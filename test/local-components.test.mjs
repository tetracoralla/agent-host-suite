import assert from 'node:assert/strict'
import { chmod, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { importLocalComponent, localComponentStatus, previewLocalComponent, removeLocalComponent, rollbackLocalComponent } from '../src/local-components.mjs'
import { rollbackInstallation, updateInstallation } from '../src/lifecycle.mjs'
import { cleanupStorage } from '../src/storage.mjs'
import { setup } from '../src/setup.mjs'
import { listHistory, loadState, prepareStatePaths, saveState } from '../src/state.mjs'
import { createCodexRunner } from './helpers.mjs'
import { createReleaseFixture, createToolComponentFixture } from './release-helpers.mjs'

function healthyProbe(component) {
  const result = { status: 'ok', tools: component.expectedTools, expectedTools: component.expectedTools, server: { name: 'Private Fixture', version: component.version } }
  return { first: result, repeat: result, firstLaunchMs: 1, repeatLaunchMs: 1, firstLaunchTimeoutMs: 60000, repeatTimeoutMs: component.healthTimeoutMs }
}

async function environment(root) {
  const manifest = await createReleaseFixture(join(root, 'release'), {
    suiteVersion: '0.1.1-private-test',
    releaseId: 'private-component-test',
    marker: 'base',
  })
  const stateRoot = join(root, 'state')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathMarketplace: 'openadam', mathVersion: '0.4.0' })
  const hostSkillHome = join(root, 'host-home')
  await setup({
    profile: 'standard', hosts: ['codex'], releaseManifest: manifest, stateRoot,
    noService: true, dryRun: false, enableObservability: false,
  }, { runner: fake.runner, hostSkillHome })
  return { stateRoot, fake, hostSkillHome }
}

test('private component preview validates sealed bytes and MCP catalog without mutating installed state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-private-preview-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot } = await environment(root)
  const fixture = await createToolComponentFixture(join(root, 'tool'))
  const before = await loadState(await prepareStatePaths(stateRoot))

  const preview = await previewLocalComponent({
    stateRoot,
    artifact: fixture.artifactPath,
    licenseSpdx: 'Apache-2.0',
  }, { mcpProbe: healthyProbe })

  assert.deepEqual(preview.binding, fixture.binding)
  assert.equal(preview.component.kind, 'agent-tool')
  assert.deepEqual(preview.component.expectedTools, ['private_fixture.run'])
  assert.equal(preview.health.first.status, 'ok')
  const after = await loadState(await prepareStatePaths(stateRoot))
  assert.deepEqual(after, before)
  assert.equal(after.components['private-fixture'], undefined)
})

test('private component import locks preview facts, activates through Codex projection, and supports remove and rollback', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-private-lifecycle-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const fixture = await createToolComponentFixture(join(root, 'tool'))
  const dependencies = { runner: fake.runner, hostSkillHome, mcpProbe: healthyProbe }

  await assert.rejects(
    importLocalComponent({ stateRoot, artifact: fixture.artifactPath, binding: { ...fixture.binding, archiveBytes: fixture.binding.archiveBytes + 1 }, activate: true }, dependencies),
    (error) => error.code === 'LOCAL_COMPONENT_BINDING_MISMATCH',
  )

  const imported = await importLocalComponent({
    stateRoot, artifact: fixture.artifactPath, binding: fixture.binding,
    activate: true, replace: false, replaceHostConflicts: false, dryRun: false,
  }, dependencies)
  assert.equal(imported.status, 'imported')
  assert.equal(imported.component.active, true)
  assert.equal(fake.plugins.has('private-fixture@private-fixture-local'), true)
  assert.equal(fake.marketplaces.get('private-fixture-local').includes(join(stateRoot, 'host-projections', 'codex')), true)
  const listed = await localComponentStatus({ stateRoot })
  assert.deepEqual(listed.components.map((item) => [item.id, item.active]), [['private-fixture', true]])

  const removed = await removeLocalComponent({ stateRoot, target: 'private-fixture', dryRun: false }, dependencies)
  assert.equal(removed.status, 'removed')
  assert.equal(removed.component.installed, false)
  assert.equal(fake.plugins.has('private-fixture@private-fixture-local'), false)
  const removedState = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(removedState.components['private-fixture'], undefined)
  assert.equal(removedState.privateComponents['private-fixture'].rollback.component.root.includes(join(stateRoot, 'packages')), true)

  const restored = await rollbackLocalComponent({ stateRoot, target: 'private-fixture', dryRun: false }, dependencies)
  assert.equal(restored.status, 'rolled-back')
  assert.equal(restored.component.version, '0.1.0')
  assert.equal(restored.component.active, true)
  assert.equal(fake.plugins.has('private-fixture@private-fixture-local'), true)
})

