import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fingerprintRelativeFiles } from '../src/development-manifest.mjs'
import { installProviderSkills, preflightProviderSkills } from '../src/developer-kit-skill.mjs'
import { materializeCodexProjections } from '../src/hosts/codex-projection.mjs'
import { runSkillLauncher } from './launcher-helpers.mjs'

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-host-provider-execution-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const marketplaceRoot = join(root, 'package', 'marketplace')
  const pluginRoot = join(marketplaceRoot, 'plugins', 'fixture')
  const skillRoot = join(pluginRoot, 'skills', 'use-fixture')
  const workspaceRoot = join(root, "workspace ' $literal %value% !")
  const nextWorkspace = join(root, 'next-workspace')
  const caller = join(root, 'caller')
  await mkdir(skillRoot, { recursive: true })
  await mkdir(workspaceRoot)
  await mkdir(nextWorkspace)
  await mkdir(caller)
  await writeFile(join(workspaceRoot, 'input.txt'), 'first input')
  await writeFile(join(nextWorkspace, 'input.txt'), 'second input')
  await writeFile(join(caller, 'relative.txt'), 'caller resource')
  await writeFile(join(skillRoot, 'SKILL.md'), '---\nname: use-fixture\n---\n')
  const cli = join(pluginRoot, 'cli.mjs')
  await writeFile(cli, `import { readFileSync } from 'node:fs';
import { join } from 'node:path';
console.log(JSON.stringify({
  input: readFileSync(join(process.env.PROVIDER_FIXTURE_WORKSPACE, 'input.txt'), 'utf8'),
  resource: readFileSync('relative.txt', 'utf8'),
  cwd: process.cwd(), argv: process.argv.slice(2)
}));\n`)
  for (const [file, value] of [
    [join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), { name: 'fixture-local' }],
    [join(pluginRoot, '.codex-plugin', 'plugin.json'), { name: 'fixture', skills: './skills/', mcpServers: './.mcp.json' }],
    [join(pluginRoot, '.mcp.json'), { mcpServers: { fixture: { command: './cli.mjs', args: [] } } }],
  ]) {
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, JSON.stringify(value))
  }
  const component = {
    version: '0.1.0', fingerprint: 'sha256:provider-execution-fixture',
    toolIntegrationSchema: 'openadam.agent-host-tool-integration.v0.3',
    marketplaceRoot, pluginRoot, marketplace: 'fixture-local', plugin: 'fixture',
    command: process.execPath, args: [cli], cwd: pluginRoot,
    workspaceEnvironment: ['PROVIDER_FIXTURE_WORKSPACE'],
    providerSkill: {
      id: 'use-fixture', root: skillRoot, identityRelativeFiles: ['SKILL.md'],
      identityFingerprint: await fingerprintRelativeFiles(skillRoot, ['SKILL.md']),
      launcherRelativePath: 'scripts/fixture', command: process.execPath,
      args: [cli, "bound ' $literal %value% !"], versionArguments: ['--version'], expectedVersion: '0.1.0',
    },
  }
  return { root, component, workspaceRoot, nextWorkspace, caller }
}

async function expose(host, fixture, workspaceRoot, skillOnly, previous) {
  const { root, component } = fixture
  const manifest = { components: { fixture: { ...component, skillOnly } } }
  const paths = { hostProjections: join(root, 'projections'), backups: join(root, 'backups') }
  if (host === 'codex') {
    const projected = await materializeCodexProjections(manifest, paths.hostProjections, workspaceRoot)
    const result = projected.components.fixture
    return { launcherPath: result.providerSkill.launcherPath, pluginRoot: result.pluginRoot }
  }
  const options = { homeRoot: join(root, 'home'), workspaceRoot }
  await preflightProviderSkills(host, manifest, paths, { ...options, previous: previous ? [previous] : [] })
  return (await installProviderSkills(host, manifest, paths, previous ? [previous] : [], options))[0]
}

for (const host of ['codex', 'claude', 'zcode']) {
  test(`${host} Provider Skill preserves the explicit workspace and caller cwd, including on-demand and rebind`, async (t) => {
    const data = await fixture(t)
    const expected = {
      input: 'first input', resource: 'caller resource', cwd: data.caller,
      argv: ["bound ' $literal %value% !", '--read'],
    }
    const active = await expose(host, data, data.workspaceRoot, false)
    assert.deepEqual(JSON.parse(runSkillLauncher(active.launcherPath, ['--read'], { cwd: data.caller })), expected)
    if (host === 'codex') {
      const mcp = JSON.parse(await readFile(join(active.pluginRoot, '.mcp.json'), 'utf8'))
      assert.equal(mcp.mcpServers.fixture.env.PROVIDER_FIXTURE_WORKSPACE, data.workspaceRoot)
      assert.equal(mcp.mcpServers.fixture.cwd, data.component.cwd)
    }
    const inactive = await expose(host, data, data.workspaceRoot, true, active)
    assert.deepEqual(JSON.parse(runSkillLauncher(inactive.launcherPath, ['--read'], { cwd: data.caller })), expected)
    const rebound = await expose(host, data, data.nextWorkspace, true, inactive)
    assert.notEqual(rebound.launcherPath, inactive.launcherPath)
    assert.deepEqual(JSON.parse(runSkillLauncher(rebound.launcherPath, ['--read'], { cwd: data.caller })), { ...expected, input: 'second input' })
    const reused = await expose(host, data, data.nextWorkspace, true, rebound)
    assert.equal(reused.launcherPath, rebound.launcherPath)
  })

  test(`${host} Provider Skill refuses a missing workspace grant even when MCP is inactive`, async (t) => {
    const data = await fixture(t)
    for (const skillOnly of [false, true]) {
      await assert.rejects(expose(host, data, null, skillOnly), (error) => error.code === 'WORKSPACE_GRANT_REQUIRED')
    }
  })
}
