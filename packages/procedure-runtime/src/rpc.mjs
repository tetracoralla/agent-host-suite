import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import {
  closeOwnedProcessTree,
  managedSpawnOptions,
} from '../../../src/process-tree.mjs'
import { ProcedureError, id } from './value.mjs'

export class Rpc extends EventEmitter {
  constructor(
    command,
    args,
    { cwd, env = {}, jsonrpc = false, deadlineMs = 30000 } = {},
  ) {
    super()
    this.pending = new Map()
    this.jsonrpc = jsonrpc
    this.deadlineMs = deadlineMs
    this.closed = false
    this.bytes = 0
    this.buffer = ''
    this.stderr = ''
    this.child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      ...managedSpawnOptions(),
    })
    this.decoder = new StringDecoder('utf8')
    this.child.stdout.on('data', (chunk) => {
      try {
        this.bytes += chunk.length
        if (this.bytes > 64 * 1024 * 1024)
          throw new ProcedureError(
            'PROTOCOL_LIMIT',
            'Worker output exceeds 64 MiB',
          )
        this.buffer += this.decoder.write(chunk)
        let n
        while ((n = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, n)
          this.buffer = this.buffer.slice(n + 1)
          if (Buffer.byteLength(line) > 4 * 1024 * 1024)
            throw new ProcedureError(
              'PROTOCOL_LIMIT',
              'Worker message exceeds 4 MiB',
            )
          if (line.trim()) this.receive(JSON.parse(line))
        }
        if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024)
          throw new ProcedureError(
            'PROTOCOL_LIMIT',
            'Worker message exceeds 4 MiB',
          )
      } catch (e) {
        this.fail(e)
      }
    })
    this.child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-8000)
    })
    this.child.stdin.on('error', (error) => this.fail(error))
    this.child.on('error', (error) => this.fail(error))
    this.child.once('close', (code, signal) => {
      this.closed = true
      this.fail(
        new ProcedureError('WORKER_DISCONNECTED', 'Worker connection ended', {
          code,
          signal,
          diagnostic: this.stderr.slice(-1500),
        }),
      )
      this.emit('closed', { code, signal })
    })
  }
  receive(message) {
    if (message.method) {
      this.emit(Object.hasOwn(message, 'id') ? 'request' : 'event', message)
      return
    }
    const entry = this.pending.get(message.id)
    if (!entry) {
      this.emit('late', message)
      return
    }
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error)
      entry.reject(
        new ProcedureError('PROVIDER_ERROR', message.error.message, {
          native: message.error,
        }),
      )
    else entry.resolve(message.result)
  }
  send(message) {
    if (this.closed)
      throw new ProcedureError(
        'WORKER_DISCONNECTED',
        'Worker is no longer connected',
      )
    const data =
      JSON.stringify({
        ...(this.jsonrpc ? { jsonrpc: '2.0' } : {}),
        ...message,
      }) + '\n'
    if (Buffer.byteLength(data) > 4 * 1024 * 1024)
      throw new ProcedureError('PROTOCOL_LIMIT', 'Worker request exceeds 4 MiB')
    this.child.stdin.write(data)
  }
  request(method, params = {}, timeout = this.deadlineMs) {
    const requestId = id()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(
          new ProcedureError(
            'PROVIDER_TIMEOUT',
            `${method} did not finish; execution may have occurred`,
            { requestId, method },
          ),
        )
      }, timeout)
      this.pending.set(requestId, { resolve, reject, timer })
      try {
        this.send({ id: requestId, method, params })
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(e)
      }
    })
  }
  notify(method, params = {}) {
    this.send({ method, params })
  }
  reply(requestId, result) {
    this.send({ id: requestId, result })
  }
  reject(requestId, message = 'Unsupported request') {
    this.send({ id: requestId, error: { code: -32601, message } })
  }
  fail(error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(error)
    }
    this.pending.clear()
    this.emit('failure', error)
  }
  async close() {
    if (this.closing) return this.closing
    this.closing = (async () => {
      if (!this.closed) this.child.stdin.end()
      await closeOwnedProcessTree(this.child, {
        gracefulWaitMs: 500,
        termWaitMs: 1200,
      })
      this.closed = true
    })()
    return this.closing
  }
}
