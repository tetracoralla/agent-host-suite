import { runSkillLauncher } from './launcher-helpers.mjs'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, readdir, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { platform } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { importLocalComponent, localComponentStatus, previewLocalComponent, removeLocalComponent, rollbackLocalComponent } from '../src/local-components.mjs'
import { rollbackInstallation, setActiveTools, toolSetStatus, transitionComponentInventory, updateInstallation } from '../src/lifecycle.mjs'
import { cleanupStorage } from '../src/storage.mjs'
import { setup } from '../src/setup.mjs'
import { listHistory, loadState, prepareStatePaths, saveState } from '../src/state.mjs'
import { compatibleApplicationState, createCodexRunner, healthyCatalogPreflight } from './helpers.mjs'
import { createAgenticProcedureComponentFixture, createInteractiveProcedureComponentFixture, createProcedureComponentFixture, createReleaseFixture, createToolComponentFixture } from './release-helpers.mjs'
import { runFile } from '../src/process.mjs'
import { exportSkillLinkCatalog } from '../src/skill-link-catalog.mjs'
import { continueProcedureRun, describeInstalledProcedure, inspectProcedureRun, invokeInstalledProcedure, listInstalledProcedures } from '../src/procedure-products.mjs'

const tarCommand = platform() === 'win32' ? 'tar.exe' : '/usr/bin/tar'

function healthyProbe(component) {
  const result = { status: 'ok', tools: component.expectedTools, expectedTools: component.expectedTools, server: { name: 'Private Fixture', version: component.version } }
  return { first: result, repeat: result, firstLaunchMs: 1, repeatLaunchMs: 1, firstLaunchTimeoutMs: 60000, repeatTimeoutMs: component.healthTimeoutMs }
}

async function healthyComponentWarmup({ manifest, componentIds }) {
  return {
    status: 'ok', strategy: 'sequential-first-and-repeat',
    components: componentIds.map((id) => ({ id, version: manifest.components[id].version })),
  }
}

async function environment(root) {
  const manifest = await createReleaseFixture(join(root, 'release'), {
    suiteVersion: '0.1.1-private-test',
    releaseId: 'private-component-test',
    marker: 'base',
  })
  const stateRoot = join(root, 'state')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathMarketplace: 'openadam', mathVersion: '0.4.0' })
  const hostSkillHome = join(root, 'host-home')
  await setup({
    profile: 'standard', hosts: ['codex'], releaseManifest: manifest, stateRoot,
    noService: true, dryRun: false, enableObservability: false,
  }, {
    runner: fake.runner, codexConfiguration: fake.configuration,
    hostSkillHome,
    componentWarmup: healthyComponentWarmup,
    catalogPreflight: healthyCatalogPreflight,
    applicationStatePreflight: compatibleApplicationState,
  })
  return { stateRoot, fake, hostSkillHome }
}

test('private component preview validates sealed bytes and MCP catalog without mutating installed state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-private-preview-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot } = await environment(root)
  const fixture = await createToolComponentFixture(join(root, 'tool'))
  const before = await loadState(await prepareStatePaths(stateRoot))
  const archiveCalls = []
  const artifactRunner = async (command, args, options = {}) => {
    if (command === tarCommand) archiveCalls.push([...args])
    return runFile(command, args, options)
  }

  const preview = await previewLocalComponent({
    stateRoot,
    artifact: fixture.artifactPath,
    licenseSpdx: 'Apache-2.0',
  }, { artifactRunner, mcpProbe: healthyProbe })

  assert.deepEqual(preview.binding, fixture.binding)
  assert.equal(preview.component.kind, 'agent-tool')
  assert.deepEqual(preview.component.expectedTools, ['private_fixture.run'])
  assert.equal(preview.health.first.status, 'ok')
  const after = await loadState(await prepareStatePaths(stateRoot))
  assert.deepEqual(after, before)
  assert.equal(after.components['private-fixture'], undefined)
  assert.equal(archiveCalls.filter((args) => args[0] === '-tzf').length, 1)
  assert.equal(archiveCalls.filter((args) => args[0] === '-tvzf').length, 1)
  assert.equal(archiveCalls.filter((args) => args[0] === '-xOzf').length, 1)
  assert.equal(archiveCalls.filter((args) => args[0] === '-xzf').length, 1)
})

test('standalone private component preview needs no installed Agent environment', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-standalone-preview-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = await createToolComponentFixture(join(root, 'tool'))
  const preview = await previewLocalComponent({
    standalone: true,
    artifact: fixture.artifactPath,
    licenseSpdx: 'Apache-2.0',
  }, { mcpProbe: healthyProbe })

  assert.deepEqual(preview.binding, fixture.binding)
  assert.equal(preview.status, 'ready')
  assert.deepEqual(preview.component.expectedTools, ['private_fixture.run'])
})

test('private component import locks preview facts, activates through Codex projection, and supports remove and rollback', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-private-lifecycle-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const fixture = await createToolComponentFixture(join(root, 'tool'))
  const dependencies = {
    runner: fake.runner, codexConfiguration: fake.configuration,
    hostSkillHome,
    mcpProbe: healthyProbe,
    componentWarmup: healthyComponentWarmup,
    catalogPreflight: healthyCatalogPreflight,
    applicationStatePreflight: compatibleApplicationState,
  }

  await assert.rejects(
    importLocalComponent({ stateRoot, artifact: fixture.artifactPath, binding: { ...fixture.binding, archiveBytes: fixture.binding.archiveBytes + 1 }, activate: true }, dependencies),
    (error) => error.code === 'LOCAL_COMPONENT_BINDING_MISMATCH',
  )

  const imported = await importLocalComponent({
    stateRoot, artifact: fixture.artifactPath, binding: fixture.binding,
    activate: true, replace: false, replaceHostConflicts: false, dryRun: false,
  }, dependencies)
  assert.equal(imported.status, 'imported')
  assert.equal(imported.component.active, true)
  assert.equal(fake.enabledPlugins('private-fixture').length > 0, true)
  assert.equal(fake.enabledPlugins('private-fixture')[0].sourcePath.includes(join(await realpath(stateRoot), 'host-projections', 'codex')), true)
  const listed = await localComponentStatus({ stateRoot })
  assert.deepEqual(listed.components.map((item) => [item.id, item.active]), [['private-fixture', true]])

  const removed = await removeLocalComponent({ stateRoot, target: 'private-fixture', dryRun: false }, dependencies)
  assert.equal(removed.status, 'removed')
  assert.equal(removed.next, undefined)
  assert.equal(removed.component.installed, false)
  assert.equal(fake.enabledPlugins('private-fixture').length > 0, false)
  const removedState = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(removedState.components['private-fixture'], undefined)
  assert.equal(removedState.privateComponents['private-fixture'].rollback.component.root.includes(join(await realpath(stateRoot), 'packages')), true)

  const restored = await rollbackLocalComponent({ stateRoot, target: 'private-fixture', dryRun: false }, dependencies)
  assert.equal(restored.status, 'rolled-back')
  assert.equal(restored.next, undefined)
  assert.equal(restored.component.version, '0.1.0')
  assert.equal(restored.component.active, true)
  assert.equal(fake.enabledPlugins('private-fixture').length > 0, true)
})

test('component inventory transitions publish installed Direct Capability providers into the active runtime config', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-private-runtime-inventory-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const paths = await prepareStatePaths(stateRoot)
  const previous = await loadState(paths)
  const providerRoot = join(root, 'private-provider')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(providerRoot))
  const provider = {
    providerId: 'io.example.private-capability',
    transport: 'capability-jsonl-v0.1',
    lifecycle: 'per-call',
    rootPath: providerRoot,
    profilePath: join(providerRoot, 'profile.json'),
    manifestPath: join(providerRoot, 'provider.json'),
    identityFiles: [join(providerRoot, 'adapter.mjs')],
    capabilityId: 'org.example.private',
    capabilityVersion: '0.1.0',
    contracts: [{
      operationId: 'run',
      inputSchemaPath: join(providerRoot, 'input.json'),
      outputSchemaPath: join(providerRoot, 'output.json'),
    }],
  }
  await transitionComponentInventory({ stateRoot, dryRun: false }, {
    components: {
      ...previous.components,
      'private-capability': {
        version: '0.1.0', root: providerRoot, displayName: 'Private Capability',
        summary: 'Fixture Direct Capability', capabilityProvider: provider,
      },
    },
    availableAgentComponents: [...previous.availableAgentComponents, 'private-capability'],
    agentComponents: previous.agentComponents,
    privateComponents: {},
  }, {
    runner: fake.runner, codexConfiguration: fake.configuration,
    hostSkillHome,
    catalogPreflight: healthyCatalogPreflight,
  })

  const next = await loadState(paths)
  assert.notEqual(next.runtime.configPath, previous.runtime.configPath)
  const config = JSON.parse(await readFile(next.runtime.configPath, 'utf8'))
  assert.equal(config.providers.some((item) => item.providerId === provider.providerId), true)
  assert.equal(config.servicePreparation?.providerIds?.includes(provider.providerId) ?? false, false)
})

