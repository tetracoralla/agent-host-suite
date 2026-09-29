import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Coordinator } from '../packages/procedure-runtime/src/coordinator.mjs'
import {
  declaredOutputs,
  declaredTaskOutputs,
  procedureDescription,
  procedureSummary,
  validateProcedureInput,
  validateProcedureOutputs,
  validateInstalledProcedure,
} from '../packages/procedure-runtime/src/product.mjs'
import {
  runRequestDigest,
  runRequestSchema,
  runRequestTaskId,
  validateRunRequest,
} from '../packages/procedure-runtime/src/run-request.mjs'
import { AgentHostError } from './errors.mjs'
import { withLifecycleMutation } from './lifecycle-lock.mjs'
import { resolveStateRoot } from './paths.mjs'
import { runFile } from './process.mjs'
import {
  loadState,
  readStatePaths,
  saveState,
} from './state.mjs'
import { procedureCurrentlyVerified, procedureDependencySnapshot, projectProcedureAvailability, verifiedProcedureAvailability } from './procedure-availability.mjs'

const MAX_CONTRACT_BYTES = 1024 * 1024
const DIRECT_RESULT_CLAIM_SCHEMA = 'openadam.agent-host-procedure-result-claim.v0.1'
const DIRECT_RESULT_POLL_MS = 25
const VERIFICATION_WRITE_RETRIES = 40
const verificationWrites = new Map()
const stopped = new Set([
  'complete',
  'failed',
  'waiting_user',
  'paused',
  'cancelled',
  'reconciling',
])

function fail(code, message, details) {
  throw new AgentHostError(code, message, details)
}

async function jsonFile(path, label) {
  let bytes
  try {
    bytes = await readFile(path)
  } catch (error) {
    fail('PROCEDURE_PRODUCT_UNAVAILABLE', `${label} is unavailable`, {
      cause: error.message,
    })
  }
  if (bytes.length > MAX_CONTRACT_BYTES) {
    fail('PROCEDURE_PRODUCT_LIMIT', `${label} exceeds 1 MiB`)
  }
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    fail('PROCEDURE_PRODUCT_INVALID', `${label} is invalid JSON`, {
      cause: error.message,
    })
  }
}

export async function loadAgenticProcedure(componentId, component) {
  if (
    component?.productType !== 'procedure' ||
    component.procedureExecution?.kind !== 'agentic-runner'
  ) {
    fail(
      'PROCEDURE_EXECUTION_UNSUPPORTED',
      `${componentId} is not an Agentic Runner Procedure`,
    )
  }
  const [method, inputSchema, outputSchema] = await Promise.all([
    jsonFile(component.procedureExecution.methodPath, `${componentId} method`),
    jsonFile(component.procedure.inputSchemaPath, `${componentId} input schema`),
    jsonFile(component.procedure.outputSchemaPath, `${componentId} output schema`),
  ])
  return validateInstalledProcedure({
    componentId,
    fingerprint: component.fingerprint,
    id: component.procedure.id,
    version: component.procedure.version,
    name: component.displayName ?? component.procedure.id,
    description: component.summary ?? '',
    permissions: component.procedure.permissions,
    permissionCeiling: component.procedure.permissionCeiling ?? component.procedure.permissions,
    resources: component.procedure.resources,
    lifecycle: component.procedure.lifecycle,
    execution: { kind: 'agentic-runner' },
    outputArtifacts: component.procedureExecution.outputArtifacts,
    method,
    inputSchema,
    outputSchema,
  })
}

export async function installedProcedureProducts(state) {
  const products = []
  for (const [componentId, component] of Object.entries(state.components ?? {})) {
    if (component?.productType !== 'procedure') continue
    if (component.procedureExecution?.kind === 'agentic-runner') {
      products.push(await loadAgenticProcedure(componentId, component))
      continue
    }
    products.push({
      componentId,
      id: component.procedure.id,
      version: component.procedure.version,
      name: component.displayName ?? component.procedure.id,
      description: component.summary ?? '',
      permissions: [...component.procedure.permissions],
      permissionCeiling: [...(component.procedure.permissionCeiling ?? component.procedure.permissions)],
      resources: structuredClone(component.procedure.resources ?? []),
      lifecycle: structuredClone(component.procedure.lifecycle),
      execution: { kind: 'direct-runtime' },
      inputSchema: await jsonFile(component.procedure.inputSchemaPath, `${componentId} input schema`),
      outputSchema: await jsonFile(component.procedure.outputSchemaPath, `${componentId} output schema`),
    })
  }
  return products.sort((left, right) => left.id.localeCompare(right.id) || left.version.localeCompare(right.version))
}

