import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, posix, relative, resolve, sep, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { validateMethod } from '../../procedure-runtime/src/method.mjs'
import { validateInstalledProcedure } from '../../procedure-runtime/src/product.mjs'
import { validateProcedureIntegration } from '../../../src/procedure-integration.mjs'
import { isSpdxExpressionSyntax } from '../../../src/spdx-expression.mjs'

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const methodSchema = JSON.parse(
  await readFile(resolve(repositoryRoot, 'schemas/agent-host-method-graph.schema.v2.json'), 'utf8'),
)
const integrationSchema = JSON.parse(
  await readFile(resolve(repositoryRoot, 'schemas/agent-host-procedure-integration.schema.v0.2.json'), 'utf8'),
)
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true })
addFormats(ajv)
const validateMethodSchema = ajv.compile(methodSchema)
const validateIntegrationSchema = ajv.compile(integrationSchema)

export const PROJECT_SCHEMA = 'openadam.procedure-studio-project.v0.1'
export const SCENARIO_SCHEMA = 'openadam.procedure-studio-scenario.v0.1'

function exactKeys(value, allowed, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw studioError('STUDIO_PROJECT_INVALID', `${label} must be an object`)
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) {
    throw studioError('STUDIO_PROJECT_INVALID', `${label} contains unsupported fields`, { fields: unknown })
  }
}

function containedRelativePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')) {
    throw studioError('STUDIO_PROJECT_INVALID', `${label} is invalid`)
  }
  const normalized = posix.normalize(value)
  if (posix.isAbsolute(normalized) || win32.isAbsolute(normalized) || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw studioError('STUDIO_PROJECT_INVALID', `${label} must remain inside the project`)
  }
  return normalized
}

export function studioError(code, message, details = undefined) {
  const error = new Error(message)
  error.code = code
  if (details !== undefined) error.details = details
  return error
}

export function errorValue(error) {
  return {
    code: error?.code ?? 'STUDIO_FAILED',
    message: error instanceof Error ? error.message : String(error),
    ...(error?.details === undefined ? {} : { details: error.details }),
  }
}

export function documentDigest(document) {
  return `sha256:${createHash('sha256').update(JSON.stringify(document)).digest('hex')}`
}

export function resolveContained(root, path, label) {
  const target = resolve(root, containedRelativePath(path, label))
  const relation = relative(root, target)
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw studioError('STUDIO_PROJECT_INVALID', `${label} escapes the project`)
  }
  return target
}

export function validateProjectConfig(value, root) {
  exactKeys(value, ['schemaVersion', 'componentId', 'author', 'licenseSpdx', 'integration', 'scenarios', 'output'], 'Studio project')
  if (value.schemaVersion !== PROJECT_SCHEMA) {
    throw studioError('STUDIO_PROJECT_INVALID', `Unsupported Studio project schema: ${value.schemaVersion ?? 'missing'}`)
  }
  if (typeof value.componentId !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(value.componentId)) {
    throw studioError('STUDIO_PROJECT_INVALID', 'Component id must use lowercase letters, digits, and hyphens')
  }
  if (typeof value.author !== 'string' || value.author.length < 1 || value.author.length > 120) {
    throw studioError('STUDIO_PROJECT_INVALID', 'Project author is invalid')
  }
  if (!isSpdxExpressionSyntax(value.licenseSpdx)) {
    throw studioError('STUDIO_PROJECT_INVALID', 'Project licenseSpdx must be a valid SPDX expression')
  }
  const integration = containedRelativePath(value.integration, 'Procedure integration path')
  if (!Array.isArray(value.scenarios) || value.scenarios.length === 0 || value.scenarios.length > 40 || new Set(value.scenarios).size !== value.scenarios.length) {
    throw studioError('STUDIO_PROJECT_INVALID', 'Project scenarios must be a non-empty unique list')
  }
  const scenarios = value.scenarios.map((path) => containedRelativePath(path, 'Scenario path'))
  const output = containedRelativePath(value.output, 'Package output path')
  return {
    ...structuredClone(value),
    integration,
    scenarios,
    output,
    paths: {
      integration: resolveContained(root, integration, 'Procedure integration path'),
      scenarios: scenarios.map((path) => resolveContained(root, path, 'Scenario path')),
      output: resolveContained(root, output, 'Package output path'),
    },
  }
}

