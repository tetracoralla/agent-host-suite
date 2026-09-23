import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { componentEnvironment } from '../src/component-environment.mjs'
import { exportManagedCatalogInventory, preflightManagedCatalog } from '../src/context-exporter.mjs'
import { doctor } from '../src/doctor.mjs'
import { probeMcpTools } from '../src/mcp-health.mjs'
import { refreshObservability } from '../src/observability.mjs'
import { runFile } from '../src/process.mjs'
import { exportSkillLinkCatalog } from '../src/skill-link-catalog.mjs'
import { loadState, prepareStatePaths, saveState } from '../src/state.mjs'

const server = fileURLToPath(new URL('./fixtures/workspace-provider.mjs', import.meta.url))
const cli = fileURLToPath(new URL('../bin/agent-host.mjs', import.meta.url))

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-host-probe-grants-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const paths = await prepareStatePaths(join(root, 'state'))
  const [installed, workspaceRoot, nextWorkspace, extraOne, extraTwo] = ['installed', 'workspace', 'next', 'extra-one', 'extra-two'].map((name) => join(root, name))
  for (const [directory, contents] of [[installed, 'not the grant'], [workspaceRoot, 'first input'], [nextWorkspace, 'second input'], [extraOne, 'one'], [extraTwo, 'two']]) {
    await mkdir(directory)
    await writeFile(join(directory, 'input.txt'), contents)
  }
  const trace = join(root, 'started.jsonl')
  const component = {
    version: '0.7.0', fingerprint: 'probe-fixture', displayName: 'Workspace fixture',
    toolIntegrationSchema: 'openadam.agent-host-tool-integration.v0.5', identityFiles: [],
    command: process.execPath, args: [server, trace], cwd: installed, root: installed, pluginRoot: installed,
    workspaceEnvironment: ['PROVIDER_FIXTURE_WORKSPACE'],
    optionalPathEnvironment: ['PROVIDER_FIXTURE_EXTRA_ROOTS'],
    pathGrants: { PROVIDER_FIXTURE_EXTRA_ROOTS: [extraOne, extraTwo] },
    expectedTools: ['armorial.select'], healthTimeoutMs: 5000,
  }
  const configPath = join(paths.runtime, 'provider-config.json')
  await writeFile(configPath, JSON.stringify({ schemaVersion: 'openadam.direct-provider-config.v0.2', providers: [] }))
  const state = {
    schemaVersion: 'openadam.agent-host-state.v0.2', suiteVersion: '0.2.0', channel: 'development', profile: 'standard',
    installedAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z',
    workspaceRoot, components: { fixture: component }, agentComponents: ['fixture'],
    hosts: {}, runtime: { configPath, service: null }, observability: { enabled: false },
  }
  await saveState(paths, state)
  return { paths, trace, component, state, workspaceRoot, nextWorkspace }
}

const routes = {
  health: async ({ component, state }) => probeMcpTools({ ...component, healthWorkspaceRoot: state.workspaceRoot }),
  admission: async ({ component, state }) => preflightManagedCatalog({ fixture: component }, { workspaceRoot: state.workspaceRoot }),
  inventory: async ({ component, state }) => exportManagedCatalogInventory({ fixture: component }, { workspaceRoot: state.workspaceRoot }),
  links: async ({ paths }) => exportSkillLinkCatalog({ stateRoot: paths.root }),
  doctor: async ({ state }) => {
    const result = await doctor(state, { deep: true, inspectAgentApps: false })
    const check = result.checks.find((item) => item.id === 'tool.fixture.installed')
    if (check.status === 'error') throw Object.assign(new Error('Provider health failed'), check.detail)
    return check
  },
}

for (const [name, probe] of Object.entries(routes)) {
  test(`${name} uses the explicit workspace and optional roots, including after a grant change`, async (t) => {
    const data = await fixture(t)
    for (const workspaceRoot of [data.workspaceRoot, data.nextWorkspace]) {
      data.state.workspaceRoot = workspaceRoot
      await saveState(data.paths, data.state)
      await probe(data)
      const observed = (await readFile(data.trace, 'utf8')).trim().split('\n').map(JSON.parse).at(-1)
      assert.deepEqual(observed, {
        workspace: workspaceRoot,
        extraRoots: data.component.pathGrants.PROVIDER_FIXTURE_EXTRA_ROOTS.join(delimiter),
        cwd: data.component.cwd,
      })
    }
  })

  test(`${name} refuses an absent workspace before starting the Provider`, async (t) => {
    const data = await fixture(t)
    data.state.workspaceRoot = null
    await saveState(data.paths, data.state)
    await assert.rejects(probe(data), { code: 'WORKSPACE_GRANT_REQUIRED' })
    await assert.rejects(readFile(data.trace), { code: 'ENOENT' })
    assert.deepEqual(await loadState(data.paths), data.state)
  })
}

