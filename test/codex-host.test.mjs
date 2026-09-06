import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildDevelopmentManifest } from '../src/development-manifest.mjs'
import { materializeCodexProjections } from '../src/hosts/codex-projection.mjs'
import { inspectCodex, installCodex, suspendCodex, uninstallCodex } from '../src/hosts/codex.mjs'
import { createCodexRunner, createDevelopmentWorkspace } from './helpers.mjs'

async function fixture(t, seed = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-codex-binding-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourceRoot = join(root, 'workspace')
  await createDevelopmentWorkspace(sourceRoot)
  const source = await buildDevelopmentManifest(sourceRoot)
  const manifest = await materializeCodexProjections(source, join(root, 'projections'))
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, ...seed })
  return { root, source, manifest, fake, options: { codexConfiguration: fake.configuration } }
}
const entry = (state, name) => state.entries.find((value) => value.component === name)
const edit = async (fake, keys, value) => fake.client.write(await fake.client.read(), [{ keys, value }])

// A source path proves what would be copied; it cannot prove what a native
// host executes. An unmanaged registration has no retained cache receipt.
test('Codex rejects an enabled user plugin even when its reported source matches the candidate', async (t) => {
  const { source, manifest, fake, options } = await fixture(t, { mathPresent: true })
  fake.marketplaces.set('math-anchor', source.components['math-anchor'].marketplaceRoot)
  const before = await fake.client.read()
  await assert.rejects(installCodex(manifest, fake.runner, options), { code: 'CODEX_PLUGIN_CONFLICT' })
  assert.deepEqual((await fake.client.read()).config, before.config)
  assert.equal(fake.calls.some(({ args }) => args[0] === 'plugin' && args[1] === 'add'), false)
})

test('explicit replacement changes only user enablement and restores it without replacing source or cache', async (t) => {
  const { source, manifest, fake, options } = await fixture(t, { mathPresent: true })
  const userSelector = 'math-anchor@math-anchor'
  fake.marketplaces.set('math-anchor', source.components['math-anchor'].marketplaceRoot)
  await edit(fake, ['plugins', userSelector], { enabled: true, custom: { permission: 'user-owned' } })
  const before = (await fake.client.read()).config
  const installed = await installCodex(manifest, fake.runner, { ...options, replaceConflicts: true })
  const math = entry(installed, 'math-anchor')
  assert.notEqual(math.selector, userSelector)
  assert.deepEqual(math.displacedPlugins, [{ selector: userSelector, marketplace: 'math-anchor', before: { present: true, value: true } }])
  assert.equal(fake.plugins.get(userSelector).enabled, false)
  assert.deepEqual((await fake.client.read()).config.plugins[userSelector], { ...before.plugins[userSelector], enabled: false })
  assert.deepEqual((await fake.client.read()).config.marketplaces['math-anchor'], before.marketplaces['math-anchor'])
  assert.equal((await inspectCodex(manifest, fake.runner, { ...options, managedState: installed })).entries.every((item) => item.installedIdentityMatched), true)
  await uninstallCodex(installed, fake.runner, options)
  assert.deepEqual((await fake.client.read()).config, before)
  assert.equal(fake.caches.has(math.selector), true, 'native-owned inactive cache remains untouched')
  assert.equal(fake.calls.some(({ args }) => args[0] === 'plugin' && (args[1] === 'remove' || args[1] === 'marketplace')), false)
})

