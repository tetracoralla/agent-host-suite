import { posix, win32 } from 'node:path'

// Manifest inventories always use slash-separated paths, regardless of host OS.
const { isAbsolute, normalize, sep } = posix
import { AgentHostError } from './errors.mjs'

export const TOOL_INTEGRATION_SCHEMA = 'openadam.agent-host-tool-integration.v0.1'
export const TOOL_INTEGRATION_SCHEMA_V2 = 'openadam.agent-host-tool-integration.v0.2'
export const TOOL_INTEGRATION_SCHEMA_V3 = 'openadam.agent-host-tool-integration.v0.3'
export const TOOL_INTEGRATION_SCHEMA_V4 = 'openadam.agent-host-tool-integration.v0.4'
export const TOOL_INTEGRATION_SCHEMA_V5 = 'openadam.agent-host-tool-integration.v0.5'

export function isToolIntegrationSchema(value) {
  return [TOOL_INTEGRATION_SCHEMA, TOOL_INTEGRATION_SCHEMA_V2, TOOL_INTEGRATION_SCHEMA_V3, TOOL_INTEGRATION_SCHEMA_V4, TOOL_INTEGRATION_SCHEMA_V5].includes(value)
}

function fail(message, details) {
  throw new AgentHostError('TOOL_INTEGRATION_INVALID', message, details)
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

function identifier(value, label) {
  string(value, label)
  if (!/^[a-z][a-z0-9-]*$/u.test(value)) fail(`${label} is invalid`)
  return value
}

export function integrationRelativePath(value, label) {
  string(value, label)
  if (value.includes('\\')) fail(`${label} cannot contain backslashes`)
  const result = normalize(value)
  if (isAbsolute(result) || win32.isAbsolute(result) || result === '.' || result === '..' || result.startsWith(`..${sep}`)) fail(`${label} must be a contained relative path`)
  return result
}

function stringArray(value, label, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum || value.some((item) => typeof item !== 'string' || item.length === 0) || new Set(value).size !== value.length) {
    fail(`${label} is invalid`)
  }
  return value
}

