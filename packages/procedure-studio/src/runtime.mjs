import { randomUUID } from 'node:crypto'
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Coordinator } from '../../procedure-runtime/src/coordinator.mjs'
import { runRequestSchema, validateRunRequest } from '../../procedure-runtime/src/run-request.mjs'
import { studioError } from './validation.mjs'

const STOPPED = new Set(['ready', 'paused', 'waiting_user', 'failed', 'complete', 'cancelled', 'reconciling'])

function runDirectoryName(digest) {
  return digest.replace(/^sha256:/u, '')
}

function requestFor(product, scenario, suffix = randomUUID()) {
  return {
    schemaVersion: runRequestSchema,
    procedure: { id: product.id, version: product.version },
    inputs: structuredClone(scenario.inputs),
    grants: [...scenario.grants],
    resources: structuredClone(scenario.resources),
    limits: structuredClone(scenario.limits),
    idempotencyKey: `procedure-studio:${scenario.id}:${suffix}`,
  }
}

function graphNodeState(task, node) {
  const attempts = task.attempts.filter((attempt) => attempt.stage === node.id)
  const latest = attempts.at(-1)
  if (task.phase === node.id && task.active) return 'running'
  if (task.phase === node.id && task.status === 'waiting_user') return 'waiting'
  if (latest?.status === 'failed') return 'failed'
  if (latest?.status === 'complete') return 'complete'
  if (task.phase === node.id && ['ready', 'paused', 'failed'].includes(task.status)) return task.status
  return 'pending'
}

function publicRun(coordinator, task) {
  const outputs = Object.fromEntries(
    Object.entries(task.outputs ?? {}).map(([id, output]) => [id, {
      ...output,
      value: coordinator.store.readArtifact(output.artifact),
    }]),
  )
  return {
    id: task.id,
    runId: task.runId,
    status: task.status,
    phase: task.phase,
    revision: task.revision,
    goal: task.goal,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    elapsedMs: task.elapsedMs,
    procedureRef: task.procedureRef,
    procedureProduct: task.procedureProduct,
    request: {
      inputs: task.inputs,
      grants: task.grants,
      resources: task.resources,
      bindings: task.bindings,
      limits: task.limits,
    },
    question: task.question ?? null,
    problem: task.problem ?? null,
    attempts: task.attempts,
    decisions: task.decisions,
    permissions: task.permissions,
    outputs,
    nodes: task.method.graph.nodes.map((node) => ({ id: node.id, state: graphNodeState(task, node) })),
    events: coordinator.store.events(task.id, 0, 200),
    replayOf: task.replayOf ?? null,
  }
}

function downstream(method, nodeId) {
  const result = new Set([nodeId])
  const pending = [nodeId]
  while (pending.length > 0) {
    const current = method.graph.nodes.find((node) => node.id === pending.shift())
    for (const next of current?.transitions.map((route) => route.to).filter(Boolean) ?? []) {
      if (!result.has(next)) {
        result.add(next)
        pending.push(next)
      }
    }
  }
  return result
}

