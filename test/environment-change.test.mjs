import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { setup } from '../src/setup.mjs'
import { setActiveTools, uninstallInstallation } from '../src/lifecycle.mjs'
import { loadState, readStatePaths, saveState, STATE_SCHEMA, validateState } from '../src/state.mjs'
import { afterEnvironmentCommit, CHANGE_STATE_SCHEMA } from '../src/environment-change.mjs'
import { withLifecycleMutation } from '../src/lifecycle-lock.mjs'
import { writeEnvironmentJson } from '../src/environment-resources.mjs'
import { compatibleApplicationState, createDevelopmentWorkspace } from './helpers.mjs'
import { configuration } from './fixtures/environment-interruption.mjs'

const original = { type: 'stdio', command: process.execPath, args: ['user-owned-original.mjs'], enabled: true }
const fixturePath = fileURLToPath(new URL('./fixtures/environment-interruption.mjs', import.meta.url))
const readConfig = async (root) => JSON.parse(await readFile(join(root, 'home', 'config.json'), 'utf8'))
const skillPath = (root) => join(root, 'home', '.zcode', 'skills', 'agent-host-operations')

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-environment-interruption-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'source'))
  await createDevelopmentWorkspace(join(root, 'source'))
  await mkdir(skillPath(root), { recursive: true })
  await writeFile(join(skillPath(root), 'user.txt'), 'user-owned skill')
  await writeFile(join(root, 'home', 'config.json'), JSON.stringify({ preferences: { theme: 'dark' }, mcp: { servers: { 'math-anchor': original } } }))
  return root
}

async function interrupt(root, phase = 'before-commit', action = '--interrupt', host = 'zcode') {
  const exited = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixturePath, action, root, phase, host], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, stderr }))
  })
  assert.equal(exited.signal, 'SIGKILL', exited.stderr)
}

test('process death before state commit retains displacement; retry and uninstall restore user config and Skill', async (t) => {
  const root = await fixture(t)
  await interrupt(root)
  const paths = await readStatePaths(join(root, 'state'))
  const pointer = JSON.parse(await readFile(paths.state, 'utf8'))
  assert.equal(pointer.schemaVersion, CHANGE_STATE_SCHEMA)
  assert.throws(() => validateState(pointer), { code: 'STATE_SCHEMA_UNSUPPORTED' })
  await assert.rejects(loadState(paths), { code: 'ENVIRONMENT_RECOVERY_REQUIRED' })
  assert.notDeepEqual((await readConfig(root)).mcp.servers['math-anchor'], original)
  assert.equal((await lstat(skillPath(root))).isSymbolicLink(), true)
  const { options, dependencies } = configuration(root)
  await setup(options, dependencies)
  const state = await loadState(paths)
  const entry = state.hosts.zcode.entries.find((item) => item.component === 'math-anchor')
  assert.equal(entry.created, true)
  assert.equal(entry.adopted, false)
  assert.deepEqual(entry.displaced, original)
  await uninstallInstallation({ stateRoot: paths.root, keepData: true }, dependencies)
  assert.deepEqual((await readConfig(root)).mcp.servers['math-anchor'], original)
  assert.equal(await readFile(join(skillPath(root), 'user.txt'), 'utf8'), 'user-owned skill')
  assert.equal(await loadState(paths), null)
})

test('recovery preserves unrelated later user edits and a dry run does not recover', async (t) => {
  const root = await fixture(t)
  await interrupt(root)
  const path = join(root, 'home', 'config.json')
  const changed = await readConfig(root)
  changed.preferences.theme = 'light'
  changed.mcp.servers.other = { command: 'user-owned-other' }
  await writeFile(path, JSON.stringify(changed))
  const { options, dependencies } = configuration(root)
  const bytes = await readFile(path, 'utf8')
  await assert.rejects(setup({ ...options, dryRun: true }, dependencies), { code: 'ENVIRONMENT_RECOVERY_REQUIRED' })
  assert.equal(await readFile(path, 'utf8'), bytes)
  await setup(options, dependencies)
  await uninstallInstallation({ stateRoot: join(root, 'state'), keepData: true }, dependencies)
  const restored = await readConfig(root)
  assert.equal(restored.preferences.theme, 'light')
  assert.deepEqual(restored.mcp.servers.other, { command: 'user-owned-other' })
  assert.deepEqual(restored.mcp.servers['math-anchor'], original)
})

