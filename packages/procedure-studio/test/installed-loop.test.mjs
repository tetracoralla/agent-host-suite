import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { importLocalComponent, rollbackLocalComponent } from '../../../src/local-components.mjs'
import { continueProcedureRun, inspectProcedureRun, invokeInstalledProcedure, listInstalledProcedures } from '../../../src/procedure-products.mjs'
import { loadState, readStatePaths } from '../../../src/state.mjs'
import { toolSetStatus } from '../../../src/lifecycle.mjs'
import { exportSkillLinkCatalog } from '../../../src/skill-link-catalog.mjs'
import { setup } from '../../../src/setup.mjs'
import { compatibleApplicationState, createCodexRunner, healthyCatalogPreflight } from '../../../test/helpers.mjs'
import { createAgenticProcedureComponentFixture, createReleaseFixture } from '../../../test/release-helpers.mjs'
import { packageProject } from '../src/packager.mjs'
import { StudioProject } from '../src/project.mjs'

// Stage-one closure evidence: both structurally different Procedures leave the
// Studio project, install into an isolated Host, and keep serving real Agent
// use — including subprocedure resolution through the installed catalog,
// provider permission requests, recovery, update and rollback.

const examples = new URL('../examples/', import.meta.url)

async function fixture(t, name) {
  const root = await mkdtemp(join(tmpdir(), 'procedure-studio-installed-loop-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectRoot = join(root, name)
  const stateRoot = join(root, 'studio-state')
  await cp(new URL(`${name}/`, examples), projectRoot, { recursive: true })
  return { root, projectRoot, stateRoot, project: await StudioProject.open(projectRoot, stateRoot) }
}

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

function report(extra) {
  return JSON.stringify({
    outcome: 'complete',
    summary: 'Completed the installed-loop fixture step',
    plan: 'Return the declared stage result',
    findings: [],
    checks: [],
    resolvedFindingIds: [],
    acknowledgedDecisionIds: [],
    ...extra,
  })
}

const COMPOSITION_ROUTES = {
  draft: 'Read only the files relevant to the goal',
  finalize: 'Use the verified artifact and return the declared final text',
  verifier: 'Review the candidate and return the verdict JSON.',
}

const RESEARCH_ROUTES = {
  collect: '围绕问题收集可追溯材料',
  verify: '独立核对来源、关键反例与不确定性',
  write: '把已核对材料组织为面向目标读者的简洁结论',
}

// One adapter factory serves the parent Procedure and its installed
// subprocedure: turns are routed by their real Method instructions, so the
// child reviewer turn runs through the same coordinator contract.
function routedAdapter(queues, routes) {
  const route = (prompt) => {
    for (const [key, marker] of Object.entries(routes)) {
      if (typeof prompt === 'string' && prompt.includes(marker)) {
        const queue = queues.get(key) ?? []
        return { key, behavior: queue.shift() ?? {} }
      }
    }
    return { key: 'unknown', behavior: {} }
  }
  return (binding, options) => {
    const worker = {
      resolved: null,
      rejected: null,
      async initialize() { return { steer: 'unsupported', interrupt: 'supported' } },
      async session(existing) { return { provider: binding.provider, id: existing ?? randomUUID(), model: 'fixture' } },
      async start(prompt) {
        const { behavior } = route(prompt)
        if (behavior.permission !== undefined) {
          await new Promise((resolve, reject) => {
            worker.resolved = resolve
            worker.rejected = reject
            options.onPermission({ id: behavior.permission, method: 'fixture/mark-workspace', native: {} })
          })
        }
        if (behavior.question !== undefined) {
          return { status: 'complete', text: report({ outcome: 'needs_user', question: behavior.question }) }
        }
        if (behavior.failure !== undefined) {
          return { status: 'complete', text: report({ outcome: 'failed', summary: behavior.failure }) }
        }
        return { status: 'complete', text: report({ outputs: behavior.outputs ?? {} }) }
      },
      respond() { worker.resolved?.(true); worker.resolved = null },
      async interrupt() { worker.rejected?.(new Error('provider turn interrupted')); worker.rejected = null },
      async close() {},
    }
    return worker
  }
}

const verifierMethod = {
  schema: 'openadam.method-graph.v2',
  profile: null,
  id: 'verifier',
  revision: 1,
  name: 'Verifier',
  description: 'Independently verify normalized composition output.',
  roles: [
    { id: 'reviewer', name: 'Reviewer', independentFrom: [], includeReports: false, defaultBinding: { provider: 'codex' } },
  ],
  inputs: [
    { id: 'candidate', name: 'Candidate', type: 'json', required: true },
  ],
  artifacts: [
    { id: 'verdict', name: 'Verdict', type: 'json', required: true },
  ],
  permissions: [
    { id: 'model.invoke', name: 'Invoke the selected Agent' },
    { id: 'network.read', name: 'Read declared sources' },
  ],
  resources: [
    { id: 'workspace', name: 'Git workspace', type: 'workspace', required: false, adapter: 'git' },
  ],
  graph: {
    entry: 'review',
    extensions: {
      parallel: { version: 1, supported: false },
      wait: { version: 1, supported: false },
    },
    nodes: [
      {
        id: 'review',
        name: 'Review candidate',
        kind: 'agent-turn',
        role: 'reviewer',
        instruction: COMPOSITION_ROUTES.verifier,
        access: 'none',
        consumes: ['candidate'],
        produces: ['verdict'],
        permissions: ['model.invoke'],
        resources: [],
        transitions: [{ id: 'review-complete', when: { operator: 'always' }, to: null, label: 'Complete' }],
      },
    ],
  },
}

async function gitWorkspace(root) {
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  execFileSync('git', ['init', '-q', workspace])
  execFileSync('git', ['-C', workspace, 'config', 'user.name', 'Installed Loop Fixture'])
  execFileSync('git', ['-C', workspace, 'config', 'user.email', 'fixture@example.invalid'])
  await writeFile(join(workspace, 'README.md'), '# Fixture workspace\n')
  execFileSync('git', ['-C', workspace, 'add', 'README.md'])
  execFileSync('git', ['-C', workspace, 'commit', '-qm', 'fixture baseline'])
  return workspace
}

test('the Git-workspace composition installs from Studio and serves Agent use with a real installed subprocedure', async (t) => {
  const { root, projectRoot, project } = await fixture(t, 'workspace-composition')
  assert.equal(project.validation.valid, true)
  const packaged = await packageProject(project)
  assert.equal(packaged.preview.health.status, 'ok')

  const verifier = await createAgenticProcedureComponentFixture(join(root, 'verifier-component'), {
    id: 'verifier-procedure',
    version: '1.4.2',
    procedureId: 'org.openadam.example.verifier',
    method: verifierMethod,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['candidate'],
      properties: { candidate: { type: 'object' } },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['verdict'],
      properties: { verdict: { type: 'object' } },
    },
    permissions: ['model.invoke', 'network.read'],
    resources: [{ id: 'workspace', type: 'workspace', required: false, adapter: 'git' }],
    outputArtifacts: ['verdict'],
    displayName: 'Verifier',
    summary: 'Verify normalized composition output.',
  })

  const releaseManifest = await createReleaseFixture(join(root, 'host-release'), {
    suiteVersion: '0.1.1-installed-loop',
    releaseId: 'procedure-installed-loop',
    marker: 'installed-loop',
  })
  const hostStateRoot = join(root, 'host-state')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathMarketplace: 'openadam', mathVersion: '0.4.0' })
  const hostSkillHome = join(root, 'host-home')
  const dependencies = {
    runner: fake.runner,
    codexConfiguration: fake.configuration,
    hostSkillHome,
    componentWarmup: healthyComponentWarmup,
    catalogPreflight: healthyCatalogPreflight,
    applicationStatePreflight: compatibleApplicationState,
  }
  await setup({
    profile: 'standard', hosts: ['codex'], releaseManifest, stateRoot: hostStateRoot,
    noService: true, dryRun: false, enableObservability: false,
  }, dependencies)
  await importLocalComponent({ stateRoot: hostStateRoot, artifact: verifier.artifactPath, binding: verifier.binding, activate: false }, dependencies)
  await importLocalComponent({ stateRoot: hostStateRoot, artifact: packaged.artifact.path, binding: packaged.preview.binding, activate: false }, dependencies)

  const discovered = await listInstalledProcedures({ stateRoot: hostStateRoot })
  assert.deepEqual(new Set(discovered.procedures.map((item) => `${item.id}@${item.version}`)), new Set([
    'org.openadam.example.workspace-composition@2.3.0',
    'org.openadam.example.verifier@1.4.2',
  ]))
  const described = hostProcedure(hostStateRoot, ['procedure', 'describe', '--id', 'org.openadam.example.workspace-composition', '--version', '2.3.0'])
  assert.deepEqual(described.procedure.resources.map((item) => item.id), ['workspace'])

  const links = await exportSkillLinkCatalog({ stateRoot: hostStateRoot }, {
    listMcpTools: async () => [],
  })
  const procedureLinks = links.entries.filter((item) => item.kind === 'procedure')
  assert.deepEqual(new Set(procedureLinks.map((item) => item.identity)), new Set([
    'org.openadam.example.workspace-composition',
    'org.openadam.example.verifier',
  ]))
  for (const link of procedureLinks) {
    assert.deepEqual(link.invocation.arguments.slice(0, 2), ['procedure', 'invoke'])
    assert.deepEqual(link.invocation.statusArguments.slice(0, 2), ['procedure', 'status'])
    assert.deepEqual(link.invocation.continueArguments.slice(0, 2), ['procedure', 'continue'])
  }

  const installed = await loadState(await readStatePaths(hostStateRoot))
  const composition = installed.components['workspace-composition-procedure']
  assert.equal(composition.procedureExecution.methodPath.includes(hostStateRoot), true)
  assert.equal(composition.procedureExecution.methodPath.includes(projectRoot), false)

  const workspace = await gitWorkspace(root)
  const limits = {
    maxDurationMs: 120_000,
    maxNodeExecutions: 20,
    maxAgentTurns: 8,
    nodeTimeoutMs: 30_000,
    maxAttemptsPerNode: 4,
    maxOutputBytes: 262_144,
  }
  const baseRequest = {
    schemaVersion: 'openadam.agent-host-procedure-run-request.v0.1',
    procedure: { id: 'org.openadam.example.workspace-composition', version: '2.3.0' },
    inputs: { goal: 'Produce one verified compatibility note for the fixture workspace.' },
    grants: ['model.invoke', 'workspace.read', 'capability.invoke', 'procedure.invoke', 'network.read'],
    resources: { workspace: { type: 'workspace', adapter: 'git', path: workspace, allowExistingPaths: [] } },
    limits,
    idempotencyKey: 'installed-loop-composition',
  }
  const directCalls = []
  const queues = new Map([
    ['draft', [{ permission: 'mark-workspace-read', outputs: { draft: 'bounded draft from the workspace' } }]],
    ['verifier', [{ outputs: { verdict: { approved: true, checkedBy: 'installed-verifier' } } }]],
    ['finalize', [{ outputs: { final: 'Compatibility note approved by the installed verifier.' } }]],
  ])
  const adapterFactory = routedAdapter(queues, COMPOSITION_ROUTES)
  const invocation = { adapterFactory, executeDirectCall: async (call) => {
    directCalls.push(call)
    return { value: { normalized: true, source: call.input?.text ?? null } }
  } }

  const invoked = await invokeInstalledProcedure({ stateRoot: hostStateRoot, request: baseRequest }, invocation)
  assert.equal(invoked.status, 'paused')
  assert.equal(invoked.interaction, undefined)
  assert.equal(invoked.outputs, undefined)
  assert.equal(invoked.pendingPermissions, undefined)

  // The one-shot invocation ends the serving session before returning, so the
  // envelope matches the durable paused Run. A later session resumes it.
  const paused = hostProcedure(hostStateRoot, ['procedure', 'status', '--run', invoked.taskId])
  assert.equal(paused.status, invoked.status)
  assert.equal(paused.pendingPermissions, undefined)
  assert.equal((await inspectProcedureRun({ stateRoot: hostStateRoot, run: invoked.taskId })).status, 'paused')
  await assert.rejects(
    () => continueProcedureRun({
      stateRoot: hostStateRoot,
      run: invoked.taskId,
      input: { action: 'permission', permissionId: 'mark-workspace-read', allow: true },
    }, invocation),
    (error) => error.code === 'PROCEDURE_PERMISSION_SESSION_REQUIRED',
  )
  queues.set('draft', [{ outputs: { draft: 'draft after the interrupted permission wait' } }])
  queues.set('verifier', [{ outputs: { verdict: { approved: true, checkedBy: 'installed-verifier' } } }])
  queues.set('finalize', [{ outputs: { final: 'Compatibility note approved by the installed verifier.' } }])
  const approved = await continueProcedureRun({
    stateRoot: hostStateRoot,
    run: invoked.taskId,
    input: { action: 'resume' },
  }, invocation)
  assert.equal(approved.status, 'complete')
  assert.deepEqual(approved.outputs, { final: 'Compatibility note approved by the installed verifier.' })
  assert.equal(directCalls.length, 1)
  assert.deepEqual(directCalls[0].target, {
    kind: 'capability',
    providerId: 'org.openadam.text-integrity',
    capabilityId: 'text.normalize',
    capabilityVersion: '1.0.0',
    operationId: 'normalize',
  })
  assert.deepEqual(directCalls[0].grants, ['capability.invoke'])

  const tools = await toolSetStatus({ stateRoot: hostStateRoot })
  const byProcedure = new Map(tools.procedures.map((item) => [item.procedureId, item]))
  assert.equal(byProcedure.get('org.openadam.example.workspace-composition').exposure, 'available-to-new-agent-task')
  assert.equal(byProcedure.get('org.openadam.example.workspace-composition').availability.invocationEvidence.valid, true)
  assert.equal(byProcedure.get('org.openadam.example.verifier').availability.invocationEvidence.valid, true)
  assert.notEqual(byProcedure.get('org.openadam.example.verifier').availability.lastSuccessfulInvocationAt, null)
  assert.equal(tools.freshSession.requiredAfterChange, true)

  queues.set('draft', [{ failure: 'The first draft attempt crashed.' }])
  const failed = await invokeInstalledProcedure({
    stateRoot: hostStateRoot,
    request: { ...baseRequest, idempotencyKey: 'installed-loop-composition-failure' },
  }, invocation)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error.code, 'AGENT_REPORTED_FAILURE')
  queues.set('draft', [{ outputs: { draft: 'recovered draft' } }])
  queues.set('verifier', [{ outputs: { verdict: { approved: true, checkedBy: 'installed-verifier' } } }])
  queues.set('finalize', [{ outputs: { final: 'Compatibility note after recovery.' } }])
  const recovered = await continueProcedureRun({
    stateRoot: hostStateRoot,
    run: failed.taskId,
    input: { action: 'resume' },
  }, invocation)
  assert.equal(recovered.status, 'complete')
  assert.deepEqual(recovered.outputs, { final: 'Compatibility note after recovery.' })

  queues.set('draft', [{ question: 'Which workspace constraint should the note preserve?' }])
  const cancelling = await invokeInstalledProcedure({
    stateRoot: hostStateRoot,
    request: { ...baseRequest, idempotencyKey: 'installed-loop-composition-cancel' },
  }, invocation)
  assert.equal(cancelling.status, 'waiting_user')
  assert.equal(cancelling.interaction.kind, 'agent-question')
  const cancelled = hostProcedure(
    hostStateRoot,
    ['procedure', 'continue', '--run', cancelling.taskId, '--input', '-'],
    `${JSON.stringify({ action: 'cancel' })}\n`,
  )
  assert.equal(cancelled.status, 'cancelled')

  // Earlier evidence survives every later path, and the Studio project stays
  // unnecessary: hide it and confirm the installed run is still readable.
  assert.equal((await inspectProcedureRun({ stateRoot: hostStateRoot, run: invoked.taskId })).outputs.final, 'Compatibility note approved by the installed verifier.')
  const hiddenProject = join(root, 'studio-project-hidden')
  await rename(projectRoot, hiddenProject)
  assert.equal((await inspectProcedureRun({ stateRoot: hostStateRoot, run: recovered.taskId })).outputs.final, 'Compatibility note after recovery.')
})

