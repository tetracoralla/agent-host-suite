import assert from 'node:assert/strict'
import test from 'node:test'
import { probeMcpToolsFirstAndRepeat } from '../src/mcp-health.mjs'

test('release probing separates first-launch allowance from the declared repeat budget', async () => {
  const time = [100, 18100, 20000, 20400]
  const timeouts = []
  const result = await probeMcpToolsFirstAndRepeat({ healthTimeoutMs: 30000 }, {
    now: () => time.shift(),
    probe: async (component) => {
      timeouts.push(component.healthTimeoutMs)
      return { status: 'ok', tools: ['example'], server: { name: 'fixture', version: '1' } }
    },
  })

  assert.deepEqual(timeouts, [60000, 30000])
  assert.equal(result.firstLaunchMs, 18000)
  assert.equal(result.repeatLaunchMs, 400)
  assert.deepEqual(result.repeat.tools, ['example'])
})

test('release probing retains the default ordinary health budget', async () => {
  const timeouts = []
  await probeMcpToolsFirstAndRepeat({}, {
    now: () => 0,
    probe: async (component) => {
      timeouts.push(component.healthTimeoutMs)
      return { status: 'ok', tools: [], server: null }
    },
  })

  assert.deepEqual(timeouts, [60000, 10000])
})

test('release probing rejects a catalog that changes after first launch', async () => {
  let launch = 0
  await assert.rejects(
    () => probeMcpToolsFirstAndRepeat({}, {
      now: () => 0,
      probe: async () => ({
        status: 'ok',
        tools: launch++ === 0 ? ['first'] : ['second'],
        server: { name: 'fixture', version: '1' },
      }),
    }),
    (error) => error.code === 'TOOL_HEALTH_CATALOG_UNSTABLE',
  )
})
