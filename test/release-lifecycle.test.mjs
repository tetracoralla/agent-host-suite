import { runSkillLauncher } from './launcher-helpers.mjs'
import assert from 'node:assert/strict'
import { access, lstat, mkdtemp, readFile, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { rollbackInstallation, uninstallInstallation, updateInstallation } from '../src/lifecycle.mjs'
import { setup } from '../src/setup.mjs'
import { loadState, prepareStatePaths, saveState } from '../src/state.mjs'
import { createClaudeRunner, createCodexRunner } from './helpers.mjs'
import { compatibleApplicationState, createDevelopmentWorkspace, healthyCatalogPreflight } from './helpers.mjs'
import { createReleaseFixture } from './release-helpers.mjs'
import { cleanupStorage, storageStatus } from '../src/storage.mjs'
import { AgentHostError } from '../src/errors.mjs'
import { enableObservability } from '../src/observability.mjs'
import { compareSuiteVersions, loadReleaseManifest } from '../src/release-manifest.mjs'
import { writeRuntimeFiles } from '../src/runtime-config.mjs'

async function healthyComponentWarmup({ manifest, componentIds }) {
  return {
    status: 'ok', strategy: 'sequential-first-and-repeat',
    components: componentIds.map((id) => ({ id, version: manifest.components[id].version })),
  }
}

function releaseDependencies(fake, values = {}) {
  return {
    runner: fake.runner,
    componentWarmup: healthyComponentWarmup,
    catalogPreflight: healthyCatalogPreflight,
    applicationStatePreflight: compatibleApplicationState,
    ...values,
  }
}

test('suite release ordering follows semantic-version precedence', () => {
  assert.equal(compareSuiteVersions('0.1.4-development.3', '0.1.4-development.2'), 1)
  assert.equal(compareSuiteVersions('0.1.4', '0.1.4-rc.9'), 1)
  assert.equal(compareSuiteVersions('0.1.4-rc.10', '0.1.4-rc.9'), 1)
  assert.equal(compareSuiteVersions('0.1.4-alpha', '0.1.4-beta'), -1)
  assert.equal(compareSuiteVersions('0.1.4', '0.1.4'), 0)
  assert.equal(compareSuiteVersions('0.1.5', '0.1.4'), 1)
})

test('release setup rejects missing source provenance before creating installation state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-release-provenance-fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifest = await createReleaseFixture(join(root, 'release'), {
    suiteVersion: '0.1.0-beta.1', releaseId: 'fixture-beta-1', marker: 'first',
  })
  await rm(join(root, 'release', 'catalog', 'build-provenance.json'))
  const stateRoot = join(root, 'private', 'state')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathVersion: '0.4.0', mathMarketplace: 'openadam' })
  await assert.rejects(
    setup({ profile: 'standard', hosts: [], releaseManifest: manifest, stateRoot, noService: true, dryRun: false, enableObservability: false }, releaseDependencies(fake)),
    (error) => error.code === 'RELEASE_SOURCE_PROVENANCE_UNAVAILABLE',
  )
  await assert.rejects(lstat(stateRoot), (error) => error.code === 'ENOENT')
})

test('release setup, update, rollback, and purge retain immutable versions without source roots', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-release-fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const firstManifest = await createReleaseFixture(join(root, 'first'), { suiteVersion: '0.1.4', releaseId: 'fixture-suite-0.1.4', marker: 'first' })
  const secondManifest = await createReleaseFixture(join(root, 'second'), { suiteVersion: '0.1.5', releaseId: 'fixture-suite-0.1.5', marker: 'second' })
  const stateRoot = join(root, 'private', 'state', 'root')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathVersion: '0.4.0', mathMarketplace: 'openadam' })
  const installed = await setup({ profile: 'standard', hosts: ['codex'], releaseManifest: firstManifest, stateRoot, noService: true, dryRun: false, enableObservability: false }, releaseDependencies(fake, { hostSkillHome: join(root, 'host-home') }))
  assert.deepEqual(installed.componentWarmup.components.map((item) => item.id), ['math-anchor', 'migratory-time'])
  const paths = await prepareStatePaths(stateRoot)
  const first = await loadState(paths)
  assert.equal(first.channel, 'release')
  assert.equal(typeof first.releaseActivatedAt, 'string')
  assert.equal(first.componentWarmupVersion, 1)
  assert.equal(first.releaseSourceProvenance.policy, 'local-development')
  assert.equal(first.releaseSourceProvenance.remoteConfirmedAtBuildTime, false)
  assert.equal(Object.values(first.components).some((component) => component.root.includes('tools-dev')), false)
  assert.equal(first.components['math-anchor'].cwd, first.components['math-anchor'].pluginRoot)
  assert.equal(first.components['migratory-time'].cwd, first.components['migratory-time'].pluginRoot)

  const updated = await updateInstallation({ stateRoot, releaseManifest: secondManifest, dryRun: false }, releaseDependencies(fake))
  assert.deepEqual(updated.changed.sort(), ['direct-execution-runtime', 'math-anchor', 'migratory-time', 'node-runtime'])
  const second = await loadState(paths)
  assert.equal(second.suiteVersion, '0.1.5')
  assert.equal(second.componentWarmupVersion, 1)
  assert.equal(second.releaseSourceProvenance.policy, 'local-development')
  assert.equal(typeof second.releaseActivatedAt, 'string')
  for (const id of ['node-runtime', 'direct-execution-runtime', 'math-anchor', 'migratory-time']) {
    assert.equal((await readdir(join(paths.packages, id))).filter((name) => !name.startsWith('.')).length, 2)
  }

  const rolledBack = await rollbackInstallation({ stateRoot, dryRun: false }, releaseDependencies(fake))
  assert.equal(rolledBack.suiteVersion, '0.1.4')
  assert.equal((await loadState(paths)).rolledBackFrom, '0.1.5')
  assert.equal(typeof (await loadState(paths)).releaseActivatedAt, 'string')
  const removed = await uninstallInstallation({ stateRoot, purgeData: true }, { runner: fake.runner })
  assert.equal(removed.status, 'uninstalled')
  assert.equal(fake.plugins.size, 0)
  assert.equal(fake.marketplaces.size, 0)
})

