import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { grantWorkspace, setActiveTools, uninstallInstallation } from '../src/lifecycle.mjs'
import { setup } from '../src/setup.mjs'
import { loadState, prepareStatePaths } from '../src/state.mjs'
import { compatibleApplicationState, createClaudeRunner, createCodexRunner, healthyCatalogPreflight } from './helpers.mjs'
import { runSkillLauncher } from './launcher-helpers.mjs'
import { createReleaseFixture } from './release-helpers.mjs'

for (const host of ['codex', 'claude', 'zcode']) {
  test(`${host} setup, on-demand transition and workspace recovery preserve Provider CLI authority`, async (t) => {
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
      runner: fake.runner, codexConfiguration: fake.configuration,
      hostSkillHome: join(root, 'host-home'), zcodeConfigPath: join(root, 'zcode-config.json'), zcodeExecutable: process.execPath,
      applicationStatePreflight: compatibleApplicationState,
      catalogPreflight: healthyCatalogPreflight,
      componentWarmup: async () => ({ status: 'ok', strategy: 'sequential-first-and-repeat', components: [] }),
    }
    const options = { profile: 'featured', hosts: [host], releaseManifest, stateRoot, noService: true, enableObservability: false }
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
    await uninstallInstallation({ stateRoot, purgeData: false }, dependencies)
  })
}
