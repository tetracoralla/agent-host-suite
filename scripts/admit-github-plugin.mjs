import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { admitGitHubRelease, browseRecommendedTools } from '../src/github-project.mjs'
import { loadGitHubToolCatalog, loadGitHubToolRegistry } from '../src/github-registry.mjs'
import { supportedReleasePlatform } from '../src/github-project.mjs'

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  return process.argv[index + 1] ?? true
}

const output = resolve(arg('--output', '.build/github-tools'))
const registryMode = process.argv.includes('--registry')
const github = arg('--github')
const id = arg('--id')
const defaultCatalogPath = fileURLToPath(new URL('../catalog/github-releases/current.json', import.meta.url))
const catalogArgument = arg('--catalog', defaultCatalogPath)
const catalogPath = catalogArgument === true ? defaultCatalogPath : resolve(String(catalogArgument))
await mkdir(output, { recursive: true, mode: 0o700 })

const results = []
if (registryMode) {
  // Bind admission to the refresh-generated candidate file. Do not load the live
  // published catalog, which can skip a newer local candidate (for example 0.8
  // locally while live still serves 0.7 without this platform).
  const catalog = await loadGitHubToolCatalog({ catalogPath })
  const registry = await loadGitHubToolRegistry()
  const platform = supportedReleasePlatform()
  if (platform === null) {
    throw new Error('admit --registry requires a supported release platform; do not reuse another OS asset')
  }
  for (const tool of registry.tools) {
    const pinned = catalog.tools.find((item) => item.id === tool.id)
    if (pinned === undefined) {
      results.push({ id: tool.id, status: 'skipped', reason: 'not in GitHub catalog pin' })
      continue
    }
    const asset = pinned.platforms[platform]
    if (asset === undefined) {
      results.push({ id: tool.id, status: 'skipped', reason: `no asset for ${platform}` })
      continue
    }
    const admitted = await admitGitHubRelease({
      url: pinned.releaseUrl,
      tag: pinned.tag,
      outputPath: resolve(output, `${tool.id}-${pinned.version}-host-component.tar.gz`),
      workRoot: resolve(output, `work-${tool.id}`),
    })
    results.push({
      id: tool.id,
      status: 'admitted',
      version: admitted.descriptor.version,
      catalogPath,
      catalogVersion: pinned.version,
      catalogTag: pinned.tag,
      catalogReleaseUrl: pinned.releaseUrl,
      catalogDigest: asset.sha256 ?? null,
      platform,
      origin: admitted.origin,
      upstream: admitted.upstream,
      wrapped: { sha256: admitted.wrapped.sha256, bytes: admitted.wrapped.bytes, path: admitted.wrapped.path },
      health: admitted.health === null ? null : { tools: admitted.health.tools },
      presentation: admitted.presentation,
    })
  }
} else {
  const url = github ?? (id === 'armorial' ? 'https://github.com/tetracoralla/armorial/releases/tag/v0.8.0' : null)
  if (url === null) throw new Error('Usage: node scripts/admit-github-plugin.mjs --registry|--github URL [--catalog PATH] [--output DIR]')
  const admitted = await admitGitHubRelease({
    url,
    outputPath: resolve(output, 'host-component.tar.gz'),
    workRoot: resolve(output, 'work'),
  })
  results.push({
    id: admitted.descriptor.id,
    status: 'admitted',
    version: admitted.descriptor.version,
    origin: admitted.origin,
    upstream: admitted.upstream,
    wrapped: { sha256: admitted.wrapped.sha256, bytes: admitted.wrapped.bytes, path: admitted.wrapped.path },
    health: admitted.health === null ? null : { tools: admitted.health.tools },
    presentation: admitted.presentation,
  })
}

const report = {
  schemaVersion: 'openadam.agent-host-github-admit.v0.1',
  generatedAt: new Date().toISOString(),
  catalogPath: registryMode ? catalogPath : null,
  recommended: await browseRecommendedTools(),
  results,
}
await writeFile(resolve(output, 'admit.json'), `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
