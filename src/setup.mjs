import { buildDevelopmentManifest } from './development-manifest.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHostError } from './errors.mjs'
import { inspectCodex, installCodex, uninstallCodex } from './hosts/codex.mjs'
import { materializeCodexProjections, resolveWorkspaceRoot } from './hosts/codex-projection.mjs'
import { inspectClaude, installClaude, uninstallClaude } from './hosts/claude.mjs'
import { resolveStateRoot } from './paths.mjs'
import { runFile } from './process.mjs'
import { installService, inspectService, preflightServiceInstallation, uninstallService } from './service.mjs'
import { prepareStatePaths, loadState, saveState, STATE_SCHEMA } from './state.mjs'
import { writeRuntimeFiles } from './runtime-config.mjs'
import { enableObservability } from './observability.mjs'
import { recordActivity } from './activity.mjs'
import { cleanupMaterializedRelease, discardMaterializedDownloads, materializeRelease } from './release-artifacts.mjs'
import { loadReleaseManifest } from './release-manifest.mjs'
import { OBSERVABILITY_RELEASE_COMPONENTS } from './release-manifest.mjs'
import { agentFacingManifest, loadProfile, selectAgentComponents } from './profile.mjs'
import { installOperationsSkill, preflightOperationsSkill, uninstallOperationsSkill } from './host-operations-skill.mjs'

const HOSTS = new Set(['codex', 'claude'])

function selectedHosts(hosts) {
  const values = hosts.length === 0 ? ['codex'] : hosts.flatMap((value) => value.split(',')).filter(Boolean)
  for (const host of values) if (!HOSTS.has(host)) throw new AgentHostError('HOST_UNSUPPORTED', `Unsupported host: ${host}`)
  return [...new Set(values)]
}

async function inspectHost(host, manifest, paths, runner, options, dependencies) {
  const binding = host === 'codex'
    ? await inspectCodex(manifest, runner, { replaceConflicts: options.replaceHostConflicts })
    : await inspectClaude(manifest, runner)
  const operationsSkill = await preflightOperationsSkill(host, paths, runner, {
    homeRoot: dependencies.hostSkillHome,
    replaceConflicts: options.replaceHostConflicts,
  })
  return { ...binding, operationsSkill }
}

async function installHost(host, manifest, paths, runner, options, dependencies) {
  await preflightOperationsSkill(host, paths, runner, {
    homeRoot: dependencies.hostSkillHome,
    replaceConflicts: options.replaceHostConflicts,
  })
  const binding = host === 'codex'
    ? await installCodex(manifest, runner, { replaceConflicts: options.replaceHostConflicts })
    : await installClaude(manifest, runner, null, { replaceConflicts: options.replaceHostConflicts })
  try {
    const operationsSkill = await installOperationsSkill(host, paths, runner, null, {
      homeRoot: dependencies.hostSkillHome,
      replaceConflicts: options.replaceHostConflicts,
    })
    return { ...binding, operationsSkill }
  } catch (error) {
    if (host === 'codex') await uninstallCodex(binding, runner).catch(() => {})
    else await uninstallClaude(binding, runner).catch(() => {})
    throw error
  }
}

async function uninstallHost(host, state, runner) {
  const binding = host === 'codex' ? await uninstallCodex(state, runner) : await uninstallClaude(state, runner)
  const operationsSkill = await uninstallOperationsSkill(state.operationsSkill, runner)
  return { binding, operationsSkill }
}

