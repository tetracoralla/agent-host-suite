import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import {
  inspectOperationsSkill,
  installOperationsSkill,
  preflightOperationsSkill,
  uninstallOperationsSkill,
} from '../src/host-operations-skill.mjs'
import { prepareStatePaths } from '../src/state.mjs'
import { createCodexRunner } from './helpers.mjs'

const execFileAsync = promisify(execFile)

test('operations launcher prefers an installed application over an ambient CLI', { skip: process.platform !== 'darwin' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-operations-launcher-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const installedApp = join(root, 'Applications', 'Agent Host.app')
  const appLauncher = join(installedApp, 'Contents', 'MacOS', 'agent-host')
  const ambientRoot = join(root, 'ambient-bin')
  const ambientLauncher = join(ambientRoot, 'agent-host')
  const productionLauncher = join(import.meta.dirname, '..', 'skills', 'agent-host-operations', 'scripts', 'agent-host')
  const testLauncher = join(root, 'agent-host')

  await mkdir(join(installedApp, 'Contents', 'MacOS'), { recursive: true })
  await mkdir(ambientRoot, { recursive: true })
  await writeFile(appLauncher, '#!/bin/zsh\nprint installed-app\n')
  await writeFile(ambientLauncher, '#!/bin/zsh\nprint ambient-cli\n')
  await chmod(appLauncher, 0o755)
  await chmod(ambientLauncher, 0o755)

  const source = await readFile(productionLauncher, 'utf8')
  await writeFile(
    testLauncher,
    source.replace(
      'for app_path in "/Applications/Agent Host.app" "${user_app}"; do',
      `for app_path in "${installedApp}" "\${user_app}"; do`,
    ),
  )
  await chmod(testLauncher, 0o755)

  const result = await execFileAsync(testLauncher, [], {
    env: {
      ...process.env,
      AGENT_HOST_CLI: '',
      HOME: join(root, 'home'),
      PATH: `${ambientRoot}:/usr/bin:/bin`,
    },
  })
  assert.equal(result.stdout.trim(), 'installed-app')
})

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

test('Claude operations Skill follows an explicit Claude configuration root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-operations-claude-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const paths = await prepareStatePaths(join(root, 'private', 'state'))
  const configRoot = join(root, 'custom-claude-config')
  const managed = await installOperationsSkill('claude', paths, null, null, { configRoot })
  assert.equal(managed.exposurePath, join(configRoot, 'skills', 'agent-host-operations'))
  assert.equal((await lstat(managed.exposurePath)).isSymbolicLink(), true)
  await uninstallOperationsSkill(managed, null)
})

test('ZCode receives the packaged operations Skill from immutable Host storage', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-operations-zcode-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const paths = await prepareStatePaths(join(root, 'private', 'state'))
  const homeRoot = join(root, 'home')
  const managed = await installOperationsSkill('zcode', paths, null, null, { homeRoot })
  assert.equal(managed.kind, 'zcode-skill-link')
  assert.equal(managed.exposurePath, join(homeRoot, '.zcode', 'skills', 'agent-host-operations'))
  assert.equal((await lstat(managed.exposurePath)).isSymbolicLink(), true)
  assert.equal(await realpath(managed.exposurePath), managed.projectionRoot)
  assert.equal((await inspectOperationsSkill(managed, null)).status, 'ok')
  assert.equal((await stat(join(managed.projectionRoot, 'scripts', 'agent-host'))).mode & 0o111, 0o111)
  assert.equal((await uninstallOperationsSkill(managed, null)).removed, true)
})
