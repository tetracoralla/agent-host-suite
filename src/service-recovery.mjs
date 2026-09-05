import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AgentHostError } from './errors.mjs'

const RECOVERY_SCHEMA = 'openadam.agent-host-service-recovery.v0.2'
const RECOVERY_ID = /^service-recovery-v2-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MANIFEST_FILE = 'manifest.json'
const MAC_DESCRIPTOR_FILE = 'launch-agent.plist'
const WINDOWS_LAUNCHER_FILE = 'runtime-service.cmd'
const WINDOWS_TASK_FILE = 'scheduled-task.xml'

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function invalidRecovery() {
  return new AgentHostError('SERVICE_RECOVERY_BUNDLE_INVALID', 'The retained service recovery bundle failed identity or content verification')
}

function exactKeys(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value).sort()
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index])
}

async function ownerOnlyDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory()) throw invalidRecovery()
  await chmod(path, 0o700)
}

async function exclusiveFile(path, bytes) {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(path, 0o600)
}

async function replaceOwnerFile(path, bytes) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    await exclusiveFile(temporary, bytes)
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

function fileRecord(name, bytes, mode) {
  return { name, bytes: bytes.length, sha256: digest(bytes), mode }
}

function byteRecord(bytes) {
  return { bytes: bytes.length, sha256: digest(bytes) }
}

function validByteRecord(value) {
  return exactKeys(value, ['bytes', 'sha256'])
    && Number.isSafeInteger(value.bytes) && value.bytes >= 0
    && /^sha256:[0-9a-f]{64}$/u.test(value.sha256)
}

function validIdentity(value) {
  return /^sha256:[0-9a-f]{64}$/u.test(value ?? '')
}

export function defaultServiceRecoveryRoot(files) {
  return join(dirname(files.configPath), 'service-recovery')
}

export async function persistServiceRecoveryBundle({
  recoveryRoot,
  platform,
  target,
  prior,
  descriptor = null,
  launcher = null,
  taskXml = null,
  replacement,
  lifecycle,
}) {
  await ownerOnlyDirectory(recoveryRoot)
  let identity
  let directory
  for (let attempt = 0; attempt < 8; attempt += 1) {
    identity = `service-recovery-v2-${randomUUID()}`
    directory = join(recoveryRoot, identity)
    try {
      await mkdir(directory, { mode: 0o700 })
      break
    } catch (error) {
      if (error.code !== 'EEXIST' || attempt === 7) throw error
    }
  }
  try {
    const files = {}
    if (platform === 'darwin') {
      if (descriptor === null || launcher !== null || taskXml !== null) throw invalidRecovery()
      await exclusiveFile(join(directory, MAC_DESCRIPTOR_FILE), descriptor.contents)
      files.descriptor = fileRecord(MAC_DESCRIPTOR_FILE, descriptor.contents, descriptor.mode)
    } else if (platform === 'win32') {
      if (launcher === null || taskXml === null || descriptor !== null) throw invalidRecovery()
      const xmlBytes = Buffer.isBuffer(taskXml) ? taskXml : Buffer.from(taskXml)
      await exclusiveFile(join(directory, WINDOWS_LAUNCHER_FILE), launcher.contents)
      await exclusiveFile(join(directory, WINDOWS_TASK_FILE), xmlBytes)
      files.launcher = fileRecord(WINDOWS_LAUNCHER_FILE, launcher.contents, launcher.mode)
      files.taskXml = fileRecord(WINDOWS_TASK_FILE, xmlBytes, 0o600)
    } else {
      throw invalidRecovery()
    }
    const manifest = {
      schemaVersion: RECOVERY_SCHEMA,
      identity,
      phase: 'replacement-pending',
      platform,
      target,
      prior,
      files,
      replacement: {
        identity: replacement.identity,
        file: byteRecord(replacement.fileContents),
        task: replacement.task,
      },
      lifecycle: {
        statePath: lifecycle.statePath,
        currentStateIdentity: lifecycle.currentStateIdentity,
        stateFile: lifecycle.stateContents === null ? null : byteRecord(lifecycle.stateContents),
      },
      failureBinding: null,
    }
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
    await exclusiveFile(join(directory, MANIFEST_FILE), manifestBytes)
    const loaded = await loadServiceRecoveryBundle(recoveryRoot, identity)
    return {
      identity,
      phase: loaded.phase,
      platform,
      manifestSha256: digest(manifestBytes),
      replacementIdentity: loaded.replacement.identity,
      directory: loaded.directory,
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {})
    if (error instanceof AgentHostError) throw error
    throw new AgentHostError('SERVICE_RECOVERY_BUNDLE_WRITE_FAILED', 'The prior service state could not be persisted before replacement')
  }
}

