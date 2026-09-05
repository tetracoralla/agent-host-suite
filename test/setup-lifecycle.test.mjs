import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { addHost, hostStateOutsideManifest, hostStatus, removeHost, safePurgeRoot, setActiveTools, toolSetStatus, uninstallInstallation, updateInstallation, rollbackInstallation } from '../src/lifecycle.mjs'
import { setup } from '../src/setup.mjs'
import { loadState, prepareStatePaths, saveState } from '../src/state.mjs'
import { listActivity } from '../src/activity.mjs'
import { compatibleApplicationState, createCodexRunner, createDevelopmentWorkspace, healthyCatalogPreflight } from './helpers.mjs'

const cliPath = fileURLToPath(new URL('../bin/agent-host.mjs', import.meta.url))

function lifecycleDependencies(fake, stateRoot, values = {}) {
  return {
    runner: fake.runner,
    hostSkillHome: join(stateRoot, 'host-home'),
    catalogPreflight: healthyCatalogPreflight,
    applicationStatePreflight: compatibleApplicationState,
    ...values,
  }
}

test('setup, no-op update, and uninstall preserve host ownership without manufacturing a rollback', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-workspace-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-state-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stateRoot, { recursive: true, force: true })]))
  await createDevelopmentWorkspace(root)
  const fake = createCodexRunner({ mathPresent: false, timePresent: false })
  const result = await setup({ profile: 'standard', hosts: ['codex'], developmentRoot: root, stateRoot, noService: true, dryRun: false, enableObservability: false }, lifecycleDependencies(fake, stateRoot))
  assert.equal(result.status, 'installed')
  const paths = await prepareStatePaths(stateRoot)
  const installedState = await loadState(paths)
  const packageVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version
  assert.equal(installedState.profile, 'standard')
  assert.equal(installedState.suiteVersion, packageVersion)
  const statusResult = spawnSync(process.execPath, [cliPath, 'status', '--state-root', stateRoot, '--json'], { encoding: 'utf8' })
  assert.equal(statusResult.status, 0, statusResult.stderr)
  assert.equal(JSON.parse(statusResult.stdout).suiteVersion, packageVersion)
  assert.equal((await updateInstallation({ stateRoot, dryRun: false }, lifecycleDependencies(fake, stateRoot))).status, 'updated')
  await assert.rejects(
    rollbackInstallation({ stateRoot, dryRun: false }, lifecycleDependencies(fake, stateRoot)),
    (error) => error.code === 'ROLLBACK_UNAVAILABLE',
  )
  assert.deepEqual((await listActivity(paths)).map((entry) => entry.type), [
    'environment.updated',
    'environment.installed',
  ])
  const removed = await uninstallInstallation({ stateRoot, purgeData: false }, { runner: fake.runner })
  assert.equal(removed.status, 'uninstalled')
  assert.equal(await loadState(paths), null)
  assert.equal(fake.plugins.size, 0)
  assert.equal((await listActivity(paths))[0].type, 'environment.uninstalled')
})

test('a failed post-commit setup activity append returns a warning without rolling back the installation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-post-commit-setup-workspace-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-post-commit-setup-state-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stateRoot, { recursive: true, force: true })]))
  await createDevelopmentWorkspace(root)
  const fake = createCodexRunner({ mathPresent: false, timePresent: false })
  const result = await setup(
    { profile: 'standard', hosts: ['codex'], developmentRoot: root, stateRoot, noService: true, dryRun: false, enableObservability: false },
    lifecycleDependencies(fake, stateRoot, {
      recordActivity: async () => { throw new Error('injected activity append failure') },
    }),
  )
  assert.equal(result.status, 'installed')
  assert.deepEqual(result.warnings, [{
    code: 'ACTIVITY_LOG_WRITE_FAILED',
    message: 'The Agent Host installation succeeded, but its activity entry could not be recorded.',
  }])
  const paths = await prepareStatePaths(stateRoot)
  assert.equal((await loadState(paths)).profile, 'standard')
  assert.equal(fake.plugins.has('math-anchor@math-anchor'), true)
})

