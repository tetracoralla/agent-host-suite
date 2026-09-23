import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runFile } from '../src/process.mjs'
import { admitRepositoryPlugin, repositoryPluginPreview, validateRepositoryPlugin } from '../src/repository-plugin.mjs'
import { observeLocalComponentArtifact } from '../src/release-artifacts.mjs'
import { assertCompatibleOrigin, readToolSources, writeToolSources } from '../src/tool-sources.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'host-repository-plugin-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const commit = 'a'.repeat(40)
  const sourceRoot = join(root, `repository-${commit}`)
  const plugin = join(sourceRoot, 'plugins/example')
  await mkdir(join(plugin, '.codex-plugin'), { recursive: true })
  await writeFile(join(plugin, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'example', version: '1.0.0', description: 'A bundled plugin' }))
  await writeFile(join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { example: { command: 'node', args: ['server.mjs'] } } }))
  await writeFile(join(plugin, 'package.json'), JSON.stringify({ name: 'example', version: '1.0.0', license: 'Apache-2.0', openadam: { expectedTools: ['example.run'] } }))
  await writeFile(join(plugin, 'server.mjs'), 'throw new Error("probe was disabled")')
  await writeFile(join(plugin, 'LICENSE'), 'Apache-2.0')
  await writeFile(join(sourceRoot, 'private-maintainer-note.txt'), 'not part of the plugin')
  const archive = join(root, 'source.tar.gz')
  await runFile(process.platform === 'win32' ? 'tar.exe' : '/usr/bin/tar', ['-czf', archive, '-C', root, `repository-${commit}`], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  const bytes = await readFile(archive)
  const entry = { id: 'example', version: '1.0.0', repository: 'owner/repository', tag: commit,
    releaseUrl: `https://github.com/owner/repository/tree/${commit}`,
    source: { kind: 'repository-plugin', commit, pluginPath: 'plugins/example' },
    platforms: { 'darwin-arm64': { assetName: 'source.tar.gz', url: `https://codeload.github.com/owner/repository/tar.gz/${commit}`,
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, bytes: bytes.length } } }
  return { root, entry, bytes, fetch: async () => new Response(bytes) }
}

test('pinned repository plugin is sealed without copying source or running a build; origin survives storage', async (t) => {
  const value = await fixture(t)
  const preview = repositoryPluginPreview(value.entry, 'darwin-arm64')
  assert.equal(preview.compatibility.available, true)
  assert.equal(preview.downloadedPackage, false)
  const result = await admitRepositoryPlugin(value.entry, { platform: 'darwin-arm64', probe: false, fetch: value.fetch,
    outputPath: join(value.root, 'component.tar.gz') })
  assert.equal(result.origin.kind, 'github-repository')
  assert.equal(result.descriptor.files.some((file) => file.path.includes('private-maintainer-note')), false)
  const observed = await observeLocalComponentArtifact(result.wrapped.path)
  assert.equal(observed.descriptor.origin.commit, value.entry.source.commit)
  await writeToolSources(join(value.root, 'state'), { tools: { example: { origin: result.origin } } })
  assert.equal((await readToolSources(join(value.root, 'state'))).tools.example.origin.kind, 'github-repository')
  assert.throws(() => assertCompatibleOrigin(result.origin, { ...result.origin, repository: 'other/repository' }), { code: 'GITHUB_SOURCE_CONFLICT' })
})

test('repository admission rejects moving refs, path escape, changed bytes, version drift and unsupported platform', async (t) => {
  const value = await fixture(t)
  const entry = value.entry
  assert.throws(() => validateRepositoryPlugin({ ...entry, source: { ...entry.source, commit: 'main' } }), { code: 'GITHUB_CATALOG_INVALID' })
  assert.throws(() => validateRepositoryPlugin({ ...entry, source: { ...entry.source, pluginPath: '../outside' } }))
  const options = { platform: 'darwin-arm64', probe: false, fetch: value.fetch, outputPath: join(value.root, 'output.tar.gz') }
  await assert.rejects(admitRepositoryPlugin(entry, { ...options, tag: 'main' }), { code: 'GITHUB_SOURCE_UNPINNED' })
  await assert.rejects(admitRepositoryPlugin(entry, { ...options, platform: 'win32-x64' }), { code: 'GITHUB_ASSET_UNAVAILABLE' })
  await assert.rejects(admitRepositoryPlugin({ ...entry, version: '2.0.0' }, options), { code: 'GITHUB_TOOL_IDENTITY_DRIFT' })
  await assert.rejects(admitRepositoryPlugin(entry, { ...options, fetch: async () => new Response(Buffer.alloc(value.bytes.length)) }))
  await assert.rejects(readFile(options.outputPath), { code: 'ENOENT' })
})