async function verifiedFile(directory, record) {
  if (!exactKeys(record, ['name', 'bytes', 'sha256', 'mode'])
    || typeof record.name !== 'string'
    || !Number.isSafeInteger(record.bytes) || record.bytes < 0
    || !/^sha256:[0-9a-f]{64}$/u.test(record.sha256)
    || !Number.isSafeInteger(record.mode) || record.mode < 0 || record.mode > 0o777) throw invalidRecovery()
  const path = join(directory, record.name)
  const info = await lstat(path).catch(() => null)
  if (info === null || info.isSymbolicLink() || !info.isFile() || info.size !== record.bytes || (info.mode & 0o077) !== 0) throw invalidRecovery()
  const bytes = await readFile(path)
  if (digest(bytes) !== record.sha256) throw invalidRecovery()
  return { contents: bytes, mode: record.mode }
}

export async function loadServiceRecoveryBundle(recoveryRoot, identity) {
  if (typeof recoveryRoot !== 'string' || !RECOVERY_ID.test(identity ?? '')) throw invalidRecovery()
  const rootInfo = await lstat(recoveryRoot).catch(() => null)
  if (rootInfo === null || rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || (rootInfo.mode & 0o077) !== 0) throw invalidRecovery()
  const directory = join(recoveryRoot, identity)
  const directoryInfo = await lstat(directory).catch(() => null)
  if (directoryInfo === null || directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory() || (directoryInfo.mode & 0o077) !== 0) throw invalidRecovery()
  const names = (await readdir(directory)).sort()
  const manifestInfo = await lstat(join(directory, MANIFEST_FILE)).catch(() => null)
  if (manifestInfo === null || manifestInfo.isSymbolicLink() || !manifestInfo.isFile() || (manifestInfo.mode & 0o077) !== 0) throw invalidRecovery()
  const manifestBytes = await readFile(join(directory, MANIFEST_FILE))
  let manifest
  try {
    manifest = JSON.parse(manifestBytes)
  } catch {
    throw invalidRecovery()
  }
  if (!exactKeys(manifest, ['schemaVersion', 'identity', 'phase', 'platform', 'target', 'prior', 'files', 'replacement', 'lifecycle', 'failureBinding'])
    || manifest.schemaVersion !== RECOVERY_SCHEMA || manifest.identity !== identity
    || !['replacement-pending', 'failed-replacement', 'partial-restore'].includes(manifest.phase)
    || !['darwin', 'win32'].includes(manifest.platform)
    || manifest.target === null || typeof manifest.target !== 'object' || Array.isArray(manifest.target)
    || manifest.prior === null || typeof manifest.prior !== 'object' || Array.isArray(manifest.prior)
    || manifest.files === null || typeof manifest.files !== 'object' || Array.isArray(manifest.files)
    || !exactKeys(manifest.replacement, ['identity', 'file', 'task'])
    || !validIdentity(manifest.replacement.identity)
    || !validByteRecord(manifest.replacement.file)
    || manifest.replacement.identity !== manifest.replacement.file.sha256
    || !exactKeys(manifest.lifecycle, ['statePath', 'currentStateIdentity', 'stateFile'])
    || typeof manifest.lifecycle.statePath !== 'string' || manifest.lifecycle.statePath.length === 0
    || !validIdentity(manifest.lifecycle.currentStateIdentity)
    || (manifest.lifecycle.stateFile !== null && !validByteRecord(manifest.lifecycle.stateFile))
    || (manifest.failureBinding !== null && !validFailureBinding(manifest.platform, manifest.failureBinding))
    || (manifest.phase === 'replacement-pending') !== (manifest.failureBinding === null)) throw invalidRecovery()
  let descriptor = null
  let launcher = null
  let taskXml = null
  if (manifest.platform === 'darwin') {
    if (!exactKeys(manifest.replacement.task, ['label']) || typeof manifest.replacement.task.label !== 'string') throw invalidRecovery()
    if (!exactKeys(manifest.files, ['descriptor']) || names.join('\n') !== [MAC_DESCRIPTOR_FILE, MANIFEST_FILE].sort().join('\n')) throw invalidRecovery()
    if (manifest.files.descriptor.name !== MAC_DESCRIPTOR_FILE) throw invalidRecovery()
    descriptor = await verifiedFile(directory, manifest.files.descriptor)
  } else {
    if (!exactKeys(manifest.replacement.task, ['launcherPath', 'taskName'])
      || typeof manifest.replacement.task.launcherPath !== 'string'
      || typeof manifest.replacement.task.taskName !== 'string') throw invalidRecovery()
    if (!exactKeys(manifest.files, ['launcher', 'taskXml'])
      || names.join('\n') !== [MANIFEST_FILE, WINDOWS_LAUNCHER_FILE, WINDOWS_TASK_FILE].sort().join('\n')) throw invalidRecovery()
    if (manifest.files.launcher.name !== WINDOWS_LAUNCHER_FILE || manifest.files.taskXml.name !== WINDOWS_TASK_FILE) throw invalidRecovery()
    launcher = await verifiedFile(directory, manifest.files.launcher)
    taskXml = (await verifiedFile(directory, manifest.files.taskXml)).contents
  }
  return {
    identity,
    phase: manifest.phase,
    platform: manifest.platform,
    target: manifest.target,
    prior: manifest.prior,
    descriptor,
    launcher,
    taskXml,
    replacement: manifest.replacement,
    lifecycle: manifest.lifecycle,
    failureBinding: manifest.failureBinding,
    manifestSha256: digest(manifestBytes),
    directory,
  }
}

