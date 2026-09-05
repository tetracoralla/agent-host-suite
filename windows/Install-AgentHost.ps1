[CmdletBinding()]
param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\openAdam\Agent Host'),
  [switch]$NoPath,
  [switch]$NoShortcuts,
  [switch]$NoLaunch,
  [switch]$RestorePrevious,
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

function Assert-Payload([string]$Root, [object]$Manifest) {
  $prefix = (Get-NormalizedRoot $Root) + '\'
  foreach ($file in $Manifest.files) {
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $Root ($file.path -replace '/', '\')))
    if (-not $candidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Payload manifest escapes its root: $($file.path)"
    }
    $item = Get-Item -LiteralPath $candidate -Force -ErrorAction Stop
    if ($item.PSIsContainer -or $item.Length -ne [int64]$file.bytes) {
      throw "Payload file size mismatch: $($file.path)"
    }
    $actual = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne [string]$file.sha256) {
      throw "Payload digest mismatch: $($file.path)"
    }
  }
}

function Assert-StateCompatibility([string]$Root) {
  $stateRoot = if ([string]::IsNullOrWhiteSpace($env:AGENT_HOST_STATE_ROOT)) {
    Join-Path $env:LOCALAPPDATA 'openAdam\Agent Host Suite'
  } else {
    [System.IO.Path]::GetFullPath($env:AGENT_HOST_STATE_ROOT)
  }
  $statePath = Join-Path $stateRoot 'state.json'
  if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { return }
  $node = Join-Path $Root 'runtime\node.exe'
  $cli = Join-Path $Root 'app\bin\agent-host.mjs'
  if (-not (Test-Path -LiteralPath $node -PathType Leaf) -or -not (Test-Path -LiteralPath $cli -PathType Leaf)) {
    throw 'The selected Agent Host application has no usable state reader.'
  }
  $output = & $node $cli status --state-root $stateRoot --json 2>&1
  if ($LASTEXITCODE -ne 0) {
    $detail = (($output | Out-String).Trim())
    if ($detail.Length -gt 2048) { $detail = $detail.Substring(0, 2048) }
    throw "The selected Agent Host application cannot read the current local-tool state. Restore or install a compatible application first. $detail"
  }
}

