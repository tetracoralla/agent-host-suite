import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { AgentHostError } from './errors.mjs'
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

export async function loadGitHubToolCatalog() {
  const value = await readTrackedJson(CATALOG_URL, 'GitHub tool catalog')
  exactKeys(value, ['schemaVersion', 'catalogId', 'createdAt', 'channel', 'incompletePlatforms', 'tools'], 'GitHub tool catalog')
  if (value.schemaVersion !== GITHUB_CATALOG_SCHEMA) fail('GITHUB_CATALOG_INVALID', 'Unsupported GitHub tool catalog schema')
  if (!Array.isArray(value.tools)) fail('GITHUB_CATALOG_INVALID', 'GitHub tool catalog tools must be an array')
  return value
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

export async function findCatalogTool(id) {
  const catalog = await loadGitHubToolCatalog()
  return catalog.tools.find((tool) => tool.id === id) ?? null
}
