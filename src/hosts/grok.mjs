import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { AgentHostError } from '../errors.mjs'
import { canonicalJson } from '../json.mjs'
import { resolveExecutable, runFile } from '../process.mjs'
import { componentEnvironment } from '../component-environment.mjs'

const SERVER_NAME = /^[A-Za-z0-9_-]+$/
const MAX_CONFIG_BYTES = 1024 * 1024

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function equal(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

export function resolveGrokHome(options = {}) {
  if (options.homeRoot !== undefined) {
    if (!isAbsolute(options.homeRoot)) throw new AgentHostError('GROK_CONFIG_PATH_INVALID', 'Grok home root requires an absolute path')
    return join(resolve(options.homeRoot), '.grok')
  }
  if (typeof options.grokHome === 'string') {
    if (!isAbsolute(options.grokHome)) throw new AgentHostError('GROK_CONFIG_PATH_INVALID', 'GROK_HOME requires an absolute path')
    return resolve(options.grokHome)
  }
  if (typeof process.env.GROK_HOME === 'string' && process.env.GROK_HOME.length > 0) {
    if (!isAbsolute(process.env.GROK_HOME)) throw new AgentHostError('GROK_CONFIG_PATH_INVALID', 'GROK_HOME requires an absolute path')
    return resolve(process.env.GROK_HOME)
  }
  return join(homedir(), '.grok')
}

export function resolveGrokConfigPath(options = {}) {
  if (options.configPath !== undefined) {
    if (!isAbsolute(options.configPath)) throw new AgentHostError('GROK_CONFIG_PATH_INVALID', 'Grok user configuration requires an absolute path')
    return resolve(options.configPath)
  }
  return join(resolveGrokHome(options), 'config.toml')
}

function targets(manifest, workspaceRoot) {
  return Object.entries(manifest.components ?? {})
    .filter(([, component]) => component.skillOnly !== true && typeof component.command === 'string' && Array.isArray(component.args))
    .map(([name, component]) => {
      const variables = component.workspaceEnvironment ?? []
      if (variables.length > 0 && workspaceRoot === null) {
        throw new AgentHostError('WORKSPACE_GRANT_REQUIRED', `${component.displayName ?? name} requires an explicit local workspace for Grok`, {
          component: name,
          variables,
        })
      }
      const env = componentEnvironment(component, workspaceRoot)
      return {
        name,
        aliases: [...new Set([name, name.replaceAll('-', '_')])],
        binding: {
          command: component.command,
          args: [...component.args],
          ...(Object.keys(env).length === 0 ? {} : { env }),
          enabled: true,
        },
      }
    })
}

function tomlString(value) {
  return JSON.stringify(String(value))
}

function tomlKey(key) {
  return SERVER_NAME.test(key) ? key : tomlString(key)
}

function tomlValue(value) {
  if (typeof value === 'string') return tomlString(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return `[${value.map((item) => tomlValue(item)).join(', ')}]`
  if (plainObject(value)) {
    const entries = Object.keys(value).sort().map((key) => `${tomlKey(key)} = ${tomlValue(value[key])}`)
    return `{ ${entries.join(', ')} }`
  }
  throw new AgentHostError('GROK_CONFIG_INVALID', 'Grok MCP binding contains a value that cannot be written')
}

function renderServer(name, binding) {
  if (!SERVER_NAME.test(name)) throw new AgentHostError('GROK_CONFIG_INVALID', `Grok MCP server name ${name} is not a supported identifier`)
  const lines = [
    `[mcp_servers.${name}]`,
    `command = ${tomlString(binding.command)}`,
    `args = ${tomlValue(binding.args ?? [])}`,
  ]
  if (plainObject(binding.env) && Object.keys(binding.env).length > 0) lines.push(`env = ${tomlValue(binding.env)}`)
  if (typeof binding.cwd === 'string') lines.push(`cwd = ${tomlString(binding.cwd)}`)
  lines.push(`enabled = ${binding.enabled === false ? 'false' : 'true'}`)
  return lines.join('\n')
}

function headerKey(line) {
  const match = /^\s*\[([^\]\n]+)\]\s*(?:#.*)?$/u.exec(line)
  return match ? match[1].trim() : null
}

function serverNameFromHeader(key) {
  const prefix = 'mcp_servers.'
  if (!key.startsWith(prefix)) return null
  const name = key.slice(prefix.length)
  if (!SERVER_NAME.test(name) || name.includes('.')) return null
  return name
}

function splitDocument(text) {
  const lines = text.split('\n')
  const sections = []
  let current = { header: null, lines: [] }
  for (const line of lines) {
    const header = headerKey(line)
    if (header !== null) {
      sections.push(current)
      current = { header, lines: [line] }
    } else {
      current.lines.push(line)
    }
  }
  sections.push(current)
  return sections
}

function joinDocument(sections) {
  const text = sections.map((section) => section.lines.join('\n')).join('\n')
  return text.endsWith('\n') || text.length === 0 ? text : `${text}\n`
}

function skipSpace(source, index) {
  let cursor = index
  while (cursor < source.length && /\s/u.test(source[cursor])) cursor += 1
  return cursor
}

function parseTomlValue(source, index) {
  let cursor = skipSpace(source, index)
  if (source.startsWith('true', cursor) && !/[A-Za-z0-9_-]/u.test(source[cursor + 4] ?? '')) return { value: true, index: cursor + 4 }
  if (source.startsWith('false', cursor) && !/[A-Za-z0-9_-]/u.test(source[cursor + 5] ?? '')) return { value: false, index: cursor + 5 }
  if (source[cursor] === '"') {
    let end = cursor + 1
    while (end < source.length) {
      if (source[end] === '\\') {
        end += 2
        continue
      }
      if (source[end] === '"') break
      end += 1
    }
    if (source[end] !== '"') throw new AgentHostError('GROK_CONFIG_INVALID', 'Grok configuration contains an unfinished string')
    return { value: JSON.parse(source.slice(cursor, end + 1)), index: end + 1 }
  }
  if (source[cursor] === '[') {
    const values = []
    cursor += 1
    while (true) {
      cursor = skipSpace(source, cursor)
      if (source[cursor] === ']') return { value: values, index: cursor + 1 }
      const next = parseTomlValue(source, cursor)
      if (typeof next.value !== 'string') throw new AgentHostError('GROK_CONFIG_INVALID', 'Grok MCP arrays must contain strings')
      values.push(next.value)
      cursor = skipSpace(source, next.index)
      if (source[cursor] === ',') {
        cursor += 1
        continue
      }
      if (source[cursor] === ']') return { value: values, index: cursor + 1 }
      throw new AgentHostError('GROK_CONFIG_INVALID', 'Grok MCP array is not a supported list of strings')
    }
  }
  if (source[cursor] === '{') {
    const table = {}
    cursor += 1
    while (true) {
      cursor = skipSpace(source, cursor)
      if (source[cursor] === '}') return { value: table, index: cursor + 1 }
      let key
      if (source[cursor] === '"') {
        const parsed = parseTomlValue(source, cursor)
        key = parsed.value
        cursor = parsed.index
      } else {
        const match = /^[A-Za-z0-9_-]+/u.exec(source.slice(cursor))
        if (match === null) throw new AgentHostError('GROK_CONFIG_INVALID', 'Grok MCP table key is not supported')
        key = match[0]
        cursor += key.length
      }
      cursor = skipSpace(source, cursor)
      if (source[cursor] !== '=') throw new AgentHostError('GROK_CONFIG_INVALID', 'Grok MCP table entry is missing a value')
      const parsed = parseTomlValue(source, cursor + 1)
      if (typeof parsed.value !== 'string') throw new AgentHostError('GROK_CONFIG_INVALID', 'Grok MCP environment values must be strings')
      table[key] = parsed.value
      cursor = skipSpace(source, parsed.index)
      if (source[cursor] === ',') {
        cursor += 1
        continue
      }
      if (source[cursor] === '}') return { value: table, index: cursor + 1 }
      throw new AgentHostError('GROK_CONFIG_INVALID', 'Grok MCP table is not a supported inline table')
    }
  }
  throw new AgentHostError('GROK_CONFIG_INVALID', 'Grok MCP value uses syntax Agent Host does not preserve')
}

function parseServerSection(section) {
  const binding = { command: null, args: [], env: {}, enabled: true }
  const extra = []
  for (const line of section.lines.slice(1)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 0) throw new AgentHostError('GROK_CONFIG_INVALID', 'Grok MCP server entry is not a key and value')
    const key = line.slice(0, separator).trim()
    if (!['command', 'args', 'env', 'cwd', 'enabled'].includes(key)) {
      // Preserve options Grok supports but Agent Host does not own (for
      // example per-server timeouts and headers) as an opaque displaced
      // section. They must produce a normal binding conflict, not make the
      // whole user configuration unreadable merely because their TOML value
      // is outside the small Host-owned writer grammar.
      extra.push(key)
      continue
    }
    const parsed = parseTomlValue(line.slice(separator + 1), 0)
    if (skipSpace(line.slice(separator + 1), parsed.index) !== line.slice(separator + 1).length) {
      throw new AgentHostError('GROK_CONFIG_INVALID', 'Grok MCP server entry has unsupported trailing syntax')
    }
    if (key === 'command' && typeof parsed.value === 'string') binding.command = parsed.value
    else if (key === 'args' && Array.isArray(parsed.value)) binding.args = parsed.value
    else if (key === 'env' && plainObject(parsed.value)) binding.env = parsed.value
    else if (key === 'cwd' && typeof parsed.value === 'string') binding.cwd = parsed.value
    else if (key === 'enabled' && typeof parsed.value === 'boolean') binding.enabled = parsed.value
  }
  if (typeof binding.command !== 'string') throw new AgentHostError('GROK_CONFIG_INVALID', 'Grok MCP server is missing its command')
  return { binding, extra }
}

export async function inspectGrokServerCatalog(options = {}) {
  const configPath = resolveGrokConfigPath(options)
  const config = await readConfig(configPath)
  const entries = []
  let unsupportedSections = 0
  for (const section of config.sections) {
    if (section.header === null || !section.header.startsWith('mcp_servers.')) continue
    const name = serverNameFromHeader(section.header)
    if (name === null) {
      unsupportedSections += 1
      continue
    }
    let enabled = true
    for (const line of section.lines.slice(1)) {
      const separator = line.indexOf('=')
      if (separator < 0 || line.slice(0, separator).trim() !== 'enabled') continue
      const parsed = parseTomlValue(line.slice(separator + 1), 0)
      if (typeof parsed.value !== 'boolean') throw new AgentHostError('GROK_CONFIG_INVALID', `Grok MCP server ${name} has an invalid enabled value`)
      enabled = parsed.value
    }
    entries.push({ name, enabled })
  }
  entries.sort((left, right) => left.name.localeCompare(right.name))
  return { configPath, configured: config.existed, entries, unsupportedSections }
}

async function readConfig(configPath) {
  let info
  try {
    info = await lstat(configPath)
  } catch (error) {
    if (error.code === 'ENOENT') return { existed: false, text: '', sections: splitDocument('') }
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CONFIG_BYTES) {
    throw new AgentHostError('GROK_CONFIG_INVALID', 'Grok user configuration is not a supported file')
  }
  const text = await readFile(configPath, 'utf8')
  if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) throw new AgentHostError('GROK_CONFIG_INVALID', 'Grok user configuration is too large to edit safely')
  return { existed: true, text, sections: splitDocument(text) }
}

