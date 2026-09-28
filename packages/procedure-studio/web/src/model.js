import {
  METHOD_NODE_SIZE,
  arrangeMethodPositions,
  compileMethodGraphView,
  nextTransitionId,
  transitionLabel,
} from '../../src/graph-view.mjs'

export { arrangeMethodPositions, nextTransitionId }

export const NODE_LIBRARY = [
  { kind: 'agent-turn', name: 'Agent turn', group: 'Agents', description: 'Delegate one bounded step to a selected Agent role.' },
  { kind: 'direct-call', name: 'Capability', group: 'Composition', description: 'Invoke one exact provider Capability operation.' },
  { kind: 'procedure-call', name: 'Subprocedure', group: 'Composition', description: 'Call one exact Procedure id and version.' },
  { kind: 'human-input', name: 'Human input', group: 'Human', description: 'Pause durably for input or a checkpoint.' },
  { kind: 'condition', name: 'Condition', group: 'Control', description: 'Route over inputs, outputs, resources, or outcome.' },
  { kind: 'transform', name: 'Transform', group: 'Data', description: 'Project declared values without an external effect.' },
]

export const UNSUPPORTED_EXTENSIONS = [
  { kind: 'parallel', name: 'Parallel', description: 'Reserved Method extension v1 — not executable.' },
  { kind: 'wait', name: 'Wait', description: 'Reserved Method extension v1 — not executable.' },
]

export const KIND_LABEL = Object.fromEntries(NODE_LIBRARY.map((item) => [item.kind, item.name]))

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 48) || 'step'
}

export function uniqueId(method, base) {
  const taken = new Set(method.graph.nodes.map((node) => node.id))
  let value = slug(base)
  let index = 2
  while (taken.has(value)) value = `${slug(base)}-${index++}`
  return value
}

export function defaultNode(kind, method) {
  const id = uniqueId(method, KIND_LABEL[kind] ?? kind)
  const base = {
    id,
    name: KIND_LABEL[kind] ?? kind,
    kind,
    consumes: [],
    produces: [],
    permissions: [],
    resources: [],
    transitions: [{ id: `${id}-route-1`, when: { operator: 'always' }, to: null }],
  }
  if (kind === 'agent-turn') {
    const role = method.roles[0]?.id ?? 'agent'
    return { ...base, role, instruction: 'Complete this bounded step and return only declared outputs.', access: 'none' }
  }
  if (kind === 'direct-call') {
    return {
      ...base,
      target: { kind: 'capability', providerId: 'provider.id', capabilityId: 'capability.id', capabilityVersion: '1.0.0', operationId: 'run' },
      input: { object: {} },
      output: {},
    }
  }
  if (kind === 'procedure-call') {
    return { ...base, procedure: { id: 'org.example.procedure', version: '1.0.0' }, input: { object: {} }, output: {}, grants: [], resourceBindings: {} }
  }
  if (kind === 'human-input') return { ...base, prompt: 'What should this Procedure preserve before continuing?', interaction: 'input', responseArtifact: method.artifacts[0]?.id ?? 'answer' }
  if (kind === 'transform') return { ...base, output: {} }
  return base
}

export function flowNodes(method, presentation, run, zoom = 1, plan = null) {
  const runStates = new Map(run?.nodes?.map((item) => [item.id, item.state]) ?? [])
  const viewNodes = new Map(plan?.nodes.map((node) => [node.id, node]) ?? [])
  const diagnostics = new Map()
  for (const item of plan?.diagnostics ?? []) {
    for (const id of item.viewIds) diagnostics.set(id, [...(diagnostics.get(id) ?? []), item])
  }
  return method.graph.nodes.map((node, index) => ({
    id: node.id,
    type: 'methodNode',
    position: viewNodes.has(node.id)
      ? { x: viewNodes.get(node.id).x, y: viewNodes.get(node.id).y }
      : presentation.positions[node.id] ?? { x: 90 + (index % 4) * 300, y: 90 + Math.floor(index / 4) * 190 },
    style: METHOD_NODE_SIZE,
    data: {
      node,
      entry: method.graph.entry === node.id,
      runState: runStates.get(node.id) ?? null,
      compact: zoom < 0.62,
      diagnostics: diagnostics.get(node.id) ?? [],
    },
  }))
}

function transitionRecords(method) {
  return method.graph.nodes.flatMap((node) => node.transitions.map((route, index) => ({ node, route, index })))
}

