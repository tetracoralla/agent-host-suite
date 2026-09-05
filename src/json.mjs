import { createHash, randomUUID } from 'node:crypto'
import { chmod, open, readFile, rename, rm } from 'node:fs/promises'
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

export async function writePrivateJson(path, value) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  await handle.close()
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

export function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}
