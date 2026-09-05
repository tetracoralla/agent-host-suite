import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  closeProviderProcessTree,
  managedProviderSpawnOptions,
  runWindowsProviderTreeKiller,
} from '../src/process-tree.mjs'
import { StrictMcpStdioTransport } from '../src/strict-mcp-stdio-transport.mjs'

async function waitForFile(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return (await readFile(path, 'utf8')).trim()
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await delay(10)
  }
  throw new Error('process tree fixture did not publish its descendant PID')
}

function assertPidAbsent(pid) {
  assert.throws(() => process.kill(pid, 0), (error) => error.code === 'ESRCH')
}

test('MCP transport close removes a stubborn POSIX root and descendant before resolving', { skip: process.platform === 'win32' }, async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), 'direct-runtime-process-tree-'))
  const scriptPath = resolve(directory, 'stubborn-tree.mjs')
  const pidPath = resolve(directory, 'descendant.pid')
  await writeFile(scriptPath, [
    "import { spawn } from 'node:child_process'",
    "import { writeFileSync } from 'node:fs'",
    "const descendant = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
    'writeFileSync(process.argv[2], String(descendant.pid))',
    "process.on('SIGTERM', () => {})",
    'setInterval(() => {}, 1000)',
    '',
  ].join('\n'))
  const transport = new StrictMcpStdioTransport({
    command: process.execPath,
    args: [scriptPath, pidPath],
    cwd: directory,
    stderr: 'pipe',
    maxBufferSize: 4096,
  })
  let rootPid
  let descendantPid
  t.after(async () => {
    if (rootPid !== undefined) {
      try { process.kill(-rootPid, 'SIGKILL') } catch {}
    }
    await rm(directory, { recursive: true, force: true })
  })
  await transport.start()
  rootPid = transport.pid
  descendantPid = Number(await waitForFile(pidPath))
  await transport.close()
  assertPidAbsent(rootPid)
  assert.throws(() => process.kill(-rootPid, 0), (error) => error.code === 'ESRCH')
  assert.equal(Number.isSafeInteger(descendantPid) && descendantPid > 0, true)
})

test('MCP transport retains a closed POSIX root identity until its surviving descendant is removed', { skip: process.platform === 'win32' }, async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), 'direct-runtime-orphan-tree-'))
  const scriptPath = resolve(directory, 'exiting-root.mjs')
  const pidPath = resolve(directory, 'descendant.pid')
  await writeFile(scriptPath, [
    "import { spawn } from 'node:child_process'",
    "import { writeFileSync } from 'node:fs'",
    "const descendant = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
    'writeFileSync(process.argv[2], String(descendant.pid))',
    'setTimeout(() => process.exit(0), 20)',
    '',
  ].join('\n'))
  const transport = new StrictMcpStdioTransport({
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
  const closed = new Promise((resolvePromise) => { transport.onclose = resolvePromise })
  await transport.start()
  rootPid = transport.pid
  const descendantPid = Number(await waitForFile(pidPath))
  await closed
  assert.equal(transport.pid, rootPid)
  await transport.close()
  assert.throws(() => process.kill(-rootPid, 0), (error) => error.code === 'ESRCH')
  assert.equal(Number.isSafeInteger(descendantPid) && descendantPid > 0, true)
})

test('Windows Provider cleanup requires taskkill tree success and root close', async () => {
  assert.equal(managedProviderSpawnOptions('win32').detached, false)
  assert.equal(managedProviderSpawnOptions('darwin').detached, true)
  const child = new EventEmitter()
  child.pid = 4242
  child.exitCode = null
  child.signalCode = null
  const calls = []
  await closeProviderProcessTree(child, {
    platformName: 'win32',
    windowsTreeKiller: async (pid) => {
      calls.push(pid)
      child.exitCode = 1
      queueMicrotask(() => child.emit('close', 1))
      return { status: 0 }
    },
  })
  assert.deepEqual(calls, [4242])

  const unresolved = new EventEmitter()
  unresolved.pid = 4343
  unresolved.exitCode = null
  unresolved.signalCode = null
  await assert.rejects(
    closeProviderProcessTree(unresolved, {
      platformName: 'win32',
      windowsTreeKiller: async () => ({ status: 1 }),
    }),
    (error) => error.code === 'HOST_CLEANUP_FAILED',
  )
})

