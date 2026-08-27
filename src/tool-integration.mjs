import { isAbsolute, normalize, sep } from 'node:path'
import { AgentHostError } from './errors.mjs'

export const TOOL_INTEGRATION_SCHEMA = 'openadam.agent-host-tool-integration.v0.1'

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
  if (isAbsolute(result) || result === '.' || result === '..' || result.startsWith(`..${sep}`)) fail(`${label} must be a contained relative path`)
  return result
}

function stringArray(value, label, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum || value.some((item) => typeof item !== 'string' || item.length === 0) || new Set(value).size !== value.length) {
    fail(`${label} is invalid`)
  }
  return value
}

export function validateToolIntegration(value, componentFiles = undefined) {
  exactKeys(value, ['schemaVersion', 'displayName', 'summary', 'codex', 'runtime', 'ownership'], 'tool integration')
  if (value.schemaVersion !== TOOL_INTEGRATION_SCHEMA) fail(`Unsupported tool integration schema: ${value.schemaVersion ?? 'missing'}`)
  string(value.displayName, 'tool display name', 80)
  string(value.summary, 'tool summary', 180)

  exactKeys(value.codex, ['marketplaceRoot', 'marketplace', 'pluginRoot', 'plugin', 'identityFiles'], 'Codex integration')
  const marketplaceRoot = integrationRelativePath(value.codex.marketplaceRoot, 'Codex marketplace root')
  const pluginRoot = integrationRelativePath(value.codex.pluginRoot, 'Codex plugin root')
  identifier(value.codex.marketplace, 'Codex marketplace')
  identifier(value.codex.plugin, 'Codex plugin')
  const identityFiles = stringArray(value.codex.identityFiles, 'Codex identity files', 2).map((path) => integrationRelativePath(path, 'Codex identity file'))

  exactKeys(value.runtime, ['transport', 'command', 'args', 'cwd', 'workspaceEnvironment', 'expectedTools', 'timeoutMs'], 'tool runtime')
  if (value.runtime.transport !== 'mcp-stdio') fail('Tool runtime transport is unsupported')
  const command = integrationRelativePath(value.runtime.command, 'tool runtime command')
  stringArray(value.runtime.args, 'tool runtime arguments')
  const cwd = integrationRelativePath(value.runtime.cwd, 'tool runtime working directory')
  const workspaceEnvironment = stringArray(value.runtime.workspaceEnvironment ?? [], 'tool workspace environment')
  if (workspaceEnvironment.some((name) => !/^[A-Z][A-Z0-9_]*$/u.test(name))) fail('tool workspace environment is invalid')
  stringArray(value.runtime.expectedTools, 'expected tools', 1)
  if (!Number.isSafeInteger(value.runtime.timeoutMs) || value.runtime.timeoutMs < 1000 || value.runtime.timeoutMs > 30000) fail('tool runtime timeout is invalid')

  exactKeys(value.ownership, ['uninstall'], 'tool ownership')
  if (value.ownership.uninstall !== 'agent-host-created-only') fail('Tool uninstall ownership is unsupported')

  if (componentFiles !== undefined) {
    const files = componentFiles instanceof Set ? componentFiles : new Set(componentFiles)
    for (const path of [command, ...identityFiles.map((item) => `${pluginRoot}${sep}${item}`)]) {
      if (!files.has(path)) fail(`Tool integration file is absent from the component inventory: ${path}`)
    }
    if (![marketplaceRoot, pluginRoot, cwd].every((path) => [...files].some((file) => file === path || file.startsWith(`${path}${sep}`)))) {
      fail('Tool integration directory is absent from the component inventory')
    }
  }
  return value
}
