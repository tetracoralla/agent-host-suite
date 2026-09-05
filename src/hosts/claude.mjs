import { AgentHostError } from '../errors.mjs'
import { resolveExecutable, runFile } from '../process.mjs'
import { realpath } from 'node:fs/promises'
import { componentEnvironment } from '../component-environment.mjs'

export const CLAUDE_USER_CONFIG_ARGUMENTS = Object.freeze([
  '--disable-slash-commands',
  '--no-chrome',
  '--setting-sources', 'user',
])

function userConfigArguments(...args) {
  return [...CLAUDE_USER_CONFIG_ARGUMENTS, ...args]
}

function sameEnvironment(left, right) {
  const leftEntries = Object.entries(left ?? {}).sort(([a], [b]) => a.localeCompare(b))
  const rightEntries = Object.entries(right ?? {}).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries)
}

function targets(manifest, workspaceRoot) {
  return Object.entries(manifest.components ?? {})
    .filter(([, component]) => component.skillOnly !== true && typeof component.command === 'string' && Array.isArray(component.args))
    .map(([name, component]) => {
      const variables = component.workspaceEnvironment ?? []
      if (variables.length > 0 && workspaceRoot === null) {
        throw new AgentHostError('WORKSPACE_GRANT_REQUIRED', `${component.displayName ?? name} requires --workspace-root so Claude Code can grant its deterministic tools an explicit local workspace`, {
          component: name,
          variables,
        })
      }
      return {
        name,
        aliases: [...new Set([name, name.replaceAll('-', '_')])],
        component,
        environment: componentEnvironment(component, workspaceRoot),
      }
    })
}

function parseEntry(name, output, expectedArgumentSets = []) {
  const command = output.match(/^[ \t]*Command:[ \t]*(.*?)[ \t]*\r?$/mu)?.[1]
  const argsText = output.match(/^[ \t]*Args:[ \t]*(.*?)[ \t]*\r?$/mu)?.[1] ?? ''
  if (command === undefined) throw new AgentHostError('CLAUDE_MCP_PROTOCOL_INVALID', `Claude Code did not report the command for ${name}`)
  const exact = expectedArgumentSets.find((candidate) => Array.isArray(candidate) && argsText === candidate.join(' '))
  const args = exact !== undefined
    ? [...exact]
    : argsText === '' ? [] : argsText.split(/\s+/u)
  // Claude Code renders arguments space-joined without quoting, so a non-exact
  // Args line cannot be split back into the original argv faithfully.
  const environment = {}
  // Keep the match line-bounded. `\s` also consumes newlines, which allowed a
  // blank separator to pull Claude's following unindented help text into the
  // environment block.
  const environmentBlock = output.match(/^[ \t]*Environment:[ \t]*\r?\n((?:[ \t]+[^\r\n]+(?:\r?\n|$))*)/mu)?.[1] ?? ''
  for (const line of environmentBlock.split('\n')) {
    const entry = line.trim()
    if (entry.length === 0) continue
    const separator = entry.indexOf('=')
    if (separator <= 0) throw new AgentHostError('CLAUDE_MCP_PROTOCOL_INVALID', `Claude Code reported an invalid environment entry for ${name}`)
    environment[entry.slice(0, separator)] = entry.slice(separator + 1)
  }
  return { actualName: name, command, args, argsText, argsExact: exact !== undefined, environment }
}

async function existingAliases(executable, target, runner, managedEntry = null) {
  const values = []
  for (const alias of target.aliases) {
    const result = await runner(executable, userConfigArguments('mcp', 'get', alias), { allowFailure: true, timeoutMs: 8_000 })
    if (result.status === 0) {
      values.push(parseEntry(alias, result.stdout, [target.component.args, managedEntry?.args]))
      continue
    }
    const output = `${result.stdout}\n${result.stderr}`
    if (!output.includes(`No MCP server named "${alias}"`)) {
      throw new AgentHostError('CLAUDE_MCP_INSPECTION_FAILED', `Claude Code could not inspect the MCP server ${alias}`)
    }
  }
  if (values.length > 1) throw new AgentHostError('CLAUDE_MCP_CONFLICT', `Claude Code exposes multiple aliases for ${target.name}`)
  return values[0] ?? null
}

async function sameBinding(existing, target) {
  try {
    const [existingCommand, requestedCommand] = await Promise.all([realpath(existing.command), realpath(target.component.command)])
    return existingCommand === requestedCommand
      && existing.args.length === target.component.args.length
      && existing.args.every((value, index) => value === target.component.args[index])
      && sameEnvironment(existing.environment, target.environment)
  } catch {
    return false
  }
}

