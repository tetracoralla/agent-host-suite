import { isAbsolute } from 'node:path'
import { AgentHostError } from './errors.mjs'
import { resolvePilotBinding } from './provider-pilot-bindings.mjs'

// Ephemeral normalized view of admitted component records. No second persisted
// state, public integration schema, or domain operation vocabulary is introduced.
export function resolveDirectBindings(manifest, { workspaceRoot } = {}) {
  const activeIds = new Set(manifest.agentComponents ?? Object.keys(manifest.components))
  const providerIds = new Set()
  const bindings = []
  for (const [componentId, component] of Object.entries(manifest.components)) {
    const binding = Object.hasOwn(component, 'capabilityProvider')
      ? { provider: component.capabilityProvider, diagnostic: null }
      : resolvePilotBinding(componentId, component)
    if (binding === null) continue
    const raw = binding.provider
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)
      || typeof raw.providerId !== 'string' || raw.providerId.length === 0) {
      throw new AgentHostError('RUNTIME_PROVIDER_BINDING_INVALID', 'An installed Direct Provider binding is invalid')
    }
    if (providerIds.has(raw.providerId)) {
      throw new AgentHostError('RUNTIME_PROVIDER_BINDING_CONFLICT', 'Installed components declare the same Direct Provider identity')
    }
    providerIds.add(raw.providerId)
    const { workspaceRootRequired = false, ...provider } = structuredClone(raw)
    if (workspaceRootRequired !== false && workspaceRootRequired !== true) {
      throw new AgentHostError('RUNTIME_PROVIDER_BINDING_INVALID', 'The Direct Provider workspace requirement is invalid')
    }
    if (workspaceRootRequired) {
      if (typeof workspaceRoot !== 'string' || !isAbsolute(workspaceRoot)) {
        throw new AgentHostError('RUNTIME_WORKSPACE_REQUIRED', 'An installed Direct Capability requires an explicit absolute Host workspace root')
      }
      provider.workspaceRoot = workspaceRoot
    }
    bindings.push({ componentId, displayName: component.displayName ?? componentId,
      active: activeIds.has(componentId), provider, diagnostic: binding.diagnostic ?? null })
  }
  return bindings
}
