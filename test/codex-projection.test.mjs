import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import test from 'node:test'
import { materializeCodexProjections, pruneCodexProjections, resolveWorkspaceRoot } from '../src/hosts/codex-projection.mjs'

async function json(path, value) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

test('Codex projection keeps runtime bytes in the package and binds one explicit workspace grant', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-codex-projection-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const packageRoot = join(root, 'package')
  const marketplaceRoot = join(packageRoot, 'marketplace')
  const pluginRoot = join(marketplaceRoot, 'plugins', 'file-vitals')
  const command = join(pluginRoot, 'runtime', 'finspect')
  const workspace = join(root, 'workspace')
  const pluginCache = join(root, 'plugin-cache')
  const applications = join(root, 'applications')
  await mkdir(workspace)
  await mkdir(pluginCache)
  await mkdir(applications)
  await json(join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), {
    name: 'file-vitals-local', plugins: [{ name: 'file-vitals', source: { source: 'local', path: './plugins/file-vitals' } }],
  })
  await json(join(pluginRoot, '.codex-plugin', 'plugin.json'), {
    name: 'file-vitals', version: '0.3.2', skills: './skills/', mcpServers: './.mcp.json',
  })
  await json(join(pluginRoot, '.mcp.json'), {
    mcpServers: { 'file-vitals': { command: './runtime/finspect', args: ['mcp'], cwd: '.', env_vars: ['UFI_WORKSPACE_ROOT'] } },
  })
  await mkdir(join(pluginRoot, 'skills', 'file-vitals'), { recursive: true })
  await writeFile(join(pluginRoot, 'skills', 'file-vitals', 'SKILL.md'), '---\nname: file-vitals\n---\n')
  await mkdir(join(pluginRoot, 'runtime'), { recursive: true })
  await writeFile(command, '#!/bin/sh\n')
  await chmod(command, 0o700)
  const component = {
    version: '0.3.2', fingerprint: 'package-fingerprint', marketplaceRoot, pluginRoot,
    marketplace: 'file-vitals-local', plugin: 'file-vitals', displayName: 'File Vitals',
    command, args: ['mcp'], cwd: pluginRoot, workspaceEnvironment: ['UFI_WORKSPACE_ROOT'],
    pathGrants: { OPTIONAL_ROOTS: [pluginCache, applications] },
    pluginIdentityRelativeFiles: ['.codex-plugin/plugin.json', '.mcp.json', 'runtime/finspect', 'skills/file-vitals/SKILL.md'],
    pluginIdentityFingerprint: 'package-plugin-fingerprint',
  }
  const manifest = { components: { 'file-vitals': component } }
  await assert.rejects(materializeCodexProjections(manifest, join(root, 'missing-grant'), null), (error) => error.code === 'WORKSPACE_GRANT_REQUIRED')

  const resolvedWorkspace = await resolveWorkspaceRoot(workspace)
  const projected = await materializeCodexProjections(manifest, join(root, 'projections'), resolvedWorkspace)
  const projectedComponent = projected.components['file-vitals']
  assert.equal(projectedComponent.marketplaceRoot.startsWith(join(root, 'projections')), true)
  assert.equal(projectedComponent.pluginIdentityRelativeFiles.includes('runtime/finspect'), false)
  const mcp = JSON.parse(await readFile(join(projectedComponent.pluginRoot, '.mcp.json'), 'utf8'))
  assert.equal(mcp.mcpServers['file-vitals'].command, command)
  assert.equal(mcp.mcpServers['file-vitals'].cwd, pluginRoot)
  assert.equal(mcp.mcpServers['file-vitals'].env.UFI_WORKSPACE_ROOT, resolvedWorkspace)
  assert.equal(mcp.mcpServers['file-vitals'].env.OPTIONAL_ROOTS, [pluginCache, applications].join(delimiter))
  assert.equal('env_vars' in mcp.mcpServers['file-vitals'], false)
  const alternate = await materializeCodexProjections(
    { components: { 'file-vitals': { ...component, cwd: marketplaceRoot } } },
    join(root, 'projections'),
    resolvedWorkspace,
  )
  assert.notEqual(alternate.components['file-vitals'].marketplaceRoot, projectedComponent.marketplaceRoot)
  assert.equal(
    JSON.parse(await readFile(join(alternate.components['file-vitals'].pluginRoot, '.mcp.json'), 'utf8')).mcpServers['file-vitals'].cwd,
    marketplaceRoot,
  )
  const stale = join(root, 'projections', 'file-vitals', 'stale')
  await mkdir(stale)
  const cleanup = await pruneCodexProjections(
    join(root, 'projections'),
    [projectedComponent.marketplaceRoot, alternate.components['file-vitals'].marketplaceRoot],
  )
  assert.equal(cleanup.removed, 1)
  await assert.rejects(stat(stale), (error) => error.code === 'ENOENT')
})

