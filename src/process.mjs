import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { posix, win32 } from 'node:path'
import { AgentHostError } from './errors.mjs'
import { closeOwnedProcessTree, managedSpawnOptions } from './process-tree.mjs'

export async function runFile(command, args = [], options = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000
  const maxBuffer = options.maxBuffer ?? 4 * 1024 * 1024
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted === true) {
      reject(new AgentHostError('HOST_COMMAND_CANCELLED', `${command} ${args.join(' ')} was cancelled`))
      return
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...managedSpawnOptions(),
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let overflowed = false
    let cancelled = false
    let settled = false
    let finishing = false
    let terminating = false
    let termination = null
    let processTermination = null
    const onAbort = () => {
      cancelled = true
      terminate()
    }

    const finish = async (status, signal, spawnError = null) => {
      if (settled || finishing) return
      finishing = true
      let cleanupError = null
      try {
        if (termination !== null) processTermination = await termination
        else if (child.pid !== undefined && (platform() !== 'win32' || spawnError !== null)) {
          // Verify the command's owned POSIX process scope even when its root
          // exited cleanly. Work that creates a new session is outside this
          // scope and remains explicitly not observable.
          processTermination = await closeOwnedProcessTree(child, { gracefulWaitMs: 0 })
        }
      } catch (error) {
        cleanupError = error
      }
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      const result = { status, signal, stdout, stderr, timedOut, overflowed, cancelled, processTermination }
      if (cleanupError !== null) {
        reject(new AgentHostError(
          'HOST_COMMAND_CLEANUP_FAILED',
          `${command} owned process scope could not be removed`,
          { cause: cleanupError },
        ))
        return
      }
      if (options.allowFailure === true) {
        resolve(result)
        return
      }
      if (spawnError === null && status === 0 && !timedOut && !overflowed && !cancelled) {
        resolve(result)
        return
      }
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n').slice(0, 4096)
      const code = cancelled ? 'HOST_COMMAND_CANCELLED' : timedOut ? 'HOST_COMMAND_TIMEOUT' : overflowed ? 'HOST_COMMAND_OUTPUT_LIMIT' : 'HOST_COMMAND_FAILED'
      const cause = spawnError === null ? '' : `: ${spawnError.message}`
      reject(new AgentHostError(
        code,
        `${command} ${args.join(' ')} failed${status === null ? '' : ` with status ${status}`}${cause}`,
        detail === '' ? undefined : { output: detail },
      ))
    }

    const terminate = () => {
      if (terminating) return
      terminating = true
      termination = closeOwnedProcessTree(child, { gracefulWaitMs: 0, termWaitMs: 500 })
      termination.then(
        () => { void finish(child.exitCode, child.signalCode) },
        () => { void finish(child.exitCode, child.signalCode) },
      )
    }
    const append = (target, chunk) => {
      const text = chunk.toString('utf8')
      if (target === 'stdout') stdout += text
      else stderr += text
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxBuffer && !overflowed) {
        overflowed = true
        terminate()
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)
    options.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (chunk) => append('stdout', chunk))
    child.stderr.on('data', (chunk) => append('stderr', chunk))
    child.once('error', (error) => { void finish(null, null, error) })
    child.once('close', (status, signal) => { void finish(status, signal) })
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') void finish(null, null, error)
    })
    child.stdin.end(options.input ?? '')
  })
}


function windowsBatchCommand(command) {
  return platform() === 'win32' && /\.(cmd|bat)$/iu.test(String(command))
}