function exactProduct(products, id, version) {
  const matches = products.filter(
    (procedure) => procedure.id === id && procedure.version === version,
  )
  if (matches.length === 0) fail('PROCEDURE_NOT_INSTALLED', `Procedure ${id}@${version} is not installed`)
  if (matches.length > 1) fail('PROCEDURE_IDENTITY_CONFLICT', `Procedure ${id}@${version} is installed more than once`)
  return matches[0]
}

async function waitForStop(coordinator, taskId, timeoutMs) {
  const current = coordinator.get(taskId)
  if (stopped.has(current.status)) return current
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      coordinator.off('change', changed)
      reject(new AgentHostError('PROCEDURE_RUN_TIMEOUT', 'Procedure Run exceeded the invocation wait limit'))
    }, timeoutMs)
    const changed = (changedTask) => {
      if (changedTask !== taskId) return
      const task = coordinator.get(taskId)
      if (!stopped.has(task.status)) return
      clearTimeout(timer)
      coordinator.off('change', changed)
      resolve(task)
    }
    coordinator.on('change', changed)
  })
}

function resultEnvelope(procedure, task, outputs = undefined) {
  const pendingPermissions = (task.status === 'waiting_user' ? (task.permissions ?? []) : [])
    .filter((permission) => permission.status === 'pending')
    .map((permission) => ({
      id: permission.id,
      method: permission.method ?? null,
      requiredGrant: permission.requiredGrant ?? null,
    }))
  return {
    schemaVersion: 'openadam.agent-host-procedure-result.v0.1',
    status: task.status,
    procedure: { id: procedure.id, version: procedure.version },
    execution: procedure.execution.kind,
    taskId: task.id,
    runId: task.runId,
    ...(outputs === undefined ? {} : { outputs }),
    ...(task.question === null || task.question === undefined ? {} : {
      interaction: {
        kind: task.question.kind ?? 'agent-question',
        id: task.question.id,
        prompt: task.question.text,
        ...(task.question.node === undefined ? {} : { node: task.question.node }),
        ...(task.question.options === undefined ? {} : { options: task.question.options }),
      },
    }),
    ...(pendingPermissions.length === 0 ? {} : { pendingPermissions }),
    ...(task.problem === null || task.problem === undefined ? {} : {
      error: task.problem,
    }),
  }
}

function childRunSegment(idempotencyKey) {
  const safe = idempotencyKey.replace(/[^a-zA-Z0-9._-]+/gu, '-').slice(0, 48) || 'child'
  return `${safe}-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 12)}`
}

function procedureRunRoot(paths, request, dependencies) {
  const stack = dependencies.procedureStack ?? []
  if (stack.length === 0) return join(paths.runtime, 'procedure-runs')
  // Subprocedure runs get their own coordinator state directory keyed by the
  // delegating attempt's idempotency key: the parent coordinator stays open
  // while the child executes, and one store root admits exactly one owner.
  return join(paths.runtime, 'procedure-runs', 'children', childRunSegment(request.idempotencyKey))
}

function taskProcedure(task, current = undefined) {
  if (task.procedureRef === null || task.procedureRef === undefined) {
    fail('PROCEDURE_RUN_INVALID', 'Procedure Run has no product identity')
  }
  if (task.procedureProduct !== null && task.procedureProduct !== undefined) {
    return {
      id: task.procedureRef.id,
      version: task.procedureRef.version,
      componentId: task.procedureProduct.componentId,
      fingerprint: task.procedureProduct.fingerprint,
      execution: { kind: task.procedureProduct.execution },
      outputArtifacts: [...task.procedureProduct.outputArtifacts],
      outputSchema: structuredClone(task.procedureProduct.outputSchema),
    }
  }
  return exactProduct(current ?? [], task.procedureRef.id, task.procedureRef.version)
}