test('Codex verifies cached bytes independently from the reported source and requires fresh identity for repair', async (t) => {
  const { manifest, fake, options } = await fixture(t)
  const installed = await installCodex(manifest, fake.runner, options)
  const math = entry(installed, 'math-anchor')
  const cachedFile = join(math.installedPath, '.codex-plugin', 'plugin.json')
  const originalSource = await readFile(join(math.pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8')
  await writeFile(cachedFile, '{"name":"math-anchor","version":"0.3.0","user":"changed"}\n')
  assert.equal(await readFile(join(math.pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'), originalSource)
  const inspection = await inspectCodex(manifest, fake.runner, { ...options, managedState: installed })
  assert.equal(entry(inspection, 'math-anchor').installedIdentityMatched, false)
  await assert.rejects(installCodex(manifest, fake.runner, { ...options, managedState: installed }), { code: 'CODEX_PLUGIN_CHANGED' })
  const repaired = await installCodex(manifest, fake.runner, { ...options, managedState: installed, replaceConflicts: true })
  assert.notEqual(entry(repaired, 'math-anchor').installedPath, math.installedPath)
  assert.match(await readFile(cachedFile, 'utf8'), /"user":"changed"/)
})

test('Codex installation compensates earlier registration changes when a later cache copy fails', async (t) => {
  const { manifest, fake, options } = await fixture(t)
  const before = (await fake.client.read()).config
  const runner = async (file, args, values) => {
    if (args[0] === 'plugin' && args[1] === 'add' && args[2].startsWith('migratory-time@')) throw new Error('injected second-provider failure')
    return fake.runner(file, args, values)
  }
  await assert.rejects(installCodex(manifest, runner, options), /injected second-provider failure/)
  assert.deepEqual((await fake.client.read()).config, before)
  assert.equal(fake.caches.size, 1, 'already copied native bytes remain passive')
})

test('failed release replacement restores old registrations and the exact original cache bytes', async (t) => {
  const old = await fixture(t)
  const next = await fixture(t)
  const installed = await installCodex(old.manifest, old.fake.runner, old.options)
  const before = (await old.fake.client.read()).config
  const original = await Promise.all(installed.entries.map(async (value) => ({
    path: value.installedPath, inode: (await lstat(value.installedPath, { bigint: true })).ino,
    contents: await readFile(join(value.installedPath, '.codex-plugin', 'plugin.json'), 'utf8'),
  })))
  const runner = async (file, args, values) => {
    if (args[0] === 'plugin' && args[1] === 'add' && args[2].startsWith('migratory-time@')) throw new Error('injected release failure')
    return old.fake.runner(file, args, values)
  }
  await assert.rejects(installCodex(next.manifest, runner, { ...old.options, managedState: installed }), /injected release failure/)
  assert.deepEqual((await old.fake.client.read()).config, before)
  for (const value of original) {
    assert.equal((await lstat(value.path, { bigint: true })).ino, value.inode)
    assert.equal(await readFile(join(value.path, '.codex-plugin', 'plugin.json'), 'utf8'), value.contents)
  }
})

test('Codex tool suspension and resumption preserve selector and cached inode', async (t) => {
  const { manifest, fake, options } = await fixture(t)
  const installed = await installCodex(manifest, fake.runner, options)
  const math = entry(installed, 'math-anchor')
  const inode = (await lstat(math.installedPath, { bigint: true })).ino
  await suspendCodex(installed, fake.runner, options)
  assert.equal(fake.enabledPlugins('math-anchor').length, 0)
  const resumed = await installCodex(manifest, fake.runner, { ...options, managedState: installed })
  assert.equal(entry(resumed, 'math-anchor').selector, math.selector)
  assert.equal((await lstat(math.installedPath, { bigint: true })).ino, inode)
  assert.equal(fake.enabledPlugins('math-anchor').length, 1)
})

test('reusing an unchanged Host cache still handles a newly enabled conflicting user plugin', async (t) => {
  const { manifest, fake, options } = await fixture(t)
  const installed = await installCodex(manifest, fake.runner, options)
  fake.plugins.set('math-anchor@later-user', { installed: true, enabled: true, version: 'user' })
  await assert.rejects(installCodex(manifest, fake.runner, { ...options, managedState: installed }), { code: 'CODEX_PLUGIN_CONFLICT' })
  const changed = await installCodex(manifest, fake.runner, { ...options, managedState: installed, replaceConflicts: true })
  assert.equal(entry(changed, 'math-anchor').selector, entry(installed, 'math-anchor').selector)
  assert.equal(fake.plugins.get('math-anchor@later-user').enabled, false)
  await edit(fake, ['plugins', 'math-anchor@later-user', 'custom'], { preference: 'retained' })
  await uninstallCodex(changed, fake.runner, options)
  assert.deepEqual((await fake.client.read()).config.plugins['math-anchor@later-user'], { enabled: true, custom: { preference: 'retained' } })
})

test('uninstall preserves ownership when a user-edited Host registration still depends on Host files', async (t) => {
  const { manifest, fake, options } = await fixture(t)
  const installed = await installCodex(manifest, fake.runner, options)
  const math = entry(installed, 'math-anchor')
  await edit(fake, ['plugins', math.selector], { enabled: true, user: 'new setting' })
  const before = (await fake.client.read()).config
  await assert.rejects(uninstallCodex(installed, fake.runner, options), { code: 'CODEX_PLUGIN_CHANGED' })
  assert.deepEqual((await fake.client.read()).config, before)
  assert.equal(fake.plugins.has(math.selector), true)
  assert.equal(fake.marketplaces.has(math.marketplace), true)
  assert.deepEqual((await fake.client.read()).config.plugins[math.selector], { enabled: true, user: 'new setting' })
})

test('legacy lossy displacement records are rejected before changing registrations', async (t) => {
  const { manifest, fake, options } = await fixture(t)
  const installed = await installCodex(manifest, fake.runner, options)
  const legacy = { ...installed, entries: installed.entries.map((value) => ({ ...value, configurationVersion: undefined, restorePlugin: true })) }
  const before = (await fake.client.read()).config
  await assert.rejects(installCodex(manifest, fake.runner, { ...options, managedState: legacy }), { code: 'CODEX_LEGACY_RESTORE_UNVERIFIABLE' })
  await assert.rejects(uninstallCodex(legacy, fake.runner, options), { code: 'CODEX_LEGACY_RESTORE_UNVERIFIABLE' })
  assert.deepEqual((await fake.client.read()).config, before)
})

test('a changed registration cannot lose its user fields during explicit replacement with a new projection', async (t) => {
  const current = await fixture(t)
  const next = await fixture(t)
  const installed = await installCodex(current.manifest, current.fake.runner, current.options)
  const math = entry(installed, 'math-anchor')
  await edit(current.fake, ['plugins', math.selector], { enabled: true, user: 'retained data' })
  const before = (await current.fake.client.read()).config
  await assert.rejects(installCodex(next.manifest, current.fake.runner, { ...current.options, managedState: installed, replaceConflicts: true }), { code: 'CODEX_PLUGIN_CHANGED' })
  assert.deepEqual((await current.fake.client.read()).config, before)
})

test('a newly shared Host marketplace prevents ownership removal and keeps every registration', async (t) => {
  const { manifest, fake, options } = await fixture(t)
  const installed = await installCodex(manifest, fake.runner, options)
  const math = entry(installed, 'math-anchor')
  await edit(fake, ['plugins', 'another@' + math.marketplace], { enabled: true })
  const before = (await fake.client.read()).config
  await assert.rejects(uninstallCodex(installed, fake.runner, options), { code: 'CODEX_MARKETPLACE_CHANGED' })
  assert.deepEqual((await fake.client.read()).config, before)
})

test('minimal exclusively owned legacy registrations migrate to new cache identities and retire their old sources', async (t) => {
  const { source, manifest, fake, options } = await fixture(t, { mathPresent: true })
  const component = source.components['math-anchor']
  fake.marketplaces.set('math-anchor', component.marketplaceRoot)
  const prior = { kind: 'codex', entries: [{ component: 'math-anchor', selector: 'math-anchor@math-anchor', marketplace: 'math-anchor',
    marketplaceRoot: component.marketplaceRoot, pluginCreated: true, marketplaceCreated: true, displacedPlugins: [], restorePlugin: false }] }
  const next = await installCodex(manifest, fake.runner, { ...options, managedState: prior })
  assert.notEqual(entry(next, 'math-anchor').selector, prior.entries[0].selector)
  assert.equal(fake.plugins.has(prior.entries[0].selector), false)
  assert.equal(fake.marketplaces.has('math-anchor'), false)
  assert.equal((await inspectCodex(manifest, fake.runner, { ...options, managedState: next })).entries.every((item) => item.installedIdentityMatched), true)
  await uninstallCodex(next, fake.runner, options)
  assert.equal(fake.plugins.size, 0)
})

test('legacy migration rejects shared or user-modified registrations before installing any cache', async (t) => {
  const { source, manifest, fake, options } = await fixture(t, { mathPresent: true })
  fake.marketplaces.set('math-anchor', source.components['math-anchor'].marketplaceRoot)
  const prior = { kind: 'codex', entries: [{ component: 'math-anchor', selector: 'math-anchor@math-anchor', marketplace: 'math-anchor',
    marketplaceRoot: source.components['math-anchor'].marketplaceRoot, pluginCreated: true, marketplaceCreated: true }] }
  await edit(fake, ['plugins', 'math-anchor@math-anchor'], { enabled: true, user: 'new setting' })
  const before = (await fake.client.read()).config
  await assert.rejects(installCodex(manifest, fake.runner, { ...options, managedState: prior, replaceConflicts: true }), { code: 'CODEX_LEGACY_IDENTITY_UNVERIFIABLE' })
  assert.deepEqual((await fake.client.read()).config, before)
  assert.equal(fake.caches.size, 0)
})

test('cached identity rejects added Skills and symlinks even when every expected file has the original bytes', async (t) => {
  const { manifest, fake, options } = await fixture(t)
  const installed = await installCodex(manifest, fake.runner, options)
  const math = entry(installed, 'math-anchor')
  const extra = join(math.installedPath, 'skills', 'unexpected')
  await mkdir(extra)
  await writeFile(join(extra, 'SKILL.md'), 'An additional agent-visible instruction')
  const inspect = () => inspectCodex(manifest, fake.runner, { ...options, managedState: installed })
  assert.equal(entry(await inspect(), 'math-anchor').installedIdentityMatched, false)
  await rm(extra, { recursive: true })
  assert.equal(entry(await inspect(), 'math-anchor').installedIdentityMatched, true)
  const cached = join(math.installedPath, '.codex-plugin', 'plugin.json')
  await rm(cached)
  await symlink(join(math.pluginRoot, '.codex-plugin', 'plugin.json'), cached)
  assert.equal(entry(await inspect(), 'math-anchor').installedIdentityMatched, false)
})
