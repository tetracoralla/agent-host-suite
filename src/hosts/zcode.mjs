import { access, lstat, mkdir, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { AgentHostError } from '../errors.mjs'
import { readJson, writePrivateJson } from '../json.mjs'
import { resolveExecutable, runFile } from '../process.mjs'
import { componentEnvironment } from '../component-environment.mjs'

const DEFAULT_CLI = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function targets(manifest, workspaceRoot) {
  return Object.entries(manifest.components ?? {})
    .filter(([, component]) => component.skillOnly !== true && typeof component.command === 'string' && Array.isArray(component.args))
    .map(([component, value]) => {
      const variables = value.workspaceEnvironment ?? []
      if (variables.length > 0 && workspaceRoot === null) {
        throw new AgentHostError('WORKSPACE_GRANT_REQUIRED', `${value.displayName ?? component} requires --workspace-root so ZCode can grant its deterministic tools an explicit local workspace`, {
          component,
          variables,
        })
      }
      return {
        component,
        name: component,
        binding: {
          type: 'stdio',
          command: value.command,
          args: [...value.args],
          ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
          ...(variables.length === 0 && Object.keys(value.pathGrants ?? {}).length === 0 ? {} : { env: componentEnvironment(value, workspaceRoot) }),
          enabled: true,
          ...(Number.isFinite(value.healthTimeoutMs) ? { timeoutMs: value.healthTimeoutMs } : {}),
        },
      }
    })
}

export function resolveZcodeConfigPath(options = {}) {
  if (options.configPath !== undefined) return options.configPath
  const home = options.homeRoot ?? homedir()
  return join(home, '.zcode', 'cli', 'config.json')
}

export async function resolveZcodeExecutable(runner = runFile, options = {}) {
  if (options.executable !== undefined) return options.executable
  const discovered = await resolveExecutable('zcode', runner)
  if (discovered !== null) return discovered
  try {
    await access(DEFAULT_CLI)
    return DEFAULT_CLI
  } catch {
    return null
  }
}

async function readConfig(configPath) {
  let config
  try {
    config = await readJson(configPath)
  } catch (error) {
    throw new AgentHostError('ZCODE_CONFIG_INVALID', `ZCode configuration is invalid: ${error.message}`)
  }
  if (config === null) return { mcp: { servers: {} } }
  if (!plainObject(config) || (config.mcp !== undefined && !plainObject(config.mcp))
    || (config.mcp?.servers !== undefined && !plainObject(config.mcp.servers))) {
    throw new AgentHostError('ZCODE_CONFIG_INVALID', 'ZCode configuration does not contain a valid mcp.servers object')
  }
  return config
}

async function samePath(left, right) {
  try {
    return await realpath(left) === await realpath(right)
  } catch {
    return false
  }
}

async function sameBinding(actual, expected) {
  if (!plainObject(actual) || actual.type !== expected.type || actual.enabled === false) return false
  if (!await samePath(actual.command, expected.command)) return false
  if (JSON.stringify(actual.args ?? []) !== JSON.stringify(expected.args)) return false
  if ((actual.cwd ?? null) !== (expected.cwd ?? null)) return false
  if (JSON.stringify(actual.env ?? {}) !== JSON.stringify(expected.env ?? {})) return false
  return (actual.timeoutMs ?? null) === (expected.timeoutMs ?? null)
}

async function versionOf(executable, runner) {
  if (executable === null) return null
  const result = await runner(executable, ['version', '--json'], { allowFailure: true, timeoutMs: 5_000 })
  if (result.status !== 0) return null
  try {
    const parsed = JSON.parse(result.stdout)
    return parsed.version ?? parsed.cliVersion ?? result.stdout.trim()
  } catch {
    return result.stdout.trim()
  }
}

export async function inspectZcode(manifest, runner = runFile, managedState = null, options = {}) {
  const configPath = resolveZcodeConfigPath({ ...options, configPath: managedState?.configPath ?? options.configPath })
  const executable = await resolveZcodeExecutable(runner, options)
  if (executable === null) throw new AgentHostError('ZCODE_NOT_INSTALLED', 'ZCode is not installed')
  const config = await readConfig(configPath)
  const servers = config.mcp?.servers ?? {}
  const entries = []
  for (const target of targets(manifest, options.workspaceRoot ?? managedState?.workspaceRoot ?? null)) {
    const existing = servers[target.name] ?? null
    const managed = managedState?.entries?.find((entry) => entry.component === target.component)
    const identityMatched = existing !== null && await sameBinding(existing, target.binding)
    const owned = managed?.created === true
    if (existing !== null && !identityMatched && !owned && options.replaceConflicts !== true) {
      throw new AgentHostError('ZCODE_MCP_CONFLICT', `ZCode already has an unmanaged MCP server for ${target.name} with a different binding`)
    }
    entries.push({
      component: target.component,
      name: target.name,
      present: existing !== null,
      owned,
      identityMatched,
      binding: target.binding,
      existingBinding: existing === null ? null : structuredClone(existing),
    })
  }
  return { executable, configPath, version: await versionOf(executable, runner), entries }
}

export async function installZcode(manifest, runner = runFile, managedState = null, options = {}) {
  const inspection = await inspectZcode(manifest, runner, managedState, options)
  let configExisted = true
  try {
    await lstat(inspection.configPath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    configExisted = false
  }
  const config = await readConfig(inspection.configPath)
  const servers = { ...(config.mcp?.servers ?? {}) }
  const installed = []
  for (const entry of inspection.entries) {
    if (JSON.stringify(servers[entry.name] ?? null) !== JSON.stringify(entry.existingBinding)) {
      throw new AgentHostError('ZCODE_CONFIG_CHANGED', `ZCode configuration changed while Agent Host was preparing ${entry.name}`)
    }
    if (entry.present && entry.identityMatched && !entry.owned) {
      installed.push({ ...entry, created: false, adopted: true, displaced: null })
      continue
    }
    const previous = managedState?.entries?.find((item) => item.component === entry.component)
    const displaced = previous?.displaced ?? (entry.present && !entry.owned ? structuredClone(entry.existingBinding) : null)
    servers[entry.name] = entry.binding
    installed.push({ ...entry, created: true, adopted: false, displaced })
  }
  await mkdir(dirname(inspection.configPath), { recursive: true, mode: 0o700 })
  let committed = false
  try {
    await writePrivateJson(inspection.configPath, { ...config, mcp: { ...(config.mcp ?? {}), servers } })
    committed = true
    const verified = await inspectZcode(manifest, runner, { configPath: inspection.configPath, workspaceRoot: options.workspaceRoot ?? managedState?.workspaceRoot ?? null, entries: installed }, { ...options, replaceConflicts: true })
    if (!verified.entries.every((entry) => entry.present && entry.identityMatched)) {
      throw new AgentHostError('ZCODE_MCP_UNAVAILABLE', 'ZCode did not retain the installed MCP bindings')
    }
  } catch (error) {
    if (committed) {
      if (configExisted) await writePrivateJson(inspection.configPath, config).catch(() => {})
      else await rm(inspection.configPath, { force: true }).catch(() => {})
    }
    throw error
  }
  return {
    kind: 'zcode',
    version: inspection.version,
    configPath: inspection.configPath,
    workspaceRoot: options.workspaceRoot ?? managedState?.workspaceRoot ?? null,
    entries: installed,
    restartRequired: true,
  }
}

async function currentBindingMatches(entry, servers) {
  return servers[entry.name] !== undefined && await sameBinding(servers[entry.name], entry.binding)
}

export async function uninstallZcode(hostState) {
  const config = await readConfig(hostState.configPath)
  const servers = { ...(config.mcp?.servers ?? {}) }
  const removed = []
  for (const entry of [...(hostState.entries ?? [])].reverse()) {
    if (entry.created !== true) continue
    if (!await currentBindingMatches(entry, servers)) {
      removed.push({ target: entry.name, kind: 'mcp', status: 'preserved-user-change' })
      continue
    }
    delete servers[entry.name]
    if (entry.displaced !== null && entry.displaced !== undefined) {
      servers[entry.name] = structuredClone(entry.displaced)
      removed.push({ target: entry.name, kind: 'restored-mcp', status: 'ok' })
    } else {
      removed.push({ target: entry.name, kind: 'mcp', status: 'ok' })
    }
  }
  await writePrivateJson(hostState.configPath, { ...config, mcp: { ...(config.mcp ?? {}), servers } })
  return { kind: 'zcode', removed }
}

export async function suspendZcode(hostState) {
  const config = await readConfig(hostState.configPath)
  const servers = { ...(config.mcp?.servers ?? {}) }
  const suspended = []
  for (const entry of [...(hostState.entries ?? [])].reverse()) {
    if (entry.created !== true) {
      throw new AgentHostError('TOOL_SET_UNMANAGED_BINDING', `Agent Host cannot hide unmanaged ZCode MCP server ${entry.name} without changing user-owned configuration`)
    }
    if (!await currentBindingMatches(entry, servers)) {
      throw new AgentHostError('ZCODE_MCP_CHANGED', `Agent Host cannot hide ${entry.name} because its ZCode binding was changed after installation`)
    }
    delete servers[entry.name]
    suspended.push({ target: entry.name, kind: 'mcp' })
  }
  await writePrivateJson(hostState.configPath, { ...config, mcp: { ...(config.mcp ?? {}), servers } })
  return { kind: 'zcode', suspended }
}
