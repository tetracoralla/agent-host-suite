import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { recordActivity } from '../src/activity.mjs'
import { writePrivateJson } from '../src/json.mjs'
import { operationsSnapshot, OPERATIONS_SNAPSHOT_MAX_BYTES } from '../src/operations-snapshot.mjs'
import { prepareStatePaths, saveState, STATE_SCHEMA } from '../src/state.mjs'

test('operations snapshot is bounded, path-free, and keeps Observer assessment outside the product', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-operations-snapshot-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateRoot = join(root, 'private', 'state')
  const paths = await prepareStatePaths(stateRoot)
  const now = new Date().toISOString()
  await saveState(paths, {
    schemaVersion: STATE_SCHEMA,
    suiteVersion: '0.1.0-dogfood.test',
    releaseId: 'test-release',
    channel: 'release',
    profile: 'observability',
    installedAt: now,
    updatedAt: now,
    releaseActivatedAt: now,
    workspaceRoot: join(root, 'workspace-secret'),
    components: { tool: { version: '1.0.0' } },
    agentComponents: ['tool'],
    hosts: { codex: { kind: 'codex', version: 'test', restartRequired: false, entries: [], operationsSkill: { kind: 'codex-plugin' } } },
    runtime: { service: null },
    observability: {
      enabled: true,
      consentedAt: now,
      latest: {
        refreshedAt: now,
        collection: {
          startedAtMs: 1,
          completedAtMs: 2,
          status: 'ok',
          providersOk: 1,
          providersPartial: 1,
          providersMissing: 0,
          providersError: 0,
          providers: [{ provider: 'codex', status: 'ok', scannedAtMs: 2 }],
          semanticSources: [{ source: 'deployment', status: 'ok', scannedAtMs: 2 }],
        },
        context: {
          catalog: { canonicalUtf8Bytes: 1000, largestToolUtf8Bytes: 200, rawCatalog: 'must-not-escape' },
          counts: { tools: 8, schemas: 16 },
          hardNameCollisions: 0,
        },
        report: {
          directRuntime: { status: 'observed' },
          freshSessionCorrelation: { codex: 'available', claude: 'unavailable' },
          suiteTools: [
            { provider: 'codex', toolName: 'mcp__tool__run', calls: 12, runtime: { measured: 0, completed: 0, errors: 0, cancelled: 0 }, currentAgentHostDeployment: { callsSinceActivation: 1, freshSessionCallsSinceActivation: 1, status: 'observed' } },
            { provider: 'claude', toolName: 'mcp__tool__inspect', calls: 3, runtime: { measured: 3, completed: 2, errors: 1, cancelled: 0 }, currentAgentHostDeployment: { callsSinceActivation: 0, freshSessionCallsSinceActivation: 0, status: 'declared-binding-only' } },
          ],
          totals: { completedToolCalls: 12 },
          activity: {
            providers: [{ provider: 'codex', observedSessions: 5 }],
            daily: Array.from({ length: 400 }, (_, index) => ({ provider: 'codex', utcDate: `day-${index}`, totalTokens: index })),
            dailyRowsAvailable: 400,
          },
          routingObservations: [{ raw: 'must-not-escape' }],
        },
      },
    },
  })
  for (let index = 0; index < 20; index += 1) {
    await recordActivity(paths, 'test.activity', `${index}:${'x'.repeat(800)}`, { private: join(root, 'must-not-escape') })
  }

  const snapshot = await operationsSnapshot({ stateRoot })
  const serialized = JSON.stringify(snapshot)
  assert.equal(snapshot.response.serializedBytes, Buffer.byteLength(serialized, 'utf8'))
  assert.equal(snapshot.response.serializedBytes <= OPERATIONS_SNAPSHOT_MAX_BYTES, true)
  assert.equal(snapshot.recentActivity.length, 12)
  assert.equal(snapshot.environment.workspaceGranted, true)
  assert.equal(snapshot.environment.hosts.codex.restartRequired, undefined)
  assert.deepEqual(snapshot.environment.hosts.codex.freshSession, {
    requiredAfterBindingChange: false,
    currentSessionUptake: 'not-observed',
  })
  assert.equal(serialized.includes(root), false)
  assert.equal(serialized.includes('must-not-escape'), false)
  assert.equal(snapshot.observability.privacy.modelCallsByObserver, 0)
  assert.deepEqual(snapshot.observability.toolUsage.tools.map((item) => item.toolName), ['mcp__tool__run', 'mcp__tool__inspect'])
  assert.equal(snapshot.observability.toolUsage.tools[0].currentReleaseFreshSessionCalls, 1)
  assert.equal(snapshot.observability.activity.providers[0].observedSessions, 5)
  assert.equal(snapshot.observability.activity.dailyRowsAvailable, 400)
  assert.equal(snapshot.observability.activity.dailyRowsOmitted, true)
  assert.equal(snapshot.observability.activity.daily, undefined)
  assert.match(snapshot.assessmentBoundary, /does not establish.*open Agent session.*causation/u)
})