function validFailureBinding(platform, value) {
  if (!exactKeys(value, ['carrier', 'task'])) return false
  if (value.carrier !== null && !validByteRecord(value.carrier)) return false
  if (platform === 'darwin') {
    return exactKeys(value.task, ['configured', 'path', 'program', 'state'])
      && (typeof value.task.configured === 'boolean' || value.task.configured === null)
      && (value.task.configured === true
        ? [value.task.path, value.task.program, value.task.state].every((item) => typeof item === 'string' && item.length > 0)
        : value.task.path === null && value.task.program === null && value.task.state === null)
  }
  return exactKeys(value.task, ['configured', 'xmlSha256'])
    && (typeof value.task.configured === 'boolean' || value.task.configured === null)
    && (value.task.xmlSha256 === null || validIdentity(value.task.xmlSha256))
    && (value.task.configured !== true || validIdentity(value.task.xmlSha256))
}

export async function bindServiceRecoveryFailure(recoveryRoot, identity, expectedManifestSha256, { carrierContents, task }) {
  const bundle = await loadServiceRecoveryBundle(recoveryRoot, identity)
  if (bundle.phase !== 'replacement-pending' || bundle.failureBinding !== null || bundle.manifestSha256 !== expectedManifestSha256) throw invalidRecovery()
  const manifestPath = join(bundle.directory, MANIFEST_FILE)
  const currentManifestBytes = await readFile(manifestPath)
  if (digest(currentManifestBytes) !== expectedManifestSha256) throw invalidRecovery()
  const manifest = JSON.parse(currentManifestBytes)
  manifest.phase = 'failed-replacement'
  manifest.failureBinding = {
    carrier: carrierContents === null ? null : byteRecord(carrierContents),
    task,
  }
  if (!validFailureBinding(bundle.platform, manifest.failureBinding)) throw invalidRecovery()
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  await replaceOwnerFile(manifestPath, manifestBytes)
  const loaded = await loadServiceRecoveryBundle(recoveryRoot, identity)
  return {
    identity,
    phase: loaded.phase,
    platform: loaded.platform,
    manifestSha256: loaded.manifestSha256,
    replacementIdentity: loaded.replacement.identity,
    directory: loaded.directory,
  }
}

export async function rebindServiceRecoveryPartialRestore(
  recoveryRoot,
  identity,
  expectedManifestSha256,
  { carrierContents, task, stateContents, currentStateIdentity },
) {
  const bundle = await loadServiceRecoveryBundle(recoveryRoot, identity)
  if (!['failed-replacement', 'partial-restore'].includes(bundle.phase)
    || bundle.failureBinding === null
    || bundle.manifestSha256 !== expectedManifestSha256
    || !validIdentity(currentStateIdentity)) throw invalidRecovery()
  const manifestPath = join(bundle.directory, MANIFEST_FILE)
  const currentManifestBytes = await readFile(manifestPath)
  if (digest(currentManifestBytes) !== expectedManifestSha256) throw invalidRecovery()
  const manifest = JSON.parse(currentManifestBytes)
  manifest.phase = 'partial-restore'
  manifest.lifecycle = {
    statePath: bundle.lifecycle.statePath,
    currentStateIdentity,
    stateFile: stateContents === null ? null : byteRecord(stateContents),
  }
  manifest.failureBinding = {
    carrier: carrierContents === null ? null : byteRecord(carrierContents),
    task,
  }
  if (!validFailureBinding(bundle.platform, manifest.failureBinding)) throw invalidRecovery()
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  await replaceOwnerFile(manifestPath, manifestBytes)
  const loaded = await loadServiceRecoveryBundle(recoveryRoot, identity)
  return {
    identity,
    phase: loaded.phase,
    platform: loaded.platform,
    manifestSha256: loaded.manifestSha256,
    replacementIdentity: loaded.replacement.identity,
    directory: loaded.directory,
  }
}

export async function retireServiceRecoveryBundle(recoveryRoot, identity) {
  const bundle = await loadServiceRecoveryBundle(recoveryRoot, identity)
  await rm(bundle.directory, { recursive: true, force: true })
}
