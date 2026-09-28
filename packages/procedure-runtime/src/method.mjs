import { assert, object, text, integer, hash } from './value.mjs'

export const methodSchema = 'openadam.method-graph.v2'
export const legacyMethodSchema = 'openadam.method.v1'
const identifier = /^[a-z][a-z0-9_.-]{0,79}$/
const productIdentifier = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u
const semanticVersion = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
const conditionPath = /^(outcome|facts|inputs|outputs|resources)(\.[a-zA-Z0-9_-]+)*$/
const nodeKinds = new Set([
  'agent-turn',
  'direct-call',
  'procedure-call',
  'human-input',
  'condition',
  'transform',
  'extension',
])

function exactKeys(value, allowed, label) {
  assert(object(value), 'INVALID_METHOD', `${label} must be an object`)
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key))
  assert(
    unexpected.length === 0,
    'INVALID_METHOD',
    `${label} contains unsupported fields: ${unexpected.join(', ')}`,
  )
}

function namedDefinition(value, kind) {
  assert(object(value), 'INVALID_METHOD', `${kind} must be an object`)
  text(value.id, `${kind} ID`, 80)
  assert(identifier.test(value.id), 'INVALID_METHOD', `Invalid ${kind} ID`)
  text(value.name, `${kind} name`, 120)
}

function uniqueDefinitions(values, kind, maximum) {
  assert(
    Array.isArray(values) && values.length <= maximum,
    'INVALID_METHOD',
    `${kind} count exceeds ${maximum}`,
  )
  const ids = new Set()
  for (const value of values) {
    namedDefinition(value, kind)
    assert(!ids.has(value.id), 'INVALID_METHOD', `${kind} IDs must be unique`)
    ids.add(value.id)
  }
  return ids
}

function legacyGraph(value) {
  const method = structuredClone(value)
  method.schema ??= legacyMethodSchema
  method.profile ??= method.id === 'development' ? 'development' : null
  method.description ??= ''
  method.roles ??= [
    ...new Map(
      (method.stages ?? []).map((stage) => [
        stage.role,
        { id: stage.role, name: stage.role },
      ]),
    ).values(),
  ]
  method.inputs ??= [{ id: 'goal', name: '目标', type: 'text', required: true }]
  method.artifacts ??= []
  method.permissions ??= [
    { id: 'model.invoke', name: '调用所选 Agent' },
    { id: 'workspace.write', name: '修改工作区' },
    { id: 'git.stage', name: '暂存 Git 候选' },
  ]
  method.workspace ??= { adapter: 'git', required: true }
  const nodes = (method.stages ?? []).map((stage, index) => ({
    id: stage.id,
    kind: 'agent-turn',
    name: stage.name ?? stage.id,
    role: stage.role,
    instruction: stage.instruction,
    access: stage.access ?? 'none',
    consumes: stage.consumes ?? [],
    produces: stage.produces ?? [],
    resources:
      stage.resources ??
      ((stage.access ?? 'none') === 'none' ? [] : ['workspace']),
    permissions:
      stage.permissions ??
      [
        'model.invoke',
        ...(stage.access === 'write' ? ['workspace.write'] : []),
      ],
    transitions:
      stage.transitions ??
      [
        ...(stage.onChanges
          ? [
              {
                when: {
                  path: 'outcome',
                  operator: 'equals',
                  value: 'changes_requested',
                },
                to: stage.onChanges,
                label: '需要修改',
              },
            ]
          : []),
        {
          when: { path: 'outcome', operator: 'equals', value: 'complete' },
          to: Object.hasOwn(stage, 'next')
            ? stage.next
            : index === method.stages.length - 1
              ? null
              : method.stages[index + 1].id,
          label: stage.next === null ? '完成' : '继续',
        },
      ],
  }))
  return {
    schema: methodSchema,
    id: method.id,
    revision: method.revision,
    name: method.name,
    description: method.description,
    profile: method.profile,
    roles: method.roles,
    inputs: method.inputs,
    artifacts: method.artifacts,
    permissions: method.permissions,
    resources:
      method.workspace.adapter === 'none'
        ? []
        : [
            {
              id: 'workspace',
              name: 'Git workspace',
              type: 'workspace',
              required: method.workspace.required !== false,
              adapter: method.workspace.adapter,
            },
          ],
    graph: {
      entry: nodes[0]?.id ?? null,
      nodes,
      extensions: {
        parallel: { version: 1, supported: false },
        wait: { version: 1, supported: false },
      },
    },
  }
}

function normalizeMethod(value) {
  if (value?.schema === legacyMethodSchema || value?.schema === undefined)
    return legacyGraph(value)
  return structuredClone(value)
}

