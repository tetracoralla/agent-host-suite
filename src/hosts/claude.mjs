import { AgentHostError } from '../errors.mjs'
import { resolveExecutable, runFile } from '../process.mjs'
import { realpath } from 'node:fs/promises'

function targets(manifest) {
  return [
    { name: 'math-anchor', aliases: ['math-anchor', 'math_anchor'], component: manifest.components['math-anchor'] },
    { name: 'migratory-time', aliases: ['migratory-time', 'migratory_time'], component: manifest.components['migratory-time'] },
  ].filter((target) => target.component !== undefined)
}

function parseEntry(name, output, expectedArgumentSets = []) {
  const command = output.match(/^\s*Command:\s*(.+?)\s*$/mu)?.[1]
  const argsText = output.match(/^\s*Args:\s*(.*?)\s*$/mu)?.[1] ?? ''
  if (command === undefined) throw new AgentHostError('CLAUDE_MCP_PROTOCOL_INVALID', `Claude Code did not report the command for ${name}`)
  const exact = expectedArgumentSets.find((candidate) => Array.isArray(candidate) && argsText === candidate.join(' '))
  const args = exact !== undefined
    ? [...exact]
    : argsText === '' ? [] : argsText.split(/\s+/u)
  return { actualName: name, command, args }
}

async function existingAliases(executable, target, runner, managedEntry = null) {
  const values = []
  for (const alias of target.aliases) {
    const result = await runner(executable, ['mcp', 'get', alias], { allowFailure: true, timeoutMs: 8_000 })
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
  } catch {
    return false
  }
}

export async function inspectClaude(manifest, runner = runFile, managedState = null, options = {}) {
  const executable = await resolveExecutable('claude', runner)
  if (executable === null) throw new AgentHostError('CLAUDE_NOT_INSTALLED', 'Claude Code is not installed or not on PATH')
  const versionResult = await runner(executable, ['--version'])
  const entries = []
  for (const target of targets(manifest)) {
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
      if (!entry.owned) displaced = { name: entry.actualName, command: entry.existingBinding.command, args: entry.existingBinding.args, identityMatched: entry.identityMatched }
      await runner(inspection.executable, ['mcp', 'remove', '--scope', 'user', entry.actualName])
    }
    try {
      await runner(inspection.executable, [
        'mcp', 'add', '--scope', 'user', entry.name, '--', entry.command, ...entry.args,
      ])
    } catch (error) {
      if (entry.present) {
        await runner(inspection.executable, [
          'mcp', 'add', '--scope', 'user', entry.actualName, '--', entry.existingBinding.command, ...entry.existingBinding.args,
        ], { allowFailure: true })
      }
      throw error
    }
    installed.push({ ...entry, actualName: entry.name, created: true, adopted: false, displaced })
  }
  return { kind: 'claude', version: inspection.version, entries: installed, restartRequired: true }
}

export async function uninstallClaude(hostState, runner = runFile) {
  const executable = await resolveExecutable('claude', runner)
  if (executable === null) return { kind: 'claude', unavailable: true, removed: [] }
  const removed = []
  for (const entry of [...hostState.entries].reverse()) {
    if (entry.created) {
      const result = await runner(executable, ['mcp', 'remove', '--scope', 'user', entry.actualName], { allowFailure: true })
      removed.push({ target: entry.actualName, kind: 'mcp', status: result.status })
    }
    if (entry.displaced !== null && entry.displaced !== undefined) {
      const displaced = entry.displaced
      const result = await runner(executable, ['mcp', 'add', '--scope', 'user', displaced.name, '--', displaced.command, ...displaced.args], { allowFailure: true })
      removed.push({ target: displaced.name, kind: 'restored-mcp', status: result.status })
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
    await runner(executable, ['mcp', 'remove', '--scope', 'user', entry.actualName])
    removed.push({ target: entry.actualName, kind: 'mcp' })
  }
  return { kind: 'claude', suspended: removed }
}
