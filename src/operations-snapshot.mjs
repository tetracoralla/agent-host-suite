import { listActivity } from './activity.mjs'
import { AgentHostError } from './errors.mjs'
import { readJson } from './json.mjs'
import { resolveStateRoot } from './paths.mjs'
import { loadState, readStatePaths } from './state.mjs'
import { storageStatus } from './storage.mjs'
import { runFile } from './process.mjs'
import { join } from 'node:path'
import { readCurrentObservability } from './observability.mjs'
import { readProcessInventory } from './process-inventory.mjs'

export const OPERATIONS_SNAPSHOT_SCHEMA = 'openadam.agent-host-operations-snapshot.v0.1'
export const OPERATIONS_SNAPSHOT_MAX_BYTES = 16_384
const RECENT_ACTIVITY_LIMIT = 12
const ACTIVITY_TYPE_MAX_CHARS = 120
const ACTIVITY_SUMMARY_MAX_CHARS = 320
const TOP_TOOL_USAGE_LIMIT = 8
const PROVIDER_ACTIVITY_LIMIT = 8

function boundedText(value, limit) {
  if (typeof value !== 'string') return null
  if (value.length <= limit) return value
  return `${value.slice(0, limit - 1)}…`
}

function collectionSource(item) {
  return {
    source: item.provider ?? item.source,
    status: item.status,
    errorCode: item.errorCode ?? null,
    scannedAtMs: item.scannedAtMs ?? null,
    backlogSources: item.backlogSources ?? null,
    skippedLines: item.skippedLines ?? null,
  }
}

function compactToolUsage(report) {
  const tools = Array.isArray(report?.suiteTools) ? report.suiteTools : []
  const ranked = tools
    .filter((item) => Number.isFinite(item.calls) && item.calls > 0)
    .sort((left, right) => right.calls - left.calls || String(left.toolName).localeCompare(String(right.toolName)))
    .slice(0, TOP_TOOL_USAGE_LIMIT)
    .map((item) => ({
      provider: item.provider ?? null,
      toolName: boundedText(item.toolName, 160),
      historicalCalls: item.calls,
      measuredCalls: item.runtime?.measured ?? null,
      completed: item.runtime?.completed ?? null,
      errors: item.runtime?.errors ?? null,
      cancelled: item.runtime?.cancelled ?? null,
      currentReleaseCalls: item.currentAgentHostDeployment?.callsSinceActivation ?? null,
      currentReleaseFreshSessionCalls: item.currentAgentHostDeployment?.freshSessionCallsSinceActivation ?? null,
      currentReleaseStatus: item.currentAgentHostDeployment?.status ?? null,
    }))
  return {
    mappedBindings: tools.length,
    returned: ranked.length,
    limit: TOP_TOOL_USAGE_LIMIT,
    ordering: 'historical-observed-calls-descending',
    tools: ranked,
    assessmentBoundary: 'Historical calls are not current-release adoption, opportunity, correctness, task quality, or user value.',
  }
}

function compactObservedActivity(report) {
  const activity = report?.activity
  if (activity === null || activity === undefined) return null
  const providers = Array.isArray(activity.providers) ? activity.providers : []
  return {
    providers: providers.slice(0, PROVIDER_ACTIVITY_LIMIT).map((item) => ({
      provider: boundedText(item?.provider, 80),
      observedSessions: item?.observedSessions ?? null,
      observedTurns: item?.observedTurns ?? null,
      observedActiveDays: item?.observedActiveDays ?? item?.activeUtcDays ?? null,
      firstObservedAtMs: item?.firstObservedAtMs ?? null,
      lastObservedAtMs: item?.lastObservedAtMs ?? null,
      longestObservedSessionSpanMs: item?.longestObservedSessionSpanMs ?? null,
      sessionDurationSemantics: boundedText(item?.sessionDurationSemantics, 180),
      currentObservedDayStreak: item?.currentObservedDayStreak ?? null,
      longestObservedDayStreak: item?.longestObservedDayStreak ?? null,
    })),
    providersReturned: Math.min(providers.length, PROVIDER_ACTIVITY_LIMIT),
    providersAvailable: providers.length,
    dailyRowsAvailable: activity.dailyRowsAvailable ?? (Array.isArray(activity.daily) ? activity.daily.length : null),
    dailyRowsOmitted: true,
    dailyRowsRoute: 'agent-host usage --json',
    sessionSemantics: boundedText(activity.sessionSemantics, 180),
    turnSemantics: boundedText(activity.turnSemantics, 180),
    activeDaySemantics: boundedText(activity.activeDaySemantics, 180),
    dayStreakSemantics: boundedText(activity.dayStreakSemantics, 180),
  }
}

