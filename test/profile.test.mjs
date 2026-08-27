import assert from 'node:assert/strict'
import test from 'node:test'
import { loadProfile } from '../src/profile.mjs'

test('profiles retain the small standard catalog and compose the current local dogfood set', async () => {
  const standard = await loadProfile('standard')
  assert.deepEqual(standard.components, ['node-runtime', 'direct-execution-runtime', 'math-anchor', 'migratory-time'])
  assert.equal(standard.displayName, 'Standard tools')
  assert.equal(standard.requiresConsent, false)

  const local = await loadProfile('local-dogfood')
  assert.equal(local.displayName, 'Standard + local tools')
  assert.equal(local.requiresConsent, true)
  assert.equal(local.components.includes('agent-tool-observer'), true)
  assert.equal(local.components.includes('context-surface-analyzer'), true)
  assert.equal(local.components.includes('file-vitals'), true)
  assert.equal(new Set(local.components).size, local.components.length)
})

test('an unknown profile fails closed', async () => {
  await assert.rejects(loadProfile('../outside'), (error) => error.code === 'PROFILE_UNKNOWN')
})
