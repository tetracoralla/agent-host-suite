import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { describeComponentChanges, repairInstallation, updateInstallation } from '../src/lifecycle.mjs'
import { setup } from '../src/setup.mjs'
import { loadState, prepareStatePaths } from '../src/state.mjs'
import { compatibleApplicationState, createCodexRunner, healthyCatalogPreflight } from './helpers.mjs'
import { createReleaseFixture } from './release-helpers.mjs'

const supportedReleasePlatform = ['darwin', 'win32'].includes(process.platform)

test('component diffs treat an older observer at the same suite version as a downgrade', () => {
  const changes = describeComponentChanges(
    { 'agent-tool-observer': { version: '0.6.4', fingerprint: 'newer' }, laniakea: { version: '0.3.7', fingerprint: 'newer-laniakea' } },
    { 'agent-tool-observer': { version: '0.6.0', fingerprint: 'bundled' }, laniakea: { version: '0.3.1', fingerprint: 'bundled-laniakea' } },
  )
  assert.deepEqual(changes, [
    { id: 'agent-tool-observer', action: 'downgrade', currentVersion: '0.6.4', targetVersion: '0.6.0' },
    { id: 'laniakea', action: 'downgrade', currentVersion: '0.3.7', targetVersion: '0.3.1' },
  ])
  const unchanged = describeComponentChanges(
    { 'agent-tool-observer': { version: '0.6.4', fingerprint: 'same' } },
    { 'agent-tool-observer': { version: '0.6.4', fingerprint: 'same' } },
  )
  assert.deepEqual(unchanged, [])
  const upgrade = describeComponentChanges(
    { 'agent-tool-observer': { version: '0.6.0', fingerprint: 'old' } },
    { 'agent-tool-observer': { version: '0.6.4', fingerprint: 'new' } },
  )
  assert.equal(upgrade[0].action, 'upgrade')
})

async function healthyComponentWarmup({ manifest, componentIds }) {
  return {
    status: 'ok', strategy: 'sequential-first-and-repeat',
    components: componentIds.map((id) => ({ id, version: manifest.components[id].version })),
  }
}

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

function releaseDependencies(fake, values = {}) {
  return {
    runner: fake.runner, codexConfiguration: fake.configuration,
    componentWarmup: healthyComponentWarmup,
    catalogPreflight: healthyCatalogPreflight,
    applicationStatePreflight: compatibleApplicationState,
    ...values,
  }
}

test('same suite version still refuses a silent component downgrade', { skip: !supportedReleasePlatform }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-component-downgrade-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const currentManifest = await createReleaseFixture(join(root, 'current'), {
    suiteVersion: '0.2.0',
    releaseId: 'fixture-observer-current',
    marker: 'observer-current',
    includeObservability: true,
    componentVersions: { 'agent-tool-observer': '0.6.4' },
  })
  const bundledManifest = await createReleaseFixture(join(root, 'bundled'), {
    suiteVersion: '0.2.0',
    releaseId: 'fixture-observer-bundled',
    marker: 'observer-bundled',
    includeObservability: true,
    componentVersions: { 'agent-tool-observer': '0.6.0' },
  })
  const stateRoot = join(root, 'private', 'state', 'root')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathVersion: '0.4.0', mathMarketplace: 'openadam' })
  await setup({
    profile: 'observability',
    hosts: [],
    releaseManifest: currentManifest,
    stateRoot,
    noService: true,
    dryRun: false,
    enableObservability: true,
  }, releaseDependencies(fake, {
    hostSkillHome: join(root, 'host-home'),
    activateObservability: monitoringActivation(root),
  }))
  const before = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(before.suiteVersion, '0.2.0')
  assert.equal(before.components['agent-tool-observer'].version, '0.6.4')

  await assert.rejects(
    updateInstallation({ stateRoot, releaseManifest: bundledManifest, dryRun: true }, releaseDependencies(fake)),
    (error) => error.code === 'COMPONENT_DOWNGRADE_UNSUPPORTED'
      && error.details.components.some((item) => item.id === 'agent-tool-observer'
        && item.currentVersion === '0.6.4'
        && item.requestedVersion === '0.6.0'),
  )
  await assert.rejects(
    updateInstallation({ stateRoot, releaseManifest: bundledManifest, dryRun: false }, releaseDependencies(fake)),
    (error) => error.code === 'COMPONENT_DOWNGRADE_UNSUPPORTED',
  )
  const after = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(after.components['agent-tool-observer'].version, '0.6.4')
  assert.equal(after.releaseId, before.releaseId)
})

