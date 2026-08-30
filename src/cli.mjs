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
import { importLocalComponent, localComponentStatus, previewLocalComponent, removeLocalComponent, rollbackLocalComponent } from './local-components.mjs'
import { isAbsolute, join } from 'node:path'

const USAGE = `Usage:
  agent-host setup [--profile standard|observability|local-dogfood] [--tool COMPONENT] [--host codex|claude] [--workspace-root PATH] [--release-manifest PATH | --development-root PATH] [--enable-observability] [--replace-host-conflicts] [--no-service] [--dry-run] [--state-root PATH] [--json]
  agent-host status [--state-root PATH] [--json]
  agent-host snapshot [--state-root PATH] [--json]
  agent-host activity [--state-root PATH] [--json]
  agent-host storage [--state-root PATH] [--json]
  agent-host cleanup [--dry-run] [--state-root PATH] [--json]
  agent-host doctor [--deep] [--skip-agent-apps] [--state-root PATH] [--json]
  agent-host update [--profile standard|observability|local-dogfood] [--tool COMPONENT] [--workspace-root PATH] [--release-manifest PATH] [--replace-host-conflicts] [--dry-run] [--state-root PATH] [--json]
  agent-host tools status [--state-root PATH] [--json]
  agent-host tools set --tool COMPONENT [--tool COMPONENT] [--replace-host-conflicts] [--dry-run] [--state-root PATH] [--json]
  agent-host tools reset [--replace-host-conflicts] [--dry-run] [--state-root PATH] [--json]
  agent-host component preview --artifact PATH --license-spdx EXPRESSION [--workspace-root PATH] [--state-root PATH] [--json]
  agent-host component import --artifact PATH --binding PATH [--activate] [--replace] [--workspace-root PATH] [--replace-host-conflicts] [--dry-run] [--state-root PATH] [--json]
  agent-host component list [--state-root PATH] [--json]
  agent-host component status COMPONENT [--state-root PATH] [--json]
  agent-host component remove COMPONENT [--replace-host-conflicts] [--dry-run] [--state-root PATH] [--json]
  agent-host component rollback COMPONENT [--workspace-root PATH] [--replace-host-conflicts] [--dry-run] [--state-root PATH] [--json]
  agent-host rollback [--workspace-root PATH] [--replace-host-conflicts] [--dry-run] [--state-root PATH] [--json]
  agent-host observability enable|disable|refresh|status [--state-root PATH] [--json]
  agent-host host add codex|claude [--workspace-root PATH] [--replace-host-conflicts] [--state-root PATH] [--json]
  agent-host host remove codex|claude [--state-root PATH] [--json]
  agent-host host status codex|claude [--quick] [--state-root PATH] [--json]
  agent-host uninstall [--purge-data] [--state-root PATH] [--json]`

const ROUTE_ARGUMENTS = Object.freeze({
  setup: ['--profile', '--host', '--tool', '--workspace-root', '--development-root', '--release-manifest', '--state-root', '--enable-observability', '--replace-host-conflicts', '--no-service', '--dry-run', '--json'],
  status: ['--state-root', '--json'],
  snapshot: ['--state-root', '--json'],
  activity: ['--state-root', '--json'],
  storage: ['--state-root', '--json'],
  cleanup: ['--state-root', '--dry-run', '--json'],
  doctor: ['--state-root', '--deep', '--skip-agent-apps', '--json'],
  update: ['--profile', '--tool', '--workspace-root', '--release-manifest', '--replace-host-conflicts', '--dry-run', '--state-root', '--json'],
  rollback: ['--workspace-root', '--replace-host-conflicts', '--dry-run', '--state-root', '--json'],
  uninstall: ['--purge-data', '--state-root', '--json'],
  maintenance: ['--state-root', '--json'],
  'tools status': ['--state-root', '--json'],
  'tools set': ['--tool', '--replace-host-conflicts', '--dry-run', '--state-root', '--json'],
  'tools reset': ['--replace-host-conflicts', '--dry-run', '--state-root', '--json'],
  'component preview': ['--artifact', '--license-spdx', '--workspace-root', '--state-root', '--json'],
  'component import': ['--artifact', '--binding', '--activate', '--replace', '--workspace-root', '--replace-host-conflicts', '--dry-run', '--state-root', '--json'],
  'component list': ['--state-root', '--json'],
  'component status': ['--state-root', '--json'],
  'component remove': ['--replace-host-conflicts', '--dry-run', '--state-root', '--json'],
  'component rollback': ['--workspace-root', '--replace-host-conflicts', '--dry-run', '--state-root', '--json'],
  'observability enable': ['--state-root', '--json'],
  'observability disable': ['--state-root', '--json'],
  'observability refresh': ['--state-root', '--json'],
  'observability status': ['--state-root', '--json'],
  'host add': ['--workspace-root', '--replace-host-conflicts', '--state-root', '--json'],
  'host remove': ['--state-root', '--json'],
  'host status': ['--state-root', '--quick', '--json'],
})

function routeName(options) {
  return ['observability', 'host', 'tools', 'component'].includes(options.command)
    ? `${options.command} ${options.action ?? ''}`.trim()
    : options.command
}

