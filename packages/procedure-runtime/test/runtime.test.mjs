import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import Ajv2020 from 'ajv/dist/2020.js'
import { Coordinator } from '../src/coordinator.mjs'
import { Store } from '../src/store.mjs'
import { validateMethod, projectContext, report } from '../src/method.mjs'
import {
  developmentMethod,
  validateDevelopmentMethod,
} from '../src/profiles/development.mjs'
import { researchBriefMethod } from '../src/profiles/research-brief.mjs'
import { workspaceCompositionMethod } from '../src/profiles/workspace-composition.mjs'
import {
  snapshot,
  candidate,
  stage,
  git,
  commitCandidate,
  workerSandbox,
  prepareCommit,
  applyCommit,
  workerAlive,
  claimCheckout,
} from '../src/workspace.mjs'
import { serve } from '../src/server.mjs'
import { validateInstalledProcedure } from '../src/product.mjs'
import { runRequestTaskId, validateRunRequest } from '../src/run-request.mjs'

function testCoordinator(root, options = {}) {
  return new Coordinator(root, {
    methods: [developmentMethod, researchBriefMethod],
    ...options,
  })
}

function researchProcedure() {
  return {
    componentId: 'research-brief-fixture',
    id: 'org.openadam.test.research-brief',
    version: '1.0.0',
    name: 'Research Brief',
    description: 'Produce a checked brief.',
    permissions: researchBriefMethod.permissions.map((permission) => permission.id),
    resources: researchBriefMethod.resources.map(({ id, type, required, adapter }) => ({
      id,
      type,
      required,
      ...(adapter ? { adapter } : {}),
    })),
    lifecycle: {
      mode: 'stateful',
      resumable: true,
      interaction: 'agent-mediated',
    },
    execution: { kind: 'agentic-runner' },
    outputArtifacts: ['brief'],
    method: researchBriefMethod,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['goal', 'audience'],
      properties: {
        goal: { type: 'string' },
        audience: { type: 'string' },
      },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['brief'],
      properties: { brief: { type: 'string' } },
    },
  }
}

function workspaceCompositionProcedure() {
  return {
    componentId: 'workspace-composition-fixture',
    id: 'org.openadam.test.workspace-composition',
    version: '1.0.0',
    name: 'Workspace Composition',
    description: 'Exercise Agent, Direct Capability, and exact subprocedure nodes.',
    permissions: workspaceCompositionMethod.permissions.map((permission) => permission.id),
    resources: workspaceCompositionMethod.resources.map(({ id, type, required, adapter }) => ({
      id,
      type,
      required,
      adapter,
    })),
    lifecycle: {
      mode: 'stateful',
      resumable: true,
      interaction: 'agent-mediated',
    },
    execution: { kind: 'agentic-runner' },
    outputArtifacts: ['final'],
    method: workspaceCompositionMethod,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['request'],
      properties: { request: { type: 'string', minLength: 1 } },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['final'],
      properties: { final: { type: 'string', minLength: 1 } },
    },
  }
}

test('installed Procedure schemas cannot contradict their Method input or output types', () => {
  const inputMismatch = researchProcedure()
  inputMismatch.inputSchema.properties.goal = { type: 'boolean' }
  assert.throws(
    () => validateInstalledProcedure(inputMismatch),
    (error) => error.code === 'INVALID_PROCEDURE_PRODUCT' && /input goal schema conflicts/u.test(error.message),
  )
  const outputMismatch = researchProcedure()
  outputMismatch.outputSchema.properties.brief = { type: 'array' }
  assert.throws(
    () => validateInstalledProcedure(outputMismatch),
    (error) => error.code === 'INVALID_PROCEDURE_PRODUCT' && /output brief schema conflicts/u.test(error.message),
  )
})

test('published Method Graph and Run Request schemas accept the runtime reference contracts', (t) => {
  const f = fixture(t)
  const validator = new Ajv2020({ allErrors: true, strict: false })
  const methodSchema = JSON.parse(
    readFileSync(new URL('../../../schemas/agent-host-method-graph.schema.v2.json', import.meta.url), 'utf8'),
  )
  const validateMethodSchema = validator.compile(methodSchema)
  for (const method of [developmentMethod, researchBriefMethod, workspaceCompositionMethod])
    assert.equal(validateMethodSchema(method), true, JSON.stringify(validateMethodSchema.errors))
  const unknownNodeField = structuredClone(researchBriefMethod)
  unknownNodeField.graph.nodes[0].studioHint = 'must not be silently discarded'
  assert.equal(validateMethodSchema(unknownNodeField), false)
  assert.throws(() => validateMethod(unknownNodeField), { code: 'INVALID_METHOD' })
  const missingNodeField = structuredClone(researchBriefMethod)
  delete missingNodeField.graph.nodes[0].consumes
  assert.equal(validateMethodSchema(missingNodeField), false)
  assert.throws(() => validateMethod(missingNodeField), { code: 'INVALID_METHOD' })
  const nativeZcodeModel = structuredClone(researchBriefMethod)
  nativeZcodeModel.roles[2].defaultBinding.model = { providerId: 'native-provider', modelId: 'native-model', options: { reasoningLevel: 'high' } }
  assert.equal(validateMethodSchema(nativeZcodeModel), true, JSON.stringify(validateMethodSchema.errors))
  assert.doesNotThrow(() => validateMethod(nativeZcodeModel))
  const invalidZcodeModel = structuredClone(researchBriefMethod)
  invalidZcodeModel.roles[2].defaultBinding.model = 'not-native-coordinates'
  assert.equal(validateMethodSchema(invalidZcodeModel), false)
  assert.throws(() => validateMethod(invalidZcodeModel), { code: 'INVALID_METHOD' })
  const invalidCodexModel = structuredClone(researchBriefMethod)
  invalidCodexModel.roles[0].defaultBinding.model = { providerId: 'wrong-shape', modelId: 'wrong-shape' }
  assert.equal(validateMethodSchema(invalidCodexModel), false)
  assert.throws(() => validateMethod(invalidCodexModel), { code: 'INVALID_METHOD' })

  const requestSchema = JSON.parse(
    readFileSync(new URL('../../../schemas/agent-host-procedure-run-request.schema.v0.1.json', import.meta.url), 'utf8'),
  )
  const validateRequestSchema = validator.compile(requestSchema)
  const request = {
    schemaVersion: 'openadam.agent-host-procedure-run-request.v0.1',
    procedure: { id: 'org.openadam.test.workspace-composition', version: '1.0.0' },
    inputs: { request: 'Compose this result' },
    grants: ['model.invoke', 'workspace.write', 'capability.invoke', 'procedure.invoke'],
    resources: {
      workspace: { type: 'workspace', adapter: 'git', path: f.workspace, allowExistingPaths: [] },
    },
    limits: {
      maxDurationMs: 60_000, maxNodeExecutions: 12, maxAgentTurns: 2,
      nodeTimeoutMs: 30_000, maxAttemptsPerNode: 2, maxOutputBytes: 65_536,
    },
    idempotencyKey: 'schema-fixture',
  }
  assert.equal(validateRequestSchema(request), true, JSON.stringify(validateRequestSchema.errors))
  assert.doesNotThrow(() => validateRunRequest(request, workspaceCompositionProcedure()))
})