test('repair restores connections without proposing unrelated tool downgrades', { skip: !supportedReleasePlatform }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-repair-no-downgrade-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifest = await createReleaseFixture(join(root, 'release'), {
    suiteVersion: '0.2.0',
    releaseId: 'fixture-repair-current',
    marker: 'repair-current',
    includeObservability: true,
    componentVersions: { 'agent-tool-observer': '0.6.4' },
  })
  const stateRoot = join(root, 'private', 'state', 'root')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathVersion: '0.4.0', mathMarketplace: 'openadam' })
  await setup({
    profile: 'observability',
    hosts: ['codex'],
    releaseManifest: manifest,
    stateRoot,
    noService: true,
    dryRun: false,
    enableObservability: true,
  }, releaseDependencies(fake, {
    hostSkillHome: join(root, 'host-home'),
    activateObservability: monitoringActivation(root),
  }))
  const before = await loadState(await prepareStatePaths(stateRoot))
  const preview = await repairInstallation({ stateRoot, dryRun: true }, releaseDependencies(fake, {
    hostSkillHome: join(root, 'host-home'),
  }))
  assert.equal(preview.kind, 'repair')
  assert.deepEqual(preview.changed, [])
  assert.deepEqual(preview.componentChanges, [])
  assert.equal(preview.suiteVersion, '0.2.0')
  assert.equal(preview.repairs.monitoring, true)
  assert.deepEqual(preview.repairs.hosts, ['codex'])
  assert.match(preview.planId, /^sha256:[0-9a-f]{64}$/u)

  const repaired = await repairInstallation({ stateRoot, dryRun: false, planId: preview.planId }, releaseDependencies(fake, {
    hostSkillHome: join(root, 'host-home'),
    rebindObservability: async () => {},
  }))
  assert.equal(repaired.status, 'repaired')
  assert.deepEqual(repaired.changed, [])
  const after = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(after.components['agent-tool-observer'].version, before.components['agent-tool-observer'].version)
  assert.equal(after.components['agent-tool-observer'].fingerprint, before.components['agent-tool-observer'].fingerprint)
  assert.equal(after.suiteVersion, before.suiteVersion)
  assert.equal(after.releaseId, before.releaseId)
})

