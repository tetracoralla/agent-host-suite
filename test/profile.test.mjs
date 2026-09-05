import assert from 'node:assert/strict'
import test from 'node:test'
import { loadProfile, selectAgentComponents, validateProfile } from '../src/profile.mjs'

test('profiles retain the small standard catalog and compose the current local dogfood set', async () => {
  const standard = await loadProfile('standard')
  assert.deepEqual(standard.components, ['node-runtime', 'direct-execution-runtime', 'math-anchor', 'migratory-time'])
  assert.equal(standard.displayName, 'Standard tools')
  assert.equal(standard.requiresConsent, false)
  assert.deepEqual(standard.agentComponents, ['math-anchor', 'migratory-time'])
  assert.deepEqual(standard.defaultAgentComponents, ['math-anchor', 'migratory-time'])

  const developer = await loadProfile('developer')
  assert.equal(developer.displayName, 'Developer Kit')
  assert.deepEqual(developer.components, ['node-runtime', 'direct-execution-runtime', 'math-anchor', 'migratory-time', 'agent-tool-development-kit'])
  assert.equal(developer.components.includes('agent-tool-development-kit'), true)
  assert.deepEqual(developer.agentComponents, [])
  assert.deepEqual(developer.defaultAgentComponents, [])

  const observability = await loadProfile('observability')
  assert.equal(observability.requiresConsent, true)
  assert.deepEqual(observability.agentComponents, ['math-anchor', 'migratory-time'])
  assert.deepEqual(observability.defaultAgentComponents, ['math-anchor', 'migratory-time'])

  const local = await loadProfile('local-dogfood')
  assert.equal(local.displayName, 'Standard + local tools')
  assert.equal(local.requiresConsent, true)
  assert.equal(local.components.includes('agent-tool-observer'), true)
  assert.equal(local.components.includes('context-surface-analyzer'), true)
  assert.equal(local.agentComponents.includes('context-surface-analyzer'), false)
  assert.equal(local.components.includes('file-vitals'), true)
  assert.equal(local.components.includes('agent-tool-development-kit'), true)
  assert.equal(local.agentComponents.includes('agent-tool-development-kit'), false)
  assert.deepEqual(local.defaultAgentComponents, ['math-anchor'])
  assert.equal(new Set(local.components).size, local.components.length)
})

test('an unknown profile fails closed', async () => {
  await assert.rejects(loadProfile('../outside'), (error) => error.code === 'PROFILE_UNKNOWN')
})

test('profile runtime validation matches the published non-empty default set', () => {
  assert.throws(() => validateProfile({
    schemaVersion: 'openadam.agent-host-profile.v0.2',
    id: 'invalid-empty-default',
    components: ['math-anchor'],
    agentComponents: ['math-anchor'],
    defaultAgentComponents: [],
  }, 'invalid-empty-default'), (error) => error.code === 'PROFILE_INVALID')
})

test('an active tool set is ordered by the installed profile and fails closed for empty or foreign tools', () => {
  const available = ['math-anchor', 'migratory-time', 'file-vitals']
  assert.deepEqual(selectAgentComponents(available, ['file-vitals', 'math-anchor', 'math-anchor']), ['math-anchor', 'file-vitals'])
  assert.throws(() => selectAgentComponents(available, []), (error) => error.code === 'TOOL_SET_EMPTY')
  assert.throws(() => selectAgentComponents(available, ['shell']), (error) => error.code === 'TOOL_SET_COMPONENT_UNAVAILABLE')
  assert.deepEqual(selectAgentComponents([], []), [])
})
