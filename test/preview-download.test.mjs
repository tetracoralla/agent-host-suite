import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  FEATURED_CATALOG_DOWNLOAD_ENV,
  GITHUB_PREVIEW_INDEX_CONVENTION,
  GITHUB_RELEASES_URL,
  PUBLIC_DOWNLOAD_NOT_CONFIGURED_NOTE,
  UNSIGNED_MACOS_GATEKEEPER_NOTE,
  fetchBoundCatalog,
  fetchPreviewRelease,
  normalizePreviewDownloadUrl,
  resolveReleaseManifestPath,
  validatePreviewDistribution,
} from '../src/preview-download.mjs'
import { defaultReleaseManifestPath } from '../src/release-manifest.mjs'
import { setup } from '../src/setup.mjs'
import { compatibleApplicationState, createCodexRunner, healthyCatalogPreflight } from './helpers.mjs'
import { createReleaseFixture } from './release-helpers.mjs'

const writerPath = fileURLToPath(new URL('../scripts/write-preview-distribution.mjs', import.meta.url))
const supportedReleasePlatform = ['darwin', 'win32'].includes(process.platform)
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  delete env[FEATURED_CATALOG_DOWNLOAD_ENV]
  return env
}

function mockFetch(files) {
  return async (url) => {
    const href = String(url)
    const entry = files[href]
    if (entry === undefined) return new Response('missing', { status: 404 })
    if (entry.redirect) {
      return new Response(null, { status: 302, headers: { location: entry.redirect } })
    }
    const body = entry.body
    return new Response(body, { status: 200, headers: entry.headers ?? {} })
  }
}

function unpublishedIndex() {
  return {
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
}

test('GitHub Releases HTML pages normalize to the preview-distribution asset convention', () => {
  assert.equal(normalizePreviewDownloadUrl(GITHUB_RELEASES_URL), GITHUB_PREVIEW_INDEX_CONVENTION)
  assert.equal(
    normalizePreviewDownloadUrl(`${GITHUB_RELEASES_URL}/latest`),
    GITHUB_PREVIEW_INDEX_CONVENTION,
  )
  assert.equal(
    normalizePreviewDownloadUrl('https://example.invalid/preview/'),
    'https://example.invalid/preview/preview-distribution.json',
  )
  assert.equal(normalizePreviewDownloadUrl(''), null)
  assert.throws(
    () => normalizePreviewDownloadUrl('http://example.invalid/preview-distribution.json'),
    (error) => error.code === 'PREVIEW_DOWNLOAD_INVALID_URL',
  )
})

test('the tracked preview index stays an unpublished placeholder', async () => {
  const tracked = JSON.parse(await readFile(new URL('../catalog/preview-distribution.json', import.meta.url), 'utf8'))
  const index = validatePreviewDistribution(tracked)
  assert.equal(index.status, 'unpublished')
  assert.equal(index.publicReleasePublished, false)
  assert.equal(index.notarized, false)
  assert.equal(index.catalog, null)
  assert.deepEqual(index.carriers, [])
  assert.equal(index.gatekeeperNote, UNSIGNED_MACOS_GATEKEEPER_NOTE)
})

test('unsigned macOS Gatekeeper copy names the macOS 15+ System Settings override', () => {
  assert.match(UNSIGNED_MACOS_GATEKEEPER_NOTE, /Open Anyway/u)
  assert.match(UNSIGNED_MACOS_GATEKEEPER_NOTE, /Privacy & Security/u)
  assert.match(UNSIGNED_MACOS_GATEKEEPER_NOTE, /System Settings/u)
  assert.match(UNSIGNED_MACOS_GATEKEEPER_NOTE, /macOS 15|Sequoia/u)
})

test('profiles fetch fails closed when the convention index returns 404 (injected, not live GitHub)', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-preview-unconfigured-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let requested = null
  await assert.rejects(
    fetchPreviewRelease({}, {
      env: cleanEnv(),
      paths: { downloads: root },
      fetch: async (url) => {
        requested = String(url)
        return new Response('missing', { status: 404 })
      },
    }),
    (error) => error.code === 'PREVIEW_DOWNLOAD_NOT_CONFIGURED' && error.message === PUBLIC_DOWNLOAD_NOT_CONFIGURED_NOTE,
  )
  assert.equal(requested, GITHUB_PREVIEW_INDEX_CONVENTION)
})