test('a standard release can opt into bundled local monitoring in one atomic update', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-release-observability-opt-in-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifest = await createReleaseFixture(join(root, 'release'), {
    suiteVersion: '0.1.0-beta.1', releaseId: 'fixture-observability-opt-in', marker: 'monitoring', includeObservability: true,
  })
  const stateRoot = join(root, 'private', 'state', 'root')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathVersion: '0.4.0', mathMarketplace: 'openadam' })
  const dependencies = releaseDependencies(fake, { hostSkillHome: join(root, 'host-home') })
  await setup({
    profile: 'standard', hosts: ['codex'], releaseManifest: manifest, stateRoot,
    noService: true, dryRun: false, enableObservability: false,
  }, dependencies)
  const paths = await prepareStatePaths(stateRoot)
  const before = await loadState(paths)
  assert.equal(before.profile, 'standard')
  assert.equal(before.observability.enabled, false)
  assert.equal(before.components['agent-tool-observer'], undefined)
  assert.equal(before.components['context-surface-analyzer'], undefined)

  const activatedStates = []
  const enabled = await enableObservability({ stateRoot }, releaseDependencies(fake, {
    hostSkillHome: join(root, 'host-home'),
    releaseManifestLoader: (path) => loadReleaseManifest(path ?? manifest),
    activateObservability: async (state) => {
      activatedStates.push(state)
      return {
        ...state,
        updatedAt: new Date().toISOString(),
        observability: {
          enabled: true,
          consentedAt: new Date().toISOString(),
          observer: { stateDir: join(root, 'observer'), installation: { intervalSeconds: 300 } },
          maintenance: { intervalSeconds: 604800 },
          latest: null,
        },
      }
    },
  }))

  assert.equal(enabled.status, 'enabled')
  assert.equal(enabled.profile, 'observability')
  assert.equal(enabled.observability.enabled, true)
  assert.equal(activatedStates.length, 1)
  assert.equal(activatedStates[0].profile, 'observability')
  const after = await loadState(paths)
  assert.equal(after.profile, 'observability')
  assert.equal(after.observability.enabled, true)
  assert.equal(after.components['agent-tool-observer'].root.includes(join(paths.packages, 'agent-tool-observer')), true)
  assert.equal(after.components['context-surface-analyzer'].root.includes(join(paths.packages, 'context-surface-analyzer')), true)
  assert.deepEqual(after.agentComponents, ['math-anchor', 'migratory-time'])
  assert.deepEqual(after.availableAgentComponents, ['math-anchor', 'migratory-time'])
  assert.equal(after.hosts.codex.entries.some((entry) => entry.component === 'agent-tool-observer'), false)
})

test('a failed monitoring opt-in keeps the prior standard installation intact', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-release-observability-rollback-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifest = await createReleaseFixture(join(root, 'release'), {
    suiteVersion: '0.1.0-beta.1', releaseId: 'fixture-observability-rollback', marker: 'monitoring-failure', includeObservability: true,
  })
  const stateRoot = join(root, 'private', 'state', 'root')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathVersion: '0.4.0', mathMarketplace: 'openadam' })
  const hostSkillHome = join(root, 'host-home')
  await setup({
    profile: 'standard', hosts: ['codex'], releaseManifest: manifest, stateRoot,
    noService: true, dryRun: false, enableObservability: false,
  }, releaseDependencies(fake, { hostSkillHome }))
  const paths = await prepareStatePaths(stateRoot)
  const before = await loadState(paths)

  await assert.rejects(
    enableObservability({ stateRoot }, releaseDependencies(fake, {
      hostSkillHome,
      releaseManifestLoader: (path) => loadReleaseManifest(path ?? manifest),
      activateObservability: async () => { throw new Error('injected monitoring activation failure') },
    })),
    /injected monitoring activation failure/u,
  )

  assert.deepEqual(await loadState(paths), before)
  for (const id of ['agent-tool-observer', 'context-surface-analyzer']) {
    assert.deepEqual((await readdir(join(paths.packages, id))).filter((name) => !name.startsWith('.')), [])
  }
  assert.equal(fake.plugins.has('math-anchor@openadam'), true)
  assert.equal(fake.plugins.has('migratory-time@migratory-time'), true)
})

