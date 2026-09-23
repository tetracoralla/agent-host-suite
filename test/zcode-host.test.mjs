import assert from 'node:assert/strict'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { installZcode, inspectZcode, suspendZcode, uninstallZcode } from '../src/hosts/zcode.mjs'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-zcode-test-'))
  const configPath = join(root, '.zcode', 'cli', 'config.json')
  const workspaceRoot = join(root, 'workspace')
  const command = process.execPath
  const previous = {
    command,
    args: ['/source/math.mjs'],
    cwd: '/source',
    enabled: true,
  }
  const config = {
    plugins: { enabledPlugins: { 'user-plugin@example': true } },
    mcp: {
      servers: {
        'math-anchor': previous,
        unrelated: { command, args: ['unrelated'], enabled: false },
      },
    },
  }
  await import('node:fs/promises').then(({ mkdir }) => mkdir(join(root, '.zcode', 'cli'), { recursive: true }))
  await import('node:fs/promises').then(({ mkdir }) => mkdir(workspaceRoot, { recursive: true }))
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
  const manifest = {
    components: {
      'math-anchor': {
        command,
        args: ['mcp'],
        cwd: root,
        workspaceEnvironment: ['MATH_WORKSPACE_ROOT'],
        healthTimeoutMs: 12_000,
      },
      backstage: { command, args: ['ignored'], skillOnly: true },
    },
  }
  const runner = async (_command, args) => {
    if (args[0] === 'version') return { status: 0, stdout: '{"version":"0.16.5"}\n', stderr: '' }
    throw new Error(`unexpected command: ${args.join(' ')}`)
  }
  return { root, configPath, workspaceRoot, previous, manifest, runner }
}

async function readConfig(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

test('ZCode adapter replaces only selected source bindings and restores them exactly', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.root, { recursive: true, force: true }))
  const installed = await installZcode(item.manifest, item.runner, null, {
    configPath: item.configPath,
    executable: process.execPath,
    workspaceRoot: item.workspaceRoot,
    replaceConflicts: true,
  })
  assert.equal(installed.version, '0.16.5')
  assert.equal(installed.entries.length, 1)
  assert.equal(installed.entries[0].created, true)
  assert.deepEqual(installed.entries[0].displaced, item.previous)
  const active = await readConfig(item.configPath)
  assert.deepEqual(active.mcp.servers['math-anchor'], {
    type: 'stdio', command: process.execPath, args: ['mcp'], cwd: item.root,
    env: { MATH_WORKSPACE_ROOT: item.workspaceRoot }, enabled: true, timeoutMs: 12_000,
  })
  assert.deepEqual(active.mcp.servers.unrelated, { command: process.execPath, args: ['unrelated'], enabled: false })
  assert.deepEqual(active.plugins, { enabledPlugins: { 'user-plugin@example': true } })

  const removed = await uninstallZcode(installed)
  assert.equal(removed.removed[0].kind, 'restored-mcp')
  assert.deepEqual((await readConfig(item.configPath)).mcp.servers['math-anchor'], item.previous)
})

test('ZCode adapter fails closed on an unmanaged conflict without changing config', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.root, { recursive: true, force: true }))
  const before = await readFile(item.configPath, 'utf8')
  await assert.rejects(installZcode(item.manifest, item.runner, null, {
    configPath: item.configPath,
    executable: process.execPath,
    workspaceRoot: item.workspaceRoot,
  }), (error) => error.code === 'ZCODE_MCP_CONFLICT')
  assert.equal(await readFile(item.configPath, 'utf8'), before)
})

test('ZCode uninstall preserves a binding changed by the user after installation', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.root, { recursive: true, force: true }))
  const installed = await installZcode(item.manifest, item.runner, null, {
    configPath: item.configPath,
    executable: process.execPath,
    workspaceRoot: item.workspaceRoot,
    replaceConflicts: true,
  })
  const changed = await readConfig(item.configPath)
  changed.mcp.servers['math-anchor'] = { command: process.execPath, args: ['user-change'], enabled: true }
  await writeFile(item.configPath, `${JSON.stringify(changed, null, 2)}\n`)
  const result = await uninstallZcode(installed)
  assert.equal(result.removed[0].status, 'preserved-user-change')
  assert.deepEqual((await readConfig(item.configPath)).mcp.servers['math-anchor'], changed.mcp.servers['math-anchor'])
})

