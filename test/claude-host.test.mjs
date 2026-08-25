import assert from 'node:assert/strict'
import test from 'node:test'
import { installClaude, uninstallClaude } from '../src/hosts/claude.mjs'

function fixture() {
  const manifest = {
    components: {
      'math-anchor': { command: '/provider/math', args: ['mcp'] },
      'migratory-time': { command: process.execPath, args: ['/provider/time.mjs'] },
    },
  }
  const mutations = []
  const runner = async (command, args, options = {}) => {
    if (command === '/usr/bin/env' && args[0] === 'which') return { status: 0, stdout: '/usr/bin/claude\n', stderr: '' }
    if (args[0] === '--version') return { status: 0, stdout: '2.1.233\n', stderr: '' }
    if (args[0] === 'mcp' && args[1] === 'get') {
      if (args[2] === 'math-anchor') return { status: 0, stdout: 'Command: /provider/math\nArgs: mcp\n', stderr: '' }
      if (args[2] === 'migratory_time') return { status: 0, stdout: `Command: ${process.execPath}\nArgs: /provider/time.mjs\n`, stderr: '' }
      return { status: 1, stdout: '', stderr: '' }
    }
    mutations.push([command, args, options])
    return { status: 0, stdout: '', stderr: '' }
  }
  return { manifest, mutations, runner }
}

test('Claude adapter adopts equivalent existing aliases without mutating user configuration', async () => {
  const fake = fixture()
  const installed = await installClaude(fake.manifest, fake.runner)
  assert.deepEqual(installed.entries.map((entry) => [entry.actualName, entry.created, entry.adopted]), [
    ['math-anchor', false, true],
    ['migratory_time', false, true],
  ])
  await uninstallClaude(installed, fake.runner)
  assert.deepEqual(fake.mutations, [])
})

test('Claude adapter refuses a different unmanaged binding', async () => {
  const fake = fixture()
  const base = fake.runner
  fake.runner = async (command, args, options) => {
    if (args[0] === 'mcp' && args[1] === 'get' && args[2] === 'math-anchor') {
      return { status: 0, stdout: 'Command: /different/math\nArgs: mcp\n', stderr: '' }
    }
    return base(command, args, options)
  }
  await assert.rejects(installClaude(fake.manifest, fake.runner), (error) => error.code === 'CLAUDE_MCP_CONFLICT')
})
