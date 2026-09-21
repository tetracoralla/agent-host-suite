import { homedir, platform } from 'node:os'
import { AgentHostError } from './errors.mjs'
import { resolveExecutable, runFile } from './process.mjs'

const CANCELLED = 'CANCELLED'
const PICKER_TIMEOUT_MS = 10 * 60 * 1000

function lastLine(text) {
  const lines = String(text ?? '').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
  return lines.at(-1) ?? ''
}

function cancelled() {
  return { status: 'cancelled' }
}

function picked(path) {
  const value = lastLine(path)
  if (value === '' || value === CANCELLED) return cancelled()
  return { status: 'picked', path: value }
}

function unavailable(detail) {
  throw new AgentHostError(
    'DIRECTORY_PICKER_UNAVAILABLE',
    'Open Agent Host on this computer to choose a folder.',
    detail === undefined ? undefined : { cause: String(detail).slice(0, 4096) },
  )
}

async function pickDarwin(runner, findCommand) {
  const osascript = await findCommand('osascript') ?? '/usr/bin/osascript'
  const result = await runner(osascript, [
    '-e', 'try',
    '-e', 'POSIX path of (choose folder with prompt "Choose a project folder")',
    '-e', 'on error number -128',
    '-e', `return "${CANCELLED}"`,
    '-e', 'end try',
  ], { allowFailure: true, timeoutMs: PICKER_TIMEOUT_MS })
  if (result.status !== 0) unavailable(result.stderr || result.stdout)
  return picked(result.stdout)
}

async function pickWindows(runner) {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$dialog.Description = "Choose a project folder"',
    '$dialog.ShowNewFolderButton = $true',
    '$result = $dialog.ShowDialog()',
    `if ($result -ne [System.Windows.Forms.DialogResult]::OK) { Write-Output "${CANCELLED}"; exit 0 }`,
    'Write-Output $dialog.SelectedPath',
  ].join('; ')
  const result = await runner('powershell.exe', [
    '-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ], { allowFailure: true, timeoutMs: PICKER_TIMEOUT_MS })
  if (result.status !== 0) unavailable(result.stderr || result.stdout)
  return picked(result.stdout)
}

async function pickLinux(runner, findCommand) {
  const zenity = await findCommand('zenity')
  if (zenity) {
    const result = await runner(zenity, [
      '--file-selection', '--directory', '--title=Choose a project folder',
    ], { allowFailure: true, timeoutMs: PICKER_TIMEOUT_MS })
    if (result.status === 0) return picked(result.stdout)
    if (result.status === 1) return cancelled()
    unavailable(result.stderr || result.stdout)
  }
  const kdialog = await findCommand('kdialog')
  if (kdialog) {
    const result = await runner(kdialog, ['--getexistingdirectory', homedir()], {
      allowFailure: true,
      timeoutMs: PICKER_TIMEOUT_MS,
    })
    if (result.status === 0) return picked(result.stdout)
    if (result.status === 1) return cancelled()
    unavailable(result.stderr || result.stdout)
  }
  unavailable()
}

export async function pickDirectory(options = {}) {
  const platformName = options.platform ?? platform()
  const runner = options.runner ?? runFile
  const findCommand = options.findCommand ?? ((name) => resolveExecutable(name, runner, platformName))
  if (platformName === 'darwin') return pickDarwin(runner, findCommand)
  if (platformName === 'win32') return pickWindows(runner)
  return pickLinux(runner, findCommand)
}
