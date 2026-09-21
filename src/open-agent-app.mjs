import { access, stat } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { AgentHostError } from './errors.mjs'
import { resolveExecutable, startDetachedProcess } from './process.mjs'
import { resolveZcodeExecutable } from './hosts/zcode.mjs'

export const AGENT_APP_SPECS = Object.freeze({
  zcode: Object.freeze({
    id: 'zcode',
    name: 'ZCode',
    bundleIds: Object.freeze(['com.zcode.app']),
    appNames: Object.freeze(['ZCode']),
  }),
  codex: Object.freeze({
    id: 'codex',
    name: 'Codex',
    bundleIds: Object.freeze(['com.openai.codex', 'com.openai.chat']),
    appNames: Object.freeze(['Codex', 'ChatGPT']),
  }),
  claude: Object.freeze({
    id: 'claude',
    name: 'Claude Code',
    bundleIds: Object.freeze(['com.anthropic.claudecode', 'com.anthropic.claude']),
    appNames: Object.freeze(['Claude Code', 'Claude']),
  }),
})

const LINUX_TERMINALS = Object.freeze([
  { id: 'xfce4-terminal', names: ['xfce4-terminal'], buildArgs: (cli, name) => ['--disable-server', '--title', name, '-x', cli] },
  { id: 'gnome-terminal', names: ['gnome-terminal'], buildArgs: (cli, name) => ['--title', name, '--', cli], acceptCleanExit: true },
  { id: 'konsole', names: ['konsole'], buildArgs: (cli, name) => ['--separate', '-p', `tabtitle=${name}`, '-e', cli] },
  { id: 'xterm', names: ['xterm'], buildArgs: (cli, name) => ['-T', name, '-e', cli] },
  { id: 'x-terminal-emulator', names: ['x-terminal-emulator'], buildArgs: (cli) => ['-e', cli], acceptCleanExit: true },
])