function compactObservability(state, analysis, current) {
  const value = state.observability
  if (value?.enabled !== true) {
    return {
      enabled: false,
      refreshedAt: null,
      privacy: {
        rawPromptStored: false,
        rawToolArgumentsStored: false,
        rawToolResultsStored: false,
        networkUsedByObserver: false,
        modelCallsByObserver: 0,
      },
    }
  }
  const currentAvailable = current?.status !== 'unavailable' && current !== null
  const latest = currentAvailable ? {
    ...value.latest,
    refreshedAt: current.observedAt,
    collection: current.collection,
    report: current.report,
  } : value.latest ?? null
  const collection = latest?.collection ?? null
  const report = latest?.report ?? null
  return {
    enabled: true,
    consentedAt: value.consentedAt ?? null,
    refreshedAt: latest?.refreshedAt ?? null,
    observationSource: currentAvailable ? 'current-observer-snapshots' : 'cached-agent-host-refresh',
    currentReadErrorCode: current?.status === 'unavailable' ? current.errorCode : null,
    collector: currentAvailable ? current.collector : null,
    freshness: currentAvailable ? current.freshness : null,
    collection: collection === null ? null : {
      startedAtMs: collection.startedAtMs ?? null,
      completedAtMs: collection.completedAtMs ?? null,
      status: collection.status ?? null,
      providersOk: collection.providersOk ?? null,
      providersPartial: collection.providersPartial ?? null,
      providersMissing: collection.providersMissing ?? null,
      providersError: collection.providersError ?? null,
      sources: (collection.sources ?? [...(collection.providers ?? []), ...(collection.semanticSources ?? [])]).map(collectionSource),
    },
    catalog: latest?.context === undefined ? null : {
      canonicalUtf8Bytes: latest.context.catalog?.canonicalUtf8Bytes ?? null,
      largestToolUtf8Bytes: latest.context.catalog?.largestToolUtf8Bytes ?? null,
      tools: latest.context.counts?.tools ?? null,
      schemas: latest.context.counts?.schemas ?? null,
      hardNameCollisions: latest.context.hardNameCollisions ?? null,
      budgetChecks: (analysis?.budgetChecks ?? []).map((item) => ({
        metric: item.metric,
        actual: item.actual,
        limit: item.limit,
        remaining: Number.isFinite(item.actual) && Number.isFinite(item.limit) ? item.limit - item.actual : null,
        status: item.status,
      })),
    },
    directRuntime: report?.directRuntime ?? null,
    freshSessionCorrelation: report?.freshSessionCorrelation ?? null,
    activity: compactObservedActivity(report),
    observationCoverage: report?.observationCoverage ?? null,
    toolUsage: compactToolUsage(report),
    totals: report?.totals ?? null,
    privacy: {
      rawPromptStored: false,
      rawToolArgumentsStored: false,
      rawToolResultsStored: false,
      networkUsedByObserver: false,
      modelCallsByObserver: 0,
    },
  }
}

function compactStorage(value) {
  return {
    current: value.current,
    rollback: value.rollback,
    allocatedBytes: value.sections.total.allocatedBytes,
    apparentBytes: value.sections.total.apparentBytes,
    installation: value.installation === undefined ? null : {
      managerAppAllocatedBytes: value.installation.managerApp?.allocatedBytes ?? null,
      privateStateAllocatedBytes: value.installation.privateState.allocatedBytes,
      combinedAllocatedBytes: value.installation.allocatedBytes,
    },
    sections: Object.fromEntries(Object.entries(value.sections)
      .filter(([name]) => name !== 'total')
      .map(([name, item]) => [name, { allocatedBytes: item.allocatedBytes, apparentBytes: item.apparentBytes }])),
    cleanup: value.cleanup,
  }
}

function enforceBudget(result) {
  let serializedBytes = 0
  let output
  for (let attempt = 0; attempt < 4; attempt += 1) {
    output = { ...result, response: { serializedBytes, limitBytes: OPERATIONS_SNAPSHOT_MAX_BYTES } }
    const measured = Buffer.byteLength(JSON.stringify(output), 'utf8')
    if (measured === serializedBytes) break
    serializedBytes = measured
  }
  output = { ...result, response: { serializedBytes, limitBytes: OPERATIONS_SNAPSHOT_MAX_BYTES } }
  const finalBytes = Buffer.byteLength(JSON.stringify(output), 'utf8')
  if (finalBytes > OPERATIONS_SNAPSHOT_MAX_BYTES) {
    throw new AgentHostError('OPERATIONS_SNAPSHOT_BUDGET_EXCEEDED', 'The compact Agent Host snapshot exceeded its response budget', {
      serializedBytes: finalBytes,
      limitBytes: OPERATIONS_SNAPSHOT_MAX_BYTES,
    })
  }
  if (finalBytes !== serializedBytes) output.response.serializedBytes = finalBytes
  return output
}

