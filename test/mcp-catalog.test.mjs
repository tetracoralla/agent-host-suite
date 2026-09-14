import assert from 'node:assert/strict'
import test from 'node:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assessManagedCatalog,
  exportManagedCatalogInventory,
  MANAGED_CATALOG_BUDGETS,
  MANAGED_CATALOG_PREFERENCES,
  preflightManagedCatalog,
} from '../src/context-exporter.mjs'
import { probeMcpTools } from '../src/mcp-health.mjs'
import {
  SIX_TOOL_COMBINATION,
  TRUSTED_LARGE_CATALOG,
  catalogToolsForMode,
} from './fixtures/managed-catalog-shapes.mjs'

const fixture = fileURLToPath(new URL('./fixtures/catalog-provider.mjs', import.meta.url))
const component = (mode = 'normal') => ({
  command: process.execPath, args: [fixture, mode], cwd: dirname(fixture), pluginRoot: dirname(fixture),
  version: '1.0.0', fingerprint: 'fixture', expectedTools: ['input_only', 'inline_output'], healthTimeoutMs: 5000,
})

function snapshotFor(mode) {
  return {
    tools: catalogToolsForMode(mode),
    budgets: MANAGED_CATALOG_BUDGETS,
  }
}

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

test('six-tool combination matching five tools plus Migratory Time is admitted over the 64 KiB preference', async () => {
  const assessment = assessManagedCatalog(snapshotFor('six-tool'))
  assert.equal(assessment.toolCount, SIX_TOOL_COMBINATION.toolCount)
  assert.equal(assessment.canonicalUtf8Bytes, SIX_TOOL_COMBINATION.canonicalUtf8Bytes)
  assert.equal(assessment.canonicalUtf8Bytes > MANAGED_CATALOG_PREFERENCES.preferredCatalogUtf8Bytes, true)
  assert.equal(assessment.canonicalUtf8Bytes < MANAGED_CATALOG_BUDGETS.maxCatalogUtf8Bytes, true)
  assert.equal(assessment.status, 'within')
  assert.equal(assessment.preference.status, 'over')
  assert.deepEqual(assessment.exceeded, [])

  const preflight = await preflightManagedCatalog({ fixture: component('six-tool') })
  assert.equal(preflight.status, 'within')
  assert.equal(preflight.toolCount, SIX_TOOL_COMBINATION.toolCount)
  assert.equal(preflight.canonicalUtf8Bytes, SIX_TOOL_COMBINATION.canonicalUtf8Bytes)
  assert.equal(preflight.preference.status, 'over')
})

test('a trusted large catalog is admitted while a runaway catalog is blocked', async () => {
  const trusted = assessManagedCatalog(snapshotFor('trusted-large'))
  assert.equal(trusted.toolCount, TRUSTED_LARGE_CATALOG.toolCount)
  assert.equal(trusted.canonicalUtf8Bytes, TRUSTED_LARGE_CATALOG.canonicalUtf8Bytes)
  assert.equal(trusted.status, 'within')
  assert.equal(trusted.preference.status, 'over')
  assert.equal((await preflightManagedCatalog({ fixture: component('trusted-large') })).status, 'within')

  const runaway = assessManagedCatalog(snapshotFor('runaway'))
  assert.equal(runaway.status, 'exceeded')
  assert.equal(runaway.exceeded.some((item) => item.metric === 'catalog.canonicalUtf8Bytes'), true)
  await assert.rejects(preflightManagedCatalog({ fixture: component('runaway') }), { code: 'AGENT_TOOL_CATALOG_BUDGET_EXCEEDED' })

  await assert.rejects(preflightManagedCatalog({ fixture: component('oversized-count') }), { code: 'CATALOG_EXPORT_LIMIT' })
})
