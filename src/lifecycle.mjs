import { homedir, platform, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, parse } from 'node:path'
import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { buildDevelopmentManifest, buildDevelopmentObservabilityManifest, fingerprintIdentityFiles } from './development-manifest.mjs'
import { AgentHostError } from './errors.mjs'
import { inspectCodex, installCodex, suspendCodex, uninstallCodex } from './hosts/codex.mjs'
import { materializeCodexProjections, pruneCodexProjections, resolveWorkspaceRoot } from './hosts/codex-projection.mjs'
import { CLAUDE_USER_CONFIG_ARGUMENTS, inspectClaude, installClaude, suspendClaude, uninstallClaude } from './hosts/claude.mjs'
import { inspectZcode, installZcode, resolveZcodeExecutable, suspendZcode, uninstallZcode } from './hosts/zcode.mjs'
import { canonicalJson, readJson, sha256 } from './json.mjs'
import { resolveStateRoot } from './paths.mjs'
import { resolveExecutable, runFile } from './process.mjs'
import { inspectService, installService, restoreServiceRecoveryBundle, uninstallService } from './service.mjs'
import { loadServiceRecoveryBundle } from './service-recovery.mjs'
import { archiveAndRemoveState, loadRollbackState, loadState, prepareStatePaths, readStatePaths, saveState, statePaths } from './state.mjs'
import { cleanupRuntimeSocket, writeRuntimeFiles } from './runtime-config.mjs'
import { activateObservabilityState, observabilitySummary, rebindObservabilityState, teardownObservability } from './observability.mjs'
import { recordActivity } from './activity.mjs'
import { cleanupMaterializedRelease, discardMaterializedDownloads, materializeRelease, verifyReleaseComponent } from './release-artifacts.mjs'
import { COMPONENT_WARMUP_POLICY_VERSION, warmInstalledAgentComponents } from './component-warmup.mjs'
import { preflightManagedCatalog } from './context-exporter.mjs'
import { compareSuiteVersions, loadReleaseManifest, OBSERVABILITY_RELEASE_COMPONENTS } from './release-manifest.mjs'
import { loadReleaseProvenance } from './release-provenance.mjs'
import { hostFacingManifest, loadProfile, selectAgentComponents } from './profile.mjs'
import { inspectOperationsSkill, installOperationsSkill, preflightOperationsSkill, uninstallOperationsSkill } from './host-operations-skill.mjs'
import { preflightApplicationState } from './application-carrier.mjs'
import { validateComponentPathGrants } from './component-environment.mjs'
import { retireLifecycleRoot, withLifecycleMutation } from './lifecycle-lock.mjs'
import {
  inspectDeveloperKitSkill,
  inspectProductSkills,
  inspectProviderSkills,
  installDeveloperKitSkill,
  installProductSkills,
  installProviderSkills,
  preflightDeveloperKitSkill,
  preflightProductSkills,
  preflightProviderSkills,
  uninstallDeveloperKitSkill,
  uninstallProductSkills,
  uninstallProviderSkills,
} from './developer-kit-skill.mjs'

function stateManifest(state) {
  return hostFacingManifest({ components: state.components }, state.agentComponents ?? Object.keys(state.components))
}

function availableAgentComponents(state) {
  return state.availableAgentComponents ?? state.agentComponents ?? Object.keys(state.components)
}

const SUPPORTED_HOSTS = Object.freeze(['codex', 'claude', 'zcode'])

function hostDisplayName(id) {
  return id === 'codex' ? 'Codex' : id === 'claude' ? 'Claude Code' : 'ZCode'
}

function retainedWorkspaceRoot(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new AgentHostError('WORKSPACE_ROOT_INVALID', 'The retained workspace root must be an absolute directory path')
  }
  return value
}

function agentCatalogComponents(manifest, componentIds) {
  return Object.fromEntries(componentIds.map((id) => [id, manifest.components[id]]))
}

function updatedInstallationState({
  previous,
  manifest,
  profile,
  availableAgentComponents: available,
  activeAgentComponents: active,
  releasePreparation,
  releaseSourceProvenance,
  hosts,
  runtime,
  workspaceRoot,
  activatedAt,
}) {
  const {
    developmentRoot: _developmentRoot,
    releaseId: _releaseId,
    releaseManifest: _releaseManifest,
    releaseSourceProvenance: _releaseSourceProvenance,
    workspaceRoot: _workspaceRoot,
    ...previousBase
  } = previous
  return {
    ...structuredClone(previousBase),
    suiteVersion: manifest.suiteVersion,
    channel: manifest.channel,
    profile: profile.id,
    components: manifest.components,
    availableAgentComponents: available,
    agentComponents: active,
    ...(releasePreparation === null ? {} : { componentWarmupVersion: COMPONENT_WARMUP_POLICY_VERSION }),
    hosts,
    runtime,
    updatedAt: activatedAt,
    releaseActivatedAt: activatedAt,
    bindingsActivatedAt: activatedAt,
    workspaceRoot,
    ...(manifest.developmentRoot === undefined ? {} : { developmentRoot: manifest.developmentRoot }),
    ...(releasePreparation === null ? {} : {
      releaseId: manifest.releaseId,
      releaseManifest: releasePreparation.release,
      releaseSourceProvenance,
    }),
  }
}

async function checkApplicationState(state, dependencies) {
  return (dependencies.applicationStatePreflight ?? preflightApplicationState)(state, {
    runner: dependencies.applicationRunner ?? runFile,
    carrier: dependencies.applicationCarrier,
    resolver: dependencies.resolveApplicationCarrier,
  })
}

function activeManifest(manifest) {
  return hostFacingManifest(manifest, manifest.agentComponents ?? Object.keys(manifest.components))
}

async function validateActiveComponentPathGrants(manifest) {
  const active = manifest.agentComponents ?? Object.keys(manifest.components)
  for (const id of active) {
    const component = manifest.components[id]
    if (component !== undefined) await validateComponentPathGrants(component)
  }
}

async function pruneStateCodexProjections(paths, state, prune = pruneCodexProjections) {
  const active = (state.hosts.codex?.entries ?? []).map((entry) => entry.marketplaceRoot)
  return prune(join(paths.hostProjections, 'codex'), active)
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
  await preflightDeveloperKitSkill(id, manifest, paths, {
    homeRoot: dependencies.hostSkillHome,
    previous: previous?.developerSkill,
    replaceConflicts: options.replaceHostConflicts,
  })
  await preflightProviderSkills(id, manifest, paths, {
    homeRoot: dependencies.hostSkillHome,
    previous: previous?.providerSkills,
    replaceConflicts: options.replaceHostConflicts,
  })
  await preflightProductSkills(id, manifest, paths, {
    homeRoot: dependencies.hostSkillHome,
    previous: previous?.productSkills,
    replaceConflicts: options.replaceHostConflicts,
  })
  const binding = id === 'codex'
    ? await installCodex(manifest, runner, { replaceConflicts: options.replaceHostConflicts, managedState: previous })
    : id === 'claude'
      ? await installClaude(manifest, runner, previous, {
          replaceConflicts: options.replaceHostConflicts,
          workspaceRoot: options.workspaceRoot ?? previous?.workspaceRoot ?? null,
        })
      : await installZcode(manifest, runner, previous, {
          replaceConflicts: options.replaceHostConflicts,
          workspaceRoot: options.workspaceRoot ?? previous?.workspaceRoot ?? null,
          configPath: dependencies.zcodeConfigPath,
          executable: dependencies.zcodeExecutable,
        })
  const mergedBinding = mergeHostOwnership(previous, binding)
  let operationsSkill = null
  let developerSkill = null
  let providerSkills = []
  let productSkills = []
  try {
    operationsSkill = await installOperationsSkill(id, paths, runner, previous?.operationsSkill, {
      homeRoot: dependencies.hostSkillHome,
      replaceConflicts: options.replaceHostConflicts,
    })
    developerSkill = await installDeveloperKitSkill(id, manifest, paths, previous?.developerSkill, {
      homeRoot: dependencies.hostSkillHome,
      replaceConflicts: options.replaceHostConflicts,
    })
    providerSkills = await installProviderSkills(id, manifest, paths, previous?.providerSkills, {
      homeRoot: dependencies.hostSkillHome,
      replaceConflicts: options.replaceHostConflicts,
    })
    productSkills = await installProductSkills(id, manifest, paths, previous?.productSkills, {
      homeRoot: dependencies.hostSkillHome,
      replaceConflicts: options.replaceHostConflicts,
    })
    return { ...mergedBinding, operationsSkill, developerSkill, providerSkills, productSkills }
  } catch (error) {
    if (previous === undefined) {
      await uninstallProductSkills(productSkills).catch(() => {})
      await uninstallProviderSkills(providerSkills).catch(() => {})
      await uninstallDeveloperKitSkill(developerSkill).catch(() => {})
      await uninstallOperationsSkill(operationsSkill, runner).catch(() => {})
      if (id === 'codex') await uninstallCodex(binding, runner).catch(() => {})
      else if (id === 'claude') await uninstallClaude(binding, runner).catch(() => {})
      else await uninstallZcode(binding).catch(() => {})
    }
    throw error
  }
}

