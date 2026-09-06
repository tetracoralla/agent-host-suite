import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectExecutionRuntime } from '../src/runtime.mjs'
import { prepareRuntimeConfig } from '../src/config.mjs'
import { readExecutionOutcome, validExecutionOutcome } from '../src/execution-outcome.mjs'
import { fakeMcpConfig, fakeMcpCall, workOrder } from './helpers.mjs'

const partial = { status: 'partial', items: { total: 2, completed: 1, errors: 1, cancelled: 0, unknown: 0 }, errorCodes: [{ code: 'E_TIMEOUT', count: 1 }] }

test('outcome metadata is explicit and rejects inconsistent or content-bearing claims', () => {
  assert.deepEqual(readExecutionOutcome({ structuredContent: { status: 'error' } }), { status: 'not-reported', value: null })
  const read = (value, isError = false) => readExecutionOutcome({ _meta: { 'io.openadam.executionOutcome.v1': value }, isError })
  assert.deepEqual(read(partial), { status: 'reported', value: partial })
  for (const invalid of [
    { ...partial, message: 'private content' },
    { ...partial, status: 'completed' },
    { ...partial, items: { ...partial.items, total: 3 } },
    { ...partial, errorCodes: [{ code: 'message containing private content', count: 1 }] },
    { ...partial, errorCodes: [{ code: 'E_TIMEOUT', count: 3 }] },
  ]) assert.equal(read(invalid).status, 'invalid')
  assert.equal(read(partial, true).status, 'invalid')
  assert.equal(validExecutionOutcome(null), false)
})

test('legacy orders remain accepted; v0.2 requires a purpose and observes provider-declared partial results', async () => {
  const observations = []
  const runtime = new DirectExecutionRuntime(await prepareRuntimeConfig(fakeMcpConfig({ args: ['--partial-outcome'] })), {
    observationSink: { async write(event) { observations.push(event) } },
  })
  try {
    const legacy = workOrder('legacy', [fakeMcpCall('echo', { value: 'private-result' })])
    const oldResult = await runtime.runWorkOrder(legacy)
    assert.equal(oldResult.status, 'ok')
    assert.equal(observations[0].purpose, 'unspecified')
    assert.deepEqual(observations[0].outcome, { status: 'reported', value: partial })
    const modern = { ...legacy, schemaVersion: 'openadam.direct-work-order.v0.2', purpose: 'diagnostic' }
    const result = await runtime.runWorkOrder(modern)
    assert.equal(result.status, 'ok')
    assert.deepEqual(result.calls[0].result, oldResult.calls[0].result)
    assert.equal(observations[1].purpose, 'diagnostic')
    assert.equal(JSON.stringify(observations).includes('private-result'), false)
    for (const purpose of [undefined, 'invented']) {
      await assert.rejects(runtime.runWorkOrder({ ...modern, purpose }), /work order|work-order|JSON/iu)
    }
    await assert.rejects(runtime.runWorkOrder({ ...legacy, purpose: 'diagnostic' }), /work order|work-order/iu)
  } finally { await runtime.close() }
})