test('a failed uninstall activity append returns a warning without leaving installed state behind', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-post-commit-uninstall-workspace-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-post-commit-uninstall-state-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stateRoot, { recursive: true, force: true })]))
  await createDevelopmentWorkspace(root)
  const fake = createCodexRunner({ mathPresent: false, timePresent: false })
  await setup(
    { profile: 'standard', hosts: ['codex'], developmentRoot: root, stateRoot, noService: true, dryRun: false, enableObservability: false },
    lifecycleDependencies(fake, stateRoot),
  )
  const result = await uninstallInstallation({ stateRoot, purgeData: false }, {
    runner: fake.runner,
    recordActivity: async () => { throw new Error('injected activity append failure') },
  })
  assert.equal(result.status, 'uninstalled')
  assert.deepEqual(result.warnings, [{
    code: 'ACTIVITY_LOG_WRITE_FAILED',
    message: 'Agent Host was removed, but its activity entry could not be recorded.',
  }])
  const paths = await prepareStatePaths(stateRoot)
  assert.equal(await loadState(paths), null)
  assert.equal(fake.plugins.size, 0)
})

test('uninstall restores the prior Host and state when its final state archive fails', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-uninstall-compensation-workspace-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-uninstall-compensation-state-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stateRoot, { recursive: true, force: true })]))
  await createDevelopmentWorkspace(root)
  const fake = createCodexRunner({ mathPresent: false, timePresent: false })
  const dependencies = lifecycleDependencies(fake, stateRoot)
  await setup({ profile: 'standard', hosts: ['codex'], developmentRoot: root, stateRoot, noService: true, dryRun: false, enableObservability: false }, dependencies)
  const paths = await prepareStatePaths(stateRoot)
  const before = await loadState(paths)
  const pluginsBefore = new Map(fake.plugins)
  const marketplacesBefore = new Map(fake.marketplaces)

  await assert.rejects(
    uninstallInstallation({ stateRoot, purgeData: false }, {
      ...dependencies,
      archiveAndRemoveState: async () => { throw new Error('injected uninstall archive failure') },
    }),
    /injected uninstall archive failure/u,
  )

  assert.deepEqual(await loadState(paths), before)
  assert.deepEqual(new Map(fake.plugins), pluginsBefore)
  assert.deepEqual(new Map(fake.marketplaces), marketplacesBefore)
})

test('Agent app add compensates its external binding when state commit fails', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-add-compensation-workspace-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-add-compensation-state-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stateRoot, { recursive: true, force: true })]))
  await createDevelopmentWorkspace(root)
  const fake = createCodexRunner({ mathPresent: false, timePresent: false })
  await setup({ profile: 'standard', hosts: ['codex'], developmentRoot: root, stateRoot, noService: true, dryRun: false, enableObservability: false }, lifecycleDependencies(fake, stateRoot))
  await removeHost({ stateRoot, target: 'codex' }, lifecycleDependencies(fake, stateRoot))
  const paths = await prepareStatePaths(stateRoot)
  const before = await loadState(paths)

  await assert.rejects(
    addHost({ stateRoot, target: 'codex' }, lifecycleDependencies(fake, stateRoot, {
      saveState: async () => { throw new Error('injected host add commit failure') },
    })),
    /injected host add commit failure/u,
  )

  assert.deepEqual(await loadState(paths), before)
  assert.equal(fake.plugins.size, 0)
  assert.equal(fake.marketplaces.size, 0)
})

