import { createHash } from 'node:crypto'
import { studioError, validateStudioDocument } from './validation.mjs'

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function getPath(value, path) {
  return path.reduce((current, part) => current?.[part], value)
}

function setPath(value, path, next) {
  let current = value
  for (const part of path.slice(0, -1)) current = current[part]
  current[path.at(-1)] = structuredClone(next)
}

function idFor(kind, key, before, after) {
  return createHash('sha256')
    .update(JSON.stringify({ kind, key, before, after }))
    .digest('hex')
    .slice(0, 20)
}

function change(kind, key, label, before, after, apply, details = {}) {
  return {
    id: idFor(kind, key, before, after),
    kind,
    label,
    before: structuredClone(before ?? null),
    after: structuredClone(after ?? null),
    apply,
    ...details,
  }
}

function collectionChanges(current, proposed, path, kind, noun) {
  const before = new Map((getPath(current, path) ?? []).map((item) => [item.id, item]))
  const after = new Map((getPath(proposed, path) ?? []).map((item) => [item.id, item]))
  const changes = []
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const left = before.get(id)
    const right = after.get(id)
    if (equal(left, right)) continue
    changes.push(change(
      left === undefined ? `${kind}-add` : right === undefined ? `${kind}-remove` : `${kind}-update`,
      `${path.join('.')}:${id}`,
      `${left === undefined ? 'Add' : right === undefined ? 'Remove' : 'Update'} ${noun} “${right?.name ?? left?.name ?? id}”`,
      left,
      right,
      { type: 'collection-item', path, id },
      { affectedNodeIds: kind === 'node' ? [id] : [] },
    ))
  }
  return changes
}

function nodeChanges(current, proposed) {
  const before = new Map(current.method.graph.nodes.map((node) => [node.id, node]))
  const after = new Map(proposed.method.graph.nodes.map((node) => [node.id, node]))
  const changes = []
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const left = before.get(id)
    const right = after.get(id)
    if (left === undefined || right === undefined) {
      changes.push(...collectionChanges(
        { method: { graph: { nodes: left ? [left] : [] } } },
        { method: { graph: { nodes: right ? [right] : [] } } },
        ['method', 'graph', 'nodes'],
        'node',
        'node',
      ))
      continue
    }
    const leftSettings = Object.fromEntries(Object.entries(left).filter(([key]) => key !== 'transitions'))
    const rightSettings = Object.fromEntries(Object.entries(right).filter(([key]) => key !== 'transitions'))
    if (!equal(leftSettings, rightSettings)) {
      const exactUpgrade = left.kind === 'procedure-call' && right.kind === 'procedure-call' && !equal(left.procedure, right.procedure)
      changes.push(change(
        exactUpgrade ? 'subprocedure-version' : 'node-update',
        `method.graph.nodes:${id}:settings`,
        exactUpgrade
          ? `Update exact subprocedure ${left.procedure.id} ${left.procedure.version} → ${right.procedure.version}`
          : `Update node “${right.name}”`,
        leftSettings,
        rightSettings,
        { type: 'node-field', id, field: 'settings' },
        {
          affectedNodeIds: [id],
          ...(exactUpgrade ? { impact: downstreamNodeIds(proposed.method, id) } : {}),
        },
      ))
    }
    if (!equal(left.transitions, right.transitions)) {
      changes.push(change(
        'edge-update',
        `method.graph.nodes:${id}:transitions`,
        `Reroute edges from “${right.name}”`,
        left.transitions,
        right.transitions,
        { type: 'node-field', id, field: 'transitions' },
        { affectedNodeIds: [id, ...right.transitions.map((route) => route.to).filter(Boolean)] },
      ))
    }
  }
  return changes
}

function downstreamNodeIds(method, nodeId) {
  const direct = method.graph.nodes.find((node) => node.id === nodeId)?.transitions.map((route) => route.to).filter(Boolean) ?? []
  const seen = new Set()
  const pending = [...direct]
  while (pending.length > 0 && seen.size < 20) {
    const id = pending.shift()
    if (seen.has(id)) continue
    seen.add(id)
    const node = method.graph.nodes.find((item) => item.id === id)
    pending.push(...(node?.transitions.map((route) => route.to).filter(Boolean) ?? []))
  }
  return [...seen]
}

