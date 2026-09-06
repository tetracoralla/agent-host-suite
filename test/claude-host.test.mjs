import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { inspectClaude, installClaude, resolveClaudeConfigPath, suspendClaude, uninstallClaude } from '../src/hosts/claude.mjs'

const prefix = ['--disable-slash-commands', '--no-chrome', '--setting-sources', 'user']
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-claude-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configPath = join(root, '.claude.json')
  const manifest = { components: {
    'math-anchor': { command: process.execPath, args: ['mcp'] },
    'migratory-time': { command: process.execPath, args: ['/provider/time.mjs'] },
  } }
  const config = { projects: { '/project/only': { mcpServers: { 'project-private': { type: 'http', url: 'https://example.invalid/private' } } } },
    mcpServers: { 'math-anchor': { command: process.execPath, args: ['mcp'] },
      migratory_time: { command: process.execPath, args: ['/provider/time.mjs'] } } }
  const write = async (value) => writeFile(configPath, JSON.stringify(value))
  const read = async () => JSON.parse(await readFile(configPath, 'utf8'))
  await write(config)
  const calls = []
  const runner = async (command, args) => {
    calls.push({ command, args })
    if (command === 'where.exe' || (command === '/usr/bin/env' && args[0] === 'which')) return { status: 0, stdout: '/fixture/claude\n', stderr: '' }
    assert.deepEqual(args, [...prefix, '--version'], 'No human binding rendering or Provider health query is needed')
    return { status: 0, stdout: '2.1.233\n', stderr: '' }
  }
  return { root, configPath, manifest, config, read, write, runner, calls, options: { configPath } }
}

test('Claude adopts equivalent aliases, installs only the new user binding, and leaves project entries untouched', async (t) => {
  const f = await fixture(t)
  f.manifest.components.armorial = { command: process.execPath, args: ['/provider/armorial.mjs'] }
  const state = await installClaude(f.manifest, f.runner, null, f.options)
  assert.deepEqual(state.entries.map((entry) => [entry.actualName, entry.created, entry.adopted]), [
    ['math-anchor', false, true], ['migratory_time', false, true], ['armorial', true, false],
  ])
  assert.deepEqual((await f.read()).projects, f.config.projects)
  assert.deepEqual((await f.read()).mcpServers.armorial.args, ['/provider/armorial.mjs'])
  await uninstallClaude(state, async () => { throw new Error('Removal must not need an installed CLI') })
  assert.deepEqual(await f.read(), f.config)
})

test('Claude stores exact workspace environment and retains the saved grant when unchanged', async (t) => {
  const f = await fixture(t)
  f.manifest.components.armorial = { command: process.execPath, args: [], workspaceEnvironment: ['ALPHA', 'BETA'] }
  await assert.rejects(installClaude(f.manifest, f.runner, null, f.options), { code: 'WORKSPACE_GRANT_REQUIRED' })
  assert.deepEqual(await f.read(), f.config)
  const state = await installClaude(f.manifest, f.runner, { workspaceRoot: '/work/approved', entries: [] }, f.options)
  assert.equal(state.workspaceRoot, '/work/approved')
  assert.deepEqual((await f.read()).mcpServers.armorial, { type: 'stdio', command: process.execPath, args: [], env: { ALPHA: '/work/approved', BETA: '/work/approved' } })
  const changedOrder = await f.read()
  changedOrder.mcpServers.armorial.env = { BETA: '/work/approved', ALPHA: '/work/approved' }
  await f.write(changedOrder)
  const current = await inspectClaude(f.manifest, f.runner, state)
  assert.equal(current.entries.find((entry) => entry.name === 'armorial').identityMatched, true)
})

test('Claude preserves complete displaced JSON, spaced and empty argv, environment and unrelated user settings', async (t) => {
  const f = await fixture(t)
  f.config.mcpServers['math-anchor'] = { type: 'stdio', command: process.execPath,
    args: ['/server with spaces.mjs', '', '--header', 'X Custom: one two'], env: { SECRET_FIXTURE: 'first\nsecond' }, custom: { preserve: true } }
  await f.write(f.config)
  await assert.rejects(installClaude(f.manifest, f.runner, null, f.options), { code: 'CLAUDE_MCP_CONFLICT' })
  const state = await installClaude(f.manifest, f.runner, null, { ...f.options, replaceConflicts: true })
  assert.deepEqual(state.entries[0].displaced.config, f.config.mcpServers['math-anchor'])
  const later = await f.read()
  later.preference = 'new user value'
  await f.write(later)
  await uninstallClaude(state)
  assert.deepEqual(await f.read(), { ...f.config, preference: 'new user value' })
})