test('a Studio-produced Procedure updates from v1 to v2 and rolls back with invocation evidence intact', async (t) => {
  const { root, projectRoot, project } = await fixture(t, 'research-brief')
  const saved = await project.save(project.revision)
  assert.equal(saved.source.saved, true)
  const firstPackage = await packageProject(project)
  assert.equal(firstPackage.preview.component.procedureVersion, '1.0.0')

  const releaseManifest = await createReleaseFixture(join(root, 'host-release'), {
    suiteVersion: '0.1.1-installed-loop',
    releaseId: 'procedure-update-loop',
    marker: 'update-loop',
  })
  const hostStateRoot = join(root, 'host-state')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathMarketplace: 'openadam', mathVersion: '0.4.0' })
  const hostSkillHome = join(root, 'host-home')
  const dependencies = {
    runner: fake.runner,
    codexConfiguration: fake.configuration,
    hostSkillHome,
    componentWarmup: healthyComponentWarmup,
    catalogPreflight: healthyCatalogPreflight,
    applicationStatePreflight: compatibleApplicationState,
  }
  await setup({
    profile: 'standard', hosts: ['codex'], releaseManifest, stateRoot: hostStateRoot,
    noService: true, dryRun: false, enableObservability: false,
  }, dependencies)
  await importLocalComponent({ stateRoot: hostStateRoot, artifact: firstPackage.artifact.path, binding: firstPackage.preview.binding, activate: false }, dependencies)

  const request = (version, key) => ({
    schemaVersion: 'openadam.agent-host-procedure-run-request.v0.1',
    procedure: { id: 'org.openadam.example.research-brief', version },
    inputs: { goal: 'Explain the installed update loop', audience: 'Reviewers' },
    grants: ['model.invoke', 'network.read'],
    resources: {},
    limits: {
      maxDurationMs: 60_000, maxNodeExecutions: 12, maxAgentTurns: 8,
      nodeTimeoutMs: 30_000, maxAttemptsPerNode: 4, maxOutputBytes: 65_536,
    },
    idempotencyKey: key,
  })
  const firstRun = await invokeInstalledProcedure({
    stateRoot: hostStateRoot,
    request: request('1.0.0', 'update-loop-v1'),
  }, {
    adapterFactory: routedAdapter(new Map([
      ['collect', [{ outputs: { 'source-notes': { sources: ['fixture'] } } }]],
      ['verify', [{ facts: { coverage: 'sufficient' } }]],
      ['write', [{ outputs: { brief: 'Installed v1 brief.' } }]],
    ]), RESEARCH_ROUTES),
  })
  assert.equal(firstRun.status, 'complete')
  assert.deepEqual(firstRun.outputs, { brief: 'Installed v1 brief.' })
  let tools = await toolSetStatus({ stateRoot: hostStateRoot })
  assert.equal(tools.procedures[0].procedureVersion, '1.0.0')
  assert.equal(tools.procedures[0].availability.invocationEvidence.valid, true)

  const current = project.publicState()
  const document = structuredClone(current.document)
  document.integration.procedure.version = '1.1.0'
  document.method.revision = 2
  document.method.graph.nodes.find((node) => node.id === 'write').instruction = '把已核对材料组织为面向目标读者的简洁结论，并明确标注这是 v2 简报。'
  const drafted = await project.update({ expectedRevision: current.revision, document })
  await project.save(drafted.revision)
  const secondPackage = await packageProject(project)
  assert.equal(secondPackage.preview.component.procedureVersion, '1.1.0')
  assert.notEqual(secondPackage.artifact.path, firstPackage.artifact.path)

  await importLocalComponent({ stateRoot: hostStateRoot, artifact: secondPackage.artifact.path, binding: secondPackage.preview.binding, activate: false, replace: true }, dependencies)
  tools = await toolSetStatus({ stateRoot: hostStateRoot })
  assert.equal(tools.procedures.length, 1)
  assert.equal(tools.procedures[0].procedureVersion, '1.1.0')
  assert.equal(tools.procedures[0].availability.invocationEvidence.valid, false)
  assert.equal((await inspectProcedureRun({ stateRoot: hostStateRoot, run: firstRun.taskId })).outputs.brief, 'Installed v1 brief.')

  const secondRun = await invokeInstalledProcedure({
    stateRoot: hostStateRoot,
    request: request('1.1.0', 'update-loop-v2'),
  }, {
    adapterFactory: routedAdapter(new Map([
      ['collect', [{ outputs: { 'source-notes': { sources: ['fixture'] } } }]],
      ['verify', [{ facts: { coverage: 'sufficient' } }]],
      ['write', [{ outputs: { brief: 'Installed v2 brief.' } }]],
    ]), RESEARCH_ROUTES),
  })
  assert.equal(secondRun.status, 'complete')
  assert.deepEqual(secondRun.outputs, { brief: 'Installed v2 brief.' })
  tools = await toolSetStatus({ stateRoot: hostStateRoot })
  assert.equal(tools.procedures[0].procedureVersion, '1.1.0')
  assert.equal(tools.procedures[0].availability.invocationEvidence.valid, true)

  await rollbackLocalComponent({ stateRoot: hostStateRoot, target: 'research-brief-procedure' }, dependencies)
  tools = await toolSetStatus({ stateRoot: hostStateRoot })
  assert.equal(tools.procedures[0].procedureVersion, '1.0.0')
  assert.equal(tools.procedures[0].availability.invocationEvidence.valid, false)
  const listed = hostProcedure(hostStateRoot, ['procedure', 'list'])
  assert.deepEqual(listed.procedures.map((item) => item.version), ['1.0.0'])

  const rolledBack = await invokeInstalledProcedure({
    stateRoot: hostStateRoot,
    request: request('1.0.0', 'update-loop-v1-after-rollback'),
  }, {
    adapterFactory: routedAdapter(new Map([
      ['collect', [{ outputs: { 'source-notes': { sources: ['fixture'] } } }]],
      ['verify', [{ facts: { coverage: 'sufficient' } }]],
      ['write', [{ outputs: { brief: 'Rolled-back v1 brief.' } }]],
    ]), RESEARCH_ROUTES),
  })
  assert.equal(rolledBack.status, 'complete')
  assert.deepEqual(rolledBack.outputs, { brief: 'Rolled-back v1 brief.' })
  tools = await toolSetStatus({ stateRoot: hostStateRoot })
  assert.equal(tools.procedures[0].procedureVersion, '1.0.0')
  assert.equal(tools.procedures[0].availability.invocationEvidence.valid, true)
  assert.equal((await inspectProcedureRun({ stateRoot: hostStateRoot, run: secondRun.taskId })).outputs.brief, 'Installed v2 brief.')
  assert.equal(projectRoot.includes(hostStateRoot), false)
})

