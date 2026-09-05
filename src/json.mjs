import { createHash, randomUUID } from 'node:crypto'
import { chmod, open, readFile, rename, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { AgentHostError } from './errors.mjs'

export async function readJson(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new AgentHostError('STATE_INVALID_JSON', `Invalid JSON at ${path}: ${error.message}`)
  }
}

const pendingWrites = new Map()

export async function writePrivateJson(path, value) {
  const contents = `${JSON.stringify(value, null, 2)}\n`
  const absolute = resolve(path)
  const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute
  const previous = pendingWrites.get(key) ?? Promise.resolve()
  const writing = previous.catch(() => {}).then(() => writePrivateJsonNow(path, contents))
  pendingWrites.set(key, writing)
  try {
    await writing
  } finally {
    if (pendingWrites.get(key) === writing) pendingWrites.delete(key)
  }
}

async function writePrivateJsonNow(path, contents) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(contents)
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  await handle.close()
  try {
    await chmod(temporary, 0o600)
    // Windows can briefly hold the replaced destination open. Retry the atomic
    // rename, never unlink the previous state to make room.
    const deadline = Date.now() + 1000
    for (;;) {
      try { await rename(temporary, path); break } catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || Date.now() >= deadline) throw error
        await new Promise((done) => setTimeout(done, 20))
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

export function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}
