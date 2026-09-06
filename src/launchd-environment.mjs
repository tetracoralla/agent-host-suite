import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { AgentHostError } from './errors.mjs'
import { recordEnvironmentChange } from './environment-change.mjs'
import { MAX_FILE_BYTES, checkProof, conflict, equal, exactKeys, existing, invalid, object, proofFor, proofValid } from './environment-resource-state.mjs'
import { runFile } from './process.mjs'
import { launchAgentContents, retainedLaunchAgentProgram, SERVICE_LABEL, waitForEndpoint } from './service.mjs'

const unavailable = () => new AgentHostError('SERVICE_STATE_UNAVAILABLE', 'macOS returned an unsupported or ambiguous service observation')
const labelValid = (value) => typeof value === 'string' && value.length <= 240
  && (value === SERVICE_LABEL || (value.startsWith(SERVICE_LABEL + '.') && /^[a-zA-Z0-9._-]+$/u.test(value)))
const textValid = (value) => typeof value === 'string' && !/[\u0000-\u001f\u007f]/u.test(value)
const fileValid = (value) => value === null || (exactKeys(value, ['base64', 'mode']) && typeof value.base64 === 'string'
  && Buffer.from(value.base64, 'base64').toString('base64') === value.base64
  && Buffer.from(value.base64, 'base64').length <= MAX_FILE_BYTES
  && Number.isInteger(value.mode) && value.mode >= 0 && value.mode <= 0o777)
const definitionValid = (value) => exactKeys(value, ['path', 'program', 'args', 'environment', 'stdout', 'stderr'])
  && textValid(value.path) && isAbsolute(value.path) && textValid(value.program) && isAbsolute(value.program)
  && Array.isArray(value.args) && value.args.length > 0 && value.args.every(textValid)
  && object(value.environment) && Object.entries(value.environment).every(([name, text]) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) && textValid(text))
  && textValid(value.stdout) && textValid(value.stderr)
const snapshotValid = (value) => exactKeys(value, ['file', 'job', 'ready', 'socketPath']) && fileValid(value.file)
  && (value.job === null || (exactKeys(value.job, ['running', 'definition']) && typeof value.job.running === 'boolean' && definitionValid(value.job.definition)))
  && typeof value.ready === 'boolean' && (!value.ready || (value.job?.running === true && value.socketPath !== null))
  && (value.socketPath === null || (typeof value.socketPath === 'string' && isAbsolute(value.socketPath)))
const descriptorIdentity = (file) => file === null ? null : {
  sha256: 'sha256:' + createHash('sha256').update(Buffer.from(file.base64, 'base64')).digest('hex'), mode: file.mode,
}

export function validateLaunchdChange(step) {
  if (!exactKeys(step, ['kind', 'proof', 'label', 'before', 'after']) || step.kind !== 'launchd-service'
    || !proofValid(step.proof) || !labelValid(step.label) || !snapshotValid(step.before) || !snapshotValid(step.after)) throw invalid()
  for (const value of [step.before, step.after]) {
    if (value.job !== null && (value.file === null || value.job.definition.path !== step.proof.path)) throw invalid()
  }
}

async function carrier(proof) {
  await checkProof(proof)
  const info = await existing(proof.path)
  if (info === null) return null
  if (!info.isFile() || info.isSymbolicLink() || info.size > BigInt(MAX_FILE_BYTES)) throw conflict()
  const bytes = await readFile(proof.path)
  if (bytes.length > MAX_FILE_BYTES) throw conflict()
  return { base64: bytes.toString('base64'), mode: Number(info.mode) & 0o777 }
}

async function definition(file, proof, label, runner) {
  if (file === null) return null
  const bytes = Buffer.from(file.base64, 'base64')
  const program = retainedLaunchAgentProgram(bytes)
  const result = await runner('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: bytes, timeoutMs: 5000, maxBuffer: MAX_FILE_BYTES })
  let plist
  try { plist = JSON.parse(result.stdout) } catch { throw unavailable() }
  // Current Host descriptors start on load. Supporting other start policies
  // requires an explicit restoration method, not a guess from live state.
  if (plist.Label !== label || plist.RunAtLoad !== true || !Array.isArray(plist.ProgramArguments)
    || (plist.Program ?? plist.ProgramArguments[0]) !== program) throw unavailable()
  const value = { path: proof.path, program, args: plist.ProgramArguments, environment: plist.EnvironmentVariables ?? {},
    stdout: plist.StandardOutPath ?? '', stderr: plist.StandardErrorPath ?? '' }
  if (!definitionValid(value)) throw unavailable()
  return value
}

// launchctl print is a public diagnostic command, not a versioned data API.
// Parse only the observed complete identity blocks; unknown shapes fail closed.
export function parseLaunchdObservation(text) {
  const field = (name, required = true) => {
    const values = [...text.matchAll(new RegExp('^\\t' + name + ' = (.*)$', 'gm'))]
    if ((!required && values.length > 1) || (required && values.length !== 1)) throw unavailable()
    return values[0]?.[1] ?? ''
  }
  const block = (name) => {
    const values = [...text.matchAll(new RegExp('^\\t' + name + ' = \\{\\n([\\s\\S]*?)^\\t\\}\\n', 'gm'))]
    if (values.length !== 1) throw unavailable()
    const lines = values[0][1].split('\n'); lines.pop()
    if (lines.some((line) => !line.startsWith('\t\t'))) throw unavailable()
    return lines.map((line) => line.slice(2))
  }
  const environment = {}
  for (const line of block('environment')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*) => (.*)$/u.exec(line)
    if (match === null || Object.hasOwn(environment, match[1])) throw unavailable()
    Object.defineProperty(environment, match[1], { value: match[2], enumerable: true, configurable: true })
  }
  const value = { path: field('path'), program: field('program'), args: block('arguments'), environment,
    stdout: field('stdout path', false), stderr: field('stderr path', false) }
  if (!definitionValid(value)) throw unavailable()
  return { running: field('state') === 'running', definition: value }
}