function serversByName(sections) {
  const servers = new Map()
  for (const section of sections) {
    if (section.header === null) continue
    const name = serverNameFromHeader(section.header)
    if (name === null) continue
    if (servers.has(name)) throw new AgentHostError('GROK_CONFIG_INVALID', `Grok configuration defines ${name} more than once`)
    servers.set(name, section)
  }
  return servers
}

async function sameCommand(left, right) {
  try {
    return await realpath(left) === await realpath(right)
  } catch {
    return left === right
  }
}

async function sameBinding(actual, expected) {
  if (actual.enabled === false || expected.enabled === false) return false
  if (!equal(actual.args ?? [], expected.args ?? [])) return false
  if (!equal(actual.env ?? {}, expected.env ?? {})) return false
  if ((actual.cwd ?? null) !== (expected.cwd ?? null)) return false
  return sameCommand(actual.command, expected.command)
}

function ownedBinding(entry) {
  return entry.binding ?? { command: entry.command, args: entry.args, env: entry.env ?? {}, enabled: true }
}

async function writeConfig(configPath, sections) {
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 })
  const text = joinDocument(sections)
  const temporary = `${configPath}.${process.pid}.tmp`
  await writeFile(temporary, text, { mode: 0o600 })
  await rename(temporary, configPath)
}