test('a changed owned field blocks all recovery effects and retains the exact original record', async (t) => {
  const root = await fixture(t)
  await interrupt(root)
  const config = await readConfig(root)
  config.mcp.servers['math-anchor'] = { command: 'user-change-after-crash' }
  await writeFile(join(root, 'home', 'config.json'), JSON.stringify(config))
  const paths = await readStatePaths(join(root, 'state'))
  const journalPath = join(paths.root, '.environment-change.json')
  const journal = await readFile(journalPath, 'utf8')
  const pointer = await readFile(paths.state, 'utf8')
  const link = await readlink(skillPath(root))
  const { options, dependencies } = configuration(root)
  await assert.rejects(setup(options, dependencies), { code: 'ENVIRONMENT_RESOURCE_CHANGED' })
  assert.deepEqual(await readConfig(root), config)
  assert.equal(await readFile(journalPath, 'utf8'), journal)
  assert.equal(await readFile(paths.state, 'utf8'), pointer)
  assert.equal(await readlink(skillPath(root)), link)
})

test('process death after state commit keeps the committed environment and original ownership', async (t) => {
  const root = await fixture(t)
  await interrupt(root, 'after-commit')
  const paths = await readStatePaths(join(root, 'state'))
  assert.deepEqual((await loadState(paths)).hosts.zcode.entries.find((entry) => entry.component === 'math-anchor').displaced, original)
  const { dependencies } = configuration(root)
  await uninstallInstallation({ stateRoot: paths.root, keepData: true }, dependencies)
  assert.deepEqual((await readConfig(root)).mcp.servers['math-anchor'], original)
  assert.equal(await readFile(join(skillPath(root), 'user.txt'), 'utf8'), 'user-owned skill')
})

test('an interrupted uninstall restores its previous projections before retrying removal', async (t) => {
  const root = await fixture(t)
  const { options, dependencies } = configuration(root)
  await setup(options, dependencies)
  await interrupt(root, 'before-commit', '--interrupt-uninstall')
  const paths = await readStatePaths(join(root, 'state'))
  await assert.rejects(loadState(paths), { code: 'ENVIRONMENT_RECOVERY_REQUIRED' })
  assert.deepEqual((await readConfig(root)).mcp.servers['math-anchor'], original)
  assert.equal(await readFile(join(skillPath(root), 'user.txt'), 'utf8'), 'user-owned skill')
  await uninstallInstallation({ stateRoot: paths.root, keepData: true }, dependencies)
  assert.equal(await loadState(paths), null)
  assert.deepEqual((await readConfig(root)).mcp.servers['math-anchor'], original)
  assert.equal(await readFile(join(skillPath(root), 'user.txt'), 'utf8'), 'user-owned skill')
})

test('death after preparing the first intent but before its effect makes retry safe', async (t) => {
  const root = await fixture(t)
  await interrupt(root, 'before-commit', '--interrupt-prepared')
  assert.deepEqual((await readConfig(root)).mcp.servers['math-anchor'], original)
  assert.equal(await readFile(join(skillPath(root), 'user.txt'), 'utf8'), 'user-owned skill')
  const { options, dependencies } = configuration(root)
  await setup(options, dependencies)
  await uninstallInstallation({ stateRoot: options.stateRoot, keepData: true }, dependencies)
  assert.deepEqual((await readConfig(root)).mcp.servers['math-anchor'], original)
})

