import { readFile, readlink, rename, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  MAX_FILE_BYTES, equal, conflict, invalid, exactKeys, selectorValid, cellValid, descriptorValid,
  identity, existing, proofFor, checkProof, proofValid, getCell, object, restoreFields,
} from './environment-resource-state.mjs'
import { writePrivateJson } from './json.mjs'
import { afterEnvironmentCommit, hasEnvironmentChange, recordEnvironmentChange } from './environment-change.mjs'
import { planCodexResourceRecovery, validateCodexResourceChange } from './hosts/codex-config-resource.mjs'
import { planLaunchdRecovery, validateLaunchdChange } from './launchd-environment.mjs'
import { planWindowsServiceRecovery, validateWindowsServiceChange } from './windows-service-environment.mjs'

async function readDocument(proof) {
  await checkProof(proof)
  const info = await existing(proof.path)
  if (info === null) return { bytes: null, value: null }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) throw conflict()
  const bytes = await readFile(proof.path, 'utf8')
  if (Buffer.byteLength(bytes) > MAX_FILE_BYTES) throw conflict()
  let value
  try { value = JSON.parse(bytes) } catch { throw conflict() }
  if (!object(value)) throw conflict()
  return { bytes, value }
}

// A document the user removed after a pure-addition step already lacks the
// cells it added, so its undo result is the same absence rather than a
// recreated empty file. Steps that changed or removed existing cells keep
// failing closed: their before document cannot be reconstructed.
function absentDocumentUndo(step) {
  return step.changes.every((change) => !change.before.present) ? null : restoreFields(step, null)
}

export async function writeEnvironmentJson(path, value, selectors, expected) {
  const proof = await proofFor(path)
  const before = await readDocument(proof)
  if (expected !== undefined && !equal(before.value, expected)) throw conflict()
  const changes = selectors.filter((keys) => !equal(getCell(before.value, keys), getCell(value, keys)))
    .map((keys) => ({ keys, before: getCell(before.value, keys), after: getCell(value, keys) }))
  if (changes.length === 0) return
  const prune = []
  for (const { keys } of changes) {
    for (let length = 1; length < keys.length; length += 1) {
      const parent = keys.slice(0, length)
      if (!getCell(before.value, parent).present && !prune.some((item) => equal(item, parent))) prune.push(parent)
    }
  }
  const step = { kind: 'json-fields', proof, changes, prune, fileCreated: before.value === null }
  await recordEnvironmentChange(step)
  if ((await readDocument(proof)).bytes !== before.bytes) throw conflict()
  if (value === null) await rm(proof.path, { force: true })
  else await writePrivateJson(proof.path, value)
}

async function describe(proof) {
  await checkProof(proof)
  const info = await existing(proof.path)
  if (info === null) return null
  if (info.isSymbolicLink()) return { kind: 'link', target: await readlink(proof.path) }
  if (info.isDirectory() || info.isFile()) return { kind: info.isDirectory() ? 'directory' : 'file', identity: identity(info) }
  throw conflict()
}

export async function moveEnvironmentPath(from, to) {
  const source = await proofFor(from)
  const destination = await proofFor(to)
  const before = await describe(source)
  if (before === null || await describe(destination) !== null) throw conflict()
  await recordEnvironmentChange({ kind: 'path-move', source, destination, before })
  if (!equal(await describe(source), before) || await describe(destination) !== null) throw conflict()
  await rename(source.path, destination.path)
}

export async function removeEnvironmentDirectory(path, paths) {
  if (!hasEnvironmentChange(paths)) return rm(path, { recursive: true, force: true })
  if (await existing(path) === null) return
  const backup = join(paths.backups, `retired-environment-${randomUUID()}`)
  await moveEnvironmentPath(path, backup)
  await afterEnvironmentCommit(() => rm(backup, { recursive: true, force: true }))
}

async function replaceLink(proof, target) {
  if (target === null) { await rm(proof.path, { force: true }); return }
  const temporary = `${proof.path}.tmp-${process.pid}-${randomUUID()}`
  try {
    await symlink(target, temporary, process.platform === 'win32' ? 'junction' : 'dir')
    await rename(temporary, proof.path)
  } finally { await rm(temporary, { force: true }) }
}

export async function setEnvironmentLink(path, target) {
  const proof = await proofFor(path)
  const before = await describe(proof)
  if (before !== null && before.kind !== 'link') throw conflict()
  const after = target === null ? null : { kind: 'link', target }
  if (equal(before, after)) return
  await recordEnvironmentChange({ kind: 'link', proof, before, after })
  if (!equal(await describe(proof), before)) throw conflict()
  await replaceLink(proof, target)
}

