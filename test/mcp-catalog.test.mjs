import assert from 'node:assert/strict'
import test from 'node:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exportManagedCatalogInventory, preflightManagedCatalog } from '../src/context-exporter.mjs'
import { probeMcpTools } from '../src/mcp-health.mjs'

const fixture = fileURLToPath(new URL('./fixtures/catalog-provider.mjs', import.meta.url))
const component = (mode = 'normal') => ({
  command: process.execPath, args: [fixture, mode], cwd: dirname(fixture), pluginRoot: dirname(fixture),
  version: '1.0.0', fingerprint: 'fixture', expectedTools: ['input_only', 'inline_output'], healthTimeoutMs: 5000,
})

test('actual catalog admission preserves absent and inline output schemas', async () => {
  const { snapshot } = await exportManagedCatalogInventory({ fixture: component() })
  assert.equal(snapshot.tools.length, 2)
  assert.equal(Object.hasOwn(snapshot.tools[0], 'outputSchema'), false)
  assert.deepEqual(snapshot.tools[1].outputSchema, { type: 'object', properties: { value: { type: 'string' } } })
  assert.equal((await preflightManagedCatalog({ fixture: component() })).status, 'within')
})

test('actual health discovery accepts optional output schemas without fetching result resources', async () => {
  const result = await probeMcpTools(component())
  assert.equal(result.status, 'ok')
  assert.deepEqual(result.tools, ['inline_output', 'input_only'])
})

test('optional output schemas do not bypass input validation, declared output validation or resource limits', async () => {
  for (const mode of ['bad-input', 'bad-output']) {
    await assert.rejects(exportManagedCatalogInventory({ fixture: component(mode) }))
    await assert.rejects(probeMcpTools(component(mode)))
  }
  await assert.rejects(preflightManagedCatalog({ fixture: component('large') }), { code: 'AGENT_TOOL_CATALOG_BUDGET_EXCEEDED' })
})
