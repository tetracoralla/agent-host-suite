import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { toolInventory } from '../src/tool-inventory.mjs'

test('inventory includes independent public entries and never returns credentials or commands', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'host-independent-inventory-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.zcode/cli'), { recursive: true })
  await writeFile(join(root, '.claude.json'), JSON.stringify({ mcpServers: { decision_table: { command: '/private/provider', env: { SECRET: 'hidden-secret' } } } }))
  await writeFile(join(root, '.zcode/cli/config.json'), JSON.stringify({ mcp: { servers: { 'state-machine': { command: '/private/provider', enabled: false } } } }))
  const runner = async (_command, args) => args.includes('list')
    ? { status: 0, stdout: JSON.stringify({ installed: [{ name: 'schedule-algebra', pluginId: 'schedule-algebra@independent', installed: true, enabled: true, version: '1.0.0', source: { path: '/private/provider' } }] }) }
    : { status: 0, stdout: '/usr/bin/codex\n' }
  const value = await toolInventory({ stateRoot: join(root, 'state'), homeRoot: root }, { runner })
  assert.equal(value.agentApps.codex.entries[0].hostComponent, null)
  assert.equal(value.agentApps.claude.entries[0].name, 'decision_table')
  assert.equal(value.agentApps.zcode.entries[0].enabled, false)
  assert.equal(JSON.stringify(value).includes('hidden-secret'), false)
  assert.equal(JSON.stringify(value).includes('/private/provider'), false)
  await writeFile(join(root, '.claude.json'), '{broken')
  const broken = await toolInventory({ stateRoot: join(root, 'state'), homeRoot: root }, { runner })
  assert.equal(broken.agentApps.claude.status, 'unavailable')
})
