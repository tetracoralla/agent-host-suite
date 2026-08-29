import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  await mkdir(workspace)
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
  assert.equal('env_vars' in mcp.mcpServers['file-vitals'], false)
  const stale = join(root, 'projections', 'file-vitals', 'stale')
  await mkdir(stale)
  const cleanup = await pruneCodexProjections(join(root, 'projections'), [projectedComponent.marketplaceRoot])
  assert.equal(cleanup.removed, 1)
  await assert.rejects(stat(stale), (error) => error.code === 'ENOENT')
})
