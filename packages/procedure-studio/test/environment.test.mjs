import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { prepareStatePaths, saveState } from '../../../src/state.mjs'
import { StudioProject } from '../src/project.mjs'
import { serveStudio } from '../src/server.mjs'

// End-to-end evidence for the Studio execution environment: a composition
// with Capability and subprocedure calls runs from the normal Studio service
// entry against an isolated Agent environment whose Direct Runtime is a
// fixture process. No model, provider, or network service is invoked.

const examples = new URL('../examples/', import.meta.url)

// A Direct Runtime stand-in: it records every work order and answers the
// fixture Capability call and the installed direct-runtime Procedure.
const fakeRuntimeSource = `
import { appendFile } from 'node:fs/promises'
let bytes = ''
for await (const chunk of process.stdin) bytes += chunk
const order = JSON.parse(bytes)
const call = order.calls[0]
const result = call.target.kind === 'capability'
  ? { value: { normalized: true, seenBy: 'fixture-direct-runtime' } }
  : { verdict: { approved: true, checkedBy: 'installed-environment' } }
await appendFile(process.argv[2], JSON.stringify({ target: call.target, providerId: call.providerId ?? null, input: call.input }) + '\\n')
process.stdout.write(JSON.stringify({ status: 'ok', calls: [{ id: call.id, status: 'ok', result }] }) + '\\n')
`

function report(outputs) {
  return JSON.stringify({
    outcome: 'complete',
    summary: 'Completed the bounded Studio fixture step',
    plan: 'Return declared outputs',
    findings: [],
    checks: [],
    resolvedFindingIds: [],
    acknowledgedDecisionIds: [],
    outputs,
  })
}

function adapter(reports) {
  return (binding) => ({
    async initialize() { return { steer: 'unsupported', interrupt: 'supported' } },
    async session(existing) { return { provider: binding.provider, id: existing ?? randomUUID(), model: 'fixture-only' } },
    async start() { return { status: 'complete', text: reports.shift() } },
    async interrupt() {},
    async close() {},
  })
}

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'procedure-studio-environment-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function gitWorkspace(root) {
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  execFileSync('git', ['init', '-q', workspace])
  execFileSync('git', ['-C', workspace, 'config', 'user.name', 'Environment Fixture'])
  execFileSync('git', ['-C', workspace, 'config', 'user.email', 'fixture@example.invalid'])
  await writeFile(join(workspace, 'README.md'), '# Fixture workspace\n')
  execFileSync('git', ['-C', workspace, 'add', 'README.md'])
  execFileSync('git', ['-C', workspace, 'commit', '-qm', 'fixture baseline'])
  return workspace
}

async function fixtureEnvironment(root) {
  const fakeRuntime = join(root, 'fake-direct-runtime.mjs')
  await writeFile(fakeRuntime, fakeRuntimeSource)
  const orderLog = join(root, 'direct-runtime-orders.jsonl')
  const componentFiles = join(root, 'verifier-files')
  await mkdir(componentFiles)
  await writeFile(join(componentFiles, 'input.schema.json'), `${JSON.stringify({
    type: 'object',
    additionalProperties: false,
    required: ['candidate'],
    properties: { candidate: { type: 'object' } },
  }, null, 2)}\n`)
  await writeFile(join(componentFiles, 'output.schema.json'), `${JSON.stringify({
    type: 'object',
    additionalProperties: false,
    required: ['verdict'],
    properties: { verdict: { type: 'object' } },
  }, null, 2)}\n`)
  const stateRoot = join(root, 'host-state')
  const paths = await prepareStatePaths(stateRoot)
  const now = new Date().toISOString()
  await saveState(paths, {
    schemaVersion: 'openadam.agent-host-state.v0.2',
    suiteVersion: '0.1.0-studio-environment-fixture',
    channel: 'development',
    profile: 'standard',
    installedAt: now,
    updatedAt: now,
    components: {
      'direct-execution-runtime': {
        fingerprint: 'fixture-direct-runtime',
        command: process.execPath,
        args: [fakeRuntime, orderLog],
      },
      'verifier-procedure': {
        fingerprint: 'verifier-fixture',
        displayName: 'Verifier',
        summary: 'Fixture direct-runtime verifier Procedure.',
        productType: 'procedure',
        procedure: {
          id: 'org.openadam.example.verifier',
          version: '1.4.2',
          permissions: ['model.invoke', 'network.read'],
          resources: [],
          inputSchemaPath: join(componentFiles, 'input.schema.json'),
          outputSchemaPath: join(componentFiles, 'output.schema.json'),
        },
        procedureExecution: { kind: 'direct-runtime', providerId: 'org.openadam.fixture.verifier-provider' },
      },
    },
    hosts: {},
    runtime: { socketPath: join(stateRoot, 'runtime', 'fixture-socket') },
    observability: {},
  })
  return { stateRoot, orderLog }
}

