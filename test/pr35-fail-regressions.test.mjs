import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { selectReleaseAsset } from '../src/github-api.mjs'
import { compareSemVer } from '../src/semver.mjs'
import {
  checkApplicationUpdate,
  readApplicationUpdateJournal,
  readReplacedApplicationVersion,
  relaunchReplacedApplication,
  resolveManagerRelaunchLaunch,
  updateApplication,
  verifyReplacedApplication,
} from '../src/application-update.mjs'
import { loadGitHubToolCatalog } from '../src/github-registry.mjs'
import { setUpdatePreferences } from '../src/update-preferences.mjs'
import { prepareStatePaths, saveState, STATE_SCHEMA, loadState } from '../src/state.mjs'
import { installGitHubTool, updateAvailability, updateGitHubTool } from '../src/tool-updates.mjs'
import { mergeUpdateCandidates, readUpdateCandidates } from '../src/update-candidates.mjs'
import { githubOrigin } from '../src/tool-sources.mjs'
import { wrapGitHubPluginArchive } from '../src/github-plugin-wrap.mjs'
import { createReleaseFixture } from './release-helpers.mjs'
import { setup } from '../src/setup.mjs'
import { withLifecycleMutation } from '../src/lifecycle-lock.mjs'
import { statePaths } from '../src/state.mjs'
import { compatibleApplicationState, healthyCatalogPreflight } from './helpers.mjs'

const execFileAsync = promisify(execFile)
const tar = process.platform === 'win32' ? 'tar.exe' : '/usr/bin/tar'

async function write(path, contents, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents, { mode })
  if (mode !== 0o600) await chmod(path, mode)
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
}

