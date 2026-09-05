[CmdletBinding()]
param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\openAdam\Agent Host'),
  [switch]$PurgeData,
  [switch]$Internal
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-NormalizedRoot([string]$Path) {
  $resolved = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
  $volume = [System.IO.Path]::GetPathRoot($resolved).TrimEnd('\')
  if ([string]::IsNullOrWhiteSpace($resolved) -or $resolved -eq $volume -or $resolved.Length -lt ($volume.Length + 4)) {
    throw "Unsafe installation path: $resolved"
  }
  return $resolved
}

function Remove-UserPath([string]$BinPath) {
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @($current -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  $parts = @($parts | Where-Object { -not ([Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ieq $BinPath.TrimEnd('\')) })
  [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
}

$InstallRoot = Get-NormalizedRoot $InstallRoot
if (-not $Internal -and $PSCommandPath.StartsWith(($InstallRoot + '\'), [System.StringComparison]::OrdinalIgnoreCase)) {
  $temporary = Join-Path $env:TEMP "openadam-agent-host-uninstall-$PID.ps1"
  Copy-Item -LiteralPath $PSCommandPath -Destination $temporary -Force
  $arguments = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $temporary, '-InstallRoot', $InstallRoot, '-Internal')
  if ($PurgeData) { $arguments += '-PurgeData' }
  & powershell.exe @arguments
  $exitCode = $LASTEXITCODE
  Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
  exit $exitCode
}

$node = Join-Path $InstallRoot 'runtime\node.exe'
$cli = Join-Path $InstallRoot 'app\bin\agent-host.mjs'
if ((Test-Path -LiteralPath $node -PathType Leaf) -and (Test-Path -LiteralPath $cli -PathType Leaf)) {
  $arguments = @($cli, 'uninstall', '--json')
  if ($PurgeData) { $arguments += '--purge-data' }
  & $node @arguments
  if ($LASTEXITCODE -ne 0) { throw "Agent Host could not finish its owned uninstall (exit $LASTEXITCODE)." }
}

Remove-UserPath (Join-Path $InstallRoot 'bin')
$programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\openAdam'
foreach ($name in @('Agent Host.lnk', 'Restore previous Agent Host.lnk', 'Uninstall Agent Host.lnk')) {
  Remove-Item -LiteralPath (Join-Path $programs $name) -Force -ErrorAction SilentlyContinue
}
if ((Test-Path -LiteralPath $programs) -and -not (Get-ChildItem -LiteralPath $programs -Force | Select-Object -First 1)) {
  Remove-Item -LiteralPath $programs -Force
}

if (Test-Path -LiteralPath $InstallRoot) { Remove-Item -LiteralPath $InstallRoot -Recurse -Force }
$previous = "$InstallRoot.previous"
if (Test-Path -LiteralPath $previous) { Remove-Item -LiteralPath $previous -Recurse -Force }

if ($PurgeData) {
  Write-Host 'Agent Host, installed tools, settings, and Agent Host private state were removed.'
} else {
  Write-Host 'Agent Host and installed tools were removed. Local observations and settings were retained for reinstall.'
}
