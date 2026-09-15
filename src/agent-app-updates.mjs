import { access } from 'node:fs/promises'
import { platform } from 'node:os'
import { runFile } from './process.mjs'

const APPS = [
  {
    id: 'zcode',
    name: 'ZCode',
    darwin: ['/Applications/ZCode.app'],
    upgrade: 'Use ZCode’s in-app update or reinstall from its official download. Agent Host does not redistribute ZCode.',
  },
  {
    id: 'codex',
    name: 'Codex',
    commands: ['codex'],
    upgrade: 'Update Codex with the same installer or package manager that placed it on this machine. Agent Host does not redistribute Codex.',
  },
  {
    id: 'claude',
    name: 'Claude Code',
    commands: ['claude'],
    upgrade: 'Update Claude Code with its official installer or package manager. Agent Host does not redistribute Claude Code.',
  },
]

async function commandExists(name, runner) {
  try {
    const result = await runner(process.platform === 'win32' ? 'where.exe' : '/usr/bin/which', [name], {
      allowFailure: true,
      timeoutMs: 5000,
      maxBuffer: 4096,
    })
    return result.status === 0
  } catch {
    return false
  }
}

async function appExists(paths) {
  for (const path of paths ?? []) {
    try {
      await access(path)
      return path
    } catch {
      continue
    }
  }
  return null
}

export async function inspectAgentAppUpdates({ runner = runFile } = {}) {
  const items = []
  for (const app of APPS) {
    const installedPath = platform() === 'darwin' ? await appExists(app.darwin) : null
    const onPath = app.commands === undefined ? false : await commandExists(app.commands[0], runner)
    items.push({
      kind: 'agent-app',
      id: app.id,
      displayName: app.name,
      availability: installedPath !== null || onPath === true ? 'installed-official-upgrade' : 'not-installed',
      installPath: installedPath,
      onPath,
      source: installedPath !== null || onPath === true ? 'official-distribution' : null,
      action: 'open-official-upgrade',
      upgrade: app.upgrade,
      note: 'Closed-source Agent apps are version-managed through their official distribution. GitHub catalog data cannot install them or run commands.',
    })
  }
  return items
}