async function createPluginArchive(root, {
  id = 'review-alpha',
  version = '1.0.0',
  displayName = 'Review Alpha',
} = {}) {
  const plugin = join(root, id)
  await write(join(plugin, 'package.json'), `${JSON.stringify({
    name: id,
    version,
    description: displayName,
    license: 'Apache-2.0',
    openadam: { displayName, summary: displayName, expectedTools: [`${id}.ping`] },
  }, null, 2)}\n`)
  await write(join(plugin, '.codex-plugin/plugin.json'), `${JSON.stringify({
    name: id, version, skills: './skills/', mcpServers: './.mcp.json',
  })}\n`)
  await write(join(plugin, '.mcp.json'), `${JSON.stringify({
    mcpServers: { [id]: { command: 'node', args: ['dist/mcp.js'], cwd: '.' } },
  })}\n`)
  await write(join(plugin, 'dist/mcp.js'), 'process.stdin.resume()\n')
  await write(join(plugin, `skills/${id}-mark/SKILL.md`), `---\nname: ${id}-mark\n---\n`)
  await write(join(plugin, 'LICENSE'), 'Apache-2.0\n')
  await write(join(plugin, 'NOTICE'), `${displayName}\n`)
  const archive = join(root, `${id}-${version}.tar.gz`)
  await execFileAsync(tar, ['-czf', archive, '-C', root, id], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  const bytes = (await stat(archive)).size
  const sha256 = `sha256:${createHash('sha256').update(await readFile(archive)).digest('hex')}`
  return { archive, sha256, bytes, id, version }
}

function healthyProbe(component) {
  const result = {
    status: 'ok',
    tools: component.expectedTools,
    expectedTools: component.expectedTools,
    server: { name: 'Review Fixture', version: component.version },
  }
  return { first: result, repeat: result, firstLaunchMs: 1, repeatLaunchMs: 1, firstLaunchTimeoutMs: 60000, repeatTimeoutMs: component.healthTimeoutMs }
}

async function installedEnvironment(stateRoot) {
  const paths = await prepareStatePaths(stateRoot)
  await saveState(paths, {
    schemaVersion: STATE_SCHEMA,
    suiteVersion: '0.2.0',
    channel: 'release',
    profile: 'standard',
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    components: {
      'node-runtime': {
        version: '22.22.1',
        command: process.execPath,
        root: join(stateRoot, 'node-runtime'),
        displayName: 'Node',
      },
    },
    hosts: {},
    runtime: { service: null },
    observability: { enabled: false },
    availableAgentComponents: ['node-runtime'],
    agentComponents: [],
  })
  return {
    paths,
    dependencies: {
      mcpProbe: healthyProbe,
      catalogPreflight: healthyCatalogPreflight,
      applicationStatePreflight: compatibleApplicationState,
    },
  }
}

test('F7 SemVer: pre-release is older than the matching release', () => {
  assert.equal(compareSemVer('1.0.0-beta.1', '1.0.0'), -1)
  assert.equal(compareSemVer('1.0.0', '1.0.0-beta.1'), 1)
  assert.equal(updateAvailability({ installedVersion: '1.0.0-beta.1', availableVersion: '1.0.0' }), 'update-available')
  assert.equal(updateAvailability({ installedVersion: '1.0.0', availableVersion: '1.0.0-beta.1' }), 'newer-than-catalog')
})

test('F8 Host app check does not treat an older GitHub latest as update-available', async () => {
  const check = await checkApplicationUpdate({
    currentVersion: '0.3.0',
    platform: 'directory',
    channel: 'stable',
    fetch: async () => jsonResponse({
      tag_name: 'v0.2.0',
      html_url: 'https://github.com/tetracoralla/agent-host-suite/releases/tag/v0.2.0',
      prerelease: false,
      draft: false,
      assets: [{
        name: 'Agent-Host-0.2.0-directory.tar.gz',
        browser_download_url: 'https://example.invalid/Agent-Host-0.2.0-directory.tar.gz',
        size: 10,
        digest: `sha256:${'a'.repeat(64)}`,
      }],
    }),
  })
  assert.equal(check.availability, 'current')
  assert.equal(check.availableVersion, '0.2.0')
})

test('F10 sole wrong-platform archive is refused', () => {
  assert.throws(
    () => selectReleaseAsset({
      assets: [{ name: 'example-1.0.0-macos-arm64.tar.gz', url: 'https://example.invalid/a.tar.gz', bytes: 1 }],
    }, { platform: 'win32-x64' }),
    (error) => error.code === 'GITHUB_ASSET_UNAVAILABLE',
  )
})

test('F1 updateApplication without explicit stateRoot still downloads the carrier', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-f1-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateRoot = join(root, 'state')
  const previous = process.env.AGENT_HOST_STATE_ROOT
  process.env.AGENT_HOST_STATE_ROOT = stateRoot
  t.after(() => {
    if (previous === undefined) delete process.env.AGENT_HOST_STATE_ROOT
    else process.env.AGENT_HOST_STATE_ROOT = previous
  })

  const payload = Buffer.from('carrier-bytes')
  const digest = `sha256:${createHash('sha256').update(payload).digest('hex')}`
  let downloaded = false
  const result = await updateApplication({
    currentVersion: '0.2.0',
    platform: 'directory',
    downloadOnly: true,
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
            browser_download_url: 'https://example.invalid/Agent-Host-0.2.1-directory.tar.gz',
            size: payload.length,
            digest,
          }],
        })
      }
      downloaded = true
      return new Response(payload, { headers: { 'content-type': 'application/gzip' } })
    },
  }, { resolver: async () => null })
  assert.equal(result.availability, 'update-available')
  assert.equal(downloaded, true)
  assert.equal(result.downloaded?.sha256, digest)
  assert.equal(result.applied, false)
})

test('F2 verify uses payload package.json; formal CLI rejects --version; relaunch targets Manager', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-f2-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await write(join(root, 'app', 'package.json'), `${JSON.stringify({ name: 'agent-host-suite', version: '0.2.1' }, null, 2)}\n`)
  const cli = join(root, 'app', 'bin', 'agent-host.mjs')
  // Copy the real formal CLI entry so --version fails with CLI_USAGE.
  const recorded = await readReplacedApplicationVersion(root)
  assert.equal(recorded.version, '0.2.1')
  const verified = await verifyReplacedApplication({ root, expectedVersion: '0.2.1' })
  assert.equal(verified.version, '0.2.1')

  // Prove formal suite CLI has no --version command.
  const formal = fileURLToPath(new URL('../bin/agent-host.mjs', import.meta.url))
  const { status, stderr, stdout } = await execFileAsync(process.execPath, [formal, '--version'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: process.env,
  }).then((result) => ({ status: 0, ...result }), (error) => ({
    status: error.code ?? 1,
    stdout: error.stdout ?? '',
    stderr: error.stderr ?? String(error),
  }))
  assert.notEqual(status, 0)
  assert.match(`${stderr}${stdout}`, /Unknown command: --version|CLI_USAGE/u)

  await write(join(root, 'bin', 'Agent Host.cmd'), '@echo off\r\nexit /b 0\r\n')
  await write(join(root, 'Contents', 'MacOS', 'AgentHostManager'), '#!/bin/sh\nexit 0\n', 0o755)
  const relaunch = await resolveManagerRelaunchLaunch({ root })
  if (process.platform === 'win32') {
    assert.equal(relaunch.kind, 'windows-manager', relaunch.kind)
    assert.match(relaunch.command, /Agent Host\.cmd$/u)
  } else {
    assert.equal(relaunch.kind, 'macos-manager', relaunch.kind)
  }
})