test('a displaced non-stdio alias is restored with its original transport and headers', async (t) => {
  const f = await fixture(t)
  f.config.mcpServers.migratory_time = { type: 'http', url: 'https://example.invalid/mcp', headers: { Authorization: 'fixture-only' } }
  await f.write(f.config)
  const state = await installClaude(f.manifest, f.runner, null, { ...f.options, replaceConflicts: true })
  const installed = await f.read()
  assert.equal(Object.hasOwn(installed.mcpServers, 'migratory_time'), false)
  assert.equal(installed.mcpServers['migratory-time'].type, 'stdio')
  await uninstallClaude(state)
  assert.deepEqual(await f.read(), f.config)
})

test('spaced, empty and newline arguments match their exact user binding without a rewrite', async (t) => {
  const f = await fixture(t)
  const args = ['/provider with spaces.mjs', '', 'first\nsecond']
  f.manifest.components['migratory-time'].args = args
  f.config.mcpServers.migratory_time.args = args
  await f.write(f.config)
  const before = await readFile(f.configPath, 'utf8')
  const state = await installClaude(f.manifest, f.runner, null, f.options)
  assert.equal(state.entries.find((entry) => entry.component === 'migratory-time').adopted, true)
  assert.equal(await readFile(f.configPath, 'utf8'), before)
})

test('an owned release update uses the previous exact binding and keeps original displacement', async (t) => {
  const f = await fixture(t)
  f.config.mcpServers.migratory_time.args = ['/user/original with spaces.mjs']
  await f.write(f.config)
  let state = await installClaude(f.manifest, f.runner, null, { ...f.options, replaceConflicts: true })
  f.manifest.components['migratory-time'].args = ['/next/provider with spaces.mjs', '']
  state = await installClaude(f.manifest, f.runner, state)
  assert.deepEqual((await f.read()).mcpServers['migratory-time'].args, f.manifest.components['migratory-time'].args)
  await uninstallClaude(state)
  assert.deepEqual(await f.read(), f.config)
})

test('invalid configuration and duplicate aliases fail before any user binding changes', async (t) => {
  const f = await fixture(t)
  for (const bytes of ['{private-fixture-invalid', '{"mcpServers":[]}', '{"mcpServers":{"math-anchor":null}}']) {
    await writeFile(f.configPath, bytes)
    await assert.rejects(installClaude(f.manifest, f.runner, null, f.options), { code: 'CLAUDE_CONFIG_INVALID' })
    assert.equal(await readFile(f.configPath, 'utf8'), bytes)
  }
  f.config.mcpServers['migratory-time'] = f.config.mcpServers.migratory_time
  await f.write(f.config)
  await assert.rejects(installClaude(f.manifest, f.runner, null, f.options), { code: 'CLAUDE_MCP_CONFLICT' })
  assert.deepEqual(await f.read(), f.config)
})

test('a changed config during version discovery is preserved instead of overwritten', async (t) => {
  const f = await fixture(t)
  const later = structuredClone(f.config)
  later.mcpServers['math-anchor'].args = ['user-change-during-inspection']
  const runner = async (command, args) => {
    const result = await f.runner(command, args)
    if (args.at(-1) === '--version') await f.write(later)
    return result
  }
  await assert.rejects(installClaude(f.manifest, runner, null, f.options), { code: 'CLAUDE_CONFIG_CHANGED' })
  assert.deepEqual(await f.read(), later)
})