async function pathExists(path, exists) {
  if (typeof exists === 'function') return exists(path)
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function directoryExists(path, exists) {
  if (typeof exists === 'function') return exists(path)
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function defaultFindCommand(name, runner) {
  return resolveExecutable(name, runner)
}

async function defaultResolveCli(hostId, runner) {
  if (hostId === 'zcode') return resolveZcodeExecutable(runner)
  return resolveExecutable(hostId, runner)
}

function failUnavailable(spec, executable, extra = {}) {
  const command = executable || spec.id
  throw new AgentHostError(
    'AGENT_APP_OPEN_UNAVAILABLE',
    `${spec.name} has no usable window on this machine. Open a terminal and run: ${command}`,
    {
      host: spec.id,
      executable: executable ?? null,
      nextStep: `Open a terminal and run: ${command}`,
      kind: executable ? 'cli-needs-terminal' : 'not-launchable',
      ...extra,
    },
  )
}

async function resolveGuiLaunch(spec, options) {
  const platformName = options.platform ?? platform()
  const home = options.home ?? homedir()
  const exists = options.exists
  if (platformName === 'darwin') {
    const candidates = spec.appNames.flatMap((name) => [
      `/Applications/${name}.app`,
      join(home, 'Applications', `${name}.app`),
    ])
    for (const appPath of candidates) {
      if (await directoryExists(appPath, exists)) {
        return {
          method: 'gui',
          command: '/usr/bin/open',
          args: ['-a', appPath],
          launched: appPath,
          acceptCleanExit: true,
        }
      }
    }
    const bundlePaths = options.bundlePaths ?? {}
    for (const bundleId of spec.bundleIds) {
      const mapped = bundlePaths[bundleId]
      if (typeof mapped === 'string' && mapped.length > 0) {
        return {
          method: 'gui',
          command: '/usr/bin/open',
          args: ['-b', bundleId],
          launched: mapped,
          acceptCleanExit: true,
        }
      }
    }
    return null
  }
  if (platformName === 'win32') {
    const localAppData = options.env?.LOCALAPPDATA ?? process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Roaming', '..', 'Local')
    const candidates = spec.appNames.flatMap((name) => [
      join(localAppData, 'Programs', name, `${name}.exe`),
      join(home, 'AppData', 'Local', 'Programs', name, `${name}.exe`),
    ])
    for (const exePath of candidates) {
      if (await pathExists(exePath, exists)) {
        return {
          method: 'gui',
          command: exePath,
          args: [],
          launched: exePath,
          windowsHide: false,
          acceptCleanExit: true,
        }
      }
    }
    return null
  }
  const desktopDirs = [
    join(home, '.local', 'share', 'applications'),
    '/usr/local/share/applications',
    '/usr/share/applications',
  ]
  const desktopNames = spec.appNames.map((name) => `${name.toLowerCase().replace(/\s+/gu, '-')}.desktop`)
  for (const directory of desktopDirs) {
    for (const desktopName of desktopNames) {
      const desktopPath = join(directory, desktopName)
      if (await pathExists(desktopPath, exists)) {
        return {
          method: 'gui',
          command: 'xdg-open',
          args: [desktopPath],
          launched: desktopPath,
          acceptCleanExit: true,
        }
      }
    }
  }
  return null
}

async function resolveTerminalLaunch(spec, executable, options) {
  const platformName = options.platform ?? platform()
  const findCommand = options.findCommand ?? ((name) => defaultFindCommand(name, options.runner))
  if (platformName === 'darwin') {
    const osascript = await findCommand('osascript') ?? '/usr/bin/osascript'
    if (!await pathExists(osascript, options.exists) && osascript !== '/usr/bin/osascript') return null
    const pathLiteral = String(executable).replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')
    return {
      method: 'terminal',
      command: osascript,
      args: [
        '-e', 'tell application "Terminal"',
        '-e', 'activate',
        '-e', `do script "exec " & quoted form of "${pathLiteral}"`,
        '-e', 'end tell',
      ],
      launched: executable,
      terminal: 'Terminal',
      acceptCleanExit: true,
    }
  }
  if (platformName === 'win32') {
    const comSpec = options.env?.ComSpec ?? process.env.ComSpec ?? 'cmd.exe'
    const wt = await findCommand('wt.exe')
    if (wt) {
      return {
        method: 'terminal',
        command: wt,
        args: ['new-tab', '--title', spec.name, executable],
        launched: executable,
        terminal: 'Windows Terminal',
        windowsHide: false,
        acceptCleanExit: true,
      }
    }
    return {
      method: 'terminal',
      command: comSpec,
      args: ['/d', '/s', '/c', 'start', spec.name, executable],
      launched: executable,
      terminal: 'cmd',
      windowsHide: false,
      acceptCleanExit: true,
    }
  }
  for (const terminal of LINUX_TERMINALS) {
    let command = null
    for (const name of terminal.names) {
      command = await findCommand(name)
      if (command) break
    }
    if (!command) continue
    return {
      method: 'terminal',
      command,
      args: terminal.buildArgs(executable, spec.name),
      launched: executable,
      terminal: terminal.id,
      acceptCleanExit: terminal.acceptCleanExit === true,
    }
  }
  return null
}

export async function resolveAgentAppLaunch(hostId, options = {}) {
  const spec = AGENT_APP_SPECS[hostId]
  if (spec === undefined) {
    throw new AgentHostError('MANAGER_REQUEST_INVALID', 'Choose a supported Agent app to open')
  }
  const resolveCli = options.resolveCli ?? ((id) => defaultResolveCli(id, options.runner))
  const gui = await resolveGuiLaunch(spec, options)
  if (gui) return { spec, ...gui }
  const cli = await resolveCli(hostId)
  if (typeof cli !== 'string' || cli.length === 0) {
    throw new AgentHostError('MANAGER_REQUEST_INVALID', 'That Agent app is not installed on this machine')
  }
  const terminal = await resolveTerminalLaunch(spec, cli, options)
  if (terminal) return { spec, ...terminal }
  failUnavailable(spec, cli)
}

async function runLaunch(hostId, launch, options) {
  const start = options.start ?? startDetachedProcess
  const started = await start(launch.command, launch.args, {
    confirmMs: options.confirmMs ?? 1_500,
    cwd: options.cwd,
    env: options.env,
    windowsHide: launch.windowsHide ?? false,
    acceptCleanExit: launch.acceptCleanExit === true,
  })
  return {
    status: 'opened',
    host: hostId,
    method: launch.method,
    launched: launch.launched,
    ...(launch.terminal === undefined ? {} : { terminal: launch.terminal }),
    pid: started?.pid ?? null,
  }
}

export async function openAgentApp(hostId, options = {}) {
  const spec = AGENT_APP_SPECS[hostId]
  if (spec === undefined) {
    throw new AgentHostError('MANAGER_REQUEST_INVALID', 'Choose a supported Agent app to open')
  }
  const resolveCli = options.resolveCli ?? ((id) => defaultResolveCli(id, options.runner))
  const gui = await resolveGuiLaunch(spec, options)
  if (gui) {
    try {
      return await runLaunch(hostId, { spec, ...gui }, options)
    } catch {
      // GUI handoff failed; a visible terminal is the remaining honest path.
    }
  }
  const cli = await resolveCli(hostId)
  if (typeof cli !== 'string' || cli.length === 0) {
    if (gui) failUnavailable(spec, null, { kind: 'gui-failed' })
    throw new AgentHostError('MANAGER_REQUEST_INVALID', 'That Agent app is not installed on this machine')
  }
  const terminal = await resolveTerminalLaunch(spec, cli, options)
  if (terminal) {
    try {
      return await runLaunch(hostId, { spec, ...terminal }, options)
    } catch (error) {
      failUnavailable(spec, cli, {
        causeCode: error instanceof AgentHostError ? error.code : 'HOST_COMMAND_FAILED',
        cause: error instanceof Error ? error.message : String(error),
      })
    }
  }
  failUnavailable(spec, cli)
}
