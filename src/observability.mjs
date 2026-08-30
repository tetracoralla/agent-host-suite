import { chmod, copyFile, lstat, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildDevelopmentObservabilityManifest } from './development-manifest.mjs'
import { AgentHostError } from './errors.mjs'
import { exportManagedCatalogInventory } from './context-exporter.mjs'
import { readJson, writePrivateJson } from './json.mjs'
import { resolveStateRoot } from './paths.mjs'
import { runFile } from './process.mjs'
import { installMaintenance, uninstallMaintenance } from './maintenance-service.mjs'
import { loadState, prepareStatePaths, saveState } from './state.mjs'
import { recordActivity } from './activity.mjs'
import { cleanupStorage } from './storage.mjs'

const OBSERVER_LABEL = 'com.openadam.agent-tool-observer'
const SUPPORTED_OBSERVER_REPORTS = new Set([
  'openadam.agent-tool-observer.report.v0.4',
  'openadam.agent-tool-observer.report.v0.5',
])
const SEMANTIC_TARGET_KINDS = new Set(['procedure', 'capability', 'mcp-tool', 'mcp-operation'])

function observerStateDir() {
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
  const result = await runner('/bin/launchctl', ['print', `gui/${process.getuid()}/${OBSERVER_LABEL}`], { allowFailure: true, timeoutMs: 5_000 })
  return result.status === 0
}

async function backupPriorLaunchAgent(paths, runner) {
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
  if (!SUPPORTED_OBSERVER_REPORTS.has(report.schemaVersion) || !Array.isArray(report.semanticExecutions)) {
    throw new AgentHostError('OBSERVABILITY_REPORT_UNSUPPORTED', 'Observer returned an unsupported report contract')
  }
  const semanticTotals = semanticExecutionTotals(report.semanticExecutions)
  const suiteExecutions = report.semanticExecutions.filter((item) => [
    'io.github.tetracoralla.math-anchor',
    'io.github.tetracoralla.migratory-time',
  ].includes(item.providerId))
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
    report: {
      schemaVersion: report.schemaVersion,
      generatedAtMs: report.generatedAtMs,
      windowDays: report.windowDays,
      providers: report.providers,
      usage: report.usage,
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
    },
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

export async function enableObservability(options, dependencies = {}) {
  const runner = dependencies.runner ?? runFile
  const paths = await prepareStatePaths(resolveStateRoot(options.stateRoot))
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
      throw new AgentHostError('OBSERVABILITY_RELEASE_COMPONENTS_MISSING', 'This release does not include local monitoring components')
    }
  } else {
    throw new AgentHostError('OBSERVABILITY_CHANNEL_UNSUPPORTED', `Unsupported channel: ${current.channel}`)
  }
  const priorLaunchAgent = await backupPriorLaunchAgent(paths, runner)
  const observer = components['agent-tool-observer']
  const candidate = {
    ...current,
    profile: current.profile === 'standard' ? 'observability' : current.profile,
    components: { ...current.components, ...components },
    observability: {
      enabled: true,
      consentedAt: new Date().toISOString(),
      observer: { label: OBSERVER_LABEL, stateDir: observerStateDir(), priorLaunchAgent },
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
    maintenance = await installMaintenance(paths.root, runner)
    candidate.observability.maintenance = maintenance
    candidate.observability.latest = await refreshState(candidate, paths, runner)
    candidate.updatedAt = new Date().toISOString()
    await saveState(paths, candidate, { retainCurrent: true })
    await recordActivity(paths, 'monitoring.enabled', 'Local monitoring turned on')
    return { status: 'enabled', profile: candidate.profile, observability: observabilitySummary(candidate.observability) }
  } catch (error) {
    if (maintenance !== null) await uninstallMaintenance(maintenance, runner).catch(() => {})
    if (installed) await runJson(observer, ['uninstall', '--json'], runner, { env: observerEnvironment(candidate) }).catch(() => {})
    await restorePriorLaunchAgent(priorLaunchAgent, runner).catch(() => {})
    throw error
  }
}

