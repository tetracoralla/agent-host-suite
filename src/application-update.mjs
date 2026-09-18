import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { platform as osPlatform } from 'node:os'
import { basename, join } from 'node:path'
import { withLifecycleMutation } from './lifecycle-lock.mjs'
import { statePaths } from './state.mjs'
import { AgentHostError } from './errors.mjs'
import { fetchGitHubRelease, fetchGitHubReleases, parseSha256File } from './github-api.mjs'
import { acquireHttpsFile } from './release-artifacts.mjs'
import { resolveApplicationCarrier } from './application-carrier.mjs'
import { readJson, writePrivateJson } from './json.mjs'
import { resolveStateRoot } from './paths.mjs'
import { prepareStatePaths } from './state.mjs'
import { loadGitHubToolRegistry } from './github-registry.mjs'
import { supportedReleasePlatform } from './github-project.mjs'
import { runFile, startDetachedProcess } from './process.mjs'
import { compareSemVer } from './semver.mjs'
import { readUpdatePreferences } from './update-preferences.mjs'

export const APPLICATION_UPDATE_SCHEMA = 'openadam.agent-host-application-update.v0.1'
export const APPLICATION_UPDATE_STATE_SCHEMA = 'openadam.agent-host-application-update-state.v0.1'

const HOST_REPO = 'tetracoralla/agent-host-suite'
const TERMINAL_PHASES = new Set(['idle', 'complete', 'recovered'])
const LIVE_PHASES = new Set(['downloading', 'downloaded', 'staging', 'replacing', 'verifying', 'relaunching'])
// Pre-swap phases may be abandoned when the lease is released after a failed download.
// Mid-swap phases with a still-alive owner must remain live so recovery does not rewind them.
const ABANDONABLE_PHASES = new Set(['downloading', 'downloaded', 'staging'])

function fail(code, message, details) {
  throw new AgentHostError(code, message, details)
}

function journalPath(root) {
  return join(root, 'application-update.json')
}

function emptyJournal() {
  return {
    schemaVersion: APPLICATION_UPDATE_STATE_SCHEMA,
    phase: 'idle',
    channel: 'stable',
    fromVersion: null,
    toVersion: null,
    carrierPath: null,
    stagedRoot: null,
    previousRoot: null,
    currentRoot: null,
    restored: null,
    error: null,
    pid: null,
    processStartedAt: null,
    updatedAt: null,
  }
}

function ownerFields() {
  return {
    pid: process.pid,
    processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    if (error?.code === 'EPERM') return true
    throw error
  }
}

function journalOwnerAlive(journal) {
  return LIVE_PHASES.has(journal.phase) && processIsAlive(journal.pid)
}

export async function readApplicationUpdateJournal(stateRoot) {
  const root = resolveStateRoot(stateRoot)
  const value = await readJson(journalPath(root))
  if (value === null) return emptyJournal()
  if (value.schemaVersion !== APPLICATION_UPDATE_STATE_SCHEMA) return { ...emptyJournal(), recoveredInvalid: true }
  return value
}

async function writeJournal(stateRoot, value) {
  const paths = await prepareStatePaths(resolveStateRoot(stateRoot))
  const record = {
    ...emptyJournal(),
    ...value,
    ...ownerFields(),
    schemaVersion: APPLICATION_UPDATE_STATE_SCHEMA,
    updatedAt: new Date().toISOString(),
  }
  await writePrivateJson(journalPath(paths.root), record)
  return record
}

function carrierName(version, platform) {
  if (platform === 'darwin-arm64') return `Agent-Host-${version}-darwin-arm64.dmg`
  if (platform === 'darwin-x86_64') return `Agent-Host-${version}-darwin-x86_64.dmg`
  if (platform === 'win32-x64') return `Agent-Host-${version}-win32-x64.zip`
  if (platform === 'win32-arm64') return `Agent-Host-${version}-win32-arm64.zip`
  return `Agent-Host-${version}-directory.tar.gz`
}

export async function checkApplicationUpdate({
  fetch,
  signal,
  channel = 'stable',
  currentVersion,
  platform = supportedReleasePlatform(),
} = {}) {
  const registry = await loadGitHubToolRegistry()
  const repository = registry.host?.repository ?? HOST_REPO
  let release
  try {
    if (channel === 'preview') {
      const releases = await fetchGitHubReleases(repository, { fetch, signal, channel: 'preview' })
      release = releases[0]
      if (release === undefined) fail('APPLICATION_UPDATE_UNAVAILABLE', 'No preview GitHub Release is published')
    } else {
      release = await fetchGitHubRelease(repository, 'latest', { fetch, signal })
      if (release.prerelease === true) fail('APPLICATION_UPDATE_CHANNEL', 'Stable application updates do not use prerelease GitHub latest')
    }
  } catch (error) {
    if (error instanceof AgentHostError) {
      return {
        schemaVersion: APPLICATION_UPDATE_SCHEMA,
        status: 'check-failed',
        channel,
        currentVersion: currentVersion ?? null,
        availableVersion: null,
        availability: 'check-failed',
        error: { code: error.code, message: error.message },
        note: 'profiles fetch --carrier downloads an installer. It does not replace or relaunch Agent Host.',
      }
    }
    throw error
  }
  const version = release.tag.replace(/^v/u, '')
  const filename = platform === null ? null : carrierName(version, platform)
  const asset = filename === null ? null : release.assets.find((item) => item.name === filename) ?? null
  const checksum = filename === null ? null : release.assets.find((item) => item.name === 'SHA256SUMS' || item.name === `${filename}.sha256`) ?? null
  let availability = 'current'
  if (platform === null) availability = 'no-platform-asset'
  else if (asset === null) availability = 'no-platform-asset'
  else if (currentVersion === undefined || currentVersion === null) availability = 'version-unknown'
  else if (compareSemVer(currentVersion, version) < 0) availability = 'update-available'
  return {
    schemaVersion: APPLICATION_UPDATE_SCHEMA,
    status: 'ok',
    channel,
    currentVersion: currentVersion ?? null,
    availableVersion: version,
    tag: release.tag,
    prerelease: release.prerelease === true,
    releaseUrl: release.htmlUrl,
    platform,
    availability,
    carrier: asset === null ? null : { filename: asset.name, url: asset.url, bytes: asset.bytes, sha256: asset.digest ?? null },
    checksum: checksum === null ? null : { filename: checksum.name, url: checksum.url },
    notarized: false,
    note: 'Unsigned preview. Control-click Open on macOS; SmartScreen may warn on Windows. profiles fetch --carrier is not application self-update.',
  }
}