function valueChange(current, proposed, path, kind, label) {
  const before = getPath(current, path)
  const after = getPath(proposed, path)
  return equal(before, after)
    ? []
    : [change(kind, path.join('.'), label(before, after), before, after, { type: 'value', path })]
}

function schemaChanges(current, proposed, schemaKey, label) {
  const changes = []
  const beforeSchema = current[schemaKey]
  const afterSchema = proposed[schemaKey]
  const ids = new Set([...Object.keys(beforeSchema.properties ?? {}), ...Object.keys(afterSchema.properties ?? {})])
  for (const id of ids) {
    const before = beforeSchema.properties?.[id]
    const after = afterSchema.properties?.[id]
    const beforeRequired = beforeSchema.required?.includes(id) ?? false
    const afterRequired = afterSchema.required?.includes(id) ?? false
    if (equal(before, after) && beforeRequired === afterRequired) continue
    changes.push(change(
      `${schemaKey}-field`,
      `${schemaKey}:${id}`,
      `${before === undefined ? 'Add' : after === undefined ? 'Remove' : 'Change'} ${label} field “${id}”${beforeRequired === afterRequired ? '' : afterRequired ? ' to required' : ' to optional'}`,
      before === undefined ? null : { schema: before, required: beforeRequired },
      after === undefined ? null : { schema: after, required: afterRequired },
      { type: 'schema-field', schemaKey, id },
    ))
  }
  return changes
}

export function semanticDiff(current, proposed) {
  if (proposed === null || typeof proposed !== 'object' || Array.isArray(proposed)) {
    throw studioError('STUDIO_PROPOSAL_INVALID', 'Agent proposal must contain one canonical source bundle')
  }
  const required = ['integration', 'method', 'inputSchema', 'outputSchema']
  const missing = required.filter((key) => proposed[key] === null || typeof proposed[key] !== 'object' || Array.isArray(proposed[key]))
  if (missing.length > 0 || !Array.isArray(proposed.method?.graph?.nodes)) {
    throw studioError('STUDIO_PROPOSAL_INVALID', 'Agent proposal must contain one complete canonical source bundle', { missing })
  }
  const changes = [
    ...valueChange(current, proposed, ['integration', 'displayName'], 'procedure-identity', () => 'Change Procedure display name'),
    ...valueChange(current, proposed, ['integration', 'summary'], 'procedure-identity', () => 'Change Procedure summary'),
    ...valueChange(current, proposed, ['integration', 'procedure', 'version'], 'procedure-version', (before, after) => `Change Procedure version ${before} → ${after}`),
    ...valueChange(current, proposed, ['integration', 'procedure', 'permissions'], 'permission-declaration', () => 'Change product permission declaration'),
    ...valueChange(current, proposed, ['integration', 'procedure', 'resources'], 'resource-declaration', () => 'Change product resource declaration'),
    ...valueChange(current, proposed, ['integration', 'execution', 'outputArtifacts'], 'output-contract', () => 'Change declared output artifacts'),
    ...valueChange(current, proposed, ['method', 'revision'], 'method-revision', (before, after) => `Change Method revision ${before} → ${after}`),
    ...valueChange(current, proposed, ['method', 'name'], 'method-identity', () => 'Change Method name'),
    ...valueChange(current, proposed, ['method', 'description'], 'method-identity', () => 'Change Method description'),
    ...valueChange(current, proposed, ['method', 'profile'], 'method-profile', () => 'Change Method profile'),
    ...collectionChanges(current, proposed, ['method', 'roles'], 'role', 'role'),
    ...collectionChanges(current, proposed, ['method', 'inputs'], 'input', 'Method input'),
    ...collectionChanges(current, proposed, ['method', 'artifacts'], 'artifact', 'artifact'),
    ...collectionChanges(current, proposed, ['method', 'permissions'], 'permission', 'Method permission'),
    ...collectionChanges(current, proposed, ['method', 'resources'], 'resource', 'Method resource'),
    ...nodeChanges(current, proposed),
    ...valueChange(current, proposed, ['method', 'graph', 'entry'], 'entry', (before, after) => `Change graph entry ${before} → ${after}`),
    ...schemaChanges(current, proposed, 'inputSchema', 'input schema'),
    ...schemaChanges(current, proposed, 'outputSchema', 'output schema'),
  ]
  const proposalValidation = validateStudioDocument(proposed)
  return {
    schemaVersion: 'openadam.procedure-studio-agent-proposal.v0.1',
    source: 'agent',
    receivedAt: new Date().toISOString(),
    candidate: structuredClone(proposed),
    candidateValidation: proposalValidation,
    changes,
  }
}

