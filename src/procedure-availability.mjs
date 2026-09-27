import { createHash } from 'node:crypto'

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

export function procedureDependencySnapshot(state, component) {
  const direct = component.procedureExecution?.kind === 'direct-runtime'
  const runtime = direct
    ? state.components?.['direct-execution-runtime']
    : {
        suiteVersion: state.suiteVersion ?? null,
        releaseId: state.releaseId ?? null,
      }
  const binding = direct
    ? {
        invocation: component.procedureInvocation ?? null,
        runtimeConfigPath: state.runtime?.configPath ?? null,
      }
    : {
        invocation: component.procedureInvocation ?? null,
        bindingsActivatedAt: state.bindingsActivatedAt ?? null,
        hosts: state.hosts ?? {},
      }
  return {
    procedureFingerprint: component.fingerprint ?? null,
    runtimeFingerprint: direct ? runtime?.fingerprint ?? null : digest(runtime),
    bindingFingerprint: digest(binding),
  }
}

export function initialProcedureAvailability(component, contractValidated) {
  return {
    installed: true,
    contractValidated,
    discoverable: component.procedureInvocation !== undefined,
    lastSuccessfulInvocationAt: null,
    invocationEvidence: {
      valid: false,
      verifiedAt: null,
      invalidatedAt: null,
      invalidatedReason: 'not-yet-invoked',
      dependencies: null,
    },
    currentHealth: {
      status: contractValidated ? 'not-checked' : 'unavailable',
      observedAt: null,
    },
    currentSessionDiscovery: {
      status: 'not-observed',
      observedAt: null,
    },
  }
}

export function verifiedProcedureAvailability(state, component, verifiedAt) {
  return {
    installed: true,
    contractValidated: true,
    discoverable: component.procedureInvocation !== undefined,
    lastSuccessfulInvocationAt: verifiedAt,
    invocationEvidence: {
      valid: true,
      verifiedAt,
      invalidatedAt: null,
      invalidatedReason: null,
      dependencies: procedureDependencySnapshot(state, component),
    },
    currentHealth: {
      status: 'healthy',
      observedAt: verifiedAt,
    },
    currentSessionDiscovery: {
      status: 'not-observed',
      observedAt: null,
    },
  }
}

export function projectProcedureAvailability(state, component) {
  const stored = component.procedureAvailability ?? initialProcedureAvailability(component, false)
  const projected = stored.invocationEvidence === undefined
    ? {
        installed: stored.installed === true,
        contractValidated: stored.contractValidated === true,
        discoverable: stored.discoverable === true,
        lastSuccessfulInvocationAt: stored.verifiedAt ?? null,
        invocationEvidence: {
          valid: false,
          verifiedAt: stored.verifiedAt ?? null,
          invalidatedAt: stored.invocationVerified === true ? state.updatedAt ?? null : null,
          invalidatedReason: stored.invocationVerified === true
            ? 'legacy-evidence-unscoped'
            : 'not-yet-invoked',
          dependencies: null,
        },
        currentHealth: { status: 'not-checked', observedAt: null },
        currentSessionDiscovery: { status: 'not-observed', observedAt: null },
      }
    : structuredClone(stored)
  const evidence = projected.invocationEvidence
  if (evidence?.valid === true) {
    const current = procedureDependencySnapshot(state, component)
    const expected = evidence.dependencies
    let reason = null
    if (expected?.procedureFingerprint !== current.procedureFingerprint)
      reason = 'procedure-changed'
    else if (expected?.runtimeFingerprint !== current.runtimeFingerprint)
      reason = 'runtime-changed'
    else if (expected?.bindingFingerprint !== current.bindingFingerprint)
      reason = 'binding-changed'
    if (reason !== null) {
      evidence.valid = false
      evidence.invalidatedAt = state.updatedAt ?? null
      evidence.invalidatedReason = reason
      projected.currentHealth = { status: 'not-checked', observedAt: null }
    }
  }
  projected.currentSessionDiscovery ??= { status: 'not-observed', observedAt: null }
  return projected
}

export function procedureCurrentlyVerified(state, component) {
  return projectProcedureAvailability(state, component).invocationEvidence.valid === true
}