export function validateResourceChange(step) {
  if (step?.kind === 'windows-service') return validateWindowsServiceChange(step)
  if (step?.kind === 'launchd-service') return validateLaunchdChange(step)
  if (step?.kind === 'codex-config') return validateCodexResourceChange(step)
  if (step?.kind === 'json-fields') {
    if (!exactKeys(step, ['kind', 'proof', 'changes', 'prune', 'fileCreated']) || !proofValid(step.proof)
      || typeof step.fileCreated !== 'boolean' || !Array.isArray(step.changes) || step.changes.length > 4096
      || !Array.isArray(step.prune) || step.prune.some((keys) => !selectorValid(keys))) throw invalid()
    for (const change of step.changes) if (!exactKeys(change, ['keys', 'before', 'after']) || !selectorValid(change.keys)
      || !cellValid(change.before) || !cellValid(change.after)) throw invalid()
    if (step.prune.some((keys) => !step.changes.some((change) => keys.length < change.keys.length
      && keys.every((key, index) => key === change.keys[index])))) throw invalid()
    return
  }
  if (step?.kind === 'path-move' && exactKeys(step, ['kind', 'source', 'destination', 'before'])
    && proofValid(step.source) && proofValid(step.destination) && step.source.path !== step.destination.path
    && step.before !== null && descriptorValid(step.before)) return
  if (step?.kind === 'link' && exactKeys(step, ['kind', 'proof', 'before', 'after']) && proofValid(step.proof)
    && [step.before, step.after].every((value) => value === null || (descriptorValid(value) && value.kind === 'link'))) return
  throw invalid()
}

// Virtual reversal checks the entire remaining sequence without writing. The
// journal drops one step only after its undo succeeds; a crash between undo and
// that durable update is accepted because the resource already equals before.
export async function planResourceRecovery(steps, dependencies = {}) {
  const virtual = new Map()
  const read = async (proof, json = false) => {
    await checkProof(proof)
    const key = `${json ? 'json' : 'path'}:${proof.path}`
    if (!virtual.has(key)) virtual.set(key, json ? (await readDocument(proof)).value : await describe(proof))
    return { key, value: virtual.get(key) }
  }
  const actions = []
  for (const step of [...steps].reverse()) {
    validateResourceChange(step)
    if (step.kind === 'windows-service') {
      actions.push(await planWindowsServiceRecovery(step, virtual, dependencies))
    } else if (step.kind === 'launchd-service') {
      actions.push(await planLaunchdRecovery(step, virtual, dependencies))
    } else if (step.kind === 'codex-config') {
      actions.push(await planCodexResourceRecovery(step, virtual, dependencies))
    } else if (step.kind === 'json-fields') {
      const current = await read(step.proof, true)
      virtual.set(current.key, current.value === null && !step.fileCreated
        ? absentDocumentUndo(step) : restoreFields(step, current.value))
      actions.push(async () => {
        const actual = await readDocument(step.proof)
        const restored = actual.value === null && !step.fileCreated
          ? absentDocumentUndo(step) : restoreFields(step, actual.value)
        if (equal(restored, actual.value)) return
        if ((await readDocument(step.proof)).bytes !== actual.bytes) throw conflict()
        if (restored === null) await rm(step.proof.path, { force: true })
        else await writePrivateJson(step.proof.path, restored)
      })
    } else if (step.kind === 'link') {
      const current = await read(step.proof)
      if (!equal(current.value, step.before) && !equal(current.value, step.after)) throw conflict()
      virtual.set(current.key, step.before)
      actions.push(async () => {
        const actual = await describe(step.proof)
        if (equal(actual, step.before)) return
        if (!equal(actual, step.after)) throw conflict()
        await replaceLink(step.proof, step.before?.target ?? null)
      })
    } else {
      const source = await read(step.source)
      const destination = await read(step.destination)
      const original = equal(source.value, step.before) && destination.value === null
      const moved = source.value === null && equal(destination.value, step.before)
      if (!original && !moved) throw conflict()
      virtual.set(source.key, step.before)
      virtual.set(destination.key, null)
      actions.push(async () => {
        const from = await describe(step.source)
        const to = await describe(step.destination)
        if (equal(from, step.before) && to === null) return
        if (from !== null || !equal(to, step.before)) throw conflict()
        await rename(step.destination.path, step.source.path)
      })
    }
  }
  return actions
}
