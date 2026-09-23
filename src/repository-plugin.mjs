import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHostError } from './errors.mjs'
import { acquireHttpsFile } from './release-artifacts.mjs'
import { wrapGitHubPluginArchive } from './github-plugin-wrap.mjs'
import { integrationRelativePath } from './tool-integration.mjs'

// Repository-carried plugins are already built, self-contained provider bytes.
// Admission never runs package installation, build scripts, or a moving branch.
export function validateRepositoryPlugin(entry) {
  const source = entry?.source
  if (source?.kind !== 'repository-plugin'
    || Object.keys(source).some((key) => !['kind', 'commit', 'pluginPath'].includes(key))
    || !/^[0-9a-f]{40}$/u.test(source.commit ?? '')
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(entry.repository ?? '')
    || entry.tag !== source.commit) {
    throw new AgentHostError('GITHUB_CATALOG_INVALID', 'Repository plugins require an exact commit and plugin directory')
  }
  integrationRelativePath(source.pluginPath, 'repository plugin path')
  const url = `https://codeload.github.com/${entry.repository}/tar.gz/${source.commit}`
  for (const asset of Object.values(entry.platforms ?? {})) {
    if (asset.url !== url || !/^sha256:[0-9a-f]{64}$/u.test(asset.sha256 ?? '')
      || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(asset.assetName ?? '')) {
      throw new AgentHostError('GITHUB_CATALOG_INVALID', 'Repository plugin archive identity is invalid')
    }
  }
  return source
}

export function repositoryPluginPreview(entry, platform) {
  validateRepositoryPlugin(entry)
  const asset = platform === null ? null : entry.platforms?.[platform]
  return {
    schemaVersion: 'openadam.agent-host-github-project-preview.v0.1',
    status: asset ? 'ready' : 'unavailable',
    origin: { kind: 'github-repository', repository: entry.repository, tag: entry.tag,
      commit: entry.source.commit, pluginPath: entry.source.pluginPath, releaseUrl: entry.releaseUrl },
    presentation: entry.presentation ?? { displayName: entry.id, summary: 'Repository plugin', homepage: `https://github.com/${entry.repository}` },
    release: null,
    compatibility: { platform, available: asset != null, asset: asset ?? null,
      reason: asset ? null : 'GITHUB_ASSET_UNAVAILABLE' },
    permissions: { message: 'Install verifies the pinned repository archive and inspects its bundled plugin. No repository build or package-install scripts run.' },
    downloadedPackage: false, registered: true,
  }
}

export async function admitRepositoryPlugin(entry, options = {}) {
  const source = validateRepositoryPlugin(entry)
  if (options.tag != null && options.tag !== source.commit) {
    throw new AgentHostError('GITHUB_SOURCE_UNPINNED', 'This repository plugin is admitted only at its catalog commit')
  }
  const asset = entry.platforms?.[options.platform]
  if (asset == null) throw new AgentHostError('GITHUB_ASSET_UNAVAILABLE', 'This repository plugin has no verified package for the current platform')
  const scratch = options.workRoot ?? await mkdtemp(join(tmpdir(), 'agent-host-repository-plugin-'))
  try {
    const downloaded = await acquireHttpsFile({
      url: asset.url, destination: join(scratch, asset.assetName), expectedSha256: asset.sha256,
      expectedBytes: asset.bytes, maxBytes: Math.min(asset.bytes, 128 * 1024 * 1024),
      fetch: options.fetch, signal: options.signal, label: `${entry.id} repository plugin`,
    })
    const origin = { kind: 'github-repository', repository: entry.repository, tag: source.commit,
      commit: source.commit, pluginPath: source.pluginPath, releaseUrl: entry.releaseUrl,
      assetName: asset.assetName, assetUrl: asset.url, assetSha256: downloaded.sha256, assetBytes: downloaded.bytes }
    const wrapped = await wrapGitHubPluginArchive({
      archivePath: downloaded.path, expectedSha256: asset.sha256, pluginPath: source.pluginPath,
      origin, expectedComponentId: options.expectedComponentId ?? entry.id, expectedVersion: entry.version,
      nodeCommand: options.nodeCommand, probe: options.probe,
      outputPath: options.outputPath, workRoot: join(scratch, 'wrap'),
    })
    return { ...wrapped, origin, downloaded }
  } finally {
    if (options.workRoot === undefined) await rm(scratch, { recursive: true, force: true })
  }
}
