// Owned by Agent Host Suite src/windows-private-access.mjs.
// Packaged copies are checked byte-for-byte by scripts/sync-platform-support.mjs.
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
const execFileAsync = promisify(execFile)

export const windowsScript = String.raw`
$ErrorActionPreference = 'Stop'
# Parent PowerShell 7 sessions can supply an incompatible module search path to
# Windows PowerShell 5.1. Resolve only this engine's built-in modules.
$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules')
$results = @(foreach ($request in (ConvertFrom-Json -InputObject $env:OPENADAM_PRIVATE_REQUESTS)) {
try {
$target = $request.path
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$userSid = $identity.User.Value
$tokenOwner = $identity.Owner.Value
$acl = Get-Acl -LiteralPath $target
$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
if ($owner -ne $userSid -and $owner -ne $tokenOwner) {
  @{status='wrong-owner'}
  continue
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
if (-not $private -and $request.ensure -eq $true) {
  $directory = (Get-Item -LiteralPath $target -Force).PSIsContainer
  if ($directory) { $acl = [System.Security.AccessControl.DirectorySecurity]::new() }
  else { $acl = [System.Security.AccessControl.FileSecurity]::new() }
  $acl.SetOwner($identity.User)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in $trusted) {
    $principal = [System.Security.Principal.SecurityIdentifier]::new($sid)
    $inheritance = if ($directory) { 'ContainerInherit,ObjectInherit' } else { 'None' }
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $principal, 'FullControl', $inheritance, 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $target -AclObject $acl
  $verified = Get-Acl -LiteralPath $target
  if (-not (Is-Private $verified $trusted $userSid)) { throw 'Private ACL readback failed' }
  @{status='secured'}
} elseif ($private) {
  @{status='private'}
} else {
  @{status='shared'}
}
} catch {
  @{status='error'; reason=$_.FullyQualifiedErrorId; line=$_.InvocationInfo.ScriptLineNumber}
}
})
ConvertTo-Json -InputObject $results -Compress
`

function invocation(requests) {
  if (requests.length > 64) throw new Error('Too many Windows access-list requests')
  return [['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(windowsScript, 'utf16le').toString('base64')], {
    env: { ...process.env, OPENADAM_PRIVATE_REQUESTS: JSON.stringify(requests) },
    encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 16384,
  }]
}
function decode(text, count) {
  const values = JSON.parse(text.trim())
  if (!Array.isArray(values) || values.length !== count) throw new Error('Invalid Windows access-list response')
  return values
}
function helperTimedOut(error) {
  return error?.code === 'ETIMEDOUT' || (error?.killed === true && error?.signal === 'SIGTERM')
}

export function windowsAccessListsSync(requests) {
  const [args, options] = invocation(requests)
  let output
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { output = execFileSync('powershell.exe', args, options); break } catch (error) {
      if (attempt !== 0 || !helperTimedOut(error)) throw error
    }
  }
  return decode(output, requests.length)
}

async function executeAccessLists(args, options) {
  // Retry a timed-out native helper once (at most 20s total), with exactly
  // the same request and a fresh result instead of a cached security decision.
  // Inspection remains read-only and ensuring an ACL is idempotent. Denied
  // access, unsafe results and malformed output are never retry conditions.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return await execFileAsync('powershell.exe', args, options) } catch (error) {
      if (attempt !== 0 || !helperTimedOut(error)) throw error
    }
  }
}
let queue = []
let scheduled = false
export function windowsAccessList(path, ensure = false) {
  return new Promise((resolve, reject) => {
    queue.push({ path, ensure, resolve, reject })
    if (scheduled) return
    scheduled = true
    // Coalesce concurrent filesystem checks without retaining security results.
    setTimeout(async () => {
      scheduled = false
      const entries = queue
      queue = []
      for (let offset = 0; offset < entries.length; offset += 64) {
        const batch = entries.slice(offset, offset + 64)
        try {
          const [args, options] = invocation(batch.map(({ path, ensure }) => ({ path, ensure })))
          const result = await executeAccessLists(args, options)
          const values = decode(result.stdout, batch.length)
          batch.forEach((entry, index) => entry.resolve(values[index]))
        } catch (error) { batch.forEach((entry) => entry.reject(error)) }
      }
    }, 2)
  })
}
export function requirePrivateWindowsResults(values) {
  if (!values.every((value) => ['private', 'secured'].includes(value.status))) {
    const error = new Error('Windows access list is not private to the current identity')
    error.code = 'PRIVATE_ACCESS_UNSAFE'
    throw error
  }
}