test('Agent app remove restores its external binding when state commit fails', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-remove-compensation-workspace-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-remove-compensation-state-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stateRoot, { recursive: true, force: true })]))
  await createDevelopmentWorkspace(root)
  const fake = createCodexRunner({ mathPresent: false, timePresent: false })
  await setup({ profile: 'standard', hosts: ['codex'], developmentRoot: root, stateRoot, noService: true, dryRun: false, enableObservability: false }, lifecycleDependencies(fake, stateRoot))
  const paths = await prepareStatePaths(stateRoot)
  const before = await loadState(paths)
  const pluginsBefore = new Map(fake.plugins)
  const marketplacesBefore = new Map(fake.marketplaces)

  await assert.rejects(
    removeHost({ stateRoot, target: 'codex' }, lifecycleDependencies(fake, stateRoot, {
      saveState: async () => { throw new Error('injected host remove commit failure') },
    })),
    /injected host remove commit failure/u,
  )

  assert.deepEqual(await loadState(paths), before)
  assert.deepEqual(new Map(fake.plugins), pluginsBefore)
  assert.deepEqual(new Map(fake.marketplaces), marketplacesBefore)
})

test('Agent app removal does not require its retained workspace grant to still exist', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-remove-stale-workspace-source-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-remove-stale-workspace-state-'))
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-host-remove-stale-workspace-grant-'))
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(stateRoot, { recursive: true, force: true }),
    rm(workspaceRoot, { recursive: true, force: true }),
  ]))
  await createDevelopmentWorkspace(root)
  const fake = createCodexRunner({ mathPresent: false, timePresent: false })
  await setup({
    profile: 'standard', hosts: ['codex'], developmentRoot: root, stateRoot,
    workspaceRoot, noService: true, dryRun: false, enableObservability: false,
  }, lifecycleDependencies(fake, stateRoot))
  await rm(workspaceRoot, { recursive: true, force: true })

  const result = await removeHost({ stateRoot, target: 'codex' }, lifecycleDependencies(fake, stateRoot))

  assert.equal(result.status, 'host-removed')
  assert.equal(fake.plugins.size, 0)
  assert.equal(fake.marketplaces.size, 0)
  assert.equal((await loadState(await prepareStatePaths(stateRoot))).hosts.codex, undefined)
})

test('Agent app removal still rejects an unsafe retained workspace grant', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-remove-unsafe-workspace-source-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-remove-unsafe-workspace-state-'))
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-host-remove-unsafe-workspace-grant-'))
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(stateRoot, { recursive: true, force: true }),
    rm(workspaceRoot, { recursive: true, force: true }),
  ]))
  await createDevelopmentWorkspace(root)
  const fake = createCodexRunner({ mathPresent: false, timePresent: false })
  await setup({
    profile: 'standard', hosts: ['codex'], developmentRoot: root, stateRoot,
    workspaceRoot, noService: true, dryRun: false, enableObservability: false,
  }, lifecycleDependencies(fake, stateRoot))
  const paths = await prepareStatePaths(stateRoot)
  const state = await loadState(paths)
  await saveState(paths, { ...state, workspaceRoot: 'relative/workspace' })

  await assert.rejects(
    removeHost({ stateRoot, target: 'codex' }, lifecycleDependencies(fake, stateRoot)),
    (error) => error.code === 'WORKSPACE_ROOT_INVALID',
  )
  assert.equal(fake.plugins.size, 3)
  assert.notEqual((await loadState(paths)).hosts.codex, undefined)
})

test('setup reports cleanup failure and retains ownership facts instead of swallowing it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-setup-compound-workspace-'))
  const stateParent = await mkdtemp(join(tmpdir(), 'agent-host-setup-compound-state-'))
  const stateRoot = join(stateParent, 'private', 'state')
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stateParent, { recursive: true, force: true })]))
  await createDevelopmentWorkspace(root)
  const fake = createCodexRunner({ mathPresent: false, timePresent: false })

  await assert.rejects(
    setup({ profile: 'standard', hosts: ['codex'], developmentRoot: root, stateRoot, noService: true, dryRun: false, enableObservability: false }, lifecycleDependencies(fake, stateRoot, {
      saveState: async () => { throw new Error('injected setup commit failure') },
      uninstallHost: async () => { throw new Error('injected setup cleanup failure') },
    })),
    (error) => error.code === 'SETUP_ROLLBACK_FAILED'
      && error.details.setup === 'injected setup commit failure'
      && error.details.rollback.some((entry) => entry.step === 'host.codex.uninstall' && entry.message === 'injected setup cleanup failure'),
  )
  await access(stateRoot)
})

