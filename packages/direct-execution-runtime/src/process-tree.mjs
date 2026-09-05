import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { platform } from 'node:os'
import { HostError } from './errors.mjs'

const POLL_INTERVAL_MS = 10

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
export function managedProviderSpawnOptions(platformName = platform()) {
  return {
    // A detached POSIX child owns a process group whose descendants remain
    // addressable after the direct child exits. Windows Providers use a kill-on-close Job
    // and intentionally do not rely on POSIX-style detached semantics.
    detached: platformName !== 'win32',
    windowsHide: true,
  }
}

const guardedWindowsChildren = new WeakMap()
const windowsGuardian = fileURLToPath(new URL('./windows-provider-runner.ps1', import.meta.url))

export function spawnManagedProvider(command, args, options) {
  if (platform() !== 'win32') return spawn(command, args, options)
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', windowsGuardian], {
    ...options,
    env: { ...options.env, OPENADAM_PROVIDER_LAUNCH: JSON.stringify({ command, args, cwd: options.cwd, ownerPid: process.pid }) },
    shell: false,
  })
  const state = { closed: false }
  state.completion = new Promise((resolve) => child.once('close', () => {
    state.closed = true
    resolve()
  }))
  guardedWindowsChildren.set(child, state)
  return child
}

function posixGroupAlive(pid, signalProcess = process.kill) {
  try {
    signalProcess(-pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    if (error?.code === 'EPERM') return true
    throw error
  }
}

function posixProcessAlive(pid, signalProcess = process.kill) {
  try {
    signalProcess(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    if (error?.code === 'EPERM') return true
    throw error
  }
}

function posixGroupIdentity(child, signalProcess) {
  if (child.exitCode === null && child.signalCode === null) return 'owned-by-live-root'
  // POSIX reserves a process ID while a process group with that numeric ID
  // still exists. Once Node has reaped the Provider root, a live positive PID
  // (including one observable only through EPERM) therefore proves that the
  // number was recycled and the old Provider group no longer exists. Never
  // signal the unrelated group now addressed by -pid. If the positive PID is
  // absent, surviving Provider descendants may still reserve the group ID.
  return posixProcessAlive(child.pid, signalProcess)
    ? 'recycled-after-root-reap'
    : 'owned-by-surviving-descendants'
}

async function waitForPosixGroupExit(pid, timeoutMs, signalProcess) {
  const deadline = Date.now() + timeoutMs
  while (posixGroupAlive(pid, signalProcess)) {
    if (Date.now() >= deadline) return false
    await delay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())))
  }
  return true
}

function signalPosixGroup(pid, signal, signalProcess = process.kill) {
  try {
    signalProcess(-pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

async function inaccessibleGroupDisappearedWithReapedRoot(child, timeoutMs, signalProcess) {
  if (!(await waitForChildExit(child, timeoutMs))) return false
  if (posixProcessAlive(child.pid, signalProcess)) return false
  return await waitForPosixGroupExit(child.pid, timeoutMs, signalProcess)
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return await new Promise((resolve) => {
    let settled = false
    const finish = (exited) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('close', onClose)
      resolve(exited)
    }
    const onClose = () => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('close', onClose)
  })
}

export async function runWindowsProviderTreeKiller(pid, spawnProcess = spawn) {
  return await new Promise((resolve) => {
    const killer = spawnProcess('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try {
        killer.kill('SIGKILL')
      } catch {
        // The taskkill helper already exited.
      }
      finish({ status: null, timedOut: true })
    }, 5_000)
    killer.once('error', (error) => finish({ status: null, error }))
    killer.once('close', (status) => finish({ status, timedOut: false }))
  })
}

/**
 * Terminate a Provider process tree and return only after the owning OS route
 * confirms it is gone. On POSIX the process group remains authoritative after
 * the root exits. Windows guarded children own a kill-on-close Job; unguarded children
 * still require successful taskkill /T before root close counts.
 */
export async function closeProviderProcessTree(child, options = {}) {
  if (child?.pid === undefined) return
  const platformName = options.platformName ?? platform()
  if (platformName === 'win32') {
    const guarded = guardedWindowsChildren.get(child)
    // The guardian either never admitted the Provider or owns a kill-on-close
    // Job. A naturally closed guardian has already retired that entire Job.
    if (guarded) {
      if (guarded.closed) return
      // Terminate the owned guardian handle directly. Its sole Job handle
      // closes and retires descendants without taskkill's parent/child race.
      let cause
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL') } catch (error) { cause = error }
      }
      // An exit code precedes stdio close. Keep the owned ChildProcess identity
      // until its close event instead of racing cleanup against open pipes.
      let timer
      try {
        const closed = await Promise.race([
          guarded.completion.then(() => true),
          new Promise((resolve) => { timer = setTimeout(() => resolve(false), options.killWaitMs ?? 5000) }),
        ])
        if (!closed) throw new HostError('HOST_CLEANUP_FAILED', 'The Windows Provider Job guardian did not close', { cause })
      } finally {
        clearTimeout(timer)
      }
      return
    }
    const result = await (options.windowsTreeKiller ?? runWindowsProviderTreeKiller)(child.pid)
    if (result?.status !== 0) {
      throw new HostError('HOST_CLEANUP_FAILED', 'Windows could not confirm termination of the Provider process tree')
    }
    if (!(await waitForChildExit(child, options.killWaitMs ?? 1_500))) {
      throw new HostError('HOST_CLEANUP_FAILED', 'The Windows Provider root did not close after tree termination')
    }
    return
  }

  try {
    child.stdin?.end()
  } catch {
    // Forced process-group termination below is authoritative.
  }
  const signalProcess = options.signalProcess ?? process.kill
  if (await waitForPosixGroupExit(child.pid, options.gracefulWaitMs ?? 250, signalProcess)) return
  if (posixGroupIdentity(child, signalProcess) === 'recycled-after-root-reap') return
  try {
    signalPosixGroup(child.pid, 'SIGTERM', signalProcess)
  } catch (error) {
    if (
      error?.code === 'EPERM'
      && await inaccessibleGroupDisappearedWithReapedRoot(
        child,
        options.identityWaitMs ?? 100,
        signalProcess,
      )
    ) return
    throw new HostError('HOST_CLEANUP_FAILED', 'The POSIX Provider process group could not be terminated', { cause: error })
  }
  if (await waitForPosixGroupExit(child.pid, options.termWaitMs ?? 750, signalProcess)) return
  if (posixGroupIdentity(child, signalProcess) === 'recycled-after-root-reap') return
  try {
    signalPosixGroup(child.pid, 'SIGKILL', signalProcess)
  } catch (error) {
    if (
      error?.code === 'EPERM'
      && await inaccessibleGroupDisappearedWithReapedRoot(
        child,
        options.identityWaitMs ?? 100,
        signalProcess,
      )
    ) return
    throw new HostError('HOST_CLEANUP_FAILED', 'The POSIX Provider process group could not be force-terminated', { cause: error })
  }
  if (!(await waitForPosixGroupExit(child.pid, options.killWaitMs ?? 750, signalProcess))
    && posixGroupIdentity(child, signalProcess) !== 'recycled-after-root-reap') {
    throw new HostError('HOST_CLEANUP_FAILED', 'The POSIX Provider process group remained after forced termination')
  }
}