test('death after undo but before recording progress can resume the same recovery', async (t) => {
  const root = await fixture(t)
  await interrupt(root)
  await interrupt(root, 'before-commit', '--interrupt-recovery')
  const { options, dependencies } = configuration(root)
  await setup(options, dependencies)
  await uninstallInstallation({ stateRoot: options.stateRoot, keepData: true }, dependencies)
  assert.deepEqual((await readConfig(root)).mcp.servers['math-anchor'], original)
  assert.equal(await readFile(join(skillPath(root), 'user.txt'), 'utf8'), 'user-owned skill')
})

test('recovery rejects a replaced parent directory before writing through its new alias', async (t) => {
  const root = await fixture(t)
  await interrupt(root)
  const bytes = await readFile(join(root, 'home', 'config.json'))
  await rename(join(root, 'home'), join(root, 'moved-home'))
  await mkdir(join(root, 'other-home'))
  await symlink(join(root, 'other-home'), join(root, 'home'), process.platform === 'win32' ? 'junction' : 'dir')
  const { options, dependencies } = configuration(root)
  await assert.rejects(setup(options, dependencies), { code: 'ENVIRONMENT_RESOURCE_CHANGED' })
  assert.deepEqual(await readFile(join(root, 'moved-home', 'config.json')), bytes)
  await assert.rejects(lstat(join(root, 'other-home', 'config.json')), { code: 'ENOENT' })
})

test('an unrelated local preference mutation cannot implicitly recover external Host bindings', async (t) => {
  const root = await fixture(t)
  await interrupt(root)
  const before = await readConfig(root)
  let called = false
  await assert.rejects(withLifecycleMutation({ root: join(root, 'state') }, 'manager.language', {}, async () => {
    called = true
  }), { code: 'ENVIRONMENT_RECOVERY_REQUIRED' })
  assert.equal(called, false)
  assert.deepEqual(await readConfig(root), before)
})

test('a malformed private recovery record exposes no partial payload and changes no resources', async (t) => {
  const root = await fixture(t)
  await interrupt(root)
  const before = await readConfig(root)
  const payload = 'private-value-that-must-not-appear'
  await writeFile(join(root, 'state', '.environment-change.json'), `{"private":"${payload}`)
  const { options, dependencies } = configuration(root)
  await assert.rejects(setup(options, dependencies), (error) => {
    assert.equal(error.code, 'ENVIRONMENT_RECOVERY_REQUIRED')
    assert.equal(JSON.stringify({ message: error.message, details: error.details }).includes(payload), false)
    return true
  })
  assert.deepEqual(await readConfig(root), before)
})

test('field recovery treats constructor and __proto__ as data without changing object prototypes', async (t) => {
  const root = await fixture(t)
  const path = join(root, 'home', 'config.json')
  const before = JSON.parse('{"mcp":{"servers":{"constructor":{"command":"before"},"__proto__":{"command":"before"}}}}')
  await writeFile(path, JSON.stringify(before))
  const after = structuredClone(before)
  after.mcp.servers.constructor.command = 'after'
  after.mcp.servers.__proto__.command = 'after'
  await assert.rejects(withLifecycleMutation({ root: join(root, 'state') }, 'test.change', {}, async () => {
    await writeEnvironmentJson(path, after, [['mcp', 'servers', 'constructor'], ['mcp', 'servers', '__proto__']], before)
    throw new Error('injected failure after actual config write')
  }), /injected failure/u)
  assert.deepEqual(await readConfig(root), before)
  assert.equal(Object.hasOwn(Object.prototype, 'command'), false)
})

test('recovery does not recreate a configuration file the user removed during a pending change', async (t) => {
  const root = await fixture(t)
  const path = join(root, 'home', 'config.json')
  const before = await readConfig(root)
  const after = structuredClone(before)
  after['host-added'] = { binding: true }
  await assert.rejects(withLifecycleMutation({ root: join(root, 'state') }, 'test.change', {}, async () => {
    await writeEnvironmentJson(path, after, [['host-added']], before)
    await rm(path)
    throw new Error('injected failure after user removal')
  }), /injected failure after user removal/u)
  await assert.rejects(readFile(path), (error) => error.code === 'ENOENT')
})

