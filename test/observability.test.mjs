import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { configuredSemanticProviderIds, contextAnalyzerInvocation, disableObservability, enableObservability, exportObservabilityTrace, maintenance, observabilityAdapterPlan, observabilityAdapters, observabilitySummary, observabilityTraceSources, readCurrentObservability, refreshObservability, semanticExecutionTotals } from '../src/observability.mjs'
import { assessManagedCatalog, MANAGED_CATALOG_BUDGETS, retryableCatalogError, validateManagedToolBindings } from '../src/context-exporter.mjs'
import { loadState, prepareStatePaths, saveState, STATE_SCHEMA } from '../src/state.mjs'

test('local dogfood cannot disable monitoring and leave a consent-bearing profile incomplete', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-observability-profile-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  const paths = await prepareStatePaths(stateRoot)
  await saveState(paths, {
    schemaVersion: STATE_SCHEMA,
    suiteVersion: '0.1.0-dogfood.3',
    channel: 'release',
    profile: 'local-dogfood',
    installedAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    components: {},
    hosts: {},
    runtime: {},
    observability: { enabled: true },
  })

  await assert.rejects(
    disableObservability({ stateRoot }),
    (error) => error.code === 'OBSERVABILITY_PROFILE_REQUIRES_ENABLED',
  )
})

test('a failed post-commit monitoring activity append returns a warning without restoring enabled state', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-observability-post-commit-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  const paths = await prepareStatePaths(stateRoot)
  await saveState(paths, {
    schemaVersion: STATE_SCHEMA,
    suiteVersion: '0.1.4',
    channel: 'release',
    profile: 'standard',
    installedAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
    components: {
      'agent-tool-observer': { command: '/private/node', args: ['/private/observer/cli.mjs'], root: '/private/observer' },
      'context-surface-analyzer': { command: '/private/node', args: ['/private/analyzer/cli.mjs'], root: '/private/analyzer' },
    },
    hosts: {},
    runtime: { observationLog: '/private/direct-runtime.jsonl' },
    observability: {
      enabled: true,
      maintenance: null,
      observer: { stateDir: '/private/observer-state', priorLaunchAgent: { existed: false } },
    },
  })
  const result = await disableObservability({ stateRoot }, {
    runner: async () => ({ status: 0, stdout: JSON.stringify({ status: 'uninstalled' }), stderr: '' }),
    recordActivity: async () => { throw new Error('injected activity append failure') },
  })
  assert.equal(result.status, 'disabled')
  assert.deepEqual(result.warnings, [{
    code: 'ACTIVITY_LOG_WRITE_FAILED',
    message: 'The monitoring change succeeded, but its activity entry could not be recorded.',
  }])
  assert.equal((await loadState(paths)).observability.enabled, false)
})

test('monitoring enable removes its activated carrier when state commit fails', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-observability-enable-compensation-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  const paths = await prepareStatePaths(stateRoot)
  const current = {
    schemaVersion: STATE_SCHEMA,
    suiteVersion: '0.1.4',
    channel: 'release',
    profile: 'standard',
    installedAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
    components: {
      'agent-tool-observer': { command: '/private/node', args: ['/private/observer/cli.mjs'], root: '/private/observer' },
      'context-surface-analyzer': { command: '/private/node', args: ['/private/analyzer/cli.mjs'], root: '/private/analyzer' },
    },
    hosts: {},
    runtime: { observationLog: '/private/direct-runtime.jsonl' },
    observability: { enabled: false },
  }
  await saveState(paths, current)
  let teardowns = 0
  await assert.rejects(
    enableObservability({ stateRoot }, {
      activateObservability: async (candidate) => ({ ...candidate, observability: { enabled: true } }),
      teardownObservability: async () => { teardowns += 1 },
      saveState: async () => { throw new Error('injected monitoring enable commit failure') },
    }),
    /injected monitoring enable commit failure/u,
  )
  assert.equal(teardowns, 1)
  assert.deepEqual(await loadState(paths), current)
})