test('an unpublished preview index does not pretend a catalog exists', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-preview-unpublished-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const body = Buffer.from(`${JSON.stringify(unpublishedIndex())}\n`)
  await assert.rejects(
    fetchBoundCatalog('https://example.invalid/preview-distribution.json', {
      downloads: root,
      fetch: mockFetch({
        'https://example.invalid/preview-distribution.json': { body },
      }),
    }),
    (error) => error.code === 'PREVIEW_DOWNLOAD_NOT_CONFIGURED' && /not an app store/u.test(error.message),
  )
})

test('fetchBoundCatalog downloads current.json and provenance through an index', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-preview-index-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const catalog = Buffer.from(`${JSON.stringify({
    schemaVersion: 'openadam.agent-host-release.v0.2',
    releaseId: 'preview-1',
    suiteVersion: '0.2.0',
    status: 'internal-beta',
    createdAt: '2026-09-14T00:00:00.000Z',
    platforms: ['darwin-arm64'],
    components: [],
  })}\n`)
  const provenance = Buffer.from(`${JSON.stringify({
    schemaVersion: 'openadam.agent-host-build-provenance.v0.1',
    policy: 'local-development',
    releaseId: 'preview-1',
    suiteVersion: '0.2.0',
    createdAt: '2026-09-14T00:00:00.000Z',
    sources: { suite: { repository: null, revision: '0'.repeat(40), dirty: true, sourcePolicy: 'local-development' } },
    reusedComponents: [],
    distributionBoundary: 'local-build-only-not-a-remote-confirmed-distribution',
  })}\n`)
  const index = {
    ...unpublishedIndex(),
    status: 'preview-unsigned',
    publicReleasePublished: true,
    catalog: {
      url: 'https://example.invalid/current.json',
      sha256: sha256(catalog),
      bytes: catalog.length,
      provenanceUrl: 'https://example.invalid/build-provenance.json',
      provenanceSha256: sha256(provenance),
    },
  }
  const fetched = await fetchBoundCatalog('https://example.invalid/preview-distribution.json', {
    downloads: root,
    fetch: mockFetch({
      'https://example.invalid/preview-distribution.json': { body: Buffer.from(`${JSON.stringify(index)}\n`) },
      'https://example.invalid/current.json': { body: catalog },
      'https://example.invalid/build-provenance.json': { body: provenance },
    }),
  })
  assert.equal(fetched.manifest.releaseId, 'preview-1')
  assert.equal(JSON.parse(await readFile(fetched.manifestPath, 'utf8')).releaseId, 'preview-1')
  assert.equal(JSON.parse(await readFile(fetched.provenancePath, 'utf8')).releaseId, 'preview-1')
})

test('resolveReleaseManifestPath uses a saved local catalog when env is unset', async () => {
  const candidate = '/tmp/agent-host-saved-current.json'
  assert.equal(
    await resolveReleaseManifestPath({}, {
      env: cleanEnv(),
      savedCatalogSource: { kind: 'local', url: null, path: candidate },
    }),
    resolve(candidate),
  )
  assert.equal(
    await resolveReleaseManifestPath({ releaseManifest: '/tmp/explicit-current.json' }, {
      env: cleanEnv(),
      savedCatalogSource: { kind: 'local', url: null, path: candidate },
    }),
    resolve('/tmp/explicit-current.json'),
  )
})

test('resolveReleaseManifestPath uses the default unbound catalog when nothing is configured', async () => {
  assert.equal(
    await resolveReleaseManifestPath({}, { env: cleanEnv(), paths: { downloads: '/tmp' } }),
    defaultReleaseManifestPath(),
  )
})

test('resolveReleaseManifestPath treats Windows drive-letter paths as local files', async () => {
  const candidate = 'C:\\Users\\Fixture\\catalog\\current.json'
  assert.equal(
    await resolveReleaseManifestPath({ releaseManifest: candidate }, { env: cleanEnv() }),
    resolve(candidate),
  )
})

