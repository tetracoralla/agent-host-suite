import { readFile } from 'node:fs/promises'
import { AgentHostError } from './errors.mjs'

const PROFILE_SCHEMA = 'openadam.agent-host-profile.v0.2'
const PROFILE_ID = /^[a-z][a-z0-9-]*$/u

function fail(message, details) {
  throw new AgentHostError('PROFILE_INVALID', message, details)
}

export function validateProfile(profile, expectedId) {
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) fail('Profile must be an object')
  const allowed = ['schemaVersion', 'id', 'extends', 'components', 'agentComponents', 'defaultAgentComponents', 'requiresConsent', 'displayName']
  const unexpected = Object.keys(profile).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) fail('Profile contains unsupported fields', { fields: unexpected })
  if (profile.schemaVersion !== PROFILE_SCHEMA || profile.id !== expectedId || !PROFILE_ID.test(profile.id)) fail('Profile identity is invalid')
  if (profile.extends !== undefined && !PROFILE_ID.test(profile.extends)) fail('Profile parent is invalid')
  if (!Array.isArray(profile.components) || profile.components.length === 0 || new Set(profile.components).size !== profile.components.length || profile.components.some((id) => !PROFILE_ID.test(id))) fail('Profile components are invalid')
  if (!Array.isArray(profile.agentComponents) || new Set(profile.agentComponents).size !== profile.agentComponents.length || profile.agentComponents.some((id) => !PROFILE_ID.test(id))) fail('Profile Agent components are invalid')
  if (profile.defaultAgentComponents !== undefined
    && (!Array.isArray(profile.defaultAgentComponents)
      || profile.defaultAgentComponents.length === 0
      || new Set(profile.defaultAgentComponents).size !== profile.defaultAgentComponents.length
      || profile.defaultAgentComponents.some((id) => !PROFILE_ID.test(id)))) {
    fail('Profile default Agent components are invalid')
  }
  const foreignAgentComponents = profile.agentComponents.filter((id) => !profile.components.includes(id))
  if (foreignAgentComponents.length > 0) fail('Profile Agent components must also be installed by that profile layer', { components: foreignAgentComponents })
  if (profile.requiresConsent !== undefined && typeof profile.requiresConsent !== 'boolean') fail('Profile consent flag is invalid')
  if (profile.displayName !== undefined && (typeof profile.displayName !== 'string' || profile.displayName.length === 0 || profile.displayName.length > 80)) fail('Profile display name is invalid')
  return profile
}

async function readProfile(id) {
  if (!PROFILE_ID.test(id)) throw new AgentHostError('PROFILE_UNKNOWN', `Unknown profile: ${id}`)
  const url = new URL(`../catalog/profiles/${id}.json`, import.meta.url)
  let text
  try {
    text = await readFile(url, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') throw new AgentHostError('PROFILE_UNKNOWN', `Unknown profile: ${id}`)
    throw error
  }
  return validateProfile(JSON.parse(text), id)
}

export async function loadProfile(id) {
  const visited = new Set()
  const chain = []
  let current = id
  while (current !== undefined) {
    if (visited.has(current)) fail('Profile inheritance contains a cycle')
    visited.add(current)
    const profile = await readProfile(current)
    chain.unshift(profile)
    current = profile.extends
  }
  const components = [...new Set(['node-runtime', ...chain.flatMap((profile) => profile.components)])]
  const agentComponents = [...new Set(chain.flatMap((profile) => profile.agentComponents))]
  const declaredDefault = [...chain].reverse().find((profile) => profile.defaultAgentComponents !== undefined)?.defaultAgentComponents
  const defaultAgentComponents = declaredDefault === undefined ? agentComponents : agentComponents.filter((id) => declaredDefault.includes(id))
  const unavailableDefaults = (declaredDefault ?? []).filter((id) => !agentComponents.includes(id))
  if (unavailableDefaults.length > 0 || (agentComponents.length > 0 && defaultAgentComponents.length === 0)) {
    fail('Profile default Agent components must select at least one available Agent component', { components: unavailableDefaults })
  }
  return {
    id,
    displayName: chain.at(-1)?.displayName ?? id,
    components,
    agentComponents,
    defaultAgentComponents,
    requiresConsent: chain.some((profile) => profile.requiresConsent === true),
  }
}

export function agentFacingManifest(manifest, agentComponents) {
  const selected = new Set(agentComponents ?? Object.keys(manifest.components))
  const missing = [...selected].filter((id) => manifest.components[id] === undefined)
  if (missing.length > 0) throw new AgentHostError('PROFILE_COMPONENTS_MISSING', 'The active Agent tool set contains unavailable components', { components: missing })
  return { ...manifest, components: Object.fromEntries(Object.entries(manifest.components).filter(([id]) => selected.has(id))) }
}

export function hostFacingManifest(manifest, agentComponents) {
  const agents = agentFacingManifest(manifest, agentComponents)
  const selected = new Set(Object.keys(agents.components))
  const components = { ...agents.components }
  for (const [id, component] of Object.entries(manifest.components)) {
    if (component.developerKitIntegrationSchema !== undefined) components[id] = component
    if (component.providerSkill !== undefined) {
      components[id] = selected.has(id) ? { ...component, skillOnly: false } : { ...component, skillOnly: true }
    }
  }
  return { ...manifest, components }
}

export function selectAgentComponents(availableComponents, requestedComponents) {
  const available = [...availableComponents]
  const requested = requestedComponents === undefined ? available : [...new Set(requestedComponents)]
  if (requested.length === 0 && available.length > 0) {
    throw new AgentHostError('TOOL_SET_EMPTY', 'Keep at least one installed Agent tool active')
  }
  const unavailable = requested.filter((id) => !available.includes(id))
  if (unavailable.length > 0) {
    throw new AgentHostError('TOOL_SET_COMPONENT_UNAVAILABLE', 'The requested Agent tool is not installed by the selected profile', {
      components: unavailable,
      available,
    })
  }
  return available.filter((id) => requested.includes(id))
}

export function selectProfileManifest(manifest, profile) {
  const missing = profile.components.filter((id) => manifest.components[id] === undefined)
  if (missing.length > 0) throw new AgentHostError('PROFILE_COMPONENTS_MISSING', `The selected release does not contain the ${profile.displayName} tool set`, { components: missing })
  return { ...manifest, components: Object.fromEntries(profile.components.map((id) => [id, manifest.components[id]])) }
}
