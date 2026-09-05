import { spawn } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import { closeOwnedProcessTree, managedSpawnOptions } from './process-tree.mjs'

/**
 * Host-owned MCP stdio transport for bounded probes. Unlike the stock SDK
 * transport, close resolves only after its owned process scope is confirmed
 * absent. Processes that leave that scope are not observable here.
 */
export class ManagedMcpStdioTransport {
  #server
  #process
  #readBuffer
  #stderrStream
  #closing
  #termination

  constructor(server) {
    this.#server = { ...server, args: [...(server.args ?? [])], env: server.env === undefined ? undefined : { ...server.env } }
    this.#readBuffer = new ReadBuffer({ maxBufferSize: server.maxBufferSize })
    if (server.stderr === 'pipe' || server.stderr === 'overlapped') this.#stderrStream = new PassThrough()
  }

  get stderr() {
    return this.#stderrStream ?? this.#process?.stderr ?? null
  }

  get pid() {
    return this.#process?.pid ?? null
  }

  get termination() {
    return this.#termination ?? null
  }

  async start() {
    if (this.#process !== undefined) throw new Error('Managed MCP stdio transport is already started')
    const child = spawn(this.#server.command, this.#server.args, {
      cwd: this.#server.cwd,
      env: { ...getDefaultEnvironment(), ...this.#server.env },
      stdio: ['pipe', 'pipe', this.#server.stderr ?? 'inherit'],
      shell: false,
      ...managedSpawnOptions(),
    })
    this.#process = child
    child.on('error', (error) => {
      this.onerror?.(error)
    })
    child.stdout.on('data', (chunk) => {
      try {
        this.#readBuffer.append(chunk)
        while (true) {
          const message = this.#readBuffer.readMessage()
          if (message === null) break
          this.onmessage?.(message)
        }
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)))
        void this.close().catch((closeError) => this.onerror?.(closeError))
      }
    })
    child.stdout.on('error', (error) => this.onerror?.(error))
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') this.onerror?.(error)
    })
    if (this.#stderrStream !== undefined && child.stderr !== null) child.stderr.pipe(this.#stderrStream)
    child.once('close', () => {
      this.onclose?.()
    })
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        child.off('spawn', onSpawn)
        child.off('error', onError)
      }
      const onSpawn = () => {
        cleanup()
        resolve()
      }
      const onError = (error) => {
        cleanup()
        reject(error)
      }
      child.once('spawn', onSpawn)
      child.once('error', onError)
    })
  }

  async send(message) {
    const stdin = this.#process?.stdin
    if (stdin === undefined) throw new Error('Managed MCP stdio transport is not connected')
    const serialized = serializeMessage(message)
    await new Promise((resolve, reject) => {
      const accepted = stdin.write(serialized, (error) => error === null || error === undefined ? resolve() : reject(error))
      if (!accepted) stdin.once('drain', resolve)
    })
  }

  async close() {
    if (this.#closing !== undefined) return await this.#closing
    const child = this.#process
    const closing = closeOwnedProcessTree(child)
    this.#closing = closing
    try {
      this.#termination = await closing
      if (this.#process === child) this.#process = undefined
      this.#readBuffer.clear()
    } finally {
      if (this.#closing === closing) this.#closing = undefined
    }
  }
}