test('formal Run Requests bind exact identity, explicit grants, resources, limits and idempotency', (t) => {
  const f = fixture(t)
  const procedure = workspaceCompositionProcedure()
  const request = {
    schemaVersion: 'openadam.agent-host-procedure-run-request.v0.1',
    procedure: { id: procedure.id, version: procedure.version },
    inputs: { request: 'Compose this result' },
    grants: ['model.invoke', 'workspace.write', 'capability.invoke', 'procedure.invoke'],
    resources: {
      workspace: {
        type: 'workspace',
        adapter: 'git',
        path: f.workspace,
        allowExistingPaths: [],
      },
    },
    limits: {
      maxDurationMs: 60_000,
      maxNodeExecutions: 12,
      maxAgentTurns: 2,
      nodeTimeoutMs: 30_000,
      maxAttemptsPerNode: 2,
      maxOutputBytes: 65_536,
    },
    idempotencyKey: 'workspace-composition-fixture',
  }
  const normalized = validateRunRequest(request, procedure)
  assert.deepEqual(normalized.procedure, request.procedure)
  assert.equal(normalized.resources.workspace.path, f.workspace)
  assert.equal(runRequestTaskId(normalized), runRequestTaskId(validateRunRequest(request, procedure)))

  const missingResource = structuredClone(request)
  missingResource.resources = {}
  assert.throws(() => validateRunRequest(missingResource, procedure), {
    code: 'PROCEDURE_RESOURCE_REQUIRED',
  })
  const excessiveGrant = structuredClone(request)
  excessiveGrant.grants.push('account.delete')
  assert.throws(() => validateRunRequest(excessiveGrant, procedure), {
    code: 'PROCEDURE_GRANT_EXCEEDS_DECLARATION',
  })
  const restrictedInstallation = { ...procedure, permissionCeiling: ['model.invoke', 'workspace.write'] }
  assert.throws(() => validateRunRequest(request, restrictedInstallation), {
    code: 'PROCEDURE_GRANT_EXCEEDS_INSTALLATION',
  })
  const wrongVersion = structuredClone(request)
  wrongVersion.procedure.version = '1.0.1'
  assert.throws(() => validateRunRequest(wrongVersion, procedure), {
    code: 'PROCEDURE_IDENTITY_MISMATCH',
  })

  const resourceProduct = {
    ...procedure,
    resources: [
      ...procedure.resources,
      { id: 'source-file', type: 'file', required: true, access: 'read' },
      { id: 'publishing-account', type: 'account', required: true, provider: 'fixture' },
    ],
  }
  const resourceRequest = structuredClone(request)
  resourceRequest.resources['source-file'] = {
    type: 'file', path: join(f.workspace, 'answer.txt'), access: 'read',
  }
  resourceRequest.resources['publishing-account'] = {
    type: 'account', provider: 'fixture', account: 'reviewer@example.test',
  }
  const bound = validateRunRequest(resourceRequest, resourceProduct)
  assert.equal(bound.resources['source-file'].access, 'read')
  assert.equal(bound.resources['publishing-account'].account, 'reviewer@example.test')
  const wrongAccount = structuredClone(resourceRequest)
  wrongAccount.resources['publishing-account'].provider = 'other'
  assert.throws(() => validateRunRequest(wrongAccount, resourceProduct), {
    code: 'PROCEDURE_RESOURCE_INVALID',
  })
})

test('workspace composition executes Agent, Direct Capability and exact subprocedure nodes under Run grants', async (t) => {
  const f = fixture(t)
  const agent = fakeFactory({
    reports: [jsonReport({ outputs: { draft: { value: 'draft value' } } })],
  })
  const directCalls = []
  const procedureCalls = []
  const coordinator = new Coordinator(f.state, {
    procedures: [workspaceCompositionProcedure()],
    adapterFactory: agent.factory,
    async executeDirectCall(call) {
      directCalls.push(call)
      return { normalized: { value: `${call.input.draft.value} normalized` } }
    },
    async executeProcedureCall(call) {
      procedureCalls.push(call)
      return { value: `${call.inputs.value} composed` }
    },
  })
  f.cleanup.push(() => coordinator.close())
  const task = coordinator.create({
    procedureRef: {
      id: 'org.openadam.test.workspace-composition',
      version: '1.0.0',
    },
    inputs: { request: 'Produce one composed result' },
    grants: ['model.invoke', 'workspace.write', 'capability.invoke', 'procedure.invoke'],
    resources: {
      workspace: {
        type: 'workspace',
        adapter: 'git',
        path: f.workspace,
        allowExistingPaths: [],
      },
    },
    limits: {
      maxDurationMs: 60_000,
      maxNodeExecutions: 10,
      maxAgentTurns: 2,
      nodeTimeoutMs: 30_000,
      maxAttemptsPerNode: 2,
      maxOutputBytes: 65_536,
    },
    idempotencyKey: 'composed-run',
  })
  command(coordinator, task, 'start')
  await waitFor(() => ['complete', 'failed', 'paused', 'reconciling'].includes(coordinator.get(task.id).status))
  const complete = coordinator.get(task.id)
  assert.equal(complete.status, 'complete', JSON.stringify(complete.problem))
  assert.equal(coordinator.store.readArtifact(complete.outputs.final.artifact), 'draft value normalized composed')
  assert.deepEqual(complete.attempts.map((attempt) => attempt.stage), ['prepare', 'normalize', 'delegate'])
  assert.deepEqual(directCalls[0].grants, ['capability.invoke'])
  assert.deepEqual(directCalls[0].resources, {})
  assert.deepEqual(procedureCalls[0].procedure, {
    id: 'org.openadam.test.echo-procedure',
    version: '0.1.0',
  })
  assert.deepEqual(procedureCalls[0].grants, [])
  assert.deepEqual(procedureCalls[0].resources, {})

  const denied = coordinator.create({
    taskId: crypto.randomUUID(),
    procedureRef: {
      id: 'org.openadam.test.workspace-composition',
      version: '1.0.0',
    },
    inputs: { request: 'Do not grant Direct execution' },
    grants: ['model.invoke', 'workspace.write', 'procedure.invoke'],
    resources: {
      workspace: {
        type: 'workspace', adapter: 'git', path: f.workspace, allowExistingPaths: [],
      },
    },
    idempotencyKey: 'missing-direct-grant',
  })
  command(coordinator, denied, 'start')
  await waitFor(() => coordinator.get(denied.id).status === 'failed')
  assert.equal(coordinator.get(denied.id).problem.code, 'PERMISSION_GRANT_REQUIRED')
})

test('human input, deterministic condition and transform nodes resume without an Agent turn', async (t) => {
  const f = fixture(t)
  const method = {
    schema: 'openadam.method-graph.v2',
    profile: null,
    id: 'human-transform',
    revision: 1,
    name: 'Human transform',
    description: 'Collect one bounded choice and deterministically project it.',
    roles: [],
    inputs: [],
    artifacts: [
      { id: 'choice', name: 'Choice', type: 'text', required: false },
      { id: 'final', name: 'Final', type: 'text', required: true },
    ],
    permissions: [],
    resources: [],
    graph: {
      entry: 'ask',
      extensions: {
        parallel: { version: 1, supported: false },
        wait: { version: 1, supported: false },
      },
      nodes: [
        {
          id: 'ask', name: 'Ask', kind: 'human-input', prompt: 'Choose the route.',
          interaction: 'checkpoint', options: ['continue'], responseArtifact: 'choice',
          consumes: [], produces: ['choice'], permissions: [], resources: [],
          transitions: [{ when: { operator: 'always' }, to: 'check' }],
        },
        {
          id: 'check', name: 'Check', kind: 'condition', consumes: ['choice'], produces: [], permissions: [], resources: [],
          transitions: [
            { when: { path: 'outputs.choice', operator: 'equals', value: 'continue' }, to: 'project' },
            { when: { operator: 'always' }, to: 'project' },
          ],
        },
        {
          id: 'project', name: 'Project', kind: 'transform', consumes: ['choice'], produces: ['final'], permissions: [], resources: [],
          output: { final: { path: 'outputs.choice' } },
          transitions: [{ when: { operator: 'always' }, to: null }],
        },
      ],
    },
  }
  validateMethod(method)
  const coordinator = new Coordinator(f.state, { methods: [method] })
  f.cleanup.push(() => coordinator.close())
  const task = coordinator.create({ method, inputs: {}, grants: [], resources: {} })
  command(coordinator, task, 'start')
  await waitFor(() => coordinator.get(task.id).status === 'waiting_user')
  assert.throws(
    () => command(coordinator, coordinator.get(task.id), 'answer', {
      questionId: coordinator.get(task.id).question.id,
      value: 'undeclared',
    }),
    { code: 'INVALID_INPUT' },
  )
  command(coordinator, coordinator.get(task.id), 'answer', {
    questionId: coordinator.get(task.id).question.id,
    value: 'continue',
  })
  await waitFor(() => coordinator.get(task.id).status === 'complete')
  const complete = coordinator.get(task.id)
  assert.equal(complete.turns, 0)
  assert.equal(coordinator.store.readArtifact(complete.outputs.final.artifact), 'continue')
})

test('a bare Coordinator exposes no implicit Procedure products', (t) => {
  const f = fixture(t)
  const coordinator = new Coordinator(f.state)
  f.cleanup.push(() => coordinator.close())
  assert.deepEqual(coordinator.procedureList(), [])
  assert.throws(
    () => coordinator.procedure('development', '1.0.0'),
    (error) => error.code === 'NOT_FOUND',
  )
})