test('private component rollback preserves removal as the immediate previous state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-private-removal-rollback-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const first = await createToolComponentFixture(join(root, 'first'), { version: '0.1.0', marker: 'first' })
  const second = await createToolComponentFixture(join(root, 'second'), { version: '0.2.0', marker: 'second' })
  const dependencies = { runner: fake.runner, hostSkillHome, mcpProbe: healthyProbe }
  await importLocalComponent({ stateRoot, artifact: first.artifactPath, binding: first.binding, activate: true, dryRun: false }, dependencies)
  await removeLocalComponent({ stateRoot, target: 'private-fixture', dryRun: false }, dependencies)

  const imported = await importLocalComponent({ stateRoot, artifact: second.artifactPath, binding: second.binding, activate: false, dryRun: false }, dependencies)
  assert.deepEqual(imported.component.rollback, { installed: false, version: null, archiveSha256: null, active: false })
  const removed = await rollbackLocalComponent({ stateRoot, target: 'private-fixture', dryRun: false }, dependencies)
  assert.equal(removed.component.installed, false)
  assert.equal(removed.component.rollback.version, '0.2.0')
  assert.equal(fake.plugins.has('private-fixture@private-fixture-local'), false)

  const restored = await rollbackLocalComponent({ stateRoot, target: 'private-fixture', dryRun: false }, dependencies)
  assert.equal(restored.component.version, '0.2.0')
  assert.equal(restored.component.active, false)
})

test('private component import is inactive by default and refuses component ids owned by the compatibility release', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-private-collision-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const privateFixture = await createToolComponentFixture(join(root, 'private'))
  const dependencies = { runner: fake.runner, hostSkillHome, mcpProbe: healthyProbe }
  const imported = await importLocalComponent({
    stateRoot, artifact: privateFixture.artifactPath, binding: privateFixture.binding,
    activate: false, replace: false, dryRun: false,
  }, dependencies)
  assert.equal(imported.component.active, false)
  assert.equal(fake.plugins.has('private-fixture@private-fixture-local'), false)

  const paths = await prepareStatePaths(stateRoot)
  const state = await loadState(paths)
  state.components['reserved-tool'] = { ...state.components['math-anchor'], displayName: 'Release-owned fixture' }
  await saveState(paths, state)
  const reserved = await createToolComponentFixture(join(root, 'reserved'), { id: 'reserved-tool' })
  await assert.rejects(
    importLocalComponent({ stateRoot, artifact: reserved.artifactPath, binding: reserved.binding, activate: false }, dependencies),
    (error) => error.code === 'LOCAL_COMPONENT_ID_RESERVED',
  )
})

test('a compatibility update preserves the private component overlay without adding it to the release profile', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-private-update-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const fixture = await createToolComponentFixture(join(root, 'private'))
  const dependencies = { runner: fake.runner, hostSkillHome, mcpProbe: healthyProbe }
  await importLocalComponent({
    stateRoot, artifact: fixture.artifactPath, binding: fixture.binding,
    activate: false, replace: false, dryRun: false,
  }, dependencies)
  const nextRelease = await createReleaseFixture(join(root, 'next-release'), {
    suiteVersion: '0.1.1-private-test.2',
    releaseId: 'private-component-test-2',
    marker: 'next',
  })

  await updateInstallation({ stateRoot, releaseManifest: nextRelease, dryRun: false }, dependencies)
  const paths = await prepareStatePaths(stateRoot)
  const state = await loadState(paths)
  assert.equal(state.profile, 'standard')
  assert.equal(state.availableAgentComponents.includes('private-fixture'), true)
  assert.equal(state.agentComponents.includes('private-fixture'), false)
  assert.equal(state.privateComponents['private-fixture'].current.binding.archiveSha256, fixture.binding.archiveSha256)
  assert.equal(state.components['private-fixture'].root.startsWith(paths.packages), true)
})

