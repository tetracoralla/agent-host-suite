import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareStatePaths, saveState, STATE_SCHEMA } from '../src/state.mjs'
import { projectUsageSummary, usageSummary, USAGE_SUMMARY_MAX_BYTES } from '../src/usage-summary.mjs'

function state(observability) {
  const now = '2026-09-02T00:00:00.000Z'
  return {
    schemaVersion: STATE_SCHEMA,
    suiteVersion: '0.1.3',
    channel: 'release',
    profile: 'observability',
    installedAt: now,
    updatedAt: now,
    components: {},
    hosts: {},
    runtime: {},
    observability,
  }
}

function report(root = '/private/must-not-escape') {
  return {
    generatedAtMs: Date.parse('2026-09-02T00:00:00.000Z'),
    windowDays: 30,
    providers: [{ provider: 'codex', status: 'ok', errorCode: null, scannedAtMs: 1 }],
    usage: [{ provider: 'codex', records: 3, inputTokens: 100, cachedInputTokens: 50, outputTokens: 20, reasoningTokens: 5, totalTokens: 120, averageDurationMs: 12.5, semantics: 'provider-reported-model-usage-record', peakObservedDailyTokens: 80, peakObservedDailyDate: '2026-09-01', dailyTokenSemantics: 'provider-records-grouped-by-utc-day', hiddenPath: root }],
    activity: {
      providers: [{ provider: 'codex', observedSessions: 2, observedTurns: 7, observedActiveDays: 1, firstObservedAtMs: 1, lastObservedAtMs: 2, longestObservedSessionSpanMs: 100, currentObservedDayStreak: 1, longestObservedDayStreak: 4 }],
      daily: [{ provider: 'codex', utcDate: '2026-09-01', toolCalls: 4, usageRecords: 2, observedSessions: 2, observedTurns: 3, inputTokens: 60, cachedInputTokens: 20, outputTokens: 10, reasoningTokens: 5, totalTokens: 80, hiddenPath: root }],
      dailyRowsAvailable: 1,
      dailyRowsTruncated: false,
      sessionSemantics: 'provider-scoped-hashed-session-identifiers',
      turnSemantics: 'provider-scoped-hashed-turn-identifiers-when-exposed',
      activeDaySemantics: 'utc-days-with-observed-tool-or-usage-metadata',
      dayStreakSemantics: 'consecutive-utc-days-with-observations',
    },
    suiteTools: Array.from({ length: 40 }, (_, index) => ({
      provider: 'codex',
      toolName: `mcp__fixture__tool_${index}_${'x'.repeat(400)}`,
      calls: 100 - index,
      runtime: { measured: 10, completed: 8, errors: 1, cancelled: 1, averageDurationMs: 4.5 },
      currentAgentHostDeployment: { callsSinceActivation: 4, freshSessionCallsSinceActivation: 2, status: 'observed' },
      firstObservedAtMs: 1,
      lastObservedAtMs: 2,
      rawPath: root,
    })),
    suiteExecutions: [{
      target: { kind: 'capability', capabilityId: 'io.openadam.fixture', capabilityVersion: '0.1.0', operationId: 'run' },
      providerId: 'fixture',
      providerVersion: '1.0.0',
      transport: 'direct-runtime',
      executions: 2,
      runtime: { completed: 1, providerErrors: 1, hostErrors: 0, averageDurationMs: 3, averageQueueMs: 1, averageProviderRoundTripMs: 2 },
      lastObservedAtMs: 2,
      rawPath: root,
    }],
    tracePlane: {
      adapters: [{
        id: 'openadam.zcode-model-io', provider: 'zcode', transport: 'stable-local-records',
        runtime: { status: 'ok', errorCode: null, scannedAtMs: 2, eventsWritten: 9, backlogSources: 0 },
      }],
      providers: [{ provider: 'zcode', modelSteps: 3, offeredToolObservations: 5, traceToolCalls: 2, traceToolResults: 2, turnEnds: 0 }],
      passiveStorage: 'metadata-only',
      interpretationStatus: 'not-performed',
    },
    observationCoverage: {
      toolInvocation: { status: 'observed', basis: 'provider-tool-call-metadata' },
      runtimeOutcome: { status: 'partial' },
      tokenUsage: { status: 'partial' },
      skillUse: { status: 'unavailable', reason: 'no-authoritative-skill-activation-events' },
      semanticEffect: { status: 'not-observed' },
      resultAdoption: { status: 'not-observed' },
      nonUseReason: { status: 'not-observed' },
    },
  }
}