export function validateCondition(value) {
  assert(object(value), 'INVALID_METHOD', 'Transition condition is required')
  exactKeys(value, ['path', 'operator', 'value'], 'Transition condition')
  if (value.operator === 'always') {
    assert(
      Object.keys(value).length === 1,
      'INVALID_METHOD',
      'An always condition cannot carry a path or value',
    )
    return { operator: 'always' }
  }
  text(value.path, 'Condition path', 120)
  assert(
    conditionPath.test(value.path) &&
      !value.path.split('.').some((part) =>
        ['__proto__', 'prototype', 'constructor'].includes(part),
      ),
    'INVALID_METHOD',
    'Condition path must address outcome, facts or outputs',
  )
  assert(
      ['equals', 'not_equals', 'in', 'exists'].includes(value.operator),
    'INVALID_METHOD',
    'Unsupported transition operator',
  )
  if (value.operator === 'in')
    assert(
      Array.isArray(value.value) && value.value.length <= 100,
      'INVALID_METHOD',
      'An in condition needs a bounded value list',
    )
  assert(
    JSON.stringify(value).length <= 8000,
    'INVALID_METHOD',
    'Transition condition is too large',
  )
  return structuredClone(value)
}

function pathValue(source, path) {
  let value = source
  for (const part of path.split('.')) value = value?.[part]
  return value
}

export function conditionMatches(condition, result) {
  if (condition.operator === 'always') return true
  const actual = pathValue(result, condition.path)
  if (condition.operator === 'exists')
    return condition.value === false ? actual === undefined : actual !== undefined
  if (condition.operator === 'equals')
    return JSON.stringify(actual) === JSON.stringify(condition.value)
  if (condition.operator === 'not_equals')
    return JSON.stringify(actual) !== JSON.stringify(condition.value)
  return condition.value.some(
    (item) => JSON.stringify(item) === JSON.stringify(actual),
  )
}

export function resolveTransition(stage, result) {
  const transition = stage.transitions.find((route) =>
    conditionMatches(route.when, result),
  )
  assert(
    transition,
    'METHOD_ROUTE_MISSING',
    `No route from ${stage.id} matches this result`,
  )
  return transition.to
}

function validateExpression(value, depth = 0) {
  assert(depth <= 12, 'INVALID_METHOD', 'Value expression nesting exceeds 12 levels')
  assert(object(value), 'INVALID_METHOD', 'Value expression must be an object')
  const variants = ['path', 'literal', 'object', 'array'].filter((key) =>
    Object.hasOwn(value, key),
  )
  assert(variants.length === 1, 'INVALID_METHOD', 'Value expression needs exactly one variant')
  exactKeys(value, variants, 'Value expression')
  if (Object.hasOwn(value, 'path')) {
    text(value.path, 'Value expression path', 200)
    assert(
      /^(inputs|outputs|resources|result)(\.[a-zA-Z0-9_-]+)*$/.test(value.path) &&
        !value.path.split('.').some((part) =>
          ['__proto__', 'prototype', 'constructor'].includes(part),
        ),
      'INVALID_METHOD',
      'Value expression path is invalid',
    )
  } else if (Object.hasOwn(value, 'object')) {
    assert(object(value.object), 'INVALID_METHOD', 'Object expression is invalid')
    assert(Object.keys(value.object).length <= 100, 'INVALID_METHOD', 'Object expression is too large')
    for (const item of Object.values(value.object)) validateExpression(item, depth + 1)
  } else if (Object.hasOwn(value, 'array')) {
    assert(Array.isArray(value.array) && value.array.length <= 100, 'INVALID_METHOD', 'Array expression is invalid')
    for (const item of value.array) validateExpression(item, depth + 1)
  } else {
    assert(
      value.literal === null ||
        ['string', 'number', 'boolean'].includes(typeof value.literal) ||
        Array.isArray(value.literal) ||
        object(value.literal),
      'INVALID_METHOD',
      'Literal expression is invalid',
    )
  }
  assert(JSON.stringify(value).length <= 64000, 'INVALID_METHOD', 'Value expression is too large')
  return structuredClone(value)
}

function expressionPaths(value) {
  if (Object.hasOwn(value, 'path')) return [value.path]
  if (Object.hasOwn(value, 'object'))
    return Object.values(value.object).flatMap(expressionPaths)
  if (Object.hasOwn(value, 'array')) return value.array.flatMap(expressionPaths)
  return []
}

function expressionValue(value, context) {
  if (Object.hasOwn(value, 'path')) return structuredClone(pathValue(context, value.path))
  if (Object.hasOwn(value, 'literal')) return structuredClone(value.literal)
  if (Object.hasOwn(value, 'array'))
    return value.array.map((item) => expressionValue(item, context))
  return Object.fromEntries(
    Object.entries(value.object).map(([key, item]) => [key, expressionValue(item, context)]),
  )
}

export function evaluateExpression(value, context) {
  validateExpression(value)
  return expressionValue(value, context)
}