const jsonReport = (extra = {}) =>
  JSON.stringify({
    outcome: 'complete',
    summary: 'Inspected the actual candidate',
    plan: 'Change answer; run check',
    findings: [],
    checks: [],
    resolvedFindingIds: [],
    acknowledgedDecisionIds: [],
    ...extra,
  })
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'procedure-test-'))
  const workspace = join(root, 'repo')
  const state = join(root, 'state')
  mkdirSync(workspace)
  mkdirSync(state)
  execFileSync('git', ['init', '-q', workspace])
  git(workspace, ['config', 'user.name', 'Procedure Fixture'])
  git(workspace, ['config', 'user.email', 'fixture@example.invalid'])
  writeFileSync(join(workspace, 'answer.txt'), 'before\n')
  git(workspace, ['add', 'answer.txt'])
  git(workspace, ['commit', '-qm', 'fixture baseline'])
  const cleanup = []
  t.after(async () => {
    for (const fn of cleanup) await fn()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, workspace, state, cleanup }
}
function fakeFactory({ onStart, hold = false, reports = [] } = {}) {
  const calls = []
  const sessions = []
  let pending
  const factory = (binding, options) => {
    let done
    let stopped = false
    let sessionId
    const worker = {
      async initialize() {
        return { steer: 'unsupported', interrupt: 'supported' }
      },
      async session(existing) {
        sessionId = existing ?? `session-${sessions.length}`
        sessions.push({ provider: binding.provider, id: sessionId, existing })
        return {
          provider: binding.provider,
          id: sessionId,
          model: 'fixture-only',
        }
      },
      async start(prompt) {
        calls.push({ binding, prompt, options })
        onStart?.({ binding, prompt, options, worker })
        if (hold)
          return new Promise((resolve) => {
            done = resolve
            pending = worker
          })
        return { status: 'complete', text: reports.shift() ?? jsonReport() }
      },
      async interrupt() {
        stopped = true
      },
      async close() {
        if (done)
          done({
            status: stopped ? 'interrupted' : 'complete',
            text: jsonReport(),
          })
      },
      respond(key, allow) {
        calls.push({ permission: key, allow })
      },
      finish(value) {
        done?.(value ?? { status: 'complete', text: jsonReport() })
      },
    }
    return worker
  }
  return {
    factory,
    calls,
    sessions,
    get worker() {
      return pending
    },
  }
}
const waitFor = async (fn) => {
  const until = Date.now() + 4000
  while (!fn()) {
    if (Date.now() > until) throw new Error('State not reached')
    await new Promise((r) => setTimeout(r, 10))
  }
}
function command(c, task, action, extra = {}) {
  return c.command(task.id, {
    requestId: crypto.randomUUID(),
    expectedRevision: c.get(task.id).revision,
    action,
    ...extra,
  })
}
const create = (c, f, extra = {}) =>
  c.create({
    workspace: f.workspace,
    goal: 'Complete a real file change and independently inspect it',
    method: developmentMethod,
    authority: { modelCalls: true, write: true, stage: true },
    ...extra,
  })

test(
  'a surviving worker process group blocks checkout takeover after its leader exits',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = fixture(t)
    const group = Number(
      execFileSync(
        process.execPath,
        [
          '-e',
          `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setTimeout(()=>{},120000)'],{stdio:'ignore'});
    child.unref(); console.log(process.pid);
  `,
        ],
        { detached: true, encoding: 'utf8' },
      ).trim(),
    )
    t.after(() => {
      try {
        process.kill(-group, 'SIGKILL')
      } catch (e) {
        if (e.code !== 'ESRCH') throw e
      }
    })
    assert.throws(() => process.kill(group, 0), { code: 'ESRCH' })
    assert.equal(workerAlive(group), true)
    writeFileSync(
      join(f.workspace, '.git/agent-procedure-lease.json'),
      JSON.stringify({
        owner: f.state,
        taskId: 'old',
        pid: group,
        workerPid: group,
      }),
    )
    assert.throws(() => claimCheckout(f.workspace, f.state, 'new'), {
      code: 'WORKSPACE_BUSY',
    })
  },
)

test('restart reconciles an older active task even beyond the 200-row task list', async (t) => {
  const f = fixture(t)
  const c = testCoordinator(f.state, { adapterFactory: fakeFactory().factory })
  const first = create(c, f)
  c.store.update(first.id, null, (task) => {
    task.status = 'running'
    task.active = { id: 'interrupted', pid: null }
  })
  for (let i = 0; i < 205; i++)
    c.store.save({ ...first, id: crypto.randomUUID() })
  await c.close()
  const recovered = testCoordinator(f.state, {
    adapterFactory: fakeFactory().factory,
  })
  f.cleanup.push(() => recovered.close())
  assert.equal(recovered.list().length, 200)
  assert.equal(recovered.get(first.id).status, 'reconciling')
  assert.equal(recovered.get(first.id).active.id, 'interrupted')
})

test('worker event quota stops execution but cannot block pause, cancel or durable recovery records', async (t) => {
  const f = fixture(t)
  const mock = fakeFactory({ hold: true })
  const c = testCoordinator(f.state, {
    adapterFactory: mock.factory,
    procedures: [researchProcedure()],
  })
  f.cleanup.push(() => c.close())
  const task = create(c, f)
  command(c, task, 'start')
  await waitFor(() => mock.worker)
  c.store.db
    .prepare('INSERT OR REPLACE INTO event_usage VALUES(?,20000,0)')
    .run(task.id)
  mock.calls[0].options.onEvent({
    kind: 'provider-event',
    text: 'beyond quota',
  })
  await waitFor(() => c.get(task.id).status === 'paused')
  assert.equal(c.get(task.id).problem.code, 'EVENT_LIMIT')
  assert.equal(c.get(task.id).active, null)
  command(c, task, 'cancel')
  assert.equal(c.get(task.id).status, 'cancelled')
  assert(c.store.events(task.id).some((e) => e.kind === 'attempt-ended'))
  for (let i = 0; i < 2005; i++) c.store.event(task.id, 'control-test', { i })
  assert(c.store.retention(task.id).discardedControlEvents > 0)
  assert.equal(
    c.store.db
      .prepare(
        "SELECT count(*) AS n FROM events WHERE task=? AND kind NOT IN ('worker-event','late-event')",
      )
      .get(task.id).n,
    2000,
  )
})

test('failed native dispatch leaves new input saved, not falsely delivered', async (t) => {
  const f = fixture(t)
  const c = testCoordinator(f.state, {
    adapterFactory: () => ({
      initialize: async () => ({}),
      session: async () => ({ id: 'same-owner', provider: 'codex' }),
      start: async () => {
        throw new Error('request transport failed before acknowledgement')
      },
      close: async () => {},
    }),
  })
  f.cleanup.push(() => c.close())
  const task = create(c, f)
  command(c, task, 'input', { text: 'Keep this decision' })
  command(c, task, 'start')
  await waitFor(() => c.get(task.id).status === 'failed')
  const decision = c.get(task.id).decisions[0]
  assert.equal(decision.delivery, 'queued-for-turn')
  assert.equal(decision.deliveryEvidence, undefined)
  assert.equal(decision.appliedEvidence, null)
})

test('candidate snapshots retain dangling symlinks, special object keys and literal Git paths', (t) => {
  const f = fixture(t)
  const base = snapshot(f.workspace)
  writeFileSync(join(f.workspace, '__proto__'), 'ordinary file\n')
  writeFileSync(join(f.workspace, '[a].txt'), 'literal\n')
  symlinkSync('../missing-target', join(f.workspace, 'dangling'))
  const value = candidate(f.workspace, base, [])
  assert.equal(value.files.dangling.kind, 'symlink')
  assert(Object.hasOwn(value.files, '__proto__'))
  stage(f.workspace, value)
  assert.equal(git(f.workspace, ['show', ':__proto__']), 'ordinary file\n')
  assert.equal(git(f.workspace, ['show', ':[a].txt']), 'literal\n')
  assert.equal(git(f.workspace, ['show', ':dangling']), '../missing-target')
})

