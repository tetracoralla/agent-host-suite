import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { assert, object, text, integer, clone } from './value.mjs'

export const runRequestSchema = 'openadam.agent-host-procedure-run-request.v0.1'

const identity = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u
const semver = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

function exactKeys(value, allowed, label) {
  assert(object(value), 'PROCEDURE_RUN_REQUEST_INVALID', `${label} must be an object`)
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key))
  assert(unexpected.length === 0, 'PROCEDURE_RUN_REQUEST_INVALID', `${label} contains unsupported fields`, { fields: unexpected })
}

function validateProcedure(value) {
  exactKeys(value, ['id', 'version'], 'Procedure identity')
  assert(typeof value.id === 'string' && value.id.length <= 160 && identity.test(value.id), 'PROCEDURE_RUN_REQUEST_INVALID', 'Procedure id is invalid')
  assert(typeof value.version === 'string' && value.version.length <= 100 && semver.test(value.version), 'PROCEDURE_RUN_REQUEST_INVALID', 'Procedure version is invalid')
  return { id: value.id, version: value.version }
}

function validateLimits(value) {
  exactKeys(value, ['maxDurationMs', 'maxNodeExecutions', 'maxAgentTurns', 'nodeTimeoutMs', 'maxAttemptsPerNode', 'maxOutputBytes'], 'Run limits')
  return {
    maxDurationMs: integer(value.maxDurationMs, 'maxDurationMs', 1_000, 28_800_000),
    maxNodeExecutions: integer(value.maxNodeExecutions, 'maxNodeExecutions', 1, 500),
    maxAgentTurns: integer(value.maxAgentTurns, 'maxAgentTurns', 0, 100),
    nodeTimeoutMs: integer(value.nodeTimeoutMs, 'nodeTimeoutMs', 1_000, 1_800_000),
    maxAttemptsPerNode: integer(value.maxAttemptsPerNode, 'maxAttemptsPerNode', 1, 20),
    maxOutputBytes: integer(value.maxOutputBytes, 'maxOutputBytes', 1_024, 4 * 1024 * 1024),
  }
}

function validateResourceBinding(requirement, value) {
  assert(object(value), 'PROCEDURE_RESOURCE_INVALID', `Resource ${requirement.id} must be an object`)
  if (requirement.type === 'workspace') {
    exactKeys(value, ['type', 'adapter', 'path', 'allowExistingPaths'], `Workspace resource ${requirement.id}`)
    assert(value.type === 'workspace' && value.adapter === requirement.adapter, 'PROCEDURE_RESOURCE_INVALID', `Workspace resource ${requirement.id} has the wrong type or adapter`)
    text(value.path, `Workspace resource ${requirement.id} path`, 4096)
    assert(isAbsolute(value.path), 'PROCEDURE_RESOURCE_INVALID', `Workspace resource ${requirement.id} path must be absolute`)
    assert(Array.isArray(value.allowExistingPaths) && value.allowExistingPaths.length <= 1000 && value.allowExistingPaths.every((path) => typeof path === 'string' && path.length > 0 && path.length <= 4096), 'PROCEDURE_RESOURCE_INVALID', `Workspace resource ${requirement.id} existing paths are invalid`)
    return { type: 'workspace', adapter: value.adapter, path: resolve(value.path), allowExistingPaths: [...new Set(value.allowExistingPaths)] }
  }
  if (requirement.type === 'file') {
    exactKeys(value, ['type', 'path', 'access'], `File resource ${requirement.id}`)
    assert(value.type === 'file' && value.access === requirement.access, 'PROCEDURE_RESOURCE_INVALID', `File resource ${requirement.id} has the wrong type or access`)
    text(value.path, `File resource ${requirement.id} path`, 4096)
    assert(isAbsolute(value.path), 'PROCEDURE_RESOURCE_INVALID', `File resource ${requirement.id} path must be absolute`)
    return { type: 'file', path: resolve(value.path), access: value.access }
  }
  exactKeys(value, ['type', 'provider', 'account'], `Account resource ${requirement.id}`)
  assert(value.type === 'account', 'PROCEDURE_RESOURCE_INVALID', `Account resource ${requirement.id} has the wrong type`)
  text(value.provider, `Account resource ${requirement.id} provider`, 160)
  text(value.account, `Account resource ${requirement.id} account`, 320)
  if (requirement.provider !== undefined)
    assert(value.provider === requirement.provider, 'PROCEDURE_RESOURCE_INVALID', `Account resource ${requirement.id} has the wrong provider`)
  return { type: 'account', provider: value.provider, account: value.account }
}

