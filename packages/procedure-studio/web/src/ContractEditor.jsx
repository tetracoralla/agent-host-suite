import React, { useState } from 'react'
import { Bot, Box, Braces, FileInput, KeyRound, Plus, Trash2 } from 'lucide-react'
import { DebouncedInput, Field, TagList } from './editor-controls.jsx'

const INPUT_TYPES = ['text', 'string', 'boolean', 'json', 'reference']
const ARTIFACT_TYPES = ['text', 'json', 'reference', 'file-set', 'git-candidate']
const PROVIDERS = ['codex', 'grok', 'zcode']

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_.-]+/gu, '-').replace(/^[^a-z]+|-+$/gu, '').slice(0, 80) || 'item'
}

function uniqueDefinitionId(values, base) {
  const taken = new Set(values.map((item) => item.id))
  let id = slug(base)
  let index = 2
  while (taken.has(id)) id = `${slug(base)}-${index++}`
  return id
}

function schemaType(type) {
  if (type === 'boolean') return 'boolean'
  if (['json'].includes(type)) return ['object', 'array']
  if (type === 'file-set') return 'array'
  if (type === 'git-candidate') return 'object'
  return 'string'
}

function syncInputSchema(document) {
  const inputs = document.method.inputs
  document.inputSchema.properties ??= {}
  const ids = new Set(inputs.map((item) => item.id))
  for (const id of Object.keys(document.inputSchema.properties)) if (!ids.has(id)) delete document.inputSchema.properties[id]
  for (const input of inputs) {
    const current = document.inputSchema.properties[input.id] ?? {}
    document.inputSchema.properties[input.id] = { ...current, type: schemaType(input.type) }
  }
  document.inputSchema.required = inputs.filter((item) => item.required).map((item) => item.id)
}

function syncOutputSchema(document) {
  const outputIds = document.integration.execution.outputArtifacts
  const artifacts = new Map(document.method.artifacts.map((item) => [item.id, item]))
  document.outputSchema.properties ??= {}
  for (const id of Object.keys(document.outputSchema.properties)) if (!outputIds.includes(id)) delete document.outputSchema.properties[id]
  for (const id of outputIds) {
    const artifact = artifacts.get(id)
    if (!artifact) continue
    const current = document.outputSchema.properties[id] ?? {}
    document.outputSchema.properties[id] = { ...current, type: schemaType(artifact.type) }
  }
  document.outputSchema.required = [...outputIds]
}

function syncProductDeclarations(document) {
  document.integration.procedure.permissions = document.method.permissions.map((item) => item.id)
  document.integration.procedure.resources = document.method.resources.map(({ name: _name, ...resource }) => structuredClone(resource))
}

function usesDefinition(method, collection, id, outputIds, scenarios) {
  const nodes = method.graph.nodes
  const scenarioUsages = scenarios.filter((scenario) => {
    if (collection === 'roles') return Object.hasOwn(scenario.bindings, id)
    if (collection === 'inputs') return Object.hasOwn(scenario.inputs, id)
    if (collection === 'permissions') return scenario.grants.includes(id)
    if (collection === 'resources') return Object.hasOwn(scenario.resources, id)
    return false
  }).map((scenario) => `scenario: ${scenario.name}`)
  if (collection === 'roles') {
    const roleUsages = method.roles.filter((role) => role.id !== id && (role.independentFrom ?? []).includes(id)).map((role) => `role: ${role.name}`)
    return [...nodes.filter((node) => node.kind === 'agent-turn' && node.role === id).map((node) => node.id), ...roleUsages, ...scenarioUsages]
  }
  if (collection === 'inputs') return [...nodes.filter((node) => node.consumes.includes(id) || node.transitions.some((route) => route.when.path === `inputs.${id}`)).map((node) => node.id), ...scenarioUsages]
  if (collection === 'artifacts') {
    const users = nodes.filter((node) => node.consumes.includes(id) || node.produces.includes(id) || node.responseArtifact === id || node.transitions.some((route) => route.when.path === `outputs.${id}`)).map((node) => node.id)
    return outputIds.includes(id) ? [...users, 'declared output'] : users
  }
  if (collection === 'permissions') return [...nodes.filter((node) => node.permissions.includes(id) || node.grants?.includes(id)).map((node) => node.id), ...scenarioUsages]
  return [...nodes.filter((node) => node.resources.includes(id) || Object.values(node.resourceBindings ?? {}).includes(id) || node.transitions.some((route) => route.when.path === `resources.${id}`)).map((node) => node.id), ...scenarioUsages]
}

