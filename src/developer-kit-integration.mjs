import { posix, win32 } from 'node:path'
const { isAbsolute, normalize, sep } = posix
import { AgentHostError } from './errors.mjs'

export const DEVELOPER_KIT_INTEGRATION_SCHEMA = 'openadam.agent-host-developer-kit-integration.v0.1'

function fail(message, details) {
  throw new AgentHostError('DEVELOPER_KIT_INTEGRATION_INVALID', message, details)
}

function exactKeys(value, allowed, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) fail(`${label} contains unsupported fields`, { fields: unexpected })
}

function string(value, label, maximum = 1024) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\u0000\r\n]/u.test(value)) fail(`${label} is invalid`)
  return value
}

function identifier(value, label) {
  string(value, label, 128)
  if (!/^[a-z][a-z0-9-]*$/u.test(value)) fail(`${label} is invalid`)
  return value
}

export function developerKitRelativePath(value, label) {
  string(value, label)
  if (value.includes('\\')) fail(`${label} cannot contain backslashes`)
  const result = normalize(value)
  if ((isAbsolute(result) || win32.isAbsolute(result)) || result === '.' || result === '..' || result.startsWith(`..${sep}`)) fail(`${label} must be a contained relative path`)
  return result
}

function stringArray(value, label, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum || value.length > 128
    || value.some((item) => typeof item !== 'string' || item.length === 0)
    || new Set(value).size !== value.length) fail(`${label} is invalid`)
  return value
}

export function isDeveloperKitIntegrationSchema(value) {
  return value === DEVELOPER_KIT_INTEGRATION_SCHEMA
}

export function validateDeveloperKitIntegration(value, componentFiles = undefined) {
  exactKeys(value, ['schemaVersion', 'displayName', 'summary', 'cli', 'codex', 'skill', 'ownership'], 'developer kit integration')
  if (value.schemaVersion !== DEVELOPER_KIT_INTEGRATION_SCHEMA) fail(`Unsupported developer kit integration schema: ${value.schemaVersion ?? 'missing'}`)
  string(value.displayName, 'developer kit display name', 80)
  string(value.summary, 'developer kit summary', 180)

  exactKeys(value.cli, ['executor', 'command', 'args', 'versionArguments'], 'developer kit CLI')
  if (value.cli.executor !== 'suite-node') fail('Developer Kit CLI must use the Suite Node executor')
  const command = developerKitRelativePath(value.cli.command, 'developer kit CLI command')
  stringArray(value.cli.args, 'developer kit CLI arguments')
  stringArray(value.cli.versionArguments, 'developer kit CLI version arguments', 1)

  exactKeys(value.codex, ['marketplaceRoot', 'marketplace', 'pluginRoot', 'plugin', 'identityFiles'], 'developer kit Codex integration')
  const marketplaceRoot = developerKitRelativePath(value.codex.marketplaceRoot, 'developer kit marketplace root')
  const pluginRoot = developerKitRelativePath(value.codex.pluginRoot, 'developer kit plugin root')
  identifier(value.codex.marketplace, 'developer kit marketplace')
  identifier(value.codex.plugin, 'developer kit plugin')
  const pluginIdentity = stringArray(value.codex.identityFiles, 'developer kit plugin identity files', 2)
    .map((path) => developerKitRelativePath(path, 'developer kit plugin identity file'))

  exactKeys(value.skill, ['id', 'root', 'identityFiles', 'launcher'], 'developer kit Skill integration')
  identifier(value.skill.id, 'developer kit Skill id')
  const skillRoot = developerKitRelativePath(value.skill.root, 'developer kit Skill root')
  const skillIdentity = stringArray(value.skill.identityFiles, 'developer kit Skill identity files', 1)
    .map((path) => developerKitRelativePath(path, 'developer kit Skill identity file'))
  developerKitRelativePath(value.skill.launcher, 'developer kit Skill launcher')

  exactKeys(value.ownership, ['uninstall'], 'developer kit ownership')
  if (value.ownership.uninstall !== 'agent-host-created-only') fail('Developer Kit uninstall ownership is unsupported')

  if (componentFiles !== undefined) {
    const files = componentFiles instanceof Set ? componentFiles : new Set(componentFiles)
    for (const path of [
      command,
      `${marketplaceRoot}${sep}.agents${sep}plugins${sep}marketplace.json`,
      ...pluginIdentity.map((path) => `${pluginRoot}${sep}${path}`),
      ...skillIdentity.map((path) => `${skillRoot}${sep}${path}`),
    ]) if (!files.has(path)) fail(`Developer Kit integration file is absent from the component inventory: ${path}`)
  }
  return value
}
