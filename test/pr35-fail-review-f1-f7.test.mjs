import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { AgentHostError } from '../src/errors.mjs'
import {
  downloadGitHubToolUpdate,
  installGitHubTool,
  updateGitHubTool,
} from '../src/tool-updates.mjs'
import { loadState, prepareStatePaths, saveState, STATE_SCHEMA, statePaths } from '../src/state.mjs'
import { setUpdatePreferences } from '../src/update-preferences.mjs'
import { compatibleApplicationState, healthyCatalogPreflight } from './helpers.mjs'
import { storageStatus, cleanupStorage } from '../src/storage.mjs'
import { operationsSnapshot } from '../src/operations-snapshot.mjs'
import {
  readApplicationUpdateJournal,
  updateApplication,
} from '../src/application-update.mjs'
import { withLifecycleMutation } from '../src/lifecycle-lock.mjs'
import { checkApplicationUpdate, packageJsonApplicationVersion, resolveInstalledApplicationVersion } from '../src/application-update.mjs'
import { readUpdatePreferences } from '../src/update-preferences.mjs'

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

test('F1 Host-managed tool-update cache does not break storage/cleanup/snapshot', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pr35-f1-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateRoot = join(root, 'state')
  const { dependencies } = await installedEnvironment(stateRoot)
  const first = await createPluginArchive(join(root, 'first'))
  const next = await createPluginArchive(join(root, 'next'), { version: '1.1.0' })
  await mkdir(join(stateRoot, 'node-runtime'), { recursive: true })
  await installGitHubTool({
    stateRoot,
    github: 'https://github.com/review/alpha',
    fetch: githubFetch({ repository: 'review/alpha', ...first }),
    probe: false,
  }, dependencies)
  assert.equal((await storageStatus({ stateRoot })).status, 'ok')
  await downloadGitHubToolUpdate({
    stateRoot,
    target: 'review-alpha',
    fetch: githubFetch({ repository: 'review/alpha', ...next }),
  }, dependencies)
  assert.equal((await storageStatus({ stateRoot })).status, 'ok')
  assert.equal((await cleanupStorage({ stateRoot, dryRun: true })).status, 'ready')
  assert.equal((await operationsSnapshot({ stateRoot })).status, 'ok')
})

test('F2 concurrent updateApplication does not overwrite a live recovery journal', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pr35-f2-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const lockRoot = join(root, 'lock-state')
  await prepareStatePaths(lockRoot)
  const data = Buffer.from('isolated-carrier')
  const digest = `sha256:${createHash('sha256').update(data).digest('hex')}`
  const name = 'Agent-Host-0.2.1-darwin-arm64.dmg'
  const fakeFetch = async (url) => (String(url).includes('/releases/latest')
    ? jsonResponse({ tag_name: 'v0.2.1', assets: [{ name, browser_download_url: `https://github.com/review/fixture/${name}`, size: data.length, digest }] })
    : new Response(data))
  await withLifecycleMutation(statePaths(lockRoot), 'application.update', {}, async () => {
    await writeFile(join(lockRoot, 'application-update.json'), JSON.stringify({
      schemaVersion: 'openadam.agent-host-application-update-state.v0.1',
      phase: 'verifying',
      pid: process.pid,
      currentRoot: join(root, 'current'),
      previousRoot: join(root, 'previous'),
      fromVersion: '0.2.0',
      toVersion: '0.2.1',
    }))
    await assert.rejects(
      () => updateApplication({
        stateRoot: lockRoot,
        downloadOnly: true,
        currentVersion: '0.2.0',
        platform: 'darwin-arm64',
        fetch: fakeFetch,
      }, { resolver: async () => null }),
      (error) => error instanceof AgentHostError && error.code === 'APPLICATION_UPDATE_BUSY',
    )
    const journal = await readApplicationUpdateJournal(lockRoot)
    assert.equal(journal.phase, 'verifying')
    assert.equal(journal.currentRoot, join(root, 'current'))
    assert.equal(journal.previousRoot, join(root, 'previous'))
  })
})

test('F3 update refuses identity drift to a different component id', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pr35-f3-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateRoot = join(root, 'state')
  const { dependencies } = await installedEnvironment(stateRoot)
  const alpha = await createPluginArchive(join(root, 'alpha'), { id: 'review-alpha', version: '1.0.0' })
  const drift = await createPluginArchive(join(root, 'drift'), { id: 'review-beta', version: '1.1.0' })
  await installGitHubTool({
    stateRoot,
    github: 'https://github.com/review/alpha',
    fetch: githubFetch({ repository: 'review/alpha', ...alpha }),
    probe: false,
  }, dependencies)
  await assert.rejects(
    () => updateGitHubTool({
      stateRoot,
      target: 'review-alpha',
      fetch: githubFetch({ repository: 'review/alpha', ...drift }),
      probe: false,
    }, dependencies),
    (error) => error instanceof AgentHostError && error.code === 'GITHUB_TOOL_IDENTITY_DRIFT',
  )
  const after = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(after.components['review-alpha']?.version, '1.0.0')
  assert.equal(after.components['review-beta'], undefined)
})