test('private component replacement retains exactly one prior sealed version for rollback', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-private-replace-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const first = await createToolComponentFixture(join(root, 'first'), { version: '0.1.0', marker: 'first' })
  const second = await createToolComponentFixture(join(root, 'second'), { version: '0.2.0', marker: 'second' })
  const dependencies = { runner: fake.runner, hostSkillHome, mcpProbe: healthyProbe }
  await importLocalComponent({ stateRoot, artifact: first.artifactPath, binding: first.binding, activate: true, dryRun: false }, dependencies)

  const replaced = await importLocalComponent({
    stateRoot, artifact: second.artifactPath, binding: second.binding,
    activate: false, replace: true, dryRun: false,
  }, dependencies)
  assert.equal(replaced.component.version, '0.2.0')
  assert.equal(replaced.component.active, true)
  assert.equal(replaced.component.rollback.version, '0.1.0')

  const restored = await rollbackLocalComponent({ stateRoot, target: 'private-fixture', dryRun: false }, dependencies)
  assert.equal(restored.component.version, '0.1.0')
  assert.equal(restored.component.rollback.version, '0.2.0')
  const state = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(state.components['private-fixture'].version, '0.1.0')
  assert.equal(fake.plugins.get('private-fixture@private-fixture-local').version, '0.1.0')
})

test('private component transitions never enter compatibility-release rollback history', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-private-history-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const fixture = await createToolComponentFixture(join(root, 'private'))
  const dependencies = { runner: fake.runner, hostSkillHome, mcpProbe: healthyProbe }
  const paths = await prepareStatePaths(stateRoot)
  const before = await listHistory(paths)

  await importLocalComponent({
    stateRoot, artifact: fixture.artifactPath, binding: fixture.binding,
    activate: false, dryRun: false,
  }, dependencies)
  assert.deepEqual(await listHistory(paths), before)

  await removeLocalComponent({ stateRoot, target: 'private-fixture', dryRun: false }, dependencies)
  assert.deepEqual(await listHistory(paths), before)

  await rollbackLocalComponent({ stateRoot, target: 'private-fixture', dryRun: false }, dependencies)
  assert.deepEqual(await listHistory(paths), before)
  await assert.rejects(
    rollbackInstallation({ stateRoot, dryRun: true }, dependencies),
    (error) => error.code === 'ROLLBACK_UNAVAILABLE',
  )
})

test('private component import dry-run removes every package path it created', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-private-dry-run-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const fixture = await createToolComponentFixture(join(root, 'private'))
  const dependencies = { runner: fake.runner, hostSkillHome, mcpProbe: healthyProbe }
  const paths = await prepareStatePaths(stateRoot)
  const before = await loadState(paths)

  const preview = await importLocalComponent({
    stateRoot, artifact: fixture.artifactPath, binding: fixture.binding,
    activate: false, dryRun: true,
  }, dependencies)
  assert.equal(preview.status, 'ready')
  assert.equal(preview.component.installed, false)
  assert.equal(preview.component.active, false)
  assert.equal(preview.component.importedAt, null)
  assert.equal(preview.component.rollback, null)
  assert.deepEqual(await loadState(paths), before)
  await assert.rejects(stat(join(paths.packages, 'private-fixture')), (error) => error.code === 'ENOENT')
})

test('a failed post-commit activity append returns stable warnings and preserves authoritative component state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-private-activity-failure-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const fixture = await createToolComponentFixture(join(root, 'private'))
  const dependencies = {
    runner: fake.runner,
    hostSkillHome,
    mcpProbe: healthyProbe,
    recordActivity: async () => { throw new Error('injected activity append failure') },
    pruneCodexProjections: async () => { throw new Error('injected projection cleanup failure') },
  }
  const expectedWarnings = [{
    code: 'CODEX_PROJECTION_CLEANUP_FAILED',
    message: 'The private component change succeeded, but stale Codex projection cleanup could not be completed.',
  }, {
    code: 'ACTIVITY_LOG_WRITE_FAILED',
    message: 'The private component change succeeded, but its activity entry could not be recorded.',
  }]

  const imported = await importLocalComponent({
    stateRoot, artifact: fixture.artifactPath, binding: fixture.binding,
    activate: false, dryRun: false,
  }, dependencies)
  assert.equal(imported.status, 'imported')
  assert.deepEqual(imported.warnings, expectedWarnings)
  assert.deepEqual(imported.projectionCleanup, { status: 'not-completed', removed: 0 })
  let state = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(state.privateComponents['private-fixture'].current.binding.archiveSha256, fixture.binding.archiveSha256)
  assert.equal((await stat(state.privateComponents['private-fixture'].current.component.root)).isDirectory(), true)

  const removed = await removeLocalComponent({ stateRoot, target: 'private-fixture', dryRun: false }, dependencies)
  assert.equal(removed.status, 'removed')
  assert.deepEqual(removed.warnings, expectedWarnings)
  state = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(state.privateComponents['private-fixture'].current, null)
  assert.equal((await stat(state.privateComponents['private-fixture'].rollback.component.root)).isDirectory(), true)

  const restored = await rollbackLocalComponent({ stateRoot, target: 'private-fixture', dryRun: false }, dependencies)
  assert.equal(restored.status, 'rolled-back')
  assert.deepEqual(restored.warnings, expectedWarnings)
  state = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(state.privateComponents['private-fixture'].current.binding.archiveSha256, fixture.binding.archiveSha256)
  assert.equal((await stat(state.privateComponents['private-fixture'].current.component.root)).isDirectory(), true)
})

