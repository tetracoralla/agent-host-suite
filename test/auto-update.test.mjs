import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { executeAutoUpdates } from '../src/auto-update.mjs'
import { supportedReleasePlatform } from '../src/github-project.mjs'
import { setUpdatePreferences } from '../src/update-preferences.mjs'
import { githubOrigin, writeToolSources } from '../src/tool-sources.mjs'
import { prepareStatePaths, saveState, STATE_SCHEMA, statePaths } from '../src/state.mjs'
import { readApplicationUpdateJournal, updateApplication } from '../src/application-update.mjs'
import { withLifecycleMutation } from '../src/lifecycle-lock.mjs'


function fixtureReleaseAssetToken() {
  const platform = supportedReleasePlatform()
  if (platform === null) return 'any'
  return platform.replace(/^darwin-/, 'macos-').replace(/^win32-/, 'windows-')
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
}

test('auto-update executor checks persisted third-party tools when autoCheck is on', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-auto-update-'))
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
  await setUpdatePreferences(stateRoot, { autoCheck: true, autoDownload: false, autoInstall: false })
  let calls = 0
  const result = await executeAutoUpdates(stateRoot, {
    force: true,
    fetch: async () => {
      calls += 1
      return jsonResponse({
        tag_name: 'v1.1.0',
        html_url: 'https://github.com/north-pier/glyphmark/releases/tag/v1.1.0',
        prerelease: false,
        draft: false,
        assets: [{
          name: `glyphmark-1.1.0-${fixtureReleaseAssetToken()}.tar.gz`,
          browser_download_url: `https://github.com/north-pier/glyphmark/releases/download/v1.1.0/glyphmark-1.1.0-${fixtureReleaseAssetToken()}.tar.gz`,
          size: 100,
          digest: 'sha256:' + 'a'.repeat(64),
        }],
      })
    },
  })
  assert.equal(result.status, 'ok')
  assert.equal(calls > 0, true)
  assert.equal(result.tools.some((item) => item.id === 'glyphmark' && item.availability === 'update-available'), true)
})

test('auto-update stays skipped until autoCheck is enabled', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-auto-skip-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  const result = await executeAutoUpdates(stateRoot, { fetch: async () => { throw new Error('should not fetch') } })
  assert.equal(result.status, 'skipped')
  assert.equal(result.reason, 'auto-check-disabled')
})

test('executeAutoUpdates resolves installed application version without options.currentVersion', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-auto-version-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  await prepareStatePaths(stateRoot)
  await setUpdatePreferences(stateRoot, { autoCheck: true, autoDownload: false, autoInstall: false })
  const appRoot = join(stateRoot, 'payload-app')
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(join(appRoot, 'Contents', 'Resources', 'agent-host-suite'), { recursive: true })
  await writeFile(join(appRoot, 'Contents', 'Resources', 'agent-host-suite', 'package.json'), JSON.stringify({ version: '0.2.0' }))
  const result = await executeAutoUpdates(stateRoot, {
    force: true,
    platform: 'darwin-arm64',
    fetch: async () => jsonResponse({
      tag_name: 'v0.2.1',
      html_url: 'https://github.com/review/host/releases/tag/v0.2.1',
      assets: [{
        name: 'Agent-Host-0.2.1-darwin-arm64.dmg',
        browser_download_url: 'https://github.com/review/host/app.dmg',
        size: 100,
        digest: 'sha256:' + 'b'.repeat(64),
      }],
    }),
  }, {
    resolver: async () => ({
      kind: 'macos-application',
      root: appRoot,
      executable: join(appRoot, 'Contents', 'MacOS', 'agent-host'),
      prefixArguments: [],
    }),
  })
  assert.equal(result.status, 'ok')
  assert.equal(result.application.availability, 'update-available')
  assert.equal(result.application.currentVersion, '0.2.0')
  assert.notEqual(result.application.availability, 'version-unknown')
})

test('successful download-only then autoDownload maintenance does not see APPLICATION_UPDATE_BUSY', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-auto-dl-alive-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  await prepareStatePaths(stateRoot)
  const data = Buffer.from('auto-download-alive-owner')
  const digest = `sha256:${createHash('sha256').update(data).digest('hex')}`
  const name = 'Agent-Host-0.2.1-darwin-arm64.dmg'
  const fetch = async (url) => {
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
  const downloaded = await updateApplication({
    stateRoot,
    downloadOnly: true,
    currentVersion: '0.2.0',
    platform: 'darwin-arm64',
    fetch,
  }, { resolver: async () => null })
  assert.equal(downloaded.downloaded?.sha256, digest)
  const journal = await readApplicationUpdateJournal(stateRoot)
  assert.equal(journal.phase, 'complete')
  assert.equal(journal.pid, process.pid)
  let leaseFree = false
  await withLifecycleMutation(statePaths(stateRoot), 'probe', {}, async () => { leaseFree = true })
  assert.equal(leaseFree, true)
  await setUpdatePreferences(stateRoot, { autoCheck: true, autoDownload: true, autoInstall: false })
  const result = await executeAutoUpdates(stateRoot, {
    force: true,
    currentVersion: '0.2.0',
    platform: 'darwin-arm64',
    fetch,
  }, { resolver: async () => null })
  assert.equal(result.status, 'ok', JSON.stringify(result))
  assert.equal(result.downloaded?.length >= 1, true)
  assert.equal(result.downloaded[0].downloaded?.sha256, digest)
})
