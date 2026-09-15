import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { parseGitHubResource, parseSha256File } from '../src/github-api.mjs'
import { sanitizeSvg, presentationFromPackageMetadata } from '../src/tool-presentation.mjs'
import { inspectGitHubPluginRoot } from '../src/github-plugin-contract.mjs'
import { wrapGitHubPluginArchive } from '../src/github-plugin-wrap.mjs'
import { previewGitHubProject } from '../src/github-project.mjs'
import { updateAvailability } from '../src/tool-updates.mjs'
import { applyDirectorySwapUpdate, verifyReplacedApplication } from '../src/application-update.mjs'
import { inspectFeaturedReadiness } from '../src/featured-readiness.mjs'
import { browseRecommendedTools } from '../src/github-project.mjs'
import { human } from '../src/cli.mjs'
import { createIsolatedCli, runIsolatedCli } from './cli-isolation.mjs'

const execFileAsync = promisify(execFile)
const tar = process.platform === 'win32' ? 'tar.exe' : '/usr/bin/tar'

async function write(path, contents, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents, { mode })
  if (mode !== 0o600) await chmod(path, mode)
}

async function createPluginArchive(root, {
  id = 'glyphmark',
  version = '1.0.0',
  displayName = 'Glyphmark',
  summary = 'Stamp a verified mark onto a page.',
  author = 'North Pier Labs',
  homepage = 'https://example.invalid/glyphmark',
  logo = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8"/></svg>\n',
} = {}) {
  const plugin = join(root, id)
  await write(join(plugin, 'package.json'), `${JSON.stringify({
    name: id,
    version,
    description: summary,
    author,
    homepage,
    license: 'Apache-2.0',
    openadam: { displayName, summary, logo: 'logo.svg', expectedTools: ['glyphmark.ping'] },
    bin: { [id]: 'dist/cli.js' },
  }, null, 2)}\n`)
  await write(join(plugin, '.codex-plugin/plugin.json'), `${JSON.stringify({
    name: id, version, skills: './skills/', mcpServers: './.mcp.json',
  })}\n`)
  await write(join(plugin, '.mcp.json'), `${JSON.stringify({
    mcpServers: { [id]: { command: 'node', args: ['dist/mcp.js'], cwd: '.' } },
  })}\n`)
  await write(join(plugin, 'dist/mcp.js'), 'process.stdin.resume()\n')
  await write(join(plugin, 'dist/cli.js'), `process.stdout.write('${version}\\n')\n`)
  await write(join(plugin, `skills/${id}-mark/SKILL.md`), `---\nname: ${id}-mark\n---\nStamp a mark.\n`)
  await write(join(plugin, 'LICENSE'), 'Apache-2.0\n')
  await write(join(plugin, 'NOTICE'), `${displayName}\n`)
  await write(join(plugin, 'logo.svg'), logo)
  const archive = join(root, `${id}-${version}.tar.gz`)
  await execFileAsync(tar, ['-czf', archive, '-C', root, id], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  const bytes = (await stat(archive)).size
  const sha256 = `sha256:${createHash('sha256').update(await readFile(archive)).digest('hex')}`
  return { archive, sha256, bytes, plugin }
}

test('GitHub URLs parse repository, tag, and asset without treating HTML as an installer', () => {
  assert.deepEqual(parseGitHubResource('tetracoralla/armorial').repository, 'tetracoralla/armorial')
  assert.equal(parseGitHubResource('https://github.com/tetracoralla/armorial/releases/tag/v0.8.0').tag, 'v0.8.0')
  assert.equal(
    parseGitHubResource('https://github.com/tetracoralla/armorial/releases/download/v0.8.0/armorial-0.8.0-codex-plugin-macos-arm64.tar.gz').assetName,
    'armorial-0.8.0-codex-plugin-macos-arm64.tar.gz',
  )
  assert.throws(() => parseGitHubResource('http://github.com/tetracoralla/armorial'), (error) => error.code === 'GITHUB_URL_INVALID')
  assert.equal(
    parseSha256File('db2cd4acb1b1e0ba96ece12d03f1d2d4d1fc8f5fabc1b1c6999ea3cb07b87fcd  armorial-0.8.0-codex-plugin-macos-arm64.tar.gz\n').sha256,
    'sha256:db2cd4acb1b1e0ba96ece12d03f1d2d4d1fc8f5fabc1b1c6999ea3cb07b87fcd',
  )
})

test('tool presentation prefers package metadata and rejects scripted SVG logos', () => {
  const presentation = presentationFromPackageMetadata({
    packageJson: {
      name: 'glyphmark',
      description: 'Stamp a verified mark onto a page.',
      author: 'North Pier Labs',
      homepage: 'https://example.invalid/glyphmark',
      openadam: { displayName: 'Glyphmark', logo: 'logo.svg' },
    },
    pluginJson: { name: 'glyphmark', version: '1.0.0' },
    files: ['logo.svg', 'package.json'],
  })
  assert.equal(presentation.displayName, 'Glyphmark')
  assert.equal(presentation.author, 'North Pier Labs')
  assert.equal(presentation.logoPath, 'logo.svg')
  assert.throws(() => sanitizeSvg('<svg><script>alert(1)</script></svg>'), (error) => error.code === 'TOOL_LOGO_INVALID')
  assert.throws(() => sanitizeSvg('<svg><image href="https://evil.example/x"/></svg>'), (error) => error.code === 'TOOL_LOGO_INVALID')
  sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8"/></svg>')
})

test('third-party rename and logo change keep the same GitHub origin identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-glyphmark-upgrade-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = await createPluginArchive(root, { version: '1.0.0', displayName: 'Glyphmark' })
  const second = await createPluginArchive(join(root, 'v11'), {
    version: '1.1.0',
    displayName: 'Glyphmark Studio',
    logo: '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="4" cy="4" r="3"/></svg>\n',
  })
  const origin = {
    kind: 'github-release',
    repository: 'north-pier/glyphmark',
    tag: 'v1.0.0',
    releaseUrl: 'https://github.com/north-pier/glyphmark/releases/tag/v1.0.0',
    assetName: 'glyphmark-1.0.0.tar.gz',
    assetUrl: 'https://github.com/north-pier/glyphmark/releases/download/v1.0.0/glyphmark-1.0.0.tar.gz',
    assetSha256: first.sha256,
    assetBytes: first.bytes,
  }
  const wrappedFirst = await wrapGitHubPluginArchive({
    archivePath: first.archive, expectedSha256: first.sha256, origin,
    expectedTools: ['glyphmark.ping'], probe: false,
    outputPath: join(root, 'g1.tar.gz'), workRoot: join(root, 'w1'),
  })
  const wrappedSecond = await wrapGitHubPluginArchive({
    archivePath: second.archive, expectedSha256: second.sha256,
    origin: { ...origin, tag: 'v1.1.0', assetName: 'glyphmark-1.1.0.tar.gz', assetSha256: second.sha256, assetBytes: second.bytes },
    expectedTools: ['glyphmark.ping'], probe: false,
    outputPath: join(root, 'g2.tar.gz'), workRoot: join(root, 'w2'),
  })
  assert.equal(wrappedFirst.descriptor.id, wrappedSecond.descriptor.id)
  assert.equal(wrappedFirst.presentation.displayName, 'Glyphmark')
  assert.equal(wrappedSecond.presentation.displayName, 'Glyphmark Studio')
  assert.equal(wrappedFirst.origin.repository, wrappedSecond.origin.repository)
  assert.notEqual(wrappedFirst.descriptor.version, wrappedSecond.descriptor.version)
})

