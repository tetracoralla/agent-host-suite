import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { AgentHostError } from '../errors.mjs'
import { closeOwnedProcessTree, managedSpawnOptions } from '../process-tree.mjs'

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const version = (value) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value)
const failure = (code, message) => new AgentHostError(code, message)
const protocolFailure = () => failure('CODEX_CONFIG_PROTOCOL_INVALID', 'Codex returned an unsupported configuration response')
const absolutePath = (value) => typeof value === 'string' && isAbsolute(value) && resolve(value) === value

function userConfiguration(result) {
  if (!Array.isArray(result?.layers)) throw protocolFailure()
  const layers = result.layers.filter((layer) => layer?.name?.type === 'user')
  if (layers.length !== 1) throw protocolFailure()
  const layer = layers[0]
  if (!absolutePath(layer.name.file) || !version(layer.version) || !object(layer.config)) throw protocolFailure()
  return { filePath: layer.name.file, version: layer.version, config: layer.config }
}

function editsFor(changes) {
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > 4096) throw protocolFailure()
  const seen = new Set()
  return changes.map((change) => {
    if (!object(change)) throw protocolFailure()
    const { keys, value } = change
    // This client only manages the public plugin/marketplace registration
    // records. It cannot change model, credential, approval or thread settings.
    const enabledField = Array.isArray(keys) && keys.length === 3 && keys[0] === 'plugins' && keys[2] === 'enabled'
    if (!Array.isArray(keys) || (!enabledField && keys.length !== 2) || !['plugins', 'marketplaces'].includes(keys[0])
      || typeof keys[1] !== 'string' || keys[1].length === 0 || keys[1].length > 256
      || (value !== null && (enabledField ? typeof value !== 'boolean' : !object(value)))) throw protocolFailure()
    const keyPath = keys.map((key) => JSON.stringify(key)).join('.')
    const registration = JSON.stringify(keys.slice(0, 2))
    if (seen.has(registration)) throw protocolFailure()
    seen.add(registration)
    return { keyPath, mergeStrategy: 'replace', value }
  })
}