export async function refreshObservability(options, dependencies = {}) {
  const runner = dependencies.runner ?? runFile
  const paths = await prepareStatePaths(resolveStateRoot(options.stateRoot))
  const state = await loadState(paths)
  if (state === null) throw new AgentHostError('NOT_INSTALLED', 'No Agent environment is installed')
  if (state.observability?.enabled !== true) throw new AgentHostError('OBSERVABILITY_DISABLED', 'Observability is not enabled')
  state.observability.latest = await refreshState(state, paths, runner)
  state.updatedAt = new Date().toISOString()
  await saveState(paths, state)
  return { status: 'refreshed', observability: observabilitySummary(state.observability) }
}

export async function observabilityStatus(options) {
  const paths = await prepareStatePaths(resolveStateRoot(options.stateRoot))
  const state = await loadState(paths)
  if (state === null) return { status: 'ok', configured: false, enabled: false }
  const analysis = await readJson(join(paths.context, 'managed-catalog.analysis.json'))
  return {
    status: 'ok',
    configured: true,
    enabled: state.observability?.enabled === true,
    consentedAt: state.observability?.consentedAt ?? null,
    latest: state.observability?.latest ?? null,
    analysis,
    privacy: { rawPromptStored: false, rawToolArgumentsStored: false, rawToolResultsStored: false, networkUsedByObserver: false, modelCallsByObserver: 0 },
  }
}

export async function teardownObservability(state, paths, runner = runFile) {
  if (state.observability?.enabled !== true) return { removed: false }
  const observer = state.components['agent-tool-observer']
  const maintenance = await uninstallMaintenance(state.observability.maintenance, runner)
  const uninstalled = await runJson(observer, ['uninstall', '--json'], runner, { env: observerEnvironment(state) })
  const restored = await restorePriorLaunchAgent(state.observability.observer.priorLaunchAgent, runner)
  return { removed: true, maintenance, observer: uninstalled, priorLaunchAgent: restored, dataPreserved: true }
}

export async function disableObservability(options, dependencies = {}) {
  const runner = dependencies.runner ?? runFile
  const paths = await prepareStatePaths(resolveStateRoot(options.stateRoot))
  const state = await loadState(paths)
  if (state === null) throw new AgentHostError('NOT_INSTALLED', 'No Agent environment is installed')
  if (state.observability?.enabled !== true) return { status: 'disabled', changed: false }
  if (state.profile === 'local-dogfood') {
    throw new AgentHostError('OBSERVABILITY_PROFILE_REQUIRES_ENABLED', 'Switch to the Standard + local monitoring tool set before turning local monitoring off')
  }
  const results = await teardownObservability(state, paths, runner)
  delete state.components['agent-tool-observer']
  delete state.components['context-surface-analyzer']
  state.profile = state.profile === 'observability' ? 'standard' : state.profile
  state.observability = { enabled: false, disabledAt: new Date().toISOString(), dataPreserved: true }
  state.updatedAt = new Date().toISOString()
  await saveState(paths, state, { retainCurrent: true })
  await recordActivity(paths, 'monitoring.disabled', 'Local monitoring turned off')
  return { status: 'disabled', changed: true, results }
}

export async function maintenance(options, dependencies = {}) {
  const runner = dependencies.runner ?? runFile
  const paths = await prepareStatePaths(resolveStateRoot(options.stateRoot))
  const state = await loadState(paths)
  if (state === null) throw new AgentHostError('NOT_INSTALLED', 'No Agent environment is installed')
  if (state.observability?.enabled !== true) throw new AgentHostError('OBSERVABILITY_DISABLED', 'Observability is not enabled')
  state.observability.latest = await refreshState(state, paths, runner)
  const observer = state.components['agent-tool-observer']
  const observerMaintenance = await runJson(observer, ['maintain', '--json'], runner, { env: observerEnvironment(state), timeoutMs: 300_000 })
  state.updatedAt = new Date().toISOString()
  await saveState(paths, state)
  const storage = await (dependencies.cleanupStorage ?? cleanupStorage)({ stateRoot: paths.root })
  await recordActivity(paths, 'environment.maintained', 'Local observation and package storage maintained', {
    observerRowsRemoved: Object.values(observerMaintenance.removed ?? {}).reduce((sum, value) => sum + value, 0),
    storageBytesReclaimed: storage.reclaimedAllocatedBytes,
  })
  return {
    status: 'maintained',
    observability: observabilitySummary(state.observability),
    observer: observerMaintenance,
    storage,
  }
}
