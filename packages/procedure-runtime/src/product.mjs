import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { assert, object } from './value.mjs'
import { validateMethod } from './method.mjs'

const idPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u
const semverPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

function keys(value) {
  return Object.keys(value).sort()
}

function sameSet(left, right) {
  const a = [...left].sort()
  const b = [...right].sort()
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function schema(value, label) {
  assert(object(value) && value.type === 'object' && object(value.properties), 'INVALID_PROCEDURE_PRODUCT', `${label} must be a closed object JSON Schema`)
  assert(value.additionalProperties === false, 'INVALID_PROCEDURE_PRODUCT', `${label} must reject undeclared properties`)
  assert(Array.isArray(value.required) && value.required.every((item) => typeof item === 'string'), 'INVALID_PROCEDURE_PRODUCT', `${label} needs an explicit required list`)
  assert(new Set(value.required).size === value.required.length, 'INVALID_PROCEDURE_PRODUCT', `${label} required fields must be unique`)
  compile(value, label)
  return value
}

function compile(value, label) {
  try {
    const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true })
    addFormats(ajv)
    return ajv.compile(value)
  } catch (error) {
    assert(false, 'INVALID_PROCEDURE_PRODUCT', `${label} is not a valid JSON Schema`, { cause: error.message })
  }
}

function validateValue(schema, value, code, label) {
  const validate = compile(schema, label)
  assert(validate(value), code, `${label} does not satisfy its declared schema`, {
    errors: (validate.errors ?? []).slice(0, 12).map((error) => ({
      path: error.instancePath || '/',
      keyword: error.keyword,
      message: error.message,
    })),
  })
  return value
}

function schemaTypes(value) {
  return new Set(Array.isArray(value?.type) ? value.type : [value?.type])
}

function compatibleType(contract, runtimeType, label) {
  assert(object(contract), 'INVALID_PROCEDURE_PRODUCT', `${label} schema must be an object`)
  const expected = runtimeType === 'boolean'
    ? ['boolean']
    : ['text', 'string', 'reference'].includes(runtimeType)
      ? ['string']
      : runtimeType === 'file-set'
        ? ['array']
        : runtimeType === 'git-candidate'
          ? ['object']
          : runtimeType === 'json'
            ? ['object', 'array']
            : []
  const declared = schemaTypes(contract)
  assert(expected.some((type) => declared.has(type)), 'INVALID_PROCEDURE_PRODUCT', `${label} schema conflicts with the Method type`)
}

function publicResource(resource) {
  return Object.fromEntries(
    Object.entries(resource).filter(([key]) => key !== 'name'),
  )
}