test('GitHub plugin wrap preserves plugin bytes and records upstream plus wrapped digests', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-glyphmark-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const created = await createPluginArchive(root)
  const original = await readFile(join(created.plugin, 'dist/mcp.js'))
  const wrapped = await wrapGitHubPluginArchive({
    archivePath: created.archive,
    expectedSha256: created.sha256,
    origin: {
      kind: 'github-release',
      repository: 'north-pier/glyphmark',
      tag: 'v1.0.0',
      releaseUrl: 'https://github.com/north-pier/glyphmark/releases/tag/v1.0.0',
      assetName: 'glyphmark-1.0.0.tar.gz',
      assetUrl: 'https://github.com/north-pier/glyphmark/releases/download/v1.0.0/glyphmark-1.0.0.tar.gz',
      assetSha256: created.sha256,
      assetBytes: created.bytes,
    },
    expectedTools: ['glyphmark.ping'],
    probe: false,
    outputPath: join(root, 'glyphmark-host.tar.gz'),
    workRoot: join(root, 'wrap'),
  })
  assert.equal(wrapped.descriptor.id, 'glyphmark')
  assert.equal(wrapped.descriptor.version, '1.0.0')
  assert.equal(wrapped.presentation.displayName, 'Glyphmark')
  assert.equal(wrapped.presentation.author, 'North Pier Labs')
  assert.equal(wrapped.upstream.sha256, created.sha256)
  assert.equal(wrapped.wrapped.sha256.startsWith('sha256:'), true)
  assert.notEqual(wrapped.wrapped.sha256, wrapped.upstream.sha256)
  const extractedPlugin = await inspectGitHubPluginRoot(created.plugin)
  assert.equal(extractedPlugin.command, 'dist/mcp.js')
  const copied = await execFileAsync(tar, ['-xOzf', wrapped.wrapped.path, './marketplace/plugins/glyphmark/dist/mcp.js'])
  assert.equal(copied.stdout, original.toString('utf8'))
})

