import assert from 'node:assert/strict'
import test from 'node:test'
import { warmInstalledAgentComponents } from '../src/component-warmup.mjs'

function health(id, firstLaunchMs, repeatLaunchMs) {
  return {
    first: { status: 'ok', tools: [`${id}.tool`] },
    repeat: { status: 'ok', tools: [`${id}.tool`] },
    firstLaunchMs,
    repeatLaunchMs,
  }
}

test('selected Agent tools warm sequentially on their final installed commands', async () => {
  let concurrent = 0
  let peak = 0
  const seen = []
  const manifest = {
    components: {
      'math-anchor': { version: '0.4.0', root: '/packages/math', command: '/packages/math/math', args: ['mcp'] },
      'data-transformer': {
        version: '0.2.0', root: '/packages/data', command: '/packages/data/adt-mcp', args: [], cwd: '/packages/data',
        expectedTools: ['data_transform'], workspaceEnvironment: ['ADT_WORKSPACE_ROOT'], healthTimeoutMs: 30_000,
      },
      laniakea: { version: '0.2.1', root: '/packages/laniakea', command: '/packages/laniakea/server', args: [], expectedTools: ['create_mind_map'] },
    },
  }
  const result = await warmInstalledAgentComponents({
    manifest,
    componentIds: ['math-anchor', 'data-transformer'],
    workspaceRoot: '/workspace',
  }, {
    probe: async (component) => {
      concurrent += 1
      peak = Math.max(peak, concurrent)
      seen.push(component)
      await Promise.resolve()
      concurrent -= 1
      return health(component.command.includes('math') ? 'math' : 'data', seen.length * 10, 1)
    },
  })

  assert.equal(peak, 1)
  assert.deepEqual(seen.map((item) => item.command), ['/packages/math/math', '/packages/data/adt-mcp'])
  assert.deepEqual(seen[0].expectedTools, ['math.batch', 'math.describe', 'math.run', 'math.search'])
  assert.equal(seen[1].healthWorkspaceRoot, '/workspace')
  assert.deepEqual(result.components.map((item) => item.id), ['math-anchor', 'data-transformer'])
  assert.equal(result.strategy, 'sequential-first-and-repeat')
})

test('selected Agent tools without a live MCP health target fail closed', async () => {
  await assert.rejects(
    warmInstalledAgentComponents({
      manifest: { components: { unknown: { version: '1.0.0', root: '/packages/unknown' } } },
      componentIds: ['unknown'],
      workspaceRoot: null,
    }),
    (error) => error.code === 'COMPONENT_WARMUP_UNAVAILABLE',
  )
})

test('an update with no changed Agent-tool fingerprints skips process launch', async () => {
  let called = false
  const result = await warmInstalledAgentComponents({
    manifest: { components: {} },
    componentIds: [],
    workspaceRoot: null,
  }, { probe: async () => { called = true } })

  assert.equal(called, false)
  assert.deepEqual(result, { status: 'skipped', strategy: 'no-agent-tool-fingerprint-change', components: [] })
})