async function uninstallHost(id, state, runner) {
  const complete = { ...state, entries: [...(state.entries ?? []), ...(state.inactiveEntries ?? [])] }
  const productSkills = await uninstallProductSkills(state.productSkills)
  const providerSkills = await uninstallProviderSkills(state.providerSkills)
  const developerSkill = await uninstallDeveloperKitSkill(state.developerSkill)
  const binding = id === 'codex'
    ? await uninstallCodex(complete, runner)
    : id === 'claude'
      ? await uninstallClaude(complete, runner)
      : await uninstallZcode(complete)
  const operationsSkill = await uninstallOperationsSkill(state.operationsSkill, runner)
  return { binding, operationsSkill, developerSkill, providerSkills, productSkills }
}

async function suspendHost(id, state, runner) {
  return id === 'codex'
    ? await suspendCodex(state, runner)
    : id === 'claude'
      ? await suspendClaude(state, runner)
      : await suspendZcode(state)
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

async function committedStep(warnings, code, message, task, fallback) {
  try {
    return await task()
  } catch {
    warnings.push({ code, message })
    return fallback
  }
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
  } else if (id === 'claude' || id === 'zcode') {
    const desired = new Set(Object.keys(manifest.components))
    entries = current.entries.filter((entry) => !desired.has(entry.component))
  } else {
    return null
  }
  return entries.length === 0 ? null : { ...current, entries, operationsSkill: undefined, developerSkill: undefined, providerSkills: undefined, productSkills: undefined }
}

async function addHostUnlocked(options, dependencies = {}, preparedPaths = null) {
  const runner = dependencies.runner ?? runFile
  const paths = preparedPaths ?? await prepareStatePaths(resolveStateRoot(options.stateRoot))
  const previous = await loadState(paths)
  if (previous === null) throw new AgentHostError('NOT_INSTALLED', 'No Agent environment is installed')
  if (!SUPPORTED_HOSTS.includes(options.target)) throw new AgentHostError('HOST_UNSUPPORTED', `Unsupported host: ${options.target}`)
  if (previous.hosts[options.target] !== undefined) return { status: 'host-present', host: options.target, changed: false }
  await validateActiveComponentPathGrants({ components: previous.components, agentComponents: previous.agentComponents })
  let manifest = stateManifest(previous)
  let workspaceRoot = previous.workspaceRoot ?? null
  if (options.target === 'codex' || options.target === 'zcode') {
    workspaceRoot = await resolveWorkspaceRoot(options.workspaceRoot ?? previous.workspaceRoot)
    if (options.target === 'codex') manifest = await materializeCodexProjections(manifest, join(paths.hostProjections, 'codex'), workspaceRoot)
  }
  let installed = null
  let next = null
  try {
    installed = await installHost(options.target, manifest, undefined, paths, runner, { ...options, workspaceRoot }, dependencies)
    next = {
      ...previous,
      hosts: { ...previous.hosts, [options.target]: installed },
      ...(workspaceRoot === null ? {} : { workspaceRoot }),
      updatedAt: new Date().toISOString(),
    }
    await (dependencies.saveState ?? saveState)(paths, next, { retainCurrent: true })
  } catch (error) {
    let rollbackError = null
    try {
      if (installed !== null) await uninstallHost(options.target, installed, runner)
      if (options.target === 'codex') await rm(join(paths.hostProjections, 'codex'), { recursive: true, force: true })
    } catch (failure) {
      rollbackError = failure
    }
    if (rollbackError !== null) {
      throw new AgentHostError('HOST_ADD_ROLLBACK_FAILED', 'The Agent app connection failed and its partial installation could not be removed', {
        connection: error.message,
        rollback: rollbackError.message,
      })
    }
    throw error
  }
  const warnings = []
  const projectionCleanup = options.target === 'codex'
    ? await committedStep(
        warnings,
        'CODEX_PROJECTION_CLEANUP_FAILED',
        'The Agent app connection succeeded, but stale Codex projection cleanup could not be completed.',
        () => pruneStateCodexProjections(paths, next, dependencies.pruneCodexProjections),
        { status: 'not-completed', removed: 0 },
      )
    : { removed: 0 }
  await committedStep(
    warnings,
    'ACTIVITY_LOG_WRITE_FAILED',
    'The Agent app connection succeeded, but its activity entry could not be recorded.',
    () => (dependencies.recordActivity ?? recordActivity)(paths, 'agent-app.added', `${hostDisplayName(options.target)} connected`, { host: options.target }),
  )
  return { status: 'host-added', host: options.target, changed: true, restartRequired: true, binding: installed, projectionCleanup, ...(warnings.length === 0 ? {} : { warnings }) }
}

async function removeHostUnlocked(options, dependencies = {}, preparedPaths = null) {
  const runner = dependencies.runner ?? runFile
  const paths = preparedPaths ?? await prepareStatePaths(resolveStateRoot(options.stateRoot))
  const state = await loadState(paths)
  if (state === null) throw new AgentHostError('NOT_INSTALLED', 'No Agent environment is installed')
  if (!SUPPORTED_HOSTS.includes(options.target)) throw new AgentHostError('HOST_UNSUPPORTED', `Unsupported host: ${options.target}`)
  if (state.hosts[options.target] === undefined) return { status: 'host-absent', host: options.target, changed: false }
  let rollbackManifest = stateManifest(state)
  const workspaceRoot = options.workspaceRoot === undefined
    ? retainedWorkspaceRoot(state.workspaceRoot)
    : await resolveWorkspaceRoot(options.workspaceRoot)
  if (options.target === 'codex') {
    rollbackManifest = await materializeCodexProjections(rollbackManifest, join(paths.hostProjections, 'codex'), workspaceRoot)
  }
  let removed = null
  let mutationStarted = false
  let next = null
  try {
    mutationStarted = true
    removed = await uninstallHost(options.target, state.hosts[options.target], runner)
    const hosts = { ...state.hosts }
    delete hosts[options.target]
    next = { ...state, hosts, updatedAt: new Date().toISOString() }
    await (dependencies.saveState ?? saveState)(paths, next, { retainCurrent: true })
  } catch (error) {
    let rollbackError = null
    if (mutationStarted) {
      try {
        await installHost(options.target, rollbackManifest, undefined, paths, runner, {
          ...options,
          workspaceRoot,
          replaceHostConflicts: true,
        }, dependencies)
      } catch (failure) {
        rollbackError = failure
      }
    }
    if (rollbackError !== null) {
      throw new AgentHostError('HOST_REMOVE_ROLLBACK_FAILED', 'The Agent app disconnection failed and the previous connection could not be restored', {
        disconnection: error.message,
        rollback: rollbackError.message,
      })
    }
    throw error
  }
  const warnings = []
  let projectionCleanup = { removed: 0 }
  projectionCleanup = await committedStep(
    warnings,
    'HOST_PROJECTION_CLEANUP_FAILED',
    'The Agent app was disconnected, but stale Host projection cleanup could not be completed.',
    async () => {
      if (options.target === 'codex') await rm(join(paths.hostProjections, 'codex'), { recursive: true, force: true })
      await rm(join(paths.hostProjections, 'operations-skills', options.target), { recursive: true, force: true })
      await rm(join(paths.hostProjections, 'developer-skills', options.target), { recursive: true, force: true })
      await rm(join(paths.hostProjections, 'provider-skills', options.target), { recursive: true, force: true })
      await rm(join(paths.hostProjections, 'product-skills', options.target), { recursive: true, force: true })
      return options.target === 'codex' ? { removed: 'all' } : { removed: 0 }
    },
    { status: 'not-completed', removed: 0 },
  )
  await committedStep(
    warnings,
    'ACTIVITY_LOG_WRITE_FAILED',
    'The Agent app was disconnected, but its activity entry could not be recorded.',
    () => (dependencies.recordActivity ?? recordActivity)(paths, 'agent-app.removed', `${hostDisplayName(options.target)} disconnected`, { host: options.target }),
  )
  return { status: 'host-removed', host: options.target, changed: true, removed, projectionCleanup, ...(warnings.length === 0 ? {} : { warnings }) }
}

