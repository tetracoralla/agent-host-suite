import { homedir } from 'node:os'
import { tmpdir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { buildDevelopmentManifest, buildDevelopmentObservabilityManifest, fingerprintIdentityFiles } from './development-manifest.mjs'
import { AgentHostError } from './errors.mjs'
import { inspectCodex, installCodex, suspendCodex, uninstallCodex } from './hosts/codex.mjs'
import { materializeCodexProjections, pruneCodexProjections, resolveWorkspaceRoot } from './hosts/codex-projection.mjs'
import { inspectClaude, installClaude, suspendClaude, uninstallClaude } from './hosts/claude.mjs'
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
import { agentFacingManifest, loadProfile, selectAgentComponents } from './profile.mjs'
import { inspectOperationsSkill, installOperationsSkill, preflightOperationsSkill, uninstallOperationsSkill } from './host-operations-skill.mjs'

function stateManifest(state) {
  return agentFacingManifest({ components: state.components }, state.agentComponents ?? Object.keys(state.components))
}

function availableAgentComponents(state) {
  return state.availableAgentComponents ?? state.agentComponents ?? Object.keys(state.components)
}

function activeManifest(manifest) {
  return agentFacingManifest(manifest, manifest.agentComponents ?? Object.keys(manifest.components))
}

async function pruneStateCodexProjections(paths, state) {
  const active = (state.hosts.codex?.entries ?? []).map((entry) => entry.marketplaceRoot)
  return pruneCodexProjections(join(paths.hostProjections, 'codex'), active)
}

function mergeHostOwnership(previous, next) {
  if (previous === undefined) return next
  const previousEntries = [...(previous.entries ?? []), ...(previous.inactiveEntries ?? [])]
  if (next.kind === 'codex') {
    return {
      ...next,
      entries: next.entries.map((entry) => {
        const old = previousEntries.find((item) => item.selector === entry.selector)
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
      const old = previousEntries.find((item) => item.name === entry.name)
      return {
        ...entry,
        created: entry.created || old?.created === true,
        displaced: old?.displaced ?? entry.displaced ?? null,
      }
    }),
  }
}

async function installHost(id, manifest, previous, paths, runner, options, dependencies = {}) {
  await preflightOperationsSkill(id, paths, runner, {
    homeRoot: dependencies.hostSkillHome,
    previous: previous?.operationsSkill,
    replaceConflicts: options.replaceHostConflicts,
  })
  const binding = id === 'codex'
    ? mergeHostOwnership(previous, await installCodex(manifest, runner, { replaceConflicts: options.replaceHostConflicts, managedState: previous }))
    : mergeHostOwnership(previous, await installClaude(manifest, runner, previous, { replaceConflicts: options.replaceHostConflicts }))
  try {
    const operationsSkill = await installOperationsSkill(id, paths, runner, previous?.operationsSkill, {
      homeRoot: dependencies.hostSkillHome,
      replaceConflicts: options.replaceHostConflicts,
    })
    return { ...binding, operationsSkill }
  } catch (error) {
    if (previous === undefined) {
      if (id === 'codex') await uninstallCodex(binding, runner).catch(() => {})
      else await uninstallClaude(binding, runner).catch(() => {})
    }
    throw error
  }
}

async function uninstallHost(id, state, runner) {
  const complete = { ...state, entries: [...(state.entries ?? []), ...(state.inactiveEntries ?? [])] }
  const binding = id === 'codex' ? await uninstallCodex(complete, runner) : await uninstallClaude(complete, runner)
  const operationsSkill = await uninstallOperationsSkill(state.operationsSkill, runner)
  return { binding, operationsSkill }
}

async function suspendHost(id, state, runner) {
  return id === 'codex' ? await suspendCodex(state, runner) : await suspendClaude(state, runner)
}

function hostEntryKey(id, entry) {
  return id === 'codex' ? entry.selector : entry.component
}

function hostManifestKeys(id, manifest) {
  if (id === 'codex') {
    return new Set(Object.values(manifest.components)
      .filter((component) => component.plugin !== undefined)
      .map((component) => `${component.plugin}@${component.marketplace}`))
  }
  return new Set(Object.keys(manifest.components))
}

function completeHostState(state) {
  return { ...state, entries: [...(state.entries ?? []), ...(state.inactiveEntries ?? [])], inactiveEntries: [] }
}

function inactiveEntriesFor(id, state, activeKeys, availableKeys) {
  return [...(state.entries ?? []), ...(state.inactiveEntries ?? [])]
    .filter((entry) => availableKeys.has(hostEntryKey(id, entry)) && !activeKeys.has(hostEntryKey(id, entry)))
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
  let entries
  if (id === 'codex') {
    const desired = new Set(Object.values(manifest.components)
      .filter((component) => component.plugin !== undefined)
      .map((component) => `${component.plugin}@${component.marketplace}`))
    entries = current.entries.filter((entry) => !desired.has(entry.selector))
  } else if (id === 'claude') {
    const desired = new Set(Object.keys(manifest.components))
    entries = current.entries.filter((entry) => !desired.has(entry.component))
  } else {
    return null
  }
  return entries.length === 0 ? null : { ...current, entries, operationsSkill: undefined }
}

export async function addHost(options, dependencies = {}) {
  const runner = dependencies.runner ?? runFile
  const paths = await prepareStatePaths(resolveStateRoot(options.stateRoot))
  const state = await loadState(paths)
  if (state === null) throw new AgentHostError('NOT_INSTALLED', 'No Agent environment is installed')
  if (!['codex', 'claude'].includes(options.target)) throw new AgentHostError('HOST_UNSUPPORTED', `Unsupported host: ${options.target}`)
  if (state.hosts[options.target] !== undefined) return { status: 'host-present', host: options.target, changed: false }
  let manifest = stateManifest(state)
  if (options.target === 'codex') {
    const workspaceRoot = await resolveWorkspaceRoot(options.workspaceRoot ?? state.workspaceRoot)
    manifest = await materializeCodexProjections(manifest, join(paths.hostProjections, 'codex'), workspaceRoot)
    if (workspaceRoot !== null) state.workspaceRoot = workspaceRoot
  }
  const installed = await installHost(options.target, manifest, undefined, paths, runner, options, dependencies)
  state.hosts[options.target] = installed
  state.updatedAt = new Date().toISOString()
  await saveState(paths, state, { retainCurrent: true })
  const projectionCleanup = options.target === 'codex'
    ? await pruneStateCodexProjections(paths, state)
    : { removed: 0 }
  await recordActivity(paths, 'agent-app.added', `${options.target === 'codex' ? 'Codex' : 'Claude Code'} connected`, { host: options.target })
  return { status: 'host-added', host: options.target, changed: true, restartRequired: true, binding: installed, projectionCleanup }
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
  let projectionCleanup = { removed: 0 }
  if (options.target === 'codex') {
    await rm(join(paths.hostProjections, 'codex'), { recursive: true, force: true })
    projectionCleanup = { removed: 'all' }
  }
  await rm(join(paths.hostProjections, 'operations-skills', options.target), { recursive: true, force: true })
  await recordActivity(paths, 'agent-app.removed', `${options.target === 'codex' ? 'Codex' : 'Claude Code'} disconnected`, { host: options.target })
  return { status: 'host-removed', host: options.target, changed: true, removed, projectionCleanup }
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
      ? await (await import('./hosts/codex.mjs')).inspectCodex(stateManifest(state), runner, { managedState: managed, useManagedBindings: true })
      : await (await import('./hosts/claude.mjs')).inspectClaude(stateManifest(state), runner, managed)
    const bindingHealthy = options.target === 'codex'
      ? inspection.entries.every((entry) => entry.pluginPresent && entry.pluginEnabled && entry.installedVersion === entry.requestedVersion && entry.installedIdentityMatched)
      : inspection.entries.every((entry) => entry.present && entry.identityMatched)
    const operationsSkill = await inspectOperationsSkill(managed.operationsSkill, runner)
    const healthy = bindingHealthy && operationsSkill.status === 'ok'
    return {
      status: healthy ? 'ok' : 'error',
      configured: true,
      host: options.target,
      appInstalled: true,
      managed: true,
      installed: true,
      healthy,
      version: inspection.version,
      inspection: { ...inspection, operationsSkill },
    }
  } catch (error) {
    return { status: 'error', configured: true, host: options.target, appInstalled: executable !== null, managed: true, installed: true, healthy: false, version, error: { code: error.code ?? 'HOST_INSPECTION_FAILED', message: error.message } }
  }
}

async function activateState(paths, previous, manifest, runner, options, workspaceRoot, dependencies = {}) {
  const runtimeFiles = await writeRuntimeFiles(paths, manifest)
  const agents = activeManifest(manifest)
  const codexAgents = previous.hosts.codex === undefined
    ? agents
    : await materializeCodexProjections(agents, join(paths.hostProjections, 'codex'), workspaceRoot)
  const hosts = {}
  for (const id of Object.keys(previous.hosts)) {
    const prior = previous.hosts[id]
    const complete = completeHostState(prior)
    const activeKeys = hostManifestKeys(id, agents)
    const availableKeys = hostManifestKeys(id, { components: manifest.components })
    const activeToSuspend = (prior.entries ?? []).filter((entry) => availableKeys.has(hostEntryKey(id, entry)) && !activeKeys.has(hostEntryKey(id, entry)))
    if (activeToSuspend.length > 0) await suspendHost(id, { ...prior, entries: activeToSuspend }, runner)
    const removedFromProfile = complete.entries.filter((entry) => !availableKeys.has(hostEntryKey(id, entry)))
    if (removedFromProfile.length > 0) await uninstallHost(id, { ...prior, entries: removedFromProfile, inactiveEntries: [], operationsSkill: undefined }, runner)
    const installed = await installHost(id, id === 'codex' ? codexAgents : agents, complete, paths, runner, options, dependencies)
    hosts[id] = { ...installed, inactiveEntries: inactiveEntriesFor(id, complete, activeKeys, availableKeys) }
  }
  const installedService = previous.runtime.service === null
    ? null
    : await installService(manifest.components['direct-execution-runtime'], runtimeFiles, runner, previous.runtime.service)
  const service = installedService === null ? null : { ...installedService, created: previous.runtime.service.created }
  return { hosts, runtime: { ...runtimeFiles, service } }
}

async function activateHostsOnly(paths, previous, manifest, runner, options, workspaceRoot, dependencies = {}) {
  const agents = activeManifest(manifest)
  const codexAgents = previous.hosts.codex === undefined
    ? agents
    : await materializeCodexProjections(agents, join(paths.hostProjections, 'codex'), workspaceRoot)
  const hosts = {}
  for (const id of Object.keys(previous.hosts)) {
    const prior = previous.hosts[id]
    const complete = completeHostState(prior)
    const activeKeys = hostManifestKeys(id, agents)
    const availableKeys = hostManifestKeys(id, { components: previous.components })
    const activeToSuspend = (prior.entries ?? []).filter((entry) => !activeKeys.has(hostEntryKey(id, entry)))
    if (activeToSuspend.length > 0) await suspendHost(id, { ...prior, entries: activeToSuspend }, runner)
    const installed = await installHost(id, id === 'codex' ? codexAgents : agents, complete, paths, runner, options, dependencies)
    hosts[id] = { ...installed, inactiveEntries: inactiveEntriesFor(id, complete, activeKeys, availableKeys) }
  }
  return hosts
}

async function inspectActivation(previous, manifest, runner, options, workspaceRoot, dependencies = {}) {
  const agents = activeManifest(manifest)
  let temporaryProjectionRoot = null
  const temporaryOperationsRoot = await mkdtemp(join(tmpdir(), 'agent-host-operations-projection-'))
  const operationsPaths = {
    hostProjections: temporaryOperationsRoot,
    backups: join(temporaryOperationsRoot, 'backups'),
  }
  let codexAgents = agents
  if (previous.hosts.codex !== undefined) {
    temporaryProjectionRoot = await mkdtemp(join(tmpdir(), 'agent-host-codex-projection-'))
    codexAgents = await materializeCodexProjections(agents, temporaryProjectionRoot, workspaceRoot)
  }
  const hosts = {}
  try {
    for (const [id, managed] of Object.entries(previous.hosts)) {
      const binding = id === 'codex'
        ? await inspectCodex(codexAgents, runner, { managedState: managed, replaceConflicts: options.replaceHostConflicts })
        : await inspectClaude(agents, runner, managed, { replaceConflicts: options.replaceHostConflicts })
      const operationsSkill = await preflightOperationsSkill(id, operationsPaths, runner, {
        homeRoot: dependencies.hostSkillHome,
        previous: managed.operationsSkill,
        replaceConflicts: options.replaceHostConflicts,
      })
      hosts[id] = { ...binding, operationsSkill }
    }
  } finally {
    if (temporaryProjectionRoot !== null) await rm(temporaryProjectionRoot, { recursive: true, force: true })
    await rm(temporaryOperationsRoot, { recursive: true, force: true })
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
  const workspaceRoot = await resolveWorkspaceRoot(options.workspaceRoot ?? previous.workspaceRoot)
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
  const activeAgentComponents = options.tools !== undefined
    ? selectAgentComponents(profile.agentComponents, options.tools)
    : options.profile !== undefined && options.profile !== previous.profile
      ? profile.agentComponents
      : selectAgentComponents(profile.agentComponents, (previous.agentComponents ?? profile.agentComponents).filter((id) => profile.agentComponents.includes(id)))
  manifest.agentComponents = activeAgentComponents
  const changed = [...new Set([
    ...Object.entries(manifest.components).filter(([id, component]) => component.fingerprint !== previous.components[id]?.fingerprint).map(([id]) => id),
    ...Object.keys(previous.components).filter((id) => manifest.components[id] === undefined),
    ...(JSON.stringify(previous.agentComponents ?? Object.keys(previous.components)) === JSON.stringify(activeAgentComponents) ? [] : ['agent-catalog']),
    ...(workspaceRoot === (previous.workspaceRoot ?? null) ? [] : ['workspace-grant']),
  ])]
  if (options.dryRun) {
    try {
      const activation = await inspectActivation(previous, manifest, runner, options, workspaceRoot, dependencies)
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
    const activated = await activateState(paths, previous, manifest, runner, options, workspaceRoot, dependencies)
    const { developmentRoot: _developmentRoot, releaseId: _releaseId, releaseManifest: _releaseManifest, workspaceRoot: _workspaceRoot, ...previousBase } = previous
    const base = structuredClone(previousBase)
    const activatedAt = new Date().toISOString()
    next = {
      ...base,
      suiteVersion: manifest.suiteVersion,
      channel: manifest.channel,
      profile: profile.id,
      components: manifest.components,
      availableAgentComponents: profile.agentComponents,
      agentComponents: activeAgentComponents,
      hosts: activated.hosts,
      runtime: activated.runtime,
      updatedAt: activatedAt,
      releaseActivatedAt: activatedAt,
      bindingsActivatedAt: activatedAt,
      workspaceRoot,
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
      await activateState(paths, previous, { components: previous.components, agentComponents: previous.agentComponents }, runner, options, previous.workspaceRoot ?? null, dependencies)
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
  const projectionCleanup = await pruneStateCodexProjections(paths, next)
  await recordActivity(paths, 'environment.updated', changed.length === 0 ? 'Environment checked for updates' : 'Environment updated', {
    changed,
    channel: next.channel,
    releaseId: next.releaseId ?? null,
    suiteVersion: next.suiteVersion,
  })
  await discardMaterializedDownloads(releasePreparation)
  return { status: 'updated', channel: next.channel, releaseId: next.releaseId ?? null, changed, restartRequired: Object.keys(next.hosts).length > 0, projectionCleanup }
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
  const workspaceRoot = await resolveWorkspaceRoot(options.workspaceRoot ?? current.workspaceRoot)
  const activated = await activateState(paths, current, { components: target.components, agentComponents: target.agentComponents }, runner, options, workspaceRoot, dependencies)
  const activatedAt = new Date().toISOString()
  const restored = {
    ...target,
    hosts: activated.hosts,
    runtime: activated.runtime,
    updatedAt: activatedAt,
    releaseActivatedAt: activatedAt,
    bindingsActivatedAt: activatedAt,
    rolledBackFrom: current.suiteVersion,
    workspaceRoot,
  }
  if (restored.observability?.enabled === true) await rebindObservabilityState(restored, paths, runner)
  await saveState(paths, restored, { retainCurrent: true })
  const projectionCleanup = await pruneStateCodexProjections(paths, restored)
  await recordActivity(paths, 'environment.rolled-back', 'Previous environment restored', {
    suiteVersion: restored.suiteVersion,
    rolledBackFrom: current.suiteVersion,
  })
  return { status: 'rolled-back', suiteVersion: restored.suiteVersion, restartRequired: true, observabilityTeardown, projectionCleanup }
}

export async function toolSetStatus(options = {}) {
  const paths = await prepareStatePaths(resolveStateRoot(options.stateRoot))
  const state = await loadState(paths)
  if (state === null) throw new AgentHostError('NOT_INSTALLED', 'No Agent environment is installed')
  const available = availableAgentComponents(state)
  const active = state.agentComponents ?? available
  return {
    schemaVersion: 'openadam.agent-host-tool-set.v0.1',
    status: 'ok',
    profile: state.profile,
    availableAgentComponents: available,
    activeAgentComponents: active,
    inactiveAgentComponents: available.filter((id) => !active.includes(id)),
    tools: available.map((id) => ({
      id,
      version: state.components[id]?.version ?? null,
      displayName: state.components[id]?.displayName ?? id,
      summary: state.components[id]?.summary ?? null,
      active: active.includes(id),
    })),
    freshSession: {
      requiredAfterChange: true,
      currentSessionUptake: 'not-observed',
    },
  }
}

export async function setActiveTools(options, dependencies = {}) {
  const runner = dependencies.runner ?? runFile
  const paths = await prepareStatePaths(resolveStateRoot(options.stateRoot))
  const previous = await loadState(paths)
  if (previous === null) throw new AgentHostError('NOT_INSTALLED', 'No Agent environment is installed')
  const available = availableAgentComponents(previous)
  const requested = options.resetTools === true ? available : options.tools
  const active = selectAgentComponents(available, requested)
  const current = previous.agentComponents ?? available
  const changed = JSON.stringify(current) !== JSON.stringify(active)
  const manifest = { components: previous.components, agentComponents: active }
  const workspaceRoot = await resolveWorkspaceRoot(options.workspaceRoot ?? previous.workspaceRoot)
  if (!changed) {
    return { ...(await toolSetStatus({ stateRoot: paths.root })), status: 'tool-set-unchanged', changed: false, restartRequired: false }
  }
  if (options.dryRun === true) {
    const activation = await inspectActivation(previous, manifest, runner, options, workspaceRoot, dependencies)
    return {
      schemaVersion: 'openadam.agent-host-tool-set.v0.1', status: 'ready', dryRun: true,
      changed: true, activeAgentComponents: active,
      inactiveAgentComponents: available.filter((id) => !active.includes(id)), activation,
      restartRequired: Object.keys(previous.hosts).length > 0,
    }
  }
  const rebind = dependencies.rebindObservability ?? rebindObservabilityState
  let nextHosts = null
  try {
    nextHosts = await activateHostsOnly(paths, previous, manifest, runner, options, workspaceRoot, dependencies)
    const activatedAt = new Date().toISOString()
    const next = {
      ...previous,
      availableAgentComponents: available,
      agentComponents: active,
      hosts: nextHosts,
      updatedAt: activatedAt,
      bindingsActivatedAt: activatedAt,
      workspaceRoot,
    }
    if (next.observability?.enabled === true) await rebind(next, paths, runner)
    await saveState(paths, next)
  } catch (error) {
    await activateHostsOnly(paths, { ...previous, hosts: nextHosts ?? previous.hosts }, { components: previous.components, agentComponents: current }, runner, options, previous.workspaceRoot ?? null, dependencies).catch(() => {})
    if (previous.observability?.enabled === true) await rebind(previous, paths, runner).catch(() => {})
    throw error
  }
  const projectionCleanup = await pruneStateCodexProjections(paths, { ...previous, hosts: nextHosts })
  await recordActivity(paths, 'tool-set.changed', 'Agent tool availability changed', {
    activeAgentComponents: active,
    inactiveAgentComponents: available.filter((id) => !active.includes(id)),
  })
  return {
    ...(await toolSetStatus({ stateRoot: paths.root })),
    status: 'tool-set-updated', changed: true,
    restartRequired: Object.keys(previous.hosts).length > 0,
    projectionCleanup,
  }
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
  await rm(paths.hostProjections, { recursive: true, force: true })
  results.hostProjections = { removed: true }
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