test('operations snapshot exposes catalog budget checks and a live suite process baseline', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-snapshot-baseline-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateRoot = join(root, 'private', 'state')
  const paths = await prepareStatePaths(stateRoot)
  const now = new Date().toISOString()
  await saveState(paths, {
    schemaVersion: STATE_SCHEMA,
    suiteVersion: '0.1.0-dogfood.test',
    releaseId: 'test-release',
    channel: 'release',
    profile: 'observability',
    installedAt: now,
    updatedAt: now,
    components: { tool: { version: '1.0.0' } },
    agentComponents: ['tool'],
    hosts: {},
    runtime: { service: null },
    observability: {
      enabled: true,
      consentedAt: now,
      latest: {
        refreshedAt: now,
        context: {
          catalog: { canonicalUtf8Bytes: 191032, largestToolUtf8Bytes: 26234 },
          counts: { tools: 31, schemas: 62 },
          hardNameCollisions: 0,
        },
        report: { totals: {} },
      },
    },
  })
  await writePrivateJson(join(paths.context, 'managed-catalog.analysis.json'), {
    budgetChecks: [
      { metric: 'catalog.canonicalUtf8Bytes', actual: 191032, limit: 65536, status: 'exceeded' },
      { metric: 'counts.tools', actual: 31, limit: 64, status: 'within' },
      { metric: 'catalog.largestToolUtf8Bytes', actual: 26234, limit: 40000, status: 'within' },
    ],
  })

  const marker = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)', paths.root], { stdio: 'ignore' })
  try {
    const snapshot = await operationsSnapshot({ stateRoot })
    assert.deepEqual(snapshot.observability.catalog.budgetChecks, [
      { metric: 'catalog.canonicalUtf8Bytes', actual: 191032, limit: 65536, remaining: -125496, status: 'exceeded' },
      { metric: 'counts.tools', actual: 31, limit: 64, remaining: 33, status: 'within' },
      { metric: 'catalog.largestToolUtf8Bytes', actual: 26234, limit: 40000, remaining: 13766, status: 'within' },
    ])
    assert.equal(snapshot.processes.processCount >= 1, true, 'the marker process references the state root and must be counted')
    assert.equal(snapshot.processes.totalRssBytes > 0, true)
    assert.equal(typeof snapshot.processes.sampledAt, 'string')
  } finally {
    marker.kill('SIGKILL')
  }
})

