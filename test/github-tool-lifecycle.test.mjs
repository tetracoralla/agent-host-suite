import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { installGitHubTool, inspectToolUpdates, updateGitHubTool } from '../src/tool-updates.mjs'
import { observeLocalComponentArtifact } from '../src/release-artifacts.mjs'
import { currentReleasePlatformOrLocal } from '../src/release-manifest.mjs'
import { githubOrigin, readToolSources } from '../src/tool-sources.mjs'
import { loadState, prepareStatePaths, saveState, STATE_SCHEMA } from '../src/state.mjs'
import { removeLocalComponent, rollbackLocalComponent } from '../src/local-components.mjs'
import { setActiveTools } from '../src/lifecycle.mjs'
import { executeAutoUpdates } from '../src/auto-update.mjs'
import { setUpdatePreferences } from '../src/update-preferences.mjs'
import { wrapGitHubPluginArchive } from '../src/github-plugin-wrap.mjs'
import { compatibleApplicationState, healthyCatalogPreflight } from './helpers.mjs'

const execFileAsync = promisify(execFile)
const tar = process.platform === 'win32' ? 'tar.exe' : '/usr/bin/tar'

async function write(path, contents, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents, { mode })
  if (mode !== 0o600) await chmod(path, mode)
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
}

async function createPluginArchive(root, {
  id = 'review-alpha',
  version = '1.0.0',
  displayName = 'Review Alpha',
  summary = 'First unregistered review tool.',
  author = 'Review Fixture',
  homepage = 'https://example.invalid/review-alpha',
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
    openadam: { displayName, summary, logo: 'logo.svg', expectedTools: [`${id}.ping`] },
    bin: { [id]: 'dist/cli.js' },
  }, null, 2)}\n`)
  await write(join(plugin, '.codex-plugin/plugin.json'), `${JSON.stringify({
    name: id, version, skills: './skills/', mcpServers: './.mcp.json',
  })}\n`)
  await write(join(plugin, '.mcp.json'), `${JSON.stringify({
    mcpServers: { [id]: { command: 'node', args: ['dist/mcp.js'], cwd: '.' } },
  })}\n`)
  await write(join(plugin, 'dist/mcp.js'), 'process.stdin.resume()\n')
  await write(join(plugin, 'dist/cli.js'), `process.stdout.write(${JSON.stringify(version)} + '\\n')\n`)
  await write(join(plugin, `skills/${id}-mark/SKILL.md`), `---\nname: ${id}-mark\n---\nReview tool.\n`)
  await write(join(plugin, 'LICENSE'), 'Apache-2.0\n')
  await write(join(plugin, 'NOTICE'), `${displayName}\n`)
  await write(join(plugin, 'logo.svg'), logo)
  const archive = join(root, `${id}-${version}.tar.gz`)
  await execFileAsync(tar, ['-czf', archive, '-C', root, id], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  const bytes = (await stat(archive)).size
  const sha256 = `sha256:${createHash('sha256').update(await readFile(archive)).digest('hex')}`
  return { archive, sha256, bytes, plugin, id, version }
}

function githubFetch({ repository, version, archive, sha256, bytes, hold }) {
  const name = `${repository.split('/')[1]}-${version}.tar.gz`
  const archiveBytes = archive
  return async (url) => {
    const href = String(url)
    if (href.includes('/releases/latest') || href.includes('/releases/tags/')) {
      return jsonResponse({
        tag_name: `v${version}`,
        html_url: `https://github.com/${repository}/releases/tag/v${version}`,
        prerelease: false,
        draft: false,
        assets: [{
          name,
          browser_download_url: `https://github.com/${repository}/releases/download/v${version}/${name}`,
          size: bytes,
          digest: sha256,
        }],
      })
    }
    if (href.includes(name) || href.endsWith('.tar.gz')) {
      if (typeof hold === 'function') await hold()
      return new Response(await readFile(archiveBytes), { headers: { 'content-type': 'application/gzip' } })
    }
    if (href.includes('/repos/')) {
      return jsonResponse({
        name: repository.split('/')[1],
        html_url: `https://github.com/${repository}`,
        owner: { login: repository.split('/')[0] },
      })
    }
    return jsonResponse({ message: 'not found' })
  }
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

test('observation, binding, and materialization use the current platform', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-platform-bind-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const created = await createPluginArchive(root)
  const wrapped = await wrapGitHubPluginArchive({
    archivePath: created.archive,
    expectedSha256: created.sha256,
    origin: githubOrigin({
      repository: 'review/alpha',
      tag: 'v1.0.0',
      assetName: 'review-alpha-1.0.0.tar.gz',
      assetUrl: 'https://github.com/review/alpha/releases/download/v1.0.0/review-alpha-1.0.0.tar.gz',
      assetSha256: created.sha256,
      assetBytes: created.bytes,
    }),
    expectedTools: ['review-alpha.ping'],
    probe: false,
    outputPath: join(root, 'wrapped.tar.gz'),
    workRoot: join(root, 'wrap'),
  })
  const observation = await observeLocalComponentArtifact(wrapped.wrapped.path)
  assert.equal(observation.releaseComponent.platform, currentReleasePlatformOrLocal())
  assert.notEqual(observation.releaseComponent.platform === 'local' && currentReleasePlatformOrLocal() !== 'local', true)
})