test('F9 updateApplication honors saved preview channel preference', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-f9-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateRoot = join(root, 'state')
  await prepareStatePaths(stateRoot)
  await setUpdatePreferences(stateRoot, { channel: 'preview' })
  let requestedLatest = false
  let requestedList = false
  await updateApplication({
    stateRoot,
    currentVersion: '0.2.0',
    platform: 'directory',
    dryRun: true,
    fetch: async (url) => {
      const href = String(url)
      if (href.includes('/releases/latest')) {
        requestedLatest = true
        return jsonResponse({ tag_name: 'v0.2.0', prerelease: false, draft: false, assets: [] })
      }
      if (href.includes('/releases?') || /\/releases$/u.test(href.split('?')[0])) {
        requestedList = true
        return jsonResponse([{
          tag_name: 'v0.2.1-preview.1',
          html_url: 'https://github.com/tetracoralla/agent-host-suite/releases/tag/v0.2.1-preview.1',
          prerelease: true,
          draft: false,
          assets: [{
            name: 'Agent-Host-0.2.1-preview.1-directory.tar.gz',
            browser_download_url: 'https://example.invalid/a.tar.gz',
            size: 10,
            digest: `sha256:${'b'.repeat(64)}`,
          }],
        }])
      }
      throw new Error(`unexpected ${href}`)
    },
  }, { resolver: async () => null })
  assert.equal(requestedLatest, false)
  assert.equal(requestedList, true)
})

test('F6 plain update refuses a stale older candidate after a newer install', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-f6-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateRoot = join(root, 'state')
  const { dependencies } = await installedEnvironment(stateRoot)
  const v10 = await createPluginArchive(join(root, 'v10'), { version: '1.0.0' })
  const v11 = await createPluginArchive(join(root, 'v11'), { version: '1.1.0' })
  const v12 = await createPluginArchive(join(root, 'v12'), { version: '1.2.0' })

  async function wrap(fixture, tag) {
    return wrapGitHubPluginArchive({
      archivePath: fixture.archive,
      expectedSha256: fixture.sha256,
      probe: false,
      origin: githubOrigin({
        repository: 'review/alpha',
        tag,
        assetName: `alpha-${fixture.version}.tar.gz`,
        assetUrl: `https://github.com/review/alpha/releases/download/${tag}/alpha-${fixture.version}.tar.gz`,
        assetSha256: fixture.sha256,
        assetBytes: fixture.bytes,
      }),
    })
  }

  const w10 = await wrap(v10, 'v1.0.0')
  const w12 = await wrap(v12, 'v1.2.0')

  await installGitHubTool({
    stateRoot,
    github: 'https://github.com/review/alpha',
    tag: 'v1.0.0',
    wrappedArchivePath: w10.wrapped.path,
    expectedDigest: w10.wrapped.sha256,
    expectedUpstreamDigest: v10.sha256,
    expectedAssetName: 'alpha-1.0.0.tar.gz',
    probe: false,
  }, dependencies)

  await mergeUpdateCandidates(stateRoot, {
    tools: {
      'review-alpha': {
        tag: 'v1.1.0',
        version: '1.1.0',
        digest: v11.sha256,
        upstreamDigest: v11.sha256,
        platform: process.platform === 'win32' ? 'win32-x64' : (process.platform === 'darwin' ? 'darwin-arm64' : 'linux-x64'),
        compatible: true,
        platformAvailable: true,
        from: 'catalog',
        assetName: 'alpha-1.1.0.tar.gz',
        assetUrl: 'https://github.com/review/alpha/releases/download/v1.1.0/alpha-1.1.0.tar.gz',
        assetBytes: v11.bytes,
        releaseUrl: 'https://github.com/review/alpha/releases/tag/v1.1.0',
        checkedAt: new Date().toISOString(),
      },
    },
  })

  await installGitHubTool({
    stateRoot,
    github: 'https://github.com/review/alpha',
    tag: 'v1.2.0',
    wrappedArchivePath: w12.wrapped.path,
    expectedDigest: w12.wrapped.sha256,
    expectedUpstreamDigest: v12.sha256,
    expectedAssetName: 'alpha-1.2.0.tar.gz',
    probe: false,
  }, dependencies)

  await mergeUpdateCandidates(stateRoot, {
    tools: {
      'review-alpha': {
        tag: 'v1.1.0',
        version: '1.1.0',
        digest: v11.sha256,
        upstreamDigest: v11.sha256,
        platform: process.platform === 'win32' ? 'win32-x64' : (process.platform === 'darwin' ? 'darwin-arm64' : 'linux-x64'),
        compatible: true,
        platformAvailable: true,
        from: 'catalog',
        assetName: 'alpha-1.1.0.tar.gz',
        assetUrl: 'https://github.com/review/alpha/releases/download/v1.1.0/alpha-1.1.0.tar.gz',
        assetBytes: v11.bytes,
        releaseUrl: 'https://github.com/review/alpha/releases/tag/v1.1.0',
        checkedAt: new Date().toISOString(),
      },
    },
  })

  await assert.rejects(
    () => updateGitHubTool({
      stateRoot,
      target: 'review-alpha',
      probe: false,
    }, dependencies),
    (error) => error.code === 'GITHUB_TOOL_STALE_CANDIDATE' || error.code === 'GITHUB_TOOL_DOWNGRADE_REFUSED',
  )
  const state = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(state.components['review-alpha'].version, '1.2.0')
  const candidates = await readUpdateCandidates(stateRoot)
  assert.equal(candidates.tools?.['review-alpha'] == null, true)
})

