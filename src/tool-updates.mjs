import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, rm, rmdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { AgentHostError } from './errors.mjs'
import { admitGitHubRelease, browseRecommendedTools, previewGitHubProject, supportedReleasePlatform } from './github-project.mjs'
import { fetchGitHubRelease, selectReleaseAsset } from './github-api.mjs'
import { findCatalogTool, findRegisteredTool, loadGitHubToolCatalog } from './github-registry.mjs'
import { materializeObservedLocalComponentArtifact, observeLocalComponentArtifact } from './release-artifacts.mjs'
import { currentReleasePlatformOrLocal } from './release-manifest.mjs'
import { materializeToolComponent } from './tool-component.mjs'
import { probeMcpToolsFirstAndRepeat } from './mcp-health.mjs'
import { resolveStateRoot } from './paths.mjs'
import { loadState, prepareStatePaths, statePaths } from './state.mjs'
import { transitionComponentInventory } from './lifecycle.mjs'
import { isAgentToolsPaused } from './profile.mjs'
import { recordActivity } from './activity.mjs'
import { assertCompatibleOrigin, githubOrigin, originIdentity, readToolSources, writeToolSources } from './tool-sources.mjs'
import { candidateFromRemote, clearUpdateCandidate, mergeUpdateCandidates, readUpdateCandidates, sameCandidateCacheIdentity } from './update-candidates.mjs'
import { compareSemVer } from './semver.mjs'
import { isSpdxExpressionSyntax } from './spdx-expression.mjs'
import { presentInstalledLogo } from './tool-presentation.mjs'
import { withLifecycleMutation } from './lifecycle-lock.mjs'

export const TOOL_UPDATE_SCHEMA = 'openadam.agent-host-tool-update.v0.1'
const PRIVATE_COMPONENT_STATE_SCHEMA = 'openadam.agent-host-private-component-state.v0.1'

function fail(code, message, details) {
  throw new AgentHostError(code, message, details)
}

function compareVersions(left, right) {
  return compareSemVer(left, right)
}

function inventoryFromState(state) {
  return {
    components: { ...state.components },
    availableAgentComponents: [...(state.availableAgentComponents ?? Object.keys(state.components))],
    agentComponents: [...(state.agentComponents ?? [])],
    privateComponents: structuredClone(state.privateComponents ?? {}),
    agentToolsPaused: state.agentToolsPaused === true,
    resumeAgentComponents: [...(state.resumeAgentComponents ?? [])],
  }
}

function samePackageRoot(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  return left === right
}

function packageIsReferenced(state, packageRoot) {
  if (state === null || state === undefined || typeof packageRoot !== 'string') return false
  for (const component of Object.values(state.components ?? {})) {
    if (samePackageRoot(component?.root, packageRoot)) return true
  }
  for (const record of Object.values(state.privateComponents ?? {})) {
    if (samePackageRoot(record?.current?.component?.root, packageRoot)) return true
    if (samePackageRoot(record?.rollback?.component?.root, packageRoot)) return true
  }
  return false
}

async function deletePackageTree(installedRoot) {
  const packageRoot = dirname(installedRoot)
  await rm(installedRoot, { recursive: true, force: true })
  try {
    await rmdir(packageRoot)
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error
  }
}

async function cleanupUnadoptedPackage(prepared, preparedPaths = null) {
  if (prepared?.installed?.created !== true) return
  const installedRoot = prepared.installed.root
  // Serialize with commit: another install may be adopting this shared package
  // before its new state refs are written. Without the lifecycle lock, reclaim
  // would delete mid-commit. When the lock is busy, retain reclaimable packages.
  if (preparedPaths === null) {
    await deletePackageTree(installedRoot)
    return
  }
  try {
    await withLifecycleMutation(
      statePaths(preparedPaths.root),
      'tool.package-cleanup',
      {},
      async (_dependencies, lockedPaths) => {
        const state = await loadState(lockedPaths).catch(() => null)
        if (packageIsReferenced(state, installedRoot)) return
        await deletePackageTree(installedRoot)
      },
    )
  } catch (error) {
    if (error instanceof AgentHostError && error.code === 'LIFECYCLE_BUSY') return
    throw error
  }
}

function bindingFromComponent(component) {
  const release = component?.releaseArtifact
  if (release === null || typeof release !== 'object') return null
  return {
    archiveSha256: release.artifact?.sha256,
    archiveBytes: release.artifact?.bytes,
    descriptorSha256: release.descriptorSha256,
    id: release.id,
    version: release.version,
    platform: release.platform,
    spdx: release.license?.spdx,
  }
}

async function runtimeFromWrapped(wrapped, observation) {
  const binding = {
    archiveSha256: observation.observed.archiveSha256,
    archiveBytes: observation.observed.archiveBytes,
    descriptorSha256: observation.observed.descriptorSha256,
    id: observation.descriptor.id,
    version: observation.descriptor.version,
    platform: currentReleasePlatformOrLocal(),
    spdx: wrapped.contract.licenseSpdx,
  }
  if (!isSpdxExpressionSyntax(binding.spdx)) fail('LOCAL_COMPONENT_SPDX_REQUIRED', 'GitHub install requires a valid SPDX license expression')
  return { binding, observation }
}

