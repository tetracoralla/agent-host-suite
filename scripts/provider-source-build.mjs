import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { runFile } from '../src/process.mjs'

export const ARMORIAL_COMPATIBILITY_VERSION = '0.7.0'
export const FILE_VITALS_COMPATIBILITY_VERSION = '0.3.3'

const INSTALL_TIMEOUT_MS = 180_000
const BUILD_TIMEOUT_MS = 300_000
const COMMAND_OUTPUT_LIMIT = 8 * 1024 * 1024
const ARCHIVE_LIMIT = 128 * 1024 * 1024
const ARCHIVE_ENTRY_LIMIT = 20_000
const ARCHIVE_ENTRY_EXPANDED_LIMIT = 256 * 1024 * 1024
const ARCHIVE_TOTAL_EXPANDED_LIMIT = 1024 * 1024 * 1024
const ARCHIVE_INSPECTION_TIMEOUT_MS = 15_000

export function fileVitalsSourceBuildRequired({
  sourcePolicy,
  reuseRequested,
  pluginRootOverride,
  archiveOverride,
}) {
  const overrides = [pluginRootOverride, archiveOverride]
  const overrideCount = overrides.filter((value) => value !== undefined).length
  if (overrideCount === 1) {
    throw new Error('File Vitals Provider override requires both plugin root and archive')
  }
  if (overrideCount > 0 && sourcePolicy !== 'local-development') {
    throw new Error('File Vitals Provider override is development-only')
  }
  if (overrideCount > 0 && reuseRequested) {
    throw new Error('File Vitals Provider override cannot be combined with component reuse')
  }
  return !reuseRequested && overrideCount === 0
}

