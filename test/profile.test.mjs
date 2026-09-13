import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { defaultToolsForProfile, featuredCatalog, FEATURED_PROFILE_ID, listProfiles, loadProfile, LOCAL_DOGFOOD_PROFILE_ID, selectAgentComponents, selectProfileManifest, validateProfile } from '../src/profile.mjs'

test('profiles retain the small standard catalog, a distinct featured set, and the local dogfood set', async () => {
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

  const featured = await loadProfile(FEATURED_PROFILE_ID)
  assert.equal(featured.displayName, 'Featured tools')
  assert.equal(featured.requiresConsent, false)
  assert.equal(featured.components.includes('armorial'), true)
  assert.equal(featured.agentComponents.includes('armorial'), true)
  assert.equal(featured.components.includes('math-anchor'), true)
  assert.deepEqual(featured.defaultAgentComponents, ['math-anchor', 'migratory-time', 'armorial'])
  assert.equal(featured.components.includes('data-transformer'), false)
  assert.equal(featured.components.includes('laniakea'), false)
  assert.equal(featured.components.includes('projective'), false)
  assert.equal(featured.components.includes('equatorium'), false)
  assert.equal(featured.components.includes('file-vitals'), false)
  assert.equal(featured.components.includes('agent-tool-development-kit'), false)
  assert.equal(featured.components.includes('agent-tool-observer'), false)
  assert.equal(local.components.includes('armorial'), true)
  assert.notEqual(featured.id, LOCAL_DOGFOOD_PROFILE_ID)
})

test('the featured catalog lists profile membership without becoming a marketplace', async () => {
  const catalog = await featuredCatalog()
  assert.equal(catalog.marketplace, false)
  assert.equal(catalog.boundReleaseRequired, true)
  assert.equal(catalog.featuredProfile, FEATURED_PROFILE_ID)
  const featured = catalog.profiles.find((profile) => profile.featured === true)
  const dogfood = catalog.profiles.find((profile) => profile.dogfood === true)
  assert.equal(featured.id, FEATURED_PROFILE_ID)
  assert.deepEqual(featured.defaultAgentComponents, ['math-anchor', 'migratory-time', 'armorial'])
  assert.equal(dogfood.id, LOCAL_DOGFOOD_PROFILE_ID)
  assert.deepEqual((await listProfiles()).map((profile) => profile.id).sort(), catalog.profiles.map((profile) => profile.id).sort())
  assert.deepEqual(await defaultToolsForProfile(FEATURED_PROFILE_ID), featured.defaultAgentComponents)
})

test('featured membership matches the catalog document and fails closed without armorial bytes', async () => {
  const featured = await loadProfile(FEATURED_PROFILE_ID)
  const catalogDoc = await readFile(new URL('../docs/FEATURED_CATALOG.md', import.meta.url), 'utf8')
  assert.match(catalogDoc, /--profile featured/u)
  assert.match(catalogDoc, /profiles list/u)
  assert.match(catalogDoc, /armorial/u)
  assert.match(catalogDoc, /draft-unbound/u)
  assert.match(catalogDoc, /not a public marketplace/u)
  assert.match(catalogDoc, /Publishing a notarized DMG, GitHub Release, or public marketplace/u)
  const standardOnly = {
    components: Object.fromEntries(['node-runtime', 'direct-execution-runtime', 'math-anchor', 'migratory-time'].map((id) => [id, {}])),
  }
  assert.throws(
    () => selectProfileManifest(standardOnly, featured),
    (error) => error.code === 'PROFILE_COMPONENTS_MISSING' && error.details.components.includes('armorial'),
  )
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