test('a packaged Procedure installs without becoming an MCP tool and enters the Agent contract catalog', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-private-procedure-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const fixture = await createProcedureComponentFixture(join(root, 'procedure'))
  const dependencies = {
    runner: fake.runner,
    codexConfiguration: fake.configuration,
    hostSkillHome,
    componentWarmup: healthyComponentWarmup,
    catalogPreflight: healthyCatalogPreflight,
    applicationStatePreflight: compatibleApplicationState,
    mcpProbe() {
      throw new Error('Procedure admission must not probe an MCP tool surface')
    },
  }

  const preview = await previewLocalComponent({
    stateRoot,
    artifact: fixture.artifactPath,
    licenseSpdx: 'Apache-2.0',
  }, dependencies)
  assert.equal(preview.component.productType, 'procedure')
  assert.equal(preview.component.procedureId, 'org.openadam.test.echo-procedure')
  assert.deepEqual(preview.component.permissions, [])
  assert.deepEqual(preview.component.lifecycle, {
    mode: 'synchronous',
    resumable: false,
    interaction: 'none',
  })
  assert.equal(preview.health.status, 'ok')
  assert.equal(preview.health.executed, false)

  await assert.rejects(
    importLocalComponent({
      stateRoot,
      artifact: fixture.artifactPath,
      binding: fixture.binding,
      activate: true,
    }, dependencies),
    (error) => error.code === 'LOCAL_COMPONENT_ACTIVATION_UNSUPPORTED',
  )

  const imported = await importLocalComponent({
    stateRoot,
    artifact: fixture.artifactPath,
    binding: fixture.binding,
    activate: false,
  }, dependencies)
  assert.equal(imported.component.productType, 'procedure')
  // agentAvailable stays false until a verified invocation: installation and
  // contract validation never masquerade as successful Agent-facing use.
  assert.equal(imported.component.agentAvailable, false)
  assert.deepEqual(imported.component.availability, {
    installed: true,
    contractValidated: true,
    discoverable: true,
    lastSuccessfulInvocationAt: null,
    invocationEvidence: {
      valid: false,
      verifiedAt: null,
      invalidatedAt: null,
      invalidatedReason: 'not-yet-invoked',
      dependencies: null,
    },
    currentHealth: { status: 'not-checked', observedAt: null },
    currentSessionDiscovery: { status: 'not-observed', observedAt: null },
  })
  assert.equal(imported.component.active, false)

  const paths = await prepareStatePaths(stateRoot)
  const state = await loadState(paths)
  assert.equal(state.availableAgentComponents.includes('private-procedure'), false)
  assert.equal(state.agentComponents.includes('private-procedure'), false)
  const config = JSON.parse(await readFile(state.runtime.configPath, 'utf8'))
  const procedure = config.providers.find((item) => item.providerId === 'test.fake-procedure')
  assert.equal(procedure.procedureId, 'org.openadam.test.echo-procedure')

  const products = await toolSetStatus({ stateRoot })
  assert.equal(products.schemaVersion, 'openadam.agent-host-tool-set.v0.2')
  assert.deepEqual(products.procedures.map((item) => item.id), ['private-procedure'])
  assert.equal(products.procedures[0].agentAvailable, false)
  assert.equal(products.procedures[0].exposure, 'available-to-new-agent-task')
  const catalog = await exportSkillLinkCatalog({ stateRoot }, {
    listMcpTools: async (component) => component.expectedTools.map((name) => ({
      name,
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    })),
  })
  assert.equal(catalog.entries.some((item) =>
    item.kind === 'procedure'
      && item.identity === 'org.openadam.test.echo-procedure'
      && item.version === '0.1.0'
      && item.execution === 'direct-runtime'
      && item.invocation?.protocol === 'openadam.agent-host-procedure-invocation.v0.2'), true)
  const listed = await listInstalledProcedures({ stateRoot })
  assert.equal(listed.procedures[0].execution.kind, 'direct-runtime')
  const request = {
    schemaVersion: 'openadam.agent-host-procedure-run-request.v0.1',
    procedure: { id: 'org.openadam.test.echo-procedure', version: '0.1.0' },
    inputs: { value: 'through-host' },
    grants: [],
    resources: {},
    limits: {
      maxDurationMs: 60_000, maxNodeExecutions: 1, maxAgentTurns: 0,
      nodeTimeoutMs: 30_000, maxAttemptsPerNode: 1, maxOutputBytes: 65_536,
    },
    idempotencyKey: 'direct-through-host',
  }
  let directCalls = 0
  const invocationDependencies = {
    runner: async (_command, args, options) => {
      directCalls++
      assert.deepEqual(args.slice(-5), ['run', '--socket', state.runtime.socketPath, '--work-order', '-'])
      const order = JSON.parse(options.input)
      assert.equal(order.calls[0].target.procedureId, 'org.openadam.test.echo-procedure')
      return {
        status: 0,
        stdout: JSON.stringify({
          status: 'ok',
          calls: [{ status: 'ok', result: { value: order.calls[0].input.value } }],
        }),
        stderr: '',
      }
    },
  }
  const invoked = await invokeInstalledProcedure({ stateRoot, request }, invocationDependencies)
  assert.deepEqual(invoked.outputs, { value: 'through-host' })
  assert.deepEqual(await invokeInstalledProcedure({ stateRoot, request }, invocationDependencies), invoked)
  assert.equal(directCalls, 1)
  await assert.rejects(
    invokeInstalledProcedure({
      stateRoot,
      request: { ...request, inputs: { value: 'different request' } },
    }, invocationDependencies),
    (error) => error.code === 'PROCEDURE_IDEMPOTENCY_CONFLICT',
  )
  // The conflicting request must be rejected before the Provider executes: a
  // reused key with different content never burns an execution or effect.
  assert.equal(directCalls, 1)
  assert.equal((await toolSetStatus({ stateRoot })).procedures[0].agentAvailable, true)

  // A Runtime or binding change invalidates both availability evidence and the
  // completed-result scope. Returning the old cache must not certify the new
  // execution environment without actually exercising it.
  const changedRuntimeState = await loadState(paths)
  changedRuntimeState.components['direct-execution-runtime'].fingerprint = 'runtime-fingerprint-replaced'
  await saveState(paths, changedRuntimeState)
  assert.equal((await toolSetStatus({ stateRoot })).procedures[0].agentAvailable, false)
  const afterRuntimeChange = await invokeInstalledProcedure({ stateRoot, request }, invocationDependencies)
  assert.deepEqual(afterRuntimeChange.outputs, { value: 'through-host' })
  assert.notEqual(afterRuntimeChange.runId, invoked.runId)
  assert.equal(directCalls, 2)
  assert.deepEqual(await invokeInstalledProcedure({ stateRoot, request }, invocationDependencies), afterRuntimeChange)
  assert.equal(directCalls, 2)
  assert.equal((await toolSetStatus({ stateRoot })).procedures[0].agentAvailable, true)

  // Replace the component with different bytes at the same declared product
  // identity. A reused idempotency key must re-execute against the newly
  // installed package instead of being served the replaced package's cached
  // durable result.
  const replaced = await createProcedureComponentFixture(join(root, 'replaced'), {
    id: 'private-procedure',
    mutateAdapter: 'replaced package bytes',
  })
  await importLocalComponent({
    stateRoot,
    artifact: replaced.artifactPath,
    binding: replaced.binding,
    replace: true,
    activate: false,
  }, dependencies)
  assert.equal((await toolSetStatus({ stateRoot })).procedures[0].agentAvailable, false)
  const reinvoked = await invokeInstalledProcedure({ stateRoot, request }, invocationDependencies)
  assert.deepEqual(reinvoked.outputs, { value: 'through-host' })
  assert.notEqual(reinvoked.runId, afterRuntimeChange.runId)
  assert.equal(directCalls, 3)
  assert.deepEqual(await invokeInstalledProcedure({ stateRoot, request }, invocationDependencies), reinvoked)
  assert.equal(directCalls, 3)

  // Rolling back exact retained bytes restores their scoped availability
  // evidence and never exposes the lifecycle layer's private next-state value.
  const rolledBack = await rollbackLocalComponent({ stateRoot, target: 'private-procedure' }, dependencies)
  assert.equal(rolledBack.next, undefined)
  assert.equal(rolledBack.component.agentAvailable, true)
  assert.equal((await localComponentStatus({ stateRoot, target: 'private-procedure' })).components[0].agentAvailable, true)
  assert.deepEqual(await invokeInstalledProcedure({ stateRoot, request }, invocationDependencies), afterRuntimeChange)
  assert.equal(directCalls, 3)
})