export function validateScenario(value) {
  exactKeys(value, ['schemaVersion', 'id', 'name', 'description', 'inputs', 'grants', 'resources', 'limits', 'bindings'], 'Test scenario')
  if (value.schemaVersion !== SCENARIO_SCHEMA) {
    throw studioError('STUDIO_SCENARIO_INVALID', `Unsupported Test scenario schema: ${value.schemaVersion ?? 'missing'}`)
  }
  if (typeof value.id !== 'string' || !/^[a-z][a-z0-9_.-]{0,79}$/u.test(value.id)) {
    throw studioError('STUDIO_SCENARIO_INVALID', 'Scenario id is invalid')
  }
  if (typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 120) {
    throw studioError('STUDIO_SCENARIO_INVALID', 'Scenario name is invalid')
  }
  if (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 1000)) {
    throw studioError('STUDIO_SCENARIO_INVALID', 'Scenario description is invalid')
  }
  if (value.inputs === null || typeof value.inputs !== 'object' || Array.isArray(value.inputs)) {
    throw studioError('STUDIO_SCENARIO_INVALID', 'Scenario inputs must be an object')
  }
  if (!Array.isArray(value.grants) || new Set(value.grants).size !== value.grants.length || value.grants.some((item) => typeof item !== 'string')) {
    throw studioError('STUDIO_SCENARIO_INVALID', 'Scenario grants are invalid')
  }
  for (const key of ['resources', 'limits', 'bindings']) {
    if (value[key] === null || typeof value[key] !== 'object' || Array.isArray(value[key])) {
      throw studioError('STUDIO_SCENARIO_INVALID', `Scenario ${key} must be an object`)
    }
  }
  return structuredClone(value)
}

function pointerParts(path) {
  return String(path || '/')
    .split('/')
    .filter(Boolean)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
}

function diagnosticTarget(document, path) {
  const parts = pointerParts(path)
  const graphIndex = parts.findIndex((part, index) => part === 'nodes' && parts[index - 1] === 'graph')
  if (graphIndex >= 0) {
    const index = Number(parts[graphIndex + 1])
    return { kind: 'node', id: document.method?.graph?.nodes?.[index]?.id ?? null }
  }
  return { kind: parts[0] === 'procedure' ? 'contract' : 'source', id: null }
}