export function updateAvailability({ installedVersion, availableVersion, compatible = true, platformAvailable = true }) {
  if (platformAvailable !== true) return 'no-platform-asset'
  if (installedVersion === null || installedVersion === undefined) return 'not-installed'
  if (availableVersion === null || availableVersion === undefined) return 'current'
  if (compatible !== true) return 'compatible-after-host-update'
  const comparison = compareVersions(installedVersion, availableVersion)
  if (comparison < 0) return 'update-available'
  if (comparison > 0) return 'newer-than-catalog'
  return 'current'
}

async function resolveRemoteCandidate(origin, catalogEntry, { fetch, signal, channel = 'stable', platform } = {}) {
  const repository = origin?.repository ?? catalogEntry?.repository
  const fetchImpl = fetch ?? globalThis.fetch
  if (typeof repository !== 'string') {
    return {
      availableVersion: catalogEntry?.version ?? null,
      tag: catalogEntry?.tag ?? null,
      compatible: true,
      platformAvailable: catalogEntry === undefined || platform === null ? true : catalogEntry.platforms?.[platform] != null,
      from: catalogEntry === undefined ? null : 'catalog',
      error: null,
    }
  }
  try {
    const release = await fetchGitHubRelease(repository, channel === 'preview' ? null : 'latest', { fetch: fetchImpl, signal })
    const remoteVersion = release.tag.replace(/^v/u, '')
    if (catalogEntry !== undefined) {
      const catalogNewer = compareVersions(catalogEntry.version, remoteVersion) >= 0
      const platformAsset = platform === null ? null : catalogEntry.platforms?.[platform] ?? null
      if (catalogNewer) {
        return {
          availableVersion: catalogEntry.version,
          tag: catalogEntry.tag,
          compatible: true,
          platformAvailable: platform === null ? true : platformAsset !== null,
          from: 'catalog',
          remoteVersion,
          digest: platformAsset?.sha256 ?? null,
          assetName: platformAsset?.assetName ?? null,
          assetUrl: platformAsset?.url ?? null,
          assetBytes: platformAsset?.bytes ?? null,
          releaseUrl: catalogEntry.releaseUrl,
          error: null,
        }
      }
      const remoteAsset = (() => {
        try {
          return selectReleaseAsset(release, { platform })
        } catch {
          return null
        }
      })()
      return {
        availableVersion: remoteVersion,
        tag: release.tag,
        compatible: false,
        platformAvailable: platform === null ? true : remoteAsset !== null,
        from: 'github',
        remoteVersion,
        // Keep version/tag/digest/asset fields from the same remote release.
        // Do not pair a newer GitHub version with older catalog asset metadata.
        digest: remoteAsset?.digest ?? null,
        assetName: remoteAsset?.name ?? null,
        assetUrl: remoteAsset?.url ?? null,
        assetBytes: remoteAsset?.bytes ?? null,
        releaseUrl: release.htmlUrl,
        error: null,
      }
    }
    const asset = (() => {
      try {
        return selectReleaseAsset(release, { platform })
      } catch {
        return null
      }
    })()
    return {
      availableVersion: remoteVersion,
      tag: release.tag,
      compatible: true,
      platformAvailable: platform === null ? true : asset !== null,
      from: 'github',
      remoteVersion,
      digest: asset?.digest ?? null,
      assetName: asset?.name ?? null,
      assetUrl: asset?.url ?? null,
      assetBytes: asset?.bytes ?? null,
      releaseUrl: release.htmlUrl,
      error: null,
    }
  } catch (error) {
    if (catalogEntry !== undefined) {
      const platformAsset = platform === null ? null : catalogEntry.platforms?.[platform] ?? null
      return {
        availableVersion: catalogEntry.version,
        tag: catalogEntry.tag,
        compatible: true,
        platformAvailable: platform === null ? true : platformAsset !== null,
        from: 'catalog',
        digest: platformAsset?.sha256 ?? null,
        assetName: platformAsset?.assetName ?? null,
        assetUrl: platformAsset?.url ?? null,
        assetBytes: platformAsset?.bytes ?? null,
        releaseUrl: catalogEntry.releaseUrl,
        error: { code: error instanceof AgentHostError ? error.code : 'GITHUB_REQUEST_FAILED', message: error instanceof Error ? error.message : String(error) },
      }
    }
    return {
      availableVersion: null,
      tag: origin?.tag ?? null,
      compatible: true,
      platformAvailable: true,
      from: 'github',
      error: { code: error instanceof AgentHostError ? error.code : 'GITHUB_REQUEST_FAILED', message: error instanceof Error ? error.message : String(error) },
    }
  }
}

async function presentLogo(component, catalogEntry) {
  return presentInstalledLogo(component, catalogEntry?.presentation?.logo ?? null)
}