test('concurrent Direct Procedure retries share one execution and conflicting content never reaches the Provider', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-direct-procedure-concurrency-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const dependencies = {
    runner: fake.runner,
    codexConfiguration: fake.configuration,
    hostSkillHome,
    componentWarmup: healthyComponentWarmup,
    catalogPreflight: healthyCatalogPreflight,
    applicationStatePreflight: compatibleApplicationState,
  }
  const fixture = await createProcedureComponentFixture(join(root, 'procedure'), { id: 'concurrent-procedure' })
  await importLocalComponent({
    stateRoot,
    artifact: fixture.artifactPath,
    binding: fixture.binding,
    activate: false,
  }, dependencies)
  const request = {
    schemaVersion: 'openadam.agent-host-procedure-run-request.v0.1',
    procedure: { id: 'org.openadam.test.echo-procedure', version: '0.1.0' },
    inputs: { value: 'one execution' },
    grants: [],
    resources: {},
    limits: {
      maxDurationMs: 60_000, maxNodeExecutions: 1, maxAgentTurns: 0,
      nodeTimeoutMs: 30_000, maxAttemptsPerNode: 1, maxOutputBytes: 65_536,
    },
    idempotencyKey: 'direct-concurrent-retry',
  }
  let calls = 0
  let release
  let started
  const gate = new Promise((resolve) => { release = resolve })
  const running = new Promise((resolve) => { started = resolve })
  const invocationDependencies = {
    runner: async (_command, _args, options) => {
      calls++
      started()
      await gate
      const order = JSON.parse(options.input)
      return {
        status: 0,
        stdout: JSON.stringify({
          status: 'ok',
          calls: [{ status: 'ok', result: { value: order.calls[0].input.value } }],
        }),
        stderr: '',
      }
    },
  }
  const first = invokeInstalledProcedure({ stateRoot, request }, invocationDependencies)
  await running
  const retry = invokeInstalledProcedure({ stateRoot, request }, invocationDependencies)
  await new Promise((resolve) => setTimeout(resolve, 75))
  assert.equal(calls, 1)
  await assert.rejects(
    invokeInstalledProcedure({
      stateRoot,
      request: { ...request, inputs: { value: 'conflicting content' } },
    }, invocationDependencies),
    (error) => error.code === 'PROCEDURE_IDEMPOTENCY_CONFLICT',
  )
  assert.equal(calls, 1)
  release()
  const [firstResult, retryResult] = await Promise.all([first, retry])
  assert.deepEqual(retryResult, firstResult)
  assert.equal(calls, 1)
  assert.equal((await toolSetStatus({ stateRoot })).procedures[0].agentAvailable, true)
})

test('a Direct Procedure completion cannot verify dependencies that changed while the call was running', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-direct-procedure-verification-race-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const dependencies = {
    runner: fake.runner,
    codexConfiguration: fake.configuration,
    hostSkillHome,
    componentWarmup: healthyComponentWarmup,
    catalogPreflight: healthyCatalogPreflight,
    applicationStatePreflight: compatibleApplicationState,
  }
  const fixture = await createProcedureComponentFixture(join(root, 'procedure'), { id: 'verification-race-procedure' })
  await importLocalComponent({
    stateRoot,
    artifact: fixture.artifactPath,
    binding: fixture.binding,
    activate: false,
  }, dependencies)
  const request = {
    schemaVersion: 'openadam.agent-host-procedure-run-request.v0.1',
    procedure: { id: 'org.openadam.test.echo-procedure', version: '0.1.0' },
    inputs: { value: 'dependency race' },
    grants: [],
    resources: {},
    limits: {
      maxDurationMs: 60_000, maxNodeExecutions: 1, maxAgentTurns: 0,
      nodeTimeoutMs: 30_000, maxAttemptsPerNode: 1, maxOutputBytes: 65_536,
    },
    idempotencyKey: 'direct-dependency-race',
  }
  const paths = await prepareStatePaths(stateRoot)
  let calls = 0
  const result = await invokeInstalledProcedure({ stateRoot, request }, {
    runner: async (_command, _args, options) => {
      calls++
      const changed = await loadState(paths)
      changed.components['direct-execution-runtime'].fingerprint = 'runtime-changed-during-call'
      await saveState(paths, changed)
      const order = JSON.parse(options.input)
      return {
        status: 0,
        stdout: JSON.stringify({
          status: 'ok',
          calls: [{ status: 'ok', result: { value: order.calls[0].input.value } }],
        }),
        stderr: '',
      }
    },
  })
  assert.equal(result.status, 'complete')
  assert.equal(calls, 1)
  assert.equal((await toolSetStatus({ stateRoot })).procedures[0].agentAvailable, false)

  const verified = await invokeInstalledProcedure({ stateRoot, request }, {
    runner: async (_command, _args, options) => {
      calls++
      const order = JSON.parse(options.input)
      return {
        status: 0,
        stdout: JSON.stringify({
          status: 'ok',
          calls: [{ status: 'ok', result: { value: order.calls[0].input.value } }],
        }),
        stderr: '',
      }
    },
  })
  assert.notEqual(verified.runId, result.runId)
  assert.equal(calls, 2)
  assert.equal((await toolSetStatus({ stateRoot })).procedures[0].agentAvailable, true)
})

