import { doctor } from './doctor.mjs'
import { asPublicError, AgentHostError } from './errors.mjs'
import { addHost, hostStatus, removeHost, rollbackInstallation, setActiveTools, toolSetStatus, uninstallInstallation, updateInstallation } from './lifecycle.mjs'
import { disableObservability, enableObservability, maintenance, observabilityStatus, observabilitySummary, refreshObservability } from './observability.mjs'
import { readJson } from './json.mjs'
import { resolveStateRoot } from './paths.mjs'
import { loadState, prepareStatePaths } from './state.mjs'
import { setup } from './setup.mjs'
import { listActivity } from './activity.mjs'
import { cleanupStorage, storageStatus } from './storage.mjs'
import { operationsSnapshot } from './operations-snapshot.mjs'
import { join } from 'node:path'

const USAGE = `Usage:
  agent-host setup [--profile standard|observability|local-dogfood] [--tool COMPONENT] [--host codex|claude] [--workspace-root PATH] [--release-manifest PATH | --development-root PATH] [--enable-observability] [--no-service] [--dry-run] [--json]
  agent-host status [--state-root PATH] [--json]
  agent-host snapshot [--state-root PATH] [--json]
  agent-host activity [--state-root PATH] [--json]
  agent-host storage [--state-root PATH] [--json]
  agent-host cleanup [--dry-run] [--state-root PATH] [--json]
  agent-host doctor [--deep] [--state-root PATH] [--json]
  agent-host update [--profile standard|observability|local-dogfood] [--tool COMPONENT] [--workspace-root PATH] [--replace-host-conflicts] [--dry-run] [--state-root PATH] [--json]
  agent-host tools status [--state-root PATH] [--json]
  agent-host tools set --tool COMPONENT [--tool COMPONENT] [--replace-host-conflicts] [--dry-run] [--state-root PATH] [--json]
  agent-host tools reset [--replace-host-conflicts] [--dry-run] [--state-root PATH] [--json]
  agent-host rollback [--dry-run] [--state-root PATH] [--json]
  agent-host observability enable|disable|refresh|status [--state-root PATH] [--json]
  agent-host host add|remove|status codex|claude [--state-root PATH] [--json]
  agent-host uninstall [--purge-data] [--state-root PATH] [--json]`

function parseArgs(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) return { command: 'help', json: false }
  const options = {
    command: argv[0],
    action: ['observability', 'host', 'tools'].includes(argv[0]) ? argv[1] : undefined,
    target: argv[0] === 'host' ? argv[2] : undefined,
    profile: argv[0] === 'setup' ? 'standard' : undefined,
    hosts: [],
    tools: [],
    json: false,
    deep: false,
    dryRun: false,
    noService: false,
    enableObservability: false,
    purgeData: false,
    replaceHostConflicts: false,
  }
  const values = new Set(['--profile', '--host', '--tool', '--workspace-root', '--development-root', '--release-manifest', '--state-root'])
  const booleans = new Map([
    ['--json', 'json'], ['--deep', 'deep'], ['--dry-run', 'dryRun'], ['--no-service', 'noService'],
    ['--enable-observability', 'enableObservability'], ['--purge-data', 'purgeData'],
    ['--replace-host-conflicts', 'replaceHostConflicts'],
  ])
  const start = options.command === 'host' ? 3 : ['observability', 'tools'].includes(options.command) ? 2 : 1
  if (['observability', 'host', 'tools'].includes(options.command) && options.action === undefined) throw new AgentHostError('CLI_USAGE', `${options.command} requires an action`)
  if (options.command === 'host' && options.target === undefined) throw new AgentHostError('CLI_USAGE', 'host requires codex or claude')
  for (let index = start; index < argv.length; index += 1) {
    const arg = argv[index]
    if (booleans.has(arg)) {
      options[booleans.get(arg)] = true
      continue
    }
    if (values.has(arg)) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new AgentHostError('CLI_USAGE', `${arg} requires a value`)
      index += 1
      if (arg === '--host') options.hosts.push(value)
      else if (arg === '--tool') options.tools.push(value)
      else if (arg === '--workspace-root') options.workspaceRoot = value
      else if (arg === '--development-root') options.developmentRoot = value
      else if (arg === '--release-manifest') options.releaseManifest = value
      else if (arg === '--state-root') options.stateRoot = value
      else options.profile = value
      continue
    }
    throw new AgentHostError('CLI_USAGE', `Unknown argument: ${arg}`)
  }
  if (options.tools.length === 0) options.tools = undefined
  return options
}