function validateResource(resource) {
  assert(['workspace', 'file', 'account'].includes(resource.type), 'INVALID_METHOD', 'Unsupported resource type')
  assert(typeof resource.required === 'boolean', 'INVALID_METHOD', 'Resource required flag is invalid')
  if (resource.type === 'workspace') {
    exactKeys(resource, ['id', 'name', 'type', 'required', 'adapter'], `Workspace resource ${resource.id}`)
    assert(resource.adapter === 'git', 'INVALID_METHOD', 'Workspace resource adapter must be git')
  } else if (resource.type === 'file') {
    exactKeys(resource, ['id', 'name', 'type', 'required', 'access'], `File resource ${resource.id}`)
    assert(['read', 'write'].includes(resource.access), 'INVALID_METHOD', 'File resource access is invalid')
  } else {
    exactKeys(resource, ['id', 'name', 'type', 'required', 'provider'], `Account resource ${resource.id}`)
    if (resource.provider !== undefined)
      text(resource.provider, 'Account resource provider', 160)
  }
}

function validateNode(node, { roles, inputs, artifacts, permissions, resources, workspaceResources, nodes, transitionIds }) {
  assert(nodeKinds.has(node.kind), 'INVALID_METHOD', `Unsupported graph node kind: ${node.kind}`)
  const baseKeys = ['id', 'name', 'kind', 'consumes', 'produces', 'permissions', 'resources', 'transitions']
  const variantKeys = {
    'agent-turn': ['role', 'instruction', 'access'],
    'direct-call': ['target', 'input', 'output'],
    'procedure-call': ['procedure', 'input', 'output', 'grants', 'resourceBindings'],
    'human-input': ['prompt', 'interaction', 'responseArtifact', 'options'],
    condition: [],
    transform: ['output'],
    extension: ['extension'],
  }
  exactKeys(node, [...baseKeys, ...variantKeys[node.kind]], `Graph node ${node.id ?? '<unknown>'}`)
  for (const [field, known, maximum] of [
    ['consumes', new Set([...inputs, ...artifacts]), 80],
    ['produces', artifacts, 80],
    ['permissions', permissions, 40],
    ['resources', resources, 40],
  ])
    assert(
      Array.isArray(node[field]) &&
        node[field].length <= maximum &&
        new Set(node[field]).size === node[field].length &&
        node[field].every((id) => known.has(id)),
      'INVALID_METHOD',
      `Node ${field} reference is invalid`,
    )
  const assertExpressionScope = (expression) => {
    for (const path of expressionPaths(expression)) {
      const [root, id] = path.split('.')
      if (root === 'inputs' || root === 'outputs')
        assert(node.consumes.includes(id), 'INVALID_METHOD', `Expression ${path} is not declared in node consumes`)
      if (root === 'resources')
        assert(node.resources.includes(id), 'INVALID_METHOD', `Expression ${path} is not declared in node resources`)
    }
  }
  if (node.kind === 'agent-turn') {
    assert(roles.has(node.role), 'INVALID_METHOD', 'Agent-turn role does not exist')
    assert(['none', 'read', 'write'].includes(node.access), 'INVALID_METHOD', 'Invalid workspace access')
    if (node.access !== 'none')
      assert(
        node.resources.some((id) => workspaceResources.has(id)),
        'INVALID_METHOD',
        'A workspace Agent turn must reference the workspace resource',
      )
    text(node.instruction, 'Agent-turn instruction', 8000)
  } else if (node.kind === 'direct-call') {
    assert(object(node.target), 'INVALID_METHOD', 'Direct-call target is required')
    exactKeys(node.target, ['kind', 'providerId', 'capabilityId', 'capabilityVersion', 'operationId'], `Direct-call target ${node.id}`)
    assert(node.target.kind === 'capability', 'INVALID_METHOD', 'Direct-call target must be a Capability')
    for (const field of ['providerId', 'capabilityId', 'capabilityVersion', 'operationId'])
      text(node.target[field], `Direct-call ${field}`, 200)
    assert(node.permissions.includes('capability.invoke'), 'INVALID_METHOD', 'Direct-call nodes require the capability.invoke permission')
    validateExpression(node.input)
    assertExpressionScope(node.input)
    assert(object(node.output), 'INVALID_METHOD', 'Direct-call output mapping is required')
    assert(new Set(Object.keys(node.output)).size === node.produces.length && node.produces.every((id) => Object.hasOwn(node.output, id)), 'INVALID_METHOD', 'Direct-call output mapping must match produced artifacts')
    for (const expression of Object.values(node.output)) {
      validateExpression(expression)
      assertExpressionScope(expression)
    }
  } else if (node.kind === 'procedure-call') {
    assert(object(node.procedure), 'INVALID_METHOD', 'Procedure-call identity is required')
    exactKeys(node.procedure, ['id', 'version'], `Subprocedure identity ${node.id}`)
    text(node.procedure.id, 'Subprocedure ID', 160)
    text(node.procedure.version, 'Subprocedure version', 100)
    assert(productIdentifier.test(node.procedure.id) && semanticVersion.test(node.procedure.version), 'INVALID_METHOD', 'Subprocedure identity must be an exact Procedure id and semantic version')
    assert(node.permissions.includes('procedure.invoke'), 'INVALID_METHOD', 'Procedure-call nodes require the procedure.invoke permission')
    assert(Array.isArray(node.grants) && new Set(node.grants).size === node.grants.length && node.grants.every((grant) => node.permissions.includes(grant) && grant !== 'procedure.invoke'), 'INVALID_METHOD', 'Subprocedure grants must be an explicit subset of the node permissions')
    assert(object(node.resourceBindings), 'INVALID_METHOD', 'Subprocedure resource bindings are required')
    assert(Object.keys(node.resourceBindings).length <= 40, 'INVALID_METHOD', 'Subprocedure resource bindings are too large')
    for (const [childResource, parentResource] of Object.entries(node.resourceBindings)) {
      assert(productIdentifier.test(childResource), 'INVALID_METHOD', 'Subprocedure resource id is invalid')
      assert(node.resources.includes(parentResource), 'INVALID_METHOD', 'Subprocedure resource binding must reference a declared parent resource')
    }
    validateExpression(node.input)
    assertExpressionScope(node.input)
    assert(object(node.output), 'INVALID_METHOD', 'Procedure-call output mapping is required')
    assert(new Set(Object.keys(node.output)).size === node.produces.length && node.produces.every((id) => Object.hasOwn(node.output, id)), 'INVALID_METHOD', 'Procedure-call output mapping must match produced artifacts')
    for (const expression of Object.values(node.output)) {
      validateExpression(expression)
      assertExpressionScope(expression)
    }
  } else if (node.kind === 'human-input') {
    text(node.prompt, 'Human-input prompt', 4000)
    assert(node.produces.length === 1 && node.responseArtifact === node.produces[0], 'INVALID_METHOD', 'Human-input node must produce its response artifact')
    assert(['input', 'checkpoint'].includes(node.interaction), 'INVALID_METHOD', 'Human-input interaction is invalid')
    if (node.options !== undefined)
      assert(Array.isArray(node.options) && node.options.length >= 1 && node.options.length <= 20 && node.options.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 200), 'INVALID_METHOD', 'Human-input options are invalid')
  } else if (node.kind === 'condition') {
    assert(node.produces.length === 0, 'INVALID_METHOD', 'Condition nodes cannot produce artifacts')
  } else if (node.kind === 'transform') {
    assert(object(node.output), 'INVALID_METHOD', 'Transform output mapping is required')
    assert(new Set(Object.keys(node.output)).size === node.produces.length && node.produces.every((id) => Object.hasOwn(node.output, id)), 'INVALID_METHOD', 'Transform output mapping must match produced artifacts')
    for (const expression of Object.values(node.output)) {
      validateExpression(expression)
      assertExpressionScope(expression)
    }
  } else {
    assert(object(node.extension), 'INVALID_METHOD', 'Extension node descriptor is required')
    exactKeys(node.extension, ['id', 'version', 'configuration'], `Extension node ${node.id}`)
    assert(['parallel', 'wait'].includes(node.extension.id), 'INVALID_METHOD', 'Unknown Method extension point')
    integer(node.extension.version, 'Extension version', 1, 1000)
    assert(object(node.extension.configuration), 'INVALID_METHOD', 'Extension configuration must be an object')
    assert(JSON.stringify(node.extension.configuration).length <= 64000, 'INVALID_METHOD', 'Extension configuration is too large')
  }
  assert(Array.isArray(node.transitions) && node.transitions.length >= 1 && node.transitions.length <= 12, 'INVALID_METHOD', 'Each graph node needs 1–12 transitions')
  for (const transition of node.transitions) {
    assert(object(transition), 'INVALID_METHOD', 'Invalid transition')
    exactKeys(transition, ['id', 'when', 'to', 'label'], `Transition from ${node.id}`)
    if (transition.id !== undefined) {
      text(transition.id, 'Transition ID', 80)
      assert(identifier.test(transition.id), 'INVALID_METHOD', 'Invalid transition ID')
      assert(!transitionIds.has(transition.id), 'INVALID_METHOD', 'Transition IDs must be unique')
      transitionIds.add(transition.id)
    }
    validateCondition(transition.when)
    if (transition.when.path?.startsWith('inputs.') || transition.when.path?.startsWith('outputs.'))
      assert(node.consumes.includes(transition.when.path.split('.')[1]), 'INVALID_METHOD', `Transition ${transition.when.path} is not declared in node consumes`)
    if (transition.when.path?.startsWith('resources.'))
      assert(node.resources.includes(transition.when.path.split('.')[1]), 'INVALID_METHOD', `Transition ${transition.when.path} is not declared in node resources`)
    assert(transition.to === null || nodes.has(transition.to), 'INVALID_METHOD', 'Graph node target does not exist')
    if (transition.label) text(transition.label, 'Transition label', 120)
  }
  const fallbackIndexes = node.transitions
    .map((transition, index) => transition.when.operator === 'always' ? index : -1)
    .filter((index) => index >= 0)
  assert(fallbackIndexes.length <= 1 && (fallbackIndexes.length === 0 || fallbackIndexes[0] === node.transitions.length - 1), 'INVALID_METHOD', 'A node fallback route must be unique and last')
  assert(
    node.transitions.some((transition) => transition.when.operator === 'always') ||
      node.transitions.some((transition) => transition.when.path === 'outcome' && transition.when.operator === 'equals' && transition.when.value === 'complete'),
    'INVALID_METHOD',
    'Each graph node needs an explicit complete or fallback route',
  )
}

