import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectClaude, installClaude, uninstallClaude } from '../src/hosts/claude.mjs'

const userConfigPrefix = ['--disable-slash-commands', '--no-chrome', '--setting-sources', 'user']

function userConfigCommand(args) {
  assert.deepEqual(args.slice(0, userConfigPrefix.length), userConfigPrefix)
  return args.slice(userConfigPrefix.length)
}

function fixture() {
  const manifest = {
    components: {
      'math-anchor': { command: process.execPath, args: ['mcp'] },
      'migratory-time': { command: process.execPath, args: ['/provider/time.mjs'] },
    },
  }
  const mutations = []
  const runner = async (command, args, options = {}) => {
    if (command === 'where.exe' || (command === '/usr/bin/env' && args[0] === 'which')) return { status: 0, stdout: '/usr/bin/claude\n', stderr: '' }
    const commandArgs = userConfigCommand(args)
    if (commandArgs[0] === '--version') return { status: 0, stdout: '2.1.233\n', stderr: '' }
    if (commandArgs[0] === 'mcp' && commandArgs[1] === 'get') {
      if (commandArgs[2] === 'math-anchor') return { status: 0, stdout: `Command: ${process.execPath}\nArgs: mcp\n`, stderr: '' }
      if (commandArgs[2] === 'migratory_time') return { status: 0, stdout: `Command: ${process.execPath}\nArgs: /provider/time.mjs\n`, stderr: '' }
      return { status: 1, stdout: `No MCP server named "${commandArgs[2]}".\n`, stderr: '' }
    }
    mutations.push([command, commandArgs, options])
    return { status: 0, stdout: '', stderr: '' }
  }
  return { manifest, mutations, runner }
}

test('Claude adapter adopts equivalent existing aliases without mutating user configuration', async () => {
  const fake = fixture()
  fake.manifest.components.armorial = { command: process.execPath, args: ['/provider/armorial.mjs'] }
  const installed = await installClaude(fake.manifest, fake.runner)
  assert.deepEqual(installed.entries.map((entry) => [entry.actualName, entry.created, entry.adopted]), [
    ['math-anchor', false, true],
    ['migratory_time', false, true],
    ['armorial', true, false],
  ])
  await uninstallClaude(installed, fake.runner)
  assert.deepEqual(fake.mutations.map(([, args]) => args), [
    ['mcp', 'add', '--scope', 'user', 'armorial', '--', process.execPath, '/provider/armorial.mjs'],
    ['mcp', 'remove', '--scope', 'user', 'armorial'],
  ])
})

test('Claude adapter binds a generic workspace-aware component with exact environment', async () => {
  const fake = fixture()
  fake.manifest.components['data-transformer'] = {
    command: process.execPath,
    args: ['/provider/data.mjs'],
    workspaceEnvironment: ['ADT_WORKSPACE_ROOT'],
  }
  const workspaceRoot = '/work/approved'
  const installed = await installClaude(fake.manifest, fake.runner, null, { workspaceRoot })
  assert.equal(installed.workspaceRoot, workspaceRoot)
  assert.deepEqual(
    fake.mutations.map(([, args]) => args).find((args) => args.includes('data-transformer')),
    ['mcp', 'add', '--scope', 'user', 'data-transformer', '-e', `ADT_WORKSPACE_ROOT=${workspaceRoot}`, '--', process.execPath, '/provider/data.mjs'],
  )
})

test('Claude adapter retains the managed workspace grant when a caller omits an unchanged option', async () => {
  const fake = fixture()
  fake.manifest.components['data-transformer'] = {
    command: process.execPath,
    args: ['/provider/data.mjs'],
    workspaceEnvironment: ['ADT_WORKSPACE_ROOT'],
  }
  const installed = await installClaude(fake.manifest, fake.runner, { workspaceRoot: '/work/managed', entries: [] })
  assert.equal(installed.workspaceRoot, '/work/managed')
  assert.deepEqual(
    fake.mutations.map(([, args]) => args).find((args) => args.includes('data-transformer')),
    ['mcp', 'add', '--scope', 'user', 'data-transformer', '-e', 'ADT_WORKSPACE_ROOT=/work/managed', '--', process.execPath, '/provider/data.mjs'],
  )
})