function parseArgs(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) return { command: 'help', json: false }
  const options = {
    command: argv[0],
    action: ['observability', 'host', 'tools', 'component'].includes(argv[0]) ? argv[1] : undefined,
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
    activate: false,
    replace: false,
    skipAgentApps: false,
    quick: false,
  }
  if (options.command === 'component' && ['status', 'remove', 'rollback'].includes(options.action) && argv[2] !== undefined && !argv[2].startsWith('--')) options.target = argv[2]
  const values = new Set(['--profile', '--host', '--tool', '--workspace-root', '--development-root', '--release-manifest', '--state-root', '--artifact', '--binding', '--license-spdx'])
  const booleans = new Map([
    ['--json', 'json'], ['--deep', 'deep'], ['--dry-run', 'dryRun'], ['--no-service', 'noService'],
    ['--enable-observability', 'enableObservability'], ['--purge-data', 'purgeData'],
    ['--replace-host-conflicts', 'replaceHostConflicts'],
    ['--activate', 'activate'], ['--replace', 'replace'],
    ['--skip-agent-apps', 'skipAgentApps'], ['--quick', 'quick'],
  ])
  const start = options.command === 'host' ? 3 : options.command === 'component' && options.target !== undefined ? 3 : ['observability', 'tools', 'component'].includes(options.command) ? 2 : 1
  if (['observability', 'host', 'tools', 'component'].includes(options.command) && options.action === undefined) throw new AgentHostError('CLI_USAGE', `${options.command} requires an action`)
  if (options.command === 'host' && options.target === undefined) throw new AgentHostError('CLI_USAGE', 'host requires codex or claude')
  const route = routeName(options)
  const allowed = new Set(ROUTE_ARGUMENTS[route] ?? ['--json'])
  for (let index = start; index < argv.length; index += 1) {
    const arg = argv[index]
    if ((booleans.has(arg) || values.has(arg)) && !allowed.has(arg)) {
      throw new AgentHostError('CLI_USAGE', `${route} does not accept ${arg}`)
    }
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
      else if (arg === '--artifact') options.artifact = value
      else if (arg === '--binding') options.bindingPath = value
      else if (arg === '--license-spdx') options.licenseSpdx = value
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
  if (Array.isArray(result.components) && result.components.every((item) => item.id !== undefined && item.installed !== undefined)) {
    if (result.components.length === 0) return 'No private Agent tools are imported.'
    return result.components.map((item) => `${item.id} ${item.version ?? 'removed'} · ${item.active ? 'active' : item.installed ? 'inactive' : 'removed'}`).join('\n')
  }
  if (result.component?.id !== undefined && result.component?.installed !== undefined) {
    const suffix = result.restartRequired === true ? ' · start a fresh Agent task' : ''
    const activityWarning = result.warnings?.some((warning) => warning.code === 'ACTIVITY_LOG_WRITE_FAILED') === true
      ? ' · activity log unavailable'
      : ''
    const cleanupWarning = result.warnings?.some((warning) => warning.code === 'CODEX_PROJECTION_CLEANUP_FAILED') === true
      ? ' · stale projection cleanup pending'
      : ''
    return `${result.component.id} ${result.component.version ?? 'removed'} · ${result.status}${suffix}${activityWarning}${cleanupWarning}`
  }
  if (result.schemaVersion === 'openadam.agent-host-local-component-preview.v0.1') {
    return `${result.component.id} ${result.component.version} · package structure and MCP catalog ready for explicit import approval`
  }
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
      private: state.privateComponents?.[id]?.current?.component !== undefined,
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
  if (options.command === 'component') {
    if (options.action === 'preview') {
      if (options.artifact === undefined || options.licenseSpdx === undefined) throw new AgentHostError('CLI_USAGE', 'component preview requires --artifact and --license-spdx')
      return previewLocalComponent(options)
    }
    if (options.action === 'import') {
      if (options.artifact === undefined || options.bindingPath === undefined) throw new AgentHostError('CLI_USAGE', 'component import requires --artifact and --binding')
      if (!isAbsolute(options.bindingPath)) throw new AgentHostError('CLI_USAGE', 'component import --binding must be an absolute file path')
      const bindingFile = await readJson(options.bindingPath)
      if (bindingFile === null) throw new AgentHostError('LOCAL_COMPONENT_BINDING_UNAVAILABLE', 'The local component binding file is unavailable')
      const binding = bindingFile.schemaVersion === 'openadam.agent-host-local-component-preview.v0.1' ? bindingFile.binding : bindingFile
      return importLocalComponent({ ...options, binding })
    }
    if (options.action === 'list') return localComponentStatus(options)
    if (options.action === 'status') {
      if (options.target === undefined) throw new AgentHostError('CLI_USAGE', 'component status requires a component id')
      return localComponentStatus(options)
    }
    if (options.action === 'remove') {
      if (options.target === undefined) throw new AgentHostError('CLI_USAGE', 'component remove requires a component id')
      return removeLocalComponent(options)
    }
    if (options.action === 'rollback') {
      if (options.target === undefined) throw new AgentHostError('CLI_USAGE', 'component rollback requires a component id')
      return rollbackLocalComponent(options)
    }
    throw new AgentHostError('CLI_USAGE', `Unknown component action: ${options.action}`)
  }
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
    return doctor(state, { deep: options.deep, inspectAgentApps: !options.skipAgentApps, contextAnalysis })
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