test('an installed subprocedure question suspends the parent Run and continues the same child after reopen', async (t) => {
  const { root, projectRoot, project } = await fixture(t, 'workspace-composition')
  const packaged = await packageProject(project)
  assert.equal(packaged.preview.health.status, 'ok')

  const verifier = await createAgenticProcedureComponentFixture(join(root, 'verifier-component'), {
    id: 'verifier-procedure',
    version: '1.4.2',
    procedureId: 'org.openadam.example.verifier',
    method: verifierMethod,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['candidate'],
      properties: { candidate: { type: 'object' } },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['verdict'],
      properties: { verdict: { type: 'object' } },
    },
    permissions: ['model.invoke', 'network.read'],
    resources: [{ id: 'workspace', type: 'workspace', required: false, adapter: 'git' }],
    outputArtifacts: ['verdict'],
    displayName: 'Verifier',
    summary: 'Verify normalized composition output.',
  })
  const releaseManifest = await createReleaseFixture(join(root, 'host-release'), {
    suiteVersion: '0.1.1-continuation-loop',
    releaseId: 'procedure-continuation-loop',
    marker: 'continuation-loop',
  })
  const hostStateRoot = join(root, 'host-state')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathMarketplace: 'openadam', mathVersion: '0.4.0' })
  const dependencies = {
    runner: fake.runner,
    codexConfiguration: fake.configuration,
    hostSkillHome: join(root, 'host-home'),
    componentWarmup: healthyComponentWarmup,
    catalogPreflight: healthyCatalogPreflight,
    applicationStatePreflight: compatibleApplicationState,
  }
  await setup({
    profile: 'standard', hosts: ['codex'], releaseManifest, stateRoot: hostStateRoot,
    noService: true, dryRun: false, enableObservability: false,
  }, dependencies)
  await importLocalComponent({ stateRoot: hostStateRoot, artifact: verifier.artifactPath, binding: verifier.binding, activate: false }, dependencies)
  await importLocalComponent({ stateRoot: hostStateRoot, artifact: packaged.artifact.path, binding: packaged.preview.binding, activate: false }, dependencies)

  const workspace = await gitWorkspace(root)
  const request = {
    schemaVersion: 'openadam.agent-host-procedure-run-request.v0.1',
    procedure: { id: 'org.openadam.example.workspace-composition', version: '2.3.0' },
    inputs: { goal: 'Produce one verified note across a subprocedure question wait.' },
    grants: ['model.invoke', 'workspace.read', 'capability.invoke', 'procedure.invoke', 'network.read'],
    resources: { workspace: { type: 'workspace', adapter: 'git', path: workspace, allowExistingPaths: [] } },
    limits: {
      maxDurationMs: 120_000, maxNodeExecutions: 20, maxAgentTurns: 8,
      nodeTimeoutMs: 30_000, maxAttemptsPerNode: 4, maxOutputBytes: 262_144,
    },
    idempotencyKey: 'subprocedure-continuation-loop',
  }
  const adapterFactory = routedAdapter(new Map([
    ['draft', [{ outputs: { draft: 'draft before the subprocedure question' } }]],
    ['verifier', [
      { question: 'Which workspace constraint should the verification preserve?' },
      { outputs: { verdict: { approved: true, checkedBy: 'continuation-verifier' } } },
    ]],
    ['finalize', [{ outputs: { final: 'Composition continued after the subprocedure answer.' } }]],
  ]), COMPOSITION_ROUTES)
  const invocation = {
    adapterFactory,
    executeDirectCall: async () => ({ value: { normalized: true } }),
  }

  // First process: the child verifier asks; the one-shot parent Run returns
  // the mirrored question instead of failing the composed work.
  const waiting = await invokeInstalledProcedure({ stateRoot: hostStateRoot, request }, invocation)
  assert.equal(waiting.status, 'waiting_user')
  assert.equal(waiting.interaction.kind, 'subprocedure')
  assert.equal(waiting.interaction.prompt, 'Which workspace constraint should the verification preserve?')

  // A separate CLI process observes the same durable wait without adapters.
  const observed = hostProcedure(hostStateRoot, ['procedure', 'status', '--run', waiting.taskId])
  assert.equal(observed.status, 'waiting_user')
  assert.equal(observed.interaction.kind, 'subprocedure')

  // The answering session reopens the parent Run from durable state: the
  // recorded continuation continues the same child Run (its state directory
  // persists under procedure-runs/children), not a fresh child.
  const childRoot = join(hostStateRoot, 'runtime', 'procedure-runs', 'children')
  const childSegments = await readdir(childRoot, { withFileTypes: true })
  assert.equal(childSegments.filter((entry) => entry.isDirectory()).length >= 1, true)

  const answered = await continueProcedureRun({
    stateRoot: hostStateRoot,
    run: waiting.taskId,
    input: { action: 'answer', questionId: waiting.interaction.id, value: 'Preserve the fixture constraint.' },
  }, invocation)
  assert.equal(answered.status, 'complete')
  assert.deepEqual(answered.outputs, { final: 'Composition continued after the subprocedure answer.' })
  assert.equal(answered.outputs.final, 'Composition continued after the subprocedure answer.')
  assert.equal((await inspectProcedureRun({ stateRoot: hostStateRoot, run: waiting.taskId })).outputs.final, 'Composition continued after the subprocedure answer.')
})

