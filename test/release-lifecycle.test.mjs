import assert from 'node:assert/strict'
import { mkdtemp, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { rollbackInstallation, uninstallInstallation, updateInstallation } from '../src/lifecycle.mjs'
import { setup } from '../src/setup.mjs'
import { loadState, prepareStatePaths, saveState } from '../src/state.mjs'
import { createCodexRunner } from './helpers.mjs'
import { createDevelopmentWorkspace } from './helpers.mjs'
import { createReleaseFixture } from './release-helpers.mjs'
import { cleanupStorage } from '../src/storage.mjs'

test('release setup, update, rollback, and purge retain immutable versions without source roots', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-release-fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const firstManifest = await createReleaseFixture(join(root, 'first'), { suiteVersion: '0.1.0-beta.1', releaseId: 'fixture-beta-1', marker: 'first' })
  const secondManifest = await createReleaseFixture(join(root, 'second'), { suiteVersion: '0.1.0-beta.2', releaseId: 'fixture-beta-2', marker: 'second' })
  const stateRoot = join(root, 'private', 'state', 'root')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathVersion: '0.4.0', mathMarketplace: 'openadam' })
  await setup({ profile: 'standard', hosts: ['codex'], releaseManifest: firstManifest, stateRoot, noService: true, dryRun: false, enableObservability: false }, { runner: fake.runner, hostSkillHome: join(root, 'host-home') })
  const paths = await prepareStatePaths(stateRoot)
  const first = await loadState(paths)
  assert.equal(first.channel, 'release')
  assert.equal(typeof first.releaseActivatedAt, 'string')
  assert.equal(Object.values(first.components).some((component) => component.root.includes('tools-dev')), false)

  const updated = await updateInstallation({ stateRoot, releaseManifest: secondManifest, dryRun: false }, { runner: fake.runner })
  assert.deepEqual(updated.changed.sort(), ['direct-execution-runtime', 'math-anchor', 'migratory-time', 'node-runtime'])
  const second = await loadState(paths)
  assert.equal(second.suiteVersion, '0.1.0-beta.2')
  assert.equal(typeof second.releaseActivatedAt, 'string')
  for (const id of ['node-runtime', 'direct-execution-runtime', 'math-anchor', 'migratory-time']) {
    assert.equal((await readdir(join(paths.packages, id))).filter((name) => !name.startsWith('.')).length, 2)
  }

  const rolledBack = await rollbackInstallation({ stateRoot, dryRun: false }, { runner: fake.runner })
  assert.equal(rolledBack.suiteVersion, '0.1.0-beta.1')
  assert.equal((await loadState(paths)).rolledBackFrom, '0.1.0-beta.2')
  assert.equal(typeof (await loadState(paths)).releaseActivatedAt, 'string')
  const removed = await uninstallInstallation({ stateRoot, purgeData: true }, { runner: fake.runner })
  assert.equal(removed.status, 'uninstalled')
  assert.equal(fake.plugins.size, 0)
  assert.equal(fake.marketplaces.size, 0)
})

test('storage cleanup keeps the active release and one complete rollback while removing older immutable packages and downloads', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-storage-fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifests = []
  for (const [index, marker] of ['first', 'second', 'third'].entries()) {
    manifests.push(await createReleaseFixture(join(root, marker), {
      suiteVersion: `0.1.0-beta.${index + 1}`,
      releaseId: `fixture-beta-${index + 1}`,
      marker,
    }))
  }
  const stateRoot = join(root, 'private', 'state', 'root')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathVersion: '0.4.0', mathMarketplace: 'openadam' })
  await setup({ profile: 'standard', hosts: [], releaseManifest: manifests[0], stateRoot, noService: true, dryRun: false, enableObservability: false }, { runner: fake.runner, hostSkillHome: join(root, 'host-home') })
  await updateInstallation({ stateRoot, releaseManifest: manifests[1], dryRun: false }, { runner: fake.runner })
  await updateInstallation({ stateRoot, releaseManifest: manifests[2], dryRun: false }, { runner: fake.runner })
  const paths = await prepareStatePaths(stateRoot)
  const staleDownload = join(paths.downloads, 'stale-release.tar.gz')
  await writeFile(staleDownload, 'stale', { mode: 0o600 })
  await utimes(staleDownload, new Date(0), new Date(0))

  const preview = await cleanupStorage({ stateRoot, dryRun: true })
  assert.equal(preview.plan.packageVersions, 4)
  assert.equal(preview.plan.downloads, 1)
  assert.equal((await readdir(join(paths.packages, 'math-anchor'))).length, 3)

  const cleaned = await cleanupStorage({ stateRoot })
  assert.equal(cleaned.removed.packageVersions, 4)
  assert.equal(cleaned.removed.downloads, 1)
  for (const id of ['node-runtime', 'direct-execution-runtime', 'math-anchor', 'migratory-time']) {
    assert.equal((await readdir(join(paths.packages, id))).filter((name) => !name.startsWith('.')).length, 2)
  }
  assert.equal((await rollbackInstallation({ stateRoot, dryRun: true }, { runner: fake.runner })).targetVersion, '0.1.0-beta.2')
})

