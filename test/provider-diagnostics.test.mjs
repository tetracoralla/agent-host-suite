import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectDirectProviders } from '../src/provider-diagnostics.mjs'

function state(components) {
  return { components: { 'direct-execution-runtime': { version: '0.2.2', command: 'runtime', args: [] }, ...components },
    runtime: { socketPath: 'isolated-test-socket' } }
}

const time = { root: '/private/time', adapterPath: '/private/time/adapter', profilePath: '/private/time/profile',
  manifestPath: '/private/time/manifest', inputSchemaPath: '/private/time/input', outputSchemaPath: '/private/time/output' }

test('a time-only environment diagnoses only its installed Provider', async () => {
  const requests = []
  const checks = await inspectDirectProviders(state({ 'migratory-time': time }), { ready: true }, async (_, args, options) => {
    const order = JSON.parse(options.input)
    requests.push({ args, order })
    return { status: 0, stdout: JSON.stringify({ calls: order.calls.map((call) => ({
      ...call, status: 'ok', result: { results: [{ localDateTime: '2026-08-24T21:00' }] },
    })) }) }
  })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].order.purpose, 'diagnostic')
  assert.deepEqual(requests[0].order.calls.map(({ id }) => id), ['time'])
  assert.equal(requests[0].args.includes('project'), false)
  assert.deepEqual(checks.map(({ id, status }) => [id, status]),
    [['tool.migratory-time.direct', 'ok'], ['runtime.semantic-probe', 'ok']])
})

test('a configured Provider without a diagnostic stays unobserved and is not called', async () => {
  let calls = 0
  const runner = async () => { calls++; throw new Error('must not invoke an undeclared probe') }
  const checks = await inspectDirectProviders(state({ independent: { capabilityProvider: { providerId: 'io.example.independent' } } }), { ready: true }, runner)
  assert.equal(calls, 0)
  assert.equal(checks[0].status, 'warning')
  assert.equal(checks[0].detail.observation, 'not-observed')
  assert.equal(checks.some(({ id }) => id === 'runtime.semantic-probe'), false)
  assert.deepEqual(await inspectDirectProviders(state({}), { ready: true }, runner), [])
})

test('replacement of a pilot binding never inherits the old product semantic claim', async () => {
  const checks = await inspectDirectProviders(state({ 'migratory-time': {
    ...time, capabilityProvider: { providerId: 'io.example.other-time' },
  } }), { ready: true }, async () => { throw new Error('unexpected run') })
  assert.equal(checks.length, 1)
  assert.equal(checks[0].detail.observation, 'not-observed')
})

test('wrong, duplicate, missing, or untrusted Provider results cannot pass diagnostics', async () => {
  const valid = { id: 'time', providerId: 'io.github.tetracoralla.migratory-time', status: 'ok',
    result: { results: [{ localDateTime: '2026-08-24T21:00' }] } }
  for (const calls of [null, [], [valid, valid], [{ ...valid, providerId: 'io.example.unrelated' }],
    [{ ...valid, result: { results: [{ localDateTime: '2026-08-24T20:00' }] } }],
    [{ ...valid, result: { results: [...valid.result.results, ...valid.result.results] } }]]) {
    const checks = await inspectDirectProviders(state({ 'migratory-time': time }), { ready: true },
      async () => ({ status: 0, stdout: JSON.stringify({ calls }) }))
    assert.equal(checks.find(({ id }) => id === 'runtime.semantic-probe').status, 'error')
  }
  const failed = await inspectDirectProviders(state({ 'migratory-time': time }), { ready: true },
    async () => { throw Object.assign(new Error('private provider failure'), { code: 'PROCESS_TIMEOUT' }) })
  assert.equal(failed.find(({ id }) => id === 'runtime.semantic-probe').detail.code, 'PROCESS_TIMEOUT')
  assert.equal(JSON.stringify(failed).includes('private provider failure'), false)
})

test('service-down diagnostics cover every configured Direct Provider', async () => {
  const checks = await inspectDirectProviders(state({ independent: { capabilityProvider: { providerId: 'io.example.independent' } } }),
    { ready: false }, async () => { throw new Error('unexpected run') })
  assert.equal(checks[0].id, 'tool.independent.direct')
  assert.equal(checks[0].status, 'error')
})