test('a clean failed first setup removes its newly published private state root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-setup-clean-failure-workspace-'))
  const stateParent = await mkdtemp(join(tmpdir(), 'agent-host-setup-clean-failure-state-'))
  const stateRoot = join(stateParent, 'private', 'state')
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stateParent, { recursive: true, force: true })]))
  await createDevelopmentWorkspace(root)
  const fake = createCodexRunner({ mathPresent: false, timePresent: false })

  await assert.rejects(
    setup({ profile: 'standard', hosts: ['codex'], developmentRoot: root, stateRoot, noService: true, dryRun: false, enableObservability: false }, lifecycleDependencies(fake, stateRoot, {
      saveState: async () => { throw new Error('injected setup commit failure') },
    })),
    /injected setup commit failure/u,
  )
  await assert.rejects(() => access(stateRoot), (error) => error.code === 'ENOENT')
})

test('successful read-only lifecycle no-ops do not leave a newly published private state scaffold', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-empty-lifecycle-workspace-'))
  const stateParent = await mkdtemp(join(tmpdir(), 'agent-host-empty-lifecycle-state-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stateParent, { recursive: true, force: true })]))
  await createDevelopmentWorkspace(root)
  const fake = createCodexRunner({ mathPresent: false, timePresent: false })

  const setupStateRoot = join(stateParent, 'setup', 'private', 'state')
  const preview = await setup(
    { profile: 'standard', hosts: ['codex'], developmentRoot: root, stateRoot: setupStateRoot, noService: true, dryRun: true, enableObservability: false },
    lifecycleDependencies(fake, setupStateRoot),
  )
  assert.equal(preview.status, 'ready')
  await assert.rejects(() => access(setupStateRoot), (error) => error.code === 'ENOENT')

  const uninstallStateRoot = join(stateParent, 'uninstall', 'private', 'state')
  const absent = await uninstallInstallation({ stateRoot: uninstallStateRoot, purgeData: false }, { runner: fake.runner })
  assert.equal(absent.status, 'not-installed')
  await assert.rejects(() => access(uninstallStateRoot), (error) => error.code === 'ENOENT')
})

test('public setup fails closed while the release catalog is unbound', async () => {
  await assert.rejects(
    setup({ profile: 'standard', hosts: [], noService: true, dryRun: true, enableObservability: false }),
    (error) => error.code === 'RELEASE_UNBOUND',
  )
})

test('developer profile refuses a mutable development-root CLI', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-developer-source-root-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-developer-source-state-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stateRoot, { recursive: true, force: true })]))
  await createDevelopmentWorkspace(root)
  await assert.rejects(
    setup({ profile: 'developer', hosts: [], developmentRoot: root, stateRoot, noService: true, dryRun: true, enableObservability: false }),
    (error) => error.code === 'DEVELOPER_PROFILE_RELEASE_REQUIRED',
  )
})

test('quick host status detects the executable without starting the Agent app CLI', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-quick-status-workspace-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-quick-status-state-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stateRoot, { recursive: true, force: true })]))
  await createDevelopmentWorkspace(root)
  const fake = createCodexRunner({ mathPresent: false, timePresent: false })
  await setup({ profile: 'standard', hosts: ['codex'], developmentRoot: root, stateRoot, noService: true, dryRun: false, enableObservability: false }, lifecycleDependencies(fake, stateRoot))
  const before = fake.calls.length
  const result = await hostStatus({ stateRoot, target: 'codex', quick: true }, { runner: fake.runner })
  const quickCalls = fake.calls.slice(before)
  assert.equal(result.status, 'ok')
  assert.equal(result.managed, true)
  assert.equal(result.healthy, null)
  assert.deepEqual(quickCalls.map((call) => [call.command, ...call.args]), [process.platform === 'win32' ? ['where.exe', 'codex'] : ['/usr/bin/env', 'which', 'codex']])
})