test('installGitHubTool materializes two unregistered tools, invokes the installed CLI, and keeps the other tool on update', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-github-install-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateRoot = join(root, 'state')
  const { dependencies } = await installedEnvironment(stateRoot)
  const alpha = await createPluginArchive(join(root, 'alpha'), { id: 'review-alpha', version: '1.0.0', displayName: 'Review Alpha' })
  const alphaNext = await createPluginArchive(join(root, 'alpha-11'), { id: 'review-alpha', version: '1.1.0', displayName: 'Review Alpha' })
  const beta = await createPluginArchive(join(root, 'beta'), { id: 'review-beta', version: '1.0.0', displayName: 'Review Beta' })

  const installedAlpha = await installGitHubTool({
    stateRoot,
    github: 'https://github.com/review/alpha',
    fetch: githubFetch({ repository: 'review/alpha', version: '1.0.0', archive: alpha.archive, sha256: alpha.sha256, bytes: alpha.bytes }),
    probe: false,
  }, dependencies)
  assert.equal(installedAlpha.component.installed, true)
  assert.equal(installedAlpha.component.id, 'review-alpha')
  assert.equal(installedAlpha.component.version, '1.0.0')

  const installedBeta = await installGitHubTool({
    stateRoot,
    github: 'https://github.com/review/beta',
    fetch: githubFetch({ repository: 'review/beta', version: '1.0.0', archive: beta.archive, sha256: beta.sha256, bytes: beta.bytes }),
    probe: false,
  }, dependencies)
  assert.equal(installedBeta.component.id, 'review-beta')

  const state = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(state.components['review-alpha'].version, '1.0.0')
  assert.equal(state.components['review-beta'].version, '1.0.0')
  assert.equal(state.privateComponents['review-alpha'].current.component.root, state.components['review-alpha'].root)
  const cli = join(state.components['review-alpha'].root, 'marketplace/plugins/review-alpha/dist/cli.js')
  const invoked = await execFileAsync(process.execPath, [cli], { timeout: 5000 })
  assert.equal(invoked.stdout.trim(), '1.0.0')

  await updateGitHubTool({
    stateRoot,
    target: 'review-alpha',
    fetch: githubFetch({ repository: 'review/alpha', version: '1.1.0', archive: alphaNext.archive, sha256: alphaNext.sha256, bytes: alphaNext.bytes }),
    probe: false,
  }, dependencies)
  const after = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(after.components['review-alpha'].version, '1.1.0')
  assert.equal(after.components['review-beta'].version, '1.0.0')
  assert.equal(after.components['review-beta'].root, state.components['review-beta'].root)
})

test('concurrent GitHub installs keep both tools and both source records', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-github-concurrent-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateRoot = join(root, 'state')
  const { dependencies } = await installedEnvironment(stateRoot)
  const alpha = await createPluginArchive(join(root, 'alpha'), { id: 'review-alpha', version: '1.0.0' })
  const beta = await createPluginArchive(join(root, 'beta'), { id: 'review-beta', version: '1.0.0', displayName: 'Review Beta' })
  let releaseAlpha
  const held = new Promise((resolve) => { releaseAlpha = resolve })
  const pendingAlpha = installGitHubTool({
    stateRoot,
    github: 'https://github.com/review/alpha',
    fetch: githubFetch({
      repository: 'review/alpha', version: '1.0.0', archive: alpha.archive, sha256: alpha.sha256, bytes: alpha.bytes,
      hold: () => held,
    }),
    probe: false,
  }, dependencies)
  await installGitHubTool({
    stateRoot,
    github: 'https://github.com/review/beta',
    fetch: githubFetch({ repository: 'review/beta', version: '1.0.0', archive: beta.archive, sha256: beta.sha256, bytes: beta.bytes }),
    probe: false,
  }, dependencies)
  releaseAlpha()
  await pendingAlpha
  const state = await loadState(await prepareStatePaths(stateRoot))
  const sources = await readToolSources(stateRoot)
  assert.equal(state.components['review-alpha'].version, '1.0.0')
  assert.equal(state.components['review-beta'].version, '1.0.0')
  assert.equal(sources.tools['review-alpha'].origin.repository, 'review/alpha')
  assert.equal(sources.tools['review-beta'].origin.repository, 'review/beta')
})

