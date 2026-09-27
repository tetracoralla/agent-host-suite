import assert from 'node:assert/strict'
import test from 'node:test'
import {
  projectProcedureAvailability,
  verifiedProcedureAvailability,
} from '../src/procedure-availability.mjs'

const verifiedAt = '2026-09-27T08:00:00.000Z'

function directFixture() {
  const component = {
    fingerprint: 'procedure-a',
    procedureExecution: { kind: 'direct-runtime' },
    procedureInvocation: { protocol: 'openadam.agent-host-procedure-invocation.v0.2' },
  }
  const state = {
    updatedAt: verifiedAt,
    suiteVersion: '1.0.0',
    components: { 'direct-execution-runtime': { fingerprint: 'runtime-a' } },
    runtime: { configPath: '/private/runtime/config-a.json' },
    hosts: {},
  }
  component.procedureAvailability = verifiedProcedureAvailability(state, component, verifiedAt)
  return { state, component }
}

test('Procedure invocation history survives while procedure, runtime and binding changes invalidate current evidence', () => {
  const current = directFixture()
  assert.equal(projectProcedureAvailability(current.state, current.component).invocationEvidence.valid, true)

  const changedProcedure = structuredClone(current)
  changedProcedure.component.fingerprint = 'procedure-b'
  let projected = projectProcedureAvailability(changedProcedure.state, changedProcedure.component)
  assert.equal(projected.invocationEvidence.valid, false)
  assert.equal(projected.invocationEvidence.invalidatedReason, 'procedure-changed')
  assert.equal(projected.lastSuccessfulInvocationAt, verifiedAt)

  const changedRuntime = structuredClone(current)
  changedRuntime.state.components['direct-execution-runtime'].fingerprint = 'runtime-b'
  projected = projectProcedureAvailability(changedRuntime.state, changedRuntime.component)
  assert.equal(projected.invocationEvidence.invalidatedReason, 'runtime-changed')
  assert.equal(projected.currentHealth.status, 'not-checked')

  const changedBinding = structuredClone(current)
  changedBinding.component.procedureInvocation.arguments = ['procedure', 'invoke', '--request', '-']
  projected = projectProcedureAvailability(changedBinding.state, changedBinding.component)
  assert.equal(projected.invocationEvidence.invalidatedReason, 'binding-changed')
  assert.equal(projected.currentSessionDiscovery.status, 'not-observed')
})

test('Agentic Runner evidence tracks Host runtime and Agent provider bindings separately', () => {
  const state = {
    suiteVersion: '1.0.0', releaseId: 'release-a', updatedAt: verifiedAt,
    bindingsActivatedAt: verifiedAt,
    components: {},
    runtime: {},
    hosts: { codex: { version: '1', binding: 'a' } },
  }
  const component = {
    fingerprint: 'agentic-a',
    procedureExecution: { kind: 'agentic-runner' },
    procedureInvocation: { protocol: 'openadam.agent-host-procedure-invocation.v0.2' },
  }
  component.procedureAvailability = verifiedProcedureAvailability(state, component, verifiedAt)

  const runtimeChanged = structuredClone(state)
  runtimeChanged.suiteVersion = '1.1.0'
  assert.equal(
    projectProcedureAvailability(runtimeChanged, component).invocationEvidence.invalidatedReason,
    'runtime-changed',
  )

  const providerChanged = structuredClone(state)
  providerChanged.hosts.codex.binding = 'b'
  assert.equal(
    projectProcedureAvailability(providerChanged, component).invocationEvidence.invalidatedReason,
    'binding-changed',
  )
})

test('legacy success timestamps migrate as history without claiming current evidence', () => {
  const { state, component } = directFixture()
  component.procedureAvailability = {
    installed: true,
    contractValidated: true,
    discoverable: true,
    invocationVerified: true,
    verifiedAt,
  }
  const projected = projectProcedureAvailability(state, component)
  assert.equal(projected.lastSuccessfulInvocationAt, verifiedAt)
  assert.equal(projected.invocationEvidence.valid, false)
  assert.equal(projected.invocationEvidence.invalidatedReason, 'legacy-evidence-unscoped')
})