test('purge-data removes the private state root for a deep state root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-workspace-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-state-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stateRoot, { recursive: true, force: true })]))
  await createDevelopmentWorkspace(root)
  const fake = createCodexRunner({ mathPresent: false, timePresent: false })
  await setup({ profile: 'standard', hosts: ['codex'], developmentRoot: root, stateRoot, noService: true, dryRun: false, enableObservability: false }, lifecycleDependencies(fake, stateRoot))
  const purged = await uninstallInstallation({ stateRoot, purgeData: true }, { runner: fake.runner })
  assert.equal(purged.status, 'uninstalled')
  assert.equal(purged.purgeData, true)
  assert.equal(purged.archive, null)
  await assert.rejects(access(stateRoot))
})

test('purge-data refuses filesystem roots, home, and shallow state roots', async () => {
  assert.equal(safePurgeRoot('relative/path/state'), false)
  assert.equal(safePurgeRoot(join(homedir(), '..', '..', '..', '..', '..')), false)
  assert.equal(safePurgeRoot('/'), false)
  assert.equal(safePurgeRoot('/private/tmp'), false)
  assert.equal(safePurgeRoot('/tmp/one-level'), false)
  assert.equal(safePurgeRoot(homedir()), false)
  assert.equal(safePurgeRoot(join(homedir(), 'Library/Application Support/OpenAdam/Agent Host Suite')), true)
})

test('profile transitions identify host bindings outside the target manifest', () => {
  const current = {
    kind: 'codex',
    entries: [
      { selector: 'math-anchor@openadam' },
      { selector: 'migratory-time@migratory-time' },
      { selector: 'file-vitals@file-vitals-local', pluginCreated: true },
    ],
  }
  const manifest = {
    components: {
      math: { plugin: 'math-anchor', marketplace: 'openadam' },
      time: { plugin: 'migratory-time', marketplace: 'migratory-time' },
    },
  }
  assert.deepEqual(hostStateOutsideManifest('codex', current, manifest)?.entries, [
    { selector: 'file-vitals@file-vitals-local', pluginCreated: true },
  ])
  const claude = {
    kind: 'claude',
    entries: [
      { component: 'math-anchor' },
      { component: 'migratory-time', created: true },
    ],
  }
  assert.deepEqual(hostStateOutsideManifest('claude', claude, { components: { 'math-anchor': {} } })?.entries, [
    { component: 'migratory-time', created: true },
  ])
})

test('the installed tool working set changes Codex exposure without removing package inventory or release rollback', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-tool-set-workspace-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-tool-set-state-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stateRoot, { recursive: true, force: true })]))
  await createDevelopmentWorkspace(root)
  const fake = createCodexRunner({ mathPresent: false, timePresent: false })
  await setup({ profile: 'standard', hosts: ['codex'], developmentRoot: root, stateRoot, noService: true, dryRun: false, enableObservability: false }, lifecycleDependencies(fake, stateRoot))

  const preview = await setActiveTools({ stateRoot, tools: ['math-anchor'], dryRun: true }, lifecycleDependencies(fake, stateRoot))
  assert.equal(preview.status, 'ready')
  assert.deepEqual(preview.activeAgentComponents, ['math-anchor'])
  assert.equal(fake.plugins.has('migratory-time@migratory-time'), true)

  const changed = await setActiveTools({ stateRoot, tools: ['math-anchor'], dryRun: false }, lifecycleDependencies(fake, stateRoot))
  assert.equal(changed.status, 'tool-set-updated')
  assert.equal(changed.restartRequired, true)
  assert.equal(fake.plugins.has('math-anchor@math-anchor'), true)
  assert.equal(fake.plugins.has('migratory-time@migratory-time'), false)
  const paths = await prepareStatePaths(stateRoot)
  const state = await loadState(paths)
  assert.deepEqual(state.availableAgentComponents, ['math-anchor', 'migratory-time'])
  assert.deepEqual(state.agentComponents, ['math-anchor'])
  assert.equal(typeof state.bindingsActivatedAt, 'string')
  assert.equal(state.components['migratory-time'] !== undefined, true)
  assert.deepEqual((await toolSetStatus({ stateRoot })).inactiveAgentComponents, ['migratory-time'])

  const reset = await setActiveTools({ stateRoot, resetTools: true, dryRun: false }, lifecycleDependencies(fake, stateRoot))
  assert.deepEqual(reset.activeAgentComponents, ['math-anchor', 'migratory-time'])
  assert.equal(fake.plugins.has('migratory-time@migratory-time'), true)
  assert.equal((await listActivity(paths))[0].type, 'tool-set.changed')
})

