import { posix, win32 } from 'node:path'
import { AgentHostError } from './errors.mjs'

export const PROCEDURE_INTEGRATION_SCHEMA = 'openadam.agent-host-procedure-integration.v0.2'

function fail(message, details) {
  throw new AgentHostError('PROCEDURE_INTEGRATION_INVALID', message, details)
}

function exactKeys(value, allowed, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) fail(`${label} contains unsupported fields`, { fields: unexpected })
}

function string(value, label, maximum = undefined) {
  if (typeof value !== 'string' || value.length === 0 || (maximum !== undefined && value.length > maximum)) fail(`${label} is invalid`)
  return value
}

function stableId(value, label) {
  string(value, label, 160)
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(value)) fail(`${label} is invalid`)
  return value
}

function semver(value, label) {
  string(value, label, 100)
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value)) fail(`${label} is invalid`)
  return value
}

function relativePath(value, label) {
  string(value, label)
  if (value.includes('\\')) fail(`${label} cannot contain backslashes`)
  const result = posix.normalize(value)
  if (posix.isAbsolute(result) || win32.isAbsolute(result) || result === '.' || result === '..' || result.startsWith('../')) fail(`${label} must be a contained relative path`)
  return result
}

function paths(value, label, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum || value.some((item) => typeof item !== 'string' || item.length === 0) || new Set(value).size !== value.length) fail(`${label} is invalid`)
  return value.map((item) => relativePath(item, label))
}

function ids(value, label, minimum = 0, maximum = 80) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum || new Set(value).size !== value.length) fail(`${label} is invalid`)
  return value.map((item) => stableId(item, label))
}

function resources(value) {
  if (!Array.isArray(value) || value.length > 40) fail('Procedure resources are invalid')
  const seen = new Set()
  for (const resource of value) {
    exactKeys(
      resource,
      resource?.type === 'workspace'
        ? ['id', 'type', 'required', 'adapter']
        : resource?.type === 'file'
          ? ['id', 'type', 'required', 'access']
          : ['id', 'type', 'required', 'provider'],
      'Procedure resource',
    )
    stableId(resource.id, 'Procedure resource id')
    if (seen.has(resource.id)) fail('Procedure resource ids must be unique')
    seen.add(resource.id)
    if (typeof resource.required !== 'boolean') fail('Procedure resource required flag is invalid')
    if (resource.type === 'workspace') {
      if (resource.adapter !== 'git') fail('Procedure workspace resource adapter is unsupported')
    } else if (resource.type === 'file') {
      if (!['read', 'write'].includes(resource.access)) fail('Procedure file resource access is unsupported')
    } else if (resource.type === 'account') {
      if (resource.provider !== undefined) stableId(resource.provider, 'Procedure account provider')
    } else fail('Procedure resource type is unsupported')
  }
  return value
}

export function isProcedureIntegrationSchema(value) {
  return value === PROCEDURE_INTEGRATION_SCHEMA
}

export function validateProcedureIntegration(value, componentFiles = undefined) {
  exactKeys(value, ['schemaVersion', 'displayName', 'summary', 'procedure', 'execution', 'ownership'], 'Procedure integration')
  if (!isProcedureIntegrationSchema(value.schemaVersion)) fail(`Unsupported Procedure integration schema: ${value.schemaVersion ?? 'missing'}`)
  string(value.displayName, 'Procedure display name', 80)
  string(value.summary, 'Procedure summary', 180)
  const procedure = value.procedure
  exactKeys(procedure, ['id', 'version', 'inputSchema', 'outputSchema', 'permissions', 'resources', 'lifecycle'], 'Procedure product')
  stableId(procedure.id, 'Procedure id')
  semver(procedure.version, 'Procedure version')
  const inputSchema = relativePath(procedure.inputSchema, 'Procedure input schema')
  const outputSchema = relativePath(procedure.outputSchema, 'Procedure output schema')
  ids(procedure.permissions, 'Procedure permission', 0, 40)
  const procedureResources = resources(procedure.resources)
  exactKeys(procedure.lifecycle, ['mode', 'resumable', 'interaction'], 'Procedure lifecycle')
  if (!['synchronous', 'stateful'].includes(procedure.lifecycle.mode)) fail('Procedure lifecycle mode is unsupported')
  if (typeof procedure.lifecycle.resumable !== 'boolean') fail('Procedure lifecycle resumable flag is invalid')
  if (!['none', 'agent-mediated'].includes(procedure.lifecycle.interaction)) fail('Procedure lifecycle interaction is unsupported')

  const execution = value.execution
  exactKeys(execution, execution?.kind === 'direct-runtime'
    ? ['kind', 'providerId', 'transport', 'providerLifecycle', 'profile', 'implementationManifest', 'identityFiles']
    : ['kind', 'method', 'outputArtifacts', 'identityFiles'], 'Procedure execution binding')
  let executionFiles
  if (execution.kind === 'direct-runtime') {
    if (procedureResources.length > 0) {
      fail('Direct Runtime Procedures cannot declare resources until the work-order carrier can transport them')
    }
    stableId(execution.providerId, 'Direct Procedure provider id')
    if (execution.transport !== 'procedure-jsonl-v0.2') fail('Direct Procedure transport is unsupported')
    if (!['persistent', 'per-call'].includes(execution.providerLifecycle)) fail('Direct Procedure provider lifecycle is unsupported')
    if (procedure.lifecycle.mode !== 'synchronous' || procedure.lifecycle.resumable !== false || procedure.lifecycle.interaction !== 'none') {
      fail('Direct Runtime Procedures must declare a non-resumable synchronous lifecycle without interaction')
    }
    executionFiles = [
      relativePath(execution.profile, 'Procedure Profile'),
      relativePath(execution.implementationManifest, 'Procedure implementation manifest'),
      ...paths(execution.identityFiles, 'Procedure identity file', 1),
    ]
  } else if (execution.kind === 'agentic-runner') {
    if (procedure.lifecycle.mode !== 'stateful' || procedure.lifecycle.resumable !== true || procedure.lifecycle.interaction !== 'agent-mediated') {
      fail('Agentic Runner Procedures must declare a resumable stateful, Agent-mediated lifecycle')
    }
    executionFiles = [
      relativePath(execution.method, 'Procedure method'),
      ...paths(execution.identityFiles, 'Procedure identity file', 1),
    ]
    ids(execution.outputArtifacts, 'Procedure output artifact', 1, 80)
  } else fail('Procedure execution kind is unsupported')
  exactKeys(value.ownership, ['uninstall'], 'Procedure ownership')
  if (value.ownership.uninstall !== 'agent-host-created-only') fail('Procedure uninstall ownership is unsupported')
  if (componentFiles !== undefined) {
    const files = componentFiles instanceof Set ? componentFiles : new Set(componentFiles)
    const missing = [inputSchema, outputSchema, ...executionFiles].filter((path) => !files.has(path))
    if (missing.length > 0) fail('Procedure integration references files outside the component inventory', { files: missing })
  }
  return value
}