test('a stale parent answer re-surfaces the child current question instead of delivering it to the wrong one', async (t) => {
  const { root, projectRoot, project } = await fixture(t, 'workspace-composition')
  const packaged = await packageProject(project)
  assert.equal(packaged.preview.health.status, 'ok')

  const verifier = await createAgenticProcedureComponentFixture(join(root, 'verifier-component'), {
    id: 'verifier-procedure',
    version: '1.4.2',
    procedureId: 'org.openadam.example.verifier',
    method: verifierMethod,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['candidate'],
      properties: { candidate: { type: 'object' } },
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['verdict'],
      properties: { verdict: { type: 'object' } },
    },
    permissions: ['model.invoke', 'network.read'],
    resources: [{ id: 'workspace', type: 'workspace', required: false, adapter: 'git' }],
    outputArtifacts: ['verdict'],
    displayName: 'Verifier',
    summary: 'Verify normalized composition output.',
  })
  const releaseManifest = await createReleaseFixture(join(root, 'host-release'), {
    suiteVersion: '0.1.1-stale-answer-drift',
    releaseId: 'procedure-stale-answer-drift',
    marker: 'stale-answer-drift',
  })
  const hostStateRoot = join(root, 'host-state')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathMarketplace: 'openadam', mathVersion: '0.4.0' })
  const dependencies = {
    runner: fake.runner,
    codexConfiguration: fake.configuration,
    hostSkillHome: join(root, 'host-home'),
    componentWarmup: healthyComponentWarmup,
    catalogPreflight: healthyCatalogPreflight,
    applicationStatePreflight: compatibleApplicationState,
  }
  await setup({
    profile: 'standard', hosts: ['codex'], releaseManifest, stateRoot: hostStateRoot,
    noService: true, dryRun: false, enableObservability: false,
  }, dependencies)
  await importLocalComponent({ stateRoot: hostStateRoot, artifact: verifier.artifactPath, binding: verifier.binding, activate: false }, dependencies)
  await importLocalComponent({ stateRoot: hostStateRoot, artifact: packaged.artifact.path, binding: packaged.preview.binding, activate: false }, dependencies)

  const workspace = await gitWorkspace(root)
  const request = {
    schemaVersion: 'openadam.agent-host-procedure-run-request.v0.1',
    procedure: { id: 'org.openadam.example.workspace-composition', version: '2.3.0' },
    inputs: { goal: 'Keep each subprocedure answer bound to its own question.' },
    grants: ['model.invoke', 'workspace.read', 'capability.invoke', 'procedure.invoke', 'network.read'],
    resources: { workspace: { type: 'workspace', adapter: 'git', path: workspace, allowExistingPaths: [] } },
    limits: {
      maxDurationMs: 120_000, maxNodeExecutions: 20, maxAgentTurns: 8,
      nodeTimeoutMs: 30_000, maxAttemptsPerNode: 4, maxOutputBytes: 262_144,
    },
    idempotencyKey: 'stale-answer-drift',
  }
  const adapterFactory = routedAdapter(new Map([
    ['draft', [{ outputs: { draft: 'draft before the drift' } }]],
    ['verifier', [
      { question: 'Which constraint applies first?' },
      { question: 'Which region should the verdict name?' },
      { outputs: { verdict: { approved: true, checkedBy: 'drift-verifier' } } },
    ]],
    ['finalize', [{ outputs: { final: 'Composition survived a stale parent answer.' } }]],
  ]), COMPOSITION_ROUTES)
  const invocation = {
    adapterFactory,
    executeDirectCall: async () => ({ value: { normalized: true } }),
  }

  // The parent suspends on the child first question.
  const waiting = await invokeInstalledProcedure({ stateRoot: hostStateRoot, request }, invocation)
  assert.equal(waiting.status, 'waiting_user')
  assert.equal(waiting.interaction.prompt, 'Which constraint applies first?')

  // The durable continuation names the child Run: read it from the parent
  // store so the child can be continued directly, as its own session.
  const parentStore = new DatabaseSync(join(hostStateRoot, 'runtime', 'procedure-runs', 'tasks.sqlite'), { readOnly: true })
  const row = parentStore.prepare('SELECT state FROM tasks WHERE id = ?').get(waiting.taskId)
  parentStore.close()
  const recordedContinuations = JSON.parse(row.state).subprocedureContinuations
  const childReference = recordedContinuations[Object.keys(recordedContinuations)[0]]
  assert.equal(typeof childReference.run, 'string')
  const child = { stateRoot: hostStateRoot, run: childReference.run, runRoot: childReference.root }

  const childWaiting = await inspectProcedureRun(child, invocation)
  assert.equal(childWaiting.status, 'waiting_user')
  assert.equal(childWaiting.interaction.prompt, 'Which constraint applies first?')

  // An explicit questionId binds the answer: naming a question the child is
  // not asking is rejected instead of answering whichever question is current.
  await assert.rejects(
    continueProcedureRun({
      ...child,
      input: { action: 'answer', questionId: 'not-the-current-question', value: 'wrong aim' },
    }, invocation),
    (error) => error.code === 'STALE_ANSWER',
  )

  // The child session answers its first question directly and advances to a
  // second question while the parent still mirrors the first one.
  const advanced = await continueProcedureRun({
    ...child,
    input: { action: 'answer', questionId: childWaiting.interaction.id, value: 'The fixture constraint.' },
  }, invocation)
  assert.equal(advanced.status, 'waiting_user')
  assert.equal(advanced.interaction.prompt, 'Which region should the verdict name?')

  // The parent answer for the first question must not be delivered to the
  // child second question: the parent re-surfaces the current child question.
  const resurfaced = await continueProcedureRun({
    stateRoot: hostStateRoot,
    run: waiting.taskId,
    input: { action: 'answer', questionId: waiting.interaction.id, value: 'An answer intended for the first question.' },
  }, invocation)
  assert.equal(resurfaced.status, 'waiting_user')
  assert.equal(resurfaced.interaction.kind, 'subprocedure')
  assert.equal(resurfaced.interaction.prompt, 'Which region should the verdict name?')

  const completed = await continueProcedureRun({
    stateRoot: hostStateRoot,
    run: waiting.taskId,
    input: { action: 'answer', questionId: resurfaced.interaction.id, value: 'eu-central' },
  }, invocation)
  assert.equal(completed.status, 'complete')
  assert.deepEqual(completed.outputs, { final: 'Composition survived a stale parent answer.' })
})
