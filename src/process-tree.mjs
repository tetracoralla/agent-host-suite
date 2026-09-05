import { spawn } from 'node:child_process'
import { platform } from 'node:os'
import { AgentHostError } from './errors.mjs'

const POLL_INTERVAL_MS = 10

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
export function managedSpawnOptions(platformName = platform()) {
  return {
    // A detached POSIX child becomes the leader of a new process group. This
    // lets cleanup address processes that remain in that group after the direct
    // child exits; a process that creates another session leaves this scope.
    // Windows uses taskkill /T instead of detached console semantics.
    detached: platformName !== 'win32',
    windowsHide: true,
  }
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

function ownedPosixGroupCanBeSignalled(child, signalProcess) {
  if (child.exitCode === null && child.signalCode === null) return true
  // Once Node has reaped the direct child, a live process at its positive PID
  // is a later process. A group at the recycled numeric ID is not ours. If an
  // owned descendant still held the original group open, POSIX could not reuse
  // that ID for a new group leader.
  return !posixProcessAlive(child.pid, signalProcess)
}

function signalPosixGroup(pid, signal, signalProcess = process.kill) {
  try {
    signalProcess(-pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

async function waitForPosixGroupExit(pid, timeoutMs, signalProcess) {
  const deadline = Date.now() + timeoutMs
  while (posixGroupAlive(pid, signalProcess)) {
    if (Date.now() >= deadline) return false
    await delay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())))
  }
  return true
}

async function runWindowsTreeKiller(pid, spawnProcess = spawn) {
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

function processScope(platformName) {
  return platformName === 'win32' ? 'windows-process-tree' : 'posix-process-group'
}

function terminationReport(platformName, status, method, rootExitObserved, scopeStatus) {
  return Object.freeze({
    status,
    platform: platformName,
    scope: processScope(platformName),
    method,
    rootExitObserved,
    scopeStatus,
    outsideScope: 'not-observable',
  })
}

function scopeFailure(message, report, cause = undefined) {
  return new AgentHostError('HOST_PROCESS_TREE_CLEANUP_FAILED', message, {
    termination: report,
    ...(cause === undefined ? {} : { cause }),
  })
}

/**
 * Close the process scope established for one owned child. POSIX verifies the
 * created process group, not merely its leader. Windows accepts success only
 * after taskkill /T reports success and the direct child has emitted close.
 * Work that leaves that scope is deliberately reported as not observable.
 */
export async function closeOwnedProcessTree(child, options = {}) {
  const platformName = options.platformName ?? platform()
  if (child?.pid === undefined) return terminationReport(platformName, 'not-required', 'not-started', true, 'confirmed-absent')
  if (platformName === 'win32') {
    const result = await (options.windowsTreeKiller ?? runWindowsTreeKiller)(child.pid)
    if (result?.status !== 0) {
      const report = terminationReport(platformName, 'unconfirmed', 'taskkill-tree-failed', false, 'not-confirmed')
      throw scopeFailure('Windows could not confirm termination of the owned process scope', report)
    }
    if (!(await waitForChildExit(child, options.killWaitMs ?? 1_500))) {
      const report = terminationReport(platformName, 'unconfirmed', 'taskkill-tree', false, 'root-still-observed')
      throw scopeFailure('The owned Windows process root did not close after scoped termination', report)
    }
    return terminationReport(platformName, 'confirmed', 'taskkill-tree', true, 'confirmed-absent')
  }

  try {
    child.stdin?.end()
  } catch {
    // Forced group termination below is authoritative.
  }
  const signalProcess = options.signalProcess ?? process.kill
  if (await waitForPosixGroupExit(child.pid, options.gracefulWaitMs ?? 250, signalProcess)) {
    return terminationReport(platformName, 'confirmed', 'eof', true, 'confirmed-absent')
  }
  if (!ownedPosixGroupCanBeSignalled(child, signalProcess)) {
    return terminationReport(platformName, 'confirmed', 'recycled-group-not-owned', true, 'confirmed-absent')
  }
  try {
    signalPosixGroup(child.pid, 'SIGTERM', signalProcess)
  } catch (error) {
    const report = terminationReport(platformName, 'unconfirmed', 'term-group-failed', false, 'not-confirmed')
    throw scopeFailure('The owned POSIX process scope could not be terminated', report, error)
  }
  if (await waitForPosixGroupExit(child.pid, options.termWaitMs ?? 750, signalProcess)) {
    return terminationReport(platformName, 'confirmed', 'term-group', true, 'confirmed-absent')
  }
  if (!ownedPosixGroupCanBeSignalled(child, signalProcess)) {
    return terminationReport(platformName, 'confirmed', 'recycled-group-not-owned', true, 'confirmed-absent')
  }
  try {
    signalPosixGroup(child.pid, 'SIGKILL', signalProcess)
  } catch (error) {
    const report = terminationReport(platformName, 'unconfirmed', 'kill-group-failed', false, 'not-confirmed')
    throw scopeFailure('The owned POSIX process scope could not be force-terminated', report, error)
  }
  if (!(await waitForPosixGroupExit(child.pid, options.killWaitMs ?? 750, signalProcess))
    && ownedPosixGroupCanBeSignalled(child, signalProcess)) {
    const report = terminationReport(platformName, 'unconfirmed', 'kill-group-timeout', false, 'still-observed')
    throw scopeFailure('The owned POSIX process scope remained after forced termination', report)
  }
  return terminationReport(platformName, 'confirmed', 'kill-group', true, 'confirmed-absent')
}
