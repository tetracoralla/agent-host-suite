import { cp, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
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
import { runFile } from './process.mjs'

export const APPLICATION_UPDATE_SCHEMA = 'openadam.agent-host-application-update.v0.1'
export const APPLICATION_UPDATE_STATE_SCHEMA = 'openadam.agent-host-application-update-state.v0.1'

const HOST_REPO = 'tetracoralla/agent-host-suite'

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
    error: null,
    updatedAt: null,
  }
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
  const record = { ...emptyJournal(), ...value, schemaVersion: APPLICATION_UPDATE_STATE_SCHEMA, updatedAt: new Date().toISOString() }
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
  else if (currentVersion === undefined || currentVersion === null) availability = 'update-available'
  else if (currentVersion !== version) availability = 'update-available'
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

export async function resolveReplacedApplicationLaunch({ root, command, args = ['--version'] } = {}) {
  if (typeof command === 'string' && command.length > 0) return { command, args }
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

export async function verifyReplacedApplication({ root, expectedVersion, runner = runFile, command, args = ['--version'] }) {
  const launch = await resolveReplacedApplicationLaunch({ root, command, args })
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

async function pathExists(path) {
  return stat(path).then(() => true).catch((error) => {
    if (error.code === 'ENOENT') return false
    throw error
  })
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

export async function recoverApplicationUpdate(stateRoot) {
  const journal = await readApplicationUpdateJournal(stateRoot)
  if (journal.phase === 'idle' || journal.phase === 'complete') return { ...journal, recovered: false }
  if (typeof journal.previousRoot === 'string' && typeof journal.currentRoot === 'string' && await pathExists(journal.previousRoot)) {
    await restorePreviousApplication({ currentRoot: journal.currentRoot, previousRoot: journal.previousRoot })
    return writeJournal(stateRoot, {
      ...journal,
      phase: 'recovered',
      error: { code: 'APPLICATION_UPDATE_INTERRUPTED', message: 'Application replacement was interrupted and the previous files were restored.' },
    })
  }
  return writeJournal(stateRoot, { ...journal, phase: 'failed' })
}

async function applyStagedReplacement(options, check, currentVersion, dependencies) {
  const currentRoot = options.currentRoot
  const stagedRoot = options.stagedRoot
  const previousRoot = options.previousRoot ?? `${currentRoot}.previous`
  const journal = await writeJournal(options.stateRoot, {
    phase: 'replacing',
    channel: check.channel,
    fromVersion: currentVersion,
    toVersion: check.availableVersion,
    currentRoot,
    stagedRoot,
    previousRoot,
    carrierPath: options.carrierPath ?? null,
  })
  try {
    const applied = await applyDirectorySwapUpdate({ currentRoot, stagedRoot, previousRoot })
    await writeJournal(options.stateRoot, { ...journal, phase: 'verifying', previousRoot: applied.previousRoot })
    const verified = await verifyReplacedApplication({
      root: applied.currentRoot,
      expectedVersion: options.expectedVersion ?? check.availableVersion,
      runner: dependencies.runner,
      command: options.verifyCommand,
      args: options.verifyArgs ?? ['--version'],
    })
    await writeJournal(options.stateRoot, { ...journal, phase: 'complete', previousRoot: applied.previousRoot })
    return { ...check, applied: true, replacement: applied, verified, journal: 'complete' }
  } catch (error) {
    await recoverApplicationUpdate(options.stateRoot)
    throw error
  }
}

export async function updateApplication(options = {}, dependencies = {}) {
  const platform = options.platform ?? supportedReleasePlatform()
  if (options.stateRoot !== undefined) {
    await recoverApplicationUpdate(options.stateRoot).catch(() => {})
  }
  const installed = await (dependencies.resolver ?? resolveApplicationCarrier)(options)
  const currentVersion = options.currentVersion
    ?? installed?.version
    ?? (await readFile(new URL('../package.json', import.meta.url), 'utf8').then((text) => JSON.parse(text).version))
  const check = await checkApplicationUpdate({
    fetch: options.fetch,
    signal: options.signal,
    channel: options.channel ?? 'stable',
    currentVersion,
    platform,
  })
  if (options.dryRun === true) {
    return { ...check, dryRun: true, applied: false, note: `${check.note} This is a preview; files were not replaced.` }
  }
  if (check.availability === 'current') return { ...check, applied: false }
  if (check.availability === 'check-failed') return check

  const runApply = async (payload) => {
    if (options.stateRoot === undefined) return applyStagedReplacement(payload, check, currentVersion, dependencies)
    const paths = statePaths(resolveStateRoot(options.stateRoot))
    return withLifecycleMutation(paths, 'application.update', dependencies, async () => (
      applyStagedReplacement(payload, check, currentVersion, dependencies)
    ))
  }

  if ((options.applyKind === 'directory-swap' || (typeof options.currentRoot === 'string' && typeof options.stagedRoot === 'string'))
    && typeof options.currentRoot === 'string' && typeof options.stagedRoot === 'string') {
    return runApply(options)
  }

  let downloaded = null
  if (check.carrier !== null && options.stateRoot !== undefined) {
    const paths = await prepareStatePaths(resolveStateRoot(options.stateRoot))
    await mkdir(paths.downloads, { recursive: true, mode: 0o700 })
    const destination = join(paths.downloads, check.carrier.filename)
    await writeJournal(options.stateRoot, {
      phase: 'downloading',
      channel: check.channel,
      fromVersion: currentVersion,
      toVersion: check.availableVersion,
      carrierPath: destination,
    })
    downloaded = await downloadApplicationCarrier(check, {
      destination,
      fetch: options.fetch,
      signal: options.signal,
      expectedSha256: check.carrier.sha256 ?? null,
    })
    await writeJournal(options.stateRoot, {
      phase: 'downloaded',
      channel: check.channel,
      fromVersion: currentVersion,
      toVersion: check.availableVersion,
      carrierPath: downloaded.path,
    })
  } else if (check.carrier !== null && options.destination !== undefined) {
    downloaded = await downloadApplicationCarrier(check, {
      destination: options.destination,
      fetch: options.fetch,
      signal: options.signal,
      expectedSha256: check.carrier.sha256 ?? null,
    })
  }

  if (installed !== null && typeof installed.root === 'string' && (process.platform === 'darwin' || process.platform === 'win32') && typeof options.stagedRoot === 'string') {
    return runApply({
      ...options,
      applyKind: 'directory-swap',
      currentRoot: installed.root,
      stagedRoot: options.stagedRoot,
      carrierPath: downloaded?.path,
    })
  }

  return {
    ...check,
    applied: false,
    downloaded: downloaded === null ? null : { path: downloaded.path, sha256: downloaded.sha256, bytes: downloaded.bytes },
    availability: check.carrier === null ? 'no-platform-asset' : check.availability,
    candidate: check.carrier,
    verification: {
      command: 'node scripts/verify-application-update.mjs --fixture',
      macos: 'Download the DMG, compare SHA-256, Control-click Open, then agent-host app update on that Mac.',
      windows: 'Download the ZIP, compare SHA-256, extract, then run the installer. SmartScreen may warn.',
    },
    note: downloaded === null
      ? 'This environment cannot replace a macOS app or Windows install. Candidate metadata is returned instead of a mocked system replacement.'
      : 'Installer downloaded and verified. Replacement runs when Agent Host is installed as a macOS app or Windows payload with a staged directory.',
  }
}
