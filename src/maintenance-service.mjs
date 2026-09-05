import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { homedir, platform } from 'node:os'
import { requireApplicationCarrier } from './application-carrier.mjs'
import { runFile } from './process.mjs'

export const MAINTENANCE_LABEL = 'io.github.tetracoralla.agent-host-suite.maintenance'
export const WINDOWS_MAINTENANCE_TASK = '\\openAdam\\AgentHostMaintenance'

function xml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export function maintenancePlist(stateRoot, carrier) {
  const executableDirectory = dirname(carrier.executable)
  const servicePath = [executableDirectory, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
    .filter((value, index, values) => values.indexOf(value) === index).join(':')
  const command = [carrier.executable, ...(carrier.prefixArguments ?? [])]
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${MAINTENANCE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    ${command.map((value) => `<string>${xml(value)}</string>`).join('\n    ')}
    <string>maintenance</string>
    <string>--state-root</string><string>${xml(stateRoot)}</string>
    <string>--json</string>
  </array>
  <key>StartInterval</key><integer>604800</integer>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(servicePath)}</string></dict>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict>
</plist>
`
}

export function maintenancePlistPath() {
  return join(homedir(), 'Library', 'LaunchAgents', `${MAINTENANCE_LABEL}.plist`)
}

function batchQuote(value) {
  const text = String(value)
  if (/[\u0000\r\n"]/u.test(text)) throw new Error('The Windows maintenance command contains unsupported characters')
  return `"${text.replaceAll('%', '%%')}"`
}

export function maintenanceBatch(stateRoot, carrier) {
  return `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${[
    carrier.executable, ...(carrier.prefixArguments ?? []), 'maintenance', '--state-root', stateRoot, '--json',
  ].map(batchQuote).join(' ')} >NUL 2>NUL\r\n`
}

export async function installMaintenance(stateRoot, runner = runFile, dependencies = {}) {
  const carrier = await requireApplicationCarrier({
    carrier: dependencies.applicationCarrier,
    resolver: dependencies.resolveApplicationCarrier,
  })
  if (platform() === 'win32') {
    const path = join(stateRoot, 'runtime', 'maintenance.cmd')
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.tmp-${process.pid}`
    const descriptor = await open(temporary, 'wx', 0o600)
    try {
      await descriptor.writeFile(maintenanceBatch(stateRoot, carrier))
      await descriptor.sync()
    } finally {
      await descriptor.close()
    }
    const current = await lstat(path).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (current !== null && (current.isSymbolicLink() || !current.isFile())) {
      await rm(temporary, { force: true })
      throw new Error('The Windows maintenance launcher is not a regular file')
    }
    if (current !== null) await rm(path, { force: true })
    await rename(temporary, path)
    await runner('schtasks.exe', [
      '/Create', '/TN', WINDOWS_MAINTENANCE_TASK, '/SC', 'WEEKLY', '/D', 'SUN', '/ST', '03:00',
      '/RL', 'LIMITED', '/TR', `"${path}"`, '/F',
    ], { timeoutMs: 15_000 })
    return { kind: 'windows-scheduled-task', label: WINDOWS_MAINTENANCE_TASK, taskName: WINDOWS_MAINTENANCE_TASK, launcherPath: path, created: true, intervalSeconds: 604800 }
  }
  if (platform() !== 'darwin') throw new Error('The current maintenance service implementation supports macOS only')
  const path = maintenancePlistPath()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}`
  const descriptor = await open(temporary, 'wx', 0o600)
  try {
    await descriptor.writeFile(maintenancePlist(stateRoot, carrier))
    await descriptor.sync()
  } finally {
    await descriptor.close()
  }
  await chmod(temporary, 0o600)
  await rename(temporary, path)
  const domain = `gui/${process.getuid()}`
  await runner('/bin/launchctl', ['bootout', domain, path], { allowFailure: true })
  await runner('/bin/launchctl', ['bootstrap', domain, path])
  return { label: MAINTENANCE_LABEL, plistPath: path, created: true, intervalSeconds: 604800 }
}

function decodeXml(value) {
  return value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
}

function plistProgramArguments(contents) {
  const block = contents.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u)?.[1]
  if (block === undefined) return null
  return [...block.matchAll(/<string>([\s\S]*?)<\/string>/gu)].map((match) => decodeXml(match[1]))
}

function contained(root, candidate) {
  const resolvedRoot = resolve(root)
  const resolvedCandidate = resolve(candidate)
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)
}

export async function inspectMaintenance(stateRoot, state, dependencies = {}) {
  if (state === undefined || state === null) return { ready: false, reason: 'not-configured' }
  const platformName = dependencies.platformName ?? platform()
  const carrier = await requireApplicationCarrier({
    carrier: dependencies.applicationCarrier,
    resolver: dependencies.resolveApplicationCarrier,
  })
  if (platformName === 'win32') {
    if (typeof state.launcherPath !== 'string') return { ready: false, reason: 'launcher-unrecorded', carrier: carrier.kind }
    try {
      const info = await lstat(state.launcherPath)
      if (info.isSymbolicLink() || !info.isFile()) return { ready: false, reason: 'launcher-unsafe', carrier: carrier.kind }
      const contents = await readFile(state.launcherPath, 'utf8')
      const ready = contents === maintenanceBatch(stateRoot, carrier)
      return { ready, reason: ready ? null : 'application-command-mismatch', carrier: carrier.kind }
    } catch (error) {
      return { ready: false, reason: error.code === 'ENOENT' ? 'launcher-missing' : 'launcher-unreadable', carrier: carrier.kind }
    }
  }
  if (platformName !== 'darwin') return { ready: false, reason: 'platform-unsupported', carrier: carrier.kind }
  if (typeof state.plistPath !== 'string') return { ready: false, reason: 'launcher-unrecorded', carrier: carrier.kind }
  try {
    const info = await lstat(state.plistPath)
    if (info.isSymbolicLink() || !info.isFile()) return { ready: false, reason: 'launcher-unsafe', carrier: carrier.kind }
    const contents = await readFile(state.plistPath, 'utf8')
    const actual = plistProgramArguments(contents)
    const expected = [
      carrier.executable,
      ...(carrier.prefixArguments ?? []),
      'maintenance', '--state-root', stateRoot, '--json',
    ]
    const applicationShim = JSON.stringify(actual) === JSON.stringify(expected)
    const installedCli = Array.isArray(actual)
      && actual.length === 6
      && contained(join(stateRoot, 'packages', 'node-runtime'), actual[0])
      && actual[1] === join(carrier.root, 'Contents', 'Resources', 'agent-host-suite', 'bin', 'agent-host.mjs')
      && JSON.stringify(actual.slice(2)) === JSON.stringify(['maintenance', '--state-root', stateRoot, '--json'])
    const ready = applicationShim || installedCli
    return {
      ready,
      reason: ready ? null : 'application-command-mismatch',
      carrier: carrier.kind,
      ...(ready ? { commandStyle: applicationShim ? 'application-shim' : 'installed-application-cli' } : {}),
    }
  } catch (error) {
    return { ready: false, reason: error.code === 'ENOENT' ? 'launcher-missing' : 'launcher-unreadable', carrier: carrier.kind }
  }
}

export async function uninstallMaintenance(state, runner = runFile) {
  if (state === undefined || state === null) return { removed: false }
  if (platform() === 'win32') {
    const taskName = state.taskName ?? WINDOWS_MAINTENANCE_TASK
    await runner('schtasks.exe', ['/End', '/TN', taskName], { allowFailure: true, timeoutMs: 5_000 })
    await runner('schtasks.exe', ['/Delete', '/TN', taskName, '/F'], { allowFailure: true, timeoutMs: 5_000 })
    if (state.created && typeof state.launcherPath === 'string') await rm(state.launcherPath, { force: true })
    return { removed: state.created === true }
  }
  const domain = `gui/${process.getuid()}`
  await runner('/bin/launchctl', ['bootout', domain, state.plistPath], { allowFailure: true })
  if (state.created) await rm(state.plistPath, { force: true })
  return { removed: state.created }
}
