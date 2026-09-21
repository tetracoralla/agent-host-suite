import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AgentHostError } from '../src/errors.mjs'
import { openAgentApp, resolveAgentAppLaunch } from '../src/open-agent-app.mjs'
import { startDetachedProcess } from '../src/process.mjs'

test('GUI launch is preferred over a CLI that has no terminal', async () => {
  const launches = []
  const result = await openAgentApp('codex', {
    platform: 'darwin',
    home: '/tmp/fake-home',
    exists: async (path) => path === '/Applications/Codex.app',
    resolveCli: async () => '/usr/local/bin/codex',
    findCommand: async () => null,
    start: async (command, args, options) => {
      launches.push({ command, args, options })
      return { pid: 4242, command, args }
    },
  })
  assert.equal(result.status, 'opened')
  assert.equal(result.method, 'gui')
  assert.equal(result.launched, '/Applications/Codex.app')
  assert.equal(launches[0].command, '/usr/bin/open')
  assert.deepEqual(launches[0].args, ['-a', '/Applications/Codex.app'])
  assert.equal(launches[0].options.acceptCleanExit, true)
})

test('CLI without a GUI uses a visible terminal, not a detached stdio-ignore spawn', async () => {
  const launches = []
  const result = await openAgentApp('codex', {
    platform: 'linux',
    exists: async () => false,
    resolveCli: async () => '/opt/codex',
    findCommand: async (name) => (name === 'xfce4-terminal' ? '/usr/bin/xfce4-terminal' : null),
    start: async (command, args, options) => {
      launches.push({ command, args, options })
      return { pid: 99, command, args }
    },
  })
  assert.equal(result.method, 'terminal')
  assert.equal(result.terminal, 'xfce4-terminal')
  assert.equal(launches[0].command, '/usr/bin/xfce4-terminal')
  assert.equal(launches[0].args.includes('/opt/codex'), true)
  assert.equal(launches[0].options.windowsHide, false)
})

test('CLI without GUI or terminal returns an executable next step, not HOST_COMMAND_FAILED', async () => {
  await assert.rejects(
    () => openAgentApp('codex', {
      platform: 'linux',
      exists: async () => false,
      resolveCli: async () => '/usr/bin/codex',
      findCommand: async () => null,
      start: async () => {
        throw new AgentHostError('HOST_COMMAND_FAILED', 'stdin is not a terminal')
      },
    }),
    (error) => (
      error.code === 'AGENT_APP_OPEN_UNAVAILABLE'
      && error.details?.nextStep.includes('/usr/bin/codex')
      && error.details?.kind === 'cli-needs-terminal'
    ),
  )
})

test('missing Agent app stays MANAGER_REQUEST_INVALID', async () => {
  await assert.rejects(
    () => resolveAgentAppLaunch('codex', {
      platform: 'linux',
      exists: async () => false,
      resolveCli: async () => null,
      findCommand: async () => null,
    }),
    (error) => error.code === 'MANAGER_REQUEST_INVALID',
  )
})

test('detached CLI without a TTY fails, visible terminal can run the same CLI', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-open-tty-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const marker = join(root, 'ready')
  const script = join(root, 'tty-cli')
  await writeFile(script, `#!/bin/sh
if [ ! -t 0 ]; then
  echo "Error: stdin is not a terminal" >&2
  exit 1
fi
printf 'tty-ok\\n' > ${JSON.stringify(marker)}
sleep 2
`, { mode: 0o700 })
  await chmod(script, 0o700)

  // confirmMs must outlast process exit; 800ms observed a still-alive pid on this
  // machine (~1330ms to exit) and treated startup as confirmed. Product default is unchanged.
  await assert.rejects(
    () => startDetachedProcess(script, [], { confirmMs: 3_000 }),
    (error) => error.code === 'HOST_COMMAND_FAILED',
  )
  await assert.rejects(readFile(marker))

  const hasDisplay = typeof process.env.DISPLAY === 'string' && process.env.DISPLAY.length > 0
  if (process.platform !== 'linux' || !hasDisplay) return

  let opened
  try {
    opened = await openAgentApp('codex', {
      resolveCli: async () => script,
      exists: async () => false,
      confirmMs: 2_500,
    })
  } catch (error) {
    if (error.code === 'AGENT_APP_OPEN_UNAVAILABLE') {
      assert.match(error.details.nextStep, /Open a terminal and run/u)
      return
    }
    throw error
  }
  assert.equal(opened.method, 'terminal')
  const deadline = Date.now() + 6_000
  while (Date.now() < deadline) {
    try {
      assert.equal((await readFile(marker, 'utf8')).trim(), 'tty-ok')
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }
  assert.equal((await readFile(marker, 'utf8')).trim(), 'tty-ok')
  if (Number.isInteger(opened.pid) && opened.pid > 0) {
    try { process.kill(opened.pid, 'SIGTERM') } catch { /* already gone */ }
  }
})