test('recovery still blocks when a removed file held cells the pending change must restore', async (t) => {
  const root = await fixture(t)
  const path = join(root, 'home', 'config.json')
  const before = await readConfig(root)
  const after = structuredClone(before)
  after.preferences.theme = 'light'
  await assert.rejects(withLifecycleMutation({ root: join(root, 'state') }, 'test.change', {}, async () => {
    await writeEnvironmentJson(path, after, [['preferences', 'theme']], before)
    await rm(path)
    throw new Error('injected failure after user removal')
  }), { code: 'ENVIRONMENT_RECOVERY_REQUIRED' })
  await assert.rejects(readFile(path), (error) => error.code === 'ENOENT')
  const pointer = JSON.parse(await readFile(join(root, 'state', 'state.json'), 'utf8'))
  assert.equal(pointer.schemaVersion, CHANGE_STATE_SCHEMA)
})

test('a failed post-commit cleanup reports its limit without undoing committed bindings', async (t) => {
  const root = await fixture(t)
  const path = join(root, 'home', 'config.json')
  const before = await readConfig(root)
  const after = structuredClone(before)
  after.mcp.servers['math-anchor'].args = ['committed-value']
  const result = await withLifecycleMutation({ root: join(root, 'state') }, 'test.commit', {}, async (_dependencies, paths) => {
    await writeEnvironmentJson(path, after, [['mcp', 'servers', 'math-anchor']], before)
    await afterEnvironmentCommit(async () => { throw new Error('private cleanup error text') })
    const now = new Date().toISOString()
    await saveState(paths, { schemaVersion: STATE_SCHEMA, suiteVersion: '0.1.6', channel: 'development', profile: 'standard',
      installedAt: now, updatedAt: now, components: {}, hosts: {}, runtime: {}, observability: {} })
    return { status: 'committed' }
  })
  assert.equal(result.status, 'committed')
  assert.deepEqual(result.warnings.map((item) => item.code), ['ENVIRONMENT_CLEANUP_INCOMPLETE'])
  assert.equal(JSON.stringify(result).includes('private cleanup error text'), false)
  assert.deepEqual(await readConfig(root), after)
  assert.equal((await loadState(await readStatePaths(join(root, 'state')))).suiteVersion, '0.1.6')
})

async function claudeFixture(t) {
  const root = await fixture(t)
  const path = join(root, 'home', 'claude-config.json')
  const skill = join(root, 'home', '.claude', 'skills', 'agent-host-operations')
  await mkdir(skill, { recursive: true })
  await writeFile(join(skill, 'user.txt'), 'original Claude skill')
  const config = { preference: 'original', projects: { '/fixture-project': { mcpServers: { private: { command: 'untouched' } } } },
    mcpServers: {
      'math-anchor': { command: process.execPath, args: ['user path with spaces', '', 'line\nbreak'], env: { HEADER: 'exact value' } },
      migratory_time: { type: 'http', url: 'https://example.invalid/user-mcp', headers: { Authorization: 'fixture-only' } },
    } }
  await writeFile(path, JSON.stringify(config))
  return { root, path, skill, config, read: async () => JSON.parse(await readFile(path, 'utf8')) }
}

test('interrupted Claude setup restores complete user JSON and aliases before retrying installation', async (t) => {
  const f = await claudeFixture(t)
  await interrupt(f.root, 'before-commit', '--interrupt', 'claude')
  assert.equal((await lstat(f.skill)).isSymbolicLink(), true)
  const changed = await f.read()
  changed.preference = 'later user edit'
  await writeFile(f.path, JSON.stringify(changed))
  const { options, dependencies } = configuration(f.root, 'claude')
  await setup(options, dependencies)
  const state = await loadState(await readStatePaths(options.stateRoot))
  const time = state.hosts.claude.entries.find((entry) => entry.name === 'migratory-time')
  assert.deepEqual(time.displaced, { name: 'migratory_time', config: f.config.mcpServers.migratory_time })
  await uninstallInstallation({ stateRoot: options.stateRoot, keepData: true }, dependencies)
  assert.deepEqual(await f.read(), { ...f.config, preference: 'later user edit' })
  assert.equal(await readFile(join(f.skill, 'user.txt'), 'utf8'), 'original Claude skill')
  assert.deepEqual((await readConfig(f.root)).mcp.servers['math-anchor'], original, 'The separate ZCode fixture is untouched')
})

