import { execFile, spawnSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))

async function modules(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await modules(path))
    else if (entry.name.endsWith('.mjs')) result.push(path)
  }
  return result
}

const files = [...await modules(join(root, 'src')), ...await modules(join(root, 'scripts'))]
for (const file of files) await execFileAsync(process.execPath, ['--check', file])
if (process.platform === 'win32') {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$parseTokens = $null; $parseErrors = $null; $null = [System.Management.Automation.Language.Parser]::ParseFile([Console]::In.ReadToEnd(), [ref]$parseTokens, [ref]$parseErrors); if ($parseErrors.Count -gt 0) { $parseErrors | ForEach-Object { Write-Output $_.Message }; exit 1 }"],
  { input: join(root, 'src', 'windows-task.ps1'), encoding: 'utf8', timeout: 15000, windowsHide: true })
  if (result.error || result.status !== 0) throw new Error('Windows service PowerShell syntax failed: ' + (result.error?.message ?? result.stdout + result.stderr))
}
console.log(`syntax passed for ${files.length} modules`)
