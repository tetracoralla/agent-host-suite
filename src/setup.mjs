import { buildDevelopmentManifest } from './development-manifest.mjs'
import { AgentHostError } from './errors.mjs'
import { inspectCodex, installCodex, uninstallCodex } from './hosts/codex.mjs'
import { inspectClaude, installClaude, uninstallClaude } from './hosts/claude.mjs'
import { resolveStateRoot } from './paths.mjs'
import { runFile } from './process.mjs'
import { installService, inspectService, uninstallService } from './service.mjs'
import { prepareStatePaths, loadState, saveState, STATE_SCHEMA } from './state.mjs'
import { writeRuntimeFiles } from './runtime-config.mjs'
import { enableObservability } from './observability.mjs'

const HOSTS = new Set(['codex', 'claude'])

function selectedHosts(hosts) {
  const values = hosts.length === 0 ? ['codex'] : hosts.flatMap((value) => value.split(',')).filter(Boolean)
  for (const host of values) if (!HOSTS.has(host)) throw new AgentHostError('HOST_UNSUPPORTED', `Unsupported host: ${host}`)
  return [...new Set(values)]
}

async function inspectHost(host, manifest, runner, options) {
  if (host === 'codex') return inspectCodex(manifest, runner, { replaceConflicts: options.replaceHostConflicts })
  return inspectClaude(manifest, runner)
}

async function installHost(host, manifest, runner, options) {
  if (host === 'codex') return installCodex(manifest, runner, { replaceConflicts: options.replaceHostConflicts })
  return installClaude(manifest, runner, null, { replaceConflicts: options.replaceHostConflicts })
}

async function uninstallHost(host, state, runner) {
  if (host === 'codex') return uninstallCodex(state, runner)
  return uninstallClaude(state, runner)
}

export async function setup(options, dependencies = {}) {
  const runner = dependencies.runner ?? runFile
  if (options.profile !== 'standard' && options.profile !== 'observability') {
    throw new AgentHostError('PROFILE_UNKNOWN', `Unknown profile: ${options.profile}`)
  }
  if (options.profile === 'observability' && !options.enableObservability) {
    throw new AgentHostError('OBSERVABILITY_CONSENT_REQUIRED', 'The observability profile requires --enable-observability')
  }
  if (options.developmentRoot === undefined) {
    throw new AgentHostError('RELEASE_UNBOUND', 'No published compatibility release is bound yet; use an explicit --development-root')
  }
  const manifest = await buildDevelopmentManifest(options.developmentRoot)
  const hosts = selectedHosts(options.hosts)
  const preflight = {}
  for (const host of hosts) preflight[host] = await inspectHost(host, manifest, runner, options)
  if (options.dryRun) {
    return { status: 'ready', dryRun: true, profile: options.profile, hosts: preflight, components: manifest.components }
  }

  const paths = await prepareStatePaths(resolveStateRoot(options.stateRoot))
  if (await loadState(paths) !== null) throw new AgentHostError('ALREADY_INSTALLED', 'Agent Host Suite is already configured; use update')
  const runtimeFiles = await writeRuntimeFiles(paths, manifest)
  const installedHosts = {}
  let serviceState = null
  try {
    for (const host of hosts) installedHosts[host] = await installHost(host, manifest, runner, options)
    if (!options.noService) {
      serviceState = await installService(manifest.components['direct-execution-runtime'], runtimeFiles, runner)
    }
    const now = new Date().toISOString()
    const state = {
      schemaVersion: STATE_SCHEMA,
      suiteVersion: manifest.suiteVersion,
      channel: manifest.channel,
      profile: 'standard',
      installedAt: now,
      updatedAt: now,
      developmentRoot: manifest.developmentRoot,
      components: manifest.components,
      hosts: installedHosts,
      runtime: { ...runtimeFiles, service: serviceState },
      observability: { enabled: false },
    }
    await saveState(paths, state)
    if (options.profile === 'observability') {
      const enabled = await enableObservability({ stateRoot: paths.root }, { runner })
      return { status: 'installed', stateRoot: paths.root, profile: enabled.profile, hosts: Object.keys(installedHosts), service: serviceState, observability: enabled.observability, restartRequired: hosts.length > 0 }
    }
    return { status: 'installed', stateRoot: paths.root, profile: state.profile, hosts: Object.keys(installedHosts), service: serviceState, restartRequired: hosts.length > 0 }
  } catch (error) {
    if (serviceState !== null) await uninstallService(serviceState, runner).catch(() => {})
    for (const [host, state] of Object.entries(installedHosts).reverse()) {
      await uninstallHost(host, state, runner).catch(() => {})
    }
    if (paths !== undefined) {
      const { rm } = await import('node:fs/promises')
      await rm(paths.state, { force: true }).catch(() => {})
    }
    throw error
  }
}

export async function servicePreflight(state, runner = runFile) {
  return inspectService(state.runtime.service, runner)
}