export async function inspectClaude(manifest, runner = runFile, managedState = null, options = {}) {
  const executable = await resolveExecutable('claude', runner)
  if (executable === null) throw new AgentHostError('CLAUDE_NOT_INSTALLED', 'Claude Code is not installed or not on PATH')
  const versionResult = await runner(executable, userConfigArguments('--version'))
  const entries = []
  for (const target of targets(manifest, options.workspaceRoot ?? managedState?.workspaceRoot ?? null)) {
    const managedEntry = managedState?.entries?.find((entry) => entry.component === target.name)
    const existing = await existingAliases(executable, target, runner, managedEntry)
    const owned = managedEntry?.created === true
    const identityMatched = existing === null ? false : await sameBinding(existing, target)
    if (existing !== null && !identityMatched && !owned && options.replaceConflicts !== true) {
      throw new AgentHostError('CLAUDE_MCP_CONFLICT', `Claude Code already has an unmanaged MCP server for ${target.name} with different command or arguments`)
    }
    entries.push({
      name: target.name,
      component: target.name,
      actualName: existing?.actualName ?? target.name,
      present: existing !== null,
      owned,
      identityMatched,
      command: target.component.command,
      args: target.component.args,
      environment: target.environment,
      existingBinding: existing,
    })
  }
  return { executable, version: versionResult.stdout.trim(), entries }
}

export async function installClaude(manifest, runner = runFile, managedState = null, options = {}) {
  const inspection = await inspectClaude(manifest, runner, managedState, options)
  const installed = []
  for (const entry of inspection.entries) {
    if (entry.present && entry.identityMatched && !entry.owned) {
      installed.push({ ...entry, created: false, adopted: true })
      continue
    }
    let displaced = null
    if (entry.present) {
      if (!entry.owned) displaced = {
        name: entry.actualName,
        command: entry.existingBinding.command,
        args: entry.existingBinding.args,
        argsText: entry.existingBinding.argsText,
        argsExact: entry.existingBinding.argsExact,
        environment: entry.existingBinding.environment,
        identityMatched: entry.identityMatched,
      }
      await runner(inspection.executable, userConfigArguments('mcp', 'remove', '--scope', 'user', entry.actualName))
    }
    try {
      await runner(inspection.executable, userConfigArguments(
        'mcp', 'add', '--scope', 'user', entry.name,
        ...Object.entries(entry.environment).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
        '--', entry.command, ...entry.args,
      ))
    } catch (error) {
      if (entry.present) {
        await runner(inspection.executable, userConfigArguments(
          'mcp', 'add', '--scope', 'user', entry.actualName,
          ...Object.entries(entry.existingBinding.environment).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
          '--', entry.existingBinding.command, ...entry.existingBinding.args,
        ), { allowFailure: true })
      }
      throw error
    }
    installed.push({ ...entry, actualName: entry.name, created: true, adopted: false, displaced })
  }
  return {
    kind: 'claude',
    version: inspection.version,
    workspaceRoot: options.workspaceRoot ?? managedState?.workspaceRoot ?? null,
    entries: installed,
    restartRequired: true,
  }
}

export async function uninstallClaude(hostState, runner = runFile) {
  const executable = await resolveExecutable('claude', runner)
  if (executable === null) return { kind: 'claude', unavailable: true, removed: [] }
  const removed = []
  for (const entry of [...hostState.entries].reverse()) {
    if (entry.created) {
      const result = await runner(executable, userConfigArguments('mcp', 'remove', '--scope', 'user', entry.actualName), { allowFailure: true })
      removed.push({ target: entry.actualName, kind: 'mcp', status: result.status })
    }
    if (entry.displaced !== null && entry.displaced !== undefined) {
      const displaced = entry.displaced
      const result = await runner(executable, userConfigArguments(
        'mcp', 'add', '--scope', 'user', displaced.name,
        ...Object.entries(displaced.environment ?? {}).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
        '--', displaced.command, ...displaced.args,
      ), { allowFailure: true })
      removed.push({
        target: displaced.name,
        kind: 'restored-mcp',
        status: result.status,
        // A restored binding whose Args line could not be mapped back to exact
        // argv may need manual correction; the original rendering is retained.
        ...(displaced.argsExact === false ? { argsExact: false, originalArgs: displaced.argsText } : {}),
      })
    }
  }
  return { kind: 'claude', removed }
}

export async function suspendClaude(hostState, runner = runFile) {
  const executable = await resolveExecutable('claude', runner)
  if (executable === null) throw new AgentHostError('CLAUDE_NOT_INSTALLED', 'Claude Code is not installed or not on PATH')
  const removed = []
  for (const entry of [...hostState.entries].reverse()) {
    if (entry.created !== true) {
      throw new AgentHostError('TOOL_SET_UNMANAGED_BINDING', `Agent Host cannot hide unmanaged Claude Code MCP server ${entry.actualName} without changing user-owned configuration`)
    }
    await runner(executable, userConfigArguments('mcp', 'remove', '--scope', 'user', entry.actualName))
    removed.push({ target: entry.actualName, kind: 'mcp' })
  }
  return { kind: 'claude', suspended: removed }
}