test('a monitoring opt-in commit failure removes its activated external carriers', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-release-observability-commit-rollback-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifest = await createReleaseFixture(join(root, 'release'), {
    suiteVersion: '0.1.0-beta.1', releaseId: 'fixture-observability-commit-rollback', marker: 'monitoring-commit-failure', includeObservability: true,
  })
  const stateRoot = join(root, 'private', 'state', 'root')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathVersion: '0.4.0', mathMarketplace: 'openadam' })
  const hostSkillHome = join(root, 'host-home')
  await setup({
    profile: 'standard', hosts: ['codex'], releaseManifest: manifest, stateRoot,
    noService: true, dryRun: false, enableObservability: false,
  }, releaseDependencies(fake, { hostSkillHome }))
  const paths = await prepareStatePaths(stateRoot)
  const before = await loadState(paths)
  let externalCarrierActive = false
  let teardowns = 0

  await assert.rejects(
    enableObservability({ stateRoot }, releaseDependencies(fake, {
      hostSkillHome,
      releaseManifestLoader: (path) => loadReleaseManifest(path ?? manifest),
      activateObservability: async (state) => {
        externalCarrierActive = true
        return {
          ...state,
          observability: { enabled: true, observer: {}, maintenance: null },
        }
      },
      teardownObservability: async () => {
        teardowns += 1
        externalCarrierActive = false
      },
      saveState: async () => { throw new Error('injected monitoring opt-in commit failure') },
    })),
    /injected monitoring opt-in commit failure/u,
  )

  assert.equal(teardowns, 1)
  assert.equal(externalCarrierActive, false)
  assert.deepEqual(await loadState(paths), before)
  for (const id of ['agent-tool-observer', 'context-surface-analyzer']) {
    assert.deepEqual((await readdir(join(paths.packages, id))).filter((name) => !name.startsWith('.')), [])
  }
})

test('monitoring opt-in cannot silently replace the installed compatibility release', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-observability-release-mismatch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const firstManifest = await createReleaseFixture(join(root, 'first'), {
    suiteVersion: '0.1.0-beta.1', releaseId: 'fixture-monitoring-release-1', marker: 'first', includeObservability: true,
  })
  const secondManifest = await createReleaseFixture(join(root, 'second'), {
    suiteVersion: '0.1.0-beta.2', releaseId: 'fixture-monitoring-release-2', marker: 'second', includeObservability: true,
  })
  const stateRoot = join(root, 'private', 'state', 'root')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathVersion: '0.4.0', mathMarketplace: 'openadam' })
  const hostSkillHome = join(root, 'host-home')
  await setup({
    profile: 'standard', hosts: ['codex'], releaseManifest: firstManifest, stateRoot,
    noService: true, dryRun: false, enableObservability: false,
  }, releaseDependencies(fake, { hostSkillHome }))
  const paths = await prepareStatePaths(stateRoot)
  const before = await loadState(paths)
  const callsBefore = fake.calls.length

  await assert.rejects(
    enableObservability({ stateRoot }, releaseDependencies(fake, {
      hostSkillHome,
      releaseManifestLoader: (path) => loadReleaseManifest(path ?? secondManifest),
    })),
    (error) => error.code === 'OBSERVABILITY_COMPATIBILITY_UPDATE_REQUIRED',
  )

  assert.deepEqual(await loadState(paths), before)
  assert.equal(fake.calls.length, callsBefore)
  for (const id of ['agent-tool-observer', 'context-surface-analyzer']) {
    assert.deepEqual((await readdir(join(paths.packages, id))).filter((name) => !name.startsWith('.')), [])
  }
})

test('release update asks the installed application to read the candidate state before dry-run or activation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-release-app-preflight-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const firstManifest = await createReleaseFixture(join(root, 'first'), {
    suiteVersion: '0.1.0-beta.1', releaseId: 'fixture-app-preflight-1', marker: 'first',
  })
  const secondManifest = await createReleaseFixture(join(root, 'second'), {
    suiteVersion: '0.1.0-beta.2', releaseId: 'fixture-app-preflight-2', marker: 'second',
  })
  const stateRoot = join(root, 'private', 'state', 'root')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathVersion: '0.4.0', mathMarketplace: 'openadam' })
  await setup({
    profile: 'standard', hosts: ['codex'], releaseManifest: firstManifest, stateRoot,
    noService: true, dryRun: false, enableObservability: false,
  }, releaseDependencies(fake, { hostSkillHome: join(root, 'host-home') }))
  const paths = await prepareStatePaths(stateRoot)
  const before = await loadState(paths)
  const callsBefore = fake.calls.length
  let inspected = 0
  const rejectNewState = async (candidate) => {
    inspected += 1
    assert.equal(candidate.suiteVersion, '0.1.0-beta.2')
    assert.equal(candidate.releaseSourceProvenance.policy, 'local-development')
    throw new AgentHostError('APPLICATION_STATE_INCOMPATIBLE', 'fixture old app rejected the new optional field')
  }

  await assert.rejects(
    updateInstallation(
      { stateRoot, releaseManifest: secondManifest, dryRun: true },
      releaseDependencies(fake, { applicationStatePreflight: rejectNewState }),
    ),
    (error) => error.code === 'APPLICATION_STATE_INCOMPATIBLE',
  )
  await assert.rejects(
    updateInstallation(
      { stateRoot, releaseManifest: secondManifest, dryRun: false },
      releaseDependencies(fake, { applicationStatePreflight: rejectNewState }),
    ),
    (error) => error.code === 'APPLICATION_STATE_INCOMPATIBLE',
  )
  assert.equal(inspected, 2)
  assert.equal(fake.calls.length, callsBefore)
  assert.deepEqual(await loadState(paths), before)
  assert.equal(await lstat(join(paths.packages, 'math-anchor')).then(() => true), true)
  assert.equal((await readdir(join(paths.packages, 'math-anchor'))).filter((name) => !name.startsWith('.')).length, 1)
})

