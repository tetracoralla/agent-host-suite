import React, { useEffect, useMemo, useState } from 'react'
import { Box, CircleAlert, CopyPlus, Save, ShieldCheck, SlidersHorizontal } from 'lucide-react'
import { Field } from './editor-controls.jsx'

const PROVIDERS = ['codex', 'grok', 'zcode']
const LIMITS = [
  ['maxDurationMs', 'Duration (ms)', 1_000, 28_800_000],
  ['maxNodeExecutions', 'Node executions', 1, 500],
  ['maxAgentTurns', 'Agent turns', 0, 100],
  ['nodeTimeoutMs', 'Node timeout (ms)', 1_000, 1_800_000],
  ['maxAttemptsPerNode', 'Attempts / node', 1, 20],
  ['maxOutputBytes', 'Output bytes', 1_024, 4 * 1024 * 1024],
]

function missing(value) {
  return value === undefined || value === null || value === ''
}

export function scenarioReadiness(studio, scenario) {
  if (!studio || !scenario) return [{ severity: 'error', message: 'Select a Test scenario.' }]
  const method = studio.document.method
  const issues = []
  for (const input of method.inputs) {
    if (input.required && missing(scenario.inputs[input.id])) issues.push({ severity: 'error', message: `${input.name} is required.` })
  }
  for (const resource of method.resources) {
    const binding = scenario.resources[resource.id]
    if (!binding) {
      if (resource.required) issues.push({ severity: 'error', message: `Bind required resource ${resource.name}.` })
      continue
    }
    if (binding.type !== resource.type) issues.push({ severity: 'error', message: `${resource.name} has the wrong binding type.` })
    if (['workspace', 'file'].includes(resource.type) && (!binding.path || !binding.path.startsWith('/'))) {
      issues.push({ severity: 'error', message: `${resource.name} needs an absolute path.` })
    }
    if (resource.type === 'account' && (!binding.provider || !binding.account)) {
      issues.push({ severity: 'error', message: `${resource.name} needs both provider and account.` })
    }
  }
  for (const role of method.roles) {
    const binding = scenario.bindings[role.id] ?? role.defaultBinding
    if (!binding || !PROVIDERS.includes(binding.provider)) {
      issues.push({ severity: 'error', message: `Choose a supported provider for ${role.name}.` })
      continue
    }
    if (binding.provider === 'zcode' && binding.model !== undefined && (typeof binding.model !== 'object' || !binding.model.providerId || !binding.model.modelId)) {
      issues.push({ severity: 'error', message: `${role.name} needs both ZCode provider id and model id.` })
    }
    if ((role.independentFrom ?? []).length && binding.sessionId) {
      issues.push({ severity: 'error', message: `${role.name} must start independently and cannot resume a session.` })
    }
  }
  for (const [key, label, minimum, maximum] of LIMITS) {
    const value = scenario.limits[key]
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      issues.push({ severity: 'error', message: `${label} must be an integer from ${minimum.toLocaleString()} to ${maximum.toLocaleString()}.` })
    }
  }
  const neededGrants = new Set(method.graph.nodes.flatMap((node) => node.permissions))
  const missingGrants = [...neededGrants].filter((id) => !scenario.grants.includes(id))
  if (missingGrants.length) issues.push({ severity: 'warning', message: `Run will stop when it reaches permissions not granted here: ${missingGrants.join(', ')}.` })
  return issues
}

function JsonField({ label, value, onChange }) {
  const canonical = value === undefined ? '' : JSON.stringify(value, null, 2)
  const [text, setText] = useState(canonical)
  const [error, setError] = useState(null)
  useEffect(() => { setText(canonical); setError(null) }, [canonical])
  const apply = () => {
    if (!text.trim()) {
      onChange(undefined)
      setError(null)
      return
    }
    try {
      onChange(JSON.parse(text))
      setError(null)
    } catch (caught) {
      setError(caught.message)
    }
  }
  return <Field label={label} hint={error ? `Invalid JSON: ${error}` : null}><textarea className={error ? 'invalid-field' : ''} rows={4} value={text} spellCheck="false" onChange={(event) => setText(event.target.value)} onBlur={apply} /></Field>
}

function defaultResource(resource) {
  if (resource.type === 'workspace') return { type: 'workspace', adapter: resource.adapter, path: '', allowExistingPaths: [] }
  if (resource.type === 'file') return { type: 'file', path: '', access: resource.access }
  return { type: 'account', provider: resource.provider ?? '', account: '' }
}

