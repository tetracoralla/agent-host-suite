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