test('usage summary is bounded, path-free, ranked, and preserves authority limits', () => {
  const root = '/private/must-not-escape'
  const result = projectUsageSummary(state({ enabled: true }), {
    observedAt: '2026-09-02T00:00:00.000Z',
    freshness: { status: 'current', latestCollectionCompletedAtMs: 3, ageMs: 1, overdueAfterMs: 2, hiddenPath: root },
    collection: { status: 'completed', providersOk: 1, sources: [{ provider: 'codex', status: 'ok' }] },
    report: report(root),
  })
  const serialized = JSON.stringify(result)
  assert.equal(result.tools.entries.length, 20)
  assert.equal(result.tools.available, 40)
  assert.equal(result.tools.entries[0].historicalCalls, 100)
  assert.equal(result.reliability.measuredToolCalls, 200)
  assert.equal(result.coverage.skillUse.status, 'unavailable')
  assert.equal(result.coverage.resultAdoption.status, 'not-observed')
  assert.deepEqual(result.freshness, { status: 'current', latestCollectionCompletedAtMs: 3, ageMs: 1, overdueAfterMs: 2 })
  assert.equal(result.providerUsage[0].peakObservedDailyTokens, 80)
  assert.equal(result.providerUsage[0].averageDurationMs, 12.5)
  assert.equal(result.providerActivity[0].longestObservedDayStreak, 4)
  assert.equal(result.dailyActivity.entries[0].totalTokens, 80)
  assert.equal(result.trace.adapters[0].id, 'openadam.zcode-model-io')
  assert.equal(result.trace.toolOffers, 5)
  assert.equal(result.trace.interpretationStatus, 'not-performed')
  assert.match(result.assessmentBoundary, /do not establish Skill activation/u)
  assert.equal(serialized.includes(root), false)
  assert.equal(Buffer.byteLength(serialized, 'utf8') <= USAGE_SUMMARY_MAX_BYTES, true)
  assert.equal(result.response.serializedBytes, Buffer.byteLength(serialized, 'utf8'))
})

test('usage summary falls back to a cached Host refresh without claiming current freshness', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-usage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const paths = await prepareStatePaths(root)
  await saveState(paths, state({
    enabled: true,
    latest: { refreshedAt: '2026-09-01T00:00:00.000Z', collection: null, report: report() },
  }))
  const result = await usageSummary({ stateRoot: root }, {
    readCurrentObservability: async () => { throw new Error('fixture outage') },
  })
  assert.equal(result.observationSource, 'cached-agent-host-refresh')
  assert.equal(result.currentReadErrorCode, 'OBSERVABILITY_CURRENT_READ_FAILED')
  assert.equal(result.freshness, null)
  assert.equal(result.providerUsage[0].totalTokens, 120)
})

test('usage summary accepts a shared current Observer read for a multi-result Manager refresh', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-usage-shared-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const paths = await prepareStatePaths(root)
  await saveState(paths, state({ enabled: true }))
  const result = await usageSummary({ stateRoot: root }, {
    currentObservability: Promise.resolve({
      observedAt: '2026-09-02T00:00:00.000Z',
      collection: null,
      report: report(),
      collector: null,
      freshness: null,
    }),
    readCurrentObservability: async () => { throw new Error('must not run') },
  })
  assert.equal(result.observationSource, 'current-observer-snapshots')
  assert.equal(result.providerUsage[0].totalTokens, 120)
})

test('usage summary represents uninstalled and monitoring-off environments without synthetic zero observations', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-usage-empty-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const uninstalled = await usageSummary({ stateRoot: root })
  assert.equal(uninstalled.configured, false)
  assert.equal(uninstalled.windowDays, null)
  const paths = await prepareStatePaths(root)
  await saveState(paths, state({ enabled: false }))
  const disabled = await usageSummary({ stateRoot: root })
  assert.equal(disabled.configured, true)
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.observationSource, 'none')
})