function windowsComSpec() {
  if (typeof process.env.ComSpec === 'string' && process.env.ComSpec.length > 0) {
    return process.env.ComSpec
  }
  return win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readyFileProbe(readyFile) {
  try {
    const text = await readFile(readyFile, 'utf8')
    const pid = Number(String(text).trim().split(/\s+/u)[0])
    if (!Number.isInteger(pid) || pid <= 0) return false
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function childPidAlive(child) {
  if (child?.pid === undefined) return false
  try {
    process.kill(child.pid, 0)
    return true
  } catch {
    return false
  }
}

export async function startDetachedProcess(command, args = [], options = {}) {
  const confirmMs = options.confirmMs ?? 1_500
  const useWindowsBatch = windowsBatchCommand(command)
  const readyProbe = typeof options.readyProbe === 'function'
    ? options.readyProbe
    : (typeof options.readyFile === 'string' && options.readyFile.length > 0
      ? () => readyFileProbe(options.readyFile)
      : null)
  // Windows .cmd/.bat: spawn cmd.exe with separate argv so Node quotes each
  // argument (paths with spaces like `Agent Host.cmd`). Use `call` so the
  // batch's foreground node/Manager stays under the outer cmd. Do not pack a
  // single `/s /c` string with windowsVerbatimArguments: true — that path
  // never started the batch on windows-latest. Do not use `start /b`.

  return new Promise((resolve, reject) => {
    let settled = false
    let child
    let shellExited = false
    let exitStatus = null
    let exitSignal = null

    try {
      if (useWindowsBatch) {
        child = spawn(windowsComSpec(), ['/d', '/c', 'call', command, ...args], {
          cwd: options.cwd,
          env: options.env ?? process.env,
          stdio: options.stdio ?? 'ignore',
          detached: true,
          windowsHide: true,
          shell: false,
          // default windowsVerbatimArguments: false — Node quotes each argv.
        })
      } else {
        child = spawn(command, args, {
          cwd: options.cwd,
          env: options.env ?? process.env,
          stdio: options.stdio ?? 'ignore',
          detached: true,
          windowsHide: true,
          shell: false,
        })
      }
    } catch (error) {
      reject(new AgentHostError(
        'HOST_COMMAND_FAILED',
        `${command} ${args.join(' ')} failed to spawn: ${error instanceof Error ? error.message : String(error)}`,
      ))
      return
    }

    const settleFailure = (code, message, details) => {
      if (settled) return
      settled = true
      try {
        if (child.pid !== undefined) child.kill()
      } catch {
        // Best-effort only; ownership was never handed off.
      }
      reject(new AgentHostError(code, message, details))
    }

    const finishOk = (extra = {}) => {
      if (settled) return
      settled = true
      // Hand off ownership: updater must not reap this long-running Manager.
      try {
        child.unref()
      } catch {
        // Already detached / closed.
      }
      resolve({
        pid: child.pid,
        command,
        args,
        detached: true,
        confirmedAfterMs: confirmMs,
        shell: useWindowsBatch,
        ...extra,
      })
    }

    child.once('error', (error) => {
      settleFailure(
        'HOST_COMMAND_FAILED',
        `${command} ${args.join(' ')} failed to start: ${error.message}`,
        { cause: error.message },
      )
    })
    child.once('exit', (status, signal) => {
      shellExited = true
      exitStatus = status
      exitSignal = signal
      if (settled) return
      // With `call`, early exit means the batch ended before confirmation.
      // When readyProbe/readyFile is set, confirm() still waits for the probe
      // (Manager may outlive a short-lived wrapper). Without a probe, fail now.
      if (readyProbe !== null) return
      settleFailure(
        'HOST_COMMAND_FAILED',
        `${command} ${args.join(' ')} exited before startup was confirmed`,
        { status, signal },
      )
    })

    const startedAt = Date.now()
    const confirm = async () => {
      // When readyFile/probe is provided, require it — never fall back to
      // outer child.pid (cmd.exe can stay alive while Manager never wrote
      // the ready file). Pid liveness is the confirm path only when no probe.
      while (!settled && Date.now() - startedAt < confirmMs) {
        if (readyProbe !== null) {
          try {
            if (await readyProbe()) {
              finishOk({ ready: 'probe' })
              return
            }
          } catch {
            // Keep polling until confirmMs.
          }
        }
        await delay(50)
      }
      if (settled) return
      if (readyProbe !== null) {
        try {
          if (await readyProbe()) {
            finishOk({ ready: 'probe' })
            return
          }
        } catch {
          // Probe failed; fail closed below.
        }
        settleFailure(
          'HOST_COMMAND_FAILED',
          `${command} ${args.join(' ')} exited before startup was confirmed`,
          {
            status: exitStatus,
            signal: exitSignal,
            ready: 'timeout',
          },
        )
        return
      }
      if (!shellExited && childPidAlive(child)) {
        finishOk({})
        return
      }
      settleFailure(
        'HOST_COMMAND_FAILED',
        `${command} ${args.join(' ')} exited before startup was confirmed`,
        {
          status: exitStatus,
          signal: exitSignal,
        },
      )
    }
    void confirm()
  })
}

const STANDARD_TOOL_DIRECTORIES = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
]

// A GUI-launched process inherits a minimal PATH (/usr/bin:/bin:...), so
// Homebrew-installed host CLIs look "not installed" to `which`. Append the
// standard install locations instead of trusting the inherited PATH alone.
export function toolSearchPath(currentPath = process.env.PATH ?? '', home = homedir(), platformName = platform()) {
  const pathDelimiter = platformName === 'win32' ? ';' : ':'
  const pathJoin = platformName === 'win32' ? win32.join : posix.join
  const entries = currentPath.split(pathDelimiter).filter((entry) => entry !== '')
  const additions = platformName === 'win32'
    ? [pathJoin(home, 'AppData', 'Roaming', 'npm'), pathJoin(home, '.local', 'bin'), pathJoin(home, 'bin')]
    : [...STANDARD_TOOL_DIRECTORIES, pathJoin(home, '.local', 'bin'), pathJoin(home, 'bin')]
  for (const directory of additions) {
    if (!entries.includes(directory)) entries.push(directory)
  }
  return entries.join(pathDelimiter)
}

export async function resolveExecutable(name, runner = runFile, platformName = platform()) {
  const env = { ...process.env, PATH: toolSearchPath(process.env.PATH, homedir(), platformName) }
  const command = platformName === 'win32' ? 'where.exe' : '/usr/bin/env'
  const args = platformName === 'win32' ? [name] : ['which', name]
  const result = await runner(command, args, { allowFailure: true, timeoutMs: 5_000, env })
  if (result.status !== 0 || result.stdout.trim() === '') return null
  return result.stdout.trim().split('\n')[0]
}