test('monitoring disable rebinds its prior carrier when state commit fails', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-observability-disable-compensation-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  const paths = await prepareStatePaths(stateRoot)
  const current = {
    schemaVersion: STATE_SCHEMA,
    suiteVersion: '0.1.4',
    channel: 'release',
    profile: 'observability',
    installedAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
    components: {
      'agent-tool-observer': { command: '/private/node', args: ['/private/observer/cli.mjs'], root: '/private/observer' },
      'context-surface-analyzer': { command: '/private/node', args: ['/private/analyzer/cli.mjs'], root: '/private/analyzer' },
    },
    hosts: {},
    runtime: { observationLog: '/private/direct-runtime.jsonl' },
    observability: { enabled: true, observer: {}, maintenance: null },
  }
  await saveState(paths, current)
  let rebinds = 0
  await assert.rejects(
    disableObservability({ stateRoot }, {
      teardownObservability: async () => ({ removed: true }),
      rebindObservability: async () => { rebinds += 1 },
      saveState: async () => { throw new Error('injected monitoring disable commit failure') },
    }),
    /injected monitoring disable commit failure/u,
  )
  assert.equal(rebinds, 1)
  assert.deepEqual(await loadState(paths), current)
})

test('monitoring refresh and maintenance disclose possible partial Observer effects', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-observability-partial-effects-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  const paths = await prepareStatePaths(stateRoot)
  await saveState(paths, {
    schemaVersion: STATE_SCHEMA,
    suiteVersion: '0.1.4',
    channel: 'release',
    profile: 'observability',
    installedAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
    components: {
      'agent-tool-observer': { command: '/private/node', args: ['/private/observer/cli.mjs'], root: '/private/observer' },
      'context-surface-analyzer': { cliCommand: '/private/node', cliArgs: ['/private/analyzer/cli.mjs'], root: '/private/analyzer' },
    },
    hosts: {},
    runtime: { observationLog: '/private/direct-runtime.jsonl' },
    observability: { enabled: true, observer: { stateDir: '/private/observer-state' }, maintenance: null },
  })
  const runner = async () => { throw new Error('injected Observer collection failure') }

  await assert.rejects(
    refreshObservability({ stateRoot }, { runner }),
    (error) => error.code === 'OBSERVABILITY_REFRESH_FAILED'
      && error.details.effects.observerCollectionOrIngestionMayHaveOccurred === true
      && error.details.effects.hostStateCommitted === false,
  )
  await assert.rejects(
    maintenance({ stateRoot }, { runner }),
    (error) => error.code === 'OBSERVABILITY_MAINTENANCE_PARTIAL'
      && error.details.effects.observerRefreshCompleted === false
      && error.details.effects.hostStateCommitted === false,
  )
})

test('maintenance discloses possible storage changes once cleanup has started', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-observability-storage-effects-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  const paths = await prepareStatePaths(stateRoot)
  await saveState(paths, {
    schemaVersion: STATE_SCHEMA,
    suiteVersion: '0.1.5',
    channel: 'release',
    profile: 'observability',
    installedAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
    components: {
      'agent-tool-observer': { version: '0.5.0', command: '/private/node', args: ['/private/observer/cli.mjs'], root: '/private/observer' },
      'context-surface-analyzer': { version: '0.1.2', cliCommand: '/private/node', cliArgs: ['/private/analyzer/cli.mjs'], root: '/private/analyzer' },
    },
    agentComponents: [],
    hosts: {},
    runtime: { observationLog: '/private/direct-runtime.jsonl' },
    observability: { enabled: true, observer: { stateDir: '/private/observer-state' }, maintenance: null },
  })
  const runner = async (_command, args) => {
    if (args.includes('analyze')) {
      return {
        status: 0,
        stdout: JSON.stringify({
          status: 'ok', format: 'context-surface.analysis.v0.1',
          source: { id: 'test-source', revision: 'test-revision' }, snapshot: {},
          catalog: { sha256: 'test-catalog', canonicalUtf8Bytes: 0 },
          counts: { tools: 0, schemas: 0 }, hardNameCollisions: [], exactDuplicateSchemas: [],
        }),
        stderr: '',
      }
    }
    const operation = args[1]
    if (operation === 'report') {
      return {
        status: 0,
        stdout: JSON.stringify({
          schemaVersion: 'openadam.agent-tool-observer.report.v0.8',
          generatedAtMs: Date.now(), windowDays: 30, providers: [], usage: {},
          activity: null, cost: {}, directRuntime: {}, semanticExecutions: [], tools: [],
        }),
        stderr: '',
      }
    }
    return {
      status: 0,
      stdout: JSON.stringify(operation === 'maintain' ? { status: 'ok', removed: {} } : { status: 'ok' }),
      stderr: '',
    }
  }
  let cleanupStarted = false

  await assert.rejects(
    maintenance({ stateRoot }, {
      runner,
      cleanupStorage: async () => {
        cleanupStarted = true
        throw new Error('injected storage cleanup failure after a partial effect')
      },
    }),
    (error) => error.code === 'OBSERVABILITY_MAINTENANCE_PARTIAL'
      && error.details.effects.observerRefreshCompleted === true
      && error.details.effects.hostStateCommitted === true
      && error.details.effects.observerRetentionMayHaveChanged === true
      && error.details.effects.hostStorageMayHaveChanged === true,
  )
  assert.equal(cleanupStarted, true)
})

