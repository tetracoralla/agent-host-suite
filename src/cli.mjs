import { doctor } from './doctor.mjs'
import { asPublicError, AgentHostError } from './errors.mjs'
import { addHost, hostStatus, recoverServiceInstallation, removeHost, rollbackInstallation, setActiveTools, toolSetStatus, uninstallInstallation, updateInstallation } from './lifecycle.mjs'
import { disableObservability, enableObservability, exportObservabilityTrace, maintenance, observabilityAdapterPlan, observabilityAdapters, observabilityStatus, observabilitySummary, observabilityTraceSources, refreshObservability } from './observability.mjs'
import { readJson } from './json.mjs'
import { resolveStateRoot } from './paths.mjs'
import { loadState, readStatePaths } from './state.mjs'
import { setup } from './setup.mjs'
import { listActivity } from './activity.mjs'
import { cleanupStorage, storageStatus } from './storage.mjs'
import { operationsSnapshot } from './operations-snapshot.mjs'
import { importLocalComponent, localComponentStatus, previewLocalComponent, removeLocalComponent, rollbackLocalComponent } from './local-components.mjs'
import { exportSkillLinkCatalog } from './skill-link-catalog.mjs'
import { usageSummary } from './usage-summary.mjs'
import { startWebManager } from './web-manager.mjs'
import { isAbsolute, join, resolve } from 'node:path'

const USAGE = `Usage:
  agent-host setup [--profile standard|developer|observability|local-dogfood] [--tool COMPONENT] [--host codex|claude|zcode] [--workspace-root PATH] [--release-manifest PATH | --development-root PATH] [--enable-observability] [--replace-host-conflicts] [--no-service] [--dry-run] [--state-root PATH] [--json]
  agent-host status [--state-root PATH] [--json]
  agent-host snapshot [--state-root PATH] [--json]
  agent-host catalog [--state-root PATH] [--json]
  agent-host activity [--state-root PATH] [--json]
  agent-host usage [--state-root PATH] [--json]
  agent-host manager [--no-open] [--state-root PATH]
  agent-host storage [--state-root PATH] [--json]
  agent-host cleanup [--dry-run] [--state-root PATH] [--json]
  agent-host maintenance [--state-root PATH] [--json]
  agent-host doctor [--deep] [--skip-agent-apps] [--state-root PATH] [--json]
  agent-host update [--profile standard|developer|observability|local-dogfood] [--tool COMPONENT] [--workspace-root PATH] [--release-manifest PATH] [--enable-observability] [--replace-host-conflicts] [--dry-run] [--state-root PATH] [--json]
  agent-host tools status [--state-root PATH] [--json]
  agent-host tools set --tool COMPONENT [--tool COMPONENT] [--replace-host-conflicts] [--dry-run] [--state-root PATH] [--json]
  agent-host tools reset [--replace-host-conflicts] [--dry-run] [--state-root PATH] [--json]
  agent-host component preview --artifact PATH --license-spdx EXPRESSION [--workspace-root PATH] [--path-grant NAME=PATH] [--standalone | --state-root PATH] [--json]
  agent-host component import --artifact PATH --binding PATH [--activate] [--replace] [--workspace-root PATH] [--path-grant NAME=PATH] [--replace-host-conflicts] [--dry-run] [--state-root PATH] [--json]
  agent-host component list [--state-root PATH] [--json]
  agent-host component status COMPONENT [--state-root PATH] [--json]
  agent-host component remove COMPONENT [--replace-host-conflicts] [--dry-run] [--state-root PATH] [--json]
  agent-host component rollback COMPONENT [--workspace-root PATH] [--path-grant NAME=PATH] [--replace-host-conflicts] [--dry-run] [--state-root PATH] [--json]
  agent-host rollback [--workspace-root PATH] [--replace-host-conflicts] [--dry-run] [--state-root PATH] [--json]
  agent-host observability enable|disable|refresh|status [--state-root PATH] [--json]
  agent-host observability trace-sources --provider PROVIDER [--from-ms N] [--to-ms N] [--limit N] [--state-root PATH] [--json]
  agent-host observability export-trace --provider PROVIDER (--file PATH | --session HASH) --output PATH [--from-ms N] [--to-ms N] [--include-selected-content --confirm-sensitive-content] [--max-events N] [--max-output-bytes N] [--state-root PATH] [--json]
  agent-host observability adapters [--state-root PATH] [--json]
  agent-host observability adapter-plan --adapter ID [--state-root PATH] [--json]
  agent-host host add codex|claude|zcode [--workspace-root PATH] [--replace-host-conflicts] [--state-root PATH] [--json]
  agent-host host remove codex|claude|zcode [--state-root PATH] [--json]
  agent-host host status codex|claude|zcode [--quick] [--state-root PATH] [--json]
  agent-host service recover --recovery ID --manifest-sha256 SHA256 [--state-root PATH] [--json]
  agent-host uninstall [--purge-data] [--state-root PATH] [--json]`

