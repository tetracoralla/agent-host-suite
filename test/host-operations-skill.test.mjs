import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  inspectOperationsSkill,
  installOperationsSkill,
  preflightOperationsSkill,
  uninstallOperationsSkill,
} from '../src/host-operations-skill.mjs'
import { prepareStatePaths } from '../src/state.mjs'
import { createCodexRunner } from './helpers.mjs'

test('Codex receives Agent Host operations as a Skill-only managed plugin', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-operations-codex-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const paths = await prepareStatePaths(join(root, 'private', 'state'))
  const fake = createCodexRunner({ mathPresent: false, timePresent: false })

  const preflight = await preflightOperationsSkill('codex', paths, fake.runner)
  assert.equal(preflight.carrier, 'codex-plugin')
  assert.equal(preflight.present, false)

  const managed = await installOperationsSkill('codex', paths, fake.runner)
  assert.equal(managed.kind, 'codex-plugin')
  assert.equal(fake.plugins.has('agent-host-operations@agent-host-local'), true)
  assert.equal((await inspectOperationsSkill(managed, fake.runner)).status, 'ok')
  const pluginRoot = managed.binding.entries[0].pluginRoot
  assert.equal((await stat(join(pluginRoot, 'skills', 'agent-host-operations', 'scripts', 'agent-host'))).mode & 0o111, 0o111)
  const plugin = JSON.parse(await readFile(join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'))
  assert.equal(plugin.mcpServers, undefined)
  assert.equal(plugin.skills, './skills/')

  await uninstallOperationsSkill(managed, fake.runner)
  assert.equal(fake.plugins.has('agent-host-operations@agent-host-local'), false)
  assert.equal(fake.marketplaces.has('agent-host-local'), false)
})

test('Claude Skill projection fails closed, restores a displaced Skill, and preserves later user changes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-operations-claude-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const paths = await prepareStatePaths(join(root, 'private', 'state'))
  const homeRoot = join(root, 'home')
  const exposure = join(homeRoot, '.claude', 'skills', 'agent-host-operations')
  await mkdir(exposure, { recursive: true })
  await writeFile(join(exposure, 'SKILL.md'), 'user-owned\n')

  await assert.rejects(
    preflightOperationsSkill('claude', paths, null, { homeRoot }),
    (error) => error.code === 'HOST_SKILL_CONFLICT',
  )
  const managed = await installOperationsSkill('claude', paths, null, null, { homeRoot, replaceConflicts: true })
  assert.equal((await lstat(exposure)).isSymbolicLink(), true)
  assert.equal(await realpath(exposure), managed.projectionRoot)
  assert.equal((await inspectOperationsSkill(managed, null)).status, 'ok')
  const removed = await uninstallOperationsSkill(managed, null)
  assert.equal(removed.restored, true)
  assert.equal(await readFile(join(exposure, 'SKILL.md'), 'utf8'), 'user-owned\n')

  await rm(exposure, { recursive: true, force: true })
  const second = await installOperationsSkill('claude', paths, null, null, { homeRoot })
  await rm(exposure, { force: false })
  await mkdir(exposure)
  await writeFile(join(exposure, 'SKILL.md'), 'changed-after-install\n')
  const preserved = await uninstallOperationsSkill(second, null)
  assert.equal(preserved.preservedChangedTarget, true)
  assert.equal(await readFile(join(exposure, 'SKILL.md'), 'utf8'), 'changed-after-install\n')
})