async function sha256(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

function parseManifest(text, label) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} is not valid JSON`)
  }
}

async function archiveManifest(archivePath, path, runner) {
  const result = await runner('/usr/bin/tar', ['-xOzf', archivePath, path], {
    timeoutMs: 15_000,
    maxBuffer: 64 * 1024,
  })
  return parseManifest(result.stdout, path)
}

function normalizedArchiveEntry(value) {
  return value.replace(/^\.\//u, '').replace(/\/$/u, '')
}

function archiveCollisionKey(value, targetFilesystem) {
  const normalized = normalizedArchiveEntry(value)
  if (targetFilesystem === 'portable-case-sensitive') return normalized
  if (targetFilesystem !== 'macos-default') throw new Error(`Unsupported Provider archive target filesystem: ${targetFilesystem}`)
  return normalized
    .split('/')
    .map((part) => part.normalize('NFD').toUpperCase().toLowerCase().normalize('NFD'))
    .join('/')
}

function safeArchiveEntry(value, expectedRoot) {
  if (value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value) || value.includes('\\') || value.startsWith('/')) return false
  const normalized = normalizedArchiveEntry(value)
  const parts = normalized.split('/')
  return normalized !== ''
    && !parts.includes('')
    && !parts.includes('.')
    && !parts.includes('..')
    && (normalized === expectedRoot || normalized.startsWith(`${expectedRoot}/`))
}

function archiveFileSize(line, label) {
  const match = line.match(/^\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s+/u)
  if (match === null) throw new Error(`${label} archive inventory could not establish one member size`)
  const bytes = Number(match[1])
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > ARCHIVE_ENTRY_EXPANDED_LIMIT) {
    throw new Error(`${label} archive contains a member outside the expanded-size limit`)
  }
  return bytes
}

export async function inspectProviderPluginArchive({
  archivePath,
  expectedRoot,
  label = 'Provider',
  runner = runFile,
  now = Date.now,
  targetFilesystem = 'portable-case-sensitive',
}) {
  const started = now()
  const remaining = () => {
    const value = ARCHIVE_INSPECTION_TIMEOUT_MS - (now() - started)
    if (value <= 0) throw new Error(`${label} archive inspection exceeded its total time limit`)
    return value
  }
  if (typeof expectedRoot !== 'string' || expectedRoot.length === 0 || expectedRoot.includes('/')
    || expectedRoot.includes('\\') || expectedRoot === '.' || expectedRoot === '..') {
    throw new Error(`${label} archive root is invalid`)
  }
  const archiveInfo = await lstat(archivePath)
  if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.size < 1 || archiveInfo.size > ARCHIVE_LIMIT) {
    throw new Error(`${label} archive is not one bounded regular compressed input`)
  }
  const listing = await runner('/usr/bin/tar', ['-tzf', archivePath], {
    timeoutMs: remaining(),
    maxBuffer: 4 * 1024 * 1024,
  })
  remaining()
  const entries = listing.stdout.split('\n').filter(Boolean)
  if (entries.length === 0 || entries.length > ARCHIVE_ENTRY_LIMIT) throw new Error(`${label} archive has an invalid entry count`)
  if (entries.some((entry) => !safeArchiveEntry(entry, expectedRoot))) throw new Error(`${label} archive contains an unsafe path`)
  if (!['portable-case-sensitive', 'macos-default'].includes(targetFilesystem)) {
    throw new Error(`${label} archive target filesystem is invalid`)
  }
  const normalized = entries.map(normalizedArchiveEntry)
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} archive repeats a normalized path`)
  if (targetFilesystem === 'macos-default') {
    if (entries.some((entry) => entry.includes('\uFFFD'))) {
      throw new Error(`${label} archive contains a filename that cannot be represented safely on the target filesystem`)
    }
    const targetKeys = entries.map((entry) => archiveCollisionKey(entry, targetFilesystem))
    if (new Set(targetKeys).size !== targetKeys.length) {
      throw new Error(`${label} archive contains paths that collide on the macOS target filesystem`)
    }
  }
  const detailed = await runner('/usr/bin/tar', ['-tvzf', archivePath], {
    timeoutMs: remaining(),
    maxBuffer: 8 * 1024 * 1024,
  })
  remaining()
  const verboseLines = detailed.stdout.split('\n').filter(Boolean)
  if (verboseLines.length !== entries.length || verboseLines.length > ARCHIVE_ENTRY_LIMIT) {
    throw new Error(`${label} archive has inconsistent inventory views`)
  }
  let expandedBytes = 0
  let fileCount = 0
  for (const line of verboseLines) {
    // BSD tar and GNU tar both begin verbose entries with the member type.
    // The later extraction accepts only regular files and directories.
    if (!['-', 'd'].includes(line[0])) throw new Error(`${label} archive contains a linked or special archive member`)
    if (line[0] === '-') {
      const bytes = archiveFileSize(line, label)
      expandedBytes += bytes
      fileCount += 1
      if (!Number.isSafeInteger(expandedBytes) || expandedBytes > ARCHIVE_TOTAL_EXPANDED_LIMIT) {
        throw new Error(`${label} archive exceeds the cumulative expanded-size limit`)
      }
    }
  }
  return {
    archiveBytes: archiveInfo.size,
    entries,
    fileCount,
    expandedBytes,
    limits: {
      archiveBytes: ARCHIVE_LIMIT,
      entries: ARCHIVE_ENTRY_LIMIT,
      entryExpandedBytes: ARCHIVE_ENTRY_EXPANDED_LIMIT,
      totalExpandedBytes: ARCHIVE_TOTAL_EXPANDED_LIMIT,
      inspectionMs: ARCHIVE_INSPECTION_TIMEOUT_MS,
    },
  }
}