test('POSIX Provider cleanup never signals a recycled process-group identity after root close', async () => {
  const child = new EventEmitter()
  child.pid = 4444
  child.exitCode = 0
  child.signalCode = null
  const signals = []
  await closeProviderProcessTree(child, {
    platformName: 'linux',
    gracefulWaitMs: 0,
    signalProcess: (pid, signal) => {
      signals.push([pid, signal])
    },
  })
  assert.deepEqual(signals, [[-4444, 0], [4444, 0]])
})

test('POSIX Provider cleanup treats positive-PID EPERM after root reap as recycled identity', async () => {
  const child = new EventEmitter()
  child.pid = 4494
  child.exitCode = 0
  child.signalCode = null
  const signals = []
  await closeProviderProcessTree(child, {
    platformName: 'linux',
    gracefulWaitMs: 0,
    signalProcess: (pid, signal) => {
      signals.push([pid, signal])
      const error = new Error(pid < 0 ? 'unrelated group is inaccessible' : 'recycled PID is inaccessible')
      error.code = 'EPERM'
      throw error
    },
  })
  assert.deepEqual(signals, [[-4494, 0], [4494, 0]])
})

test('POSIX Provider cleanup fails closed when a reaped root leaves an inaccessible group', async () => {
  const child = new EventEmitter()
  child.pid = 4545
  child.exitCode = 0
  child.signalCode = null
  const signals = []
  await assert.rejects(
    closeProviderProcessTree(child, {
      platformName: 'darwin',
      gracefulWaitMs: 0,
      identityWaitMs: 0,
      signalProcess: (pid, signal) => {
        signals.push([pid, signal])
        if (pid === child.pid) {
          const error = new Error('missing root')
          error.code = 'ESRCH'
          throw error
        }
        if (signal === 'SIGTERM') {
          const error = new Error('inaccessible group of unknown provenance')
          error.code = 'EPERM'
          throw error
        }
      },
    }),
    (error) => error.code === 'HOST_CLEANUP_FAILED',
  )
  assert.deepEqual(signals, [
    [-4545, 0],
    [4545, 0],
    [-4545, 'SIGTERM'],
    [4545, 0],
    [-4545, 0],
  ])
})

test('POSIX Provider cleanup waits for an inaccessible zombie root to be reaped and confirms group absence', async () => {
  const child = new EventEmitter()
  child.pid = 4646
  child.exitCode = null
  child.signalCode = null
  let reaped = false
  const signals = []
  await closeProviderProcessTree(child, {
    platformName: 'darwin',
    gracefulWaitMs: 0,
    identityWaitMs: 100,
    signalProcess: (pid, signal) => {
      signals.push([pid, signal])
      if (pid === -child.pid && signal === 0 && reaped) {
        const error = new Error('group is gone')
        error.code = 'ESRCH'
        throw error
      }
      if (pid === child.pid) {
        const error = new Error('root is gone')
        error.code = 'ESRCH'
        throw error
      }
      if (pid === -child.pid && signal === 'SIGTERM') {
        queueMicrotask(() => {
          reaped = true
          child.exitCode = 0
          child.emit('close', 0)
        })
        const error = new Error('zombie-only group is temporarily inaccessible')
        error.code = 'EPERM'
        throw error
      }
    },
  })
  assert.deepEqual(signals, [
    [-4646, 0],
    [-4646, 'SIGTERM'],
    [4646, 0],
    [-4646, 0],
  ])
})

test('Windows Provider tree killer invokes taskkill with descendant and force flags', async () => {
  const killer = new EventEmitter()
  killer.kill = () => {}
  let invocation
  const resultPromise = runWindowsProviderTreeKiller(5151, (command, args, options) => {
    invocation = { command, args, options }
    queueMicrotask(() => killer.emit('close', 0))
    return killer
  })
  assert.deepEqual(await resultPromise, { status: 0, timedOut: false })
  assert.equal(invocation.command, 'taskkill.exe')
  assert.deepEqual(invocation.args, ['/pid', '5151', '/t', '/f'])
  assert.equal(invocation.options.windowsHide, true)
})
