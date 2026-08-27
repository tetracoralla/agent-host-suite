import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildDevelopmentManifest, fingerprintIdentityFiles } from '../src/development-manifest.mjs'
import { createRuntimeConfig, mathProjectionSelection, semanticProbeOrder } from '../src/runtime-config.mjs'
import { createDevelopmentWorkspace } from './helpers.mjs'

test('development manifest binds runnable files and two different provider transports', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-workspace-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await createDevelopmentWorkspace(root)
  const manifest = await buildDevelopmentManifest(root)
  assert.equal(manifest.components['math-anchor'].version, '0.3.0')
  assert.equal(manifest.components['migratory-time'].marketplace, 'migratory-time')
  assert.equal(await fingerprintIdentityFiles(manifest.components['math-anchor'].identityFiles), manifest.components['math-anchor'].fingerprint)
  const config = createRuntimeConfig(manifest)
  assert.equal(config.limits.defaultTimeoutMs, 30000)
  assert.deepEqual(config.providers.map((item) => item.transport), ['mcp-stdio', 'capability-jsonl-v0.1'])
  assert.deepEqual(config.providers[0].allowedTools, ['math.run', 'math.batch', 'math.describe'])
  assert.deepEqual(config.providers[0].operationProjections, [{
    toolName: 'math.run',
    operationField: 'operation',
    argumentsField: 'arguments',
    batchToolName: 'math.batch',
    batchItemsField: 'items',
    schemaLookup: {
      toolName: 'math.describe',
      operationField: 'operation',
      resultPath: ['operation', 'inputSchema'],
    },
  }])
  assert.equal(mathProjectionSelection().target.operationId, 'expression.evaluate')
  const probes = semanticProbeOrder().calls
  assert.equal(probes.every((call) => call.timeoutMs === 30000), true)
  assert.equal(probes.find((call) => call.id === 'math').target.kind, 'mcp-operation')
  assert.equal(probes.find((call) => call.id === 'math-batch').input.items.length, 2)
})

test('development manifest changes when an identity file changes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-workspace-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = await createDevelopmentWorkspace(root)
  const before = await buildDevelopmentManifest(root)
  await writeFile(join(fixture.time, 'plugins/migratory-time/server/index.mjs'), 'process.exit(0)\n')
  const after = await buildDevelopmentManifest(root)
  assert.notEqual(after.components['migratory-time'].fingerprint, before.components['migratory-time'].fingerprint)
})

test('development manifest reports a stable package error when a required runtime is missing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-workspace-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = await createDevelopmentWorkspace(root)
  await rm(join(fixture.math, 'plugins/math-anchor/runtime/math-anchor-runtime/math-anchor-runtime'))
  await assert.rejects(
    buildDevelopmentManifest(root),
    (error) => error.code === 'COMPONENT_PACKAGE_UNAVAILABLE' && !error.message.includes(root),
  )
})