export function validateToolIntegration(value, componentFiles = undefined) {
  const toolKeys = ['schemaVersion', 'displayName', 'summary', 'codex', 'runtime', 'ownership']
  if (value?.schemaVersion === TOOL_INTEGRATION_SCHEMA_V3) toolKeys.push('discovery')
  if (value?.schemaVersion === TOOL_INTEGRATION_SCHEMA_V4) toolKeys.push('directCapability')
  exactKeys(value, toolKeys, 'tool integration')
  if (!isToolIntegrationSchema(value.schemaVersion)) fail(`Unsupported tool integration schema: ${value.schemaVersion ?? 'missing'}`)
  string(value.displayName, 'tool display name', 80)
  string(value.summary, 'tool summary', 180)

  exactKeys(value.codex, ['marketplaceRoot', 'marketplace', 'pluginRoot', 'plugin', 'identityFiles'], 'Codex integration')
  const marketplaceRoot = integrationRelativePath(value.codex.marketplaceRoot, 'Codex marketplace root')
  const pluginRoot = integrationRelativePath(value.codex.pluginRoot, 'Codex plugin root')
  identifier(value.codex.marketplace, 'Codex marketplace')
  identifier(value.codex.plugin, 'Codex plugin')
  const identityFiles = stringArray(value.codex.identityFiles, 'Codex identity files', 2).map((path) => integrationRelativePath(path, 'Codex identity file'))

  const runtimeKeys = ['transport', 'command', 'args', 'cwd', 'workspaceEnvironment', 'expectedTools', 'timeoutMs']
  if ([TOOL_INTEGRATION_SCHEMA_V2, TOOL_INTEGRATION_SCHEMA_V3, TOOL_INTEGRATION_SCHEMA_V4, TOOL_INTEGRATION_SCHEMA_V5].includes(value.schemaVersion)) runtimeKeys.push('executor')
  if (value.schemaVersion === TOOL_INTEGRATION_SCHEMA_V5) runtimeKeys.push('optionalPathEnvironment')
  exactKeys(value.runtime, runtimeKeys, 'tool runtime')
  if (value.runtime.transport !== 'mcp-stdio') fail('Tool runtime transport is unsupported')
  const executor = [TOOL_INTEGRATION_SCHEMA_V2, TOOL_INTEGRATION_SCHEMA_V3, TOOL_INTEGRATION_SCHEMA_V4, TOOL_INTEGRATION_SCHEMA_V5].includes(value.schemaVersion) ? value.runtime.executor : 'component'
  if (!['component', 'suite-node'].includes(executor)) fail('Tool runtime executor is unsupported')
  const command = integrationRelativePath(value.runtime.command, 'tool runtime command')
  stringArray(value.runtime.args, 'tool runtime arguments')
  const cwd = integrationRelativePath(value.runtime.cwd, 'tool runtime working directory')
  const workspaceEnvironment = stringArray(value.runtime.workspaceEnvironment ?? [], 'tool workspace environment')
  if (workspaceEnvironment.some((name) => !/^[A-Z][A-Z0-9_]*$/u.test(name))) fail('tool workspace environment is invalid')
  const optionalPathEnvironment = value.schemaVersion === TOOL_INTEGRATION_SCHEMA_V5
    ? stringArray(value.runtime.optionalPathEnvironment ?? [], 'tool optional path environment')
    : []
  if (optionalPathEnvironment.some((name) => !/^[A-Z][A-Z0-9_]*$/u.test(name))) fail('tool optional path environment is invalid')
  const overlappingEnvironment = optionalPathEnvironment.filter((name) => workspaceEnvironment.includes(name))
  if (overlappingEnvironment.length > 0) fail('tool workspace and optional path environment names must be distinct', { fields: overlappingEnvironment })
  stringArray(value.runtime.expectedTools, 'expected tools', 1)
  if (!Number.isSafeInteger(value.runtime.timeoutMs) || value.runtime.timeoutMs < 1000 || value.runtime.timeoutMs > 30000) fail('tool runtime timeout is invalid')

  exactKeys(value.ownership, ['uninstall'], 'tool ownership')
  if (value.ownership.uninstall !== 'agent-host-created-only') fail('Tool uninstall ownership is unsupported')

  let discovery = null
  if (value.schemaVersion === TOOL_INTEGRATION_SCHEMA_V3) {
    exactKeys(value.discovery, ['kind', 'skill', 'runtime'], 'tool discovery')
    if (value.discovery.kind !== 'skill-cli') fail('Tool discovery kind is unsupported')
    exactKeys(value.discovery.skill, ['id', 'root', 'identityFiles', 'launcher'], 'tool discovery Skill')
    const skillId = identifier(value.discovery.skill.id, 'tool discovery Skill id')
    const skillRoot = integrationRelativePath(value.discovery.skill.root, 'tool discovery Skill root')
    const expectedSkillRoot = `${pluginRoot}${sep}skills${sep}${skillId}`
    if (skillRoot !== expectedSkillRoot) fail('Tool discovery Skill root must match the declared Codex plugin Skill')
    const skillIdentityFiles = stringArray(value.discovery.skill.identityFiles, 'tool discovery Skill identity files', 1)
      .map((path) => integrationRelativePath(path, 'tool discovery Skill identity file'))
    if (!skillIdentityFiles.includes('SKILL.md')) fail('Tool discovery Skill identity files must include SKILL.md')
    const launcher = integrationRelativePath(value.discovery.skill.launcher, 'tool discovery Skill launcher')
    exactKeys(value.discovery.runtime, ['executor', 'command', 'args', 'versionArguments'], 'tool discovery runtime')
    if (!['component', 'suite-node'].includes(value.discovery.runtime.executor)) fail('Tool discovery runtime executor is unsupported')
    const discoveryCommand = integrationRelativePath(value.discovery.runtime.command, 'tool discovery runtime command')
    const discoveryArgs = stringArray(value.discovery.runtime.args, 'tool discovery runtime arguments')
    const versionArguments = stringArray(value.discovery.runtime.versionArguments, 'tool discovery version arguments', 1)
    discovery = { skillId, skillRoot, skillIdentityFiles, launcher, discoveryCommand, discoveryArgs, versionArguments }
  }

  let directCapability = null
  if (value.schemaVersion === TOOL_INTEGRATION_SCHEMA_V4) {
    exactKeys(value.directCapability, ['providerId', 'transport', 'lifecycle', 'workspaceRoot', 'capabilityId', 'capabilityVersion', 'adapter', 'manifest', 'profile', 'identityFiles', 'contracts'], 'Direct Capability integration')
    string(value.directCapability.providerId, 'Direct Capability provider id')
    if (value.directCapability.transport !== 'capability-jsonl-v0.1') fail('Direct Capability transport is unsupported')
    if (!['persistent', 'per-call'].includes(value.directCapability.lifecycle)) fail('Direct Capability lifecycle is unsupported')
    if (value.directCapability.workspaceRoot !== undefined && value.directCapability.workspaceRoot !== 'host-required') fail('Direct Capability workspace root policy is unsupported')
    string(value.directCapability.capabilityId, 'Direct Capability id')
    string(value.directCapability.capabilityVersion, 'Direct Capability version')
    exactKeys(value.directCapability.adapter, ['command', 'args', 'cwd'], 'Direct Capability adapter')
    const adapterCommand = integrationRelativePath(value.directCapability.adapter.command, 'Direct Capability adapter command')
    const adapterArgs = stringArray(value.directCapability.adapter.args, 'Direct Capability adapter arguments')
    const adapterCwd = integrationRelativePath(value.directCapability.adapter.cwd, 'Direct Capability adapter working directory')
    const manifest = integrationRelativePath(value.directCapability.manifest, 'Direct Capability manifest')
    const profile = integrationRelativePath(value.directCapability.profile, 'Direct Capability Profile')
    const capabilityIdentityFiles = stringArray(value.directCapability.identityFiles, 'Direct Capability identity files', 1)
      .map((path) => integrationRelativePath(path, 'Direct Capability identity file'))
    if (!capabilityIdentityFiles.includes(adapterCommand)) fail('Direct Capability identity files must include the adapter command')
    if (!Array.isArray(value.directCapability.contracts) || value.directCapability.contracts.length === 0) fail('Direct Capability contracts are invalid')
    const operationIds = new Set()
    const contracts = value.directCapability.contracts.map((contract) => {
      exactKeys(contract, ['operationId', 'inputSchema', 'outputSchema'], 'Direct Capability contract')
      const operationId = string(contract.operationId, 'Direct Capability operation id')
      if (operationIds.has(operationId)) fail('Direct Capability operation ids must be unique')
      operationIds.add(operationId)
      return {
        operationId,
        inputSchema: integrationRelativePath(contract.inputSchema, 'Direct Capability input schema'),
        outputSchema: integrationRelativePath(contract.outputSchema, 'Direct Capability output schema'),
      }
    })
    directCapability = { adapterCommand, adapterArgs, adapterCwd, manifest, profile, capabilityIdentityFiles, contracts }
  }

  if (componentFiles !== undefined) {
    const files = componentFiles instanceof Set ? componentFiles : new Set(componentFiles)
    const requiredFiles = [command, ...identityFiles.map((item) => `${pluginRoot}${sep}${item}`)]
    if (discovery !== null) {
      requiredFiles.push(
        discovery.discoveryCommand,
        ...discovery.skillIdentityFiles.map((item) => `${discovery.skillRoot}${sep}${item}`),
      )
      const launcherPath = `${discovery.skillRoot}${sep}${discovery.launcher}`
      if (files.has(launcherPath)) fail(`Tool discovery launcher is Host-owned and must not exist in the component inventory: ${launcherPath}`)
    }
    if (directCapability !== null) {
      requiredFiles.push(
        directCapability.adapterCommand,
        directCapability.manifest,
        directCapability.profile,
        ...directCapability.capabilityIdentityFiles,
        ...directCapability.contracts.flatMap((contract) => [contract.inputSchema, contract.outputSchema]),
      )
    }
    for (const path of requiredFiles) {
      if (!files.has(path)) fail(`Tool integration file is absent from the component inventory: ${path}`)
    }
    const requiredDirectories = [marketplaceRoot, pluginRoot, cwd, ...(discovery === null ? [] : [discovery.skillRoot]), ...(directCapability === null ? [] : [directCapability.adapterCwd])]
    if (!requiredDirectories.every((path) => [...files].some((file) => file === path || file.startsWith(`${path}${sep}`)))) {
      fail('Tool integration directory is absent from the component inventory')
    }
  }
  return value
}
