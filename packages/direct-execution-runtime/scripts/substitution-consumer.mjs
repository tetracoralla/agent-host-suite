import assert from 'node:assert/strict'
import { digestJson } from '../src/json.mjs'

export const timeZoneTarget = Object.freeze({
  kind: 'capability', capabilityId: 'org.openadam.time-zone.convert',
  capabilityVersion: '0.2.0', operationId: 'convert',
})

export function consumerOrder(cases, providerId, id = 'substitution') {
  return {
    schemaVersion: 'openadam.direct-work-order.v0.1', id,
    calls: cases.map((entry) => ({
      id: entry.id, providerId, target: { ...timeZoneTarget }, input: structuredClone(entry.input),
    })),
  }
}

// One unchanged semantic consumer is used for every Provider and carrier.
// Host failures cannot become an agreed domain outcome. The sole omitted
// result field is the time-zone suite's explicit database-provenance exception.
export function consumeCall(call) {
  if (call.status === 'provider_error') {
    assert.equal(typeof call.error?.code, 'string')
    assert.equal(typeof call.error?.retryable, 'boolean')
    return { outcome: 'error', code: call.error.code, retryable: call.error.retryable }
  }
  assert.equal(call.status, 'ok', `${call.providerId}/${call.id}: execution failed: ${call.error?.code ?? call.status}`)
  assert.ok(['converted', 'ambiguous', 'nonexistent'].includes(call.result?.status))
  assert.equal(typeof call.result.context?.timeZoneDatabase, 'string', 'database provenance is required')
  assert.ok(call.result.context.timeZoneDatabase.length > 0)
  const value = structuredClone(call.result)
  delete value.context.timeZoneDatabase
  return { outcome: 'success', value }
}

export function compareCalls(cases, calls, { providerId, contractDigest, expected, assertUtcConversion }) {
  assert.equal(calls.length, cases.length, 'missing or surplus consumer result')
  return calls.map((call, index) => {
    const entry = cases[index]
    assert.equal(call.id, entry.id, 'result correlation changed')
    assert.equal(call.providerId, providerId, 'selected Provider changed')
    assert.deepEqual(call.target, timeZoneTarget, 'semantic target changed')
    const outcome = consumeCall(call)
    assert.equal(call.binding?.contractDigest, contractDigest, 'executed contract changed')
    if (entry.id.startsWith('generated-utc-')) {
      assert.equal(outcome.outcome, 'success', 'supported generated UTC input failed')
      assertUtcConversion(entry.input, call.result)
    }
    if (expected !== undefined && digestJson(outcome) !== digestJson(expected[index])) {
      throw new Error(`${entry.id}: consumer semantics differ (${digestJson(outcome)} versus ${digestJson(expected[index])})`)
    }
    return outcome
  })
}

export function timingSummary(samples) {
  assert.ok(samples.length > 0 && samples.every((value) => Number.isFinite(value) && value >= 0))
  const sorted = [...samples].sort((left, right) => left - right)
  const at = (fraction) => Number(sorted[Math.floor((sorted.length - 1) * fraction)].toFixed(3))
  return { samples: sorted.length, min: at(0), p50: at(0.5), p95: at(0.95), max: at(1) }
}
