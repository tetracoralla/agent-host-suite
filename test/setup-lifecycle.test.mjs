import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { hostStateOutsideManifest, safePurgeRoot, uninstallInstallation, updateInstallation, rollbackInstallation } from '../src/lifecycle.mjs'
import { setup } from '../src/setup.mjs'
import { loadState, prepareStatePaths } from '../src/state.mjs'
import { listActivity } from '../src/activity.mjs'
import { createCodexRunner, createDevelopmentWorkspace } from './helpers.mjs'

test('setup, update, rollback, and uninstall preserve host ownership', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-workspace-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-state-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stateRoot, { recursive: true, force: true })]))
  await createDevelopmentWorkspace(root)
  const fake = createCodexRunner({ mathPresent: false, timePresent: false })
  const result = await setup({ profile: 'standard', hosts: ['codex'], developmentRoot: root, stateRoot, noService: true, dryRun: false, enableObservability: false }, { runner: fake.runner })
  assert.equal(result.status, 'installed')
  const paths = await prepareStatePaths(stateRoot)
  assert.equal((await loadState(paths)).profile, 'standard')
  assert.equal((await updateInstallation({ stateRoot, dryRun: false }, { runner: fake.runner })).status, 'updated')
  assert.equal((await rollbackInstallation({ stateRoot, dryRun: false }, { runner: fake.runner })).status, 'rolled-back')
  assert.deepEqual((await listActivity(paths)).map((entry) => entry.type), [
    'environment.rolled-back',
    'environment.updated',
    'environment.installed',
  ])
  const removed = await uninstallInstallation({ stateRoot, purgeData: false }, { runner: fake.runner })
  assert.equal(removed.status, 'uninstalled')
  assert.equal(await loadState(paths), null)
  assert.equal(fake.plugins.size, 0)
  assert.equal((await listActivity(paths))[0].type, 'environment.uninstalled')
})

test('public setup fails closed while the release catalog is unbound', async () => {
  await assert.rejects(
    setup({ profile: 'standard', hosts: [], noService: true, dryRun: true, enableObservability: false }),
    (error) => error.code === 'RELEASE_UNBOUND',
  )
})

test('purge-data removes the private state root for a deep state root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-workspace-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-state-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stateRoot, { recursive: true, force: true })]))
  await createDevelopmentWorkspace(root)
  const fake = createCodexRunner({ mathPresent: false, timePresent: false })
  await setup({ profile: 'standard', hosts: ['codex'], developmentRoot: root, stateRoot, noService: true, dryRun: false, enableObservability: false }, { runner: fake.runner })
  const purged = await uninstallInstallation({ stateRoot, purgeData: true }, { runner: fake.runner })
  assert.equal(purged.status, 'uninstalled')
  assert.equal(purged.purgeData, true)
  assert.equal(purged.archive, null)
  await assert.rejects(access(stateRoot))
})

test('purge-data refuses filesystem roots, home, and shallow state roots', async () => {
  assert.equal(safePurgeRoot('/'), false)
  assert.equal(safePurgeRoot('/private/tmp'), false)
  assert.equal(safePurgeRoot('/tmp/one-level'), false)
  assert.equal(safePurgeRoot(homedir()), false)
  assert.equal(safePurgeRoot('/Users/name/Library/Application Support/OpenAdam/Agent Host Suite'), true)
})

test('profile transitions identify only Codex bindings outside the target manifest', () => {
  const current = {
    kind: 'codex',
    entries: [
      { selector: 'math-anchor@openadam' },
      { selector: 'migratory-time@migratory-time' },
      { selector: 'file-vitals@file-vitals-local', pluginCreated: true },
    ],
  }
  const manifest = {
    components: {
      math: { plugin: 'math-anchor', marketplace: 'openadam' },
      time: { plugin: 'migratory-time', marketplace: 'migratory-time' },
    },
  }
  assert.deepEqual(hostStateOutsideManifest('codex', current, manifest)?.entries, [
    { selector: 'file-vitals@file-vitals-local', pluginCreated: true },
  ])
  assert.equal(hostStateOutsideManifest('claude', current, manifest), null)
})

test('unsafe purge-data is rejected before any installed state or host binding changes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-workspace-'))
  const stateRoot = `/tmp/agent-host-purge-preflight-${process.pid}`
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stateRoot, { recursive: true, force: true })]))
  await createDevelopmentWorkspace(root)
  const fake = createCodexRunner({ mathPresent: false, timePresent: false })
  await setup({ profile: 'standard', hosts: ['codex'], developmentRoot: root, stateRoot, noService: true, dryRun: false, enableObservability: false }, { runner: fake.runner })
  const paths = await prepareStatePaths(stateRoot)
  await assert.rejects(
    uninstallInstallation({ stateRoot, purgeData: true }, { runner: fake.runner }),
    (error) => error.code === 'PURGE_ROOT_UNSAFE',
  )
  assert.notEqual(await loadState(paths), null)
  assert.equal(fake.plugins.size, 2)
  assert.equal(fake.marketplaces.size, 2)
})