export function validateMethod(value) {
  assert(object(value), 'INVALID_METHOD', 'Method must be an object')
  const method = normalizeMethod(value)
  exactKeys(method, ['schema', 'profile', 'id', 'revision', 'name', 'description', 'roles', 'inputs', 'artifacts', 'permissions', 'resources', 'graph'], 'Method')
  assert(method.schema === methodSchema, 'INVALID_METHOD', 'Unknown method schema')
  text(method.id, 'Method ID', 80)
  assert(identifier.test(method.id), 'INVALID_METHOD', 'Invalid method ID')
  integer(method.revision, 'Method revision', 1, 1000000)
  text(method.name, 'Method name', 120)
  assert(
    typeof method.description === 'string' && method.description.length <= 1000,
    'INVALID_METHOD',
    'Method description exceeds 1,000 characters',
  )
  assert(
    method.profile === null ||
      (typeof method.profile === 'string' && identifier.test(method.profile)),
    'INVALID_METHOD',
    'Invalid method profile',
  )
  const roles = uniqueDefinitions(method.roles, 'Role', 40)
  for (const role of method.roles) {
    exactKeys(role, ['id', 'name', 'description', 'independentFrom', 'includeReports', 'defaultBinding'], `Role ${role.id}`)
    assert(
      Array.isArray(role.independentFrom ?? []) &&
        (role.independentFrom ?? []).every((id) => roles.has(id)),
      'INVALID_METHOD',
      'Role independence references an unknown role',
    )
    if (role.description) text(role.description, 'Role description', 1000)
    if (role.includeReports !== undefined)
      assert(typeof role.includeReports === 'boolean', 'INVALID_METHOD', 'Role includeReports must be boolean')
    if (role.defaultBinding !== undefined) {
      exactKeys(role.defaultBinding, ['provider', 'model'], `Role ${role.id} default binding`)
      assert(
        object(role.defaultBinding) &&
          ['codex', 'grok', 'zcode'].includes(role.defaultBinding.provider),
        'INVALID_METHOD',
        'Role default binding must name a supported Agent shell',
      )
      if (role.defaultBinding.model !== undefined) {
        if (role.defaultBinding.provider === 'zcode') {
          assert(object(role.defaultBinding.model), 'INVALID_METHOD', 'ZCode default model binding must use native provider and model ids')
          assert(typeof role.defaultBinding.model.providerId === 'string' && role.defaultBinding.model.providerId.length >= 1 && role.defaultBinding.model.providerId.length <= 200, 'INVALID_METHOD', 'ZCode default provider ID is invalid')
          assert(typeof role.defaultBinding.model.modelId === 'string' && role.defaultBinding.model.modelId.length >= 1 && role.defaultBinding.model.modelId.length <= 200, 'INVALID_METHOD', 'ZCode default model ID is invalid')
          if (role.defaultBinding.model.options !== undefined) {
            assert(object(role.defaultBinding.model.options), 'INVALID_METHOD', 'ZCode default model options are invalid')
            if (role.defaultBinding.model.options.reasoningLevel !== undefined)
              assert(typeof role.defaultBinding.model.options.reasoningLevel === 'string' && role.defaultBinding.model.options.reasoningLevel.length >= 1 && role.defaultBinding.model.options.reasoningLevel.length <= 80, 'INVALID_METHOD', 'ZCode default reasoning level is invalid')
          }
        } else {
          assert(typeof role.defaultBinding.model === 'string' && role.defaultBinding.model.length >= 1 && role.defaultBinding.model.length <= 200, 'INVALID_METHOD', 'Role default model binding is invalid')
        }
      }
    }
  }
  const inputs = uniqueDefinitions(method.inputs, 'Input', 40)
  for (const input of method.inputs) {
    exactKeys(input, ['id', 'name', 'type', 'required'], `Input ${input.id}`)
    assert(
      ['text', 'string', 'boolean', 'json', 'reference'].includes(input.type),
      'INVALID_METHOD',
      'Unsupported input type',
    )
    assert(typeof input.required === 'boolean', 'INVALID_METHOD', 'Input required flag is invalid')
  }
  const artifacts = uniqueDefinitions(method.artifacts, 'Artifact', 80)
  for (const artifact of method.artifacts) {
    exactKeys(artifact, ['id', 'name', 'type', 'required'], `Artifact ${artifact.id}`)
    assert(
      ['text', 'json', 'reference', 'file-set', 'git-candidate'].includes(
        artifact.type,
      ),
      'INVALID_METHOD',
      'Unsupported artifact type',
    )
    assert(typeof artifact.required === 'boolean', 'INVALID_METHOD', 'Artifact required flag is invalid')
  }
  const permissions = uniqueDefinitions(method.permissions, 'Permission', 40)
  for (const permission of method.permissions)
    exactKeys(permission, ['id', 'name'], `Permission ${permission.id}`)
  const resources = uniqueDefinitions(method.resources, 'Resource', 40)
  for (const resource of method.resources) validateResource(resource)
  assert(method.resources.filter((resource) => resource.type === 'workspace').length <= 1, 'INVALID_METHOD', 'A Method can bind at most one workspace resource in this Runner version')
  const workspaceResources = new Set(
    method.resources
      .filter((resource) => resource.type === 'workspace')
      .map((resource) => resource.id),
  )
  assert(object(method.graph), 'INVALID_METHOD', 'Method graph is required')
  exactKeys(method.graph, ['entry', 'extensions', 'nodes'], 'Method graph')
  assert(object(method.graph.extensions), 'INVALID_METHOD', 'Method graph extension declarations are required')
  exactKeys(method.graph.extensions, ['parallel', 'wait'], 'Method graph extension declarations')
  for (const id of ['parallel', 'wait']) {
    const extension = method.graph.extensions[id]
    exactKeys(extension, ['version', 'supported'], `Method ${id} extension declaration`)
    assert(object(extension) && extension.version === 1 && extension.supported === false, 'INVALID_METHOD', `Method ${id} extension declaration is invalid`)
  }
  assert(
    Array.isArray(method.graph.nodes) &&
      method.graph.nodes.length >= 1 &&
      method.graph.nodes.length <= 80,
    'INVALID_METHOD',
    'Methods require 1–80 graph nodes',
  )
  const nodes = uniqueDefinitions(method.graph.nodes, 'Graph node', 80)
  const transitionIds = new Set()
  assert(nodes.has(method.graph.entry), 'INVALID_METHOD', 'Method graph entry is invalid')
  for (const node of method.graph.nodes)
    validateNode(node, { roles, inputs, artifacts, permissions, resources, workspaceResources, nodes, transitionIds })
  assert(
    method.graph.nodes.some((node) => node.kind === 'agent-turn') || roles.size === 0,
    'INVALID_METHOD',
    'Roles without Agent turns are not allowed',
  )
  const reachable = new Set()
  const visit = (id) => {
    if (id === null || reachable.has(id)) return
    reachable.add(id)
    const node = method.graph.nodes.find((item) => item.id === id)
    for (const transition of node.transitions) visit(transition.to)
  }
  visit(method.graph.entry)
  assert(
    reachable.size === method.graph.nodes.length,
    'INVALID_METHOD',
    'Every graph node must be reachable from the entry node',
  )
  const terminal = new Set(
    method.graph.nodes
      .filter((node) => node.transitions.some((route) => route.to === null))
      .map((node) => node.id),
  )
  assert(terminal.size > 0, 'INVALID_METHOD', 'Method has no completion route')
  const produced = new Set(method.graph.nodes.flatMap((node) => node.produces))
  assert(
    method.artifacts.every(
      (artifact) => !artifact.required || produced.has(artifact.id),
    ),
    'INVALID_METHOD',
    'Every required artifact needs a producing stage',
  )
  for (const artifact of method.artifacts) {
    const withoutProducer = new Set()
    const visitWithoutProducer = (id) => {
      if (id === null || withoutProducer.has(id)) return
      withoutProducer.add(id)
      const node = method.graph.nodes.find((item) => item.id === id)
      assert(!node.consumes.includes(artifact.id), 'INVALID_METHOD', `Artifact ${artifact.id} can be consumed before it is produced`)
      if (node.produces.includes(artifact.id)) return
      if (artifact.required)
        assert(!node.transitions.some((route) => route.to === null), 'INVALID_METHOD', `Required artifact ${artifact.id} is missing on a completion route`)
      for (const transition of node.transitions) visitWithoutProducer(transition.to)
    }
    visitWithoutProducer(method.graph.entry)
  }
  const canFinish = new Set(terminal)
  let changed = true
  while (changed) {
    changed = false
    for (const node of method.graph.nodes)
      if (
        !canFinish.has(node.id) &&
        node.transitions.some(
          (route) => route.to === null || canFinish.has(route.to),
        )
      ) {
        canFinish.add(node.id)
        changed = true
      }
  }
  assert(
    method.graph.nodes.every((node) => canFinish.has(node.id)),
    'INVALID_METHOD',
    'Every graph node needs a route that can reach completion',
  )
  return method
}