export async function hostStatus(options, dependencies = {}) {
  const runner = dependencies.runner ?? runFile
  const paths = await readStatePaths(resolveStateRoot(options.stateRoot))
  const state = await loadState(paths)
  if (!SUPPORTED_HOSTS.includes(options.target)) throw new AgentHostError('HOST_UNSUPPORTED', `Unsupported host: ${options.target}`)
  const executable = options.target === 'zcode'
    ? await resolveZcodeExecutable(runner, { executable: dependencies.zcodeExecutable })
    : await resolveExecutable(options.target, runner)
  const managed = state?.hosts?.[options.target]
  if (options.quick === true) {
    return {
      status: executable === null ? 'error' : 'ok',
      configured: state !== null,
      host: options.target,
      appInstalled: executable !== null,
      managed: managed !== undefined,
      installed: managed !== undefined,
      healthy: null,
      version: managed?.version ?? null,
    }
  }
  let version = managed?.version ?? null
  if (executable !== null && managed === undefined) {
    const versionArguments = options.target === 'claude'
      ? [...CLAUDE_USER_CONFIG_ARGUMENTS, '--version']
      : options.target === 'zcode' ? ['version', '--json'] : ['--version']
    const versionResult = await runner(executable, versionArguments, { allowFailure: true, timeoutMs: 5_000 })
    if (versionResult.status === 0) version = versionResult.stdout.trim()
  }
  if (state === null) return { status: 'ok', configured: false, host: options.target, appInstalled: executable !== null, managed: false, version }
  if (managed === undefined) return { status: 'ok', configured: true, host: options.target, appInstalled: executable !== null, managed: false, installed: false, version }
  try {
    await validateActiveComponentPathGrants({ components: state.components, agentComponents: state.agentComponents })
    const inspection = options.target === 'codex'
      ? await inspectCodex(stateManifest(state), runner, { managedState: managed, useManagedBindings: true })
      : options.target === 'claude'
        ? await inspectClaude(stateManifest(state), runner, managed, { workspaceRoot: state.workspaceRoot ?? null })
        : await inspectZcode(stateManifest(state), runner, managed, {
            workspaceRoot: state.workspaceRoot ?? null,
            configPath: dependencies.zcodeConfigPath,
            executable: dependencies.zcodeExecutable,
          })
    const bindingHealthy = options.target === 'codex'
      ? inspection.entries.every((entry) => entry.pluginPresent && entry.pluginEnabled && entry.installedVersion === entry.requestedVersion && entry.installedIdentityMatched)
      : inspection.entries.every((entry) => entry.present && entry.identityMatched)
    const operationsSkill = await inspectOperationsSkill(managed.operationsSkill, runner)
    const developerSkill = options.target === 'codex'
      ? { status: 'not-applicable', carrier: 'codex-plugin' }
      : await inspectDeveloperKitSkill(managed.developerSkill, runner)
    const developerSkillExpected = state.components['agent-tool-development-kit'] !== undefined
    const developerSkillHealthy = options.target === 'codex'
      || (developerSkillExpected ? developerSkill.status === 'ok' : developerSkill.status === 'absent')
    const providerSkills = options.target === 'codex'
      ? { status: 'not-applicable', carrier: 'codex-plugin' }
      : await inspectProviderSkills(managed.providerSkills, runner)
    const expectedProviderSkillCount = Object.values(stateManifest(state).components).filter((component) => component.providerSkill !== undefined).length
    const providerSkillsHealthy = options.target === 'codex'
      || (providerSkills.status === 'ok' && providerSkills.skills.length === expectedProviderSkillCount)
    const productSkills = options.target === 'codex'
      ? { status: 'not-applicable', carrier: 'codex-plugin' }
      : await inspectProductSkills(managed.productSkills, runner)
    const hostManifest = stateManifest(state)
    const providerSkillIds = new Set(Object.values(hostManifest.components).flatMap((component) => component.providerSkill?.id ?? []))
    const expectedProductSkillCount = Object.values(hostManifest.components)
      .filter((component) => component.skillOnly !== true)
      .flatMap((component) => component.productSkills ?? [])
      .filter((skill) => !providerSkillIds.has(skill.id)).length
    const productSkillsHealthy = options.target === 'codex'
      || (productSkills.status === 'ok' && productSkills.skills.length === expectedProductSkillCount)
    const healthy = bindingHealthy && operationsSkill.status === 'ok' && developerSkillHealthy && providerSkillsHealthy && productSkillsHealthy
    return {
      status: healthy ? 'ok' : 'error',
      configured: true,
      host: options.target,
      appInstalled: true,
      managed: true,
      installed: true,
      healthy,
      version: inspection.version,
      inspection: { ...inspection, operationsSkill, developerSkill, providerSkills, productSkills },
    }
  } catch (error) {
    return { status: 'error', configured: true, host: options.target, appInstalled: executable !== null, managed: true, installed: true, healthy: false, version, error: { code: error.code ?? 'HOST_INSPECTION_FAILED', message: error.message } }
  }
}

async function activateManagedHosts(paths, previous, manifest, runner, options, workspaceRoot, dependencies, behavior) {
  const agents = activeManifest(manifest)
  const codexAgents = previous.hosts.codex === undefined
    ? agents
    : await materializeCodexProjections(agents, join(paths.hostProjections, 'codex'), workspaceRoot)
  const hosts = {}
  for (const id of Object.keys(previous.hosts)) {
    const prior = previous.hosts[id]
    const complete = completeHostState(prior)
    const activeKeys = hostManifestKeys(id, agents)
    const availableKeys = hostManifestKeys(id, { components: behavior.availableComponents })
    const activeToSuspend = (prior.entries ?? []).filter((entry) => {
      const key = hostEntryKey(id, entry)
      return !activeKeys.has(key) && (!behavior.suspendOnlyAvailable || availableKeys.has(key))
    })
    if (activeToSuspend.length > 0) await suspendHost(id, { ...prior, entries: activeToSuspend }, runner)
    if (behavior.removeUnavailable) {
      const removed = complete.entries.filter((entry) => !availableKeys.has(hostEntryKey(id, entry)))
      if (removed.length > 0) await uninstallHost(id, { ...prior, entries: removed, inactiveEntries: [], operationsSkill: undefined, developerSkill: undefined, providerSkills: undefined, productSkills: undefined }, runner)
    }
    const installed = await installHost(id, id === 'codex' ? codexAgents : agents, complete, paths, runner, { ...options, workspaceRoot }, dependencies)
    hosts[id] = { ...installed, inactiveEntries: inactiveEntriesFor(id, complete, activeKeys, availableKeys) }
  }
  return hosts
}