test('F3 failed concurrent install does not delete a package another op already adopted', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-f3-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateRoot = join(root, 'state')
  const { dependencies, paths } = await installedEnvironment(stateRoot)
  const fixture = await createPluginArchive(root, { id: 'review-race', version: '1.0.0' })
  const wrapped = await wrapGitHubPluginArchive({
    archivePath: fixture.archive,
    expectedSha256: fixture.sha256,
    probe: false,
    origin: githubOrigin({
      repository: 'review/race',
      tag: 'v1.0.0',
      assetName: 'race-1.0.0.tar.gz',
      assetUrl: 'https://github.com/review/race/releases/download/v1.0.0/race-1.0.0.tar.gz',
      assetSha256: fixture.sha256,
      assetBytes: fixture.bytes,
    }),
  })

  let releaseHealth
  const healthGate = new Promise((resolve) => { releaseHealth = resolve })
  let firstHealthSeen = false
  const gatedProbe = async (component) => {
    if (!firstHealthSeen) {
      firstHealthSeen = true
      await healthGate
    }
    return healthyProbe(component)
  }

  const common = {
    stateRoot,
    github: 'https://github.com/review/race',
    tag: 'v1.0.0',
    wrappedArchivePath: wrapped.wrapped.path,
    expectedDigest: wrapped.wrapped.sha256,
    expectedUpstreamDigest: fixture.sha256,
    expectedAssetName: 'race-1.0.0.tar.gz',
  }

  const pendingA = installGitHubTool({
    ...common,
    probe: true,
  }, { ...dependencies, mcpProbe: gatedProbe })

  for (let i = 0; i < 200 && !firstHealthSeen; i += 1) await new Promise((r) => setTimeout(r, 20))
  assert.equal(firstHealthSeen, true)

  const installedB = await installGitHubTool({
    ...common,
    probe: false,
  }, dependencies)
  assert.equal(installedB.status, 'ok')
  const packageRoot = (await loadState(paths)).components['review-race'].root
  assert.equal(typeof packageRoot, 'string')
  assert.equal(await stat(packageRoot).then(() => true, () => false), true)

  let releaseLock
  let markAcquired
  const acquired = new Promise((resolve) => { markAcquired = resolve })
  const lockHeld = withLifecycleMutation(statePaths(paths.root), 'test.hold-for-race', {}, async () => {
    markAcquired()
    await new Promise((resolve) => { releaseLock = resolve })
  })
  await acquired
  releaseHealth()
  await assert.rejects(() => pendingA, (error) => error.code === 'LIFECYCLE_BUSY')
  releaseLock()
  await lockHeld

  assert.equal(await stat(packageRoot).then(() => true, () => false), true)
  const state = await loadState(paths)
  assert.equal(state.components['review-race'].root, packageRoot)
})