test('Direct Runtime Procedure admission and invocation fail closed at the current resource and grant boundary', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-direct-procedure-authority-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const dependencies = {
    runner: fake.runner,
    codexConfiguration: fake.configuration,
    hostSkillHome,
    componentWarmup: healthyComponentWarmup,
    catalogPreflight: healthyCatalogPreflight,
    applicationStatePreflight: compatibleApplicationState,
  }
  const unsupported = await createProcedureComponentFixture(join(root, 'resource'), {
    id: 'resource-procedure',
    resources: [{ id: 'workspace', type: 'workspace', required: true, adapter: 'git' }],
  })
  await assert.rejects(
    previewLocalComponent({
      stateRoot,
      artifact: unsupported.artifactPath,
      licenseSpdx: 'Apache-2.0',
    }, dependencies),
    (error) => error.code === 'PROCEDURE_INTEGRATION_INVALID'
      && /cannot declare resources/u.test(error.message),
  )

  const fixture = await createProcedureComponentFixture(join(root, 'permission'), {
    id: 'permission-procedure',
    permissions: ['network.write'],
  })
  await importLocalComponent({
    stateRoot,
    artifact: fixture.artifactPath,
    binding: fixture.binding,
    activate: false,
  }, dependencies)
  const request = {
    schemaVersion: 'openadam.agent-host-procedure-run-request.v0.1',
    procedure: { id: 'org.openadam.test.echo-procedure', version: '0.1.0' },
    inputs: { value: 'explicit authority' },
    grants: [],
    resources: {},
    limits: {
      maxDurationMs: 60_000, maxNodeExecutions: 1, maxAgentTurns: 0,
      nodeTimeoutMs: 30_000, maxAttemptsPerNode: 1, maxOutputBytes: 65_536,
    },
    idempotencyKey: 'direct-authority-required',
  }
  let calls = 0
  const invocationDependencies = {
    runner: async (_command, _args, options) => {
      calls++
      const order = JSON.parse(options.input)
      return {
        status: 0,
        stdout: JSON.stringify({
          status: 'ok',
          calls: [{ status: 'ok', result: { value: order.calls[0].input.value } }],
        }),
        stderr: '',
      }
    },
  }
  // Model a durable result created under an older policy that did not require
  // the declared grant, then restore the current component contract. Current
  // authority must be checked before that cached result can be returned.
  const paths = await prepareStatePaths(stateRoot)
  const legacyState = await loadState(paths)
  legacyState.components['permission-procedure'].procedure.permissions = []
  legacyState.components['permission-procedure'].procedure.permissionCeiling = []
  await saveState(paths, legacyState)
  const legacyRequest = {
    ...request,
    inputs: { value: 'legacy cached result' },
    idempotencyKey: 'direct-authority-legacy-cache',
  }
  const legacyResult = await invokeInstalledProcedure({ stateRoot, request: legacyRequest }, invocationDependencies)
  assert.deepEqual(legacyResult.outputs, { value: 'legacy cached result' })
  assert.equal(calls, 1)
  const currentState = await loadState(paths)
  currentState.components['permission-procedure'].procedure.permissions = ['network.write']
  currentState.components['permission-procedure'].procedure.permissionCeiling = ['network.write']
  await saveState(paths, currentState)
  await assert.rejects(
    invokeInstalledProcedure({ stateRoot, request: legacyRequest }, invocationDependencies),
    (error) => error.code === 'PROCEDURE_GRANT_REQUIRED'
      && error.details?.permissions?.includes('network.write'),
  )
  assert.equal(calls, 1)
  await assert.rejects(
    invokeInstalledProcedure({ stateRoot, request }, invocationDependencies),
    (error) => error.code === 'PROCEDURE_GRANT_REQUIRED'
      && error.details?.permissions?.includes('network.write'),
  )
  assert.equal(calls, 1)
  const invoked = await invokeInstalledProcedure({
    stateRoot,
    request: {
      ...request,
      grants: ['network.write'],
      idempotencyKey: 'direct-authority-granted',
    },
  }, invocationDependencies)
  assert.deepEqual(invoked.outputs, { value: 'explicit authority' })
  assert.equal(calls, 2)
})

test('an installed non-development Procedure is discovered, invoked, read after restart, replaced and removed through Host state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-agentic-procedure-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const first = await createAgenticProcedureComponentFixture(join(root, 'first'))
  const dependencies = {
    runner: fake.runner,
    codexConfiguration: fake.configuration,
    hostSkillHome,
    componentWarmup: healthyComponentWarmup,
    catalogPreflight: healthyCatalogPreflight,
    applicationStatePreflight: compatibleApplicationState,
  }
  await importLocalComponent({
    stateRoot,
    artifact: first.artifactPath,
    binding: first.binding,
    activate: false,
  }, dependencies)

  const before = await exportSkillLinkCatalog({ stateRoot }, {
    listMcpTools: async (component) => component.expectedTools.map((name) => ({
      name,
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    })),
  })
  const link = before.entries.find((item) => item.kind === 'procedure')
  assert.equal(link.identity, 'org.openadam.test.research-brief')
  assert.equal(link.execution, 'agentic-runner')
  assert.deepEqual(link.invocation.arguments.slice(0, 2), ['procedure', 'invoke'])
  assert.deepEqual(link.invocation.statusArguments.slice(0, 2), ['procedure', 'status'])
  assert.deepEqual(link.invocation.continueArguments.slice(0, 2), ['procedure', 'continue'])
  assert.equal(link.availability.invocationEvidence.valid, false)

  const reports = [
    JSON.stringify({ outcome: 'needs_user', summary: 'need audience detail', question: 'Should the brief stay concise?' }),
    JSON.stringify({ outcome: 'complete', summary: 'sources', outputs: { 'source-notes': { sources: ['fixture'] } } }),
    JSON.stringify({ outcome: 'complete', summary: 'checked', facts: { coverage: 'sufficient' } }),
    JSON.stringify({ outcome: 'complete', summary: 'written', outputs: { brief: 'Checked fixture brief' } }),
  ]
  const adapterFactory = () => ({
    async initialize() { return { steer: 'unsupported', interrupt: 'supported' } },
    async session(existing) { return { provider: 'fixture', id: existing ?? randomUUID(), model: 'fixture' } },
    async start() { return { status: 'complete', text: reports.shift() } },
    async interrupt() {},
    async close() {},
    respond() {},
  })
  const request = {
    schemaVersion: 'openadam.agent-host-procedure-run-request.v0.1',
    procedure: { id: 'org.openadam.test.research-brief', version: '1.0.0' },
    inputs: { goal: 'Explain the fixture', audience: 'Reviewers' },
    grants: ['model.invoke', 'network.read'],
    resources: {},
    limits: {
      maxDurationMs: 60_000, maxNodeExecutions: 12, maxAgentTurns: 8,
      nodeTimeoutMs: 30_000, maxAttemptsPerNode: 4, maxOutputBytes: 65_536,
    },
    idempotencyKey: 'research-brief-with-question',
  }
  const invoked = await invokeInstalledProcedure({ stateRoot, request }, { adapterFactory })
  assert.equal(invoked.status, 'waiting_user')
  assert.equal(invoked.interaction.kind, 'agent-question')
  assert.equal(invoked.outputs, undefined)
  assert.equal(
    (await invokeInstalledProcedure({ stateRoot, request }, { adapterFactory })).taskId,
    invoked.taskId,
  )
  await assert.rejects(
    invokeInstalledProcedure({
      stateRoot,
      request: { ...request, inputs: { ...request.inputs, audience: 'Operators' } },
    }, { adapterFactory }),
    (error) => error.code === 'PROCEDURE_IDEMPOTENCY_CONFLICT',
  )

  const completed = await continueProcedureRun({
    stateRoot,
    run: invoked.taskId,
    input: { action: 'answer', text: 'Yes, keep it concise.' },
  }, { adapterFactory })
  assert.equal(completed.status, 'complete')
  assert.deepEqual(completed.outputs, { brief: 'Checked fixture brief' })

  const afterRestart = await inspectProcedureRun({
    stateRoot,
    run: completed.taskId,
  }, { adapterFactory })
  assert.deepEqual(afterRestart.outputs, completed.outputs)
  const available = await toolSetStatus({ stateRoot })
  assert.equal(available.procedures[0].availability.invocationEvidence.valid, true)
  assert.equal(available.procedures[0].agentAvailable, true)

  // The same request must execute again after the environment changes: an
  // old completed Run is history, not proof that the new binding works.
  const changedRuntimeState = await loadState(await prepareStatePaths(stateRoot))
  changedRuntimeState.suiteVersion = '0.1.2-private-test'
  await saveState(await prepareStatePaths(stateRoot), changedRuntimeState)
  assert.equal((await toolSetStatus({ stateRoot })).procedures[0].agentAvailable, false)
  reports.push(
    JSON.stringify({ outcome: 'complete', summary: 'new sources', outputs: { 'source-notes': { sources: ['new-environment'] } } }),
    JSON.stringify({ outcome: 'complete', summary: 'checked', facts: { coverage: 'sufficient' } }),
    JSON.stringify({ outcome: 'complete', summary: 'written', outputs: { brief: 'Brief from the changed environment' } }),
  )
  const reinvoked = await invokeInstalledProcedure({ stateRoot, request }, { adapterFactory })
  assert.equal(reinvoked.status, 'complete')
  assert.notEqual(reinvoked.taskId, completed.taskId)
  assert.deepEqual(reinvoked.outputs, { brief: 'Brief from the changed environment' })
  assert.deepEqual((await inspectProcedureRun({ stateRoot, run: completed.taskId })).outputs, completed.outputs)

  const pausedRequest = { ...request, idempotencyKey: 'paused-across-binding-change' }
  reports.push(JSON.stringify({ outcome: 'needs_user', summary: 'confirm', question: 'Keep the original brief?' }))
  const paused = await invokeInstalledProcedure({ stateRoot, request: pausedRequest }, { adapterFactory })
  assert.equal(paused.status, 'waiting_user')
  const changedBindingState = await loadState(await prepareStatePaths(stateRoot))
  changedBindingState.bindingsActivatedAt = '2026-10-05T00:00:00.000Z'
  await saveState(await prepareStatePaths(stateRoot), changedBindingState)
  reports.push(
    JSON.stringify({ outcome: 'complete', summary: 'sources', outputs: { 'source-notes': { sources: ['original-binding'] } } }),
    JSON.stringify({ outcome: 'complete', summary: 'checked', facts: { coverage: 'sufficient' } }),
    JSON.stringify({ outcome: 'complete', summary: 'written', outputs: { brief: 'Continued historical Run' } }),
  )
  const continued = await continueProcedureRun({
    stateRoot, run: paused.taskId, input: { action: 'answer', text: 'Yes' },
  }, { adapterFactory })
  assert.equal(continued.status, 'complete')
  assert.deepEqual(continued.outputs, { brief: 'Continued historical Run' })
  assert.equal((await toolSetStatus({ stateRoot })).procedures[0].agentAvailable, false)

  // Replacing exact bytes at the same public version also scopes idempotency.
  const replacedBytes = await createAgenticProcedureComponentFixture(join(root, 'same-version'), { summary: 'Changed package bytes at the same version' })
  await importLocalComponent({ stateRoot, artifact: replacedBytes.artifactPath, binding: replacedBytes.binding, replace: true, activate: false }, dependencies)
  reports.push(
    JSON.stringify({ outcome: 'complete', summary: 'sources', outputs: { 'source-notes': { sources: ['new-package'] } } }),
    JSON.stringify({ outcome: 'complete', summary: 'checked', facts: { coverage: 'sufficient' } }),
    JSON.stringify({ outcome: 'complete', summary: 'written', outputs: { brief: 'Current package and binding' } }),
  )
  const currentRun = await invokeInstalledProcedure({ stateRoot, request }, { adapterFactory })
  assert.equal(currentRun.status, 'complete')
  assert.notEqual(currentRun.taskId, reinvoked.taskId)
  assert.deepEqual(currentRun.outputs, { brief: 'Current package and binding' })
  assert.equal((await toolSetStatus({ stateRoot })).procedures[0].agentAvailable, true)
  assert.equal((await invokeInstalledProcedure({ stateRoot, request }, { adapterFactory })).taskId, currentRun.taskId)

  const beforeReplace = await toolSetStatus({ stateRoot })
  assert.equal(beforeReplace.procedures[0].rollbackVersion, '1.0.0')

  const second = await createAgenticProcedureComponentFixture(join(root, 'second'), { version: '1.1.0' })
  await importLocalComponent({
    stateRoot,
    artifact: second.artifactPath,
    binding: second.binding,
    replace: true,
    activate: false,
  }, dependencies)
  const updated = await toolSetStatus({ stateRoot })
  assert.equal(updated.procedures[0].procedureVersion, '1.1.0')
  assert.equal(updated.procedures[0].rollbackVersion, '1.0.0')
  assert.equal(updated.procedures[0].availability.invocationEvidence.valid, false)
  assert.deepEqual((await inspectProcedureRun({ stateRoot, run: completed.taskId })).outputs, completed.outputs)

  await rollbackLocalComponent({ stateRoot, target: 'research-brief-procedure' }, dependencies)
  const rolledBack = await toolSetStatus({ stateRoot })
  assert.equal(rolledBack.procedures[0].procedureVersion, '1.0.0')
  assert.equal(rolledBack.procedures[0].rollbackVersion, '1.1.0')

  await removeLocalComponent({ stateRoot, target: 'research-brief-procedure' }, dependencies)
  assert.deepEqual((await toolSetStatus({ stateRoot })).procedures, [])
  assert.deepEqual((await inspectProcedureRun({ stateRoot, run: completed.taskId })).outputs, completed.outputs)
})