async function persistInspectedCandidates(stateRoot, items, catalogSource, dependencies) {
  const candidatePatch = {}
  for (const item of items) {
    if (item.candidate === null || item.candidate === undefined) continue
    candidatePatch[item.id] = item.candidate
  }
  await mergeUpdateCandidates(stateRoot, {
    catalog: catalogSource,
    tools: candidatePatch,
  }, dependencies)
  const applySources = async () => {
    const current = await readToolSources(stateRoot)
    if (current.recoveredInvalid === true) return
    const tools = { ...current.tools }
    let changed = false
    for (const item of items) {
      if (tools[item.id]?.origin === undefined) continue
      tools[item.id] = { ...tools[item.id], lastCheck: item.lastCheck }
      changed = true
    }
    if (changed) await writeToolSources(stateRoot, { tools })
  }
  try {
    if (dependencies.lifecycleLease !== undefined) await applySources()
    else {
      await withLifecycleMutation(statePaths(resolveStateRoot(stateRoot)), 'updates.inspect', dependencies, applySources)
    }
  } catch (error) {
    if (!(error instanceof AgentHostError && error.code === 'LIFECYCLE_BUSY')) {
      // lastCheck is advisory; inventory and candidates remain authoritative.
    }
  }
}

export async function inspectToolUpdates(stateRoot, { fetch, signal, catalog, channel = 'stable', persist = true } = {}, dependencies = {}) {
  const paths = await prepareStatePaths(resolveStateRoot(stateRoot))
  const state = await loadState(paths)
  const sources = await readToolSources(stateRoot)
  const persisted = persist === true ? await readUpdateCandidates(stateRoot) : { catalog: null, tools: {} }
  let catalogSource = persisted.catalog ?? null
  const pinned = catalog ?? await loadGitHubToolCatalog({
    fetch,
    signal,
    onFetched: async (live) => {
      catalogSource = {
        kind: live.source.kind,
        repository: live.source.repository,
        tag: live.source.tag,
        assetName: live.source.assetName,
        digest: live.source.digest,
        fetchedAt: live.source.fetchedAt,
        catalogId: live.catalog.catalogId,
      }
    },
  })
  const platform = supportedReleasePlatform()
  const ids = new Set([
    ...Object.keys(state?.components ?? {}),
    ...Object.keys(sources.tools ?? {}),
    ...pinned.tools.map((tool) => tool.id),
  ])
  const items = []
  for (const id of [...ids].sort()) {
    const component = state?.components?.[id]
    const source = sources.tools?.[id]
    const catalogEntry = pinned.tools.find((tool) => tool.id === id)
    const origin = source?.origin ?? component?.origin ?? (catalogEntry === undefined ? null : githubOrigin({
      repository: catalogEntry.repository,
      tag: catalogEntry.tag,
      releaseUrl: catalogEntry.releaseUrl,
      assetName: catalogEntry.platforms?.[platform]?.assetName,
      assetUrl: catalogEntry.platforms?.[platform]?.url,
      assetSha256: catalogEntry.platforms?.[platform]?.sha256,
      assetBytes: catalogEntry.platforms?.[platform]?.bytes,
    }))
    const remote = origin === null && catalogEntry === undefined
      ? { availableVersion: null, tag: null, compatible: true, platformAvailable: true, from: null, error: null }
      : await resolveRemoteCandidate(origin, catalogEntry, { fetch, signal, channel, platform })
    const availableVersion = remote.availableVersion
    const availability = remote.error !== null && availableVersion === null
      ? 'check-failed'
      : updateAvailability({
        installedVersion: component?.version ?? null,
        availableVersion,
        compatible: remote.compatible,
        platformAvailable: remote.platformAvailable,
      })
    const lastCheck = {
      at: new Date().toISOString(),
      status: remote.error === null ? availability : 'check-failed',
      availableVersion,
      from: remote.from,
      ...(remote.error === null ? {} : { error: remote.error }),
    }
    let candidate = remote.tag === undefined || remote.tag === null ? null : candidateFromRemote(remote, {
      platform,
      catalogId: pinned.catalogId ?? null,
    })
    const previousCandidate = persisted.tools?.[id]
    if (
      candidate !== null
      && previousCandidate !== undefined
      && typeof previousCandidate.downloadedPath === 'string'
      && sameCandidateCacheIdentity(previousCandidate, candidate)
    ) {
      candidate = {
        ...candidate,
        downloadedPath: previousCandidate.downloadedPath,
        wrappedDigest: previousCandidate.wrappedDigest ?? candidate.wrappedDigest,
        upstreamDigest: previousCandidate.upstreamDigest ?? candidate.upstreamDigest ?? candidate.digest,
      }
    } else if (
      candidate !== null
      && previousCandidate !== undefined
      && typeof previousCandidate.downloadedPath === 'string'
    ) {
      // Same tag can be reissued with different upstream bytes. Never present a
      // new candidate.digest while still bound to an old Host-managed cache.
      candidate = {
        ...candidate,
        downloadedPath: null,
        wrappedDigest: null,
        upstreamDigest: candidate.upstreamDigest ?? candidate.digest ?? null,
      }
    }
    items.push({
      kind: 'tool',
      id,
      displayName: component?.displayName ?? catalogEntry?.presentation?.displayName ?? id,
      summary: component?.summary ?? catalogEntry?.presentation?.summary ?? null,
      author: component?.author ?? catalogEntry?.presentation?.author ?? null,
      homepage: component?.homepage ?? `https://github.com/${origin?.repository ?? catalogEntry?.repository ?? ''}`,
      logo: await presentLogo(component, catalogEntry),
      installedVersion: component?.version ?? null,
      availableVersion,
      availability,
      source: origin === null ? null : {
        kind: origin.kind,
        repository: origin.repository,
        tag: remote.tag ?? origin.tag,
        releaseUrl: remote.releaseUrl ?? origin.releaseUrl,
        identity: originIdentity(origin),
      },
      lastCheck,
      restartRequired: component !== undefined && availability === 'update-available',
      paused: state?.agentToolsPaused === true,
      active: state?.agentComponents?.includes(id) === true,
      candidate,
    })
  }
  if (persist === true && stateRoot !== undefined) {
    await persistInspectedCandidates(stateRoot, items, catalogSource, dependencies)
  }
  return items
}

