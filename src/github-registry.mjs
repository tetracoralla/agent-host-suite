import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { AgentHostError } from './errors.mjs'
import { fetchGitHubRelease } from './github-api.mjs'
import { currentReleasePlatform } from './release-manifest.mjs'

export const GITHUB_TOOLS_SCHEMA = 'openadam.agent-host-github-tools.v0.1'
export const GITHUB_CATALOG_SCHEMA = 'openadam.agent-host-github-catalog.v0.1'

const REGISTRY_URL = new URL('../catalog/github-tools.json', import.meta.url)
const CATALOG_URL = new URL('../catalog/github-releases/current.json', import.meta.url)

function fail(code, message, details) {
  throw new AgentHostError(code, message, details)
}

function exactKeys(value, allowed, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('GITHUB_REGISTRY_INVALID', `${label} must be an object`)
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) fail('GITHUB_REGISTRY_INVALID', `${label} contains unsupported fields`, { fields: unexpected })
}

async function readTrackedJson(url, label) {
  try {
    return JSON.parse(await readFile(fileURLToPath(url), 'utf8'))
  } catch (error) {
    fail('GITHUB_REGISTRY_UNAVAILABLE', `${label} is unavailable`, { cause: error instanceof Error ? error.message : String(error) })
  }
}

export async function loadGitHubToolRegistry() {
  const value = await readTrackedJson(REGISTRY_URL, 'GitHub tool registry')
  exactKeys(value, ['schemaVersion', 'host', 'tools'], 'GitHub tool registry')
  if (value.schemaVersion !== GITHUB_TOOLS_SCHEMA) fail('GITHUB_REGISTRY_INVALID', 'Unsupported GitHub tool registry schema')
  exactKeys(value.host, ['repository', 'stableTagPrefix', 'catalogTag', 'unsignedPreview'], 'GitHub host registry')
  if (!Array.isArray(value.tools)) fail('GITHUB_REGISTRY_INVALID', 'GitHub tool registry tools must be an array')
  const ids = new Set()
  const tools = value.tools.map((tool) => {
    exactKeys(tool, ['id', 'repository', 'featured', 'assetName', 'checksumAssetName', 'platforms'], 'GitHub tool registration')
    if (typeof tool.id !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(tool.id) || ids.has(tool.id)) {
      fail('GITHUB_REGISTRY_INVALID', 'GitHub tool registration ids must be unique')
    }
    ids.add(tool.id)
    return tool
  })
  return { ...value, tools }
}

export function parseGitHubToolCatalog(value) {
  exactKeys(value, ['schemaVersion', 'catalogId', 'createdAt', 'channel', 'incompletePlatforms', 'tools'], 'GitHub tool catalog')
  if (value.schemaVersion !== GITHUB_CATALOG_SCHEMA) fail('GITHUB_CATALOG_INVALID', 'Unsupported GitHub tool catalog schema')
  if (!Array.isArray(value.tools)) fail('GITHUB_CATALOG_INVALID', 'GitHub tool catalog tools must be an array')
  return value
}

export async function loadBundledGitHubToolCatalog() {
  return parseGitHubToolCatalog(await readTrackedJson(CATALOG_URL, 'GitHub tool catalog'))
}

