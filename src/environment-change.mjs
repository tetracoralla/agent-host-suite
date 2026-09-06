import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { lstat, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentHostError } from './errors.mjs'
import { readJson, writePrivateJson } from './json.mjs'
import { assertPrivateAccess } from './private-permissions.mjs'
import { planResourceRecovery, validateResourceChange } from './environment-resources.mjs'
import { validateState } from './state.mjs'

export const CHANGE_STATE_SCHEMA = 'openadam.agent-host-changing.v0.1'
const JOURNAL_SCHEMA = 'openadam.agent-host-environment-change.v0.1'
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024
const contexts = new AsyncLocalStorage()
const journalPath = (paths) => join(paths.root, '.environment-change.json')
const isPointer = (value) => value?.schemaVersion === CHANGE_STATE_SCHEMA
const required = () => new AgentHostError('ENVIRONMENT_RECOVERY_REQUIRED', 'An interrupted environment change must be recovered before continuing')

export function environmentDependencies() { return contexts.getStore()?.dependencies ?? null }

function validateJournal(journal, pointer, paths) {
  if (journal?.schemaVersion !== JOURNAL_SCHEMA || journal.id !== pointer.id || journal.root !== paths.root
    || Object.keys(journal).some((key) => !['schemaVersion', 'id', 'root', 'operation', 'previousState', 'steps'].includes(key))
    || typeof journal.operation !== 'string' || !Array.isArray(journal.steps) || journal.steps.length > 4096
    || (journal.previousState !== null && (typeof journal.previousState !== 'object' || Array.isArray(journal.previousState) || isPointer(journal.previousState)))
    || Object.keys(pointer).some((key) => !['schemaVersion', 'id'].includes(key))
    || !/^[0-9a-f-]{36}$/u.test(pointer.id ?? '')) throw required()
  for (const step of journal.steps) validateResourceChange(step)
  if (journal.previousState !== null) validateState(journal.previousState)
  return journal
}

async function readJournal(paths, pointer) {
  const path = journalPath(paths)
  const info = await lstat(path).catch(() => null)
  if (!info?.isFile() || info.isSymbolicLink() || info.size > MAX_JOURNAL_BYTES) throw required()
  await assertPrivateAccess(path, info)
  const contents = await readFile(path, 'utf8')
  if (Buffer.byteLength(contents) > MAX_JOURNAL_BYTES) throw required()
  let journal
  try { journal = JSON.parse(contents) } catch { throw required() }
  return validateJournal(journal, pointer, paths)
}

async function persistJournal(context) {
  if (Buffer.byteLength(JSON.stringify(context.journal)) > MAX_JOURNAL_BYTES) {
    throw new AgentHostError('ENVIRONMENT_CHANGE_LIMIT', 'The environment recovery record exceeds its storage bound')
  }
  await writePrivateJson(journalPath(context.paths), context.journal)
}

// The pointer is the authority for an unfinished transaction. A stable state
// (including absence after uninstall) means commit finished, even when cleanup
// of the now-unreferenced journal was interrupted. Older readers reject this
// versioned pointer instead of adopting an incompletely installed environment.
export async function recordEnvironmentChange(step) {
  const context = contexts.getStore()
  if (context === undefined || context.recovering) return
  validateResourceChange(step)
  if (context.journal === null) {
    const previousState = await readJson(context.paths.state)
    if (isPointer(previousState)) throw required()
    if (previousState !== null) validateState(previousState)
    context.journal = { schemaVersion: JOURNAL_SCHEMA, id: randomUUID(), root: context.paths.root,
      operation: context.operation, previousState, steps: [step] }
    try {
      await persistJournal(context)
      await writePrivateJson(context.paths.state, { schemaVersion: CHANGE_STATE_SCHEMA, id: context.journal.id })
    } catch (error) {
      const published = await readJson(context.paths.state).catch(() => null)
      if (!isPointer(published) || published.id !== context.journal.id) context.journal = null
      throw error
    }
  } else {
    if (context.journal.steps.length >= 4096) throw new AgentHostError('ENVIRONMENT_CHANGE_LIMIT', 'The environment recovery record has too many resource changes')
    context.journal.steps.push(step)
    try { await persistJournal(context) } catch (error) {
      context.journal.steps.pop()
      throw error
    }
  }
  await context.dependencies.afterEnvironmentChangePrepared?.({ kind: step.kind, count: context.journal.steps.length })
}