test('context analysis uses its auxiliary CLI when the same component also exposes an MCP runtime', () => {
  assert.deepEqual(contextAnalyzerInvocation({
    command: '/private/package/runtime/node',
    args: ['./src/mcp-server.js'],
    cliCommand: '/private/package/node/bin/node',
    cliArgs: ['/private/package/src/cli.js'],
  }), {
    command: '/private/package/node/bin/node',
    args: ['/private/package/src/cli.js'],
  })
})

test('catalog export retries only bounded MCP timeout failures', () => {
  assert.equal(retryableCatalogError({ code: -32001, message: 'Request timed out' }), true)
  assert.equal(retryableCatalogError({ code: 'CATALOG_INVALID', message: 'bad schema' }), false)
})

test('deployment tool-name conflicts fail in Agent Host before Observer ingestion', () => {
  assert.throws(() => validateManagedToolBindings([
    { id: 'math-anchor', toolNames: ['math.run'] },
    { id: 'other-math', toolNames: ['MATH_RUN'] },
  ]), (error) => error.code === 'AGENT_TOOL_BINDING_CONFLICT'
    && error.details.first.component === 'math-anchor'
    && error.details.conflicting.component === 'other-math')
})

test('catalog assessment uses the same canonical bytes as the declared Agent budget', () => {
  const within = assessManagedCatalog({
    tools: [{ name: 'small', description: 'small', inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }],
    budgets: MANAGED_CATALOG_BUDGETS,
  })
  assert.equal(within.status, 'within')
  assert.equal(within.toolCount, 1)
  assert.equal(within.headroom.catalogUtf8Bytes, MANAGED_CATALOG_BUDGETS.maxCatalogUtf8Bytes - within.canonicalUtf8Bytes)

  const exceeded = assessManagedCatalog({
    tools: [{ name: 'large', description: 'x'.repeat(65_536), inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }],
    budgets: MANAGED_CATALOG_BUDGETS,
  })
  assert.equal(exceeded.status, 'exceeded')
  assert.equal(exceeded.headroom.catalogUtf8Bytes < 0, true)
  assert.deepEqual(exceeded.exceeded.map((item) => item.metric), ['catalog.canonicalUtf8Bytes', 'catalog.largestToolUtf8Bytes'])
})