function updateZcodeModel(role, key, value) {
  const current = role.defaultBinding?.model && typeof role.defaultBinding.model === 'object' ? role.defaultBinding.model : {}
  const model = structuredClone(current)
  if (key === 'reasoningLevel') {
    model.options ??= {}
    if (value) model.options.reasoningLevel = value
    else delete model.options.reasoningLevel
    if (!Object.keys(model.options).length) delete model.options
  } else if (value) model[key] = value
  else delete model[key]
  role.defaultBinding = { ...(role.defaultBinding ?? {}), provider: 'zcode' }
  if (Object.keys(model).length) role.defaultBinding.model = model
  else delete role.defaultBinding.model
}

function CollectionHeader({ title, description, onAdd, addLabel = 'Add' }) {
  return <div className="contract-heading"><div><h3>{title}</h3><p>{description}</p></div>{onAdd && <button className="button quiet small" type="button" onClick={onAdd}><Plus size={13} />{addLabel}</button>}</div>
}

function DeleteDefinition({ usages, onDelete, label }) {
  const blocked = usages.length > 0
  return <button className="object-delete" type="button" disabled={blocked} title={blocked ? `Used by ${usages.join(', ')}` : `Delete ${label}`} aria-label={blocked ? `${label} is in use` : `Delete ${label}`} onClick={onDelete}><Trash2 size={13} /></button>
}

function NamedObject({ icon: Icon, item, children, usages, onName, onDelete, badge }) {
  return <article className="contract-object"><header><span className="contract-object-icon"><Icon size={14} /></span><span><b>{item.name}</b><code>{item.id}</code></span>{badge}{onDelete && <DeleteDefinition usages={usages} onDelete={onDelete} label={item.name} />}</header><div className="contract-object-fields"><Field label="Name"><DebouncedInput value={item.name} onCommit={onName} /></Field>{children}</div>{usages.length > 0 && <footer>Used by <TagList values={usages} /></footer>}</article>
}

