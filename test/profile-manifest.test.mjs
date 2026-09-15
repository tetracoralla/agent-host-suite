import assert from 'node:assert/strict'
import test from 'node:test'
import { hostFacingManifest } from '../src/profile.mjs'

test('host manifest keeps inactive discovery Providers Skill-only without changing the active set', () => {
  const manifest = {
    components: {
      armorial: { plugin: 'armorial', providerSkill: { id: 'armorial' } },
      'file-vitals': { plugin: 'file-vitals', providerSkill: { id: 'file-vitals' } },
      'math-anchor': { plugin: 'math-anchor' },
      'agent-tool-development-kit': { plugin: 'agent-tool-development-kit', developerKitIntegrationSchema: 'v0.1' },
    },
  }
  const projected = hostFacingManifest(manifest, ['armorial', 'math-anchor'])
  assert.deepEqual(Object.keys(projected.components).sort(), [
    'agent-tool-development-kit', 'armorial', 'file-vitals', 'math-anchor',
  ])
  assert.equal(projected.components.armorial.skillOnly, false)
  assert.equal(projected.components['file-vitals'].skillOnly, true)
  assert.equal(projected.components['math-anchor'].skillOnly, undefined)
})

test('a fully paused working set withholds on-demand Skills while keeping the developer kit', () => {
  const manifest = {
    components: {
      armorial: { plugin: 'armorial', providerSkill: { id: 'armorial' } },
      'file-vitals': { plugin: 'file-vitals', providerSkill: { id: 'file-vitals' } },
      'math-anchor': { plugin: 'math-anchor' },
      'agent-tool-development-kit': { plugin: 'agent-tool-development-kit', developerKitIntegrationSchema: 'v0.1' },
    },
  }
  const onDemand = hostFacingManifest(manifest, [])
  assert.equal(onDemand.components.armorial.skillOnly, true)
  assert.equal(onDemand.components['file-vitals'].skillOnly, true)
  assert.equal(onDemand.components['agent-tool-development-kit'] !== undefined, true)

  const paused = hostFacingManifest(manifest, [], { paused: true })
  assert.equal(paused.components.armorial, undefined)
  assert.equal(paused.components['file-vitals'], undefined)
  assert.equal(paused.components['math-anchor'], undefined)
  assert.equal(paused.components['agent-tool-development-kit'] !== undefined, true)
})
