import { assertPrivateAccess, secureWindowsDirectory } from './private-permissions.mjs'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { platform } from 'node:os'
import { promisify } from 'node:util'
import { AgentHostError } from './errors.mjs'
import { readJson, writePrivateJson } from './json.mjs'
import { prepareStatePaths, statePaths } from './state.mjs'

const LOCK_DIRECTORY = '.lifecycle-lock'
const OWNER_FILE = 'owner.json'
const RECOVERY_CLAIMS_DIRECTORY = '.recovery-claims'
const RECOVERY_CLAIM_SCHEMA = 'openadam.agent-host-lifecycle-recovery-claim.v0.1'
const RECOVERY_TICKET_SCHEMA = 'openadam.agent-host-lifecycle-recovery-ticket.v0.1'
const RECOVERY_ENTRY_LIMIT = 128
const RECOVERY_CHOOSING_POLLS = 50
const RECOVERY_CHOOSING_POLL_MS = 5
const RECOVERY_TEMP_STALE_MS = 30_000
const RECOVERY_TOKEN_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const RECOVERY_TOKEN_PATTERN = new RegExp(`^${RECOVERY_TOKEN_SOURCE}$`, 'u')
const RECOVERY_CLAIM_NAME_PATTERN = new RegExp(`^claim-(${RECOVERY_TOKEN_SOURCE})\\.json$`, 'u')
const RECOVERY_TICKET_NAME_PATTERN = new RegExp(`^ticket-(${RECOVERY_TOKEN_SOURCE})\\.json$`, 'u')
const RECOVERY_TEMP_NAME_PATTERN = new RegExp(`^(?:claim|ticket)-${RECOVERY_TOKEN_SOURCE}\\.json\\.tmp-[1-9][0-9]*-${RECOVERY_TOKEN_SOURCE}$`, 'u')
const SCAFFOLD_DIRECTORIES = new Set([
  'history', 'runtime', 'observations', 'context', 'backups', 'downloads', 'packages', 'host-projections',
])
const liveLeases = new WeakSet()
const leaseLocations = new WeakMap()
const execFileAsync = promisify(execFile)

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    if (error?.code === 'EPERM') return true
    throw error
  }
}

async function observedProcessStartTimes(pids) {
  const requested = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0)
  const observed = new Map()
  if (requested.includes(process.pid)) observed.set(process.pid, Date.now() - process.uptime() * 1000)
  if (platform() !== 'win32') return observed
  const external = requested.filter((pid) => pid !== process.pid)
  if (external.length === 0) return observed
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', [
        "$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules')",
        "$rows = @(foreach ($processId in (ConvertFrom-Json -InputObject $env:OPENADAM_LOCK_PROCESS_IDS)) { try { $item = Get-Process -Id $processId -ErrorAction Stop; [pscustomobject]@{ pid = $item.Id; startedAt = $item.StartTime.ToUniversalTime().ToString('o') } } catch {} })",
        'ConvertTo-Json -InputObject $rows -Compress',
      ].join('; '),
    ], {
      timeout: 5000, maxBuffer: 32768, windowsHide: true,
      env: { ...process.env, OPENADAM_LOCK_PROCESS_IDS: JSON.stringify(external) },
    })
    const rows = JSON.parse(stdout)
    if (!Array.isArray(rows)) return observed
    for (const row of rows) {
      const startedAt = Date.parse(row?.startedAt)
      if (external.includes(row?.pid) && Number.isFinite(startedAt)) observed.set(row.pid, startedAt)
    }
  } catch {
    // Missing observations retain live, identity-uncertain owners.
  }
  return observed
}

async function ownerProcessMatches(owner, snapshot) {
  if (!processIsAlive(owner.pid)) return false
  const observed = (snapshot ?? await observedProcessStartTimes([owner.pid])).get(owner.pid)
  // POSIX ps lstart is a zone-less wall clock. Live external owners remain
  // uncertain rather than being reclaimed across an ambiguous DST instant.
  if (observed === undefined) return true
  const delta = Math.abs(observed - Date.parse(owner.processStartedAt))
  return delta <= 2000
}

function lockOwner(operation) {
  return {
    schemaVersion: 'openadam.agent-host-lifecycle-lock.v0.1',
    token: randomUUID(),
    pid: process.pid,
    processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    operation,
    acquiredAt: new Date().toISOString(),
  }
}

