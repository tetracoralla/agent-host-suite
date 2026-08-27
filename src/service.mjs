import { platform, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { chmod, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { AgentHostError } from './errors.mjs'
import { runFile } from './process.mjs'

export const SERVICE_LABEL = 'io.github.tetracoralla.agent-host-suite.runtime'

function xml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export function launchAgentContents(runtime, files) {
  const executableDirectory = dirname(runtime.command)
  const servicePath = [executableDirectory, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(':')
  const argumentsList = [
    runtime.command,
    ...runtime.args,
    'serve',
    '--config', files.configPath,
    '--socket', files.socketPath,
    '--observation-log', files.observationLog,
    '--replace-stale-socket',
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsList.map((item) => `    <string>${xml(item)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(servicePath)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
`
}

export function defaultLaunchAgentPath() {
  return join(userInfo().homedir, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
}

export async function preflightServiceInstallation(runner = runFile, launchAgentPath = defaultLaunchAgentPath()) {
  if (platform() !== 'darwin') {
    throw new AgentHostError('SERVICE_PLATFORM_UNSUPPORTED', `Automatic service installation is not implemented on ${platform()}`)
  }
  try {
    const info = await lstat(launchAgentPath)
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new AgentHostError('SERVICE_PATH_UNSAFE', 'The local execution service path is not a regular file')
    }
    throw new AgentHostError('SERVICE_CONFLICT', 'Another local execution service is already configured', { launchAgentPath })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const domain = `gui/${process.getuid()}`
  const loaded = await runner('/bin/launchctl', ['print', `${domain}/${SERVICE_LABEL}`], { allowFailure: true })
  if (loaded.status === 0) {
    throw new AgentHostError('SERVICE_CONFLICT', 'Another local execution service is already running')
  }
  return { supported: true, label: SERVICE_LABEL, launchAgentPath }
}

export async function inspectService(serviceState = null, runner = runFile) {
  if (platform() !== 'darwin') return { supported: false, platform: platform() }
  if (serviceState === null || serviceState === undefined) {
    return { supported: true, configured: false, loaded: false, launchAgentPath: null }
  }
  const domain = `gui/${process.getuid()}`
  const result = await runner('/bin/launchctl', ['print', `${domain}/${SERVICE_LABEL}`], { allowFailure: true })
  const loaded = result.status === 0
  const running = loaded && /^\s*state = running\s*$/mu.test(result.stdout)
  let socketPresent = null
  if (typeof serviceState.socketPath === 'string') {
    try {
      socketPresent = (await lstat(serviceState.socketPath)).isSocket()
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      socketPresent = false
    }
  }
  const lastExitMatch = result.stdout.match(/^\s*last exit code = (-?\d+)\s*$/mu)
  return {
    supported: true,
    configured: true,
    loaded,
    running,
    socketPresent,
    ready: loaded && running && socketPresent !== false,
    lastExitCode: lastExitMatch === null ? null : Number(lastExitMatch[1]),
    launchAgentPath: serviceState?.launchAgentPath ?? defaultLaunchAgentPath(),
  }
}

export async function installService(runtime, files, runner = runFile, existingState = null) {
  if (platform() !== 'darwin') {
    throw new AgentHostError('SERVICE_PLATFORM_UNSUPPORTED', `Automatic service installation is not implemented on ${platform()}`)
  }
  const launchAgentPath = existingState?.launchAgentPath ?? defaultLaunchAgentPath()
  await mkdir(dirname(launchAgentPath), { recursive: true, mode: 0o700 })
  let existed = false
  try {
    const info = await lstat(launchAgentPath)
    existed = true
    if (info.isSymbolicLink() || !info.isFile()) throw new AgentHostError('SERVICE_PATH_UNSAFE', 'LaunchAgent path is not a regular file')
    if (existingState === null) {
      const current = await readFile(launchAgentPath, 'utf8')
      if (!current.includes(`<string>${SERVICE_LABEL}</string>`)) {
        throw new AgentHostError('SERVICE_CONFLICT', 'The local execution service path belongs to another service', { launchAgentPath })
      }
      throw new AgentHostError('SERVICE_CONFLICT', 'Another local execution service is already configured', { launchAgentPath })
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const temporary = `${launchAgentPath}.tmp-${process.pid}`
  await writeFile(temporary, launchAgentContents(runtime, files), { mode: 0o600, flag: 'wx' })
  await chmod(temporary, 0o600)
  await rm(launchAgentPath, { force: true })
  await import('node:fs/promises').then(({ rename }) => rename(temporary, launchAgentPath))
  const domain = `gui/${process.getuid()}`
  if (existed || existingState !== null) {
    await runner('/bin/launchctl', ['bootout', domain, launchAgentPath], { allowFailure: true })
  }
  await runner('/bin/launchctl', ['bootstrap', domain, launchAgentPath])
  await runner('/bin/launchctl', ['kickstart', '-k', `${domain}/${SERVICE_LABEL}`])
  return { kind: 'launchd', label: SERVICE_LABEL, launchAgentPath, created: !existed }
}

export async function uninstallService(serviceState, runner = runFile) {
  if (serviceState === null || serviceState === undefined) return { removed: false }
  if (platform() !== 'darwin') return { removed: false, unsupported: true }
  const domain = `gui/${process.getuid()}`
  await runner('/bin/launchctl', ['bootout', domain, serviceState.launchAgentPath], { allowFailure: true })
  if (serviceState.created) await rm(serviceState.launchAgentPath, { force: true })
  return { removed: serviceState.created }
}
