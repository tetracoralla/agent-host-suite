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
import { inferArchiveRoot, inspectGitHubPluginRoot } from '../src/github-plugin-contract.mjs'
import { wrapGitHubPluginArchive } from '../src/github-plugin-wrap.mjs'
import { admitGitHubRelease, previewGitHubProject } from '../src/github-project.mjs'
import { inspectToolUpdates, updateAvailability, updateGitHubTool } from '../src/tool-updates.mjs'
import { MAX_COMPONENT_DESCRIPTOR_BYTES } from '../src/release-artifacts.mjs'
import {
  applyDirectorySwapUpdate,
  readApplicationUpdateJournal,
  recoverApplicationUpdate,
  resolveReplacedApplicationLaunch,
  updateApplication,
  verifyReplacedApplication,
} from '../src/application-update.mjs'
import { githubOrigin, writeToolSources } from '../src/tool-sources.mjs'
import { prepareStatePaths, saveState, STATE_SCHEMA } from '../src/state.mjs'
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

async function writeApplicationVersionFixture(root, version) {
  const cli = join(root, 'app', 'bin', 'agent-host.mjs')
  await write(cli, `process.stdout.write(${JSON.stringify(String(version))} + '\\n')\n`)
  if (process.platform === 'win32') {
    await write(join(root, 'bin', 'agent-host.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0..\\app\\bin\\agent-host.mjs" %*\r\n`)
  } else {
    await write(join(root, 'bin', 'agent-host'), `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`, 0o755)
  }
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

test('plugin archive roots accept Windows tar listing separators and still reject escapes', () => {
  assert.equal(inferArchiveRoot(['glyphmark\\package.json\r', 'glyphmark\\dist\\mcp.js\r']), 'glyphmark')
  assert.equal(inferArchiveRoot(['./glyphmark/package.json', 'glyphmark/dist/mcp.js/']), 'glyphmark')
  assert.throws(() => inferArchiveRoot(['C:\\glyphmark\\package.json']), (error) => error.code === 'GITHUB_PLUGIN_INVALID')
  assert.throws(() => inferArchiveRoot(['/glyphmark/package.json']), (error) => error.code === 'GITHUB_PLUGIN_INVALID')
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
  await writeApplicationVersionFixture(current, '0.2.0')
  await writeApplicationVersionFixture(staged, '0.2.1')
  const applied = await applyDirectorySwapUpdate({ currentRoot: current, stagedRoot: staged })
  const verified = await verifyReplacedApplication({
    root: applied.currentRoot,
    expectedVersion: '0.2.1',
  })
  assert.equal(verified.version, '0.2.1')
  assert.match(verified.output, /0\.2\.1/u)
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

test('installed runtime modules do not import scripts/provider-source-build.mjs', async () => {
  const source = await readFile(new URL('../src/github-plugin-wrap.mjs', import.meta.url), 'utf8')
  assert.equal(source.includes("from '../scripts/provider-source-build.mjs'"), false)
  assert.equal(source.includes("from './provider-plugin-archive.mjs'"), true)
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

function jsonResponse(value) {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
}

function releasePayload(version, { digest, bytes = 100 } = {}) {
  const name = `glyphmark-${version}-macos-arm64.tar.gz`
  return {
    tag_name: `v${version}`,
    html_url: `https://github.com/north-pier/glyphmark/releases/tag/v${version}`,
    prerelease: false,
    draft: false,
    assets: [{
      name,
      browser_download_url: `https://github.com/north-pier/glyphmark/releases/download/v${version}/${name}`,
      size: bytes,
      digest: digest ?? `sha256:${'a'.repeat(64)}`,
    }],
  }
}

test('unregistered GitHub preview does not throw and does not download the package', async () => {
  const calls = []
  const preview = await previewGitHubProject('https://github.com/north-pier/glyphmark', {
    fetch: async (url) => {
      calls.push(String(url))
      const href = String(url)
      if (href.endsWith('/repos/north-pier/glyphmark')) {
        return jsonResponse({
          name: 'glyphmark',
          description: 'Stamp a verified mark onto a page.',
          html_url: 'https://github.com/north-pier/glyphmark',
          homepage: 'https://example.invalid/glyphmark',
          license: { spdx_id: 'Apache-2.0' },
          owner: { login: 'north-pier', html_url: 'https://github.com/north-pier', avatar_url: null },
        })
      }
      if (href.includes('/releases/latest')) return jsonResponse(releasePayload('1.1.0'))
      throw new Error(`unexpected fetch ${href}`)
    },
  })
  assert.equal(preview.registered, false)
  assert.equal(preview.downloadedPackage, false)
  assert.equal(preview.origin.repository, 'north-pier/glyphmark')
  assert.equal(calls.some((url) => url.includes('glyphmark-1.1.0-macos-arm64.tar.gz')), false)
})

test('third-party admit uses the GitHub asset digest and requests the archive', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-admit-digest-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const created = await createPluginArchive(root, { version: '1.1.0' })
  const calls = []
  const archiveBytes = await readFile(created.archive)
  await assert.rejects(
    () => admitGitHubRelease({
      url: 'https://github.com/north-pier/glyphmark',
      fetch: async (url) => {
        calls.push(String(url))
        const href = String(url)
        if (href.includes('/releases/latest') || href.includes('/releases/tags/')) {
          return jsonResponse(releasePayload('1.1.0', { digest: 'sha256:' + '0'.repeat(64), bytes: archiveBytes.length }))
        }
        return new Response(archiveBytes, { headers: { 'content-type': 'application/gzip' } })
      },
      probe: false,
      outputPath: join(root, 'wrapped.tar.gz'),
      workRoot: join(root, 'work'),
    }),
    (error) => error.code === 'RELEASE_ARTIFACT_DIGEST_MISMATCH' || error.code === 'GITHUB_CHECKSUM_INVALID',
  )
  assert.equal(calls.some((url) => url.includes('/releases/latest') || url.includes('/releases/tags/')), true)
  assert.equal(calls.some((url) => url.includes('.tar.gz')), true)
})

test('missing, wrong, and mismatched checksums fail closed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-checksum-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const created = await createPluginArchive(root)
  const bytes = await readFile(created.archive)
  await assert.rejects(
    () => admitGitHubRelease({
      url: 'https://github.com/north-pier/glyphmark',
      fetch: async (url) => {
        const href = String(url)
        if (href.includes('/releases/')) {
          const payload = releasePayload('1.0.0', { bytes: bytes.length })
          payload.assets[0].digest = undefined
          return jsonResponse(payload)
        }
        if (href.endsWith('.sha256')) return new Response('', { status: 404 })
        return new Response(bytes)
      },
      probe: false,
      workRoot: join(root, 'missing'),
    }),
    (error) => error.code === 'GITHUB_CHECKSUM_INVALID' || error.code === 'RELEASE_DOWNLOAD_FAILED',
  )
  await assert.rejects(
    () => admitGitHubRelease({
      url: 'https://github.com/north-pier/glyphmark',
      fetch: async (url) => {
        const href = String(url)
        if (href.includes('/releases/')) return jsonResponse(releasePayload('1.0.0', { digest: created.sha256, bytes: bytes.length }))
        return new Response(Buffer.concat([bytes, Buffer.from('x')]), { headers: { 'content-type': 'application/gzip' } })
      },
      probe: false,
      workRoot: join(root, 'mismatch'),
    }),
    (error) => error.code === 'RELEASE_ARTIFACT_DIGEST_MISMATCH' || error.code === 'RELEASE_ARTIFACT_SIZE_MISMATCH',
  )
})

test('inspectToolUpdates fetches persisted third-party sources and records an available version', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-tool-check-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  const origin = githubOrigin({
    repository: 'north-pier/glyphmark',
    tag: 'v1.0.0',
    assetName: 'glyphmark-1.0.0-macos-arm64.tar.gz',
    assetUrl: 'https://github.com/north-pier/glyphmark/releases/download/v1.0.0/glyphmark-1.0.0-macos-arm64.tar.gz',
    assetSha256: 'sha256:' + 'a'.repeat(64),
    assetBytes: 100,
  })
  await writeToolSources(stateRoot, { tools: { glyphmark: { origin } } })
  const paths = await prepareStatePaths(stateRoot)
  await saveState(paths, {
    schemaVersion: STATE_SCHEMA,
    suiteVersion: '0.2.0',
    channel: 'release',
    profile: 'standard',
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    components: { glyphmark: { version: '1.0.0', origin } },
    hosts: {},
    runtime: { service: null },
    observability: { enabled: false },
    availableAgentComponents: ['glyphmark'],
    agentComponents: [],
  })
  let calls = 0
  const items = await inspectToolUpdates(stateRoot, {
    fetch: async () => {
      calls += 1
      return jsonResponse(releasePayload('1.1.0'))
    },
  })
  const tool = items.find((item) => item.id === 'glyphmark')
  assert.equal(calls > 0, true)
  assert.equal(tool.availableVersion, '1.1.0')
  assert.equal(tool.availability, 'update-available')
})

test('updateGitHubTool requests the available tag, not the installed tag', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-tool-update-tag-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  const origin = githubOrigin({
    repository: 'north-pier/glyphmark',
    tag: 'v1.0.0',
    assetName: 'glyphmark-1.0.0-macos-arm64.tar.gz',
    assetUrl: 'https://github.com/north-pier/glyphmark/releases/download/v1.0.0/glyphmark-1.0.0-macos-arm64.tar.gz',
    assetSha256: 'sha256:' + 'a'.repeat(64),
    assetBytes: 100,
  })
  await writeToolSources(stateRoot, { tools: { glyphmark: { origin } } })
  const calls = []
  await assert.rejects(
    () => updateGitHubTool({
      stateRoot,
      target: 'glyphmark',
      fetch: async (url) => {
        calls.push(String(url))
        return jsonResponse(releasePayload('1.1.0'))
      },
    }),
    (error) => error.code === 'RELEASE_ARTIFACT_DIGEST_MISMATCH'
      || error.code === 'GITHUB_CHECKSUM_INVALID'
      || error.code === 'RELEASE_DOWNLOAD_FAILED'
      || error.code === 'RELEASE_ARTIFACT_SIZE_MISMATCH'
      || error.code === 'GITHUB_PLUGIN_INVALID'
      || error.code === 'NOT_INSTALLED'
      || error.code === 'GITHUB_RELEASE_INVALID',
  )
  assert.equal(calls.some((url) => url.includes('/releases/tags/v1.0.0')), false)
  assert.equal(calls.some((url) => url.includes('/releases/latest') || url.includes('/releases/tags/v1.1.0')), true)
})

test('public application update downloads instead of requiring a pre-staged payload', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-app-entry-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  const payload = Buffer.from('application-carrier-bytes')
  const digest = `sha256:${createHash('sha256').update(payload).digest('hex')}`
  const result = await updateApplication({
    stateRoot,
    currentVersion: '0.2.0',
    platform: 'darwin-arm64',
    fetch: async (url) => {
      const href = String(url)
      if (href.includes('/releases/latest')) {
        return jsonResponse({
          tag_name: 'v0.2.1',
          html_url: 'https://github.com/tetracoralla/agent-host-suite/releases/tag/v0.2.1',
          prerelease: false,
          draft: false,
          assets: [{
            name: 'Agent-Host-0.2.1-darwin-arm64.dmg',
            browser_download_url: 'https://github.com/tetracoralla/agent-host-suite/releases/download/v0.2.1/Agent-Host-0.2.1-darwin-arm64.dmg',
            size: payload.length,
            digest,
          }],
        })
      }
      return new Response(payload, { headers: { 'content-type': 'application/gzip' } })
    },
  }, { resolver: async () => null })
  assert.notEqual(result.code, 'APPLICATION_UPDATE_NOT_APPLIED')
  assert.equal(result.applied, false)
  assert.equal(result.downloaded?.sha256, digest)
})

test('failed replacement start restores the previous application and keeps the backup', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-app-recover-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const app = join(root, 'current')
  const staged = join(root, 'staged')
  const stateRoot = join(root, 'state')
  await writeApplicationVersionFixture(app, '0.2.0')
  await writeApplicationVersionFixture(staged, '0.2.1')
  await write(join(app, 'marker'), 'working-old')
  await write(join(staged, 'marker'), 'broken-new')
  let failure
  try {
    await updateApplication({
      stateRoot,
      currentVersion: '0.2.0',
      applyKind: 'directory-swap',
      currentRoot: app,
      stagedRoot: staged,
      fetch: async () => jsonResponse({
        tag_name: 'v0.2.1',
        html_url: 'https://github.com/tetracoralla/agent-host-suite/releases/tag/v0.2.1',
        prerelease: false,
        draft: false,
        assets: [{
          name: 'Agent-Host-0.2.1-directory.tar.gz',
          browser_download_url: 'https://github.com/tetracoralla/agent-host-suite/releases/download/v0.2.1/Agent-Host-0.2.1-directory.tar.gz',
          size: 100,
          digest: 'sha256:' + 'a'.repeat(64),
        }],
      }),
    }, { resolver: async () => null, runner: async () => ({ status: 1, stderr: 'does not start', stdout: '' }) })
  } catch (error) {
    failure = error.code
  }
  assert.equal(failure, 'APPLICATION_UPDATE_RELAUNCH_FAILED')
  assert.equal(await readFile(join(app, 'marker'), 'utf8'), 'working-old')
  assert.equal(await readFile(join(`${app}.previous`, 'marker'), 'utf8'), 'working-old')
})

test('macOS .app replacement launch uses Contents/MacOS, not bin/agent-host', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-macos-launch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const exec = join(root, 'Contents', 'MacOS', 'agent-host')
  await write(exec, `#!/bin/sh\necho 0.2.1\n`, 0o755)
  const launch = await resolveReplacedApplicationLaunch({ root, args: ['--version'] })
  assert.equal(launch.command, exec)
  const verified = await verifyReplacedApplication({ root, expectedVersion: '0.2.1' })
  assert.match(verified.output, /0\.2\.1/u)
})