function replaceServer(sections, name, binding) {
  const header = `mcp_servers.${name}`
  const rendered = renderServer(name, binding).split('\n')
  let replaced = false
  const next = sections.map((section) => {
    if (section.header !== header) return section
    replaced = true
    return { header, lines: rendered }
  })
  if (!replaced) next.push({ header, lines: rendered })
  return next
}

function restoreServer(sections, name, displacedSection) {
  const header = `mcp_servers.${name}`
  const without = sections.filter((section) => section.header !== header)
  if (displacedSection == null) return without
  without.push({ header, lines: displacedSection })
  return without
}

async function versionOf(executable, runner) {
  if (executable === null) return null
  const result = await runner(executable, ['--version'], { allowFailure: true, timeoutMs: 5_000 })
  if (result.status !== 0) return null
  return result.stdout.trim() || null
}

export async function inspectGrok(manifest, runner = runFile, managedState = null, options = {}) {
  const executable = options.executable !== undefined ? options.executable : await resolveExecutable('grok', runner)
  if (executable === null) throw new AgentHostError('GROK_NOT_INSTALLED', 'Grok CLI is not installed or not on PATH')
  const configPath = resolveGrokConfigPath({ ...options, configPath: managedState?.configPath ?? options.configPath })
  const config = await readConfig(configPath)
  const servers = serversByName(config.sections)
  const workspaceRoot = options.workspaceRoot ?? managedState?.workspaceRoot ?? null
  const entries = []
  for (const target of targets(manifest, workspaceRoot)) {
    const aliases = target.aliases.filter((name) => servers.has(name))
    if (aliases.length > 1) throw new AgentHostError('GROK_MCP_CONFLICT', `Grok exposes multiple aliases for ${target.name}`)
    const actualName = aliases[0] ?? target.name
    const section = servers.get(actualName) ?? null
    const parsed = section === null ? null : parseServerSection(section)
    const managed = managedState?.entries?.find((entry) => entry.component === target.name)
    const owned = managed?.created === true
    const identityMatched = parsed !== null && parsed.extra.length === 0 && await sameBinding(parsed.binding, target.binding)
    if (parsed !== null && !identityMatched && !owned && options.replaceConflicts !== true) {
      throw new AgentHostError('GROK_MCP_CONFLICT', `Grok already has an unmanaged MCP server for ${target.name} with a different binding`)
    }
    if (parsed !== null && owned && (parsed.extra.length > 0 || !await sameBinding(parsed.binding, ownedBinding(managed))) && options.replaceConflicts !== true) {
      throw new AgentHostError('GROK_MCP_CHANGED', `Grok binding ${actualName} changed after installation`)
    }
    entries.push({
      component: target.name,
      name: target.name,
      actualName,
      present: parsed !== null,
      owned,
      identityMatched,
      binding: target.binding,
      existingBinding: parsed === null ? null : structuredClone(parsed.binding),
      displacedSection: section === null ? null : [...section.lines],
    })
  }
  return { executable, configPath, version: await versionOf(executable, runner), entries }
}