test('tool update refuses an older application catalog before materializing or changing hosts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-release-downgrade-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const olderManifest = await createReleaseFixture(join(root, 'older'), {
    suiteVersion: '0.1.0-beta.1', releaseId: 'fixture-downgrade-older', marker: 'older',
  })
  const currentManifest = await createReleaseFixture(join(root, 'current'), {
    suiteVersion: '0.1.0-beta.2', releaseId: 'fixture-downgrade-current', marker: 'current',
  })
  const stateRoot = join(root, 'private', 'state', 'root')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathVersion: '0.4.0', mathMarketplace: 'openadam' })
  const hostSkillHome = join(root, 'host-home')
  await setup({
    profile: 'standard', hosts: ['codex'], releaseManifest: currentManifest, stateRoot,
    noService: true, dryRun: false, enableObservability: false,
  }, releaseDependencies(fake, { hostSkillHome }))
  const paths = await prepareStatePaths(stateRoot)
  const before = await loadState(paths)
  const callsBefore = fake.calls.length

  await assert.rejects(
    updateInstallation({ stateRoot, releaseManifest: olderManifest, dryRun: false }, releaseDependencies(fake, { hostSkillHome })),
    (error) => error.code === 'RELEASE_DOWNGRADE_UNSUPPORTED'
      && error.details.currentVersion === '0.1.0-beta.2'
      && error.details.requestedVersion === '0.1.0-beta.1',
  )

  assert.deepEqual(await loadState(paths), before)
  assert.equal(fake.calls.length, callsBefore)
})

test('rollback asks the installed application to read the candidate state before host mutation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-rollback-app-preflight-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const firstManifest = await createReleaseFixture(join(root, 'first'), {
    suiteVersion: '0.1.0-beta.1', releaseId: 'fixture-rollback-app-1', marker: 'first',
  })
  const secondManifest = await createReleaseFixture(join(root, 'second'), {
    suiteVersion: '0.1.0-beta.2', releaseId: 'fixture-rollback-app-2', marker: 'second',
  })
  const stateRoot = join(root, 'private', 'state', 'root')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathVersion: '0.4.0', mathMarketplace: 'openadam' })
  const hostSkillHome = join(root, 'host-home')
  await setup({
    profile: 'standard', hosts: ['codex'], releaseManifest: firstManifest, stateRoot,
    noService: true, dryRun: false, enableObservability: false,
  }, releaseDependencies(fake, { hostSkillHome }))
  await updateInstallation({ stateRoot, releaseManifest: secondManifest, dryRun: false }, releaseDependencies(fake, { hostSkillHome }))
  const paths = await prepareStatePaths(stateRoot)
  const before = await loadState(paths)
  const callsBefore = fake.calls.length
  let inspected = 0

  await assert.rejects(
    rollbackInstallation({ stateRoot, dryRun: false }, releaseDependencies(fake, {
      hostSkillHome,
      applicationStatePreflight: async (candidate) => {
        inspected += 1
        assert.equal(candidate.suiteVersion, '0.1.0-beta.1')
        assert.equal(candidate.rolledBackFrom, '0.1.0-beta.2')
        throw new AgentHostError('APPLICATION_STATE_INCOMPATIBLE', 'fixture app rejected rollback state')
      },
    })),
    (error) => error.code === 'APPLICATION_STATE_INCOMPATIBLE',
  )

  assert.equal(inspected, 1)
  assert.equal(fake.calls.length, callsBefore)
  assert.deepEqual(await loadState(paths), before)
})

test('whole-suite rollback restores the current Host and runtime after a post-activation commit failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-rollback-compensation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const firstManifest = await createReleaseFixture(join(root, 'first'), {
    suiteVersion: '0.1.0-beta.1', releaseId: 'fixture-rollback-compensation-1', marker: 'first',
  })
  const secondManifest = await createReleaseFixture(join(root, 'second'), {
    suiteVersion: '0.1.0-beta.2', releaseId: 'fixture-rollback-compensation-2', marker: 'second',
  })
  const stateRoot = join(root, 'private', 'state', 'root')
  const hostSkillHome = join(root, 'host-home')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathVersion: '0.4.0', mathMarketplace: 'openadam' })
  await setup({ profile: 'standard', hosts: ['codex'], releaseManifest: firstManifest, stateRoot, noService: true, dryRun: false, enableObservability: false }, releaseDependencies(fake, { hostSkillHome }))
  await updateInstallation({ stateRoot, releaseManifest: secondManifest, dryRun: false }, releaseDependencies(fake, { hostSkillHome }))
  const paths = await prepareStatePaths(stateRoot)
  const before = await loadState(paths)
  const marketplacesBefore = new Map(fake.marketplaces)

  await assert.rejects(
    rollbackInstallation({ stateRoot, dryRun: false }, releaseDependencies(fake, {
      hostSkillHome,
      saveState: async () => { throw new Error('injected state commit failure') },
    })),
    /injected state commit failure/u,
  )

  assert.deepEqual(await loadState(paths), before)
  assert.deepEqual(new Map(fake.marketplaces), marketplacesBefore)
  assert.equal((await lstat(before.runtime.configPath)).isFile(), true)
})