test('Claude adapter rejects a workspace-aware component without an explicit grant', async () => {
  const fake = fixture()
  fake.manifest.components['data-transformer'] = {
    command: process.execPath,
    args: ['/provider/data.mjs'],
    workspaceEnvironment: ['ADT_WORKSPACE_ROOT'],
  }
  await assert.rejects(inspectClaude(fake.manifest, fake.runner), (error) => error.code === 'WORKSPACE_GRANT_REQUIRED')
  assert.deepEqual(fake.mutations, [])
})

test('Claude adapter reads environment entries independently of reported order', async () => {
  const fake = fixture()
  fake.manifest.components.armorial = {
    command: process.execPath,
    args: ['/provider/armorial.mjs'],
    workspaceEnvironment: ['ALPHA', 'BETA'],
  }
  const base = fake.runner
  fake.runner = async (command, args, options) => {
    const commandArgs = command === '/usr/bin/claude' ? userConfigCommand(args) : args
    if (commandArgs[0] === 'mcp' && commandArgs[1] === 'get' && commandArgs[2] === 'armorial') {
      return {
        status: 0,
        stdout: `Command: ${process.execPath}\nArgs: /provider/armorial.mjs\nEnvironment:\n  BETA=/work/approved\n  ALPHA=/work/approved\n\nTo remove this server, run: claude mcp remove armorial -s user\n`,
        stderr: '',
      }
    }
    return base(command, args, options)
  }
  const inspected = await inspectClaude(fake.manifest, fake.runner, null, { workspaceRoot: '/work/approved' })
  assert.equal(inspected.entries.find((entry) => entry.name === 'armorial').identityMatched, true)
})

test('Claude adapter keeps an empty Args line separate from the Environment heading', async () => {
  const fake = fixture()
  fake.manifest.components['release-parity'] = {
    command: process.execPath,
    args: [],
    workspaceEnvironment: ['RELEASE_PARITY_WORKSPACE_ROOT'],
  }
  const base = fake.runner
  fake.runner = async (command, args, options) => {
    const commandArgs = command === '/usr/bin/claude' ? userConfigCommand(args) : args
    if (commandArgs[0] === 'mcp' && commandArgs[1] === 'get' && commandArgs[2] === 'release-parity') {
      return {
        status: 0,
        stdout: `Command: ${process.execPath}\nArgs:\nEnvironment:\n  RELEASE_PARITY_WORKSPACE_ROOT=/work/approved\n\nTo remove this server, run: claude mcp remove release-parity -s user\n`,
        stderr: '',
      }
    }
    return base(command, args, options)
  }
  const inspected = await inspectClaude(fake.manifest, fake.runner, null, { workspaceRoot: '/work/approved' })
  const entry = inspected.entries.find((value) => value.name === 'release-parity')
  assert.deepEqual(entry.existingBinding.args, [])
  assert.equal(entry.identityMatched, true)
})

test('Claude adapter refuses a different unmanaged binding', async () => {
  const fake = fixture()
  const base = fake.runner
  fake.runner = async (command, args, options) => {
    const commandArgs = command === '/usr/bin/claude' ? userConfigCommand(args) : args
    if (commandArgs[0] === 'mcp' && commandArgs[1] === 'get' && commandArgs[2] === 'math-anchor') {
      return { status: 0, stdout: 'Command: /different/math\nArgs: mcp\n', stderr: '' }
    }
    return base(command, args, options)
  }
  await assert.rejects(installClaude(fake.manifest, fake.runner), (error) => error.code === 'CLAUDE_MCP_CONFLICT')
})

test('Claude adapter does not mistake an inspection failure for an absent server', async () => {
  const fake = fixture()
  const base = fake.runner
  fake.runner = async (command, args, options) => {
    const commandArgs = command === '/usr/bin/claude' ? userConfigCommand(args) : args
    if (commandArgs[0] === 'mcp' && commandArgs[1] === 'get' && commandArgs[2] === 'math-anchor') {
      return { status: 1, stdout: '', stderr: 'temporary configuration failure' }
    }
    return base(command, args, options)
  }
  await assert.rejects(installClaude(fake.manifest, fake.runner), (error) => error.code === 'CLAUDE_MCP_INSPECTION_FAILED')
  assert.deepEqual(fake.mutations, [])
})

