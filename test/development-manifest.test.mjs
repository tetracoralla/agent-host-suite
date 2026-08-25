import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildDevelopmentManifest, fingerprintIdentityFiles } from '../src/development-manifest.mjs'
import { createRuntimeConfig } from '../src/runtime-config.mjs'
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
  assert.deepEqual(config.providers.map((item) => item.transport), ['mcp-stdio', 'capability-jsonl-v0.1'])
  assert.deepEqual(config.providers[0].allowedTools, ['math.run', 'math.batch'])
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
