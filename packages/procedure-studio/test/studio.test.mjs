import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { importLocalComponent } from '../../../src/local-components.mjs'
import { continueProcedureRun, invokeInstalledProcedure, listInstalledProcedures } from '../../../src/procedure-products.mjs'
import { loadState, readStatePaths } from '../../../src/state.mjs'
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
  document.method.graph.nodes.find((node) => node.id === 'collect').instruction = 'Name the one audience constraint to preserve.'
  const draft = await project.update({ expectedRevision: original.revision, document })
  assert.equal(draft.source.saved, false)
  assert.equal((await StudioProject.open(projectRoot, stateRoot)).document.method.graph.nodes.find((node) => node.id === 'collect').instruction, 'Name the one audience constraint to preserve.')
  const saved = await project.save(draft.revision)
  assert.equal(saved.source.saved, true)
  const bytes = JSON.parse(await readFile(join(projectRoot, 'method.json'), 'utf8'))
  assert.equal(bytes.graph.nodes.find((node) => node.id === 'collect').instruction, 'Name the one audience constraint to preserve.')

  const invalid = structuredClone(saved.document)
  invalid.method.graph.nodes[0].unknownStudioField = true
  const invalidState = await project.update({ expectedRevision: saved.revision, document: invalid })
  assert.equal(invalidState.validation.valid, false)
  assert.deepEqual(invalidState.validation.diagnostics.map((item) => item.code), ['SCHEMA_UNEVALUATEDPROPERTIES'])
  assert.match(invalidState.validation.diagnostics[0].message, /unknownStudioField/u)
  await assert.rejects(project.save(invalidState.revision), (error) => error.code === 'STUDIO_VALIDATION_FAILED')

  const validDraft = structuredClone(saved.document)
  validDraft.method.graph.nodes.find((node) => node.id === 'collect').instruction = 'Preserve this private draft while reconciling.'
  const recoveredPresentation = structuredClone(invalidState.presentation)
  recoveredPresentation.selection = ['collect']
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
  const recoveredNode = reconciled.proposal.changes.find((change) => change.kind === 'node-update' && change.affectedNodeIds.includes('collect'))
  assert.ok(recoveredNode)
  const merged = await conflicted.decideProposal(reconciled.revision, { accept: [recoveredNode.id], reject: [] })
  assert.equal(merged.document.method.description, 'Changed outside Studio.')
  assert.equal(merged.document.method.graph.nodes.find((node) => node.id === 'collect').instruction, 'Preserve this private draft while reconciling.')
})

test('Agent source proposals expose semantic units and apply only accepted changes', async (t) => {
  const { project } = await fixture(t)
  const current = project.publicState()
  const candidate = structuredClone(current.document)
  candidate.integration.procedure.version = '1.1.0'
  candidate.method.revision = 2
  candidate.method.graph.nodes.find((node) => node.id === 'write').name = 'Assemble final brief'
  const proposed = await project.loadProposal(current.revision, candidate)
  const version = proposed.proposal.changes.find((change) => change.kind === 'procedure-version')
  const node = proposed.proposal.changes.find((change) => change.kind === 'node-update')
  assert.ok(version)
  assert.ok(node)
  const decided = await project.decideProposal(proposed.revision, { accept: [version.id], reject: [node.id] })
  assert.equal(decided.document.integration.procedure.version, '1.1.0')
  assert.equal(decided.document.method.graph.nodes.find((item) => item.id === 'write').name, '形成简报')
  assert.equal(decided.proposalDecisions[version.id], 'accepted')
  assert.equal(decided.proposalDecisions[node.id], 'rejected')
})

function researchReport(extra) {
  return JSON.stringify({
    outcome: 'complete',
    summary: 'Completed the Research Brief fixture step',
    plan: 'Return the declared stage result',
    findings: [],
    checks: [],
    resolvedFindingIds: [],
    acknowledgedDecisionIds: [],
    ...extra,
  })
}

function researchAdapter(reports) {
  return (binding) => ({
    async initialize() { return { steer: 'unsupported', interrupt: 'supported' } },
    async session(existing) { return { provider: binding.provider, id: existing ?? randomUUID(), model: 'fixture-only' } },
    async start() { return { status: 'complete', text: reports.shift() } },
    async interrupt() {},
    async close() {},
  })
}

