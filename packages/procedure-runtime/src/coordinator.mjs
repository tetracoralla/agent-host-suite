import { EventEmitter } from 'node:events'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Store } from './store.mjs'
import { AgentAdapter, nativeReply, validateBinding } from './adapters.mjs'
import {
  validateMethod,
  validateInputs,
  projectContext,
  report,
  resolveTransition,
  evaluateExpression,
  validateArtifactValue,
} from './method.mjs'
import { validateDevelopmentMethod } from './profiles/development.mjs'
import { validateInstalledProcedure } from './product.mjs'
import {
  workspaceRoot,
  snapshot,
  dirtyPaths,
  candidate,
  assertCandidate,
  stage,
  prepareCommit,
  applyCommit,
  safePath,
  diff,
  captureContents,
  workerAlive,
} from './workspace.mjs'
import {
  assert,
  id,
  now,
  hash,
  text,
  integer,
  clone,
  object,
  errorValue,
} from './value.mjs'

const stopped = [
  'ready',
  'paused',
  'waiting_user',
  'failed',
  'complete',
  'cancelled',
  'reconciling',
]

// Evidence belongs to a candidate and its requirements, including stopped or
// failed attempts. A successful report is not needed to invalidate old evidence.
function invalidateEvidence(task, reason, candidateIdentity = null) {
  task.reviewedCandidate = null
  if (
    !candidateIdentity ||
    task.independentReview?.candidate !== candidateIdentity
  )
    task.independentReview = null
  for (const check of task.checks)
    if (
      check.status === 'current' &&
      (!candidateIdentity || check.candidate !== candidateIdentity)
    ) {
      check.status = 'stale'
      check.reason = reason
    }
  for (const finding of task.findings)
    if (
      finding.status === 'verified' &&
      (!candidateIdentity ||
        finding.resolution?.candidate !== candidateIdentity)
    ) {
      finding.status = 'pending'
      finding.invalidatedBy = reason
    }
}

function awaitingPermission(task) {
  return task.permissions.some(
    (p) =>
      p.attempt === task.active?.id &&
      (p.status === 'pending' ||
        (!p.delivered && ['approved', 'denied'].includes(p.status))),
  )
}

function isGitTask(task) {
  return (
    task.workspaceAdapter === 'git' ||
    (task.workspaceAdapter == null && typeof task.workspace === 'string')
  )
}

function validateProfile(method) {
  return method.profile === 'development'
    ? validateDevelopmentMethod(method)
    : validateMethod(method)
}

function nodes(method) {
  return method.graph.nodes
}

function nodeById(method, nodeId) {
  return nodes(method).find((node) => node.id === nodeId)
}

function workspaceRequirement(method) {
  return method.resources.find((resource) => resource.type === 'workspace') ?? null
}

function grantedPermissions(input, method) {
  const grants = new Set(input.grants ?? [])
  // Read legacy callers without making the booleans part of the new contract.
  if (input.authority?.modelCalls) grants.add('model.invoke')
  if (input.authority?.write) grants.add('workspace.write')
  if (input.authority?.stage) grants.add('git.stage')
  const declared = new Set(method.permissions.map((permission) => permission.id))
  for (const grant of grants)
    assert(declared.has(grant), 'INVALID_INPUT', `Unknown permission grant: ${grant}`)
  return [...grants]
}

function invalidateDependentOutputs(task, changed) {
  const pending = [...changed]
  while (pending.length) {
    const [dependency, currentArtifact] = pending.shift()
    for (const [id, output] of Object.entries(task.outputs))
      if (
        id !== dependency &&
        output.dependencies?.[dependency] !== undefined &&
        output.dependencies[dependency] !== currentArtifact
      ) {
        delete task.outputs[id]
        pending.push([id, null])
      }
  }
}

function graphContext(task, store, result = {}) {
  return {
    inputs: clone(task.inputs),
    outputs: Object.fromEntries(
      Object.entries(task.outputs ?? {}).map(([key, output]) => [
        key,
        store.readArtifact(output.artifact),
      ]),
    ),
    resources: clone(task.resources ?? {}),
    result: clone(result),
    outcome: result.outcome ?? 'complete',
    facts: clone(result.facts ?? {}),
  }
}

function mapNodeOutputs(node, task, store, result) {
  if (!node.output) return clone(result.outputs ?? {})
  const context = graphContext(task, store, result)
  return Object.fromEntries(
    Object.entries(node.output).map(([artifact, expression]) => [
      artifact,
      evaluateExpression(expression, context),
    ]),
  )
}

