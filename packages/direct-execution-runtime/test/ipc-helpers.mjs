import { createHash } from 'node:crypto'
import { access } from 'node:fs/promises'
import { connect } from 'node:net'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

export function testSocketPath(directory, name = 'runtime.sock') {
  if (process.platform !== 'win32') return resolve(directory, name)
  const id = createHash('sha256').update(resolve(directory, name)).digest('hex').slice(0, 24)
  return `\\.\pipe\openadam-test-${id}`
}
export async function assertEndpointAbsent(socketPath) {
  if (process.platform !== 'win32') {
    await assert.rejects(() => access(socketPath), (error) => error.code === 'ENOENT')
    return
  }
  await new Promise((resolve, reject) => {
    const socket = connect({ path: socketPath })
    socket.once('connect', () => { socket.destroy(); reject(new Error('Named pipe remains reachable')) })
    socket.once('error', (error) => {
      socket.destroy()
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) resolve()
      else reject(error)
    })
  })
}
