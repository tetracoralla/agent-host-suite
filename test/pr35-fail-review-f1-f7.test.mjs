import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
import { executeAutoUpdates } from '../src/auto-update.mjs'
import { compatibleApplicationState, healthyCatalogPreflight } from './helpers.mjs'
import { storageStatus, cleanupStorage } from '../src/storage.mjs'
import { operationsSnapshot } from '../src/operations-snapshot.mjs'
import {
  readApplicationUpdateJournal,
  updateApplication,
  checkApplicationUpdate,
  packageJsonApplicationVersion,
  resolveInstalledApplicationVersion,
} from '../src/application-update.mjs'
import { withLifecycleMutation } from '../src/lifecycle-lock.mjs'
import { readUpdatePreferences } from '../src/update-preferences.mjs'
import { constants as fsConstants } from 'node:fs'
import { main } from '../src/cli.mjs'

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
  mcpSource = 'process.stdin.resume()\n',
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
  await write(join(plugin, 'dist/mcp.js'), mcpSource)
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


function markingMcpSource(markerPath, toolName) {
  return `import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
writeFileSync(${JSON.stringify(markerPath)}, 'executed\\n')
const tool = {
  name: ${JSON.stringify(toolName)},
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
}
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  const response = { jsonrpc: '2.0', id: request.id }
  if (request.method === 'initialize') {
    response.result = {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'review-fixture', version: '1.0.0' },
    }
  } else if (request.method === 'tools/list') {
    response.result = { tools: [tool] }
  } else {
    response.error = { code: -32601, message: 'not implemented' }
  }
  process.stdout.write(JSON.stringify(response) + '\\n')
}).on('close', () => process.exit(0))
`
}

test('R1 / F3 identity drift rejects before real MCP probe executes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pr35-r1-f3-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateRoot = join(root, 'state')
  const marker = join(root, 'probe-executed.marker')
  const { dependencies } = await installedEnvironment(stateRoot)
  const alpha = await createPluginArchive(join(root, 'alpha'), { id: 'review-alpha', version: '1.0.0' })
  const drift = await createPluginArchive(join(root, 'drift'), {
    id: 'review-beta',
    version: '1.1.0',
    displayName: 'Review Beta',
    mcpSource: markingMcpSource(marker, 'review-beta.ping'),
  })
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
      // Real admission probe (not probe:false): drift must fail before stdio MCP runs.
      fetch: githubFetch({ repository: 'review/alpha', ...drift }),
    }, dependencies),
    (error) => error instanceof AgentHostError && error.code === 'GITHUB_TOOL_IDENTITY_DRIFT',
  )
  const executed = await access(marker, fsConstants.F_OK).then(() => true, () => false)
  assert.equal(executed, false)
  const after = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(after.components['review-alpha']?.version, '1.0.0')
  assert.equal(after.components['review-beta'], undefined)
})

test('R2 / F2 download failure leaves journal recoverable; same PID can retry', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pr35-r2-f2-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateRoot = join(root, 'state')
  await prepareStatePaths(stateRoot)
  const data = Buffer.from('isolated-carrier-retry')
  const digest = `sha256:${createHash('sha256').update(data).digest('hex')}`
  const name = 'Agent-Host-0.2.1-darwin-arm64.dmg'
  let failDownload = true
  let downloadCalls = 0
  const fakeFetch = async (url) => {
    const href = String(url)
    if (href.includes('/releases/latest') || href.includes('/releases/tags/')) {
      return jsonResponse({
        tag_name: 'v0.2.1',
        assets: [{
          name,
          browser_download_url: `https://github.com/review/fixture/${name}`,
          size: data.length,
          digest,
        }],
      })
    }
    downloadCalls += 1
    if (failDownload) return new Response('network down', { status: 503 })
    return new Response(data)
  }
  await assert.rejects(
    () => updateApplication({
      stateRoot,
      downloadOnly: true,
      currentVersion: '0.2.0',
      platform: 'darwin-arm64',
      fetch: fakeFetch,
    }, { resolver: async () => null }),
    (error) => error instanceof AgentHostError && error.code === 'RELEASE_DOWNLOAD_FAILED',
  )
  let leaseFree = false
  await withLifecycleMutation(statePaths(stateRoot), 'application.update', {}, async () => {
    leaseFree = true
  })
  assert.equal(leaseFree, true)
  const afterFail = await readApplicationUpdateJournal(stateRoot)
  assert.notEqual(afterFail.phase, 'downloading')
  assert.ok(afterFail.phase === 'failed' || afterFail.phase === 'recovered' || afterFail.phase === 'idle')
  failDownload = false
  const retry = await updateApplication({
    stateRoot,
    downloadOnly: true,
    currentVersion: '0.2.0',
    platform: 'darwin-arm64',
    fetch: fakeFetch,
  }, { resolver: async () => null })
  assert.equal(retry.availability, 'update-available')
  assert.equal(retry.downloaded?.sha256, digest)
  assert.equal(downloadCalls, 2)
})