test('one environment mapper rejects missing required grants but preserves optional omission', () => {
  for (const workspaceRoot of [undefined, null, '', 'relative', 42]) {
    assert.throws(() => componentEnvironment({ workspaceEnvironment: ['PROVIDER_FIXTURE_WORKSPACE'] }, workspaceRoot), { code: 'WORKSPACE_GRANT_REQUIRED' })
  }
  assert.deepEqual(componentEnvironment({ optionalPathEnvironment: ['PROVIDER_FIXTURE_EXTRA_ROOTS'] }, null), {})
})

test('shipped catalog CLI observes the saved grant and fails closed without it', async (t) => {
  const data = await fixture(t)
  const invoke = () => runFile(process.execPath, [cli, 'catalog', '--state-root', data.paths.root, '--json'], { allowFailure: true, timeoutMs: 10000 })
  const first = await invoke()
  assert.equal(first.status, 0, first.stderr)
  const catalog = JSON.parse(first.stdout)
  assert.equal(catalog.entries[0].identity, 'armorial.select')
  const before = await readFile(data.trace, 'utf8')
  data.state.workspaceRoot = null
  await saveState(data.paths, data.state)
  const missing = await invoke()
  assert.notEqual(missing.status, 0)
  assert.equal(missing.stdout, '')
  assert.equal(JSON.parse(missing.stderr).error.code, 'WORKSPACE_GRANT_REQUIRED')
  assert.equal(await readFile(data.trace, 'utf8'), before)
})

test('probe routes do not turn ambient variables into workspace or optional path grants', async (t) => {
  const data = await fixture(t)
  const variables = ['PROVIDER_FIXTURE_WORKSPACE', 'PROVIDER_FIXTURE_EXTRA_ROOTS']
  const previous = variables.map((name) => process.env[name])
  t.after(() => variables.forEach((name, index) => {
    if (previous[index] === undefined) delete process.env[name]
    else process.env[name] = previous[index]
  }))
  for (const name of variables) process.env[name] = data.nextWorkspace
  data.component.pathGrants = {}
  await saveState(data.paths, data.state)
  for (const probe of Object.values(routes)) await probe(data)
  const observed = (await readFile(data.trace, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(observed.length, Object.keys(routes).length)
  assert.equal(observed.every((item) => item.workspace === data.workspaceRoot && item.extraRoots === null), true)
  data.state.workspaceRoot = null
  await saveState(data.paths, data.state)
  for (const probe of Object.values(routes)) await assert.rejects(probe(data), { code: 'WORKSPACE_GRANT_REQUIRED' })
  assert.equal((await readFile(data.trace, 'utf8')).trim().split('\n').length, observed.length)
})

test('monitoring refresh measures the current granted Provider and preserves state on missing authority', async (t) => {
  const data = await fixture(t)
  const analyzerRoot = fileURLToPath(new URL('../packages/context-surface-analyzer/', import.meta.url))
  data.state.components['context-surface-analyzer'] = {
    version: '0.1.2', root: analyzerRoot, command: process.execPath, args: [join(analyzerRoot, 'src/cli.js')],
  }
  data.state.components['agent-tool-observer'] = { version: '0.6.4', root: data.paths.root, command: 'observer-fixture', args: [] }
  data.state.observability = { enabled: true, observer: { stateDir: join(data.paths.root, 'observer-fixture') } }
  const runner = async (command, args, options) => {
    if (command === process.execPath) return runFile(command, args, options)
    assert.equal(command, 'observer-fixture')
    assert.equal(['collect', 'ingest-context-surface', 'ingest-agent-host-deployment', 'status', 'report'].includes(args[0]), true)
    const result = args[0] === 'report'
      ? { schemaVersion: 'openadam.agent-tool-observer.report.v0.9', tools: [], semanticExecutions: [] }
      : { status: 'ok' }
    return { status: 0, stdout: JSON.stringify(result), stderr: '' }
  }
  for (const [workspaceRoot, value] of [[data.workspaceRoot, 'first input'], [data.nextWorkspace, 'second input']]) {
    data.state.workspaceRoot = workspaceRoot
    await saveState(data.paths, data.state)
    const result = await refreshObservability({ stateRoot: data.paths.root }, { runner })
    assert.equal(result.status, 'refreshed')
    const snapshot = JSON.parse(await readFile(join(data.paths.context, 'managed-catalog.snapshot.json'), 'utf8'))
    assert.equal(snapshot.tools[0].outputSchema.properties.value.const, value)
    const saved = await loadState(data.paths)
    assert.equal(saved.observability.latest.context.counts.tools, 1)
  }
  data.state.workspaceRoot = null
  await saveState(data.paths, data.state)
  const startedBefore = await readFile(data.trace, 'utf8')
  await assert.rejects(refreshObservability({ stateRoot: data.paths.root }, { runner }), (error) =>
    error.code === 'OBSERVABILITY_REFRESH_FAILED' && error.details.effects.hostStateCommitted === false)
  assert.deepEqual(await loadState(data.paths), data.state)
  assert.equal(await readFile(data.trace, 'utf8'), startedBefore)
})