async function activateState(paths, previous, manifest, runner, options, workspaceRoot, dependencies = {}) {
  const runtimeFiles = await (dependencies.writeRuntimeFiles ?? writeRuntimeFiles)(paths, manifest, { workspaceRoot })
  try {
    const hosts = await activateManagedHosts(paths, previous, manifest, runner, options, workspaceRoot, dependencies, {
      availableComponents: manifest.components,
      removeUnavailable: true,
      suspendOnlyAvailable: true,
    })
    const installedService = previous.runtime.service === null
      ? null
        : await installService(manifest.components['direct-execution-runtime'], runtimeFiles, runner, previous.runtime.service, {
          allowMissingOwnedState: dependencies.allowMissingOwnedServiceState === true,
          recoveryRoot: paths.serviceRecovery,
          recoveryLifecycle: {
            statePath: paths.state,
            currentStateIdentity: sha256(canonicalJson(previous)),
          },
        })
    const service = installedService === null ? null : { ...installedService, created: previous.runtime.service.created }
    return { hosts, runtime: { ...runtimeFiles, service } }
  } catch (error) {
    if (runtimeFiles.configPath !== previous.runtime.configPath) {
      await rm(runtimeFiles.configPath, { force: true }).catch(() => {})
    }
    throw error
  }
}

async function activateHostsOnly(paths, previous, manifest, runner, options, workspaceRoot, dependencies = {}) {
  return activateManagedHosts(paths, previous, manifest, runner, options, workspaceRoot, dependencies, {
    availableComponents: previous.components,
    removeUnavailable: false,
    suspendOnlyAvailable: false,
  })
}

async function activateHostsForInventory(paths, previous, manifest, runner, options, workspaceRoot, dependencies = {}) {
  return activateManagedHosts(paths, previous, manifest, runner, options, workspaceRoot, dependencies, {
    availableComponents: manifest.components,
    removeUnavailable: true,
    suspendOnlyAvailable: true,
  })
}