test('private component rollback rejects tampered retained bytes before health or host transition', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-private-rollback-tamper-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const fixture = await createToolComponentFixture(join(root, 'private'))
  const dependencies = { runner: fake.runner, hostSkillHome, mcpProbe: healthyProbe }
  await importLocalComponent({
    stateRoot, artifact: fixture.artifactPath, binding: fixture.binding,
    activate: true, dryRun: false,
  }, dependencies)
  await removeLocalComponent({ stateRoot, target: 'private-fixture', dryRun: false }, dependencies)
  const paths = await prepareStatePaths(stateRoot)
  const before = await loadState(paths)
  const retained = before.privateComponents['private-fixture'].rollback.component
  const runtimeEntrypoint = retained.args[0]
  await chmod(runtimeEntrypoint, 0o600)
  await writeFile(runtimeEntrypoint, '// tampered retained runtime\n', 'utf8')
  let probes = 0

  await assert.rejects(
    rollbackLocalComponent({ stateRoot, target: 'private-fixture', dryRun: false }, {
      ...dependencies,
      mcpProbe: () => { probes += 1; return healthyProbe(retained) },
    }),
    (error) => error.code === 'LOCAL_COMPONENT_ROLLBACK_BYTES_UNVERIFIED' && error.details?.cause === 'COMPONENT_FILE_DIGEST_MISMATCH',
  )
  assert.equal(probes, 0)
  assert.deepEqual(await loadState(paths), before)
  assert.equal(fake.plugins.has('private-fixture@private-fixture-local'), false)
})

test('private component rollback requires a current healthy MCP catalog before host transition', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-private-rollback-health-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const fixture = await createToolComponentFixture(join(root, 'private'))
  const dependencies = { runner: fake.runner, hostSkillHome, mcpProbe: healthyProbe }
  await importLocalComponent({
    stateRoot, artifact: fixture.artifactPath, binding: fixture.binding,
    activate: true, dryRun: false,
  }, dependencies)
  await removeLocalComponent({ stateRoot, target: 'private-fixture', dryRun: false }, dependencies)
  const paths = await prepareStatePaths(stateRoot)
  const before = await loadState(paths)

  await assert.rejects(
    rollbackLocalComponent({ stateRoot, target: 'private-fixture', dryRun: false }, {
      ...dependencies,
      mcpProbe: () => { throw Object.assign(new Error('injected unhealthy catalog'), { code: 'TOOL_HEALTH_TOOLS_MISSING' }) },
    }),
    (error) => error.code === 'TOOL_HEALTH_TOOLS_MISSING',
  )
  assert.deepEqual(await loadState(paths), before)
  assert.equal(fake.plugins.has('private-fixture@private-fixture-local'), false)
})

test('verified storage cleanup retains private component bytes referenced by current and rollback state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-private-storage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const first = await createToolComponentFixture(join(root, 'first'), { version: '0.1.0', marker: 'first' })
  const second = await createToolComponentFixture(join(root, 'second'), { version: '0.2.0', marker: 'second' })
  const dependencies = { runner: fake.runner, hostSkillHome, mcpProbe: healthyProbe }
  await importLocalComponent({ stateRoot, artifact: first.artifactPath, binding: first.binding, activate: false, dryRun: false }, dependencies)
  await importLocalComponent({ stateRoot, artifact: second.artifactPath, binding: second.binding, replace: true, dryRun: false }, dependencies)
  await removeLocalComponent({ stateRoot, target: 'private-fixture', dryRun: false }, dependencies)
  const paths = await prepareStatePaths(stateRoot)
  const roots = (await readdir(join(paths.packages, 'private-fixture'))).map((name) => join(paths.packages, 'private-fixture', name))
  for (const packageRoot of roots) await utimes(packageRoot, new Date(0), new Date(0))

  const preview = await cleanupStorage({ stateRoot, dryRun: true })
  assert.equal(preview.plan.packageVersions, 1)
  assert.equal(preview.before.packages.files > 0, true)
  await cleanupStorage({ stateRoot, dryRun: false })
  const state = await loadState(paths)
  const retainedRoot = state.privateComponents['private-fixture'].rollback.component.root
  assert.deepEqual(await readdir(join(paths.packages, 'private-fixture')), [basename(retainedRoot)])
  assert.equal((await stat(retainedRoot)).isDirectory(), true)
})
