import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { validateMethod } from '../../procedure-runtime/src/method.mjs'
import {
  arrangeMethodPositions,
  compileMethodGraphView,
  ensureTransitionIds,
  methodSemanticGraph,
  positionsFromPlan,
} from '../src/graph-view.mjs'
import { findTransition, flowView } from '../web/src/model.js'

const methodUrl = new URL('../examples/research-brief/method.json', import.meta.url)

async function exampleMethod() {
  return JSON.parse(await readFile(methodUrl, 'utf8'))
}

test('legacy transitions gain stable unique identities without changing route meaning', async () => {
  const legacy = await exampleMethod()
  for (const node of legacy.graph.nodes) for (const route of node.transitions) delete route.id
  const normalized = ensureTransitionIds(legacy)
  const before = normalized.graph.nodes.flatMap((node) => node.transitions.map((route) => ({ id: route.id, to: route.to, when: route.when })))
  const ids = before.map((route) => route.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(ids.every((id) => /^[a-z][a-z0-9_.-]{0,79}$/u.test(id)))
  assert.equal(validateMethod(legacy).schema, 'openadam.method-graph.v2')
  assert.equal(validateMethod(normalized).schema, 'openadam.method-graph.v2')
  const duplicate = structuredClone(normalized)
  duplicate.graph.nodes[1].transitions[0].id = duplicate.graph.nodes[0].transitions[0].id
  assert.throws(() => validateMethod(duplicate), /Transition IDs must be unique/u)

  normalized.graph.nodes[0].transitions.reverse()
  assert.deepEqual(
    new Set(methodSemanticGraph(normalized).relations.map((relation) => relation.id)),
    new Set(ids.slice(0, -1)),
  )
  assert.equal(findTransition(normalized, ids[0]).transition.id, ids[0])
})

test('layered and fixed plans share one stable graph identity and orthogonal route contract', async () => {
  const method = await exampleMethod()
  const layered = compileMethodGraphView(method, { forceLayered: true })
  assert.equal(layered.profile.type, 'layered')
  assert.deepEqual(new Set(layered.nodes.map((node) => node.id)), new Set(method.graph.nodes.map((node) => node.id)))
  assert.deepEqual(new Set(layered.edges.map((edge) => edge.id)), new Set(methodSemanticGraph(method).relations.map((relation) => relation.id)))

  const positions = positionsFromPlan(layered)
  positions.write = { x: positions.write.x + 37, y: positions.write.y + 53 }
  const fixed = compileMethodGraphView(method, { positions, previousPlan: layered })
  assert.equal(fixed.profile.type, 'fixed')
  assert.deepEqual({ x: fixed.nodes.find((node) => node.id === 'write').x, y: fixed.nodes.find((node) => node.id === 'write').y }, positions.write)
  for (const edge of fixed.edges) {
    assert.ok(edge.route.points.length >= 2)
    for (let index = 1; index < edge.route.points.length; index += 1) {
      const left = edge.route.points[index - 1]
      const right = edge.route.points[index]
      assert.ok(left.x === right.x || left.y === right.y, `${edge.id} contains a diagonal segment`)
    }
  }
})

test('branching, parallel endpoint pairs, a back edge, and a self loop remain separate view objects', async () => {
  const method = await exampleMethod()
  const verify = method.graph.nodes.find((node) => node.id === 'verify')
  verify.transitions.splice(1, 0, {
    id: 'verify-second-collect-route',
    when: { path: 'facts.coverage', operator: 'not_equals', value: 'sufficient' },
    to: 'collect',
    label: 'Alternative rework route',
  })
  const write = method.graph.nodes.find((node) => node.id === 'write')
  write.transitions = [
    { id: 'write-rework', when: { path: 'outcome', operator: 'not_equals', value: 'complete' }, to: 'verify', label: 'Rework' },
    { id: 'write-self-check', when: { path: 'outcome', operator: 'equals', value: 'retry' }, to: 'write', label: 'Retry locally' },
    write.transitions[0],
  ]
  const plan = compileMethodGraphView(method, { forceLayered: true })
  assert.deepEqual(
    new Set(plan.edges.map((edge) => edge.id)),
    new Set(methodSemanticGraph(method).relations.map((relation) => relation.id)),
  )
  assert.equal(plan.edges.filter((edge) => edge.source === 'verify' && edge.target === 'collect').length, 2)
  assert.ok(plan.edges.some((edge) => edge.source === edge.target && edge.id === 'write-self-check'))
  assert.ok(plan.edges.some((edge) => edge.id === 'write-rework'))
  assert.deepEqual(plan.quality, {
    complete: true,
    edgeCrossings: 0,
    edgeNodeIntersections: 0,
    nonOrthogonalSegments: 0,
    duplicateEndpointPairs: 0,
    nodeOverlaps: 0,
    labelNodeOverlaps: 0,
    labelEdgeIntersections: 0,
    labelOverlaps: 0,
  })
  assert.deepEqual(plan.diagnostics, [])
})

test('auto arrangement retains a selected anchor and the rendered flow falls back safely for invalid drafts', async () => {
  const method = await exampleMethod()
  const first = compileMethodGraphView(method, { forceLayered: true })
  const positions = positionsFromPlan(first)
  const arranged = arrangeMethodPositions(method, positions, 'write')
  assert.equal(arranged.error, null)
  assert.deepEqual(arranged.positions.write, positions.write)

  const invalid = structuredClone(method)
  invalid.graph.nodes[0].transitions[0].to = 'missing-node'
  const rendered = flowView(invalid, { positions }, null, 1)
  assert.equal(rendered.plan, null)
  assert.ok(rendered.compileError)
  assert.equal(rendered.nodes.length, invalid.graph.nodes.length)
})