export class Coordinator extends EventEmitter {
  constructor(
    root,
    {
      adapterFactory = (binding, options) => new AgentAdapter(binding, options),
      executeDirectCall = null,
      executeProcedureCall = null,
      workspaceDelegation = null,
      methods = [],
      procedures = [],
    } = {},
  ) {
    super()
    this.store = new Store(root)
    this.adapterFactory = adapterFactory
    this.executeDirectCall = executeDirectCall
    this.executeProcedureCall = executeProcedureCall
    this.workspaceDelegation = workspaceDelegation
    this.sessionFinished = false
    this.workers = new Map()
    this.draining = false
    this.closing = false
    this.exhaustedEventTasks = new Set()
    this.procedures = new Map()
    for (const method of methods) this.store.putMethod(validateProfile(method))
    for (const candidate of procedures) {
      const procedure = validateInstalledProcedure(candidate)
      const key = `${procedure.id}\u0000${procedure.version}`
      assert(
        !this.procedures.has(key),
        'PROCEDURE_CONFLICT',
        'Installed Procedure identities must be unique',
      )
      this.procedures.set(key, procedure)
      this.store.putMethod(validateProfile(procedure.method))
    }
    // Dispatching cannot safely be replayed: the external effect may already exist.
    this.store.transaction(() => {
      for (const task of this.store.allTasks()) {
        task.method = validateProfile(task.method)
        task.resources ??= task.workspace === null || task.workspace === undefined
          ? {}
          : {
              workspace: {
                type: 'workspace',
                adapter: 'git',
                path: task.workspace,
                allowExistingPaths: [],
              },
            }
        task.workspaceAdapter ??= workspaceRequirement(task.method)?.adapter ?? 'none'
        task.inputs ??= { goal: task.goal }
        task.outputs ??= {}
        task.subprocedureContinuations ??= {}
        task.nodeExecutions ??= task.attempts?.length ?? 0
        task.limits = {
          maxDurationMs: task.limits?.maxDurationMs ?? (task.limits?.maxMinutes ?? 30) * 60000,
          maxNodeExecutions: task.limits?.maxNodeExecutions ?? 100,
          maxAgentTurns: task.limits?.maxAgentTurns ?? task.limits?.maxTurns ?? 12,
          nodeTimeoutMs: task.limits?.nodeTimeoutMs ?? (task.limits?.turnSeconds ?? 300) * 1000,
          maxAttemptsPerNode: task.limits?.maxAttemptsPerNode ?? task.limits?.maxAttemptsPerStage ?? 4,
          maxOutputBytes: task.limits?.maxOutputBytes ?? 256000,
        }
        task.grants ??= [
          ...(task.authority?.modelCalls ? ['model.invoke'] : []),
          ...(task.authority?.write ? ['workspace.write'] : []),
          ...(task.authority?.stage ? ['git.stage'] : []),
        ]
        if (
          task.active ||
          ['running', 'pausing', 'cancelling', 'finalizing'].includes(
            task.status,
          )
        ) {
          task.status = 'reconciling'
          task.problem = {
            code: 'COORDINATOR_RESTARTED',
            message: 'Check the previous worker and checkout before continuing',
          }
          task.revision++
        }
        this.store.save(task)
      }
      this.store.db
        .prepare(
          "UPDATE outbox SET status='uncertain' WHERE status='dispatching'",
        )
      .run()
    })
  }
  procedure(id, version) {
    const procedure = this.procedures.get(`${id}\u0000${version}`)
    assert(procedure, 'NOT_FOUND', 'Installed Procedure version not found')
    return procedure
  }
  procedureList() {
    return [...this.procedures.values()]
  }
  claim(task, workerPid = null) {
    if (isGitTask(task)) this.store.claim(task.workspace, task.id, workerPid, this.workspaceDelegation)
  }
  reclaimDelegated(task) {
    if (isGitTask(task)) this.store.reclaimDelegated(task.workspace, task.id)
  }
  release(task) {
    if (isGitTask(task)) this.store.release(task.id)
  }
  workspaceState(task) {
    if (!isGitTask(task))
      return this.store.readArtifact(task.base)
    return candidate(
      task.workspace,
      this.store.readArtifact(task.base),
      task.protectedPaths,
    )
  }
  create(input) {
    const registeredProcedure = input.procedureRef === undefined || input.procedureRef === null
      ? null
      : this.procedure(input.procedureRef.id, input.procedureRef.version)
    assert(registeredProcedure !== null || input.method !== undefined, 'INVALID_INPUT', 'A registered Procedure method is required')
    const method = validateProfile(registeredProcedure?.method ?? input.method)
    const taskId = input.taskId ?? id()
    assert(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        taskId,
      ),
      'INVALID_INPUT',
      'Task ID must be a UUID',
    )
    const createRequestHash = hash({
      ...input,
      taskId,
      method,
      procedureFingerprint: registeredProcedure?.fingerprint,
      start: undefined,
      startRequestId: undefined,
    })
    const existing = this.store.maybeGet(taskId)
    if (existing) {
      assert(
        existing.createRequestHash === createRequestHash,
        'REQUEST_CONFLICT',
        'Task ID already belongs to different creation input',
      )
      return existing
    }
    const goal = input.goal ?? input.inputs?.goal ?? `${method.name} Run`
    text(goal, 'Goal', 32000)
    const suppliedInputs = { ...(input.inputs ?? {}) }
    if (method.inputs.some((item) => item.id === 'goal'))
      suppliedInputs.goal = goal
    const inputs = validateInputs(method, suppliedInputs)
    const resources = clone(input.resources ?? {})
    const workspaceSpec = workspaceRequirement(method)
    const workspaceBinding = workspaceSpec === null
      ? null
      : resources[workspaceSpec.id] ??
        (input.workspace === undefined
          ? null
          : {
              type: 'workspace',
              adapter: workspaceSpec.adapter,
              path: input.workspace,
              allowExistingPaths: input.allowExistingPaths ?? [],
            })
    assert(
      workspaceSpec?.required !== true || workspaceBinding !== null,
      'RESOURCE_BINDING_REQUIRED',
      `Missing required resource binding: ${workspaceSpec?.id ?? 'workspace'}`,
    )
    const workspace = workspaceBinding === null
      ? null
      : workspaceRoot(text(workspaceBinding.path, 'Workspace', 4096))
    if (workspaceSpec !== null && workspaceBinding !== null)
      resources[workspaceSpec.id] = {
        ...workspaceBinding,
        path: workspace,
        allowExistingPaths: [...(workspaceBinding.allowExistingPaths ?? [])],
      }
    const defaultBindings = Object.fromEntries(
      method.roles
        .filter((role) => role.defaultBinding)
        .map((role) => [role.id, role.defaultBinding]),
    )
    const bindings = clone({ ...defaultBindings, ...(input.bindings ?? {}) })
    for (const role of method.roles) {
      assert(
        bindings[role.id] &&
          ['codex', 'grok', 'zcode'].includes(bindings[role.id].provider),
        'INVALID_BINDING',
        `Missing ${role.name} binding`,
      )
      validateBinding(bindings[role.id])
      if ((role.independentFrom ?? []).length)
        assert(
          !bindings[role.id].sessionId,
          'INDEPENDENT_SESSION',
          `${role.name} must start an independent session`,
        )
    }
    const limits = {
      maxDurationMs: input.limits?.maxDurationMs ?? (input.limits?.maxMinutes ?? 30) * 60000,
      maxNodeExecutions: input.limits?.maxNodeExecutions ?? 100,
      maxAgentTurns: input.limits?.maxAgentTurns ?? input.limits?.maxTurns ?? 12,
      nodeTimeoutMs: input.limits?.nodeTimeoutMs ?? (input.limits?.turnSeconds ?? 300) * 1000,
      maxAttemptsPerNode: input.limits?.maxAttemptsPerNode ?? input.limits?.maxAttemptsPerStage ?? 4,
      maxOutputBytes: input.limits?.maxOutputBytes ?? 256000,
    }
    integer(limits.maxDurationMs, 'Duration limit', 1000, 28_800_000)
    integer(limits.maxNodeExecutions, 'Node execution limit', 1, 500)
    integer(limits.maxAgentTurns, 'Agent turn limit', 0, 100)
    integer(limits.nodeTimeoutMs, 'Node timeout', 1000, 1_800_000)
    integer(limits.maxAttemptsPerNode, 'Attempt limit', 1, 20)
    integer(limits.maxOutputBytes, 'Output limit', 1024, 4 * 1024 * 1024)
    const allowed = workspaceBinding?.allowExistingPaths ?? input.allowExistingPaths ?? []
    assert(
      Array.isArray(allowed) && allowed.length <= 1000,
      'INVALID_INPUT',
      'Invalid existing path authorization',
    )
    assert(
      workspaceSpec !== null || allowed.length === 0,
      'INVALID_INPUT',
      'Existing path authorization applies only to Git workspaces',
    )
    allowed.forEach((p) => safePath(workspace, p))
    const workspaceAdapter = workspaceSpec?.adapter ?? 'none'
    const base = isGitTask({ workspaceAdapter })
      ? snapshot(workspace)
      : { adapter: 'none', identity: hash({ method: method.id, inputs }) }
    if (workspaceAdapter === 'git') {
      base.contents = captureContents(workspace, base, allowed)
      base.includedPaths = [...new Set(allowed)]
    }
    const grants = grantedPermissions(input, method)
    const task = {
      id: taskId,
      runId: id(),
      createRequestHash,
      revision: 0,
      goal,
      inputs,
      resources,
      workspace,
      workspaceAdapter,
      method,
      procedureRef: registeredProcedure === null
        ? null
        : { id: registeredProcedure.id, version: registeredProcedure.version },
      procedureProduct: registeredProcedure === null
        ? null
        : {
            componentId: registeredProcedure.componentId,
            fingerprint: registeredProcedure.fingerprint,
            executionDependencies: clone(input.executionDependencies ?? null),
            name: registeredProcedure.name,
            execution: registeredProcedure.execution.kind,
            outputArtifacts: [...registeredProcedure.outputArtifacts],
            outputSchema: clone(registeredProcedure.outputSchema),
          },
      bindings,
      limits,
      grants,
      authority: {
        modelCalls: grants.includes('model.invoke'),
        write: grants.includes('workspace.write'),
        stage: grants.includes('git.stage'),
      },
      status: 'ready',
      phase: method.graph.entry,
      createdAt: now(),
      updatedAt: now(),
      startedAt: null,
      elapsedMs: 0,
      nodeExecutions: 0,
      turns: 0,
      active: null,
      sessions: {},
      attempts: [],
      decisions: [],
      findings: [],
      permissions: [],
      checks: [],
      outputs: {},
      candidate: null,
      reviewedCandidate: null,
      plan: null,
      protectedPaths:
        workspaceAdapter === 'git'
          ? dirtyPaths(workspace).filter((p) => !allowed.includes(p))
          : [],
      base: this.store.artifact(base),
      artifacts: [],
      problem: null,
    }
    this.store.transaction(() => {
      this.store.putMethod(method)
      this.store.save(task)
      this.store.event(task.id, 'created', {
        goal: task.goal,
        method: { id: method.id, revision: method.revision },
      })
    })
    return task
  }
  get(taskId) {
    return this.store.get(taskId)
  }
  list() {
    return this.store.list().map((t) => ({
      id: t.id,
      goal: t.goal,
      status: t.status,
      phase: t.phase,
      revision: t.revision,
      workspace: t.workspace,
      updatedAt: t.updatedAt,
      staged: t.staged ?? false,
      committed: !!t.commit,
    }))
  }
  command(taskId, command) {
    const { requestId, expectedRevision, action, ...payload } = command
    const result = this.store.command(
      taskId,
      requestId,
      expectedRevision,
      { action, ...payload },
      (task) => {
        assert(!this.closing, 'CLOSING', 'Coordinator is closing')
        assert(
          !task.finalization || ['reconcile', 'finish-commit'].includes(action),
          'FINALIZATION_PENDING',
          'Reconcile the authorized commit before issuing another task command',
        )
        if (action === 'start' || action === 'resume') {
          assert(
            ['ready', 'paused', 'failed', 'waiting_user'].includes(
              task.status,
            ) && !task.active,
            'INVALID_STATE',
            'Task is not ready to continue',
          )
          assert(
            !task.question,
            'ANSWER_REQUIRED',
            'Answer the pending task question first',
          )
          const stage = nodeById(task.method, task.phase)
          const missing = stage.permissions.filter(
            (permission) => !task.grants.includes(permission),
          )
          assert(
            missing.length === 0,
            'PERMISSION_GRANT_REQUIRED',
            `Grant the permissions required by ${stage.name}: ${missing.join(', ')}`,
            { permissions: missing },
          )
          assert(
            task.nodeExecutions < task.limits.maxNodeExecutions &&
              (stage.kind !== 'agent-turn' || task.turns < task.limits.maxAgentTurns) &&
              task.elapsedMs < task.limits.maxDurationMs,
            'RUN_LIMIT',
            'Run limit reached; explicitly extend limits before continuing',
          )
          task.status = 'ready'
          task.problem = null
          this.claim(task)
          this.store.enqueue(task.id, { id: id(), kind: 'dispatch' })
        } else if (action === 'pause' || action === 'cancel') {
          // Reconciling still has an unconfirmed writer or commit effect;
          // finalizing is completing an already authorized stage/commit. Neither
          // may hand out the checkout lease as a plain pause or cancel.
          assert(
            ![
              'cancelled',
              'complete',
              'cancelling',
              'reconciling',
              'finalizing',
            ].includes(task.status),
            'INVALID_STATE',
            'Finish recovery or the pending staged/commit step first',
          )
          task.status = task.active
            ? action === 'pause'
              ? 'pausing'
              : 'cancelling'
            : action === 'pause'
              ? 'paused'
              : 'cancelled'
          if (action === 'cancel') task.question = null
          if (task.active)
            this.store.enqueue(task.id, {
              id: id(),
              kind: 'stop',
              attempt: task.active.id,
            })
          else this.release(task)
        } else if (action === 'input') {
          text(payload.text, 'Input', 16000)
          assert(
            !['cancelled', 'complete', 'finalizing', 'reconciling'].includes(
              task.status,
            ),
            'INVALID_STATE',
            'Ended tasks cannot receive new instructions',
          )
          const decision = {
            id: id(),
            text: payload.text,
            source: 'user',
            scope: payload.scope ?? 'task',
            status: 'active',
            revision: task.revision + 1,
            delivery: 'saved',
            appliedEvidence: null,
            createdAt: now(),
          }
          assert(
            ['task', 'current-stage'].includes(decision.scope),
            'INVALID_INPUT',
            'Unknown input scope',
          )
          decision.phase = task.phase
          if (payload.supersedes) {
            const previous = task.decisions.find(
              (d) => d.id === payload.supersedes && d.status === 'active',
            )
            assert(previous, 'NOT_FOUND', 'Decision to replace not found')
            previous.status = 'superseded'
            decision.supersedes = previous.id
          }
          task.decisions.push(decision)
          assert(
            task.decisions.length <= 500,
            'TASK_LIMIT',
            'Decision history exceeds 500 records',
          )
          invalidateEvidence(task, 'requirements-changed')
          if (task.method.profile !== 'development') {
            task.outputs = {}
            task.phase = task.method.graph.entry
            task.plan = null
            task.subprocedureContinuations = {}
          }
          task.question = null
          if (task.active) {
            if (
              payload.impact === 'supplement' &&
              task.status !== 'waiting_user'
            )
              this.store.enqueue(task.id, {
                id: id(),
                kind: 'input',
                attempt: task.active.id,
                decision: decision.id,
              })
            else {
              task.status = 'pausing'
              this.store.enqueue(task.id, {
                id: id(),
                kind: 'stop',
                attempt: task.active.id,
              })
            }
          }
        } else if (action === 'answer') {
          assert(
            ['waiting_user', 'paused'].includes(task.status) &&
              !task.active &&
              task.question?.id === payload.questionId,
            'STALE_ANSWER',
            'Question is no longer current',
          )
          const answer = payload.value ?? payload.text
          assert(answer !== undefined, 'INVALID_INPUT', 'Answer value is required')
          assert(JSON.stringify(answer).length <= 64000, 'INVALID_INPUT', 'Answer exceeds 64 KiB')
          task.decisions.push({
            id: id(),
            text: typeof answer === 'string' ? answer : JSON.stringify(answer),
            source: 'user',
            scope: 'task',
            status: 'active',
            revision: task.revision + 1,
            delivery: 'saved',
            createdAt: now(),
            questionId: payload.questionId,
          })
          invalidateEvidence(task, 'requirements-changed')
          if (task.question.kind === 'human-input') {
            const question = task.question
            const node = nodeById(task.method, question.node)
            assert(node?.kind === 'human-input', 'INVALID_METHOD', 'Human-input graph node is unavailable')
            if (node.options?.length)
              assert(typeof answer === 'string' && node.options.includes(answer), 'INVALID_INPUT', 'Answer must be one of the declared options')
            const current = this.workspaceState(task)
            assert(current.identity === question.candidate, 'CANDIDATE_DRIFT', 'Workspace changed while the Procedure waited for human input')
            task.question = null
            if (payload.reject === true) {
              task.status = 'paused'
              task.problem = { code: 'HUMAN_INPUT_REJECTED', message: 'The requested human input was declined' }
            } else {
              const attempt = task.attempts.find((item) => item.id === question.attempt)
              if (attempt) {
                attempt.status = 'complete'
                attempt.finishedAt = now()
              }
              this.advanceGraphNode(
                task,
                node,
                { outcome: 'complete', outputs: { [question.responseArtifact]: answer }, facts: {} },
                question.attempt,
                current.identity,
              )
            }
          } else {
            if (task.question.kind === 'subprocedure') {
              const recorded = task.subprocedureContinuations?.[task.question.node]
              assert(recorded, 'STALE_ANSWER', 'The waiting subprocedure Run is no longer recorded')
              if (!payload.reject)
                recorded.pendingAnswer = { questionId: task.question.childQuestionId, value: answer }
            }
            task.question = null
            task.status = payload.reject ? 'paused' : 'ready'
            if (!payload.reject)
              this.store.enqueue(task.id, { id: id(), kind: 'dispatch' })
          }
        } else if (action === 'permission') {
          const permission = task.permissions.find(
            (p) => p.id === payload.permissionId && p.status === 'pending',
          )
          assert(
            permission &&
              task.active?.id === permission.attempt &&
              task.status === 'waiting_user',
            'STALE_PERMISSION',
            'Provider request is no longer active',
          )
          assert(
            permission.decisionRevision === task.decisions.length,
            'STALE_PERMISSION',
            'Requirements changed after this permission request',
          )
          if (permission.provider)
            nativeReply(
              permission.provider,
              { method: permission.method, params: permission.native },
              payload.allow === true,
              payload.answer,
            )
          permission.status = payload.allow === true ? 'approved' : 'denied'
          permission.answer = payload.answer ?? null
          this.store.enqueue(task.id, {
            id: id(),
            kind: 'permission',
            attempt: task.active.id,
            permission: permission.id,
            allow: payload.allow === true,
            answer: payload.answer,
          })
        } else if (action === 'reconcile') {
          assert(
            task.status === 'reconciling',
            'INVALID_STATE',
            'No recovery is pending',
          )
          assert(
            !this.workers.has(task.id),
            'WORKER_ACTIVE',
            'Owned worker is still active',
          )
          if (task.active?.pid) {
            assert(
              !workerAlive(task.active.pid),
              'WORKER_UNCONFIRMED',
              'The previous worker PID still exists; stop it through its owning interface before recovery',
            )
          }
          if (task.finalization?.kind === 'commit') {
            assert(isGitTask(task), 'INVALID_STATE', 'Commit recovery requires Git')
            const live = snapshot(task.workspace)
            const prepared = task.finalization.prepared
            if (live.head === prepared.commit) {
              task.finalization.recovery =
                'committed-index-needs-reconciliation'
              task.status = 'paused'
              task.problem = {
                code: 'COMMIT_RECORDED',
                message:
                  'The authorized commit exists. Resume finalization to reconcile only its index paths.',
              }
              task.active = null
              return
            }
            assert(
              live.head === prepared.expectedHead,
              'HEAD_CHANGED',
              'HEAD differs from both the approved baseline and prepared commit',
            )
            // The prepared commit is not current. Never replay the pending
            // intent over the baseline; retain user content and review again.
            task.finalization = null
          }
          const recovered = this.workspaceState(task)
          if (task.active) {
            rmSync(join(this.store.root, 'worker-context', task.active.id), {
              recursive: true,
              force: true,
            })
            if (!task.attempts.some((a) => a.id === task.active.id)) {
              // Includes downtime conservatively: execution after the last
              // durable observation is unknown, never silently free budget.
              const started = Date.parse(task.active.startedAt)
              if (Number.isFinite(started))
                task.elapsedMs += Math.max(0, Date.now() - started)
              task.attempts.push({
                ...task.active,
                status: 'uncertain',
                candidate: recovered.identity,
                finishedAt: now(),
              })
            }
            task.active = null
          }
          if (isGitTask(task)) {
            task.candidate = {
              identity: recovered.identity,
              artifact: this.store.artifact(recovered),
              paths: recovered.paths,
            }
            invalidateEvidence(task, 'recovery-required')
          }
          task.permissions.forEach((p) => {
            if (p.status === 'pending') p.status = 'expired'
          })
          task.status = 'paused'
          task.problem = null
          this.release(task)
          this.store.db
            .prepare(
              "UPDATE outbox SET status='reconciled' WHERE task=? AND status IN ('pending','uncertain')",
            )
            .run(task.id)
        } else if (action === 'finish-commit') {
          assert(
            task.status === 'paused' &&
              task.finalization?.recovery ===
                'committed-index-needs-reconciliation',
            'INVALID_STATE',
            'No recorded commit needs recovery',
          )
          this.claim(task)
          task.status = 'finalizing'
          this.store.enqueue(task.id, { id: id(), kind: 'finish-commit' })
        } else if (action === 'limits') {
          assert(
            stopped.includes(task.status) && !task.active,
            'INVALID_STATE',
            'Pause before changing limits',
          )
          for (const [key, min, max] of [
            ['maxDurationMs', 1000, 28_800_000],
            ['maxNodeExecutions', 1, 500],
            ['maxAgentTurns', 0, 100],
            ['nodeTimeoutMs', 1000, 1_800_000],
            ['maxAttemptsPerNode', 1, 20],
            ['maxOutputBytes', 1024, 4 * 1024 * 1024],
          ])
            if (payload.limits?.[key] !== undefined)
              task.limits[key] = integer(payload.limits[key], key, min, max)
        } else if (action === 'binding') {
          assert(
            ['ready', 'paused', 'failed'].includes(task.status) && !task.active,
            'INVALID_STATE',
            'Pause before changing bindings',
          )
          const role = task.method.roles.find((item) => item.id === payload.role)
          assert(role, 'INVALID_BINDING', 'Unknown role')
          assert(
            ['codex', 'grok', 'zcode'].includes(payload.binding?.provider),
            'INVALID_BINDING',
            'Unknown provider',
          )
          validateBinding(payload.binding)
          assert(
            !(role.independentFrom ?? []).length || !payload.binding.sessionId,
            'INDEPENDENT_SESSION',
            `${role.name} needs an independent session`,
          )
          if (
            payload.role === 'owner' &&
            (task.sessions.owner || task.bindings.owner.sessionId)
          )
            assert(
              payload.acceptNewOwner === true,
              'OWNER_CONTINUITY',
              'Changing owner loses original-session continuity; accept this explicitly',
            )
          task.bindings[payload.role] = clone(payload.binding)
          delete task.sessions[payload.role]
          invalidateEvidence(task, 'binding-changed')
          task.status = 'paused'
          task.problem = null
        } else if (action === 'finding') {
          assert(
            !['finalizing', 'reconciling', 'cancelled', 'complete'].includes(
              task.status,
            ),
            'INVALID_STATE',
            'Findings can only change before task finalization',
          )
          const finding = task.findings.find((f) => f.id === payload.findingId)
          assert(finding, 'NOT_FOUND', 'Finding not found')
          assert(
            ['rejected', 'withdrawn', 'pending'].includes(payload.status),
            'INVALID_INPUT',
            'Invalid finding disposition',
          )
          text(payload.reason, 'Finding reason', 4000)
          finding.status = payload.status
          finding.disposition = {
            source: 'user',
            reason: payload.reason,
            at: now(),
          }
          assert(
            task.decisions.length < 500,
            'TASK_LIMIT',
            'Decision history exceeds 500 records',
          )
          task.decisions.push({
            id: id(),
            text: `Finding ${finding.id}: ${payload.status}. ${payload.reason}`,
            source: 'user',
            scope: 'finding',
            status: 'active',
            revision: task.revision + 1,
            delivery: 'saved',
            appliedEvidence: null,
            createdAt: now(),
          })
          invalidateEvidence(task, 'finding-disposition-changed')
          if (task.active) {
            task.status = 'pausing'
            this.store.enqueue(task.id, {
              id: id(),
              kind: 'stop',
              attempt: task.active.id,
            })
          }
        } else if (action === 'stage' || action === 'commit') {
          assert(isGitTask(task), 'INVALID_STATE', 'Only Git-backed methods can stage or commit')
          assert(
            task.status === 'complete' &&
              !task.active &&
              task.candidate &&
              task.reviewedCandidate === task.candidate.identity,
            'NOT_REVIEWED',
            'Only the current owner-reviewed candidate can be finalized',
          )
          assert(
            payload.candidate === task.candidate.identity,
            'STALE_CANDIDATE',
            'Approval names a different candidate',
          )
          assert(
            !task.commit,
            'ALREADY_COMMITTED',
            'This candidate already has a local commit',
          )
          if (action === 'commit') text(payload.message, 'Commit message', 4000)
          this.claim(task)
          task.status = 'finalizing'
          this.store.enqueue(task.id, {
            id: id(),
            kind: action,
            candidate: task.candidate.identity,
            message: payload.message,
            authorization: {
              source: 'user',
              requestId,
              revision: task.revision + 1,
            },
          })
        } else assert(false, 'UNKNOWN_COMMAND', 'Unknown task action')
        this.store.event(task.id, 'command', {
          action,
          requestId,
          expectedRevision,
        })
      },
    )
    this.emit('change', taskId)
    queueMicrotask(() => void this.drain())
    return result
  }
  async drain() {
    if (this.draining || this.closing) return
    this.draining = true
    try {
      for (const entry of this.store.pending()) {
        if (this.closing) break
        const task = this.get(entry.task)
        const command = entry.body
        this.store.mark(command.id, 'dispatching')
        try {
          if (command.kind === 'dispatch') {
            if (task.status === 'ready' && !task.active)
              void this.run(task.id).catch((error) => this.fail(task.id, error))
          } else if (command.kind === 'stop')
            await this.stop(task.id, command.attempt)
          else if (command.kind === 'input')
            await this.deliver(task.id, command)
          else if (command.kind === 'permission') {
            const worker = this.workers.get(task.id)
            const permission = task.permissions.find(
              (p) =>
                p.id === command.permission && p.attempt === command.attempt,
            )
            if (
              !worker ||
              task.active?.id !== command.attempt ||
              !['waiting_user', 'running'].includes(task.status) ||
              !['approved', 'denied'].includes(permission?.status) ||
              permission?.decisionRevision !== task.decisions.length
            ) {
              this.store.update(task.id, 'permission-expired', (t) => {
                const p = t.permissions.find(
                  (p) =>
                    p.id === command.permission &&
                    p.attempt === command.attempt,
                )
                if (p && !p.delivered) p.status = 'expired'
              })
              this.store.mark(command.id, 'done')
              continue
            }
            worker.respond(command.permission, command.allow, command.answer)
            this.store.update(task.id, 'permission-delivered', (t) => {
              const p = t.permissions.find(
                (p) =>
                  p.id === command.permission && p.attempt === command.attempt,
              )
              p.delivered = true
              if (t.active?.id === command.attempt && !awaitingPermission(t))
                t.status = 'running'
            })
          } else if (
            ['stage', 'commit', 'finish-commit'].includes(command.kind)
          )
            this.finalize(task.id, command)
          this.store.mark(command.id, 'done')
        } catch (error) {
          this.store.mark(command.id, 'uncertain')
          this.fail(task.id, error)
        }
      }
    } finally {
      this.draining = false
      if (!this.closing && this.store.pending().length)
        queueMicrotask(() => void this.drain())
    }
  }
  recordGraphOutputs(task, node, outputs, attemptId) {
    assert(object(outputs), 'INVALID_NODE_RESULT', 'Graph node outputs must be an object')
    const specs = new Map(task.method.artifacts.map((artifact) => [artifact.id, artifact]))
    const keys = Object.keys(outputs)
    assert(keys.every((key) => node.produces.includes(key)), 'INVALID_NODE_RESULT', 'Graph node returned an undeclared artifact')
    const changed = []
    for (const [artifactId, value] of Object.entries(outputs)) {
      validateArtifactValue(specs.get(artifactId), value)
      const artifact = this.store.artifact(value)
      task.artifacts.push(artifact)
      if (task.outputs[artifactId]?.artifact !== artifact)
        changed.push([artifactId, artifact])
      task.outputs[artifactId] = {
        artifact,
        stage: node.id,
        attempt: attemptId,
        updatedAt: now(),
        dependencies: Object.fromEntries(
          node.consumes
            .filter((input) => task.outputs[input])
            .map((input) => [input, task.outputs[input].artifact]),
        ),
      }
    }
    invalidateDependentOutputs(task, changed)
    assert(
      Buffer.byteLength(JSON.stringify(graphContext(task, this.store).outputs)) <=
        task.limits.maxOutputBytes,
      'OUTPUT_LIMIT',
      'Procedure outputs exceed the Run Request output limit',
    )
  }
  advanceGraphNode(task, node, result, attemptId, candidateIdentity) {
    const outputs = mapNodeOutputs(node, task, this.store, result)
    this.recordGraphOutputs(task, node, outputs, attemptId)
    const routeContext = graphContext(task, this.store, {
      ...result,
      outputs: {
        ...(result.outputs ?? {}),
        ...outputs,
      },
    })
    const next = resolveTransition(node, routeContext)
    if (next !== null) {
      task.phase = next
      task.status = 'ready'
      this.store.enqueue(task.id, { id: id(), kind: 'dispatch' })
      return
    }
    const missing = task.method.artifacts
      .filter((artifact) => artifact.required && !task.outputs[artifact.id])
      .map((artifact) => artifact.id)
    assert(missing.length === 0, 'REQUIRED_OUTPUT_MISSING', `Required outputs are missing: ${missing.join(', ')}`, { artifacts: missing })
    task.status = 'complete'
    if (isGitTask(task)) task.reviewedCandidate = candidateIdentity
    if (isGitTask(task) && task.grants.includes('git.stage')) {
      task.status = 'finalizing'
      this.store.enqueue(task.id, {
        id: id(),
        kind: 'stage',
        candidate: candidateIdentity,
        authorization: { source: 'task-grant' },
      })
    }
  }
  async runNonAgentNode(task, node, before) {
    const attemptId = id()
    if (node.kind === 'human-input') {
      this.store.update(task.id, 'human-input-requested', (current) => {
        current.startedAt ??= now()
        current.nodeExecutions++
        current.status = 'waiting_user'
        current.question = {
          id: id(),
          kind: 'human-input',
          node: node.id,
          interaction: node.interaction,
          text: node.prompt,
          options: clone(node.options ?? []),
          responseArtifact: node.responseArtifact,
          attempt: attemptId,
          candidate: before.identity,
        }
        current.attempts.push({
          id: attemptId,
          requestId: `${current.runId}:${node.id}:${current.nodeExecutions}`,
          stage: node.id,
          kind: node.kind,
          startedAt: now(),
          status: 'waiting_user',
          candidate: before.identity,
        })
      })
      this.release(this.get(task.id))
      this.emit('change', task.id)
      return
    }
    task = this.store.update(task.id, 'node-started', (current) => {
      current.startedAt ??= now()
      current.status = 'running'
      current.nodeExecutions++
      current.active = {
        id: attemptId,
        requestId: `${current.runId}:${node.id}:${current.nodeExecutions}`,
        stage: node.id,
        kind: node.kind,
        startedAt: now(),
        inputCandidate: before.identity,
        decisionRevision: current.decisions.length,
        pid: null,
      }
      current.problem = null
    })
    let result
    try {
      const context = graphContext(task, this.store)
      if (node.kind === 'condition') result = { outcome: 'complete', outputs: {}, facts: {} }
      else if (node.kind === 'transform') result = { outcome: 'complete', outputs: {}, facts: {} }
      else if (node.kind === 'direct-call') {
        assert(typeof this.executeDirectCall === 'function', 'DIRECT_CALL_UNAVAILABLE', 'This Runner embedding has no Direct Runtime call executor')
        result = {
          outcome: 'complete',
          outputs: await this.executeDirectCall({
            target: clone(node.target),
            input: evaluateExpression(node.input, context),
            grants: node.permissions.filter((permission) => task.grants.includes(permission)),
            resources: Object.fromEntries(node.resources.map((resource) => [resource, clone(task.resources[resource])])),
            timeoutMs: task.limits.nodeTimeoutMs,
            idempotencyKey: task.active.requestId,
          }),
        }
      } else if (node.kind === 'procedure-call') {
        assert(typeof this.executeProcedureCall === 'function', 'PROCEDURE_CALL_UNAVAILABLE', 'This Runner embedding has no subprocedure executor')
        const delegated = Object.keys(node.resourceBindings)
        if (delegated.length > 0) {
          // The child claims the delegated checkouts. The parent takes them
          // back after the call, including a lease left by a closed child.
          this.release(task)
        }
        let delegationError = null
        try {
          result = {
            outcome: 'complete',
            outputs: await this.executeProcedureCall({
              procedure: clone(node.procedure),
              inputs: evaluateExpression(node.input, context),
              grants: clone(node.grants),
              resources: Object.fromEntries(
                delegated.map((childResource) => [
                  childResource,
                  clone(task.resources[node.resourceBindings[childResource]]),
                ]),
              ),
              limits: clone(task.limits),
              idempotencyKey: task.active.requestId,
              delegation: delegated.length > 0 ? { owner: this.store.root, taskId: task.id } : null,
              continuation: clone(task.subprocedureContinuations?.[node.id] ?? null),
            }),
          }
        } catch (error) {
          delegationError = error
        }
        if (delegated.length > 0) {
          try {
            this.reclaimDelegated(task)
          } catch (error) {
            if (!delegationError) delegationError = error
            else delegationError.details = { ...(delegationError.details ?? {}), reclaim: errorValue(error) }
          }
        }
        if (delegationError) throw delegationError
      } else {
        assert(false, 'METHOD_EXTENSION_UNSUPPORTED', `Method extension ${node.extension.id}@${node.extension.version} is declared but not supported by this Runner`)
      }
    } catch (error) {
      // A subprocedure that stopped in a continuable state suspends the parent
      // Run instead of failing it: the durable continuation record names the
      // child Run so a later answer, resume, or fresh process continues the
      // same child instead of restarting the composed work.
      const wait = error?.code === 'SUBPROCEDURE_WAIT_REQUIRED' && error.details?.continuation
        ? error.details
        : null
      this.store.update(task.id, wait === null ? 'node-failed' : 'subprocedure-wait', (current) => {
        current.elapsedMs += Date.now() - Date.parse(current.active.startedAt)
        current.attempts.push({ ...current.active, finishedAt: now(), status: wait === null ? 'failed' : 'waiting', error: errorValue(error), candidate: before.identity })
        current.active = null
        if (wait !== null) {
          current.subprocedureContinuations ??= {}
          current.subprocedureContinuations[node.id] = {
            run: wait.continuation.run,
            root: wait.continuation.root,
            procedure: wait.continuation.procedure,
            recordedAt: now(),
          }
          if (wait.continuation.interaction) {
            current.status = 'waiting_user'
            current.question = {
              id: id(),
              kind: 'subprocedure',
              node: node.id,
              childRun: wait.continuation.run,
              childQuestionId: wait.continuation.interaction.id,
              text: wait.continuation.interaction.prompt,
              options: clone(wait.continuation.interaction.options ?? []),
            }
            current.problem = null
          } else {
            current.status = 'paused'
            current.problem = errorValue(error)
          }
          return
        }
        current.status = 'failed'
        current.problem = errorValue(error)
      })
      this.release(this.get(task.id))
      this.emit('change', task.id)
      return
    }
    const after = this.workspaceState(this.get(task.id))
    this.store.update(task.id, 'node-completed', (current) => {
      const active = current.active
      current.elapsedMs += Date.now() - Date.parse(active.startedAt)
      current.attempts.push({ ...active, finishedAt: now(), status: 'complete', candidate: after.identity })
      current.active = null
      if (current.subprocedureContinuations) delete current.subprocedureContinuations[node.id]
      const delegatedWorkspace = node.kind === 'procedure-call'
        && Object.keys(node.resourceBindings).length > 0
        && isGitTask(current)
      if (delegatedWorkspace && after.identity !== before.identity) {
        current.candidate = {
          identity: after.identity,
          artifact: this.store.artifact(after),
          paths: after.paths,
        }
        invalidateEvidence(current, 'delegated-procedure', after.identity)
      } else {
        assert(after.identity === before.identity, 'NODE_EFFECT_VIOLATION', `${node.kind} changed the parent workspace outside an Agent turn`)
      }
      this.advanceGraphNode(current, node, result, attemptId, after.identity)
    })
    if (!['ready', 'finalizing'].includes(this.get(task.id).status)) this.release(this.get(task.id))
    this.emit('change', task.id)
    void this.drain()
  }
  async run(taskId) {
    let task = this.get(taskId)
    if (task.active || task.status !== 'ready') return
    let step = nodeById(task.method, task.phase)
    assert(step, 'INVALID_METHOD', 'Current graph node is absent from method')
    const missingPermissions = step.permissions.filter(
      (permission) => !task.grants.includes(permission),
    )
    assert(
      missingPermissions.length === 0,
      'PERMISSION_GRANT_REQUIRED',
      `Graph node ${step.name} is missing permission grants: ${missingPermissions.join(', ')}`,
      { permissions: missingPermissions },
    )
    const missingResources = step.resources.filter(
      (resource) => task.resources?.[resource] === undefined,
    )
    assert(
      missingResources.length === 0,
      'RESOURCE_BINDING_REQUIRED',
      `Graph node ${step.name} is missing resource bindings: ${missingResources.join(', ')}`,
      { resources: missingResources },
    )
    this.store.checkEventBudget(taskId, 0)
    assert(
      task.nodeExecutions < task.limits.maxNodeExecutions &&
        task.elapsedMs < task.limits.maxDurationMs &&
        task.attempts.filter((a) => a.stage === step.id).length <
          task.limits.maxAttemptsPerNode,
      'RUN_LIMIT',
      'The run reached its configured bound',
    )
    if (step.kind === 'agent-turn')
      assert(task.turns < task.limits.maxAgentTurns, 'RUN_LIMIT', 'The Run reached its Agent-turn bound')
    this.claim(task)
    const before = this.workspaceState(task)
    if (
      isGitTask(task) &&
      task.candidate &&
      before.identity !== task.candidate.identity
    ) {
      this.store.update(taskId, 'workspace-drift', (t) => {
        t.candidate = {
          identity: before.identity,
          artifact: this.store.artifact(before),
          paths: before.paths,
        }
        invalidateEvidence(t, 'workspace-changed')
        t.status = 'paused'
        t.problem = {
          code: 'CANDIDATE_DRIFT',
          message:
            'Checkout changed between stages. Inspect and continue with the new candidate.',
        }
        t.checks.forEach((c) => {
          c.status = 'stale'
          c.reason = 'workspace-changed'
        })
      })
      this.release(task)
      return
    }
    if (step.kind !== 'agent-turn') {
      await this.runNonAgentNode(task, step, before)
      return
    }
    // The method's graph is necessary, but is not proof that *these bytes and
    // requirements* passed independent review. Drift/recovery must revisit it.
    if (
      task.method.profile === 'development' &&
      step.transitions.some((route) => route.to === null) &&
      (task.independentReview?.candidate !== before.identity ||
        task.independentReview?.decisionRevision !== task.decisions.length)
    ) {
      const reviewer =
        [...task.attempts]
          .reverse()
          .map((a) => nodeById(task.method, a.stage))
          .find((s) => s?.role === 'reviewer' && s.access === 'read') ??
        nodes(task.method).find(
          (s) => s.role === 'reviewer' && s.access === 'read',
        )
      task = this.store.update(taskId, 'independent-review-required', (t) => {
        t.phase = reviewer.id
      })
      step = reviewer
    }
    assert(
      task.attempts.filter((a) => a.stage === step.id).length <
        task.limits.maxAttemptsPerNode,
      'RUN_LIMIT',
      'The required review reached its configured attempt bound',
    )
    task = this.store.update(taskId, 'attempt-started', (t) => {
      t.startedAt ??= now()
      t.status = 'running'
      t.nodeExecutions++
      t.turns++
      t.active = {
        id: id(),
        requestId: id(),
        stage: step.id,
        role: step.role,
        startedAt: now(),
        inputCandidate: before.identity,
        decisionRevision: t.decisions.length,
        session: null,
        pid: null,
      }
      t.problem = null
    })
    const attempt = task.active
    let worker
    let outcome
    let failure
    const contextRoot = join(this.store.root, 'worker-context', attempt.id)
    try {
      mkdirSync(contextRoot, { recursive: true, mode: 0o700 })
      worker = this.adapterFactory(task.bindings[step.role], {
        workspace: task.workspace ?? this.store.root,
        workspaceAdapter: task.workspaceAdapter,
        stateRoot: this.store.root,
        contextRoot,
        writable: isGitTask(task) && step.access === 'write',
        protectedPaths: task.protectedPaths,
        onEvent: (event) => this.workerEvent(taskId, attempt.id, event),
        onPermission: (permission) =>
          this.workerPermission(taskId, attempt.id, permission),
      })
      this.workers.set(taskId, worker)
      this.claim(task, worker.rpc?.child.pid ?? null)
      this.store.update(taskId, null, (t) => {
        t.active.pid = worker.rpc?.child.pid ?? null
      })
      const capabilities = await worker.initialize()
      this.store.update(taskId, 'provider-connected', (t) => {
        t.active.capabilities = capabilities
      })
      const role = task.method.roles.find((item) => item.id === step.role)
      const existing = (role.independentFrom ?? []).length
        ? undefined
        : (task.sessions[step.role]?.id ?? task.bindings[step.role].sessionId)
      const session = await worker.session(existing)
      for (const other of role.independentFrom ?? [])
        assert(
          session.id !== task.sessions[other]?.id,
          'INDEPENDENT_SESSION',
          `${role.name} reused the ${other} session`,
        )
      task = this.store.update(taskId, 'session-ready', (t) => {
        t.active.session = session
        t.sessions[step.role] = session
      })
      assert(
        task.status === 'running',
        'STOP_REQUESTED',
        'Task stopped before dispatch',
      )
      const contextFile = join(contextRoot, 'task-context.json')
      let projection
      const prompt = projectContext(task, step, this.store, {
        currentCandidate: before,
        contextFile,
        onProjection: (data) => {
          projection = data
        },
      })
      writeFileSync(contextFile, JSON.stringify(projection), { mode: 0o600 })
      const includedDecisions = task.decisions
        .filter(
          (d) =>
            d.status === 'active' &&
            (d.scope === 'task' || d.phase === step.id),
        )
        .map((d) => d.id)
      this.store.update(taskId, null, (t) => {
        t.active.context = this.store.artifact({ prompt, projection })
        t.artifacts.push(t.active.context)
        for (const d of t.decisions)
          if (includedDecisions.includes(d.id)) d.delivery = 'queued-for-turn'
      })
      const accepted = (evidence) =>
        this.store.update(taskId, 'input-accepted', (t) => {
          if (t.active?.id !== attempt.id) return
          t.active.turnId = evidence.turnId ?? t.active.turnId
          for (const d of t.decisions)
            if (includedDecisions.includes(d.id)) {
              d.delivery = 'delivered'
              d.deliveryEvidence = { ...evidence, attempt: attempt.id }
            }
        })
      outcome = await worker.start(prompt, {
        requestId: attempt.requestId,
        timeoutMs: Math.min(
          task.limits.nodeTimeoutMs,
          task.limits.maxDurationMs - task.elapsedMs,
        ),
        onAccepted: accepted,
      })
      accepted({ turnId: outcome.turnId, evidence: 'provider-result' })
    } catch (error) {
      failure = error
    }
    let stoppedConfirmed = false
    try {
      await worker?.close()
      stoppedConfirmed = true
    } catch (error) {
      failure = error
    }
    if (stoppedConfirmed) rmSync(contextRoot, { recursive: true, force: true })
    this.workers.delete(taskId)
    const current = this.get(taskId)
    if (current.active?.id !== attempt.id) {
      this.store.event(taskId, 'late-result', {
        attempt: attempt.id,
        result: outcome ? this.store.artifact(outcome) : null,
        error: failure ? errorValue(failure) : null,
      })
      return
    }
    const after = this.workspaceState(current)
    this.store.update(taskId, 'attempt-ended', (t) => {
      t.elapsedMs += Date.now() - Date.parse(attempt.startedAt)
      const record = {
        ...t.active,
        finishedAt: now(),
        candidate: after.identity,
        result: outcome ? this.store.artifact(outcome) : null,
        status: failure ? 'failed' : (outcome?.status ?? 'uncertain'),
        error: failure ? errorValue(failure) : null,
      }
      t.attempts.push(record)
      if (!stoppedConfirmed) {
        t.status = 'reconciling'
        t.problem = {
          code: 'STOP_UNCONFIRMED',
          message:
            'Worker termination is unconfirmed; the writer lease is retained',
        }
        return
      }
      t.active = null
      t.permissions.forEach((p) => {
        if (p.attempt === attempt.id && p.status === 'pending')
          p.status = 'expired'
      })
      if (isGitTask(t)) {
        t.candidate = {
          identity: after.identity,
          artifact: this.store.artifact(after),
          paths: after.paths,
        }
        invalidateEvidence(t, 'candidate-changed', after.identity)
      }
      if (t.status === 'pausing' || t.status === 'cancelling') {
        t.status = t.status === 'pausing' ? 'paused' : 'cancelled'
        return
      }
      if (failure) {
        t.status = 'failed'
        t.problem = errorValue(failure)
        return
      }
      if (outcome.status !== 'complete') {
        t.status = 'paused'
        t.problem = {
          code: 'TURN_INCOMPLETE',
          message: 'Worker did not complete this stage',
        }
        return
      }
      if (
        isGitTask(t) &&
        step.access === 'read' &&
        after.identity !== before.identity
      ) {
        t.status = 'paused'
        t.problem = {
          code: 'REVIEW_DRIFT',
          message: 'Candidate changed during read-only review',
        }
        t.reviewedCandidate = null
        return
      }
      let result
      try {
        result = report(outcome.text, { method: t.method, stage: step })
      } catch (e) {
        t.status = 'failed'
        t.problem = errorValue(e)
        return
      }
      record.report = this.store.artifact(result)
      t.artifacts.push(record.report)
      if (['complete', 'changes_requested'].includes(result.outcome)) {
        const produced = { ...result.outputs }
        if (step.produces.includes('plan') && produced.plan === undefined)
          produced.plan = result.plan || result.summary
        if (
          isGitTask(t) &&
          step.produces.includes('candidate') &&
          produced.candidate === undefined
        )
          produced.candidate = {
            identity: after.identity,
            paths: after.paths,
            snapshot: t.candidate?.artifact,
          }
        const changed = []
        for (const [artifactId, value] of Object.entries(produced)) {
          const artifact = this.store.artifact(value)
          t.artifacts.push(artifact)
          if (t.outputs[artifactId]?.artifact !== artifact)
            changed.push([artifactId, artifact])
          t.outputs[artifactId] = {
            artifact,
            stage: step.id,
            attempt: attempt.id,
            updatedAt: now(),
            dependencies: Object.fromEntries(
              step.consumes
                .filter((input) => t.outputs[input])
                .map((input) => [input, t.outputs[input].artifact]),
            ),
          }
        }
        invalidateDependentOutputs(t, changed)
      }
      for (const decision of t.decisions)
        if (result.acknowledgedDecisionIds?.includes(decision.id))
          decision.appliedEvidence = {
            source: 'agent-report',
            attempt: attempt.id,
            candidate: after.identity,
          }
      if (attempt.decisionRevision !== t.decisions.length) {
        t.status = 'paused'
        t.problem = {
          code: 'REQUIREMENTS_CHANGED',
          message:
            'New input arrived during this turn; verify it before continuing',
        }
        return
      }
      for (const check of result.checks ?? [])
        t.checks.push({
          ...check,
          id: id(),
          source: 'agent-report',
          attempt: attempt.id,
          candidate: after.identity,
          status: 'current',
        })
      for (const found of result.findings ?? [])
        t.findings.push({
          ...found,
          id: id(),
          source: 'agent-report',
          attempt: attempt.id,
          candidate: after.identity,
          status: 'pending',
        })
      for (const key of result.resolvedFindingIds ?? []) {
        const finding = t.findings.find((f) => f.id === key)
        if (finding && !['rejected', 'withdrawn'].includes(finding.status)) {
          finding.status =
            step.access === 'write' ? 'claimed-fixed' : 'verified'
          finding.resolution = {
            attempt: attempt.id,
            candidate: after.identity,
            source: 'agent-report',
          }
        }
      }
      if (step.id === t.method.graph.entry)
        t.plan = result.plan || result.summary
      if (result.outcome === 'needs_user') {
        t.question = {
          id: id(),
          kind: 'agent-question',
          text: result.question,
          attempt: attempt.id,
          candidate: after.identity,
        }
        t.status = 'waiting_user'
        return
      }
      if (result.outcome === 'failed') {
        t.status = 'failed'
        t.problem = { code: 'AGENT_REPORTED_FAILURE', message: result.summary }
        return
      }
      let next
      try {
        next = resolveTransition(step, result)
      } catch (error) {
        t.status = 'paused'
        t.problem = errorValue(error)
        return
      }
      if (
        t.method.profile === 'development' &&
        step.role === 'reviewer' &&
        step.access === 'read' &&
        result.outcome === 'complete'
      )
        t.independentReview = {
          candidate: after.identity,
          decisionRevision: t.decisions.length,
          attempt: attempt.id,
        }
      if (next === null) {
        if (
          t.method.profile === 'development' &&
          t.findings.some((f) =>
            ['pending', 'claimed-fixed'].includes(f.status),
          )
        ) {
          t.status = 'paused'
          t.problem = {
            code: 'UNRESOLVED_FINDINGS',
            message: 'Findings remain unresolved',
          }
          return
        }
        const missing = t.method.artifacts
          .filter((artifact) => artifact.required && !t.outputs[artifact.id])
          .map((artifact) => artifact.id)
        if (missing.length) {
          t.status = 'paused'
          t.problem = {
            code: 'REQUIRED_OUTPUT_MISSING',
            message: `Required outputs are missing: ${missing.join(', ')}`,
            details: { artifacts: missing },
          }
          return
        }
        t.status = 'complete'
        if (isGitTask(t)) t.reviewedCandidate = after.identity
        if (isGitTask(t) && t.grants.includes('git.stage')) {
          t.status = 'finalizing'
          this.store.enqueue(taskId, {
            id: id(),
            kind: 'stage',
            candidate: after.identity,
            authorization: { source: 'task-grant' },
          })
        }
      } else {
        t.phase = next
        t.status = 'ready'
        this.store.enqueue(taskId, { id: id(), kind: 'dispatch' })
      }
    })
    if (
      !['ready', 'finalizing'].includes(this.get(taskId).status) &&
      stoppedConfirmed
    )
      this.release(this.get(taskId))
    this.emit('change', taskId)
    void this.drain()
  }
  workerEvent(taskId, attempt, event) {
    if (this.exhaustedEventTasks.has(taskId)) return
    const task = this.get(taskId)
    if (event.kind === 'permission-resolved' && task.active?.id === attempt)
      this.store.update(taskId, 'permission-resolved', (t) => {
        const p = t.permissions.find(
          (p) => p.id === event.requestId && p.attempt === attempt,
        )
        if (p && !p.delivered) p.status = 'expired'
        if (t.status === 'waiting_user' && !awaitingPermission(t))
          t.status = 'running'
      })
    try {
      const body = JSON.stringify(event)
      const bytes = Buffer.byteLength(body)
      this.store.checkEventBudget(taskId, bytes)
      const reference = bytes > 4000 ? this.store.artifact(event) : null
      this.store.event(
        taskId,
        task.active?.id === attempt ? 'worker-event' : 'late-event',
        {
          attempt,
          kind: event.kind,
          method: event.method,
          ...(reference ? { artifact: reference } : { event }),
        },
        bytes,
      )
    } catch (error) {
      this.exhaustedEventTasks.add(taskId)
      this.store.update(taskId, null, (t) => {
        if (t.active?.id === attempt) t.status = 'pausing'
        t.problem = errorValue(error)
      })
      void this.stop(taskId, attempt).catch(() => {})
      return
    }
    this.emit('change', taskId)
  }
  workerPermission(taskId, attempt, permission) {
    const current = this.get(taskId)
    const node = nodeById(current.method, current.phase)
    if (
      permission.requiredGrant &&
      (!current.grants.includes(permission.requiredGrant) ||
        !node?.permissions.includes(permission.requiredGrant))
    ) {
      const worker = this.workers.get(taskId)
      try {
        worker?.respond(permission.id, false)
      } catch {}
      this.store.event(taskId, 'permission-denied-by-run-grant', {
        attempt,
        permission: permission.id,
        requiredGrant: permission.requiredGrant,
      })
      return
    }
    this.store.update(taskId, 'permission-requested', (task) => {
      if (
        task.active?.id !== attempt ||
        !['running', 'waiting_user'].includes(task.status)
      )
        return
      task.permissions.push({
        ...permission,
        attempt,
        status: 'pending',
        decisionRevision: task.decisions.length,
      })
      task.status = 'waiting_user'
    })
    this.emit('change', taskId)
  }
  async deliver(taskId, command) {
    const task = this.get(taskId)
    const decision = task.decisions.find((d) => d.id === command.decision)
    if (!decision || task.active?.id !== command.attempt) return
    const worker = this.workers.get(taskId)
    assert(
      worker,
      'WORKER_DISCONNECTED',
      'Input remains saved; worker disconnected',
    )
    if (task.active.capabilities?.steer === 'supported') {
      await worker.steer(decision.text)
      this.store.update(taskId, 'input-delivered', (t) => {
        const d = t.decisions.find((d) => d.id === decision.id)
        d.delivery = 'delivered'
        d.deliveryEvidence = {
          evidence: 'provider-ack',
          attempt: command.attempt,
        }
      })
    } else {
      this.store.update(taskId, 'continuation-required', (t) => {
        t.status = 'pausing'
      })
      await this.stop(taskId, command.attempt)
    }
  }
  async stop(taskId, attempt) {
    const worker = this.workers.get(taskId)
    if (!worker) {
      if (this.get(taskId).active?.id === attempt)
        this.store.update(taskId, 'stop-unconfirmed', (t) => {
          t.status = 'reconciling'
        })
      return
    }
    try {
      await worker.interrupt()
    } catch (error) {
      this.store.event(taskId, 'interrupt-error', {
        attempt,
        error: errorValue(error),
      })
    }
    await worker.close() // ACK alone never releases the write lease.
  }
  finalize(taskId, command) {
    const task = this.get(taskId)
    assert(isGitTask(task), 'INVALID_STATE', 'Finalization requires a Git workspace')
    if (command.kind === 'finish-commit') {
      const result = applyCommit(task.workspace, task.finalization.prepared)
      this.store.update(taskId, 'commit-reconciled', (t) => {
        t.commit = { ...result, authorization: t.finalization.authorization }
        t.finalization = null
        t.status = 'complete'
      })
      this.release(task)
      return
    }
    assert(
      task.status === 'finalizing' &&
        task.candidate.identity === command.candidate &&
        task.reviewedCandidate === command.candidate,
      'STALE_CANDIDATE',
      'Finalization candidate changed',
    )
    const value = this.store.readArtifact(task.candidate.artifact)
    assertCandidate(task.workspace, value)
    if (command.kind === 'stage') {
      const staged = stage(task.workspace, value)
      this.store.update(taskId, 'staged', (t) => {
        t.candidate = {
          ...t.candidate,
          identity: staged.identity,
          artifact: this.store.artifact({
            ...staged,
            paths: value.paths,
            contents: value.contents,
          }),
        }
        t.reviewedCandidate = staged.identity
        t.status = 'complete'
        t.staged = true
      })
    } else {
      const prepared = prepareCommit(
        task.workspace,
        value,
        command.message,
        this.store.root,
      )
      this.store.update(taskId, 'commit-prepared', (t) => {
        t.finalization = {
          kind: 'commit',
          prepared,
          authorization: command.authorization,
        }
      })
      assertCandidate(task.workspace, value)
      const result = applyCommit(task.workspace, prepared)
      this.store.update(taskId, 'committed', (t) => {
        t.commit = {
          ...result,
          authorization: command.authorization,
          candidate: command.candidate,
        }
        t.finalization = null
        t.status = 'complete'
      })
    }
    this.release(task)
  }
  fail(taskId, error) {
    const task = this.get(taskId)
    this.store.update(taskId, 'failure', (t) => {
      t.status = t.active || t.finalization ? 'reconciling' : 'failed'
      t.problem = errorValue(error)
    })
    if (!task.active && !task.finalization) this.release(task)
    this.emit('change', taskId)
  }
  export(taskId) {
    const task = this.get(taskId)
    return {
      schema: 'openadam.procedure-handoff.v1',
      task,
      changes: isGitTask(task) ? diff(task.workspace) : null,
      outputs: Object.fromEntries(
        Object.entries(task.outputs ?? {}).map(([key, output]) => [
          key,
          { ...output, value: this.store.readArtifact(output.artifact) },
        ]),
      ),
      reports: task.attempts
        .filter((a) => a.report)
        .map((a) => ({
          attempt: a.id,
          stage: a.stage,
          report: this.store.readArtifact(a.report),
        })),
      limits:
        'Provider reports are attributed evidence, not independent verification. Session independence is enforced only where the selected method declares it.',
    }
  }
  async finishSession() {
    if (this.sessionFinished) return
    this.closing = true
    const stopping = []
    for (const [taskId, worker] of [...this.workers]) {
      stopping.push(taskId)
      this.store.update(taskId, 'coordinator-stopping', (t) => {
        t.status = 'pausing'
      })
      await worker.interrupt().catch(() => {})
      await worker.close().catch(() => {})
    }
    while (this.workers.size || stopping.some((taskId) => this.get(taskId).status === 'pausing')) {
      await new Promise((r) => setTimeout(r, 20))
    }
    this.sessionFinished = true
  }
  async close() {
    await this.finishSession()
    this.store.close()
  }
}
