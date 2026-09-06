import { AgentHostError } from './errors.mjs'
import { readCurrentObservability } from './observability.mjs'
import { resolveStateRoot } from './paths.mjs'
import { loadState, readStatePaths } from './state.mjs'

export const USAGE_SUMMARY_SCHEMA = 'openadam.agent-host-usage.v0.1'
export const USAGE_SUMMARY_MAX_BYTES = 32_768

const PROVIDER_LIMIT = 8
const TRACE_ADAPTER_LIMIT = 8
const TOOL_LIMIT = 20
const SEMANTIC_EXECUTION_LIMIT = 20
const COLLECTION_SOURCE_LIMIT = 16
const DAILY_ACTIVITY_LIMIT = 120
const TEXT_LIMIT = 180

function boundedText(value, limit = TEXT_LIMIT) {
  if (typeof value !== 'string') return null
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}

function numberOrNull(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? null
    : Number(value)
}

function nonNegativeIntegerOrNull(value) {
  const number = numberOrNull(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : null
}

function compactCollectionSource(item) {
  return {
    source: boundedText(item?.source ?? item?.provider),
    status: boundedText(item?.status),
    errorCode: boundedText(item?.errorCode),
    scannedAtMs: nonNegativeIntegerOrNull(item?.scannedAtMs),
    backlogSources: nonNegativeIntegerOrNull(item?.backlogSources),
    skippedLines: nonNegativeIntegerOrNull(item?.skippedLines),
  }
}

function compactCollection(value) {
  if (value === null || value === undefined) return null
  const sources = value.sources ?? [...(value.providers ?? []), ...(value.semanticSources ?? [])]
  return {
    status: boundedText(value.status),
    startedAtMs: nonNegativeIntegerOrNull(value.startedAtMs),
    completedAtMs: nonNegativeIntegerOrNull(value.completedAtMs),
    providersOk: nonNegativeIntegerOrNull(value.providersOk),
    providersPartial: nonNegativeIntegerOrNull(value.providersPartial),
    providersMissing: nonNegativeIntegerOrNull(value.providersMissing),
    providersError: nonNegativeIntegerOrNull(value.providersError),
    sources: sources.slice(0, COLLECTION_SOURCE_LIMIT).map(compactCollectionSource),
    sourcesReturned: Math.min(sources.length, COLLECTION_SOURCE_LIMIT),
    sourcesAvailable: sources.length,
  }
}

function compactProviderHealth(item) {
  return {
    provider: boundedText(item?.provider),
    status: boundedText(item?.status),
    errorCode: boundedText(item?.errorCode),
    scannedAtMs: nonNegativeIntegerOrNull(item?.scannedAtMs),
  }
}

function compactTraceAdapter(item) {
  return {
    id: boundedText(item?.id),
    provider: boundedText(item?.provider),
    transport: boundedText(item?.transport),
    status: boundedText(item?.runtime?.status) ?? 'unconfigured',
    errorCode: boundedText(item?.runtime?.errorCode),
    scannedAtMs: nonNegativeIntegerOrNull(item?.runtime?.scannedAtMs),
    eventsWritten: nonNegativeIntegerOrNull(item?.runtime?.eventsWritten),
    backlogSources: nonNegativeIntegerOrNull(item?.runtime?.backlogSources),
  }
}

function compactTrace(value) {
  const rawAdapters = Array.isArray(value?.adapters) ? value.adapters : []
  const adapters = rawAdapters.slice(0, TRACE_ADAPTER_LIMIT).map(compactTraceAdapter)
  const providers = Array.isArray(value?.providers) ? value.providers : []
  const total = (key) => providers.reduce((sum, item) => sum + (nonNegativeIntegerOrNull(item?.[key]) ?? 0), 0)
  return {
    adaptersReturned: adapters.length,
    adaptersAvailable: rawAdapters.length,
    adapters,
    providersObserved: new Set(providers.map((item) => item?.provider).filter(Boolean)).size,
    modelSteps: total('modelSteps'),
    toolOffers: total('offeredToolObservations'),
    toolCalls: total('traceToolCalls'),
    toolResults: total('traceToolResults'),
    turnEnds: total('turnEnds'),
    passiveStorage: 'metadata-only',
    interpretationStatus: 'not-performed',
  }
}

function compactFreshness(value) {
  if (value === null || value === undefined) return null
  return {
    status: boundedText(value.status),
    latestCollectionCompletedAtMs: nonNegativeIntegerOrNull(value.latestCollectionCompletedAtMs),
    ageMs: nonNegativeIntegerOrNull(value.ageMs),
    overdueAfterMs: nonNegativeIntegerOrNull(value.overdueAfterMs),
  }
}

function compactUsage(item) {
  return {
    provider: boundedText(item?.provider),
    records: nonNegativeIntegerOrNull(item?.records),
    inputTokens: nonNegativeIntegerOrNull(item?.inputTokens),
    cachedInputTokens: nonNegativeIntegerOrNull(item?.cachedInputTokens),
    outputTokens: nonNegativeIntegerOrNull(item?.outputTokens),
    reasoningTokens: nonNegativeIntegerOrNull(item?.reasoningTokens),
    totalTokens: nonNegativeIntegerOrNull(item?.totalTokens),
    averageDurationMs: numberOrNull(item?.averageDurationMs),
    semantics: boundedText(item?.semantics),
    peakObservedDailyTokens: nonNegativeIntegerOrNull(item?.peakObservedDailyTokens),
    peakObservedDailyDate: boundedText(item?.peakObservedDailyDate),
    dailyTokenSemantics: boundedText(item?.dailyTokenSemantics),
  }
}

function compactActivity(item) {
  return {
    provider: boundedText(item?.provider),
    observedSessions: nonNegativeIntegerOrNull(item?.observedSessions),
    observedTurns: nonNegativeIntegerOrNull(item?.observedTurns),
    observedActiveDays: nonNegativeIntegerOrNull(item?.observedActiveDays),
    firstObservedAtMs: nonNegativeIntegerOrNull(item?.firstObservedAtMs),
    lastObservedAtMs: nonNegativeIntegerOrNull(item?.lastObservedAtMs),
    longestObservedSessionSpanMs: nonNegativeIntegerOrNull(item?.longestObservedSessionSpanMs),
    currentObservedDayStreak: nonNegativeIntegerOrNull(item?.currentObservedDayStreak),
    longestObservedDayStreak: nonNegativeIntegerOrNull(item?.longestObservedDayStreak),
  }
}

function compactDailyActivity(item) {
  return {
    provider: boundedText(item?.provider),
    utcDate: boundedText(item?.utcDate),
    toolCalls: nonNegativeIntegerOrNull(item?.toolCalls),
    usageRecords: nonNegativeIntegerOrNull(item?.usageRecords),
    observedSessions: nonNegativeIntegerOrNull(item?.observedSessions),
    observedTurns: nonNegativeIntegerOrNull(item?.observedTurns),
    inputTokens: nonNegativeIntegerOrNull(item?.inputTokens),
    cachedInputTokens: nonNegativeIntegerOrNull(item?.cachedInputTokens),
    outputTokens: nonNegativeIntegerOrNull(item?.outputTokens),
    reasoningTokens: nonNegativeIntegerOrNull(item?.reasoningTokens),
    totalTokens: nonNegativeIntegerOrNull(item?.totalTokens),
  }
}

function compactTool(item) {
  return {
    provider: boundedText(item?.provider),
    toolName: boundedText(item?.toolName),
    historicalCalls: nonNegativeIntegerOrNull(item?.calls),
    directCalls: item?.derivedCalls == null ? null : Math.max(0, (item.calls ?? 0) - item.derivedCalls),
    referencedCalls: nonNegativeIntegerOrNull(item?.derivedCalls),
    componentId: boundedText(item?.currentComponentBinding?.componentId ?? item?.currentAgentHostDeployment?.componentId),
    componentVersion: boundedText(item?.currentComponentBinding?.componentVersion ?? item?.currentAgentHostDeployment?.componentVersion),
    currentBindingCalls: nonNegativeIntegerOrNull(item?.currentComponentBinding?.calls),
    currentBindingObservedSinceMs: nonNegativeIntegerOrNull(item?.currentComponentBinding?.observedSinceMs),
    currentBindingAttribution: boundedText(item?.currentComponentBinding?.versionAttribution),
    measuredCalls: nonNegativeIntegerOrNull(item?.runtime?.measured),
    completed: nonNegativeIntegerOrNull(item?.runtime?.completed),
    errors: nonNegativeIntegerOrNull(item?.runtime?.errors),
    cancelled: nonNegativeIntegerOrNull(item?.runtime?.cancelled),
    averageDurationMs: numberOrNull(item?.runtime?.averageDurationMs),
    currentReleaseCalls: nonNegativeIntegerOrNull(item?.currentAgentHostDeployment?.callsSinceActivation),
    currentReleaseFreshSessionCalls: nonNegativeIntegerOrNull(item?.currentAgentHostDeployment?.freshSessionCallsSinceActivation),
    currentReleaseStatus: boundedText(item?.currentAgentHostDeployment?.status),
    firstObservedAtMs: nonNegativeIntegerOrNull(item?.firstObservedAtMs),
    lastObservedAtMs: nonNegativeIntegerOrNull(item?.lastObservedAtMs),
  }
}

function compactSemanticTarget(value) {
  if (value?.kind === 'capability') {
    return {
      kind: 'capability',
      id: boundedText(value.capabilityId),
      version: boundedText(value.capabilityVersion),
      operationId: boundedText(value.operationId),
    }
  }
  if (value?.kind === 'procedure') {
    return { kind: 'procedure', id: boundedText(value.procedureId), version: boundedText(value.procedureVersion) }
  }
  return {
    kind: boundedText(value?.kind),
    id: boundedText(value?.toolName),
    operationId: boundedText(value?.operationId),
  }
}

function compactOutcome(value) {
  if (!value) return null
  const keys = ['reported', 'notReported', 'invalid', 'completed', 'partial', 'errors', 'cancelled', 'unknown']
  return { ...Object.fromEntries(keys.map((key) => [key, nonNegativeIntegerOrNull(value[key])])),
    items: Object.fromEntries(['total', 'completed', 'errors', 'cancelled', 'unknown']
      .map((key) => [key, nonNegativeIntegerOrNull(value.items?.[key])])) }
}

function compactErrorCodes(rows = []) {
  const entries = rows.slice(0, 20).map((item) => ({
    providerId: boundedText(item.providerId), providerVersion: boundedText(item.providerVersion),
    purpose: boundedText(item.purpose), source: boundedText(item.source),
    code: boundedText(item.code), count: nonNegativeIntegerOrNull(item.count),
  }))
  return { returned: entries.length, available: rows.length, truncated: rows.length > entries.length, entries }
}

function compactVersionHistory(value) {
  const rows = Array.isArray(value?.versions) ? value.versions : []
  const entries = rows.slice(0, 32).map((item) => ({
    providerId: boundedText(item.providerId), providerVersion: boundedText(item.providerVersion),
    purpose: boundedText(item.purpose),
    ...Object.fromEntries(['executions', 'completed', 'providerErrors', 'hostErrors', 'reportedOutcomes',
      'partialResults', 'resultErrors', 'resultCancellations', 'batchItems', 'itemErrors', 'itemCancellations',
      'firstObservedAtMs', 'lastObservedAtMs'].map((key) => [key, nonNegativeIntegerOrNull(item[key])])),
  }))
  return { basis: boundedText(value?.basis), earlierHistory: boundedText(value?.earlierHistory),
    retention: boundedText(value?.retention), available: rows.length, returned: entries.length,
    limit: 32, truncated: rows.length > entries.length,
    totalExecutions: rows.reduce((sum, row) => sum + (nonNegativeIntegerOrNull(row.executions) ?? 0), 0), entries }
}

function compactSemanticExecution(item) {
  return {
    target: compactSemanticTarget(item?.target),
    providerId: boundedText(item?.providerId),
    providerVersion: boundedText(item?.providerVersion),
    purpose: boundedText(item?.purpose) ?? 'unspecified',
    providerOutcome: compactOutcome(item?.providerOutcome),
    transport: boundedText(item?.transport),
    executions: nonNegativeIntegerOrNull(item?.executions),
    completed: nonNegativeIntegerOrNull(item?.runtime?.completed),
    providerErrors: nonNegativeIntegerOrNull(item?.runtime?.providerErrors),
    hostErrors: nonNegativeIntegerOrNull(item?.runtime?.hostErrors),
    averageDurationMs: numberOrNull(item?.runtime?.averageDurationMs),
    averageQueueMs: numberOrNull(item?.runtime?.averageQueueMs),
    averageProviderRoundTripMs: numberOrNull(item?.runtime?.averageProviderRoundTripMs),
    lastObservedAtMs: nonNegativeIntegerOrNull(item?.lastObservedAtMs),
    correctnessStatus: 'unknown',
  }
}

function compactCoverage(value) {
  const keys = ['toolInvocation', 'runtimeOutcome', 'tokenUsage', 'skillUse', 'semanticEffect', 'resultAdoption', 'nonUseReason']
  return Object.fromEntries(keys.map((key) => [key, {
    status: boundedText(value?.[key]?.status) ?? 'unavailable',
    basis: boundedText(value?.[key]?.basis),
    reason: boundedText(value?.[key]?.reason),
  }]))
}

function reliabilityTotals(tools, semanticExecutions) {
  return {
    measuredToolCalls: tools.reduce((sum, item) => sum + (item.measuredCalls ?? 0), 0),
    completedToolCalls: tools.reduce((sum, item) => sum + (item.completed ?? 0), 0),
    toolErrors: tools.reduce((sum, item) => sum + (item.errors ?? 0), 0),
    toolCancellations: tools.reduce((sum, item) => sum + (item.cancelled ?? 0), 0),
    semanticExecutions: semanticExecutions.reduce((sum, item) => sum + (item.executions ?? 0), 0),
    semanticCompleted: semanticExecutions.reduce((sum, item) => sum + (item.completed ?? 0), 0),
    semanticProviderErrors: semanticExecutions.reduce((sum, item) => sum + (item.providerErrors ?? 0), 0),
    semanticPartialResults: semanticExecutions.reduce((sum, item) => sum + (item.providerOutcome?.partial ?? 0), 0),
    semanticItemErrors: semanticExecutions.reduce((sum, item) => sum + (item.providerOutcome?.items?.errors ?? 0), 0),
    diagnosticExecutions: semanticExecutions.filter((item) => item.purpose === 'diagnostic').reduce((sum, item) => sum + (item.executions ?? 0), 0),
    taskExecutions: semanticExecutions.filter((item) => item.purpose === 'task').reduce((sum, item) => sum + (item.executions ?? 0), 0),
    unspecifiedExecutions: semanticExecutions.filter((item) => item.purpose === 'unspecified').reduce((sum, item) => sum + (item.executions ?? 0), 0),
    semanticHostErrors: semanticExecutions.reduce((sum, item) => sum + (item.hostErrors ?? 0), 0),
  }
}

function enforceBudget(result) {
  // Detail lists share one response budget; their omission must not change the
  // complete observed totals or hide that additional rows exist.
  const details = ['dailyActivity', 'semanticExecutions', 'tools', 'runtimeErrorCodes', 'versionHistory']
  while (Buffer.byteLength(JSON.stringify(result), 'utf8') + 100 > USAGE_SUMMARY_MAX_BYTES) {
    const key = details.find((name) => result[name]?.entries?.length > 0)
    if (key === undefined) break
    const detail = result[key]
    if (key === 'dailyActivity') detail.entries.shift()
    else detail.entries.pop()
    detail.returned = detail.entries.length
    detail.truncated = true
  }
  let serializedBytes = 0
  let output
  for (let attempt = 0; attempt < 4; attempt += 1) {
    output = { ...result, response: { serializedBytes, limitBytes: USAGE_SUMMARY_MAX_BYTES } }
    const measured = Buffer.byteLength(JSON.stringify(output), 'utf8')
    if (measured === serializedBytes) break
    serializedBytes = measured
  }
  output = { ...result, response: { serializedBytes, limitBytes: USAGE_SUMMARY_MAX_BYTES } }
  const finalBytes = Buffer.byteLength(JSON.stringify(output), 'utf8')
  if (finalBytes > USAGE_SUMMARY_MAX_BYTES) {
    throw new AgentHostError('USAGE_SUMMARY_BUDGET_EXCEEDED', 'The compact usage summary exceeded its response budget', {
      serializedBytes: finalBytes,
      limitBytes: USAGE_SUMMARY_MAX_BYTES,
    })
  }
  if (finalBytes !== serializedBytes) output.response.serializedBytes = finalBytes
  return output
}

function emptyResult(configured, enabled) {
  return enforceBudget({
    schemaVersion: USAGE_SUMMARY_SCHEMA,
    status: 'ok',
    generatedAt: new Date().toISOString(),
    configured,
    enabled,
    windowDays: null,
    observationSource: 'none',
    freshness: null,
    collection: null,
    providerHealth: [],
    providerUsage: [],
    providerActivity: [],
    dailyActivity: { returned: 0, available: 0, limit: DAILY_ACTIVITY_LIMIT, truncated: false, entries: [] },
    tools: { returned: 0, available: 0, limit: TOOL_LIMIT, truncated: false, entries: [] },
    semanticExecutions: { returned: 0, available: 0, limit: SEMANTIC_EXECUTION_LIMIT, truncated: false, entries: [] },
    versionHistory: compactVersionHistory(null),
    runtimeErrorCodes: compactErrorCodes(),
    trace: compactTrace(null),
    reliability: reliabilityTotals([], []),
    coverage: compactCoverage(null),
    privacy: {
      rawPromptStored: false,
      rawToolArgumentsStored: false,
      rawToolResultsStored: false,
      sourcePathsReturned: false,
      networkUsedByObserver: false,
      modelCallsByObserver: 0,
    },
    assessmentBoundary: configured
      ? 'Monitoring is off. No tool-use or Agent-activity assessment was performed.'
      : 'No installed Agent Host environment was observed.',
  })
}

export function projectUsageSummary(state, current, currentErrorCode = null) {
  const currentAvailable = current !== null && current?.status !== 'unavailable'
  const cached = state.observability?.latest ?? null
  const source = currentAvailable ? current : cached
  const report = source?.report ?? null
  const rawTools = Array.isArray(report?.suiteTools) ? report.suiteTools : []
  const rawSemanticExecutions = Array.isArray(report?.suiteExecutions) ? report.suiteExecutions : []
  const allTools = rawTools
    .filter((item) => Number.isFinite(item?.calls) && item.calls > 0)
    .sort((left, right) => right.calls - left.calls || String(left.toolName).localeCompare(String(right.toolName)))
    .map(compactTool)
  const tools = allTools.slice(0, TOOL_LIMIT)
  const allSemanticExecutions = rawSemanticExecutions
    .filter((item) => Number.isFinite(item?.executions) && item.executions > 0)
    .sort((left, right) => right.executions - left.executions || String(left.providerId).localeCompare(String(right.providerId)))
    .map(compactSemanticExecution)
  const semanticExecutions = allSemanticExecutions.slice(0, SEMANTIC_EXECUTION_LIMIT)
  const providerHealth = (report?.providers ?? []).slice(0, PROVIDER_LIMIT).map(compactProviderHealth)
  const providerUsage = (report?.usage ?? []).slice(0, PROVIDER_LIMIT).map(compactUsage)
  const providerActivity = (report?.activity?.providers ?? []).slice(0, PROVIDER_LIMIT).map(compactActivity)
  const rawDailyActivity = Array.isArray(report?.activity?.daily) ? report.activity.daily : []
  const dailyActivity = rawDailyActivity.slice(-DAILY_ACTIVITY_LIMIT).map(compactDailyActivity)
  return enforceBudget({
    schemaVersion: USAGE_SUMMARY_SCHEMA,
    status: 'ok',
    generatedAt: new Date().toISOString(),
    configured: true,
    enabled: true,
    windowDays: nonNegativeIntegerOrNull(report?.windowDays),
    versionHistory: compactVersionHistory(report?.versionHistory),
    runtimeErrorCodes: compactErrorCodes(report?.runtimeErrorCodes),
    observationSource: currentAvailable ? 'current-observer-snapshots' : cached === null ? 'none' : 'cached-agent-host-refresh',
    currentReadErrorCode: currentAvailable ? null : boundedText(currentErrorCode),
    freshness: currentAvailable ? compactFreshness(current.freshness) : null,
    collection: compactCollection(currentAvailable ? current.collection : cached?.collection),
    providerHealth,
    providerUsage,
    providerActivity,
    activitySemantics: {
      sessions: boundedText(report?.activity?.sessionSemantics),
      turns: boundedText(report?.activity?.turnSemantics),
      activeDays: boundedText(report?.activity?.activeDaySemantics),
      dayStreaks: boundedText(report?.activity?.dayStreakSemantics),
    },
    dailyActivity: {
      returned: dailyActivity.length,
      available: nonNegativeIntegerOrNull(report?.activity?.dailyRowsAvailable) ?? rawDailyActivity.length,
      limit: DAILY_ACTIVITY_LIMIT,
      truncated: report?.activity?.dailyRowsTruncated === true || rawDailyActivity.length > DAILY_ACTIVITY_LIMIT,
      entries: dailyActivity,
    },
    tools: { returned: tools.length, available: allTools.length, limit: TOOL_LIMIT, truncated: tools.length < allTools.length, entries: tools },
    semanticExecutions: {
      returned: semanticExecutions.length,
      available: allSemanticExecutions.length,
      limit: SEMANTIC_EXECUTION_LIMIT,
      truncated: semanticExecutions.length < allSemanticExecutions.length,
      entries: semanticExecutions,
    },
    trace: compactTrace(report?.tracePlane),
    reliability: reliabilityTotals(allTools, allSemanticExecutions),
    coverage: compactCoverage(report?.observationCoverage),
    privacy: {
      rawPromptStored: false,
      rawToolArgumentsStored: false,
      rawToolResultsStored: false,
      sourcePathsReturned: false,
      networkUsedByObserver: false,
      modelCallsByObserver: 0,
    },
    assessmentBoundary: 'Counts describe bounded local metadata observations. They do not establish Skill activation, why a tool was not used, result adoption, semantic effect, correctness, task quality, opportunity, or user value.',
  })
}

export async function usageSummary(options = {}, dependencies = {}) {
  const paths = await readStatePaths(resolveStateRoot(options.stateRoot))
  const state = await loadState(paths)
  if (state === null) return emptyResult(false, false)
  if (state.observability?.enabled !== true) return emptyResult(true, false)
  try {
    const current = Object.prototype.hasOwnProperty.call(dependencies, 'currentObservability')
      ? await dependencies.currentObservability
      : await (dependencies.readCurrentObservability ?? readCurrentObservability)(state, dependencies.runner)
    return projectUsageSummary(state, current)
  } catch (error) {
    const errorCode = error instanceof AgentHostError ? error.code : 'OBSERVABILITY_CURRENT_READ_FAILED'
    return projectUsageSummary(state, null, errorCode)
  }
}