test('release update restores the current Host and state after a post-activation commit failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-update-compensation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const firstManifest = await createReleaseFixture(join(root, 'first'), {
    suiteVersion: '0.1.0-beta.1', releaseId: 'fixture-update-compensation-1', marker: 'first',
  })
  const secondManifest = await createReleaseFixture(join(root, 'second'), {
    suiteVersion: '0.1.0-beta.2', releaseId: 'fixture-update-compensation-2', marker: 'second',
  })
  const stateRoot = join(root, 'private', 'state', 'root')
  const hostSkillHome = join(root, 'host-home')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathVersion: '0.4.0', mathMarketplace: 'openadam' })
  await setup({ profile: 'standard', hosts: ['codex'], releaseManifest: firstManifest, stateRoot, noService: true, dryRun: false, enableObservability: false }, releaseDependencies(fake, { hostSkillHome }))
  const paths = await prepareStatePaths(stateRoot)
  const before = await loadState(paths)
  const pluginsBefore = new Map(fake.plugins)
  const marketplacesBefore = new Map(fake.marketplaces)

  await assert.rejects(
    updateInstallation({ stateRoot, releaseManifest: secondManifest, dryRun: false }, releaseDependencies(fake, {
      hostSkillHome,
      saveState: async () => { throw new Error('injected update commit failure') },
    })),
    /injected update commit failure/u,
  )

  assert.deepEqual(await loadState(paths), before)
  assert.deepEqual(new Map(fake.plugins), pluginsBefore)
  assert.deepEqual(new Map(fake.marketplaces), marketplacesBefore)
})

test('whole-suite rollback reports compound failure when current-environment restoration also fails', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-rollback-compound-failure-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const firstManifest = await createReleaseFixture(join(root, 'first'), {
    suiteVersion: '0.1.0-beta.1', releaseId: 'fixture-rollback-compound-1', marker: 'first',
  })
  const secondManifest = await createReleaseFixture(join(root, 'second'), {
    suiteVersion: '0.1.0-beta.2', releaseId: 'fixture-rollback-compound-2', marker: 'second',
  })
  const stateRoot = join(root, 'private', 'state', 'root')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathVersion: '0.4.0', mathMarketplace: 'openadam' })
  await setup({ profile: 'standard', hosts: [], releaseManifest: firstManifest, stateRoot, noService: true, dryRun: false, enableObservability: false }, releaseDependencies(fake))
  await updateInstallation({ stateRoot, releaseManifest: secondManifest, dryRun: false }, releaseDependencies(fake))
  let writes = 0

  await assert.rejects(
    rollbackInstallation({ stateRoot, dryRun: false }, releaseDependencies(fake, {
      saveState: async () => { throw new Error('injected state commit failure') },
      writeRuntimeFiles: async (...args) => {
        writes += 1
        if (writes === 2) throw new Error('injected restoration failure')
        return await writeRuntimeFiles(...args)
      },
    })),
    (error) => error.code === 'ROLLBACK_RESTORATION_FAILED'
      && error.details.rollback === 'injected state commit failure'
      && error.details.restoration === 'injected restoration failure',
  )
})

test('whole-suite rollback skips newer same-release operational snapshots', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-release-rollback-snapshot-fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const firstManifest = await createReleaseFixture(join(root, 'first'), {
    suiteVersion: '0.1.0-beta.1', releaseId: 'fixture-beta-1', marker: 'same-bytes',
  })
  const secondManifest = await createReleaseFixture(join(root, 'second'), {
    suiteVersion: '0.1.0-beta.2', releaseId: 'fixture-beta-2', marker: 'same-bytes',
  })
  const stateRoot = join(root, 'private', 'state', 'root')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathVersion: '0.4.0', mathMarketplace: 'openadam' })
  await setup({ profile: 'standard', hosts: ['codex'], releaseManifest: firstManifest, stateRoot, noService: true, dryRun: false, enableObservability: false }, releaseDependencies(fake, { hostSkillHome: join(root, 'host-home') }))
  await updateInstallation({ stateRoot, releaseManifest: secondManifest, dryRun: false }, releaseDependencies(fake))
  const paths = await prepareStatePaths(stateRoot)
  const current = await loadState(paths)
  await saveState(paths, { ...current, updatedAt: new Date().toISOString() }, { retainCurrent: true })

  assert.equal((await rollbackInstallation({ stateRoot, dryRun: true }, releaseDependencies(fake))).targetVersion, '0.1.0-beta.1')
  assert.equal((await storageStatus({ stateRoot })).rollback.suiteVersion, '0.1.0-beta.1')
})