function ajvDiagnostics(validate, value, document, source) {
  if (validate(value)) return []
  const nodeBranch = new Map([
    ['agent-turn', 0],
    ['direct-call', 1],
    ['procedure-call', 2],
    ['human-input', 3],
    ['condition', 4],
    ['transform', 5],
    ['extension', 6],
  ])
  const errors = (validate.errors ?? []).filter((error) => {
    if (source !== 'method') return true
    const nodeMatch = error.instancePath.match(/^\/graph\/nodes\/(\d+)(?:\/|$)/u)
    if (!nodeMatch) return true
    const branch = nodeBranch.get(document.method?.graph?.nodes?.[Number(nodeMatch[1])]?.kind)
    if (branch === undefined) return true
    if (error.keyword === 'oneOf' && error.instancePath === `/graph/nodes/${nodeMatch[1]}`) return false
    const schemaBranch = error.schemaPath.match(/^#\/oneOf\/(\d+)\//u)
    return !schemaBranch || Number(schemaBranch[1]) === branch
  })
  return errors.slice(0, 100).map((error, index) => {
    const path = error.instancePath || '/'
    const message = error.keyword === 'unevaluatedProperties'
      ? `${path}: unsupported field “${error.params.unevaluatedProperty}”`
      : `${path}: ${error.message}`
    return {
      id: `${source}-schema-${index}-${path}`,
      severity: 'error',
      source,
      code: `SCHEMA_${String(error.keyword).toUpperCase()}`,
      message,
      path,
      target: diagnosticTarget(document, source === 'method' ? path : `/procedure${path}`),
    }
  })
}

function semanticTarget(document, message) {
  const ids = document.method?.graph?.nodes?.map((node) => node.id) ?? []
  const id = ids.find((candidate) => message.includes(candidate))
  return id ? { kind: 'node', id } : { kind: 'source', id: null }
}

export function validateStudioDocument(value) {
  const document = structuredClone(value)
  const diagnostics = []
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    return {
      valid: false,
      diagnostics: [{ id: 'document-shape', severity: 'error', source: 'document', code: 'INVALID_DOCUMENT', message: 'Studio document must be an object', path: '/', target: { kind: 'source', id: null } }],
      normalized: null,
      product: null,
    }
  }
  const documentKeys = ['integration', 'method', 'inputSchema', 'outputSchema']
  const unknown = Object.keys(document).filter((key) => !documentKeys.includes(key))
  if (unknown.length > 0) {
    diagnostics.push({ id: 'document-fields', severity: 'error', source: 'document', code: 'UNKNOWN_FIELD', message: `Studio document contains unsupported fields: ${unknown.join(', ')}`, path: '/', target: { kind: 'source', id: null } })
  }
  diagnostics.push(...ajvDiagnostics(validateMethodSchema, document.method, document, 'method'))
  diagnostics.push(...ajvDiagnostics(validateIntegrationSchema, document.integration, document, 'integration'))
  if (diagnostics.length > 0) return { valid: false, diagnostics, normalized: document, product: null }
  let method
  try {
    method = validateMethod(document.method)
  } catch (error) {
    diagnostics.push({ id: 'method-semantic', severity: 'error', source: 'method', code: error.code ?? 'INVALID_METHOD', message: error.message, path: '/', target: semanticTarget(document, error.message) })
  }
  let integration
  try {
    integration = validateProcedureIntegration(document.integration, new Set([
      document.integration?.procedure?.inputSchema,
      document.integration?.procedure?.outputSchema,
      document.integration?.execution?.method,
      ...(document.integration?.execution?.identityFiles ?? []),
    ]))
  } catch (error) {
    diagnostics.push({ id: 'integration-semantic', severity: 'error', source: 'integration', code: error.code ?? 'PROCEDURE_INTEGRATION_INVALID', message: error.message, path: '/', target: { kind: 'contract', id: null } })
  }
  let product = null
  if (method && integration) {
    try {
      if (integration.execution.kind !== 'agentic-runner') {
        throw studioError('STUDIO_EXECUTION_UNSUPPORTED', 'Graph authoring requires an agentic-runner Procedure binding')
      }
      product = validateInstalledProcedure({
        componentId: integration.procedure.id,
        id: integration.procedure.id,
        version: integration.procedure.version,
        name: integration.displayName,
        description: integration.summary,
        fingerprint: documentDigest(document),
        permissions: integration.procedure.permissions,
        resources: integration.procedure.resources,
        lifecycle: integration.procedure.lifecycle,
        execution: { kind: 'agentic-runner' },
        outputArtifacts: integration.execution.outputArtifacts,
        method,
        inputSchema: document.inputSchema,
        outputSchema: document.outputSchema,
      })
    } catch (error) {
      diagnostics.push({ id: 'product-semantic', severity: 'error', source: 'product', code: error.code ?? 'INVALID_PROCEDURE_PRODUCT', message: error.message, path: '/', target: { kind: 'contract', id: null } })
    }
  }
  return {
    valid: diagnostics.length === 0,
    diagnostics,
    normalized: { ...document, ...(method ? { method } : {}), ...(integration ? { integration } : {}) },
    product,
  }
}

export function relativeProjectPath(root, target) {
  const value = relative(root, target).split(sep).join('/')
  return containedRelativePath(value, 'Project path')
}

export function containingDirectory(path) {
  return dirname(path)
}