test('packaged operations Skill launcher performs compact list, exact describe, invoke, status and continue across processes', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-procedure-launcher-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const fixture = await createInteractiveProcedureComponentFixture(join(root, 'interactive'))
  const directFixture = await createProcedureComponentFixture(join(root, 'direct'))
  const dependencies = {
    runner: fake.runner,
    codexConfiguration: fake.configuration,
    hostSkillHome,
    componentWarmup: healthyComponentWarmup,
    catalogPreflight: healthyCatalogPreflight,
    applicationStatePreflight: compatibleApplicationState,
  }
  await importLocalComponent({
    stateRoot,
    artifact: fixture.artifactPath,
    binding: fixture.binding,
    activate: false,
  }, dependencies)
  await importLocalComponent({
    stateRoot,
    artifact: directFixture.artifactPath,
    binding: directFixture.binding,
    activate: false,
  }, dependencies)

  const state = await loadState(await prepareStatePaths(stateRoot))
  const launcher = join(
    state.hosts.codex.operationsSkill.projectionRoot,
    'marketplace', 'plugins', 'agent-host-operations', 'skills',
    'agent-host-operations', 'scripts', 'agent-host',
  )
  const launcherEnvironment = {
    ...process.env,
    AGENT_HOST_NODE: process.execPath,
    AGENT_HOST_CLI: join(import.meta.dirname, '..', 'bin', 'agent-host.mjs'),
  }
  const run = (args, input = undefined) => JSON.parse(runSkillLauncher(
    launcher,
    [...args, '--state-root', stateRoot, '--json'],
    { env: launcherEnvironment, input },
  ))

  const catalog = run(['procedure', 'list', '--limit', '1', '--budget-bytes', '4096'])
  assert.equal(catalog.procedures.length, 1)
  assert.equal(catalog.page.remaining, 1)
  assert.equal(typeof catalog.page.nextCursor, 'string')
  assert.equal(catalog.procedures[0].inputSchema, undefined)
  assert.equal(catalog.procedures[0].outputSchema, undefined)
  assert.equal(catalog.budget.usedBytes <= catalog.budget.limitBytes, true)
  const secondPage = run([
    'procedure', 'list', '--limit', '1', '--budget-bytes', '4096', '--cursor', catalog.page.nextCursor,
  ])
  assert.equal(secondPage.page.remaining, 0)
  assert.equal(new Set([...catalog.procedures, ...secondPage.procedures].map((item) => item.id)).size, 2)
  const searched = run(['procedure', 'list', '--query', 'interactive brief', '--budget-bytes', '4096'])
  assert.deepEqual(searched.procedures.map((item) => item.id), ['org.openadam.test.interactive-brief'])

  const described = run([
    'procedure', 'describe', '--id', 'org.openadam.test.interactive-brief', '--version', '1.0.0',
  ])
  assert.deepEqual(described.procedure.inputSchema.required, ['topic'])
  assert.equal(described.procedure.invocation.protocol, 'openadam.agent-host-procedure-invocation.v0.2')

  const request = {
    schemaVersion: 'openadam.agent-host-procedure-run-request.v0.1',
    procedure: { id: 'org.openadam.test.interactive-brief', version: '1.0.0' },
    inputs: { topic: 'Foundation closure' },
    grants: [],
    resources: {},
    limits: {
      maxDurationMs: 60_000, maxNodeExecutions: 4, maxAgentTurns: 0,
      nodeTimeoutMs: 30_000, maxAttemptsPerNode: 2, maxOutputBytes: 65_536,
    },
    idempotencyKey: 'packaged-launcher-interactive',
  }
  const invoked = run(['procedure', 'invoke', '--request', '-'], `${JSON.stringify(request)}\n`)
  assert.equal(invoked.status, 'waiting_user')
  assert.equal(invoked.interaction.kind, 'human-input')

  const waiting = run(['procedure', 'status', '--run', invoked.taskId])
  assert.equal(waiting.status, 'waiting_user')
  const complete = run(
    ['procedure', 'continue', '--run', invoked.taskId, '--input', '-'],
    `${JSON.stringify({ action: 'answer', value: 'The launcher chain completed.' })}\n`,
  )
  assert.equal(complete.status, 'complete')
  assert.deepEqual(complete.outputs, { brief: 'The launcher chain completed.' })

  await removeLocalComponent({ stateRoot, target: 'interactive-procedure' }, dependencies)
  const retained = run(['procedure', 'status', '--run', invoked.taskId])
  assert.deepEqual(retained.outputs, complete.outputs)
})