export class StudioRuntime {
  static async open(root, project, coordinatorOptions = {}) {
    await mkdir(root, { recursive: true, mode: 0o700 })
    const runtime = new StudioRuntime(root, project, coordinatorOptions)
    const currentDigest = project.publicState().documentDigest
    await runtime.coordinatorFor(currentDigest, project.validation.product)
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory() && /^[a-f0-9]{64}$/u.test(entry.name) && entry.name !== runDirectoryName(currentDigest)) {
        try {
          runtime.coordinators.set(`sha256:${entry.name}`, new Coordinator(join(root, entry.name), coordinatorOptions))
        } catch (error) {
          if (error.code !== 'STORE_LOCKED') throw error
        }
      }
    }
    return runtime
  }

  constructor(root, project, coordinatorOptions = {}) {
    this.root = root
    this.project = project
    this.coordinatorOptions = coordinatorOptions
    this.coordinators = new Map()
  }

  async coordinatorFor(digest, product = null) {
    if (this.coordinators.has(digest)) return this.coordinators.get(digest)
    if (product === null) throw studioError('STUDIO_RUN_SOURCE_INVALID', 'The current source is not valid enough to run')
    const coordinator = new Coordinator(join(this.root, runDirectoryName(digest)), {
      ...this.coordinatorOptions,
      procedures: [{ ...product, componentId: this.project.config.componentId }],
    })
    this.coordinators.set(digest, coordinator)
    return coordinator
  }

  find(runId) {
    for (const [digest, coordinator] of this.coordinators) {
      const task = coordinator.store.maybeGet(runId)
      if (task) return { digest, coordinator, task }
    }
    throw studioError('STUDIO_RUN_NOT_FOUND', 'Test Run was not found', { runId })
  }

  list() {
    return [...this.coordinators.entries()]
      .flatMap(([digest, coordinator]) => coordinator.list().map((item) => ({
        ...item,
        replayOf: coordinator.store.maybeGet(item.id)?.replayOf ?? null,
        sourceDigest: digest,
      })))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  get(runId) {
    const { digest, coordinator, task } = this.find(runId)
    return { ...publicRun(coordinator, task), sourceDigest: digest }
  }

  async start(scenarioId) {
    if (!this.project.validation.valid || this.project.validation.product === null) {
      throw studioError('STUDIO_VALIDATION_FAILED', 'Fix validation errors before starting a Test Run', { diagnostics: this.project.validation.diagnostics })
    }
    const scenario = this.project.scenarios.find((item) => item.id === scenarioId)
    if (!scenario) throw studioError('STUDIO_SCENARIO_NOT_FOUND', 'Test scenario was not found', { scenarioId })
    const digest = this.project.publicState().documentDigest
    const product = { ...this.project.validation.product, componentId: this.project.config.componentId }
    const coordinator = await this.coordinatorFor(digest, product)
    const request = validateRunRequest(requestFor(product, scenario), product)
    const task = coordinator.create({
      procedureRef: request.procedure,
      inputs: request.inputs,
      grants: request.grants,
      resources: request.resources,
      limits: request.limits,
      bindings: structuredClone(scenario.bindings),
      idempotencyKey: request.idempotencyKey,
    })
    coordinator.command(task.id, {
      requestId: `studio-start-${task.id}`,
      expectedRevision: task.revision,
      action: 'start',
    })
    return this.get(task.id)
  }

  action(runId, action) {
    const { coordinator, task } = this.find(runId)
    const allowed = new Set(['start', 'resume', 'pause', 'cancel', 'answer', 'input', 'limits'])
    if (!allowed.has(action.action)) throw studioError('STUDIO_RUN_ACTION_INVALID', `Unsupported Test Run action: ${action.action}`)
    coordinator.command(task.id, {
      ...structuredClone(action),
      requestId: action.requestId ?? `studio-${action.action}-${randomUUID()}`,
      expectedRevision: task.revision,
    })
    return this.get(task.id)
  }

  async replay(runId, nodeId) {
    const source = this.find(runId)
    if (!STOPPED.has(source.task.status) || source.task.active) {
      throw studioError('STUDIO_REPLAY_UNSAFE', 'Pause the original Run before replaying from a node')
    }
    const node = source.task.method.graph.nodes.find((item) => item.id === nodeId)
    if (!node) throw studioError('STUDIO_REPLAY_UNSAFE', 'Replay node is not part of the original Method', { nodeId })
    const current = this.project.publicState()
    if (current.documentDigest !== source.digest) {
      throw studioError('STUDIO_REPLAY_SOURCE_CHANGED', 'Replay requires the exact source snapshot used by the original Run')
    }
    const product = { ...this.project.validation.product, componentId: this.project.config.componentId }
    const coordinator = await this.coordinatorFor(source.digest, product)
    const scenario = {
      id: 'replay',
      inputs: source.task.inputs,
      grants: source.task.grants,
      resources: source.task.resources,
      limits: source.task.limits,
    }
    const request = validateRunRequest(requestFor(product, scenario), product)
    const created = coordinator.create({
      procedureRef: request.procedure,
      inputs: request.inputs,
      grants: request.grants,
      resources: request.resources,
      limits: request.limits,
      bindings: structuredClone(source.task.bindings),
      idempotencyKey: request.idempotencyKey,
    })
    const invalidated = downstream(source.task.method, nodeId)
    const reusable = Object.fromEntries(
      Object.entries(source.task.outputs ?? {}).filter(([, output]) => !invalidated.has(output.stage)),
    )
    const missing = node.consumes.filter((id) => source.task.method.artifacts.some((artifact) => artifact.id === id) && reusable[id] === undefined)
    if (missing.length > 0) {
      throw studioError('STUDIO_REPLAY_UNSAFE', 'Required upstream artifacts are unavailable for replay', { nodeId, artifacts: missing })
    }
    coordinator.store.update(created.id, 'replay-created', (task) => {
      task.phase = nodeId
      task.outputs = structuredClone(reusable)
      task.artifacts = [...new Set(Object.values(reusable).map((output) => output.artifact))]
      task.replayOf = { runId: source.task.runId, taskId: source.task.id, nodeId }
    })
    const replay = coordinator.get(created.id)
    coordinator.command(replay.id, {
      requestId: `studio-replay-${replay.id}`,
      expectedRevision: replay.revision,
      action: 'start',
    })
    return this.get(replay.id)
  }

  async waitForStopped(runId, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const run = this.get(runId)
      if (STOPPED.has(run.status) && run.status !== 'ready') return run
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw studioError('STUDIO_RUN_TIMEOUT', 'Test Run did not reach a stopped state in time', { runId, timeoutMs })
  }

  async close() {
    await Promise.all([...this.coordinators.values()].map((coordinator) => coordinator.close()))
  }
}
