import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  ASSET_MANIFEST_NAME,
  buildReleaseCreateArgs,
  githubLatestWouldResolve,
  validateClosedAssetSet,
} from '../scripts/publish-unsigned-preview.mjs'
import {
  GITHUB_PREVIEW_INDEX_CONVENTION,
  GITHUB_RELEASES_URL,
  PREVIEW_DISTRIBUTION_SCHEMA,
} from '../src/preview-download.mjs'

const publishPath = fileURLToPath(new URL('../scripts/publish-unsigned-preview.mjs', import.meta.url))
const hex = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sha256 = (bytes) => `sha256:${hex(bytes)}`

async function stageDmg(root, name, contents) {
  const path = join(root, name)
  await writeFile(path, contents)
  return path
}

async function prepareAssets(t, { tag = 'v0.2.0-unsigned.1', dmgName = 'Agent-Host-0.2.0-darwin-arm64.dmg', dmgBytes = 'fake-dmg-bytes', stale = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-publish-unsigned-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dmg = await stageDmg(root, dmgName, dmgBytes)
  const output = join(root, 'out')
  if (stale) {
    await mkdir(output, { recursive: true })
    await writeFile(join(output, 'old-local-debug.log'), 'stale leftover from prior run\n')
    await writeFile(join(output, 'RELEASE_NOTES.md'), 'stale notes that must not enter SHA256SUMS\n')
  }
  const prepared = spawnSync(
    process.execPath,
    [publishPath, 'prepare', '--tag', tag, '--output', output, '--dmg', dmg],
    { encoding: 'utf8' },
  )
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