export async function installGrok(manifest, runner = runFile, managedState = null, options = {}) {
  const inspection = await inspectGrok(manifest, runner, managedState, options)
  const config = await readConfig(inspection.configPath)
  let sections = config.sections
  const installed = []
  for (const entry of inspection.entries) {
    const current = serversByName(sections).get(entry.actualName) ?? null
    const currentText = current === null ? null : current.lines.join('\n')
    const expectedText = entry.displacedSection === null ? null : entry.displacedSection.join('\n')
    if (currentText !== expectedText) throw new AgentHostError('GROK_CONFIG_CHANGED', `Grok configuration changed while preparing ${entry.name}`)
    if (entry.present && entry.identityMatched && !entry.owned) {
      installed.push({ ...entry, created: false, adopted: true, displaced: null })
      continue
    }
    const previous = managedState?.entries?.find((item) => item.component === entry.component)
    const displaced = entry.owned
      ? previous?.displaced ?? null
      : entry.present && !entry.identityMatched
        ? [...entry.displacedSection]
        : previous?.displaced ?? (entry.present ? [...entry.displacedSection] : null)
    sections = replaceServer(sections, entry.name, entry.binding)
    if (entry.actualName !== entry.name) sections = sections.filter((section) => section.header !== `mcp_servers.${entry.actualName}`)
    installed.push({ ...entry, actualName: entry.name, created: true, adopted: false, displaced })
  }
  if (installed.some((entry) => entry.created === true)) await writeConfig(inspection.configPath, sections)
  const verified = await inspectGrok(manifest, runner, {
    configPath: inspection.configPath,
    workspaceRoot: options.workspaceRoot ?? managedState?.workspaceRoot ?? null,
    entries: installed,
  }, { ...options, executable: inspection.executable, replaceConflicts: true })
  if (!verified.entries.every((entry) => entry.present && entry.identityMatched)) {
    if (config.existed) await writeFile(inspection.configPath, config.text).catch(() => {})
    else await rm(inspection.configPath, { force: true }).catch(() => {})
    throw new AgentHostError('GROK_MCP_UNAVAILABLE', 'Grok did not retain the installed MCP bindings')
  }
  return {
    kind: 'grok',
    version: inspection.version,
    configPath: inspection.configPath,
    workspaceRoot: options.workspaceRoot ?? managedState?.workspaceRoot ?? null,
    entries: installed,
    restartRequired: true,
  }
}

