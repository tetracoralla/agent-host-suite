import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { uninstallInstallation, updateInstallation, rollbackInstallation } from '../src/lifecycle.mjs'
import { setup } from '../src/setup.mjs'
import { loadState, prepareStatePaths } from '../src/state.mjs'
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
  const removed = await uninstallInstallation({ stateRoot, purgeData: false }, { runner: fake.runner })
  assert.equal(removed.status, 'uninstalled')
  assert.equal(await loadState(paths), null)
  assert.equal(fake.plugins.size, 0)
})

test('public setup fails closed while the release catalog is unbound', async () => {
  await assert.rejects(
    setup({ profile: 'standard', hosts: [], noService: true, dryRun: true, enableObservability: false }),
    (error) => error.code === 'RELEASE_UNBOUND',
  )
})
