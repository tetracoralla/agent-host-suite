import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { importLocalComponent } from '../../../src/local-components.mjs'
import { continueProcedureRun, invokeInstalledProcedure, listInstalledProcedures } from '../../../src/procedure-products.mjs'
import { setup } from '../../../src/setup.mjs'
import { compatibleApplicationState, createCodexRunner, healthyCatalogPreflight } from '../../../test/helpers.mjs'
import { createReleaseFixture } from '../../../test/release-helpers.mjs'
import { packageProject } from '../src/packager.mjs'
import { StudioProject } from '../src/project.mjs'
import { StudioRuntime } from '../src/runtime.mjs'
import { serveStudio } from '../src/server.mjs'

const examples = new URL('../examples/', import.meta.url)

async function fixture(t, name = 'research-brief') {
  const root = await mkdtemp(join(tmpdir(), 'procedure-studio-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectRoot = join(root, 'project')
  const stateRoot = join(root, 'studio-state')
  await cp(new URL(`${name}/`, examples), projectRoot, { recursive: true })
  return { root, projectRoot, stateRoot, project: await StudioProject.open(projectRoot, stateRoot) }
}

async function wait(runtime, runId, status, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  let current = null
  while (Date.now() < deadline) {
    current = runtime.get(runId)
    if (current.status === status) return current
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`Run ${runId} did not reach ${status}: ${JSON.stringify({ status: current?.status, phase: current?.phase, problem: current?.problem })}`)
}

test('canonical graph, source draft, save, reload, and external-change recovery remain one model', async (t) => {
  const { projectRoot, stateRoot, project } = await fixture(t)
  assert.equal(project.validation.valid, true)
  const original = project.publicState()
  const document = structuredClone(original.document)
  document.method.graph.nodes.find((node) => node.id === 'clarify').prompt = 'Name the one audience constraint to preserve.'
  const draft = await project.update({ expectedRevision: original.revision, document })
  assert.equal(draft.source.saved, false)
  assert.equal((await StudioProject.open(projectRoot, stateRoot)).document.method.graph.nodes.find((node) => node.id === 'clarify').prompt, 'Name the one audience constraint to preserve.')
  const saved = await project.save(draft.revision)
  assert.equal(saved.source.saved, true)
  const bytes = JSON.parse(await readFile(join(projectRoot, 'method.json'), 'utf8'))
  assert.equal(bytes.graph.nodes.find((node) => node.id === 'clarify').prompt, 'Name the one audience constraint to preserve.')

  const invalid = structuredClone(saved.document)
  invalid.method.graph.nodes[0].unknownStudioField = true
  const invalidState = await project.update({ expectedRevision: saved.revision, document: invalid })
  assert.equal(invalidState.validation.valid, false)
  assert.deepEqual(invalidState.validation.diagnostics.map((item) => item.code), ['SCHEMA_UNEVALUATEDPROPERTIES'])
  assert.match(invalidState.validation.diagnostics[0].message, /unknownStudioField/u)
  await assert.rejects(project.save(invalidState.revision), (error) => error.code === 'STUDIO_VALIDATION_FAILED')

  const validDraft = structuredClone(saved.document)
  validDraft.method.graph.nodes.find((node) => node.id === 'clarify').prompt = 'Preserve this private draft while reconciling.'
  const recoveredPresentation = structuredClone(invalidState.presentation)
  recoveredPresentation.selection = ['clarify']
  const restored = await project.update({ expectedRevision: invalidState.revision, document: validDraft, presentation: recoveredPresentation })
  assert.equal(restored.validation.valid, true)

  const external = bytes
  external.description = 'Changed outside Studio.'
  await writeFile(join(projectRoot, 'method.json'), `${JSON.stringify(external, null, 2)}\n`)
  const conflicted = await StudioProject.open(projectRoot, stateRoot)
  assert.equal(conflicted.sourceConflict, true)
  await assert.rejects(conflicted.save(conflicted.revision), (error) => error.code === 'STUDIO_SOURCE_CONFLICT')
  const reconciled = await conflicted.reconcile(conflicted.revision)
  assert.equal(reconciled.source.conflict, false)
  assert.deepEqual(reconciled.presentation.selection, [])
  assert.equal(reconciled.document.method.description, 'Changed outside Studio.')
  assert.equal(reconciled.proposal.source, 'recovered-draft')
  const recoveredNode = reconciled.proposal.changes.find((change) => change.kind === 'node-update' && change.affectedNodeIds.includes('clarify'))
  assert.ok(recoveredNode)
  const merged = await conflicted.decideProposal(reconciled.revision, { accept: [recoveredNode.id], reject: [] })
  assert.equal(merged.document.method.description, 'Changed outside Studio.')
  assert.equal(merged.document.method.graph.nodes.find((node) => node.id === 'clarify').prompt, 'Preserve this private draft while reconciling.')
})

test('Agent source proposals expose semantic units and apply only accepted changes', async (t) => {
  const { project } = await fixture(t)
  const current = project.publicState()
  const candidate = structuredClone(current.document)
  candidate.integration.procedure.version = '1.1.0'
  candidate.method.revision = 2
  candidate.method.graph.nodes.find((node) => node.id === 'compose').name = 'Assemble final brief'
  const proposed = await project.loadProposal(current.revision, candidate)
  const version = proposed.proposal.changes.find((change) => change.kind === 'procedure-version')
  const node = proposed.proposal.changes.find((change) => change.kind === 'node-update')
  assert.ok(version)
  assert.ok(node)
  const decided = await project.decideProposal(proposed.revision, { accept: [version.id], reject: [node.id] })
  assert.equal(decided.document.integration.procedure.version, '1.1.0')
  assert.equal(decided.document.method.graph.nodes.find((item) => item.id === 'compose').name, 'Compose declared output')
  assert.equal(decided.proposalDecisions[version.id], 'accepted')
  assert.equal(decided.proposalDecisions[node.id], 'rejected')
})

test('Test Runs execute the real Coordinator, wait for human input, continue, cancel, and replay safely', async (t) => {
  const { stateRoot, project } = await fixture(t)
  const runtime = await StudioRuntime.open(join(stateRoot, 'runs'), project)
  try {
    const started = await runtime.start('needs-clarification')
    const waiting = await wait(runtime, started.id, 'waiting_user')
    assert.equal(waiting.question.node, 'clarify')
    runtime.action(waiting.id, { action: 'answer', questionId: waiting.question.id, value: 'Keep the brief useful to local-first tool developers.' })
    const completed = await wait(runtime, waiting.id, 'complete')
    assert.equal(completed.outputs.brief.value, 'Keep the brief useful to local-first tool developers.')

    const replayed = await runtime.replay(completed.id, 'compose')
    const replayComplete = await wait(runtime, replayed.id, 'complete')
    assert.equal(replayComplete.replayOf.taskId, completed.id)
    assert.equal(replayComplete.outputs.brief.value, completed.outputs.brief.value)
    assert.equal(runtime.get(completed.id).status, 'complete')

    const second = await runtime.start('needs-clarification')
    const secondWaiting = await wait(runtime, second.id, 'waiting_user')
    runtime.action(secondWaiting.id, { action: 'cancel' })
    assert.equal((await wait(runtime, second.id, 'cancelled')).question, null)

    const deterministic = await runtime.start('covered-topic')
    assert.equal((await wait(runtime, deterministic.id, 'complete')).outputs.brief.value, 'A concise brief for local-first Procedure developers')
  } finally {
    await runtime.close()
  }
})

function agentReport(outputs) {
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

test('failed workspace composition resumes through real Coordinator nodes and preserves replay evidence', async (t) => {
  const { root, stateRoot, project } = await fixture(t, 'workspace-composition')
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  execFileSync('git', ['init', '-q', workspace])
  execFileSync('git', ['-C', workspace, 'config', 'user.name', 'Procedure Studio Fixture'])
  execFileSync('git', ['-C', workspace, 'config', 'user.email', 'fixture@example.invalid'])
  await writeFile(join(workspace, 'README.md'), '# Fixture\n')
  execFileSync('git', ['-C', workspace, 'add', 'README.md'])
  execFileSync('git', ['-C', workspace, 'commit', '-qm', 'fixture baseline'])
  project.scenarios[0].resources.workspace.path = workspace

  const reports = [
    agentReport({ draft: 'bounded draft' }),
    agentReport({ final: 'recovered composition' }),
    agentReport({ final: 'replayed composition' }),
  ]
  let session = 0
  let directCalls = 0
  const runtime = await StudioRuntime.open(join(stateRoot, 'runs'), project, {
    adapterFactory(binding) {
      return {
        async initialize() { return { steer: 'unsupported', interrupt: 'supported' } },
        async session(existing) { return { provider: binding.provider, id: existing ?? `studio-fixture-${session++}`, model: 'fixture-only' } },
        async start() { return { status: 'complete', text: reports.shift() } },
        async close() {},
      }
    },
    async executeDirectCall() {
      directCalls += 1
      if (directCalls === 1) {
        const error = new Error('Fixture Capability was temporarily unavailable')
        error.code = 'FIXTURE_CAPABILITY_UNAVAILABLE'
        throw error
      }
      return { value: { normalized: true } }
    },
    async executeProcedureCall() {
      return { verdict: { approved: true } }
    },
  })
  try {
    const started = await runtime.start('workspace-composition')
    const failed = await wait(runtime, started.id, 'failed')
    assert.equal(failed.problem.code, 'FIXTURE_CAPABILITY_UNAVAILABLE')
    assert.equal(failed.request.bindings.author.provider, 'codex')
    assert.equal(failed.nodes.find((node) => node.id === 'normalize').state, 'failed')

    runtime.action(failed.id, { action: 'resume' })
    const recovered = await wait(runtime, failed.id, 'complete')
    assert.equal(recovered.outputs.final.value, 'recovered composition')
    assert.deepEqual(recovered.attempts.filter((attempt) => attempt.stage === 'normalize').map((attempt) => attempt.status), ['failed', 'complete'])

    const replayed = await runtime.replay(recovered.id, 'normalize')
    const replayComplete = await wait(runtime, replayed.id, 'complete')
    assert.equal(replayComplete.outputs.final.value, 'replayed composition')
    assert.equal(replayComplete.replayOf.taskId, recovered.id)
    assert.equal(runtime.get(recovered.id).attempts.some((attempt) => attempt.error?.code === 'FIXTURE_CAPABILITY_UNAVAILABLE'), true)
  } finally {
    await runtime.close()
  }
})

test('a structurally different workspace composition validates without being mistaken for the research fixture', async (t) => {
  const { project } = await fixture(t, 'workspace-composition')
  assert.equal(project.validation.valid, true)
  assert.deepEqual(new Set(project.document.method.graph.nodes.map((node) => node.kind)), new Set(['agent-turn', 'direct-call', 'procedure-call']))
  const subprocedure = project.document.method.graph.nodes.find((node) => node.kind === 'procedure-call')
  assert.deepEqual(subprocedure.procedure, { id: 'org.openadam.example.verifier', version: '1.4.2' })
  assert.deepEqual(subprocedure.grants, ['network.read'])
  assert.deepEqual(subprocedure.resourceBindings, { workspace: 'workspace' })
})

test('a captured Run request saves as a new project Test scenario and runs', async (t) => {
  const { projectRoot, stateRoot, project } = await fixture(t)
  const limits = structuredClone(project.scenarios.find((item) => item.id === 'covered-topic').limits)
  const saved = await project.saveScenario(project.revision, {
    name: 'Rushed Coverage',
    description: 'Captured from a completed review Run.',
    inputs: { topic: 'scenario capture', coverage_complete: true },
    grants: [],
    resources: {},
    limits,
    bindings: {},
  })
  const scenario = saved.scenarios.find((item) => item.id === 'rushed-coverage')
  assert.ok(scenario)
  const persisted = JSON.parse(await readFile(join(projectRoot, 'scenarios', 'rushed-coverage.json'), 'utf8'))
  assert.equal(persisted.schemaVersion, 'openadam.procedure-studio-scenario.v0.1')
  assert.equal(persisted.inputs.coverage_complete, true)
  const config = JSON.parse(await readFile(join(projectRoot, 'studio.project.json'), 'utf8'))
  assert.ok(config.scenarios.includes('scenarios/rushed-coverage.json'))
  const sourceSaved = await project.save(saved.revision)
  assert.equal(sourceSaved.source.conflict, false)
  assert.equal(sourceSaved.source.saved, true)

  const reopened = await StudioProject.open(projectRoot, stateRoot)
  assert.deepEqual(new Set(reopened.scenarios.map((item) => item.id)), new Set(['covered-topic', 'needs-clarification', 'rushed-coverage']))
  const runtime = await StudioRuntime.open(join(stateRoot, 'runs'), reopened)
  try {
    const started = await runtime.start('rushed-coverage')
    assert.equal((await wait(runtime, started.id, 'complete')).outputs.brief.value, 'scenario capture')
    const list = runtime.list()
    assert.equal(list.length, 1)
  } finally {
    await runtime.close()
  }

  await assert.rejects(
    reopened.saveScenario(reopened.revision, { name: 'Rushed Coverage', inputs: {} }),
    (error) => error.code === 'STUDIO_SCENARIO_EXISTS',
  )
})

test('creating a scenario refuses to overwrite an externally changed project manifest', async (t) => {
  const { projectRoot, project } = await fixture(t)
  const configPath = join(projectRoot, 'studio.project.json')
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  config.author = 'External editor'
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
  const source = project.scenarios[0]
  await assert.rejects(
    project.saveScenario(project.revision, { ...source, name: 'Must Not Overwrite Manifest' }),
    (error) => error.code === 'STUDIO_SOURCE_CONFLICT',
  )
  const after = JSON.parse(await readFile(configPath, 'utf8'))
  assert.equal(after.author, 'External editor')
  await assert.rejects(readFile(join(projectRoot, 'scenarios', 'must-not-overwrite-manifest.json')), (error) => error.code === 'ENOENT')
})

test('saved Test scenarios remain editable with stable identity and external-change protection', async (t) => {
  const { projectRoot, project } = await fixture(t)
  const current = project.publicState()
  const candidate = structuredClone(current.scenarios.find((item) => item.id === 'covered-topic'))
  candidate.name = 'Coverage with edited input'
  candidate.inputs.topic = 'An edited reusable scenario'
  candidate.limits.maxNodeExecutions = 18
  const updated = await project.updateScenario(current.revision, candidate.id, candidate)
  assert.equal(updated.scenarios.find((item) => item.id === candidate.id).inputs.topic, 'An edited reusable scenario')
  const persisted = JSON.parse(await readFile(join(projectRoot, 'scenarios', 'covered-topic.json'), 'utf8'))
  assert.equal(persisted.name, 'Coverage with edited input')
  assert.equal(persisted.limits.maxNodeExecutions, 18)

  const renamed = structuredClone(candidate)
  renamed.id = 'renamed-scenario'
  await assert.rejects(
    project.updateScenario(updated.revision, candidate.id, renamed),
    (error) => error.code === 'STUDIO_SCENARIO_ID_IMMUTABLE',
  )

  const external = structuredClone(candidate)
  external.description = 'Changed outside Studio.'
  await writeFile(join(projectRoot, 'scenarios', 'covered-topic.json'), `${JSON.stringify(external, null, 2)}\n`)
  await assert.rejects(
    project.updateScenario(updated.revision, candidate.id, candidate),
    (error) => error.code === 'STUDIO_SCENARIO_CONFLICT',
  )
  const reloaded = await project.reloadScenarios(updated.revision)
  assert.equal(reloaded.scenarios.find((item) => item.id === candidate.id).description, 'Changed outside Studio.')
  const afterReload = structuredClone(reloaded.scenarios.find((item) => item.id === candidate.id))
  afterReload.inputs.topic = 'Edited after external recovery'
  const recovered = await project.updateScenario(reloaded.revision, candidate.id, afterReload)
  assert.equal(recovered.scenarios.find((item) => item.id === candidate.id).inputs.topic, 'Edited after external recovery')
})

test('loopback Studio server requires its private token and same-origin mutation path', async (t) => {
  const { stateRoot, project } = await fixture(t)
  const studio = await serveStudio({ project, stateRoot, port: 0 })
  try {
    const unauthorized = await fetch(`${studio.origin}/api/project`)
    assert.equal(unauthorized.status, 401)
    assert.equal((await unauthorized.json()).error.code, 'STUDIO_UNAUTHORIZED')

    const authorized = await fetch(`${studio.origin}/api/project`, {
      headers: { 'x-procedure-studio-token': studio.token },
    })
    assert.equal(authorized.status, 200)
    assert.equal((await authorized.json()).state.validation.valid, true)

    const stateResponse = await fetch(`${studio.origin}/api/project`, {
      headers: { 'x-procedure-studio-token': studio.token },
    })
    const state = (await stateResponse.json()).state

    const scenario = structuredClone(state.scenarios.find((item) => item.id === 'covered-topic'))
    scenario.inputs.topic = 'Updated through the private route'
    const scenarioUpdated = await fetch(`${studio.origin}/api/project/scenario/covered-topic`, {
      method: 'PUT',
      headers: { 'x-procedure-studio-token': studio.token, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: state.revision, candidate: scenario }),
    })
    assert.equal(scenarioUpdated.status, 200)
    const updatedState = (await scenarioUpdated.json()).state
    assert.equal(updatedState.scenarios.find((item) => item.id === 'covered-topic').inputs.topic, 'Updated through the private route')
    const scenariosReloaded = await fetch(`${studio.origin}/api/project/scenarios/reload`, {
      method: 'POST',
      headers: { 'x-procedure-studio-token': studio.token, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: updatedState.revision }),
    })
    assert.equal(scenariosReloaded.status, 200)
    const reloadedState = (await scenariosReloaded.json()).state

    const crossed = await fetch(`${studio.origin}/api/project`, {
      headers: {
        'x-procedure-studio-token': studio.token,
        origin: 'https://outside.example.invalid',
      },
    })
    assert.equal(crossed.status, 400)
    assert.equal((await crossed.json()).error.code, 'STUDIO_INVALID_ORIGIN')

    const wrongContent = await fetch(`${studio.origin}/api/project/save`, {
      method: 'POST',
      headers: { 'x-procedure-studio-token': studio.token, 'content-type': 'text/plain' },
      body: '{}',
    })
    assert.equal(wrongContent.status, 400)
    assert.equal((await wrongContent.json()).error.code, 'STUDIO_INVALID_CONTENT_TYPE')

    const scenarioSaved = await fetch(`${studio.origin}/api/project/scenario`, {
      method: 'POST',
      headers: { 'x-procedure-studio-token': studio.token, 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: reloadedState.revision,
        name: 'Route Scenario',
        inputs: { topic: 'route capture', coverage_complete: true },
        grants: [],
        resources: {},
        limits: state.scenarios[0].limits,
        bindings: {},
      }),
    })
    assert.equal(scenarioSaved.status, 201)
    assert.ok((await scenarioSaved.json()).state.scenarios.some((item) => item.id === 'route-scenario'))

    const shell = await fetch(studio.url)
    assert.equal(shell.status, 200)
    assert.match(shell.headers.get('content-security-policy'), /frame-ancestors 'none'/u)
    assert.match(await shell.text(), new RegExp(studio.token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  } finally {
    await studio.close()
  }
})

async function healthyComponentWarmup({ manifest, componentIds }) {
  return { status: 'ok', strategy: 'sequential-first-and-repeat', components: componentIds.map((id) => ({ id, version: manifest.components[id].version })) }
}

test('Studio package passes preview, isolated Host import/discovery, invocation, and continuation', async (t) => {
  const { root, project } = await fixture(t)
  const packaged = await packageProject(project)
  assert.equal(packaged.preview.health.status, 'ok')
  assert.equal(packaged.effects.formalAgentHostStateChanged, false)

  const releaseManifest = await createReleaseFixture(join(root, 'host-release'), {
    suiteVersion: '0.1.1-studio-test',
    releaseId: 'procedure-studio-isolated-host',
    marker: 'studio',
  })
  const hostStateRoot = join(root, 'isolated-host-state')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathMarketplace: 'openadam', mathVersion: '0.4.0' })
  const hostSkillHome = join(root, 'host-home')
  await setup({
    profile: 'standard', hosts: ['codex'], releaseManifest, stateRoot: hostStateRoot,
    noService: true, dryRun: false, enableObservability: false,
  }, {
    runner: fake.runner,
    codexConfiguration: fake.configuration,
    hostSkillHome,
    componentWarmup: healthyComponentWarmup,
    catalogPreflight: healthyCatalogPreflight,
    applicationStatePreflight: compatibleApplicationState,
  })
  const lifecycleDependencies = {
    runner: fake.runner,
    codexConfiguration: fake.configuration,
    hostSkillHome,
    componentWarmup: healthyComponentWarmup,
    catalogPreflight: healthyCatalogPreflight,
    applicationStatePreflight: compatibleApplicationState,
  }
  const imported = await importLocalComponent({
    stateRoot: hostStateRoot,
    artifact: packaged.artifact.path,
    binding: packaged.preview.binding,
    activate: false,
  }, lifecycleDependencies)
  assert.equal(imported.status, 'imported')
  const discovered = await listInstalledProcedures({ stateRoot: hostStateRoot })
  assert.deepEqual(discovered.procedures.map((item) => [item.id, item.version]), [['org.openadam.example.research-brief', '1.0.0']])

  const request = {
    schemaVersion: 'openadam.agent-host-procedure-run-request.v0.1',
    procedure: { id: 'org.openadam.example.research-brief', version: '1.0.0' },
    inputs: { topic: 'Host-chain verification', coverage_complete: false },
    grants: [],
    resources: {},
    limits: {
      maxDurationMs: 60_000,
      maxNodeExecutions: 12,
      maxAgentTurns: 0,
      nodeTimeoutMs: 10_000,
      maxAttemptsPerNode: 4,
      maxOutputBytes: 65_536,
    },
    idempotencyKey: 'studio-isolated-host-e2e',
  }
  const invoked = await invokeInstalledProcedure({ stateRoot: hostStateRoot, request })
  assert.equal(invoked.status, 'waiting_user')
  assert.equal(invoked.interaction.node, 'clarify')
  const continued = await continueProcedureRun({
    stateRoot: hostStateRoot,
    run: invoked.taskId,
    input: { action: 'answer', value: 'Verified through the isolated Host chain.' },
  })
  assert.equal(continued.status, 'complete')
  assert.deepEqual(continued.outputs, { brief: 'Verified through the isolated Host chain.' })
})