test('large role context remains retrievable and the reviewer receives the dirty baseline, not builder transcript', async (t) => {
  const f = fixture(t)
  writeFileSync(join(f.workspace, 'answer.txt'), 'existing uncommitted work\n')
  const c = testCoordinator(f.state, { adapterFactory: fakeFactory().factory })
  f.cleanup.push(() => c.close())
  const task = create(c, f, { allowExistingPaths: ['answer.txt'] })
  task.active = { id: 'fixture-context', requestId: 'request' }
  task.decisions = Array.from({ length: 12 }, (_, i) => ({
    id: String(i),
    text: '完整约束'.repeat(3000),
    scope: 'task',
    status: 'active',
  }))
  task.attempts = [
    { report: c.store.artifact({ summary: 'private builder explanation' }) },
  ]
  task.permissions = [
    {
      id: 'answered',
      kind: 'question',
      status: 'approved',
      questions: [{ id: 'choice', question: 'Where?' }],
      answer: { choice: ['Local only'] },
    },
    { id: 'tool', kind: 'permission', status: 'approved', answer: null },
  ]
  let projection
  const prompt = projectContext(
    task,
    task.method.graph.nodes.find((node) => node.kind === 'agent-turn' && node.role === 'reviewer'),
    c.store,
    {
      contextFile: '/fixture/context.json',
      onProjection: (data) => {
        projection = data
      },
    },
  )
  assert(prompt.includes('exceeds the inline budget'))
  assert(prompt.includes('/fixture/context.json'))
  assert.equal(projection.decisions.length, 12)
  assert.equal(
    Buffer.from(
      projection.baseline.initialContents['answer.txt'],
      'base64',
    ).toString(),
    'existing uncommitted work\n',
  )
  assert.equal(projection.reports, undefined)
  assert.equal(projection.userAnswers.length, 1)
  assert.deepEqual(projection.userAnswers[0].answer, { choice: ['Local only'] })
  assert(!prompt.includes('private builder explanation'))
})

test(
  'real sandbox exposes only this attempt context, not another task or the shared database',
  { skip: process.platform !== 'darwin' },
  (t) => {
    const f = fixture(t)
    const contextRoot = join(f.state, 'worker-context', 'owned')
    mkdirSync(contextRoot, { recursive: true })
    writeFileSync(join(contextRoot, 'task-context.json'), 'own facts')
    writeFileSync(join(f.state, 'other-task.json'), 'private other task')
    const [program, args] = workerSandbox(f.workspace, {
      stateRoot: f.state,
      contextRoot,
      writable: false,
    })
    const own = execFileSync(
      program,
      [...args, '/bin/cat', join(contextRoot, 'task-context.json')],
      { encoding: 'utf8' },
    )
    assert.equal(own, 'own facts')
    assert.throws(() =>
      execFileSync(
        program,
        [...args, '/bin/cat', join(f.state, 'other-task.json')],
        { stdio: 'pipe' },
      ),
    )
    assert.throws(() =>
      execFileSync(
        program,
        [
          ...args,
          '/bin/sh',
          '-c',
          'printf overwrite > "$1"',
          'fixture',
          join(contextRoot, 'task-context.json'),
        ],
        { stdio: 'pipe' },
      ),
    )
  },
)

test(
  'no-workspace sandbox starts without Git and exposes only its attempt context inside Runner state',
  { skip: process.platform !== 'darwin' },
  (t) => {
    const state = mkdtempSync(join(tmpdir(), 'procedure-no-workspace-state-'))
    t.after(() => rmSync(state, { recursive: true, force: true }))
    const contextRoot = join(state, 'worker-context', 'owned')
    mkdirSync(contextRoot, { recursive: true })
    writeFileSync(join(contextRoot, 'task-context.json'), 'own facts')
    writeFileSync(join(state, 'other-task.json'), 'private other task')
    const [program, args] = workerSandbox(state, {
      stateRoot: state,
      contextRoot,
      workspaceAdapter: 'none',
      writable: false,
    })
    assert.equal(execFileSync(
      program,
      [...args, '/bin/cat', join(contextRoot, 'task-context.json')],
      { encoding: 'utf8' },
    ), 'own facts')
    assert.throws(() => execFileSync(
      program,
      [...args, '/bin/cat', join(state, 'other-task.json')],
      { stdio: 'pipe' },
    ))
    assert.throws(() => execFileSync(
      program,
      [...args, '/bin/sh', '-c', 'printf overwrite > "$1"', 'fixture', join(contextRoot, 'task-context.json')],
      { stdio: 'pipe' },
    ))
  },
)

test('prepared commit rejects newly staged candidate-path work and never clobbers it', (t) => {
  const f = fixture(t)
  const base = snapshot(f.workspace)
  writeFileSync(join(f.workspace, 'answer.txt'), 'reviewed\n')
  const value = candidate(f.workspace, base, [])
  const prepared = prepareCommit(f.workspace, value, 'candidate only', f.state)
  writeFileSync(join(f.workspace, 'answer.txt'), 'later user edit\n')
  git(f.workspace, ['add', 'answer.txt'])
  assert.throws(() => applyCommit(f.workspace, prepared), {
    code: 'INDEX_CHANGED',
  })
  assert.equal(git(f.workspace, ['rev-parse', 'HEAD']).trim(), base.head)
  assert.equal(git(f.workspace, ['show', ':answer.txt']), 'later user edit\n')
})

test('a committed-but-unacknowledged candidate recovers without a second commit', async (t) => {
  const f = fixture(t)
  const c = testCoordinator(f.state, { adapterFactory: fakeFactory().factory })
  const task = create(c, f)
  const base = c.store.readArtifact(task.base)
  writeFileSync(join(f.workspace, 'answer.txt'), 'reviewed\n')
  const value = candidate(f.workspace, base, [])
  const prepared = prepareCommit(
    f.workspace,
    value,
    'single authorized candidate',
    f.state,
  )
  c.store.update(task.id, null, (t) => {
    t.status = 'finalizing'
    t.candidate = {
      identity: value.identity,
      artifact: c.store.artifact(value),
      paths: value.paths,
    }
    t.finalization = {
      kind: 'commit',
      prepared,
      authorization: { source: 'fixture-user' },
    }
  })
  git(f.workspace, ['update-ref', 'HEAD', prepared.commit, base.head])
  await c.close()
  const recovered = testCoordinator(f.state, {
    adapterFactory: fakeFactory().factory,
  })
  f.cleanup.push(() => recovered.close())
  assert.equal(recovered.get(task.id).status, 'reconciling')
  command(recovered, task, 'reconcile')
  assert.equal(
    recovered.get(task.id).finalization.recovery,
    'committed-index-needs-reconciliation',
  )
  command(recovered, task, 'finish-commit')
  await waitFor(() => recovered.get(task.id).status === 'complete')
  assert.equal(recovered.get(task.id).commit.commit, prepared.commit)
  assert.equal(git(f.workspace, ['rev-list', '--count', 'HEAD']).trim(), '2')
  assert.equal(git(f.workspace, ['show', ':answer.txt']), 'reviewed\n')
})

test('full three-role flow returns to original owner and preserves unrelated staged/unstaged work', async (t) => {
  const f = fixture(t)
  writeFileSync(join(f.workspace, 'unrelated.txt'), 'keep staged\n')
  git(f.workspace, ['add', 'unrelated.txt'])
  writeFileSync(join(f.workspace, 'unrelated.txt'), 'keep unstaged too\n')
  const original = git(f.workspace, ['show', ':unrelated.txt'])
  const mock = fakeFactory({
    onStart: ({ options }) => {
      if (options.writable)
        writeFileSync(join(f.workspace, 'answer.txt'), 'after\n')
    },
  })
  const c = testCoordinator(f.state, {
    adapterFactory: mock.factory,
    procedures: [researchProcedure()],
  })
  f.cleanup.push(() => c.close())
  const task = create(c, f)
  command(c, task, 'start')
  await waitFor(() => c.get(task.id).status === 'complete')
  const result = c.get(task.id)
  assert.equal(result.attempts.length, 4)
  assert.equal(mock.sessions[0].id, mock.sessions[3].id)
  assert.notEqual(mock.sessions[1].id, mock.sessions[2].id)
  assert.equal(result.reviewedCandidate, result.candidate.identity)
  assert.equal(git(f.workspace, ['show', ':unrelated.txt']), original)
  assert.equal(
    readFileSync(join(f.workspace, 'unrelated.txt'), 'utf8'),
    'keep unstaged too\n',
  )
  command(c, task, 'stage', { candidate: result.candidate.identity })
  await waitFor(() => c.get(task.id).staged)
  assert.equal(git(f.workspace, ['show', ':answer.txt']), 'after\n')
  assert.equal(git(f.workspace, ['show', ':unrelated.txt']), original)
})

