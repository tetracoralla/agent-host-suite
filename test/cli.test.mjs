import assert from 'node:assert/strict'
import test from 'node:test'
import { human } from '../src/cli.mjs'

test('human storage status reports the current footprint and cleanup candidates', () => {
  const usage = (allocatedBytes, apparentBytes = allocatedBytes) => ({ allocatedBytes, apparentBytes, files: 0, directories: 0 })
  const output = human({
    status: 'ok',
    sections: {
      total: usage(10 * 1024 * 1024, 9 * 1024 * 1024),
      packages: usage(6 * 1024 * 1024),
      hostProjections: usage(32 * 1024),
      downloads: usage(0),
      runtime: usage(1024 * 1024),
      observations: usage(2 * 1024 * 1024),
      context: usage(512 * 1024),
      history: usage(256 * 1024),
      backups: usage(256 * 1024),
    },
    cleanup: { packageVersions: 2, downloads: 1, allocatedBytes: 3 * 1024 * 1024 },
  })
  assert.match(output, /Storage · 10\.0 MiB allocated \(9\.00 MiB apparent\)/u)
  assert.match(output, /Packages 6\.00 MiB/u)
  assert.match(output, /Cleanup · 2 package versions, 1 downloads, 3\.00 MiB eligible/u)
  assert.notEqual(output, 'ok')
})

test('human operations snapshot stays compact and reports monitoring freshness', () => {
  const output = human({
    schemaVersion: 'openadam.agent-host-operations-snapshot.v0.1',
    configured: true,
    environment: { suiteVersion: '0.1.0-dogfood.18', profile: 'local' },
    observability: { enabled: true, refreshedAt: '2026-08-28T12:00:00.000Z' },
    storage: { allocatedBytes: 4 * 1024 * 1024 },
  })
  assert.equal(output, 'Agent Host 0.1.0-dogfood.18 · local · monitoring refreshed 2026-08-28T12:00:00.000Z · 4.00 MiB allocated')
})

test('human observability status renders monitoring state instead of crashing on missing hosts', () => {
  const enabled = human({
    status: 'ok',
    configured: true,
    enabled: true,
    consentedAt: '2026-08-25T16:43:29.188Z',
    latest: { refreshedAt: '2026-08-28T13:43:19.792Z', deployment: {} },
    analysis: { status: 'ok', format: 'context-surface.analysis.v0.1' },
    privacy: { rawPromptStored: false, rawToolArgumentsStored: false, rawToolResultsStored: false, networkUsedByObserver: false, modelCallsByObserver: 0 },
  })
  assert.equal(enabled, 'Observability enabled · last refresh 2026-08-28T13:43:19.792Z.')
  const disabled = human({ status: 'ok', configured: true, enabled: false, consentedAt: null, latest: null, analysis: null, privacy: {} })
  assert.equal(disabled, 'Observability disabled · local data preserved.')
  const notInstalled = human({ status: 'ok', configured: false, enabled: false, privacy: {} })
  assert.equal(notInstalled, 'Observability off · no Agent environment installed.')
})
