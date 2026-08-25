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
