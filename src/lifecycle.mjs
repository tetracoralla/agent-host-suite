import { homedir } from 'node:os'
import { dirname, parse } from 'node:path'
import { rm } from 'node:fs/promises'
import { buildDevelopmentManifest, buildDevelopmentObservabilityManifest, fingerprintIdentityFiles } from './development-manifest.mjs'
import { AgentHostError } from './errors.mjs'
import { inspectCodex, installCodex, uninstallCodex } from './hosts/codex.mjs'
import { inspectClaude, installClaude, uninstallClaude } from './hosts/claude.mjs'
import { readJson } from './json.mjs'
import { resolveStateRoot } from './paths.mjs'
import { resolveExecutable, runFile } from './process.mjs'
import { inspectService, installService, uninstallService } from './service.mjs'
import { archiveAndRemoveState, listHistory, loadState, prepareStatePaths, saveState } from './state.mjs'
import { cleanupRuntimeSocket, writeRuntimeFiles } from './runtime-config.mjs'
import { rebindObservabilityState, teardownObservability } from './observability.mjs'
import { recordActivity } from './activity.mjs'
import { cleanupMaterializedRelease, discardMaterializedDownloads, materializeRelease, verifyReleaseComponent } from './release-artifacts.mjs'
import { loadReleaseManifest, OBSERVABILITY_RELEASE_COMPONENTS } from './release-manifest.mjs'
import { loadProfile } from './profile.mjs'

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
          displacedMarketplace: old?.displacedMarketplace ?? (old?.marketplaceCreated === true ? null : entry.displacedMarketplace ?? null),
          restorePlugin: old?.restorePlugin === true || (old?.pluginCreated !== true && entry.restorePlugin === true),
          displacedPlugins: [...new Map([...(old?.displacedPlugins ?? []), ...(entry.displacedPlugins ?? [])].map((item) => [item.selector, item])).values()],
        }
      }),
    }
  }
  return {
    ...next,
    entries: next.entries.map((entry) => {
      const old = previous.entries.find((item) => item.name === entry.name)
      return {
        ...entry,
        created: entry.created || old?.created === true,
        displaced: old?.displaced ?? entry.displaced ?? null,
      }
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

function activationRollbackState(id, next, previous) {
  if (id !== 'codex' || previous === undefined) return next
  return {
    ...next,
    entries: next.entries.map((entry) => {
      const target = previous.entries.find((item) => item.selector === entry.selector)
      if (target === undefined) return entry
      return {
        ...entry,
        displacedMarketplace: target.marketplaceRoot,
        restorePlugin: true,
        displacedPlugins: [],
      }
    }),
  }
}

export function hostStateOutsideManifest(id, current, manifest) {
  if (id !== 'codex') return null
  const desired = new Set(Object.values(manifest.components)
    .filter((component) => component.plugin !== undefined)
    .map((component) => `${component.plugin}@${component.marketplace}`))
  const entries = current.entries.filter((entry) => !desired.has(entry.selector))
  return entries.length === 0 ? null : { ...current, entries }
}

export async function addHost(options, dependencies = {}) {
  const runner = dependencies.runner ?? runFile
  const paths = await prepareStatePaths(resolveStateRoot(options.stateRoot))
  const state = await loadState(paths)
  if (state === null) throw new AgentHostError('NOT_INSTALLED', 'No Agent environment is installed')
  if (!['codex', 'claude'].includes(options.target)) throw new AgentHostError('HOST_UNSUPPORTED', `Unsupported host: ${options.target}`)
  if (state.hosts[options.target] !== undefined) return { status: 'host-present', host: options.target, changed: false }
  const installed = await installHost(options.target, { components: state.components }, undefined, runner, options)
  state.hosts[options.target] = installed
  state.updatedAt = new Date().toISOString()
  await saveState(paths, state, { retainCurrent: true })
  await recordActivity(paths, 'agent-app.added', `${options.target === 'codex' ? 'Codex' : 'Claude Code'} connected`, { host: options.target })
  return { status: 'host-added', host: options.target, changed: true, restartRequired: true, binding: installed }
}

export async function removeHost(options, dependencies = {}) {
  const runner = dependencies.runner ?? runFile
  const paths = await prepareStatePaths(resolveStateRoot(options.stateRoot))
  const state = await loadState(paths)
  if (state === null) throw new AgentHostError('NOT_INSTALLED', 'No Agent environment is installed')
  if (!['codex', 'claude'].includes(options.target)) throw new AgentHostError('HOST_UNSUPPORTED', `Unsupported host: ${options.target}`)
  if (state.hosts[options.target] === undefined) return { status: 'host-absent', host: options.target, changed: false }
  const removed = await uninstallHost(options.target, state.hosts[options.target], runner)
  delete state.hosts[options.target]
  state.updatedAt = new Date().toISOString()
  await saveState(paths, state, { retainCurrent: true })
  await recordActivity(paths, 'agent-app.removed', `${options.target === 'codex' ? 'Codex' : 'Claude Code'} disconnected`, { host: options.target })
  return { status: 'host-removed', host: options.target, changed: true, removed }
}

export async function hostStatus(options, dependencies = {}) {
  const runner = dependencies.runner ?? runFile
  const paths = await prepareStatePaths(resolveStateRoot(options.stateRoot))
  const state = await loadState(paths)
  if (!['codex', 'claude'].includes(options.target)) throw new AgentHostError('HOST_UNSUPPORTED', `Unsupported host: ${options.target}`)
  const executable = await resolveExecutable(options.target, runner)
  let version = null
  if (executable !== null) {
    const versionResult = await runner(executable, ['--version'], { allowFailure: true, timeoutMs: 5_000 })
    if (versionResult.status === 0) version = versionResult.stdout.trim()
  }
  if (state === null) return { status: 'ok', configured: false, host: options.target, appInstalled: executable !== null, managed: false, version }
  const managed = state.hosts[options.target]
  if (managed === undefined) return { status: 'ok', configured: true, host: options.target, appInstalled: executable !== null, managed: false, installed: false, version }
  try {
    const inspection = options.target === 'codex'
      ? await (await import('./hosts/codex.mjs')).inspectCodex({ components: state.components }, runner, { managedState: managed })
      : await (await import('./hosts/claude.mjs')).inspectClaude({ components: state.components }, runner, managed)
    const healthy = options.target === 'codex'
      ? inspection.entries.every((entry) => entry.pluginPresent && entry.pluginEnabled && entry.installedVersion === entry.requestedVersion && entry.installedIdentityMatched)
      : inspection.entries.every((entry) => entry.present && entry.identityMatched)
    return {
      status: healthy ? 'ok' : 'error',
      configured: true,
      host: options.target,
      appInstalled: true,
      managed: true,
      installed: true,
      healthy,
      version: inspection.version,
      inspection,
    }
  } catch (error) {
    return { status: 'error', configured: true, host: options.target, appInstalled: executable !== null, managed: true, installed: true, healthy: false, version, error: { code: error.code ?? 'HOST_INSPECTION_FAILED', message: error.message } }
  }
}

async function activateState(paths, previous, manifest, runner, options) {
  const runtimeFiles = await writeRuntimeFiles(paths, manifest)
  const hosts = {}
  for (const id of Object.keys(previous.hosts)) {
    const obsolete = hostStateOutsideManifest(id, previous.hosts[id], manifest)
    if (obsolete !== null) await uninstallHost(id, obsolete, runner)
    hosts[id] = await installHost(id, manifest, previous.hosts[id], runner, options)
  }
  const installedService = previous.runtime.service === null
    ? null
    : await installService(manifest.components['direct-execution-runtime'], runtimeFiles, runner, previous.runtime.service)
  const service = installedService === null ? null : { ...installedService, created: previous.runtime.service.created }
  return { hosts, runtime: { ...runtimeFiles, service } }
}

async function inspectActivation(previous, manifest, runner, options) {
  const hosts = {}
  for (const [id, managed] of Object.entries(previous.hosts)) {
    hosts[id] = id === 'codex'
      ? await inspectCodex(manifest, runner, { managedState: managed, replaceConflicts: options.replaceHostConflicts })
      : await inspectClaude(manifest, runner, managed, { replaceConflicts: options.replaceHostConflicts })
  }
  return {
    hosts,
    service: await inspectService(
      previous.runtime.service === null ? null : { ...previous.runtime.service, socketPath: previous.runtime.socketPath },
      runner,
    ),
  }
}

export async function updateInstallation(options, dependencies = {}) {
  const runner = dependencies.runner ?? runFile
  const paths = await prepareStatePaths(resolveStateRoot(options.stateRoot))
  const previous = await loadState(paths)
  if (previous === null) throw new AgentHostError('NOT_INSTALLED', 'No Agent environment is installed')
  const profile = await loadProfile(options.profile ?? previous.profile)
  if (profile.requiresConsent && previous.observability?.enabled !== true) {
    throw new AgentHostError('OBSERVABILITY_CONSENT_REQUIRED', `Enable local monitoring before selecting the ${profile.displayName} tool set`)
  }
  let releasePreparation = null
  let manifest
  if (options.releaseManifest !== undefined || previous.channel === 'release') {
    const release = await loadReleaseManifest(options.releaseManifest)
    if (release.manifest.status === 'draft-unbound') throw new AgentHostError('RELEASE_UNBOUND', 'No verified compatibility release is bound in this build')
    releasePreparation = await materializeRelease(release, paths, { runner: dependencies.artifactRunner ?? runFile, componentIds: profile.components })
    manifest = releasePreparation.manifest
  } else if (previous.channel === 'development') {
    manifest = await buildDevelopmentManifest(previous.developmentRoot)
    if (previous.observability?.enabled === true) {
      manifest.components = { ...manifest.components, ...await buildDevelopmentObservabilityManifest(previous.developmentRoot) }
    }
  } else {
    throw new AgentHostError('UPDATE_CHANNEL_UNSUPPORTED', `Unsupported update channel: ${previous.channel}`)
  }
  if (previous.observability?.enabled === true) {
    const missing = OBSERVABILITY_RELEASE_COMPONENTS.filter((id) => manifest.components[id] === undefined)
    if (missing.length > 0) {
      await cleanupMaterializedRelease(releasePreparation)
      throw new AgentHostError('OBSERVABILITY_RELEASE_COMPONENTS_MISSING', 'The selected release cannot preserve local monitoring', { components: missing })
    }
  }
  const changed = [...new Set([
    ...Object.entries(manifest.components).filter(([id, component]) => component.fingerprint !== previous.components[id]?.fingerprint).map(([id]) => id),
    ...Object.keys(previous.components).filter((id) => manifest.components[id] === undefined),
  ])]
  if (options.dryRun) {
    try {
      const activation = await inspectActivation(previous, manifest, runner, options)
      return {
        status: 'ready',
        dryRun: true,
        fromChannel: previous.channel,
        toChannel: manifest.channel,
        releaseId: manifest.releaseId ?? null,
        profile: profile.id,
        profileDisplayName: profile.displayName,
        changed,
        activation,
      }
    } finally {
      await cleanupMaterializedRelease(releasePreparation)
    }
  }
  const rebind = dependencies.rebindObservability ?? rebindObservabilityState
  let next = null
  try {
    const activated = await activateState(paths, previous, manifest, runner, options)
    const { developmentRoot: _developmentRoot, releaseId: _releaseId, releaseManifest: _releaseManifest, ...previousBase } = previous
    const base = structuredClone(previousBase)
    next = {
      ...base,
      suiteVersion: manifest.suiteVersion,
      channel: manifest.channel,
      profile: profile.id,
      components: manifest.components,
      hosts: activated.hosts,
      runtime: activated.runtime,
      updatedAt: new Date().toISOString(),
      ...(manifest.developmentRoot === undefined ? {} : { developmentRoot: manifest.developmentRoot }),
      ...(releasePreparation === null ? {} : { releaseId: manifest.releaseId, releaseManifest: releasePreparation.release }),
    }
    if (next.observability?.enabled === true) await rebind(next, paths, runner)
  } catch (error) {
    let rollbackError = null
    try {
      if (next !== null) {
        await uninstallService(next.runtime.service, runner)
        for (const [id, state] of Object.entries(next.hosts).reverse()) {
          await uninstallHost(id, activationRollbackState(id, state, previous.hosts[id]), runner)
        }
      }
      await activateState(paths, previous, { components: previous.components }, runner, options)
      if (previous.observability?.enabled === true) await rebind(previous, paths, runner)
    } catch (failure) {
      rollbackError = failure
    }
    if (rollbackError === null) await cleanupMaterializedRelease(releasePreparation)
    if (rollbackError !== null) {
      throw new AgentHostError('UPDATE_ROLLBACK_FAILED', 'The update failed and the previous environment could not be fully restored', {
        update: error.message,
        rollback: rollbackError.message,
        retainedReleasePackages: releasePreparation?.createdRoots ?? [],
      })
    }
    throw error
  }
  await saveState(paths, next, { retainCurrent: true })
  await recordActivity(paths, 'environment.updated', changed.length === 0 ? 'Environment checked for updates' : 'Environment updated', {
    changed,
    channel: next.channel,
    releaseId: next.releaseId ?? null,
    suiteVersion: next.suiteVersion,
  })
  await discardMaterializedDownloads(releasePreparation)
  return { status: 'updated', channel: next.channel, releaseId: next.releaseId ?? null, changed, restartRequired: Object.keys(next.hosts).length > 0 }
}

async function verifyStateBytes(state) {
  const mismatches = []
  for (const [id, component] of Object.entries(state.components)) {
    try {
      if (state.channel === 'release') await verifyReleaseComponent(component)
      else if (await fingerprintIdentityFiles(component.identityFiles) !== component.fingerprint) mismatches.push(id)
    } catch {
      mismatches.push(id)
    }
  }
  return mismatches
}

export async function rollbackInstallation(options, dependencies = {}) {
  const runner = dependencies.runner ?? runFile
  const paths = await prepareStatePaths(resolveStateRoot(options.stateRoot))
  const current = await loadState(paths)
  if (current === null) throw new AgentHostError('NOT_INSTALLED', 'No Agent environment is installed')
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
  await recordActivity(paths, 'environment.rolled-back', 'Previous environment restored', {
    suiteVersion: restored.suiteVersion,
    rolledBackFrom: current.suiteVersion,
  })
  return { status: 'rolled-back', suiteVersion: restored.suiteVersion, restartRequired: true, observabilityTeardown }
}

export function safePurgeRoot(root) {
  const parsed = parse(root)
  if (root === parsed.root || root === homedir() || dirname(root) === root) return false
  return root.split(parsed.root).filter(Boolean).length >= 3
}

export async function uninstallInstallation(options, dependencies = {}) {
  const runner = dependencies.runner ?? runFile
  const root = resolveStateRoot(options.stateRoot)
  if (options.purgeData && !safePurgeRoot(root)) {
    throw new AgentHostError('PURGE_ROOT_UNSAFE', `Refusing to recursively remove unsafe state root: ${root}`)
  }
  const paths = await prepareStatePaths(root)
  const state = await loadState(paths)
  if (state === null) return { status: 'not-installed' }
  const results = {
    observability: await teardownObservability(state, paths, runner),
    service: await uninstallService(state.runtime.service, runner),
    hosts: {},
  }
  results.runtimeSocket = await cleanupRuntimeSocket(paths, state.runtime)
  for (const [id, host] of Object.entries(state.hosts).reverse()) results.hosts[id] = await uninstallHost(id, host, runner)
  await recordActivity(paths, 'environment.uninstalled', 'Agent Host removed', {
    purgeData: options.purgeData,
    suiteVersion: state.suiteVersion,
  })
  const archive = await archiveAndRemoveState(paths, state)
  if (options.purgeData) {
    await rm(root, { recursive: true, force: false })
  }
  return { status: 'uninstalled', purgeData: options.purgeData, archive: options.purgeData ? null : archive, results }
}