test('observability summary preserves provider coverage and bounded-routing disclosure', () => {
  const correlation = {
    providers: [{ provider: 'claude', coverageStatus: 'unavailable-for-observed-calls' }],
    routing: { observationRecordsReturned: 100, observationRecordsTruncated: true },
    adoptionStatus: 'not-assessed',
  }
  const summary = observabilitySummary({
    enabled: true,
    consentedAt: '2026-08-28T00:00:00.000Z',
    observer: { stateDir: '/private/observer', installation: { intervalSeconds: 300 } },
    maintenance: { intervalSeconds: 604800 },
    latest: {
      refreshedAt: '2026-08-28T00:00:01.000Z',
      deployment: null,
      context: { catalog: {}, counts: {}, hardNameCollisions: 0 },
      report: {
        freshSessionCorrelation: correlation,
        totals: {
          freshSessionSuiteToolCalls: 0,
          freshSessionRoutingObservationsReturned: 100,
          freshSessionRoutingObservationsTruncated: true,
        },
      },
    },
  })
  assert.deepEqual(summary.latest.freshSessionCorrelation, correlation)
  assert.equal(summary.latest.totals.freshSessionRoutingObservationsReturned, 100)
  assert.equal('freshSessionRoutingTurns' in summary.latest.totals, false)
})

test('semantic totals come from current Direct Runtime observations, not retired receipt projections', () => {
  assert.deepEqual(semanticExecutionTotals([
    { target: { kind: 'procedure' }, executions: 3 },
    { target: { kind: 'capability' }, executions: 5 },
    { target: { kind: 'mcp-operation' }, executions: 8 },
  ]), { procedureEvents: 3, capabilityEvents: 5 })
  assert.deepEqual(semanticExecutionTotals(undefined), { procedureEvents: 0, capabilityEvents: 0 })
  assert.throws(() => semanticExecutionTotals([
    { target: { kind: 'procedure' }, executions: -1 },
  ]), (error) => error.code === 'OBSERVABILITY_REPORT_UNSUPPORTED')
  assert.throws(() => semanticExecutionTotals([
    { target: { kind: 'future-semantic-kind' }, executions: 1 },
  ]), (error) => error.code === 'OBSERVABILITY_REPORT_UNSUPPORTED')
})

test('semantic provider selection follows the active installed component inventory', () => {
  const ids = configuredSemanticProviderIds({
    agentComponents: ['math-anchor', 'data-transformer'],
    components: {
      'math-anchor': {},
      'migratory-time': {},
      'data-transformer': { capabilityProvider: { providerId: 'io.example.structured-data' } },
      inactive: { capabilityProvider: { providerId: 'io.example.inactive' } },
    },
  })
  assert.deepEqual([...ids].sort(), ['io.example.structured-data', 'io.github.tetracoralla.math-anchor'])
})