async function directTargetInvocation(state, call, dependencies) {
  const runtime = state.components?.['direct-execution-runtime']
  if (typeof runtime?.command !== 'string' || !Array.isArray(runtime.args)) {
    fail('PROCEDURE_RUNTIME_UNAVAILABLE', 'The installed Direct Runtime command is unavailable')
  }
  if (typeof state.runtime?.socketPath !== 'string') {
    fail('PROCEDURE_RUNTIME_UNAVAILABLE', 'The installed Direct Runtime endpoint is unavailable')
  }
  const orderId = `procedure-${createHash('sha256').update(call.idempotencyKey ?? randomUUID()).digest('hex').slice(0, 32)}`
  const order = {
    schemaVersion: 'openadam.direct-work-order.v0.2',
    purpose: 'task',
    id: orderId,
    calls: [{
      id: 'procedure',
      providerId: call.providerId,
      target: call.target,
      input: call.input,
      ...(call.timeoutMs === undefined ? {} : { timeoutMs: Math.min(call.timeoutMs, 300_000) }),
    }],
  }
  const runner = dependencies.runner ?? runFile
  const result = await runner(
    runtime.command,
    [...runtime.args, 'run', '--socket', state.runtime.socketPath, '--work-order', '-'],
    {
      input: `${JSON.stringify(order)}\n`,
      timeoutMs: dependencies.timeoutMs ?? 305_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  )
  let output
  try {
    output = JSON.parse(result.stdout)
  } catch (error) {
    fail('PROCEDURE_RESULT_INVALID', 'Direct Runtime returned invalid JSON', { cause: error.message })
  }
  const returnedCall = output?.calls?.[0]
  if (output?.status !== 'ok' || returnedCall?.status !== 'ok') {
    fail('PROCEDURE_RUN_FAILED', 'Direct Runtime call failed', { result: output })
  }
  return returnedCall.result
}

async function directInvocation(state, component, procedure, request, runIdentity, dependencies) {
  if (Object.keys(request.resources).length > 0)
    fail('PROCEDURE_RESOURCE_UNSUPPORTED', 'Direct Runtime Procedure resource bindings are not supported by the current work-order contract')
  const result = await directTargetInvocation(state, {
    providerId: component.procedureExecution.providerId,
    target: {
      kind: 'procedure',
      procedureId: procedure.id,
      procedureVersion: procedure.version,
    },
    input: request.inputs,
    timeoutMs: request.limits.nodeTimeoutMs,
    idempotencyKey: request.idempotencyKey,
  }, dependencies)
  const outputs = validateProcedureOutputs(procedure, result)
  return {
    schemaVersion: 'openadam.agent-host-procedure-result.v0.1',
    status: 'complete',
    procedure: { id: procedure.id, version: procedure.version },
    execution: 'direct-runtime',
    taskId: null,
    runId: `procedure-${runIdentity.slice(0, 32)}`,
    outputs,
  }
}

function directRunIdentity(state, component, procedure, request) {
  return createHash('sha256')
    .update(JSON.stringify({
      procedure: { id: procedure.id, version: procedure.version },
      dependencies: procedureDependencySnapshot(state, component),
      idempotencyKey: request.idempotencyKey,
    }))
    .digest('hex')
}

function directResultPath(paths, runIdentity) {
  return join(paths.runtime, 'procedure-direct-results', `${runIdentity}.json`)
}

async function readDirectResult(path, requestDigest) {
  let bytes
  try {
    bytes = await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { found: false }
    throw error
  }
  let cached
  try {
    cached = JSON.parse(bytes)
  } catch (error) {
    fail('PROCEDURE_RESULT_INVALID', 'The durable Direct Procedure result is invalid JSON', { cause: error.message })
  }
  if (cached === null || typeof cached !== 'object' || Array.isArray(cached)
    || typeof cached.requestDigest !== 'string' || cached.result === undefined) {
    fail('PROCEDURE_RESULT_INVALID', 'The durable Direct Procedure result is invalid')
  }
  if (cached.requestDigest !== requestDigest)
    fail('PROCEDURE_IDEMPOTENCY_CONFLICT', 'The idempotency key belongs to a different Run Request')
  return { found: true, result: cached.result }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    if (error.code === 'EPERM') return true
    throw error
  }
}

function validDirectClaim(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && value.schemaVersion === DIRECT_RESULT_CLAIM_SCHEMA
    && typeof value.token === 'string' && value.token.length > 0
    && Number.isInteger(value.pid) && value.pid > 0
    && typeof value.requestDigest === 'string' && value.requestDigest.length === 64
}