test('F5 reserved compat component migrates when GitHub origin matches the registered tool', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-f5-unit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateRoot = join(root, 'state')
  const { dependencies, paths } = await installedEnvironment(stateRoot)
  const state = await loadState(paths)
  const compatRoot = join(paths.packages, 'armorial', '0.7.0-compat')
  await mkdir(compatRoot, { recursive: true })
  state.components.armorial = {
    version: '0.7.0',
    root: compatRoot,
    displayName: 'Armorial',
    summary: 'compat',
    // No github-release origin — simulates featured/compat inventory.
  }
  state.availableAgentComponents = [...state.availableAgentComponents, 'armorial']
  state.agentComponents = [...state.agentComponents, 'armorial']
  await saveState(paths, state)

  const next = await createPluginArchive(join(root, 'armorial-08'), {
    id: 'armorial',
    version: '0.8.0',
    displayName: 'Armorial',
  })
  const wrapped = await wrapGitHubPluginArchive({
    archivePath: next.archive,
    expectedSha256: next.sha256,
    probe: false,
    origin: githubOrigin({
      repository: 'tetracoralla/armorial',
      tag: 'v0.8.0',
      assetName: 'armorial-0.8.0.tar.gz',
      assetUrl: 'https://github.com/tetracoralla/armorial/releases/download/v0.8.0/armorial-0.8.0.tar.gz',
      assetSha256: next.sha256,
      assetBytes: next.bytes,
    }),
  })

  const result = await installGitHubTool({
    stateRoot,
    github: 'https://github.com/tetracoralla/armorial',
    tag: 'v0.8.0',
    wrappedArchivePath: wrapped.wrapped.path,
    expectedDigest: wrapped.wrapped.sha256,
    expectedUpstreamDigest: next.sha256,
    expectedAssetName: 'armorial-0.8.0.tar.gz',
    probe: false,
  }, dependencies)
  assert.equal(result.status, 'ok')
  assert.equal(result.component.version, '0.8.0')
  const after = await loadState(paths)
  assert.equal(after.components.armorial.version, '0.8.0')
  assert.equal(after.privateComponents.armorial.rollback.component.version, '0.7.0')

  // Unregistered / mismatched repository must still be refused.
  const foreign = await createPluginArchive(join(root, 'armorial-foreign'), {
    id: 'armorial',
    version: '0.8.1',
    displayName: 'Armorial',
  })
  const foreignWrapped = await wrapGitHubPluginArchive({
    archivePath: foreign.archive,
    expectedSha256: foreign.sha256,
    probe: false,
    origin: githubOrigin({
      repository: 'evil/armorial',
      tag: 'v0.8.1',
      assetName: 'armorial-0.8.1.tar.gz',
      assetUrl: 'https://github.com/evil/armorial/releases/download/v0.8.1/armorial-0.8.1.tar.gz',
      assetSha256: foreign.sha256,
      assetBytes: foreign.bytes,
    }),
  })
  // Reset to compat-owned id without github source for the foreign attempt.
  const mid = await loadState(paths)
  delete mid.privateComponents.armorial
  mid.components.armorial = {
    version: '0.7.0',
    root: compatRoot,
    displayName: 'Armorial',
  }
  await saveState(paths, mid)
  const { writeToolSources } = await import('../src/tool-sources.mjs')
  await writeToolSources(stateRoot, { tools: {} })
  await assert.rejects(
    () => installGitHubTool({
      stateRoot,
      github: 'https://github.com/evil/armorial',
      tag: 'v0.8.1',
      wrappedArchivePath: foreignWrapped.wrapped.path,
      expectedDigest: foreignWrapped.wrapped.sha256,
      expectedUpstreamDigest: foreign.sha256,
      expectedAssetName: 'armorial-0.8.1.tar.gz',
      probe: false,
      replaceSource: true,
    }, dependencies),
    (error) => error.code === 'LOCAL_COMPONENT_ID_RESERVED',
  )
})

