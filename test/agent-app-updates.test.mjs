import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectAgentAppUpdates } from '../src/agent-app-updates.mjs'

test('Agent app version inspection reports installed version from the official command', async () => {
  const items = await inspectAgentAppUpdates({
    runner: async (command, args) => {
      if (args?.[0] === 'codex' || command === 'codex' || args?.includes('codex')) {
        if (args?.includes('--version') || args?.[0] === '--version') {
          return { status: 0, stdout: 'codex-cli 0.40.1\n', stderr: '' }
        }
        return { status: 0, stdout: '/usr/local/bin/codex\n', stderr: '' }
      }
      if (String(command).includes('which') || String(command).includes('where')) {
        if (args?.[0] === 'codex') return { status: 0, stdout: '/usr/local/bin/codex\n', stderr: '' }
        return { status: 1, stdout: '', stderr: '' }
      }
      return { status: 1, stdout: '', stderr: '' }
    },
  })
  const codex = items.find((item) => item.id === 'codex')
  assert.equal(codex.kind, 'agent-app')
  assert.equal(['installed-official-upgrade', 'installed-version-unreadable', 'not-installed'].includes(codex.availability), true)
  assert.equal(codex.availableVersion, null)
  assert.match(codex.note, /does not redistribute|not installed/u)
})