async function inspectActivation(previous, manifest, runner, options, workspaceRoot, dependencies = {}) {
  await validateActiveComponentPathGrants(manifest)
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
        : id === 'claude'
          ? await inspectClaude(agents, runner, managed, {
              replaceConflicts: options.replaceHostConflicts,
              workspaceRoot,
            })
          : await inspectZcode(agents, runner, managed, {
              replaceConflicts: options.replaceHostConflicts,
              workspaceRoot,
              configPath: dependencies.zcodeConfigPath,
              executable: dependencies.zcodeExecutable,
            })
      const operationsSkill = await preflightOperationsSkill(id, operationsPaths, runner, {
        homeRoot: dependencies.hostSkillHome,
        previous: managed.operationsSkill,
        replaceConflicts: options.replaceHostConflicts,
      })
      const developerSkill = await preflightDeveloperKitSkill(id, agents, operationsPaths, {
        homeRoot: dependencies.hostSkillHome,
        previous: managed.developerSkill,
        replaceConflicts: options.replaceHostConflicts,
      })
      const providerSkills = await preflightProviderSkills(id, agents, operationsPaths, {
        homeRoot: dependencies.hostSkillHome,
        previous: managed.providerSkills,
        replaceConflicts: options.replaceHostConflicts,
      })
      const productSkills = await preflightProductSkills(id, agents, operationsPaths, {
        homeRoot: dependencies.hostSkillHome,
        previous: managed.productSkills,
        replaceConflicts: options.replaceHostConflicts,
      })
      hosts[id] = { ...binding, operationsSkill, developerSkill, providerSkills, productSkills }
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

async function updateInstallationUnlocked(options, dependencies = {}, preparedPaths = null) {
  const runner = dependencies.runner ?? runFile
  const paths = preparedPaths ?? await prepareStatePaths(resolveStateRoot(options.stateRoot))
  const previous = await loadState(paths)
  if (previous === null) throw new AgentHostError('NOT_INSTALLED', 'No Agent environment is installed')
  const profile = await loadProfile(options.profile ?? previous.profile)
  const workspaceRoot = await resolveWorkspaceRoot(options.workspaceRoot ?? previous.workspaceRoot)
  const enablingObservability = profile.requiresConsent
    && previous.observability?.enabled !== true
    && options.enableObservability === true
  if (options.enableObservability === true && !profile.requiresConsent) {
    throw new AgentHostError('OBSERVABILITY_PROFILE_REQUIRED', 'Enabling local monitoring requires a monitoring profile')
  }
  if (profile.requiresConsent && previous.observability?.enabled !== true && !enablingObservability) {
    throw new AgentHostError('OBSERVABILITY_CONSENT_REQUIRED', `Enable local monitoring before selecting the ${profile.displayName} tool set`)
  }
  let releasePreparation = null
  let releaseSourceProvenance = null
  let manifest
  if (options.releaseManifest !== undefined || previous.channel === 'release') {
    const release = await (dependencies.releaseManifestLoader ?? loadReleaseManifest)(options.releaseManifest)
    if (release.manifest.status === 'draft-unbound') throw new AgentHostError('RELEASE_UNBOUND', 'No verified compatibility release is bound in this build')
    if (previous.channel === 'release' && compareSuiteVersions(release.manifest.suiteVersion, previous.suiteVersion) < 0) {
      throw new AgentHostError('RELEASE_DOWNGRADE_UNSUPPORTED', 'Tool updates cannot install an older compatibility release; use the retained rollback action instead', {
        currentVersion: previous.suiteVersion,
        requestedVersion: release.manifest.suiteVersion,
      })
    }
    const provenance = await loadReleaseProvenance(release)
    releaseSourceProvenance = {
      policy: provenance.record.policy,
      recordSha256: provenance.sha256,
      remoteConfirmedAtBuildTime: provenance.record.policy === 'remote-tagged',
    }
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
  const privateComponents = Object.entries(previous.privateComponents ?? {})
    .filter(([, record]) => record?.current?.component !== undefined && record.current.component !== null)
  for (const [id, record] of privateComponents) {
    if (manifest.components[id] !== undefined) {
      await cleanupMaterializedRelease(releasePreparation)
      throw new AgentHostError('LOCAL_COMPONENT_ID_RESERVED', `The selected compatibility release now owns private component id ${id}; remove the private component before updating`)
    }
    manifest.components[id] = record.current.component
  }
  const availableAgentComponents = [...new Set([...profile.agentComponents, ...privateComponents.map(([id]) => id)])]
  const activePrivateComponents = (previous.agentComponents ?? []).filter((id) => privateComponents.some(([privateId]) => privateId === id))
  const activeAgentComponents = options.tools !== undefined
    ? selectAgentComponents(availableAgentComponents, options.tools)
    : options.profile !== undefined && options.profile !== previous.profile
      ? [...profile.defaultAgentComponents, ...activePrivateComponents]
      : selectAgentComponents(availableAgentComponents, (previous.agentComponents ?? availableAgentComponents).filter((id) => availableAgentComponents.includes(id)))
  manifest.agentComponents = activeAgentComponents
  try {
    await validateActiveComponentPathGrants(manifest)
  } catch (error) {
    await cleanupMaterializedRelease(releasePreparation)
    throw error
  }
  const changed = [...new Set([
    ...Object.entries(manifest.components).filter(([id, component]) => component.fingerprint !== previous.components[id]?.fingerprint).map(([id]) => id),
    ...Object.keys(previous.components).filter((id) => manifest.components[id] === undefined),
    ...(JSON.stringify(previous.agentComponents ?? Object.keys(previous.components)) === JSON.stringify(activeAgentComponents) ? [] : ['agent-catalog']),
    ...(workspaceRoot === (previous.workspaceRoot ?? null) ? [] : ['workspace-grant']),
    ...(releasePreparation !== null && previous.componentWarmupVersion !== COMPONENT_WARMUP_POLICY_VERSION ? ['agent-tool-warmup'] : []),
  ])]
  if (options.observabilityExpansionOnly === true) {
    const incompatibleChanges = changed.filter((id) => !OBSERVABILITY_RELEASE_COMPONENTS.includes(id))
    const sameRelease = manifest.suiteVersion === previous.suiteVersion && manifest.releaseId === previous.releaseId
    if (!sameRelease || incompatibleChanges.length > 0) {
      await cleanupMaterializedRelease(releasePreparation)
      throw new AgentHostError(
        'OBSERVABILITY_COMPATIBILITY_UPDATE_REQUIRED',
        'The installed application carries monitoring for a different compatibility release; review and update tools before turning on monitoring',
        { incompatibleChanges, sameRelease },
      )
    }
  }
  const candidateActivatedAt = new Date().toISOString()
  const candidateState = updatedInstallationState({
    previous,
    manifest,
    profile,
    availableAgentComponents,
    activeAgentComponents,
    releasePreparation,
    releaseSourceProvenance,
    hosts: previous.hosts,
    runtime: previous.runtime,
    workspaceRoot,
    activatedAt: candidateActivatedAt,
  })
  let applicationCompatibility
  try {
    applicationCompatibility = await checkApplicationState(candidateState, dependencies)
  } catch (error) {
    await cleanupMaterializedRelease(releasePreparation)
    throw error
  }
  if (options.dryRun) {
    try {
      const catalogPreflight = await (dependencies.catalogPreflight ?? preflightManagedCatalog)(agentCatalogComponents(manifest, activeAgentComponents))
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
        catalogPreflight,
        activation,
        applicationCompatibility,
      }
    } finally {
      await cleanupMaterializedRelease(releasePreparation)
    }
  }
  const rebind = dependencies.rebindObservability ?? rebindObservabilityState
  let next = null
  let activationStarted = false
  let componentWarmup = { status: 'skipped', strategy: 'no-agent-tool-fingerprint-change', components: [] }
  let catalogPreflight = null
  try {
    if (releasePreparation !== null) {
      const componentIds = previous.componentWarmupVersion === COMPONENT_WARMUP_POLICY_VERSION
        ? activeAgentComponents.filter((id) => manifest.components[id]?.fingerprint !== previous.components[id]?.fingerprint)
        : activeAgentComponents
      componentWarmup = await (dependencies.componentWarmup ?? warmInstalledAgentComponents)({
        manifest,
        componentIds,
        workspaceRoot,
      }, { probe: dependencies.mcpProbe })
    }
    catalogPreflight = await (dependencies.catalogPreflight ?? preflightManagedCatalog)(agentCatalogComponents(manifest, activeAgentComponents))
    activationStarted = true
    const activated = await activateState(paths, previous, manifest, runner, options, workspaceRoot, dependencies)
    const activatedAt = new Date().toISOString()
    next = updatedInstallationState({
      previous,
      manifest,
      profile,
      availableAgentComponents,
      activeAgentComponents,
      releasePreparation,
      releaseSourceProvenance,
      hosts: activated.hosts,
      runtime: activated.runtime,
      workspaceRoot,
      activatedAt,
    })
    if (enablingObservability) {
      next = await (dependencies.activateObservability ?? activateObservabilityState)(next, paths, runner, dependencies)
    } else if (next.observability?.enabled === true) {
      await rebind(next, paths, runner)
    }
    await (dependencies.saveState ?? saveState)(paths, next, { retainCurrent: true })
  } catch (error) {
    const rollbackFailures = []
    if (enablingObservability && next?.observability?.enabled === true) {
      try {
        await (dependencies.teardownObservability ?? teardownObservability)(next, paths, runner)
      } catch (failure) {
        rollbackFailures.push(failure)
      }
    }
    try {
      if (next !== null) {
        await uninstallService(next.runtime.service, runner)
        for (const [id, state] of Object.entries(next.hosts).reverse()) {
          await uninstallHost(id, activationRollbackState(id, state, previous.hosts[id]), runner)
        }
      }
      if (activationStarted) {
        await activateState(paths, previous, { components: previous.components, agentComponents: previous.agentComponents }, runner, options, previous.workspaceRoot ?? null, dependencies)
        if (previous.observability?.enabled === true) await rebind(previous, paths, runner)
      }
    } catch (failure) {
      rollbackFailures.push(failure)
    }
    const rollbackError = rollbackFailures.length === 0
      ? null
      : new Error(rollbackFailures.map((failure) => failure?.message ?? String(failure)).join('; '))
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
  const warnings = []
  const projectionCleanup = await committedStep(
    warnings,
    'CODEX_PROJECTION_CLEANUP_FAILED',
    'The environment update succeeded, but stale Codex projection cleanup could not be completed.',
    () => pruneStateCodexProjections(paths, next, dependencies.pruneCodexProjections),
    { status: 'not-completed', removed: 0 },
  )
  await committedStep(
    warnings,
    'ACTIVITY_LOG_WRITE_FAILED',
    'The environment update succeeded, but its activity entry could not be recorded.',
    () => (dependencies.recordActivity ?? recordActivity)(paths, 'environment.updated', changed.length === 0 ? 'Environment checked for updates' : 'Environment updated', {
      changed,
      channel: next.channel,
      releaseId: next.releaseId ?? null,
      suiteVersion: next.suiteVersion,
    }),
  )
  if (enablingObservability) await committedStep(
    warnings,
    'ACTIVITY_LOG_WRITE_FAILED',
    'Local monitoring was enabled, but its activity entry could not be recorded.',
    () => (dependencies.recordActivity ?? recordActivity)(paths, 'monitoring.enabled', 'Local monitoring turned on'),
  )
  await committedStep(
    warnings,
    'DOWNLOAD_CLEANUP_FAILED',
    'The environment update succeeded, but staged release downloads could not be discarded.',
    () => (dependencies.discardMaterializedDownloads ?? discardMaterializedDownloads)(releasePreparation),
  )
  return {
    status: 'updated',
    channel: next.channel,
    releaseId: next.releaseId ?? null,
    changed,
    componentWarmup,
    catalogPreflight,
    ...(enablingObservability ? { observability: observabilitySummary(next.observability) } : {}),
    restartRequired: Object.keys(next.hosts).length > 0,
    projectionCleanup,
    ...(warnings.length === 0 ? {} : { warnings }),
  }
}

async function verifyStateBytes(state) {
  const mismatches = []
  for (const [id, component] of Object.entries(state.components)) {
    try {
      if (component.releaseArtifact !== undefined) await verifyReleaseComponent(component)
      else if (state.channel === 'release') await verifyReleaseComponent(component)
      else if (await fingerprintIdentityFiles(component.identityFiles) !== component.fingerprint) mismatches.push(id)
    } catch {
      mismatches.push(id)
    }
  }
  return mismatches
}

async function rollbackInstallationUnlocked(options, dependencies = {}, preparedPaths = null) {
  const runner = dependencies.runner ?? runFile
  const paths = preparedPaths ?? await prepareStatePaths(resolveStateRoot(options.stateRoot))
  const current = await loadState(paths)
  if (current === null) throw new AgentHostError('NOT_INSTALLED', 'No Agent environment is installed')
  const target = await loadRollbackState(paths, current)
  if (target === null) throw new AgentHostError('ROLLBACK_UNAVAILABLE', 'No previous complete compatibility set is retained')
  const mismatches = await verifyStateBytes(target)
  if (mismatches.length > 0) {
    throw new AgentHostError('ROLLBACK_BYTES_UNAVAILABLE', 'The previous development bytes are no longer present', { components: mismatches })
  }
  const workspaceRoot = await resolveWorkspaceRoot(options.workspaceRoot ?? current.workspaceRoot)
  const candidateActivatedAt = new Date().toISOString()
  const candidateState = {
    ...target,
    hosts: target.hosts,
    runtime: target.runtime,
    updatedAt: candidateActivatedAt,
    releaseActivatedAt: candidateActivatedAt,
    bindingsActivatedAt: candidateActivatedAt,
    rolledBackFrom: current.suiteVersion,
    workspaceRoot,
    ...(target.channel === 'release' ? { componentWarmupVersion: COMPONENT_WARMUP_POLICY_VERSION } : {}),
  }
  await validateActiveComponentPathGrants({ components: target.components, agentComponents: target.agentComponents })
  const applicationCompatibility = await checkApplicationState(candidateState, dependencies)
  if (options.dryRun) return { status: 'ready', dryRun: true, targetVersion: target.suiteVersion, applicationCompatibility }
  let componentWarmup = { status: 'skipped', strategy: 'previously-warmed-release', components: [] }
  if (target.channel === 'release' && target.componentWarmupVersion !== COMPONENT_WARMUP_POLICY_VERSION) {
    const privateComponentIds = new Set(Object.entries(target.privateComponents ?? {})
      .filter(([, record]) => record?.current?.component !== undefined && record.current.component !== null)
      .map(([id]) => id))
    const componentIds = availableAgentComponents(target).filter((id) => !privateComponentIds.has(id))
    componentWarmup = await (dependencies.componentWarmup ?? warmInstalledAgentComponents)({
      manifest: target,
      componentIds,
      workspaceRoot: target.workspaceRoot ?? null,
    }, { probe: dependencies.mcpProbe })
  }
  const targetActiveComponents = target.agentComponents ?? availableAgentComponents(target)
  const catalogPreflight = await (dependencies.catalogPreflight ?? preflightManagedCatalog)(agentCatalogComponents(target, targetActiveComponents))
  let observabilityTeardown = null
  let activated = null
  let restored = null
  let mutationStarted = false
  let targetObservabilityTouched = false
  try {
    if (current.observability?.enabled === true && target.observability?.enabled !== true) {
      mutationStarted = true
      observabilityTeardown = await teardownObservability(current, paths, runner)
    }
    mutationStarted = true
    activated = await activateState(paths, current, { components: target.components, agentComponents: target.agentComponents }, runner, options, workspaceRoot, dependencies)
    const activatedAt = new Date().toISOString()
    restored = {
      ...target,
      hosts: activated.hosts,
      runtime: activated.runtime,
      updatedAt: activatedAt,
      releaseActivatedAt: activatedAt,
      bindingsActivatedAt: activatedAt,
      rolledBackFrom: current.suiteVersion,
      workspaceRoot,
      ...(target.channel === 'release' ? { componentWarmupVersion: COMPONENT_WARMUP_POLICY_VERSION } : {}),
    }
    if (restored.observability?.enabled === true) {
      targetObservabilityTouched = true
      await rebindObservabilityState(restored, paths, runner)
    }
    await (dependencies.saveState ?? saveState)(paths, restored, { retainCurrent: true })
  } catch (error) {
    let restorationError = null
    if (mutationStarted) {
      try {
        if (targetObservabilityTouched && current.observability?.enabled !== true) {
          await teardownObservability(restored ?? target, paths, runner)
        }
        await activateState(
          paths,
          { ...current, hosts: activated?.hosts ?? current.hosts, runtime: activated?.runtime ?? current.runtime },
          { components: current.components, agentComponents: current.agentComponents },
          runner,
          options,
          current.workspaceRoot ?? null,
          dependencies,
        )
        if (current.observability?.enabled === true) await rebindObservabilityState(current, paths, runner)
      } catch (failure) {
        restorationError = failure
      }
    }
    if (restorationError !== null) {
      throw new AgentHostError('ROLLBACK_RESTORATION_FAILED', 'Rollback failed and the current Agent environment could not be fully restored', {
        rollback: error.message,
        restoration: restorationError.message,
      })
    }
    throw error
  }
  const warnings = []
  const projectionCleanup = await committedStep(
    warnings,
    'CODEX_PROJECTION_CLEANUP_FAILED',
    'The environment rollback succeeded, but stale Codex projection cleanup could not be completed.',
    () => pruneStateCodexProjections(paths, restored, dependencies.pruneCodexProjections),
    { status: 'not-completed', removed: 0 },
  )
  await committedStep(
    warnings,
    'ACTIVITY_LOG_WRITE_FAILED',
    'The environment rollback succeeded, but its activity entry could not be recorded.',
    () => (dependencies.recordActivity ?? recordActivity)(paths, 'environment.rolled-back', 'Previous environment restored', {
      suiteVersion: restored.suiteVersion,
      rolledBackFrom: current.suiteVersion,
    }),
  )
  return { status: 'rolled-back', suiteVersion: restored.suiteVersion, componentWarmup, catalogPreflight, restartRequired: true, observabilityTeardown, projectionCleanup, ...(warnings.length === 0 ? {} : { warnings }) }
}

export async function toolSetStatus(options = {}) {
  const paths = await readStatePaths(resolveStateRoot(options.stateRoot))
  const state = await loadState(paths)
  if (state === null) throw new AgentHostError('NOT_INSTALLED', 'No Agent environment is installed')
  const available = availableAgentComponents(state)
  const active = state.agentComponents ?? available
  const profile = await loadProfile(state.profile)
  const defaults = profile.defaultAgentComponents.filter((id) => available.includes(id))
  return {
    schemaVersion: 'openadam.agent-host-tool-set.v0.1',
    status: 'ok',
    profile: state.profile,
    availableAgentComponents: available,
    defaultAgentComponents: defaults,
    activeAgentComponents: active,
    inactiveAgentComponents: available.filter((id) => !active.includes(id)),
    tools: available.map((id) => ({
      id,
      version: state.components[id]?.version ?? null,
      displayName: state.components[id]?.displayName ?? id,
      summary: state.components[id]?.summary ?? null,
      private: state.privateComponents?.[id]?.current?.component !== undefined,
      active: active.includes(id),
    })),
    freshSession: {
      requiredAfterChange: true,
      currentSessionUptake: 'not-observed',
    },
  }
}

async function setActiveToolsUnlocked(options, dependencies = {}, preparedPaths = null) {
  const runner = dependencies.runner ?? runFile
  const paths = preparedPaths ?? await prepareStatePaths(resolveStateRoot(options.stateRoot))
  const previous = await loadState(paths)
  if (previous === null) throw new AgentHostError('NOT_INSTALLED', 'No Agent environment is installed')
  const available = availableAgentComponents(previous)
  const profile = options.resetTools === true ? await loadProfile(previous.profile) : null
  const requested = options.resetTools === true
    ? profile.defaultAgentComponents.filter((id) => available.includes(id))
    : options.tools
  const active = selectAgentComponents(available, requested)
  const current = previous.agentComponents ?? available
  const changed = JSON.stringify(current) !== JSON.stringify(active)
  const manifest = { components: previous.components, agentComponents: active }
  const workspaceRoot = await resolveWorkspaceRoot(options.workspaceRoot ?? previous.workspaceRoot)
  await validateActiveComponentPathGrants(manifest)
  if (!changed) {
    return { ...(await toolSetStatus({ stateRoot: paths.root })), status: 'tool-set-unchanged', changed: false, restartRequired: false }
  }
  const catalogPreflight = await (dependencies.catalogPreflight ?? preflightManagedCatalog)(agentCatalogComponents(previous, active))
  if (options.dryRun === true) {
    const activation = await inspectActivation(previous, manifest, runner, options, workspaceRoot, dependencies)
    return {
      schemaVersion: 'openadam.agent-host-tool-set.v0.1', status: 'ready', dryRun: true,
      changed: true, activeAgentComponents: active,
      inactiveAgentComponents: available.filter((id) => !active.includes(id)), activation, catalogPreflight,
      restartRequired: Object.keys(previous.hosts).length > 0,
    }
  }
  const rebind = dependencies.rebindObservability ?? rebindObservabilityState
  let activated = null
  try {
    activated = await activateState(paths, previous, manifest, runner, options, workspaceRoot, dependencies)
    const activatedAt = new Date().toISOString()
    const next = {
      ...previous,
      availableAgentComponents: available,
      agentComponents: active,
      hosts: activated.hosts,
      runtime: activated.runtime,
      updatedAt: activatedAt,
      bindingsActivatedAt: activatedAt,
      workspaceRoot,
    }
    if (next.observability?.enabled === true) await rebind(next, paths, runner)
    await (dependencies.saveState ?? saveState)(paths, next)
  } catch (error) {
    let rollbackError = null
    try {
      await activateState(
        paths,
        { ...previous, hosts: activated?.hosts ?? previous.hosts, runtime: activated?.runtime ?? previous.runtime },
        { components: previous.components, agentComponents: current },
        runner,
        options,
        previous.workspaceRoot ?? null,
        dependencies,
      )
      if (previous.observability?.enabled === true) await rebind(previous, paths, runner)
    } catch (failure) {
      rollbackError = failure
    }
    if (rollbackError !== null) {
      throw new AgentHostError('TOOL_SET_CHANGE_ROLLBACK_FAILED', 'The Agent tool set change failed and the previous Agent environment could not be fully restored', {
        change: error.message,
        rollback: rollbackError.message,
      })
    }
    throw error
  }
  const warnings = []
  const projectionCleanup = await committedStep(
    warnings,
    'CODEX_PROJECTION_CLEANUP_FAILED',
    'The Agent tool set changed, but stale Codex projection cleanup could not be completed.',
    () => pruneStateCodexProjections(paths, { ...previous, hosts: activated.hosts }, dependencies.pruneCodexProjections),
    { status: 'not-completed', removed: 0 },
  )
  await committedStep(
    warnings,
    'ACTIVITY_LOG_WRITE_FAILED',
    'The Agent tool set changed, but its activity entry could not be recorded.',
    () => (dependencies.recordActivity ?? recordActivity)(paths, 'tool-set.changed', 'Agent tool availability changed', {
      activeAgentComponents: active,
      inactiveAgentComponents: available.filter((id) => !active.includes(id)),
    }),
  )
  return {
    ...(await toolSetStatus({ stateRoot: paths.root })),
    status: 'tool-set-updated', changed: true,
    catalogPreflight,
    restartRequired: Object.keys(previous.hosts).length > 0,
    projectionCleanup,
    ...(warnings.length === 0 ? {} : { warnings }),
  }
}

async function transitionComponentInventoryUnlocked(options, inventory, dependencies = {}, preparedPaths = null) {
  const runner = dependencies.runner ?? runFile
  const paths = preparedPaths ?? await prepareStatePaths(resolveStateRoot(options.stateRoot))
  const previous = await loadState(paths)
  if (previous === null) throw new AgentHostError('NOT_INSTALLED', 'No Agent environment is installed')
  const available = [...inventory.availableAgentComponents]
  const active = selectAgentComponents(available, inventory.agentComponents)
  const missing = Object.keys(inventory.components).filter((id) => inventory.components[id]?.root === undefined)
  if (missing.length > 0 || available.some((id) => inventory.components[id] === undefined)) {
    throw new AgentHostError('COMPONENT_INVENTORY_INVALID', 'The proposed component inventory is incomplete', { components: missing })
  }
  const workspaceRoot = await resolveWorkspaceRoot(options.workspaceRoot ?? previous.workspaceRoot)
  const manifest = { components: inventory.components, agentComponents: active }
  await validateActiveComponentPathGrants(manifest)
  const catalogPreflight = await (dependencies.catalogPreflight ?? preflightManagedCatalog)(agentCatalogComponents(manifest, active))
  if (options.dryRun === true) {
    return {
      status: 'ready',
      dryRun: true,
      activation: await inspectActivation(previous, manifest, runner, options, workspaceRoot, dependencies),
      availableAgentComponents: available,
      activeAgentComponents: active,
      catalogPreflight,
      restartRequired: Object.keys(previous.hosts).length > 0,
    }
  }
  const rebind = dependencies.rebindObservability ?? rebindObservabilityState
  let activated = null
  let activationStarted = false
  let next = null
  try {
    activationStarted = true
    activated = await activateState(paths, previous, manifest, runner, options, workspaceRoot, dependencies)
    const activatedAt = new Date().toISOString()
    next = {
      ...previous,
      components: inventory.components,
      availableAgentComponents: available,
      agentComponents: active,
      privateComponents: inventory.privateComponents,
      hosts: activated.hosts,
      runtime: activated.runtime,
      updatedAt: activatedAt,
      bindingsActivatedAt: activatedAt,
      workspaceRoot,
    }
    if (next.observability?.enabled === true) await rebind(next, paths, runner)
    // Private component rollback is carried by `privateComponents[*].rollback`.
    // Retaining this overlay transition in the compatibility history would let
    // `agent-host rollback` select a same-release private-component snapshot
    // instead of the previous complete compatibility set.
    await (dependencies.saveState ?? saveState)(paths, next)
  } catch (error) {
    let rollbackError = null
    try {
      if (activationStarted) {
        await activateState(
          paths,
          { ...previous, hosts: activated?.hosts ?? previous.hosts, runtime: activated?.runtime ?? previous.runtime },
          { components: previous.components, agentComponents: previous.agentComponents ?? availableAgentComponents(previous) },
          runner,
          options,
          previous.workspaceRoot ?? null,
          dependencies,
        )
        if (previous.observability?.enabled === true) await rebind(previous, paths, runner)
      }
    } catch (failure) {
      rollbackError = failure
    }
    if (rollbackError !== null) {
      throw new AgentHostError('COMPONENT_CHANGE_ROLLBACK_FAILED', 'The private component change failed and the previous Agent environment could not be fully restored', {
        change: error.message,
        rollback: rollbackError.message,
      })
    }
    throw error
  }
  let projectionCleanup
  let warnings = []
  try {
    projectionCleanup = await pruneStateCodexProjections(paths, next, dependencies.pruneCodexProjections)
  } catch {
    // Projection pruning removes only now-unreferenced Suite copies. Once the
    // host binding and state commit, a cleanup failure must not roll back the
    // host while leaving the committed state in place or report the component
    // transition itself as failed.
    projectionCleanup = { status: 'not-completed', removed: 0 }
    warnings = [{
      code: 'CODEX_PROJECTION_CLEANUP_FAILED',
      message: 'The private component change succeeded, but stale Codex projection cleanup could not be completed.',
    }]
  }
  return { next, catalogPreflight, projectionCleanup, warnings, restartRequired: Object.keys(previous.hosts).length > 0 }
}

export function safePurgeRoot(root) {
  const parsed = parse(root)
  if (root === parsed.root || root === homedir() || dirname(root) === root) return false
  return root.split(parsed.root).filter(Boolean).length >= 3
}

async function uninstallInstallationUnlocked(options, dependencies = {}, preparedPaths = null) {
  const runner = dependencies.runner ?? runFile
  const root = resolveStateRoot(options.stateRoot)
  if (options.purgeData && !safePurgeRoot(root)) {
    throw new AgentHostError('PURGE_ROOT_UNSAFE', `Refusing to recursively remove unsafe state root: ${root}`)
  }
  const paths = preparedPaths ?? await prepareStatePaths(root)
  const state = await loadState(paths)
  if (state === null) return { status: 'not-installed' }
  const results = { observability: null, service: null, hosts: {} }
  const warnings = []
  let mutationStarted = false
  let archive
  try {
    mutationStarted = true
    results.observability = await (dependencies.teardownObservability ?? teardownObservability)(state, paths, runner)
    results.service = await (dependencies.uninstallService ?? uninstallService)(state.runtime.service, runner)
    results.runtimeSocket = await (dependencies.cleanupRuntimeSocket ?? cleanupRuntimeSocket)(paths, state.runtime)
    for (const [id, host] of Object.entries(state.hosts).reverse()) {
      results.hosts[id] = await (dependencies.uninstallHost ?? uninstallHost)(id, host, runner)
    }
    await rm(paths.hostProjections, { recursive: true, force: true })
    results.hostProjections = { removed: true }
    await committedStep(
      warnings,
      'ACTIVITY_LOG_WRITE_FAILED',
      'Agent Host was removed, but its activity entry could not be recorded.',
      () => (dependencies.recordActivity ?? recordActivity)(paths, 'environment.uninstalled', 'Agent Host removed', {
        purgeData: options.purgeData,
        suiteVersion: state.suiteVersion,
      }),
    )
    archive = await (dependencies.archiveAndRemoveState ?? archiveAndRemoveState)(paths, state)
  } catch (error) {
    let rollbackError = null
    if (mutationStarted) {
      try {
        const restoredActivation = await activateState(
          paths,
          state,
          { components: state.components, agentComponents: state.agentComponents },
          runner,
          { ...options, replaceHostConflicts: true },
          state.workspaceRoot ?? null,
          { ...dependencies, allowMissingOwnedServiceState: true },
        )
        const restored = { ...state, hosts: restoredActivation.hosts, runtime: restoredActivation.runtime }
        if (restored.observability?.enabled === true) {
          await (dependencies.rebindObservability ?? rebindObservabilityState)(restored, paths, runner)
        }
        const persisted = await loadState(paths)
        if (persisted === null || state.runtime.service !== null) {
          await (dependencies.saveState ?? saveState)(paths, restored)
        } else if (restored.runtime.configPath !== state.runtime.configPath) {
          await rm(restored.runtime.configPath, { force: true })
        }
      } catch (failure) {
        rollbackError = failure
      }
    }
    if (rollbackError !== null) {
      throw new AgentHostError('UNINSTALL_ROLLBACK_FAILED', 'Agent Host removal failed and the previous environment could not be fully restored', {
        uninstall: error.message,
        rollback: rollbackError.message,
      })
    }
    throw error
  }
  return { status: 'uninstalled', purgeData: options.purgeData, archive: options.purgeData ? null : archive, results, ...(warnings.length === 0 ? {} : { warnings }) }
}

async function lockedLifecycle(options, dependencies, operation, callback) {
  const paths = statePaths(resolveStateRoot(options.stateRoot))
  return await withLifecycleMutation(paths, operation, dependencies, (lockedDependencies, preparedPaths) =>
    callback(lockedDependencies, preparedPaths))
}

export async function addHost(options, dependencies = {}) {
  return await lockedLifecycle(options, dependencies, 'agent-app.add', (locked, paths) =>
    addHostUnlocked(options, locked, paths))
}

export async function removeHost(options, dependencies = {}) {
  return await lockedLifecycle(options, dependencies, 'agent-app.remove', (locked, paths) =>
    removeHostUnlocked(options, locked, paths))
}

export async function updateInstallation(options, dependencies = {}) {
  return await lockedLifecycle(options, dependencies, 'environment.update', (locked, paths) =>
    updateInstallationUnlocked(options, locked, paths))
}

export async function rollbackInstallation(options, dependencies = {}) {
  return await lockedLifecycle(options, dependencies, 'environment.rollback', (locked, paths) =>
    rollbackInstallationUnlocked(options, locked, paths))
}

export async function preflightServiceRecovery(options) {
  let paths
  let state
  try {
    paths = await readStatePaths(resolveStateRoot(options.stateRoot))
    const stateInfo = await lstat(paths.state)
    if (stateInfo.isSymbolicLink() || !stateInfo.isFile() || stateInfo.size < 1 || stateInfo.size > 16 * 1024 * 1024
      || (typeof process.getuid === 'function' && stateInfo.uid !== process.getuid())
      || (stateInfo.mode & 0o077) !== 0) {
      throw new AgentHostError('SERVICE_RECOVERY_STATE_INVALID', 'Service recovery requires one existing private Agent Host installation state')
    }
    state = await loadState(paths)
  } catch (error) {
    if (error instanceof AgentHostError && error.code === 'SERVICE_RECOVERY_STATE_INVALID') throw error
    throw new AgentHostError('SERVICE_RECOVERY_STATE_INVALID', 'Service recovery requires one existing private Agent Host installation state')
  }
  if (state === null) {
    throw new AgentHostError('SERVICE_RECOVERY_STATE_INVALID', 'Service recovery requires one existing private Agent Host installation state')
  }

  const bundle = await loadServiceRecoveryBundle(paths.serviceRecovery, options.recovery)
  if (bundle.manifestSha256 !== options.manifestSha256) {
    throw new AgentHostError('SERVICE_RECOVERY_BUNDLE_INVALID', 'The retained service recovery bundle failed identity or content verification')
  }
  if (bundle.lifecycle.statePath !== paths.state) {
    throw new AgentHostError('SERVICE_RECOVERY_TARGET_MISMATCH', 'The retained recovery bundle belongs to another Agent Host state root')
  }
  const service = state.runtime?.service
  const targetMatches = service !== null && typeof service === 'object' && !Array.isArray(service)
    && (bundle.platform === 'darwin'
      ? service.launchAgentPath === bundle.target.launchAgentPath
        && service.socketPath === bundle.target.priorSocketPath
      : service.launcherPath === bundle.target.launcherPath
        && service.taskName === bundle.target.taskName
        && service.socketPath === bundle.target.priorSocketPath)
  if (!targetMatches) {
    throw new AgentHostError('SERVICE_RECOVERY_TARGET_MISMATCH', 'The retained recovery bundle does not match the selected Agent Host service state')
  }
  return paths.root
}

export async function recoverServiceInstallation(options, dependencies = {}) {
  const preflight = dependencies.preflightServiceRecovery ?? preflightServiceRecovery
  const stateRoot = await preflight(options)
  return await lockedLifecycle({ ...options, stateRoot }, dependencies, 'service.recover', async (locked, paths) => {
    const restore = locked.restoreServiceRecoveryBundle ?? restoreServiceRecoveryBundle
    return await restore(
      { identity: options.recovery, manifestSha256: options.manifestSha256 },
      locked.runner ?? runFile,
      {
        recoveryRoot: paths.serviceRecovery,
        platformName: locked.platformName ?? platform(),
        expectedLifecycleStatePath: paths.state,
        ...(locked.waitForEndpoint === undefined ? {} : { waitForEndpoint: locked.waitForEndpoint }),
        ...(locked.endpointReachable === undefined ? {} : { endpointReachable: locked.endpointReachable }),
      },
    )
  })
}

export async function setActiveTools(options, dependencies = {}) {
  return await lockedLifecycle(options, dependencies, 'tool-set.change', (locked, paths) =>
    setActiveToolsUnlocked(options, locked, paths))
}

export async function transitionComponentInventory(options, inventory, dependencies = {}) {
  return await lockedLifecycle(options, dependencies, 'component-inventory.change', (locked, paths) =>
    transitionComponentInventoryUnlocked(options, inventory, locked, paths))
}

export async function uninstallInstallation(options, dependencies = {}) {
  const root = resolveStateRoot(options.stateRoot)
  if (options.purgeData && !safePurgeRoot(root)) {
    throw new AgentHostError('PURGE_ROOT_UNSAFE', `Refusing to recursively remove unsafe state root: ${root}`)
  }
  const paths = statePaths(root)
  let retiredRoot = null
  const result = await withLifecycleMutation(paths, 'environment.uninstall', dependencies, async (locked, preparedPaths) => {
    const value = await uninstallInstallationUnlocked(options, locked, preparedPaths)
    if (options.purgeData) retiredRoot = await retireLifecycleRoot(locked.lifecycleLease, 'purged')
    return value
  })
  if (retiredRoot === null) return result
  try {
    await rm(retiredRoot, { recursive: true, force: false })
    return result
  } catch {
    return {
      ...result,
      warnings: [
        ...(result.warnings ?? []),
        { code: 'PURGE_DATA_CLEANUP_FAILED', message: 'Agent Host was uninstalled, but the retired private data root could not be deleted.' },
      ],
    }
  }
}