export async function downloadApplicationCarrier(check, {
  destination,
  fetch,
  signal,
  expectedSha256 = null,
} = {}) {
  if (check.carrier === null) fail('APPLICATION_UPDATE_UNAVAILABLE', 'No application installer is published for this platform')
  let digest = expectedSha256 ?? check.carrier?.sha256 ?? null
  if (digest == null && check.checksum !== null) {
    const sumsPath = `${destination}.SHA256SUMS`
    await acquireHttpsFile({
      url: check.checksum.url,
      destination: sumsPath,
      maxBytes: 64 * 1024,
      fetch,
      signal,
      label: 'application checksums',
    })
    const text = await readFile(sumsPath, 'utf8')
    const line = text.split(/\r?\n/u).find((item) => item.includes(check.carrier.filename))
    if (line === undefined) fail('GITHUB_CHECKSUM_INVALID', 'SHA256SUMS does not name the application installer')
    digest = parseSha256File(line, check.carrier.filename).sha256
  }
  if (digest == null) fail('GITHUB_CHECKSUM_INVALID', 'Application installers require a SHA-256')
  return acquireHttpsFile({
    url: check.carrier.url,
    destination,
    expectedSha256: digest,
    expectedBytes: check.carrier.bytes,
    maxBytes: check.carrier.bytes ?? 512 * 1024 * 1024,
    fetch,
    signal,
    label: check.carrier.filename,
  })
}

export async function applyDirectorySwapUpdate({
  currentRoot,
  stagedRoot,
  previousRoot,
}) {
  if (typeof currentRoot !== 'string' || typeof stagedRoot !== 'string') {
    fail('APPLICATION_UPDATE_INVALID', 'Application replacement requires current and staged directories')
  }
  const backup = previousRoot ?? `${currentRoot}.previous`
  await rm(backup, { recursive: true, force: true })
  await rename(currentRoot, backup)
  try {
    await rename(stagedRoot, currentRoot)
  } catch (error) {
    await rename(backup, currentRoot).catch(() => {})
    throw error
  }
  return { currentRoot, previousRoot: backup, kind: 'directory-swap' }
}

async function pathExists(path) {
  return stat(path).then(() => true).catch((error) => {
    if (error.code === 'ENOENT') return false
    throw error
  })
}

function updateTransactionMarkerPath(currentRoot) {
  return join(currentRoot, '.agent-host-update-txn.json')
}