export async function fetchPublishedGitHubCatalog({ fetch = globalThis.fetch, signal } = {}) {
  const registry = await loadGitHubToolRegistry()
  const tag = registry.host.catalogTag
  const release = await fetchGitHubRelease(registry.host.repository, tag, { fetch, signal })
  const asset = release.assets.find((item) => item.name === 'current.json')
    ?? release.assets.find((item) => item.name === 'github-releases.json')
    ?? release.assets.find((item) => item.name.endsWith('.json'))
  if (asset === undefined) {
    fail('GITHUB_CATALOG_UNAVAILABLE', 'The GitHub catalog tag does not include a catalog JSON asset')
  }
  let response
  try {
    response = await fetch(asset.url, {
      method: 'GET',
      redirect: 'follow',
      signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'openAdam-agent-host-suite',
      },
    })
  } catch (error) {
    fail('GITHUB_NETWORK', `GitHub catalog could not be reached${error instanceof Error ? `: ${error.message}` : ''}`)
  }
  if (!response.ok) fail('GITHUB_CATALOG_UNAVAILABLE', 'The GitHub catalog asset could not be downloaded', { status: response.status })
  const text = await response.text()
  if (text.length > 2 * 1024 * 1024) fail('GITHUB_CATALOG_INVALID', 'The GitHub catalog exceeded the supported size')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    fail('GITHUB_CATALOG_INVALID', 'The GitHub catalog asset is not valid JSON')
  }
  return {
    catalog: parseGitHubToolCatalog(parsed),
    source: {
      kind: 'github-release',
      repository: registry.host.repository,
      tag,
      assetName: asset.name,
      url: asset.url,
      digest: asset.digest ?? null,
      fetchedAt: new Date().toISOString(),
    },
  }
}

export async function loadGitHubToolCatalogFromPath(catalogPath) {
  if (typeof catalogPath !== 'string' || catalogPath.length === 0) {
    fail('GITHUB_CATALOG_UNAVAILABLE', 'GitHub tool catalog path is missing')
  }
  let parsed
  try {
    parsed = JSON.parse(await readFile(catalogPath, 'utf8'))
  } catch (error) {
    fail('GITHUB_CATALOG_UNAVAILABLE', `GitHub tool catalog is unavailable at ${catalogPath}`, {
      cause: error instanceof Error ? error.message : String(error),
    })
  }
  return parseGitHubToolCatalog(parsed)
}

export async function loadGitHubToolCatalog(options = {}) {
  if (typeof options.catalogPath === 'string' && options.catalogPath.length > 0) {
    // Explicit candidate file wins: never replace with a live published catalog.
    return loadGitHubToolCatalogFromPath(options.catalogPath)
  }
  const bundled = await loadBundledGitHubToolCatalog()
  if (options.bundledOnly === true) return bundled
  try {
    const live = await fetchPublishedGitHubCatalog({
      fetch: options.fetch ?? globalThis.fetch,
      signal: options.signal,
    })
    if (typeof options.onFetched === 'function') await options.onFetched(live)
    return live.catalog
  } catch {
    if (options.fallbackCatalog !== undefined && options.fallbackCatalog !== null) return options.fallbackCatalog
    return bundled
  }
}

export function interpolateAssetName(pattern, { version, assetPlatform }) {
  if (typeof pattern !== 'string' || pattern.length === 0) fail('GITHUB_REGISTRY_INVALID', 'Asset name pattern is missing')
  return pattern.replaceAll('{version}', version).replaceAll('{assetPlatform}', assetPlatform)
}

export function registeredToolAsset(registration, version, platform = currentReleasePlatform()) {
  const assetPlatform = registration.platforms?.[platform]
  if (typeof assetPlatform !== 'string') {
    fail('GITHUB_ASSET_UNAVAILABLE', `${registration.id} has no GitHub asset for ${platform}`)
  }
  const assetName = interpolateAssetName(registration.assetName, { version, assetPlatform })
  const checksumAssetName = typeof registration.checksumAssetName === 'string'
    ? interpolateAssetName(registration.checksumAssetName, { version, assetPlatform })
    : `${assetName}.sha256`
  return { platform, assetPlatform, assetName, checksumAssetName }
}

export function catalogToolAsset(entry, platform = currentReleasePlatform()) {
  const asset = entry?.platforms?.[platform]
  if (asset === undefined) fail('GITHUB_ASSET_UNAVAILABLE', `${entry?.id ?? 'tool'} has no catalog asset for ${platform}`)
  return { platform, ...asset }
}

export async function findRegisteredTool(id) {
  const registry = await loadGitHubToolRegistry()
  return registry.tools.find((tool) => tool.id === id) ?? null
}

export async function findCatalogTool(id, options = {}) {
  const catalog = await loadGitHubToolCatalog(options)
  return catalog.tools.find((tool) => tool.id === id) ?? null
}