function validOwner(owner) {
  return owner !== null
    && owner?.schemaVersion === 'openadam.agent-host-lifecycle-lock.v0.1'
    && typeof owner.token === 'string'
    && owner.token.length > 0
    && Number.isInteger(owner.pid)
    && owner.pid > 0
    && typeof owner.processStartedAt === 'string'
    && Number.isFinite(Date.parse(owner.processStartedAt))
    && typeof owner.operation === 'string'
    && owner.operation.length > 0
    && typeof owner.acquiredAt === 'string'
    && Number.isFinite(Date.parse(owner.acquiredAt))
}

async function publishLease(paths, owner) {
  const candidate = await mkdtemp(join(paths.root, '.lifecycle-lock-candidate-'))
  try {
    await writePrivateJson(join(candidate, OWNER_FILE), owner)
    await rename(candidate, join(paths.root, LOCK_DIRECTORY))
  } catch (error) {
    await rm(candidate, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function existingPrivateRoot(root) {
  const info = await lstat(root).catch((error) => {
    if (error?.code === 'ENOENT') return null
    throw error
  })
  if (info === null) return null
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new AgentHostError('STATE_ROOT_UNSAFE', `Private state path is not a real directory: ${root}`)
  }
  await assertPrivateAccess(root, info)
  return await realpath(root)
}

async function publishNewRootLease(root, owner) {
  await mkdir(dirname(root), { recursive: true, mode: 0o700 })
  const candidate = await mkdtemp(join(dirname(root), `.${basename(root)}.lifecycle-root-candidate-`))
  try {
    await secureWindowsDirectory(candidate)
    const lockPath = join(candidate, LOCK_DIRECTORY)
    await mkdir(lockPath, { mode: 0o700 })
    await writePrivateJson(join(lockPath, OWNER_FILE), owner)
    await rename(candidate, root)
    return await realpath(root)
  } catch (error) {
    await rm(candidate, { recursive: true, force: true }).catch(() => {})
    if (['EEXIST', 'ENOTEMPTY', 'EACCES', 'EPERM'].includes(error?.code)) return null
    throw error
  }
}

function lifecycleBusy(owner, message = 'Another Agent Host lifecycle mutation is already running') {
  return new AgentHostError('LIFECYCLE_BUSY', message, {
    operation: owner.operation,
    pid: owner.pid,
    acquiredAt: owner.acquiredAt,
  })
}

function recoveryClaim(targetOwnerToken, operation) {
  return {
    ...lockOwner(`recover:${operation}`),
    schemaVersion: RECOVERY_CLAIM_SCHEMA,
    targetOwnerToken,
  }
}

function validRecoveryClaim(value) {
  const keys = value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : []
  return keys.length === 7
    && keys.every((key) => ['schemaVersion', 'token', 'targetOwnerToken', 'pid', 'processStartedAt', 'operation', 'acquiredAt'].includes(key))
    && value.schemaVersion === RECOVERY_CLAIM_SCHEMA
    && typeof value.token === 'string'
    && RECOVERY_TOKEN_PATTERN.test(value.token)
    && typeof value.targetOwnerToken === 'string'
    && value.targetOwnerToken.length > 0
    && Number.isInteger(value.pid)
    && value.pid > 0
    && typeof value.processStartedAt === 'string'
    && Number.isFinite(Date.parse(value.processStartedAt))
    && typeof value.operation === 'string'
    && value.operation.length > 0
    && typeof value.acquiredAt === 'string'
    && Number.isFinite(Date.parse(value.acquiredAt))
}

function recoveryTicket(claim, ticket) {
  return {
    schemaVersion: RECOVERY_TICKET_SCHEMA,
    token: claim.token,
    targetOwnerToken: claim.targetOwnerToken,
    ticket,
  }
}

function validRecoveryTicket(value, token) {
  const keys = value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : []
  return keys.length === 4
    && keys.every((key) => ['schemaVersion', 'token', 'targetOwnerToken', 'ticket'].includes(key))
    && value.schemaVersion === RECOVERY_TICKET_SCHEMA
    && value.token === token
    && typeof value.targetOwnerToken === 'string'
    && value.targetOwnerToken.length > 0
    && Number.isSafeInteger(value.ticket)
    && value.ticket >= 1
    && value.ticket <= RECOVERY_ENTRY_LIMIT
}

function recoveryInvalid(message) {
  return new AgentHostError('LIFECYCLE_RECOVERY_INVALID', message)
}

async function removeRecoveryEntry(path) {
  await rm(path, { force: true }).catch((error) => {
    if (error?.code !== 'ENOENT') throw error
  })
}

async function inspectRecoveryClaims(claimsPath, ownToken) {
  const entries = await readdir(claimsPath, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return null
    throw recoveryInvalid('The Agent Host lifecycle recovery directory cannot be inspected safely')
  })
  if (entries === null) return null
  const sorted = entries.sort((left, right) => left.name.localeCompare(right.name))
  const overflow = sorted.length > RECOVERY_ENTRY_LIMIT
  const boundedEntries = sorted.slice(0, RECOVERY_ENTRY_LIMIT)

  const claims = new Map()
  const tickets = new Map()
  const now = Date.now()
  for (const entry of boundedEntries) {
    const path = join(claimsPath, entry.name)
    if (RECOVERY_TEMP_NAME_PATTERN.test(entry.name)) {
      if (entry.isSymbolicLink() || !entry.isFile()) throw recoveryInvalid('The Agent Host lifecycle recovery directory contains an unsafe temporary entry')
      const info = await lstat(path).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
      if (info !== null && now - info.mtimeMs >= RECOVERY_TEMP_STALE_MS) await removeRecoveryEntry(path)
      continue
    }
    const claimMatch = entry.name.match(RECOVERY_CLAIM_NAME_PATTERN)
    const ticketMatch = entry.name.match(RECOVERY_TICKET_NAME_PATTERN)
    if (entry.isSymbolicLink() || !entry.isFile() || (claimMatch === null && ticketMatch === null)) {
      throw recoveryInvalid('The Agent Host lifecycle recovery directory contains an unknown or unsafe entry')
    }
    let value
    try {
      value = JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw recoveryInvalid('The Agent Host lifecycle recovery directory contains malformed JSON')
    }
    if (claimMatch !== null) {
      const token = claimMatch[1]
      if (!validRecoveryClaim(value) || value.token !== token || claims.has(token)) {
        throw recoveryInvalid('The Agent Host lifecycle recovery directory contains an invalid claim')
      }
      claims.set(token, { value, claimPath: path, ticketPath: join(claimsPath, `ticket-${token}.json`) })
    } else {
      const token = ticketMatch[1]
      if (!validRecoveryTicket(value, token) || tickets.has(token)) {
        throw recoveryInvalid('The Agent Host lifecycle recovery directory contains an invalid election ticket')
      }
      tickets.set(token, value)
    }
  }

  for (const token of tickets.keys()) {
    if (!claims.has(token)) throw recoveryInvalid('The Agent Host lifecycle recovery directory contains an orphaned election ticket')
  }

  // One fresh bounded OS observation for this directory pass. Starting a
  // PowerShell per claimant makes competing recovery scans quadratic in costly
  // subprocesses. No observation is retained between election passes.
  const snapshot = await observedProcessStartTimes([...claims.values()]
    .map((item) => item.value.pid).filter(processIsAlive))
  const active = []
  for (const [token, item] of claims) {
    const ticket = tickets.get(token) ?? null
    if (ticket !== null && ticket.targetOwnerToken !== item.value.targetOwnerToken) {
      throw recoveryInvalid('The Agent Host lifecycle recovery ticket targets a different lock owner')
    }
    if (token === ownToken || await ownerProcessMatches(item.value, snapshot)) {
      active.push({ ...item, ticket })
      continue
    }
    // A dead claimant can never resume. Its unique token paths cannot be
    // recreated by another contender, so concurrent cleaners may safely remove
    // only those exact files. A live or identity-uncertain claimant is retained.
    await removeRecoveryEntry(item.ticketPath)
    await removeRecoveryEntry(item.claimPath)
  }
  if (overflow) {
    // Never elect from a partial directory view. This pass still retires at
    // most RECOVERY_ENTRY_LIMIT recognized dead or stale temporary entries, so
    // repeated recovery attempts can converge without one unbounded cleanup.
    throw new AgentHostError('LIFECYCLE_RECOVERY_BUSY', 'The stale Agent Host lifecycle recovery directory needs another bounded cleanup pass')
  }
  return active
}

function recoveryOrder(left, right) {
  const ticketOrder = left.ticket.ticket - right.ticket.ticket
  return ticketOrder === 0 ? left.value.token.localeCompare(right.value.token) : ticketOrder
}

async function claimAndRetireStaleLock(existingRoot, lockPath, retained, operation, dependencies) {
  const claimsPath = join(lockPath, RECOVERY_CLAIMS_DIRECTORY)
  const claim = recoveryClaim(retained.token, operation)
  try {
    await mkdir(claimsPath, { mode: 0o700 })
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    if (error?.code !== 'EEXIST') throw new AgentHostError('LIFECYCLE_RECOVERY_FAILED', 'The stale Agent Host lifecycle recovery directory could not be created safely')
  }
  const claimsInfo = await lstat(claimsPath).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
  if (claimsInfo === null) return false
  if (claimsInfo.isSymbolicLink() || !claimsInfo.isDirectory()) throw recoveryInvalid('The Agent Host lifecycle recovery path is not a private directory')

  const claimPath = join(claimsPath, `claim-${claim.token}.json`)
  const ticketPath = join(claimsPath, `ticket-${claim.token}.json`)
  let published = false
  try {
    try {
      await writePrivateJson(claimPath, claim)
      published = true
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw new AgentHostError('LIFECYCLE_RECOVERY_FAILED', 'The stale Agent Host lifecycle recovery claim could not be published safely')
    }
    if (typeof dependencies.lifecycleRecoveryClaimPublished === 'function') {
      await dependencies.lifecycleRecoveryClaimPublished()
    }

    const choosingClaims = await inspectRecoveryClaims(claimsPath, claim.token)
    if (choosingClaims === null || !choosingClaims.some((item) => item.value.token === claim.token)) return false
    const maximumTicket = choosingClaims.reduce((maximum, item) => Math.max(maximum, item.ticket?.ticket ?? 0), 0)
    if (maximumTicket >= RECOVERY_ENTRY_LIMIT) throw recoveryInvalid('The Agent Host lifecycle recovery election ticket limit is exhausted')
    const ownTicket = recoveryTicket(claim, maximumTicket + 1)
    try {
      await writePrivateJson(ticketPath, ownTicket)
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw new AgentHostError('LIFECYCLE_RECOVERY_FAILED', 'The stale Agent Host lifecycle recovery ticket could not be published safely')
    }

    let elected = false
    for (let poll = 0; poll < RECOVERY_CHOOSING_POLLS; poll += 1) {
      const active = await inspectRecoveryClaims(claimsPath, claim.token)
      if (active === null) return false
      const own = active.find((item) => item.value.token === claim.token)
      if (own === undefined || own.ticket === null || own.ticket.ticket !== ownTicket.ticket) {
        // The elected contender may already have retired this whole lock while
        // the current contender was reading it. Missing own election files are
        // therefore a retry signal, never authority to move the fixed path.
        return false
      }
      const otherChoosing = active.some((item) => item.value.token !== claim.token && item.ticket === null)
      if (otherChoosing) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, RECOVERY_CHOOSING_POLL_MS))
        continue
      }
      const lower = active
        .filter((item) => item.value.token !== claim.token && item.ticket !== null)
        .some((item) => recoveryOrder(item, own) < 0)
      if (lower) {
        throw new AgentHostError('LIFECYCLE_RECOVERY_BUSY', 'Another process won the stale Agent Host lifecycle recovery election')
      }
      elected = true
      break
    }
    if (!elected) throw new AgentHostError('LIFECYCLE_RECOVERY_BUSY', 'Another process is still choosing a stale Agent Host lifecycle recovery ticket')

    const current = await readJson(join(lockPath, OWNER_FILE)).catch(() => null)
    if (!validOwner(current)) {
      throw new AgentHostError('LIFECYCLE_LOCK_INVALID', 'The Agent Host lifecycle lock changed while stale recovery was being elected')
    }
    if (current.token !== retained.token) {
      // This claim may have landed inside a later live lock. Its distinct owner
      // token prevents the elected reaper from retiring that replacement.
      throw lifecycleBusy(current, 'The Agent Host lifecycle owner changed while stale recovery was being elected')
    }
    if (await ownerProcessMatches(current)) {
      throw lifecycleBusy(current, 'The Agent Host lifecycle owner became live while stale recovery was being elected')
    }

    // Bakery-style immutable tickets give every late contender a ticket greater
    // than already-published contenders. Equal tickets use the immutable random
    // token as a total order. Only the elected claimant can reach this rename.
    const stalePath = join(existingRoot, `.lifecycle-lock-stale-${randomUUID()}`)
    try {
      await rename(lockPath, stalePath)
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw new AgentHostError('LIFECYCLE_RECOVERY_FAILED', 'The elected stale Agent Host lifecycle lock changed before retirement')
    }
    try {
      await rm(stalePath, { recursive: true, force: false })
    } catch {
      throw new AgentHostError('LIFECYCLE_RECOVERY_FAILED', 'The retired stale Agent Host lifecycle lock could not be removed')
    }
    if (typeof dependencies.lifecycleRecoveryRetired === 'function') {
      await dependencies.lifecycleRecoveryRetired()
    }
    return true
  } finally {
    if (published) {
      await removeRecoveryEntry(ticketPath).catch(() => {})
      await removeRecoveryEntry(claimPath).catch(() => {})
    }
  }
}