test('R3 / F6 maintenance entry resolves installed version and auto-downloads', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pr35-r3-f6-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateRoot = join(root, 'state')
  await prepareStatePaths(stateRoot)
  await setUpdatePreferences(stateRoot, { autoCheck: true, autoDownload: true, autoInstall: false })
  const appRoot = join(root, 'Agent Host.app')
  await mkdir(join(appRoot, 'Contents', 'MacOS'), { recursive: true })
  await mkdir(join(appRoot, 'Contents', 'Resources', 'agent-host-suite'), { recursive: true })
  await writeFile(join(appRoot, 'Contents', 'MacOS', 'agent-host'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await writeFile(
    join(appRoot, 'Contents', 'Resources', 'agent-host-suite', 'package.json'),
    JSON.stringify({ version: '0.2.0' }),
  )
  const data = Buffer.from('maintenance-carrier')
  const digest = `sha256:${createHash('sha256').update(data).digest('hex')}`
  const name = 'Agent-Host-0.2.1-darwin-arm64.dmg'
  const fetch = async (url) => {
    const href = String(url)
    if (href.includes('/releases/latest') || href.includes('/releases/tags/')) {
      return jsonResponse({
        tag_name: 'v0.2.1',
        html_url: 'https://github.com/tetracoralla/agent-host-suite/releases/tag/v0.2.1',
        assets: [{
          name,
          browser_download_url: `https://github.com/review/fixture/${name}`,
          size: data.length,
          digest,
        }],
      })
    }
    if (href.includes(name) || href.endsWith('.dmg')) return new Response(data)
    return jsonResponse({ message: 'not found' })
  }
  const resolver = async () => ({
    kind: 'macos-application',
    root: appRoot,
    executable: join(appRoot, 'Contents', 'MacOS', 'agent-host'),
    prefixArguments: [],
  })
  const chunks = []
  const originalWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk, encoding, cb) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk))
    if (typeof encoding === 'function') encoding()
    else if (typeof cb === 'function') cb()
    return true
  }
  let code
  try {
    code = await main(['maintenance', '--state-root', stateRoot, '--json'], {
      fetch,
      resolver,
      platform: 'darwin-arm64',
    })
  } finally {
    process.stdout.write = originalWrite
  }
  assert.equal(code, 0)
  const lines = chunks.join('').trim().split('\n').filter(Boolean)
  const payload = JSON.parse(lines.at(-1))
  assert.equal(payload.auto?.status, 'ok')
  assert.equal(payload.auto?.application?.availability, 'update-available')
  assert.equal(payload.auto?.application?.currentVersion, '0.2.0')
  assert.equal(payload.auto?.downloaded?.length >= 1, true)
})

test('P2 successful download-only then nested auto maintenance is not APPLICATION_UPDATE_BUSY', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pr35-p2-dl-alive-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateRoot = join(root, 'state')
  await prepareStatePaths(stateRoot)
  const data = Buffer.from('p2-download-then-auto-carrier')
  const digest = `sha256:${createHash('sha256').update(data).digest('hex')}`
  const name = 'Agent-Host-0.2.1-darwin-arm64.dmg'
  const fakeFetch = async (url) => {
    const href = String(url)
    if (href.includes('/releases/latest') || href.includes('/releases/tags/')) {
      return jsonResponse({
        tag_name: 'v0.2.1',
        html_url: 'https://github.com/review/host/releases/tag/v0.2.1',
        prerelease: false,
        draft: false,
        assets: [{
          name,
          browser_download_url: `https://github.com/review/fixture/${name}`,
          size: data.length,
          digest,
        }],
      })
    }
    return new Response(data)
  }
  const first = await updateApplication({
    stateRoot,
    downloadOnly: true,
    currentVersion: '0.2.0',
    platform: 'darwin-arm64',
    fetch: fakeFetch,
  }, { resolver: async () => null })
  assert.equal(first.downloaded?.sha256, digest)
  const afterDownload = await readApplicationUpdateJournal(stateRoot)
  assert.equal(afterDownload.phase, 'complete', JSON.stringify(afterDownload))
  assert.equal(typeof afterDownload.carrierPath, 'string')
  assert.equal(afterDownload.pid, process.pid)
  let leaseFree = false
  await withLifecycleMutation(statePaths(stateRoot), 'application.update', {}, async () => {
    leaseFree = true
  })
  assert.equal(leaseFree, true)

  // Independent nested maintenance (same alive Manager PID) must not treat the
  // finalized download-only journal as an in-flight update.
  await setUpdatePreferences(stateRoot, { autoCheck: true, autoDownload: true, autoInstall: false })
  const autoDownload = await executeAutoUpdates(stateRoot, {
    force: true,
    currentVersion: '0.2.0',
    platform: 'darwin-arm64',
    fetch: fakeFetch,
  }, { resolver: async () => null })
  assert.equal(autoDownload.status, 'ok', JSON.stringify(autoDownload))
  assert.equal(autoDownload.downloaded?.length >= 1, true)
  assert.equal(autoDownload.downloaded[0].downloaded?.sha256, digest)

  // Pre-fix leftover: phase=downloaded with alive owner + free lease, then nested
  // updateApplication under an inherited exclusive lease (autoInstall path shape).
  await writeFile(join(stateRoot, 'application-update.json'), JSON.stringify({
    schemaVersion: 'openadam.agent-host-application-update-state.v0.1',
    phase: 'downloaded',
    channel: 'stable',
    fromVersion: '0.2.0',
    toVersion: '0.2.1',
    carrierPath: afterDownload.carrierPath,
    currentRoot: null,
    previousRoot: null,
    stagedRoot: null,
    restored: false,
    error: null,
    pid: process.pid,
    processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    updatedAt: new Date().toISOString(),
  }))
  await setUpdatePreferences(stateRoot, { autoCheck: true, autoDownload: true, autoInstall: true })
  const nested = await withLifecycleMutation(statePaths(stateRoot), 'updates.auto', {}, async (locked) => (
    updateApplication({
      stateRoot,
      downloadOnly: true,
      currentVersion: '0.2.0',
      platform: 'darwin-arm64',
      fetch: fakeFetch,
    }, { ...locked, resolver: async () => null })
  ))
  assert.equal(nested.downloaded?.sha256, digest)
  assert.notEqual(nested.code, 'APPLICATION_UPDATE_BUSY')
  const afterNested = await readApplicationUpdateJournal(stateRoot)
  assert.equal(afterNested.phase, 'complete')
})
