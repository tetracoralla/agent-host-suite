import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  ASSET_MANIFEST_NAME,
  buildReleaseCreateArgs,
  githubLatestWouldResolve,
  validateClosedAssetSet,
} from '../scripts/publish-unsigned-preview.mjs'
import {
  FEATURED_CATALOG_DOWNLOAD_ENV,
  fetchBoundCatalog,
  GITHUB_PREVIEW_INDEX_CONVENTION,
  GITHUB_RELEASES_URL,
  PREVIEW_DISTRIBUTION_SCHEMA,
} from '../src/preview-download.mjs'
import { acquireArtifact } from '../src/release-artifacts.mjs'

const publishPath = fileURLToPath(new URL('../scripts/publish-unsigned-preview.mjs', import.meta.url))
const hex = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sha256 = (bytes) => `sha256:${hex(bytes)}`
const supportedReleasePlatform = ['darwin', 'win32'].includes(process.platform)
const N7_COMPONENT_IDS = [
  'node-runtime',
  'direct-execution-runtime',
  'math-anchor',
  'migratory-time',
  'armorial',
]

async function stageDmg(root, name, contents) {
  const path = join(root, name)
  await writeFile(path, contents)
  return path
}

async function stageRelativeBoundCatalog(root, { ids = N7_COMPONENT_IDS } = {}) {
  const catalogDir = join(root, 'catalog')
  await mkdir(join(catalogDir, 'artifacts'), { recursive: true })
  const components = []
  for (const id of ids) {
    const version = id === 'node-runtime' ? '22.22.1' : '1.0.0'
    const platform = 'darwin-arm64'
    const archiveName = `${id}-${version}-${platform}.tar.gz`
    const bytes = Buffer.from(`fixture-archive:${id}\n`)
    await writeFile(join(catalogDir, 'artifacts', archiveName), bytes)
    components.push({
      id,
      version,
      platform,
      artifact: {
        url: `artifacts/${archiveName}`,
        sha256: sha256(bytes),
        bytes: bytes.length,
        format: 'tar.gz',
      },
      descriptorSha256: sha256(Buffer.from(`${id}-descriptor`)),
      license: { spdx: id === 'node-runtime' ? 'MIT' : 'Apache-2.0', files: ['LICENSE'] },
    })
  }
  const catalogPath = join(catalogDir, 'current.json')
  await writeFile(catalogPath, `${JSON.stringify({
    schemaVersion: 'openadam.agent-host-release.v0.2',
    releaseId: 'n7-bound-catalog',
    suiteVersion: '0.2.0',
    status: 'internal-beta',
    createdAt: '2026-09-14T00:00:00.000Z',
    platforms: ['darwin-arm64'],
    components,
  }, null, 2)}\n`)
  await writeFile(join(catalogDir, 'build-provenance.json'), `${JSON.stringify({
    schemaVersion: 'openadam.agent-host-build-provenance.v0.1',
    policy: 'local-development',
    releaseId: 'n7-bound-catalog',
    suiteVersion: '0.2.0',
    createdAt: '2026-09-14T00:00:00.000Z',
    sources: { suite: { repository: null, revision: '0'.repeat(40), dirty: true, sourcePolicy: 'local-development' } },
    reusedComponents: [],
    distributionBoundary: 'local-build-only-not-a-remote-confirmed-distribution',
  }, null, 2)}\n`)
  return { catalogDir, catalogPath, components }
}

function uploadOnlyFetch(tag, assetsDir, uploadNames) {
  const base = `${GITHUB_RELEASES_URL}/download/${tag}/`
  return async (url) => {
    const href = String(url)
    if (!href.startsWith(base)) return new Response('missing', { status: 404 })
    const name = decodeURIComponent(href.slice(base.length))
    if (name.includes('/') || name.includes('\\') || !uploadNames.has(name)) {
      return new Response('missing', { status: 404 })
    }
    const body = await readFile(join(assetsDir, name))
    return new Response(body, { status: 200 })
  }
}

