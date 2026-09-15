import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { platform } from 'node:os'
import { pipeline } from 'node:stream/promises'
import { runFile } from './process.mjs'

const ARCHIVE_LIMIT = 128 * 1024 * 1024
const ARCHIVE_ENTRY_LIMIT = 20_000
const ARCHIVE_ENTRY_EXPANDED_LIMIT = 256 * 1024 * 1024
const ARCHIVE_TOTAL_EXPANDED_LIMIT = 1024 * 1024 * 1024
const ARCHIVE_INSPECTION_TIMEOUT_MS = 15_000

function tarCommand() {
  return platform() === 'win32' ? 'tar.exe' : '/usr/bin/tar'
}

async function sha256(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
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
  const match = line.match(/^[d-][rwxsStT-]{9}[+]?\s+\S+\s+(\d+)\s+/u)
    ?? line.match(/^\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s+/u)
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
  const tar = tarCommand()
  const listing = await runner(tar, ['-tzf', archivePath], {
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
  const detailed = await runner(tar, ['-tvzf', archivePath], {
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
    await runner(tarCommand(), ['-xzf', boundArchive, '-C', extracted, '--no-same-owner'], {
      timeoutMs: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    return { archivePath: boundArchive, extractedRoot: join(extracted, expectedRoot), inspection }
  } catch (error) {
    await rm(archiveWork, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}