export async function checkRegisteredTool(id, { fetch, signal, channel = 'stable', stateRoot } = {}) {
  const persisted = stateRoot === undefined ? null : (await readUpdateCandidates(stateRoot)).tools?.[id]
  if (persisted?.version !== undefined && persisted.version !== null && persisted.tag !== null) {
    return {
      id,
      repository: persisted.releaseUrl ?? persisted.from,
      tag: persisted.tag,
      version: persisted.version,
      prerelease: false,
      htmlUrl: persisted.releaseUrl,
      from: persisted.from ?? 'candidate',
      compatible: persisted.compatible,
      platformAvailable: persisted.platformAvailable,
      digest: persisted.digest ?? null,
    }
  }
  const registration = await findRegisteredTool(id)
  const catalogEntry = await findCatalogTool(id, { fetch, signal })
  const saved = stateRoot === undefined ? null : (await readToolSources(stateRoot)).tools?.[id]
  const repository = registration?.repository ?? catalogEntry?.repository ?? saved?.origin?.repository
  if (typeof repository !== 'string') fail('GITHUB_TOOL_UNKNOWN', `No GitHub registration for ${id}`)
  try {
    const release = await fetchGitHubRelease(repository, channel === 'preview' ? null : 'latest', { fetch: fetch ?? globalThis.fetch, signal })
    return {
      id,
      repository,
      tag: release.tag,
      version: release.tag.replace(/^v/u, ''),
      prerelease: release.prerelease,
      htmlUrl: release.htmlUrl,
      from: 'github',
    }
  } catch (error) {
    if (catalogEntry !== undefined) {
      return {
        id,
        repository,
        tag: catalogEntry.tag,
        version: catalogEntry.version,
        prerelease: false,
        htmlUrl: catalogEntry.releaseUrl,
        from: 'catalog',
        checkError: { code: error instanceof AgentHostError ? error.code : 'GITHUB_REQUEST_FAILED', message: error instanceof Error ? error.message : String(error) },
      }
    }
    throw error
  }
}

function applyPausedWorkingSet(inventory, state, id, { activate, isNew }) {
  const paused = isAgentToolsPaused(state)
  const resume = [...(state.resumeAgentComponents ?? [])]
  const wasInResume = resume.includes(id)
  const wasActive = paused ? wasInResume : inventory.agentComponents.includes(id)
  if (!inventory.availableAgentComponents.includes(id)) inventory.availableAgentComponents.push(id)
  if (paused) {
    inventory.agentComponents = inventory.agentComponents.filter((item) => item !== id)
    if (isNew === true && !resume.includes(id)) resume.push(id)
    inventory.resumeAgentComponents = resume.filter((item) => inventory.availableAgentComponents.includes(item))
    inventory.agentToolsPaused = true
    return { paused: true, active: false, wasActive }
  }
  const active = activate === true || wasActive || (isNew === true && activate !== false)
  inventory.agentComponents = inventory.agentComponents.filter((item) => item !== id)
  if (active) inventory.agentComponents.push(id)
  inventory.agentToolsPaused = false
  inventory.resumeAgentComponents = []
  return { paused: false, active, wasActive }
}

