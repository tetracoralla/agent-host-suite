import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { AgentHostError } from './errors.mjs'
import { canonicalJson } from './json.mjs'

export const MAX_FILE_BYTES = 4 * 1024 * 1024
export const missing = Object.freeze({ present: false })
export const equal = (left, right) => canonicalJson(left) === canonicalJson(right)
export const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
export const conflict = () => new AgentHostError('ENVIRONMENT_RESOURCE_CHANGED', 'A resource changed outside the recorded environment transition; it was preserved')
export const invalid = () => new AgentHostError('ENVIRONMENT_CHANGE_INVALID', 'The environment recovery record contains an unsupported resource')
export const exactKeys = (value, keys) => object(value) && Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => Object.hasOwn(value, key))
export const selectorValid = (keys) => Array.isArray(keys) && keys.length > 0 && keys.length <= 8
  && keys.every((key) => typeof key === 'string' && key.length > 0)
export const cellValid = (value) => equal(value, missing) || (exactKeys(value, ['present', 'value']) && value.present === true)
export const identityValid = (value) => exactKeys(value, ['dev', 'ino']) && ['dev', 'ino'].every((key) => typeof value[key] === 'string' && /^\d+$/u.test(value[key]))
export const descriptorValid = (value) => value === null || (exactKeys(value, ['kind', 'target']) && value.kind === 'link' && typeof value.target === 'string')
  || (exactKeys(value, ['kind', 'identity']) && ['file', 'directory'].includes(value.kind) && identityValid(value.identity))
export const identity = (info) => ({ dev: String(info.dev), ino: String(info.ino) })

export async function existing(path) {
  return lstat(path, { bigint: true }).catch((error) => { if (error.code === 'ENOENT') return null; throw error })
}

export async function proofFor(path) {
  const parent = await realpath(dirname(path))
  const info = await lstat(parent, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink()) throw conflict()
  return { path: join(parent, basename(path)), parent: identity(info) }
}

export async function checkProof(proof) {
  if (await realpath(dirname(proof.path)).catch(() => null) !== dirname(proof.path)) throw conflict()
  const info = await existing(dirname(proof.path))
  if (!info?.isDirectory() || !equal(identity(info), proof.parent)) throw conflict()
}

export function proofValid(proof) {
  return exactKeys(proof, ['path', 'parent']) && typeof proof.path === 'string' && isAbsolute(proof.path)
    && resolve(proof.path) === proof.path && identityValid(proof.parent)
}

export function getCell(value, keys) {
  for (const key of keys) {
    if (!object(value) || !Object.hasOwn(value, key)) return missing
    value = value[key]
  }
  return { present: true, value }
}

export function setCell(value, keys, cell) {
  let cursor = value
  for (const key of keys.slice(0, -1)) {
    if (!Object.hasOwn(cursor, key)) {
      if (!cell.present) return
      Object.defineProperty(cursor, key, { value: {}, writable: true, enumerable: true, configurable: true })
    }
    if (!object(cursor[key])) throw conflict()
    cursor = cursor[key]
  }
  if (cell.present) Object.defineProperty(cursor, keys.at(-1), { value: structuredClone(cell.value), writable: true, enumerable: true, configurable: true })
  else delete cursor[keys.at(-1)]
}

export function restoreFields(step, current) {
  const next = structuredClone(current ?? {})
  for (const change of step.changes) {
    const cell = getCell(next, change.keys)
    if (!equal(cell, change.before) && !equal(cell, change.after)) throw conflict()
    setCell(next, change.keys, change.before)
  }
  for (const keys of [...(step.prune ?? [])].sort((a, b) => b.length - a.length)) {
    const cell = getCell(next, keys)
    if (cell.present && object(cell.value) && Object.keys(cell.value).length === 0) setCell(next, keys, missing)
  }
  return step.fileCreated && Object.keys(next).length === 0 ? null : next
}