function formatBytes(value) {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount < 0) return 'unknown'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let scaled = amount
  let unit = 0
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024
    unit += 1
  }
  const digits = unit === 0 || scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2
  return `${scaled.toFixed(digits)} ${units[unit]}`
}

function storageSummary(result) {
  const sections = result.sections
  const historyAndBackups = Number(sections.history?.allocatedBytes ?? 0) + Number(sections.backups?.allocatedBytes ?? 0)
  const installation = result.installation
  return [
    `Storage · ${formatBytes(installation?.allocatedBytes ?? sections.total.allocatedBytes)} allocated (${formatBytes(installation?.apparentBytes ?? sections.total.apparentBytes)} apparent)`,
    ...(installation?.managerApp === null || installation?.managerApp === undefined ? [] : [`Manager app ${formatBytes(installation.managerApp.allocatedBytes)} · private state ${formatBytes(installation.privateState.allocatedBytes)}`]),
    `Packages ${formatBytes(sections.packages.allocatedBytes)} · host projections ${formatBytes(sections.hostProjections.allocatedBytes)} · downloads ${formatBytes(sections.downloads.allocatedBytes)} · runtime ${formatBytes(sections.runtime.allocatedBytes)}`,
    `Observations ${formatBytes(sections.observations.allocatedBytes)} · catalog snapshots ${formatBytes(sections.context.allocatedBytes)} · history/backups ${formatBytes(historyAndBackups)}`,
    `Cleanup · ${result.cleanup.packageVersions} package versions, ${result.cleanup.downloads} downloads, ${formatBytes(result.cleanup.allocatedBytes)} eligible`,
  ].join('\n')
}

export function human(result) {
  if (result.schemaVersion === 'openadam.agent-host-tool-set.v0.1') {
    const active = result.activeAgentComponents?.length ?? 0
    const available = result.availableAgentComponents?.length ?? active + (result.inactiveAgentComponents?.length ?? 0)
    const suffix = result.restartRequired === true ? ' · start a fresh Agent task' : ''
    return `Agent tools · ${active} of ${available} active${suffix}`
  }
  if (result.schemaVersion === 'openadam.agent-host-operations-snapshot.v0.1') {
    if (result.configured !== true) return 'No Agent environment is installed.'
    const observation = result.observability?.enabled === true
      ? `monitoring refreshed ${result.observability.refreshedAt ?? 'unknown'}`
      : 'monitoring off'
    return `Agent Host ${result.environment.suiteVersion} · ${result.environment.profile} · ${observation} · ${formatBytes(result.storage.allocatedBytes)} allocated`
  }
  if (result.status === 'ok' && Array.isArray(result.checks)) {
    return [`Doctor: ${result.status}`, ...result.checks.map((item) => `${item.status === 'ok' ? '✓' : '✗'} ${item.message}`)].join('\n')
  }
  if (result.host !== undefined && result.appInstalled !== undefined) {
    if (!result.appInstalled) return `${result.host} is not installed.`
    if (result.managed !== true) return `${result.host} is installed but not connected to Agent Host.`
    return `${result.host} ${result.healthy === true ? 'is ready' : 'needs attention'}.`
  }
  if (result.privacy !== undefined && result.enabled !== undefined) {
    if (result.configured !== true) return 'Observability off · no Agent environment installed.'
    if (result.enabled !== true) return 'Observability disabled · local data preserved.'
    return `Observability enabled · last refresh ${result.latest?.refreshedAt ?? 'unknown'}.`
  }
  if (result.configured === false) return 'No Agent environment is installed.'
  if (result.configured === true) return `Agent Host ${result.suiteVersion} · ${result.profile} · ${Object.keys(result.hosts).join(', ') || 'no connected Agent app'}`
  if (result.status === 'enabled') return 'Observability enabled · local metadata collection is active.'
  if (result.status === 'disabled') return `Observability disabled · local data ${result.results?.dataPreserved === false ? 'removed' : 'preserved'}.`
  if (result.status === 'refreshed') return 'Observability refreshed.'
  if (result.status === 'ok' && result.sections?.total !== undefined && result.cleanup !== undefined) return storageSummary(result)
  if (result.status === 'cleaned') return `Storage cleaned · ${result.reclaimedAllocatedBytes} allocated bytes reclaimed.`
  if (result.status === 'ready' && result.plan !== undefined) return `Cleanup preview · ${result.plan.allocatedBytes} allocated bytes eligible; nothing changed.`
  return `${result.status}${result.restartRequired ? ' · start a fresh Agent session' : ''}`
}