test('the local profile reset restores its small default instead of activating the installed inventory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-local-default-workspace-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-local-default-state-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stateRoot, { recursive: true, force: true })]))
  await createDevelopmentWorkspace(root)
  const fake = createCodexRunner({ mathPresent: false, timePresent: false })
  await setup({ profile: 'standard', hosts: ['codex'], developmentRoot: root, stateRoot, noService: true, dryRun: false, enableObservability: false }, lifecycleDependencies(fake, stateRoot))

  const paths = await prepareStatePaths(stateRoot)
  const state = await loadState(paths)
  await saveState(paths, { ...state, profile: 'local-dogfood' })

  const reset = await setActiveTools({ stateRoot, resetTools: true, dryRun: false }, lifecycleDependencies(fake, stateRoot))
  assert.deepEqual(reset.defaultAgentComponents, ['math-anchor'])
  assert.deepEqual(reset.activeAgentComponents, ['math-anchor'])
  assert.deepEqual(reset.inactiveAgentComponents, ['migratory-time'])
  assert.equal(fake.plugins.has('math-anchor@math-anchor'), true)
  assert.equal(fake.plugins.has('migratory-time@migratory-time'), false)
})

test('an over-budget tool set is rejected before host bindings or saved state change', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-tool-budget-workspace-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-tool-budget-state-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stateRoot, { recursive: true, force: true })]))
  await createDevelopmentWorkspace(root)
  const fake = createCodexRunner({ mathPresent: false, timePresent: false })
  await setup({ profile: 'standard', hosts: ['codex'], developmentRoot: root, stateRoot, noService: true, dryRun: false, enableObservability: false }, lifecycleDependencies(fake, stateRoot))
  await setActiveTools({ stateRoot, tools: ['math-anchor'], dryRun: false }, lifecycleDependencies(fake, stateRoot))
  const paths = await prepareStatePaths(stateRoot)
  const stateBefore = await loadState(paths)
  const callsBefore = fake.calls.length

  await assert.rejects(
    setActiveTools({ stateRoot, resetTools: true, dryRun: false }, lifecycleDependencies(fake, stateRoot, {
      catalogPreflight: async () => { throw Object.assign(new Error('catalog exceeds budget'), { code: 'AGENT_TOOL_CATALOG_BUDGET_EXCEEDED' }) },
    })),
    (error) => error.code === 'AGENT_TOOL_CATALOG_BUDGET_EXCEEDED',
  )
  assert.equal(fake.calls.length, callsBefore)
  assert.deepEqual(await loadState(paths), stateBefore)
  assert.equal(fake.plugins.has('migratory-time@migratory-time'), false)
})