async function refreshClosedSetDigests(output) {
  const catalogBytes = await readFile(join(output, 'current.json'))
  const provenanceBytes = await readFile(join(output, 'build-provenance.json'))
  const indexPath = join(output, 'preview-distribution.json')
  const index = JSON.parse(await readFile(indexPath, 'utf8'))
  if (index.catalog != null) {
    index.catalog.sha256 = sha256(catalogBytes)
    index.catalog.bytes = catalogBytes.length
    index.catalog.provenanceSha256 = sha256(provenanceBytes)
  }
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`)
  const manifestPath = join(output, ASSET_MANIFEST_NAME)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  for (const name of ['current.json', 'build-provenance.json', 'preview-distribution.json']) {
    const bytes = await readFile(join(output, name))
    const entry = manifest.upload.find((item) => item.name === name)
    if (entry == null) continue
    entry.sha256 = hex(bytes)
    entry.bytes = bytes.length
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return { index, manifest }
}

async function prepareAssets(t, {
  tag = 'v0.2.0-unsigned.1',
  dmgName = 'Agent-Host-0.2.0-darwin-arm64.dmg',
  dmgBytes = 'fake-dmg-bytes',
  stale = false,
  catalog = null,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-publish-unsigned-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dmg = await stageDmg(root, dmgName, dmgBytes)
  const output = join(root, 'out')
  if (stale) {
    await mkdir(output, { recursive: true })
    await writeFile(join(output, 'old-local-debug.log'), 'stale leftover from prior run\n')
    await writeFile(join(output, 'RELEASE_NOTES.md'), 'stale notes that must not enter SHA256SUMS\n')
  }
  const args = [publishPath, 'prepare', '--tag', tag, '--output', output, '--dmg', dmg]
  if (catalog != null) args.push('--catalog', catalog)
  const prepared = spawnSync(process.execPath, args, { encoding: 'utf8' })
  assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout)
  return { root, output, prepared, dmgBytes, tag, dmgName }
}

test('buildReleaseCreateArgs is non-prerelease --latest (GitHub REST cannot make_latest a prerelease)', () => {
  const args = buildReleaseCreateArgs({
    tag: 'v0.2.0-unsigned.1',
    assetPaths: ['/tmp/preview-distribution.json'],
    notesPath: '/tmp/RELEASE_NOTES.md',
    title: 'Agent Host unsigned preview v0.2.0-unsigned.1',
  })
  assert.equal(args.includes('--latest'), true)
  assert.equal(args.includes('--prerelease'), false)
  // Model GitHub /releases/latest: prereleases are excluded even if a client
  // passed --latest. Only the non-prerelease shape we publish can occupy latest.
  assert.equal(githubLatestWouldResolve({ draft: false, prerelease: true, tag_name: 'v0.2.0-unsigned.1' }), false)
  assert.equal(githubLatestWouldResolve({ draft: false, prerelease: false, tag_name: 'v0.2.0-unsigned.1' }), true)
})

test('prepare/publish dry-run print non-prerelease --latest and only the closed asset set', async (t) => {
  const { output, prepared, tag, dmgName } = await prepareAssets(t, { stale: true })
  assert.match(prepared.stdout, /--latest/u)
  assert.doesNotMatch(prepared.stdout, /--prerelease/u)
  assert.match(prepared.stdout, /old-local-debug\.log/u)
  assert.match(prepared.stdout, /ignoring non-manifest files/u)

  const sums = await readFile(join(output, 'SHA256SUMS'), 'utf8')
  assert.doesNotMatch(sums, /old-local-debug\.log/u)
  assert.doesNotMatch(sums, /RELEASE_NOTES\.md/u)
  assert.ok(sums.includes(dmgName), `expected SHA256SUMS to include ${dmgName}`)
  assert.match(sums, /preview-distribution\.json/u)

  const notes = await readFile(join(output, 'RELEASE_NOTES.md'), 'utf8')
  assert.match(notes, /System Settings/u)
  assert.match(notes, /Privacy & Security/u)
  assert.match(notes, /Open Anyway/u)
  assert.match(notes, /macOS 15 Sequoia/u)
  assert.match(notes, /Control-click → Open no longer overrides Gatekeeper/u)

  const manifest = JSON.parse(await readFile(join(output, ASSET_MANIFEST_NAME), 'utf8'))
  assert.equal(manifest.tag, tag)
  assert.equal(manifest.upload.some((entry) => entry.name === 'old-local-debug.log'), false)

  const published = spawnSync(
    process.execPath,
    [publishPath, 'publish', '--tag', tag, '--assets', output, '--dry-run'],
    { encoding: 'utf8' },
  )
  assert.equal(published.status, 0, published.stderr || published.stdout)
  assert.match(published.stdout, /--latest/u)
  assert.doesNotMatch(published.stdout, /--prerelease/u)
  assert.match(published.stdout, /refusing to upload non-manifest leftovers: old-local-debug\.log/u)
  const ghLine = published.stdout.split('\n').find((line) => line.startsWith('gh release create '))
  assert.ok(ghLine, 'expected gh release create line')
  assert.doesNotMatch(ghLine, /old-local-debug\.log/u)
  assert.match(ghLine, /preview-distribution\.json/u)
  assert.ok(published.stdout.includes(dmgName), `expected publish stdout to include ${dmgName}`)
  assert.match(published.stdout, /SHA256SUMS/u)

  // Discovery contract: the argv shape we emit is one GitHub would expose on
  // /releases/latest, which Host probes for preview-distribution.json.
  const simulatedRelease = {
    tag_name: tag,
    draft: false,
    prerelease: published.stdout.includes('--prerelease'),
    assets: manifest.upload.map((entry) => ({ name: entry.name })),
  }
  assert.equal(githubLatestWouldResolve(simulatedRelease), true)
  assert.equal(
    simulatedRelease.assets.some((asset) => asset.name === 'preview-distribution.json'),
    true,
  )
  assert.equal(GITHUB_PREVIEW_INDEX_CONVENTION.endsWith('/latest/download/preview-distribution.json'), true)
  assert.equal(GITHUB_PREVIEW_INDEX_CONVENTION.startsWith(GITHUB_RELEASES_URL), true)
})

test('publish refuses tag mismatch against the closed asset manifest / index URLs', async (t) => {
  const { output } = await prepareAssets(t, { tag: 'v0.2.0-unsigned.1' })
  const published = spawnSync(
    process.execPath,
    [publishPath, 'publish', '--tag', 'v9.9.9-unsigned.1', '--assets', output, '--dry-run'],
    { encoding: 'utf8' },
  )
  assert.notEqual(published.status, 0)
  assert.match(`${published.stderr}\n${published.stdout}`, /does not match publish --tag|must live under/iu)
})

test('publish refuses tampered carrier bytes', async (t) => {
  const { output, dmgName, tag } = await prepareAssets(t)
  await writeFile(join(output, dmgName), 'tampered-dmg-bytes-not-matching-index')
  const published = spawnSync(
    process.execPath,
    [publishPath, 'publish', '--tag', tag, '--assets', output, '--dry-run'],
    { encoding: 'utf8' },
  )
  assert.notEqual(published.status, 0)
  assert.match(`${published.stderr}\n${published.stdout}`, /sha256 mismatch|size mismatch|tampered|do not match/iu)
})

test('publish refuses missing declared carrier', async (t) => {
  const { output, dmgName, tag } = await prepareAssets(t)
  await rm(join(output, dmgName), { force: true })
  const published = spawnSync(
    process.execPath,
    [publishPath, 'publish', '--tag', tag, '--assets', output, '--dry-run'],
    { encoding: 'utf8' },
  )
  assert.notEqual(published.status, 0)
  assert.match(`${published.stderr}\n${published.stdout}`, /missing|not a regular file|ENOENT|missing declared carrier/iu)
})

test('validateClosedAssetSet does not treat leftover files as uploadable', async (t) => {
  const { output, tag } = await prepareAssets(t, { stale: true })
  const manifest = JSON.parse(await readFile(join(output, ASSET_MANIFEST_NAME), 'utf8'))
  const index = JSON.parse(await readFile(join(output, 'preview-distribution.json'), 'utf8'))
  assert.equal(index.schemaVersion, PREVIEW_DISTRIBUTION_SCHEMA)
  const validated = await validateClosedAssetSet({
    assetsDir: output,
    tag,
    index,
    manifest,
  })
  assert.equal(validated.leftovers.includes('old-local-debug.log'), true)
  assert.equal(
    validated.uploadPaths.some((path) => path.endsWith('old-local-debug.log')),
    false,
  )
  // Copy a leftover into a fake "would have been uploaded by readdir" set and
  // prove the closed set still excludes it.
  const readdirStyle = [...validated.uploadPaths, join(output, 'old-local-debug.log')]
  assert.equal(readdirStyle.length, validated.uploadPaths.length + 1)
})

test('prepare indexes carrier URLs under the publish tag so /releases/latest assets match the tag download base', async (t) => {
  const { output, tag, dmgName } = await prepareAssets(t)
  const index = JSON.parse(await readFile(join(output, 'preview-distribution.json'), 'utf8'))
  assert.equal(index.publicReleasePublished, true)
  assert.equal(index.carriers.length, 1)
  assert.equal(
    index.carriers[0].url,
    `${GITHUB_RELEASES_URL}/download/${tag}/${dmgName}`,
  )
  assert.equal(
    index.selfHostedIndexUrl,
    `${GITHUB_RELEASES_URL}/download/${tag}/preview-distribution.json`,
  )
})

test('prepare --catalog publishes referenced archives and a clean client acquires them from the upload set', async (t) => {
  const catalogRoot = await mkdtemp(join(tmpdir(), 'agent-host-n7-catalog-'))
  t.after(() => rm(catalogRoot, { recursive: true, force: true }))
  const staged = await stageRelativeBoundCatalog(catalogRoot)
  assert.equal(staged.components.every((item) => item.artifact.url.startsWith('artifacts/')), true)

  const { output, prepared, tag } = await prepareAssets(t, { catalog: staged.catalogPath })
  assert.match(prepared.stdout, /Included 5 catalog archive/u)

  const sourceCatalog = JSON.parse(await readFile(staged.catalogPath, 'utf8'))
  assert.equal(sourceCatalog.components.every((item) => item.artifact.url.startsWith('artifacts/')), true)

  const publishedCatalog = JSON.parse(await readFile(join(output, 'current.json'), 'utf8'))
  const expectedPrefix = `${GITHUB_RELEASES_URL}/download/${tag}/`
  const archiveNames = []
  for (const component of publishedCatalog.components) {
    assert.equal(component.artifact.url.startsWith(expectedPrefix), true, component.artifact.url)
    assert.equal(component.artifact.url.includes('/artifacts/'), false)
    const name = component.artifact.url.slice(expectedPrefix.length)
    archiveNames.push(name)
    assert.equal(name, basename(staged.components.find((item) => item.id === component.id).artifact.url))
  }

  const manifest = JSON.parse(await readFile(join(output, ASSET_MANIFEST_NAME), 'utf8'))
  const uploadNames = new Set(manifest.upload.map((entry) => entry.name))
  for (const name of archiveNames) {
    assert.equal(uploadNames.has(name), true, `upload set missing ${name}`)
    assert.equal(manifest.upload.find((entry) => entry.name === name).role, 'component-archive')
  }

  const published = spawnSync(
    process.execPath,
    [publishPath, 'publish', '--tag', tag, '--assets', output, '--dry-run'],
    { encoding: 'utf8' },
  )
  assert.equal(published.status, 0, published.stderr || published.stdout)
  const ghLine = published.stdout.split('\n').find((line) => line.startsWith('gh release create '))
  assert.ok(ghLine, 'expected gh release create line')
  for (const name of archiveNames) assert.match(ghLine, new RegExp(name.replaceAll('.', '\\.'), 'u'))

  const consumerRoot = await mkdtemp(join(tmpdir(), 'agent-host-n7-consumer-'))
  t.after(() => rm(consumerRoot, { recursive: true, force: true }))
  const fetch = uploadOnlyFetch(tag, output, uploadNames)
  const fetched = await fetchBoundCatalog(`${expectedPrefix}preview-distribution.json`, {
    downloads: join(consumerRoot, 'downloads'),
    fetch,
  })
  const consumed = JSON.parse(await readFile(fetched.manifestPath, 'utf8'))
  assert.equal(consumed.components.length, 5)
  assert.equal(consumed.components.every((item) => item.artifact.url.startsWith(expectedPrefix)), true)

  const acquired = []
  for (const component of consumed.components) {
    const result = await acquireArtifact(component, fetched.manifestPath, {
      downloads: join(consumerRoot, 'downloads'),
    }, { fetch })
    acquired.push(result.path)
    assert.equal(result.created, true)
  }
  assert.equal(acquired.length, 5)

  const omitted = new Set([...uploadNames].filter((name) => !name.endsWith('.tar.gz')))
  await mkdir(join(consumerRoot, 'downloads-omitted'), { recursive: true })
  await assert.rejects(
    acquireArtifact(consumed.components[0], fetched.manifestPath, {
      downloads: join(consumerRoot, 'downloads-omitted'),
    }, { fetch: uploadOnlyFetch(tag, output, omitted) }),
    (error) => error.code === 'RELEASE_DOWNLOAD_FAILED',
  )
})

test('prepare --catalog fails closed when a referenced archive is missing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-n7-missing-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const staged = await stageRelativeBoundCatalog(root)
  await rm(join(staged.catalogDir, staged.components[0].artifact.url))
  const dmg = await stageDmg(root, 'Agent-Host-0.2.0-darwin-arm64.dmg', 'fake-dmg-bytes')
  const prepared = spawnSync(
    process.execPath,
    [publishPath, 'prepare', '--tag', 'v0.2.0-unsigned.1', '--output', join(root, 'out'), '--dmg', dmg, '--catalog', staged.catalogPath],
    { encoding: 'utf8' },
  )
  assert.notEqual(prepared.status, 0)
  assert.match(
    `${prepared.stderr}\n${prepared.stdout}`,
    /missing|not a regular file|not present next to the catalog/iu,
  )
})

test('prepare --catalog fails closed when HTTPS artifact URLs have no local archive to publish', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-n7-remote-missing-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const staged = await stageRelativeBoundCatalog(root)
  const catalog = JSON.parse(await readFile(staged.catalogPath, 'utf8'))
  for (const component of catalog.components) {
    component.artifact.url = `https://example.invalid/artifacts/${basename(component.artifact.url)}`
  }
  await writeFile(staged.catalogPath, `${JSON.stringify(catalog, null, 2)}\n`)
  await rm(join(staged.catalogDir, 'artifacts'), { recursive: true, force: true })
  const dmg = await stageDmg(root, 'Agent-Host-0.2.0-darwin-arm64.dmg', 'fake-dmg-bytes')
  const prepared = spawnSync(
    process.execPath,
    [publishPath, 'prepare', '--tag', 'v0.2.0-unsigned.1', '--output', join(root, 'out'), '--dmg', dmg, '--catalog', staged.catalogPath],
    { encoding: 'utf8' },
  )
  assert.notEqual(prepared.status, 0)
  assert.match(`${prepared.stderr}\n${prepared.stdout}`, /not present next to the catalog|Refuse publishing/u)
})