async function commitGitHubInstall(options, { wrapped, binding, component, health, prepared }, dependencies, preparedPaths) {
  const stateRoot = preparedPaths.root
  const state = await loadState(preparedPaths)
  if (state === null) fail('NOT_INSTALLED', 'No Agent environment is installed')
  const sources = await readToolSources(stateRoot)
  const previousSource = sources.tools?.[binding.id]
  assertCompatibleOrigin(previousSource?.origin ?? state.components[binding.id]?.origin, {
    ...wrapped.origin,
    id: binding.id,
  }, { replaceSource: options.replaceSource === true })
  const inventory = inventoryFromState(state)
  const previousComponent = inventory.components[binding.id]
  const record = inventory.privateComponents[binding.id]
  if (
    previousComponent !== undefined
    && record?.current?.component === undefined
    && previousSource === undefined
    && previousComponent.origin?.kind !== 'github-release'
  ) {
    // Allow a verified migration onto a registered GitHub-managed tool for the same id.
    // Keep reserved-ID protection for unregistered / mismatched repositories.
    const registered = await findRegisteredTool(binding.id)
    const allowedMigration = typeof registered?.repository === 'string'
      && registered.repository === wrapped.origin?.repository
      && wrapped.origin?.kind === 'github-release'
    if (!allowedMigration) {
      fail('LOCAL_COMPONENT_ID_RESERVED', `Component ${binding.id} is owned by the installed compatibility release`)
    }
  }
  if (options.allowDowngrade !== true && previousComponent?.version !== undefined) {
    if (compareVersions(previousComponent.version, binding.version) > 0) {
      fail('GITHUB_TOOL_DOWNGRADE_REFUSED', `Refusing to downgrade ${binding.id} from ${previousComponent.version} to ${binding.version}`, {
        installedVersion: previousComponent.version,
        candidateVersion: binding.version,
      })
    }
  }
  const { paused, active, wasActive } = applyPausedWorkingSet(inventory, state, binding.id, {
    activate: options.activate,
    isNew: previousComponent === undefined,
  })
  inventory.components[binding.id] = component
  const previousCurrent = record?.current == null
    ? (previousComponent === undefined ? null : {
      binding: bindingFromComponent(previousComponent),
      component: previousComponent,
      importedAt: previousComponent.importedAt ?? new Date().toISOString(),
      active: wasActive,
    })
    : { ...record.current, active: wasActive }
  inventory.privateComponents[binding.id] = {
    schemaVersion: PRIVATE_COMPONENT_STATE_SCHEMA,
    current: {
      binding: structuredClone(binding),
      component,
      importedAt: new Date().toISOString(),
      active,
    },
    rollback: previousCurrent,
  }
  const dropped = Object.keys(state.components).filter((id) => id !== binding.id && inventory.components[id] === undefined)
  const othersUnchanged = Object.entries(state.components)
    .filter(([id]) => id !== binding.id)
    .every(([id, value]) => inventory.components[id] === value)
  if (dropped.length > 0 || othersUnchanged !== true) {
    fail('TOOL_UPDATE_ISOLATION', 'A single-tool GitHub install must not replace unrelated tools')
  }
  const transition = await transitionComponentInventory(options, inventory, dependencies)
  const latestSources = await readToolSources(stateRoot)
  await writeToolSources(stateRoot, {
    tools: {
      ...latestSources.tools,
      [binding.id]: {
        origin: wrapped.origin,
        wrappedSha256: wrapped.wrapped.sha256,
        wrappedBytes: wrapped.wrapped.bytes,
        lastCheck: { at: new Date().toISOString(), status: 'installed', availableVersion: wrapped.descriptor.version },
        rollback: previousComponent === undefined ? null : {
          origin: previousSource?.origin ?? previousComponent.origin ?? null,
          version: previousComponent.version,
          root: previousComponent.root,
        },
      },
    },
  })
  try {
    await recordActivity(preparedPaths, 'tool.github-updated', `${component.displayName} ${previousComponent === undefined ? 'installed' : 'updated'} from GitHub`, {
      component: binding.id,
      version: binding.version,
      repository: wrapped.origin.repository,
    })
  } catch {
    // Activity is not authoritative once inventory is committed.
  }
  return {
    schemaVersion: TOOL_UPDATE_SCHEMA,
    status: transition.status ?? 'ok',
    component: {
      id: binding.id,
      version: binding.version,
      displayName: component.displayName,
      summary: component.summary,
      author: component.author ?? null,
      homepage: component.homepage ?? null,
      logo: component.logo ?? null,
      installed: true,
      active,
    },
    origin: wrapped.origin,
    upstream: wrapped.upstream,
    wrapped: { sha256: wrapped.wrapped.sha256, bytes: wrapped.wrapped.bytes },
    health,
    restartRequired: transition.restartRequired === true || Object.keys(state.hosts ?? {}).length > 0,
    preserved: {
      otherTools: Object.keys(state.components).filter((id) => id !== binding.id),
      paused,
      observability: state.observability?.enabled === true,
      privateTools: Object.keys(inventory.privateComponents ?? {}),
    },
  }
}