function InputControl({ definition, value, onChange }) {
  const label = `${definition.name}${definition.required ? ' *' : ''}`
  if (definition.type === 'boolean') return <Field label={label}><select value={value === undefined ? '' : String(value)} onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value === 'true')}><option value="">Not set</option><option value="true">True</option><option value="false">False</option></select></Field>
  if (definition.type === 'json') return <JsonField label={label} value={value} onChange={onChange} />
  return <Field label={label}><input value={value ?? ''} placeholder={definition.required ? 'Required' : 'Optional'} onChange={(event) => onChange(event.target.value || undefined)} /></Field>
}

function updateZcodeBinding(binding, key, value) {
  const next = structuredClone(binding)
  const model = next.model && typeof next.model === 'object' ? next.model : {}
  if (key === 'reasoningLevel') {
    model.options ??= {}
    if (value) model.options.reasoningLevel = value
    else delete model.options.reasoningLevel
    if (!Object.keys(model.options).length) delete model.options
  } else if (value) model[key] = value
  else delete model[key]
  if (Object.keys(model).length) next.model = model
  else delete next.model
  return next
}

function BindingEditor({ role, binding, onChange }) {
  const independent = (role.independentFrom ?? []).length > 0
  const setValue = (key, value) => {
    const next = { ...binding }
    if (value) next[key] = value
    else delete next[key]
    onChange(next)
  }
  return <article className="binding-card"><header><span><b>{role.name}</b><small>{role.id}</small></span>{independent && <em>Independent session</em>}</header><div className="binding-detail-grid"><Field label="Provider"><select value={binding.provider ?? ''} onChange={(event) => onChange({ provider: event.target.value })}><option value="">Choose…</option>{PROVIDERS.map((provider) => <option key={provider}>{provider}</option>)}</select></Field>{binding.provider === 'zcode' ? <><Field label="ZCode provider id"><input value={typeof binding.model === 'object' ? binding.model.providerId ?? '' : ''} placeholder="Provider id" onChange={(event) => onChange(updateZcodeBinding(binding, 'providerId', event.target.value))} /></Field><Field label="ZCode model id"><input value={typeof binding.model === 'object' ? binding.model.modelId ?? '' : ''} placeholder="Model id" onChange={(event) => onChange(updateZcodeBinding(binding, 'modelId', event.target.value))} /></Field><Field label="Reasoning level"><input value={typeof binding.model === 'object' ? binding.model.options?.reasoningLevel ?? '' : ''} placeholder="Provider default" onChange={(event) => onChange(updateZcodeBinding(binding, 'reasoningLevel', event.target.value))} /></Field></> : <Field label="Model"><input placeholder="Provider default" value={typeof binding.model === 'string' ? binding.model : ''} onChange={(event) => setValue('model', event.target.value)} /></Field>}<Field label="Session id" hint={independent ? 'Leave blank; this role must start independently.' : 'Optional existing provider session.'}><input className={independent && binding.sessionId ? 'invalid-field' : ''} placeholder="New session" value={binding.sessionId ?? ''} onChange={(event) => setValue('sessionId', event.target.value)} /></Field></div></article>
}