test('update preview names source and version diffs and bind apply to the reviewed plan', { skip: !supportedReleasePlatform }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-update-plan-bind-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const firstManifest = await createReleaseFixture(join(root, 'first'), {
    suiteVersion: '0.2.0',
    releaseId: 'fixture-plan-first',
    marker: 'plan-first',
    includeObservability: true,
    componentVersions: { 'agent-tool-observer': '0.6.0' },
  })
  const secondManifest = await createReleaseFixture(join(root, 'second'), {
    suiteVersion: '0.2.0',
    releaseId: 'fixture-plan-second',
    marker: 'plan-second',
    includeObservability: true,
    componentVersions: { 'agent-tool-observer': '0.6.4' },
  })
  const thirdManifest = await createReleaseFixture(join(root, 'third'), {
    suiteVersion: '0.2.0',
    releaseId: 'fixture-plan-third',
    marker: 'plan-third',
    includeObservability: true,
    componentVersions: { 'agent-tool-observer': '0.6.5' },
  })
  const stateRoot = join(root, 'private', 'state', 'root')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathVersion: '0.4.0', mathMarketplace: 'openadam' })
  const hostSkillHome = join(root, 'host-home')
  await setup({
    profile: 'observability',
    hosts: [],
    releaseManifest: firstManifest,
    stateRoot,
    noService: true,
    dryRun: false,
    enableObservability: true,
  }, releaseDependencies(fake, {
    hostSkillHome,
    activateObservability: monitoringActivation(root),
  }))

  const preview = await updateInstallation(
    { stateRoot, releaseManifest: secondManifest, dryRun: true },
    releaseDependencies(fake, { hostSkillHome }),
  )
  assert.equal(preview.kind, 'update')
  assert.equal(preview.source.kind, 'release-manifest')
  assert.equal(preview.fromVersion, '0.2.0')
  assert.equal(preview.toVersion, '0.2.0')
  const observer = preview.componentChanges.find((item) => item.id === 'agent-tool-observer')
  assert.equal(observer.currentVersion, '0.6.0')
  assert.equal(observer.targetVersion, '0.6.4')
  assert.equal(observer.action, 'upgrade')
  assert.match(preview.planId, /^sha256:[0-9a-f]{64}$/u)

  await assert.rejects(
    updateInstallation(
      { stateRoot, releaseManifest: thirdManifest, dryRun: false, planId: preview.planId },
      releaseDependencies(fake, { hostSkillHome }),
    ),
    (error) => error.code === 'UPDATE_PLAN_STALE'
      && error.details.reviewedPlanId === preview.planId
      && error.details.currentPlanId !== preview.planId,
  )
  const unchanged = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(unchanged.components['agent-tool-observer'].version, '0.6.0')

  const updated = await updateInstallation(
    { stateRoot, releaseManifest: secondManifest, dryRun: false, planId: preview.planId },
    releaseDependencies(fake, { hostSkillHome, rebindObservability: async () => {} }),
  )
  assert.equal(updated.status, 'updated')
  const after = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(after.components['agent-tool-observer'].version, '0.6.4')
})

test('repair apply refuses a stale reviewed plan', { skip: !supportedReleasePlatform }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-repair-plan-stale-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const firstManifest = await createReleaseFixture(join(root, 'first'), {
    suiteVersion: '0.2.0',
    releaseId: 'fixture-repair-plan-first',
    marker: 'repair-plan-first',
    includeObservability: true,
    componentVersions: { 'agent-tool-observer': '0.6.0' },
  })
  const secondManifest = await createReleaseFixture(join(root, 'second'), {
    suiteVersion: '0.2.0',
    releaseId: 'fixture-repair-plan-second',
    marker: 'repair-plan-second',
    includeObservability: true,
    componentVersions: { 'agent-tool-observer': '0.6.4' },
  })
  const stateRoot = join(root, 'private', 'state', 'root')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathVersion: '0.4.0', mathMarketplace: 'openadam' })
  const hostSkillHome = join(root, 'host-home')
  await setup({
    profile: 'observability',
    hosts: [],
    releaseManifest: firstManifest,
    stateRoot,
    noService: true,
    dryRun: false,
    enableObservability: true,
  }, releaseDependencies(fake, {
    hostSkillHome,
    activateObservability: monitoringActivation(root),
  }))
  const preview = await repairInstallation({ stateRoot, dryRun: true }, releaseDependencies(fake, { hostSkillHome }))
  await updateInstallation(
    { stateRoot, releaseManifest: secondManifest, dryRun: false },
    releaseDependencies(fake, { hostSkillHome, rebindObservability: async () => {} }),
  )
  await assert.rejects(
    repairInstallation({ stateRoot, dryRun: false, planId: preview.planId }, releaseDependencies(fake, { hostSkillHome })),
    (error) => error.code === 'REPAIR_PLAN_STALE',
  )
})