test('validateClosedAssetSet refuses a bound catalog that still names local artifacts/', async (t) => {
  const catalogRoot = await mkdtemp(join(tmpdir(), 'agent-host-n7-relative-'))
  t.after(() => rm(catalogRoot, { recursive: true, force: true }))
  const staged = await stageRelativeBoundCatalog(catalogRoot)
  const { output, tag } = await prepareAssets(t, { catalog: staged.catalogPath })
  const rewritten = JSON.parse(await readFile(join(output, 'current.json'), 'utf8'))
  for (const component of rewritten.components) {
    component.artifact.url = `artifacts/${basename(component.artifact.url)}`
  }
  await writeFile(join(output, 'current.json'), `${JSON.stringify(rewritten, null, 2)}\n`)
  const { index, manifest } = await refreshClosedSetDigests(output)
  await assert.rejects(
    () => validateClosedAssetSet({ assetsDir: output, tag, index, manifest }),
    (error) => /clean client cannot fetch|must be a downloadable Release asset/u.test(error.message),
  )
})

test('clean client setup installs from prepare --catalog upload set only', { skip: !supportedReleasePlatform }, async (t) => {
  const { createReleaseFixture } = await import('./release-helpers.mjs')
  const { setup } = await import('../src/setup.mjs')
  const { compatibleApplicationState, createCodexRunner, healthyCatalogPreflight } = await import('./helpers.mjs')
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'agent-host-n7-setup-'))
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }))
  const manifestPath = await createReleaseFixture(join(fixtureRoot, 'release'), {
    suiteVersion: '0.2.0', releaseId: 'n7-setup', marker: 'n7',
  })
  const source = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert.equal(source.components.every((item) => item.artifact.url.startsWith('artifacts/')), true)

  const { output, tag } = await prepareAssets(t, { catalog: manifestPath })
  const manifest = JSON.parse(await readFile(join(output, ASSET_MANIFEST_NAME), 'utf8'))
  const uploadNames = new Set(manifest.upload.map((entry) => entry.name))
  for (const component of source.components) {
    assert.equal(uploadNames.has(basename(component.artifact.url)), true, component.artifact.url)
  }
  const publishedCatalog = JSON.parse(await readFile(join(output, 'current.json'), 'utf8'))
  assert.equal(
    publishedCatalog.components.every((item) => item.artifact.url.startsWith(`${GITHUB_RELEASES_URL}/download/${tag}/`)),
    true,
  )

  const fake = createCodexRunner({
    mathPresent: false, timePresent: false, mathVersion: '0.4.0', mathMarketplace: 'openadam',
  })
  const installed = await setup({
    profile: 'standard', hosts: [], noHost: true, noService: true, dryRun: false,
    stateRoot: join(fixtureRoot, 'state'),
  }, {
    env: { [FEATURED_CATALOG_DOWNLOAD_ENV]: `${GITHUB_RELEASES_URL}/download/${tag}/preview-distribution.json` },
    fetch: uploadOnlyFetch(tag, output, uploadNames),
    runner: fake.runner,
    componentWarmup: async ({ manifest: runtime, componentIds }) => ({
      status: 'ok',
      strategy: 'sequential-first-and-repeat',
      components: componentIds.map((id) => ({ id, version: runtime.components[id].version })),
    }),
    catalogPreflight: healthyCatalogPreflight,
    applicationStatePreflight: compatibleApplicationState,
    hostSkillHome: join(fixtureRoot, 'host-home'),
  })
  assert.equal(installed.status, 'installed')
})