test('interrupted Claude uninstall restores committed bindings and projection ownership before retry', async (t) => {
  const f = await claudeFixture(t)
  const { options, dependencies } = configuration(f.root, 'claude')
  await setup(options, dependencies)
  await interrupt(f.root, 'before-commit', '--interrupt-uninstall', 'claude')
  assert.deepEqual(await f.read(), f.config)
  await uninstallInstallation({ stateRoot: options.stateRoot, keepData: true }, dependencies)
  assert.deepEqual(await f.read(), f.config)
  assert.equal(await readFile(join(f.skill, 'user.txt'), 'utf8'), 'original Claude skill')
  assert.equal(await loadState(await readStatePaths(options.stateRoot)), null)
})

test('a Claude tool-set transition preserves a later user binding through failure, explicit replacement and final uninstall', async (t) => {
  const f = await claudeFixture(t)
  const { options, dependencies: base } = configuration(f.root, 'claude')
  const dependencies = { ...base, applicationStatePreflight: compatibleApplicationState }
  await setup(options, dependencies)
  const paths = await readStatePaths(options.stateRoot)
  const beforeState = await loadState(paths)
  const userBinding = { type: 'stdio', command: process.execPath, args: ['later user choice', ''], env: { USER_VALUE: 'kept' } }
  const later = await f.read()
  later.mcpServers['math-anchor'] = userBinding
  await writeFile(f.path, JSON.stringify(later))
  await assert.rejects(setActiveTools({ stateRoot: paths.root, tools: ['math-anchor'] }, dependencies))
  assert.deepEqual(await f.read(), later)
  assert.deepEqual(await loadState(paths), beforeState)
  await setActiveTools({ stateRoot: paths.root, tools: ['math-anchor'], replaceHostConflicts: true }, dependencies)
  const changed = await loadState(paths)
  assert.deepEqual(changed.hosts.claude.entries.find((entry) => entry.name === 'math-anchor').displaced.config, userBinding)
  assert.equal(changed.hosts.claude.inactiveEntries.some((entry) => entry.name === 'migratory-time'), true)
  await uninstallInstallation({ stateRoot: paths.root, keepData: true }, dependencies)
  assert.deepEqual(await f.read(), { ...f.config, mcpServers: { ...f.config.mcpServers, 'math-anchor': userBinding } })
})

test('nested lifecycle work keeps the canonical journal owner through a requested path alias', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-nested-journal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const actual = join(root, 'actual')
  const alias = join(root, 'alias')
  await mkdir(actual)
  await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const stateRoot = join(alias, 'state')
  const resource = join(actual, 'config.json')
  await writeFile(resource, '{"selected":"before"}')
  await withLifecycleMutation({ root: stateRoot }, 'fixture.outer', {}, async (locked, paths) => {
    const before = { schemaVersion: STATE_SCHEMA, suiteVersion: '0.1.6', channel: 'development', profile: 'standard',
      installedAt: '2026-09-06T00:00:00Z', updatedAt: '2026-09-06T00:00:00Z', components: {}, hosts: {}, runtime: {}, observability: { enabled: false } }
    await saveState(paths, before)
    await withLifecycleMutation({ root: stateRoot }, 'fixture.nested', locked, async (_inherited, nested) => {
      await writeEnvironmentJson(resource, { selected: 'after' }, [['selected']])
      assert.equal(nested.root, paths.root)
      assert.deepEqual(await loadState(nested), before)
      await saveState(nested, { ...before, updatedAt: '2026-09-06T01:00:00Z' })
    })
  })
  assert.equal(JSON.parse(await readFile(resource, 'utf8')).selected, 'after')
  assert.equal((await loadState(await readStatePaths(stateRoot))).updatedAt, '2026-09-06T01:00:00Z')
})