test('Codex projection exposes a Developer Kit Skill with a version-locked CLI and no MCP server', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-developer-projection-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const marketplaceRoot = join(root, 'package', 'marketplace')
  const pluginRoot = join(marketplaceRoot, 'plugins', 'agent-tool-development-kit')
  const skillRoot = join(pluginRoot, 'skills', 'build-openadam-agent-tools')
  await json(join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), {
    name: 'openadam-developer-tools',
    plugins: [{ name: 'agent-tool-development-kit', source: { source: 'local', path: './plugins/agent-tool-development-kit' } }],
  })
  await json(join(pluginRoot, '.codex-plugin', 'plugin.json'), {
    name: 'agent-tool-development-kit', version: '0.1.0', skills: './skills/',
  })
  await mkdir(join(skillRoot, 'agents'), { recursive: true })
  await writeFile(join(skillRoot, 'SKILL.md'), '---\nname: build-openadam-agent-tools\n---\n')
  await writeFile(join(skillRoot, 'agents', 'openai.yaml'), 'interface:\n  display_name: Developer Kit\n')
  const component = {
    version: '0.1.0', fingerprint: 'developer-component-fingerprint', marketplaceRoot, pluginRoot,
    marketplace: 'openadam-developer-tools', plugin: 'agent-tool-development-kit', displayName: 'Agent Tool Development Kit',
    command: '/private/runtime/node', args: ['/private/package/openadam-dev.mjs'], skillOnly: true,
    developerSkill: {
      id: 'build-openadam-agent-tools', root: skillRoot,
      identityRelativeFiles: ['SKILL.md', 'agents/openai.yaml'], identityFingerprint: 'source-skill-fingerprint',
      launcherRelativePath: 'scripts/openadam-dev',
    },
    pluginIdentityRelativeFiles: ['.codex-plugin/plugin.json', 'skills/build-openadam-agent-tools/SKILL.md'],
    pluginIdentityFingerprint: 'source-plugin-fingerprint',
  }
  const projected = await materializeCodexProjections({ components: { 'agent-tool-development-kit': component } }, join(root, 'projections'), null)
  const result = projected.components['agent-tool-development-kit']
  const expectedDigest = createHash('sha256')
    .update('openadam.agent-host-codex-projection.v0.2')
    .update('\0')
    .update(component.fingerprint)
    .update('\0')
    .update(component.command)
    .update('\0')
    .update(JSON.stringify(component.args))
    .update('\0\0\0')
    .update('skill-only')
    .digest('hex')
    .slice(0, 16)
  assert.equal(basename(dirname(result.marketplaceRoot)), expectedDigest)
  await assert.rejects(readFile(join(result.pluginRoot, '.mcp.json')), (error) => error.code === 'ENOENT')
  const launcher = await readFile(result.developerSkill.launcherPath, 'utf8')
  if (process.platform === 'win32') {
    assert.match(launcher, /@echo off\r\nsetlocal DisableDelayedExpansion/u)
    assert.match(launcher, /"\/private\/runtime\/node" "\/private\/package\/openadam-dev\.mjs" %\*/u)
  } else {
    assert.match(launcher, /^#!\/bin\/sh\nexec '\/private\/runtime\/node' '\/private\/package\/openadam-dev\.mjs' "\$@"\n$/u)
    assert.equal((await stat(result.developerSkill.launcherPath)).mode & 0o111, 0o100)
  }
  const launcherName = process.platform === 'win32' ? 'openadam-dev.cmd' : 'openadam-dev'
  assert.equal(result.pluginIdentityRelativeFiles.includes(`skills/build-openadam-agent-tools/scripts/${launcherName}`), true)
})

