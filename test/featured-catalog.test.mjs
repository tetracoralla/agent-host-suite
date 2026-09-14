import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { doctor } from '../src/doctor.mjs'
import { setActiveTools, toolSetStatus, updateInstallation } from '../src/lifecycle.mjs'
import { defaultToolsForProfile, loadProfile } from '../src/profile.mjs'
import { materializeComponentIdsForUpdate, OBSERVABILITY_RELEASE_COMPONENTS } from '../src/release-manifest.mjs'
import { setup } from '../src/setup.mjs'
import { loadState, prepareStatePaths } from '../src/state.mjs'
import { createIsolatedCli, runIsolatedCli } from './cli-isolation.mjs'
import { compatibleApplicationState, createCodexRunner, createDevelopmentWorkspace, healthyCatalogPreflight } from './helpers.mjs'
import { createReleaseFixture } from './release-helpers.mjs'

const supportedReleasePlatform = ['darwin', 'win32'].includes(process.platform)

async function healthyComponentWarmup({ manifest, componentIds }) {
  return {
    status: 'ok', strategy: 'sequential-first-and-repeat',
    components: componentIds.map((id) => ({ id, version: manifest.components[id].version })),
  }
}

function releaseDependencies(fake, values = {}) {
  return {
    runner: fake.runner, codexConfiguration: fake.configuration,
    componentWarmup: healthyComponentWarmup,
    catalogPreflight: healthyCatalogPreflight,
    applicationStatePreflight: compatibleApplicationState,
    ...values,
  }
}

test('featured setup fails closed against the tracked unbound catalog', async (t) => {
  const isolated = await createIsolatedCli(t)
  await assert.rejects(
    setup({
      profile: 'featured', hosts: [], noService: true, dryRun: true, enableObservability: false,
      stateRoot: isolated.stateRoot,
    }),
    (error) => error.code === 'RELEASE_UNBOUND',
  )
  const cli = runIsolatedCli(['setup', '--profile', 'featured', '--no-service', '--dry-run', '--json'], isolated)
  assert.equal(cli.status, 1)
  assert.equal(JSON.parse(cli.stderr).error.code, 'RELEASE_UNBOUND')
  const unknownProfile = runIsolatedCli(['tools', 'set', '--profile', 'not-a-catalog', '--json'], isolated)
  assert.equal(unknownProfile.status, 1)
  assert.equal(JSON.parse(unknownProfile.stderr).error.code, 'PROFILE_UNKNOWN')
})

test('featured setup cannot use a development root as a substitute for a bound catalog', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-featured-development-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-featured-development-state-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stateRoot, { recursive: true, force: true })]))
  await createDevelopmentWorkspace(root)
  await assert.rejects(
    setup({
      profile: 'featured', hosts: [], developmentRoot: root, stateRoot,
      noService: true, dryRun: true, enableObservability: false,
    }),
    (error) => error.code === 'FEATURED_PROFILE_RELEASE_REQUIRED',
  )
  const isolated = await createIsolatedCli(t)
  const cli = runIsolatedCli([
    'setup', '--profile', 'featured', '--development-root', root,
    '--no-service', '--dry-run', '--json',
  ], isolated)
  assert.equal(cli.status, 1)
  assert.equal(JSON.parse(cli.stderr).error.code, 'FEATURED_PROFILE_RELEASE_REQUIRED')
})

test('featured cannot be selected by updating a development install without a bound catalog', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-featured-update-development-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-featured-update-development-state-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stateRoot, { recursive: true, force: true })]))
  await createDevelopmentWorkspace(root)
  const fake = createCodexRunner({ mathPresent: false, timePresent: false })
  await setup({
    profile: 'standard', hosts: ['codex'], developmentRoot: root, stateRoot,
    noService: true, dryRun: false, enableObservability: false,
  }, releaseDependencies(fake, { hostSkillHome: join(stateRoot, 'host-home') }))
  await assert.rejects(
    updateInstallation({ profile: 'featured', stateRoot, dryRun: true }, releaseDependencies(fake)),
    (error) => error.code === 'FEATURED_PROFILE_RELEASE_REQUIRED',
  )
})