test('resolveReleaseManifestPath rejects non-HTTPS URL schemes', async () => {
  await assert.rejects(
    () => resolveReleaseManifestPath({ releaseManifest: 'http://example.invalid/current.json' }, { env: cleanEnv() }),
    (error) => error.code === 'PREVIEW_DOWNLOAD_UNSUPPORTED',
  )
  await assert.rejects(
    () => resolveReleaseManifestPath({ releaseManifest: 'file:///tmp/current.json' }, { env: cleanEnv() }),
    (error) => error.code === 'PREVIEW_DOWNLOAD_UNSUPPORTED',
  )
})

test('write-preview-distribution writes an unpublished index without claiming assets', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-preview-write-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const output = join(root, 'preview-distribution.json')
  const written = spawnSync(process.execPath, [writerPath, '--output', output], { encoding: 'utf8' })
  assert.equal(written.status, 0, written.stderr)
  const index = validatePreviewDistribution(JSON.parse(await readFile(output, 'utf8')))
  assert.equal(index.status, 'unpublished')
  assert.equal(index.publicReleasePublished, false)
  assert.equal(index.catalog, null)
})

test('setup fetches a bound catalog from AGENT_HOST_FEATURED_CATALOG_URL', { skip: !supportedReleasePlatform }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-preview-setup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifestPath = await createReleaseFixture(join(root, 'release'), {
    suiteVersion: '0.1.0-beta.1', releaseId: 'preview-setup-1', marker: 'preview', includeArmorial: true,
  })
  const catalogDir = dirname(manifestPath)
  const current = JSON.parse(await readFile(manifestPath, 'utf8'))
  const files = {}
  for (const component of current.components) {
    const filename = component.artifact.url.split('/').pop()
    const bytes = await readFile(join(catalogDir, component.artifact.url))
    component.artifact.url = `https://example.invalid/artifacts/${filename}`
    files[component.artifact.url] = { body: bytes }
  }
  const rewritten = Buffer.from(`${JSON.stringify(current, null, 2)}\n`)
  await writeFile(manifestPath, rewritten)
  const provenance = await readFile(join(catalogDir, 'build-provenance.json'))
  const index = {
    ...unpublishedIndex(),
    status: 'preview-unsigned',
    publicReleasePublished: true,
    catalog: {
      url: 'https://example.invalid/current.json',
      sha256: sha256(rewritten),
      bytes: rewritten.length,
      provenanceUrl: 'https://example.invalid/build-provenance.json',
      provenanceSha256: sha256(provenance),
    },
  }
  files['https://example.invalid/preview-distribution.json'] = { body: Buffer.from(`${JSON.stringify(index)}\n`) }
  files['https://example.invalid/current.json'] = { body: rewritten, redirect: undefined }
  files['https://cdn.example.invalid/current.json'] = { body: rewritten }
  files['https://example.invalid/build-provenance.json'] = { body: provenance }

  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathVersion: '0.4.0', mathMarketplace: 'openadam' })
  const installed = await setup({
    profile: 'featured', hosts: [], noHost: true, noService: true, dryRun: false,
    stateRoot: join(root, 'state'),
  }, {
    env: { [FEATURED_CATALOG_DOWNLOAD_ENV]: 'https://example.invalid/preview-distribution.json' },
    fetch: mockFetch(files),
    runner: fake.runner,
    componentWarmup: async ({ manifest, componentIds }) => ({
      status: 'ok', strategy: 'sequential-first-and-repeat',
      components: componentIds.map((id) => ({ id, version: manifest.components[id].version })),
    }),
    catalogPreflight: healthyCatalogPreflight,
    applicationStatePreflight: compatibleApplicationState,
    hostSkillHome: join(root, 'host-home'),
  })
  assert.equal(installed.status, 'installed')
})