test('adding a GitHub tool while paused keeps pause semantics and resume includes the new tool', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-github-pause-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateRoot = join(root, 'state')
  const { dependencies } = await installedEnvironment(stateRoot)
  await setActiveTools({ stateRoot, pauseTools: true }, dependencies)
  const beta = await createPluginArchive(join(root, 'beta'), { id: 'review-beta', version: '1.0.0', displayName: 'Review Beta' })
  await installGitHubTool({
    stateRoot,
    github: 'https://github.com/review/beta',
    fetch: githubFetch({ repository: 'review/beta', version: '1.0.0', archive: beta.archive, sha256: beta.sha256, bytes: beta.bytes }),
    probe: false,
  }, dependencies)
  const paused = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(paused.agentToolsPaused, true)
  assert.equal(paused.agentComponents.includes('review-beta'), false)
  assert.equal(paused.resumeAgentComponents.includes('review-beta'), true)
  await setActiveTools({ stateRoot, resumeTools: true }, dependencies)
  const resumed = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(resumed.agentToolsPaused, undefined)
  assert.equal(resumed.agentComponents.includes('review-beta'), true)
})

test('GitHub tools support remove, rollback, and retained cleanup ownership', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-github-own-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateRoot = join(root, 'state')
  const { dependencies } = await installedEnvironment(stateRoot)
  const alpha = await createPluginArchive(join(root, 'alpha'), { id: 'review-alpha', version: '1.0.0' })
  const alphaNext = await createPluginArchive(join(root, 'alpha-11'), { id: 'review-alpha', version: '1.1.0' })
  await installGitHubTool({
    stateRoot,
    github: 'https://github.com/review/alpha',
    fetch: githubFetch({ repository: 'review/alpha', version: '1.0.0', archive: alpha.archive, sha256: alpha.sha256, bytes: alpha.bytes }),
    probe: false,
  }, dependencies)
  await updateGitHubTool({
    stateRoot,
    target: 'review-alpha',
    fetch: githubFetch({ repository: 'review/alpha', version: '1.1.0', archive: alphaNext.archive, sha256: alphaNext.sha256, bytes: alphaNext.bytes }),
    probe: false,
  }, dependencies)
  const upgraded = await loadState(await prepareStatePaths(stateRoot))
  const previousRoot = upgraded.privateComponents['review-alpha'].rollback.component.root
  assert.equal(typeof previousRoot, 'string')
  assert.equal((await stat(previousRoot)).isDirectory(), true)
  const rolled = await rollbackLocalComponent({ stateRoot, target: 'review-alpha' }, dependencies)
  assert.equal(rolled.status, 'rolled-back')
  const restored = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(restored.components['review-alpha'].version, '1.0.0')
  const removed = await removeLocalComponent({ stateRoot, target: 'review-alpha' }, dependencies)
  assert.equal(removed.status, 'removed')
  const afterRemove = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(afterRemove.components['review-alpha'], undefined)
  assert.equal(afterRemove.privateComponents['review-alpha'].current, null)
})

test('inspectToolUpdates live-queries without an injected fetch and persists the same candidate', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-github-candidate-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateRoot = join(root, 'state')
  const { dependencies } = await installedEnvironment(stateRoot)
  const alpha = await createPluginArchive(join(root, 'alpha'), { id: 'review-alpha', version: '1.0.0' })
  await installGitHubTool({
    stateRoot,
    github: 'https://github.com/review/alpha',
    fetch: githubFetch({ repository: 'review/alpha', version: '1.0.0', archive: alpha.archive, sha256: alpha.sha256, bytes: alpha.bytes }),
    probe: false,
  }, dependencies)
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return githubFetch({
      repository: 'review/alpha', version: '1.1.0', archive: alpha.archive, sha256: alpha.sha256, bytes: alpha.bytes,
    })(url)
  }
  t.after(() => { globalThis.fetch = originalFetch })
  const items = await inspectToolUpdates(stateRoot, { persist: true })
  const item = items.find((entry) => entry.id === 'review-alpha')
  assert.equal(item.availability, 'update-available')
  assert.equal(item.candidate.version, '1.1.0')
  assert.equal(calls.some((url) => url.includes('/releases/latest') || url.includes('/releases/tags/')), true)
})

test('auto-install reuses the lifecycle lease instead of deadlocking', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-auto-install-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateRoot = join(root, 'state')
  const { dependencies } = await installedEnvironment(stateRoot)
  const alpha = await createPluginArchive(join(root, 'alpha'), { id: 'review-alpha', version: '1.0.0' })
  const alphaNext = await createPluginArchive(join(root, 'alpha-11'), { id: 'review-alpha', version: '1.1.0' })
  await installGitHubTool({
    stateRoot,
    github: 'https://github.com/review/alpha',
    fetch: githubFetch({ repository: 'review/alpha', version: '1.0.0', archive: alpha.archive, sha256: alpha.sha256, bytes: alpha.bytes }),
    probe: false,
  }, dependencies)
  await setUpdatePreferences(stateRoot, { autoCheck: true, autoDownload: false, autoInstall: true })
  const result = await executeAutoUpdates(stateRoot, {
    force: true,
    probe: false,
    fetch: githubFetch({ repository: 'review/alpha', version: '1.1.0', archive: alphaNext.archive, sha256: alphaNext.sha256, bytes: alphaNext.bytes }),
  }, { ...dependencies, mcpProbe: healthyProbe })
  assert.equal(result.status, 'ok')
  assert.equal(result.installed.some((item) => item.component?.id === 'review-alpha'), true)
  const state = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(state.components['review-alpha'].version, '1.1.0')
})