test('public application update stages a directory carrier and replaces the installed root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-app-apply-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const current = join(root, 'current')
  const stagedSource = join(root, 'payload')
  const stateRoot = join(root, 'state')
  await writeApplicationVersionFixture(current, '0.2.0')
  await writeApplicationVersionFixture(stagedSource, '0.2.1')
  const archive = join(root, 'Agent-Host-0.2.1-directory.tar.gz')
  await execFileAsync(tar, ['-czf', archive, '-C', stagedSource, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  const payload = await readFile(archive)
  const digest = `sha256:${createHash('sha256').update(payload).digest('hex')}`
  const result = await updateApplication({
    stateRoot,
    currentVersion: '0.2.0',
    currentRoot: current,
    platform: 'directory',
    relaunch: false,
    fetch: async (url) => {
      const href = String(url)
      if (href.includes('/releases/latest')) {
        return jsonResponse({
          tag_name: 'v0.2.1',
          html_url: 'https://github.com/tetracoralla/agent-host-suite/releases/tag/v0.2.1',
          prerelease: false,
          draft: false,
          assets: [{
            name: 'Agent-Host-0.2.1-directory.tar.gz',
            browser_download_url: 'https://github.com/tetracoralla/agent-host-suite/releases/download/v0.2.1/Agent-Host-0.2.1-directory.tar.gz',
            size: payload.length,
            digest,
          }],
        })
      }
      return new Response(payload, { headers: { 'content-type': 'application/gzip' } })
    },
  }, {
    resolver: async () => ({ kind: 'directory', root: current, version: '0.2.0' }),
  })
  assert.equal(result.applied, true)
  assert.equal(result.downloaded?.sha256, digest)
  const verified = await verifyReplacedApplication({ root: current, expectedVersion: '0.2.1' })
  assert.match(verified.output, /0\.2\.1/u)
})

test('application recovery does not interrupt a live update and recovered is idempotent', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-app-recover-live-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const current = join(root, 'current')
  const previous = join(root, 'previous')
  const stateRoot = join(root, 'state')
  await writeApplicationVersionFixture(current, 'new-in-progress')
  await writeApplicationVersionFixture(previous, 'old')
  const { writePrivateJson } = await import('../src/json.mjs')
  const { prepareStatePaths } = await import('../src/state.mjs')
  const paths = await prepareStatePaths(stateRoot)
  await writePrivateJson(join(paths.root, 'application-update.json'), {
    schemaVersion: 'openadam.agent-host-application-update-state.v0.1',
    phase: 'verifying',
    channel: 'stable',
    fromVersion: 'old',
    toVersion: 'new-in-progress',
    currentRoot: current,
    previousRoot: previous,
    pid: process.pid,
    processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    updatedAt: new Date().toISOString(),
  })
  const live = await recoverApplicationUpdate(stateRoot)
  assert.equal(live.recovered, false)
  assert.equal(live.live, true)
  assert.equal(await readFile(join(current, 'app/bin/agent-host.mjs'), 'utf8').then((text) => text.includes('new-in-progress')), true)
  const { writePrivateJson: writeJournal } = await import('../src/json.mjs')
  await writeJournal(join(paths.root, 'application-update.json'), {
    schemaVersion: 'openadam.agent-host-application-update-state.v0.1',
    phase: 'recovered',
    channel: 'stable',
    fromVersion: 'old',
    toVersion: 'new-in-progress',
    currentRoot: current,
    previousRoot: previous,
    pid: process.pid,
    processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    updatedAt: new Date().toISOString(),
    error: { code: 'APPLICATION_UPDATE_INTERRUPTED', message: 'restored' },
  })
  await write(join(current, 'marker'), 'later-user-restored-version')
  const again = await recoverApplicationUpdate(stateRoot)
  assert.equal(again.recovered, false)
  assert.equal(await readFile(join(current, 'marker'), 'utf8'), 'later-user-restored-version')
})