test('Claude adapter restores a removed binding when replacement fails', async () => {
  const fake = fixture()
  const base = fake.runner
  fake.runner = async (command, args, options = {}) => {
    const commandArgs = command === '/usr/bin/claude' ? userConfigCommand(args) : args
    if (commandArgs[0] === 'mcp' && commandArgs[1] === 'get' && commandArgs[2] === 'math-anchor') {
      return { status: 0, stdout: 'Command: /previous/math\nArgs: mcp\n', stderr: '' }
    }
    if (commandArgs[0] === 'mcp' && commandArgs[1] === 'add' && commandArgs[4] === 'math-anchor' && commandArgs[6] === process.execPath) {
      fake.mutations.push([command, commandArgs, options])
      throw new Error('replacement failed')
    }
    return base(command, args, options)
  }
  await assert.rejects(
    installClaude(fake.manifest, fake.runner, null, { replaceConflicts: true }),
    /replacement failed/u,
  )
  assert.deepEqual(fake.mutations.map(([, args]) => args), [
    ['mcp', 'remove', '--scope', 'user', 'math-anchor'],
    ['mcp', 'add', '--scope', 'user', 'math-anchor', '--', process.execPath, 'mcp'],
    ['mcp', 'add', '--scope', 'user', 'math-anchor', '--', '/previous/math', 'mcp'],
  ])
})

test('Claude adapter preserves an expected single argument containing spaces', async () => {
  const fake = fixture()
  const path = '/opt/openadam-example/Agent Host/server.mjs'
  fake.manifest.components['migratory-time'].args = [path]
  const base = fake.runner
  fake.runner = async (command, args, options) => {
    const commandArgs = command === '/usr/bin/claude' ? userConfigCommand(args) : args
    if (commandArgs[0] === 'mcp' && commandArgs[1] === 'get' && commandArgs[2] === 'migratory_time') {
      return { status: 0, stdout: `Command: ${process.execPath}\nArgs: ${path}\n`, stderr: '' }
    }
    return base(command, args, options)
  }
  const installed = await installClaude(fake.manifest, fake.runner)
  assert.equal(installed.entries.find((entry) => entry.component === 'migratory-time').identityMatched, true)
  assert.deepEqual(fake.mutations, [])
})

test('Claude adapter preserves the previous managed argument containing spaces during a release update', async () => {
  const fake = fixture()
  const previousPath = '/opt/openadam-example/Agent Host/old-server.mjs'
  const nextPath = '/opt/openadam-example/Agent Host/new-server.mjs'
  fake.manifest.components['migratory-time'].args = [nextPath]
  const base = fake.runner
  fake.runner = async (command, args, options) => {
    const commandArgs = command === '/usr/bin/claude' ? userConfigCommand(args) : args
    if (commandArgs[0] === 'mcp' && commandArgs[1] === 'get' && commandArgs[2] === 'migratory_time') {
      return { status: 0, stdout: `Command: ${process.execPath}\nArgs: ${previousPath}\n`, stderr: '' }
    }
    return base(command, args, options)
  }
  const current = await inspectClaude(fake.manifest, fake.runner, {
    entries: [{ component: 'migratory-time', created: true, args: [previousPath] }],
  })
  const entry = current.entries.find((item) => item.component === 'migratory-time')
  assert.deepEqual(entry.existingBinding.args, [previousPath])
  assert.equal(entry.identityMatched, false)
})

test('a displaced binding whose Args line cannot map to exact argv is restored with an explicit lossy marker', async () => {
  const fake = fixture()
  const argsText = 'mcp --header X Custom'
  const base = fake.runner
  fake.runner = async (command, args, options) => {
    const commandArgs = command === '/usr/bin/claude' ? userConfigCommand(args) : args
    if (commandArgs[0] === 'mcp' && commandArgs[1] === 'get' && commandArgs[2] === 'math-anchor') {
      return { status: 0, stdout: `Command: ${process.execPath}\nArgs: ${argsText}\n`, stderr: '' }
    }
    return base(command, args, options)
  }
  const installed = await installClaude(fake.manifest, fake.runner, null, { replaceConflicts: true })
  const math = installed.entries.find((entry) => entry.name === 'math-anchor')
  assert.equal(math.displaced.argsExact, false)
  assert.equal(math.displaced.argsText, argsText)
  const removed = await uninstallClaude(installed, fake.runner)
  const restored = removed.removed.find((item) => item.target === 'math-anchor' && item.kind === 'restored-mcp')
  assert.equal(restored.argsExact, false)
  assert.equal(restored.originalArgs, argsText)
})