test('private component rollback preserves removal as the immediate previous state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-private-removal-rollback-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const first = await createToolComponentFixture(join(root, 'first'), { version: '0.1.0', marker: 'first' })
  const second = await createToolComponentFixture(join(root, 'second'), { version: '0.2.0', marker: 'second' })
  const dependencies = {
    runner: fake.runner, codexConfiguration: fake.configuration,
    hostSkillHome,
    mcpProbe: healthyProbe,
    componentWarmup: healthyComponentWarmup,
    catalogPreflight: healthyCatalogPreflight,
    applicationStatePreflight: compatibleApplicationState,
  }
  await importLocalComponent({ stateRoot, artifact: first.artifactPath, binding: first.binding, activate: true, dryRun: false }, dependencies)
  await removeLocalComponent({ stateRoot, target: 'private-fixture', dryRun: false }, dependencies)

  const imported = await importLocalComponent({ stateRoot, artifact: second.artifactPath, binding: second.binding, activate: false, dryRun: false }, dependencies)
  assert.deepEqual(imported.component.rollback, { installed: false, version: null, archiveSha256: null, active: false })
  const removed = await rollbackLocalComponent({ stateRoot, target: 'private-fixture', dryRun: false }, dependencies)
  assert.equal(removed.component.installed, false)
  assert.equal(removed.component.rollback.version, '0.2.0')
  assert.equal(fake.enabledPlugins('private-fixture').length > 0, false)

  const restored = await rollbackLocalComponent({ stateRoot, target: 'private-fixture', dryRun: false }, dependencies)
  assert.equal(restored.component.version, '0.2.0')
  assert.equal(restored.component.active, false)
})

test('private component import is inactive by default and refuses component ids owned by the compatibility release', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-private-collision-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const privateFixture = await createToolComponentFixture(join(root, 'private'))
  const dependencies = { runner: fake.runner, codexConfiguration: fake.configuration, hostSkillHome, mcpProbe: healthyProbe, componentWarmup: healthyComponentWarmup, catalogPreflight: healthyCatalogPreflight }
  const imported = await importLocalComponent({
    stateRoot, artifact: privateFixture.artifactPath, binding: privateFixture.binding,
    activate: false, replace: false, dryRun: false,
  }, dependencies)
  assert.equal(imported.component.active, false)
  assert.equal(fake.enabledPlugins('private-fixture').length > 0, false)
  await removeLocalComponent({ stateRoot, target: 'private-fixture', dryRun: false }, dependencies)

  const paths = await prepareStatePaths(stateRoot)
  const state = await loadState(paths)
  state.components['reserved-tool'] = { ...state.components['math-anchor'], displayName: 'Release-owned fixture' }
  await saveState(paths, state)
  const reserved = await createToolComponentFixture(join(root, 'reserved'), { id: 'reserved-tool' })
  await assert.rejects(
    importLocalComponent({ stateRoot, artifact: reserved.artifactPath, binding: reserved.binding, activate: false }, dependencies),
    (error) => error.code === 'LOCAL_COMPONENT_ID_RESERVED',
  )
})

test('private component import supports multiple sealed records and binds only declared optional path roots', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-private-path-grants-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const pluginCache = join(root, 'plugin-cache')
  const applications = join(root, 'applications')
  await import('node:fs/promises').then(({ mkdir }) => Promise.all([mkdir(pluginCache), mkdir(applications)]))
  const first = await createToolComponentFixture(join(root, 'first'), {
    optionalPathEnvironment: ['PLUGIN_CACHE_ROOTS', 'APPLICATION_ROOTS'],
  })
  const dependencies = { runner: fake.runner, codexConfiguration: fake.configuration, hostSkillHome, mcpProbe: healthyProbe, componentWarmup: healthyComponentWarmup, catalogPreflight: healthyCatalogPreflight }

  await assert.rejects(
    importLocalComponent({ stateRoot, artifact: first.artifactPath, binding: first.binding, pathGrants: [`UNDECLARED=${pluginCache}`] }, dependencies),
    (error) => error.code === 'PATH_GRANT_UNDECLARED',
  )
  await assert.rejects(
    importLocalComponent({ stateRoot, artifact: first.artifactPath, binding: first.binding, pathGrants: [`PLUGIN_CACHE_ROOTS=${join(root, 'missing')}`] }, dependencies),
    (error) => error.code === 'PATH_GRANT_INVALID'
      && error.message.includes('PLUGIN_CACHE_ROOTS')
      && !error.message.toLowerCase().includes('workspace'),
  )
  await importLocalComponent({
    stateRoot, artifact: first.artifactPath, binding: first.binding, activate: false,
    pathGrants: [`PLUGIN_CACHE_ROOTS=${pluginCache}`, `APPLICATION_ROOTS=${applications}`],
  }, dependencies)
  let state = await loadState(await prepareStatePaths(stateRoot))
  assert.deepEqual(state.components['private-fixture'].pathGrants, {
    PLUGIN_CACHE_ROOTS: [await realpath(pluginCache)],
    APPLICATION_ROOTS: [await realpath(applications)],
  })

  const second = await createToolComponentFixture(join(root, 'second'), { id: 'second-fixture' })
  await importLocalComponent({ stateRoot, artifact: second.artifactPath, binding: second.binding, activate: false }, dependencies)
  state = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(state.privateComponents['private-fixture'].current.component.root.startsWith((await prepareStatePaths(stateRoot)).packages), true)
  assert.equal(state.privateComponents['second-fixture'].current.component.root.startsWith((await prepareStatePaths(stateRoot)).packages), true)
})

test('private component rollback restores one record while another remains current', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-private-rollback-overlay-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const first = await createToolComponentFixture(join(root, 'first'), { id: 'first-fixture' })
  const second = await createToolComponentFixture(join(root, 'second'), { id: 'second-fixture' })
  const dependencies = { runner: fake.runner, codexConfiguration: fake.configuration, hostSkillHome, mcpProbe: healthyProbe, componentWarmup: healthyComponentWarmup, catalogPreflight: healthyCatalogPreflight }
  await importLocalComponent({ stateRoot, artifact: first.artifactPath, binding: first.binding, activate: false }, dependencies)
  await removeLocalComponent({ stateRoot, target: 'first-fixture' }, dependencies)
  await importLocalComponent({ stateRoot, artifact: second.artifactPath, binding: second.binding, activate: true }, dependencies)
  let rollbackProbes = 0

  const restored = await rollbackLocalComponent({ stateRoot, target: 'first-fixture' }, {
    ...dependencies,
    mcpProbe(component) {
      rollbackProbes += 1
      return healthyProbe(component)
    },
  })
  assert.equal(restored.component.installed, true)
  assert.equal(restored.component.active, false)
  assert.equal(rollbackProbes, 1)
  const state = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(state.privateComponents['first-fixture'].current.component.version, '0.1.0')
  assert.equal(state.privateComponents['second-fixture'].current.component.version, '0.1.0')
  assert.equal(fake.enabledPlugins('second-fixture').length > 0, true)
  assert.equal(fake.enabledPlugins('first-fixture').length > 0, false)
})

test('activating a second private component fails before state change when the complete catalog conflicts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-private-active-conflict-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const first = await createToolComponentFixture(join(root, 'first'), { id: 'first-fixture' })
  const second = await createToolComponentFixture(join(root, 'second'), { id: 'second-fixture' })
  const catalogPreflight = async (components) => {
    if (components['first-fixture'] !== undefined && components['second-fixture'] !== undefined) {
      throw Object.assign(new Error('duplicate Agent-visible tool name'), { code: 'AGENT_TOOL_BINDING_CONFLICT' })
    }
    return healthyCatalogPreflight(components)
  }
  const dependencies = { runner: fake.runner, codexConfiguration: fake.configuration, hostSkillHome, mcpProbe: healthyProbe, componentWarmup: healthyComponentWarmup, catalogPreflight }
  await importLocalComponent({ stateRoot, artifact: first.artifactPath, binding: first.binding, activate: true }, dependencies)
  const before = await loadState(await prepareStatePaths(stateRoot))
  await assert.rejects(
    importLocalComponent({ stateRoot, artifact: second.artifactPath, binding: second.binding, activate: true }, dependencies),
    (error) => error.code === 'AGENT_TOOL_BINDING_CONFLICT',
  )
  assert.deepEqual(await loadState(await prepareStatePaths(stateRoot)), before)
  assert.equal(fake.enabledPlugins('first-fixture').length > 0, true)
  assert.equal(fake.enabledPlugins('second-fixture').length > 0, false)
})