async function acquireDirectResultClaim(path, requestDigest, waitMs) {
  const claimPath = `${path}.inflight`
  const deadline = Date.now() + waitMs
  while (true) {
    const token = randomUUID()
    try {
      await mkdir(claimPath, { mode: 0o700 })
      const claim = {
        schemaVersion: DIRECT_RESULT_CLAIM_SCHEMA,
        token,
        pid: process.pid,
        requestDigest,
      }
      try {
        await writeFile(join(claimPath, 'owner.json'), `${JSON.stringify(claim)}\n`, { mode: 0o600, flag: 'wx' })
      } catch (error) {
        await rm(claimPath, { recursive: true, force: true }).catch(() => {})
        throw error
      }
      return { claimPath, token, cached: null }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }

    const cached = await readDirectResult(path, requestDigest)
    if (cached.found) return { claimPath: null, token: null, cached: cached.result }

    let owner
    try {
      owner = JSON.parse(await readFile(join(claimPath, 'owner.json'), 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT' && Date.now() < deadline) {
        await delay(DIRECT_RESULT_POLL_MS)
        continue
      }
      fail('PROCEDURE_RESULT_CLAIM_INVALID', 'The Direct Procedure result claim is incomplete or invalid')
    }
    if (!validDirectClaim(owner))
      fail('PROCEDURE_RESULT_CLAIM_INVALID', 'The Direct Procedure result claim is incomplete or invalid')
    if (owner.requestDigest !== requestDigest)
      fail('PROCEDURE_IDEMPOTENCY_CONFLICT', 'The idempotency key belongs to a different Run Request')

    if (!processIsAlive(owner.pid)) {
      const stalePath = `${claimPath}.stale-${token}`
      try {
        await rename(claimPath, stalePath)
      } catch (error) {
        if (error.code === 'ENOENT') continue
        throw error
      }
      await rm(stalePath, { recursive: true, force: false })
      continue
    }
    if (Date.now() >= deadline)
      fail('PROCEDURE_INVOCATION_IN_PROGRESS', 'The same Direct Procedure request is still running')
    await delay(Math.min(DIRECT_RESULT_POLL_MS, deadline - Date.now()))
  }
}

async function releaseDirectResultClaim(claimPath, token) {
  if (claimPath === null) return
  let owner
  try {
    owner = JSON.parse(await readFile(join(claimPath, 'owner.json'), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  if (owner?.token !== token)
    fail('PROCEDURE_RESULT_CLAIM_INVALID', 'The Direct Procedure result claim changed before completion')
  await rm(claimPath, { recursive: true, force: false })
}

async function cachedDirectInvocation(paths, state, component, procedure, request, dependencies) {
  // Authority must be checked before reading a durable result. Otherwise a
  // result cached by an older Host policy could bypass the current grant
  // boundary after an upgrade.
  const missingGrants = procedure.permissions.filter(
    (permission) => !request.grants.includes(permission),
  )
  if (missingGrants.length > 0) {
    fail(
      'PROCEDURE_GRANT_REQUIRED',
      `Direct Runtime Procedure requires explicit task grants: ${missingGrants.join(', ')}`,
      { permissions: missingGrants },
    )
  }
  const runIdentity = directRunIdentity(state, component, procedure, request)
  const path = directResultPath(paths, runIdentity)
  const digest = runRequestDigest(request)
  const cached = await readDirectResult(path, digest)
  if (cached.found) return cached.result
  await mkdir(join(paths.runtime, 'procedure-direct-results'), { recursive: true, mode: 0o700 })
  const claim = await acquireDirectResultClaim(
    path,
    digest,
    Math.min(request.limits.maxDurationMs, dependencies.timeoutMs ?? 305_000) + 1_000,
  )
  if (claim.cached !== null) return claim.cached
  try {
    const claimedCache = await readDirectResult(path, digest)
    if (claimedCache.found) return claimedCache.result
    const result = await directInvocation(state, component, procedure, request, runIdentity, dependencies)
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify({ requestDigest: digest, result })}\n`, { mode: 0o600, flag: 'wx' })
    try {
      await link(temporary, path)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const winner = await readDirectResult(path, digest)
      if (!winner.found) throw error
      return winner.result
    } finally {
      await rm(temporary, { force: true })
    }
    return result
  } finally {
    await releaseDirectResultClaim(claim.claimPath, claim.token)
  }
}

function sameDependencySnapshot(left, right) {
  return left?.procedureFingerprint === right?.procedureFingerprint
    && left?.runtimeFingerprint === right?.runtimeFingerprint
    && left?.bindingFingerprint === right?.bindingFingerprint
}

async function recordVerifiedInvocation(stateRoot, componentId, expectedDependencies, dependencies) {
  const root = resolveStateRoot(stateRoot)
  const key = `${root}\0${componentId}\0${JSON.stringify(expectedDependencies)}`
  const active = verificationWrites.get(key)
  if (active !== undefined) return await active

  const write = (async () => {
    const statePaths = await readStatePaths(root)
    for (let attempt = 0; attempt < VERIFICATION_WRITE_RETRIES; attempt++) {
      const currentState = await loadState(statePaths)
      const currentComponent = currentState?.components?.[componentId]
      if (currentComponent === undefined
        || !sameDependencySnapshot(procedureDependencySnapshot(currentState, currentComponent), expectedDependencies)) return
      if (procedureCurrentlyVerified(currentState, currentComponent)) return

      try {
        const operation = `procedure.verify-${randomUUID()}`
        await withLifecycleMutation(
          statePaths,
          operation,
          { ...dependencies, migrateState: true },
          async (_inner, paths) => {
            const state = await loadState(paths)
            const component = state?.components?.[componentId]
            if (component === undefined
              || !sameDependencySnapshot(procedureDependencySnapshot(state, component), expectedDependencies)
              || procedureCurrentlyVerified(state, component)) return
            const verifiedAt = new Date().toISOString()
            component.procedureAvailability = verifiedProcedureAvailability(
              state,
              component,
              verifiedAt,
            )
            const privateComponent = state.privateComponents?.[componentId]?.current?.component
            if (privateComponent?.fingerprint === expectedDependencies.procedureFingerprint) {
              privateComponent.procedureAvailability = structuredClone(component.procedureAvailability)
            }
            state.updatedAt = verifiedAt
            await saveState(paths, state)
          },
        )
        return
      } catch (error) {
        if (!(error instanceof AgentHostError
          && ['LIFECYCLE_BUSY', 'LIFECYCLE_RECOVERY_BUSY'].includes(error.code))) throw error
      }
      await delay(DIRECT_RESULT_POLL_MS)
    }
    // Availability is a conservative projection of completed work. A busy
    // lifecycle must not turn an already completed Procedure result into a
    // failure; leaving the evidence unverified is the safe fallback.
  })()
  verificationWrites.set(key, write)
  try {
    return await write
  } finally {
    if (verificationWrites.get(key) === write) verificationWrites.delete(key)
  }
}

// Both executors resolve the executing environment through `load` so one
// implementation serves a Host invocation (snapshot resolved once per Run)
// and an embedding workspace such as Procedure Studio (fresh per call).
function directCallExecutor(load, dependencies) {
  return async (call) => {
    if (Object.keys(call.resources ?? {}).length > 0)
      fail('PROCEDURE_RESOURCE_UNSUPPORTED', 'Direct Runtime Capability calls cannot receive resource bindings in the current work-order contract')
    const { state } = await load()
    const { providerId, ...target } = call.target
    return directTargetInvocation(state, {
      providerId,
      target,
      input: call.input,
      timeoutMs: call.timeoutMs,
      idempotencyKey: call.idempotencyKey,
    }, dependencies)
  }
}

function procedureCallExecutor(load, stack, dependencies) {
  return async (call) => {
    const identity = `${call.procedure.id}@${call.procedure.version}`
    if (stack.includes(identity))
      fail('PROCEDURE_RECURSION', `Subprocedure cycle detected at ${identity}`)
    const { paths, products } = await load()
    exactProduct(products, call.procedure.id, call.procedure.version)
    const nested = {
      ...dependencies,
      procedureStack: [...stack, identity],
      workspaceDelegation: call.delegation ?? null,
    }
    const prior = call.continuation !== null && call.continuation !== undefined
      && call.continuation.procedure === identity
        ? call.continuation
        : null
    let result
    if (prior !== null) {
      // The child Run is durable: a fresh parent process continues it instead
      // of restarting the composed work. A child that already completed
      // (for example after a parent restart) returns its recorded outputs.
      const existing = await inspectProcedureRun({ stateRoot: paths.root, run: prior.run, runRoot: prior.root }, nested)
      if (existing.status === 'complete') {
        result = existing
      } else if (
        prior.pendingAnswer !== undefined
        && existing.status === 'waiting_user'
        && existing.interaction
        && existing.interaction.id !== prior.pendingAnswer.questionId
      ) {
        // The child's current question is not the one this answer was given
        // for (its session advanced elsewhere): re-surface the child's
        // current question as a fresh wait instead of delivering the stale
        // answer to it.
        result = existing
      } else {
        const answerCurrent = prior.pendingAnswer !== undefined
          && existing.status === 'waiting_user'
          && existing.interaction?.id === prior.pendingAnswer.questionId
        const input = answerCurrent
          ? { action: 'answer', questionId: prior.pendingAnswer.questionId, value: prior.pendingAnswer.value }
          : { action: 'resume' }
        try {
          result = await continueProcedureRun({
            stateRoot: paths.root,
            run: prior.run,
            runRoot: prior.root,
            input,
            timeoutMs: call.limits?.maxDurationMs,
          }, nested)
        } catch (error) {
          // A parent that declined or lost the mirrored answer still owes the
          // child its answer; re-surface the child question as a fresh wait
          // instead of failing the composed Run. STALE_ANSWER covers a child
          // question that changed between the inspect above and this call.
          if (error.code !== 'ANSWER_REQUIRED' && error.code !== 'STALE_ANSWER') throw error
          const waiting = await inspectProcedureRun({ stateRoot: paths.root, run: prior.run, runRoot: prior.root }, nested)
          if (waiting.status === 'waiting_user' && waiting.interaction) result = waiting
          else throw error
        }
      }
    } else {
      const request = {
        schemaVersion: runRequestSchema,
        procedure: call.procedure,
        inputs: call.inputs,
        grants: call.grants,
        resources: call.resources,
        limits: call.limits,
        idempotencyKey: call.idempotencyKey,
      }
      result = await invokeInstalledProcedure({ stateRoot: paths.root, request }, nested)
    }
    if (result.status !== 'complete') {
      // Only a child question offers a continuation: answering it through the
      // parent resumes the same child Run. A child paused on a provider
      // permission or a run limit would loop if resumed one-shot — its
      // pending permissions are surfaced for diagnosis instead.
      const question = result.status === 'waiting_user' ? result.interaction : null
      const continuable = Boolean(question)
      fail('SUBPROCEDURE_WAIT_REQUIRED', `Subprocedure ${identity} stopped ${result.status} before completing. ${continuable ? 'Answer the parent Run to continue the same child Run.' : 'The nested Run is not continuable from this embedding; a live Runner session or a new Run is required.'}`, {
        status: result.status,
        ...(result.pendingPermissions?.length ? { pendingPermissions: result.pendingPermissions } : {}),
        ...(continuable ? {
          continuation: {
            run: result.taskId,
            // A continued child keeps the root it was created under: a
            // re-executed parent attempt has a fresh idempotency key, which
            // would otherwise derive a directory the child Run does not live
            // in.
            root: prior !== null ? prior.root : procedureRunRoot(paths, { idempotencyKey: call.idempotencyKey }, nested),
            procedure: identity,
            interaction: question,
          },
        } : {}),
      })
    }
    return result.outputs
  }
}

function coordinatorOptions(state, paths, products, dependencies, stack = []) {
  const snapshot = async () => ({ state, paths, products })
  return {
    procedures: products.filter((candidate) => candidate.execution.kind === 'agentic-runner'),
    ...(dependencies.adapterFactory === undefined ? {} : { adapterFactory: dependencies.adapterFactory }),
    executeDirectCall: dependencies.executeDirectCall ?? directCallExecutor(snapshot, dependencies),
    executeProcedureCall: dependencies.executeProcedureCall ?? procedureCallExecutor(snapshot, stack, dependencies),
  }
}

// Execution wiring for an embedding workspace: Capability calls and
// subprocedure calls run through the installed Agent environment identified
// by `environmentRoot`, with its state resolved again on every call so
// installs, updates and removals take effect without restarting the embedding.
export function procedureEnvironmentExecutors(environmentRoot, dependencies = {}) {
  const root = resolveStateRoot(environmentRoot)
  const load = async () => {
    const paths = await readStatePaths(root)
    const state = await loadState(paths)
    if (state === null) fail('NOT_INSTALLED', 'No Agent environment is installed')
    return { state, paths, products: await installedProcedureProducts(state) }
  }
  return {
    executeDirectCall: directCallExecutor(load, dependencies),
    executeProcedureCall: procedureCallExecutor(load, [], dependencies),
  }
}

export async function invokeInstalledProcedure(options, dependencies = {}) {
  const paths = await readStatePaths(resolveStateRoot(options.stateRoot))
  const state = await loadState(paths)
  if (state === null) fail('NOT_INSTALLED', 'No Agent environment is installed')
  const products = await installedProcedureProducts(state)
  if (options.request === undefined)
    fail('PROCEDURE_RUN_REQUEST_REQUIRED', 'Procedure invocation requires one formal Run Request')
  const requestedIdentity = options.request?.procedure ?? {}
  const procedure = exactProduct(products, requestedIdentity.id, requestedIdentity.version)
  const request = validateRunRequest(options.request, procedure)
  validateProcedureInput(procedure, request.inputs)
  const component = state.components[procedure.componentId]
  const expectedDependencies = procedureDependencySnapshot(state, component)
  let result
  if (procedure.execution.kind === 'direct-runtime') {
    result = await cachedDirectInvocation(paths, state, component, procedure, request, dependencies)
  } else {
    const coordinator = new Coordinator(procedureRunRoot(paths, request, dependencies), {
      ...coordinatorOptions(
        state,
        paths,
        products,
        dependencies,
        dependencies.procedureStack ?? [`${procedure.id}@${procedure.version}`],
      ),
      ...(dependencies.workspaceDelegation ? { workspaceDelegation: dependencies.workspaceDelegation } : {}),
    })
    try {
      let task
      try {
        task = coordinator.create({
          taskId: runRequestTaskId(request),
          procedureRef: { id: procedure.id, version: procedure.version },
          inputs: request.inputs,
          grants: request.grants,
          resources: request.resources,
          limits: request.limits,
          idempotencyKey: request.idempotencyKey,
        })
      } catch (error) {
        if (error.code === 'REQUEST_CONFLICT')
          fail('PROCEDURE_IDEMPOTENCY_CONFLICT', 'The idempotency key belongs to a different Run Request')
        throw error
      }
      if (task.status === 'ready' && task.nodeExecutions === 0)
        coordinator.command(task.id, {
          requestId: `start-${task.id}`,
          expectedRevision: task.revision,
          action: 'start',
        })
      if (!stopped.has(coordinator.get(task.id).status))
        await waitForStop(coordinator, task.id, request.limits.maxDurationMs)
      await coordinator.finishSession()
      const final = coordinator.get(task.id)
      result = resultEnvelope(
        procedure,
        final,
        final.status === 'complete'
          ? declaredOutputs(procedure, final, coordinator.store)
          : undefined,
      )
    } finally {
      await coordinator.close()
    }
  }
  if (result.status === 'complete') {
    await recordVerifiedInvocation(paths.root, procedure.componentId, expectedDependencies, dependencies)
  }
  return result
}

export async function inspectProcedureRun(options, dependencies = {}) {
  const paths = await readStatePaths(resolveStateRoot(options.stateRoot))
  const state = await loadState(paths)
  if (state === null) fail('NOT_INSTALLED', 'No Agent environment is installed')
  const products = await installedProcedureProducts(state)
  const procedures = products.filter(
    (procedure) => procedure.execution.kind === 'agentic-runner',
  )
  const coordinator = new Coordinator(options.runRoot ?? join(paths.runtime, 'procedure-runs'), {
    ...coordinatorOptions(state, paths, products, dependencies),
    ...(dependencies.workspaceDelegation ? { workspaceDelegation: dependencies.workspaceDelegation } : {}),
  })
  try {
    const task = coordinator.get(options.run)
    const procedure = taskProcedure(task, procedures)
    return resultEnvelope(
      procedure,
      task,
      task.status === 'complete'
        ? validateProcedureOutputs(procedure, declaredTaskOutputs(procedure.outputArtifacts, task, coordinator.store))
        : undefined,
    )
  } finally {
    await coordinator.close()
  }
}

function continuation(task, input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('PROCEDURE_CONTINUATION_INVALID', 'Procedure continuation must be one JSON object')
  }
  const requestId = `continue-${randomUUID()}`
  const common = { requestId, expectedRevision: task.revision }
  if (input.action === 'answer') {
    const value = input.value ?? input.text
    if (value === undefined || JSON.stringify(value).length > 64000) fail('PROCEDURE_CONTINUATION_INVALID', 'Procedure answer requires a bounded value')
    if (task.question?.id === undefined) fail('PROCEDURE_CONTINUATION_INVALID', 'Procedure Run has no current question')
    if (input.questionId !== undefined && typeof input.questionId !== 'string') {
      fail('PROCEDURE_CONTINUATION_INVALID', 'Procedure answer questionId must be a string')
    }
    // An explicit questionId binds the answer to that question; the
    // coordinator rejects a mismatch instead of answering whichever question
    // happens to be current.
    return {
      ...common,
      action: 'answer',
      questionId: input.questionId ?? task.question.id,
      value,
      reject: input.reject === true,
    }
  }
  if (input.action === 'resume' || input.action === 'cancel') {
    return { ...common, action: input.action }
  }
  if (input.action === 'permission') {
    fail(
      'PROCEDURE_PERMISSION_SESSION_REQUIRED',
      'Provider permission decisions are accepted only by the live Runner session that holds the turn. One-shot procedure continue cannot answer them.',
    )
  }
  if (input.action === 'input') {
    if (typeof input.text !== 'string' || input.text.length === 0) fail('PROCEDURE_CONTINUATION_INVALID', 'Procedure input requires text')
    return {
      ...common,
      action: 'input',
      text: input.text,
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(input.impact === undefined ? {} : { impact: input.impact }),
    }
  }
  fail('PROCEDURE_CONTINUATION_INVALID', 'Procedure continuation action must be answer, input, resume or cancel')
}

export async function continueProcedureRun(options, dependencies = {}) {
  const paths = await readStatePaths(resolveStateRoot(options.stateRoot))
  const state = await loadState(paths)
  if (state === null) fail('NOT_INSTALLED', 'No Agent environment is installed')
  const products = await installedProcedureProducts(state)
  const procedures = products.filter(
    (procedure) => procedure.execution.kind === 'agentic-runner',
  )
  const coordinator = new Coordinator(options.runRoot ?? join(paths.runtime, 'procedure-runs'), {
    ...coordinatorOptions(state, paths, products, dependencies),
    ...(dependencies.workspaceDelegation ? { workspaceDelegation: dependencies.workspaceDelegation } : {}),
  })
  try {
    const task = coordinator.get(options.run)
    const procedure = taskProcedure(task, procedures)
    const currentComponent = state.components?.[procedure.componentId]
    const expectedDependencies = currentComponent?.fingerprint === procedure.fingerprint
      ? procedureDependencySnapshot(state, currentComponent)
      : null
    coordinator.command(task.id, continuation(task, options.input))
    await waitForStop(coordinator, task.id, options.timeoutMs ?? 30 * 60 * 1000)
    await coordinator.finishSession()
    const final = coordinator.get(task.id)
    const result = resultEnvelope(
      procedure,
      final,
      final.status === 'complete'
        ? validateProcedureOutputs(procedure, declaredTaskOutputs(procedure.outputArtifacts, final, coordinator.store))
        : undefined,
    )
    if (result.status === 'complete' && expectedDependencies !== null) {
      await recordVerifiedInvocation(paths.root, procedure.componentId, expectedDependencies, dependencies)
    }
    return result
  } finally {
    await coordinator.close()
  }
}

export async function listInstalledProcedures(options = {}) {
  const paths = await readStatePaths(resolveStateRoot(options.stateRoot))
  const state = await loadState(paths)
  if (state === null) fail('NOT_INSTALLED', 'No Agent environment is installed')
  const query = (options.query ?? '').trim().toLocaleLowerCase('en-US')
  if (query.length > 200) fail('PROCEDURE_CATALOG_QUERY_INVALID', 'Procedure search query exceeds 200 characters')
  const limit = options.limit ?? 20
  const budgetBytes = options.budgetBytes ?? 32 * 1024
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    fail('PROCEDURE_CATALOG_LIMIT_INVALID', 'Procedure list limit must be from 1 to 100')
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 1024 || budgetBytes > 256 * 1024)
    fail('PROCEDURE_CATALOG_BUDGET_INVALID', 'Procedure list budget must be from 1024 to 262144 bytes')
  let after = null
  if (options.cursor !== undefined) {
    try {
      const decoded = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'))
      if (decoded.v !== 1 || !Array.isArray(decoded.after) || decoded.after.length !== 2 || decoded.after.some((item) => typeof item !== 'string') || decoded.query !== query) throw new Error('cursor mismatch')
      after = { id: decoded.after[0], version: decoded.after[1] }
    } catch {
      fail('PROCEDURE_CATALOG_CURSOR_INVALID', 'Procedure list cursor is invalid for this search')
    }
  }
  const filtered = (await installedProcedureProducts(state))
    .filter((procedure) => {
      const haystack = `${procedure.id}\n${procedure.version}\n${procedure.name}\n${procedure.description}`.toLocaleLowerCase('en-US')
      return query.length === 0 || haystack.includes(query)
    })
  const compare = (left, right) => left.id.localeCompare(right.id) || left.version.localeCompare(right.version)
  const candidates = after === null
    ? filtered
    : filtered.filter((procedure) => compare(procedure, after) > 0)
  const procedures = []
  const response = (items, remaining) => {
    const last = items.at(-1)
    const nextCursor = remaining === 0 || last === undefined
      ? null
      : Buffer.from(JSON.stringify({ v: 1, after: [last.id, last.version], query })).toString('base64url')
    const value = {
      schemaVersion: 'openadam.agent-host-procedure-catalog.v0.2',
      status: 'ok',
      query,
      procedures: items,
      page: { returned: items.length, remaining, nextCursor },
      budget: { limitBytes: budgetBytes, usedBytes: 0 },
    }
    let previous = -1
    while (value.budget.usedBytes !== previous) {
      previous = value.budget.usedBytes
      value.budget.usedBytes = Buffer.byteLength(JSON.stringify(value))
    }
    return value
  }
  for (const procedure of candidates.slice(0, limit)) {
    const component = state.components[procedure.componentId]
    const item = {
      ...procedureSummary(procedure),
      availability: projectProcedureAvailability(state, component),
    }
    const trial = response([...procedures, item], candidates.length - procedures.length - 1)
    if (trial.budget.usedBytes > budgetBytes) {
      if (procedures.length === 0)
        fail('PROCEDURE_CATALOG_BUDGET_TOO_SMALL', 'Procedure list budget cannot fit one compact summary', { requiredBytes: trial.budget.usedBytes })
      break
    }
    procedures.push(item)
  }
  return response(procedures, candidates.length - procedures.length)
}

export async function describeInstalledProcedure(options = {}) {
  const paths = await readStatePaths(resolveStateRoot(options.stateRoot))
  const state = await loadState(paths)
  if (state === null) fail('NOT_INSTALLED', 'No Agent environment is installed')
  const procedure = exactProduct(await installedProcedureProducts(state), options.id, options.version)
  const component = state.components[procedure.componentId]
  return {
    schemaVersion: 'openadam.agent-host-procedure-description.v0.1',
    status: 'ok',
    procedure: {
      ...procedureDescription(procedure),
      invocation: structuredClone(component.procedureInvocation),
      availability: projectProcedureAvailability(state, component),
    },
    runRequest: {
      schemaVersion: runRequestSchema,
      required: ['schemaVersion', 'procedure', 'inputs', 'grants', 'resources', 'limits', 'idempotencyKey'],
      limits: {
        maxDurationMs: 1_800_000,
        maxNodeExecutions: 100,
        maxAgentTurns: procedure.execution.kind === 'direct-runtime' ? 0 : 12,
        nodeTimeoutMs: 300_000,
        maxAttemptsPerNode: 4,
        maxOutputBytes: 256_000,
      },
    },
  }
}
