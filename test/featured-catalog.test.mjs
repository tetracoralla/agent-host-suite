import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { doctor } from '../src/doctor.mjs'
import { setActiveTools, toolSetStatus } from '../src/lifecycle.mjs'
import { defaultToolsForProfile } from '../src/profile.mjs'
import { setup } from '../src/setup.mjs'
import { loadState, prepareStatePaths } from '../src/state.mjs'
import { compatibleApplicationState, createCodexRunner, createDevelopmentWorkspace, healthyCatalogPreflight } from './helpers.mjs'
import { createReleaseFixture } from './release-helpers.mjs'

const cliPath = fileURLToPath(new URL('../bin/agent-host.mjs', import.meta.url))
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

test('featured setup fails closed against the tracked unbound catalog', async () => {
  await assert.rejects(
    setup({ profile: 'featured', hosts: [], noService: true, dryRun: true, enableObservability: false }),
    (error) => error.code === 'RELEASE_UNBOUND',
  )
  const cli = spawnSync(process.execPath, [cliPath, 'setup', '--profile', 'featured', '--no-service', '--dry-run', '--json'], { encoding: 'utf8' })
  assert.equal(cli.status, 1)
  assert.equal(JSON.parse(cli.stderr).error.code, 'RELEASE_UNBOUND')
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
    (error) => error.code === 'PROFILE_COMPONENTS_MISSING' && error.details?.components?.includes('armorial'),
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

  const listed = spawnSync(process.execPath, [cliPath, 'profiles', 'list', '--json'], { encoding: 'utf8' })
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
  const missingState = spawnSync(process.execPath, [cliPath, 'tools', 'set', '--profile', 'featured', '--json'], { encoding: 'utf8' })
  assert.equal(missingState.status, 1)
  assert.equal(JSON.parse(missingState.stderr).error.code, 'NOT_INSTALLED')

  const report = await doctor(state, { deep: false, inspectAgentApps: false, runner: fake.runner })
  const membership = report.checks.find((item) => item.id === 'profile.catalog')
  assert.equal(membership?.status, 'ok')
  assert.equal(membership.detail.profile, 'featured')
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
})
