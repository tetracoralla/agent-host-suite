import { homedir } from 'node:os'
import { dirname, parse } from 'node:path'
import { rm } from 'node:fs/promises'
import { buildDevelopmentManifest, buildDevelopmentObservabilityManifest, fingerprintIdentityFiles } from './development-manifest.mjs'
import { AgentHostError } from './errors.mjs'
import { installCodex, uninstallCodex } from './hosts/codex.mjs'
import { installClaude, uninstallClaude } from './hosts/claude.mjs'
import { readJson } from './json.mjs'
import { resolveStateRoot } from './paths.mjs'
import { runFile } from './process.mjs'
import { installService, uninstallService } from './service.mjs'
import { archiveAndRemoveState, listHistory, loadState, prepareStatePaths, saveState } from './state.mjs'
import { writeRuntimeFiles } from './runtime-config.mjs'
import { rebindObservabilityState, teardownObservability } from './observability.mjs'

function mergeHostOwnership(previous, next) {
  if (previous === undefined) return next
  if (next.kind === 'codex') {
    return {
      ...next,
      entries: next.entries.map((entry) => {
        const old = previous.entries.find((item) => item.selector === entry.selector)
        return {
          ...entry,
          marketplaceCreated: entry.marketplaceCreated || old?.marketplaceCreated === true,
          pluginCreated: entry.pluginCreated || old?.pluginCreated === true,
          displacedPlugins: [...new Map([...(old?.displacedPlugins ?? []), ...(entry.displacedPlugins ?? [])].map((item) => [item.selector, item])).values()],
        }
      }),
    }
  }
  return {
    ...next,
    entries: next.entries.map((entry) => {
      const old = previous.entries.find((item) => item.name === entry.name)
      return { ...entry, created: entry.created || old?.created === true }
    }),
  }
}

async function installHost(id, manifest, previous, runner, options) {
  if (id === 'codex') return mergeHostOwnership(previous, await installCodex(manifest, runner, { replaceConflicts: options.replaceHostConflicts, managedState: previous }))
  return mergeHostOwnership(previous, await installClaude(manifest, runner, previous, { replaceConflicts: options.replaceHostConflicts }))
}

async function uninstallHost(id, state, runner) {
  if (id === 'codex') return uninstallCodex(state, runner)
  return uninstallClaude(state, runner)
}

export async function addHost(options, dependencies = {}) {
  const runner = dependencies.runner ?? runFile
  const paths = await prepareStatePaths(resolveStateRoot(options.stateRoot))
  const state = await loadState(paths)
  if (state === null) throw new AgentHostError('NOT_INSTALLED', 'Agent Host Suite is not configured')
  if (!['codex', 'claude'].includes(options.target)) throw new AgentHostError('HOST_UNSUPPORTED', `Unsupported host: ${options.target}`)
  if (state.hosts[options.target] !== undefined) return { status: 'host-present', host: options.target, changed: false }
  const installed = await installHost(options.target, { components: state.components }, undefined, runner, options)
  state.hosts[options.target] = installed
  state.updatedAt = new Date().toISOString()
  await saveState(paths, state, { retainCurrent: true })
  return { status: 'host-added', host: options.target, changed: true, restartRequired: true, binding: installed }
}

export async function removeHost(options, dependencies = {}) {
  const runner = dependencies.runner ?? runFile
  const paths = await prepareStatePaths(resolveStateRoot(options.stateRoot))
  const state = await loadState(paths)
  if (state === null) throw new AgentHostError('NOT_INSTALLED', 'Agent Host Suite is not configured')
  if (!['codex', 'claude'].includes(options.target)) throw new AgentHostError('HOST_UNSUPPORTED', `Unsupported host: ${options.target}`)
  if (state.hosts[options.target] === undefined) return { status: 'host-absent', host: options.target, changed: false }
  const removed = await uninstallHost(options.target, state.hosts[options.target], runner)
  delete state.hosts[options.target]
  state.updatedAt = new Date().toISOString()
  await saveState(paths, state, { retainCurrent: true })
  return { status: 'host-removed', host: options.target, changed: true, removed }
}

export async function hostStatus(options, dependencies = {}) {
  const runner = dependencies.runner ?? runFile
  const paths = await prepareStatePaths(resolveStateRoot(options.stateRoot))
  const state = await loadState(paths)
  if (state === null) return { status: 'ok', configured: false, host: options.target }
  const managed = state.hosts[options.target]
  if (managed === undefined) return { status: 'ok', configured: true, host: options.target, installed: false }
  try {
    const inspection = options.target === 'codex'
      ? await (await import('./hosts/codex.mjs')).inspectCodex({ components: state.components }, runner, { managedState: managed })
      : await (await import('./hosts/claude.mjs')).inspectClaude({ components: state.components }, runner, managed)
    return { status: 'ok', configured: true, host: options.target, installed: true, healthy: true, inspection }
  } catch (error) {
    return { status: 'error', configured: true, host: options.target, installed: true, healthy: false, error: { code: error.code ?? 'HOST_INSPECTION_FAILED', message: error.message } }
  }
}

