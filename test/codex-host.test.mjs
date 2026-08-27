import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildDevelopmentManifest } from '../src/development-manifest.mjs'
import { installCodex, uninstallCodex } from '../src/hosts/codex.mjs'
import { createCodexRunner, createDevelopmentWorkspace } from './helpers.mjs'

test('Codex installation preserves an existing provider and owns only new entries', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-workspace-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await createDevelopmentWorkspace(root)
  const manifest = await buildDevelopmentManifest(root)
  const fake = createCodexRunner({ mathPresent: true })
  fake.marketplaces.set('math-anchor', manifest.components['math-anchor'].marketplaceRoot)
  const installed = await installCodex(manifest, fake.runner)
  const math = installed.entries.find((item) => item.component === 'math-anchor')
  const time = installed.entries.find((item) => item.component === 'migratory-time')
  assert.equal(math.pluginCreated, false)
  assert.equal(math.marketplaceCreated, false)
  assert.equal(time.pluginCreated, true)
  assert.equal(time.marketplaceCreated, true)
  await uninstallCodex(installed, fake.runner)
  assert.equal(fake.plugins.has('math-anchor@math-anchor'), true)
  assert.equal(fake.plugins.has('migratory-time@migratory-time'), false)
  assert.equal(fake.marketplaces.has('math-anchor'), true)
  assert.equal(fake.marketplaces.has('migratory-time'), false)
})

test('Codex migration refuses different bytes unless explicitly requested and restores the displaced entry', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-workspace-'))
  const legacyRoot = await mkdtemp(join(tmpdir(), 'agent-host-legacy-plugin-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(legacyRoot, { recursive: true, force: true })]))
  await createDevelopmentWorkspace(root)
  await createDevelopmentWorkspace(join(legacyRoot, 'workspace'))
  const manifest = await buildDevelopmentManifest(root)
  const legacyPlugin = join(legacyRoot, 'workspace/migratory-time/plugins/migratory-time')
  await writeFile(join(legacyPlugin, 'server/index.mjs'), 'process.exit(0)\n')
  const fake = createCodexRunner({ mathPresent: false, legacyTimeRoot: legacyPlugin })
  await assert.rejects(installCodex(manifest, fake.runner), (error) => error.code === 'CODEX_PLUGIN_CONFLICT')
  const installed = await installCodex(manifest, fake.runner, { replaceConflicts: true })
  assert.equal(fake.plugins.has('migratory-time@personal'), false)
  assert.equal(installed.entries.find((item) => item.component === 'migratory-time').displacedPlugins[0].identityMatched, false)
  await uninstallCodex(installed, fake.runner)
  assert.equal(fake.plugins.has('migratory-time@personal'), true)
})

test('Codex installation refuses an exact selector whose installed bytes are unavailable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-workspace-'))
  const missingRoot = await mkdtemp(join(tmpdir(), 'agent-host-missing-plugin-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(missingRoot, { recursive: true, force: true })]))
  await createDevelopmentWorkspace(root)
  const manifest = await buildDevelopmentManifest(root)
  const fake = createCodexRunner({ mathPresent: true })
  fake.marketplaces.set('math-anchor', manifest.components['math-anchor'].marketplaceRoot)
  fake.plugins.set('math-anchor@math-anchor', { version: '0.3.0', enabled: true, sourcePath: missingRoot })
  await assert.rejects(installCodex(manifest, fake.runner), (error) => error.code === 'CODEX_PLUGIN_CONFLICT')
})

test('Codex installation rolls back every mutation when a later provider fails', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-workspace-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await createDevelopmentWorkspace(root)
  const manifest = await buildDevelopmentManifest(root)
  const fake = createCodexRunner({ mathPresent: false, timePresent: false })
  const failingRunner = async (file, args, options) => {
    if (args[0] === 'plugin' && args[1] === 'add' && args[2] === 'migratory-time@migratory-time') {
      throw new Error('injected second-provider failure')
    }
    return fake.runner(file, args, options)
  }
  await assert.rejects(installCodex(manifest, failingRunner), /injected second-provider failure/)
  assert.equal(fake.plugins.size, 0)
  assert.equal(fake.marketplaces.size, 0)
})

test('Codex managed marketplace rebind restores the previous release when a later provider fails', async (t) => {
  const oldRoot = await mkdtemp(join(tmpdir(), 'agent-host-workspace-old-'))
  const newRoot = await mkdtemp(join(tmpdir(), 'agent-host-workspace-new-'))
  t.after(() => Promise.all([rm(oldRoot, { recursive: true, force: true }), rm(newRoot, { recursive: true, force: true })]))
  await createDevelopmentWorkspace(oldRoot)
  await createDevelopmentWorkspace(newRoot)
  const oldManifest = await buildDevelopmentManifest(oldRoot)
  const newManifest = await buildDevelopmentManifest(newRoot)
  const fake = createCodexRunner({ mathPresent: false, timePresent: false })
  const oldState = await installCodex(oldManifest, fake.runner)
  const failingRunner = async (file, args, options) => {
    if (args[0] === 'plugin' && args[1] === 'add' && args[2] === 'migratory-time@migratory-time' && fake.marketplaces.get('migratory-time') === newManifest.components['migratory-time'].marketplaceRoot) {
      throw new Error('injected release rebind failure')
    }
    return fake.runner(file, args, options)
  }
  await assert.rejects(installCodex(newManifest, failingRunner, { managedState: oldState }), /injected release rebind failure/)
  assert.equal(fake.marketplaces.get('math-anchor'), oldManifest.components['math-anchor'].marketplaceRoot)
  assert.equal(fake.marketplaces.get('migratory-time'), oldManifest.components['migratory-time'].marketplaceRoot)
  assert.equal(fake.plugins.has('math-anchor@math-anchor'), true)
  assert.equal(fake.plugins.has('migratory-time@migratory-time'), true)
})

test('Codex uninstall restores an unmanaged marketplace and exact-selector plugin displaced by migration', async (t) => {
  const userRoot = await mkdtemp(join(tmpdir(), 'agent-host-workspace-user-'))
  const releaseRoot = await mkdtemp(join(tmpdir(), 'agent-host-workspace-release-'))
  t.after(() => Promise.all([rm(userRoot, { recursive: true, force: true }), rm(releaseRoot, { recursive: true, force: true })]))
  await createDevelopmentWorkspace(userRoot)
  await createDevelopmentWorkspace(releaseRoot)
  const releaseManifest = await buildDevelopmentManifest(releaseRoot)
  const fake = createCodexRunner({ mathPresent: true, timePresent: false })
  fake.marketplaces.set('math-anchor', join(userRoot, 'calculator'))

  const installed = await installCodex(releaseManifest, fake.runner, { replaceConflicts: true })
  const math = installed.entries.find((entry) => entry.component === 'math-anchor')
  assert.equal(math.displacedMarketplace, join(userRoot, 'calculator'))
  assert.equal(math.restorePlugin, true)
  assert.equal(fake.marketplaces.get('math-anchor'), releaseManifest.components['math-anchor'].marketplaceRoot)

  await uninstallCodex(installed, fake.runner)
  assert.equal(fake.marketplaces.get('math-anchor'), join(userRoot, 'calculator'))
  assert.equal(fake.plugins.has('math-anchor@math-anchor'), true)
})