test('a non-development method runs without Git, uses open roles, conditional rework and declared artifacts', async (t) => {
  const f = fixture(t)
  const reports = [
    jsonReport({
      summary: 'Collected an initial source set',
      outputs: { 'source-notes': { sources: ['source-a'], revision: 1 } },
    }),
    jsonReport({
      summary: 'Coverage has a material gap',
      facts: { coverage: 'insufficient' },
    }),
    jsonReport({
      summary: 'Collected the missing counterexample',
      outputs: {
        'source-notes': {
          sources: ['source-a', 'source-b'],
          revision: 2,
        },
      },
    }),
    jsonReport({
      summary: 'Coverage is sufficient',
      facts: { coverage: 'sufficient' },
    }),
    jsonReport({
      summary: 'Prepared the audience brief',
      outputs: { brief: 'A checked brief for product leaders.' },
    }),
  ]
  const mock = fakeFactory({ reports })
  const c = testCoordinator(f.state, { adapterFactory: mock.factory })
  f.cleanup.push(() => c.close())
  const task = c.create({
    goal: 'Explain the adoption risks of a new local workflow tool',
    inputs: { audience: 'Product leaders' },
    method: researchBriefMethod,
    bindings: {
      researcher: { provider: 'codex' },
      'fact-checker': { provider: 'grok' },
      editor: { provider: 'zcode' },
    },
    grants: ['model.invoke', 'network.read'],
  })
  command(c, task, 'start')
  await waitFor(() => c.get(task.id).status === 'complete')
  const result = c.get(task.id)
  assert.equal(result.workspace, null)
  assert.equal(result.workspaceAdapter, 'none')
  assert.equal(mock.calls[0].options.workspaceAdapter, 'none')
  assert.deepEqual(
    result.attempts.map((attempt) => attempt.stage),
    ['collect', 'verify', 'collect', 'verify', 'write'],
  )
  assert.equal(c.store.readArtifact(result.outputs['source-notes'].artifact).revision, 2)
  assert.equal(
    c.store.readArtifact(result.outputs.brief.artifact),
    'A checked brief for product leaders.',
  )
  const handoff = c.export(task.id)
  assert.equal(handoff.changes, null)
  assert.equal(handoff.outputs.brief.value, 'A checked brief for product leaders.')
})
test('declared artifact types reject structurally invalid worker outputs', () => {
  const write = researchBriefMethod.graph.nodes.find((node) => node.id === 'write')
  assert.throws(
    () =>
      report(
        jsonReport({ outputs: { brief: { unexpected: 'object' } } }),
        { method: researchBriefMethod, stage: write },
      ),
    { code: 'INVALID_REPORT' },
  )
})
test('a correction restarts a no-workspace method without retaining derived artifacts', async (t) => {
  const f = fixture(t)
  const c = testCoordinator(f.state, { adapterFactory: fakeFactory().factory })
  f.cleanup.push(() => c.close())
  const task = c.create({
    goal: 'Compare two approaches',
    inputs: { audience: 'Independent developers' },
    method: researchBriefMethod,
    bindings: {
      researcher: { provider: 'codex' },
      'fact-checker': { provider: 'grok' },
      editor: { provider: 'zcode' },
    },
    grants: ['model.invoke', 'network.read'],
  })
  c.store.transaction(() => {
    const saved = c.store.get(task.id)
    saved.phase = 'write'
    saved.outputs = {
      'source-notes': {
        artifact: c.store.artifact({ sources: ['old'] }),
        stage: 'collect',
      },
      brief: {
        artifact: c.store.artifact('Old brief'),
        stage: 'write',
      },
    }
    c.store.save(saved)
  })
  command(c, c.get(task.id), 'input', { text: 'Use a different audience' })
  const corrected = c.get(task.id)
  assert.equal(corrected.phase, 'collect')
  assert.deepEqual(corrected.outputs, {})
})
test('idempotent request, stale revision and same-ID different-content are distinct', async (t) => {
  const f = fixture(t)
  const c = testCoordinator(f.state, { adapterFactory: fakeFactory().factory })
  f.cleanup.push(() => c.close())
  const task = create(c, f)
  const req = {
    requestId: 'same',
    expectedRevision: 0,
    action: 'input',
    text: 'Preserve input',
  }
  const first = c.command(task.id, req)
  assert.deepEqual(c.command(task.id, req), first)
  assert.equal(c.get(task.id).decisions.length, 1)
  assert.throws(() => c.command(task.id, { ...req, text: 'changed' }), {
    code: 'REQUEST_CONFLICT',
  })
  assert.throws(() => c.command(task.id, { ...req, requestId: 'other' }), {
    code: 'REVISION_CONFLICT',
  })
})
test('pause cannot hand off before close and late completion cannot schedule another stage', async (t) => {
  const f = fixture(t)
  const mock = fakeFactory({ hold: true })
  const c = testCoordinator(f.state, { adapterFactory: mock.factory })
  f.cleanup.push(() => c.close())
  const task = create(c, f)
  command(c, task, 'start')
  await waitFor(() => mock.worker)
  command(c, task, 'pause')
  assert.equal(c.get(task.id).status, 'pausing')
  await waitFor(() => c.get(task.id).status === 'paused')
  mock.worker.finish()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(mock.calls.length, 1)
  assert.equal(c.get(task.id).active, null)
})
test('key correction survives stopping, appears in resumed projection, and invalidates old advance', async (t) => {
  const f = fixture(t)
  const mock = fakeFactory({ hold: true })
  const c = testCoordinator(f.state, { adapterFactory: mock.factory })
  f.cleanup.push(() => c.close())
  const task = create(c, f)
  command(c, task, 'start')
  await waitFor(() => mock.worker)
  command(c, task, 'input', { text: 'Keep the API name exactly unchanged' })
  await waitFor(() => c.get(task.id).status === 'paused')
  assert.equal(c.get(task.id).phase, 'plan')
  command(c, task, 'resume')
  await waitFor(() => mock.calls.length === 2)
  assert.match(mock.calls[1].prompt, /Keep the API name exactly unchanged/)
  command(c, task, 'cancel')
  await waitFor(() => c.get(task.id).status === 'cancelled')
})
test('review drift does not certify changed candidate', async (t) => {
  const f = fixture(t)
  const mock = fakeFactory({
    onStart: ({ binding }) => {
      if (binding.provider === 'zcode')
        writeFileSync(
          join(f.workspace, 'answer.txt'),
          'native edit during review',
        )
    },
  })
  const c = testCoordinator(f.state, { adapterFactory: mock.factory })
  f.cleanup.push(() => c.close())
  const task = create(c, f)
  command(c, task, 'start')
  await waitFor(() => c.get(task.id).status === 'paused')
  assert.equal(c.get(task.id).problem.code, 'REVIEW_DRIFT')
  assert.equal(c.get(task.id).reviewedCandidate, null)
})
test('missing model authorization never constructs a worker', async (t) => {
  const f = fixture(t)
  const mock = fakeFactory()
  const c = testCoordinator(f.state, { adapterFactory: mock.factory })
  f.cleanup.push(() => c.close())
  const task = create(c, f, { authority: { write: true } })
  assert.throws(() => command(c, task, 'start'), {
    code: 'PERMISSION_GRANT_REQUIRED',
  })
  assert.equal(mock.calls.length, 0)
})
test('provider permissions are scoped to attempt and requirements; refusal reaches provider', async (t) => {
  const f = fixture(t)
  const mock = fakeFactory({
    hold: true,
    onStart: ({ options }) =>
      options.onPermission({
        id: 'p1',
        method: 'request',
        native: { command: 'check' },
      }),
  })
  const c = testCoordinator(f.state, { adapterFactory: mock.factory })
  f.cleanup.push(() => c.close())
  const task = create(c, f)
  command(c, task, 'start')
  await waitFor(() => c.get(task.id).status === 'waiting_user')
  command(c, task, 'permission', { permissionId: 'p1', allow: false })
  await waitFor(() => mock.calls.some((x) => x.permission))
  assert.equal(mock.calls.at(-1).allow, false)
  assert.throws(
    () => command(c, task, 'permission', { permissionId: 'p1', allow: true }),
    { code: 'STALE_PERMISSION' },
  )
  command(c, task, 'cancel')
  await waitFor(() => c.get(task.id).status === 'cancelled')
})
test('a Provider temporary request cannot enlarge the Run grant or the active node grant', async (t) => {
  const f = fixture(t)
  const mock = fakeFactory({
    hold: true,
    onStart: ({ options }) =>
      options.onPermission({
        id: 'write-outside-node',
        method: 'item/fileChange/requestApproval',
        native: { path: 'answer.txt' },
        requiredGrant: 'workspace.write',
      }),
  })
  const c = testCoordinator(f.state, { adapterFactory: mock.factory })
  f.cleanup.push(() => c.close())
  const task = create(c, f)
  command(c, task, 'start')
  await waitFor(() => mock.calls.some((call) => call.permission === 'write-outside-node'))
  assert.equal(mock.calls.at(-1).allow, false)
  assert.equal(c.get(task.id).status, 'running')
  assert.equal(c.get(task.id).permissions.length, 0)
  assert.equal(
    c.store.events(task.id).some((event) =>
      event.kind === 'permission-denied-by-run-grant' &&
      event.body.requiredGrant === 'workspace.write'),
    true,
  )
  command(c, task, 'cancel')
  await waitFor(() => c.get(task.id).status === 'cancelled')
})
test('crashed dispatch is not replayed and recovery requires checking old writer', async (t) => {
  const f = fixture(t)
  const initial = testCoordinator(f.state)
  const task = create(initial, f)
  initial.store.update(task.id, null, (t) => {
    t.status = 'running'
    t.active = {
      id: 'old',
      pid: process.pid,
      stage: 'build',
      startedAt: new Date().toISOString(),
    }
  })
  initial.store.close()
  const mock = fakeFactory()
  const c = testCoordinator(f.state, { adapterFactory: mock.factory })
  f.cleanup.push(() => c.close())
  assert.equal(c.get(task.id).status, 'reconciling')
  assert.equal(mock.calls.length, 0)
  assert.throws(() => command(c, task, 'reconcile'), {
    code: 'WORKER_UNCONFIRMED',
  })
  c.store.update(task.id, null, (t) => {
    t.active.pid = null
  })
  command(c, task, 'reconcile')
  assert.equal(c.get(task.id).status, 'paused')
  assert.equal(mock.calls.length, 0)
})
test('pause and cancel cannot bypass recovery or an in-flight finalization', async (t) => {
  const f = fixture(t)
  const mock = fakeFactory({ hold: true })
  const c = testCoordinator(f.state, { adapterFactory: mock.factory })
  f.cleanup.push(() => c.close())
  const task = create(c, f)
  command(c, task, 'start')
  await waitFor(() => mock.worker)
  // Simulate an unconfirmed stop: the worker registration is gone but the
  // attempt stays active with a retained checkout lease.
  c.workers.delete(task.id)
  c.store.update(task.id, null, (x) => {
    x.status = 'reconciling'
  })
  assert.throws(() => command(c, task, 'pause'), { code: 'INVALID_STATE' })
  assert.throws(() => command(c, task, 'cancel'), { code: 'INVALID_STATE' })
  const other = create(c, f)
  assert.throws(() => command(c, other, 'start'), { code: 'WORKSPACE_BUSY' })
  c.store.update(task.id, null, (x) => {
    x.status = 'finalizing'
  })
  assert.throws(() => command(c, task, 'pause'), { code: 'INVALID_STATE' })
  c.store.update(task.id, null, (x) => {
    x.status = 'reconciling'
  })
  command(c, task, 'reconcile')
  assert.equal(c.get(task.id).status, 'paused')
  command(c, task, 'cancel')
  await waitFor(() => c.get(task.id).status === 'cancelled')
})
test('workspaces share one lease across tasks and state root has one coordinator', async (t) => {
  const f = fixture(t)
  const mock = fakeFactory({ hold: true })
  const c = testCoordinator(f.state, { adapterFactory: mock.factory })
  f.cleanup.push(() => c.close())
  assert.throws(() => new Store(f.state), { code: 'STORE_LOCKED' })
  const a = create(c, f),
    b = create(c, f)
  command(c, a, 'start')
  await waitFor(() => mock.worker)
  assert.throws(() => command(c, b, 'start'), { code: 'WORKSPACE_BUSY' })
  command(c, a, 'cancel')
  await waitFor(() => c.get(a.id).status === 'cancelled')
})
test('attempt budgets stop rework loops with a continuable candidate', async (t) => {
  const f = fixture(t)
  const mock = fakeFactory({
    reports: [
      jsonReport(),
      jsonReport(),
      jsonReport({
        outcome: 'changes_requested',
        findings: [{ title: 'Fix value', detail: 'Wrong value' }],
      }),
    ],
  })
  const c = testCoordinator(f.state, { adapterFactory: mock.factory })
  f.cleanup.push(() => c.close())
  const task = create(c, f, { limits: { maxTurns: 3, maxMinutes: 1 } })
  command(c, task, 'start')
  await waitFor(() => c.get(task.id).status === 'failed')
  assert.equal(c.get(task.id).problem.code, 'RUN_LIMIT')
  assert.equal(mock.calls.length, 3)
  assert.ok(c.get(task.id).candidate)
})
test('editable method revisions really change next run and cannot bypass independent review', async (t) => {
  const f = fixture(t)
  const method = structuredClone(developmentMethod)
  method.revision = developmentMethod.revision + 1
  method.graph.nodes[1].instruction = 'Unique changed construction instruction'
  const mock = fakeFactory()
  const c = testCoordinator(f.state, { adapterFactory: mock.factory })
  f.cleanup.push(() => c.close())
  const task = create(c, f, { method })
  command(c, task, 'start')
  await waitFor(() => c.get(task.id).status === 'complete')
  assert.match(mock.calls[1].prompt, /Unique changed construction instruction/)
  assert.equal(c.get(task.id).method.revision, developmentMethod.revision + 1)
  method.graph.nodes[1].transitions[0].to = 'final-review'
  assert.throws(() => validateDevelopmentMethod(method), {
    code: 'INVALID_METHOD',
  })
})
test('commit is exact-candidate, preserves unrelated index, and never pushes', (t) => {
  const f = fixture(t)
  writeFileSync(join(f.workspace, 'other.txt'), 'unrelated')
  git(f.workspace, ['add', 'other.txt'])
  const base = snapshot(f.workspace)
  writeFileSync(join(f.workspace, 'answer.txt'), 'approved')
  let change = candidate(f.workspace, base, ['other.txt'])
  writeFileSync(join(f.workspace, 'answer.txt'), 'late')
  assert.throws(
    () => commitCandidate(f.workspace, change, 'task commit', f.state),
    { code: 'CANDIDATE_DRIFT' },
  )
  writeFileSync(join(f.workspace, 'answer.txt'), 'approved')
  const result = commitCandidate(f.workspace, change, 'task commit', f.state)
  assert.equal(git(f.workspace, ['rev-parse', 'HEAD']).trim(), result.commit)
  assert.equal(git(f.workspace, ['show', 'HEAD:answer.txt']), 'approved')
  assert.throws(() =>
    git(f.workspace, ['show', 'HEAD:other.txt'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  )
  assert.equal(git(f.workspace, ['show', ':other.txt']), 'unrelated')
})
test(
  'real inherited sandbox blocks shell git writes and protected files, but permits task edits',
  { skip: process.platform !== 'darwin' },
  (t) => {
    const f = fixture(t)
    const outside = mkdtempSync(join(homedir(), '.procedure-sandbox-fixture-'))
    t.after(() => rmSync(outside, { recursive: true, force: true }))
    writeFileSync(join(f.workspace, 'protected.txt'), 'keep')
    const [cmd, args] = workerSandbox(f.workspace, {
      writable: true,
      stateRoot: f.state,
      protectedPaths: ['protected.txt'],
      runtime: 'codex',
    })
    const exec = (source) =>
      execFileSync(cmd, [...args, process.execPath, '-e', source], {
        cwd: f.workspace,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    exec("require('fs').writeFileSync('answer.txt','allowed')")
    assert.throws(() =>
      exec(
        `require('fs').writeFileSync(${JSON.stringify(join(outside, 'not-allowed.txt'))},'blocked')`,
      ),
    )
    assert.throws(() =>
      exec("require('fs').writeFileSync('.git/HEAD','broken')"),
    )
    assert.throws(() =>
      exec("require('fs').writeFileSync('protected.txt','broken')"),
    )
    assert.equal(
      readFileSync(join(f.workspace, 'protected.txt'), 'utf8'),
      'keep',
    )
    const [ro, flags] = workerSandbox(f.workspace, {
      writable: false,
      stateRoot: f.state,
      runtime: 'codex',
    })
    assert.throws(() =>
      execFileSync(
        ro,
        [
          ...flags,
          process.execPath,
          '-e',
          "require('fs').writeFileSync('answer.txt','broken')",
        ],
        { cwd: f.workspace, stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    )
  },
)
test('real HTTP entry authenticates, rejects cross-origin commands and shares task state', async (t) => {
  const f = fixture(t)
  const mock = fakeFactory({
    reports: [
      jsonReport({ outputs: { 'source-notes': { sources: ['one'] } } }),
      jsonReport({ facts: { coverage: 'sufficient' } }),
      jsonReport({ outputs: { brief: 'Finished brief' } }),
    ],
  })
  const c = testCoordinator(f.state, {
    adapterFactory: mock.factory,
    procedures: [researchProcedure()],
  })
  const running = await serve({ coordinator: c })
  f.cleanup.push(() => running.close())
  const headers = {
    Authorization: `Bearer ${running.token}`,
    'Content-Type': 'application/json',
  }
  assert.equal((await fetch(running.origin + '/api/tasks')).status, 403)
  assert.equal(
    (
      await fetch(running.origin + '/api/tasks', {
        headers: { ...headers, Origin: 'https://evil.example' },
      })
    ).status,
    403,
  )
  const input = {
    schemaVersion: 'openadam.agent-host-procedure-run-request.v0.1',
    procedure: { id: 'org.openadam.test.research-brief', version: '1.0.0' },
    inputs: {
      goal: '<img src=x onerror=alert(1)>',
      audience: 'Independent developers',
    },
    grants: ['model.invoke', 'network.read'],
    resources: {},
    limits: {
      maxDurationMs: 60_000,
      maxNodeExecutions: 20,
      maxAgentTurns: 10,
      nodeTimeoutMs: 30_000,
      maxAttemptsPerNode: 4,
      maxOutputBytes: 262_144,
    },
    idempotencyKey: 'http-entry-fixture',
  }
  const r = await fetch(running.origin + '/api/tasks', {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
  })
  assert.equal(r.status, 201)
  const task = await r.json()
  const list = await (
    await fetch(running.origin + '/api/tasks', { headers })
  ).json()
  assert.equal(list.tasks[0].id, task.id)
  const catalog = await (
    await fetch(running.origin + '/api/procedures', { headers })
  ).json()
  const research = catalog.procedures.find(
    (procedure) => procedure.id === 'org.openadam.test.research-brief',
  )
  assert.deepEqual(research.permissions, ['model.invoke', 'network.read'])
  assert.equal(research.execution.kind, 'agentic-runner')
  assert.equal(research.method, undefined)
  const described = await (
    await fetch(
      running.origin + '/api/procedures/org.openadam.test.research-brief/1.0.0',
      { headers },
    )
  ).json()
  assert.deepEqual(described.procedure.inputSchema, researchProcedure().inputSchema)

  const taskId = task.id
  await waitFor(() => c.get(taskId).status === 'complete')
  const retried = await fetch(running.origin + '/api/tasks', {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
  })
  assert.equal(retried.status, 201)
  assert.equal((await retried.json()).id, taskId)
  assert.equal(c.list().filter((item) => item.id === taskId).length, 1)
  const output = await (
    await fetch(`${running.origin}/api/tasks/${taskId}/output`, { headers })
  ).json()
  assert.deepEqual(output.outputs, { brief: 'Finished brief' })
  assert.equal(
    (
      await fetch(running.origin + '/api/methods', {
        method: 'POST',
        headers,
        body: JSON.stringify(researchBriefMethod),
      })
    ).status,
    404,
  )
  const page = await fetch(running.origin, { headers })
  assert.equal(page.status, 404)
  assert.match(
    page.headers.get('content-security-policy'),
    /frame-ancestors 'none'/,
  )
  assert.equal((await page.json()).error.code, 'NOT_FOUND')
})

test('an approved permission can finish and schedule the remaining stages without a lost wakeup', async (t) => {
  const f = fixture(t)
  let c
  const mock = fakeFactory({
    hold: true,
    onStart: ({ options, worker }) => {
      if (options.writable)
        options.onPermission({
          id: 'approval',
          method: 'permission',
          native: { command: 'read' },
          requiredGrant: 'workspace.write',
        })
      else setTimeout(() => worker.finish(), 1)
    },
  })
  c = testCoordinator(f.state, {
    adapterFactory: (binding, options) => {
      const w = mock.factory(binding, options)
      w.respond = () => w.finish()
      return w
    },
  })
  f.cleanup.push(() => c.close())
  const task = create(c, f)
  command(c, task, 'start')
  await waitFor(() => c.get(task.id).status === 'waiting_user')
  command(c, task, 'permission', { permissionId: 'approval', allow: true })
  await waitFor(() => c.get(task.id).status === 'complete')
  assert.equal(c.get(task.id).attempts.length, 4)
})

test('separate state directories cannot create overlapping checkout writers', async (t) => {
  const f = fixture(t)
  const a = testCoordinator(f.state, {
    adapterFactory: fakeFactory({ hold: true }).factory,
  })
  const b = testCoordinator(join(f.root, 'state-b'), {
    adapterFactory: fakeFactory().factory,
  })
  f.cleanup.push(
    () => a.close(),
    () => b.close(),
  )
  const first = create(a, f),
    second = create(b, f)
  command(a, first, 'start')
  await waitFor(() => a.get(first.id).active)
  assert.throws(() => command(b, second, 'start'), { code: 'WORKSPACE_BUSY' })
  command(a, first, 'cancel')
  await waitFor(() => a.get(first.id).status === 'cancelled')
})

test('queued permission is revalidated after a correction or pause before delivery', async (t) => {
  for (const action of ['input', 'pause']) {
    const f = fixture(t)
    const mock = fakeFactory({
      hold: true,
      onStart: ({ options }) =>
        options.onPermission({ id: 'approval', method: 'request', native: {} }),
    })
    const c = testCoordinator(f.state, { adapterFactory: mock.factory })
    f.cleanup.push(() => c.close())
    const task = create(c, f)
    command(c, task, 'start')
    await waitFor(() => c.get(task.id).status === 'waiting_user')
    command(c, task, 'permission', { permissionId: 'approval', allow: true })
    command(c, task, action, { text: 'Do not run this command' })
    await waitFor(() => !c.get(task.id).active)
    assert(!mock.calls.some((call) => call.permission && call.allow))
    assert.equal(c.get(task.id).status, 'paused')
  }
})

test('failed commit finalization retains lease until reconciliation and cannot resume as a model turn', async (t) => {
  const f = fixture(t)
  const c = testCoordinator(f.state, { adapterFactory: fakeFactory().factory })
  f.cleanup.push(() => c.close())
  const task = create(c, f)
  const base = c.store.readArtifact(task.base)
  writeFileSync(join(f.workspace, 'answer.txt'), 'reviewed\n')
  const value = candidate(f.workspace, base, [])
  const prepared = prepareCommit(f.workspace, value, 'candidate', f.state)
  c.store.claim(f.workspace, task.id)
  c.store.update(task.id, null, (x) => {
    x.status = 'finalizing'
    x.finalization = {
      kind: 'commit',
      prepared,
      authorization: { source: 'fixture' },
    }
  })
  c.fail(task.id, new Error('index publish failed'))
  const other = create(c, f)
  assert.throws(() => command(c, other, 'start'), { code: 'WORKSPACE_BUSY' })
  git(f.workspace, ['update-ref', 'HEAD', prepared.commit, base.head])
  command(c, task, 'reconcile')
  assert.throws(() => command(c, task, 'resume'), {
    code: 'FINALIZATION_PENDING',
  })
  assert.throws(() => command(c, task, 'cancel'), {
    code: 'FINALIZATION_PENDING',
  })
  assert.throws(() => command(c, other, 'start'), { code: 'WORKSPACE_BUSY' })
  command(c, task, 'finish-commit')
  await waitFor(() => c.get(task.id).status === 'complete')
  assert.equal(git(f.workspace, ['rev-list', '--count', 'HEAD']).trim(), '2')
})

test('native edit during final owner review must revisit independent review before completion', async (t) => {
  const f = fixture(t)
  let ownerCalls = 0
  const mock = fakeFactory({
    onStart: ({ binding, options }) => {
      if (options.writable)
        writeFileSync(join(f.workspace, 'answer.txt'), 'built\n')
      if (binding.provider === 'codex' && ++ownerCalls === 2)
        writeFileSync(
          join(f.workspace, 'answer.txt'),
          'changed during owner review\n',
        )
    },
  })
  const c = testCoordinator(f.state, { adapterFactory: mock.factory })
  f.cleanup.push(() => c.close())
  const task = create(c, f)
  command(c, task, 'start')
  await waitFor(() => c.get(task.id).status === 'paused')
  assert.equal(c.get(task.id).problem.code, 'REVIEW_DRIFT')
  command(c, task, 'resume')
  await waitFor(() => c.get(task.id).status === 'complete')
  assert.deepEqual(
    mock.calls.map((call) => call.binding.provider),
    ['codex', 'grok', 'zcode', 'codex', 'zcode', 'codex'],
  )
})

test('failed or incomplete attempts invalidate checks and verified findings for changed bytes', async (t) => {
  const f = fixture(t)
  const mock = fakeFactory({ hold: true })
  const c = testCoordinator(f.state, { adapterFactory: mock.factory })
  f.cleanup.push(() => c.close())
  const task = create(c, f)
  c.store.update(task.id, null, (x) => {
    x.phase = 'build'
    x.checks = [{ candidate: 'old', status: 'current' }]
    x.findings = [
      { id: 'finding', status: 'verified', resolution: { candidate: 'old' } },
    ]
  })
  command(c, task, 'start')
  await waitFor(() => mock.worker)
  writeFileSync(join(f.workspace, 'answer.txt'), 'new unreviewed content')
  command(c, task, 'pause')
  await waitFor(() => c.get(task.id).status === 'paused')
  assert.equal(c.get(task.id).checks[0].status, 'stale')
  assert.equal(c.get(task.id).findings[0].status, 'pending')
})

test('a paused task question can be answered and continues without discarding the question', async (t) => {
  const f = fixture(t)
  const mock = fakeFactory({
    reports: [jsonReport({ outcome: 'needs_user', question: 'Which result?' })],
  })
  const c = testCoordinator(f.state, { adapterFactory: mock.factory })
  f.cleanup.push(() => c.close())
  const task = create(c, f)
  command(c, task, 'start')
  await waitFor(() => c.get(task.id).question)
  const questionId = c.get(task.id).question.id
  command(c, task, 'pause')
  command(c, task, 'answer', { questionId, text: 'Keep it local' })
  await waitFor(() => c.get(task.id).status === 'complete')
  assert(mock.calls[1].prompt.includes('Keep it local'))
})

test('method cannot omit a complete route or trap every route in a loop', () => {
  const missing = structuredClone(developmentMethod)
  missing.graph.nodes[1].transitions = []
  assert.throws(() => validateMethod(missing), { code: 'INVALID_METHOD' })
  const loop = structuredClone(developmentMethod)
  for (const node of loop.graph.nodes)
    for (const transition of node.transitions)
      if (transition.to === null) transition.to = loop.graph.nodes[0].id
  assert.throws(() => validateMethod(loop), { code: 'INVALID_METHOD' })
})

test('explicitly included existing edits and deletions remain in the candidate without another worker edit', async (t) => {
  const f = fixture(t)
  writeFileSync(join(f.workspace, 'existing.txt'), 'already written\n')
  rmSync(join(f.workspace, 'answer.txt'))
  const c = testCoordinator(f.state, { adapterFactory: fakeFactory().factory })
  f.cleanup.push(() => c.close())
  const task = create(c, f, {
    allowExistingPaths: ['existing.txt', 'answer.txt'],
  })
  command(c, task, 'start')
  await waitFor(() => c.get(task.id).status === 'complete')
  assert.deepEqual(c.get(task.id).candidate.paths, [
    'answer.txt',
    'existing.txt',
  ])
  assert.equal(git(f.workspace, ['show', ':existing.txt']), 'already written\n')
  assert.equal(git(f.workspace, ['ls-files', 'answer.txt']).trim(), '')
})

test('recovery accounts for an interrupted attempt only once', async (t) => {
  const f = fixture(t)
  const c = testCoordinator(f.state, { adapterFactory: fakeFactory().factory })
  f.cleanup.push(() => c.close())
  const task = create(c, f)
  c.store.update(task.id, null, (x) => {
    x.status = 'reconciling'
    x.active = {
      id: 'crashed',
      stage: 'build',
      startedAt: new Date(Date.now() - 61000).toISOString(),
    }
  })
  command(c, task, 'reconcile')
  assert(c.get(task.id).elapsedMs >= 61000)
  c.store.update(task.id, null, (x) => {
    x.status = 'reconciling'
    x.active = { ...x.attempts[0] }
  })
  const elapsed = c.get(task.id).elapsedMs
  command(c, task, 'reconcile')
  assert.equal(c.get(task.id).attempts.length, 1)
  assert.equal(c.get(task.id).elapsedMs, elapsed)
})

test('commit bytes come from the reviewed candidate, not a later reread', (t) => {
  const f = fixture(t)
  const base = snapshot(f.workspace)
  writeFileSync(join(f.workspace, 'answer.txt'), 'candidate bytes')
  const value = candidate(f.workspace, base, [])
  const prepared = prepareCommit(f.workspace, value, 'approved bytes', f.state)
  writeFileSync(join(f.workspace, 'answer.txt'), 'later native edit')
  assert.equal(
    git(f.workspace, ['show', prepared.commit + ':answer.txt']),
    'candidate bytes',
  )
  assert.equal(
    readFileSync(join(f.workspace, 'answer.txt'), 'utf8'),
    'later native edit',
  )
})

test('supplement during a native permission wait stops the old request instead of stranding the worker', async (t) => {
  const f = fixture(t)
  const mock = fakeFactory({ hold: true })
  const c = testCoordinator(f.state, { adapterFactory: mock.factory })
  f.cleanup.push(() => c.close())
  const task = create(c, f)
  command(c, task, 'start')
  await waitFor(() => mock.worker)
  mock.calls[0].options.onPermission({
    id: 'waiting',
    method: 'fixture',
    native: {},
  })
  command(c, task, 'input', {
    text: 'Also inspect the newline',
    impact: 'supplement',
  })
  await waitFor(() => c.get(task.id).status === 'paused')
  assert.equal(c.get(task.id).permissions[0].status, 'expired')
  assert.equal(c.get(task.id).active, null)
})

test('finding disposition during an attempt becomes a decision and cannot be certified by the old report', async (t) => {
  const f = fixture(t)
  const mock = fakeFactory({ hold: true })
  const c = testCoordinator(f.state, { adapterFactory: mock.factory })
  f.cleanup.push(() => c.close())
  const task = create(c, f)
  c.store.update(task.id, null, (x) => {
    x.findings.push({ id: 'f', title: 'Issue', status: 'pending' })
  })
  command(c, task, 'start')
  await waitFor(() => mock.worker)
  command(c, task, 'finding', {
    findingId: 'f',
    status: 'rejected',
    reason: 'Outside the agreed goal',
  })
  await waitFor(() => c.get(task.id).status === 'paused')
  const result = c.get(task.id)
  assert.equal(result.decisions.at(-1).scope, 'finding')
  assert.equal(result.findings[0].status, 'rejected')
  assert.equal(result.reviewedCandidate, null)
})

for (const runtime of ['codex', 'grok'])
  test(
    `${runtime} enclosing policy preserves provider persistence but protects global config and hooks`,
    { skip: process.platform !== 'darwin' },
    (t) => {
      const f = fixture(t)
      const home = mkdtempSync(join(homedir(), '.procedure-provider-fixture-'))
      t.after(() => rmSync(home, { recursive: true, force: true }))
      mkdirSync(join(home, 'hooks'))
      writeFileSync(join(home, 'hooks/example'), 'keep')
      writeFileSync(join(home, 'config.toml'), 'keep')
      const key = runtime === 'codex' ? 'CODEX_HOME' : 'GROK_HOME'
      const old = process.env[key]
      process.env[key] = home
      let enclosed
      try {
        enclosed = workerSandbox(f.workspace, {
          stateRoot: f.state,
          writable: true,
          runtime,
        })
      } finally {
        if (old === undefined) delete process.env[key]
        else process.env[key] = old
      }
      const [cmd, args] = enclosed
      const exec = (source) =>
        execFileSync(cmd, [...args, process.execPath, '-e', source], {
          cwd: f.workspace,
          stdio: 'pipe',
        })
      exec(
        `require('fs').writeFileSync(${JSON.stringify(join(home, 'session-state'))},'allowed')`,
      )
      for (const file of ['config.toml', 'hooks/example'])
        assert.throws(() =>
          exec(
            `require('fs').writeFileSync(${JSON.stringify(join(home, file))},'blocked')`,
          ),
        )
      assert.throws(() =>
        exec(
          `require('fs').renameSync(${JSON.stringify(home)},${JSON.stringify(home + '-moved')})`,
        ),
      )
      assert.equal(readFileSync(join(home, 'config.toml'), 'utf8'), 'keep')
    },
  )

test('multiple permissions approved before delivery all reach the same still-active worker', async (t) => {
  const f = fixture(t)
  const mock = fakeFactory({ hold: true })
  const c = testCoordinator(f.state, { adapterFactory: mock.factory })
  f.cleanup.push(() => c.close())
  const task = create(c, f)
  command(c, task, 'start')
  await waitFor(() => mock.worker)
  for (const id of ['one', 'two'])
    mock.calls[0].options.onPermission({ id, method: 'fixture', native: {} })
  for (const permissionId of ['one', 'two'])
    command(c, task, 'permission', { permissionId, allow: true })
  await waitFor(() => c.get(task.id).permissions.every((p) => p.delivered))
  assert.deepEqual(
    mock.calls.filter((x) => x.permission).map((x) => x.permission),
    ['one', 'two'],
  )
})
