import { lstat, readFile } from 'node:fs/promises'
import { resolveStateRoot } from './paths.mjs'
import { loadState, readStatePaths } from './state.mjs'
import { resolveExecutable, runFile } from './process.mjs'
import { resolveClaudeConfigPath } from './hosts/claude.mjs'
import { resolveZcodeConfigPath } from './hosts/zcode.mjs'
import { toolSetStatus } from './lifecycle.mjs'

const LIMIT = 256
const label = (value) => typeof value === 'string' ? value.slice(0, 180) : null
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

async function configEntries(path, pick, records) {
  try {
    const info = await lstat(path).catch((error) => { if (error.code === 'ENOENT') return null; throw error })
    if (info === null) return { status: 'not-configured', available: 0, returned: 0, truncated: false, entries: [] }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error('unsupported configuration')
    const config = JSON.parse(await readFile(path, 'utf8'))
    if (!object(config)) throw new Error('invalid configuration')
    const entries = pick(config) ?? {}
    if (!object(entries) || Object.values(entries).some((value) => !object(value))) throw new Error('invalid server catalog')
    const names = Object.keys(entries).sort()
    return {
      status: 'configured', available: names.length, returned: Math.min(names.length, LIMIT), truncated: names.length > LIMIT,
      entries: names.slice(0, LIMIT).map((name) => ({
        name: label(name), enabled: entries[name].enabled !== false && entries[name].disabled !== true,
        hostComponent: records.find((record) => (record.actualName ?? record.name) === name)?.component ?? null,
      })),
    }
  } catch { return { status: 'unavailable', errorCode: 'HOST_CONFIG_UNREADABLE', entries: [] } }
}

export async function toolInventory(options = {}, dependencies = {}) {
  const runner = dependencies.runner ?? runFile
  const state = await loadState(await readStatePaths(resolveStateRoot(options.stateRoot)))
  const managed = state === null ? [] : (await toolSetStatus(options)).tools
  const codex = async () => {
    try {
      const executable = await resolveExecutable('codex', runner)
      if (executable === null) return { status: 'not-installed', entries: [] }
      const result = await runner(executable, ['plugin', 'list', '--json'], { timeoutMs: 15000, maxBuffer: 4 * 1024 * 1024 })
      const value = JSON.parse(result.stdout)
      if (!Array.isArray(value.installed)) throw new Error('invalid catalog')
      const entries = value.installed.filter((item) => item.installed === true)
      return { status: 'configured', available: entries.length, returned: Math.min(entries.length, LIMIT), truncated: entries.length > LIMIT,
        entries: entries.slice(0, LIMIT).map((item) => ({
          name: label(item.name), pluginId: label(item.pluginId), version: label(item.version), enabled: item.enabled === true,
          hostComponent: state?.hosts?.codex?.entries?.find((record) => record.selector === item.pluginId)?.component ?? null,
        })),
      }
    } catch { return { status: 'unavailable', errorCode: 'HOST_PLUGIN_INVENTORY_UNAVAILABLE', entries: [] } }
  }
  const [codexEntries, claude, zcode] = await Promise.all([
    codex(),
    configEntries(resolveClaudeConfigPath({ homeRoot: options.homeRoot, configPath: state?.hosts?.claude?.configPath }),
      (config) => config.mcpServers, state?.hosts?.claude?.entries ?? []),
    configEntries(resolveZcodeConfigPath({ homeRoot: options.homeRoot, configPath: state?.hosts?.zcode?.configPath }),
      (config) => config.mcp?.servers, state?.hosts?.zcode?.entries ?? []),
  ])
  return { schemaVersion: 'openadam.agent-host-tool-inventory.v0.1', managed,
    agentApps: { codex: codexEntries, claude, zcode },
    assessmentBoundary: 'Public user-level configuration and plugin inventory only; project-scoped tools, native built-ins, current-session uptake and runtime readiness are not inferred. hostComponent is a saved Host binding match, not a fresh ownership or byte-identity check. No credentials, commands, arguments or source paths are returned.',
  }
}