test('F5 registered Armorial can migrate from compat release onto GitHub-managed install', {
  skip: process.platform !== 'darwin' && process.platform !== 'win32',
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-f5-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const releaseRoot = join(root, 'release')
  const stateRoot = join(root, 'state')
  const manifest = await createReleaseFixture(releaseRoot, {
    suiteVersion: '0.2.0',
    releaseId: 'compat-armorial-0.7',
    marker: 'compat',
    includeArmorial: true,
  })
  await setup({
    stateRoot,
    profile: 'featured',
    hosts: [],
    noHost: true,
    noService: true,
    releaseManifest: manifest,
    enableObservability: false,
  }, {
    catalogPreflight: healthyCatalogPreflight,
    applicationStatePreflight: compatibleApplicationState,
    mcpProbe: healthyProbe,
  })
  const before = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(before.components.armorial.version, '0.7.0')

  const next = await createPluginArchive(join(root, 'armorial-08'), {
    id: 'armorial',
    version: '0.8.0',
    displayName: 'Armorial',
  })
  // Wrap into Host component archive like GitHub install would.
  const wrapped = await wrapGitHubPluginArchive({
    archivePath: next.archive,
    expectedSha256: next.sha256,
    probe: false,
    origin: githubOrigin({
      repository: 'tetracoralla/armorial',
      tag: 'v0.8.0',
      assetName: 'armorial-0.8.0.tar.gz',
      assetUrl: 'https://github.com/tetracoralla/armorial/releases/download/v0.8.0/armorial-0.8.0.tar.gz',
      assetSha256: next.sha256,
      assetBytes: next.bytes,
    }),
  })

  const result = await installGitHubTool({
    stateRoot,
    github: 'https://github.com/tetracoralla/armorial',
    tag: 'v0.8.0',
    wrappedArchivePath: wrapped.wrapped.path,
    expectedDigest: wrapped.wrapped.sha256,
    expectedUpstreamDigest: next.sha256,
    expectedAssetName: 'armorial-0.8.0.tar.gz',
    probe: false,
  }, {
    mcpProbe: healthyProbe,
    catalogPreflight: healthyCatalogPreflight,
    applicationStatePreflight: compatibleApplicationState,
  })
  assert.equal(result.status, 'ok')
  assert.equal(result.component.version, '0.8.0')
  const after = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(after.components.armorial.version, '0.8.0')
  assert.equal(after.privateComponents.armorial.rollback.component.version, '0.7.0')
})


test('R1 / F2 long-running Manager relaunch detaches and survives updater handoff', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-r1-relaunch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const app = join(root, 'current')
  const staged = join(root, 'staged')
  const stateRoot = join(root, 'state')
  const pidPath = join(root, 'manager.pid')
  await write(join(app, 'app', 'package.json'), `${JSON.stringify({ name: 'agent-host-suite', version: '0.2.0' }, null, 2)}\n`)
  await write(join(staged, 'app', 'package.json'), `${JSON.stringify({ name: 'agent-host-suite', version: '0.2.1' }, null, 2)}\n`)
  // Platform-native long-running Manager: Contents/MacOS elsewhere; on win32
  // keep a spaced .cmd for layout realism but relaunch via explicit node so
  // the contract under test is detach+readyFile (not cmd quoting).
  // readyFile/probe is required when provided (no child.pid fallback).
  if (process.platform === 'win32') {
    const managerScript = join(staged, 'bin', 'manager-keepalive.mjs')
    await write(managerScript, `import { writeFileSync } from 'node:fs'
// argv[2] is pidPath when invoked as node script.mjs <pidPath>
writeFileSync(process.argv[2], String(process.pid))
setInterval(() => {}, 1000)
`)
    // Layout realism only — relaunch uses explicit node below.
    await write(
      join(staged, 'bin', 'Agent Host.cmd'),
      `@echo off\r\n"${process.execPath}" "%~dp0manager-keepalive.mjs" "${pidPath}"\r\n`,
    )
  } else {
    const manager = join(staged, 'Contents', 'MacOS', 'AgentHostManager')
    await write(manager, `#!/bin/sh
echo $$ > "${pidPath}"
while true; do sleep 1; done
`, 0o755)
  }
  // Also keep a CLI so resolve paths stay valid on all platforms.
  await write(join(staged, 'app', 'bin', 'agent-host.mjs'), 'console.log("0.2.1")\n')
  await write(join(app, 'app', 'bin', 'agent-host.mjs'), 'console.log("0.2.0")\n')

  const win32Relaunch = process.platform === 'win32'
    ? {
      // After directory-swap, staged lands at `app` (currentRoot).
      relaunchCommand: process.execPath,
      relaunchArgs: [join(app, 'bin', 'manager-keepalive.mjs'), pidPath],
    }
    : {}

  const result = await updateApplication({
    stateRoot,
    currentVersion: '0.2.0',
    applyKind: 'directory-swap',
    currentRoot: app,
    stagedRoot: staged,
    // win32 cold runners need a longer readyFile window for Node handoff.
    relaunchConfirmMs: process.platform === 'win32' ? 10_000 : 2_000,
    relaunchReadyFile: pidPath,
    ...win32Relaunch,
    fetch: async () => jsonResponse({
      tag_name: 'v0.2.1',
      html_url: 'https://github.com/tetracoralla/agent-host-suite/releases/tag/v0.2.1',
      prerelease: false,
      draft: false,
      assets: [{
        name: 'Agent-Host-0.2.1-directory.tar.gz',
        browser_download_url: 'https://example.invalid/Agent-Host-0.2.1-directory.tar.gz',
        size: 100,
        digest: 'sha256:' + 'a'.repeat(64),
      }],
    }),
  }, { resolver: async () => null })
  assert.equal(result.applied, true)
  assert.equal(result.journal, 'complete')
  assert.equal(result.relaunched?.detached, true)
  const pid = Number(await readFile(pidPath, 'utf8'))
  assert.equal(Number.isInteger(pid) && pid > 0, true)
  process.kill(pid, 0)
  t.after(() => {
    try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
  })
})