test('F4 replace refuses downgrade using installed payload version', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pr35-f4-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const current = join(root, 'Agent Host.app')
  const staged = join(root, 'staged.app')
  for (const [path, version] of [[current, '0.3.0'], [staged, '0.2.1']]) {
    await mkdir(join(path, 'Contents/MacOS'), { recursive: true })
    await mkdir(join(path, 'Contents/Resources/agent-host-suite'), { recursive: true })
    await writeFile(join(path, 'Contents/MacOS/agent-host'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await writeFile(join(path, 'Contents/Resources/agent-host-suite/package.json'), JSON.stringify({ version }))
  }
  const fetch = async () => jsonResponse({
    tag_name: 'v0.2.1',
    assets: [{ name: 'Agent-Host-0.2.1-darwin-arm64.dmg', browser_download_url: 'https://github.com/review/app.dmg', size: 1 }],
  })
  const result = await updateApplication({
    stateRoot: join(root, 'state'),
    applicationRoots: [join(current, 'Contents')],
    currentRoot: current,
    stagedRoot: staged,
    relaunch: false,
    fetch,
  })
  assert.equal(result.applied, false)
  assert.equal(result.currentVersion, '0.3.0')
  assert.equal(result.availability, 'current')
  assert.equal(JSON.parse(await readFile(join(current, 'Contents/Resources/agent-host-suite/package.json'), 'utf8')).version, '0.3.0')
})

test('F5 lost cache rebinds wrap digest after verifying upstream', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pr35-f5-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateRoot = join(root, 'state')
  const { dependencies } = await installedEnvironment(stateRoot)
  const first = await createPluginArchive(join(root, 'first'))
  const next = await createPluginArchive(join(root, 'next'), { version: '1.1.0' })
  await installGitHubTool({
    stateRoot,
    github: 'https://github.com/review/alpha',
    fetch: githubFetch({ repository: 'review/alpha', ...first }),
    probe: false,
  }, dependencies)
  const fetch = githubFetch({ repository: 'review/alpha', ...next })
  const downloaded = await downloadGitHubToolUpdate({ stateRoot, target: 'review-alpha', fetch }, dependencies)
  await rm(downloaded.path)
  await new Promise((resolve) => setTimeout(resolve, 1100))
  const result = await updateGitHubTool({ stateRoot, target: 'review-alpha', fetch, probe: false }, dependencies)
  assert.equal(result.component.id, 'review-alpha')
  assert.equal(result.component.version, '1.1.0')
})

test('F6 app check does not treat matching package version as update-available', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pr35-f6-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateRoot = join(root, 'cli-state')
  await prepareStatePaths(stateRoot)
  const fetch = async () => jsonResponse({
    tag_name: 'v0.2.0',
    assets: [{
      name: 'Agent-Host-0.2.0-darwin-arm64.dmg',
      browser_download_url: 'https://github.com/review/fixture/app.dmg',
      size: 100,
      digest: `sha256:${'a'.repeat(64)}`,
    }],
  })
  // Mirror CLI app check/status shared version resolution.
  const preferences = await readUpdatePreferences(stateRoot)
  const resolved = await resolveInstalledApplicationVersion({ stateRoot })
  const currentVersion = resolved.version ?? await packageJsonApplicationVersion()
  const result = await checkApplicationUpdate({
    stateRoot,
    channel: preferences.channel,
    currentVersion,
    fetch,
  })
  assert.notEqual(result.availability, 'update-available')
  assert.equal(result.currentVersion, '0.2.0')
  assert.ok(result.availability === 'current' || result.availability === 'no-platform-asset' || result.availability === 'version-unknown')
})

test('F7 explicit autoCheck off cascades dependents and is not silently reversed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pr35-f7-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateRoot = join(root, 'state')
  await prepareStatePaths(stateRoot)
  const saved = await setUpdatePreferences(stateRoot, { autoInstall: true })
  assert.equal(saved.autoCheck, true)
  assert.equal(saved.autoDownload, true)
  assert.equal(saved.autoInstall, true)
  const disabled = await setUpdatePreferences(stateRoot, { autoCheck: false })
  assert.equal(disabled.autoCheck, false)
  assert.equal(disabled.autoDownload, false)
  assert.equal(disabled.autoInstall, false)
})