export function findTransition(method, edgeId) {
  const direct = transitionRecords(method).find(({ route }) => route.id === edgeId)
  if (direct) return { node: direct.node, index: direct.index, transition: direct.route }
  const [nodeId, rawIndex] = edgeId.split(':')
  const node = method.graph.nodes.find((item) => item.id === nodeId)
  const index = Number(rawIndex)
  return Number.isInteger(index) && node?.transitions[index]
    ? { node, index, transition: node.transitions[index] }
    : null
}

export function flowEdges(method, plan = null) {
  const records = transitionRecords(method)
  const byId = new Map(records.filter(({ route }) => route.id).map((record) => [record.route.id, record]))
  if (plan) {
    const diagnostics = new Map()
    for (const item of plan.diagnostics) {
      for (const id of item.viewIds) diagnostics.set(id, [...(diagnostics.get(id) ?? []), item])
    }
    return plan.edges.map((edge) => {
      const record = byId.get(edge.id)
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: 'output',
        targetHandle: 'input',
        type: 'compiledRoute',
        data: {
          nodeId: record?.node.id ?? edge.source,
          transitionIndex: record?.index ?? -1,
          path: edge.path,
          route: edge.route,
          label: edge.label,
          diagnostics: diagnostics.get(edge.id) ?? [],
        },
      }
    })
  }
  return records
    .map(({ node, route, index }) => route.to === null ? null : ({
      id: route.id ?? `${node.id}-route-${index + 1}`,
      source: node.id,
      target: route.to,
      label: transitionLabel(route),
      type: 'smoothstep',
      data: { nodeId: node.id, transitionIndex: index },
    }))
    .filter(Boolean)
}

export function flowView(method, presentation, run, zoom = 1, previousPlan = null) {
  let plan = null
  let compileError = null
  try {
    plan = compileMethodGraphView(method, { positions: presentation.positions, previousPlan: previousPlan ?? undefined })
  } catch (error) {
    compileError = error
  }
  return {
    plan,
    compileError,
    diagnostics: plan?.diagnostics ?? [],
    nodes: flowNodes(method, presentation, run, zoom, plan),
    edges: flowEdges(method, plan),
  }
}

export function cloneSelection(document, presentation, selectedIds) {
  const selected = document.method.graph.nodes.filter((node) => selectedIds.includes(node.id))
  return {
    nodes: structuredClone(selected),
    positions: Object.fromEntries(selected.map((node) => [node.id, presentation.positions[node.id] ?? { x: 0, y: 0 }])),
  }
}

export function pasteSelection(document, presentation, copied) {
  const nextDocument = structuredClone(document)
  const nextPresentation = structuredClone(presentation)
  const remap = new Map()
  const usedTransitionIds = new Set(nextDocument.method.graph.nodes.flatMap((node) => node.transitions.map((route) => route.id).filter(Boolean)))
  for (const node of copied.nodes) remap.set(node.id, uniqueId(nextDocument.method, `${node.id}-copy`))
  const nodes = copied.nodes.map((node) => {
    const copy = structuredClone(node)
    copy.id = remap.get(node.id)
    copy.name = `${node.name} copy`
    copy.transitions = copy.transitions.map((route) => ({
      ...route,
      id: nextTransitionId(nextDocument.method, copy.id, usedTransitionIds),
      to: remap.get(route.to) ?? null,
    }))
    nextDocument.method.graph.nodes.push(copy)
    const position = copied.positions[node.id]
    nextPresentation.positions[copy.id] = { x: position.x + 42, y: position.y + 42 }
    return copy.id
  })
  nextPresentation.selection = nodes
  return { document: nextDocument, presentation: nextPresentation, selectedIds: nodes }
}

export function deleteSelection(document, presentation, nodeIds, edgeId = null) {
  const nextDocument = structuredClone(document)
  const nextPresentation = structuredClone(presentation)
  if (edgeId) {
    const selected = findTransition(nextDocument.method, edgeId)
    const node = selected?.node
    const index = selected?.index ?? -1
    if (node && node.transitions.length > 1) node.transitions.splice(index, 1)
    else if (node?.transitions[index]) node.transitions[index].to = null
    return { document: nextDocument, presentation: nextPresentation }
  }
  const removing = new Set(nodeIds)
  nextDocument.method.graph.nodes = nextDocument.method.graph.nodes.filter((node) => !removing.has(node.id))
  for (const node of nextDocument.method.graph.nodes) {
    node.transitions = node.transitions.map((route) => removing.has(route.to) ? { ...route, to: null } : route)
  }
  for (const id of removing) delete nextPresentation.positions[id]
  nextPresentation.selection = []
  return { document: nextDocument, presentation: nextPresentation }
}

export function proposalSummary(change) {
  const values = (value) => value === null ? 'None' : typeof value === 'string' ? value : JSON.stringify(value)
  return { before: values(change.before), after: values(change.after) }
}