// Aggregate live process baseline: suite-owned processes are the ones whose
// command line references the private state root (provider children, the
// direct runtime service, and the CLI itself). Counts and resident bytes only.
async function processBaseline(root, runner) {
  const processes = await readProcessInventory(runner)
  if (processes === null) return null
  let processCount = 0
  let totalRssBytes = 0
  for (const process of processes) {
    if (!process.command.includes(root)) continue
    processCount += 1
    totalRssBytes += process.rssBytes ?? 0
  }
  return {
    sampledAt: new Date().toISOString(),
    processCount,
    totalRssBytes,
    basis: 'processes whose command line references the Agent Host state root',
  }
}

export async function operationsSnapshot(options = {}, dependencies = {}) {
  const runner = dependencies.runner ?? runFile
  const hasProvidedObservability = Object.prototype.hasOwnProperty.call(dependencies, 'currentObservability')
  const paths = await readStatePaths(resolveStateRoot(options.stateRoot))
  const state = await loadState(paths)
  if (state === null) {
    return enforceBudget({
      schemaVersion: OPERATIONS_SNAPSHOT_SCHEMA,
      status: 'ok',
      generatedAt: new Date().toISOString(),
      configured: false,
      assessmentBoundary: 'No installed Agent Host environment was observed.',
    })
  }
  const [storage, activity, analysis, processes, currentObservability] = await Promise.all([
    storageStatus({ stateRoot: paths.root }),
    listActivity(paths, { limit: RECENT_ACTIVITY_LIMIT }),
    readJson(join(paths.context, 'managed-catalog.analysis.json')).catch(() => null),
    processBaseline(paths.root, runner),
    state.observability?.enabled === true
      ? (hasProvidedObservability
        ? Promise.resolve(dependencies.currentObservability)
        : readCurrentObservability(state, runner)).catch((error) => ({
        status: 'unavailable',
        errorCode: error instanceof AgentHostError ? error.code : 'OBSERVABILITY_CURRENT_READ_FAILED',
      }))
      : null,
  ])
  return enforceBudget({
    schemaVersion: OPERATIONS_SNAPSHOT_SCHEMA,
    status: 'ok',
    generatedAt: new Date().toISOString(),
    configured: true,
    environment: {
      suiteVersion: state.suiteVersion,
      releaseId: state.releaseId ?? null,
      sourceProvenance: state.releaseSourceProvenance ?? null,
      channel: state.channel,
      profile: state.profile,
      installedAt: state.installedAt,
      updatedAt: state.updatedAt,
      releaseActivatedAt: state.releaseActivatedAt ?? null,
      bindingsActivatedAt: state.bindingsActivatedAt ?? state.releaseActivatedAt ?? null,
      workspaceGranted: state.workspaceRoot !== null && state.workspaceRoot !== undefined,
      components: Object.fromEntries(Object.entries(state.components).map(([id, component]) => [id, component.version])),
      availableAgentComponents: state.availableAgentComponents ?? state.agentComponents ?? Object.keys(state.components),
      agentComponents: state.agentComponents ?? Object.keys(state.components),
      hosts: Object.fromEntries(Object.entries(state.hosts).map(([id, host]) => [id, {
        version: host.version,
        bindings: host.entries.length,
        operationsSkill: host.operationsSkill === undefined ? 'not-managed' : 'managed',
        freshSession: {
          requiredAfterBindingChange: host.restartRequired === true,
          currentSessionUptake: 'not-observed',
        },
      }])),
      service: state.runtime.service === null ? null : {
        kind: state.runtime.service.kind,
        created: state.runtime.service.created === true,
      },
    },
    observability: compactObservability(state, analysis, currentObservability),
    storage: compactStorage(storage),
    processes,
    recentActivity: activity.map((item) => ({
      occurredAt: item.occurredAt,
      type: boundedText(item.type, ACTIVITY_TYPE_MAX_CHARS),
      summary: boundedText(item.summary, ACTIVITY_SUMMARY_MAX_CHARS),
    })),
    assessmentBoundary: 'This snapshot contains bounded observations and measurements. It does not establish current executable health, whether an open Agent session loaded current bindings, causation, opportunity, adoption quality, task correctness, user value, or a cleanup/update decision.',
  })
}
