import { compileGraphView } from '@openadam/graph-view-compiler/compiler'

export const METHOD_NODE_SIZE = Object.freeze({ width: 226, height: 132 })

const TRANSITION_ID = /^[a-z][a-z0-9_.-]{0,79}$/u

function transitionBase(nodeId) {
  return `${nodeId.slice(0, 66)}-route`.replace(/[^a-z0-9_.-]/gu, '-')
}

export function nextTransitionId(method, nodeId, used = null) {
  const known = used ?? new Set(method.graph.nodes.flatMap((node) => node.transitions.map((route) => route.id).filter(Boolean)))
  const base = transitionBase(nodeId)
  let index = 1
  let candidate = `${base}-${index}`
  while (known.has(candidate)) candidate = `${base}-${++index}`
  known.add(candidate)
  return candidate
}

export function ensureTransitionIds(method) {
  const normalized = structuredClone(method)
  const used = new Set()
  for (const node of normalized.graph.nodes) {
    for (const route of node.transitions) {
      if (TRANSITION_ID.test(route.id ?? '') && !used.has(route.id)) {
        used.add(route.id)
      } else {
        route.id = nextTransitionId(normalized, node.id, used)
      }
    }
  }
  return normalized
}

export function transitionLabel(route) {
  if (route.label) return route.label
  if (route.when.operator === 'always') return 'Always'
  return `${route.when.path} ${route.when.operator}`
}

function labelSize(label) {
  return { width: Math.min(184, Math.max(52, 18 + label.length * 6.4)), height: 24 }
}

export function methodSemanticGraph(method) {
  return {
    version: 1,
    nodes: method.graph.nodes.map((node) => ({
      id: node.id,
      label: node.name,
      kind: node.kind,
      ports: [
        { id: 'input', kind: 'input', preferredSide: 'left' },
        { id: 'output', kind: 'output', preferredSide: 'right' },
      ],
    })),
    relations: method.graph.nodes.flatMap((node) => node.transitions.flatMap((route, index) => route.to === null ? [] : [{
      id: route.id ?? `${transitionBase(node.id)}-${index + 1}`,
      source: node.id,
      target: route.to,
      direction: 'directed',
      label: transitionLabel(route),
      kind: route.when.operator === 'always' ? 'fallback' : 'conditional',
      sourcePort: 'output',
      targetPort: 'input',
    }])),
  }
}

function completePositions(method, positions) {
  return positions && method.graph.nodes.every((node) => {
    const point = positions[node.id]
    return Number.isFinite(point?.x) && Number.isFinite(point?.y)
  })
}

export function compileMethodGraphView(method, {
  positions = null,
  previousPlan,
  anchorNodeId,
  forceLayered = false,
} = {}) {
  const graph = methodSemanticGraph(method)
  const nodeSizes = Object.fromEntries(graph.nodes.map((node) => [node.id, METHOD_NODE_SIZE]))
  const labelSizes = Object.fromEntries(graph.relations.map((relation) => [relation.id, labelSize(relation.label)]))
  const fixed = !forceLayered && completePositions(method, positions)
  const profile = fixed
    ? { type: 'fixed', positions }
    : {
        type: 'layered',
        layout: {
          direction: 'left-to-right',
          nodeGap: 72,
          edgeGap: 28,
          rankGap: 216,
          marginX: 110,
          marginY: 96,
        },
      }
  const retainedAnchor = previousPlan?.nodes.some((node) => node.id === anchorNodeId) && graph.nodes.some((node) => node.id === anchorNodeId)
    ? anchorNodeId
    : undefined
  return compileGraphView({
    graph,
    nodeSizes,
    labelSizes,
    profile,
    routing: { stub: 24, clearance: 14, turnCost: 18, maximumObstacles: 96 },
    ...(previousPlan === undefined ? {} : { previousPlan }),
    ...(!fixed && previousPlan !== undefined
      ? { stability: { mode: 'preserve-anchor', ...(retainedAnchor === undefined ? {} : { anchorNodeId: retainedAnchor }) } }
      : {}),
  })
}

export function positionsFromPlan(plan) {
  return Object.fromEntries(plan.nodes.map((node) => [node.id, { x: node.x, y: node.y }]))
}

export function initialMethodPositions(method) {
  try {
    return positionsFromPlan(compileMethodGraphView(method, { forceLayered: true }))
  } catch {
    return Object.fromEntries(method.graph.nodes.map((node, index) => [node.id, {
      x: 110 + (index % 4) * 300,
      y: 96 + Math.floor(index / 4) * 190,
    }]))
  }
}

export function arrangeMethodPositions(method, positions, anchorNodeId) {
  try {
    const previousPlan = compileMethodGraphView(method, { positions })
    const plan = compileMethodGraphView(method, { previousPlan, anchorNodeId, forceLayered: true })
    return { positions: positionsFromPlan(plan), plan, error: null }
  } catch (error) {
    return { positions, plan: null, error }
  }
}