test('featured setup fails closed when the bound release omits Armorial', { skip: !supportedReleasePlatform }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-featured-missing-armorial-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifest = await createReleaseFixture(join(root, 'release'), {
    suiteVersion: '0.1.0-beta.1', releaseId: 'fixture-featured-missing', marker: 'standard-only',
  })
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathVersion: '0.4.0', mathMarketplace: 'openadam' })
  await assert.rejects(
    setup({
      profile: 'featured', hosts: [], releaseManifest: manifest,
      stateRoot: join(root, 'private', 'state'),
      noService: true, dryRun: true, enableObservability: false,
    }, releaseDependencies(fake)),
    (error) => error.code === 'PROFILE_COMPONENTS_MISSING',
  )
})

test('a bound featured profile is selectable through setup, profiles list, and tools set', { skip: !supportedReleasePlatform }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-featured-bound-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifest = await createReleaseFixture(join(root, 'release'), {
    suiteVersion: '0.1.0-beta.1', releaseId: 'fixture-featured-1', marker: 'featured', includeArmorial: true,
  })
  const stateRoot = join(root, 'private', 'state', 'root')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathVersion: '0.4.0', mathMarketplace: 'openadam' })
  const installed = await setup({
    profile: 'featured', hosts: ['codex'], releaseManifest: manifest, stateRoot,
    noService: true, dryRun: false, enableObservability: false,
  }, releaseDependencies(fake, { hostSkillHome: join(root, 'host-home') }))
  assert.equal(installed.status, 'installed')
  const state = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(state.profile, 'featured')
  assert.equal(state.components.armorial.displayName, 'Armorial')
  assert.deepEqual(state.availableAgentComponents, ['math-anchor', 'migratory-time', 'armorial'])
  assert.deepEqual(state.agentComponents, ['math-anchor', 'migratory-time', 'armorial'])

  const isolated = await createIsolatedCli(t)
  const listed = runIsolatedCli(['profiles', 'list', '--json'], isolated)
  assert.equal(listed.status, 0, listed.stderr)
  assert.equal(JSON.parse(listed.stdout).profiles.find((profile) => profile.id === 'featured').agentComponents.includes('armorial'), true)

  const narrowed = await setActiveTools({ stateRoot, tools: ['math-anchor', 'armorial'] }, releaseDependencies(fake))
  assert.deepEqual(narrowed.activeAgentComponents, ['math-anchor', 'armorial'])
  const restored = await setActiveTools(
    { stateRoot, tools: await defaultToolsForProfile('featured') },
    releaseDependencies(fake),
  )
  assert.deepEqual(restored.activeAgentComponents, ['math-anchor', 'migratory-time', 'armorial'])
  assert.deepEqual((await toolSetStatus({ stateRoot })).activeAgentComponents, ['math-anchor', 'migratory-time', 'armorial'])
  const missingState = runIsolatedCli(
    ['tools', 'set', '--profile', 'featured', '--json'],
    { ...isolated, stateRoot: isolated.unusedStateRoot },
  )
  assert.equal(missingState.status, 1)
  assert.equal(JSON.parse(missingState.stderr).error.code, 'NOT_INSTALLED')

  const report = await doctor(state, { deep: false, inspectAgentApps: false, runner: fake.runner })
  const membership = report.checks.find((item) => item.id === 'profile.catalog')
  assert.equal(membership?.status, 'ok')
  assert.equal(membership.detail.profile, 'featured')
  assert.deepEqual(membership.detail.defaultAgentComponents, ['math-anchor', 'migratory-time', 'armorial'])
})

test('featured materialization merges consented monitoring without making it a featured tool', async () => {
  const featured = await loadProfile('featured')
  assert.equal(featured.components.includes('armorial'), true)
  assert.equal(featured.components.includes('agent-tool-observer'), false)
  assert.deepEqual(
    materializeComponentIdsForUpdate(featured.components, { preserveObservability: false }),
    featured.components,
  )
  const merged = materializeComponentIdsForUpdate(featured.components, { preserveObservability: true })
  assert.equal(merged.includes('armorial'), true)
  for (const id of OBSERVABILITY_RELEASE_COMPONENTS) assert.equal(merged.includes(id), true)
  assert.equal(featured.agentComponents.includes('agent-tool-observer'), false)
})

function monitoringActivation(root) {
  return async (candidate) => ({
    ...candidate,
    observability: {
      enabled: true,
      consentedAt: '2026-09-14T00:00:00.000Z',
      observer: { stateDir: join(root, 'observer') },
      maintenance: null,
      latest: null,
    },
  })
}