test('later edits to an owned binding are preserved on uninstall and block suspension or implicit replacement', async (t) => {
  const f = await fixture(t)
  f.manifest.components.armorial = { command: process.execPath, args: ['original'] }
  const state = await installClaude(f.manifest, f.runner, null, f.options)
  const later = await f.read()
  later.mcpServers.armorial.args = ['user-edit']
  await f.write(later)
  const owned = { ...state, entries: state.entries.filter((entry) => entry.created) }
  await assert.rejects(suspendClaude(owned), { code: 'CLAUDE_MCP_CHANGED' })
  await assert.rejects(installClaude(f.manifest, f.runner, state), { code: 'CLAUDE_MCP_CHANGED' })
  const removed = await uninstallClaude(state)
  assert.equal(removed.removed.find((entry) => entry.target === 'armorial').status, 'preserved-user-change')
  assert.deepEqual(await f.read(), later)
})

test('an occupied displaced alias rejects removal before any of the planned writes', async (t) => {
  const f = await fixture(t)
  f.config.mcpServers.migratory_time.args = ['user-original']
  await f.write(f.config)
  const state = await installClaude(f.manifest, f.runner, null, { ...f.options, replaceConflicts: true })
  const later = await f.read()
  later.mcpServers.migratory_time = { command: 'new-user-alias' }
  await f.write(later)
  await assert.rejects(uninstallClaude(state), { code: 'CLAUDE_MCP_CHANGED' })
  assert.deepEqual(await f.read(), later)
})

test('explicit replacement of a later user edit preserves that edit as the new displacement', async (t) => {
  const f = await fixture(t)
  f.manifest.components.armorial = { command: process.execPath, args: ['owned'] }
  let state = await installClaude(f.manifest, f.runner, null, f.options)
  const later = await f.read()
  later.mcpServers.armorial = { type: 'http', url: 'https://example.invalid/user-replacement', headers: { token: 'fixture' } }
  await f.write(later)
  state = await installClaude(f.manifest, f.runner, state, { replaceConflicts: true })
  await uninstallClaude(state)
  assert.deepEqual(await f.read(), later)
})

test('uninstall preserves a user-deleted active binding while intentionally suspended entries can restore displacement', async (t) => {
  const f = await fixture(t)
  f.config.mcpServers['math-anchor'].args = ['user-original']
  await f.write(f.config)
  const state = await installClaude(f.manifest, f.runner, null, { ...f.options, replaceConflicts: true })
  const owned = state.entries.find((entry) => entry.name === 'math-anchor')
  const later = await f.read()
  delete later.mcpServers['math-anchor']
  await f.write(later)
  await uninstallClaude(state)
  assert.deepEqual(await f.read(), later)
  await uninstallClaude({ ...state, entries: [owned], inactiveEntries: [owned] })
  assert.deepEqual(await f.read(), f.config)
})

test('legacy lossy displacement is not promoted to a successful exact restore', async (t) => {
  const f = await fixture(t)
  f.manifest.components.armorial = { command: process.execPath, args: ['current'] }
  const state = await installClaude(f.manifest, f.runner, null, f.options)
  const entry = state.entries.find((item) => item.name === 'armorial')
  entry.displaced = { name: 'armorial', command: process.execPath, args: ['one', 'two'], argsText: 'one two', argsExact: false, environment: {} }
  const before = await f.read()
  await assert.rejects(uninstallClaude(state), { code: 'CLAUDE_MCP_RESTORE_UNVERIFIABLE' })
  assert.deepEqual(await f.read(), before)
  entry.displaced.argsExact = true
  delete entry.binding
  await uninstallClaude(state)
  assert.deepEqual((await f.read()).mcpServers.armorial.args, ['one', 'two'])
})

test('fresh explicit configuration roots stay isolated and retained paths survive later default changes', async (t) => {
  const f = await fixture(t)
  const configRoot = join(f.root, 'fresh-directory')
  assert.equal(resolveClaudeConfigPath({ configRoot }), join(configRoot, '.claude.json'))
  assert.equal(resolveClaudeConfigPath({ homeRoot: f.root }), f.configPath)
  await assert.rejects(lstat(configRoot), { code: 'ENOENT' })
  const state = await installClaude(f.manifest, f.runner, null, { configRoot })
  assert.equal(state.configPath, join(configRoot, '.claude.json'))
  await uninstallClaude(state)
  assert.deepEqual(await f.read(), f.config)
  assert.deepEqual(JSON.parse(await readFile(state.configPath, 'utf8')).mcpServers, {})
})
