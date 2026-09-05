import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { compareCalls, consumeCall, consumerOrder, timeZoneTarget } from '../scripts/substitution-consumer.mjs'

const cases = [{ id: 'fixed', input: { localDateTime: '2026-08-03T08:30', sourceTimeZone: 'UTC', targetTimeZones: ['UTC'] } }]
const successful = {
  id: 'fixed', providerId: 'first', target: { ...timeZoneTarget }, binding: { contractDigest: 'sha256:contract' }, status: 'ok',
  result: { status: 'converted', context: { calendar: 'iso8601', timeZoneDatabase: '2026a' },
    source: { localDateTime: '2026-08-03T08:30', timeZone: 'UTC' }, instant: '2026-08-03T08:30:00Z',
    results: [{ timeZone: 'UTC', localDateTime: '2026-08-03T08:30', offset: '+00:00' }] },
}
const options = { providerId: 'first', contractDigest: 'sha256:contract', assertUtcConversion: () => {} }

test('substitution changes only the explicit Provider coordinate', () => {
  const before = structuredClone(cases)
  const first = consumerOrder(cases, 'first')
  const second = consumerOrder(cases, 'second')
  first.calls[0].providerId = 'second'
  assert.deepEqual(first, second)
  first.calls[0].input.targetTimeZones.reverse()
  first.calls[0].input.localDateTime = 'changed'
  assert.deepEqual(cases, before)
})

test('consumer preserves semantic differences and rejects host failures, missing results and binding drift', () => {
  const expected = compareCalls(cases, [successful], options)
  const changedDatabase = structuredClone(successful)
  changedDatabase.result.context.timeZoneDatabase = 'other-database'
  compareCalls(cases, [changedDatabase], { ...options, expected })
  assert.equal(successful.result.context.timeZoneDatabase, '2026a')
  const mutations = [
    (value) => { value.status = 'host_error'; value.error = { code: 'HOST_TIMEOUT' } },
    (value) => { value.providerId = 'unexpected' },
    (value) => { value.id = 'mis-correlated' },
    (value) => { value.target.capabilityVersion = '0.3.0' },
    (value) => { value.binding.contractDigest = 'changed' },
    (value) => { value.result.instant = '2026-08-03T09:30:00Z' },
    (value) => { value.result.context.calendar = 'wrong-calendar' },
    (value) => { delete value.result.context.timeZoneDatabase },
    (value) => { value.status = 'provider_error'; value.error = { code: 'UNKNOWN_TIME_ZONE', retryable: false } },
  ]
  for (const mutate of mutations) {
    const value = structuredClone(successful)
    mutate(value)
    assert.throws(() => compareCalls(cases, [value], { ...options, expected }))
  }
  assert.throws(() => compareCalls(cases, [], options))
})

test('domain error code and retryability survive while diagnostic wording stays Provider owned', () => {
  const domain = { ...successful, status: 'provider_error', error: { code: 'UNKNOWN_TIME_ZONE', retryable: false, message: 'one' } }
  const expected = compareCalls(cases, [domain], options)
  domain.error.message = 'another message'
  compareCalls(cases, [domain], { ...options, expected })
  domain.error.retryable = true
  assert.throws(() => compareCalls(cases, [domain], { ...options, expected }))
  assert.throws(() => consumeCall({ status: 'host_error', error: { code: 'HOST_TIMEOUT' } }))
})

test('an unavailable prerequisite returns incomplete with exit 2 before any Provider executes', { skip: process.platform === 'win32' }, async () => {
  const empty = await mkdtemp(resolve(tmpdir(), 'substitution-absent-'))
  try {
    const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/check-local-substitution.mjs', import.meta.url))], {
      env: { ...process.env, OPENADAM_CAPABILITY_CONTRACTS_ROOT: empty, OPENADAM_MIGRATORY_TIME_SOURCE_ROOT: empty },
      timeout: 10000,
    }).catch((error) => error)
    assert.equal(result.code, 2)
    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.execution, 'not_run')
    assert.equal(report.unavailable.length, 3)
  } finally {
    await rm(empty, { recursive: true, force: true })
  }
})