test('private component rollback preserves optional path validation errors', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-private-rollback-path-error-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const pluginCache = join(root, 'plugin-cache')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(pluginCache))
  const fixture = await createToolComponentFixture(join(root, 'private'), { optionalPathEnvironment: ['PLUGIN_CACHE_ROOTS'] })
  const dependencies = { runner: fake.runner, codexConfiguration: fake.configuration, hostSkillHome, mcpProbe: healthyProbe, componentWarmup: healthyComponentWarmup, catalogPreflight: healthyCatalogPreflight }
  await importLocalComponent({
    stateRoot, artifact: fixture.artifactPath, binding: fixture.binding,
    pathGrants: [`PLUGIN_CACHE_ROOTS=${pluginCache}`], activate: false,
  }, dependencies)
  await removeLocalComponent({ stateRoot, target: 'private-fixture' }, dependencies)
  const before = await loadState(await prepareStatePaths(stateRoot))
  let rollbackProbes = 0

  await assert.rejects(
    rollbackLocalComponent({ stateRoot, target: 'private-fixture', pathGrants: [`UNDECLARED=${pluginCache}`] }, {
      ...dependencies,
      mcpProbe(component) {
        rollbackProbes += 1
        return healthyProbe(component)
      },
    }),
    (error) => error.code === 'PATH_GRANT_UNDECLARED',
  )
  assert.equal(rollbackProbes, 0)
  assert.deepEqual(await loadState(await prepareStatePaths(stateRoot)), before)
})

test('activating a component fails closed when a retained optional path grant is stale', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-private-stale-path-grant-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const pluginCache = join(root, 'plugin-cache')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(pluginCache))
  const fixture = await createToolComponentFixture(join(root, 'private'), { optionalPathEnvironment: ['PLUGIN_CACHE_ROOTS'] })
  const dependencies = { runner: fake.runner, codexConfiguration: fake.configuration, hostSkillHome, mcpProbe: healthyProbe, componentWarmup: healthyComponentWarmup, catalogPreflight: healthyCatalogPreflight }
  await importLocalComponent({
    stateRoot, artifact: fixture.artifactPath, binding: fixture.binding,
    pathGrants: [`PLUGIN_CACHE_ROOTS=${pluginCache}`], activate: false,
  }, dependencies)
  await rm(pluginCache, { recursive: true })
  const before = await loadState(await prepareStatePaths(stateRoot))

  await assert.rejects(
    setActiveTools({ stateRoot, tools: [...before.agentComponents, 'private-fixture'] }, dependencies),
    (error) => error.code === 'PATH_GRANT_INVALID' && error.message.includes('PLUGIN_CACHE_ROOTS'),
  )
  assert.deepEqual(await loadState(await prepareStatePaths(stateRoot)), before)
  assert.equal(fake.enabledPlugins('private-fixture').length > 0, false)
})

test('an inactive v0.3 private Provider remains discoverable as a Skill-only Codex plugin', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-private-discovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const fixture = await createToolComponentFixture(join(root, 'private'), { discovery: true })
  const dependencies = { runner: fake.runner, codexConfiguration: fake.configuration, hostSkillHome, mcpProbe: healthyProbe, componentWarmup: healthyComponentWarmup, catalogPreflight: healthyCatalogPreflight }
  const imported = await importLocalComponent({
    stateRoot, artifact: fixture.artifactPath, binding: fixture.binding,
    activate: false, replace: false, dryRun: false,
  }, dependencies)
  assert.equal(imported.component.active, false)
  assert.equal(fake.enabledPlugins('private-fixture').length > 0, true)
  const pluginRoot = fake.enabledPlugins('private-fixture')[0].installedPath
  const plugin = JSON.parse(await readFile(join(pluginRoot, '.codex-plugin/plugin.json'), 'utf8'))
  assert.equal('mcpServers' in plugin, false)
  await assert.rejects(readFile(join(pluginRoot, '.mcp.json')), (error) => error.code === 'ENOENT')
  assert.equal(runSkillLauncher(
    join(pluginRoot, `skills/use-private-fixture/scripts/private-fixture${process.platform === 'win32' ? '.cmd' : ''}`),
    ['--version'],
  ).trim(), '0.1.0')
})

test('a compatibility update preserves the private component overlay without adding it to the release profile', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-private-update-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const fixture = await createToolComponentFixture(join(root, 'private'))
  const dependencies = {
    runner: fake.runner, codexConfiguration: fake.configuration,
    hostSkillHome,
    mcpProbe: healthyProbe,
    componentWarmup: healthyComponentWarmup,
    catalogPreflight: healthyCatalogPreflight,
    applicationStatePreflight: compatibleApplicationState,
  }
  await importLocalComponent({
    stateRoot, artifact: fixture.artifactPath, binding: fixture.binding,
    activate: false, replace: false, dryRun: false,
  }, dependencies)
  const nextRelease = await createReleaseFixture(join(root, 'next-release'), {
    suiteVersion: '0.1.1-private-test.2',
    releaseId: 'private-component-test-2',
    marker: 'next',
  })

  await updateInstallation({ stateRoot, releaseManifest: nextRelease, dryRun: false }, dependencies)
  const paths = await prepareStatePaths(stateRoot)
  const state = await loadState(paths)
  assert.equal(state.profile, 'standard')
  assert.equal(state.availableAgentComponents.includes('private-fixture'), true)
  assert.equal(state.agentComponents.includes('private-fixture'), false)
  assert.equal(state.privateComponents['private-fixture'].current.binding.archiveSha256, fixture.binding.archiveSha256)
  assert.equal(state.components['private-fixture'].root.startsWith(paths.packages), true)
})

test('private component replacement retains exactly one prior sealed version for rollback', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-private-replace-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const first = await createToolComponentFixture(join(root, 'first'), { version: '0.1.0', marker: 'first' })
  const second = await createToolComponentFixture(join(root, 'second'), { version: '0.2.0', marker: 'second' })
  const dependencies = { runner: fake.runner, codexConfiguration: fake.configuration, hostSkillHome, mcpProbe: healthyProbe, componentWarmup: healthyComponentWarmup, catalogPreflight: healthyCatalogPreflight }
  await importLocalComponent({ stateRoot, artifact: first.artifactPath, binding: first.binding, activate: true, dryRun: false }, dependencies)

  const replaced = await importLocalComponent({
    stateRoot, artifact: second.artifactPath, binding: second.binding,
    activate: false, replace: true, dryRun: false,
  }, dependencies)
  assert.equal(replaced.component.version, '0.2.0')
  assert.equal(replaced.component.active, true)
  assert.equal(replaced.component.rollback.version, '0.1.0')

  const restored = await rollbackLocalComponent({ stateRoot, target: 'private-fixture', dryRun: false }, dependencies)
  assert.equal(restored.component.version, '0.1.0')
  assert.equal(restored.component.rollback.version, '0.2.0')
  const state = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(state.components['private-fixture'].version, '0.1.0')
  assert.equal(fake.enabledPlugins('private-fixture')[0].version, '0.1.0')
})

test('private component transitions never enter compatibility-release rollback history', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-private-history-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const fixture = await createToolComponentFixture(join(root, 'private'))
  const dependencies = { runner: fake.runner, codexConfiguration: fake.configuration, hostSkillHome, mcpProbe: healthyProbe, componentWarmup: healthyComponentWarmup, catalogPreflight: healthyCatalogPreflight }
  const paths = await prepareStatePaths(stateRoot)
  const before = await listHistory(paths)

  await importLocalComponent({
    stateRoot, artifact: fixture.artifactPath, binding: fixture.binding,
    activate: false, dryRun: false,
  }, dependencies)
  assert.deepEqual(await listHistory(paths), before)

  await removeLocalComponent({ stateRoot, target: 'private-fixture', dryRun: false }, dependencies)
  assert.deepEqual(await listHistory(paths), before)

  await rollbackLocalComponent({ stateRoot, target: 'private-fixture', dryRun: false }, dependencies)
  assert.deepEqual(await listHistory(paths), before)
  await assert.rejects(
    rollbackInstallation({ stateRoot, dryRun: true }, dependencies),
    (error) => error.code === 'ROLLBACK_UNAVAILABLE',
  )
})