async function acquireLifecycleLease(paths, operation, dependencies) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const owner = lockOwner(operation)
    const existingRoot = await existingPrivateRoot(paths.root)
    if (existingRoot === null) {
      const createdRoot = await publishNewRootLease(paths.root, owner)
      if (createdRoot === null) continue
      const lease = Object.freeze({ root: createdRoot, requestedRoot: paths.root, ...owner, createdRoot: true })
      liveLeases.add(lease)
      leaseLocations.set(lease, { root: createdRoot, lockPath: join(createdRoot, LOCK_DIRECTORY) })
      return lease
    }
    const lockPath = join(existingRoot, LOCK_DIRECTORY)
    try {
      await publishLease({ root: existingRoot }, owner)
      const lease = Object.freeze({ root: existingRoot, requestedRoot: paths.root, ...owner, createdRoot: false })
      liveLeases.add(lease)
      leaseLocations.set(lease, { root: existingRoot, lockPath })
      return lease
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EACCES', 'EPERM'].includes(error?.code)) throw error
    }

    const retained = await readJson(join(lockPath, OWNER_FILE)).catch((error) => {
      if (error?.code === 'ENOENT') return null
      throw error
    })
    if (retained === null) continue
    if (!validOwner(retained)) {
      throw new AgentHostError(
        'LIFECYCLE_LOCK_INVALID',
        'The Agent Host lifecycle lock is incomplete or invalid; refusing concurrent mutation',
      )
    }
    if (await ownerProcessMatches(retained)) {
      throw lifecycleBusy(retained)
    }
    if (!await claimAndRetireStaleLock(existingRoot, lockPath, retained, operation, dependencies)) continue
  }
  throw new AgentHostError('LIFECYCLE_BUSY', 'The Agent Host lifecycle lock changed while it was being acquired')
}