test('auto-download stores a verified installer instead of a dry-run preview', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-auto-download-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { executeAutoUpdates } = await import('../src/auto-update.mjs')
  const { setUpdatePreferences } = await import('../src/update-preferences.mjs')
  const payload = Buffer.from('verified-application-carrier')
  const digest = `sha256:${createHash('sha256').update(payload).digest('hex')}`
  await setUpdatePreferences(root, { autoCheck: true, autoDownload: true, autoInstall: false })
  const result = await executeAutoUpdates(root, {
    force: true,
    currentVersion: '0.2.0',
    platform: 'directory',
    fetch: async (url) => {
      const href = String(url)
      if (href.includes('/releases/latest') || href.includes('/releases/tags/')) {
        return jsonResponse({
          tag_name: 'v0.2.1',
          html_url: 'https://github.com/tetracoralla/agent-host-suite/releases/tag/v0.2.1',
          prerelease: false,
          draft: false,
          assets: [{
            name: 'Agent-Host-0.2.1-directory.tar.gz',
            browser_download_url: 'https://github.com/tetracoralla/agent-host-suite/releases/download/v0.2.1/Agent-Host-0.2.1-directory.tar.gz',
            size: payload.length,
            digest,
          }],
        })
      }
      return new Response(payload, { headers: { 'content-type': 'application/gzip' } })
    },
  }, { resolver: async () => null })
  assert.equal(result.status, 'ok')
  assert.equal(result.downloaded[0].dryRun, false)
  assert.equal(result.downloaded[0].applied, false)
  assert.equal(result.downloaded[0].downloaded.sha256, digest)
  assert.equal((await stat(result.downloaded[0].downloaded.path)).size, payload.length)
})