test('R1 / F2 non-executable Manager entry fails relaunch and recovers previous app', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-r1-nonexec-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const app = join(root, 'current')
  const staged = join(root, 'staged')
  const stateRoot = join(root, 'state')
  await write(join(app, 'app', 'package.json'), `${JSON.stringify({ name: 'agent-host-suite', version: '0.2.0' }, null, 2)}\n`)
  await write(join(staged, 'app', 'package.json'), `${JSON.stringify({ name: 'agent-host-suite', version: '0.2.1' }, null, 2)}\n`)
  await write(join(app, 'marker'), 'working-old')
  await write(join(staged, 'marker'), 'broken-new')
  if (process.platform === 'win32') {
    // Garbage PE at the Windows Manager path: CreateProcess must fail closed.
    await write(join(staged, 'bin', 'AgentHostManager.exe'), 'not-a-windows-image\n')
  } else {
    const manager = join(staged, 'Contents', 'MacOS', 'AgentHostManager')
    await write(manager, '#!/bin/sh\necho should-not-run\n', 0o644)
  }
  let failure
  try {
    await updateApplication({
      stateRoot,
      currentVersion: '0.2.0',
      applyKind: 'directory-swap',
      currentRoot: app,
      stagedRoot: staged,
      relaunchConfirmMs: 400,
      fetch: async () => jsonResponse({
        tag_name: 'v0.2.1',
        html_url: 'https://github.com/tetracoralla/agent-host-suite/releases/tag/v0.2.1',
        prerelease: false,
        draft: false,
        assets: [{
          name: 'Agent-Host-0.2.1-directory.tar.gz',
          browser_download_url: 'https://example.invalid/Agent-Host-0.2.1-directory.tar.gz',
          size: 100,
          digest: 'sha256:' + 'a'.repeat(64),
        }],
      }),
    }, { resolver: async () => null })
  } catch (error) {
    failure = error.code
  }
  assert.equal(failure, 'APPLICATION_UPDATE_RELAUNCH_FAILED')
  assert.equal(await readFile(join(app, 'marker'), 'utf8'), 'working-old')
  const journal = await readApplicationUpdateJournal(stateRoot)
  assert.equal(journal.phase === 'recovered' || journal.restored === true, true, JSON.stringify(journal))
})

test('R1 / F2 runner shim treats status null as relaunch failure', async () => {
  await assert.rejects(
    () => relaunchReplacedApplication({
      root: tmpdir(),
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      runner: async () => ({ status: null, stdout: '', stderr: 'spawn failed', timedOut: false }),
    }),
    (error) => error.code === 'APPLICATION_UPDATE_RELAUNCH_FAILED',
  )
})

