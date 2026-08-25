import { AgentHostError } from '../errors.mjs'
import { resolveExecutable, runFile } from '../process.mjs'
import { realpath } from 'node:fs/promises'

function targets(manifest) {
  return [
    { name: 'math-anchor', aliases: ['math-anchor', 'math_anchor'], component: manifest.components['math-anchor'] },
    { name: 'migratory-time', aliases: ['migratory-time', 'migratory_time'], component: manifest.components['migratory-time'] },
  ]
}

function parseEntry(name, output) {
  const command = output.match(/^\s*Command:\s*(.+?)\s*$/mu)?.[1]
  const argsText = output.match(/^\s*Args:\s*(.*?)\s*$/mu)?.[1] ?? ''
  if (command === undefined) throw new AgentHostError('CLAUDE_MCP_PROTOCOL_INVALID', `Claude Code did not report the command for ${name}`)
  return { actualName: name, command, args: argsText === '' ? [] : argsText.split(/\s+/u) }
}

async function existingAliases(executable, target, runner) {
  const values = []
  for (const alias of target.aliases) {
    const result = await runner(executable, ['mcp', 'get', alias], { allowFailure: true, timeoutMs: 8_000 })
    if (result.status === 0) values.push(parseEntry(alias, result.stdout))
  }
  if (values.length > 1) throw new AgentHostError('CLAUDE_MCP_CONFLICT', `Claude Code exposes multiple aliases for ${target.name}`)
  return values[0] ?? null
}

async function sameBinding(existing, target) {
  let existingCommand = existing.command
  let requestedCommand = target.component.command
  try {
    [existingCommand, requestedCommand] = await Promise.all([realpath(existing.command), realpath(target.component.command)])
  } catch {}
  return existingCommand === requestedCommand
    && existing.args.length === target.component.args.length
    && existing.args.every((value, index) => value === target.component.args[index])
}

export async function inspectClaude(manifest, runner = runFile, managedState = null, options = {}) {
  const executable = await resolveExecutable('claude', runner)
  if (executable === null) throw new AgentHostError('CLAUDE_NOT_INSTALLED', 'Claude Code is not installed or not on PATH')
  const versionResult = await runner(executable, ['--version'])
  const entries = []
  for (const target of targets(manifest)) {
    const existing = await existingAliases(executable, target, runner)
    const managedEntry = managedState?.entries?.find((entry) => entry.component === target.name)
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
    await runner(inspection.executable, [
      'mcp', 'add', '--scope', 'user', entry.name, '--', entry.command, ...entry.args,
    ])
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