export async function setup(options, dependencies = {}) {
  const runner = dependencies.runner ?? runFile
  const profile = await loadProfile(options.profile)
  if (profile.requiresConsent && !options.enableObservability) {
    throw new AgentHostError('OBSERVABILITY_CONSENT_REQUIRED', 'The observability profile requires --enable-observability')
  }
  if (options.developmentRoot !== undefined && options.releaseManifest !== undefined) {
    throw new AgentHostError('INSTALL_SOURCE_CONFLICT', 'Choose either a release manifest or a development root, not both')
  }
  let paths = null
  let releasePreparation = null
  let manifest
  if (options.developmentRoot !== undefined) {
    manifest = await buildDevelopmentManifest(options.developmentRoot)
  } else {
    const release = await loadReleaseManifest(options.releaseManifest)
    if (release.manifest.status === 'draft-unbound') throw new AgentHostError('RELEASE_UNBOUND', 'No verified compatibility release is bound in this build')
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
  const activeAgentComponents = selectAgentComponents(profile.agentComponents, options.tools)
  const agentManifest = agentFacingManifest(manifest, activeAgentComponents)
  const workspaceRoot = await resolveWorkspaceRoot(options.workspaceRoot)
  let codexProjectionTemporaryRoot = null
  let operationsProjectionPaths = paths
  let codexProjectionRoot = null
  let codexManifest = agentManifest
  const installedHosts = {}
  let serviceState = null
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
      codexManifest = await materializeCodexProjections(agentManifest, codexProjectionRoot, workspaceRoot)
    }
    const preflight = {}
    for (const host of hosts) preflight[host] = await inspectHost(host, host === 'codex' ? codexManifest : agentManifest, operationsProjectionPaths, runner, options, dependencies)
    const servicePreflight = options.noService ? null : await preflightServiceInstallation(runner)
    if (options.dryRun) {
      await cleanupMaterializedRelease(releasePreparation)
      if (codexProjectionTemporaryRoot !== null) await rm(codexProjectionTemporaryRoot, { recursive: true, force: true })
      await rm(operationsProjectionPaths.hostProjections, { recursive: true, force: true })
      return {
        status: 'ready', dryRun: true, profile: profile.id, profileDisplayName: profile.displayName,
        hosts: preflight, service: servicePreflight, components: manifest.components,
        availableAgentComponents: profile.agentComponents, agentComponents: activeAgentComponents,
      }
    }
    paths ??= await prepareStatePaths(resolveStateRoot(options.stateRoot))
    if (await loadState(paths) !== null) throw new AgentHostError('ALREADY_INSTALLED', 'An Agent environment is already installed; use update')
    const runtimeFiles = await writeRuntimeFiles(paths, manifest)
    for (const host of hosts) installedHosts[host] = await installHost(host, host === 'codex' ? codexManifest : agentManifest, paths, runner, options, dependencies)
    if (!options.noService) {
      serviceState = await installService(manifest.components['direct-execution-runtime'], runtimeFiles, runner)
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
      ...(releasePreparation === null ? {} : { releaseId: manifest.releaseId, releaseManifest: releasePreparation.release }),
      components: manifest.components,
      availableAgentComponents: profile.agentComponents,
      agentComponents: activeAgentComponents,
      hosts: installedHosts,
      runtime: { ...runtimeFiles, service: serviceState },
      observability: { enabled: false },
    }
    await saveState(paths, state)
    await recordActivity(paths, 'environment.installed', 'Standard tools installed', {
      profile: state.profile,
      hosts: Object.keys(installedHosts),
      suiteVersion: state.suiteVersion,
    })
    await discardMaterializedDownloads(releasePreparation)
    if (profile.requiresConsent) {
      const enabled = await enableObservability({ stateRoot: paths.root }, { runner })
      return { status: 'installed', stateRoot: paths.root, profile: enabled.profile, hosts: Object.keys(installedHosts), service: serviceState, observability: enabled.observability, restartRequired: hosts.length > 0 }
    }
    return { status: 'installed', stateRoot: paths.root, profile: state.profile, hosts: Object.keys(installedHosts), service: serviceState, restartRequired: hosts.length > 0 }
  } catch (error) {
    if (serviceState !== null) await uninstallService(serviceState, runner).catch(() => {})
    for (const [host, state] of Object.entries(installedHosts).reverse()) {
      await uninstallHost(host, state, runner).catch(() => {})
    }
    if (paths !== null) {
      const { rm } = await import('node:fs/promises')
      await rm(paths.state, { force: true }).catch(() => {})
      await rm(paths.hostProjections, { recursive: true, force: true }).catch(() => {})
    }
    if (codexProjectionTemporaryRoot !== null) await rm(codexProjectionTemporaryRoot, { recursive: true, force: true }).catch(() => {})
    if (options.dryRun && operationsProjectionPaths !== null) await rm(operationsProjectionPaths.hostProjections, { recursive: true, force: true }).catch(() => {})
    await cleanupMaterializedRelease(releasePreparation)
    throw error
  }
}

export async function servicePreflight(state, runner = runFile) {
  return inspectService(state.runtime.service, runner)
}
