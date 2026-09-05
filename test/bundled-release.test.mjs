import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'
import { stageBundledReleaseCatalog, stageBundledReleaseCatalogForProfiles } from '../src/bundled-release.mjs'
import { createReleaseFixture } from './release-helpers.mjs'
import { currentReleasePlatform } from '../src/release-manifest.mjs'

test('a standard application payload excludes optional monitoring and dogfood artifacts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-bundled-release-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifestPath = await createReleaseFixture(join(root, 'source'), {
    suiteVersion: '0.1.0-beta.1', releaseId: 'fixture-beta-1', marker: 'bundle', includeObservability: true,
  })
  const sourceManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const sourceProvenancePath = join(dirname(manifestPath), 'build-provenance.json')
  const sourceProvenance = JSON.parse(await readFile(sourceProvenancePath, 'utf8'))
  sourceProvenance.reusedComponents = ['math-anchor', 'agent-tool-observer'].map((id) => ({
    id,
    artifactSha256: sourceManifest.components.find((component) => component.id === id).artifact.sha256,
    fromReleaseId: 'prior-fixture',
  }))
  await writeFile(sourceProvenancePath, `${JSON.stringify(sourceProvenance, null, 2)}\n`)
  const destination = join(root, 'standard')
  const result = await stageBundledReleaseCatalog(dirname(manifestPath), destination, 'standard')
  assert.deepEqual(result.components, ['node-runtime', 'direct-execution-runtime', 'math-anchor', 'migratory-time'])
  const manifest = JSON.parse(await readFile(join(destination, 'current.json'), 'utf8'))
  const provenance = JSON.parse(await readFile(join(destination, 'build-provenance.json'), 'utf8'))
  assert.deepEqual(manifest.components.map((component) => component.id), result.components)
  assert.equal(provenance.releaseId, manifest.releaseId)
  assert.equal(provenance.policy, 'local-development')
  assert.deepEqual(provenance.reusedComponents.map((component) => component.id), ['math-anchor'])
  assert.equal((await readdir(join(destination, 'artifacts'))).length, 4)
  await assert.rejects(access(join(destination, 'artifacts', `agent-tool-observer-0.1.0-${currentReleasePlatform()}.tar.gz`)))
})

test('an observability application payload retains the complete consented component pair', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-bundled-observability-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifestPath = await createReleaseFixture(join(root, 'source'), {
    suiteVersion: '0.1.0-beta.1', releaseId: 'fixture-beta-1', marker: 'bundle', includeObservability: true,
  })
  const result = await stageBundledReleaseCatalog(dirname(manifestPath), join(root, 'observability'), 'observability')
  assert.equal(result.components.includes('agent-tool-observer'), true)
  assert.equal(result.components.includes('context-surface-analyzer'), true)
})

test('a multi-profile application payload includes the union exactly once', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-bundled-multi-profile-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifestPath = await createReleaseFixture(join(root, 'source'), {
    suiteVersion: '0.1.0-beta.1', releaseId: 'fixture-beta-1', marker: 'bundle', includeObservability: true, includeDeveloper: true,
  })
  const result = await stageBundledReleaseCatalogForProfiles(dirname(manifestPath), join(root, 'combined'), ['standard', 'observability', 'developer'])
  assert.deepEqual(result.profiles, ['standard', 'observability', 'developer'])
  assert.equal(result.components.includes('agent-tool-observer'), true)
  assert.equal(result.components.includes('agent-tool-development-kit'), true)
  assert.equal(result.components.length, new Set(result.components).size)
})

test('bundled catalog staging rejects component bytes that drift after the release manifest is written', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-bundled-release-drift-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifestPath = await createReleaseFixture(join(root, 'source'), {
    suiteVersion: '0.1.0-beta.1', releaseId: 'fixture-beta-1', marker: 'bundle-drift',
  })
  const release = JSON.parse(await readFile(manifestPath, 'utf8'))
  const direct = release.components.find((component) => component.id === 'direct-execution-runtime')
  const archivePath = join(dirname(manifestPath), direct.artifact.url)
  await writeFile(archivePath, 'drifted after release probe\n')
  const destination = join(root, 'standard')
  await assert.rejects(
    stageBundledReleaseCatalog(dirname(manifestPath), destination, 'standard'),
    (error) => error.code === 'BUNDLED_RELEASE_ARTIFACT_MISMATCH'
      && error.message.includes(basename(archivePath).split('-0.1.0')[0]),
  )
  await assert.rejects(access(destination))
})

for (const defect of ['missing', 'symlink']) {
  test(`bundled staging identifies a ${defect} input before copying it`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'agent-host-bundle-input-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const manifestPath = await createReleaseFixture(join(root, 'source'), {
      suiteVersion: '0.1.0-beta.1', releaseId: 'fixture-beta-1', marker: 'input-kind',
    })
    const release = JSON.parse(await readFile(manifestPath, 'utf8'))
    const component = release.components.find((entry) => entry.id === 'direct-execution-runtime')
    const path = join(dirname(manifestPath), component.artifact.url)
    const original = await readFile(path)
    await rm(path)
    if (defect === 'symlink') {
      const outside = join(root, 'outside')
      await writeFile(outside, original)
      await symlink(outside, path)
    }
    const destination = join(root, 'output')
    await assert.rejects(stageBundledReleaseCatalog(dirname(manifestPath), destination, 'standard'),
      (error) => error.code === 'BUNDLED_RELEASE_ARTIFACT_MISMATCH'
        && error.message.includes('existing regular file'))
    await assert.rejects(access(destination))
  })
}