function applyCollectionItem(document, candidate, descriptor) {
  const target = getPath(document, descriptor.path)
  const source = getPath(candidate, descriptor.path)
  const index = target.findIndex((item) => item.id === descriptor.id)
  const next = source.find((item) => item.id === descriptor.id)
  if (next === undefined && index >= 0) target.splice(index, 1)
  else if (next !== undefined && index >= 0) target[index] = structuredClone(next)
  else if (next !== undefined) {
    const candidateIndex = source.findIndex((item) => item.id === descriptor.id)
    const previousCandidate = [...source].slice(0, candidateIndex).reverse().find((item) => target.some((current) => current.id === item.id))
    const insertion = previousCandidate ? target.findIndex((item) => item.id === previousCandidate.id) + 1 : target.length
    target.splice(insertion, 0, structuredClone(next))
  }
}

function applyNodeField(document, candidate, descriptor) {
  const target = document.method.graph.nodes.find((node) => node.id === descriptor.id)
  const source = candidate.method.graph.nodes.find((node) => node.id === descriptor.id)
  if (!target || !source) throw studioError('STUDIO_PROPOSAL_STALE', `Proposal node ${descriptor.id} is no longer available`)
  if (descriptor.field === 'transitions') target.transitions = structuredClone(source.transitions)
  else {
    const transitions = target.transitions
    for (const key of Object.keys(target)) delete target[key]
    Object.assign(target, structuredClone(source), { transitions })
  }
}

function applySchemaField(document, candidate, descriptor) {
  const target = document[descriptor.schemaKey]
  const source = candidate[descriptor.schemaKey]
  const next = source.properties?.[descriptor.id]
  target.properties ??= {}
  target.required ??= []
  if (next === undefined) {
    delete target.properties[descriptor.id]
    target.required = target.required.filter((id) => id !== descriptor.id)
    return
  }
  target.properties[descriptor.id] = structuredClone(next)
  const required = source.required?.includes(descriptor.id) ?? false
  target.required = required
    ? [...new Set([...target.required, descriptor.id])]
    : target.required.filter((id) => id !== descriptor.id)
}

export function applyProposalChanges(document, proposal, changeIds) {
  if (!proposal || !Array.isArray(proposal.changes)) throw studioError('STUDIO_PROPOSAL_UNAVAILABLE', 'No Agent proposal is loaded')
  if (!Array.isArray(changeIds) || new Set(changeIds).size !== changeIds.length) {
    throw studioError('STUDIO_PROPOSAL_INVALID', 'Accepted proposal change ids must be unique')
  }
  const selected = changeIds.map((id) => proposal.changes.find((item) => item.id === id))
  if (selected.some((item) => item === undefined)) throw studioError('STUDIO_PROPOSAL_STALE', 'One selected proposal change is no longer current')
  const next = structuredClone(document)
  for (const item of selected) {
    if (item.apply.type === 'value') setPath(next, item.apply.path, getPath(proposal.candidate, item.apply.path))
    else if (item.apply.type === 'collection-item') applyCollectionItem(next, proposal.candidate, item.apply)
    else if (item.apply.type === 'node-field') applyNodeField(next, proposal.candidate, item.apply)
    else if (item.apply.type === 'schema-field') applySchemaField(next, proposal.candidate, item.apply)
  }
  return next
}