test('operations snapshot prefers current Observer snapshots over stale Host cache without collecting', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-snapshot-current-observer-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateRoot = join(root, 'private', 'state')
  const paths = await prepareStatePaths(stateRoot)
  const nowMs = Date.now()
  const now = new Date(nowMs).toISOString()
  const observerRoot = join(root, 'observer')
  await mkdir(observerRoot, { recursive: true })
  await saveState(paths, {
    schemaVersion: STATE_SCHEMA,
    suiteVersion: '0.1.0-dogfood.test',
    releaseId: 'test-release',
    channel: 'release',
    profile: 'observability',
    installedAt: now,
    updatedAt: now,
    components: {
      'agent-tool-observer': { version: '0.6.0', command: '/observer/node', args: ['/observer/cli.mjs'], root: observerRoot },
    },
    agentComponents: [],
    hosts: {},
    runtime: { service: null, observationLog: join(root, 'private', 'observations.jsonl') },
    observability: {
      enabled: true,
      consentedAt: now,
      observer: { stateDir: join(root, 'private', 'observer'), installation: { intervalSeconds: 300 } },
      latest: {
        refreshedAt: '2026-01-01T00:00:00.000Z',
        collection: { completedAtMs: 1, status: 'completed', providersOk: 0 },
        report: { semanticExecutions: [], suiteTools: [], totals: { observedCalls: 0 } },
      },
    },
  })
  const status = {
    state: { toolEvents: 27, usageEvents: 11 },
    latestCollection: {
      started_at_ms: nowMs - 2_500,
      completed_at_ms: nowMs - 2_000,
      status: 'completed',
      providers_ok: 1,
      providers_partial: 0,
      providers_missing: 0,
      providers_error: 0,
    },
    providers: [{ provider: 'codex', status: 'ok', scannedAtMs: nowMs - 2_000 }],
    semanticSources: [],
  }
  const report = {
    schemaVersion: 'openadam.agent-tool-observer.report.v0.6',
    generatedAtMs: nowMs - 1_000,
    windowDays: 30,
    providers: [{ provider: 'codex', status: 'ok', errorCode: null, scannedAtMs: nowMs - 2_000 }],
    usage: [{ provider: 'codex', records: 11, totalTokens: 1234 }],
    activity: { providers: [{ provider: 'codex', observedSessions: 3, activeUtcDays: 2 }] },
    observationCoverage: {
      toolInvocation: { status: 'observed' },
      skillUse: { status: 'unavailable' },
      resultAdoption: { status: 'not-observed' },
      nonUseReason: { status: 'not-observed' },
    },
    cost: {},
    directRuntime: { status: 'not-observed' },
    freshSessionCorrelation: { adoptionStatus: 'not-assessed', routing: { observationRecordsTruncated: false } },
    semanticExecutions: [],
    routingObservations: [],
    tools: [],
  }
  const calls = []
  const runner = async (command, args) => {
    calls.push([command, args])
    if (command === '/bin/ps' || command === 'powershell.exe') return { status: 0, stdout: '', stderr: '' }
    if ((command === '/bin/launchctl' || command === 'schtasks.exe')) return { status: 0, stdout: '', stderr: '' }
    if (args.includes('status')) return { status: 0, stdout: JSON.stringify(status), stderr: '' }
    if (args.includes('report')) return { status: 0, stdout: JSON.stringify(report), stderr: '' }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
  }

  const snapshot = await operationsSnapshot({ stateRoot }, { runner })
  const serialized = JSON.stringify(snapshot)
  assert.equal(snapshot.observability.observationSource, 'current-observer-snapshots')
  assert.equal(Date.parse(snapshot.observability.refreshedAt) >= nowMs, true)
  assert.notEqual(snapshot.observability.refreshedAt, '2026-01-01T00:00:00.000Z')
  assert.equal(snapshot.observability.collection.providersOk, 1)
  assert.equal(snapshot.observability.freshness.status, 'current')
  assert.equal(snapshot.observability.collector.loaded, true)
  assert.equal(snapshot.observability.activity.providers[0].observedSessions, 3)
  assert.equal(snapshot.observability.observationCoverage.skillUse.status, 'unavailable')
  assert.equal(snapshot.observability.totals.observedCalls, 0)
  assert.equal(calls.some(([, args]) => args.includes('collect')), false)
  assert.equal(serialized.includes(root), false)
  assert.equal(snapshot.response.serializedBytes <= OPERATIONS_SNAPSHOT_MAX_BYTES, true)
})

test('operations snapshot accepts one shared current Observer read without launching the Observer again', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-snapshot-shared-observer-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const paths = await prepareStatePaths(root)
  const now = new Date().toISOString()
  await saveState(paths, {
    schemaVersion: STATE_SCHEMA,
    suiteVersion: '0.1.0-dogfood.test',
    releaseId: 'test-release',
    channel: 'release',
    profile: 'observability',
    installedAt: now,
    updatedAt: now,
    components: {},
    agentComponents: [],
    hosts: {},
    runtime: { service: null },
    observability: { enabled: true, consentedAt: now },
  })
  const runner = async (command) => {
    if (command === '/bin/ps' || command === 'powershell.exe') return { status: 0, stdout: '', stderr: '' }
    throw new Error('the injected Observer result must prevent a second Observer read')
  }
  const snapshot = await operationsSnapshot({ stateRoot: root }, {
    runner,
    currentObservability: Promise.resolve({
      observedAt: now,
      collection: null,
      report: { activity: { providers: [], daily: [] }, suiteTools: [], totals: {} },
      collector: null,
      freshness: null,
    }),
  })
  assert.equal(snapshot.observability.observationSource, 'current-observer-snapshots')
})