test('development installation migrates to a release channel without losing enabled local monitoring', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-release-migration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'tools-dev-fixture')
  await createDevelopmentWorkspace(workspace)
  const manifest = await createReleaseFixture(join(root, 'release'), {
    suiteVersion: '0.1.0-dogfood.1',
    releaseId: 'fixture-dogfood-1',
    marker: 'dogfood',
    includeObservability: true,
  })
  const stateRoot = join(root, 'private', 'state', 'root')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathVersion: '0.3.0' })
  await setup({ profile: 'standard', hosts: [], developmentRoot: workspace, stateRoot, noService: true, dryRun: false, enableObservability: false }, { runner: fake.runner, hostSkillHome: join(root, 'host-home') })
  const paths = await prepareStatePaths(stateRoot)
  const development = await loadState(paths)
  development.profile = 'observability'
  development.components['agent-tool-observer'] = { version: '0.1.0', root: workspace, command: process.execPath, args: [], identityFiles: [], fingerprint: 'development-observer' }
  development.components['context-surface-analyzer'] = { version: '0.1.1', root: workspace, command: process.execPath, args: [], identityFiles: [], fingerprint: 'development-analyzer' }
  development.observability = { enabled: true, observer: { stateDir: join(root, 'observer') }, maintenance: null, latest: null }
  await saveState(paths, development)

  const dryRun = await updateInstallation({ stateRoot, releaseManifest: manifest, dryRun: true, replaceHostConflicts: true }, { runner: fake.runner })
  assert.equal(dryRun.fromChannel, 'development')
  assert.equal(dryRun.toChannel, 'release')
  assert.equal(dryRun.releaseId, 'fixture-dogfood-1')
  assert.equal(dryRun.activation.hosts.codex.entries.length, 2)
  assert.equal(dryRun.activation.hosts.codex.entries.every((entry) => entry.marketplaceRoot.includes('agent-host-codex-projection-')), true)
  assert.equal(dryRun.activation.service.configured, false)

  let rebound = false
  let updated
  try {
    updated = await updateInstallation(
      { stateRoot, releaseManifest: manifest, dryRun: false, replaceHostConflicts: true },
      { runner: fake.runner, rebindObservability: async (state) => {
        if (state.channel === 'release') {
          rebound = true
          assert.equal(state.components['agent-tool-observer'].root.startsWith(paths.packages), true)
          assert.equal(state.components['context-surface-analyzer'].root.startsWith(paths.packages), true)
        }
      } },
    )
  } catch (error) {
    assert.fail(JSON.stringify({ code: error.code, message: error.message, details: error.details }))
  }
  assert.equal(updated.channel, 'release')
  assert.equal(updated.releaseId, 'fixture-dogfood-1')
  assert.equal(rebound, true)
  const installed = await loadState(paths)
  assert.equal(installed.profile, 'observability')
  assert.equal(installed.developmentRoot, undefined)
  assert.equal(Object.values(installed.components).every((component) => component.root.startsWith(paths.packages)), true)
})

test('development to release migration refuses to drop enabled local monitoring', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-release-migration-missing-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'tools-dev-fixture')
  await createDevelopmentWorkspace(workspace)
  const manifest = await createReleaseFixture(join(root, 'release'), { suiteVersion: '0.1.0-beta.1', releaseId: 'fixture-beta-1', marker: 'standard' })
  const stateRoot = join(root, 'private', 'state', 'root')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathVersion: '0.3.0' })
  await setup({ profile: 'standard', hosts: [], developmentRoot: workspace, stateRoot, noService: true, dryRun: false, enableObservability: false }, { runner: fake.runner, hostSkillHome: join(root, 'host-home') })
  const paths = await prepareStatePaths(stateRoot)
  const development = await loadState(paths)
  development.observability = { enabled: true, observer: { stateDir: join(root, 'observer') }, maintenance: null, latest: null }
  await saveState(paths, development)
  await assert.rejects(
    updateInstallation({ stateRoot, releaseManifest: manifest, dryRun: true }, { runner: fake.runner }),
    (error) => error.code === 'OBSERVABILITY_RELEASE_COMPONENTS_MISSING',
  )
  assert.equal((await loadState(paths)).channel, 'development')
})

test('an update cannot select a consent-bearing profile before local monitoring is enabled', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-release-consent-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifest = await createReleaseFixture(join(root, 'release'), {
    suiteVersion: '0.1.0-dogfood.1',
    releaseId: 'fixture-dogfood-consent',
    marker: 'dogfood-consent',
    includeObservability: true,
  })
  const stateRoot = join(root, 'private', 'state', 'root')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathVersion: '0.4.0' })
  await setup({ profile: 'standard', hosts: [], releaseManifest: manifest, stateRoot, noService: true, dryRun: false, enableObservability: false }, { runner: fake.runner, hostSkillHome: join(root, 'host-home') })

  await assert.rejects(
    updateInstallation({ stateRoot, releaseManifest: manifest, profile: 'observability', dryRun: true }, { runner: fake.runner }),
    (error) => error.code === 'OBSERVABILITY_CONSENT_REQUIRED',
  )
  assert.equal((await loadState(await prepareStatePaths(stateRoot))).profile, 'standard')
})