test('Codex projection keeps a Provider Skill executable while switching its MCP surface off', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-provider-skill-projection-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const marketplaceRoot = join(root, 'package', 'marketplace')
  const pluginRoot = join(marketplaceRoot, 'plugins', 'armorial')
  const skillRoot = join(pluginRoot, 'skills', 'armorial')
  await json(join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), {
    name: 'armorial-local',
    plugins: [{ name: 'armorial', source: { source: 'local', path: './plugins/armorial' } }],
  })
  await json(join(pluginRoot, '.codex-plugin', 'plugin.json'), {
    name: 'armorial', version: '0.6.0', skills: './skills/', mcpServers: './.mcp.json',
  })
  await json(join(pluginRoot, '.mcp.json'), {
    mcpServers: { armorial: { command: './server.mjs', args: [], cwd: '.' } },
  })
  await mkdir(skillRoot, { recursive: true })
  await writeFile(join(skillRoot, 'SKILL.md'), '---\nname: armorial\n---\n')
  const component = {
    version: '0.6.0', fingerprint: 'armorial-component-fingerprint', marketplaceRoot, pluginRoot,
    marketplace: 'armorial-local', plugin: 'armorial', displayName: 'Armorial',
    command: '/private/runtime/node', args: ['/private/package/server.mjs'], cwd: pluginRoot,
    workspaceEnvironment: [],
    pluginIdentityRelativeFiles: ['.codex-plugin/plugin.json', '.mcp.json', 'skills/armorial/SKILL.md'],
    pluginIdentityFingerprint: 'source-plugin-fingerprint',
    providerSkill: {
      id: 'armorial', root: skillRoot,
      identityRelativeFiles: ['SKILL.md'], identityFingerprint: 'source-skill-fingerprint',
      launcherRelativePath: 'scripts/armorial',
      command: '/private/runtime/node', args: ['/private/package/cli.js'],
      versionArguments: ['--version'], expectedVersion: '0.6.0',
    },
  }

  const active = await materializeCodexProjections(
    { components: { armorial: { ...component, skillOnly: false } } },
    join(root, 'projections'),
    null,
  )
  const activeComponent = active.components.armorial
  assert.equal(JSON.parse(await readFile(join(activeComponent.pluginRoot, '.codex-plugin/plugin.json'), 'utf8')).mcpServers, './.mcp.json')
  assert.equal(JSON.parse(await readFile(join(activeComponent.pluginRoot, '.mcp.json'), 'utf8')).mcpServers.armorial.command, component.command)
  assert.match(await readFile(activeComponent.providerSkill.launcherPath, 'utf8'), /cli\.js/u)

  const inactive = await materializeCodexProjections(
    { components: { armorial: { ...component, skillOnly: true } } },
    join(root, 'projections'),
    null,
  )
  const inactiveComponent = inactive.components.armorial
  assert.notEqual(inactiveComponent.pluginRoot, activeComponent.pluginRoot)
  assert.equal('mcpServers' in JSON.parse(await readFile(join(inactiveComponent.pluginRoot, '.codex-plugin/plugin.json'), 'utf8')), false)
  await assert.rejects(readFile(join(inactiveComponent.pluginRoot, '.mcp.json')), (error) => error.code === 'ENOENT')
  assert.match(await readFile(inactiveComponent.providerSkill.launcherPath, 'utf8'), /cli\.js/u)
})
