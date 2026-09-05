import { chmod, copyFile, lstat, rename, rm } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { buildDevelopmentObservabilityManifest } from './development-manifest.mjs'
import { AgentHostError } from './errors.mjs'
import { exportManagedCatalogInventory } from './context-exporter.mjs'
import { readJson, writePrivateJson } from './json.mjs'
import { resolveStateRoot } from './paths.mjs'
import { runFile } from './process.mjs'
import { installMaintenance, uninstallMaintenance } from './maintenance-service.mjs'
import { loadState, prepareStatePaths, readStatePaths, saveState, statePaths } from './state.mjs'
import { recordActivity } from './activity.mjs'
import { cleanupStorage } from './storage.mjs'
import { withLifecycleMutation } from './lifecycle-lock.mjs'

const OBSERVER_LABEL = 'com.openadam.agent-tool-observer'
const WINDOWS_OBSERVER_TASK = '\\openAdam\\AgentToolObserver'
const SUPPORTED_OBSERVER_REPORTS = new Set([
  'openadam.agent-tool-observer.report.v0.4',
  'openadam.agent-tool-observer.report.v0.5',
  'openadam.agent-tool-observer.report.v0.6',
  'openadam.agent-tool-observer.report.v0.7',
  'openadam.agent-tool-observer.report.v0.8',
])
const SEMANTIC_TARGET_KINDS = new Set(['procedure', 'capability', 'mcp-tool', 'mcp-operation'])
const TRACE_ADAPTER_LIMIT = 32
const TRACE_PROVIDER_LIMIT = 32
const ACTIVITY_LOG_WARNING = Object.freeze({
  code: 'ACTIVITY_LOG_WRITE_FAILED',
  message: 'The monitoring change succeeded, but its activity entry could not be recorded.',
})

async function recordCommittedActivity(dependencies, paths, type, summary, detail) {
  try {
    await (dependencies.recordActivity ?? recordActivity)(paths, type, summary, detail)
    return []
  } catch {
    return [ACTIVITY_LOG_WARNING]
  }
}

function observerStateDir() {
  if (platform() === 'win32') {
    const base = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    return join(base, 'openAdam', 'Agent Tool Observer')
  }
  return join(homedir(), 'Library', 'Application Support', 'OpenAdam', 'Agent Tool Observer')
}

function observerPlistPath() {
  return join(homedir(), 'Library', 'LaunchAgents', `${OBSERVER_LABEL}.plist`)
}

