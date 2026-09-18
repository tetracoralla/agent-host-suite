import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHostError } from './errors.mjs'
import {
  fetchGitHubRelease,
  fetchGitHubRepository,
  parseAssetDigest,
  parseGitHubResource,
  parseSha256File,
  selectReleaseAsset,
} from './github-api.mjs'
import { acquireHttpsFile } from './release-artifacts.mjs'
import { findCatalogTool, findRegisteredTool, interpolateAssetName, loadGitHubToolCatalog, loadGitHubToolRegistry, registeredToolAsset } from './github-registry.mjs'
import { wrapGitHubPluginArchive } from './github-plugin-wrap.mjs'
import { currentReleasePlatform } from './release-manifest.mjs'
import { githubOrigin } from './tool-sources.mjs'
import { fetchRemotePreviewImage } from './tool-presentation.mjs'

export const GITHUB_PROJECT_PREVIEW_SCHEMA = 'openadam.agent-host-github-project-preview.v0.1'
const CHECKSUM_MAX_BYTES = 4096

function fail(code, message, details) {
  throw new AgentHostError(code, message, details)
}

export function supportedReleasePlatform(platformName = process.platform, architecture = process.arch) {
  try {
    return currentReleasePlatform(platformName, architecture)
  } catch (error) {
    if (error instanceof AgentHostError && error.code === 'RELEASE_PLATFORM_UNSUPPORTED') return null
    throw error
  }
}

export async function previewGitHubProject(url, {
  fetch,
  signal,
  platform = supportedReleasePlatform(),
} = {}) {
  const parsed = parseGitHubResource(url)
  const repository = await fetchGitHubRepository(parsed.repository, { fetch, signal })
  const tag = parsed.tag ?? 'latest'
  let release
  try {
    release = await fetchGitHubRelease(parsed.repository, parsed.tag ?? 'latest', { fetch, signal })
  } catch (error) {
    if (error instanceof AgentHostError && (error.code === 'GITHUB_NOT_FOUND' || error.code === 'GITHUB_RATE_LIMITED')) {
      return {
        schemaVersion: GITHUB_PROJECT_PREVIEW_SCHEMA,
        status: 'unavailable',
        origin: { kind: 'github-release', repository: parsed.repository, tag: parsed.tag, url: parsed.kind === 'repository' ? repository.htmlUrl : url },
        presentation: {
          displayName: repository.name,
          summary: repository.description ?? 'GitHub project',
          author: repository.owner.login,
          homepage: repository.homepage ?? repository.htmlUrl,
        },
        release: null,
        compatibility: { platform, available: false, reason: error.code },
        permissions: {
          message: 'Install inspects the package for MCP tools, Skills, and path grants before they take effect.',
        },
        downloadedPackage: false,
        error: { code: error.code, message: error.message },
      }
    }
    throw error
  }
  const registration = (await loadGitHubToolRegistry()).tools.find((tool) => tool.repository === parsed.repository) ?? null
  let asset = null
  let unavailable = null
  try {
    if (parsed.assetName !== null) asset = selectReleaseAsset(release, { assetName: parsed.assetName })
    else if (registration !== null && platform !== null) {
      const version = release.tag.replace(/^v/u, '')
      const named = registeredToolAsset(registration, version, platform)
      asset = selectReleaseAsset(release, { assetName: named.assetName, platform })
    } else {
      asset = selectReleaseAsset(release, { platform, assetName: parsed.assetName })
    }
  } catch (error) {
    if (error instanceof AgentHostError && error.code === 'GITHUB_ASSET_UNAVAILABLE') unavailable = error
    else throw error
  }
  let logo = null
  if (typeof repository.owner.avatarUrl === 'string') {
    try {
      const image = await fetchRemotePreviewImage(repository.owner.avatarUrl, { fetch, signal, maxBytes: 128 * 1024 })
      logo = {
        mediaType: image.mediaType,
        sha256: image.sha256,
        bytes: image.bytes.length,
        source: 'github-owner-avatar',
        dataUrl: `data:${image.mediaType};base64,${image.bytes.toString('base64')}`,
      }
    } catch {
      logo = null
    }
  }
  return {
    schemaVersion: GITHUB_PROJECT_PREVIEW_SCHEMA,
    status: 'ready',
    origin: {
      kind: 'github-release',
      repository: parsed.repository,
      tag: release.tag,
      releaseUrl: release.htmlUrl,
      assetName: asset?.name ?? parsed.assetName,
      assetUrl: asset?.url ?? null,
    },
    presentation: {
      displayName: repository.name,
      summary: repository.description ?? (release.body.slice(0, 180) || 'GitHub project'),
      author: repository.owner.login,
      homepage: repository.homepage ?? repository.htmlUrl,
      license: repository.license,
      ...(logo === null ? {} : { logo }),
    },
    release: {
      tag: release.tag,
      name: release.name,
      prerelease: release.prerelease,
      publishedAt: release.publishedAt,
      assets: release.assets.map((item) => ({ name: item.name, bytes: item.bytes })),
    },
    compatibility: {
      platform,
      available: asset !== null,
      asset: asset === null ? null : { name: asset.name, bytes: asset.bytes, url: asset.url },
      reason: unavailable?.code ?? (platform === null ? 'RELEASE_PLATFORM_UNSUPPORTED' : null),
    },
    permissions: {
      message: 'Install downloads the selected Release asset, verifies its digest, and inspects MCP tools, Skills, and path grants before they take effect. Preview does not download the package.',
    },
    downloadedPackage: false,
    registered: registration !== null,
  }
}

