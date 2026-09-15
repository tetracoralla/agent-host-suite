import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { admitGitHubRelease } from '../src/github-project.mjs'
import { acquireHttpsFile, observeLocalComponentArtifact } from '../src/release-artifacts.mjs'
import { parseSha256File } from '../src/github-api.mjs'

const ARMORIAL_URL = 'https://github.com/tetracoralla/armorial/releases/tag/v0.8.0'
const ARMORIAL_ASSET = 'https://github.com/tetracoralla/armorial/releases/download/v0.8.0/armorial-0.8.0-codex-plugin-macos-arm64.tar.gz'
const ARMORIAL_SHA256 = 'sha256:db2cd4acb1b1e0ba96ece12d03f1d2d4d1fc8f5fabc1b1c6999ea3cb07b87fcd'
const ARMORIAL_BYTES = 4997635

test('public Armorial 0.8.0 downloads, verifies, wraps, and probes without a developer cache', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-armorial-08-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const admitted = await admitGitHubRelease({
    url: ARMORIAL_URL,
    outputPath: join(root, 'armorial-0.8.0-host-component.tar.gz'),
    workRoot: join(root, 'work'),
  })
  assert.equal(admitted.descriptor.id, 'armorial')
  assert.equal(admitted.descriptor.version, '0.8.0')
  assert.equal(admitted.origin.repository, 'tetracoralla/armorial')
  assert.equal(admitted.origin.tag, 'v0.8.0')
  assert.equal(admitted.upstream.sha256, ARMORIAL_SHA256)
  assert.equal(admitted.upstream.bytes, ARMORIAL_BYTES)
  assert.equal(admitted.wrapped.bytes > 0, true)
  assert.notEqual(admitted.wrapped.sha256, admitted.upstream.sha256)
  const tools = admitted.health?.tools ?? []
  for (const name of ['select_icons', 'resolve_icon', 'search_icons', 'get_icon', 'get_icons', 'choose_icon']) {
    assert.equal(tools.includes(name), true, `missing ${name}`)
  }
  assert.equal(admitted.descriptor.integration.discovery?.skill?.id, 'icon-svg-select')
  const observation = await observeLocalComponentArtifact(admitted.wrapped.path)
  assert.equal(observation.descriptor.id, 'armorial')
  assert.equal(observation.descriptor.version, '0.8.0')
  assert.equal(observation.observed.fileCount > 0, true)
}, { timeout: 180_000 })

test('truncated Armorial download fails closed and does not keep a bad file', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-armorial-trunc-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const destination = join(root, 'armorial.tar.gz')
  await mkdir(root, { recursive: true })
  await assert.rejects(
    () => acquireHttpsFile({
      url: ARMORIAL_ASSET,
      destination,
      expectedSha256: ARMORIAL_SHA256,
      expectedBytes: 64,
      maxBytes: 64,
      label: 'truncated armorial',
    }),
    (error) => error.code === 'RELEASE_ARTIFACT_SIZE_MISMATCH' || error.code === 'PREVIEW_DOWNLOAD_SIZE_MISMATCH' || error.code === 'RELEASE_DOWNLOAD_FAILED' || error.code === 'RELEASE_ARTIFACT_DIGEST_MISMATCH',
  )
  await assert.rejects(() => stat(destination), (error) => error.code === 'ENOENT')
}, { timeout: 60_000 })

test('wrong Armorial digest fails closed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-armorial-digest-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const destination = join(root, 'armorial.tar.gz')
  await assert.rejects(
    () => acquireHttpsFile({
      url: ARMORIAL_ASSET,
      destination,
      expectedSha256: 'sha256:' + '0'.repeat(64),
      expectedBytes: ARMORIAL_BYTES,
      maxBytes: ARMORIAL_BYTES,
      label: 'armorial digest',
    }),
    (error) => error.code === 'RELEASE_ARTIFACT_DIGEST_MISMATCH',
  )
}, { timeout: 180_000 })