test('developer profile installs a Skill-only Codex plugin without enlarging the Agent tool set', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-developer-release-fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifest = await createReleaseFixture(join(root, 'release'), {
    suiteVersion: '0.1.2-developer.1', releaseId: 'fixture-developer-1', marker: 'developer', includeDeveloper: true,
  })
  const stateRoot = join(root, 'private', 'state', 'root')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathVersion: '0.4.0', mathMarketplace: 'openadam' })
  await setup({
    profile: 'developer', hosts: ['codex'], releaseManifest: manifest, stateRoot,
    noService: true, dryRun: false, enableObservability: false,
  }, releaseDependencies(fake, { hostSkillHome: join(root, 'host-home') }))
  const state = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(state.components['agent-tool-development-kit'].skillOnly, true)
  assert.deepEqual(state.availableAgentComponents, [])
  assert.deepEqual(state.agentComponents, [])
  assert.equal(fake.plugins.has('agent-tool-development-kit@openadam-developer-tools'), true)
  const entry = state.hosts.codex.entries.find((item) => item.selector === 'agent-tool-development-kit@openadam-developer-tools')
  await assert.rejects(readFile(join(entry.pluginRoot, '.mcp.json')), (error) => error.code === 'ENOENT')
  assert.match(await readFile(join(entry.pluginRoot, 'skills', 'build-openadam-agent-tools', 'scripts', process.platform === 'win32' ? 'openadam-dev.cmd' : 'openadam-dev'), 'utf8'), process.platform === 'win32' ? /^@echo off/u : /^#!\/bin\/sh\nexec /u)
  await uninstallInstallation({ stateRoot, purgeData: true }, { runner: fake.runner })
  assert.equal(fake.plugins.has('agent-tool-development-kit@openadam-developer-tools'), false)
})

test('developer profile gives a fresh Claude home an owned Skill launcher without a Developer Kit MCP entry', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-developer-claude-fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifest = await createReleaseFixture(join(root, 'release'), {
    suiteVersion: '0.1.2-developer.1', releaseId: 'fixture-developer-claude-1', marker: 'developer-claude', includeDeveloper: true,
  })
  const stateRoot = join(root, 'private', 'state', 'root')
  const hostSkillHome = join(root, 'fresh-home')
  const fake = createClaudeRunner()
  await setup({
    profile: 'developer', hosts: ['claude'], releaseManifest: manifest, stateRoot,
    noService: true, dryRun: false, enableObservability: false,
  }, releaseDependencies(fake, { hostSkillHome }))
  const state = await loadState(await prepareStatePaths(stateRoot))
  const developerSkill = state.hosts.claude.developerSkill
  assert.equal((await lstat(developerSkill.exposurePath)).isSymbolicLink(), true)
  const version = JSON.parse(runSkillLauncher(developerSkill.launcherPath, developerSkill.versionArguments))
  assert.equal(version.version, '0.1.0')
  assert.deepEqual([...fake.entries.keys()], [])
  await uninstallInstallation({ stateRoot, purgeData: true }, { runner: fake.runner })
  await assert.rejects(lstat(developerSkill.exposurePath), (error) => error.code === 'ENOENT')
})

test('standard release gives ZCode immutable MCP bindings and a packaged operations Skill', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-zcode-release-fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifest = await createReleaseFixture(join(root, 'release'), {
    suiteVersion: '0.1.3-zcode.1', releaseId: 'fixture-zcode-1', marker: 'zcode',
  })
  const stateRoot = join(root, 'private', 'state', 'root')
  const hostSkillHome = join(root, 'fresh-home')
  const zcodeConfigPath = join(hostSkillHome, '.zcode', 'cli', 'config.json')
  const runner = async (_command, args) => {
    if (args[0] === 'version') return { status: 0, stdout: '0.16.5\n', stderr: '' }
    throw new Error(`unexpected fake ZCode command: ${args.join(' ')}`)
  }
  await setup({
    profile: 'standard', hosts: ['zcode'], releaseManifest: manifest, stateRoot,
    noService: true, dryRun: false, enableObservability: false,
  }, releaseDependencies({ runner }, { hostSkillHome, zcodeConfigPath, zcodeExecutable: process.execPath }))
  const state = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(state.hosts.zcode.kind, 'zcode')
  assert.equal(state.hosts.zcode.operationsSkill.kind, 'zcode-skill-link')
  assert.equal((await lstat(state.hosts.zcode.operationsSkill.exposurePath)).isSymbolicLink(), true)
  assert.deepEqual(state.hosts.zcode.productSkills.map((skill) => skill.id).sort(), ['calculate', 'convert-time-zones'])
  const canonicalStateRoot = await realpath(stateRoot)
  assert.equal(state.hosts.zcode.productSkills.every((skill) => skill.projectionRoot.includes(join(canonicalStateRoot, 'host-projections', 'product-skills', 'zcode'))), true)
  assert.equal(state.hosts.zcode.productSkills.every((skill) => !skill.projectionRoot.includes('tools-dev')), true)
  const config = JSON.parse(await readFile(zcodeConfigPath, 'utf8'))
  assert.deepEqual(Object.keys(config.mcp.servers).sort(), ['math-anchor', 'migratory-time'])
  assert.equal(Object.values(config.mcp.servers).every((entry) => entry.command.includes(join(canonicalStateRoot, 'packages'))), true)
  assert.equal(Object.values(config.mcp.servers).every((entry) => !entry.command.includes('tools-dev')), true)
  await uninstallInstallation({ stateRoot, purgeData: true }, { runner })
  assert.deepEqual(JSON.parse(await readFile(zcodeConfigPath, 'utf8')).mcp.servers, {})
  await assert.rejects(lstat(state.hosts.zcode.operationsSkill.exposurePath), (error) => error.code === 'ENOENT')
  for (const skill of state.hosts.zcode.productSkills) await assert.rejects(lstat(skill.exposurePath), (error) => error.code === 'ENOENT')
})

