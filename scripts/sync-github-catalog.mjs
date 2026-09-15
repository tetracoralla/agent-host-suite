import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { fetchGitHubRelease } from '../src/github-api.mjs'
import { loadGitHubToolCatalog, loadGitHubToolRegistry, registeredToolAsset } from '../src/github-registry.mjs'
import { parseSha256File } from '../src/github-api.mjs'
import { acquireHttpsFile } from '../src/release-artifacts.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const catalogPath = fileURLToPath(new URL('../catalog/github-releases/current.json', import.meta.url))
const registry = await loadGitHubToolRegistry()
const current = await loadGitHubToolCatalog()
const tools = []
let changed = false

for (const tool of registry.tools) {
  const existing = current.tools.find((item) => item.id === tool.id)
  let release
  try {
    release = await fetchGitHubRelease(tool.repository, 'latest')
  } catch (error) {
    if (existing !== undefined) {
      tools.push(existing)
      continue
    }
    throw error
  }
  if (release.prerelease === true || release.draft === true) {
    if (existing !== undefined) tools.push(existing)
    continue
  }
  const version = release.tag.replace(/^v/u, '')
  const platforms = {}
  const scratch = await mkdtemp(join(tmpdir(), 'agent-host-catalog-sync-'))
  try {
    for (const [platform, assetPlatform] of Object.entries(tool.platforms)) {
      const named = registeredToolAsset(tool, version, platform)
      const asset = release.assets.find((item) => item.name === named.assetName)
      if (asset === undefined) continue
      const checksum = release.assets.find((item) => item.name === named.checksumAssetName)
      let sha256
      let bytes = asset.bytes
      if (checksum !== undefined) {
        const checksumPath = join(scratch, named.checksumAssetName)
        await acquireHttpsFile({
          url: checksum.url,
          destination: checksumPath,
          maxBytes: 4096,
          label: named.checksumAssetName,
        })
        sha256 = parseSha256File(await readFile(checksumPath, 'utf8'), named.assetName).sha256
      }
      if (sha256 === undefined) continue
      platforms[platform] = {
        assetName: named.assetName,
        url: `https://github.com/${tool.repository}/releases/download/${release.tag}/${named.assetName}`,
        sha256,
        bytes,
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  if (Object.keys(platforms).length === 0) {
    if (existing !== undefined) tools.push(existing)
    continue
  }
  const next = {
    id: tool.id,
    version,
    repository: tool.repository,
    tag: release.tag,
    releaseUrl: release.htmlUrl ?? `https://github.com/${tool.repository}/releases/tag/${release.tag}`,
    featured: tool.featured === true,
    platforms,
  }
  if (existing === undefined || existing.version !== version || JSON.stringify(existing.platforms) !== JSON.stringify(platforms)) {
    changed = true
  }
  tools.push(next)
}

const catalog = {
  schemaVersion: 'openadam.agent-host-github-catalog.v0.1',
  catalogId: changed ? `github-tools-${new Date().toISOString().slice(0, 10)}` : current.catalogId,
  createdAt: changed ? new Date().toISOString() : current.createdAt,
  channel: 'stable',
  incompletePlatforms: current.incompletePlatforms ?? [],
  tools,
}
if (changed) await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({ changed, catalog }, null, 2)}\n`)
