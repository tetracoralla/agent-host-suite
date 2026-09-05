import { buildDevelopmentManifest } from './development-manifest.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHostError } from './errors.mjs'
import { inspectCodex, installCodex, uninstallCodex } from './hosts/codex.mjs'
import { materializeCodexProjections, resolveWorkspaceRoot } from './hosts/codex-projection.mjs'
import { inspectClaude, installClaude, uninstallClaude } from './hosts/claude.mjs'
import { inspectZcode, installZcode, uninstallZcode } from './hosts/zcode.mjs'
import { resolveStateRoot } from './paths.mjs'
import { runFile } from './process.mjs'
import { installService, inspectService, preflightServiceInstallation, uninstallService } from './service.mjs'
import { prepareStatePaths, loadState, saveState, statePaths, STATE_SCHEMA } from './state.mjs'
import { writeRuntimeFiles } from './runtime-config.mjs'
import { enableObservability } from './observability.mjs'
import { recordActivity } from './activity.mjs'
import { cleanupMaterializedRelease, discardMaterializedDownloads, materializeRelease } from './release-artifacts.mjs'
import { loadReleaseManifest } from './release-manifest.mjs'
import { loadReleaseProvenance } from './release-provenance.mjs'
import { OBSERVABILITY_RELEASE_COMPONENTS } from './release-manifest.mjs'
import { agentFacingManifest, hostFacingManifest, loadProfile, selectAgentComponents } from './profile.mjs'
import { installOperationsSkill, preflightOperationsSkill, uninstallOperationsSkill } from './host-operations-skill.mjs'
import {
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
import { COMPONENT_WARMUP_POLICY_VERSION, warmInstalledAgentComponents } from './component-warmup.mjs'
import { preflightManagedCatalog } from './context-exporter.mjs'
import { withLifecycleMutation } from './lifecycle-lock.mjs'

const HOSTS = new Set(['codex', 'claude', 'zcode'])
const ACTIVITY_LOG_WARNING = Object.freeze({
  code: 'ACTIVITY_LOG_WRITE_FAILED',
  message: 'The Agent Host installation succeeded, but its activity entry could not be recorded.',
})
const DOWNLOAD_CLEANUP_WARNING = Object.freeze({
  code: 'RELEASE_DOWNLOAD_CLEANUP_FAILED',
  message: 'The Agent Host installation succeeded, but one or more materialized release downloads could not be removed.',
})

function selectedHosts(hosts) {
  const values = hosts.length === 0 ? ['codex'] : hosts.flatMap((value) => value.split(',')).filter(Boolean)
  for (const host of values) if (!HOSTS.has(host)) throw new AgentHostError('HOST_UNSUPPORTED', `Unsupported host: ${host}`)
  return [...new Set(values)]
}

async function inspectHost(host, manifest, paths, runner, options, dependencies) {
  const binding = host === 'codex'
    ? await inspectCodex(manifest, runner, { replaceConflicts: options.replaceHostConflicts })
    : host === 'claude'
      ? await inspectClaude(manifest, runner, null, {
          replaceConflicts: options.replaceHostConflicts,
          workspaceRoot: options.workspaceRoot ?? null,
        })
      : await inspectZcode(manifest, runner, null, {
          replaceConflicts: options.replaceHostConflicts,
          workspaceRoot: options.workspaceRoot ?? null,
          configPath: dependencies.zcodeConfigPath,
          executable: dependencies.zcodeExecutable,
        })
  const operationsSkill = await preflightOperationsSkill(host, paths, runner, {
    homeRoot: dependencies.hostSkillHome,
    replaceConflicts: options.replaceHostConflicts,
  })
  const developerSkill = await preflightDeveloperKitSkill(host, manifest, paths, {
    homeRoot: dependencies.hostSkillHome,
    replaceConflicts: options.replaceHostConflicts,
  })
  const providerSkills = await preflightProviderSkills(host, manifest, paths, {
    homeRoot: dependencies.hostSkillHome,
    replaceConflicts: options.replaceHostConflicts,
  })
  const productSkills = await preflightProductSkills(host, manifest, paths, {
    homeRoot: dependencies.hostSkillHome,
    replaceConflicts: options.replaceHostConflicts,
  })
  return { ...binding, operationsSkill, developerSkill, providerSkills, productSkills }
}

async function installHost(host, manifest, paths, runner, options, dependencies) {
  await preflightOperationsSkill(host, paths, runner, {
    homeRoot: dependencies.hostSkillHome,
    replaceConflicts: options.replaceHostConflicts,
  })
  await preflightDeveloperKitSkill(host, manifest, paths, {
    homeRoot: dependencies.hostSkillHome,
    replaceConflicts: options.replaceHostConflicts,
  })
  await preflightProviderSkills(host, manifest, paths, {
    homeRoot: dependencies.hostSkillHome,
    replaceConflicts: options.replaceHostConflicts,
  })
  await preflightProductSkills(host, manifest, paths, {
    homeRoot: dependencies.hostSkillHome,
    replaceConflicts: options.replaceHostConflicts,
  })
  const binding = host === 'codex'
    ? await installCodex(manifest, runner, { replaceConflicts: options.replaceHostConflicts })
    : host === 'claude'
      ? await installClaude(manifest, runner, null, {
          replaceConflicts: options.replaceHostConflicts,
          workspaceRoot: options.workspaceRoot ?? null,
        })
      : await installZcode(manifest, runner, null, {
          replaceConflicts: options.replaceHostConflicts,
          workspaceRoot: options.workspaceRoot ?? null,
          configPath: dependencies.zcodeConfigPath,
          executable: dependencies.zcodeExecutable,
        })
  let operationsSkill = null
  let developerSkill = null
  let providerSkills = []
  let productSkills = []
  try {
    operationsSkill = await installOperationsSkill(host, paths, runner, null, {
      homeRoot: dependencies.hostSkillHome,
      replaceConflicts: options.replaceHostConflicts,
    })
    developerSkill = await installDeveloperKitSkill(host, manifest, paths, null, {
      homeRoot: dependencies.hostSkillHome,
      replaceConflicts: options.replaceHostConflicts,
    })
    providerSkills = await installProviderSkills(host, manifest, paths, [], {
      homeRoot: dependencies.hostSkillHome,
      replaceConflicts: options.replaceHostConflicts,
    })
    productSkills = await installProductSkills(host, manifest, paths, [], {
      homeRoot: dependencies.hostSkillHome,
      replaceConflicts: options.replaceHostConflicts,
    })
    return { ...binding, operationsSkill, developerSkill, providerSkills, productSkills }
  } catch (error) {
    await uninstallProductSkills(productSkills).catch(() => {})
    await uninstallProviderSkills(providerSkills).catch(() => {})
    await uninstallDeveloperKitSkill(developerSkill).catch(() => {})
    await uninstallOperationsSkill(operationsSkill, runner).catch(() => {})
    if (host === 'codex') await uninstallCodex(binding, runner).catch(() => {})
    else if (host === 'claude') await uninstallClaude(binding, runner).catch(() => {})
    else await uninstallZcode(binding).catch(() => {})
    throw error
  }
}

async function uninstallHost(host, state, runner) {
  const productSkills = await uninstallProductSkills(state.productSkills)
  const providerSkills = await uninstallProviderSkills(state.providerSkills)
  const developerSkill = await uninstallDeveloperKitSkill(state.developerSkill)
  const binding = host === 'codex'
    ? await uninstallCodex(state, runner)
    : host === 'claude'
      ? await uninstallClaude(state, runner)
      : await uninstallZcode(state)
  const operationsSkill = await uninstallOperationsSkill(state.operationsSkill, runner)
  return { binding, operationsSkill, developerSkill, providerSkills, productSkills }
}

async function setupUnlocked(options, dependencies = {}, preparedPaths = null) {
  const runner = dependencies.runner ?? runFile
  const profile = await loadProfile(options.profile)
  if (profile.requiresConsent && !options.enableObservability) {
    throw new AgentHostError('OBSERVABILITY_CONSENT_REQUIRED', 'The observability profile requires --enable-observability')
  }
  if (options.developmentRoot !== undefined && options.releaseManifest !== undefined) {
    throw new AgentHostError('INSTALL_SOURCE_CONFLICT', 'Choose either a release manifest or a development root, not both')
  }
  if (profile.id === 'developer' && options.developmentRoot !== undefined) {
    throw new AgentHostError('DEVELOPER_PROFILE_RELEASE_REQUIRED', 'The developer profile requires one version-bound release; it cannot expose a mutable source-root CLI')
  }
  let paths = preparedPaths
  let releasePreparation = null
  let releaseSourceProvenance = null
  let manifest
  if (options.developmentRoot !== undefined) {
    manifest = await buildDevelopmentManifest(options.developmentRoot)
  } else {
    const release = await loadReleaseManifest(options.releaseManifest)
    if (release.manifest.status === 'draft-unbound') throw new AgentHostError('RELEASE_UNBOUND', 'No verified compatibility release is bound in this build')
    const provenance = await loadReleaseProvenance(release)
    releaseSourceProvenance = {
      policy: provenance.record.policy,
      recordSha256: provenance.sha256,
      remoteConfirmedAtBuildTime: provenance.record.policy === 'remote-tagged',
    }
    paths = await prepareStatePaths(resolveStateRoot(options.stateRoot))
    if (await loadState(paths) !== null) throw new AgentHostError('ALREADY_INSTALLED', 'An Agent environment is already installed; use update')
    releasePreparation = await materializeRelease(release, paths, { runner: dependencies.artifactRunner ?? runFile, componentIds: profile.components })
    manifest = releasePreparation.manifest
    if (profile.requiresConsent) {
      const missing = OBSERVABILITY_RELEASE_COMPONENTS.filter((id) => manifest.components[id] === undefined)
      if (missing.length > 0) {
        await cleanupMaterializedRelease(releasePreparation)
        throw new AgentHostError('OBSERVABILITY_RELEASE_COMPONENTS_MISSING', 'The selected release does not include local monitoring components', { components: missing })
      }
    }
  }
  const hosts = selectedHosts(options.hosts)
  const activeAgentComponents = selectAgentComponents(
    profile.agentComponents,
    options.tools ?? profile.defaultAgentComponents,
  )
  manifest.agentComponents = activeAgentComponents
  const agentManifest = agentFacingManifest(manifest, activeAgentComponents)
  const hostManifest = hostFacingManifest(manifest, activeAgentComponents)
  const workspaceRoot = await resolveWorkspaceRoot(options.workspaceRoot)
  let codexProjectionTemporaryRoot = null
  let operationsProjectionPaths = paths
  let codexProjectionRoot = null
  let codexManifest = hostManifest
  const installedHosts = {}
  let serviceState = null
  let runtimeFiles = null
  let componentWarmup = { status: 'skipped', strategy: 'development-installation', components: [] }
  let catalogPreflight = null
  try {
    if (options.dryRun) {
      const temporaryRoot = await mkdtemp(join(tmpdir(), 'agent-host-operations-projection-'))
      operationsProjectionPaths = {
        hostProjections: temporaryRoot,
        backups: join(temporaryRoot, 'backups'),
      }
    } else {
      paths ??= await prepareStatePaths(resolveStateRoot(options.stateRoot))
      operationsProjectionPaths = paths
    }
    if (hosts.includes('codex')) {
      if (options.dryRun) {
        codexProjectionTemporaryRoot = await mkdtemp(join(tmpdir(), 'agent-host-codex-projection-'))
        codexProjectionRoot = codexProjectionTemporaryRoot
      } else {
        paths ??= await prepareStatePaths(resolveStateRoot(options.stateRoot))
        if (await loadState(paths) !== null) throw new AgentHostError('ALREADY_INSTALLED', 'An Agent environment is already installed; use update')
        codexProjectionRoot = join(paths.hostProjections, 'codex')
      }
      codexManifest = await materializeCodexProjections(hostManifest, codexProjectionRoot, workspaceRoot)
    }
    const preflight = {}
    for (const host of hosts) preflight[host] = await inspectHost(host, host === 'codex' ? codexManifest : hostManifest, operationsProjectionPaths, runner, { ...options, workspaceRoot }, dependencies)
    const servicePreflight = options.noService ? null : await preflightServiceInstallation(runner)
    if (options.dryRun) {
      catalogPreflight = await (dependencies.catalogPreflight ?? preflightManagedCatalog)(Object.fromEntries(
        activeAgentComponents.map((id) => [id, manifest.components[id]]),
      ))
      await cleanupMaterializedRelease(releasePreparation)
      if (codexProjectionTemporaryRoot !== null) await rm(codexProjectionTemporaryRoot, { recursive: true, force: true })
      await rm(operationsProjectionPaths.hostProjections, { recursive: true, force: true })
      return {
        status: 'ready', dryRun: true, profile: profile.id, profileDisplayName: profile.displayName,
        hosts: preflight, service: servicePreflight, components: manifest.components,
        availableAgentComponents: profile.agentComponents, agentComponents: activeAgentComponents,
        catalogPreflight,
      }
    }
    paths ??= await prepareStatePaths(resolveStateRoot(options.stateRoot))
    if (await loadState(paths) !== null) throw new AgentHostError('ALREADY_INSTALLED', 'An Agent environment is already installed; use update')
    if (releasePreparation !== null) {
      componentWarmup = await (dependencies.componentWarmup ?? warmInstalledAgentComponents)({
        manifest,
        componentIds: activeAgentComponents,
        workspaceRoot,
      }, { probe: dependencies.mcpProbe })
    }
    catalogPreflight = await (dependencies.catalogPreflight ?? preflightManagedCatalog)(Object.fromEntries(
      activeAgentComponents.map((id) => [id, manifest.components[id]]),
    ))
    runtimeFiles = await (dependencies.writeRuntimeFiles ?? writeRuntimeFiles)(paths, manifest, { workspaceRoot })
    for (const host of hosts) installedHosts[host] = await installHost(host, host === 'codex' ? codexManifest : hostManifest, paths, runner, { ...options, workspaceRoot }, dependencies)
    if (!options.noService) {
      serviceState = await installService(manifest.components['direct-execution-runtime'], runtimeFiles, runner, null, {
        recoveryRoot: paths.serviceRecovery,
      })
    }
    const now = new Date().toISOString()
    const state = {
      schemaVersion: STATE_SCHEMA,
      suiteVersion: manifest.suiteVersion,
      channel: manifest.channel,
      profile: profile.id,
      installedAt: now,
      updatedAt: now,
      releaseActivatedAt: now,
      bindingsActivatedAt: now,
      ...(manifest.developmentRoot === undefined ? {} : { developmentRoot: manifest.developmentRoot }),
      workspaceRoot,
      ...(releasePreparation === null ? {} : {
        releaseId: manifest.releaseId,
        releaseManifest: releasePreparation.release,
        releaseSourceProvenance,
      }),
      components: manifest.components,
      availableAgentComponents: profile.agentComponents,
      agentComponents: activeAgentComponents,
      ...(releasePreparation === null ? {} : { componentWarmupVersion: COMPONENT_WARMUP_POLICY_VERSION }),
      hosts: installedHosts,
      runtime: { ...runtimeFiles, service: serviceState },
      observability: { enabled: false },
    }
    await (dependencies.saveState ?? saveState)(paths, state)
    const warnings = []
    try {
      await (dependencies.recordActivity ?? recordActivity)(paths, 'environment.installed', 'Standard tools installed', {
        profile: state.profile,
        hosts: Object.keys(installedHosts),
        suiteVersion: state.suiteVersion,
      })
    } catch {
      warnings.push(ACTIVITY_LOG_WARNING)
    }
    try {
      await (dependencies.discardMaterializedDownloads ?? discardMaterializedDownloads)(releasePreparation)
    } catch {
      warnings.push(DOWNLOAD_CLEANUP_WARNING)
    }
    if (profile.requiresConsent) {
      const enabled = await enableObservability({ stateRoot: paths.root }, { ...dependencies, runner })
      warnings.push(...(enabled.warnings ?? []))
      return { status: 'installed', stateRoot: paths.root, profile: enabled.profile, hosts: Object.keys(installedHosts), service: serviceState, observability: enabled.observability, componentWarmup, catalogPreflight, restartRequired: hosts.length > 0, ...(warnings.length === 0 ? {} : { warnings }) }
    }
    return { status: 'installed', stateRoot: paths.root, profile: state.profile, hosts: Object.keys(installedHosts), service: serviceState, componentWarmup, catalogPreflight, restartRequired: hosts.length > 0, ...(warnings.length === 0 ? {} : { warnings }) }
  } catch (error) {
    const rollback = []
    const rollbackStep = async (step, task) => {
      try {
        await task()
      } catch (failure) {
        rollback.push({ step, message: failure.message })
      }
    }
    if (serviceState !== null) await rollbackStep('service.uninstall', () => (dependencies.uninstallService ?? uninstallService)(serviceState, runner))
    for (const [host, state] of Object.entries(installedHosts).reverse()) {
      await rollbackStep(`host.${host}.uninstall`, () => (dependencies.uninstallHost ?? uninstallHost)(host, state, runner))
    }
    if (rollback.length === 0 && paths !== null) {
      await rollbackStep('state.remove', () => rm(paths.state, { force: true }))
      await rollbackStep('host-projections.remove', () => rm(paths.hostProjections, { recursive: true, force: true }))
      if (runtimeFiles !== null) await rollbackStep('runtime-config.remove', () => rm(runtimeFiles.configPath, { force: true }))
    }
    if (codexProjectionTemporaryRoot !== null) {
      await rollbackStep('temporary-codex-projection.remove', () => rm(codexProjectionTemporaryRoot, { recursive: true, force: true }))
    }
    if (options.dryRun && operationsProjectionPaths !== null) {
      await rollbackStep('temporary-operations-projection.remove', () => rm(operationsProjectionPaths.hostProjections, { recursive: true, force: true }))
    }
    if (rollback.length === 0) {
      await rollbackStep('release-materialization.remove', () => (dependencies.cleanupMaterializedRelease ?? cleanupMaterializedRelease)(releasePreparation))
    }
    if (rollback.length > 0) {
      throw new AgentHostError('SETUP_ROLLBACK_FAILED', 'Setup failed and its partial installation could not be fully removed', {
        setup: error.message,
        rollback,
        retainedReleasePackages: releasePreparation?.createdRoots ?? [],
      })
    }
    throw error
  }
}

export async function setup(options, dependencies = {}) {
  const root = resolveStateRoot(options.stateRoot)
  const paths = statePaths(root)
  return await withLifecycleMutation(paths, 'environment.setup', dependencies, (lockedDependencies, preparedPaths) =>
    setupUnlocked(options, lockedDependencies, preparedPaths))
}

export async function servicePreflight(state, runner = runFile) {
  return inspectService(state.runtime.service, runner)
}