test('ZCode later edits block rebind and suspension; explicit replacement restores the latest edit', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.root, { recursive: true, force: true }))
  const options = { configPath: item.configPath, executable: process.execPath, workspaceRoot: item.workspaceRoot }
  const installed = await installZcode(item.manifest, item.runner, null, { ...options, replaceConflicts: true })
  const changed = await readConfig(item.configPath)
  // Even an additional user field must not be silently discarded by a grant
  // rebind, on-demand transition, or uninstall.
  changed.mcp.servers['math-anchor'].userNote = 'keep my customization'
  await writeFile(item.configPath, JSON.stringify(changed))
  const before = await readFile(item.configPath, 'utf8')
  await assert.rejects(installZcode(item.manifest, item.runner, installed, options), { code: 'ZCODE_MCP_CHANGED' })
  await assert.rejects(suspendZcode(installed), { code: 'ZCODE_MCP_CHANGED' })
  assert.equal(await readFile(item.configPath, 'utf8'), before)
  const removed = await uninstallZcode(installed)
  assert.equal(removed.removed[0].status, 'preserved-user-change')
  assert.deepEqual(await readConfig(item.configPath), changed)
  const replaced = await installZcode(item.manifest, item.runner, installed, { ...options, replaceConflicts: true })
  assert.deepEqual(replaced.entries[0].displaced, changed.mcp.servers['math-anchor'])
  await uninstallZcode(replaced)
  assert.deepEqual(await readConfig(item.configPath), changed)
})

test('ZCode uninstall completes without recreating a user-removed configuration file', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.root, { recursive: true, force: true }))
  const installed = await installZcode(item.manifest, item.runner, null, {
    configPath: item.configPath,
    executable: process.execPath,
    workspaceRoot: item.workspaceRoot,
    replaceConflicts: true,
  })
  await rm(item.configPath)
  const result = await uninstallZcode(installed)
  assert.equal(result.removed[0].status, 'preserved-user-change')
  await assert.rejects(lstat(item.configPath), (error) => error.code === 'ENOENT')
})

test('ZCode uninstall tolerates a wholly removed configuration directory', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.root, { recursive: true, force: true }))
  const installed = await installZcode(item.manifest, item.runner, null, {
    configPath: item.configPath,
    executable: process.execPath,
    workspaceRoot: item.workspaceRoot,
    replaceConflicts: true,
  })
  await rm(join(item.root, '.zcode'), { recursive: true, force: true })
  const result = await uninstallZcode(installed)
  assert.equal(result.removed[0].status, 'preserved-user-change')
})

test('ZCode suspension removes an owned active tool while inspection stays read-only', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.root, { recursive: true, force: true }))
  const installed = await installZcode(item.manifest, item.runner, null, {
    configPath: item.configPath,
    executable: process.execPath,
    workspaceRoot: item.workspaceRoot,
    replaceConflicts: true,
  })
  const before = await readFile(item.configPath, 'utf8')
  const inspection = await inspectZcode(item.manifest, item.runner, installed, {
    executable: process.execPath,
    workspaceRoot: item.workspaceRoot,
  })
  assert.equal(inspection.entries[0].identityMatched, true)
  assert.equal(await readFile(item.configPath, 'utf8'), before)
  await suspendZcode(installed)
  assert.equal((await readConfig(item.configPath)).mcp.servers['math-anchor'], undefined)
})

test('ZCode recognizes independent underscore names and restores them after suspension', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.root, { recursive: true, force: true }))
  const config = await readConfig(item.configPath)
  config.mcp.servers.math_anchor = config.mcp.servers['math-anchor']
  delete config.mcp.servers['math-anchor']
  await writeFile(item.configPath, JSON.stringify(config))
  const options = { configPath: item.configPath, executable: process.execPath, workspaceRoot: item.workspaceRoot }
  await assert.rejects(installZcode(item.manifest, item.runner, null, options), { code: 'ZCODE_MCP_CONFLICT' })
  assert.deepEqual(await readConfig(item.configPath), config)
  const installed = await installZcode(item.manifest, item.runner, null, { ...options, replaceConflicts: true })
  assert.equal(installed.entries[0].name, 'math_anchor')
  assert.equal((await readConfig(item.configPath)).mcp.servers['math-anchor'], undefined)
  await suspendZcode(installed)
  assert.equal((await readConfig(item.configPath)).mcp.servers.math_anchor, undefined)
  const resumed = await installZcode(item.manifest, item.runner, installed, options)
  assert.equal(resumed.entries[0].name, 'math_anchor')
  await suspendZcode(resumed)
  await uninstallZcode({ ...resumed, inactiveEntries: resumed.entries })
  assert.deepEqual(await readConfig(item.configPath), config)
})

test('ZCode refuses ambiguous aliases without changing either entry', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.root, { recursive: true, force: true }))
  const config = await readConfig(item.configPath)
  config.mcp.servers.math_anchor = { ...item.previous, enabled: false }
  await writeFile(item.configPath, JSON.stringify(config))
  await assert.rejects(installZcode(item.manifest, item.runner, null, {
    configPath: item.configPath, executable: process.execPath, workspaceRoot: item.workspaceRoot, replaceConflicts: true,
  }), { code: 'ZCODE_MCP_CONFLICT' })
  assert.deepEqual(await readConfig(item.configPath), config)
})
