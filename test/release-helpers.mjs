import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { promisify } from 'node:util'
import { pipeline } from 'node:stream/promises'

const execFileAsync = promisify(execFile)

async function write(path, contents, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents, { mode })
  await chmod(path, mode)
}

async function json(path, value) {
  await write(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function digest(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return `sha256:${hash.digest('hex')}`
}

async function descriptorFiles(root, paths) {
  const output = []
  for (const [path, executable] of paths) {
    const absolute = join(root, path)
    const info = await stat(absolute)
    output.push({ path, sha256: await digest(absolute), bytes: info.size, executable })
  }
  return output.sort((left, right) => left.path.localeCompare(right.path))
}

async function component(catalogRoot, fixtureRoot, definition, marker) {
  const root = join(fixtureRoot, `stage-${definition.id}`)
  const files = new Map([
    ['LICENSE', ['fixture license\n', false]],
    ['NOTICE', [`fixture ${marker}\n`, false]],
    ['THIRD_PARTY_NOTICES.txt', ['fixture notices\n', false]],
    ['sbom.spdx.json', [`{"fixture":"${marker}"}\n`, false]],
    ...definition.files,
  ])
  for (const [path, [contents, executable]] of files) await write(join(root, path), contents, executable ? 0o700 : 0o600)
  const descriptor = {
    schemaVersion: 'openadam.agent-host-component.v0.1',
    id: definition.id,
    version: definition.version,
    kind: definition.kind,
    files: await descriptorFiles(root, [...files].map(([path, [, executable]]) => [path, executable])),
    identityFiles: definition.identityFiles,
    entrypoints: definition.entrypoints,
    integration: definition.integration,
    legal: { license: 'LICENSE', notice: 'NOTICE', thirdPartyNotices: 'THIRD_PARTY_NOTICES.txt', sbom: 'sbom.spdx.json' },
  }
  const descriptorPath = join(root, 'component.json')
  await json(descriptorPath, descriptor)
  const archiveName = `${definition.id}-${definition.version}-darwin-arm64.tar.gz`
  const archivePath = join(catalogRoot, 'artifacts', archiveName)
  await execFileAsync('/usr/bin/tar', ['-czf', archivePath, '-C', root, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  const archiveInfo = await stat(archivePath)
  return {
    id: definition.id,
    version: definition.version,
    platform: 'darwin-arm64',
    artifact: { url: `artifacts/${archiveName}`, sha256: await digest(archivePath), bytes: archiveInfo.size, format: 'tar.gz' },
    descriptorSha256: await digest(descriptorPath),
    license: { spdx: definition.id === 'node-runtime' ? 'MIT' : 'Apache-2.0', files: ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt'] },
  }
}

export async function createReleaseFixture(root, { suiteVersion, releaseId, marker, includeObservability = false }) {
  const catalogRoot = join(root, 'catalog')
  await mkdir(join(catalogRoot, 'artifacts'), { recursive: true })
  const mathPluginIdentity = ['.codex-plugin/plugin.json', '.mcp.json', 'runtime/math-anchor-runtime/math-anchor-runtime', 'runtime/math-anchor-runtime/.math-anchor-build-manifest.json', 'skills/calculate/SKILL.md']
  const timePluginIdentity = ['.codex-plugin/plugin.json', '.mcp.json', 'server/index.mjs', 'runtime/node', 'skills/convert-time-zones/SKILL.md']
  const definitions = [
    {
      id: 'node-runtime', version: '22.22.1', kind: 'node-runtime',
      files: [['bin/node', ['#!/bin/sh\nexit 0\n', true]]],
      identityFiles: ['bin/node', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt', 'sbom.spdx.json'],
      entrypoints: { node: 'bin/node' }, integration: null,
    },
    {
      id: 'direct-execution-runtime', version: '0.1.0', kind: 'direct-runtime',
      files: [['src/cli.mjs', [`// ${marker}\n`, false]]],
      identityFiles: ['src/cli.mjs', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt', 'sbom.spdx.json'],
      entrypoints: { cli: 'src/cli.mjs' }, integration: null,
    },
    {
      id: 'math-anchor', version: '0.4.0', kind: 'math-anchor',
      files: [
        ['.agents/plugins/marketplace.json', ['{"name":"openadam"}\n', false]],
        ['plugins/math-anchor/.codex-plugin/plugin.json', ['{"name":"math-anchor","version":"0.4.0"}\n', false]],
        ['plugins/math-anchor/.mcp.json', [`{"marker":"${marker}"}\n`, false]],
        ['plugins/math-anchor/runtime/math-anchor-runtime/math-anchor-runtime', ['#!/bin/sh\nexit 0\n', true]],
        ['plugins/math-anchor/runtime/math-anchor-runtime/.math-anchor-build-manifest.json', ['{"version":"0.4.0"}\n', false]],
        ['plugins/math-anchor/skills/calculate/SKILL.md', ['---\nname: calculate\n---\n', false]],
      ],
      identityFiles: ['.agents/plugins/marketplace.json', ...mathPluginIdentity.map((path) => `plugins/math-anchor/${path}`)],
      entrypoints: { command: 'plugins/math-anchor/runtime/math-anchor-runtime/math-anchor-runtime' },
      integration: { pluginRoot: 'plugins/math-anchor', marketplaceRoot: '.', marketplace: 'openadam', plugin: 'math-anchor', pluginIdentityRelativeFiles: mathPluginIdentity, args: ['mcp'] },
    },
    {
      id: 'migratory-time', version: '2.0.0', kind: 'migratory-time',
      files: [
        ['.agents/plugins/marketplace.json', ['{"name":"migratory-time"}\n', false]],
        ['plugins/migratory-time/.codex-plugin/plugin.json', ['{"name":"migratory-time","version":"2.0.0"}\n', false]],
        ['plugins/migratory-time/.mcp.json', [`{"marker":"${marker}"}\n`, false]],
        ['plugins/migratory-time/server/index.mjs', ['process.stdin.resume()\n', false]],
        ['plugins/migratory-time/runtime/node', ['#!/bin/sh\nexit 0\n', true]],
        ['plugins/migratory-time/skills/convert-time-zones/SKILL.md', ['---\nname: convert-time-zones\n---\n', false]],
        ['scripts/runCapabilityAdapter.mjs', ['process.stdin.resume()\n', false]],
        ['capabilities/provider.json', ['{}\n', false]],
        ['capabilities/schemas/input.json', ['{}\n', false]],
        ['capabilities/schemas/output.json', ['{}\n', false]],
        ['capability-contracts/profile.json', ['{}\n', false]],
      ],
      identityFiles: ['.agents/plugins/marketplace.json', ...timePluginIdentity.map((path) => `plugins/migratory-time/${path}`), 'scripts/runCapabilityAdapter.mjs', 'capabilities/provider.json'],
      entrypoints: { server: 'plugins/migratory-time/server/index.mjs', adapter: 'scripts/runCapabilityAdapter.mjs', manifest: 'capabilities/provider.json', inputSchema: 'capabilities/schemas/input.json', outputSchema: 'capabilities/schemas/output.json', profile: 'capability-contracts/profile.json' },
      integration: { pluginRoot: 'plugins/migratory-time', marketplaceRoot: '.', marketplace: 'migratory-time', plugin: 'migratory-time', pluginIdentityRelativeFiles: timePluginIdentity },
    },
  ]
  if (includeObservability) {
    definitions.push(
      {
        id: 'agent-tool-observer', version: '0.1.0', kind: 'agent-tool-observer',
        files: [['src/cli.mjs', [`// observer ${marker}\n`, false]]],
        identityFiles: ['src/cli.mjs', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt', 'sbom.spdx.json'],
        entrypoints: { cli: 'src/cli.mjs' }, integration: null,
      },
      {
        id: 'context-surface-analyzer', version: '0.1.1', kind: 'context-surface-analyzer',
        files: [['src/cli.js', [`// analyzer ${marker}\n`, false]]],
        identityFiles: ['src/cli.js', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt', 'sbom.spdx.json'],
        entrypoints: { cli: 'src/cli.js' }, integration: null,
      },
    )
  }
  const components = []
  for (const definition of definitions) components.push(await component(catalogRoot, root, definition, marker))
  const manifestPath = join(catalogRoot, 'current.json')
  await json(manifestPath, {
    schemaVersion: 'openadam.agent-host-release.v0.2', releaseId, suiteVersion, status: 'internal-beta',
    createdAt: '2026-08-27T00:00:00.000Z', platforms: ['darwin-arm64'], components,
  })
  return manifestPath
}