test('current monitoring read bypasses stale Agent Host cache without collecting or mutating', async () => {
  const nowMs = Date.parse('2026-09-01T12:00:00.000Z')
  const report = {
    schemaVersion: 'openadam.agent-tool-observer.report.v0.6',
    generatedAtMs: nowMs - 1_000,
    windowDays: 30,
    providers: [{ provider: 'codex', status: 'ok', errorCode: null, scannedAtMs: nowMs - 2_000 }],
    usage: [{ provider: 'codex', records: 2, totalTokens: 100 }],
    activity: { providers: [{ provider: 'codex', observedSessions: 1 }] },
    tracePlane: {
      adapters: [{
        id: 'openadam.zcode-model-io',
        provider: 'zcode',
        transport: 'stable-local-records',
        runtime: { status: 'ok', errorCode: null, providerVersion: '0.16.5', scannedAtMs: nowMs - 2_000, eventsWritten: 3, backlogSources: 0, hiddenPath: '/must/not/escape' },
      }],
      providers: [{ provider: 'zcode', modelSteps: 3, offeredToolObservations: 5, traceToolCalls: 2, traceToolResults: 2, turnEnds: 0, hiddenPath: '/must/not/escape' }],
      passiveStorage: 'metadata-only',
      explicitAnalysisPack: { retainedSessionContentPolicy: 'metadata-only', retainedSessionSelectedContentAvailable: false },
      interpretationStatus: 'not-performed',
    },
    observationCoverage: { skillUse: { status: 'unavailable' } },
    cost: {},
    directRuntime: { status: 'ok' },
    freshSessionCorrelation: { adoptionStatus: 'not-assessed', routing: { observationRecordsTruncated: false } },
    semanticExecutions: [
      { providerId: 'io.example.structured-data', target: { kind: 'capability' }, executions: 2 },
      { providerId: 'io.example.unmanaged', target: { kind: 'capability' }, executions: 7 },
    ],
    routingObservations: [],
    tools: [{
      provider: 'codex',
      toolName: 'mcp__math_anchor__math_run',
      calls: 1,
      runtime: { measured: 1, completed: 1, errors: 0, cancelled: 0 },
      payload: {},
      turnAssociatedUsage: {},
      firstObservedAtMs: nowMs - 2_000,
      lastObservedAtMs: nowMs - 2_000,
      currentAgentHostDeployment: {
        componentId: 'math-anchor',
        callsSinceActivation: 1,
        freshSessionCallsSinceActivation: 1,
      },
    }],
  }
  const status = {
    state: { toolEvents: 1, usageEvents: 2 },
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
  const calls = []
  const runner = async (command, args) => {
    calls.push([command, args])
    if (command === '/bin/launchctl') return { status: 0, stdout: '', stderr: '' }
    if (args.includes('status')) return { status: 0, stdout: JSON.stringify(status), stderr: '' }
    if (args.includes('report')) return { status: 0, stdout: JSON.stringify(report), stderr: '' }
    throw new Error('unexpected command')
  }
  const current = await readCurrentObservability({
    components: {
      'agent-tool-observer': { command: '/observer/node', args: ['/observer/cli.mjs'], root: '/observer' },
      'data-transformer': { capabilityProvider: { providerId: 'io.example.structured-data' } },
    },
    agentComponents: ['agent-tool-observer', 'data-transformer'],
    runtime: { observationLog: '/private/observations.jsonl' },
    observability: {
      enabled: true,
      observer: { stateDir: '/private/observer', installation: { intervalSeconds: 300 } },
    },
  }, runner, nowMs)
  assert.equal(current.report.schemaVersion, report.schemaVersion)
  assert.equal(current.report.totals.freshSessionSuiteToolCalls, 1)
  assert.deepEqual(current.report.suiteExecutions.map((item) => item.providerId), ['io.example.structured-data'])
  assert.equal(current.report.tracePlane.adapters[0].provider, 'zcode')
  assert.equal(current.report.tracePlane.providers[0].modelSteps, 3)
  assert.equal(JSON.stringify(current.report.tracePlane).includes('/must/not/escape'), false)
  assert.deepEqual(current.report.activity, report.activity)
  assert.equal(current.collector.loaded, true)
  assert.equal(current.freshness.status, 'current')
  assert.equal(calls.some(([, args]) => args.includes('collect')), false)
})

test('Agent Host exports one explicitly selected trace through the installed Observer without reading source', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-trace-export-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  const paths = await prepareStatePaths(stateRoot)
  await saveState(paths, {
    schemaVersion: STATE_SCHEMA,
    suiteVersion: '0.1.3',
    channel: 'release',
    profile: 'observability',
    installedAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    components: {
      'agent-tool-observer': { command: '/private/node', args: ['/private/observer/cli.mjs'], root: '/private/observer' },
    },
    hosts: {},
    runtime: { observationLog: '/private/direct-runtime.jsonl' },
    observability: { enabled: true, observer: { stateDir: '/private/observer-state' } },
  })
  const calls = []
  const result = await exportObservabilityTrace({
    stateRoot,
    provider: 'zcode',
    file: '/selected/model-io.jsonl',
    output: '/selected/analysis.json',
    maxEvents: 25,
    maxOutputBytes: 65_536,
    includeSelectedContent: true,
    confirmSensitiveContent: true,
  }, {
    runner: async (command, args, options) => {
      calls.push({ command, args, options })
      return { status: 0, stdout: JSON.stringify({ status: 'completed', eventsReturned: 2, contentPolicy: 'selected-content' }), stderr: '' }
    },
  })
  assert.equal(result.status, 'completed')
  assert.deepEqual(calls[0].args, [
    '/private/observer/cli.mjs', 'trace-export', '--provider', 'zcode',
    '--file', '/selected/model-io.jsonl', '--output', '/selected/analysis.json',
    '--max-events', '25', '--max-output-bytes', '65536',
    '--include-selected-content', '--confirm-sensitive-content', '--json',
  ])
  assert.equal(calls[0].options.cwd, '/private/observer')
  assert.equal(calls[0].options.env.ATO_STATE_DIR, '/private/observer-state')
})

