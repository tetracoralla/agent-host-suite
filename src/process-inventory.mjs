import { platform } from 'node:os'

const POWERSHELL_INVENTORY = [
  "$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules');",
  'Get-CimInstance Win32_Process',
  '| Select-Object ProcessId,CommandLine,WorkingSetSize',
  '| ConvertTo-Json -Compress',
].join(' ')

export async function readProcessInventory(runner, platformName = platform()) {
  if (platformName === 'win32') {
    const result = await runner('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', POWERSHELL_INVENTORY,
    ], { allowFailure: true, timeoutMs: 8_000, maxBuffer: 8 * 1024 * 1024 })
    if (result.status !== 0 || result.timedOut === true || result.overflowed === true) return null
    let parsed
    try {
      parsed = JSON.parse(result.stdout || '[]')
    } catch {
      return null
    }
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    return rows.flatMap((row) => typeof row?.CommandLine === 'string' ? [{
      pid: Number.isSafeInteger(Number(row.ProcessId)) ? Number(row.ProcessId) : null,
      command: row.CommandLine,
      rssBytes: Number.isFinite(Number(row.WorkingSetSize)) ? Number(row.WorkingSetSize) : null,
    }] : [])
  }
  const result = await runner('/bin/ps', ['axo', 'pid=,rss=,command='], {
    allowFailure: true,
    timeoutMs: 5_000,
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.status !== 0 || result.timedOut === true || result.overflowed === true) return null
  return result.stdout.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/u)
    return match === null ? [] : [{ pid: Number(match[1]), rssBytes: Number(match[2]) * 1024, command: match[3] }]
  })
}