test('a preview index without a matching installer does not pretend there is a store', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-preview-no-carrier-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const catalog = Buffer.from(`${JSON.stringify({
    schemaVersion: 'openadam.agent-host-release.v0.2',
    releaseId: 'preview-empty-carrier',
    suiteVersion: '0.2.0',
    status: 'internal-beta',
    createdAt: '2026-09-14T00:00:00.000Z',
    platforms: ['darwin-arm64'],
    components: [],
  })}\n`)
  const provenance = Buffer.from(`${JSON.stringify({
    schemaVersion: 'openadam.agent-host-build-provenance.v0.1',
    policy: 'local-development',
    releaseId: 'preview-empty-carrier',
    suiteVersion: '0.2.0',
    createdAt: '2026-09-14T00:00:00.000Z',
    sources: { suite: { repository: null, revision: '0'.repeat(40), dirty: true, sourcePolicy: 'local-development' } },
    reusedComponents: [],
    distributionBoundary: 'local-build-only-not-a-remote-confirmed-distribution',
  })}\n`)
  const index = {
    ...unpublishedIndex(),
    status: 'preview-unsigned',
    publicReleasePublished: true,
    catalog: {
      url: 'https://example.invalid/current.json',
      sha256: sha256(catalog),
      bytes: catalog.length,
      provenanceUrl: 'https://example.invalid/build-provenance.json',
      provenanceSha256: sha256(provenance),
    },
  }
  await assert.rejects(
    fetchPreviewRelease({ carrier: true }, {
      env: { [FEATURED_CATALOG_DOWNLOAD_ENV]: 'https://example.invalid/preview-distribution.json' },
      paths: { downloads: root },
      fetch: mockFetch({
        'https://example.invalid/preview-distribution.json': { body: Buffer.from(`${JSON.stringify(index)}\n`) },
        'https://example.invalid/current.json': { body: catalog },
        'https://example.invalid/build-provenance.json': { body: provenance },
      }),
    }),
    (error) => error.code === 'PREVIEW_CARRIER_UNAVAILABLE' && /not a store/u.test(error.message),
  )
})

test('profiles fetch --carrier downloads the current-platform installer from the index', { skip: !supportedReleasePlatform }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-preview-carrier-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { currentReleasePlatform } = await import('../src/release-manifest.mjs')
  const platform = currentReleasePlatform()
  const dmg = Buffer.from('unsigned-preview-dmg-bytes\n')
  const catalog = Buffer.from(`${JSON.stringify({
    schemaVersion: 'openadam.agent-host-release.v0.2',
    releaseId: 'preview-carrier-1',
    suiteVersion: '0.2.0',
    status: 'internal-beta',
    createdAt: '2026-09-14T00:00:00.000Z',
    platforms: [platform],
    components: [],
  })}\n`)
  const provenance = Buffer.from(`${JSON.stringify({
    schemaVersion: 'openadam.agent-host-build-provenance.v0.1',
    policy: 'local-development',
    releaseId: 'preview-carrier-1',
    suiteVersion: '0.2.0',
    createdAt: '2026-09-14T00:00:00.000Z',
    sources: { suite: { repository: null, revision: '0'.repeat(40), dirty: true, sourcePolicy: 'local-development' } },
    reusedComponents: [],
    distributionBoundary: 'local-build-only-not-a-remote-confirmed-distribution',
  })}\n`)
  const filename = `Agent-Host-0.2.0-${platform}.${platform.startsWith('win32') ? 'zip' : 'dmg'}`
  const index = {
    ...unpublishedIndex(),
    status: 'preview-unsigned',
    publicReleasePublished: true,
    catalog: {
      url: 'https://example.invalid/current.json',
      sha256: sha256(catalog),
      bytes: catalog.length,
      provenanceUrl: 'https://example.invalid/build-provenance.json',
      provenanceSha256: sha256(provenance),
    },
    carriers: [{
      platform,
      kind: platform.startsWith('win32') ? 'zip' : 'dmg',
      filename,
      url: `https://example.invalid/${filename}`,
      sha256: sha256(dmg),
      bytes: dmg.length,
    }],
  }
  const fetched = await fetchPreviewRelease({ carrier: true }, {
    env: { [FEATURED_CATALOG_DOWNLOAD_ENV]: 'https://example.invalid/preview-distribution.json' },
    paths: { downloads: root },
    fetch: mockFetch({
      'https://example.invalid/preview-distribution.json': { body: Buffer.from(`${JSON.stringify(index)}\n`) },
      'https://example.invalid/current.json': { body: catalog },
      'https://example.invalid/build-provenance.json': { body: provenance },
      [`https://example.invalid/${filename}`]: { body: dmg },
    }),
  })
  assert.equal(fetched.notarized, false)
  assert.equal(fetched.marketplace, false)
  assert.equal(fetched.carrier.filename, filename)
  assert.deepEqual(await readFile(fetched.carrierPath), dmg)
})
