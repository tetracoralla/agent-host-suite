import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { contextAnalyzerInvocation, disableObservability, observabilitySummary, semanticExecutionTotals } from '../src/observability.mjs'
import { retryableCatalogError, validateManagedToolBindings } from '../src/context-exporter.mjs'
import { prepareStatePaths, saveState, STATE_SCHEMA } from '../src/state.mjs'

test('local dogfood cannot disable monitoring and leave a consent-bearing profile incomplete', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-observability-profile-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  const paths = await prepareStatePaths(stateRoot)
  await saveState(paths, {
    schemaVersion: STATE_SCHEMA,
    suiteVersion: '0.1.0-dogfood.3',
    channel: 'release',
    profile: 'local-dogfood',
    installedAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    components: {},
    hosts: {},
    runtime: {},
    observability: { enabled: true },
  })

  await assert.rejects(
    disableObservability({ stateRoot }),
    (error) => error.code === 'OBSERVABILITY_PROFILE_REQUIRES_ENABLED',
  )
})

test('context analysis uses its auxiliary CLI when the same component also exposes an MCP runtime', () => {
  assert.deepEqual(contextAnalyzerInvocation({
    command: '/private/package/runtime/node',
    args: ['./src/mcp-server.js'],
    cliCommand: '/private/package/node/bin/node',
    cliArgs: ['/private/package/src/cli.js'],
  }), {
    command: '/private/package/node/bin/node',
    args: ['/private/package/src/cli.js'],
  })
})

test('catalog export retries only bounded MCP timeout failures', () => {
  assert.equal(retryableCatalogError({ code: -32001, message: 'Request timed out' }), true)
  assert.equal(retryableCatalogError({ code: 'CATALOG_INVALID', message: 'bad schema' }), false)
})

test('deployment tool-name conflicts fail in Agent Host before Observer ingestion', () => {
  assert.throws(() => validateManagedToolBindings([
    { id: 'math-anchor', toolNames: ['math.run'] },
    { id: 'other-math', toolNames: ['MATH_RUN'] },
  ]), (error) => error.code === 'AGENT_TOOL_BINDING_CONFLICT'
    && error.details.first.component === 'math-anchor'
    && error.details.conflicting.component === 'other-math')
})

test('observability summary preserves provider coverage and bounded-routing disclosure', () => {
  const correlation = {
    providers: [{ provider: 'claude', coverageStatus: 'unavailable-for-observed-calls' }],
    routing: { observationRecordsReturned: 100, observationRecordsTruncated: true },
    adoptionStatus: 'not-assessed',
  }
  const summary = observabilitySummary({
    enabled: true,
    consentedAt: '2026-08-28T00:00:00.000Z',
    observer: { stateDir: '/private/observer', installation: { intervalSeconds: 300 } },
    maintenance: { intervalSeconds: 604800 },
    latest: {
      refreshedAt: '2026-08-28T00:00:01.000Z',
      deployment: null,
      context: { catalog: {}, counts: {}, hardNameCollisions: 0 },
      report: {
        freshSessionCorrelation: correlation,
        totals: {
          freshSessionSuiteToolCalls: 0,
          freshSessionRoutingObservationsReturned: 100,
          freshSessionRoutingObservationsTruncated: true,
        },
      },
    },
  })
  assert.deepEqual(summary.latest.freshSessionCorrelation, correlation)
  assert.equal(summary.latest.totals.freshSessionRoutingObservationsReturned, 100)
  assert.equal('freshSessionRoutingTurns' in summary.latest.totals, false)
})

test('semantic totals come from current Direct Runtime observations, not retired receipt projections', () => {
  assert.deepEqual(semanticExecutionTotals([
    { target: { kind: 'procedure' }, executions: 3 },
    { target: { kind: 'capability' }, executions: 5 },
    { target: { kind: 'mcp-operation' }, executions: 8 },
  ]), { procedureEvents: 3, capabilityEvents: 5 })
  assert.deepEqual(semanticExecutionTotals(undefined), { procedureEvents: 0, capabilityEvents: 0 })
  assert.throws(() => semanticExecutionTotals([
    { target: { kind: 'procedure' }, executions: -1 },
  ]), (error) => error.code === 'OBSERVABILITY_REPORT_UNSUPPORTED')
  assert.throws(() => semanticExecutionTotals([
    { target: { kind: 'future-semantic-kind' }, executions: 1 },
  ]), (error) => error.code === 'OBSERVABILITY_REPORT_UNSUPPORTED')
})