test('private component import dry-run removes every package path it created', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-private-dry-run-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const fixture = await createToolComponentFixture(join(root, 'private'))
  const dependencies = { runner: fake.runner, codexConfiguration: fake.configuration, hostSkillHome, mcpProbe: healthyProbe, componentWarmup: healthyComponentWarmup, catalogPreflight: healthyCatalogPreflight }
  const paths = await prepareStatePaths(stateRoot)
  const before = await loadState(paths)

  const preview = await importLocalComponent({
    stateRoot, artifact: fixture.artifactPath, binding: fixture.binding,
    activate: false, dryRun: true,
  }, dependencies)
  assert.equal(preview.status, 'ready')
  assert.equal(preview.component.installed, false)
  assert.equal(preview.component.active, false)
  assert.equal(preview.component.importedAt, null)
  assert.equal(preview.component.rollback, null)
  assert.deepEqual(await loadState(paths), before)
  await assert.rejects(stat(join(paths.packages, 'private-fixture')), (error) => error.code === 'ENOENT')
})

test('a failed post-commit activity append returns stable warnings and preserves authoritative component state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-private-activity-failure-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const fixture = await createToolComponentFixture(join(root, 'private'))
  const dependencies = {
    runner: fake.runner, codexConfiguration: fake.configuration,
    hostSkillHome,
    mcpProbe: healthyProbe,
    catalogPreflight: healthyCatalogPreflight,
    recordActivity: async () => { throw new Error('injected activity append failure') },
    pruneCodexProjections: async () => { throw new Error('injected projection cleanup failure') },
  }
  const expectedWarnings = [{
    code: 'CODEX_PROJECTION_CLEANUP_FAILED',
    message: 'The private component change succeeded, but stale Codex projection cleanup could not be completed.',
  }, {
    code: 'ACTIVITY_LOG_WRITE_FAILED',
    message: 'The private component change succeeded, but its activity entry could not be recorded.',
  }]

  const imported = await importLocalComponent({
    stateRoot, artifact: fixture.artifactPath, binding: fixture.binding,
    activate: false, dryRun: false,
  }, dependencies)
  assert.equal(imported.status, 'imported')
  assert.deepEqual(imported.warnings, expectedWarnings)
  assert.deepEqual(imported.projectionCleanup, { status: 'not-completed', removed: 0 })
  let state = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(state.privateComponents['private-fixture'].current.binding.archiveSha256, fixture.binding.archiveSha256)
  assert.equal((await stat(state.privateComponents['private-fixture'].current.component.root)).isDirectory(), true)

  const removed = await removeLocalComponent({ stateRoot, target: 'private-fixture', dryRun: false }, dependencies)
  assert.equal(removed.status, 'removed')
  assert.deepEqual(removed.warnings, expectedWarnings)
  state = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(state.privateComponents['private-fixture'].current, null)
  assert.equal((await stat(state.privateComponents['private-fixture'].rollback.component.root)).isDirectory(), true)

  const restored = await rollbackLocalComponent({ stateRoot, target: 'private-fixture', dryRun: false }, dependencies)
  assert.equal(restored.status, 'rolled-back')
  assert.deepEqual(restored.warnings, expectedWarnings)
  state = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(state.privateComponents['private-fixture'].current.binding.archiveSha256, fixture.binding.archiveSha256)
  assert.equal((await stat(state.privateComponents['private-fixture'].current.component.root)).isDirectory(), true)
})

test('private component rollback rejects tampered retained bytes before health or host transition', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-private-rollback-tamper-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const fixture = await createToolComponentFixture(join(root, 'private'))
  const dependencies = { runner: fake.runner, codexConfiguration: fake.configuration, hostSkillHome, mcpProbe: healthyProbe, componentWarmup: healthyComponentWarmup, catalogPreflight: healthyCatalogPreflight }
  await importLocalComponent({
    stateRoot, artifact: fixture.artifactPath, binding: fixture.binding,
    activate: true, dryRun: false,
  }, dependencies)
  await removeLocalComponent({ stateRoot, target: 'private-fixture', dryRun: false }, dependencies)
  const paths = await prepareStatePaths(stateRoot)
  const before = await loadState(paths)
  const retained = before.privateComponents['private-fixture'].rollback.component
  const runtimeEntrypoint = retained.args[0]
  await chmod(runtimeEntrypoint, 0o600)
  await writeFile(runtimeEntrypoint, '// tampered retained runtime\n', 'utf8')
  let probes = 0

  await assert.rejects(
    rollbackLocalComponent({ stateRoot, target: 'private-fixture', dryRun: false }, {
      ...dependencies,
      mcpProbe: () => { probes += 1; return healthyProbe(retained) },
    }),
    (error) => error.code === 'LOCAL_COMPONENT_ROLLBACK_BYTES_UNVERIFIED' && error.details?.cause === 'COMPONENT_FILE_DIGEST_MISMATCH',
  )
  assert.equal(probes, 0)
  assert.deepEqual(await loadState(paths), before)
  assert.equal(fake.enabledPlugins('private-fixture').length > 0, false)
})

test('private component rollback requires a current healthy MCP catalog before host transition', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-private-rollback-health-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const fixture = await createToolComponentFixture(join(root, 'private'))
  const dependencies = { runner: fake.runner, codexConfiguration: fake.configuration, hostSkillHome, mcpProbe: healthyProbe, componentWarmup: healthyComponentWarmup, catalogPreflight: healthyCatalogPreflight }
  await importLocalComponent({
    stateRoot, artifact: fixture.artifactPath, binding: fixture.binding,
    activate: true, dryRun: false,
  }, dependencies)
  await removeLocalComponent({ stateRoot, target: 'private-fixture', dryRun: false }, dependencies)
  const paths = await prepareStatePaths(stateRoot)
  const before = await loadState(paths)

  await assert.rejects(
    rollbackLocalComponent({ stateRoot, target: 'private-fixture', dryRun: false }, {
      ...dependencies,
      mcpProbe: () => { throw Object.assign(new Error('injected unhealthy catalog'), { code: 'TOOL_HEALTH_TOOLS_MISSING' }) },
    }),
    (error) => error.code === 'TOOL_HEALTH_TOOLS_MISSING',
  )
  assert.deepEqual(await loadState(paths), before)
  assert.equal(fake.enabledPlugins('private-fixture').length > 0, false)
})

test('verified storage cleanup retains private component bytes referenced by current and rollback state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-private-storage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { stateRoot, fake, hostSkillHome } = await environment(root)
  const first = await createToolComponentFixture(join(root, 'first'), { version: '0.1.0', marker: 'first' })
  const second = await createToolComponentFixture(join(root, 'second'), { version: '0.2.0', marker: 'second' })
  const dependencies = { runner: fake.runner, codexConfiguration: fake.configuration, hostSkillHome, mcpProbe: healthyProbe, componentWarmup: healthyComponentWarmup, catalogPreflight: healthyCatalogPreflight }
  await importLocalComponent({ stateRoot, artifact: first.artifactPath, binding: first.binding, activate: false, dryRun: false }, dependencies)
  await importLocalComponent({ stateRoot, artifact: second.artifactPath, binding: second.binding, replace: true, dryRun: false }, dependencies)
  await removeLocalComponent({ stateRoot, target: 'private-fixture', dryRun: false }, dependencies)
  const paths = await prepareStatePaths(stateRoot)
  const roots = (await readdir(join(paths.packages, 'private-fixture'))).map((name) => join(paths.packages, 'private-fixture', name))
  for (const packageRoot of roots) await utimes(packageRoot, new Date(0), new Date(0))

  const preview = await cleanupStorage({ stateRoot, dryRun: true })
  assert.equal(preview.plan.packageVersions, 1)
  assert.equal(preview.before.packages.files > 0, true)
  await cleanupStorage({ stateRoot, dryRun: false })
  const state = await loadState(paths)
  const retainedRoot = state.privateComponents['private-fixture'].rollback.component.root
  assert.deepEqual(await readdir(join(paths.packages, 'private-fixture')), [basename(retainedRoot)])
  assert.equal((await stat(retainedRoot)).isDirectory(), true)
})