export function ContractEditor({ studio, mutate }) {
  const method = studio.document.method
  const outputIds = studio.document.integration.execution.outputArtifacts
  const [resourceType, setResourceType] = useState(method.resources.some((item) => item.type === 'workspace') ? 'file' : 'workspace')
  const scenarios = studio.scenarios

  const updateDefinition = (collection, id, updater, label) => mutate((draft) => {
    const item = draft.document.method[collection].find((candidate) => candidate.id === id)
    if (!item) return
    updater(item)
    if (collection === 'inputs') syncInputSchema(draft.document)
    if (collection === 'artifacts') syncOutputSchema(draft.document)
    if (collection === 'permissions' || collection === 'resources') syncProductDeclarations(draft.document)
  }, { label })

  const deleteDefinition = (collection, id) => mutate((draft) => {
    draft.document.method[collection] = draft.document.method[collection].filter((item) => item.id !== id)
    if (collection === 'inputs') syncInputSchema(draft.document)
    if (collection === 'artifacts') syncOutputSchema(draft.document)
    if (collection === 'permissions' || collection === 'resources') syncProductDeclarations(draft.document)
  }, { label: `Delete ${collection.slice(0, -1)}` })

  const addDefinition = (collection, item) => mutate((draft) => {
    draft.document.method[collection].push(item(draft.document.method[collection]))
    if (collection === 'inputs') syncInputSchema(draft.document)
    if (collection === 'artifacts') syncOutputSchema(draft.document)
    if (collection === 'permissions' || collection === 'resources') syncProductDeclarations(draft.document)
  }, { label: `Add ${collection.slice(0, -1)}` })

  const toggleOutput = (id, checked) => mutate((draft) => {
    const outputs = draft.document.integration.execution.outputArtifacts
    draft.document.integration.execution.outputArtifacts = checked ? [...new Set([...outputs, id])] : outputs.filter((value) => value !== id)
    syncOutputSchema(draft.document)
  }, { label: checked ? 'Declare Procedure output' : 'Remove Procedure output' })

  return <div className="inspector-section-stack contract-editor">
    <section>
      <CollectionHeader title="Inputs" description="Typed values required when a consumer starts this Procedure." onAdd={() => addDefinition('inputs', (items) => ({ id: uniqueDefinitionId(items, 'input'), name: 'New input', type: 'text', required: false }))} addLabel="Input" />
      <div className="contract-object-list">{method.inputs.map((item) => {
        const usages = usesDefinition(method, 'inputs', item.id, outputIds, scenarios)
        return <NamedObject key={item.id} icon={FileInput} item={item} usages={usages} onName={(name) => updateDefinition('inputs', item.id, (draft) => { draft.name = name }, 'Rename input')} onDelete={() => deleteDefinition('inputs', item.id)}><div className="field-row"><Field label="Type"><select value={item.type} onChange={(event) => updateDefinition('inputs', item.id, (draft) => { draft.type = event.target.value }, 'Change input type')}>{INPUT_TYPES.map((type) => <option key={type}>{type}</option>)}</select></Field><label className="compact-check"><input type="checkbox" checked={item.required} onChange={(event) => updateDefinition('inputs', item.id, (draft) => { draft.required = event.target.checked }, 'Change input requirement')} />Required</label></div></NamedObject>
      })}</div>
    </section>

    <section>
      <CollectionHeader title="Artifacts and outputs" description="Intermediate values stay internal; checked artifacts cross the Procedure boundary." onAdd={() => addDefinition('artifacts', (items) => ({ id: uniqueDefinitionId(items, 'artifact'), name: 'New artifact', type: 'text', required: false }))} addLabel="Artifact" />
      <div className="contract-object-list">{method.artifacts.map((item) => {
        const usages = usesDefinition(method, 'artifacts', item.id, outputIds, scenarios)
        const isOutput = outputIds.includes(item.id)
        return <NamedObject key={item.id} icon={Box} item={item} usages={usages} badge={<label className="output-toggle"><input type="checkbox" checked={isOutput} disabled={isOutput && outputIds.length === 1} onChange={(event) => toggleOutput(item.id, event.target.checked)} />Output</label>} onName={(name) => updateDefinition('artifacts', item.id, (draft) => { draft.name = name }, 'Rename artifact')} onDelete={() => deleteDefinition('artifacts', item.id)}><div className="field-row"><Field label="Type"><select value={item.type} onChange={(event) => updateDefinition('artifacts', item.id, (draft) => { draft.type = event.target.value }, 'Change artifact type')}>{ARTIFACT_TYPES.map((type) => <option key={type}>{type}</option>)}</select></Field><label className="compact-check"><input type="checkbox" checked={item.required} onChange={(event) => updateDefinition('artifacts', item.id, (draft) => { draft.required = event.target.checked }, 'Change artifact requirement')} />Required internally</label></div></NamedObject>
      })}</div>
    </section>

    <section>
      <CollectionHeader title="Agent roles" description="Reusable execution roles, independence requirements, and default provider bindings." onAdd={() => addDefinition('roles', (items) => ({ id: uniqueDefinitionId(items, 'agent'), name: 'Agent', description: 'Completes a bounded Procedure step.', independentFrom: [], includeReports: false, defaultBinding: { provider: 'codex' } }))} addLabel="Role" />
      <div className="contract-object-list">{method.roles.map((item) => {
        const usages = usesDefinition(method, 'roles', item.id, outputIds, scenarios)
        const binding = item.defaultBinding ?? { provider: 'codex' }
        const independentChoices = method.roles.filter((role) => role.id !== item.id)
        return <NamedObject key={item.id} icon={Bot} item={item} usages={usages} onName={(name) => updateDefinition('roles', item.id, (draft) => { draft.name = name }, 'Rename role')} onDelete={() => deleteDefinition('roles', item.id)}><Field label="Description"><DebouncedInput multiline rows={3} value={item.description ?? ''} onCommit={(description) => updateDefinition('roles', item.id, (draft) => { if (description) draft.description = description; else delete draft.description }, 'Edit role description')} /></Field><div className="field-row"><Field label="Default provider"><select value={binding.provider} onChange={(event) => updateDefinition('roles', item.id, (draft) => { draft.defaultBinding = { provider: event.target.value } }, 'Change role provider')}>{PROVIDERS.map((provider) => <option key={provider}>{provider}</option>)}</select></Field><label className="compact-check"><input type="checkbox" checked={Boolean(item.includeReports)} onChange={(event) => updateDefinition('roles', item.id, (draft) => { draft.includeReports = event.target.checked }, 'Change report access')} />Include reports</label></div>{binding.provider === 'zcode' ? <div className="binding-detail-grid"><Field label="ZCode provider id"><DebouncedInput value={typeof binding.model === 'object' ? binding.model.providerId ?? '' : ''} placeholder="Provider id" onCommit={(value) => updateDefinition('roles', item.id, (draft) => updateZcodeModel(draft, 'providerId', value), 'Edit ZCode provider')} /></Field><Field label="ZCode model id"><DebouncedInput value={typeof binding.model === 'object' ? binding.model.modelId ?? '' : ''} placeholder="Model id" onCommit={(value) => updateDefinition('roles', item.id, (draft) => updateZcodeModel(draft, 'modelId', value), 'Edit ZCode model')} /></Field><Field label="Reasoning level"><DebouncedInput value={typeof binding.model === 'object' ? binding.model.options?.reasoningLevel ?? '' : ''} placeholder="Provider default" onCommit={(value) => updateDefinition('roles', item.id, (draft) => updateZcodeModel(draft, 'reasoningLevel', value), 'Edit ZCode reasoning')} /></Field></div> : <Field label="Default model"><DebouncedInput value={typeof binding.model === 'string' ? binding.model : ''} placeholder="Provider default" onCommit={(model) => updateDefinition('roles', item.id, (draft) => { draft.defaultBinding ??= { provider: binding.provider }; if (model) draft.defaultBinding.model = model; else delete draft.defaultBinding.model }, 'Edit role model')} /></Field>}{independentChoices.length > 0 && <div className="independence-list"><span>Must start independently from</span>{independentChoices.map((role) => <label key={role.id}><input type="checkbox" checked={(item.independentFrom ?? []).includes(role.id)} onChange={(event) => updateDefinition('roles', item.id, (draft) => { const current = draft.independentFrom ?? []; draft.independentFrom = event.target.checked ? [...new Set([...current, role.id])] : current.filter((id) => id !== role.id) }, 'Change role independence')} />{role.name}</label>)}</div>}</NamedObject>
      })}</div>
    </section>

    <section>
      <CollectionHeader title="Permissions" description="The product ceiling and Method declaration stay synchronized." onAdd={() => addDefinition('permissions', (items) => ({ id: uniqueDefinitionId(items, 'permission'), name: 'New permission' }))} addLabel="Permission" />
      <div className="contract-object-list">{method.permissions.map((item) => {
        const usages = usesDefinition(method, 'permissions', item.id, outputIds, scenarios)
        return <NamedObject key={item.id} icon={KeyRound} item={item} usages={usages} onName={(name) => updateDefinition('permissions', item.id, (draft) => { draft.name = name }, 'Rename permission')} onDelete={() => deleteDefinition('permissions', item.id)} />
      })}</div>
      {!method.permissions.length && <p className="empty-state">No permissions are declared.</p>}
    </section>

    <section>
      <CollectionHeader title="Resources" description="Concrete workspace, file, and account requirements exposed to every Test scenario." onAdd={() => {
        const selectedType = resourceType
        addDefinition('resources', (items) => {
          const id = uniqueDefinitionId(items, selectedType)
          if (selectedType === 'workspace') return { id, name: 'Git workspace', type: 'workspace', required: false, adapter: 'git' }
          if (selectedType === 'file') return { id, name: 'File', type: 'file', required: false, access: 'read' }
          return { id, name: 'Account', type: 'account', required: false }
        })
        if (selectedType === 'workspace') setResourceType('file')
      }} addLabel="Resource" />
      <label className="resource-kind-picker"><span>New resource kind</span><select value={resourceType} onChange={(event) => setResourceType(event.target.value)}><option value="workspace" disabled={method.resources.some((item) => item.type === 'workspace')}>Workspace</option><option value="file">File</option><option value="account">Account</option></select></label>
      <div className="contract-object-list">{method.resources.map((item) => {
        const usages = usesDefinition(method, 'resources', item.id, outputIds, scenarios)
        return <NamedObject key={item.id} icon={Braces} item={item} usages={usages} badge={<span className="object-badge">{item.type}</span>} onName={(name) => updateDefinition('resources', item.id, (draft) => { draft.name = name }, 'Rename resource')} onDelete={() => deleteDefinition('resources', item.id)}><div className="field-row">{item.type === 'file' && <Field label="Access"><select value={item.access} onChange={(event) => updateDefinition('resources', item.id, (draft) => { draft.access = event.target.value }, 'Change file access')}><option value="read">Read</option><option value="write">Write</option></select></Field>}{item.type === 'account' && <Field label="Provider"><DebouncedInput value={item.provider ?? ''} placeholder="Any provider" onCommit={(provider) => updateDefinition('resources', item.id, (draft) => { if (provider) draft.provider = provider; else delete draft.provider }, 'Change account provider')} /></Field>}{item.type === 'workspace' && <div className="readonly-row"><span>Adapter</span><b>git</b></div>}<label className="compact-check"><input type="checkbox" checked={item.required} onChange={(event) => updateDefinition('resources', item.id, (draft) => { draft.required = event.target.checked }, 'Change resource requirement')} />Required</label></div></NamedObject>
      })}</div>
      {!method.resources.length && <p className="empty-state">This Procedure is resource-free.</p>}
    </section>
  </div>
}
