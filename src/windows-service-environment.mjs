import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { AgentHostError } from './errors.mjs'
import { recordEnvironmentChange } from './environment-change.mjs'
import { MAX_FILE_BYTES, checkProof, conflict, equal, exactKeys, existing, invalid, proofFor, proofValid } from './environment-resource-state.mjs'
import { assertPrivateAccess } from './private-permissions.mjs'
import { runFile } from './process.mjs'
import { defaultWindowsRuntimeLauncherPath, windowsRuntimeLauncherContents, WINDOWS_SERVICE_TASK, waitForEndpoint } from './service.mjs'
import { windowsTask, windowsTaskNameValid, windowsTaskValid } from './windows-task.mjs'

const fileValid = (value) => value === null || (exactKeys(value, ['base64', 'mode', 'security']) && typeof value.base64 === 'string'
  && Buffer.from(value.base64, 'base64').toString('base64') === value.base64
  && Buffer.from(value.base64, 'base64').length <= MAX_FILE_BYTES && value.mode === 0o600
  && typeof value.security === 'string' && value.security.length > 0 && Buffer.byteLength(value.security) <= 65536)
const snapshotValid = (value) => exactKeys(value, ['file', 'task', 'ready', 'socketPath']) && fileValid(value.file)
  && windowsTaskValid(value.task) && typeof value.ready === 'boolean'
  && (value.socketPath === null || (typeof value.socketPath === 'string' && value.socketPath.length > 0))
  && (!value.ready || (value.task?.state === 4 && value.socketPath !== null))
const digest = (value) => 'sha256:' + createHash('sha256').update(value).digest('hex')
const fileIdentity = (file) => file === null ? null : { sha256: digest(Buffer.from(file.base64, 'base64')), mode: file.mode, security: digest(file.security) }
const taskIdentity = (task) => task === null ? null : { xml: digest(task.xml), sddl: digest(task.sddl) }
const sameTask = (a, b) => a === null || b === null ? a === b : a.xml === b.xml && a.sddl === b.sddl
const privateAccess = (path, info) => assertPrivateAccess(path, { ...info, uid: Number(info.uid), mode: Number(info.mode) })

export function validateWindowsServiceChange(step) {
  if (!exactKeys(step, ['kind', 'proof', 'taskName', 'before', 'after']) || step.kind !== 'windows-service'
    || !proofValid(step.proof) || !windowsTaskNameValid(step.taskName)
    || !snapshotValid(step.before) || !snapshotValid(step.after)) throw invalid()
  for (const value of [step.before, step.after]) {
    if (value.task !== null && (value.file === null || ![1, 3, 4].includes(value.task.state))) throw invalid()
  }
}

