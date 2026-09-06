import { basename, dirname } from 'node:path'
import { AgentHostError } from '../errors.mjs'
import { recordEnvironmentChange } from '../environment-change.mjs'
import {
  MAX_FILE_BYTES, cellValid, checkProof, conflict, equal, exactKeys, existing, getCell,
  invalid, object, proofFor, proofValid, restoreFields,
} from '../environment-resource-state.mjs'
import { resolveExecutable, runFile } from '../process.mjs'
import { withCodexConfiguration } from './codex-config.mjs'

const keysValid = (keys) => Array.isArray(keys) && (keys.length === 2 || (keys.length === 3 && keys[0] === 'plugins' && keys[2] === 'enabled')) && ['plugins', 'marketplaces'].includes(keys[0])
  && typeof keys[1] === 'string' && keys[1].length > 0 && keys[1].length <= 256
const registrationCell = (cell, keys) => cellValid(cell) && (!cell.present || (keys.length === 3 ? typeof cell.value === 'boolean' : object(cell.value)))

export function validateCodexResourceChange(step) {
  if (!exactKeys(step, ['kind', 'proof', 'changes']) || step.kind !== 'codex-config'
    || !proofValid(step.proof) || basename(step.proof.path) !== 'config.toml'
    || !Array.isArray(step.changes) || step.changes.length === 0 || step.changes.length > 4096) throw invalid()
  const seen = new Set()
  for (const change of step.changes) {
    if (!exactKeys(change, ['keys', 'before', 'after']) || !keysValid(change.keys)
      || !registrationCell(change.before, change.keys) || !registrationCell(change.after, change.keys)) throw invalid()
    // A whole registration and its enabled field cannot share one step: both
    // before-cells were read from the same snapshot, so their undo would overlap.
    const key = JSON.stringify(change.keys.slice(0, 2))
    if (seen.has(key)) throw invalid()
    seen.add(key)
  }
}

async function checkFile(proof) {
  await checkProof(proof)
  const info = await existing(proof.path)
  if (info !== null && (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES)) throw conflict()
}

async function read(client, proof) {
  await checkFile(proof)
  const snapshot = await client.read()
  if ((await proofFor(snapshot.filePath)).path !== proof.path) throw conflict()
  await checkFile(proof)
  return snapshot
}

async function withResource(proof, dependencies, callback) {
  await checkFile(proof)
  // The journal contains registration data, never an executable or command.
  // Recovery resolves the current installed public Codex entry point itself.
  const executable = await resolveExecutable('codex', dependencies.runner ?? runFile)
  if (executable === null) throw new AgentHostError('CODEX_NOT_INSTALLED', 'Codex is required to recover its public configuration')
  return (dependencies.codexConfiguration ?? withCodexConfiguration)(executable, {
    configRoot: dirname(proof.path), signal: dependencies.signal,
  }, (client) => callback(client))
}

export async function writeEnvironmentCodex(client, previous, changes, apply = null) {
  if (!Array.isArray(changes) || changes.length === 0) throw invalid()
  const proof = await proofFor(previous.filePath)
  const step = { kind: 'codex-config', proof, changes: changes.map((change) => {
    if (!object(change) || !keysValid(change.keys)
      || (change.value !== null && (change.keys.length === 3 ? typeof change.value !== 'boolean' : !object(change.value)))) throw invalid()
    return { keys: change.keys, before: getCell(previous.config, change.keys),
      after: change.value === null ? { present: false } : { present: true, value: change.value } }
  }) }
  validateCodexResourceChange(step)
  const current = await read(client, proof)
  if (current.version !== previous.version || !equal(current.config, previous.config)) throw conflict()
  step.changes = step.changes.filter((change) => !equal(change.before, change.after))
  if (step.changes.length === 0) {
    if (apply !== null) throw invalid()
    return current
  }
  await recordEnvironmentChange(step)
  await checkFile(proof)
  if (apply === null) await client.write(current, step.changes.map((change) => ({ keys: change.keys, value: change.after.present ? change.after.value : null })))
  else await apply()
  const after = await read(client, proof)
  if (step.changes.some((change) => !equal(getCell(after.config, change.keys), change.after))) throw conflict()
  return after
}

export async function planCodexResourceRecovery(step, virtual, dependencies) {
  validateCodexResourceChange(step)
  await checkFile(step.proof)
  const key = 'codex-config:' + step.proof.path
  if (!virtual.has(key)) {
    const snapshot = await withResource(step.proof, dependencies, (client) => read(client, step.proof))
    virtual.set(key, snapshot.config)
  }
  virtual.set(key, restoreFields(step, virtual.get(key)))
  return async () => withResource(step.proof, dependencies, async (client) => {
    const current = await read(client, step.proof)
    // Compare the selected cells again against the current native snapshot.
    // Unrelated later edits are retained; the version check closes the race
    // between this read and the native write without replacing whole TOML.
    const restored = restoreFields(step, current.config)
    const changes = step.changes.filter((change) => !equal(getCell(current.config, change.keys), change.before))
      .map((change) => ({ keys: change.keys, value: change.before.present ? change.before.value : null }))
    if (changes.length === 0) return
    await checkFile(step.proof)
    await client.write(current, changes)
    const after = await read(client, step.proof)
    if (step.changes.some((change) => !equal(getCell(after.config, change.keys), getCell(restored, change.keys)))) throw conflict()
  })
}
