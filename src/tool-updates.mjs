import { AgentHostError } from './errors.mjs'
import { admitGitHubRelease, browseRecommendedTools, previewGitHubProject, supportedReleasePlatform } from './github-project.mjs'
import { fetchGitHubRelease, selectReleaseAsset } from './github-api.mjs'
import { findCatalogTool, findRegisteredTool, loadGitHubToolCatalog } from './github-registry.mjs'
import { materializeObservedLocalComponentArtifact, observeLocalComponentArtifact } from './release-artifacts.mjs'
import { materializeToolComponent } from './tool-component.mjs'
import { probeMcpToolsFirstAndRepeat } from './mcp-health.mjs'
import { resolveStateRoot } from './paths.mjs'
import { loadState, prepareStatePaths } from './state.mjs'
import { transitionComponentInventory } from './lifecycle.mjs'
import { recordActivity } from './activity.mjs'
import { assertCompatibleOrigin, githubOrigin, originIdentity, readToolSources, writeToolSources } from './tool-sources.mjs'
import { isSpdxExpressionSyntax } from './spdx-expression.mjs'

export const TOOL_UPDATE_SCHEMA = 'openadam.agent-host-tool-update.v0.1'

function fail(code, message, details) {
  throw new AgentHostError(code, message, details)
}

function compareVersions(left, right) {
  const parts = (value) => String(value).replace(/^v/u, '').split(/[.-]/u)
  const a = parts(left)
  const b = parts(right)
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = a[index] ?? '0'
    const rightPart = b[index] ?? '0'
    const leftNumeric = /^\d+$/u.test(leftPart)
    const rightNumeric = /^\d+$/u.test(rightPart)
    if (leftNumeric && rightNumeric) {
      const comparison = Number(leftPart) - Number(rightPart)
      if (comparison !== 0) return comparison < 0 ? -1 : 1
      continue
    }
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1
  }
  return 0
}

function inventoryFromState(state) {
  return {
    components: { ...state.components },
    availableAgentComponents: [...(state.availableAgentComponents ?? Object.keys(state.components))],
    agentComponents: [...(state.agentComponents ?? [])],
    privateComponents: { ...(state.privateComponents ?? {}) },
  }
}