async function mutateOwned(hostState, suspend) {
  const configPath = resolveGrokConfigPath({ configPath: hostState.configPath })
  const config = await readConfig(configPath)
  if (!config.existed) {
    if (suspend) throw new AgentHostError('GROK_MCP_CHANGED', 'Grok user configuration is no longer present')
    return { kind: 'grok', [suspend ? 'suspended' : 'removed']: (hostState.entries ?? []).map((entry) => ({ target: entry.actualName ?? entry.name, kind: 'mcp', status: 'preserved-user-change' })) }
  }
  let sections = config.sections
  const results = []
  for (const entry of [...(hostState.entries ?? [])].reverse()) {
    const name = entry.actualName ?? entry.name
    if (entry.created !== true) {
      if (suspend) throw new AgentHostError('TOOL_SET_UNMANAGED_BINDING', `Agent Host cannot hide unmanaged Grok MCP server ${name}`)
      continue
    }
    const servers = serversByName(sections)
    const section = servers.get(name) ?? null
    const intentionallySuspended = (hostState.inactiveEntries ?? []).some((item) => item.component === entry.component)
    if (section === null && (!intentionallySuspended || suspend)) {
      if (suspend) throw new AgentHostError('GROK_MCP_CHANGED', `Grok binding ${name} is no longer present`)
      results.push({ target: name, kind: 'mcp', status: 'preserved-user-change' })
      continue
    }
    if (section !== null) {
      const parsed = parseServerSection(section)
      const matches = parsed.extra.length === 0 && await sameBinding(parsed.binding, ownedBinding(entry))
      if (!matches) {
        if (suspend) throw new AgentHostError('GROK_MCP_CHANGED', `Grok binding ${name} changed after installation`)
        results.push({ target: name, kind: 'mcp', status: 'preserved-user-change' })
        continue
      }
    }
    sections = restoreServer(sections, name, suspend ? null : entry.displaced ?? null)
    results.push({ target: name, kind: entry.displaced && !suspend ? 'restored-mcp' : 'mcp', status: 'ok' })
  }
  await writeConfig(configPath, sections)
  return { kind: 'grok', [suspend ? 'suspended' : 'removed']: results }
}

export async function uninstallGrok(hostState) {
  return mutateOwned(hostState, false)
}

export async function suspendGrok(hostState) {
  return mutateOwned(hostState, true)
}