function Set-UserPath([string]$BinPath, [bool]$Add) {
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @($current -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  $parts = @($parts | Where-Object { -not ([Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ieq $BinPath.TrimEnd('\')) })
  if ($Add) { $parts += $BinPath }
  [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
  $env:Path = "$BinPath;$env:Path"
}

function Install-Shortcuts([string]$Root) {
  $programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\openAdam'
  New-Item -ItemType Directory -Force -Path $programs | Out-Null
  $shell = New-Object -ComObject WScript.Shell
  $manager = $shell.CreateShortcut((Join-Path $programs 'Agent Host.lnk'))
  $manager.TargetPath = (Join-Path $Root 'bin\Agent Host.cmd')
  $manager.WorkingDirectory = $Root
  $manager.Description = 'Manage local Agent tools'
  $manager.Save()
  $uninstall = $shell.CreateShortcut((Join-Path $programs 'Uninstall Agent Host.lnk'))
  $uninstall.TargetPath = 'powershell.exe'
  $uninstall.Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $Root 'Uninstall-AgentHost.ps1')`""
  $uninstall.WorkingDirectory = $Root
  $uninstall.Description = 'Uninstall Agent Host'
  $uninstall.Save()
  $restore = $shell.CreateShortcut((Join-Path $programs 'Restore previous Agent Host.lnk'))
  $restore.TargetPath = 'powershell.exe'
  $restore.Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $Root 'Install-AgentHost.ps1')`" -RestorePrevious"
  $restore.WorkingDirectory = $Root
  $restore.Description = 'Swap the current and previous Agent Host applications'
  $restore.Save()
}

$InstallRoot = Get-NormalizedRoot $InstallRoot
$PreviousRoot = "$InstallRoot.previous"
$StagingRoot = "$InstallRoot.staging-$PID"
$manifestPath = Join-Path $PSScriptRoot 'payload-manifest.json'
$payloadRoot = Join-Path $PSScriptRoot 'payload'

if ($RestorePrevious) {
  if (-not $Internal -and $PSCommandPath.StartsWith(($InstallRoot + '\'), [System.StringComparison]::OrdinalIgnoreCase)) {
    $temporary = Join-Path $env:TEMP "openadam-agent-host-restore-$PID.ps1"
    Copy-Item -LiteralPath $PSCommandPath -Destination $temporary -Force
    $arguments = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $temporary, '-InstallRoot', $InstallRoot, '-RestorePrevious', '-Internal')
    if ($NoPath) { $arguments += '-NoPath' }
    if ($NoShortcuts) { $arguments += '-NoShortcuts' }
    if ($NoLaunch) { $arguments += '-NoLaunch' }
    & powershell.exe @arguments
    $exitCode = $LASTEXITCODE
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    exit $exitCode
  }
  if (-not (Test-Path -LiteralPath $InstallRoot -PathType Container) -or -not (Test-Path -LiteralPath $PreviousRoot -PathType Container)) {
    throw 'Both the current and previous Agent Host installations are required for restore.'
  }
  $previousManifestPath = Join-Path $PreviousRoot 'install-manifest.json'
  if (-not (Test-Path -LiteralPath $previousManifestPath -PathType Leaf)) { throw 'The previous installation has no verification manifest.' }
  $previousManifest = Get-Content -LiteralPath $previousManifestPath -Raw | ConvertFrom-Json
  if ($previousManifest.schemaVersion -ne 'openadam.agent-host-windows-payload.v0.1') { throw 'The previous installation manifest is unsupported.' }
  Assert-Payload $PreviousRoot $previousManifest
  Assert-StateCompatibility $PreviousRoot
  $swapRoot = "$InstallRoot.rollback-$PID"
  Move-Item -LiteralPath $InstallRoot -Destination $swapRoot
  try {
    Move-Item -LiteralPath $PreviousRoot -Destination $InstallRoot
    Move-Item -LiteralPath $swapRoot -Destination $PreviousRoot
  } catch {
    if ((Test-Path -LiteralPath $swapRoot) -and -not (Test-Path -LiteralPath $InstallRoot)) {
      Move-Item -LiteralPath $swapRoot -Destination $InstallRoot
    }
    throw
  }
  if (-not $NoPath) { Set-UserPath (Join-Path $InstallRoot 'bin') $true }
  if (-not $NoShortcuts) { Install-Shortcuts $InstallRoot }
  if (-not $NoLaunch) { Start-Process -FilePath (Join-Path $InstallRoot 'bin\Agent Host.cmd') }
  Write-Host "Restored the previous Agent Host application. Local tools and observations were retained."
  exit 0
}

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or -not (Test-Path -LiteralPath $payloadRoot -PathType Container)) {
  throw 'The Agent Host payload is incomplete. Extract the whole ZIP before installation.'
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schemaVersion -ne 'openadam.agent-host-windows-payload.v0.1') { throw 'Unsupported Agent Host payload manifest.' }
Assert-Payload $payloadRoot $manifest

if (Test-Path -LiteralPath $StagingRoot) { Remove-Item -LiteralPath $StagingRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $InstallRoot) | Out-Null
Copy-Item -LiteralPath $payloadRoot -Destination $StagingRoot -Recurse
Assert-Payload $StagingRoot $manifest
Assert-StateCompatibility $StagingRoot

if (Test-Path -LiteralPath $PreviousRoot) { Remove-Item -LiteralPath $PreviousRoot -Recurse -Force }
if (Test-Path -LiteralPath $InstallRoot) { Move-Item -LiteralPath $InstallRoot -Destination $PreviousRoot }
try {
  Move-Item -LiteralPath $StagingRoot -Destination $InstallRoot
} catch {
  if ((Test-Path -LiteralPath $PreviousRoot) -and -not (Test-Path -LiteralPath $InstallRoot)) {
    Move-Item -LiteralPath $PreviousRoot -Destination $InstallRoot
  }
  throw
}

if (-not $NoPath) { Set-UserPath (Join-Path $InstallRoot 'bin') $true }
if (-not $NoShortcuts) { Install-Shortcuts $InstallRoot }
if (-not $NoLaunch) { Start-Process -FilePath (Join-Path $InstallRoot 'bin\Agent Host.cmd') }

Write-Host "Agent Host $($manifest.suiteVersion) installed for the current user."
Write-Host "Open 'Agent Host' from the Start menu, or run agent-host from a new terminal."
if (Test-Path -LiteralPath $PreviousRoot) {
  Write-Host "The previous application is retained for one-step restore; local tools and observations were not duplicated."
}
