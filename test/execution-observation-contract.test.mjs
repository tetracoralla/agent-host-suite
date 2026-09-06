import test from 'node:test'
import assert from 'node:assert/strict'
import { validExecutionOutcome as runtimeValid } from '../packages/direct-execution-runtime/src/execution-outcome.mjs'
import { validExecutionOutcome as observerValid } from '../packages/agent-tool-observer/src/core/execution-outcome.mjs'
import { semanticProbeOrder } from '../src/runtime-config.mjs'

test('independently packaged Runtime and Observer agree on the metadata boundary', () => {
  const valid = { status: 'partial', items: { total: 3, completed: 1, errors: 1, cancelled: 1, unknown: 0 }, errorCodes: [{ code: 'E_TIMEOUT', count: 1 }, { code: 'E_CANCELLED', count: 1 }] }
  const cases = [valid, null, [], {}, { ...valid, prompt: 'private' },
    { ...valid, status: 'completed' }, { ...valid, items: { ...valid.items, unknown: 1 } },
    { ...valid, errorCodes: [{ code: 'E_TIMEOUT', count: 3 }] },
    { ...valid, errorCodes: [{ code: 'E_TIMEOUT', count: 1 }, { code: 'E_TIMEOUT', count: 1 }] },
    { status: 'unknown', items: null, errorCodes: [] },
  ]
  for (const value of cases) assert.equal(runtimeValid(value), observerValid(value), JSON.stringify(value))
  assert.equal(runtimeValid(valid), true)
})

test('doctor explicitly labels new-runtime checks and preserves the legacy closed order', () => {
  assert.equal(semanticProbeOrder('0.2.2').purpose, 'diagnostic')
  assert.equal(semanticProbeOrder('0.2.1').schemaVersion, 'openadam.direct-work-order.v0.1')
  assert.equal(Object.hasOwn(semanticProbeOrder('0.2.1'), 'purpose'), false)
})