function comparableJob(actual, expected, label) {
  if (actual === null || expected === null) return actual === expected
  const environment = { ...actual.definition.environment }
  // These two values are inserted by launchd on the observed macOS carrier.
  // If a descriptor declares either explicitly, compare that value normally.
  if (!Object.hasOwn(expected.definition.environment, 'XPC_SERVICE_NAME') && environment.XPC_SERVICE_NAME === label) delete environment.XPC_SERVICE_NAME
  if (!Object.hasOwn(expected.definition.environment, 'OSLogRateLimit') && environment.OSLogRateLimit === '64') delete environment.OSLogRateLimit
  return equal({ ...actual.definition, environment }, expected.definition)
}

async function observe(proof, label, runner) {
  const result = await runner('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`], { allowFailure: true, timeoutMs: 5000, maxBuffer: 65536 })
  if (result.status === 113 && (result.stdout + '\n' + result.stderr).includes(`Could not find service "${label}"`)) return null
  if (result.status !== 0 || result.timedOut || result.overflowed || result.cancelled) throw unavailable()
  const job = parseLaunchdObservation(result.stdout)
  if (job.definition.path !== proof.path) throw conflict()
  return job
}

async function observed(step, runner) {
  return { file: await carrier(step.proof), job: await observe(step.proof, step.label, runner) }
}
function recoverable(step, value) {
  if (![step.before.file, step.after.file].some((file) => equal(file, value.file))) throw conflict()
  if (value.job !== null && ![step.before.job, step.after.job].some((job) => comparableJob(value.job, job, step.label))) throw conflict()
}
async function replaceCarrier(proof, value) {
  await checkProof(proof)
  if (value === null) { await rm(proof.path, { force: true }); return }
  const path = proof.path + '.tmp-' + randomUUID()
  const handle = await open(path, 'wx', value.mode)
  try {
    await handle.writeFile(Buffer.from(value.base64, 'base64'))
    await handle.sync()
    await handle.close()
    await chmod(path, value.mode)
    await checkProof(proof)
    await rename(path, proof.path)
  } finally { await handle.close().catch(() => {}); await rm(path, { force: true }) }
}
async function stop(step, runner) {
  const result = await runner('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${step.label}`], { allowFailure: true, timeoutMs: 5000 })
  const deadline = Date.now() + 6000
  for (;;) {
    const current = await observed(step, runner)
    recoverable(step, current)
    if (current.job === null) break
    if (Date.now() >= deadline) throw new AgentHostError('SERVICE_ROLLBACK_CLEANUP_INCOMPLETE', 'The recorded LaunchAgent remains loaded after its removal')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (result.cancelled || result.timedOut) throw unavailable()
}
async function start(step, runner) {
  await runner('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, step.proof.path], { timeoutMs: 15000 })
}

export async function planLaunchdRecovery(step, virtual, dependencies) {
  validateLaunchdChange(step)
  if ((dependencies.servicePlatform ?? process.platform) !== 'darwin') throw new AgentHostError('SERVICE_RECOVERY_PLATFORM_MISMATCH', 'This service recovery requires macOS')
  const runner = dependencies.runner ?? runFile
  await checkProof(step.proof)
  for (const value of [step.before, step.after]) {
    if (value.job !== null && !equal(await definition(value.file, step.proof, step.label, runner), value.job.definition)) throw invalid()
  }
  const key = 'launchd:' + step.label
  if (!virtual.has(key)) virtual.set(key, await observed(step, runner))
  recoverable(step, virtual.get(key))
  virtual.set(key, { file: step.before.file, job: step.before.job })
  return async () => {
    const current = await observed(step, runner)
    recoverable(step, current)
    const restored = equal(current.file, step.before.file) && comparableJob(current.job, step.before.job, step.label)
      && current.job?.running === step.before.job?.running
    if (!restored) {
      if (current.job !== null) await stop(step, runner)
      await replaceCarrier(step.proof, step.before.file)
      if (step.before.job !== null) await start(step, runner)
    }
    const ready = dependencies.serviceWaitForEndpoint ?? waitForEndpoint
    if (step.before.ready && !await ready(step.before.socketPath)) {
      throw new AgentHostError('SERVICE_RESTORE_FAILED', 'The restored service endpoint did not become ready')
    }
    const final = await observed(step, runner)
    if (!equal(final.file, step.before.file) || !comparableJob(final.job, step.before.job, step.label)
      || (step.before.job?.running === true && final.job?.running !== true)) throw conflict()
  }
}

async function prepare(launchAgentPath, label, serviceState, runner, endpointCheck) {
  if (serviceState !== null && serviceState?.created !== true) {
    throw new AgentHostError('SERVICE_CONFLICT', 'The retained service is not recorded as Host-created')
  }
  await mkdir(dirname(launchAgentPath), { recursive: true, mode: 0o700 })
  const proof = await proofFor(launchAgentPath)
  const file = await carrier(proof)
  if (file !== null && serviceState?.descriptorIdentity !== undefined && !equal(serviceState.descriptorIdentity, descriptorIdentity(file))) {
    throw new AgentHostError('SERVICE_STATE_CHANGED', 'The managed service descriptor changed after installation; its ownership and supporting files were preserved')
  }
  const job = await observe(proof, label, runner)
  const expected = await definition(file, proof, label, runner)
  if (job !== null && (expected === null || !comparableJob(job, { definition: expected }, label))) throw conflict()
  if (job !== null && !job.running) throw new AgentHostError('SERVICE_PRIOR_STATE_UNRESTORABLE', 'The retained LaunchAgent is loaded but stopped')
  const socketPath = serviceState?.socketPath ?? null
  return { proof, before: { file, job: job === null ? null : { ...job, definition: expected }, socketPath,
    ready: job?.running === true && socketPath !== null && await endpointCheck(socketPath) } }
}

export async function installLaunchdEnvironment(runtime, files, runner, existingState, options) {
  const label = existingState?.label ?? options.serviceLabel ?? SERVICE_LABEL
  if (!labelValid(label)) throw invalid()
  const captured = await prepare(existingState?.launchAgentPath ?? options.launchAgentPath, label, existingState, runner, options.endpointCheck)
  if (existingState === null && (captured.before.file !== null || captured.before.job !== null)) throw new AgentHostError('SERVICE_CONFLICT', 'Another local execution service already uses this identity')
  if (existingState !== null && captured.before.file === null && options.allowMissingOwnedState !== true) throw new AgentHostError('SERVICE_ROLLBACK_STATE_INVALID', 'The retained LaunchAgent descriptor is missing')
  const file = { base64: Buffer.from(launchAgentContents(runtime, files, label)).toString('base64'), mode: 0o600 }
  const step = { kind: 'launchd-service', label, proof: captured.proof, before: captured.before,
    after: { file, job: { running: true, definition: await definition(file, captured.proof, label, runner) }, ready: true, socketPath: files.socketPath } }
  validateLaunchdChange(step)
  if (typeof runtime.fingerprint === 'string' && existingState?.runtimeFingerprint === runtime.fingerprint
    && equal(step.before.file, file) && step.before.ready && step.before.socketPath === files.socketPath) {
    return { kind: 'launchd', label, launchAgentPath: step.proof.path, socketPath: files.socketPath, descriptorIdentity: descriptorIdentity(file), runtimeFingerprint: runtime.fingerprint, created: existingState?.created ?? true }
  }
  await recordEnvironmentChange(step)
  const current = await observed(step, runner)
  if (!equal(current.file, step.before.file) || !comparableJob(current.job, step.before.job, label)) throw conflict()
  if (current.job !== null) await stop(step, runner)
  await replaceCarrier(step.proof, file)
  await start(step, runner)
  if (!await options.waitForEndpoint(files.socketPath)) throw new AgentHostError('SERVICE_START_FAILED', 'The local execution service did not make its Socket ready')
  const final = await observed(step, runner)
  if (!equal(final.file, file) || !comparableJob(final.job, step.after.job, label) || !final.job?.running) throw unavailable()
  return { kind: 'launchd', label, launchAgentPath: step.proof.path, socketPath: files.socketPath, descriptorIdentity: descriptorIdentity(file), runtimeFingerprint: runtime.fingerprint ?? null, created: existingState?.created ?? true }
}

export async function uninstallLaunchdEnvironment(serviceState, runner, options) {
  const label = serviceState.label ?? SERVICE_LABEL
  if (!labelValid(label)) throw invalid()
  const captured = await prepare(serviceState.launchAgentPath, label, serviceState, runner, options.endpointCheck)
  const step = { kind: 'launchd-service', label, proof: captured.proof, before: captured.before,
    after: { file: serviceState.created === true ? null : captured.before.file, job: null, ready: false, socketPath: serviceState.socketPath ?? null } }
  validateLaunchdChange(step)
  if (equal(step.before.file, step.after.file) && step.before.job === null) return { removed: serviceState.created === true }
  await recordEnvironmentChange(step)
  const current = await observed(step, runner)
  if (!equal(current.file, step.before.file) || !comparableJob(current.job, step.before.job, label)) throw conflict()
  if (current.job !== null) await stop(step, runner)
  await replaceCarrier(step.proof, step.after.file)
  return { removed: serviceState.created === true }
}
