import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { inspectGrok, installGrok, suspendGrok, uninstallGrok } from '../src/hosts/grok.mjs'

const manifest = {
  components: {
    'math-anchor': {
      displayName: 'Math Anchor',
      command: '/usr/bin/true',
      args: ['mcp'],
    },
  },
}

function runner() {
  return async () => ({ status: 0, stdout: 'grok 0.1.0\n', stderr: '' })
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-grok-'))
  const configPath = join(root, 'config.toml')
  return { root, configPath }
}

test('Grok install preserves unrelated config and reports the CLI as installed', async () => {
  const { root, configPath } = await fixture()
  await writeFile(configPath, '# keep me\n\n[model]\nname = "grok"\n\n[mcp_servers.other]\ncommand = "/bin/other"\nargs = []\nenabled = true\n')
  const installed = await installGrok(manifest, runner(), null, { configPath, executable: '/usr/bin/true' })
  assert.equal(installed.kind, 'grok')
  assert.equal(installed.version, 'grok 0.1.0')
  assert.equal(installed.entries[0].created, true)
  const text = await readFile(configPath, 'utf8')
  assert.match(text, /# keep me/)
  assert.match(text, /\[model\]/)
  assert.match(text, /\[mcp_servers\.other\]/)
  assert.match(text, /\[mcp_servers\.math-anchor\]/)
  assert.match(text, /command = "\/usr\/bin\/true"/)
  const inspected = await inspectGrok(manifest, runner(), installed, { configPath, executable: '/usr/bin/true' })
  assert.equal(inspected.entries[0].identityMatched, true)
  await rm(root, { recursive: true, force: true })
})

test('Grok refuses an unmanaged server with a different command', async () => {
  const { root, configPath } = await fixture()
  await writeFile(configPath, '[mcp_servers.math-anchor]\ncommand = "/bin/other"\nargs = ["mcp"]\nenabled = true\n')
  await assert.rejects(
    () => installGrok(manifest, runner(), null, { configPath, executable: '/usr/bin/true' }),
    (error) => error.code === 'GROK_MCP_CONFLICT',
  )
  await rm(root, { recursive: true, force: true })
})

test('Grok uninstall removes only the Host server and restores a displaced binding', async () => {
  const { root, configPath } = await fixture()
  const original = '[mcp_servers.math-anchor]\ncommand = "/bin/other"\nargs = ["serve"]\nenabled = true\n'
  await writeFile(configPath, `${original}[mcp_servers.keep]\ncommand = "/bin/keep"\nargs = []\nenabled = true\n`)
  const installed = await installGrok(manifest, runner(), null, {
    configPath,
    executable: '/usr/bin/true',
    replaceConflicts: true,
  })
  const removed = await uninstallGrok(installed)
  assert.equal(removed.removed[0].kind, 'restored-mcp')
  const text = await readFile(configPath, 'utf8')
  assert.match(text, /command = "\/bin\/other"/)
  assert.match(text, /\[mcp_servers\.keep\]/)
  assert.doesNotMatch(text, /\/usr\/bin\/true/)
  await rm(root, { recursive: true, force: true })
})

test('Grok update replaces an owned package path without treating the old Host package as user state', async () => {
  const { root, configPath } = await fixture()
  const installed = await installGrok(manifest, runner(), null, { configPath, executable: '/usr/bin/true' })
  const nextManifest = {
    components: {
      'math-anchor': {
        ...manifest.components['math-anchor'],
        command: '/usr/bin/false',
      },
    },
  }
  const updated = await installGrok(nextManifest, runner(), installed, {
    configPath,
    executable: '/usr/bin/true',
  })
  assert.equal(updated.entries[0].displaced, null)
  assert.match(await readFile(configPath, 'utf8'), /command = "\/usr\/bin\/false"/)
  await uninstallGrok(updated)
  assert.doesNotMatch(await readFile(configPath, 'utf8'), /mcp_servers\.math-anchor/)
  await rm(root, { recursive: true, force: true })
})

test('Grok reports not installed when the CLI cannot be found', async () => {
  const { root, configPath } = await fixture()
  await assert.rejects(
    () => inspectGrok(manifest, async () => ({ status: 1, stdout: '', stderr: '' }), null, { configPath, executable: null }),
    (error) => error.code === 'GROK_NOT_INSTALLED',
  )
  await rm(root, { recursive: true, force: true })
})

test('Grok suspend hides an owned server and refuses a server the user changed', async () => {
  const { root, configPath } = await fixture()
  const installed = await installGrok(manifest, runner(), null, { configPath, executable: '/usr/bin/true' })
  const suspended = await suspendGrok(installed)
  assert.equal(suspended.suspended[0].status, 'ok')
  const hidden = await readFile(configPath, 'utf8')
  assert.doesNotMatch(hidden, /math-anchor/)
  await writeFile(configPath, '[mcp_servers.math-anchor]\ncommand = "/bin/changed"\nargs = ["mcp"]\nenabled = true\n')
  const removed = await uninstallGrok(installed)
  assert.equal(removed.removed[0].status, 'preserved-user-change')
  const kept = await readFile(configPath, 'utf8')
  assert.match(kept, /\/bin\/changed/)
  await rm(root, { recursive: true, force: true })
})