async function releaseLifecycleLease(lease) {
  const location = leaseLocations.get(lease)
  if (location === undefined) throw new AgentHostError('LIFECYCLE_LOCK_LOST', 'The Agent Host lifecycle lease location is unavailable')
  const retained = await readJson(join(location.lockPath, OWNER_FILE))
  if (!validOwner(retained) || retained.token !== lease.token) {
    throw new AgentHostError(
      'LIFECYCLE_LOCK_LOST',
      'The Agent Host lifecycle lock changed before the current mutation completed',
    )
  }
  await rm(location.lockPath, { recursive: true, force: false })
  liveLeases.delete(lease)
  leaseLocations.delete(lease)
}

export async function retireLifecycleRoot(lease, purpose = 'retired') {
  if (!liveLeases.has(lease)) throw new AgentHostError('LIFECYCLE_LOCK_LOST', 'The Agent Host lifecycle lease is not active')
  const location = leaseLocations.get(lease)
  const retained = await readJson(join(location.lockPath, OWNER_FILE))
  if (!validOwner(retained) || retained.token !== lease.token) {
    throw new AgentHostError('LIFECYCLE_LOCK_LOST', 'The Agent Host lifecycle lock changed before root retirement')
  }
  const retiredRoot = `${location.root}.${purpose}-${randomUUID()}`
  await rename(location.root, retiredRoot)
  leaseLocations.set(lease, { root: retiredRoot, lockPath: join(retiredRoot, LOCK_DIRECTORY) })
  return retiredRoot
}