export function validateInstalledProcedure(value) {
  assert(object(value), 'INVALID_PROCEDURE_PRODUCT', 'Installed Procedure must be an object')
  assert(typeof value.componentId === 'string' && value.componentId.length > 0, 'INVALID_PROCEDURE_PRODUCT', 'Installed Procedure needs a component ID')
  assert(typeof value.id === 'string' && idPattern.test(value.id), 'INVALID_PROCEDURE_PRODUCT', 'Installed Procedure ID is invalid')
  assert(typeof value.version === 'string' && semverPattern.test(value.version), 'INVALID_PROCEDURE_PRODUCT', 'Installed Procedure version is invalid')
  assert(object(value.lifecycle) && value.lifecycle.mode === 'stateful' && value.lifecycle.resumable === true && value.lifecycle.interaction === 'agent-mediated', 'INVALID_PROCEDURE_PRODUCT', 'Agentic Procedure lifecycle is invalid')
  assert(Array.isArray(value.permissions) && value.permissions.every((item) => typeof item === 'string' && idPattern.test(item)), 'INVALID_PROCEDURE_PRODUCT', 'Installed Procedure permissions are invalid')
  assert(new Set(value.permissions).size === value.permissions.length, 'INVALID_PROCEDURE_PRODUCT', 'Installed Procedure permissions must be unique')
  const permissionCeiling = value.permissionCeiling ?? value.permissions
  assert(Array.isArray(permissionCeiling) && new Set(permissionCeiling).size === permissionCeiling.length && permissionCeiling.every((item) => value.permissions.includes(item)), 'INVALID_PROCEDURE_PRODUCT', 'Installed Procedure permission ceiling must be a subset of its declaration')
  assert(Array.isArray(value.resources), 'INVALID_PROCEDURE_PRODUCT', 'Installed Procedure resources are required')
  assert(value.execution?.kind === 'agentic-runner', 'INVALID_PROCEDURE_PRODUCT', 'Procedure Runtime only accepts agentic-runner products')
  const method = validateMethod(value.method)
  const inputSchema = schema(value.inputSchema, 'Procedure input schema')
  const outputSchema = schema(value.outputSchema, 'Procedure output schema')
  const inputIds = method.inputs.map((input) => input.id)
  const requiredInputs = method.inputs.filter((input) => input.required).map((input) => input.id)
  assert(sameSet(keys(inputSchema.properties), inputIds), 'INVALID_PROCEDURE_PRODUCT', 'Procedure input schema and method inputs differ')
  assert(sameSet(inputSchema.required, requiredInputs), 'INVALID_PROCEDURE_PRODUCT', 'Procedure required inputs and method inputs differ')
  for (const input of method.inputs) compatibleType(inputSchema.properties[input.id], input.type, `Procedure input ${input.id}`)
  assert(sameSet(value.permissions, method.permissions.map((permission) => permission.id)), 'INVALID_PROCEDURE_PRODUCT', 'Procedure permissions and method permissions differ')
  assert(
    JSON.stringify(value.resources) === JSON.stringify(method.resources.map(publicResource)),
    'INVALID_PROCEDURE_PRODUCT',
    'Procedure resources and method resources differ',
  )
  const artifacts = new Set(method.artifacts.map((artifact) => artifact.id))
  assert(Array.isArray(value.outputArtifacts) && value.outputArtifacts.length > 0 && value.outputArtifacts.every((id) => artifacts.has(id)), 'INVALID_PROCEDURE_PRODUCT', 'Procedure output artifacts are invalid')
  assert(new Set(value.outputArtifacts).size === value.outputArtifacts.length, 'INVALID_PROCEDURE_PRODUCT', 'Procedure output artifacts must be unique')
  assert(sameSet(keys(outputSchema.properties), value.outputArtifacts), 'INVALID_PROCEDURE_PRODUCT', 'Procedure output schema and declared artifacts differ')
  assert(sameSet(outputSchema.required, value.outputArtifacts), 'INVALID_PROCEDURE_PRODUCT', 'Procedure outputs must all be declared required')
  const artifactsById = new Map(method.artifacts.map((artifact) => [artifact.id, artifact]))
  for (const id of value.outputArtifacts) compatibleType(outputSchema.properties[id], artifactsById.get(id).type, `Procedure output ${id}`)
  return {
    ...structuredClone(value),
    permissionCeiling: [...permissionCeiling],
    method,
    inputSchema: structuredClone(inputSchema),
    outputSchema: structuredClone(outputSchema),
  }
}

export function procedureSummary(procedure) {
  return {
    id: procedure.id,
    version: procedure.version,
    componentId: procedure.componentId,
    name: procedure.name,
    description: procedure.description,
    permissions: [...procedure.permissions],
    permissionCeiling: [...(procedure.permissionCeiling ?? procedure.permissions)],
    resources: structuredClone(procedure.resources ?? []),
    lifecycle: structuredClone(procedure.lifecycle),
    execution: { kind: procedure.execution.kind },
  }
}

export function procedureDescription(procedure) {
  return {
    ...procedureSummary(procedure),
    inputSchema: structuredClone(procedure.inputSchema),
    outputSchema: structuredClone(procedure.outputSchema),
  }
}

export function declaredOutputs(procedure, task, store) {
  return validateProcedureOutputs(
    procedure,
    declaredTaskOutputs(procedure.outputArtifacts, task, store),
  )
}

export function declaredTaskOutputs(outputArtifacts, task, store) {
  assert(Array.isArray(outputArtifacts) && outputArtifacts.length > 0, 'PROCEDURE_OUTPUT_INVALID', 'Procedure output declaration is unavailable')
  return Object.fromEntries(outputArtifacts.map((id) => {
    const output = task.outputs?.[id]
    assert(output, 'PROCEDURE_OUTPUT_MISSING', `Declared Procedure output is missing: ${id}`)
    return [id, store.readArtifact(output.artifact)]
  }))
}

export function validateProcedureInput(procedure, input) {
  return validateValue(procedure.inputSchema, input, 'PROCEDURE_INPUT_INVALID', 'Procedure input')
}

export function validateProcedureOutputs(procedure, outputs) {
  return validateValue(procedure.outputSchema, outputs, 'PROCEDURE_OUTPUT_INVALID', 'Procedure outputs')
}
