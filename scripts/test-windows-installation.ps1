$ErrorActionPreference = 'Stop'
$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules')
$root = Join-Path $env:TEMP ("agent-host-ownership-test-" + [Guid]::NewGuid().ToString('N'))
$decoy = Join-Path $root 'Unrelated application'
New-Item -ItemType Directory -Path $decoy -Force | Out-Null
Set-Content -LiteralPath (Join-Path $decoy 'keep.txt') -Value 'user-owned'
$source = Split-Path -Parent $PSScriptRoot
try {
  foreach ($script in @('Install-AgentHost.ps1', 'Uninstall-AgentHost.ps1')) {
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $source "windows\$script") -InstallRoot $decoy 2>&1 | Out-String | Out-Null
    if ($LASTEXITCODE -eq 0) { throw "$script accepted an unrelated application directory" }
    if ((Get-Content -LiteralPath (Join-Path $decoy 'keep.txt') -Raw).Trim() -ne 'user-owned') {
      throw "$script changed unrelated user content"
    }
  }
  Write-Host 'Installer and uninstaller reject unrelated directories and preserve their content.'
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force
}

# Expected rejected child commands must not become the enclosing CI exit status.
exit 0