export function validateInputs(method, values = {}) {
  assert(object(values), 'INVALID_INPUT', 'Method inputs must be an object')
  const known = new Map(method.inputs.map((input) => [input.id, input]))
  for (const key of Object.keys(values))
    assert(known.has(key), 'INVALID_INPUT', `Unknown method input: ${key}`)
  for (const input of method.inputs) {
    const value = values[input.id]
    assert(
      !input.required || (value !== undefined && value !== null && value !== ''),
      'INVALID_INPUT',
      `${input.name} is required`,
    )
    if (value === undefined) continue
    if (['text', 'string', 'reference'].includes(input.type))
      text(value, input.name, 32000)
    if (input.type === 'boolean')
      assert(typeof value === 'boolean', 'INVALID_INPUT', `${input.name} must be boolean`)
    assert(
      JSON.stringify(value).length <= 64000,
      'INVALID_INPUT',
      `${input.name} exceeds its size limit`,
    )
  }
  return structuredClone(values)
}

export function validateArtifactValue(spec, value) {
  if (spec.type === 'text')
    assert(
      typeof value === 'string' &&
        value.trim().length > 0 &&
        value.length <= 128000 &&
        !value.includes('\0'),
      'INVALID_REPORT',
      `${spec.name} must be non-empty text`,
    )
  else if (spec.type === 'reference')
    assert(
      typeof value === 'string' &&
        value.trim().length > 0 &&
        value.length <= 32000 &&
        !value.includes('\0'),
      'INVALID_REPORT',
      `${spec.name} must be a reference string`,
    )
  else if (spec.type === 'json')
    assert(
      object(value) || Array.isArray(value),
      'INVALID_REPORT',
      `${spec.name} must be a JSON object or array`,
    )
  else if (spec.type === 'file-set')
    assert(
      Array.isArray(value) &&
        value.length <= 10000 &&
        value.every((path) => typeof path === 'string' && path.length <= 4096),
      'INVALID_REPORT',
      `${spec.name} must be a bounded file path list`,
    )
  else
    assert(
      spec.type === 'git-candidate' && object(value),
      'INVALID_REPORT',
      `${spec.name} must be a Git candidate object`,
    )
  assert(
    JSON.stringify(value).length <= 192000,
    'INVALID_REPORT',
    `${spec.name} exceeds its size limit`,
  )
}

