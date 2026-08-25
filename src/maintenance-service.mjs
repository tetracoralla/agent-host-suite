import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir, platform } from 'node:os'
import { fileURLToPath } from 'node:url'
import { runFile } from './process.mjs'

export const MAINTENANCE_LABEL = 'io.github.tetracoralla.agent-host-suite.maintenance'

function xml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export function maintenancePlist(stateRoot) {
  const cliPath = fileURLToPath(new URL('../bin/agent-host.mjs', import.meta.url))
  const executableDirectory = dirname(process.execPath)
  const servicePath = [executableDirectory, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
    .filter((value, index, values) => values.indexOf(value) === index).join(':')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${MAINTENANCE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(cliPath)}</string>
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

export async function installMaintenance(stateRoot, runner = runFile) {
  if (platform() !== 'darwin') throw new Error('The current maintenance service implementation supports macOS only')
  const path = maintenancePlistPath()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, maintenancePlist(stateRoot), { mode: 0o600, flag: 'wx' })
  await chmod(temporary, 0o600)
  await rm(path, { force: true })
  await rename(temporary, path)
  const domain = `gui/${process.getuid()}`
  await runner('/bin/launchctl', ['bootout', domain, path], { allowFailure: true })
  await runner('/bin/launchctl', ['bootstrap', domain, path])
  return { label: MAINTENANCE_LABEL, plistPath: path, created: true, intervalSeconds: 604800 }
}

export async function uninstallMaintenance(state, runner = runFile) {
  if (state === undefined || state === null) return { removed: false }
  const domain = `gui/${process.getuid()}`
  await runner('/bin/launchctl', ['bootout', domain, state.plistPath], { allowFailure: true })
  if (state.created) await rm(state.plistPath, { force: true })
  return { removed: state.created }
}
