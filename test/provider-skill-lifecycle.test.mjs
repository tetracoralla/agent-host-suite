import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { addHost, grantWorkspace, removeHost, rollbackInstallation, setActiveTools, uninstallInstallation, updateInstallation } from '../src/lifecycle.mjs'
import { preflightManagedCatalog } from '../src/context-exporter.mjs'
import { warmInstalledAgentComponents } from '../src/component-warmup.mjs'
import { inspectCodex } from '../src/hosts/codex.mjs'
import { hostFacingManifest } from '../src/profile.mjs'
import { setup } from '../src/setup.mjs'
import { loadState, prepareStatePaths } from '../src/state.mjs'
import { compatibleApplicationState, createClaudeRunner, createCodexRunner, healthyCatalogPreflight } from './helpers.mjs'
import { runSkillLauncher } from './launcher-helpers.mjs'
import { createReleaseFixture } from './release-helpers.mjs'

for (const host of ['codex', 'claude', 'zcode']) {
  test(`${host} setup, on-demand, grant recovery, update and rollback preserve MCP and CLI authority`, async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-host-provider-lifecycle-')))
    t.after(() => rm(root, { recursive: true, force: true }))
    const workspaceRoot = join(root, 'first-workspace')
    const nextWorkspace = join(root, 'second-workspace')
    await mkdir(workspaceRoot)
    await mkdir(nextWorkspace)
    await writeFile(join(workspaceRoot, 'input.txt'), 'first input')
    await writeFile(join(nextWorkspace, 'input.txt'), 'second input')
    const releaseManifest = await createReleaseFixture(join(root, 'release'), {
      suiteVersion: '0.2.0', releaseId: 'provider-workspace-fixture', marker: 'provider-workspace',
      includeArmorial: true, armorialWorkspace: true,
    })
    const fake = host === 'codex'
      ? createCodexRunner({ mathPresent: false, timePresent: false, mathVersion: '0.4.0', mathMarketplace: 'openadam' })
      : host === 'claude' ? createClaudeRunner() : { runner: async (_command, args) => {
          assert.equal(args[0], 'version')
          return { status: 0, stdout: '0.16.5\n', stderr: '' }
        } }
    const stateRoot = join(root, 'state')
    const dependencies = {
      runner: (command, args, options) => command === process.execPath && args[0] === 'version'
        ? Promise.resolve({ status: 0, stdout: '0.16.5\n', stderr: '' })
        : fake.runner(command, args, options),
      codexConfiguration: fake.configuration,
      hostSkillHome: join(root, 'host-home'), zcodeConfigPath: join(root, 'zcode-config.json'), zcodeExecutable: process.execPath,
      applicationStatePreflight: compatibleApplicationState,
      // Only Armorial in this sealed release fixture is a real MCP server.
      // Exercise it through production catalog admission and cold/warm probes;
      // unrelated legacy fixtures still use their explicit test doubles.
      catalogPreflight: (components, options) => components.armorial === undefined
        ? healthyCatalogPreflight(components)
        : preflightManagedCatalog({ armorial: components.armorial }, options),
      componentWarmup: (options) => warmInstalledAgentComponents({
        ...options, componentIds: options.componentIds.filter((id) => id === 'armorial'),
      }),
    }
    const options = { profile: 'featured', hosts: [host], tools: ['armorial'], releaseManifest, stateRoot, noService: true, enableObservability: false }
    await assert.rejects(setup({ ...options, dryRun: true }, dependencies), (error) => error.code === 'WORKSPACE_GRANT_REQUIRED')
    await setup({ ...options, workspaceRoot, dryRun: true }, dependencies)
    await setup({ ...options, workspaceRoot, dryRun: false }, dependencies)
    const paths = await prepareStatePaths(stateRoot)
    function launcher(state) {
      if (host !== 'codex') return state.hosts[host].providerSkills.find((skill) => skill.id === 'use-armorial').launcherPath
      const entry = state.hosts.codex.entries.find((item) => item.component === 'armorial')
      return join(entry.pluginRoot, 'skills', 'use-armorial', 'scripts', process.platform === 'win32' ? 'armorial.cmd' : 'armorial')
    }
    const first = await loadState(paths)
    assert.equal(runSkillLauncher(launcher(first), ['--read']).trim(), 'first input')
    await setActiveTools({ stateRoot, tools: ['math-anchor'], dryRun: true }, dependencies)
    await setActiveTools({ stateRoot, tools: ['math-anchor'], dryRun: false }, dependencies)
    const inactive = await loadState(paths)
    assert.equal(inactive.agentComponents.includes('armorial'), false)
    assert.equal(runSkillLauncher(launcher(inactive), ['--read']).trim(), 'first input')
    if (host === 'codex') {
      const entry = inactive.hosts.codex.entries.find((item) => item.component === 'armorial')
      await assert.rejects(readFile(join(entry.pluginRoot, '.mcp.json')), (error) => error.code === 'ENOENT')
    } else {
      const config = JSON.parse(await readFile(inactive.hosts[host].configPath, 'utf8'))
      const servers = host === 'claude' ? config.mcpServers : config.mcp.servers
      assert.equal(servers.armorial, undefined)
      assert.equal(inactive.hosts[host].inactiveEntries.find((entry) => entry.component === 'armorial')?.created, true)
    }
    await grantWorkspace({ stateRoot, workspaceRoot: nextWorkspace }, dependencies)
    const rebound = await loadState(paths)
    assert.notEqual(launcher(rebound), launcher(inactive))
    assert.equal(runSkillLauncher(launcher(rebound), ['--read']).trim(), 'second input')

    await assert.rejects(grantWorkspace({ stateRoot, workspaceRoot }, {
      ...dependencies, saveState: async () => { throw new Error('injected grant commit failure') },
    }), /injected grant commit failure/u)
    assert.deepEqual(await loadState(paths), rebound)
    assert.equal(runSkillLauncher(launcher(rebound), ['--read']).trim(), 'second input')
    await grantWorkspace({ stateRoot, workspaceRoot }, dependencies)
    assert.equal(runSkillLauncher(launcher(await loadState(paths)), ['--read']).trim(), 'first input')
    await setActiveTools({ stateRoot, tools: ['armorial'], dryRun: true }, dependencies)
    await setActiveTools({ stateRoot, tools: ['armorial'], dryRun: false }, dependencies)
    if (host !== 'codex') {
      const resumed = await loadState(paths)
      assert.equal(resumed.hosts[host].entries.find((entry) => entry.component === 'armorial')?.created, true)
    }
    const nextRelease = await createReleaseFixture(join(root, 'next-release'), {
      suiteVersion: '0.2.1', releaseId: 'provider-workspace-next', marker: 'provider-workspace-next',
      includeArmorial: true, armorialWorkspace: true,
    })
    const updateOptions = { stateRoot, releaseManifest: nextRelease, workspaceRoot: nextWorkspace }
    await updateInstallation({ ...updateOptions, dryRun: true }, dependencies)
    await updateInstallation({ ...updateOptions, dryRun: false }, dependencies)
    assert.equal(runSkillLauncher(launcher(await loadState(paths)), ['--read']).trim(), 'second input')
    // Rollback restores older Provider bytes but uses the explicitly chosen
    // current grant, not the workspace retained in the historical snapshot.
    await rollbackInstallation({ stateRoot, workspaceRoot: nextWorkspace, dryRun: false }, dependencies)
    const rolledBack = await loadState(paths)
    assert.equal(rolledBack.suiteVersion, '0.2.0')
    assert.equal(rolledBack.workspaceRoot, nextWorkspace)
    assert.equal(runSkillLauncher(launcher(rolledBack), ['--read']).trim(), 'second input')
    if (host === 'codex') {
      const add = { stateRoot, target: 'zcode', workspaceRoot }
      await assert.rejects(addHost(add, {
        ...dependencies, saveState: async () => { throw new Error('injected new-host commit failure') },
      }), /injected new-host commit failure/u)
      assert.deepEqual(await loadState(paths), rolledBack)
      assert.equal(runSkillLauncher(launcher(rolledBack), ['--read']).trim(), 'second input')
      const restoredBinding = await inspectCodex(hostFacingManifest(rolledBack, rolledBack.agentComponents), fake.runner, {
        managedState: rolledBack.hosts.codex, useManagedBindings: true, codexConfiguration: fake.configuration,
      })
      assert.deepEqual(restoredBinding.entries.map((entry) => entry.component), ['armorial'])
      assert.equal(restoredBinding.entries.every((entry) => entry.installedIdentityMatched), true)
      await addHost(add, dependencies)
      const connected = await loadState(paths)
      assert.equal(connected.workspaceRoot, workspaceRoot)
      assert.equal(runSkillLauncher(launcher(connected), ['--read']).trim(), 'first input')
      const zcodeLauncher = connected.hosts.zcode.providerSkills.find((skill) => skill.id === 'use-armorial').launcherPath
      assert.equal(runSkillLauncher(zcodeLauncher, ['--read']).trim(), 'first input')
      const zcodeConfig = JSON.parse(await readFile(connected.hosts.zcode.configPath, 'utf8'))
      assert.equal(zcodeConfig.mcp.servers.armorial.env.PROVIDER_FIXTURE_WORKSPACE, workspaceRoot)
      const codexEntry = connected.hosts.codex.entries.find((entry) => entry.component === 'armorial')
      const mcp = JSON.parse(await readFile(join(codexEntry.pluginRoot, '.mcp.json'), 'utf8'))
      assert.equal(mcp.mcpServers.armorial.env.PROVIDER_FIXTURE_WORKSPACE, workspaceRoot)
    } else {
      await removeHost({ stateRoot, target: host }, dependencies)
      await addHost({ stateRoot, target: host, workspaceRoot }, dependencies)
      const connected = await loadState(paths)
      assert.equal(connected.workspaceRoot, workspaceRoot)
      assert.equal(runSkillLauncher(launcher(connected), ['--read']).trim(), 'first input')
    }
    await uninstallInstallation({ stateRoot, purgeData: false }, dependencies)
  })
}