async function activateState(paths, previous, manifest, runner, options) {
  const runtimeFiles = await writeRuntimeFiles(paths, manifest)
  const hosts = {}
  for (const id of Object.keys(previous.hosts)) hosts[id] = await installHost(id, manifest, previous.hosts[id], runner, options)
  const installedService = previous.runtime.service === null
    ? null
    : await installService(manifest.components['direct-execution-runtime'], runtimeFiles, runner, previous.runtime.service)
  const service = installedService === null ? null : { ...installedService, created: previous.runtime.service.created }
  return { hosts, runtime: { ...runtimeFiles, service } }
}

export async function updateInstallation(options, dependencies = {}) {
  const runner = dependencies.runner ?? runFile
  const paths = await prepareStatePaths(resolveStateRoot(options.stateRoot))
  const previous = await loadState(paths)
  if (previous === null) throw new AgentHostError('NOT_INSTALLED', 'Agent Host Suite is not configured')
  if (previous.channel !== 'development') throw new AgentHostError('UPDATE_CHANNEL_UNSUPPORTED', `Unsupported update channel: ${previous.channel}`)
  const manifest = await buildDevelopmentManifest(previous.developmentRoot)
  if (previous.observability?.enabled === true) {
    manifest.components = { ...manifest.components, ...await buildDevelopmentObservabilityManifest(previous.developmentRoot) }
  }
  const changed = Object.entries(manifest.components).filter(([id, component]) => component.fingerprint !== previous.components[id]?.fingerprint).map(([id]) => id)
  if (options.dryRun) return { status: 'ready', dryRun: true, changed }
  let activated
  try {
    activated = await activateState(paths, previous, manifest, runner, options)
  } catch (error) {
    await writeRuntimeFiles(paths, { components: previous.components }).catch(() => {})
    throw error
  }
  const next = {
    ...previous,
    suiteVersion: manifest.suiteVersion,
    components: manifest.components,
    hosts: activated.hosts,
    runtime: activated.runtime,
    updatedAt: new Date().toISOString(),
  }
  if (next.observability?.enabled === true) await rebindObservabilityState(next, paths, runner)
  await saveState(paths, next, { retainCurrent: true })
  return { status: 'updated', changed, restartRequired: Object.keys(next.hosts).length > 0 }
}

async function verifyStateBytes(state) {
  const mismatches = []
  for (const [id, component] of Object.entries(state.components)) {
    const current = await fingerprintIdentityFiles(component.identityFiles)
    if (current !== component.fingerprint) mismatches.push(id)
  }
  return mismatches
}

export async function rollbackInstallation(options, dependencies = {}) {
  const runner = dependencies.runner ?? runFile
  const paths = await prepareStatePaths(resolveStateRoot(options.stateRoot))
  const current = await loadState(paths)
  if (current === null) throw new AgentHostError('NOT_INSTALLED', 'Agent Host Suite is not configured')
  const history = await listHistory(paths)
  const targetPath = history.find((path) => !path.includes('-uninstalled-'))
  if (targetPath === undefined) throw new AgentHostError('ROLLBACK_UNAVAILABLE', 'No previous complete compatibility set is retained')
  const target = await readJson(targetPath)
  const mismatches = await verifyStateBytes(target)
  if (mismatches.length > 0) {
    throw new AgentHostError('ROLLBACK_BYTES_UNAVAILABLE', 'The previous development bytes are no longer present', { components: mismatches })
  }
  if (options.dryRun) return { status: 'ready', dryRun: true, targetVersion: target.suiteVersion }
  let observabilityTeardown = null
  if (current.observability?.enabled === true && target.observability?.enabled !== true) {
    observabilityTeardown = await teardownObservability(current, paths, runner)
  }
  const activated = await activateState(paths, current, { components: target.components }, runner, options)
  const restored = {
    ...target,
    hosts: activated.hosts,
    runtime: activated.runtime,
    updatedAt: new Date().toISOString(),
    rolledBackFrom: current.suiteVersion,
  }
  if (restored.observability?.enabled === true) await rebindObservabilityState(restored, paths, runner)
  await saveState(paths, restored, { retainCurrent: true })
  return { status: 'rolled-back', suiteVersion: restored.suiteVersion, restartRequired: true, observabilityTeardown }
}

function safePurgeRoot(root) {
  const parsed = parse(root)
  if (root === parsed.root || root === homedir() || dirname(root) === root) return false
  return root.split(parsed.root).join('').split('/').filter(Boolean).length >= 3
}

export async function uninstallInstallation(options, dependencies = {}) {
  const runner = dependencies.runner ?? runFile
  const root = resolveStateRoot(options.stateRoot)
  const paths = await prepareStatePaths(root)
  const state = await loadState(paths)
  if (state === null) return { status: 'not-installed' }
  const results = {
    observability: await teardownObservability(state, paths, runner),
    service: await uninstallService(state.runtime.service, runner),
    hosts: {},
  }
  for (const [id, host] of Object.entries(state.hosts).reverse()) results.hosts[id] = await uninstallHost(id, host, runner)
  const archive = await archiveAndRemoveState(paths, state)
  if (options.purgeData) {
    if (!safePurgeRoot(root)) throw new AgentHostError('PURGE_ROOT_UNSAFE', `Refusing to recursively remove unsafe state root: ${root}`)
    await rm(root, { recursive: true, force: false })
  }
  return { status: 'uninstalled', purgeData: options.purgeData, archive: options.purgeData ? null : archive, results }
}
