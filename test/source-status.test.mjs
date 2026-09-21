import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { human } from '../src/cli.mjs'
import { FEATURED_CATALOG_DOWNLOAD_ENV, GITHUB_PREVIEW_INDEX_CONVENTION, GITHUB_RELEASES_URL, PREVIEW_DISTRIBUTION_SCHEMA } from '../src/preview-download.mjs'
import {
  APPLICATION_ENVIRONMENT_NOTE,
  SOURCE_STATUS_SCHEMA,
  UNPUBLISHED_ASSETS_NOTE,
  catalogFetchRecovery,
  checkCatalogSource,
  clearCatalogSource,
  inspectApplicationBuild,
  inspectSourceStatus,
  setCatalogSource,
} from '../src/source-status.mjs'
import { createIsolatedCli, runIsolatedCli } from './cli-isolation.mjs'

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

async function writeBoundCatalog(root, suiteVersion = '0.2.0-source') {
  const manifestPath = join(root, 'current.json')
  await writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: 'openadam.agent-host-release.v0.2',
    releaseId: 'source-fixture',
    suiteVersion,
    status: 'internal-beta',
    createdAt: '2026-09-14T00:00:00.000Z',
    platforms: ['linux-x64'],
    components: [],
  }, null, 2)}\n`)
  return manifestPath
}

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  delete env[FEATURED_CATALOG_DOWNLOAD_ENV]
  delete env.AGENT_HOST_RELEASE_MANIFEST
  return env
}

function mockFetch(files) {
  return async (url) => {
    const href = String(url)
    const entry = files[href]
    if (entry === undefined) return new Response('missing', { status: 404 })
    return new Response(entry.body, { status: 200, headers: entry.headers ?? {} })
  }
}

test('application, environment, and tool versions are distinct planes', async () => {
  const application = await inspectApplicationBuild({ carrier: null })
  assert.equal(application.kind, 'source-checkout')
  assert.equal(application.productName, 'Agent Host')
  assert.equal(typeof application.version, 'string')
  assert.equal(application.version.length > 0, true)
  assert.equal(application.note, APPLICATION_ENVIRONMENT_NOTE)
})

test('source status reports unpublished assets without claiming a Release', async (t) => {
  const isolated = await createIsolatedCli(t)
  const report = await inspectSourceStatus({ stateRoot: isolated.stateRoot }, { env: cleanEnv(), carrier: null })
  assert.equal(report.schemaVersion, SOURCE_STATUS_SCHEMA)
  assert.equal(report.status, 'unpublished')
  assert.equal(report.notarized, false)
  assert.equal(report.marketplace, false)
  assert.equal(report.publicReleasePublished, false)
  assert.equal(report.environment.configured, false)
  assert.equal(report.source.unpublished, true)
  assert.equal(report.source.kind, 'unset')
  assert.match(report.source.message, /unpublished/u)
  assert.equal(report.source.recovery.retry, true)
  assert.equal(report.source.recovery.chooseLocal, true)
  assert.match(human(report), /application/u)
  assert.match(human(report), /not notarized/u)
  assert.doesNotMatch(human(report), /notarized DMG|Developer ID signed/u)
})

test('source check records unpublished recovery without publishing assets', async (t) => {
  const isolated = await createIsolatedCli(t)
  const checked = await checkCatalogSource({ stateRoot: isolated.stateRoot }, {
    env: cleanEnv(),
    carrier: null,
    fetch: mockFetch({}),
  })
  assert.equal(checked.status, 'unpublished')
  assert.equal(checked.source.lastCheck.status, 'unpublished')
  assert.equal(checked.source.lastCheck.code, 'PREVIEW_DOWNLOAD_UNPUBLISHED')
  assert.match(checked.source.lastCheck.recovery.message, /local bound catalog/u)
  assert.equal(checked.publicReleasePublished, false)
  assert.equal(checked.notarized, false)
})

test('source check flips to published when convention index lists carriers', async (t) => {
  const isolated = await createIsolatedCli(t)
  const index = {
    schemaVersion: PREVIEW_DISTRIBUTION_SCHEMA,
    status: 'preview-unsigned',
    notarized: false,
    marketplace: false,
    publicReleasePublished: true,
    githubReleasesUrl: GITHUB_RELEASES_URL,
    selfHostedIndexUrl: GITHUB_PREVIEW_INDEX_CONVENTION,
    gatekeeperNote: 'gatekeeper',
    windowsSmartScreenNote: 'smartscreen',
    carriers: [{
      platform: 'darwin-arm64',
      kind: 'dmg',
      filename: 'Agent-Host-0.2.0-darwin-arm64.dmg',
      url: `${GITHUB_RELEASES_URL}/download/v0.2.0-unsigned.1/Agent-Host-0.2.0-darwin-arm64.dmg`,
      sha256: sha256(Buffer.from('fake-dmg')),
      bytes: 8,
    }],
    catalog: null,
  }
  const checked = await checkCatalogSource({ stateRoot: isolated.stateRoot }, {
    env: cleanEnv(),
    carrier: null,
    fetch: mockFetch({
      [GITHUB_PREVIEW_INDEX_CONVENTION]: { body: Buffer.from(`${JSON.stringify(index)}\n`) },
    }),
  })
  assert.equal(checked.status, 'ok')
  assert.equal(checked.publicReleasePublished, true)
  assert.equal(checked.notarized, false)
  assert.equal(checked.marketplace, false)
  assert.equal(checked.source.unpublished, false)
  assert.equal(checked.source.lastCheck.publicReleasePublished, true)
  assert.match(checked.source.message, /darwin-arm64/u)
  assert.match(checked.source.message, /Not Apple-notarized|not notarized/iu)
  assert.doesNotMatch(checked.source.message, /marketplace|App Store/iu)
})


test('source set accepts a local bound catalog and digest errors have recovery', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-source-catalog-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const isolated = await createIsolatedCli(t)
  const fixture = await writeBoundCatalog(root)
  const saved = await setCatalogSource(
    { stateRoot: isolated.stateRoot, releaseManifest: fixture },
    { env: cleanEnv(), carrier: null },
  )
  assert.equal(saved.source.kind, 'local')
  assert.equal(saved.source.path, fixture)
  assert.equal(saved.source.lastCheck.status, 'ok')
  assert.equal(saved.notarized, false)

  const digest = catalogFetchRecovery('PREVIEW_DOWNLOAD_DIGEST_MISMATCH')
  assert.match(digest.message, /digest or size/u)
  assert.equal(digest.action, 'discard-and-retry')
  const interrupted = catalogFetchRecovery('PREVIEW_DOWNLOAD_CANCELLED')
  assert.match(interrupted.message, /interrupted/u)
  const offline = catalogFetchRecovery('PREVIEW_DOWNLOAD_FAILED', { lastCatalogPath: '/tmp/current.json' })
  assert.match(offline.message, /offline or unreachable/u)
  assert.match(offline.message, /\/tmp\/current\.json/u)
})

test('source set HTTPS catalog check maps unpublished remote index to recovery', async (t) => {
  const isolated = await createIsolatedCli(t)
  const index = {
    schemaVersion: 'openadam.agent-host-preview-distribution.v0.1',
    status: 'unpublished',
    notarized: false,
    marketplace: false,
    publicReleasePublished: false,
    githubReleasesUrl: GITHUB_RELEASES_URL,
    selfHostedIndexUrl: null,
    gatekeeperNote: 'gatekeeper',
    windowsSmartScreenNote: 'smartscreen',
    carriers: [],
    catalog: null,
  }
  const url = 'https://example.invalid/preview-distribution.json'
  const checked = await setCatalogSource({ stateRoot: isolated.stateRoot, url }, {
    env: cleanEnv(),
    carrier: null,
    fetch: mockFetch({ [url]: { body: Buffer.from(`${JSON.stringify(index)}\n`) } }),
  })
  assert.equal(checked.source.kind, 'https')
  assert.equal(checked.source.url, url)
  assert.equal(checked.status, 'unpublished')
  assert.equal(checked.source.lastCheck.code, 'PREVIEW_DOWNLOAD_NOT_CONFIGURED')
  assert.match(checked.source.recovery.message, /unpublished|local bound catalog|not configured/iu)
})

test('CLI source status is visible without an install and source set requires one locator', async (t) => {
  const isolated = await createIsolatedCli(t)
  const status = runIsolatedCli(['source', 'status', '--json'], isolated)
  assert.equal(status.status, 0)
  const report = JSON.parse(status.stdout)
  assert.equal(report.schemaVersion, SOURCE_STATUS_SCHEMA)
  assert.equal(report.status, 'unpublished')
  assert.equal(report.notarized, false)
  assert.match(report.application.note, /different payloads/u)

  const both = runIsolatedCli([
    'source', 'set',
    '--url', 'https://example.invalid/preview-distribution.json',
    '--release-manifest', '/tmp/current.json',
    '--json',
  ], isolated)
  assert.equal(both.status, 2)
  assert.match(both.stderr, /source set requires --url or --release-manifest/u)

  const help = runIsolatedCli(['--help'], isolated)
  assert.equal(help.status, 0)
  assert.match(help.stdout, /source status/u)
  assert.match(help.stdout, /source set/u)
})

test('CLI source check of a digest mismatch keeps a recovery path', async (t) => {
  const isolated = await createIsolatedCli(t)
  const url = 'https://example.invalid/preview-distribution.json'
  const body = Buffer.from('not-the-digest')
  const index = {
    schemaVersion: 'openadam.agent-host-preview-distribution.v0.1',
    status: 'preview-unsigned',
    notarized: false,
    marketplace: false,
    publicReleasePublished: true,
    githubReleasesUrl: GITHUB_RELEASES_URL,
    selfHostedIndexUrl: url,
    gatekeeperNote: 'gatekeeper',
    windowsSmartScreenNote: 'smartscreen',
    carriers: [],
    catalog: {
      url: 'https://example.invalid/current.json',
      sha256: sha256(Buffer.from('expected-bytes')),
      bytes: 14,
      provenanceUrl: 'https://example.invalid/build-provenance.json',
      provenanceSha256: sha256(Buffer.from('{}')),
    },
  }
  await setCatalogSource({ stateRoot: isolated.stateRoot, url }, {
    env: cleanEnv(),
    carrier: null,
    fetch: mockFetch({
      [url]: { body: Buffer.from(`${JSON.stringify(index)}\n`) },
      'https://example.invalid/current.json': { body },
    }),
  })
  const checked = await inspectSourceStatus({ stateRoot: isolated.stateRoot }, { env: cleanEnv(), carrier: null })
  assert.equal(checked.source.kind, 'https')
  assert.ok(['PREVIEW_DOWNLOAD_DIGEST_MISMATCH', 'PREVIEW_DOWNLOAD_SIZE_MISMATCH', 'PREVIEW_DOWNLOAD_INVALID', 'PREVIEW_DOWNLOAD_FAILED'].includes(checked.source.lastCheck.code))
  assert.equal(checked.source.lastCheck.recovery.retry, true)
  assert.match(checked.source.lastCheck.recovery.message, /Retry|digest|size|not valid|bound/iu)
})

test('clearing a catalog source returns to unpublished', async (t) => {
  const isolated = await createIsolatedCli(t)
  const root = await mkdtemp(join(tmpdir(), 'agent-host-source-clear-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = await writeBoundCatalog(root, '0.2.0-clear')
  await setCatalogSource({ stateRoot: isolated.stateRoot, releaseManifest: fixture }, { env: cleanEnv(), carrier: null })
  const cleared = await clearCatalogSource({ stateRoot: isolated.stateRoot }, { env: cleanEnv(), carrier: null })
  assert.equal(cleared.source.kind, 'unset')
  assert.equal(cleared.source.path, null)
  assert.equal(cleared.status, 'unpublished')
})