test('an installation from before the warm-up policy migrates every public Agent tool without host activation on failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-warmup-migration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifest = await createReleaseFixture(join(root, 'release'), { suiteVersion: '0.1.0-beta.1', releaseId: 'fixture-beta-1', marker: 'first' })
  const stateRoot = join(root, 'private', 'state', 'root')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathVersion: '0.4.0', mathMarketplace: 'openadam' })
  await setup({ profile: 'standard', hosts: ['codex'], releaseManifest: manifest, stateRoot, noService: true, dryRun: false, enableObservability: false }, releaseDependencies(fake, { hostSkillHome: join(root, 'host-home') }))
  const paths = await prepareStatePaths(stateRoot)
  const legacy = await loadState(paths)
  delete legacy.componentWarmupVersion
  await saveState(paths, legacy)

  const migrated = await updateInstallation({ stateRoot, releaseManifest: manifest, dryRun: false }, releaseDependencies(fake))
  assert.deepEqual(migrated.changed, ['agent-tool-warmup'])
  assert.deepEqual(migrated.componentWarmup.components.map((item) => item.id), ['math-anchor', 'migratory-time'])
  assert.equal((await loadState(paths)).componentWarmupVersion, 1)

  await saveState(paths, { ...await loadState(paths), componentWarmupVersion: undefined })
  const callsBeforeFailure = fake.calls.length
  await assert.rejects(
    updateInstallation({ stateRoot, releaseManifest: manifest, dryRun: false }, releaseDependencies(fake, {
      componentWarmup: async () => { throw new Error('injected warm-up failure') },
    })),
    /injected warm-up failure/u,
  )
  assert.equal(fake.calls.length, callsBeforeFailure)
  assert.equal((await loadState(paths)).componentWarmupVersion, undefined)
})

test('storage cleanup keeps the active release and one complete rollback while removing older packages, downloads, and runtime configs', async (t) => {
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
  await setup({ profile: 'standard', hosts: [], releaseManifest: manifests[0], stateRoot, noService: true, dryRun: false, enableObservability: false }, releaseDependencies(fake, { hostSkillHome: join(root, 'host-home') }))
  await updateInstallation({ stateRoot, releaseManifest: manifests[1], dryRun: false }, releaseDependencies(fake))
  await updateInstallation({ stateRoot, releaseManifest: manifests[2], dryRun: false }, releaseDependencies(fake))
  const paths = await prepareStatePaths(stateRoot)
  const staleDownload = join(paths.downloads, 'stale-release.tar.gz')
  await writeFile(staleDownload, 'stale', { mode: 0o600 })
  await utimes(staleDownload, new Date(0), new Date(0))
  const staleRuntimeConfig = join(paths.runtime, 'provider-config-000000000000000000000000.json')
  await writeFile(staleRuntimeConfig, '{}', { mode: 0o600 })

  const preview = await cleanupStorage({ stateRoot, dryRun: true })
  assert.equal(preview.plan.packageVersions, 4)
  assert.equal(preview.plan.downloads, 1)
  assert.equal(preview.plan.runtimeConfigs, 2)
  assert.equal((await readdir(join(paths.packages, 'math-anchor'))).length, 3)

  await assert.rejects(
    cleanupStorage({ stateRoot }, {
      beforeCleanupCommit: async () => {
        const current = await loadState(paths)
        await saveState(paths, { ...current, updatedAt: '2027-01-01T00:00:00.000Z' })
      },
    }),
    (error) => error.code === 'STORAGE_STATE_CHANGED_DURING_CLEANUP',
  )
  assert.equal((await lstat(staleDownload)).isFile(), true)
  assert.equal((await lstat(staleRuntimeConfig)).isFile(), true)

  const cleaned = await cleanupStorage({ stateRoot })
  assert.equal(cleaned.removed.packageVersions, 4)
  assert.equal(cleaned.removed.downloads, 1)
  assert.equal(cleaned.removed.runtimeConfigs, 2)
  await assert.rejects(access(staleRuntimeConfig), (error) => error.code === 'ENOENT')
  for (const id of ['node-runtime', 'direct-execution-runtime', 'math-anchor', 'migratory-time']) {
    assert.equal((await readdir(join(paths.packages, id))).filter((name) => !name.startsWith('.')).length, 2)
  }
  assert.equal((await rollbackInstallation({ stateRoot, dryRun: true }, releaseDependencies(fake))).targetVersion, '0.1.0-beta.2')
})