async function regularFile(path) {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new AgentHostError('OBSERVABILITY_FILE_UNSAFE', `Expected a regular non-symlinked file: ${path}`)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function runJson(component, args, runner, options = {}) {
  const result = await runner(component.command, [...component.args, ...args], {
    cwd: component.root,
    env: options.env,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 120_000,
    maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
  })
  let value
  try {
    value = JSON.parse(result.stdout)
  } catch {
    throw new AgentHostError('OBSERVABILITY_OUTPUT_INVALID', `${args[0]} did not return one JSON value`)
  }
  if (value?.status === 'error') {
    throw new AgentHostError(value.error?.code ?? 'OBSERVABILITY_OPERATION_FAILED', value.error?.message ?? `${args[0]} failed`)
  }
  return value
}

async function launchAgentLoaded(runner) {
  if (platform() === 'win32') {
    const result = await runner('schtasks.exe', ['/Query', '/TN', WINDOWS_OBSERVER_TASK], { allowFailure: true, timeoutMs: 5_000 })
    return result.status === 0
  }
  const result = await runner('/bin/launchctl', ['print', `gui/${process.getuid()}/${OBSERVER_LABEL}`], { allowFailure: true, timeoutMs: 5_000 })
  return result.status === 0
}

async function backupPriorLaunchAgent(paths, runner) {
  if (platform() === 'win32') {
    if (await launchAgentLoaded(runner)) {
      throw new AgentHostError('OBSERVABILITY_SERVICE_CONFLICT', 'Another Windows Observer collector task is already configured')
    }
    return { existed: false, taskName: WINDOWS_OBSERVER_TASK, wasLoaded: false }
  }
  const path = observerPlistPath()
  if (!await regularFile(path)) return { existed: false, plistPath: path, wasLoaded: false }
  const backupPath = join(paths.backups, `${OBSERVER_LABEL}.before-suite.plist`)
  if (await regularFile(backupPath)) throw new AgentHostError('OBSERVABILITY_BACKUP_EXISTS', `Refusing to overwrite an existing backup: ${backupPath}`)
  await copyFile(path, backupPath, 0)
  await chmod(backupPath, 0o600)
  return { existed: true, plistPath: path, backupPath, wasLoaded: await launchAgentLoaded(runner) }
}

async function restorePriorLaunchAgent(prior, runner) {
  if (prior?.existed !== true) return { restored: false }
  if (platform() === 'win32') return { restored: false }
  if (!await regularFile(prior.backupPath)) throw new AgentHostError('OBSERVABILITY_BACKUP_MISSING', 'The previous Observer LaunchAgent backup is unavailable')
  const temporary = `${prior.plistPath}.restore-${process.pid}`
  await copyFile(prior.backupPath, temporary, 0)
  await chmod(temporary, 0o600)
  await rename(temporary, prior.plistPath)
  if (prior.wasLoaded) {
    const domain = `gui/${process.getuid()}`
    await runner('/bin/launchctl', ['bootstrap', domain, prior.plistPath])
    await runner('/bin/launchctl', ['enable', `${domain}/${OBSERVER_LABEL}`])
  }
  await rm(prior.backupPath, { force: true })
  return { restored: true, loaded: prior.wasLoaded }
}

function observerEnvironment(state) {
  return {
    ...process.env,
    ATO_STATE_DIR: state.observability.observer.stateDir,
    ATO_DIRECT_RUNTIME_LOGS: state.runtime.observationLog,
    ATO_NODE_EXECUTABLE: state.components['node-runtime']?.command ?? state.components['agent-tool-observer'].command,
  }
}

export function observabilitySummary(value) {
  return {
    enabled: value.enabled === true,
    consentedAt: value.consentedAt ?? null,
    observer: value.observer === undefined ? null : {
      stateDir: value.observer.stateDir,
      intervalSeconds: value.observer.installation?.intervalSeconds ?? null,
    },
    maintenance: value.maintenance === null || value.maintenance === undefined ? null : {
      intervalSeconds: value.maintenance.intervalSeconds,
    },
    latest: value.latest === null || value.latest === undefined ? null : {
      refreshedAt: value.latest.refreshedAt,
      deployment: value.latest.deployment ?? null,
      context: {
        catalog: value.latest.context.catalog,
        counts: value.latest.context.counts,
        hardNameCollisions: value.latest.context.hardNameCollisions,
      },
      freshSessionCorrelation: value.latest.report.freshSessionCorrelation ?? null,
      totals: value.latest.report.totals,
    },
  }
}

export function semanticExecutionTotals(executions) {
  const values = Array.isArray(executions) ? executions : []
  const totals = { procedureEvents: 0, capabilityEvents: 0 }
  for (const item of values) {
    const kind = item?.target?.kind
    if (!SEMANTIC_TARGET_KINDS.has(kind)
      || !Number.isSafeInteger(item.executions)
      || item.executions < 0) {
      throw new AgentHostError('OBSERVABILITY_REPORT_UNSUPPORTED', 'Observer returned an invalid semantic execution summary')
    }
    if (kind === 'procedure') totals.procedureEvents += item.executions
    if (kind === 'capability') totals.capabilityEvents += item.executions
  }
  return totals
}

export function configuredSemanticProviderIds(state) {
  const active = new Set(state.agentComponents ?? Object.keys(state.components ?? {}))
  const ids = new Set()
  if (active.has('math-anchor')) ids.add('io.github.tetracoralla.math-anchor')
  if (active.has('migratory-time')) ids.add('io.github.tetracoralla.migratory-time')
  for (const [id, component] of Object.entries(state.components ?? {})) {
    if (!active.has(id)) continue
    const providerId = component.capabilityProvider?.providerId
    if (typeof providerId === 'string' && providerId.length > 0) ids.add(providerId)
  }
  return ids
}

function tracePlaneSummary(value) {
  if (value === null || value === undefined) return null
  if (!Array.isArray(value.adapters)
    || !Array.isArray(value.providers)
    || value.passiveStorage !== 'metadata-only'
    || value.interpretationStatus !== 'not-performed') {
    throw new AgentHostError('OBSERVABILITY_REPORT_UNSUPPORTED', 'Observer returned an invalid Trace Plane summary')
  }
  return {
    adapters: value.adapters.slice(0, TRACE_ADAPTER_LIMIT).map((item) => ({
      id: item.id,
      provider: item.provider,
      transport: item.transport,
      runtime: {
        status: item.runtime?.status ?? 'unconfigured',
        errorCode: item.runtime?.errorCode ?? null,
        providerVersion: item.runtime?.providerVersion ?? null,
        scannedAtMs: item.runtime?.scannedAtMs ?? null,
        eventsWritten: item.runtime?.eventsWritten ?? 0,
        backlogSources: item.runtime?.backlogSources ?? 0,
      },
    })),
    adaptersAvailable: value.adapters.length,
    adaptersTruncated: value.adapters.length > TRACE_ADAPTER_LIMIT,
    providers: value.providers.slice(0, TRACE_PROVIDER_LIMIT).map((item) => ({
      provider: item.provider,
      modelSteps: item.modelSteps,
      offeredToolObservations: item.offeredToolObservations,
      traceToolCalls: item.traceToolCalls,
      traceToolResults: item.traceToolResults,
      turnEnds: item.turnEnds,
    })),
    providersAvailable: value.providers.length,
    providersTruncated: value.providers.length > TRACE_PROVIDER_LIMIT,
    passiveStorage: 'metadata-only',
    explicitAnalysisPack: value.explicitAnalysisPack ?? null,
    interpretationStatus: 'not-performed',
  }
}

function hostReport(report, providerIds) {
  if (!SUPPORTED_OBSERVER_REPORTS.has(report.schemaVersion) || !Array.isArray(report.semanticExecutions)) {
    throw new AgentHostError('OBSERVABILITY_REPORT_UNSUPPORTED', 'Observer returned an unsupported report contract')
  }
  const semanticTotals = semanticExecutionTotals(report.semanticExecutions)
  const suiteExecutions = report.semanticExecutions.filter((item) => providerIds.has(item.providerId))
  const suiteTools = report.tools
    .filter((item) => item.currentAgentHostDeployment?.componentId !== undefined)
    .sort((left, right) => right.calls - left.calls || left.toolName.localeCompare(right.toolName))
    .slice(0, 25)
    .map((item) => ({
      provider: item.provider,
      toolName: item.toolName,
      calls: item.calls,
      runtime: item.runtime,
      payload: item.payload,
      turnAssociatedUsage: item.turnAssociatedUsage,
      firstObservedAtMs: item.firstObservedAtMs,
      lastObservedAtMs: item.lastObservedAtMs,
      currentAgentHostDeployment: item.currentAgentHostDeployment,
    }))
  const routingObservations = report.routingObservations ?? []
  return {
    schemaVersion: report.schemaVersion,
    generatedAtMs: report.generatedAtMs,
    windowDays: report.windowDays,
    providers: report.providers,
    usage: report.usage,
    activity: report.activity ?? null,
    tracePlane: tracePlaneSummary(report.tracePlane),
    observationCoverage: report.observationCoverage ?? null,
    cost: report.cost,
    directRuntime: report.directRuntime,
    freshSessionCorrelation: report.freshSessionCorrelation ?? null,
    suiteExecutions,
    suiteTools,
    routingObservations,
    totals: {
      observedTools: report.tools.length,
      observedCalls: report.tools.reduce((total, item) => total + item.calls, 0),
      suiteToolCalls: suiteTools.reduce((total, item) => total + item.calls, 0),
      freshSessionSuiteToolCalls: suiteTools.reduce((total, item) => total + (item.currentAgentHostDeployment.freshSessionCallsSinceActivation ?? 0), 0),
      freshSessionRoutingObservationsReturned: routingObservations.length,
      freshSessionRoutingObservationsTruncated: report.freshSessionCorrelation?.routing?.observationRecordsTruncated ?? null,
      ...semanticTotals,
    },
    assessmentBoundary: 'Fresh-session counts are provider-scoped observations with explicit coverage and truncation; they are not adoption, opportunity, correctness, task-quality, or retirement decisions.',
  }
}

function collectionFromStatus(status) {
  const latest = status.latestCollection
  if (latest === null || latest === undefined) return null
  const numberOrNull = (value) => value === null || value === undefined || !Number.isFinite(Number(value))
    ? null
    : Number(value)
  return {
    startedAtMs: numberOrNull(latest.started_at_ms),
    completedAtMs: numberOrNull(latest.completed_at_ms),
    status: latest.status,
    providersOk: numberOrNull(latest.providers_ok),
    providersPartial: numberOrNull(latest.providers_partial),
    providersMissing: numberOrNull(latest.providers_missing),
    providersError: numberOrNull(latest.providers_error),
    sources: [...(status.providers ?? []), ...(status.semanticSources ?? [])],
  }
}

export async function readCurrentObservability(state, runner = runFile, nowMs = Date.now()) {
  if (state.observability?.enabled !== true) return null
  const observer = state.components['agent-tool-observer']
  const [status, report, collectorLoaded] = await Promise.all([
    runJson(observer, ['status', '--json'], runner, { env: observerEnvironment(state) }),
    runJson(observer, ['report', '--days', '30', '--json'], runner, { env: observerEnvironment(state) }),
    launchAgentLoaded(runner),
  ])
  const projectedReport = hostReport(report, configuredSemanticProviderIds(state))
  const collection = collectionFromStatus(status)
  const intervalSeconds = state.observability.observer.installation?.intervalSeconds ?? null
  const completedAtMs = collection?.completedAtMs ?? null
  const ageMs = completedAtMs === null ? null : Math.max(0, nowMs - completedAtMs)
  const overdueAfterMs = Number.isFinite(intervalSeconds)
    ? Math.max(intervalSeconds * 3_000, 15 * 60_000)
    : null
  return {
    observedAt: new Date(nowMs).toISOString(),
    collector: {
      label: platform() === 'win32' ? WINDOWS_OBSERVER_TASK : OBSERVER_LABEL,
      loaded: collectorLoaded,
      intervalSeconds,
    },
    freshness: {
      latestCollectionCompletedAtMs: completedAtMs,
      ageMs,
      overdueAfterMs,
      status: ageMs === null || overdueAfterMs === null
        ? 'unknown'
        : ageMs > overdueAfterMs ? 'overdue' : 'current',
    },
    collection,
    status: {
      state: status.state,
      providers: status.providers,
      semanticSources: status.semanticSources,
    },
    report: projectedReport,
  }
}

async function writeAnalysis(paths, state, runner) {
  const active = new Set(state.agentComponents ?? Object.keys(state.components))
  const activeComponents = Object.fromEntries(Object.entries(state.components).filter(([id]) => active.has(id)))
  const { snapshot, bindings } = await exportManagedCatalogInventory(activeComponents)
  const snapshotPath = join(paths.context, 'managed-catalog.snapshot.json')
  const analysisPath = join(paths.context, 'managed-catalog.analysis.json')
  await writePrivateJson(snapshotPath, snapshot)
  const analyzer = state.components['context-surface-analyzer']
  const invocation = contextAnalyzerInvocation(analyzer)
  const outcome = await runner(invocation.command, [...invocation.args, 'analyze', snapshotPath], {
    cwd: analyzer.root,
    timeoutMs: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  })
  let analysis
  try {
    analysis = JSON.parse(outcome.stdout)
  } catch {
    throw new AgentHostError('CONTEXT_ANALYSIS_INVALID', 'Context Surface Analyzer did not return one JSON value')
  }
  if (analysis?.status !== 'ok' || analysis?.format !== 'context-surface.analysis.v0.1') {
    throw new AgentHostError(analysis?.error?.code ?? 'CONTEXT_ANALYSIS_FAILED', analysis?.error?.message ?? 'Context Surface analysis failed')
  }
  await writePrivateJson(analysisPath, analysis)
  return { snapshot, bindings, snapshotPath, analysis, analysisPath }
}

function activationTime(state) {
  const value = Date.parse(state.bindingsActivatedAt ?? state.releaseActivatedAt ?? state.updatedAt ?? state.installedAt ?? '')
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : Date.now()
}

async function writeDeploymentObservation(paths, state, context) {
  const deploymentPath = join(paths.context, 'active-deployment.observation.json')
  const deployment = {
    schemaVersion: 'openadam.agent-host-deployment-observation.v0.1',
    observedAtMs: Date.now(),
    activatedAtMs: activationTime(state),
    channel: state.channel,
    releaseId: state.releaseId ?? null,
    suiteVersion: state.suiteVersion,
    profile: state.profile,
    components: Object.entries(state.components).map(([id, component]) => {
      const binding = context.bindings.find((item) => item.id === id)
      return {
        id,
        version: component.version,
        artifactSha256: component.releaseArtifact?.artifact?.sha256 ?? null,
        toolNames: binding?.toolNames ?? [],
      }
    }),
    context: {
      sourceId: context.analysis.source.id,
      sourceRevision: context.analysis.source.revision,
      catalogSha256: context.analysis.catalog.sha256,
      catalogBytes: context.analysis.catalog.canonicalUtf8Bytes,
      toolCount: context.analysis.counts.tools,
    },
  }
  await writePrivateJson(deploymentPath, deployment)
  return { deployment, deploymentPath }
}

export function contextAnalyzerInvocation(component) {
  return {
    command: component.cliCommand ?? component.command,
    args: component.cliArgs ?? component.args,
  }
}

async function refreshState(state, paths, runner) {
  const observer = state.components['agent-tool-observer']
  const collected = await runJson(observer, ['collect', '--json'], runner, { env: observerEnvironment(state) })
  const context = await writeAnalysis(paths, state, runner)
  const imported = await runJson(observer, ['ingest-context-surface', '--file', context.analysisPath, '--json'], runner, {
    env: observerEnvironment(state),
  })
  const deployment = await writeDeploymentObservation(paths, state, context)
  const deploymentImported = await runJson(observer, ['ingest-agent-host-deployment', '--file', deployment.deploymentPath, '--json'], runner, {
    env: observerEnvironment(state),
  })
  const status = await runJson(observer, ['status', '--json'], runner, { env: observerEnvironment(state) })
  const report = await runJson(observer, ['report', '--days', '30', '--json'], runner, { env: observerEnvironment(state) })
  const projectedReport = hostReport(report, configuredSemanticProviderIds(state))
  return {
    refreshedAt: new Date().toISOString(),
    deployment: {
      channel: state.channel,
      suiteVersion: state.suiteVersion,
      releaseId: state.releaseId ?? null,
      components: Object.fromEntries(Object.entries(state.components).map(([id, component]) => [id, component.version])),
      observerIngestion: deploymentImported,
    },
    collection: collected,
    context: {
      source: context.analysis.source,
      snapshot: context.analysis.snapshot,
      catalog: context.analysis.catalog,
      counts: context.analysis.counts,
      hardNameCollisions: context.analysis.hardNameCollisions.length,
      exactDuplicateSchemas: context.analysis.exactDuplicateSchemas.length,
      snapshotPath: context.snapshotPath,
      analysisPath: context.analysisPath,
      imported,
    },
    status,
    report: projectedReport,
  }
}

export async function rebindObservabilityState(state, paths, runner = runFile) {
  if (state.observability?.enabled !== true) return state
  const observer = state.components['agent-tool-observer']
  state.observability.observer.installation = await runJson(observer, ['install', '--json'], runner, { env: observerEnvironment(state) })
  state.observability.maintenance = await installMaintenance(paths.root, runner)
  state.observability.latest = await refreshState(state, paths, runner)
  return state
}

export async function activateObservabilityState(state, paths, runner = runFile, dependencies = {}) {
  const observer = state.components['agent-tool-observer']
  const analyzer = state.components['context-surface-analyzer']
  if (observer === undefined || analyzer === undefined) {
    throw new AgentHostError('OBSERVABILITY_RELEASE_COMPONENTS_MISSING', 'This release does not include local monitoring components')
  }
  const priorLaunchAgent = await backupPriorLaunchAgent(paths, runner)
  const candidate = {
    ...state,
    observability: {
      enabled: true,
      consentedAt: new Date().toISOString(),
      observer: { label: platform() === 'win32' ? WINDOWS_OBSERVER_TASK : OBSERVER_LABEL, stateDir: observerStateDir(), priorLaunchAgent },
      maintenance: null,
      latest: null,
    },
  }
  let installed = false
  let maintenance = null
  try {
    const installation = await runJson(observer, ['install', '--json'], runner, { env: observerEnvironment(candidate) })
    installed = true
    candidate.observability.observer = { ...candidate.observability.observer, installation }
    maintenance = await installMaintenance(paths.root, runner, {
      applicationCarrier: dependencies.applicationCarrier,
      resolveApplicationCarrier: dependencies.resolveApplicationCarrier,
    })
    candidate.observability.maintenance = maintenance
    candidate.observability.latest = await refreshState(candidate, paths, runner)
    candidate.updatedAt = new Date().toISOString()
    return candidate
  } catch (error) {
    const rollback = []
    if (maintenance !== null) {
      try {
        await uninstallMaintenance(maintenance, runner)
      } catch (failure) {
        rollback.push({ step: 'maintenance.uninstall', message: failure.message })
      }
    }
    if (installed) {
      try {
        await runJson(observer, ['uninstall', '--json'], runner, { env: observerEnvironment(candidate) })
      } catch (failure) {
        rollback.push({ step: 'observer.uninstall', message: failure.message })
      }
    }
    try {
      await restorePriorLaunchAgent(priorLaunchAgent, runner)
    } catch (failure) {
      rollback.push({ step: 'prior-launch-agent.restore', message: failure.message })
    }
    if (rollback.length > 0) {
      throw new AgentHostError('OBSERVABILITY_ACTIVATION_ROLLBACK_FAILED', 'Local monitoring activation failed and its partial installation could not be fully removed', {
        activation: error.message,
        rollback,
      })
    }
    throw error
  }
}

async function enableObservabilityUnlocked(options, dependencies = {}, preparedPaths = null) {
  const runner = dependencies.runner ?? runFile
  const paths = preparedPaths ?? await prepareStatePaths(resolveStateRoot(options.stateRoot))
  const current = await loadState(paths)
  if (current === null) throw new AgentHostError('NOT_INSTALLED', 'No Agent environment is installed')
  if (current.observability?.enabled === true) throw new AgentHostError('OBSERVABILITY_ALREADY_ENABLED', 'Observability is already enabled')
  let components
  if (current.channel === 'development') {
    components = await buildDevelopmentObservabilityManifest(current.developmentRoot)
  } else if (current.channel === 'release') {
    components = Object.fromEntries(['agent-tool-observer', 'context-surface-analyzer']
      .filter((id) => current.components[id] !== undefined)
      .map((id) => [id, current.components[id]]))
    if (Object.keys(components).length !== 2) {
      const { updateInstallation } = await import('./lifecycle.mjs')
      const result = await updateInstallation({
        stateRoot: paths.root,
        profile: 'observability',
        enableObservability: true,
        observabilityExpansionOnly: true,
        dryRun: false,
      }, dependencies)
      return {
        status: 'enabled',
        profile: 'observability',
        observability: result.observability,
        restartRequired: result.restartRequired,
        ...(result.warnings === undefined ? {} : { warnings: result.warnings }),
      }
    }
  } else {
    throw new AgentHostError('OBSERVABILITY_CHANNEL_UNSUPPORTED', `Unsupported channel: ${current.channel}`)
  }
  let candidate = null
  try {
    candidate = await (dependencies.activateObservability ?? activateObservabilityState)({
      ...current,
      profile: current.profile === 'standard' ? 'observability' : current.profile,
      components: { ...current.components, ...components },
    }, paths, runner, dependencies)
    await (dependencies.saveState ?? saveState)(paths, candidate, { retainCurrent: true })
  } catch (error) {
    let rollbackError = null
    if (candidate !== null) {
      try {
        await (dependencies.teardownObservability ?? teardownObservability)(candidate, paths, runner)
      } catch (failure) {
        rollbackError = failure
      }
    }
    if (rollbackError !== null) {
      throw new AgentHostError('OBSERVABILITY_ENABLE_ROLLBACK_FAILED', 'Local monitoring could not be enabled and its partial installation could not be removed', {
        enable: error.message,
        rollback: rollbackError.message,
      })
    }
    throw error
  }
  const warnings = await recordCommittedActivity(dependencies, paths, 'monitoring.enabled', 'Local monitoring turned on')
  return { status: 'enabled', profile: candidate.profile, observability: observabilitySummary(candidate.observability), ...(warnings.length === 0 ? {} : { warnings }) }
}

async function refreshObservabilityUnlocked(options, dependencies = {}, preparedPaths = null) {
  const runner = dependencies.runner ?? runFile
  const paths = preparedPaths ?? await prepareStatePaths(resolveStateRoot(options.stateRoot))
  const state = await loadState(paths)
  if (state === null) throw new AgentHostError('NOT_INSTALLED', 'No Agent environment is installed')
  if (state.observability?.enabled !== true) throw new AgentHostError('OBSERVABILITY_DISABLED', 'Observability is not enabled')
  try {
    state.observability.latest = await refreshState(state, paths, runner)
    state.updatedAt = new Date().toISOString()
    await (dependencies.saveState ?? saveState)(paths, state)
  } catch (error) {
    throw new AgentHostError('OBSERVABILITY_REFRESH_FAILED', 'Local monitoring refresh did not complete; some Observer collection or ingestion effects may already have occurred', {
      refresh: error.message,
      effects: {
        observerCollectionOrIngestionMayHaveOccurred: true,
        hostStateCommitted: false,
      },
    })
  }
  return { status: 'refreshed', observability: observabilitySummary(state.observability) }
}

export async function observabilityStatus(options, dependencies = {}) {
  const runner = dependencies.runner ?? runFile
  const paths = await readStatePaths(resolveStateRoot(options.stateRoot))
  const state = await loadState(paths)
  if (state === null) return { status: 'ok', configured: false, enabled: false }
  const analysis = await readJson(join(paths.context, 'managed-catalog.analysis.json'))
  let current = null
  let currentError = null
  if (state.observability?.enabled === true) {
    try {
      current = await readCurrentObservability(state, runner)
    } catch (error) {
      currentError = {
        status: 'unavailable',
        errorCode: error instanceof AgentHostError ? error.code : 'OBSERVABILITY_CURRENT_READ_FAILED',
      }
    }
  }
  return {
    status: 'ok',
    configured: true,
    enabled: state.observability?.enabled === true,
    consentedAt: state.observability?.consentedAt ?? null,
    latest: state.observability?.latest ?? null,
    current: current ?? currentError,
    analysis,
    privacy: { rawPromptStored: false, rawToolArgumentsStored: false, rawToolResultsStored: false, networkUsedByObserver: false, modelCallsByObserver: 0 },
  }
}

export async function exportObservabilityTrace(options, dependencies = {}) {
  const runner = dependencies.runner ?? runFile
  const paths = await readStatePaths(resolveStateRoot(options.stateRoot))
  const state = await loadState(paths)
  if (state === null) throw new AgentHostError('NOT_INSTALLED', 'No Agent environment is installed')
  if (state.observability?.enabled !== true) throw new AgentHostError('OBSERVABILITY_DISABLED', 'Observability is not enabled')
  if (typeof options.provider !== 'string' || typeof options.output !== 'string' || (typeof options.file === 'string') === (typeof options.session === 'string')) {
    throw new AgentHostError('CLI_USAGE', 'observability export-trace requires --provider, exactly one of --file or --session, and --output')
  }
  const observer = state.components['agent-tool-observer']
  if (observer === undefined) throw new AgentHostError('OBSERVABILITY_COMPONENT_MISSING', 'The installed Observer component is unavailable')
  const args = ['trace-export', '--provider', options.provider]
  if (typeof options.file === 'string') args.push('--file', options.file)
  else args.push('--session', options.session)
  args.push(
    '--output', options.output,
    '--max-events', String(options.maxEvents ?? 500),
    '--max-output-bytes', String(options.maxOutputBytes ?? 16 * 1024 * 1024),
  )
  if (options.fromMs !== undefined) args.push('--from-ms', String(options.fromMs))
  if (options.toMs !== undefined) args.push('--to-ms', String(options.toMs))
  if (options.includeSelectedContent === true) args.push('--include-selected-content')
  if (options.confirmSensitiveContent === true) args.push('--confirm-sensitive-content')
  args.push('--json')
  return runJson(observer, args, runner, {
    env: observerEnvironment(state),
    signal: options.signal,
    timeoutMs: 120_000,
    maxBuffer: 2 * 1024 * 1024,
  })
}

async function runObserverConfigurationCommand(options, commandArgs, dependencies = {}) {
  const runner = dependencies.runner ?? runFile
  const paths = await readStatePaths(resolveStateRoot(options.stateRoot))
  const state = await loadState(paths)
  if (state === null) throw new AgentHostError('NOT_INSTALLED', 'No Agent environment is installed')
  if (state.observability?.enabled !== true) throw new AgentHostError('OBSERVABILITY_DISABLED', 'Observability is not enabled')
  const observer = state.components['agent-tool-observer']
  if (observer === undefined) throw new AgentHostError('OBSERVABILITY_COMPONENT_MISSING', 'The installed Observer component is unavailable')
  return runJson(observer, [...commandArgs, '--json'], runner, {
    env: observerEnvironment(state),
    timeoutMs: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  })
}

export async function observabilityAdapters(options, dependencies = {}) {
  return runObserverConfigurationCommand(options, ['adapters'], dependencies)
}

export async function observabilityTraceSources(options, dependencies = {}) {
  if (typeof options.provider !== 'string' || options.provider.length === 0) {
    throw new AgentHostError('CLI_USAGE', 'observability trace-sources requires --provider')
  }
  const args = ['trace-sources', '--provider', options.provider, '--limit', String(options.limit ?? 50)]
  if (options.fromMs !== undefined) args.push('--from-ms', String(options.fromMs))
  if (options.toMs !== undefined) args.push('--to-ms', String(options.toMs))
  return runObserverConfigurationCommand(options, args, dependencies)
}

export async function observabilityAdapterPlan(options, dependencies = {}) {
  if (typeof options.adapter !== 'string' || options.adapter.length === 0) {
    throw new AgentHostError('CLI_USAGE', 'observability adapter-plan requires --adapter')
  }
  return runObserverConfigurationCommand(options, ['adapter-plan', '--adapter', options.adapter], dependencies)
}

export async function teardownObservability(state, paths, runner = runFile) {
  if (state.observability?.enabled !== true) return { removed: false }
  const observer = state.components['agent-tool-observer']
  const maintenance = await uninstallMaintenance(state.observability.maintenance, runner)
  const uninstalled = await runJson(observer, ['uninstall', '--json'], runner, { env: observerEnvironment(state) })
  const restored = await restorePriorLaunchAgent(state.observability.observer.priorLaunchAgent, runner)
  return { removed: true, maintenance, observer: uninstalled, priorLaunchAgent: restored, dataPreserved: true }
}

async function disableObservabilityUnlocked(options, dependencies = {}, preparedPaths = null) {
  const runner = dependencies.runner ?? runFile
  const paths = preparedPaths ?? await prepareStatePaths(resolveStateRoot(options.stateRoot))
  const state = await loadState(paths)
  if (state === null) throw new AgentHostError('NOT_INSTALLED', 'No Agent environment is installed')
  if (state.observability?.enabled !== true) return { status: 'disabled', changed: false }
  if (state.profile === 'local-dogfood') {
    throw new AgentHostError('OBSERVABILITY_PROFILE_REQUIRES_ENABLED', 'Switch to the Standard + local monitoring tool set before turning local monitoring off')
  }
  let results = null
  let mutationStarted = false
  let next = null
  try {
    mutationStarted = true
    results = await (dependencies.teardownObservability ?? teardownObservability)(state, paths, runner)
    const components = { ...state.components }
    delete components['agent-tool-observer']
    delete components['context-surface-analyzer']
    next = {
      ...state,
      components,
      profile: state.profile === 'observability' ? 'standard' : state.profile,
      observability: { enabled: false, disabledAt: new Date().toISOString(), dataPreserved: true },
      updatedAt: new Date().toISOString(),
    }
    await (dependencies.saveState ?? saveState)(paths, next, { retainCurrent: true })
  } catch (error) {
    let rollbackError = null
    if (mutationStarted) {
      try {
        await (dependencies.rebindObservability ?? rebindObservabilityState)(state, paths, runner)
      } catch (failure) {
        rollbackError = failure
      }
    }
    if (rollbackError !== null) {
      throw new AgentHostError('OBSERVABILITY_DISABLE_ROLLBACK_FAILED', 'Local monitoring could not be disabled and its previous installation could not be restored', {
        disable: error.message,
        rollback: rollbackError.message,
      })
    }
    throw error
  }
  const warnings = await recordCommittedActivity(dependencies, paths, 'monitoring.disabled', 'Local monitoring turned off')
  return { status: 'disabled', changed: true, results, ...(warnings.length === 0 ? {} : { warnings }) }
}

async function maintenanceUnlocked(options, dependencies = {}, preparedPaths = null) {
  const runner = dependencies.runner ?? runFile
  const paths = preparedPaths ?? await prepareStatePaths(resolveStateRoot(options.stateRoot))
  const state = await loadState(paths)
  if (state === null) throw new AgentHostError('NOT_INSTALLED', 'No Agent environment is installed')
  if (state.observability?.enabled !== true) throw new AgentHostError('OBSERVABILITY_DISABLED', 'Observability is not enabled')
  let refreshCompleted = false
  let stateCommitted = false
  let observerMaintenance = null
  let storage = null
  let storageCleanupAttempted = false
  try {
    state.observability.latest = await refreshState(state, paths, runner)
    refreshCompleted = true
    state.updatedAt = new Date().toISOString()
    await (dependencies.saveState ?? saveState)(paths, state)
    stateCommitted = true
    const observer = state.components['agent-tool-observer']
    observerMaintenance = await runJson(observer, ['maintain', '--json'], runner, { env: observerEnvironment(state), timeoutMs: 300_000 })
    storageCleanupAttempted = true
    storage = await (dependencies.cleanupStorage ?? cleanupStorage)({ stateRoot: paths.root }, dependencies)
  } catch (error) {
    throw new AgentHostError('OBSERVABILITY_MAINTENANCE_PARTIAL', 'Local maintenance did not complete; committed and possible effects are disclosed in the error details', {
      maintenance: error.message,
      effects: {
        observerRefreshCompleted: refreshCompleted,
        hostStateCommitted: stateCommitted,
        observerRetentionMayHaveChanged: observerMaintenance !== null,
        hostStorageMayHaveChanged: storageCleanupAttempted,
      },
    })
  }
  const warnings = await recordCommittedActivity(dependencies, paths, 'environment.maintained', 'Local observation and package storage maintained', {
    observerRowsRemoved: Object.values(observerMaintenance.removed ?? {}).reduce((sum, value) => sum + value, 0),
    storageBytesReclaimed: storage.reclaimedAllocatedBytes,
  })
  return {
    status: 'maintained',
    observability: observabilitySummary(state.observability),
    observer: observerMaintenance,
    storage,
    ...(warnings.length === 0 ? {} : { warnings }),
  }
}

async function lockedObservabilityMutation(options, dependencies, operation, callback) {
  const paths = statePaths(resolveStateRoot(options.stateRoot))
  return await withLifecycleMutation(paths, operation, dependencies, callback)
}

export async function enableObservability(options, dependencies = {}) {
  return await lockedObservabilityMutation(options, dependencies, 'observability.enable', (locked, paths) =>
    enableObservabilityUnlocked(options, locked, paths))
}

export async function refreshObservability(options, dependencies = {}) {
  return await lockedObservabilityMutation(options, dependencies, 'observability.refresh', (locked, paths) =>
    refreshObservabilityUnlocked(options, locked, paths))
}

export async function disableObservability(options, dependencies = {}) {
  return await lockedObservabilityMutation(options, dependencies, 'observability.disable', (locked, paths) =>
    disableObservabilityUnlocked(options, locked, paths))
}

export async function maintenance(options, dependencies = {}) {
  return await lockedObservabilityMutation(options, dependencies, 'observability.maintenance', (locked, paths) =>
    maintenanceUnlocked(options, locked, paths))
}