// A short-lived client of Codex's public app-server configuration API. No
// thread, turn, Provider call or model request is exposed by this interface.
export async function withCodexConfiguration(executable, options, callback) {
  const configRoot = options.configRoot
  if (configRoot !== undefined && !absolutePath(configRoot)) throw failure('CODEX_CONFIG_PATH_INVALID', 'Codex configuration requires an absolute root')
  if (options.signal?.aborted === true) throw failure('CODEX_CONFIG_CANCELLED', 'Codex configuration was cancelled')
  const timeoutMs = options.timeoutMs ?? 15_000
  const maxMessageBytes = options.maxMessageBytes ?? 4 * 1024 * 1024
  const maxSessionBytes = options.maxSessionBytes ?? 16 * 1024 * 1024
  const child = spawn(executable, [...(options.prefixArguments ?? []), 'app-server', '--stdio'], {
    cwd: options.cwd ?? configRoot ?? homedir(),
    env: { ...(options.env ?? process.env), ...(configRoot === undefined ? {} : { CODEX_HOME: configRoot }) },
    stdio: ['pipe', 'pipe', 'pipe'], ...managedSpawnOptions(),
  })
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  let buffer = ''
  let bufferBytes = 0
  let receivedBytes = 0
  let sequence = 0
  let closed = false
  let terminalError = null
  let closing = null
  let userPath = null
  const pending = new Map()
  const close = () => {
    if (closing === null) {
      closed = true
      child.stdin.end()
      closing = closeOwnedProcessTree(child, { gracefulWaitMs: 100, termWaitMs: 500 })
    }
    return closing
  }
  const fail = (error) => {
    terminalError ??= error
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(terminalError) }
    pending.clear()
    void close().catch(() => {})
  }
  const send = (message) => {
    if (terminalError !== null) throw terminalError
    if (closed) throw failure('CODEX_CONFIG_CLOSED', 'The Codex configuration connection is closed')
    const bytes = JSON.stringify(message) + '\n'
    if (Buffer.byteLength(bytes) > maxMessageBytes) throw failure('CODEX_CONFIG_LIMIT', 'The Codex configuration request exceeds its message bound')
    child.stdin.write(bytes)
  }
  const receive = (line) => {
    let message
    try { message = JSON.parse(line) } catch { throw protocolFailure() }
    if (!object(message)) throw protocolFailure()
    if (typeof message.method === 'string') {
      if (Object.hasOwn(message, 'id')) {
        send({ id: message.id, error: { code: -32601, message: 'Interactive requests are not supported by this configuration client' } })
      }
      return
    }
    const waiter = pending.get(message.id)
    if (waiter === undefined || (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error'))) throw protocolFailure()
    pending.delete(message.id)
    clearTimeout(waiter.timer)
    if (message.error !== undefined) {
      const conflict = message.error?.data?.config_write_error_code === 'configVersionConflict'
      waiter.reject(failure(conflict ? 'CODEX_CONFIG_CHANGED' : 'CODEX_CONFIG_REQUEST_FAILED',
        conflict ? 'Codex configuration changed after it was read; the stale write was rejected' : 'Codex could not complete the configuration request'))
    } else waiter.resolve(message.result)
  }
  child.stdout.on('data', (chunk) => {
    if (closed) return
    receivedBytes += chunk.length
    if (receivedBytes > maxSessionBytes) { fail(failure('CODEX_CONFIG_LIMIT', 'Codex configuration output exceeds its session bound')); return }
    try {
      try { buffer += decoder.decode(chunk, { stream: true }) } catch { throw protocolFailure() }
      bufferBytes += chunk.length
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        const bytes = Buffer.byteLength(line) + 1
        if (bytes > maxMessageBytes) throw failure('CODEX_CONFIG_LIMIT', 'Codex configuration output exceeds its message bound')
        buffer = buffer.slice(newline + 1)
        bufferBytes -= bytes
        receive(line)
      }
      if (bufferBytes > maxMessageBytes) throw failure('CODEX_CONFIG_LIMIT', 'Codex configuration output exceeds its message bound')
    } catch (error) { fail(error) }
  })
  child.stderr.on('data', (chunk) => {
    receivedBytes += chunk.length
    if (receivedBytes > maxSessionBytes) fail(failure('CODEX_CONFIG_LIMIT', 'Codex configuration output exceeds its session bound'))
  })
  child.stdin.on('error', () => { if (!closed) fail(failure('CODEX_CONFIG_CLOSED', 'The Codex configuration connection closed')) })
  child.once('error', () => fail(failure('CODEX_CONFIG_UNAVAILABLE', 'Codex configuration could not be started')))
  child.once('close', () => { if (!closed) fail(failure('CODEX_CONFIG_CLOSED', 'The Codex configuration process exited before completion')) })
  const onAbort = () => fail(failure('CODEX_CONFIG_CANCELLED', 'Codex configuration was cancelled'))
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const request = (method, params) => new Promise((resolveRequest, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => fail(failure('CODEX_CONFIG_TIMEOUT', 'Codex configuration did not respond before its deadline')), timeoutMs)
    pending.set(id, { resolve: resolveRequest, reject, timer })
    try { send({ id, method, params }) } catch (error) { fail(error) }
  })
  let result
  let operationError = null
  try {
    await request('initialize', { clientInfo: { name: 'agent_host_configuration', version: '1.0.0' }, capabilities: { experimentalApi: false } })
    send({ method: 'initialized', params: {} })
    const client = {
      async read() {
        const state = userConfiguration(await request('config/read', { includeLayers: true, cwd: options.cwd ?? configRoot ?? homedir() }))
        if (userPath !== null && state.filePath !== userPath) throw protocolFailure()
        userPath = state.filePath
        return state
      },
      async write(previous, changes) {
        if (!absolutePath(previous?.filePath) || previous.filePath !== userPath || !version(previous?.version)) throw protocolFailure()
        const result = await request('config/batchWrite', { filePath: previous.filePath, expectedVersion: previous.version,
          reloadUserConfig: false, edits: editsFor(changes) })
        if (result?.status !== 'ok' || result.filePath !== previous.filePath || !version(result.version)) throw protocolFailure()
        return { filePath: result.filePath, version: result.version }
      },
    }
    result = await callback(client)
    if (terminalError !== null) throw terminalError
  } catch (error) { operationError = error }
  finally {
    options.signal?.removeEventListener('abort', onAbort)
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(failure('CODEX_CONFIG_CLOSED', 'The Codex configuration connection closed')) }
    pending.clear()
    try { await close() } catch {
      operationError = new AgentHostError('CODEX_CONFIG_CLEANUP_FAILED', 'The owned Codex configuration process could not be closed', {
        causeCode: operationError?.code ?? null,
      })
    }
  }
  if (operationError !== null) throw operationError
  return result
}