export async function extractVerifiedProviderPluginArchive({
  sourceArchive,
  archiveWork,
  expectedRoot,
  expectedSha256,
  label = 'Provider',
  targetFilesystem = 'portable-case-sensitive',
  runner = runFile,
}) {
  const boundArchive = join(archiveWork, 'provider-plugin.tar.gz')
  const extracted = join(archiveWork, 'contents')
  try {
    const sourceInspection = await inspectProviderPluginArchive({
      archivePath: sourceArchive,
      expectedRoot,
      label,
      targetFilesystem,
      runner,
    })
    const sourceDigest = await sha256(sourceArchive)
    if (expectedSha256 !== undefined && expectedSha256 !== `sha256:${sourceDigest}`) {
      throw new Error(`${label} archive digest changed after the verified source build`)
    }
    await mkdir(archiveWork, { recursive: true, mode: 0o700 })
    await copyFile(sourceArchive, boundArchive, constants.COPYFILE_EXCL)
    const inspection = await inspectProviderPluginArchive({
      archivePath: boundArchive,
      expectedRoot,
      label,
      targetFilesystem,
      runner,
    })
    const copiedDigest = await sha256(boundArchive)
    if (
      inspection.archiveBytes !== sourceInspection.archiveBytes
      || copiedDigest !== sourceDigest
      || (expectedSha256 !== undefined && expectedSha256 !== `sha256:${copiedDigest}`)
    ) {
      throw new Error(`${label} archive bytes changed while the private copy was created`)
    }
    await mkdir(extracted, { mode: 0o700 })
    await runner('/usr/bin/tar', ['-xzf', boundArchive, '-C', extracted, '--no-same-owner'], {
      timeoutMs: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    return { archivePath: boundArchive, extractedRoot: join(extracted, expectedRoot), inspection }
  } catch (error) {
    await rm(archiveWork, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

export async function buildFileVitalsPluginFromSource({
  sourceRoot,
  scratchRoot,
  sourceObservation,
  runner = runFile,
  copier = copyFile,
}) {
  if (
    !/^[0-9a-f]{40}$/u.test(sourceObservation?.revision ?? '')
    || !['local-development', 'local-clean', 'remote-tagged'].includes(sourceObservation?.sourcePolicy)
    || (sourceObservation.sourcePolicy === 'remote-tagged' && sourceObservation.remoteVerified !== true)
  ) {
    throw new Error('File Vitals source build requires one recorded source revision')
  }
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('File Vitals Host component source build currently requires darwin-arm64')
  }
  const source = await realpath(sourceRoot)
  const scratch = await realpath(scratchRoot)
  const plugin = parseManifest(
    await readFile(join(source, '.codex-plugin/plugin.json'), 'utf8'),
    'File Vitals plugin manifest',
  )
  if (plugin.name !== 'file-vitals' || plugin.version !== FILE_VITALS_COMPATIBILITY_VERSION) {
    throw new Error(`File Vitals source must declare file-vitals@${FILE_VITALS_COMPATIBILITY_VERSION}`)
  }
  const buildScript = join(source, 'scripts/build_plugin.sh')
  const buildScriptInfo = await lstat(buildScript)
  if (!buildScriptInfo.isFile() || buildScriptInfo.isSymbolicLink()) {
    throw new Error('File Vitals source build script is unsafe')
  }

  const bundleName = `file-vitals-${FILE_VITALS_COMPATIBILITY_VERSION}-darwin-arm64`
  const sourceReleaseRoot = join(source, 'dist/plugin')
  const sourceArchive = join(sourceReleaseRoot, `${bundleName}.tar.gz`)
  const sourceChecksum = `${sourceArchive}.sha256`
  const releaseDirectory = join(scratch, 'file-vitals-source-release')
  try {
    await mkdir(releaseDirectory, { mode: 0o700 })
    await runner('/bin/bash', ['scripts/build_plugin.sh', '--replace'], {
      cwd: source,
      env: { ...process.env },
      timeoutMs: BUILD_TIMEOUT_MS,
      maxBuffer: COMMAND_OUTPUT_LIMIT,
    })
    const archivePath = join(releaseDirectory, `${bundleName}.tar.gz`)
    const checksumPath = `${archivePath}.sha256`
    const sourceArchiveInfo = await lstat(sourceArchive)
    if (
      !sourceArchiveInfo.isFile()
      || sourceArchiveInfo.isSymbolicLink()
      || sourceArchiveInfo.size < 1
      || sourceArchiveInfo.size > ARCHIVE_LIMIT
    ) {
      throw new Error('File Vitals source build archive is not one bounded regular compressed input')
    }
    const sourceChecksumInfo = await lstat(sourceChecksum)
    if (
      !sourceChecksumInfo.isFile()
      || sourceChecksumInfo.isSymbolicLink()
      || sourceChecksumInfo.size < 1
      || sourceChecksumInfo.size > 4096
    ) {
      throw new Error('File Vitals source build checksum is not one bounded regular file')
    }
    const sourceArchiveInspection = await inspectProviderPluginArchive({
      archivePath: sourceArchive,
      expectedRoot: bundleName,
      label: 'File Vitals source build',
      targetFilesystem: 'macos-default',
      runner,
    })
    const sourceDigest = await sha256(sourceArchive)
    if (await readFile(sourceChecksum, 'utf8') !== `${sourceDigest}  ${bundleName}.tar.gz\n`) {
      throw new Error('File Vitals source build checksum does not match its archive bytes')
    }
    await copier(sourceArchive, archivePath, constants.COPYFILE_EXCL)
    await copier(sourceChecksum, checksumPath, constants.COPYFILE_EXCL)
    const archive = await inspectProviderPluginArchive({
      archivePath,
      expectedRoot: bundleName,
      label: 'File Vitals copied source build',
      targetFilesystem: 'macos-default',
      runner,
    })
    const digest = await sha256(archivePath)
    if (
      digest !== sourceDigest
      || await readFile(checksumPath, 'utf8') !== `${digest}  ${bundleName}.tar.gz\n`
      || archive.fileCount !== sourceArchiveInspection.fileCount
      || archive.expandedBytes !== sourceArchiveInspection.expandedBytes
    ) {
      throw new Error('File Vitals copied source build differs from its inspected source archive')
    }
    const required = [
      `${bundleName}/.codex-plugin/plugin.json`,
      `${bundleName}/capabilities/provider.json`,
      `${bundleName}/runtime/finspect`,
      `${bundleName}/runtime/file-vitals-capability`,
      `${bundleName}/runtime/file-vitals-transport-schema-probe`,
    ]
    for (const path of required) {
      if (!archive.entries.includes(path)) throw new Error(`File Vitals source build omitted ${path}`)
    }
    const releasedPlugin = await archiveManifest(
      archivePath,
      `${bundleName}/.codex-plugin/plugin.json`,
      runner,
    )
    const provider = await archiveManifest(
      archivePath,
      `${bundleName}/capabilities/provider.json`,
      runner,
    )
    const implementation = provider.implementations?.find(
      (candidate) => candidate?.capabilityId === 'org.openadam.file.inspect'
        && candidate?.capabilityVersion === '0.1.0',
    )
    if (
      releasedPlugin.name !== 'file-vitals'
      || releasedPlugin.version !== FILE_VITALS_COMPATIBILITY_VERSION
      || provider.provider?.id !== 'io.github.tetracoralla.file-vitals'
      || provider.provider?.version !== FILE_VITALS_COMPATIBILITY_VERSION
      || implementation?.adapter?.protocol !== 'openadam.capability-jsonl.v0.1'
      || implementation.adapter.command !== './runtime/file-vitals-capability'
      || JSON.stringify(implementation.adapter.args ?? []) !== '[]'
      || (implementation.adapter.cwd ?? '.') !== '.'
    ) {
      throw new Error('File Vitals source build archive identity or launcher differs from the Host contract')
    }
    return {
      archivePath,
      pluginRoot: join(sourceReleaseRoot, bundleName),
      archiveRoot: bundleName,
      version: FILE_VITALS_COMPATIBILITY_VERSION,
      sha256: `sha256:${digest}`,
      sourceRevision: sourceObservation.revision,
      sourcePolicy: sourceObservation.sourcePolicy,
    }
  } catch (error) {
    await rm(releaseDirectory, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

export async function buildArmorialPluginFromVerifiedSource({
  sourceRoot,
  scratchRoot,
  sourceObservation,
  runner = runFile,
}) {
  if (sourceObservation?.sourcePolicy !== 'remote-tagged' || sourceObservation.remoteVerified !== true
    || !/^[0-9a-f]{40}$/u.test(sourceObservation.revision ?? '')) {
    throw new Error('Armorial source build requires one verified remote-tagged source revision')
  }
  const source = await realpath(sourceRoot)
  const scratch = await realpath(scratchRoot)
  const pkg = parseManifest(await readFile(join(source, 'package.json'), 'utf8'), 'source package manifest')
  if (pkg.name !== 'armorial' || pkg.version !== ARMORIAL_COMPATIBILITY_VERSION
    || typeof pkg.scripts?.['release:plugin'] !== 'string' || pkg.scripts['release:plugin'].trim().length === 0) {
    throw new Error(`Armorial verified source must declare armorial@${ARMORIAL_COMPATIBILITY_VERSION} and release:plugin`)
  }
  const lockInfo = await lstat(join(source, 'package-lock.json'))
  if (!lockInfo.isFile() || lockInfo.isSymbolicLink()) throw new Error('Armorial verified source lockfile is unsafe')

  const releaseDirectory = join(scratch, 'armorial-source-release')
  await mkdir(releaseDirectory, { mode: 0o700 })
  const environment = {
    ...process.env,
    ARMORIAL_RELEASE_DIRECTORY: releaseDirectory,
    npm_config_update_notifier: 'false',
  }
  try {
    await runner('/usr/bin/env', ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: source,
      env: environment,
      timeoutMs: INSTALL_TIMEOUT_MS,
      maxBuffer: COMMAND_OUTPUT_LIMIT,
    })
    await runner('/usr/bin/env', ['npm', 'run', 'release:plugin'], {
      cwd: source,
      env: environment,
      timeoutMs: BUILD_TIMEOUT_MS,
      maxBuffer: COMMAND_OUTPUT_LIMIT,
    })

    const archiveName = `armorial-${pkg.version}-codex-plugin-macos-arm64.tar.gz`
    const archivePath = join(releaseDirectory, archiveName)
    const checksumPath = `${archivePath}.sha256`
    const entries = (await readdir(releaseDirectory)).sort()
    if (entries.length !== 2 || entries[0] !== archiveName || entries[1] !== `${archiveName}.sha256`) {
      throw new Error('Armorial source build published an unexpected release-directory inventory')
    }
    const archiveInfo = await lstat(archivePath)
    const checksumInfo = await lstat(checksumPath)
    if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.size < 1 || archiveInfo.size > ARCHIVE_LIMIT
      || !checksumInfo.isFile() || checksumInfo.isSymbolicLink()) {
      throw new Error('Armorial source build published unsafe release files')
    }
    const digest = await sha256(archivePath)
    if (await readFile(checksumPath, 'utf8') !== `${digest}  ${basename(archivePath)}\n`) {
      throw new Error('Armorial source build checksum does not match its archive bytes')
    }
    const archive = await inspectProviderPluginArchive({
      archivePath,
      expectedRoot: 'armorial',
      label: 'Armorial source build',
      targetFilesystem: 'macos-default',
      runner,
    })
    for (const required of ['armorial/package.json', 'armorial/.codex-plugin/plugin.json']) {
      if (!archive.entries.includes(required)) throw new Error(`Armorial source build omitted ${required}`)
    }
    const packageManifest = await archiveManifest(archivePath, 'armorial/package.json', runner)
    const pluginManifest = await archiveManifest(archivePath, 'armorial/.codex-plugin/plugin.json', runner)
    if (packageManifest.name !== 'armorial' || pluginManifest.name !== 'armorial'
      || packageManifest.version !== pkg.version || pluginManifest.version !== pkg.version) {
      throw new Error('Armorial source build archive identity differs from the verified source package')
    }
    return {
      archivePath,
      version: pkg.version,
      sha256: `sha256:${digest}`,
      sourceRevision: sourceObservation.revision,
      sourcePolicy: sourceObservation.sourcePolicy,
    }
  } catch (error) {
    await rm(releaseDirectory, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}