test('development to release migration restores the development environment when monitoring rebind fails', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-release-migration-rollback-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'tools-dev-fixture')
  await createDevelopmentWorkspace(workspace)
  const manifest = await createReleaseFixture(join(root, 'release'), {
    suiteVersion: '0.1.0-dogfood.1',
    releaseId: 'fixture-dogfood-rollback',
    marker: 'dogfood-rollback',
    includeObservability: true,
  })
  const stateRoot = join(root, 'private', 'state', 'root')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathVersion: '0.3.0' })
  await setup({ profile: 'standard', hosts: ['codex'], developmentRoot: workspace, stateRoot, noService: true, dryRun: false, enableObservability: false }, { runner: fake.runner, hostSkillHome: join(root, 'host-home') })
  const paths = await prepareStatePaths(stateRoot)
  const development = await loadState(paths)
  development.profile = 'observability'
  development.components['agent-tool-observer'] = { version: '0.1.0', root: workspace, command: process.execPath, args: [], identityFiles: [], fingerprint: 'development-observer' }
  development.components['context-surface-analyzer'] = { version: '0.1.1', root: workspace, command: process.execPath, args: [], identityFiles: [], fingerprint: 'development-analyzer' }
  development.observability = { enabled: true, observer: { stateDir: join(root, 'observer') }, maintenance: null, latest: null }
  await saveState(paths, development)

  const reboundChannels = []
  await assert.rejects(
    updateInstallation(
      { stateRoot, releaseManifest: manifest, dryRun: false, replaceHostConflicts: true },
      {
        runner: fake.runner,
        rebindObservability: async (state) => {
          reboundChannels.push(state.channel)
          if (state.channel === 'release') throw new Error('injected monitoring rebind failure')
        },
      },
    ),
    /injected monitoring rebind failure/u,
  )
  assert.deepEqual(reboundChannels, ['release', 'development'])
  const restored = await loadState(paths)
  const resolvedWorkspace = await realpath(workspace)
  assert.equal(restored.channel, 'development')
  assert.equal(restored.developmentRoot, resolvedWorkspace)
  assert.equal(fake.marketplaces.get('math-anchor').startsWith(join(paths.hostProjections, 'codex')), true)
  assert.equal(fake.marketplaces.get('migratory-time').startsWith(join(paths.hostProjections, 'codex')), true)
  assert.equal(fake.plugins.has('math-anchor@math-anchor'), true)
  assert.equal(fake.plugins.has('migratory-time@migratory-time'), true)
})

test('failed update retains materialized release packages when restoration also fails', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-release-retained-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'tools-dev-fixture')
  await createDevelopmentWorkspace(workspace)
  const manifest = await createReleaseFixture(join(root, 'release'), {
    suiteVersion: '0.1.0-dogfood.1',
    releaseId: 'fixture-dogfood-retained',
    marker: 'dogfood-retained',
    includeObservability: true,
  })
  const stateRoot = join(root, 'private', 'state', 'root')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathVersion: '0.3.0' })
  await setup({ profile: 'standard', hosts: ['codex'], developmentRoot: workspace, stateRoot, noService: true, dryRun: false, enableObservability: false }, { runner: fake.runner, hostSkillHome: join(root, 'host-home') })
  const paths = await prepareStatePaths(stateRoot)
  const development = await loadState(paths)
  development.profile = 'observability'
  development.components['agent-tool-observer'] = { version: '0.1.0', root: workspace, command: process.execPath, args: [], identityFiles: [], fingerprint: 'development-observer' }
  development.components['context-surface-analyzer'] = { version: '0.1.1', root: workspace, command: process.execPath, args: [], identityFiles: [], fingerprint: 'development-analyzer' }
  development.observability = { enabled: true, observer: { stateDir: join(root, 'observer') }, maintenance: null, latest: null }
  await saveState(paths, development)

  let failure
  try {
    await updateInstallation(
      { stateRoot, releaseManifest: manifest, dryRun: false, replaceHostConflicts: true },
      { runner: fake.runner, rebindObservability: async () => { throw new Error('injected persistent rebind failure') } },
    )
    assert.fail('update should fail when both rebind attempts fail')
  } catch (error) {
    failure = error
  }
  assert.equal(failure.code, 'UPDATE_ROLLBACK_FAILED')
  assert.match(failure.details.update, /injected persistent rebind failure/u)
  assert.match(failure.details.rollback, /injected persistent rebind failure/u)
  assert.equal(failure.details.retainedReleasePackages.length > 0, true)
  for (const path of failure.details.retainedReleasePackages) assert.equal(await realpath(path), path)
  assert.equal((await loadState(paths)).channel, 'development')
})
