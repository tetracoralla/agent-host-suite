import { doctor } from './doctor.mjs'
import { asPublicError, AgentHostError } from './errors.mjs'
import { addHost, hostStatus, removeHost, rollbackInstallation, uninstallInstallation, updateInstallation } from './lifecycle.mjs'
import { disableObservability, enableObservability, maintenance, observabilityStatus, observabilitySummary, refreshObservability } from './observability.mjs'
import { resolveStateRoot } from './paths.mjs'
import { loadState, prepareStatePaths } from './state.mjs'
import { setup } from './setup.mjs'
import { listActivity } from './activity.mjs'

const USAGE = `Usage:
  agent-host setup [--profile standard|observability|local-dogfood] [--host codex|claude] [--release-manifest PATH | --development-root PATH] [--enable-observability] [--no-service] [--dry-run] [--json]
  agent-host status [--state-root PATH] [--json]
  agent-host activity [--state-root PATH] [--json]
  agent-host doctor [--deep] [--state-root PATH] [--json]
  agent-host update [--profile standard|observability|local-dogfood] [--replace-host-conflicts] [--dry-run] [--state-root PATH] [--json]
  agent-host rollback [--dry-run] [--state-root PATH] [--json]
  agent-host observability enable|disable|refresh|status [--state-root PATH] [--json]
  agent-host host add|remove|status codex|claude [--state-root PATH] [--json]
  agent-host uninstall [--purge-data] [--state-root PATH] [--json]`

function parseArgs(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) return { command: 'help', json: false }
  const options = {
    command: argv[0],
    action: ['observability', 'host'].includes(argv[0]) ? argv[1] : undefined,
    target: argv[0] === 'host' ? argv[2] : undefined,
    profile: argv[0] === 'setup' ? 'standard' : undefined,
    hosts: [],
    json: false,
    deep: false,
    dryRun: false,
    noService: false,
    enableObservability: false,
    purgeData: false,
    replaceHostConflicts: false,
  }
  const values = new Set(['--profile', '--host', '--development-root', '--release-manifest', '--state-root'])
  const booleans = new Map([
    ['--json', 'json'], ['--deep', 'deep'], ['--dry-run', 'dryRun'], ['--no-service', 'noService'],
    ['--enable-observability', 'enableObservability'], ['--purge-data', 'purgeData'],
    ['--replace-host-conflicts', 'replaceHostConflicts'],
  ])
  const start = options.command === 'host' ? 3 : options.command === 'observability' ? 2 : 1
  if (['observability', 'host'].includes(options.command) && options.action === undefined) throw new AgentHostError('CLI_USAGE', `${options.command} requires an action`)
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
      else if (arg === '--development-root') options.developmentRoot = value
      else if (arg === '--release-manifest') options.releaseManifest = value
      else if (arg === '--state-root') options.stateRoot = value
      else options.profile = value
      continue
    }
    throw new AgentHostError('CLI_USAGE', `Unknown argument: ${arg}`)
  }
  return options
}

function human(result) {
  if (result.status === 'ok' && Array.isArray(result.checks)) {
    return [`Doctor: ${result.status}`, ...result.checks.map((item) => `${item.status === 'ok' ? '✓' : '✗'} ${item.message}`)].join('\n')
  }
  if (result.host !== undefined && result.appInstalled !== undefined) {
    if (!result.appInstalled) return `${result.host} is not installed.`
    if (result.managed !== true) return `${result.host} is installed but not connected to Agent Host.`
    return `${result.host} ${result.healthy === true ? 'is ready' : 'needs attention'}.`
  }
  if (result.configured === false) return 'No Agent environment is installed.'
  if (result.configured === true) return `Agent Host ${result.suiteVersion} · ${result.profile} · ${Object.keys(result.hosts).join(', ') || 'no connected Agent app'}`
  if (result.status === 'enabled') return 'Observability enabled · local metadata collection is active.'
  if (result.status === 'disabled') return `Observability disabled · local data ${result.results?.dataPreserved === false ? 'removed' : 'preserved'}.`
  if (result.status === 'refreshed') return 'Observability refreshed.'
  return `${result.status}${result.restartRequired ? ' · start a fresh Agent session' : ''}`
}

async function status(options) {
  const paths = await prepareStatePaths(resolveStateRoot(options.stateRoot))
  const state = await loadState(paths)
  if (state === null) return { status: 'ok', configured: false, stateRoot: paths.root }
  return {
    status: 'ok', configured: true, stateRoot: paths.root, suiteVersion: state.suiteVersion,
    channel: state.channel, profile: state.profile,
    installedAt: state.installedAt, updatedAt: state.updatedAt,
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
    service: state.runtime.service, observability: observabilitySummary(state.observability),
  }
}

async function run(options) {
  if (options.command === 'help') return { help: USAGE }
  if (options.command === 'setup') return setup(options)
  if (options.command === 'status') return status(options)
  if (options.command === 'activity') {
    const paths = await prepareStatePaths(resolveStateRoot(options.stateRoot))
    return { status: 'ok', entries: await listActivity(paths) }
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
    return doctor(state, { deep: options.deep })
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