export function validateRunRequest(value, procedure) {
  exactKeys(value, ['schemaVersion', 'procedure', 'inputs', 'grants', 'resources', 'limits', 'idempotencyKey'], 'Procedure Run Request')
  assert(value.schemaVersion === runRequestSchema, 'PROCEDURE_RUN_REQUEST_INVALID', 'Procedure Run Request schema version is unsupported')
  const selected = validateProcedure(value.procedure)
  assert(selected.id === procedure.id && selected.version === procedure.version, 'PROCEDURE_IDENTITY_MISMATCH', 'Run Request Procedure identity differs from the selected installed Procedure')
  assert(object(value.inputs), 'PROCEDURE_RUN_REQUEST_INVALID', 'Run Request inputs must be an object')
  assert(Array.isArray(value.grants) && value.grants.length <= 40 && new Set(value.grants).size === value.grants.length && value.grants.every((grant) => typeof grant === 'string' && grant.length <= 160 && identity.test(grant)), 'PROCEDURE_RUN_REQUEST_INVALID', 'Run Request grants are invalid')
  const declaredGrants = new Set(procedure.permissions ?? [])
  const installedCeiling = new Set(procedure.permissionCeiling ?? procedure.permissions ?? [])
  for (const grant of value.grants)
    assert(declaredGrants.has(grant), 'PROCEDURE_GRANT_EXCEEDS_DECLARATION', `Run Request grant exceeds the Procedure declaration: ${grant}`, { grant })
  for (const grant of value.grants)
    assert(installedCeiling.has(grant), 'PROCEDURE_GRANT_EXCEEDS_INSTALLATION', `Run Request grant exceeds the installed permission ceiling: ${grant}`, { grant })
  assert(object(value.resources), 'PROCEDURE_RUN_REQUEST_INVALID', 'Run Request resources must be an object')
  const requirements = new Map((procedure.resources ?? []).map((resource) => [resource.id, resource]))
  for (const id of Object.keys(value.resources))
    assert(requirements.has(id), 'PROCEDURE_RESOURCE_UNDECLARED', `Run Request contains an undeclared resource: ${id}`)
  const resources = {}
  for (const requirement of requirements.values()) {
    const binding = value.resources[requirement.id]
    assert(binding !== undefined || requirement.required !== true, 'PROCEDURE_RESOURCE_REQUIRED', `Run Request is missing required resource: ${requirement.id}`, { resource: requirement.id })
    if (binding !== undefined) resources[requirement.id] = validateResourceBinding(requirement, binding)
  }
  text(value.idempotencyKey, 'Run Request idempotency key', 200)
  assert(!/[\u0000-\u001f\u007f]/u.test(value.idempotencyKey), 'PROCEDURE_RUN_REQUEST_INVALID', 'Run Request idempotency key contains control characters')
  const normalized = {
    schemaVersion: runRequestSchema,
    procedure: selected,
    inputs: clone(value.inputs),
    grants: [...value.grants],
    resources,
    limits: validateLimits(value.limits),
    idempotencyKey: value.idempotencyKey,
  }
  assert(Buffer.byteLength(JSON.stringify(normalized)) <= 512_000, 'PROCEDURE_RUN_REQUEST_LIMIT', 'Procedure Run Request exceeds 512 KiB')
  return normalized
}

export function runRequestTaskId(request) {
  const bytes = createHash('sha256')
    .update(`${request.procedure.id}\0${request.procedure.version}\0${request.idempotencyKey}`)
    .digest('hex')
  return `${bytes.slice(0, 8)}-${bytes.slice(8, 12)}-5${bytes.slice(13, 16)}-a${bytes.slice(17, 20)}-${bytes.slice(20, 32)}`
}

export function runRequestDigest(request) {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex')
}