const ROUTE_ARGUMENTS = Object.freeze({
  setup: ['--profile', '--host', '--tool', '--workspace-root', '--development-root', '--release-manifest', '--state-root', '--enable-observability', '--replace-host-conflicts', '--no-service', '--dry-run', '--json'],
  status: ['--state-root', '--json'],
  snapshot: ['--state-root', '--json'],
  catalog: ['--state-root', '--json'],
  activity: ['--state-root', '--json'],
  usage: ['--state-root', '--json'],
  manager: ['--state-root', '--no-open'],
  storage: ['--state-root', '--json'],
  cleanup: ['--state-root', '--dry-run', '--json'],
  doctor: ['--state-root', '--deep', '--skip-agent-apps', '--json'],
  update: ['--profile', '--tool', '--workspace-root', '--release-manifest', '--enable-observability', '--replace-host-conflicts', '--dry-run', '--state-root', '--json'],
  rollback: ['--workspace-root', '--replace-host-conflicts', '--dry-run', '--state-root', '--json'],
  uninstall: ['--purge-data', '--state-root', '--json'],
  maintenance: ['--state-root', '--json'],
  'tools status': ['--state-root', '--json'],
  'tools set': ['--tool', '--replace-host-conflicts', '--dry-run', '--state-root', '--json'],
  'tools reset': ['--replace-host-conflicts', '--dry-run', '--state-root', '--json'],
  'component preview': ['--artifact', '--license-spdx', '--workspace-root', '--path-grant', '--standalone', '--state-root', '--json'],
  'component import': ['--artifact', '--binding', '--activate', '--replace', '--workspace-root', '--path-grant', '--replace-host-conflicts', '--dry-run', '--state-root', '--json'],
  'component list': ['--state-root', '--json'],
  'component status': ['--state-root', '--json'],
  'component remove': ['--replace-host-conflicts', '--dry-run', '--state-root', '--json'],
  'component rollback': ['--workspace-root', '--path-grant', '--replace-host-conflicts', '--dry-run', '--state-root', '--json'],
  'observability enable': ['--state-root', '--json'],
  'observability disable': ['--state-root', '--json'],
  'observability refresh': ['--state-root', '--json'],
  'observability status': ['--state-root', '--json'],
  'observability trace-sources': ['--provider', '--from-ms', '--to-ms', '--limit', '--state-root', '--json'],
  'observability export-trace': ['--provider', '--file', '--session', '--output', '--from-ms', '--to-ms', '--max-events', '--max-output-bytes', '--include-selected-content', '--confirm-sensitive-content', '--state-root', '--json'],
  'observability adapters': ['--state-root', '--json'],
  'observability adapter-plan': ['--adapter', '--state-root', '--json'],
  'host add': ['--workspace-root', '--replace-host-conflicts', '--state-root', '--json'],
  'host remove': ['--state-root', '--json'],
  'host status': ['--state-root', '--quick', '--json'],
  'service recover': ['--recovery', '--manifest-sha256', '--state-root', '--json'],
})

function routeName(options) {
  return ['observability', 'host', 'tools', 'component', 'service'].includes(options.command)
    ? `${options.command} ${options.action ?? ''}`.trim()
    : options.command
}