async function status(options) {
  const paths = await prepareStatePaths(resolveStateRoot(options.stateRoot))
  const state = await loadState(paths)
  if (state === null) return { status: 'ok', configured: false, stateRoot: paths.root }
  return {
    status: 'ok', configured: true, stateRoot: paths.root, suiteVersion: state.suiteVersion,
    channel: state.channel, profile: state.profile,
    availableAgentComponents: state.availableAgentComponents ?? state.agentComponents ?? Object.keys(state.components),
    agentComponents: state.agentComponents ?? Object.keys(state.components),
    installedAt: state.installedAt, updatedAt: state.updatedAt, releaseActivatedAt: state.releaseActivatedAt ?? null,
    bindingsActivatedAt: state.bindingsActivatedAt ?? state.releaseActivatedAt ?? null,
    components: Object.fromEntries(Object.entries(state.components).map(([id, component]) => [id, {
      version: component.version,
      ...(component.displayName === undefined ? {} : { displayName: component.displayName, summary: component.summary }),
    }])),
    hosts: Object.fromEntries(Object.entries(state.hosts).map(([id, host]) => [id, {
      installed: true,
      version: host.version,
      restartRequired: host.restartRequired === true,
      entries: host.entries.map((entry) => ({
        component: entry.component,
        ownership: entry.pluginCreated === true || entry.created === true ? 'suite' : 'user',
      })),
    }])),
    workspaceRoot: state.workspaceRoot ?? null,
    service: state.runtime.service, observability: observabilitySummary(state.observability),
  }
}

async function run(options) {
  if (options.command === 'help') return { help: USAGE }
  if (options.command === 'setup') return setup(options)
  if (options.command === 'status') return status(options)
  if (options.command === 'snapshot') return operationsSnapshot(options)
  if (options.command === 'activity') {
    const paths = await prepareStatePaths(resolveStateRoot(options.stateRoot))
    return { status: 'ok', entries: await listActivity(paths) }
  }
  if (options.command === 'storage') return storageStatus(options)
  if (options.command === 'cleanup') return cleanupStorage(options)
  if (options.command === 'tools') {
    if (options.action === 'status') return toolSetStatus(options)
    if (options.action === 'set') {
      if (options.tools === undefined) throw new AgentHostError('CLI_USAGE', 'tools set requires at least one --tool')
      return setActiveTools(options)
    }
    if (options.action === 'reset') return setActiveTools({ ...options, resetTools: true })
    throw new AgentHostError('CLI_USAGE', `Unknown tools action: ${options.action}`)
  }
  if (options.command === 'update') return updateInstallation(options)
  if (options.command === 'rollback') return rollbackInstallation(options)
  if (options.command === 'observability') {
    if (options.action === 'enable') return enableObservability(options)
    if (options.action === 'disable') return disableObservability(options)
    if (options.action === 'refresh') return refreshObservability(options)
    if (options.action === 'status') return observabilityStatus(options)
    throw new AgentHostError('CLI_USAGE', `Unknown observability action: ${options.action}`)
  }
  if (options.command === 'maintenance') return maintenance(options)
  if (options.command === 'host') {
    if (options.action === 'add') return addHost(options)
    if (options.action === 'remove') return removeHost(options)
    if (options.action === 'status') return hostStatus(options)
    throw new AgentHostError('CLI_USAGE', `Unknown host action: ${options.action}`)
  }
  if (options.command === 'uninstall') return uninstallInstallation(options)
  if (options.command === 'doctor') {
    const paths = await prepareStatePaths(resolveStateRoot(options.stateRoot))
    const state = await loadState(paths)
    if (state === null) throw new AgentHostError('NOT_INSTALLED', 'No Agent environment is installed')
    const contextAnalysis = state.observability?.enabled === true
      ? await readJson(join(paths.context, 'managed-catalog.analysis.json')).catch(() => null)
      : null
    return doctor(state, { deep: options.deep, contextAnalysis })
  }
  throw new AgentHostError('CLI_USAGE', `Unknown command: ${options.command}`)
}

export async function main(argv) {
  let options = { json: argv.includes('--json') }
  try {
    options = parseArgs(argv)
    const result = await run(options)
    if (result.help !== undefined) process.stdout.write(`${result.help}\n`)
    else process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `${human(result)}\n`)
    return result.status === 'error' ? 1 : 0
  } catch (error) {
    const publicError = asPublicError(error)
    const envelope = { status: 'error', error: publicError }
    process.stderr.write(options.json ? `${JSON.stringify(envelope)}\n` : `${publicError.code}: ${publicError.message}\n`)
    return publicError.code === 'CLI_USAGE' ? 2 : 1
  }
}