async function writeUpdateTransactionMarker(currentRoot, journal) {
  if (typeof currentRoot !== 'string') return
  await writeFile(updateTransactionMarkerPath(currentRoot), `${JSON.stringify({
    schemaVersion: 'openadam.agent-host-application-update-txn.v0.1',
    fromVersion: journal.fromVersion ?? null,
    toVersion: journal.toVersion ?? null,
    previousRoot: journal.previousRoot ?? null,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 })
}

async function readUpdateTransactionMarker(currentRoot) {
  if (typeof currentRoot !== 'string') return null
  try {
    const value = JSON.parse(await readFile(updateTransactionMarkerPath(currentRoot), 'utf8'))
    if (value?.schemaVersion !== 'openadam.agent-host-application-update-txn.v0.1') return null
    return value
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    return null
  }
}

async function clearUpdateTransactionMarker(currentRoot) {
  if (typeof currentRoot !== 'string') return
  await rm(updateTransactionMarkerPath(currentRoot), { force: true }).catch(() => {})
}

function markerMatchesJournal(marker, journal) {
  return marker !== null
    && marker.fromVersion === journal.fromVersion
    && marker.toVersion === journal.toVersion
    && marker.previousRoot === journal.previousRoot
}


export async function resolveReplacedApplicationLaunch({ root, command, args = [] } = {}) {
  if (typeof command === 'string' && command.length > 0) return { command, args }
  const macosExec = join(root, 'Contents', 'MacOS', 'agent-host')
  if (await pathExists(macosExec)) {
    return { command: macosExec, args }
  }
  const cli = join(root, 'app', 'bin', 'agent-host.mjs')
  const bundledNode = join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')
  if (await pathExists(cli)) {
    const node = await pathExists(bundledNode) ? bundledNode : process.execPath
    return { command: node, args: [cli, ...args] }
  }
  return {
    command: join(root, 'bin', process.platform === 'win32' ? 'agent-host.cmd' : 'agent-host'),
    args,
  }
}

async function readJsonVersion(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (typeof value?.version === 'string' && value.version.length > 0) return value.version
    if (typeof value?.suiteVersion === 'string' && value.suiteVersion.length > 0) return value.suiteVersion
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return null
}

/** Read the version the formal payload already carries (package / distribution / Info.plist). */
export async function readReplacedApplicationVersion(root) {
  const candidates = [
    join(root, 'app', 'package.json'),
    join(root, 'Contents', 'Resources', 'agent-host-suite', 'package.json'),
    join(root, 'package.json'),
    join(root, 'distribution.json'),
    join(root, 'app', 'distribution.json'),
  ]
  for (const candidate of candidates) {
    const version = await readJsonVersion(candidate)
    if (version !== null) return { version, source: candidate }
  }
  const plist = join(root, 'Contents', 'Info.plist')
  try {
    const text = await readFile(plist, 'utf8')
    const match = text.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/u)
    if (match) return { version: match[1], source: plist }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return null
}

export async function resolveInstalledApplicationVersion(options = {}, dependencies = {}) {
  if (typeof options.currentVersion === 'string' && options.currentVersion.length > 0) {
    return { version: options.currentVersion, source: 'explicit', carrier: null }
  }
  // Prefer the payload already selected for replacement (works on non-darwin fixtures too).
  if (typeof options.currentRoot === 'string' && options.currentRoot.length > 0) {
    const recorded = await readReplacedApplicationVersion(options.currentRoot)
    if (recorded !== null) {
      return { version: recorded.version, source: recorded.source, carrier: null }
    }
  }
  const installed = await (dependencies.resolver ?? resolveApplicationCarrier)(options)
  if (installed?.root) {
    const recorded = await readReplacedApplicationVersion(installed.root)
    if (recorded !== null) {
      return { version: recorded.version, source: recorded.source, carrier: installed }
    }
    return { version: null, source: 'unreadable', carrier: installed }
  }
  return { version: null, source: 'unavailable', carrier: null }
}

export async function packageJsonApplicationVersion() {
  const text = await readFile(new URL('../package.json', import.meta.url), 'utf8')
  return JSON.parse(text).version
}

export async function verifyReplacedApplication({
  root,
  expectedVersion,
  runner = runFile,
  command,
  args,
} = {}) {
  // Prefer the formal payload's version metadata. Do not invent a --version CLI that
  // the shipped agent-host.mjs does not implement.
  if (command === undefined && args === undefined) {
    const recorded = await readReplacedApplicationVersion(root)
    if (recorded === null) {
      fail('APPLICATION_UPDATE_VERSION_MISMATCH', 'The replaced application does not expose a readable version payload', {
        expectedVersion,
        root,
      })
    }
    if (typeof expectedVersion === 'string' && recorded.version !== expectedVersion && !String(recorded.version).includes(expectedVersion)) {
      fail('APPLICATION_UPDATE_VERSION_MISMATCH', 'The replaced application did not report the new version', {
        expectedVersion,
        output: recorded.version,
        source: recorded.source,
      })
    }
    return { version: recorded.version, output: recorded.version, source: recorded.source }
  }
  const launch = await resolveReplacedApplicationLaunch({ root, command, args: args ?? [] })
  const result = await runner(launch.command, launch.args, {
    allowFailure: true,
    timeoutMs: 15_000,
    cwd: root,
    maxBuffer: 64 * 1024,
  })
  if (result.status !== 0) {
    fail('APPLICATION_UPDATE_RELAUNCH_FAILED', 'The replaced application did not start', {
      output: [result.stderr, result.stdout].filter(Boolean).join('\n').slice(0, 2048),
    })
  }
  const output = String(result.stdout ?? '').trim()
  if (typeof expectedVersion === 'string' && !output.includes(expectedVersion)) {
    fail('APPLICATION_UPDATE_VERSION_MISMATCH', 'The replaced application did not report the new version', {
      expectedVersion,
      output: output.slice(0, 2048),
    })
  }
  return { version: expectedVersion, output }
}

export async function resolveManagerRelaunchLaunch({ root, command, args = [], platformName = osPlatform() } = {}) {
  if (typeof command === 'string' && command.length > 0) return { command, args, kind: 'explicit' }
  // Prefer the Manager entry that matches the running OS. A foreign-layout fixture
  // (for example Contents/MacOS on win32) must not win over the native launcher.
  if (platformName !== 'win32') {
    const macosManager = join(root, 'Contents', 'MacOS', 'AgentHostManager')
    if (await pathExists(macosManager)) {
      return { command: macosManager, args, kind: 'macos-manager' }
    }
  }
  if (platformName === 'win32') {
    // Prefer bundled node + CLI over fragile .cmd shims when the payload ships both.
    const windowsNode = join(root, 'runtime', 'node.exe')
    const windowsCli = join(root, 'app', 'bin', 'agent-host.mjs')
    if (await pathExists(windowsNode) && await pathExists(windowsCli)) {
      return {
        command: windowsNode,
        args: [windowsCli, 'manager', ...args],
        kind: 'windows-manager-node',
      }
    }
    const windowsManager = join(root, 'bin', 'Agent Host.cmd')
    if (await pathExists(windowsManager)) {
      return { command: windowsManager, args, kind: 'windows-manager' }
    }
    const windowsManagerNoSpace = join(root, 'bin', 'AgentHost.cmd')
    if (await pathExists(windowsManagerNoSpace)) {
      return { command: windowsManagerNoSpace, args, kind: 'windows-manager' }
    }
    const windowsManagerAlt = join(root, 'bin', 'AgentHostManager.exe')
    if (await pathExists(windowsManagerAlt)) {
      return { command: windowsManagerAlt, args, kind: 'windows-manager' }
    }
  }
  // Fall back to CLI "manager" for directory / Windows payloads that ship the CLI only.
  const cliLaunch = await resolveReplacedApplicationLaunch({ root, args: ['manager'] })
  return { ...cliLaunch, kind: 'cli-manager' }
}

export async function relaunchReplacedApplication({
  root,
  starter,
  runner,
  command,
  args,
  confirmMs = 1_500,
  readyFile,
  readyProbe,
} = {}) {
  const launch = await resolveManagerRelaunchLaunch({
    root,
    command,
    args: args ?? [],
  })
  // Long-running Manager must be detached: runFile waits for exit and kills the tree at timeout.
  // Injected `runner` remains a test shim; production uses startDetachedProcess.
  const start = starter ?? (
    typeof runner === 'function'
      ? async (cmd, cmdArgs, options) => {
        const result = await runner(cmd, cmdArgs, {
          allowFailure: true,
          timeoutMs: options?.confirmMs ?? confirmMs,
          cwd: options?.cwd ?? root,
          maxBuffer: 64 * 1024,
        })
        if (result.timedOut === true) {
          throw new AgentHostError('HOST_COMMAND_TIMEOUT', `${cmd} startup timed out`)
        }
        // Spawn failure / killed tree previously returned status null and was treated as success.
        if (result.status !== 0) {
          throw new AgentHostError(
            'HOST_COMMAND_FAILED',
            `${cmd} failed to stay running`,
            {
              status: result.status,
              output: [result.stderr, result.stdout].filter(Boolean).join('\n').slice(0, 2048),
            },
          )
        }
        return { pid: null, command: cmd, args: cmdArgs, detached: false, status: result.status }
      }
      : startDetachedProcess
  )
  try {
    const started = await start(launch.command, launch.args, {
      cwd: root,
      confirmMs,
      readyFile,
      readyProbe,
    })
    return {
      command: launch.command,
      args: launch.args,
      pid: started.pid ?? null,
      status: started.status,
      kind: launch.kind,
      detached: started.detached === true,
      ready: started.ready,
    }
  } catch (error) {
    fail('APPLICATION_UPDATE_RELAUNCH_FAILED', 'The replaced application could not be restarted', {
      output: error instanceof AgentHostError
        ? (error.details?.output ?? error.message)
        : (error instanceof Error ? error.message : String(error)),
      kind: launch.kind,
      cause: error instanceof AgentHostError ? error.code : undefined,
    })
  }
}

export async function restorePreviousApplication({ currentRoot, previousRoot }) {
  if (typeof currentRoot !== 'string' || typeof previousRoot !== 'string') {
    fail('APPLICATION_UPDATE_INVALID', 'Application recovery requires current and previous directories')
  }
  if (await pathExists(previousRoot) !== true) {
    fail('APPLICATION_UPDATE_RECOVERY_UNAVAILABLE', 'The previous application files are not available to restore')
  }
  if (await pathExists(currentRoot) === true) {
    const failed = `${currentRoot}.failed`
    await rm(failed, { recursive: true, force: true })
    await rename(currentRoot, failed)
  }
  await cp(previousRoot, currentRoot, { recursive: true, errorOnExist: true })
  return { currentRoot, previousRoot, restored: true }
}

async function recoverApplicationUpdateUnlocked(stateRoot, { allowReclaimAliveOwner = false } = {}) {
  const journal = await readApplicationUpdateJournal(stateRoot)
  if (TERMINAL_PHASES.has(journal.phase)) return { ...journal, recovered: false }
  // Holding the exclusive lifecycle lock means no concurrent update can still run.
  // An alive Manager PID with a leftover pre-swap phase (download/stage) is abandoned
  // work after a failed transaction released the lease — reclaim so the same process
  // can retry. Mid-swap phases stay live so recovery never rewinds an in-flight replace.
  // Nested callers that already hold the lease keep the live-owner short-circuit.
  if (journalOwnerAlive(journal)) {
    if (allowReclaimAliveOwner === true && ABANDONABLE_PHASES.has(journal.phase)) {
      // fall through and terminalize the abandoned pre-swap journal
    } else {
      return { ...journal, recovered: false, live: true }
    }
  }
  if (journal.phase === 'failed' && journal.restored === true) {
    const recovered = await writeJournal(stateRoot, {
      ...journal,
      phase: 'recovered',
      error: journal.error ?? { code: 'APPLICATION_UPDATE_ALREADY_RESTORED', message: 'The previous application was already restored for this failed update.' },
    })
    await clearUpdateTransactionMarker(journal.currentRoot)
    return { ...recovered, recovered: false }
  }
  if (typeof journal.previousRoot === 'string' && typeof journal.currentRoot === 'string' && await pathExists(journal.previousRoot)) {
    const marker = await readUpdateTransactionMarker(journal.currentRoot)
    const currentExists = await pathExists(journal.currentRoot)
    const markerOk = markerMatchesJournal(marker, journal) === true
    const inFlight = journal.phase === 'failed'
      || journal.phase === 'replacing'
      || journal.phase === 'verifying'
      || journal.phase === 'relaunching'
    // In-flight swap/verify: require txn marker on current, or a mid-replacing hole
    // (current missing after rename). A later user-placed directory without this
    // marker must not be overwritten — including crashes stuck in verifying.
    if (inFlight && markerOk !== true && !(currentExists !== true && journal.phase === 'replacing')) {
      const recovered = await writeJournal(stateRoot, {
        ...journal,
        phase: 'recovered',
        restored: true,
        error: {
          code: 'APPLICATION_UPDATE_RECOVERY_SKIPPED',
          message: 'Recovery skipped because the current application directory no longer belongs to the interrupted update transaction.',
        },
      })
      return { ...recovered, recovered: false }
    }
    await restorePreviousApplication({ currentRoot: journal.currentRoot, previousRoot: journal.previousRoot })
    await clearUpdateTransactionMarker(journal.currentRoot)
    const recovered = await writeJournal(stateRoot, {
      ...journal,
      phase: 'recovered',
      restored: true,
      error: { code: 'APPLICATION_UPDATE_INTERRUPTED', message: 'Application replacement was interrupted and the previous files were restored.' },
    })
    return { ...recovered, recovered: true }
  }
  // Successful download-only left phase=downloaded with cache facts; finalize to a
  // terminal phase so later maintenance does not treat it as an in-flight update.
  if (journal.phase === 'downloaded') {
    const completed = await writeJournal(stateRoot, { ...journal, phase: 'complete', restored: false })
    return { ...completed, recovered: false }
  }
  const failed = await writeJournal(stateRoot, { ...journal, phase: 'failed', restored: false })
  return { ...failed, recovered: false }
}

export async function recoverApplicationUpdate(stateRoot, dependencies = {}) {
  if (stateRoot === undefined) return { ...emptyJournal(), recovered: false }
  if (dependencies.lifecycleLease !== undefined) {
    // Exclusive inherited lease ⇒ no concurrent updater. Reclaim abandoned pre-swap
    // journals (download-only leftovers, failed mid-download) even if the prior owner
    // PID is still the long-lived Manager. Mid-swap phases stay protected.
    return recoverApplicationUpdateUnlocked(stateRoot, { allowReclaimAliveOwner: true })
  }
  const paths = statePaths(resolveStateRoot(stateRoot))
  try {
    return await withLifecycleMutation(paths, 'application.recover', dependencies, () => (
      recoverApplicationUpdateUnlocked(stateRoot, { allowReclaimAliveOwner: true })
    ))
  } catch (error) {
    if (error instanceof AgentHostError && error.code === 'LIFECYCLE_BUSY') {
      const journal = await readApplicationUpdateJournal(stateRoot)
      return { ...journal, recovered: false, live: true }
    }
    throw error
  }
}

async function applyStagedReplacement(options, check, currentVersion, dependencies) {
  const currentRoot = options.currentRoot
  const stagedRoot = options.stagedRoot
  const previousRoot = options.previousRoot ?? `${currentRoot}.previous`
  const payload = await readReplacedApplicationVersion(currentRoot)
  if (payload === null) {
    fail('APPLICATION_UPDATE_VERSION_UNREADABLE', 'Refusing application replace because the installed payload version is unreadable', {
      currentRoot,
    })
  }
  const fromVersion = typeof currentVersion === 'string' ? currentVersion : payload.version
  if (typeof check.availableVersion === 'string' && compareSemVer(payload.version, check.availableVersion) > 0) {
    return {
      ...check,
      applied: false,
      availability: 'current',
      currentVersion: payload.version,
      note: 'Installed application payload is newer than the selected channel candidate; refusing downgrade.',
    }
  }
  const journal = await writeJournal(options.stateRoot, {
    phase: 'replacing',
    channel: check.channel,
    fromVersion,
    toVersion: check.availableVersion,
    currentRoot,
    stagedRoot,
    previousRoot,
    carrierPath: options.carrierPath ?? null,
  })
  try {
    // Stamp the staged tree before swap so a crash after rename still carries txn
    // identity on currentRoot (verifying/relaunching recover can trust the marker).
    const pending = { ...journal, previousRoot, currentRoot, stagedRoot }
    await writeUpdateTransactionMarker(stagedRoot, pending)
    const applied = await applyDirectorySwapUpdate({ currentRoot, stagedRoot, previousRoot })
    const active = { ...journal, previousRoot: applied.previousRoot, currentRoot: applied.currentRoot }
    await writeUpdateTransactionMarker(applied.currentRoot, active)
    await writeJournal(options.stateRoot, { ...active, phase: 'verifying' })
    const verified = await verifyReplacedApplication({
      root: applied.currentRoot,
      expectedVersion: options.expectedVersion ?? check.availableVersion,
      runner: dependencies.runner,
      command: options.verifyCommand,
      args: options.verifyArgs,
    })
    await writeJournal(options.stateRoot, { ...active, phase: 'relaunching' })
    const relaunched = options.relaunch === false
      ? { skipped: true }
      : await relaunchReplacedApplication({
        root: applied.currentRoot,
        starter: dependencies.starter,
        runner: dependencies.runner,
        command: options.relaunchCommand,
        args: options.relaunchArgs,
        confirmMs: options.relaunchConfirmMs,
        readyFile: options.relaunchReadyFile,
        readyProbe: options.relaunchReadyProbe,
      })
    await clearUpdateTransactionMarker(applied.currentRoot)
    await writeJournal(options.stateRoot, { ...active, phase: 'complete', restored: false })
    return { ...check, applied: true, replacement: applied, verified, relaunched, journal: 'complete' }
  } catch (error) {
    const backup = previousRoot
    let restored = false
    if (typeof options.currentRoot === 'string' && typeof backup === 'string' && await pathExists(backup)) {
      try {
        await restorePreviousApplication({ currentRoot: options.currentRoot, previousRoot: backup })
        restored = true
        await clearUpdateTransactionMarker(options.currentRoot)
      } catch {
        restored = false
      }
      await writeJournal(options.stateRoot, {
        ...journal,
        phase: restored ? 'recovered' : 'failed',
        restored,
        previousRoot: backup,
        currentRoot: options.currentRoot,
        error: { code: error instanceof AgentHostError ? error.code : 'APPLICATION_UPDATE_FAILED', message: error instanceof Error ? error.message : String(error) },
      })
    }
    throw error
  }
}

function tarCommand() {
  return process.platform === 'win32' ? 'tar.exe' : '/usr/bin/tar'
}

export async function findStagedApplicationRoot(destination) {
  const macosExec = join(destination, 'Contents', 'MacOS', 'agent-host')
  if (await pathExists(macosExec)) return destination
  const windowsCli = join(destination, 'app', 'bin', 'agent-host.mjs')
  if (await pathExists(windowsCli)) return destination
  const directoryCli = join(destination, 'app', 'bin', 'agent-host.mjs')
  if (await pathExists(directoryCli)) return destination
  const entries = await readdir(destination, { withFileTypes: true }).catch(() => [])
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const child = join(destination, entry.name)
    if (entry.name.endsWith('.app') && await pathExists(join(child, 'Contents', 'MacOS', 'agent-host'))) return child
    const nested = await findStagedApplicationRoot(child).catch(() => null)
    if (typeof nested === 'string') return nested
  }
  return destination
}

export async function stageApplicationCarrier({
  carrierPath,
  destination,
  runner = runFile,
} = {}) {
  if (typeof carrierPath !== 'string' || typeof destination !== 'string') {
    fail('APPLICATION_UPDATE_INVALID', 'Application staging requires a downloaded carrier and destination')
  }
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true, mode: 0o700 })
  const name = basename(carrierPath)
  if (name.endsWith('.dmg')) {
    if (process.platform !== 'darwin') {
      fail('APPLICATION_UPDATE_STAGE_UNAVAILABLE', 'Mounting a macOS disk image requires macOS')
    }
    const mountpoint = `${destination}.mount`
    await rm(mountpoint, { recursive: true, force: true })
    await mkdir(mountpoint, { recursive: true, mode: 0o700 })
    try {
      await runner('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountpoint, carrierPath], {
        timeoutMs: 60_000,
        maxBuffer: 64 * 1024,
      })
      const entries = await readdir(mountpoint)
      const app = entries.find((item) => item.endsWith('.app'))
      if (app === undefined) fail('APPLICATION_UPDATE_STAGE_UNAVAILABLE', 'The disk image does not contain Agent Host.app')
      await cp(join(mountpoint, app), join(destination, app), { recursive: true })
    } finally {
      await runner('hdiutil', ['detach', mountpoint, '-force'], { allowFailure: true, timeoutMs: 30_000 }).catch(() => {})
      await rm(mountpoint, { recursive: true, force: true }).catch(() => {})
    }
    return findStagedApplicationRoot(destination)
  }
  if (name.endsWith('.zip') || name.endsWith('.tar.gz') || name.endsWith('.tgz')) {
    await runner(tarCommand(), ['-xf', carrierPath, '-C', destination], {
      timeoutMs: 120_000,
      maxBuffer: 64 * 1024,
    })
    return findStagedApplicationRoot(destination)
  }
  fail('APPLICATION_UPDATE_STAGE_UNAVAILABLE', `Unsupported application carrier: ${name}`)
}

async function runApply(options, check, currentVersion, dependencies) {
  if (options.stateRoot === undefined) return applyStagedReplacement(options, check, currentVersion, dependencies)
  const paths = statePaths(resolveStateRoot(options.stateRoot))
  return withLifecycleMutation(paths, 'application.update', dependencies, async (locked) => (
    applyStagedReplacement(options, check, currentVersion, locked)
  ))
}

async function markApplicationUpdateFailed(stateRoot, check, currentVersion, error) {
  if (stateRoot === undefined) return
  const prior = await readApplicationUpdateJournal(stateRoot).catch(() => emptyJournal())
  // applyStagedReplacement already writes recovered/failed for swap errors — do not clobber.
  if (!ABANDONABLE_PHASES.has(prior.phase)) return
  await writeJournal(stateRoot, {
    ...prior,
    phase: 'failed',
    channel: check?.channel ?? prior.channel ?? 'stable',
    fromVersion: currentVersion ?? prior.fromVersion ?? null,
    toVersion: check?.availableVersion ?? prior.toVersion ?? null,
    restored: false,
    error: {
      code: error instanceof AgentHostError ? error.code : 'APPLICATION_UPDATE_FAILED',
      message: error instanceof Error ? error.message : String(error),
    },
  })
}

async function mutateApplicationUpdate(effective, check, currentVersion, installed, dependencies) {
  const stateRoot = effective.stateRoot
  try {
    return await mutateApplicationUpdateBody(effective, check, currentVersion, installed, dependencies)
  } catch (error) {
    // Lease is still held here. Terminalize the journal so a long-lived Manager can retry
    // after RELEASE_DOWNLOAD_FAILED (and similar) instead of seeing APPLICATION_UPDATE_BUSY.
    await markApplicationUpdateFailed(stateRoot, check, currentVersion, error).catch(() => {})
    throw error
  }
}

async function mutateApplicationUpdateBody(effective, check, currentVersion, installed, dependencies) {
  const stateRoot = effective.stateRoot
  if ((effective.applyKind === 'directory-swap' || (typeof effective.currentRoot === 'string' && typeof effective.stagedRoot === 'string'))
    && typeof effective.currentRoot === 'string' && typeof effective.stagedRoot === 'string') {
    return applyStagedReplacement(effective, check, currentVersion, dependencies)
  }

  let downloaded = null
  if (check.carrier !== null) {
    const paths = await prepareStatePaths(stateRoot)
    await mkdir(paths.downloads, { recursive: true, mode: 0o700 })
    // Isolate download filenames under the lease; never clear another txn's recovery fields.
    const destination = join(paths.downloads, check.carrier.filename)
    await writeJournal(stateRoot, {
      phase: 'downloading',
      channel: check.channel,
      fromVersion: currentVersion,
      toVersion: check.availableVersion,
      carrierPath: destination,
      currentRoot: null,
      previousRoot: null,
      stagedRoot: null,
    })
    downloaded = await downloadApplicationCarrier(check, {
      destination,
      fetch: effective.fetch,
      signal: effective.signal,
      expectedSha256: check.carrier.sha256 ?? null,
    })
    await writeJournal(stateRoot, {
      phase: 'downloaded',
      channel: check.channel,
      fromVersion: currentVersion,
      toVersion: check.availableVersion,
      carrierPath: downloaded.path,
      currentRoot: null,
      previousRoot: null,
      stagedRoot: null,
    })
  } else if (check.carrier !== null && effective.destination !== undefined) {
    downloaded = await downloadApplicationCarrier(check, {
      destination: effective.destination,
      fetch: effective.fetch,
      signal: effective.signal,
      expectedSha256: check.carrier.sha256 ?? null,
    })
  }

  const downloadedRecord = downloaded === null ? null : { path: downloaded.path, sha256: downloaded.sha256, bytes: downloaded.bytes }

  if (effective.downloadOnly === true) {
    if (downloaded !== null) {
      // Leave the transaction terminal/idle-compatible: keep carrier refs, clear live ownership semantics.
      await writeJournal(stateRoot, {
        phase: 'complete',
        channel: check.channel,
        fromVersion: currentVersion,
        toVersion: check.availableVersion,
        carrierPath: downloaded.path,
        currentRoot: null,
        previousRoot: null,
        stagedRoot: null,
        restored: false,
      })
    }
    return {
      ...check,
      applied: false,
      downloaded: downloadedRecord,
      dryRun: false,
      note: downloaded === null
        ? check.note
        : 'Installer downloaded and verified. It was not applied because only automatic download is enabled.',
    }
  }

  const currentRoot = effective.currentRoot ?? installed?.root
  if (downloaded !== null && typeof currentRoot === 'string') {
    const paths = await prepareStatePaths(stateRoot)
    const stagingHome = join(paths.downloads, `staged-${check.availableVersion}`)
    try {
      await writeJournal(stateRoot, {
        phase: 'staging',
        channel: check.channel,
        fromVersion: currentVersion,
        toVersion: check.availableVersion,
        carrierPath: downloaded.path,
        currentRoot,
        stagedRoot: stagingHome,
        previousRoot: null,
      })
      const stagedRoot = await stageApplicationCarrier({
        carrierPath: downloaded.path,
        destination: stagingHome,
        runner: dependencies.runner ?? runFile,
      })
      return {
        ...await applyStagedReplacement({
          ...effective,
          applyKind: 'directory-swap',
          currentRoot,
          stagedRoot,
          carrierPath: downloaded.path,
        }, check, currentVersion, dependencies),
        downloaded: downloadedRecord,
      }
    } catch (error) {
      if (error instanceof AgentHostError && error.code === 'APPLICATION_UPDATE_STAGE_UNAVAILABLE') {
        await writeJournal(stateRoot, {
          phase: 'complete',
          channel: check.channel,
          fromVersion: currentVersion,
          toVersion: check.availableVersion,
          carrierPath: downloaded.path,
          currentRoot: null,
          previousRoot: null,
          stagedRoot: null,
          restored: false,
        })
        return {
          ...check,
          applied: false,
          downloaded: downloadedRecord,
          error: { code: error.code, message: error.message },
          note: 'Installer downloaded and verified. This environment cannot mount or unpack that carrier to replace Agent Host.',
        }
      }
      throw error
    }
  }

  if (downloaded !== null) {
    await writeJournal(stateRoot, {
      phase: 'complete',
      channel: check.channel,
      fromVersion: currentVersion,
      toVersion: check.availableVersion,
      carrierPath: downloaded.path,
      currentRoot: null,
      previousRoot: null,
      stagedRoot: null,
      restored: false,
    })
  }
  return {
    ...check,
    applied: false,
    downloaded: downloadedRecord,
    availability: check.carrier === null ? 'no-platform-asset' : check.availability,
    candidate: check.carrier,
    verification: {
      command: 'node scripts/verify-application-update.mjs --fixture',
      macos: 'Download the DMG, compare SHA-256, Control-click Open, then agent-host app update on that Mac.',
      windows: 'Download the ZIP, compare SHA-256, extract, then run the installer. SmartScreen may warn.',
    },
    note: downloaded === null
      ? 'This environment cannot replace a macOS app or Windows install. Candidate metadata is returned instead of a mocked system replacement.'
      : 'Installer downloaded and verified. Replacement runs when Agent Host is installed as a macOS app or Windows payload.',
  }
}

export async function updateApplication(options = {}, dependencies = {}) {
  const platform = options.platform ?? supportedReleasePlatform()
  // Public CLI / Manager omit --state-root; resolve the same default used by other state APIs.
  const stateRoot = resolveStateRoot(options.stateRoot)
  const effective = { ...options, stateRoot }
  if (effective.skipRecovery !== true) {
    const recovery = await recoverApplicationUpdate(stateRoot, dependencies).catch(() => null)
    // Only treat an in-flight journal as blocking. A busy lock with an idle journal is
    // handled when this mutation tries to acquire its own lifecycle lease.
    if (recovery?.live === true && LIVE_PHASES.has(recovery.phase)) {
      fail('APPLICATION_UPDATE_BUSY', 'Another application update is in progress; refusing to overwrite the recovery journal', {
        phase: recovery.phase ?? null,
        pid: recovery.pid ?? null,
      })
    }
  }
  const resolved = await resolveInstalledApplicationVersion(effective, dependencies)
  const installed = resolved.carrier ?? await (dependencies.resolver ?? resolveApplicationCarrier)(effective)
  // Never substitute the runner entry package.json for an installed payload version (F4).
  let currentVersion = effective.currentVersion ?? resolved.version ?? null
  const preferences = await readUpdatePreferences(stateRoot).catch(() => ({ channel: 'stable' }))
  const channel = effective.channel ?? preferences.channel ?? 'stable'
  const check = await checkApplicationUpdate({
    fetch: effective.fetch,
    signal: effective.signal,
    channel,
    currentVersion,
    platform,
  })
  if (effective.dryRun === true) {
    return { ...check, dryRun: true, applied: false, downloaded: null, note: `${check.note} This is a preview; files were not replaced.` }
  }
  if (check.availability === 'current') return { ...check, applied: false }
  if (check.availability === 'check-failed') return check
  if (check.availability === 'version-unknown') {
    // Still allow download-only metadata flows, but never replace without a readable payload version.
    if (effective.downloadOnly !== true
      && (effective.applyKind === 'directory-swap'
        || (typeof effective.currentRoot === 'string' && typeof effective.stagedRoot === 'string')
        || installed?.root !== undefined)) {
      fail('APPLICATION_UPDATE_VERSION_UNREADABLE', 'Refusing application replace because the installed payload version is unreadable')
    }
  }
  // Plain update never downgrades; explicit rollback/recovery is a separate path.
  if (typeof currentVersion === 'string' && typeof check.availableVersion === 'string'
    && compareSemVer(currentVersion, check.availableVersion) > 0) {
    return { ...check, applied: false, availability: 'current', note: 'Installed application is newer than the selected channel candidate; refusing downgrade.' }
  }

  const willMutate = check.carrier !== null
    || (typeof effective.currentRoot === 'string' && typeof effective.stagedRoot === 'string')
    || effective.applyKind === 'directory-swap'
  if (!willMutate) {
    return {
      ...check,
      applied: false,
      downloaded: null,
      availability: check.carrier === null ? 'no-platform-asset' : check.availability,
      candidate: check.carrier,
      verification: {
        command: 'node scripts/verify-application-update.mjs --fixture',
        macos: 'Download the DMG, compare SHA-256, Control-click Open, then agent-host app update on that Mac.',
        windows: 'Download the ZIP, compare SHA-256, extract, then run the installer. SmartScreen may warn.',
      },
      note: 'This environment cannot replace a macOS app or Windows install. Candidate metadata is returned instead of a mocked system replacement.',
    }
  }

  const paths = statePaths(stateRoot)
  try {
    return await withLifecycleMutation(paths, 'application.update', dependencies, async (locked) => {
      // Re-validate payload version under the lifecycle lease before journal/stage/swap.
      const lockedResolved = await resolveInstalledApplicationVersion(effective, locked)
      const liveVersion = effective.currentVersion ?? lockedResolved.version
      if (liveVersion === null
        && effective.downloadOnly !== true
        && (typeof effective.currentRoot === 'string' || lockedResolved.carrier?.root !== undefined || installed?.root !== undefined)) {
        fail('APPLICATION_UPDATE_VERSION_UNREADABLE', 'Refusing application replace because the installed payload version is unreadable under lock')
      }
      if (typeof liveVersion === 'string' && typeof check.availableVersion === 'string'
        && compareSemVer(liveVersion, check.availableVersion) > 0) {
        return {
          ...check,
          currentVersion: liveVersion,
          applied: false,
          availability: 'current',
          note: 'Installed application is newer than the selected channel candidate; refusing downgrade.',
        }
      }
      const liveInstalled = lockedResolved.carrier ?? installed
      return mutateApplicationUpdate(effective, { ...check, currentVersion: liveVersion ?? check.currentVersion }, liveVersion, liveInstalled, locked)
    })
  } catch (error) {
    if (error instanceof AgentHostError && error.code === 'LIFECYCLE_BUSY') {
      fail('APPLICATION_UPDATE_BUSY', 'Another application update is in progress; refusing to overwrite the recovery journal')
    }
    throw error
  }
}