async function isPureCreatedRootScaffold(paths, lease) {
  if (!lease.createdRoot || !liveLeases.has(lease)) return false
  const location = leaseLocations.get(lease)
  if (location === undefined || location.root !== paths.root) return false
  const retained = await readJson(join(location.lockPath, OWNER_FILE)).catch(() => null)
  if (!validOwner(retained) || retained.token !== lease.token) return false
  const entries = await readdir(paths.root, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === LOCK_DIRECTORY) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) return false
      continue
    }
    if (!SCAFFOLD_DIRECTORIES.has(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) return false
    if (!await directoryTreeContainsOnlyEmptyDirectories(join(paths.root, entry.name))) return false
  }
  return entries.some((entry) => entry.name === LOCK_DIRECTORY)
}

async function directoryTreeContainsOnlyEmptyDirectories(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) return false
    if (!await directoryTreeContainsOnlyEmptyDirectories(join(directory, entry.name))) return false
  }
  return true
}

function boundedFailure(error, fallbackCode, roots) {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/u.test(error.code)
    ? error.code
    : fallbackCode
  let message = error instanceof Error ? error.message : String(error)
  for (const root of roots.filter((value) => typeof value === 'string').sort((left, right) => right.length - left.length)) {
    message = message.replaceAll(root, '<private-path>')
  }
  message = message
    .replace(/\b[A-Za-z]:[\\/][^\s,;)}\]]*/gu, '<private-path>')
    .replace(/\\\\[^\\/\s]+[\\/][^\s,;)}\]]*/gu, '<private-path>')
    .replace(/(^|[\s("'=])\/(?:[^/\s]+\/)*[^\s,;)}\]]*/gu, '$1<private-path>')
  const bounded = [...message].slice(0, 512).join('')
  return { code, message: bounded.length === 0 ? 'Lifecycle step failed' : bounded }
}

function compoundMutationFailure(operation, mutationError, phase, secondaryError, roots) {
  const phaseLabel = phase === 'release' ? 'release its lifecycle lease' : 'remove its empty private-state scaffold'
  return new AgentHostError(
    phase === 'release' ? 'LIFECYCLE_MUTATION_RELEASE_FAILED' : 'LIFECYCLE_MUTATION_CLEANUP_FAILED',
    `The Agent Host mutation failed and could not ${phaseLabel}`,
    {
      operation,
      mutation: boundedFailure(mutationError, 'AGENT_HOST_INTERNAL', roots),
      [phase]: boundedFailure(secondaryError, 'AGENT_HOST_INTERNAL', roots),
    },
  )
}

function completedMutationCleanupFailure(operation, cleanupError, roots) {
  return new AgentHostError(
    'LIFECYCLE_MUTATION_CLEANUP_FAILED',
    'The Agent Host mutation completed but could not remove its empty private-state scaffold',
    {
      operation,
      cleanup: boundedFailure(cleanupError, 'AGENT_HOST_INTERNAL', roots),
    },
  )
}

export async function withLifecycleMutation(paths, operation, dependencies, callback) {
  const inherited = dependencies.lifecycleLease
  if (liveLeases.has(inherited) && (inherited.root === paths.root || inherited.requestedRoot === paths.root)) {
    return await callback(dependencies, paths)
  }
  const lease = await acquireLifecycleLease(paths, operation, dependencies)
  let preparedPaths = statePaths(lease.root)
  let result
  let mutationError
  let scaffoldRecoveryError
  let retiredRoot = null
  try {
    preparedPaths = await prepareStatePaths(lease.root)
    result = await callback({ ...dependencies, lifecycleLease: lease }, preparedPaths)
  } catch (error) {
    mutationError = error
  }
  if (lease.createdRoot) {
    try {
      if (await isPureCreatedRootScaffold(preparedPaths, lease)) {
        retiredRoot = await retireLifecycleRoot(
          lease,
          mutationError === undefined ? 'empty-mutation' : 'failed-mutation',
        )
      }
    } catch (recoveryError) {
      scaffoldRecoveryError = recoveryError
    }
  }

  let releaseError
  try {
    await releaseLifecycleLease(lease)
  } catch (error) {
    releaseError = error
  }

  let scaffoldCleanupError = scaffoldRecoveryError
  if (retiredRoot !== null && releaseError === undefined) {
    try {
      await rm(retiredRoot, { recursive: true, force: false })
    } catch (error) {
      scaffoldCleanupError = error
    }
  }

  if (mutationError !== undefined) {
    const roots = [paths.root, lease.root, retiredRoot]
    if (releaseError !== undefined) {
      throw compoundMutationFailure(operation, mutationError, 'release', releaseError, roots)
    }
    if (scaffoldCleanupError !== undefined) {
      throw compoundMutationFailure(operation, mutationError, 'cleanup', scaffoldCleanupError, roots)
    }
    throw mutationError
  }
  if (releaseError !== undefined) throw releaseError
  if (scaffoldCleanupError !== undefined) {
    throw completedMutationCleanupFailure(
      operation,
      scaffoldCleanupError,
      [paths.root, lease.root, retiredRoot],
    )
  }
  return result
}