test('R2 / F3 cleanup retains package while another install is mid-commit before save', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-r2-precommit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateRoot = join(root, 'state')
  const { dependencies, paths } = await installedEnvironment(stateRoot)
  const fixture = await createPluginArchive(root, { id: 'review-race', version: '1.0.0' })
  const wrapped = await wrapGitHubPluginArchive({
    archivePath: fixture.archive,
    expectedSha256: fixture.sha256,
    probe: false,
    origin: githubOrigin({
      repository: 'review/race',
      tag: 'v1.0.0',
      assetName: 'race-1.0.0.tar.gz',
      assetUrl: 'https://github.com/review/race/releases/download/v1.0.0/race-1.0.0.tar.gz',
      assetSha256: fixture.sha256,
      assetBytes: fixture.bytes,
    }),
  })

  let releaseSave
  const saveGate = new Promise((resolve) => { releaseSave = resolve })
  let saveReached = false
  const gatedSave = async (...args) => {
    saveReached = true
    await saveGate
    return saveState(...args)
  }

  const common = {
    stateRoot,
    github: 'https://github.com/review/race',
    tag: 'v1.0.0',
    wrappedArchivePath: wrapped.wrapped.path,
    expectedDigest: wrapped.wrapped.sha256,
    expectedUpstreamDigest: fixture.sha256,
    expectedAssetName: 'race-1.0.0.tar.gz',
  }

  const pendingB = installGitHubTool({
    ...common,
    probe: false,
  }, { ...dependencies, saveState: gatedSave })

  for (let i = 0; i < 200 && !saveReached; i += 1) await new Promise((r) => setTimeout(r, 20))
  assert.equal(saveReached, true)

  // A tries to commit while B holds the lifecycle lock mid-commit.
  await assert.rejects(
    () => installGitHubTool({ ...common, probe: false }, dependencies),
    (error) => error.code === 'LIFECYCLE_BUSY',
  )

  releaseSave()
  const installedB = await pendingB
  assert.equal(installedB.status, 'ok')
  const packageRoot = (await loadState(paths)).components['review-race'].root
  assert.equal(typeof packageRoot, 'string')
  assert.equal(await stat(packageRoot).then(() => true, () => false), true)
})

test('R5 / F11 loadGitHubToolCatalog(catalogPath) ignores live published catalog', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-r5-catalog-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const candidate = join(root, 'candidate.json')
  await write(candidate, `${JSON.stringify({
    schemaVersion: 'openadam.agent-host-github-catalog.v0.1',
    catalogId: 'local-0.8-candidate',
    createdAt: '2026-09-17T00:00:00.000Z',
    channel: 'stable',
    incompletePlatforms: [],
    tools: [{
      id: 'armorial',
      version: '0.8.0',
      repository: 'tetracoralla/armorial',
      tag: 'v0.8.0',
      releaseUrl: 'https://github.com/tetracoralla/armorial/releases/tag/v0.8.0',
      featured: true,
      platforms: {
        'darwin-arm64': {
          assetName: 'armorial-0.8.0-codex-plugin-macos-arm64.tar.gz',
          url: 'https://example.invalid/armorial-0.8.0.tar.gz',
          sha256: 'sha256:' + 'b'.repeat(64),
          bytes: 12,
        },
        'linux-x64': {
          assetName: 'armorial-0.8.0-codex-plugin-linux-x64.tar.gz',
          url: 'https://example.invalid/armorial-0.8.0-linux.tar.gz',
          sha256: 'sha256:' + 'c'.repeat(64),
          bytes: 12,
        },
      },
    }],
  }, null, 2)}\n`)

  let fetchedLive = false
  const catalog = await loadGitHubToolCatalog({
    catalogPath: candidate,
    fetch: async () => {
      fetchedLive = true
      return jsonResponse({
        schemaVersion: 'openadam.agent-host-github-catalog.v0.1',
        catalogId: 'live-0.7',
        createdAt: '2026-01-01T00:00:00.000Z',
        channel: 'stable',
        incompletePlatforms: ['darwin-arm64'],
        tools: [{
          id: 'armorial',
          version: '0.7.0',
          repository: 'tetracoralla/armorial',
          tag: 'v0.7.0',
          releaseUrl: 'https://github.com/tetracoralla/armorial/releases/tag/v0.7.0',
          featured: true,
          platforms: {},
        }],
      })
    },
  })
  assert.equal(fetchedLive, false)
  assert.equal(catalog.tools[0].version, '0.8.0')
  assert.equal(catalog.catalogId, 'local-0.8-candidate')
  assert.equal(typeof catalog.tools[0].platforms['darwin-arm64'], 'object')
})