test('storage cleanup retains an old immutable package while a live Agent session references it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-live-package-fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifests = []
  for (const [index, marker] of ['first', 'second', 'third'].entries()) {
    manifests.push(await createReleaseFixture(join(root, marker), {
      suiteVersion: `0.1.0-live.${index + 1}`,
      releaseId: `fixture-live-${index + 1}`,
      marker,
    }))
  }
  const stateRoot = join(root, 'private', 'state', 'root')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathVersion: '0.4.0', mathMarketplace: 'openadam' })
  await setup({ profile: 'standard', hosts: [], releaseManifest: manifests[0], stateRoot, noService: true, dryRun: false, enableObservability: false }, releaseDependencies(fake, { hostSkillHome: join(root, 'host-home') }))
  const firstMathRoot = (await loadState(await prepareStatePaths(stateRoot))).components['math-anchor'].root
  await updateInstallation({ stateRoot, releaseManifest: manifests[1], dryRun: false }, releaseDependencies(fake))
  await updateInstallation({ stateRoot, releaseManifest: manifests[2], dryRun: false }, releaseDependencies(fake))

  const liveRunner = async (command, args) => {
    assert.equal(command, process.platform === 'win32' ? 'powershell.exe' : '/bin/ps')
    if (process.platform !== 'win32') assert.deepEqual(args, ['axo', 'pid=,rss=,command='])
    const stdout = process.platform === 'win32' ? JSON.stringify([{ ProcessId: 123, WorkingSetSize: 456 * 1024, CommandLine: `/agent ${firstMathRoot}/bin/provider mcp` }]) : `123 456 /agent ${firstMathRoot}/bin/provider mcp\n`
    return { status: 0, signal: null, stdout, stderr: '', timedOut: false, overflowed: false }
  }
  const preview = await cleanupStorage({ stateRoot, dryRun: true }, { runner: liveRunner })
  assert.equal(preview.plan.packageVersions, 3)
  assert.equal(preview.plan.livePackageVersions, 1)
  const cleaned = await cleanupStorage({ stateRoot }, { runner: liveRunner })
  assert.equal(cleaned.removed.packageVersions, 3)
  assert.equal(cleaned.removed.livePackageVersions, 1)
  assert.equal((await lstat(firstMathRoot)).isDirectory(), true)

  const idleRunner = async () => ({ status: 0, signal: null, stdout: '', stderr: '', timedOut: false, overflowed: false })
  const afterExit = await cleanupStorage({ stateRoot, dryRun: true }, { runner: idleRunner })
  assert.equal(afterExit.plan.packageVersions, 1)
  assert.equal(afterExit.plan.livePackageVersions, 0)
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
  await setup({ profile: 'standard', hosts: [], developmentRoot: workspace, stateRoot, noService: true, dryRun: false, enableObservability: false }, releaseDependencies(fake, { hostSkillHome: join(root, 'host-home') }))
  const paths = await prepareStatePaths(stateRoot)
  const development = await loadState(paths)
  development.profile = 'observability'
  development.components['agent-tool-observer'] = { version: '0.1.0', root: workspace, command: process.execPath, args: [], identityFiles: [], fingerprint: 'development-observer' }
  development.components['context-surface-analyzer'] = { version: '0.1.1', root: workspace, command: process.execPath, args: [], identityFiles: [], fingerprint: 'development-analyzer' }
  development.observability = { enabled: true, observer: { stateDir: join(root, 'observer') }, maintenance: null, latest: null }
  await saveState(paths, development)

  const dryRun = await updateInstallation({ stateRoot, releaseManifest: manifest, dryRun: true, replaceHostConflicts: true }, releaseDependencies(fake))
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
      releaseDependencies(fake, { rebindObservability: async (state) => {
        if (state.channel === 'release') {
          rebound = true
          assert.equal(state.components['agent-tool-observer'].root.startsWith(paths.packages), true)
          assert.equal(state.components['context-surface-analyzer'].root.startsWith(paths.packages), true)
        }
      } }),
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
  await setup({ profile: 'standard', hosts: [], developmentRoot: workspace, stateRoot, noService: true, dryRun: false, enableObservability: false }, releaseDependencies(fake, { hostSkillHome: join(root, 'host-home') }))
  const paths = await prepareStatePaths(stateRoot)
  const development = await loadState(paths)
  development.observability = { enabled: true, observer: { stateDir: join(root, 'observer') }, maintenance: null, latest: null }
  await saveState(paths, development)
  await assert.rejects(
    updateInstallation({ stateRoot, releaseManifest: manifest, dryRun: true }, releaseDependencies(fake)),
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
  await setup({ profile: 'standard', hosts: [], releaseManifest: manifest, stateRoot, noService: true, dryRun: false, enableObservability: false }, releaseDependencies(fake, { hostSkillHome: join(root, 'host-home') }))

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
  await setup({ profile: 'standard', hosts: ['codex'], developmentRoot: workspace, stateRoot, noService: true, dryRun: false, enableObservability: false }, releaseDependencies(fake, { hostSkillHome: join(root, 'host-home') }))
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
      releaseDependencies(fake, {
        runner: fake.runner,
        rebindObservability: async (state) => {
          reboundChannels.push(state.channel)
          if (state.channel === 'release') throw new Error('injected monitoring rebind failure')
        },
      }),
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
  await setup({ profile: 'standard', hosts: ['codex'], developmentRoot: workspace, stateRoot, noService: true, dryRun: false, enableObservability: false }, releaseDependencies(fake, { hostSkillHome: join(root, 'host-home') }))
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
      releaseDependencies(fake, { rebindObservability: async () => { throw new Error('injected persistent rebind failure') } }),
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