test('GitHub project preview uses API metadata and does not download the package', async () => {
  const calls = []
  const fetch = async (url) => {
    calls.push(String(url))
    const href = String(url)
    if (href.endsWith('/repos/north-pier/glyphmark')) {
      return new Response(JSON.stringify({
        name: 'glyphmark',
        description: 'Stamp a verified mark onto a page.',
        html_url: 'https://github.com/north-pier/glyphmark',
        homepage: 'https://example.invalid/glyphmark',
        license: { spdx_id: 'Apache-2.0' },
        owner: { login: 'north-pier', html_url: 'https://github.com/north-pier', avatar_url: null },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (href.includes('/releases/latest')) {
      return new Response(JSON.stringify({
        tag_name: 'v1.0.0',
        name: 'Glyphmark 1.0.0',
        html_url: 'https://github.com/north-pier/glyphmark/releases/tag/v1.0.0',
        prerelease: false,
        draft: false,
        assets: [{
          name: 'glyphmark-1.0.0.tar.gz',
          browser_download_url: 'https://github.com/north-pier/glyphmark/releases/download/v1.0.0/glyphmark-1.0.0.tar.gz',
          size: 2048,
          content_type: 'application/gzip',
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`unexpected fetch ${href}`)
  }
  const preview = await previewGitHubProject('https://github.com/north-pier/glyphmark', { fetch })
  assert.equal(preview.downloadedPackage, false)
  assert.equal(preview.presentation.displayName, 'glyphmark')
  assert.equal(preview.origin.repository, 'north-pier/glyphmark')
  assert.equal(calls.some((url) => url.includes('glyphmark-1.0.0.tar.gz')), false)
})

test('update availability distinguishes missing, current, available, and no platform asset', () => {
  assert.equal(updateAvailability({ installedVersion: null, availableVersion: '0.8.0' }), 'not-installed')
  assert.equal(updateAvailability({ installedVersion: '0.7.0', availableVersion: '0.8.0' }), 'update-available')
  assert.equal(updateAvailability({ installedVersion: '0.8.0', availableVersion: '0.8.0' }), 'current')
  assert.equal(updateAvailability({ installedVersion: '0.8.0', availableVersion: '0.8.0', platformAvailable: false }), 'no-platform-asset')
})

test('application directory swap replaces files and reads the new version', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-app-swap-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const current = join(root, 'current')
  const staged = join(root, 'staged')
  await mkdir(join(current, 'bin'), { recursive: true })
  await mkdir(join(staged, 'bin'), { recursive: true })
  await write(join(current, 'bin/agent-host'), '#!/bin/sh\necho 0.2.0\n', 0o755)
  await write(join(staged, 'bin/agent-host'), '#!/bin/sh\necho 0.2.1\n', 0o755)
  const applied = await applyDirectorySwapUpdate({ currentRoot: current, stagedRoot: staged })
  const verified = await verifyReplacedApplication({
    root: applied.currentRoot,
    expectedVersion: '0.2.1',
    command: join(applied.currentRoot, 'bin/agent-host'),
    args: [],
  })
  assert.equal(verified.version, '0.2.1')
})

test('featured readiness records working set as an experimental variable, not a scoring gate', async () => {
  const report = await inspectFeaturedReadiness({
    profile: 'local-dogfood',
    channel: 'release',
    components: {
      'math-anchor': { version: '0.4.0', identityFiles: [], plugin: 'math-anchor' },
      'migratory-time': { version: '2.0.0', identityFiles: [], plugin: 'migratory-time' },
      armorial: { version: '0.8.0', identityFiles: [], plugin: 'armorial' },
      glyphmark: { version: '1.0.0', identityFiles: [], plugin: 'glyphmark' },
    },
    agentComponents: ['math-anchor', 'migratory-time', 'armorial', 'glyphmark'],
    availableAgentComponents: ['math-anchor', 'migratory-time', 'armorial', 'glyphmark'],
    hosts: { codex: { entries: [{ component: 'armorial' }] } },
    runtime: { service: null },
  }, {
    inspectCodexHost: async () => ({
      entries: [{
        component: 'armorial',
        pluginPresent: true,
        pluginEnabled: true,
        installedVersion: '0.8.0',
        requestedVersion: '0.8.0',
        installedIdentityMatched: true,
        cacheStatus: 'matched',
        liveCacheObserved: true,
      }],
    }),
    inspectClaudeHost: async () => ({ entries: [] }),
    inspectZcodeHost: async () => ({ entries: [] }),
  })
  assert.equal(report.userStatus, 'ok')
  assert.equal(report.adoptionEvidence, false)
  assert.equal(report.checks.find((item) => item.id === 'recipe.consistency')?.status, 'ok')
  assert.equal(report.checks.find((item) => item.id === 'recipe.consistency')?.detail.experimentalVariable, true)
  assert.ok(report.checks.find((item) => item.id === 'recipe.consistency')?.detail.extra.includes('glyphmark'))
  assert.match(human(report), /User readiness: ok/u)
})

test('recommended tools come from the GitHub registry without Host tool-id branches', async () => {
  const catalog = await browseRecommendedTools()
  assert.equal(catalog.marketplace, false)
  const armorial = catalog.tools.find((tool) => tool.id === 'armorial')
  assert.equal(armorial.repository, 'tetracoralla/armorial')
  assert.equal(armorial.version, '0.8.0')
  assert.equal(armorial.releaseUrl.includes('v0.8.0'), true)
})

test('CLI exposes updates and GitHub add without treating fetch --carrier as app update', async (t) => {
  const isolated = await createIsolatedCli(t)
  const help = runIsolatedCli(['--help'], isolated)
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /tools add --github/u)
  assert.match(help.stdout, /updates status/u)
  assert.match(help.stdout, /app update/u)
  const browse = runIsolatedCli(['tools', 'browse', '--json'], isolated)
  assert.equal(browse.status, 0, browse.stderr)
  const body = JSON.parse(browse.stdout)
  assert.equal(body.tools.some((tool) => tool.id === 'armorial'), true)
})