// The packaged composition delegates its workspace to the child Procedure; a
// direct-runtime child cannot receive resource bindings, so the fixture keeps
// the exact child identity without the delegation.
async function fixtureCompositionProject(root, workspace) {
  const projectRoot = join(root, 'project')
  await cp(new URL('workspace-composition/', examples), projectRoot, { recursive: true })
  const method = JSON.parse(await readFile(join(projectRoot, 'method.json'), 'utf8'))
  const verify = method.graph.nodes.find((node) => node.id === 'verify')
  verify.resourceBindings = {}
  await writeFile(join(projectRoot, 'method.json'), `${JSON.stringify(method, null, 2)}\n`)
  const scenario = JSON.parse(await readFile(join(projectRoot, 'scenarios', 'composition.json'), 'utf8'))
  scenario.resources.workspace.path = workspace
  await writeFile(join(projectRoot, 'scenarios', 'composition.json'), `${JSON.stringify(scenario, null, 2)}\n`)
  return projectRoot
}

async function request(studio, path, method = 'GET', value = undefined) {
  const response = await fetch(`${studio.origin}${path}`, {
    method,
    headers: {
      'x-procedure-studio-token': studio.token,
      ...(value === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  })
  return { status: response.status, body: await response.json() }
}

async function waitForRun(studio, runId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let run = null
  while (Date.now() < deadline) {
    const current = await request(studio, `/api/runs/${runId}`)
    run = current.body.run
    if (['complete', 'failed', 'cancelled', 'waiting_user', 'paused'].includes(run.status)) return run
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`Run did not reach a stopped state: ${JSON.stringify({ status: run?.status, phase: run?.phase, problem: run?.problem })}`)
}

test('a Capability and subprocedure composition runs from the Studio service entry through the installed environment', async (t) => {
  const root = await temporaryRoot(t)
  const { stateRoot: environmentRoot, orderLog } = await fixtureEnvironment(root)
  const projectRoot = await fixtureCompositionProject(root, await gitWorkspace(root))
  const stateRoot = join(root, 'studio-state')
  const project = await StudioProject.open(projectRoot, stateRoot)
  assert.equal(project.validation.valid, true)

  const studio = await serveStudio({
    project,
    stateRoot,
    port: 0,
    environmentRoot,
    coordinatorOptions: { adapterFactory: adapter([
      report({ draft: 'environment-composed draft' }),
      report({ final: 'Composition verified through the installed environment.' }),
    ]) },
  })
  try {
    const state = await request(studio, '/api/project')
    assert.equal(state.status, 200)
    assert.deepEqual(state.body.environment, { root: environmentRoot, available: true, procedures: 1, problem: null })

    const started = await request(studio, '/api/runs', 'POST', { scenarioId: 'workspace-composition' })
    assert.equal(started.status, 201)
    const completed = await waitForRun(studio, started.body.run.id)
    assert.equal(completed.status, 'complete')
    assert.equal(completed.outputs.final.value, 'Composition verified through the installed environment.')

    const orders = (await readFile(orderLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(orders.length, 2)
    assert.deepEqual(orders[0].target, {
      kind: 'capability',
      capabilityId: 'text.normalize',
      capabilityVersion: '1.0.0',
      operationId: 'normalize',
    })
    assert.equal(orders[0].providerId, 'org.openadam.text-integrity')
    assert.deepEqual(orders[1].target, {
      kind: 'procedure',
      procedureId: 'org.openadam.example.verifier',
      procedureVersion: '1.4.2',
    })
    assert.equal(orders[1].providerId, 'org.openadam.fixture.verifier-provider')
    assert.deepEqual(orders[1].input.candidate, { normalized: true, seenBy: 'fixture-direct-runtime' })
    assert.equal(completed.outputs.verified.value.checkedBy, 'installed-environment')
  } finally {
    await studio.close()
  }
})

test('Test Runs that need Capability or subprocedure execution explain a missing environment before starting', async (t) => {
  const root = await temporaryRoot(t)
  const projectRoot = await fixtureCompositionProject(root, await gitWorkspace(root))
  const stateRoot = join(root, 'studio-state')
  const project = await StudioProject.open(projectRoot, stateRoot)
  const studio = await serveStudio({
    project,
    stateRoot,
    port: 0,
    environmentRoot: join(root, 'absent-environment'),
    coordinatorOptions: { adapterFactory: adapter([report({ draft: 'unused' })]) },
  })
  try {
    const state = await request(studio, '/api/project')
    assert.equal(state.body.environment.available, false)

    const started = await request(studio, '/api/runs', 'POST', { scenarioId: 'workspace-composition' })
    assert.equal(started.status, 400)
    assert.equal(started.body.error.code, 'STUDIO_EXECUTION_ENVIRONMENT_UNAVAILABLE')
    assert.deepEqual(started.body.error.details, { environmentRoot: join(root, 'absent-environment'), problem: 'not-installed' })
    assert.equal((await request(studio, '/api/runs')).body.runs.length, 0)
  } finally {
    await studio.close()
  }
})

test('a Procedure without Capability or subprocedure nodes still runs when the environment is unavailable', async (t) => {
  const root = await temporaryRoot(t)
  const projectRoot = join(root, 'project')
  await cp(new URL('research-brief/', examples), projectRoot, { recursive: true })
  const stateRoot = join(root, 'studio-state')
  const project = await StudioProject.open(projectRoot, stateRoot)
  assert.equal(project.validation.valid, true)
  const studio = await serveStudio({
    project,
    stateRoot,
    port: 0,
    environmentRoot: join(root, 'absent-environment'),
    coordinatorOptions: { adapterFactory: adapter([
      JSON.stringify({
        outcome: 'complete',
        summary: 'Collected fixture sources',
        plan: 'Return declared outputs',
        findings: [],
        checks: [],
        resolvedFindingIds: [],
        acknowledgedDecisionIds: [],
        outputs: { 'source-notes': { sources: ['fixture'], revision: 1 } },
      }),
      JSON.stringify({
        outcome: 'complete',
        summary: 'Verified fixture coverage',
        plan: 'Return declared facts',
        findings: [],
        checks: [],
        resolvedFindingIds: [],
        acknowledgedDecisionIds: [],
        facts: { coverage: 'sufficient' },
      }),
      report({ brief: 'A brief that needed no execution environment.' }),
    ]) },
  })
  try {
    const started = await request(studio, '/api/runs', 'POST', { scenarioId: 'covered-topic' })
    assert.equal(started.status, 201)
    const completed = await waitForRun(studio, started.body.run.id)
    assert.equal(completed.status, 'complete')
    assert.equal(completed.outputs.brief.value, 'A brief that needed no execution environment.')
  } finally {
    await studio.close()
  }
})
