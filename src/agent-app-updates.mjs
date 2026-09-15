import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { platform } from 'node:os'
import { runFile } from './process.mjs'

const APPS = [
  {
    id: 'zcode',
    name: 'ZCode',
    darwin: ['/Applications/ZCode.app'],
    versionPlist: 'Contents/Info.plist',
    upgradeCommand: null,
    upgrade: 'Use ZCode’s in-app update or reinstall from its official download. Agent Host does not redistribute ZCode.',
  },
  {
    id: 'codex',
    name: 'Codex',
    commands: ['codex'],
    versionArguments: ['--version'],
    upgradeCommand: 'npm',
    upgradeArguments: ['update', '-g', '@openai/codex'],
    upgrade: 'Update Codex with the same installer or package manager that placed it on this machine. Agent Host does not redistribute Codex.',
  },
  {
    id: 'claude',
    name: 'Claude Code',
    commands: ['claude'],
    versionArguments: ['--version'],
    upgradeCommand: 'claude',
    upgradeArguments: ['update'],
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

function parseVersion(text) {
  if (typeof text !== 'string') return null
  const match = text.match(/\b(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)\b/u)
  return match === null ? null : match[1]
}

async function readPlistVersion(appRoot) {
  const plist = join(appRoot, 'Contents/Info.plist')
  try {
    const text = await readFile(plist, 'utf8')
    const match = text.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/u)
    return match === null ? null : match[1]
  } catch {
    return null
  }
}

async function readCommandVersion(command, args, runner) {
  try {
    const result = await runner(command, args, {
      allowFailure: true,
      timeoutMs: 8000,
      maxBuffer: 16 * 1024,
    })
    if (result.status !== 0) {
      return { version: null, error: result.stderr?.slice(0, 240) || `version command exited ${result.status}` }
    }
    return { version: parseVersion(result.stdout) ?? parseVersion(result.stderr), error: null }
  } catch (error) {
    return { version: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function sourceKind({ installedPath, onPath, whichPath }) {
  if (typeof whichPath === 'string' && /homebrew|\/opt\/homebrew\/|\/usr\/local\/Cellar\//u.test(whichPath)) return 'homebrew'
  if (typeof whichPath === 'string' && /npm|nvm|\.nvm|fnm/u.test(whichPath)) return 'npm-global'
  if (typeof installedPath === 'string' && installedPath.startsWith('/Applications/')) return 'macos-application'
  if (onPath === true) return 'path-command'
  if (installedPath !== null) return 'official-distribution'
  return null
}

export async function inspectAgentAppUpdates({ runner = runFile } = {}) {
  const items = []
  for (const app of APPS) {
    const installedPath = platform() === 'darwin' ? await appExists(app.darwin) : null
    const onPath = app.commands === undefined ? false : await commandExists(app.commands[0], runner)
    let whichPath = null
    if (onPath === true && app.commands !== undefined) {
      try {
        const located = await runner(process.platform === 'win32' ? 'where.exe' : '/usr/bin/which', [app.commands[0]], {
          allowFailure: true, timeoutMs: 5000, maxBuffer: 4096,
        })
        whichPath = located.status === 0 ? located.stdout.trim().split(/\r?\n/u)[0] : null
      } catch {
        whichPath = null
      }
    }
    let installedVersion = null
    let versionError = null
    if (installedPath !== null) {
      installedVersion = await readPlistVersion(installedPath)
    }
    if (installedVersion === null && onPath === true && app.versionArguments !== undefined) {
      const read = await readCommandVersion(app.commands[0], app.versionArguments, runner)
      installedVersion = read.version
      versionError = read.error
    }
    const installed = installedPath !== null || onPath === true
    const source = sourceKind({ installedPath, onPath, whichPath })
    let availability = 'not-installed'
    if (installed !== true) availability = 'not-installed'
    else if (installedVersion === null) availability = 'installed-version-unreadable'
    else availability = 'installed-official-upgrade'
    items.push({
      kind: 'agent-app',
      id: app.id,
      displayName: app.name,
      installedVersion,
      availableVersion: null,
      availability,
      installPath: installedPath,
      onPath,
      commandPath: whichPath,
      source,
      action: installed === true ? 'open-official-upgrade' : 'install-from-official-distribution',
      upgradeCommand: app.upgradeCommand === null ? null : {
        command: app.upgradeCommand,
        arguments: app.upgradeArguments ?? [],
      },
      upgrade: app.upgrade,
      versionError,
      note: installed === true
        ? 'Agent Host reads the installed version from the official binary or application bundle. It does not redistribute this Agent app or query a Host-owned latest version for it.'
        : 'This Agent app is not installed. Install it from its official distribution; GitHub catalog data cannot install it.',
    })
  }
  return items
}