export async function downloadGitHubReleaseAsset({
  url,
  destination,
  expectedSha256 = null,
  expectedBytes = null,
  checksumUrl = null,
  fetch,
  signal,
  label = 'GitHub release asset',
}) {
  let digest = expectedSha256 ?? null
  if (digest == null && typeof checksumUrl === 'string') {
    const checksumDestination = `${destination}.sha256`
    const checksum = await acquireHttpsFile({
      url: checksumUrl,
      destination: checksumDestination,
      maxBytes: CHECKSUM_MAX_BYTES,
      fetch,
      signal,
      label: `${label} checksum`,
    })
    const { readFile } = await import('node:fs/promises')
    digest = parseSha256File(await readFile(checksum.path, 'utf8')).sha256
  }
  if (digest == null) fail('GITHUB_CHECKSUM_INVALID', 'GitHub release assets require a SHA-256 before download completes')
  return acquireHttpsFile({
    url,
    destination,
    expectedSha256: digest,
    expectedBytes,
    maxBytes: expectedBytes ?? 512 * 1024 * 1024,
    fetch,
    signal,
    label,
  })
}

export async function admitGitHubRelease({
  url,
  tag,
  fetch,
  signal,
  platform = supportedReleasePlatform(),
  nodeCommand,
  probe = true,
  expectedComponentId,
  outputPath,
  workRoot,
}) {
  const parsed = parseGitHubResource(url)
  const registration = (await findRegisteredToolFromRepo(parsed.repository))
  const catalogEntry = (await loadGitHubToolCatalog()).tools.find((tool) => tool.repository === parsed.repository)
  const selectedTag = tag ?? parsed.tag ?? catalogEntry?.tag
  let assetUrl
  let assetName
  let expectedSha256
  let expectedBytes
  let checksumUrl
  let releaseUrl
  let resolvedTag
  let repository = parsed.repository
  const pinnedAsset = catalogEntry === undefined
    ? undefined
    : (platform !== null ? catalogEntry.platforms?.[platform] : Object.values(catalogEntry.platforms ?? {})[0])
  if (catalogEntry !== undefined && (selectedTag === catalogEntry.tag || selectedTag === undefined) && pinnedAsset !== undefined) {
    assetUrl = pinnedAsset.url
    assetName = pinnedAsset.assetName
    expectedSha256 = pinnedAsset.sha256
    expectedBytes = pinnedAsset.bytes
    releaseUrl = catalogEntry.releaseUrl
    resolvedTag = catalogEntry.tag
  } else {
    const release = await fetchGitHubRelease(repository, selectedTag ?? 'latest', { fetch, signal })
    resolvedTag = release.tag
    releaseUrl = release.htmlUrl
    const version = release.tag.replace(/^v/u, '')
    let asset
    let checksumAssetName = `${parsed.assetName ?? ''}.sha256`
    if (registration !== null && platform !== null) {
      const named = registeredToolAsset(registration, version, platform)
      asset = selectReleaseAsset(release, { assetName: parsed.assetName ?? named.assetName, platform })
      checksumAssetName = named.checksumAssetName
    } else {
      asset = selectReleaseAsset(release, { assetName: parsed.assetName, platform })
      checksumAssetName = `${asset.name}.sha256`
    }
    assetUrl = asset.url
    assetName = asset.name
    expectedBytes = asset.bytes
    expectedSha256 = parseAssetDigest(asset.digest) ?? null
    const checksumAsset = release.assets.find((item) => item.name === checksumAssetName)
      ?? release.assets.find((item) => item.name === `${asset.name}.sha256`)
      ?? null
    if (expectedSha256 == null && checksumAsset !== null) checksumUrl = checksumAsset.url
    else if (expectedSha256 == null) checksumUrl = `${asset.url}.sha256`
  }
  if (assetUrl === undefined) {
    fail('GITHUB_ASSET_UNAVAILABLE', 'This GitHub Release has no installable archive for the current platform')
  }
  const scratch = workRoot ?? await mkdtemp(join(tmpdir(), 'agent-host-github-admit-'))
  const archivePath = join(scratch, assetName ?? 'plugin.tar.gz')
  try {
    const downloaded = await downloadGitHubReleaseAsset({
      url: assetUrl,
      destination: archivePath,
      expectedSha256: expectedSha256 ?? null,
      expectedBytes,
      checksumUrl: expectedSha256 == null ? (checksumUrl ?? `${assetUrl}.sha256`) : null,
      fetch,
      signal,
      label: assetName ?? 'plugin archive',
    })
    const origin = githubOrigin({
      repository,
      tag: resolvedTag,
      releaseUrl,
      assetName: assetName ?? 'plugin.tar.gz',
      assetUrl,
      assetSha256: downloaded.sha256,
      assetBytes: downloaded.bytes,
    })
    const wrapped = await wrapGitHubPluginArchive({
      archivePath: downloaded.path,
      expectedSha256: downloaded.sha256,
      origin,
      expectedComponentId,
      nodeCommand,
      probe,
      outputPath,
      workRoot: join(scratch, 'wrap'),
    })
    return { ...wrapped, origin, downloaded }
  } finally {
    if (workRoot === undefined) await rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
}

async function findRegisteredToolFromRepo(repository) {
  const registry = await loadGitHubToolRegistry()
  return registry.tools.find((tool) => tool.repository === repository) ?? null
}

export async function browseRecommendedTools({ platform = supportedReleasePlatform() } = {}) {
  const registry = await loadGitHubToolRegistry()
  const catalog = await loadGitHubToolCatalog()
  return {
    schemaVersion: 'openadam.agent-host-recommended-tools.v0.1',
    marketplace: false,
    platform,
    tools: registry.tools.map((tool) => {
      const pinned = catalog.tools.find((item) => item.id === tool.id)
      const asset = pinned !== undefined && platform !== null ? pinned.platforms?.[platform] ?? null : null
      return {
        id: tool.id,
        repository: tool.repository,
        featured: tool.featured === true,
        homepage: `https://github.com/${tool.repository}`,
        version: pinned?.version ?? null,
        tag: pinned?.tag ?? null,
        releaseUrl: pinned?.releaseUrl ?? `https://github.com/${tool.repository}/releases`,
        compatible: asset !== null,
        asset,
        presentation: pinned?.presentation ?? null,
      }
    }),
  }
}

export { interpolateAssetName, findCatalogTool, findRegisteredTool }