test('Agent Host lists and exports retained trace sessions only through the installed Observer', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-retained-trace-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  const paths = await prepareStatePaths(stateRoot)
  await saveState(paths, {
    schemaVersion: STATE_SCHEMA,
    suiteVersion: '0.1.4',
    channel: 'release',
    profile: 'observability',
    installedAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
    components: {
      'agent-tool-observer': { command: '/private/node', args: ['/private/observer/cli.mjs'], root: '/private/observer' },
    },
    hosts: {},
    runtime: { observationLog: '/private/direct-runtime.jsonl' },
    observability: { enabled: true, observer: { stateDir: '/private/observer-state' } },
  })
  const calls = []
  const runner = async (command, args, options) => {
    calls.push({ command, args, options })
    const source = args.includes('trace-sources')
    return {
      status: 0,
      stdout: JSON.stringify(source
        ? { status: 'ok', schemaVersion: 'openadam.agent-host-trace-source-catalog.v0.1', provider: 'zcode', sources: [] }
        : { status: 'completed', schemaVersion: 'openadam.agent-host-trace-analysis-pack.v0.2', eventsReturned: 3, contentPolicy: 'metadata-only' }),
      stderr: '',
    }
  }
  await observabilityTraceSources({ stateRoot, provider: 'zcode', fromMs: 10, toMs: 20, limit: 25 }, { runner })
  await exportObservabilityTrace({
    stateRoot,
    provider: 'zcode',
    session: 'a'.repeat(64),
    output: '/selected/retained.json',
    fromMs: 10,
    toMs: 20,
  }, { runner })
  assert.deepEqual(calls.map((item) => item.args), [
    ['/private/observer/cli.mjs', 'trace-sources', '--provider', 'zcode', '--limit', '25', '--from-ms', '10', '--to-ms', '20', '--json'],
    ['/private/observer/cli.mjs', 'trace-export', '--provider', 'zcode', '--session', 'a'.repeat(64), '--output', '/selected/retained.json', '--max-events', '500', '--max-output-bytes', '16777216', '--from-ms', '10', '--to-ms', '20', '--json'],
  ])
  assert.equal(calls.every((item) => item.options.cwd === '/private/observer'), true)
  assert.equal(calls.every((item) => item.options.env.ATO_STATE_DIR === '/private/observer-state'), true)
})

test('Agent Host exposes adapter negotiation and non-mutating plans through the installed Observer', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-adapter-plan-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  const paths = await prepareStatePaths(stateRoot)
  await saveState(paths, {
    schemaVersion: STATE_SCHEMA,
    suiteVersion: '0.1.3',
    channel: 'release',
    profile: 'observability',
    installedAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    components: {
      'agent-tool-observer': { command: '/private/node', args: ['/private/observer/cli.mjs'], root: '/private/observer' },
    },
    hosts: {},
    runtime: { observationLog: '/private/direct-runtime.jsonl' },
    observability: { enabled: true, observer: { stateDir: '/private/observer-state' } },
  })
  const calls = []
  const runner = async (command, args) => {
    calls.push({ command, args })
    return { status: 0, stdout: JSON.stringify({ status: 'ok', appliesChanges: false }), stderr: '' }
  }
  assert.equal((await observabilityAdapters({ stateRoot }, { runner })).status, 'ok')
  assert.equal((await observabilityAdapterPlan({ stateRoot, adapter: 'openadam.gemini-cli-otel' }, { runner })).appliesChanges, false)
  assert.deepEqual(calls.map((item) => item.args), [
    ['/private/observer/cli.mjs', 'adapters', '--json'],
    ['/private/observer/cli.mjs', 'adapter-plan', '--adapter', 'openadam.gemini-cli-otel', '--json'],
  ])
})