export function report(textValue, { method, stage } = {}) {
  let parsed
  try {
    parsed = JSON.parse(textValue)
  } catch {
    const match = textValue.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (match)
      try {
        parsed = JSON.parse(match[1])
      } catch {}
  }
  assert(
    object(parsed) &&
      ['complete', 'changes_requested', 'needs_user', 'failed'].includes(
        parsed.outcome,
      ),
    'INVALID_REPORT',
    'Worker must return a structured outcome; no stage was advanced',
  )
  const reportKeys = new Set([
    'outcome',
    'summary',
    'plan',
    'question',
    'outputs',
    'facts',
    'findings',
    'checks',
    'resolvedFindingIds',
    'acknowledgedDecisionIds',
  ])
  assert(
    Object.keys(parsed).every((key) => reportKeys.has(key)),
    'INVALID_REPORT',
    'Worker report contains an undeclared field',
  )
  text(parsed.summary, 'Report summary', 16000)
  parsed.findings ??= []
  parsed.checks ??= []
  parsed.resolvedFindingIds ??= []
  parsed.acknowledgedDecisionIds ??= []
  parsed.outputs ??= {}
  parsed.facts ??= {}
  assert(Array.isArray(parsed.findings) && parsed.findings.length <= 100, 'INVALID_REPORT', 'Invalid findings')
  assert(Array.isArray(parsed.checks) && parsed.checks.length <= 100, 'INVALID_REPORT', 'Invalid checks')
  assert(object(parsed.outputs) && object(parsed.facts), 'INVALID_REPORT', 'Outputs and facts must be objects')
  for (const finding of parsed.findings) {
    assert(object(finding), 'INVALID_REPORT', 'Invalid finding')
    text(finding.title, 'Finding title', 500)
    text(finding.detail, 'Finding detail', 8000)
  }
  for (const check of parsed.checks) {
    assert(object(check), 'INVALID_REPORT', 'Invalid check')
    text(check.command, 'Check command', 4000)
    text(check.result, 'Check result', 8000)
    if (check.path) text(check.path, 'Check scope', 4096)
  }
  for (const key of ['resolvedFindingIds', 'acknowledgedDecisionIds'])
    assert(
      Array.isArray(parsed[key]) &&
        parsed[key].length <= 500 &&
        parsed[key].every(
          (item) => typeof item === 'string' && item.length <= 200,
        ),
      'INVALID_REPORT',
      'Invalid report references',
    )
  if (parsed.outcome === 'needs_user') text(parsed.question, 'Question', 4000)
  if (method && stage) {
    const declared = new Map(
      method.artifacts.map((artifact) => [artifact.id, artifact]),
    )
    for (const [key, value] of Object.entries(parsed.outputs)) {
      assert(
        declared.has(key) && stage.produces.includes(key),
        'INVALID_REPORT',
        `Stage cannot produce undeclared artifact: ${key}`,
      )
      validateArtifactValue(declared.get(key), value)
    }
  }
  assert(
    JSON.stringify(parsed).length <= 256000,
    'INVALID_REPORT',
    'Report exceeds 256 KiB',
  )
  return parsed
}