export function ScenarioEditor({ studio, scenario, dirty, onChange, onSave, run, cloneName, setCloneName, cloneRun, cloneScenario }) {
  const method = studio.document.method
  const [advanced, setAdvanced] = useState(false)
  const declaredResources = method.resources
  const permissionNames = useMemo(() => new Map(method.permissions.map((item) => [item.id, item.name])), [method.permissions])
  const readiness = useMemo(() => scenarioReadiness(studio, scenario), [scenario, studio])
  if (!scenario) return <div className="run-empty"><SlidersHorizontal size={22} /><b>No Test scenario selected</b><span>Select or create a scenario before running this Procedure.</span></div>

  const patch = (updater) => onChange((current) => {
    const next = structuredClone(current)
    updater(next)
    return next
  })

  return <div className="scenario-editor">
    <header className="scenario-editor-header"><div><span className="eyebrow">Reusable request</span><h3>{scenario.name}</h3><p>{scenario.description || 'No scenario description.'}</p></div><div>{dirty && <span className="draft-badge">Unsaved changes</span>}<button className="button quiet small" type="button" disabled={!dirty} onClick={onSave}><Save size={13} />Save scenario</button></div></header>
    {readiness.length > 0 && <div className="scenario-readiness"><CircleAlert size={16} /><div><b>{readiness.some((item) => item.severity === 'error') ? 'Run setup needs attention' : 'Authority test case'}</b>{readiness.slice(0, 6).map((item, index) => <span className={item.severity} key={`${item.message}-${index}`}>{item.message}</span>)}{readiness.length > 6 && <span>And {readiness.length - 6} more issues.</span>}</div></div>}
    <div className="scenario-columns">
      <section><h4>Identity and inputs</h4><Field label="Scenario name"><input value={scenario.name} onChange={(event) => patch((draft) => { draft.name = event.target.value })} /></Field><Field label="Description"><textarea rows={3} value={scenario.description ?? ''} onChange={(event) => patch((draft) => { draft.description = event.target.value })} /></Field><div className="scenario-input-grid">{method.inputs.map((definition) => <InputControl key={definition.id} definition={definition} value={scenario.inputs[definition.id]} onChange={(value) => patch((draft) => { if (value === undefined) delete draft.inputs[definition.id]; else draft.inputs[definition.id] = value })} />)}</div></section>

      <section><h4>Authority and resources</h4>{method.permissions.length ? <div className="scenario-checks">{method.permissions.map((permission) => <label key={permission.id}><input type="checkbox" checked={scenario.grants.includes(permission.id)} onChange={(event) => patch((draft) => { draft.grants = event.target.checked ? [...new Set([...draft.grants, permission.id])] : draft.grants.filter((id) => id !== permission.id) })} /><span><b>{permissionNames.get(permission.id)}</b><small>{permission.id}</small></span></label>)}</div> : <p className="empty-state"><ShieldCheck size={14} /> No grants required.</p>}{declaredResources.map((resource) => {
        const binding = scenario.resources[resource.id]
        return <article className="scenario-resource" key={resource.id}><header><Box size={13} /><span><b>{resource.name}</b><small>{resource.id}{resource.required ? ' · required' : ''}</small></span><label><input type="checkbox" checked={Boolean(binding)} disabled={resource.required && Boolean(binding)} onChange={(event) => patch((draft) => { if (event.target.checked) draft.resources[resource.id] = defaultResource(resource); else delete draft.resources[resource.id] })} />Bound</label></header>{binding && <>{['workspace', 'file'].includes(resource.type) && <Field label="Absolute path"><input value={binding.path ?? ''} onChange={(event) => patch((draft) => { draft.resources[resource.id].path = event.target.value })} /></Field>}{resource.type === 'account' && <><Field label="Provider"><input value={binding.provider ?? ''} onChange={(event) => patch((draft) => { draft.resources[resource.id].provider = event.target.value })} /></Field><Field label="Account"><input value={binding.account ?? ''} onChange={(event) => patch((draft) => { draft.resources[resource.id].account = event.target.value })} /></Field></>}</>}</article>
      })}</section>
    </div>

    {(method.roles.length > 0 || advanced) && <section className="scenario-advanced"><button className="section-toggle" type="button" onClick={() => setAdvanced(!advanced)}><SlidersHorizontal size={14} />Bindings and execution limits<span>{advanced ? 'Hide' : 'Show'}</span></button>{advanced && <div className="scenario-columns"><div><h4>Agent bindings</h4>{method.roles.map((role) => { const binding = scenario.bindings[role.id] ?? role.defaultBinding ?? { provider: '' }; return <BindingEditor key={role.id} role={role} binding={binding} onChange={(next) => patch((draft) => { draft.bindings[role.id] = next })} /> })}{!method.roles.length && <p className="empty-state">No Agent roles are declared.</p>}</div><div><h4>Run limits</h4><div className="limit-grid">{LIMITS.map(([key, label, minimum, maximum]) => <Field label={label} hint={`${minimum.toLocaleString()}–${maximum.toLocaleString()}`} key={key}><input type="number" min={minimum} max={maximum} value={scenario.limits[key]} onChange={(event) => patch((draft) => { draft.limits[key] = Number(event.target.value) })} /></Field>)}</div></div></div>}</section>}

    {run && <section className="executed-request"><details><summary>Exact request used by selected Run</summary><pre className="json-view">{JSON.stringify(run.request, null, 2)}</pre></details></section>}
    <div className="scenario-save"><div><b>Create a separate scenario</b><span>Keep the current editable request, or clone the immutable request from the selected Run.</span></div><input aria-label="New scenario name" placeholder="New scenario name…" value={cloneName} onChange={(event) => setCloneName(event.target.value)} /><button className="button quiet" type="button" disabled={!cloneName.trim()} onClick={() => cloneScenario(scenario)}><CopyPlus size={14} />Current</button>{run && <button className="button quiet" type="button" disabled={!cloneName.trim()} onClick={() => cloneRun(run)}><Save size={14} />Selected Run</button>}</div>
  </div>
}