test('update to featured keeps consented monitoring when the bound release includes it', { skip: !supportedReleasePlatform }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-featured-observability-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifest = await createReleaseFixture(join(root, 'release'), {
    suiteVersion: '0.1.0-beta.1',
    releaseId: 'fixture-featured-observability',
    marker: 'featured-observability',
    includeArmorial: true,
    includeObservability: true,
  })
  const stateRoot = join(root, 'private', 'state', 'root')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathVersion: '0.4.0', mathMarketplace: 'openadam' })
  const installed = await setup({
    profile: 'observability',
    hosts: [],
    releaseManifest: manifest,
    stateRoot,
    noService: true,
    dryRun: false,
    enableObservability: true,
  }, releaseDependencies(fake, {
    hostSkillHome: join(root, 'host-home'),
    activateObservability: monitoringActivation(root),
  }))
  assert.equal(installed.status, 'installed')
  const before = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(before.profile, 'observability')
  assert.equal(before.observability.enabled, true)
  assert.equal(before.components['agent-tool-observer'] !== undefined, true)
  assert.equal(before.components.armorial, undefined)

  const updated = await updateInstallation({
    profile: 'featured',
    stateRoot,
    releaseManifest: manifest,
    dryRun: false,
  }, releaseDependencies(fake, { rebindObservability: async () => {} }))
  assert.equal(updated.status, 'updated')
  const after = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(after.profile, 'featured')
  assert.equal(after.observability.enabled, true)
  assert.equal(after.components.armorial.displayName, 'Armorial')
  assert.equal(after.components['agent-tool-observer'] !== undefined, true)
  assert.equal(after.components['context-surface-analyzer'] !== undefined, true)
  assert.deepEqual(after.agentComponents, ['math-anchor', 'migratory-time', 'armorial'])
})

test('update to featured fails closed when a bound release omits monitoring components', { skip: !supportedReleasePlatform }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-featured-observability-missing-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const withMonitoring = await createReleaseFixture(join(root, 'release-with-monitoring'), {
    suiteVersion: '0.1.0-beta.1',
    releaseId: 'fixture-featured-observability-present',
    marker: 'featured-observability-present',
    includeArmorial: true,
    includeObservability: true,
  })
  const withoutMonitoring = await createReleaseFixture(join(root, 'release-without-monitoring'), {
    suiteVersion: '0.1.0-beta.2',
    releaseId: 'fixture-featured-observability-missing',
    marker: 'featured-observability-missing',
    includeArmorial: true,
  })
  const stateRoot = join(root, 'private', 'state', 'root')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathVersion: '0.4.0', mathMarketplace: 'openadam' })
  await setup({
    profile: 'observability',
    hosts: [],
    releaseManifest: withMonitoring,
    stateRoot,
    noService: true,
    dryRun: false,
    enableObservability: true,
  }, releaseDependencies(fake, {
    hostSkillHome: join(root, 'host-home'),
    activateObservability: monitoringActivation(root),
  }))
  const before = await loadState(await prepareStatePaths(stateRoot))
  await assert.rejects(
    updateInstallation({
      profile: 'featured',
      stateRoot,
      releaseManifest: withoutMonitoring,
      dryRun: true,
    }, releaseDependencies(fake)),
    (error) => error.code === 'OBSERVABILITY_RELEASE_COMPONENTS_MISSING'
      && error.details.components.includes('agent-tool-observer')
      && error.details.components.includes('context-surface-analyzer'),
  )
  const after = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(after.profile, 'observability')
  assert.equal(after.observability.enabled, true)
  assert.equal(after.releaseId, before.releaseId)
  assert.equal(after.components.armorial, undefined)
  assert.equal(after.components['agent-tool-observer'] !== undefined, true)
})

test('doctor reports missing featured Agent tools', async () => {
  const report = await doctor({
    profile: 'featured',
    channel: 'development',
    components: {
      'math-anchor': { version: '0.4.0', identityFiles: [] },
      'migratory-time': { version: '2.0.0', identityFiles: [] },
    },
    agentComponents: ['math-anchor', 'migratory-time'],
    hosts: {},
    runtime: { service: null },
  }, {
    deep: false,
    inspectAgentApps: false,
    runner: async () => ({ status: 0, stdout: '', stderr: '' }),
  })
  const membership = report.checks.find((item) => item.id === 'profile.catalog')
  assert.equal(membership.status, 'error')
  assert.deepEqual(membership.detail.missing, ['armorial'])
  assert.deepEqual(membership.detail.defaultAgentComponents, ['math-anchor', 'migratory-time', 'armorial'])
})
