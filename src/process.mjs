import { spawn } from 'node:child_process'
import { AgentHostError } from './errors.mjs'

export async function runFile(command, args = [], options = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000
  const maxBuffer = options.maxBuffer ?? 4 * 1024 * 1024
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let overflowed = false
    let settled = false
    let killTimer = null

    const finish = (status, signal, spawnError = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer !== null) clearTimeout(killTimer)
      const result = { status, signal, stdout, stderr, timedOut, overflowed }
      if (options.allowFailure === true) {
        resolve(result)
        return
      }
      if (spawnError === null && status === 0 && !timedOut && !overflowed) {
        resolve(result)
        return
      }
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n').slice(0, 4096)
      const code = timedOut ? 'HOST_COMMAND_TIMEOUT' : overflowed ? 'HOST_COMMAND_OUTPUT_LIMIT' : 'HOST_COMMAND_FAILED'
      const cause = spawnError === null ? '' : `: ${spawnError.message}`
      reject(new AgentHostError(
        code,
        `${command} ${args.join(' ')} failed${status === null ? '' : ` with status ${status}`}${cause}`,
        detail === '' ? undefined : { output: detail },
      ))
    }

    const terminate = () => {
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 500)
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

    child.stdout.on('data', (chunk) => append('stdout', chunk))
    child.stderr.on('data', (chunk) => append('stderr', chunk))
    child.once('error', (error) => finish(null, null, error))
    child.once('close', (status, signal) => finish(status, signal))
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') finish(null, null, error)
    })
    child.stdin.end(options.input ?? '')
  })
}

export async function resolveExecutable(name, runner = runFile) {
  const result = await runner('/usr/bin/env', ['which', name], { allowFailure: true, timeoutMs: 5_000 })
  if (result.status !== 0 || result.stdout.trim() === '') return null
  return result.stdout.trim().split('\n')[0]
}