async function carrier(proof, taskName, runner) {
  await checkProof(proof)
  const info = await existing(proof.path)
  if (info === null) return null
  if (!info.isFile() || info.isSymbolicLink() || info.size > BigInt(MAX_FILE_BYTES)) throw conflict()
  await privateAccess(proof.path, info)
  const bytes = await readFile(proof.path)
  if (bytes.length > MAX_FILE_BYTES) throw conflict()
  // Windows exposes synthetic writable/read-only mode bits. NTFS privacy is
  // checked separately; do not compare them to a fabricated POSIX 0600 value.
  if ((Number(info.mode) & 0o222) === 0) throw new AgentHostError('SERVICE_PRIOR_STATE_UNRESTORABLE', 'A read-only Windows service launcher must be resolved before service changes')
  return { base64: bytes.toString('base64'), mode: 0o600, security: await windowsTask('file-security', taskName, { path: proof.path }, runner) }
}
async function replaceCarrier(proof, file, taskName, runner) {
  await checkProof(proof)
  if (file === null) { await rm(proof.path, { force: true }); return }
  const path = proof.path + '.tmp-' + randomUUID()
  const handle = await open(path, 'wx', file.mode)
  try {
    await handle.writeFile(Buffer.from(file.base64, 'base64'))
    await handle.sync()
    await handle.close()
    await chmod(path, file.mode)
    // A sibling temporary file normally already inherits the exact recorded
    // ACL. Reapplying an identical ACL through Set-Acl can change Windows'
    // inheritance control flags; keep the existing exact descriptor untouched.
    const inheritedSecurity = await windowsTask('file-security', taskName, { path }, runner)
    if (inheritedSecurity !== file.security
      && await windowsTask('set-file-security', taskName, { path, security: file.security }, runner) !== file.security) throw conflict()
    await privateAccess(path, await existing(path))
    await checkProof(proof)
    await rename(path, proof.path)
  } finally { await handle.close().catch(() => {}); await rm(path, { force: true }) }
}
async function newFileSecurity(proof, taskName, runner) {
  const path = proof.path + '.acl-' + randomUUID()
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.close()
    await privateAccess(path, await existing(path))
    return await windowsTask('file-security', taskName, { path }, runner)
  } finally { await handle.close().catch(() => {}); await rm(path, { force: true }) }
}
const observe = async (step, runner) => ({ file: await carrier(step.proof, step.taskName, runner), task: await windowsTask('observe', step.taskName, {}, runner) })
function recoverable(step, current) {
  if (![step.before.file, step.after.file].some((file) => equal(file, current.file))) throw conflict()
  if (current.task !== null && ![step.before.task, step.after.task].some((task) => sameTask(task, current.task))) throw conflict()
}
async function removeTask(step, task, runner) {
  const removed = await windowsTask('remove', step.taskName, { expected: task }, runner)
  if (removed !== null) throw new AgentHostError('SERVICE_ROLLBACK_CLEANUP_INCOMPLETE', 'The recorded Windows task remains registered after removal')
}
async function createTask(step, task, runner) {
  const created = await windowsTask('create', step.taskName, { expected: null, task }, runner)
  if (!sameTask(created, task)) throw conflict()
  if (task.state === 4) await windowsTask('run', step.taskName, { expected: task }, runner)
}
async function waitForTask(step, expected, runner) {
  const deadline = Date.now() + 6000
  for (;;) {
    const current = await observe(step, runner)
    recoverable(step, current)
    if (sameTask(current.task, expected) && current.task?.state === expected?.state) return current
    if (Date.now() >= deadline) throw new AgentHostError('SERVICE_RESTORE_FAILED', 'The Windows task did not reach its recorded running or stopped state')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

export async function planWindowsServiceRecovery(step, virtual, dependencies) {
  validateWindowsServiceChange(step)
  if ((dependencies.servicePlatform ?? process.platform) !== 'win32') throw new AgentHostError('SERVICE_RECOVERY_PLATFORM_MISMATCH', 'This service recovery requires Windows')
  const runner = dependencies.runner ?? runFile
  await checkProof(step.proof)
  for (const value of [step.before, step.after]) {
    if (value.file !== null && value.file.security !== await windowsTask('validate-file-security', step.taskName, { security: value.file.security }, runner)) throw invalid()
    if (value.task !== null && !equal(value.task, await windowsTask('validate', step.taskName, { task: value.task, launcherPath: step.proof.path }, runner))) throw invalid()
  }
  const key = 'windows-service:' + step.taskName.toLowerCase()
  if (!virtual.has(key)) virtual.set(key, await observe(step, runner))
  recoverable(step, virtual.get(key))
  virtual.set(key, { file: step.before.file, task: step.before.task })
  return async () => {
    const current = await observe(step, runner)
    recoverable(step, current)
    const restored = equal(current.file, step.before.file) && sameTask(current.task, step.before.task)
      && current.task?.state === step.before.task?.state
    if (!restored) {
      if (current.task !== null) await removeTask(step, current.task, runner)
      // A concurrent edit to the launcher after stopping the task is preserved.
      const stopped = await observe(step, runner)
      recoverable(step, stopped)
      if (!equal(stopped.file, step.before.file)) await replaceCarrier(step.proof, step.before.file, step.taskName, runner)
      if (step.before.task !== null) await createTask(step, step.before.task, runner)
    }
    if (step.before.ready && !await (dependencies.serviceWaitForEndpoint ?? waitForEndpoint)(step.before.socketPath)) {
      throw new AgentHostError('SERVICE_RESTORE_FAILED', 'The restored Windows service endpoint did not become ready')
    }
    const final = await waitForTask(step, step.before.task, runner)
    if (!equal(final.file, step.before.file)) throw conflict()
  }
}

async function prepare(path, taskName, state, runner, endpointCheck) {
  if (state !== null && state?.created !== true) throw new AgentHostError('SERVICE_CONFLICT', 'The retained Windows service is not recorded as Host-created')
  if (!isAbsolute(path)) throw invalid()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await privateAccess(dirname(path), await existing(dirname(path)))
  const proof = await proofFor(path)
  const file = await carrier(proof, taskName, runner)
  const task = await windowsTask('observe', taskName, {}, runner)
  if ((file !== null && state?.descriptorIdentity !== undefined && !equal(fileIdentity(file), state.descriptorIdentity))
    || (task !== null && state?.taskIdentity !== undefined && !equal(taskIdentity(task), state.taskIdentity))) {
    throw new AgentHostError('SERVICE_STATE_CHANGED', 'The managed Windows service changed after installation; its task and supporting files were preserved')
  }
  if (task !== null) {
    if (file === null) throw conflict()
    if (![1, 3, 4].includes(task.state)) throw new AgentHostError('SERVICE_PRIOR_STATE_UNRESTORABLE', 'A queued or unknown Windows task cannot be restored to an exact prior state')
    if (!equal(task, await windowsTask('validate', taskName, { task, launcherPath: proof.path }, runner))) throw conflict()
  }
  const socketPath = state?.socketPath ?? null
  return { proof, before: { file, task, socketPath, ready: task?.state === 4 && socketPath !== null && await endpointCheck(socketPath) } }
}
function stateFor(step, fingerprint) {
  return { kind: 'windows-scheduled-task', label: step.taskName, taskName: step.taskName, launcherPath: step.proof.path,
    socketPath: step.after.socketPath, descriptorIdentity: fileIdentity(step.after.file), taskIdentity: taskIdentity(step.after.task), runtimeFingerprint: fingerprint ?? null, created: true }
}
export async function installWindowsServiceEnvironment(runtime, files, runner, existingState, options) {
  const taskName = existingState?.taskName ?? options.serviceTaskName ?? WINDOWS_SERVICE_TASK
  const captured = await prepare(existingState?.launcherPath ?? options.launcherPath ?? defaultWindowsRuntimeLauncherPath(files), taskName, existingState, runner, options.endpointCheck)
  if (existingState === null && (captured.before.file !== null || captured.before.task !== null)) throw new AgentHostError('SERVICE_CONFLICT', 'Another local execution service already uses this Windows identity')
  if (existingState !== null && (captured.before.file === null || captured.before.task === null) && options.allowMissingOwnedState !== true) {
    throw new AgentHostError('SERVICE_ROLLBACK_STATE_INVALID', 'The retained Windows service launcher or task is missing')
  }
  const file = { base64: Buffer.from(windowsRuntimeLauncherContents(runtime, files)).toString('base64'), mode: 0o600,
    security: captured.before.file?.security ?? await newFileSecurity(captured.proof, taskName, runner) }
  const step = { kind: 'windows-service', taskName, ...captured, after: { file, task: captured.before.task, ready: true, socketPath: files.socketPath } }
  if (typeof runtime.fingerprint === 'string' && runtime.fingerprint === existingState?.runtimeFingerprint
    && equal(file, captured.before.file) && captured.before.ready && captured.before.socketPath === files.socketPath) return stateFor(step, runtime.fingerprint)
  step.after.task = await windowsTask('prepare', taskName, { launcherPath: step.proof.path }, runner)
  validateWindowsServiceChange(step)
  await recordEnvironmentChange(step)
  const current = await observe(step, runner)
  if (!equal(current.file, step.before.file) || !sameTask(current.task, step.before.task)) throw conflict()
  if (current.task !== null) await removeTask(step, current.task, runner)
  const stopped = await observe(step, runner)
  recoverable(step, stopped)
  if (!equal(stopped.file, file)) await replaceCarrier(step.proof, file, taskName, runner)
  await createTask(step, step.after.task, runner)
  if (!await options.waitForEndpoint(files.socketPath)) throw new AgentHostError('SERVICE_START_FAILED', 'The Windows local execution service did not make its named pipe ready')
  const final = await waitForTask(step, step.after.task, runner)
  if (!equal(final.file, file)) throw conflict()
  return stateFor(step, runtime.fingerprint)
}
export async function uninstallWindowsServiceEnvironment(serviceState, runner, options) {
  const taskName = serviceState.taskName ?? WINDOWS_SERVICE_TASK
  const captured = await prepare(serviceState.launcherPath, taskName, serviceState, runner, options.endpointCheck)
  const step = { kind: 'windows-service', taskName, ...captured, after: { file: null, task: null, ready: false, socketPath: serviceState.socketPath ?? null } }
  validateWindowsServiceChange(step)
  if (step.before.file === null && step.before.task === null) return { removed: true }
  await recordEnvironmentChange(step)
  const current = await observe(step, runner)
  if (!equal(current.file, step.before.file) || !sameTask(current.task, step.before.task)) throw conflict()
  if (current.task !== null) await removeTask(step, current.task, runner)
  recoverable(step, await observe(step, runner))
  await replaceCarrier(step.proof, null, taskName, runner)
  return { removed: true }
}