export async function installGitHubTool(options, dependencies = {}) {
  const stateRoot = options.stateRoot
  const previewOnly = options.preview === true
  if (previewOnly) {
    return previewGitHubProject(options.github, { fetch: options.fetch, signal: options.signal })
  }
  const paths = await prepareStatePaths(resolveStateRoot(stateRoot))
  const state = await loadState(paths)
  let wrapped
  if (typeof options.wrappedArchivePath === 'string' && options.wrappedArchivePath.length > 0) {
    const observation = await observeLocalComponentArtifact(options.wrappedArchivePath, { runner: dependencies.artifactRunner })
    const repository = String(options.github).replace(/^https:\/\/github\.com\//u, '').replace(/\/$/u, '')
    const origin = observation.descriptor?.origin ?? githubOrigin({
      repository,
      tag: options.tag,
      assetName: options.expectedAssetName ?? 'component.tar.gz',
      assetUrl: `https://github.com/${repository}/releases/download/${options.tag}/component.tar.gz`,
      assetSha256: options.expectedUpstreamDigest ?? observation.releaseComponent.artifact.sha256,
      assetBytes: observation.releaseComponent.artifact.bytes,
    })
    wrapped = {
      descriptor: observation.descriptor,
      presentation: observation.descriptor.presentation ?? {
        displayName: observation.descriptor.id,
        summary: observation.descriptor.id,
        author: null,
        homepage: null,
        logo: null,
      },
      contract: {
        licenseSpdx: observation.releaseComponent.license?.spdx ?? 'Apache-2.0',
        expectedTools: observation.descriptor?.integration?.expectedTools ?? [],
      },
      origin,
      upstream: {
        sha256: options.expectedUpstreamDigest ?? origin.assetSha256 ?? null,
      },
      wrapped: {
        path: options.wrappedArchivePath,
        sha256: observation.releaseComponent.artifact.sha256,
        bytes: observation.releaseComponent.artifact.bytes,
      },
      health: null,
      _observation: observation,
    }
  } else {
    wrapped = await admitGitHubRelease({
      url: options.github,
      tag: options.tag,
      fetch: options.fetch,
      signal: options.signal,
      nodeCommand: state?.components?.['node-runtime']?.command ?? process.execPath,
      probe: options.probe !== false,
      expectedComponentId: options.expectedComponentId,
    })
    if (options.expectedDigest !== null && options.expectedDigest !== undefined
      && wrapped.wrapped.sha256 !== options.expectedDigest) {
      fail('GITHUB_TOOL_UPDATE_DIGEST_MISMATCH', 'Downloaded update archive digest does not match the persisted candidate', {
        expected: options.expectedDigest,
        actual: wrapped.wrapped.sha256,
      })
    }
    if (options.expectedUpstreamDigest !== null && options.expectedUpstreamDigest !== undefined) {
      const upstream = wrapped.upstream?.sha256 ?? wrapped.origin?.assetSha256
      if (upstream !== options.expectedUpstreamDigest) {
        fail('GITHUB_TOOL_UPDATE_DIGEST_MISMATCH', 'Upstream archive digest does not match the persisted candidate', {
          expected: options.expectedUpstreamDigest,
          actual: upstream,
        })
      }
    }
  }
  if (typeof options.expectedComponentId === 'string'
    && options.expectedComponentId.length > 0
    && wrapped.descriptor?.id !== options.expectedComponentId) {
    fail('GITHUB_TOOL_IDENTITY_DRIFT', `Update target ${options.expectedComponentId} does not match component id ${wrapped.descriptor?.id}`, {
      target: options.expectedComponentId,
      componentId: wrapped.descriptor?.id ?? null,
      repository: wrapped.origin?.repository ?? null,
      tag: wrapped.origin?.tag ?? null,
    })
  }
  if (options.dryRun === true || state === null) {
    return {
      schemaVersion: TOOL_UPDATE_SCHEMA,
      status: state === null ? 'candidate' : 'ready',
      dryRun: options.dryRun === true,
      component: {
        id: wrapped.descriptor.id,
        version: wrapped.descriptor.version,
        displayName: wrapped.presentation.displayName,
        summary: wrapped.presentation.summary,
        author: wrapped.presentation.author ?? null,
        homepage: wrapped.presentation.homepage ?? null,
        logo: wrapped.presentation.logo ?? null,
      },
      origin: wrapped.origin,
      upstream: wrapped.upstream,
      wrapped: { sha256: wrapped.wrapped.sha256, bytes: wrapped.wrapped.bytes, path: wrapped.wrapped.path },
      health: wrapped.health,
      installed: false,
      message: state === null
        ? 'GitHub archive verified. Install Agent Host, then run tools add --github to bind it into an environment.'
        : 'GitHub archive verified; dry-run did not change the installed environment.',
    }
  }
  const observation = wrapped._observation
    ?? await observeLocalComponentArtifact(wrapped.wrapped.path, { runner: dependencies.artifactRunner })
  const { binding } = await runtimeFromWrapped(wrapped, observation)
  const prepared = await materializeObservedLocalComponentArtifact(observation, binding, paths, { runner: dependencies.artifactRunner })
  let inventoryAdopted = false
  try {
    let component = await materializeToolComponent(prepared.installed, prepared.releaseComponent, state.components['node-runtime']?.command)
    const health = wrapped.health ?? (options.probe === false
      ? { tools: wrapped.contract.expectedTools, skipped: true }
      : await (dependencies.mcpProbe ?? probeMcpToolsFirstAndRepeat)({
        ...component,
        healthWorkspaceRoot: state.workspaceRoot ?? component.cwd,
      }))
    const result = await withLifecycleMutation(
      statePaths(paths.root),
      'tool.github-install',
      { ...dependencies, migrateState: true, recoverEnvironmentChange: true, environmentDryRun: options.dryRun === true },
      (locked, preparedPaths) => commitGitHubInstall(
        options,
        { wrapped, binding, component, health, prepared },
        locked,
        preparedPaths,
      ),
    )
    inventoryAdopted = true
    await clearUpdateCandidate(stateRoot, binding.id).catch(() => {})
    return result
  } finally {
    if (!inventoryAdopted) await cleanupUnadoptedPackage(prepared, paths).catch(() => {})
  }
}


async function sha256File(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return `sha256:${hash.digest('hex')}`
}

function digestDirName(digest) {
  return String(digest).replace(/^sha256:/u, '')
}

async function toolUpdateCachePath(stateRoot, { id, platform, wrappedDigest }) {
  const paths = await prepareStatePaths(resolveStateRoot(stateRoot))
  return join(paths.downloads, 'tool-updates', id, platform ?? 'unknown', digestDirName(wrappedDigest), 'component.tar.gz')
}

async function pathExists(path) {
  return stat(path).then(() => true).catch((error) => {
    if (error?.code === 'ENOENT') return false
    throw error
  })
}

async function persistVerifiedToolCache(stateRoot, {
  id,
  platform,
  wrappedPath,
  wrappedDigest,
  upstreamDigest = null,
}) {
  const destination = await toolUpdateCachePath(stateRoot, { id, platform, wrappedDigest })
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  if (await pathExists(destination) !== true) {
    await cp(wrappedPath, destination)
  }
  const actual = await sha256File(destination)
  if (actual !== wrappedDigest) {
    await rm(destination, { force: true }).catch(() => {})
    fail('GITHUB_TOOL_CACHE_DIGEST_MISMATCH', 'The Host-managed tool update cache failed digest verification', {
      expected: wrappedDigest,
      actual,
    })
  }
  return {
    downloadedPath: destination,
    wrappedDigest,
    upstreamDigest,
  }
}

async function reuseCachedToolArchive(stateRoot, candidate) {
  if (candidate === null || candidate === undefined) return null
  const wrappedDigest = candidate.wrappedDigest ?? candidate.digest ?? null
  if (typeof candidate.downloadedPath !== 'string' || wrappedDigest === null) return null
  if (await pathExists(candidate.downloadedPath) !== true) return null
  const actual = await sha256File(candidate.downloadedPath)
  if (actual !== wrappedDigest) return null
  return {
    path: candidate.downloadedPath,
    wrappedDigest,
    upstreamDigest: candidate.upstreamDigest ?? null,
  }
}

function assertCandidateInstallable(candidate, { force = false, platform = null } = {}) {
  if (candidate === null || candidate === undefined) return
  if (force === true) return
  if (candidate.compatible === false) {
    fail(
      'GITHUB_TOOL_UPDATE_BLOCKED',
      'This update is listed as compatible only after a Host/catalog advance; refusing install without --force',
      {
        availability: 'compatible-after-host-update',
        version: candidate.version ?? null,
        tag: candidate.tag ?? null,
      },
    )
  }
  if (candidate.platformAvailable === false) {
    fail('GITHUB_TOOL_UPDATE_BLOCKED', 'No installable archive is published for the current platform', {
      platform: candidate.platform ?? platform,
    })
  }
}

export async function downloadGitHubToolUpdate(options, dependencies = {}) {
  const items = await inspectToolUpdates(options.stateRoot, {
    fetch: options.fetch,
    signal: options.signal,
    persist: true,
  }, dependencies)
  const item = items.find((entry) => entry.id === options.target)
  if (item === undefined) fail('GITHUB_TOOL_UNKNOWN', `${options.target} has no persisted GitHub update source`)
  if (item.availability !== 'update-available' && options.force !== true) {
    return { id: options.target, downloaded: false, availability: item.availability, candidate: item.candidate }
  }
  assertCandidateInstallable(item.candidate, { force: options.force === true, platform: item.candidate?.platform })
  const cached = await reuseCachedToolArchive(options.stateRoot, item.candidate)
  if (cached !== null) {
    return {
      id: options.target,
      downloaded: true,
      reused: true,
      path: cached.path,
      sha256: cached.wrappedDigest,
      version: item.candidate?.version ?? null,
      dryRun: false,
    }
  }
  const sources = await readToolSources(options.stateRoot)
  const repository = sources.tools?.[options.target]?.origin?.repository ?? item.source?.repository
  if (typeof repository !== 'string') fail('GITHUB_TOOL_UNKNOWN', `${options.target} has no persisted GitHub update source`)
  const platform = item.candidate?.platform ?? supportedReleasePlatform()
  const wrapped = await admitGitHubRelease({
    url: `https://github.com/${repository}`,
    tag: item.candidate?.tag ?? options.tag,
    fetch: options.fetch,
    signal: options.signal,
    probe: false,
    expectedComponentId: options.target,
  })
  if (wrapped.descriptor?.id !== options.target) {
    fail('GITHUB_TOOL_IDENTITY_DRIFT', `Update target ${options.target} does not match component id ${wrapped.descriptor?.id}`, {
      target: options.target,
      componentId: wrapped.descriptor?.id ?? null,
      repository,
      tag: wrapped.origin?.tag ?? null,
    })
  }
  const cache = await persistVerifiedToolCache(options.stateRoot, {
    id: options.target,
    platform,
    wrappedPath: wrapped.wrapped.path,
    wrappedDigest: wrapped.wrapped.sha256,
    upstreamDigest: wrapped.upstream?.sha256 ?? wrapped.origin?.assetSha256 ?? null,
  })
  await mergeUpdateCandidates(options.stateRoot, {
    tools: {
      [options.target]: {
        ...item.candidate,
        downloadedPath: cache.downloadedPath,
        digest: cache.wrappedDigest,
        wrappedDigest: cache.wrappedDigest,
        upstreamDigest: cache.upstreamDigest,
        version: wrapped.descriptor.version,
        tag: wrapped.origin.tag,
        assetName: wrapped.origin.assetName,
        assetUrl: wrapped.origin.assetUrl,
        assetBytes: wrapped.origin.assetBytes,
        releaseUrl: wrapped.origin.releaseUrl,
      },
    },
  }, dependencies)
  return {
    id: options.target,
    downloaded: true,
    reused: false,
    path: cache.downloadedPath,
    sha256: cache.wrappedDigest,
    bytes: wrapped.wrapped.bytes,
    version: wrapped.descriptor.version,
    dryRun: false,
  }
}

export async function updateGitHubTool(options, dependencies = {}) {
  const sources = await readToolSources(options.stateRoot)
  const catalogEntry = await findCatalogTool(options.target, { fetch: options.fetch, signal: options.signal })
  const saved = sources.tools?.[options.target]
  let persisted = (await readUpdateCandidates(options.stateRoot)).tools?.[options.target]
  const repository = saved?.origin?.repository ?? catalogEntry?.repository
  if (typeof repository !== 'string') fail('GITHUB_TOOL_UNKNOWN', `${options.target} has no persisted GitHub update source`)
  let tag = options.tag ?? persisted?.tag
  let candidate = persisted ?? null
  if (tag === undefined || candidate === null || candidate === undefined) {
    const items = await inspectToolUpdates(options.stateRoot, {
      fetch: options.fetch,
      signal: options.signal,
      persist: true,
    }, dependencies)
    const item = items.find((entry) => entry.id === options.target)
    tag = tag ?? item?.candidate?.tag ?? item?.source?.tag
    candidate = item?.candidate ?? candidate
    persisted = (await readUpdateCandidates(options.stateRoot)).tools?.[options.target] ?? candidate
  }
  assertCandidateInstallable(persisted ?? candidate, {
    force: options.force === true,
    platform: (persisted ?? candidate)?.platform,
  })
  const expected = persisted ?? candidate
  // Re-read installed version before applying a persisted candidate so a newer
  // install that happened after check cannot be silently downgraded.
  const paths = await prepareStatePaths(resolveStateRoot(options.stateRoot))
  const state = await loadState(paths)
  const installedVersion = state?.components?.[options.target]?.version
    ?? state?.privateComponents?.[options.target]?.current?.component?.version
    ?? saved?.origin?.tag?.replace(/^v/u, '')
  const candidateVersion = expected?.version ?? (typeof tag === 'string' ? tag.replace(/^v/u, '') : null)
  if (
    options.allowDowngrade !== true
    && typeof installedVersion === 'string'
    && typeof candidateVersion === 'string'
    && compareVersions(installedVersion, candidateVersion) > 0
  ) {
    await clearUpdateCandidate(options.stateRoot, options.target).catch(() => {})
    fail('GITHUB_TOOL_STALE_CANDIDATE', `Persisted candidate ${candidateVersion} is older than installed ${installedVersion}; refusing downgrade`, {
      installedVersion,
      candidateVersion,
      tag,
    })
  }
  if (
    typeof installedVersion === 'string'
    && typeof candidateVersion === 'string'
    && compareVersions(installedVersion, candidateVersion) === 0
  ) {
    await clearUpdateCandidate(options.stateRoot, options.target).catch(() => {})
    return {
      schemaVersion: TOOL_UPDATE_SCHEMA,
      status: 'ok',
      component: {
        id: options.target,
        version: installedVersion,
        displayName: state?.components?.[options.target]?.displayName ?? options.target,
      },
      installed: true,
      applied: false,
      message: 'Installed tool already matches the persisted candidate; cleared stale update candidate.',
    }
  }
  const cached = await reuseCachedToolArchive(options.stateRoot, expected)
  const historicalWrappedDigest = expected?.wrappedDigest ?? null
  const upstreamDigest = expected?.upstreamDigest
    ?? (historicalWrappedDigest === null ? (expected?.digest ?? null) : null)
  // Cache hit: enforce the stored Host wrap digest. Cache miss / re-acquire: verify
  // upstreamDigest only, then accept the fresh local wrap (wrap may be non-deterministic).
  return installGitHubTool({
    ...options,
    github: `https://github.com/${repository}`,
    tag,
    activate: options.activate,
    expectedDigest: cached?.path ? (cached.wrappedDigest ?? historicalWrappedDigest) : null,
    expectedUpstreamDigest: upstreamDigest,
    expectedAssetName: expected?.assetName ?? null,
    expectedComponentId: options.target,
    wrappedArchivePath: cached?.path,
  }, dependencies)
}

export { browseRecommendedTools, previewGitHubProject }
