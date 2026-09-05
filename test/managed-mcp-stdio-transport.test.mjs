import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { AgentHostError } from '../src/errors.mjs'
import { ManagedMcpStdioTransport } from '../src/managed-mcp-stdio-transport.mjs'
import { closeMcpProbeTransport } from '../src/mcp-probe-cleanup.mjs'
import { closeOwnedProcessTree, managedSpawnOptions } from '../src/process-tree.mjs'

async function waitForFile(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const value = (await readFile(path, 'utf8')).trim()
      if (/^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value))) return value
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await delay(10)
  }
  throw new Error('Host MCP process tree fixture did not publish its descendant PID')
}

async function waitForPidAbsence(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error.code === 'ESRCH') return
      throw error
    }
    // A killed orphan can remain briefly observable as a non-executable
    // zombie while the OS reaper catches up. The process-group assertion below
    // is the synchronous cleanup truth; this waits only for PID disappearance.
    await delay(10)
  }
  assert.throws(() => process.kill(pid, 0), (error) => error.code === 'ESRCH')
}

test('Host process fixture waits for PID content after the file is created', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'agent-host-pid-publication-'))
  const path = resolve(directory, 'descendant.pid')
  try {
    await writeFile(path, '')
    const pending = waitForFile(path)
    // File creation and content publication are separate observable events.
    await delay(30)
    await writeFile(path, '4242')
    assert.equal(await pending, '4242')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Host MCP transport removes a stubborn POSIX root and descendant before close resolves', { skip: process.platform === 'win32' }, async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), 'agent-host-mcp-process-tree-'))
  const scriptPath = resolve(directory, 'stubborn-tree.mjs')
  const pidPath = resolve(directory, 'descendant.pid')
  await writeFile(scriptPath, [
    "import { spawn } from 'node:child_process'",
    "import { writeFileSync } from 'node:fs'",
    "process.on('SIGTERM', () => {})",
    "const descendant = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1000); process.send(\"ready\")'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })",
    "descendant.once('message', () => writeFileSync(process.argv[2], String(descendant.pid)))",
    'setInterval(() => {}, 1000)',
    '',
  ].join('\n'))
  const transport = new ManagedMcpStdioTransport({
    command: process.execPath,
    args: [scriptPath, pidPath],
    cwd: directory,
    stderr: 'pipe',
    maxBufferSize: 4096,
  })
  let rootPid
  t.after(async () => {
    if (rootPid !== undefined) {
      try { process.kill(-rootPid, 'SIGKILL') } catch {}
    }
    await rm(directory, { recursive: true, force: true })
  })
  await transport.start()
  rootPid = transport.pid
  const descendantPid = Number(await waitForFile(pidPath))
  await transport.close()
  assert.deepEqual(transport.termination, {
    status: 'confirmed',
    platform: process.platform,
    scope: 'posix-process-group',
    method: 'kill-group',
    rootExitObserved: true,
    scopeStatus: 'confirmed-absent',
    outsideScope: 'not-observable',
  })
  assert.throws(() => process.kill(rootPid, 0), (error) => error.code === 'ESRCH')
  assert.throws(() => process.kill(-rootPid, 0), (error) => error.code === 'ESRCH')
  // The absent process group is the synchronous ownership boundary. A killed
  // orphan PID may remain observable as a zombie until the OS reaper runs.
  assert.equal(Number.isSafeInteger(descendantPid) && descendantPid > 0, true)
})

test('Host Windows cleanup reports its confirmed owned process scope', async () => {
  assert.equal(managedSpawnOptions('win32').detached, false)
  assert.equal(managedSpawnOptions('linux').detached, true)
  const child = new EventEmitter()
  child.pid = 6161
  child.exitCode = null
  child.signalCode = null
  const calls = []
  const termination = await closeOwnedProcessTree(child, {
    platformName: 'win32',
    windowsTreeKiller: async (pid) => {
      calls.push(pid)
      child.exitCode = 1
      queueMicrotask(() => child.emit('close', 1))
      return { status: 0 }
    },
  })
  assert.deepEqual(calls, [6161])
  assert.deepEqual(termination, {
    status: 'confirmed',
    platform: 'win32',
    scope: 'windows-process-tree',
    method: 'taskkill-tree',
    rootExitObserved: true,
    scopeStatus: 'confirmed-absent',
    outsideScope: 'not-observable',
  })
})

test('Host POSIX cleanup never signals a recycled process-group identity after root close', async () => {
  const child = new EventEmitter()
  child.pid = 6262
  child.exitCode = 0
  child.signalCode = null
  const signals = []
  await closeOwnedProcessTree(child, {
    platformName: 'darwin',
    gracefulWaitMs: 0,
    signalProcess: (pid, signal) => {
      signals.push([pid, signal])
    },
  })
  assert.deepEqual(signals, [[-6262, 0], [6262, 0]])
})

test('Host cleanup does not claim visibility into a Provider process that creates a new POSIX session', { skip: process.platform === 'win32' }, async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), 'agent-host-mcp-escaped-session-'))
  const scriptPath = resolve(directory, 'escaped-session.mjs')
  const pidPath = resolve(directory, 'escaped.pid')
  await writeFile(scriptPath, [
    "import { spawn } from 'node:child_process'",
    "import { writeFileSync } from 'node:fs'",
    "const escaped = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true })",
    'escaped.unref()',
    'writeFileSync(process.argv[2], String(escaped.pid))',
    "process.on('SIGTERM', () => {})",
    'setInterval(() => {}, 1000)',
    '',
  ].join('\n'))
  const transport = new ManagedMcpStdioTransport({
    command: process.execPath,
    args: [scriptPath, pidPath],
    cwd: directory,
    stderr: 'pipe',
    maxBufferSize: 4096,
  })
  let rootPid
  let escapedPid
  t.after(async () => {
    if (rootPid !== undefined) {
      try { process.kill(-rootPid, 'SIGKILL') } catch {}
    }
    if (escapedPid !== undefined) {
      try { process.kill(escapedPid, 'SIGKILL') } catch {}
      await waitForPidAbsence(escapedPid).catch(() => {})
    }
    await rm(directory, { recursive: true, force: true })
  })
  await transport.start()
  rootPid = transport.pid
  escapedPid = Number(await waitForFile(pidPath))
  await transport.close()
  assert.equal(transport.termination.status, 'confirmed')
  assert.equal(transport.termination.scope, 'posix-process-group')
  assert.equal(transport.termination.scopeStatus, 'confirmed-absent')
  assert.equal(transport.termination.outsideScope, 'not-observable')
  assert.doesNotThrow(() => process.kill(escapedPid, 0))
})

test('Host MCP probe cleanup reports bounded operation and process-scope failures together', async () => {
  const primary = new AgentHostError('FIXTURE_OPERATION_FAILED', 'operation failed')
  await assert.rejects(
    closeMcpProbeTransport(
      { close: async () => { throw new AgentHostError('HOST_PROCESS_TREE_CLEANUP_FAILED', 'x'.repeat(600)) } },
      primary,
      'FIXTURE_CLEANUP_FAILED',
      'Fixture cleanup failed',
    ),
    (error) => {
      assert.equal(error.code, 'FIXTURE_CLEANUP_FAILED')
      assert.deepEqual(error.details.operation, { code: 'FIXTURE_OPERATION_FAILED', message: 'operation failed' })
      assert.equal(error.details.cleanup.code, 'HOST_PROCESS_TREE_CLEANUP_FAILED')
      assert.equal([...error.details.cleanup.message].length, 512)
      return true
    },
  )
})