function successfulBriefReports(brief) {
  return [
    researchReport({ outputs: { 'source-notes': { sources: ['fixture'], revision: 1 } } }),
    researchReport({ facts: { coverage: 'sufficient' } }),
    researchReport({ outputs: { brief } }),
  ]
}

test('Test Runs execute the real Coordinator, wait for an Agent question, continue, cancel, recover, and replay safely', async (t) => {
  const { stateRoot, project } = await fixture(t)
  const reports = [
    researchReport({ outcome: 'needs_user', question: 'Which audience constraint should the brief preserve?' }),
    ...successfulBriefReports('A checked brief for Procedure developers.'),
    researchReport({ outputs: { brief: 'A checked brief for Procedure developers.' } }),
    researchReport({ outcome: 'needs_user', question: 'Cancel this clarification?' }),
    researchReport({ outcome: 'failed', summary: 'The first research pass could not read its sources.' }),
    ...successfulBriefReports('Recovered brief after the reported failure.'),
    researchReport({ outputs: { 'source-notes': { sources: ['first'], revision: 1 } } }),
    researchReport({ facts: { coverage: 'insufficient' } }),
    researchReport({ outputs: { 'source-notes': { sources: ['first', 'counterexample'], revision: 2 } } }),
    researchReport({ facts: { coverage: 'sufficient' } }),
    researchReport({ outputs: { brief: 'Brief after one coverage rework.' } }),
  ]
  const runtime = await StudioRuntime.open(join(stateRoot, 'runs'), project, {
    adapterFactory: researchAdapter(reports),
  })
  try {
    const started = await runtime.start('needs-clarification')
    const waiting = await wait(runtime, started.id, 'waiting_user')
    assert.equal(waiting.question.kind, 'agent-question')
    assert.equal(waiting.phase, 'collect')
    runtime.action(waiting.id, { action: 'answer', questionId: waiting.question.id, value: 'Keep the brief useful to local-first tool developers.' })
    const completed = await wait(runtime, waiting.id, 'complete')
    assert.equal(completed.outputs.brief.value, 'A checked brief for Procedure developers.')
    assert.deepEqual(completed.attempts.map((attempt) => attempt.stage), ['collect', 'collect', 'verify', 'write'])

    const replayed = await runtime.replay(completed.id, 'write')
    const replayComplete = await wait(runtime, replayed.id, 'complete')
    assert.equal(replayComplete.replayOf.taskId, completed.id)
    assert.equal(replayComplete.outputs.brief.value, completed.outputs.brief.value)
    assert.equal(runtime.get(completed.id).status, 'complete')

    const second = await runtime.start('needs-clarification')
    const secondWaiting = await wait(runtime, second.id, 'waiting_user')
    runtime.action(secondWaiting.id, { action: 'cancel' })
    assert.equal((await wait(runtime, second.id, 'cancelled')).question, null)

    const failed = await runtime.start('covered-topic')
    const stopped = await wait(runtime, failed.id, 'failed')
    assert.equal(stopped.problem.code, 'AGENT_REPORTED_FAILURE')
    runtime.action(stopped.id, { action: 'resume' })
    const recovered = await wait(runtime, failed.id, 'complete')
    assert.equal(recovered.outputs.brief.value, 'Recovered brief after the reported failure.')

    const reworked = await runtime.start('coverage-rework')
    const reworkComplete = await wait(runtime, reworked.id, 'complete')
    assert.equal(reworkComplete.outputs.brief.value, 'Brief after one coverage rework.')
    assert.deepEqual(reworkComplete.attempts.map((attempt) => attempt.stage), ['collect', 'verify', 'collect', 'verify', 'write'])
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

test('a provider permission request waits inside one Studio session and continues after approval', async (t) => {
  const { stateRoot, project } = await fixture(t)
  const report = (extra) => JSON.stringify({
    outcome: 'complete',
    summary: 'Completed the bounded Studio fixture step',
    plan: 'Return declared outputs',
    findings: [],
    checks: [],
    resolvedFindingIds: [],
    acknowledgedDecisionIds: [],
    ...extra,
  })
  const queues = new Map([
    ['collect', [
      { permission: 'read-workspace-note', outputs: { 'source-notes': { sources: ['fixture'] } } },
    ]],
    ['verify', [{ facts: { coverage: 'sufficient' } }]],
    ['write', [{ outputs: { brief: 'Brief after the approved provider permission.' } }]],
  ])
  const routes = [
    ['collect', '围绕问题收集可追溯材料'],
    ['verify', '独立核对来源、关键反例与不确定性'],
    ['write', '把已核对材料组织为面向目标读者的简洁结论'],
  ]
  const runtime = await StudioRuntime.open(join(stateRoot, 'runs'), project, {
    adapterFactory(binding, options) {
      const worker = { resolved: null, rejected: null }
      return {
        async initialize() { return { steer: 'unsupported', interrupt: 'supported' } },
        async session(existing) { return { provider: binding.provider, id: existing ?? randomUUID(), model: 'fixture' } },
        async start(prompt) {
          const key = routes.find(([, marker]) => String(prompt).includes(marker))?.[0] ?? 'unknown'
          const behavior = (queues.get(key) ?? []).shift() ?? {}
          if (behavior.permission !== undefined) {
            await new Promise((resolve, reject) => {
              worker.resolved = resolve
              worker.rejected = reject
              options.onPermission({ id: behavior.permission, method: 'fixture/read-note', native: {} })
            })
          }
          return { status: 'complete', text: report(behavior.outputs ? { outputs: behavior.outputs } : {}) }
        },
        respond() { worker.resolved?.(true); worker.resolved = null },
        async interrupt() { worker.rejected?.(new Error('provider turn interrupted')); worker.rejected = null },
        async close() {},
      }
    },
  })
  try {
    const started = await runtime.start('covered-topic')
    const waiting = await wait(runtime, started.id, 'waiting_user')
    assert.equal(waiting.interaction ?? null, null)
    assert.deepEqual(waiting.permissions.filter((permission) => permission.status === 'pending').map((permission) => permission.id), ['read-workspace-note'])
    runtime.action(waiting.id, { action: 'permission', permissionId: 'read-workspace-note', allow: true })
    const completed = await wait(runtime, waiting.id, 'complete')
    assert.equal(completed.outputs.brief.value, 'Brief after the approved provider permission.')
    assert.deepEqual(completed.permissions.filter((permission) => permission.delivered).map((permission) => [permission.id, permission.status]), [['read-workspace-note', 'approved']])
  } finally {
    await runtime.close()
  }
})

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
  assert.deepEqual(subprocedure.grants, ['model.invoke', 'network.read'])
  assert.deepEqual(subprocedure.resourceBindings, { workspace: 'workspace' })
})

test('a captured Run request saves as a new project Test scenario and runs', async (t) => {
  const { projectRoot, stateRoot, project } = await fixture(t)
  const limits = structuredClone(project.scenarios.find((item) => item.id === 'covered-topic').limits)
  const saved = await project.saveScenario(project.revision, {
    name: 'Rushed Coverage',
    description: 'Captured from a completed review Run.',
    inputs: { goal: 'Capture a reusable research scenario', audience: 'Reviewers' },
    grants: ['model.invoke', 'network.read'],
    resources: {},
    limits,
    bindings: {
      researcher: { provider: 'codex' },
      'fact-checker': { provider: 'grok' },
      editor: { provider: 'zcode' },
    },
  })
  const scenario = saved.scenarios.find((item) => item.id === 'rushed-coverage')
  assert.ok(scenario)
  const persisted = JSON.parse(await readFile(join(projectRoot, 'scenarios', 'rushed-coverage.json'), 'utf8'))
  assert.equal(persisted.schemaVersion, 'openadam.procedure-studio-scenario.v0.1')
  assert.equal(persisted.inputs.audience, 'Reviewers')
  const config = JSON.parse(await readFile(join(projectRoot, 'studio.project.json'), 'utf8'))
  assert.ok(config.scenarios.includes('scenarios/rushed-coverage.json'))
  const sourceSaved = await project.save(saved.revision)
  assert.equal(sourceSaved.source.conflict, false)
  assert.equal(sourceSaved.source.saved, true)

  const reopened = await StudioProject.open(projectRoot, stateRoot)
  assert.deepEqual(new Set(reopened.scenarios.map((item) => item.id)), new Set(['covered-topic', 'needs-clarification', 'coverage-rework', 'rushed-coverage']))
  const runtime = await StudioRuntime.open(join(stateRoot, 'runs'), reopened, {
    adapterFactory: researchAdapter(successfulBriefReports('Captured research brief.')),
  })
  try {
    const started = await runtime.start('rushed-coverage')
    assert.equal((await wait(runtime, started.id, 'complete')).outputs.brief.value, 'Captured research brief.')
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
  candidate.inputs.goal = 'An edited reusable scenario'
  candidate.limits.maxNodeExecutions = 18
  const updated = await project.updateScenario(current.revision, candidate.id, candidate)
  assert.equal(updated.scenarios.find((item) => item.id === candidate.id).inputs.goal, 'An edited reusable scenario')
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
  afterReload.inputs.goal = 'Edited after external recovery'
  const recovered = await project.updateScenario(reloaded.revision, candidate.id, afterReload)
  assert.equal(recovered.scenarios.find((item) => item.id === candidate.id).inputs.goal, 'Edited after external recovery')
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
    scenario.inputs.goal = 'Updated through the private route'
    const scenarioUpdated = await fetch(`${studio.origin}/api/project/scenario/covered-topic`, {
      method: 'PUT',
      headers: { 'x-procedure-studio-token': studio.token, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: state.revision, candidate: scenario }),
    })
    assert.equal(scenarioUpdated.status, 200)
    const updatedState = (await scenarioUpdated.json()).state
    assert.equal(updatedState.scenarios.find((item) => item.id === 'covered-topic').inputs.goal, 'Updated through the private route')
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
        inputs: { goal: 'Route capture', audience: 'Reviewers' },
        grants: ['model.invoke', 'network.read'],
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

function hostProcedure(stateRoot, args, input) {
  const cli = fileURLToPath(new URL('../../../bin/agent-host.mjs', import.meta.url))
  return JSON.parse(execFileSync(process.execPath, [cli, ...args, '--state-root', stateRoot, '--json'], {
    encoding: 'utf8',
    input,
  }))
}

test('Studio package passes preview, isolated Host import, Host CLI discovery/status/cancel, and installed runtime continuation without the project source', async (t) => {
  const { root, projectRoot, stateRoot, project } = await fixture(t)
  const opened = project.publicState()
  const document = structuredClone(opened.document)
  const marker = 'Installed Research Brief must run from sealed component bytes.'
  document.method.graph.nodes.find((node) => node.id === 'collect').instruction = marker
  const drafted = await project.update({ expectedRevision: opened.revision, document })
  const saved = await project.save(drafted.revision)
  assert.equal(saved.source.saved, true)
  const studioRuntime = await StudioRuntime.open(join(stateRoot, 'runs'), project, {
    adapterFactory: researchAdapter([
      researchReport({ outcome: 'needs_user', question: 'Which constraint?' }),
      ...successfulBriefReports('Studio scenario brief.'),
    ]),
  })
  try {
    const started = await studioRuntime.start('needs-clarification')
    const waiting = await wait(studioRuntime, started.id, 'waiting_user')
    studioRuntime.action(waiting.id, { action: 'answer', questionId: waiting.question.id, value: 'Keep the local constraint.' })
    assert.equal((await wait(studioRuntime, waiting.id, 'complete')).outputs.brief.value, 'Studio scenario brief.')
  } finally {
    await studioRuntime.close()
  }

  const packaged = await packageProject(project)
  assert.equal(packaged.preview.health.status, 'ok')
  assert.equal(packaged.effects.formalAgentHostStateChanged, false)
  assert.equal(packaged.preview.component.procedureId, 'org.openadam.example.research-brief')

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
  const listed = hostProcedure(hostStateRoot, ['procedure', 'list', '--query', 'research brief'])
  assert.deepEqual(listed.procedures.map((item) => [item.id, item.version]), [['org.openadam.example.research-brief', '1.0.0']])
  const described = hostProcedure(hostStateRoot, [
    'procedure', 'describe', '--id', 'org.openadam.example.research-brief', '--version', '1.0.0',
  ])
  assert.deepEqual(described.procedure.inputSchema.required, ['goal', 'audience'])
  assert.deepEqual(described.procedure.permissions, ['model.invoke', 'network.read'])

  const installed = await loadState(await readStatePaths(hostStateRoot))
  const component = installed.components['research-brief-procedure']
  const methodPath = component.procedureExecution.methodPath
  assert.equal(methodPath.includes(hostStateRoot), true)
  assert.equal(methodPath.includes(projectRoot), false)
  assert.match(await readFile(methodPath, 'utf8'), new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  const hiddenProject = join(root, 'studio-project-hidden')
  await rename(projectRoot, hiddenProject)

  const limits = {
    maxDurationMs: 60_000,
    maxNodeExecutions: 12,
    maxAgentTurns: 8,
    nodeTimeoutMs: 10_000,
    maxAttemptsPerNode: 4,
    maxOutputBytes: 65_536,
  }
  const request = {
    schemaVersion: 'openadam.agent-host-procedure-run-request.v0.1',
    procedure: { id: 'org.openadam.example.research-brief', version: '1.0.0' },
    inputs: { goal: 'Host-chain verification', audience: 'Reviewers' },
    grants: ['model.invoke', 'network.read'],
    resources: {},
    limits,
    idempotencyKey: 'studio-isolated-host-e2e',
  }
  const reports = [
    researchReport({ outcome: 'needs_user', question: 'Which constraint should the installed brief preserve?' }),
    ...successfulBriefReports('Installed component brief.'),
  ]
  const adapterFactory = researchAdapter(reports)
  const invoked = await invokeInstalledProcedure({ stateRoot: hostStateRoot, request }, { adapterFactory })
  assert.equal(invoked.status, 'waiting_user')
  assert.equal(invoked.interaction.kind, 'agent-question')
  assert.equal(invoked.outputs, undefined)
  const waiting = hostProcedure(hostStateRoot, ['procedure', 'status', '--run', invoked.taskId])
  assert.equal(waiting.status, 'waiting_user')
  assert.equal(waiting.interaction.kind, 'agent-question')

  const cancelRequest = { ...request, idempotencyKey: 'studio-isolated-host-cancel' }
  const cancelReports = [researchReport({ outcome: 'needs_user', question: 'Cancel from the Agent command?' })]
  const cancelling = await invokeInstalledProcedure({ stateRoot: hostStateRoot, request: cancelRequest }, {
    adapterFactory: researchAdapter(cancelReports),
  })
  const cancelled = hostProcedure(
    hostStateRoot,
    ['procedure', 'continue', '--run', cancelling.taskId, '--input', '-'],
    `${JSON.stringify({ action: 'cancel' })}\n`,
  )
  assert.equal(cancelled.status, 'cancelled')

  const continued = await continueProcedureRun({
    stateRoot: hostStateRoot,
    run: invoked.taskId,
    input: { action: 'answer', value: 'Verified through the isolated Host chain.' },
  }, { adapterFactory })
  assert.equal(continued.status, 'complete')
  assert.deepEqual(continued.outputs, { brief: 'Installed component brief.' })

  const failed = await invokeInstalledProcedure({
    stateRoot: hostStateRoot,
    request: { ...request, idempotencyKey: 'studio-isolated-host-failure' },
  }, {
    adapterFactory: researchAdapter([
      researchReport({ outcome: 'failed', summary: 'The installed research pass failed before coverage.' }),
    ]),
  })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error.code, 'AGENT_REPORTED_FAILURE')
  const recovered = await continueProcedureRun({
    stateRoot: hostStateRoot,
    run: failed.taskId,
    input: { action: 'resume' },
  }, {
    adapterFactory: researchAdapter(successfulBriefReports('Recovered installed brief.')),
  })
  assert.equal(recovered.status, 'complete')
  assert.deepEqual(recovered.outputs, { brief: 'Recovered installed brief.' })
  assert.equal(methodPath.includes(hiddenProject), false)
})
