import { execFile } from 'node:child_process'
import { platform } from 'node:os'
import { promisify } from 'node:util'
import { AgentHostError } from './errors.mjs'

const execFileAsync = promisify(execFile)
const pendingReads = new Map()

// Windows stat.mode is synthetic and cannot describe an NTFS access list.
// Use SIDs rather than localized account names, and keep path data out of code.
const windowsScript = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:OPENADAM_PRIVATE_PATH
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$userSid = $identity.User.Value
$tokenOwner = $identity.Owner.Value
$acl = Get-Acl -LiteralPath $target
$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
if ($owner -ne $userSid -and $owner -ne $tokenOwner) {
  @{status='wrong-owner'} | ConvertTo-Json -Compress
  exit 0
}
$trusted = @($userSid, 'S-1-5-18', 'S-1-5-32-544')
function Is-Private($acl, $trusted, $userSid) {
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  $allows = @($rules | Where-Object {
    $_.AccessControlType -eq 'Allow' -and ($_.PropagationFlags -band 2) -eq 0
})
$foreign = @($allows | Where-Object { $_.IdentityReference.Value -notin $trusted })
$own = @($allows | Where-Object { $_.IdentityReference.Value -eq $userSid })
return ($foreign.Count -eq 0 -and $own.Count -gt 0)
}
$private = Is-Private $acl $trusted $userSid
if (-not $private -and $env:OPENADAM_PRIVATE_ENSURE -eq '1') {
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($identity.User)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in $trusted) {
    $principal = [System.Security.Principal.SecurityIdentifier]::new($sid)
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $target -AclObject $acl
  $verified = Get-Acl -LiteralPath $target
  if (-not (Is-Private $verified $trusted $userSid)) { throw 'Private ACL readback failed' }
  @{status='secured'} | ConvertTo-Json -Compress
} elseif ($private) {
  @{status='private'} | ConvertTo-Json -Compress
} else {
  @{status='shared'} | ConvertTo-Json -Compress
}
`

async function windowsAccess(path, ensure) {
  const key = `${ensure}:${path}`
  if (pendingReads.has(key)) return pendingReads.get(key)
  const operation = (async () => {
    let value
    try {
      const result = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(windowsScript, 'utf16le').toString('base64'),
      ], {
        env: { ...process.env, OPENADAM_PRIVATE_PATH: path, OPENADAM_PRIVATE_ENSURE: ensure ? '1' : '0' },
        windowsHide: true, timeout: 10_000, maxBuffer: 16_384,
      })
      value = JSON.parse(result.stdout.trim())
    } catch {
      throw new AgentHostError('STATE_ROOT_PERMISSIONS_UNAVAILABLE', 'Windows could not verify the private Agent Host access list')
    }
    if (value.status === 'wrong-owner') {
      throw new AgentHostError('STATE_ROOT_WRONG_OWNER', 'Private Agent Host state is not owned by the current Windows identity')
    }
    if (!['private', 'secured'].includes(value.status)) {
      throw new AgentHostError('STATE_ROOT_PERMISSIONS_UNSAFE', 'Agent Host state grants access to another Windows identity')
    }
  })()
  pendingReads.set(key, operation)
  try { return await operation } finally { pendingReads.delete(key) }
}

export async function assertPrivateAccess(path, info) {
  if (platform() === 'win32') return windowsAccess(path, false)
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new AgentHostError('STATE_ROOT_WRONG_OWNER', 'Private Agent Host state is not owned by the current user')
  }
  if ((info.mode & 0o077) !== 0) {
    throw new AgentHostError('STATE_ROOT_PERMISSIONS_UNSAFE', 'The Agent Host state root must not be accessible by group or other users')
  }
}

export async function secureWindowsDirectory(path) {
  if (platform() === 'win32') await windowsAccess(path, true)
}