test('an inactive tool stays absent instead of restoring a displaced source-checkout plugin', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-tool-set-source-workspace-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-tool-set-source-state-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stateRoot, { recursive: true, force: true })]))
  const workspace = await createDevelopmentWorkspace(root)
  const fake = createCodexRunner({
    mathPresent: true,
    timePresent: false,
    mathMarketplace: 'math-anchor',
    mathMarketplaceRoot: workspace.math,
  })
  await setup({
    profile: 'standard', hosts: ['codex'], developmentRoot: root, stateRoot,
    noService: true, dryRun: false, enableObservability: false, replaceHostConflicts: true,
  }, lifecycleDependencies(fake, stateRoot))

  await setActiveTools({ stateRoot, tools: ['migratory-time'], dryRun: false }, lifecycleDependencies(fake, stateRoot))
  assert.equal(fake.plugins.has('math-anchor@math-anchor'), false)
  assert.equal(fake.marketplaces.has('math-anchor'), false)
  const inactive = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(inactive.hosts.codex.inactiveEntries.some((entry) => entry.selector === 'math-anchor@math-anchor' && entry.displacedMarketplace === workspace.math), true)

  const updated = await updateInstallation(
    { stateRoot, dryRun: false, replaceHostConflicts: true },
    lifecycleDependencies(fake, stateRoot),
  )
  assert.equal(updated.status, 'updated')
  assert.equal(fake.plugins.has('math-anchor@math-anchor'), false)
  assert.equal(fake.marketplaces.has('math-anchor'), false)
  const updatedInactive = await loadState(await prepareStatePaths(stateRoot))
  assert.equal(updatedInactive.hosts.codex.inactiveEntries.some((entry) => entry.selector === 'math-anchor@math-anchor' && entry.displacedMarketplace === workspace.math), true)

  await setActiveTools({ stateRoot, resetTools: true, dryRun: false }, lifecycleDependencies(fake, stateRoot))
  assert.equal(fake.plugins.has('math-anchor@math-anchor'), true)
  assert.notEqual(fake.marketplaces.get('math-anchor'), workspace.math)

  await uninstallInstallation({ stateRoot, purgeData: false }, { runner: fake.runner })
  assert.equal(fake.plugins.has('math-anchor@math-anchor'), true)
  assert.equal(fake.marketplaces.get('math-anchor'), workspace.math)
})

test('unsafe purge-data is rejected before any installed state or host binding changes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-workspace-'))
  const stateRoot = `/tmp/agent-host-purge-preflight-${process.pid}`
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stateRoot, { recursive: true, force: true })]))
  await createDevelopmentWorkspace(root)
  const fake = createCodexRunner({ mathPresent: false, timePresent: false })
  await setup({ profile: 'standard', hosts: ['codex'], developmentRoot: root, stateRoot, noService: true, dryRun: false, enableObservability: false }, lifecycleDependencies(fake, stateRoot))
  const paths = await prepareStatePaths(stateRoot)
  await assert.rejects(
    uninstallInstallation({ stateRoot, purgeData: true }, { runner: fake.runner }),
    (error) => error.code === 'PURGE_ROOT_UNSAFE',
  )
  assert.notEqual(await loadState(paths), null)
  assert.equal(fake.plugins.size, 3)
  assert.equal(fake.marketplaces.size, 3)
})

test('a tool-set change whose activation and rollback both fail surfaces a dedicated rollback error and saves no state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-tool-set-rollback-workspace-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-tool-set-rollback-state-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stateRoot, { recursive: true, force: true })]))
  await createDevelopmentWorkspace(root)
  const fake = createCodexRunner({ mathPresent: false, timePresent: false })
  await setup({ profile: 'standard', hosts: ['codex'], developmentRoot: root, stateRoot, noService: true, dryRun: false, enableObservability: false }, lifecycleDependencies(fake, stateRoot))
  // Suspend migratory-time so the next change must re-add it through `plugin add`.
  await setActiveTools({ stateRoot, tools: ['math-anchor'], dryRun: false }, lifecycleDependencies(fake, stateRoot))

  const base = fake.runner
  const failing = async (command, args, options = {}) => {
    if (command === '/fake/codex' && args[0] === 'plugin' && args[1] === 'add') {
      throw new Error('plugin admission unavailable')
    }
    return base(command, args, options)
  }
  const paths = await prepareStatePaths(stateRoot)
  const before = await loadState(paths)

  await assert.rejects(
    setActiveTools({ stateRoot, tools: ['migratory-time'], dryRun: false }, lifecycleDependencies(fake, stateRoot, { runner: failing })),
    (error) => error.code === 'TOOL_SET_CHANGE_ROLLBACK_FAILED'
      && error.details.change.includes('plugin admission unavailable')
      && error.details.rollback.includes('plugin admission unavailable'),
  )
  assert.deepEqual(await loadState(paths), before)
})