function parseArgs(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) return { command: 'help', json: false }
  const options = {
    command: argv[0],
    action: ['observability', 'host', 'tools', 'component', 'service'].includes(argv[0]) ? argv[1] : undefined,
    target: argv[0] === 'host' ? argv[2] : undefined,
    profile: argv[0] === 'setup' ? 'standard' : undefined,
    hosts: [],
    tools: [],
    pathGrants: [],
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
    standalone: false,
    noOpen: false,
    includeSelectedContent: false,
    confirmSensitiveContent: false,
    adapter: undefined,
  }
  if (options.command === 'component' && ['status', 'remove', 'rollback'].includes(options.action) && argv[2] !== undefined && !argv[2].startsWith('--')) options.target = argv[2]
  const values = new Set(['--profile', '--host', '--tool', '--workspace-root', '--path-grant', '--development-root', '--release-manifest', '--state-root', '--artifact', '--binding', '--license-spdx', '--provider', '--file', '--session', '--output', '--from-ms', '--to-ms', '--limit', '--max-events', '--max-output-bytes', '--adapter', '--recovery', '--manifest-sha256'])
  const booleans = new Map([
    ['--json', 'json'], ['--deep', 'deep'], ['--dry-run', 'dryRun'], ['--no-service', 'noService'],
    ['--enable-observability', 'enableObservability'], ['--purge-data', 'purgeData'],
    ['--replace-host-conflicts', 'replaceHostConflicts'],
    ['--activate', 'activate'], ['--replace', 'replace'],
    ['--skip-agent-apps', 'skipAgentApps'], ['--quick', 'quick'], ['--standalone', 'standalone'], ['--no-open', 'noOpen'],
    ['--include-selected-content', 'includeSelectedContent'], ['--confirm-sensitive-content', 'confirmSensitiveContent'],
  ])
  const start = options.command === 'host' ? 3 : options.command === 'component' && options.target !== undefined ? 3 : ['observability', 'tools', 'component', 'service'].includes(options.command) ? 2 : 1
  if (['observability', 'host', 'tools', 'component', 'service'].includes(options.command) && options.action === undefined) throw new AgentHostError('CLI_USAGE', `${options.command} requires an action`)
  if (options.command === 'host' && options.target === undefined) throw new AgentHostError('CLI_USAGE', 'host requires codex, claude, or zcode')
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
      else if (arg === '--path-grant') options.pathGrants.push(value)
      else if (arg === '--development-root') options.developmentRoot = value
      else if (arg === '--release-manifest') options.releaseManifest = value
      else if (arg === '--state-root') options.stateRoot = value
      else if (arg === '--artifact') options.artifact = value
      else if (arg === '--binding') options.bindingPath = value
      else if (arg === '--license-spdx') options.licenseSpdx = value
      else if (arg === '--provider') options.provider = value
      else if (arg === '--adapter') options.adapter = value
      else if (arg === '--recovery') options.recovery = value
      else if (arg === '--manifest-sha256') options.manifestSha256 = value
      else if (arg === '--file') options.file = resolve(value)
      else if (arg === '--session') {
        if (!/^[a-f0-9]{64}$/u.test(value)) throw new AgentHostError('CLI_USAGE', '--session requires a 64-character lowercase hexadecimal hash')
        options.session = value
      }
      else if (arg === '--output') options.output = resolve(value)
      else if (arg === '--from-ms' || arg === '--to-ms') {
        const parsed = Number(value)
        if (!Number.isSafeInteger(parsed) || parsed < 0) throw new AgentHostError('CLI_USAGE', `${arg} must be a non-negative safe integer`)
        options[arg === '--from-ms' ? 'fromMs' : 'toMs'] = parsed
      } else if (arg === '--limit') {
        const parsed = Number(value)
        if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 500) throw new AgentHostError('CLI_USAGE', '--limit must be an integer from 1 to 500')
        options.limit = parsed
      }
      else if (arg === '--max-events') {
        const parsed = Number(value)
        if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 5_000) throw new AgentHostError('CLI_USAGE', '--max-events must be an integer from 1 to 5000')
        options.maxEvents = parsed
      } else if (arg === '--max-output-bytes') {
        const parsed = Number(value)
        if (!Number.isSafeInteger(parsed) || parsed < 4_096 || parsed > 64 * 1024 * 1024) throw new AgentHostError('CLI_USAGE', '--max-output-bytes must be an integer from 4096 to 67108864')
        options.maxOutputBytes = parsed
      }
      else options.profile = value
      continue
    }
    throw new AgentHostError('CLI_USAGE', `Unknown argument: ${arg}`)
  }
  if (options.tools.length === 0) options.tools = undefined
  if (route === 'observability trace-sources') {
    if (typeof options.provider !== 'string' || options.provider.length === 0) throw new AgentHostError('CLI_USAGE', 'observability trace-sources requires --provider')
  }
  if (route === 'observability export-trace') {
    if (typeof options.provider !== 'string' || typeof options.output !== 'string' || (typeof options.file === 'string') === (typeof options.session === 'string')) {
      throw new AgentHostError('CLI_USAGE', 'observability export-trace requires --provider, exactly one of --file or --session, and --output')
    }
    if (typeof options.file === 'string' && (options.fromMs !== undefined || options.toMs !== undefined)) {
      throw new AgentHostError('CLI_USAGE', '--from-ms and --to-ms require --session')
    }
  }
  if (options.fromMs !== undefined && options.toMs !== undefined && options.fromMs > options.toMs) {
    throw new AgentHostError('CLI_USAGE', '--from-ms must not be after --to-ms')
  }
  if (route === 'service recover') {
    if (!/^service-recovery-v2-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(options.recovery ?? '')) {
      throw new AgentHostError('CLI_USAGE', 'service recover requires a valid --recovery identity')
    }
    if (!/^sha256:[0-9a-f]{64}$/u.test(options.manifestSha256 ?? '')) {
      throw new AgentHostError('CLI_USAGE', 'service recover requires a valid --manifest-sha256 digest')
    }
  }
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
    `Cleanup · ${result.cleanup.packageVersions} package versions, ${result.cleanup.downloads} downloads, ${result.cleanup.runtimeConfigs ?? 0} runtime configs, ${formatBytes(result.cleanup.allocatedBytes)} eligible`,
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
  if (result.schemaVersion === 'openadam.skill-link-catalog.v0.2') {
    const counts = Object.groupBy(result.entries, (entry) => entry.kind)
    return `Host contract catalog · ${counts.capability?.length ?? 0} Capabilities · ${counts.procedure?.length ?? 0} Procedures · ${counts.tool?.length ?? 0} Tools`
  }
  if (result.schemaVersion === 'openadam.agent-host-usage.v0.1') {
    if (result.configured !== true) return 'Usage & Reliability · no Agent environment installed.'
    if (result.enabled !== true) return 'Usage & Reliability · local monitoring is off.'
    const calls = result.tools?.entries?.reduce((sum, item) => sum + (item.historicalCalls ?? 0), 0) ?? 0
    const sessions = result.providerActivity?.reduce((sum, item) => sum + (item.observedSessions ?? 0), 0) ?? 0
    return `Usage & Reliability · ${result.windowDays ?? 'unknown'} day window · ${calls} mapped tool calls · ${sessions} observed sessions`
  }
  if (result.schemaVersion === 'openadam.agent-shell-adapter-catalog.v0.1') {
    return `Trace adapters · ${result.adapters?.length ?? 0} available · no configuration changed`
  }
  if (result.schemaVersion === 'openadam.agent-shell-adapter-plan.v0.1') {
    return `Trace adapter plan · ${result.adapter?.provider ?? result.adapter?.id ?? 'unknown'} · no configuration changed`
  }
  if (result.schemaVersion === 'openadam.agent-host-trace-analysis-pack.v0.1') {
    const content = result.contentPolicy === 'selected-content' ? 'selected content included' : 'metadata only'
    return `Trace Analysis Pack · ${result.eventsReturned ?? 0} events · ${content}`
  }
  if (result.schemaVersion === 'openadam.agent-host-trace-analysis-pack.v0.2') {
    return `Trace Analysis Pack · ${result.eventsReturned ?? 0} retained metadata events · metadata only`
  }
  if (result.schemaVersion === 'openadam.agent-host-trace-source-catalog.v0.1') {
    return `Trace sessions · ${result.sources?.length ?? 0} retained ${result.provider ?? 'Agent'} sessions · completeness unknown`
  }
  if (result.schemaVersion === 'openadam.agent-host-service-recovery-result.v0.1') {
    const service = result.service
    return `Service restored · ${service.running === true ? 'running' : service.loaded === true ? 'loaded' : 'configured'} · ${service.ready === true ? 'ready' : 'not ready'}`
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
  const paths = await readStatePaths(resolveStateRoot(options.stateRoot))
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

async function run(options, dependencies = {}) {
  if (options.command === 'help') return { help: USAGE }
  if (options.command === 'setup') return setup(options)
  if (options.command === 'status') return status(options)
  if (options.command === 'snapshot') return operationsSnapshot(options)
  if (options.command === 'catalog') return exportSkillLinkCatalog(options)
  if (options.command === 'activity') {
    const paths = await readStatePaths(resolveStateRoot(options.stateRoot))
    return { status: 'ok', entries: await listActivity(paths) }
  }
  if (options.command === 'usage') return usageSummary(options)
  if (options.command === 'manager') return startWebManager({ stateRoot: options.stateRoot, open: !options.noOpen })
  if (options.command === 'storage') return storageStatus(options)
  if (options.command === 'cleanup') return cleanupStorage(options)
  if (options.command === 'component') {
    if (options.action === 'preview') {
      if (options.artifact === undefined || options.licenseSpdx === undefined) throw new AgentHostError('CLI_USAGE', 'component preview requires --artifact and --license-spdx')
      if (options.standalone === true && options.stateRoot !== undefined) throw new AgentHostError('CLI_USAGE', 'component preview cannot combine --standalone with --state-root')
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
    if (options.action === 'trace-sources') return observabilityTraceSources(options)
    if (options.action === 'export-trace') return exportObservabilityTrace(options)
    if (options.action === 'adapters') return observabilityAdapters(options)
    if (options.action === 'adapter-plan') return observabilityAdapterPlan(options)
    throw new AgentHostError('CLI_USAGE', `Unknown observability action: ${options.action}`)
  }
  if (options.command === 'maintenance') return maintenance(options)
  if (options.command === 'host') {
    if (options.action === 'add') return addHost(options)
    if (options.action === 'remove') return removeHost(options)
    if (options.action === 'status') return hostStatus(options)
    throw new AgentHostError('CLI_USAGE', `Unknown host action: ${options.action}`)
  }
  if (options.command === 'service') {
    if (options.action === 'recover') return recoverServiceInstallation(options, dependencies)
    throw new AgentHostError('CLI_USAGE', `Unknown service action: ${options.action}`)
  }
  if (options.command === 'uninstall') return uninstallInstallation(options)
  if (options.command === 'doctor') {
    const paths = await readStatePaths(resolveStateRoot(options.stateRoot))
    const state = await loadState(paths)
    if (state === null) throw new AgentHostError('NOT_INSTALLED', 'No Agent environment is installed')
    const contextAnalysis = state.observability?.enabled === true
      ? await readJson(join(paths.context, 'managed-catalog.analysis.json')).catch(() => null)
      : null
    return doctor(state, { deep: options.deep, inspectAgentApps: !options.skipAgentApps, contextAnalysis, stateRoot: paths.root })
  }
  throw new AgentHostError('CLI_USAGE', `Unknown command: ${options.command}`)
}

function recoveryInstruction(publicError) {
  const action = publicError?.details?.recovery?.action
  if (!['SERVICE_INSTALL_ROLLBACK_FAILED', 'SERVICE_RECOVERY_FAILED'].includes(publicError?.code)
    || action?.command !== 'agent-host'
    || !Array.isArray(action.arguments)
    || action.arguments.length !== 6
    || action.arguments[0] !== 'service'
    || action.arguments[1] !== 'recover'
    || action.arguments[2] !== '--recovery'
    || !/^service-recovery-v2-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(action.arguments[3])
    || action.arguments[4] !== '--manifest-sha256'
    || !/^sha256:[0-9a-f]{64}$/u.test(action.arguments[5])) return null
  return [action.command, ...action.arguments].join(' ')
}

export async function main(argv, dependencies = {}) {
  let options = { json: argv.includes('--json') }
  try {
    options = parseArgs(argv)
    const result = await run(options, dependencies)
    if (result.help !== undefined) process.stdout.write(`${result.help}\n`)
    else process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `${human(result)}\n`)
    return result.status === 'error' ? 1 : 0
  } catch (error) {
    const publicError = asPublicError(error)
    const envelope = { status: 'error', error: publicError }
    if (options.json) process.stderr.write(`${JSON.stringify(envelope)}\n`)
    else {
      const instruction = recoveryInstruction(publicError)
      process.stderr.write(`${publicError.code}: ${publicError.message}${instruction === null ? '' : `\nRecovery: ${instruction}`}\n`)
    }
    return publicError.code === 'CLI_USAGE' ? 2 : 1
  }
}