async function runtimeFromWrapped(wrapped, observation, state) {
  const binding = {
    archiveSha256: observation.observed.archiveSha256,
    archiveBytes: observation.observed.archiveBytes,
    descriptorSha256: observation.observed.descriptorSha256,
    id: observation.descriptor.id,
    version: observation.descriptor.version,
    platform: observation.releaseComponent.platform,
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
  const live = typeof fetch === 'function' || catalogEntry === undefined
  if (typeof repository !== 'string' || live !== true) {
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
    const release = await fetchGitHubRelease(repository, channel === 'preview' ? null : 'latest', { fetch, signal })
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
          error: null,
        }
      }
      return {
        availableVersion: remoteVersion,
        tag: release.tag,
        compatible: false,
        platformAvailable: platform === null ? true : platformAsset !== null,
        from: 'github',
        remoteVersion,
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

export async function inspectToolUpdates(stateRoot, { fetch, signal, catalog, channel = 'stable', persist = true } = {}) {
  const paths = await prepareStatePaths(resolveStateRoot(stateRoot))
  const state = await loadState(paths)
  const sources = await readToolSources(stateRoot)
  const pinned = catalog ?? await loadGitHubToolCatalog()
  const platform = supportedReleasePlatform()
  const ids = new Set([
    ...Object.keys(state?.components ?? {}),
    ...Object.keys(sources.tools ?? {}),
    ...pinned.tools.map((tool) => tool.id),
  ])
  const items = []
  const nextSources = { ...sources.tools }
  let sourcesChanged = false
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
    if (persist === true && source?.origin !== undefined) {
      nextSources[id] = { ...source, lastCheck }
      sourcesChanged = true
    }
    items.push({
      kind: 'tool',
      id,
      displayName: component?.displayName ?? catalogEntry?.presentation?.displayName ?? id,
      summary: component?.summary ?? catalogEntry?.presentation?.summary ?? null,
      author: component?.author ?? catalogEntry?.presentation?.author ?? null,
      homepage: component?.homepage ?? `https://github.com/${origin?.repository ?? catalogEntry?.repository ?? ''}`,
      logo: component?.logo ?? catalogEntry?.presentation?.logo ?? null,
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
      candidate: remote.tag === undefined || remote.tag === null ? null : {
        tag: remote.tag,
        version: availableVersion,
        digest: remote.digest ?? null,
        from: remote.from,
      },
    })
  }
  if (persist === true && sourcesChanged) {
    try {
      await writeToolSources(stateRoot, { tools: nextSources })
    } catch {
      // lastCheck is advisory; inventory remains authoritative.
    }
  }
  return items
}

export async function checkRegisteredTool(id, { fetch, signal, channel = 'stable', stateRoot } = {}) {
  const registration = await findRegisteredTool(id)
  const catalogEntry = await findCatalogTool(id)
  const saved = stateRoot === undefined ? null : (await readToolSources(stateRoot)).tools?.[id]
  const repository = registration?.repository ?? catalogEntry?.repository ?? saved?.origin?.repository
  if (typeof repository !== 'string') fail('GITHUB_TOOL_UNKNOWN', `No GitHub registration for ${id}`)
  try {
    const release = await fetchGitHubRelease(repository, channel === 'preview' ? null : 'latest', { fetch, signal })
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

export async function installGitHubTool(options, dependencies = {}) {
  const stateRoot = options.stateRoot
  const previewOnly = options.preview === true
  if (previewOnly) {
    return previewGitHubProject(options.github, { fetch: options.fetch, signal: options.signal })
  }
  const paths = await prepareStatePaths(resolveStateRoot(stateRoot))
  const state = await loadState(paths)
  const wrapped = await admitGitHubRelease({
    url: options.github,
    tag: options.tag,
    fetch: options.fetch,
    signal: options.signal,
    nodeCommand: state?.components?.['node-runtime']?.command ?? process.execPath,
    probe: options.probe !== false,
  })
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
  const sources = await readToolSources(stateRoot)
  const previous = sources.tools?.[wrapped.descriptor.id]
  assertCompatibleOrigin(previous?.origin ?? state.components[wrapped.descriptor.id]?.origin, {
    ...wrapped.origin,
    id: wrapped.descriptor.id,
  }, { replaceSource: options.replaceSource === true })
  const observation = await observeLocalComponentArtifact(wrapped.wrapped.path, { runner: dependencies.artifactRunner })
  const { binding } = await runtimeFromWrapped(wrapped, observation, state)
  const prepared = await materializeObservedLocalComponentArtifact(observation, binding, paths, { runner: dependencies.artifactRunner })
  let component = await materializeToolComponent(prepared.installed, prepared.releaseComponent, state.components['node-runtime']?.command)
  const health = wrapped.health ?? (options.probe === false
    ? { tools: wrapped.contract.expectedTools, skipped: true }
    : await (dependencies.mcpProbe ?? probeMcpToolsFirstAndRepeat)({
      ...component,
      healthWorkspaceRoot: state.workspaceRoot ?? component.cwd,
    }))
  const inventory = inventoryFromState(state)
  const previousComponent = inventory.components[binding.id]
  const wasActive = inventory.agentComponents.includes(binding.id)
  const active = options.activate === true || wasActive || previousComponent === undefined
  inventory.components[binding.id] = component
  if (!inventory.availableAgentComponents.includes(binding.id)) inventory.availableAgentComponents.push(binding.id)
  if (active && !inventory.agentComponents.includes(binding.id)) inventory.agentComponents.push(binding.id)
  const othersUnchanged = Object.entries(state.components)
    .filter(([id]) => id !== binding.id)
    .every(([id, value]) => inventory.components[id] === value)
  if (othersUnchanged !== true) fail('TOOL_UPDATE_ISOLATION', 'A single-tool GitHub install must not replace unrelated tools')
  const transition = await transitionComponentInventory(options, inventory, dependencies)
  await writeToolSources(stateRoot, {
    tools: {
      ...sources.tools,
      [binding.id]: {
        origin: wrapped.origin,
        wrappedSha256: wrapped.wrapped.sha256,
        wrappedBytes: wrapped.wrapped.bytes,
        lastCheck: { at: new Date().toISOString(), status: 'installed', availableVersion: wrapped.descriptor.version },
        rollback: previousComponent === undefined ? null : {
          origin: previous?.origin ?? state.components[binding.id]?.origin ?? null,
          version: previousComponent.version,
          root: previousComponent.root,
        },
      },
    },
  })
  try {
    await recordActivity(paths, 'tool.github-updated', `${component.displayName} ${previousComponent === undefined ? 'installed' : 'updated'} from GitHub`, {
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
      paused: state.agentToolsPaused === true,
      observability: state.observability?.enabled === true,
      privateTools: Object.keys(state.privateComponents ?? {}),
    },
  }
}

export async function updateGitHubTool(options, dependencies = {}) {
  const sources = await readToolSources(options.stateRoot)
  const catalogEntry = await findCatalogTool(options.target)
  const saved = sources.tools?.[options.target]
  const repository = saved?.origin?.repository ?? catalogEntry?.repository
  if (typeof repository !== 'string') fail('GITHUB_TOOL_UNKNOWN', `${options.target} has no persisted GitHub update source`)
  let tag = options.tag
  if (tag === undefined) {
    const items = await inspectToolUpdates(options.stateRoot, {
      fetch: options.fetch,
      signal: options.signal,
      persist: true,
    })
    const item = items.find((entry) => entry.id === options.target)
    tag = item?.candidate?.tag ?? item?.source?.tag
  }
  return installGitHubTool({
    ...options,
    github: `https://github.com/${repository}`,
    tag,
    activate: options.activate,
  }, dependencies)
}

export { browseRecommendedTools, previewGitHubProject }