export function readableEnvironmentState(paths, state) {
  if (!isPointer(state)) return state
  const context = contexts.getStore()
  if (context?.paths.root !== paths.root || context.journal?.id !== state.id) throw required()
  return structuredClone(context.journal.previousState)
}

export async function environmentStateCommitted(paths) {
  const context = contexts.getStore()
  if (context?.paths.root !== paths.root) return
  const hadJournal = context.journal !== null
  context.journal = null
  const cleanup = context.cleanup.splice(0)
  // Commit already replaced the pointer. Cleanup cannot turn that success into
  // an exception that causes callers to compensate a committed installation.
  if (hadJournal) await rm(journalPath(paths), { force: true }).catch(() => { context.cleanupFailures += 1 })
  for (const task of cleanup) await task().catch(() => { context.cleanupFailures += 1 })
}

export async function afterEnvironmentCommit(task) {
  const context = contexts.getStore()
  if (context === undefined) return task()
  context.cleanup.push(task)
}

export function hasEnvironmentChange(paths, kind) {
  const context = contexts.getStore()
  return context?.paths.root === paths.root && context.journal !== null
    && (kind === undefined || context.journal.steps.some((step) => step.kind === kind))
}

export async function recoverCurrentEnvironmentChange(paths) {
  const context = contexts.getStore()
  if (context?.paths.root !== paths.root) throw required()
  if (context.journal !== null) await recover(context)
}

async function recover(context) {
  const journal = context.journal
  const pointer = await readJson(context.paths.state)
  if (!isPointer(pointer)) {
    await environmentStateCommitted(context.paths)
    return
  }
  if (pointer.id !== journal.id) throw required()
  context.recovering = true
  context.cleanup = []
  try {
    // Inspect every remaining resource before changing any of them. Each action
    // also rechecks its observation; another application's edits are not locked
    // by the Host lease, and a conflict must retain the recovery record.
    const actions = await planResourceRecovery(journal.steps, context.dependencies)
    for (const action of actions) {
      await action()
      journal.steps.pop()
      await context.dependencies.afterEnvironmentRecoveryStep?.({ remaining: journal.steps.length })
      await persistJournal(context)
    }
    if (journal.previousState === null) await rm(context.paths.state, { force: true })
    else await writePrivateJson(context.paths.state, journal.previousState)
    await environmentStateCommitted(context.paths)
  } finally { context.recovering = false }
}

export async function withEnvironmentChange(paths, operation, dependencies, callback) {
  const context = { paths, operation, dependencies, journal: null, recovering: false, cleanup: [], cleanupFailures: 0 }
  return contexts.run(context, async () => {
    const state = await readJson(paths.state).catch((error) => {
      // Local preferences can still be changed while the installation state is
      // unreadable. Any later external effect independently validates it in
      // recordEnvironmentChange; environment retries must expose the error.
      if (dependencies.recoverEnvironmentChange === true || dependencies.environmentDryRun === true) throw error
      return null
    })
    if (isPointer(state)) {
      if (dependencies.environmentDryRun === true || dependencies.recoverEnvironmentChange !== true) throw required()
      context.journal = await readJournal(paths, state)
      await recover(context)
    }
    try {
      const result = await callback()
      // A mutation that has no state commit must leave no unowned effects.
      if (context.journal !== null) await recover(context)
      if (context.cleanupFailures > 0 && result !== null && typeof result === 'object' && !Array.isArray(result)) {
        return { ...result, warnings: [...(result.warnings ?? []), {
          code: 'ENVIRONMENT_CLEANUP_INCOMPLETE',
          message: 'The environment change completed, but some private recovery records or retired projections could not be removed.',
          count: context.cleanupFailures,
        }] }
      }
      return result
    } catch (error) {
      if (context.journal !== null) {
        try { await recover(context) } catch (recoveryError) {
          throw new AgentHostError('ENVIRONMENT_RECOVERY_REQUIRED', 'The environment change failed and needs recovery; its previous ownership records were retained', {
            operation, causeCode: error.code ?? 'AGENT_HOST_INTERNAL', recoveryCode: recoveryError.code ?? 'AGENT_HOST_INTERNAL',
          })
        }
      }
      throw error
    }
  })
}