test('wrapper and importer share a descriptor bound that admits a real plugin install', async (t) => {
  assert.equal(MAX_COMPONENT_DESCRIPTOR_BYTES >= 4 * 1024 * 1024, true)
  const root = await mkdtemp(join(tmpdir(), 'agent-host-install-bound-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const created = await createPluginArchive(root)
  const wrapped = await wrapGitHubPluginArchive({
    archivePath: created.archive,
    expectedSha256: created.sha256,
    origin: githubOrigin({
      repository: 'north-pier/glyphmark',
      tag: 'v1.0.0',
      assetName: 'glyphmark-1.0.0.tar.gz',
      assetUrl: 'https://github.com/north-pier/glyphmark/releases/download/v1.0.0/glyphmark-1.0.0.tar.gz',
      assetSha256: created.sha256,
      assetBytes: created.bytes,
    }),
    expectedTools: ['glyphmark.ping'],
    probe: false,
    outputPath: join(root, 'glyphmark-host.tar.gz'),
    workRoot: join(root, 'wrap'),
  })
  const { observeLocalComponentArtifact } = await import('../src/release-artifacts.mjs')
  const observation = await observeLocalComponentArtifact(wrapped.wrapped.path)
  assert.equal(observation.descriptor.id, 'glyphmark')
  assert.equal(observation.descriptor.version, '1.0.0')
  assert.equal(observation.observed.archiveBytes > 0, true)
})

test('unknown plugin licenses stay NOASSERTION and are not rewritten as Apache-2.0', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-license-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const created = await createPluginArchive(root)
  const packageJson = JSON.parse(await readFile(join(created.plugin, 'package.json'), 'utf8'))
  delete packageJson.license
  await writeFile(join(created.plugin, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`)
  const contract = await inspectGitHubPluginRoot(created.plugin)
  assert.equal(contract.licenseSpdx, 'NOASSERTION')
})

test('R3 failed relaunch that already restored does not re-recover over a later user restore', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-r3-restored-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const app = join(root, 'current')
  const staged = join(root, 'staged')
  const stateRoot = join(root, 'state')
  await writeApplicationVersionFixture(app, '0.2.0')
  await writeApplicationVersionFixture(staged, '0.2.1')
  await write(join(app, 'marker'), 'working-old')
  await write(join(staged, 'marker'), 'broken-new')
  let failure
  try {
    await updateApplication({
      stateRoot,
      currentVersion: '0.2.0',
      applyKind: 'directory-swap',
      currentRoot: app,
      stagedRoot: staged,
      fetch: async () => jsonResponse({
        tag_name: 'v0.2.1',
        html_url: 'https://github.com/tetracoralla/agent-host-suite/releases/tag/v0.2.1',
        prerelease: false,
        draft: false,
        assets: [{
          name: 'Agent-Host-0.2.1-directory.tar.gz',
          browser_download_url: 'https://github.com/tetracoralla/agent-host-suite/releases/download/v0.2.1/Agent-Host-0.2.1-directory.tar.gz',
          size: 100,
          digest: 'sha256:' + 'a'.repeat(64),
        }],
      }),
    }, { resolver: async () => null, runner: async () => ({ status: 1, stderr: 'does not start', stdout: '' }) })
  } catch (error) {
    failure = error.code
  }
  assert.equal(failure, 'APPLICATION_UPDATE_RELAUNCH_FAILED')
  assert.equal(await readFile(join(app, 'marker'), 'utf8'), 'working-old')
  const journal = await readApplicationUpdateJournal(stateRoot)
  assert.equal(journal.phase, 'recovered')
  assert.equal(journal.restored, true)
  await write(join(app, 'marker'), 'later-user-restored-version')
  const again = await recoverApplicationUpdate(stateRoot)
  assert.equal(again.recovered, false)
  assert.equal(again.phase, 'recovered')
  assert.equal(await readFile(join(app, 'marker'), 'utf8'), 'later-user-restored-version')
})
