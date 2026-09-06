import { lstat, mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { AgentHostError } from '../errors.mjs'
import { canonicalJson, readJson } from '../json.mjs'
import { resolveExecutable, runFile } from '../process.mjs'
import { componentEnvironment } from '../component-environment.mjs'
import { writeEnvironmentJson } from '../environment-resources.mjs'

export const CLAUDE_USER_CONFIG_ARGUMENTS = Object.freeze([
  '--disable-slash-commands', '--no-chrome', '--setting-sources', 'user',
])
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const equal = (left, right) => canonicalJson(left) === canonicalJson(right)

// This is Claude's public user-scoped MCP extension point. Reading the JSON
// preserves argv and non-stdio fields that the human CLI rendering loses.
export function resolveClaudeConfigPath(options = {}) {
  const configRoot = options.configRoot ?? (options.homeRoot === undefined ? process.env.CLAUDE_CONFIG_DIR : undefined)
  const path = options.configPath ?? (configRoot === undefined
    ? join(options.homeRoot ?? homedir(), '.claude.json')
    : join(configRoot, '.claude.json'))
  if (!isAbsolute(path)) throw new AgentHostError('CLAUDE_CONFIG_PATH_INVALID', 'Claude user configuration requires an absolute path')
  return resolve(path)
}

async function readConfig(path) {
  let value
  try {
    const info = await lstat(path).catch((error) => { if (error.code === 'ENOENT') return null; throw error })
    if (info === null) return null
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error('Unsupported config file')
    value = await readJson(path)
  } catch {
    throw new AgentHostError('CLAUDE_CONFIG_INVALID', 'Claude user configuration could not be read as a supported JSON file')
  }
  if (!object(value) || (value.mcpServers !== undefined && !object(value.mcpServers))) {
    throw new AgentHostError('CLAUDE_CONFIG_INVALID', 'Claude user configuration does not contain a valid mcpServers object')
  }
  return value
}

function targets(manifest, workspaceRoot) {
  return Object.entries(manifest.components ?? {})
    .filter(([, component]) => component.skillOnly !== true && typeof component.command === 'string' && Array.isArray(component.args))
    .map(([name, component]) => {
      const variables = component.workspaceEnvironment ?? []
      if (variables.length > 0 && workspaceRoot === null) {
        throw new AgentHostError('WORKSPACE_GRANT_REQUIRED', (component.displayName ?? name) + ' requires an explicit local workspace for Claude Code', { component: name, variables })
      }
      return { name, aliases: [...new Set([name, name.replaceAll('-', '_')])],
        binding: { type: 'stdio', command: component.command, args: [...component.args], env: componentEnvironment(component, workspaceRoot) } }
    })
}

async function sameBinding(actual, expected) {
  if (!object(actual) || (actual.type ?? 'stdio') !== 'stdio' || actual.disabled === true) return false
  if (!equal(actual.args ?? [], expected.args) || !equal(actual.env ?? {}, expected.env)) return false
  try { return await realpath(actual.command) === await realpath(expected.command) } catch { return false }
}

function retainedBinding(entry) {
  return entry.binding ?? { type: 'stdio', command: entry.command, args: entry.args, env: entry.environment ?? {} }
}

async function ownedBindingMatches(actual, entry) {
  if (entry.binding !== undefined) return equal(actual, entry.binding)
  // Legacy records did not retain every JSON field. Extra current settings
  // cannot be proved owned, so preserve those entries.
  return object(actual) && Object.keys(actual).every((key) => ['type', 'command', 'args', 'env'].includes(key))
    && await sameBinding(actual, retainedBinding(entry))
}

export async function inspectClaude(manifest, runner = runFile, managedState = null, options = {}) {
  const executable = await resolveExecutable('claude', runner)
  if (executable === null) throw new AgentHostError('CLAUDE_NOT_INSTALLED', 'Claude Code is not installed or not on PATH')
  const configPath = resolveClaudeConfigPath({ ...options, configPath: managedState?.configPath ?? options.configPath })
  const config = await readConfig(configPath)
  const servers = config?.mcpServers ?? {}
  const versionResult = await runner(executable, [...CLAUDE_USER_CONFIG_ARGUMENTS, '--version'])
  const entries = []
  for (const target of targets(manifest, options.workspaceRoot ?? managedState?.workspaceRoot ?? null)) {
    const aliases = target.aliases.filter((name) => Object.hasOwn(servers, name))
    if (aliases.length > 1) throw new AgentHostError('CLAUDE_MCP_CONFLICT', 'Claude user configuration exposes multiple aliases for ' + target.name)
    const actualName = aliases[0] ?? target.name
    const existing = aliases.length === 0 ? null : servers[actualName]
    if (aliases.length > 0 && !object(existing)) throw new AgentHostError('CLAUDE_CONFIG_INVALID', 'Claude user binding ' + actualName + ' is not an object')
    const managed = managedState?.entries?.find((entry) => entry.component === target.name)
    const owned = managed?.created === true
    const identityMatched = existing !== null && await sameBinding(existing, target.binding)
    if (existing !== null && !identityMatched && !owned && options.replaceConflicts !== true) {
      throw new AgentHostError('CLAUDE_MCP_CONFLICT', 'Claude Code already has an unmanaged user MCP server for ' + target.name + ' with a different binding')
    }
    if (existing !== null && owned && !await ownedBindingMatches(existing, managed) && options.replaceConflicts !== true) {
      throw new AgentHostError('CLAUDE_MCP_CHANGED', 'Claude user binding ' + actualName + ' changed after installation')
    }
    entries.push({ name: target.name, component: target.name, actualName, present: existing !== null, owned, identityMatched,
      command: target.binding.command, args: target.binding.args, environment: target.binding.env, binding: target.binding,
      existingBinding: existing === null ? null : structuredClone(existing) })
  }
  return { executable, configPath, version: versionResult.stdout.trim(), entries }
}

export async function installClaude(manifest, runner = runFile, managedState = null, options = {}) {
  const inspection = await inspectClaude(manifest, runner, managedState, options)
  const config = await readConfig(inspection.configPath)
  const servers = { ...(config?.mcpServers ?? {}) }
  const installed = []
  const selectors = []
  for (const entry of inspection.entries) {
    if (!equal(servers[entry.actualName] ?? null, entry.existingBinding)) {
      throw new AgentHostError('CLAUDE_CONFIG_CHANGED', 'Claude user configuration changed while preparing ' + entry.name)
    }
    if (entry.present && entry.identityMatched && !entry.owned) {
      installed.push({ ...entry, created: false, adopted: true, displaced: null })
      continue
    }
    const previous = managedState?.entries?.find((item) => item.component === entry.component)
    const changedOwned = entry.present && entry.owned && !await ownedBindingMatches(entry.existingBinding, previous)
    if (changedOwned && options.replaceConflicts !== true) {
      throw new AgentHostError('CLAUDE_MCP_CHANGED', 'Claude user binding ' + entry.actualName + ' changed after installation')
    }
    const displaced = changedOwned ? { name: entry.actualName, config: entry.existingBinding }
      : previous?.displaced ?? (entry.present && !entry.owned ? { name: entry.actualName, config: entry.existingBinding } : null)
    delete servers[entry.actualName]
    servers[entry.name] = entry.binding
    selectors.push(['mcpServers', entry.actualName])
    if (entry.name !== entry.actualName) selectors.push(['mcpServers', entry.name])
    installed.push({ ...entry, actualName: entry.name, created: true, adopted: false, displaced })
  }
  if (selectors.length > 0) {
    await mkdir(dirname(inspection.configPath), { recursive: true, mode: 0o700 })
    await writeEnvironmentJson(inspection.configPath, { ...(config ?? {}), mcpServers: servers }, selectors, config)
  }
  return { kind: 'claude', version: inspection.version, configPath: inspection.configPath,
    workspaceRoot: options.workspaceRoot ?? managedState?.workspaceRoot ?? null, entries: installed, restartRequired: true }
}

function displacedConfig(displaced) {
  if (object(displaced.config)) return displaced.config
  if (displaced.argsExact !== true) throw new AgentHostError('CLAUDE_MCP_RESTORE_UNVERIFIABLE', 'The older installation retained only a rendered argument line; restore requires the original exact binding')
  return { type: 'stdio', command: displaced.command, args: displaced.args, env: displaced.environment ?? {} }
}

async function removeBindings(hostState, suspend) {
  const configPath = resolveClaudeConfigPath({ configPath: hostState.configPath })
  const config = await readConfig(configPath)
  const servers = { ...(config?.mcpServers ?? {}) }
  const results = []
  const selectors = []
  for (const entry of [...hostState.entries].reverse()) {
    if (entry.created !== true) {
      if (suspend) throw new AgentHostError('TOOL_SET_UNMANAGED_BINDING', 'Agent Host cannot hide unmanaged Claude user MCP server ' + entry.actualName)
      continue
    }
    const actual = servers[entry.actualName] ?? null
    const intentionallySuspended = (hostState.inactiveEntries ?? []).some((item) => item.component === entry.component)
    if (actual === null && (!intentionallySuspended || suspend)) {
      if (suspend) throw new AgentHostError('CLAUDE_MCP_CHANGED', 'Claude user binding ' + entry.actualName + ' is no longer present')
      results.push({ target: entry.actualName, kind: 'mcp', status: 'preserved-user-change' })
      continue
    }
    if (actual !== null && !await ownedBindingMatches(actual, entry)) {
      if (suspend) throw new AgentHostError('CLAUDE_MCP_CHANGED', 'Claude user binding ' + entry.actualName + ' changed after installation')
      results.push({ target: entry.actualName, kind: 'mcp', status: 'preserved-user-change' })
      continue
    }
    if (!suspend && entry.displaced != null) {
      const displaced = entry.displaced
      if (displaced.name !== entry.actualName && Object.hasOwn(servers, displaced.name)) {
        throw new AgentHostError('CLAUDE_MCP_CHANGED', 'The displaced Claude user alias ' + displaced.name + ' is occupied')
      }
      const restored = displacedConfig(displaced)
      delete servers[entry.actualName]
      servers[displaced.name] = restored
      selectors.push(['mcpServers', displaced.name])
      results.push({ target: displaced.name, kind: 'restored-mcp', status: 0 })
    } else {
      delete servers[entry.actualName]
      results.push({ target: entry.actualName, kind: 'mcp', status: 0 })
    }
    if (!selectors.some((keys) => keys[1] === entry.actualName)) selectors.push(['mcpServers', entry.actualName])
  }
  if (selectors.length > 0) {
    const next = { ...(config ?? {}), mcpServers: servers }
    if (config !== null || Object.keys(servers).length > 0) {
      await mkdir(dirname(configPath), { recursive: true, mode: 0o700 })
      await writeEnvironmentJson(configPath, next, selectors, config)
    }
  }
  return { kind: 'claude', [suspend ? 'suspended' : 'removed']: results }
}

export async function uninstallClaude(hostState, _runner = runFile) { return removeBindings(hostState, false) }
export async function suspendClaude(hostState, _runner = runFile) { return removeBindings(hostState, true) }