export const reportSchema = {
  type: 'object',
  properties: {
    outcome: {
      type: 'string',
      enum: ['complete', 'changes_requested', 'needs_user', 'failed'],
    },
    summary: { type: 'string' },
    plan: { type: 'string' },
    question: { type: 'string' },
    outputs: { type: 'object' },
    facts: { type: 'object' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['title', 'detail'],
        additionalProperties: false,
      },
    },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          result: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['command', 'result'],
        additionalProperties: false,
      },
    },
    resolvedFindingIds: { type: 'array', items: { type: 'string' } },
    acknowledgedDecisionIds: { type: 'array', items: { type: 'string' } },
  },
  required: ['outcome', 'summary'],
  additionalProperties: false,
}

export function projectContext(
  task,
  stage,
  store,
  { currentCandidate, contextFile, onProjection = () => {} } = {},
) {
  const original = store.readArtifact(task.base)
  const isGit = task.workspaceAdapter === 'git'
  const current = isGit
    ? currentCandidate ??
      (task.candidate ? store.readArtifact(task.candidate.artifact) : original)
    : original
  const paths = current.paths ?? []
  const role = task.method.roles.find((item) => item.id === stage.role)
  const base = {
    taskId: task.id,
    runId: task.runId,
    step: stage.id,
    attempt: task.active.id,
    requestId: task.active.requestId,
    taskRevision: task.revision,
    goal: task.goal,
    inputs: task.inputs,
    method: {
      id: task.method.id,
      revision: task.method.revision,
      name: task.method.name,
    },
    role: { id: role.id, name: role.name },
    workspace: { adapter: task.workspaceAdapter, path: task.workspace },
    resources: structuredClone(task.resources ?? {}),
    outputs: Object.fromEntries(
      Object.entries(task.outputs ?? {}).map(([key, output]) => [
        key,
        { ...output, value: store.readArtifact(output.artifact) },
      ]),
    ),
    decisions: task.decisions.filter(
      (decision) =>
        decision.status === 'active' &&
        (decision.scope === 'task' || decision.phase === stage.id),
    ),
    userAnswers: task.permissions
      .filter((permission) => permission.kind === 'question' && permission.status === 'approved')
      .map((permission) => ({
        source: 'user',
        request: permission.id,
        attempt: permission.attempt,
        questions: permission.questions,
        answer: permission.answer,
      })),
    plan: task.plan,
    findings: task.findings.filter(
      (finding) => !['rejected', 'withdrawn'].includes(finding.status),
    ),
    resolvedUserDispositions: task.findings
      .filter((finding) => ['rejected', 'withdrawn'].includes(finding.status))
      .map((finding) => ({
        id: finding.id,
        title: finding.title,
        status: finding.status,
        disposition: finding.disposition,
      })),
    limits: task.limits,
  }
  if (isGit)
    Object.assign(base, {
      candidate: task.candidate?.identity ?? null,
      baseline: {
        head: original.head,
        identity: original.identity,
        initialStatus: original.status,
        relevantIndex: original.index
          .split('\0')
          .filter((line) => paths.includes(line.slice(line.indexOf('\t') + 1))),
        relevantFiles: Object.fromEntries(
          paths.map((path) => [path, original.files[path] ?? null]),
        ),
        initialContents: original.contents ?? {},
      },
      candidatePaths: paths,
      currentFiles: Object.fromEntries(
        paths.map((path) => [path, current.files[path] ?? null]),
      ),
      protectedPaths: task.protectedPaths,
    })
  if (role.includeReports)
    base.reports = task.attempts.map((attempt) => ({
      stage: attempt.stage,
      candidate: attempt.candidate,
      report: attempt.report ? store.readArtifact(attempt.report) : null,
      error: attempt.error,
    }))
  onProjection(base)
  const json = JSON.stringify(base)
  const inline = Buffer.byteLength(json) <= 150000
  assert(inline || contextFile, 'CONTEXT_LIMIT', 'Full context requires an explicit retrieval file')
  const workspaceInstruction = isGit
    ? stage.access === 'read'
      ? 'This stage is read-only in the Git workspace.'
      : 'You hold the only task writer lease for the Git workspace.'
    : 'This method has no workspace; return declared outputs instead of editing files.'
  const declaredOutputs = stage.produces.length
    ? `This stage may return outputs only for: ${stage.produces.join(', ')}.`
    : 'This stage does not produce a named artifact.'
  return `You are ${role.name} (${role.id}) in a locally coordinated method. ${stage.instruction}\n${workspaceInstruction} ${declaredOutputs} Do not exceed the granted permissions, spawn agents, or change models. If authority or a genuine user decision is missing, return needs_user. Return exactly one JSON object matching this schema: ${JSON.stringify(reportSchema)}\nChecks and findings are attributed reports, not automatically verified facts. Reference finding and decision IDs when resolving or acknowledging them.\n${contextFile ? `Complete role-specific context is available read-only at ${contextFile}.\n` : ''}${inline ? `Task context:\n${json}` : `Context exceeds the inline budget (${Buffer.byteLength(json)} bytes). Read the complete context file before acting; ${base.decisions.length} effective decisions and ${base.findings.length} findings are included there, not discarded.`}`
}

export function methodDigest(method) {
  return hash(validateMethod(method))
}
