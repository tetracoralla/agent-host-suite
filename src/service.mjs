import { platform, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { chmod, lstat, mkdir, open, readFile, rm, rename } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import { AgentHostError } from './errors.mjs'
import { canonicalJson } from './json.mjs'
import { runFile } from './process.mjs'
import {
  bindServiceRecoveryFailure,
  defaultServiceRecoveryRoot,
  loadServiceRecoveryBundle,
  persistServiceRecoveryBundle,
  rebindServiceRecoveryPartialRestore,
  retireServiceRecoveryBundle,
} from './service-recovery.mjs'

export const SERVICE_LABEL = 'io.github.tetracoralla.agent-host-suite.runtime'
export const WINDOWS_SERVICE_TASK = '\\openAdam\\AgentHostRuntime'

function xml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function invalidRetainedLaunchAgentProgram() {
  return new AgentHostError('SERVICE_RECOVERY_BUNDLE_INVALID', 'The retained LaunchAgent descriptor does not contain one unambiguous direct program identity')
}

function plistString(value) {
  if (value.includes('\uFFFD') || /&(?!amp;|lt;|gt;)/u.test(value)) {
    throw invalidRetainedLaunchAgentProgram()
  }
  const decoded = value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
  if (decoded.length === 0 || /[\u0000-\u001f\u007f]/u.test(decoded)) {
    throw invalidRetainedLaunchAgentProgram()
  }
  return decoded
}

export function retainedLaunchAgentProgram(contents) {
  let text = contents.toString('utf8')
  if (text.includes('\uFFFD') || /<!--|<!\[CDATA\[|<!ENTITY|<\?(?!xml\b)/u.test(text)) {
    throw invalidRetainedLaunchAgentProgram()
  }
  text = text.replace(/^\s*<\?xml\s+version="1\.0"\s+encoding="UTF-8"\?>\s*/u, '')
  text = text.replace(/^<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN" "http:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd">\s*/u, '')
  if (text.includes('<!') || text.includes('<?')) throw invalidRetainedLaunchAgentProgram()

  const tokens = text.match(/<[^>]*>|[^<]+/gu) ?? []
  if (tokens.join('') !== text) throw invalidRetainedLaunchAgentProgram()
  const stack = []
  let rootClosed = false
  let pendingKey = null
  let program = null
  let programSeen = false
  let programArguments = null
  let programArgumentsSeen = false

  const parentNames = () => stack.map((item) => item.name).join('/')
  const openElement = (name, selfClosing) => {
    const parent = parentNames()
    if (['key', 'string', 'integer', 'real', 'data', 'date'].includes(stack.at(-1)?.name)) {
      throw invalidRetainedLaunchAgentProgram()
    }
    if (rootClosed || (stack.length === 0 && name !== 'plist')) throw invalidRetainedLaunchAgentProgram()
    if (name === 'plist' && stack.length !== 0) throw invalidRetainedLaunchAgentProgram()

    let target = null
    if (parent === 'plist/dict' && name === 'key') {
      if (pendingKey !== null) throw invalidRetainedLaunchAgentProgram()
      target = 'top-key'
    } else if (parent === 'plist/dict') {
      if (pendingKey === null) throw invalidRetainedLaunchAgentProgram()
      const key = pendingKey
      pendingKey = null
      if (key === 'Program') {
        if (programSeen || name !== 'string') throw invalidRetainedLaunchAgentProgram()
        programSeen = true
        target = 'program'
      } else if (key === 'ProgramArguments') {
        if (programArgumentsSeen || name !== 'array') throw invalidRetainedLaunchAgentProgram()
        programArgumentsSeen = true
        target = 'program-arguments'
      }
    } else {
      const parentElement = stack.at(-1)
      if (parentElement?.target === 'program-arguments' && parentElement.firstChildSeen !== true) {
        parentElement.firstChildSeen = true
        if (name !== 'string') throw invalidRetainedLaunchAgentProgram()
        target = 'program-argument-zero'
      }
    }

    const element = { name, target, text: '', firstChildSeen: false }
    if (!selfClosing) {
      stack.push(element)
      return
    }
    if (!['true', 'false'].includes(name) || target !== null) throw invalidRetainedLaunchAgentProgram()
  }

  const closeElement = (name) => {
    const element = stack.pop()
    if (element?.name !== name) throw invalidRetainedLaunchAgentProgram()
    if (element.target === 'top-key') {
      if (element.text.length === 0 || element.text.includes('&') || /[\u0000-\u001f\u007f]/u.test(element.text)) {
        throw invalidRetainedLaunchAgentProgram()
      }
      pendingKey = element.text
    } else if (element.target === 'program') {
      program = plistString(element.text)
    } else if (element.target === 'program-argument-zero') {
      programArguments = plistString(element.text)
    } else if (element.target === 'program-arguments' && element.firstChildSeen !== true) {
      throw invalidRetainedLaunchAgentProgram()
    }
    if (name === 'dict' && stack.length === 1 && pendingKey !== null) throw invalidRetainedLaunchAgentProgram()
    if (name === 'plist') {
      if (stack.length !== 0) throw invalidRetainedLaunchAgentProgram()
      rootClosed = true
    }
  }

  for (const token of tokens) {
    if (!token.startsWith('<')) {
      const element = stack.at(-1)
      if (element !== undefined && ['key', 'string'].includes(element.name)) element.text += token
      else if (!/^\s*$/u.test(token)) throw invalidRetainedLaunchAgentProgram()
      continue
    }
    const closing = token.match(/^<\/(plist|dict|key|string|array|true|false|integer|real|data|date)>$/u)
    if (closing !== null) {
      closeElement(closing[1])
      continue
    }
    const plistOpen = token.match(/^<plist\s+version="1\.0">$/u)
    if (plistOpen !== null) {
      openElement('plist', false)
      continue
    }
    const regularOpen = token.match(/^<(dict|key|string|array|integer|real|data|date)>$/u)
    if (regularOpen !== null) {
      openElement(regularOpen[1], false)
      continue
    }
    const selfClosing = token.match(/^<(true|false)\s*\/>$/u)
    if (selfClosing !== null) {
      openElement(selfClosing[1], true)
      continue
    }
    throw invalidRetainedLaunchAgentProgram()
  }
  if (!rootClosed || stack.length !== 0 || pendingKey !== null
    || programSeen === programArgumentsSeen
    || (programSeen && program === null)
    || (programArgumentsSeen && programArguments === null)) throw invalidRetainedLaunchAgentProgram()
  return programSeen ? program : programArguments
}

export function launchAgentContents(runtime, files) {
  const executableDirectory = dirname(runtime.command)
  const servicePath = [executableDirectory, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(':')
  const argumentsList = [
    runtime.command,
    ...runtime.args,
    'serve',
    '--config', files.configPath,
    '--socket', files.socketPath,
    '--observation-log', files.observationLog,
    '--replace-stale-socket',
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsList.map((item) => `    <string>${xml(item)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(servicePath)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
`
}

export function defaultLaunchAgentPath() {
  return join(userInfo().homedir, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
}

export function defaultWindowsRuntimeLauncherPath(files) {
  return join(dirname(files.configPath), 'direct-runtime-service.cmd')
}

function batchQuote(value) {
  const text = String(value)
  if (/[\u0000\r\n"]/u.test(text)) throw new AgentHostError('SERVICE_COMMAND_INVALID', 'The Windows service command contains unsupported characters')
  return `"${text.replaceAll('%', '%%')}"`
}

export function windowsRuntimeLauncherContents(runtime, files) {
  const args = [
    runtime.command,
    ...runtime.args,
    'serve',
    '--config', files.configPath,
    '--socket', files.socketPath,
    '--observation-log', files.observationLog,
    '--replace-stale-socket',
  ]
  return `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${args.map(batchQuote).join(' ')}\r\n`
}

async function endpointReachable(path, timeoutMs = 250) {
  if (typeof path !== 'string') return false
  return await new Promise((resolvePromise) => {
    let settled = false
    const socket = connect({ path })
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolvePromise(value)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

async function waitForEndpoint(path, attempts = 640) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await endpointReachable(path)) return true
    if (attempt + 1 < attempts) await new Promise((resolvePromise) => setTimeout(resolvePromise, 125))
  }
  return false
}

function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function commandSucceeded(result) {
  return result?.status === 0
    && result.timedOut !== true
    && result.overflowed !== true
    && result.cancelled !== true
}

function bytesDigest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function stateContentsIdentity(contents) {
  if (contents === null) return bytesDigest(Buffer.from('absent-state-file'))
  try {
    return bytesDigest(Buffer.from(canonicalJson(JSON.parse(contents.toString('utf8')))))
  } catch {
    throw new AgentHostError('SERVICE_RECOVERY_CONTEXT_INVALID', 'The lifecycle state cannot be bound as valid JSON')
  }
}

function boundedServiceFailure(error, fallbackCode, privatePaths) {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/u.test(error.code)
    ? error.code
    : fallbackCode
  let message = error instanceof Error ? error.message : String(error)
  for (const path of privatePaths.filter((value) => typeof value === 'string').sort((left, right) => right.length - left.length)) {
    message = message.replaceAll(path, '<private-path>')
  }
  message = message
    .replace(/\b[A-Za-z]:[\\/][^\s,;)}\]]*/gu, '<private-path>')
    .replace(/\\\\[^\\/\s]+[\\/][^\s,;)}\]]*/gu, '<private-path>')
    .replace(/(^|[\s("'=])\/(?:[^/\s]+\/)*[^\s,;)}\]]*/gu, '$1<private-path>')
  const bounded = [...message].slice(0, 512).join('')
  return { code, message: bounded.length === 0 ? 'Service lifecycle step failed' : bounded }
}

function recoveryAction(bundle) {
  return {
    command: 'agent-host',
    arguments: [
      'service', 'recover',
      '--recovery', bundle.identity,
      '--manifest-sha256', bundle.manifestSha256,
    ],
  }
}

function publicRecovery(bundle, { includeAction = false, retained = true } = {}) {
  if (bundle === null) return undefined
  return {
    identity: bundle.identity,
    phase: bundle.phase,
    platform: bundle.platform,
    manifestSha256: bundle.manifestSha256,
    replacementIdentity: bundle.replacementIdentity ?? bundle.replacement?.identity,
    retained,
    retryable: retained && includeAction,
    ...(includeAction ? { action: recoveryAction(bundle) } : {}),
  }
}

function serviceRollbackFailure(message, installationError, rollbackError, privatePaths, recovery = null, recoveryBindingError = null) {
  return new AgentHostError('SERVICE_INSTALL_ROLLBACK_FAILED', message, {
    installation: boundedServiceFailure(installationError, 'SERVICE_INSTALL_FAILED', privatePaths),
    rollback: boundedServiceFailure(rollbackError, 'SERVICE_ROLLBACK_FAILED', privatePaths),
    ...(recoveryBindingError === null ? {} : {
      recoveryBinding: boundedServiceFailure(recoveryBindingError, 'SERVICE_RECOVERY_BIND_FAILED', privatePaths),
    }),
    ...(recovery === null ? {} : { recovery: publicRecovery(recovery, { includeAction: true }) }),
  })
}

function publicRestoredService(bundle, service) {
  return {
    platform: bundle.platform,
    kind: bundle.platform === 'darwin' ? 'launchd' : 'windows-scheduled-task',
    configured: service.configured,
    loaded: service.loaded,
    running: service.running,
    socketPresent: service.socketPresent,
    ready: service.ready,
    ...(service.lastExitCode === undefined ? {} : { lastExitCode: service.lastExitCode }),
    ...(service.taskState === undefined ? {} : { taskState: service.taskState }),
  }
}

function windowsTaskIdentity(taskName) {
  const normalized = String(taskName).replaceAll('/', '\\')
  const separator = normalized.lastIndexOf('\\')
  const name = normalized.slice(separator + 1)
  const taskPath = separator < 0 ? '\\' : normalized.slice(0, separator + 1)
  if (name.length === 0 || taskPath.length === 0) {
    throw new AgentHostError('SERVICE_ROLLBACK_STATE_INVALID', 'The retained Windows scheduled task identity is invalid')
  }
  return { name, taskPath }
}

async function inspectWindowsTaskState(taskName, runner) {
  const identity = windowsTaskIdentity(taskName)
  const script = [
    `$matches = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskPath -eq ${powershellLiteral(identity.taskPath)} -and $_.TaskName -eq ${powershellLiteral(identity.name)} })`,
    "if ($matches.Count -eq 0) { 'ABSENT' } elseif ($matches.Count -eq 1) { 'PRESENT:' + $matches[0].State.ToString() } else { 'AMBIGUOUS' }",
  ].join('; ')
  const result = await runner('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', script,
  ], { allowFailure: true, timeoutMs: 5_000 })
  if (!commandSucceeded(result)) {
    throw new AgentHostError('SERVICE_STATE_UNAVAILABLE', 'Windows could not inspect the scheduled-task state')
  }
  const observation = result.stdout.trim()
  if (observation === 'ABSENT') return { configured: false, running: false, state: null }
  if (observation === 'AMBIGUOUS' || !observation.startsWith('PRESENT:')) {
    throw new AgentHostError('SERVICE_STATE_UNAVAILABLE', 'Windows returned an ambiguous scheduled-task identity')
  }
  const state = observation.slice('PRESENT:'.length)
  if (!['Running', 'Ready', 'Disabled', 'Queued', 'Unknown'].includes(state)) {
    throw new AgentHostError('SERVICE_STATE_UNAVAILABLE', 'Windows returned an unrecognized scheduled-task state')
  }
  return { configured: true, running: state === 'Running', state }
}

async function confirmWindowsTaskAbsent(taskName, runner) {
  const identity = windowsTaskIdentity(taskName)
  const script = [
    `$matches = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskPath -eq ${powershellLiteral(identity.taskPath)} -and $_.TaskName -eq ${powershellLiteral(identity.name)} })`,
    "if ($matches.Count -eq 0) { 'ABSENT' } elseif ($matches.Count -eq 1) { 'PRESENT' } else { 'AMBIGUOUS' }",
  ].join('; ')
  const result = await runner('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', script,
  ], { allowFailure: true, timeoutMs: 5_000 })
  if (!commandSucceeded(result)) {
    throw new AgentHostError('SERVICE_ROLLBACK_STATE_UNAVAILABLE', 'Windows could not verify whether the failed scheduled-task removal left a task behind')
  }
  if (result.stdout.trim() === 'ABSENT') return
  if (result.stdout.trim() === 'PRESENT') {
    throw new AgentHostError('SERVICE_ROLLBACK_CLEANUP_INCOMPLETE', 'The Windows scheduled task still exists after its removal command failed')
  }
  throw new AgentHostError('SERVICE_ROLLBACK_STATE_UNAVAILABLE', 'Windows returned an ambiguous scheduled-task identity after its removal command failed')
}

async function removeWindowsTaskForRollback(taskName, runner) {
  const commands = [
    ['/End', '/TN', taskName],
    ['/Delete', '/TN', taskName, '/F'],
  ]
  for (const args of commands) {
    const result = await runner('schtasks.exe', args, { allowFailure: true, timeoutMs: 5_000 })
    if (commandSucceeded(result)) continue
    await confirmWindowsTaskAbsent(taskName, runner)
    return
  }
}

function launchctlConfirmsServiceAbsent(result) {
  return !commandSucceeded(result)
    && result?.status === 113
    && `${result.stdout ?? ''}\n${result.stderr ?? ''}`.includes(`Could not find service "${SERVICE_LABEL}"`)
}

async function removeLaunchAgentForRollback(domain, launchAgentPath, runner) {
  const removal = await runner('/bin/launchctl', ['bootout', domain, launchAgentPath], { allowFailure: true, timeoutMs: 5_000 })
  if (commandSucceeded(removal)) return
  const inspection = await runner('/bin/launchctl', ['print', `${domain}/${SERVICE_LABEL}`], { allowFailure: true, timeoutMs: 5_000 })
  if (commandSucceeded(inspection)) {
    throw new AgentHostError('SERVICE_ROLLBACK_CLEANUP_INCOMPLETE', 'The LaunchAgent is still loaded after its removal command failed')
  }
  if (!launchctlConfirmsServiceAbsent(inspection)) {
    throw new AgentHostError('SERVICE_ROLLBACK_STATE_UNAVAILABLE', 'macOS could not verify whether the failed LaunchAgent removal left a job behind')
  }
}

async function regularFileSnapshot(path) {
  const info = await lstat(path).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (info === null) return null
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new AgentHostError('SERVICE_PATH_UNSAFE', 'The local execution service descriptor is not a regular file')
  }
  return { contents: await readFile(path), mode: info.mode & 0o777 }
}

async function recoveryLifecycle(options) {
  const value = options.recoveryLifecycle
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || typeof value.statePath !== 'string' || value.statePath.length === 0
    || !/^sha256:[0-9a-f]{64}$/u.test(value.currentStateIdentity ?? '')) {
    throw new AgentHostError(
      'SERVICE_RECOVERY_CONTEXT_REQUIRED',
      'Replacing an owned service requires an exact lifecycle-state recovery binding',
    )
  }
  const state = await regularFileSnapshot(value.statePath)
  const currentStateIdentity = stateContentsIdentity(state?.contents ?? null)
  if (currentStateIdentity !== value.currentStateIdentity) {
    throw new AgentHostError('SERVICE_RECOVERY_CONTEXT_INVALID', 'The lifecycle state identity changed before service replacement')
  }
  return {
    statePath: value.statePath,
    currentStateIdentity,
    stateContents: state?.contents ?? null,
  }
}

function byteRecordMatches(record, contents) {
  return contents !== null
    && contents.length === record.bytes
    && bytesDigest(contents) === record.sha256
}

async function currentTaskFailureBinding(platformName, target, runner) {
  if (platformName === 'darwin') {
    const domain = `gui/${process.getuid()}`
    const result = await runner('/bin/launchctl', ['print', `${domain}/${SERVICE_LABEL}`], { allowFailure: true, timeoutMs: 5_000 })
    if (commandSucceeded(result)) {
      const fields = {}
      for (const name of ['path', 'program', 'state']) {
        const matches = [...result.stdout.matchAll(new RegExp(`^\\s*${name} = (.+?)\\s*$`, 'gmu'))]
        if (matches.length !== 1 || matches[0][1].length === 0 || matches[0][1].length > 4096
          || /[\u0000-\u001f\u007f]/u.test(matches[0][1])) {
          throw new AgentHostError('SERVICE_STATE_UNAVAILABLE', 'macOS returned an incomplete local execution service identity')
        }
        fields[name] = matches[0][1]
      }
      return { configured: true, path: fields.path, program: fields.program, state: fields.state }
    }
    if (launchctlConfirmsServiceAbsent(result)) return { configured: false, path: null, program: null, state: null }
    return { configured: null, path: null, program: null, state: null }
  }
  const xmlResult = await runner('schtasks.exe', ['/Query', '/TN', target.taskName, '/XML'], { allowFailure: true, timeoutMs: 5_000 })
  if (commandSucceeded(xmlResult)) return { configured: true, xmlSha256: bytesDigest(Buffer.from(xmlResult.stdout)) }
  try {
    const state = await inspectWindowsTaskState(target.taskName, runner)
    if (!state.configured) return { configured: false, xmlSha256: null }
  } catch {
    // The recovery bundle records unknown task identity and later restoration fails closed.
  }
  return { configured: null, xmlSha256: null }
}

async function bindRecoveryFailure(recoveryRoot, recovery, platformName, target, carrierPath, runner) {
  let carrier = null
  try {
    carrier = await regularFileSnapshot(carrierPath)
  } catch {
    // A non-regular residual cannot be safely restored over; bind as non-recoverable absence.
  }
  const task = await currentTaskFailureBinding(platformName, target, runner)
  if (platformName === 'darwin' && task.configured === true
    && (task.path !== target.launchAgentPath || task.program !== target.program)) {
    throw new AgentHostError('SERVICE_RECOVERY_TARGET_MISMATCH', 'The failed LaunchAgent job does not match the replacement being retained')
  }
  return bindServiceRecoveryFailure(recoveryRoot, recovery.identity, recovery.manifestSha256, {
    carrierContents: carrier?.contents ?? null,
    task,
  })
}

async function verifyRecoveryTarget(bundle, runner) {
  if (bundle.failureBinding === null) {
    throw new AgentHostError('SERVICE_RECOVERY_TARGET_MISMATCH', 'The retained recovery bundle is not bound to a failed replacement residue')
  }
  const state = await regularFileSnapshot(bundle.lifecycle.statePath)
  const stateMatches = bundle.lifecycle.stateFile === null
    ? state === null
    : byteRecordMatches(bundle.lifecycle.stateFile, state?.contents ?? null)
  if (!stateMatches) {
    throw new AgentHostError('SERVICE_RECOVERY_TARGET_MISMATCH', 'The lifecycle state has changed since the failed service replacement')
  }
  if (stateContentsIdentity(state?.contents ?? null) !== bundle.lifecycle.currentStateIdentity) {
    throw new AgentHostError('SERVICE_RECOVERY_TARGET_MISMATCH', 'The lifecycle state identity differs from the failed service replacement')
  }
  const carrierPath = bundle.platform === 'darwin' ? bundle.target.launchAgentPath : bundle.target.launcherPath
  const carrier = await regularFileSnapshot(carrierPath)
  const carrierMatches = bundle.failureBinding.carrier === null
    ? carrier === null
    : byteRecordMatches(bundle.failureBinding.carrier, carrier?.contents ?? null)
  if (!carrierMatches) {
    throw new AgentHostError('SERVICE_RECOVERY_TARGET_MISMATCH', 'The service carrier has changed since the failed replacement')
  }
  const currentTask = await currentTaskFailureBinding(bundle.platform, bundle.target, runner)
  const expectedTask = bundle.failureBinding.task
  const taskMatches = bundle.platform === 'darwin'
    ? expectedTask.configured !== null
      && currentTask.configured === expectedTask.configured
      && currentTask.path === expectedTask.path
      && currentTask.program === expectedTask.program
      && currentTask.state === expectedTask.state
    : expectedTask.configured !== null
      && currentTask.configured === expectedTask.configured
      && currentTask.xmlSha256 === expectedTask.xmlSha256
  if (!taskMatches) {
    throw new AgentHostError('SERVICE_RECOVERY_TARGET_MISMATCH', 'The service task has changed or cannot be confirmed since the failed replacement')
  }
}

async function verifyRestoredTarget(bundle, runner, endpointCheck, expectedProgram) {
  const state = await regularFileSnapshot(bundle.lifecycle.statePath)
  const stateMatches = bundle.lifecycle.stateFile === null
    ? state === null
    : byteRecordMatches(bundle.lifecycle.stateFile, state?.contents ?? null)
  if (!stateMatches || stateContentsIdentity(state?.contents ?? null) !== bundle.lifecycle.currentStateIdentity) {
    throw new AgentHostError('SERVICE_RESTORE_FAILED', 'The lifecycle state changed while the retained service was being restored')
  }

  const carrierPath = bundle.platform === 'darwin' ? bundle.target.launchAgentPath : bundle.target.launcherPath
  const carrier = await regularFileSnapshot(carrierPath)
  const priorCarrier = bundle.platform === 'darwin' ? bundle.descriptor : bundle.launcher
  if (!byteRecordMatches({ bytes: priorCarrier.contents.length, sha256: bytesDigest(priorCarrier.contents) }, carrier?.contents ?? null)) {
    throw new AgentHostError('SERVICE_RESTORE_FAILED', 'The restored service carrier does not match the retained prior bytes')
  }

  const serviceState = bundle.platform === 'darwin'
    ? { launchAgentPath: bundle.target.launchAgentPath, socketPath: bundle.target.priorSocketPath }
    : { launcherPath: bundle.target.launcherPath, taskName: bundle.target.taskName, socketPath: bundle.target.priorSocketPath }
  const service = await inspectService(serviceState, runner, {
    platformName: bundle.platform,
    endpointReachable: endpointCheck,
  })
  const task = await currentTaskFailureBinding(bundle.platform, bundle.target, runner)
  const taskMatches = bundle.platform === 'darwin'
    ? task.configured === bundle.prior.loaded
      && (!task.configured || (
        task.path === bundle.target.launchAgentPath
        && task.program === expectedProgram
        && task.state === 'running'
      ))
    : task.configured === true && task.xmlSha256 === bytesDigest(bundle.taskXml)
  if (!taskMatches) {
    throw new AgentHostError('SERVICE_RESTORE_FAILED', 'The restored service task does not match the retained prior state', {
      currentService: {
        schemaVersion: 'openadam.agent-host-service-recovery-observation.v0.1',
        ...publicRestoredService(bundle, service),
        task: {
          configured: task.configured,
          pathMatches: bundle.platform === 'darwin' ? task.path === bundle.target.launchAgentPath : undefined,
          programMatches: bundle.platform === 'darwin' ? task.program === expectedProgram : undefined,
          state: task.state ?? null,
        },
      },
    })
  }
  const expectedRunning = bundle.prior.running
  const expectedLoaded = bundle.platform === 'darwin' ? bundle.prior.loaded : true
  if (service.configured !== true || service.loaded !== expectedLoaded || service.running !== expectedRunning
    || (bundle.prior.ready && service.ready !== true)) {
    throw new AgentHostError('SERVICE_RESTORE_FAILED', 'The restored service state does not match the retained prior state')
  }
  return service
}

async function rebindPartialRestore(recoveryRoot, bundle, runner) {
  const state = await regularFileSnapshot(bundle.lifecycle.statePath)
  const stateMatches = bundle.lifecycle.stateFile === null
    ? state === null
    : byteRecordMatches(bundle.lifecycle.stateFile, state?.contents ?? null)
  const currentStateIdentity = stateContentsIdentity(state?.contents ?? null)
  if (!stateMatches || currentStateIdentity !== bundle.lifecycle.currentStateIdentity) {
    throw new AgentHostError('SERVICE_RECOVERY_TARGET_MISMATCH', 'The lifecycle state changed during the partial service restoration')
  }

  const carrierPath = bundle.platform === 'darwin' ? bundle.target.launchAgentPath : bundle.target.launcherPath
  const carrier = await regularFileSnapshot(carrierPath)
  const priorCarrier = bundle.platform === 'darwin' ? bundle.descriptor : bundle.launcher
  if (carrier === null || !byteRecordMatches({
    bytes: priorCarrier.contents.length,
    sha256: bytesDigest(priorCarrier.contents),
  }, carrier.contents)) {
    throw new AgentHostError('SERVICE_RECOVERY_TARGET_MISMATCH', 'The retained prior service carrier cannot be confirmed after the partial restoration')
  }

  const task = await currentTaskFailureBinding(bundle.platform, bundle.target, runner)
  const taskCanBeRebound = bundle.platform === 'darwin'
    ? task.configured !== null && (!task.configured || task.path === bundle.target.launchAgentPath)
    : task.configured !== null
  if (!taskCanBeRebound) {
    throw new AgentHostError('SERVICE_RECOVERY_TARGET_MISMATCH', 'The current service task cannot be bound after the partial restoration')
  }
  return await rebindServiceRecoveryPartialRestore(
    recoveryRoot,
    bundle.identity,
    bundle.manifestSha256,
    {
      carrierContents: carrier.contents,
      task,
      stateContents: state?.contents ?? null,
      currentStateIdentity,
    },
  )
}

async function replacePrivateFile(path, contents, mode = 0o600) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  const descriptor = await open(temporary, 'wx', mode)
  try {
    await descriptor.writeFile(contents)
    await descriptor.sync()
    await descriptor.close()
    await chmod(temporary, mode)
    await rename(temporary, path)
  } catch (error) {
    await descriptor.close().catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

function requireRecoveryShape(bundle) {
  if (bundle.platform === 'darwin') {
    if (typeof bundle.target.launchAgentPath !== 'string'
      || typeof bundle.target.replacementSocketPath !== 'string'
      || (bundle.target.priorSocketPath !== null && typeof bundle.target.priorSocketPath !== 'string')
      || typeof bundle.prior.loaded !== 'boolean'
      || typeof bundle.prior.running !== 'boolean'
      || typeof bundle.prior.ready !== 'boolean'
      || (bundle.prior.running && !bundle.prior.loaded)
      || (bundle.prior.ready && !bundle.prior.running)
      || (bundle.prior.running && typeof bundle.target.priorSocketPath !== 'string')
      || bundle.replacement.task.label !== SERVICE_LABEL) {
      throw new AgentHostError('SERVICE_RECOVERY_BUNDLE_INVALID', 'The retained service recovery bundle failed identity or content verification')
    }
    return
  }
  if (typeof bundle.target.launcherPath !== 'string'
    || typeof bundle.target.taskName !== 'string'
    || typeof bundle.target.replacementSocketPath !== 'string'
    || (bundle.target.priorSocketPath !== null && typeof bundle.target.priorSocketPath !== 'string')
    || typeof bundle.prior.running !== 'boolean'
    || typeof bundle.prior.ready !== 'boolean'
    || (bundle.prior.ready && !bundle.prior.running)
    || (bundle.prior.running && typeof bundle.target.priorSocketPath !== 'string')
    || bundle.replacement.task.taskName !== bundle.target.taskName
    || bundle.replacement.task.launcherPath !== bundle.target.launcherPath) {
    throw new AgentHostError('SERVICE_RECOVERY_BUNDLE_INVALID', 'The retained service recovery bundle failed identity or content verification')
  }
}

async function loadExpectedRecovery(recoveryRoot, recovery) {
  const bundle = await loadServiceRecoveryBundle(recoveryRoot, recovery.identity)
  if (bundle.manifestSha256 !== recovery.manifestSha256) {
    throw new AgentHostError('SERVICE_RECOVERY_BUNDLE_INVALID', 'The retained service recovery bundle failed identity or content verification')
  }
  return bundle
}

export async function restoreServiceRecoveryBundle(recoveryReference, runner = runFile, options = {}) {
  const recoveryRoot = options.recoveryRoot
  const waitUntilReady = options.waitForEndpoint ?? waitForEndpoint
  const postEndpointCheck = options.endpointReachable ?? (async (path) => waitUntilReady(path, 1))
  let bundle
  let restorationMutationStarted = false
  try {
    if (recoveryReference === null || typeof recoveryReference !== 'object' || Array.isArray(recoveryReference)
      || typeof recoveryReference.identity !== 'string'
      || !/^sha256:[0-9a-f]{64}$/u.test(recoveryReference.manifestSha256 ?? '')) {
      throw new AgentHostError('SERVICE_RECOVERY_BUNDLE_INVALID', 'The retained service recovery bundle failed identity or content verification')
    }
    bundle = await loadServiceRecoveryBundle(recoveryRoot, recoveryReference.identity)
    if (bundle.manifestSha256 !== recoveryReference.manifestSha256) {
      throw new AgentHostError('SERVICE_RECOVERY_BUNDLE_INVALID', 'The retained service recovery bundle failed identity or content verification')
    }
    requireRecoveryShape(bundle)
    if (options.platformName !== undefined && options.platformName !== bundle.platform) {
      throw new AgentHostError('SERVICE_RECOVERY_PLATFORM_MISMATCH', 'The retained service recovery bundle belongs to another operating system')
    }
    if (options.expectedLifecycleStatePath !== undefined
      && bundle.lifecycle.statePath !== options.expectedLifecycleStatePath) {
      throw new AgentHostError('SERVICE_RECOVERY_TARGET_MISMATCH', 'The retained recovery bundle belongs to another Agent Host state root')
    }
    await verifyRecoveryTarget(bundle, runner)
    const expectedProgram = bundle.platform === 'darwin' ? retainedLaunchAgentProgram(bundle.descriptor.contents) : null
    if (bundle.platform === 'darwin') {
      const domain = `gui/${process.getuid()}`
      restorationMutationStarted = true
      await removeLaunchAgentForRollback(domain, bundle.target.launchAgentPath, runner)
      await rm(bundle.target.replacementSocketPath, { force: true })
      await replacePrivateFile(bundle.target.launchAgentPath, bundle.descriptor.contents, bundle.descriptor.mode)
      if (bundle.prior.loaded) {
        await runner('/bin/launchctl', ['bootstrap', domain, bundle.target.launchAgentPath])
        if (bundle.prior.running) {
          await runner('/bin/launchctl', ['kickstart', '-k', `${domain}/${SERVICE_LABEL}`])
          if (bundle.prior.ready && !await waitUntilReady(bundle.target.priorSocketPath)) {
            throw new AgentHostError('SERVICE_RESTORE_FAILED', 'The retained LaunchAgent did not become ready after restoration')
          }
        }
      }
    } else {
      restorationMutationStarted = true
      await removeWindowsTaskForRollback(bundle.target.taskName, runner)
      await replacePrivateFile(bundle.target.launcherPath, bundle.launcher.contents, bundle.launcher.mode)
      const taskXmlPath = `${bundle.target.launcherPath}.restore-task-${process.pid}-${randomUUID()}.xml`
      try {
        await replacePrivateFile(taskXmlPath, bundle.taskXml)
        await runner('schtasks.exe', ['/Create', '/TN', bundle.target.taskName, '/XML', taskXmlPath, '/F'], { timeoutMs: 15_000 })
      } finally {
        await rm(taskXmlPath, { force: true })
      }
      if (bundle.prior.running) {
        await runner('schtasks.exe', ['/Run', '/TN', bundle.target.taskName], { timeoutMs: 15_000 })
        if (bundle.prior.ready && !await waitUntilReady(bundle.target.priorSocketPath)) {
          throw new AgentHostError('SERVICE_RESTORE_FAILED', 'The retained Windows service did not become ready after restoration')
        }
      }
    }
    const service = await verifyRestoredTarget(bundle, runner, postEndpointCheck, expectedProgram)
    await retireServiceRecoveryBundle(recoveryRoot, recoveryReference.identity)
    return {
      schemaVersion: 'openadam.agent-host-service-recovery-result.v0.1',
      status: 'restored',
      recovery: publicRecovery(bundle, { retained: false }),
      service: publicRestoredService(bundle, service),
    }
  } catch (error) {
    if (error instanceof AgentHostError && ['SERVICE_RECOVERY_BUNDLE_INVALID', 'SERVICE_RECOVERY_PLATFORM_MISMATCH', 'SERVICE_RECOVERY_TARGET_MISMATCH'].includes(error.code)) throw error
    const privatePaths = [
      recoveryRoot,
      bundle?.directory,
      bundle?.lifecycle?.statePath,
      ...Object.values(bundle?.target ?? {}),
    ].filter((value) => typeof value === 'string')
    let refreshedRecovery = null
    let recoveryRefreshError = null
    if (restorationMutationStarted && bundle !== undefined) {
      try {
        refreshedRecovery = await rebindPartialRestore(recoveryRoot, bundle, runner)
      } catch (refreshError) {
        recoveryRefreshError = refreshError
      }
    }
    throw new AgentHostError('SERVICE_RECOVERY_FAILED', 'The retained service state could not be restored', {
      failure: boundedServiceFailure(error, 'SERVICE_RESTORE_FAILED', privatePaths),
      ...(error?.details?.currentService?.schemaVersion === 'openadam.agent-host-service-recovery-observation.v0.1'
        ? { currentService: error.details.currentService }
        : {}),
      ...(recoveryRefreshError === null ? {} : {
        recoveryRefresh: boundedServiceFailure(recoveryRefreshError, 'SERVICE_RECOVERY_REBIND_FAILED', privatePaths),
      }),
      recovery: bundle === undefined
        ? { identity: recoveryReference?.identity }
        : publicRecovery(refreshedRecovery ?? bundle, { includeAction: refreshedRecovery !== null }),
    })
  }
}

export async function preflightServiceInstallation(runner = runFile, launchAgentPath = defaultLaunchAgentPath(), platformName = platform()) {
  if (platformName === 'win32') {
    const task = await inspectWindowsTaskState(WINDOWS_SERVICE_TASK, runner)
    if (task.configured) throw new AgentHostError('SERVICE_CONFLICT', 'Another local execution service is already configured', { taskName: WINDOWS_SERVICE_TASK })
    return { supported: true, kind: 'windows-scheduled-task', label: WINDOWS_SERVICE_TASK }
  }
  if (platformName !== 'darwin') {
    throw new AgentHostError('SERVICE_PLATFORM_UNSUPPORTED', `Automatic service installation is not implemented on ${platform()}`)
  }
  try {
    const info = await lstat(launchAgentPath)
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new AgentHostError('SERVICE_PATH_UNSAFE', 'The local execution service path is not a regular file')
    }
    throw new AgentHostError('SERVICE_CONFLICT', 'Another local execution service is already configured', { launchAgentPath })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const domain = `gui/${process.getuid()}`
  const loaded = await runner('/bin/launchctl', ['print', `${domain}/${SERVICE_LABEL}`], { allowFailure: true })
  if (loaded.status === 0) {
    throw new AgentHostError('SERVICE_CONFLICT', 'Another local execution service is already running')
  }
  if (!launchctlConfirmsServiceAbsent(loaded)) {
    throw new AgentHostError('SERVICE_STATE_UNAVAILABLE', 'macOS could not inspect the local execution service state')
  }
  return { supported: true, label: SERVICE_LABEL, launchAgentPath }
}

export async function inspectService(serviceState = null, runner = runFile, options = {}) {
  const platformName = options.platformName ?? platform()
  const endpointCheck = options.endpointReachable ?? endpointReachable
  if (platformName === 'win32') {
    if (serviceState === null || serviceState === undefined) {
      return { supported: true, configured: false, loaded: false, taskName: WINDOWS_SERVICE_TASK }
    }
    const taskName = serviceState.taskName ?? WINDOWS_SERVICE_TASK
    const task = await inspectWindowsTaskState(taskName, runner)
    const socketPresent = task.configured && await endpointCheck(serviceState.socketPath)
    return {
      supported: true,
      configured: task.configured,
      loaded: task.configured,
      running: task.running,
      socketPresent,
      ready: task.configured && task.running && socketPresent,
      taskState: task.state,
      taskName,
      launcherPath: serviceState.launcherPath ?? null,
    }
  }
  if (platformName !== 'darwin') return { supported: false, platform: platformName }
  if (serviceState === null || serviceState === undefined) {
    return { supported: true, configured: false, loaded: false, launchAgentPath: null }
  }
  const domain = `gui/${process.getuid()}`
  const result = await runner('/bin/launchctl', ['print', `${domain}/${SERVICE_LABEL}`], { allowFailure: true })
  if (!commandSucceeded(result) && !launchctlConfirmsServiceAbsent(result)) {
    throw new AgentHostError('SERVICE_STATE_UNAVAILABLE', 'macOS could not inspect the local execution service state')
  }
  const loaded = result.status === 0
  const running = loaded && /^\s*state = running\s*$/mu.test(result.stdout)
  let socketPresent = null
  if (typeof serviceState.socketPath === 'string') {
    if (options.endpointReachable !== undefined) socketPresent = await endpointCheck(serviceState.socketPath)
    else {
      try {
        socketPresent = (await lstat(serviceState.socketPath)).isSocket()
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        socketPresent = false
      }
    }
  }
  const lastExitMatch = result.stdout.match(/^\s*last exit code = (-?\d+)\s*$/mu)
  return {
    supported: true,
    configured: true,
    loaded,
    running,
    socketPresent,
    ready: loaded && running && socketPresent !== false,
    lastExitCode: lastExitMatch === null ? null : Number(lastExitMatch[1]),
    launchAgentPath: serviceState?.launchAgentPath ?? defaultLaunchAgentPath(),
  }
}

export async function installService(runtime, files, runner = runFile, existingState = null, options = {}) {
  const platformName = options.platformName ?? platform()
  const waitUntilReady = options.waitForEndpoint ?? waitForEndpoint
  if (platformName === 'win32') {
    const launcherPath = existingState?.launcherPath ?? defaultWindowsRuntimeLauncherPath(files)
    await mkdir(dirname(launcherPath), { recursive: true, mode: 0o700 })
    const taskName = existingState?.taskName ?? WINDOWS_SERVICE_TASK
    const priorLauncher = await regularFileSnapshot(launcherPath)
    const missingOwnedStateAllowed = options.allowMissingOwnedState === true && existingState?.created === true
    if (existingState !== null && priorLauncher === null && !missingOwnedStateAllowed) {
      throw new AgentHostError('SERVICE_ROLLBACK_STATE_INVALID', 'The retained Windows service launcher is missing')
    }
    const priorTask = existingState === null || priorLauncher === null
      ? null
      : await runner('schtasks.exe', ['/Query', '/TN', taskName, '/XML'], { allowFailure: true, timeoutMs: 5_000 })
    if (priorTask !== null && priorTask.status !== 0) {
      throw new AgentHostError('SERVICE_ROLLBACK_STATE_INVALID', 'The retained Windows scheduled task is missing')
    }
    const priorTaskState = priorTask === null ? null : await inspectWindowsTaskState(taskName, runner)
    if (priorTask !== null && !priorTaskState.configured) {
      throw new AgentHostError('SERVICE_ROLLBACK_STATE_INVALID', 'The retained Windows scheduled task state is unavailable')
    }
    const priorRunning = priorTaskState?.running === true
    const priorReady = priorRunning && (
      options.existingEndpointReady ?? await endpointReachable(existingState.socketPath)
    )
    const recoveryRoot = options.recoveryRoot ?? defaultServiceRecoveryRoot(files)
    const replacementContents = Buffer.from(windowsRuntimeLauncherContents(runtime, files))
    const lifecycle = priorLauncher === null ? null : await recoveryLifecycle(options)
    let recovery = priorLauncher === null ? null : await persistServiceRecoveryBundle({
      recoveryRoot,
      platform: 'win32',
      target: {
        launcherPath,
        taskName,
        replacementSocketPath: files.socketPath,
        priorSocketPath: existingState?.socketPath ?? null,
      },
      prior: { running: priorRunning, ready: priorReady },
      launcher: priorLauncher,
      taskXml: priorTask.stdout,
      replacement: {
        identity: bytesDigest(replacementContents),
        fileContents: replacementContents,
        task: { taskName, launcherPath },
      },
      lifecycle,
    })
    let mutationStarted = false
    try {
      await replacePrivateFile(launcherPath, replacementContents)
      mutationStarted = true
      await runner('schtasks.exe', [
        '/Create', '/TN', taskName, '/SC', 'ONLOGON', '/RL', 'LIMITED',
        '/TR', `"${launcherPath}"`, '/F',
      ], { timeoutMs: 15_000 })
      await runner('schtasks.exe', ['/Run', '/TN', taskName], { timeoutMs: 15_000 })
      if (!await waitUntilReady(files.socketPath)) {
        throw new AgentHostError('SERVICE_START_FAILED', 'The Windows local execution service did not make its named pipe ready')
      }
      if (recovery !== null) await retireServiceRecoveryBundle(recoveryRoot, recovery.identity)
    } catch (error) {
      let rollbackError = null
      try {
        if (!mutationStarted && recovery !== null) {
          await retireServiceRecoveryBundle(recoveryRoot, recovery.identity)
        } else if (mutationStarted) {
          await removeWindowsTaskForRollback(taskName, runner)
          if (recovery === null) {
            await rm(launcherPath, { force: true })
          } else {
            const retained = await loadExpectedRecovery(recoveryRoot, recovery)
            requireRecoveryShape(retained)
            await replacePrivateFile(launcherPath, retained.launcher.contents, retained.launcher.mode)
            const taskXmlPath = `${launcherPath}.restore-task-${process.pid}.xml`
            try {
              await replacePrivateFile(taskXmlPath, retained.taskXml)
              await runner('schtasks.exe', ['/Create', '/TN', taskName, '/XML', taskXmlPath, '/F'], { timeoutMs: 15_000 })
            } finally {
              await rm(taskXmlPath, { force: true })
            }
            if (priorRunning) {
              await runner('schtasks.exe', ['/Run', '/TN', taskName], { timeoutMs: 15_000 })
              if (priorReady && !await waitUntilReady(existingState.socketPath)) {
                throw new AgentHostError('SERVICE_RESTORE_FAILED', 'The retained Windows service did not become ready after restoration')
              }
            }
            await verifyRestoredTarget(retained, runner, async () => priorReady, null)
            await retireServiceRecoveryBundle(recoveryRoot, recovery.identity)
          }
        }
      } catch (failure) {
        rollbackError = failure
      }
      if (rollbackError !== null) {
        let recoveryBindingError = null
        if (recovery !== null) {
          try {
            recovery = await bindRecoveryFailure(
              recoveryRoot,
              recovery,
              'win32',
              { taskName },
              launcherPath,
              runner,
            )
          } catch (bindingError) {
            recoveryBindingError = bindingError
          }
        }
        throw serviceRollbackFailure(
          'The Windows local execution service failed and its previous state could not be restored',
          error,
          rollbackError,
          [launcherPath, files.configPath, files.socketPath, files.observationLog, existingState?.socketPath],
          recovery,
          recoveryBindingError,
        )
      }
      throw error
    }
    return { kind: 'windows-scheduled-task', label: taskName, taskName, launcherPath, socketPath: files.socketPath, created: existingState?.created ?? true }
  }
  if (platformName !== 'darwin') {
    throw new AgentHostError('SERVICE_PLATFORM_UNSUPPORTED', `Automatic service installation is not implemented on ${platformName}`)
  }
  const launchAgentPath = existingState?.launchAgentPath ?? options.launchAgentPath ?? defaultLaunchAgentPath()
  await mkdir(dirname(launchAgentPath), { recursive: true, mode: 0o700 })
  const priorDescriptor = await regularFileSnapshot(launchAgentPath)
  if (priorDescriptor !== null && existingState === null) {
    const current = priorDescriptor.contents.toString('utf8')
    if (!current.includes(`<string>${SERVICE_LABEL}</string>`)) {
      throw new AgentHostError('SERVICE_CONFLICT', 'The local execution service path belongs to another service', { launchAgentPath })
    }
    throw new AgentHostError('SERVICE_CONFLICT', 'Another local execution service is already configured', { launchAgentPath })
  }
  const missingOwnedStateAllowed = options.allowMissingOwnedState === true && existingState?.created === true
  if (existingState !== null && priorDescriptor === null && !missingOwnedStateAllowed) {
    throw new AgentHostError('SERVICE_ROLLBACK_STATE_INVALID', 'The retained LaunchAgent descriptor is missing')
  }
  const domain = `gui/${process.getuid()}`
  const priorInspection = existingState === null
    ? null
    : await runner('/bin/launchctl', ['print', `${domain}/${SERVICE_LABEL}`], { allowFailure: true, timeoutMs: 5_000 })
  if (priorInspection !== null
    && !commandSucceeded(priorInspection)
    && !launchctlConfirmsServiceAbsent(priorInspection)) {
    throw new AgentHostError(
      'SERVICE_STATE_UNAVAILABLE',
      'macOS could not inspect the retained local execution service before replacement',
    )
  }
  const priorLoaded = priorInspection !== null && commandSucceeded(priorInspection)
  const priorRunning = priorLoaded && /^\s*state = running\s*$/mu.test(priorInspection.stdout)
  if (priorLoaded && !priorRunning) {
    throw new AgentHostError(
      'SERVICE_PRIOR_STATE_UNRESTORABLE',
      'The retained LaunchAgent is loaded but stopped; refusing an update that cannot preserve that state exactly',
    )
  }
  const priorReady = priorRunning && (
    options.existingEndpointReady ?? await endpointReachable(existingState.socketPath)
  )
  const recoveryRoot = options.recoveryRoot ?? defaultServiceRecoveryRoot(files)
  const replacementContents = Buffer.from(launchAgentContents(runtime, files))
  const lifecycle = priorDescriptor === null ? null : await recoveryLifecycle(options)
  let recovery = priorDescriptor === null ? null : await persistServiceRecoveryBundle({
    recoveryRoot,
    platform: 'darwin',
    target: {
      launchAgentPath,
      replacementSocketPath: files.socketPath,
      priorSocketPath: existingState?.socketPath ?? null,
    },
    prior: { loaded: priorLoaded, running: priorRunning, ready: priorReady },
    descriptor: priorDescriptor,
    replacement: {
      identity: bytesDigest(replacementContents),
      fileContents: replacementContents,
      task: { label: SERVICE_LABEL },
    },
    lifecycle,
  })
  let mutationStarted = false
  try {
    await replacePrivateFile(launchAgentPath, replacementContents)
    mutationStarted = true
    if (priorDescriptor !== null) {
      await removeLaunchAgentForRollback(domain, launchAgentPath, runner)
    }
    await runner('/bin/launchctl', ['bootstrap', domain, launchAgentPath])
    await runner('/bin/launchctl', ['kickstart', '-k', `${domain}/${SERVICE_LABEL}`])
    if (!await waitUntilReady(files.socketPath)) {
      throw new AgentHostError('SERVICE_START_FAILED', 'The local execution service did not finish provider preparation and make its Socket ready')
    }
    if (recovery !== null) await retireServiceRecoveryBundle(recoveryRoot, recovery.identity)
  } catch (error) {
    let rollbackError = null
    try {
      if (!mutationStarted && recovery !== null) {
        await retireServiceRecoveryBundle(recoveryRoot, recovery.identity)
      } else if (mutationStarted) {
        await removeLaunchAgentForRollback(domain, launchAgentPath, runner)
        await rm(files.socketPath, { force: true }).catch((failure) => {
          if (failure.code !== 'ENOENT') throw failure
        })
        if (recovery === null) {
          await rm(launchAgentPath, { force: true })
        } else {
          const retained = await loadExpectedRecovery(recoveryRoot, recovery)
          requireRecoveryShape(retained)
          await replacePrivateFile(launchAgentPath, retained.descriptor.contents, retained.descriptor.mode)
          if (priorLoaded) {
            await runner('/bin/launchctl', ['bootstrap', domain, launchAgentPath])
            if (priorRunning) {
              await runner('/bin/launchctl', ['kickstart', '-k', `${domain}/${SERVICE_LABEL}`])
              if (priorReady && !await waitUntilReady(existingState.socketPath)) {
                throw new AgentHostError('SERVICE_RESTORE_FAILED', 'The retained LaunchAgent did not become ready after restoration')
              }
            }
          }
          const expectedProgram = retainedLaunchAgentProgram(retained.descriptor.contents)
          await verifyRestoredTarget(retained, runner, async () => priorReady, expectedProgram)
          await retireServiceRecoveryBundle(recoveryRoot, recovery.identity)
        }
      }
    } catch (failure) {
      rollbackError = failure
    }
    if (rollbackError !== null) {
      let recoveryBindingError = null
      if (recovery !== null) {
        try {
          recovery = await bindRecoveryFailure(
            recoveryRoot,
            recovery,
            'darwin',
            { launchAgentPath, program: runtime.command },
            launchAgentPath,
            runner,
          )
        } catch (bindingError) {
          recoveryBindingError = bindingError
        }
      }
      throw serviceRollbackFailure(
        'The local execution service failed and its previous state could not be restored',
        error,
        rollbackError,
        [launchAgentPath, files.configPath, files.socketPath, files.observationLog, existingState?.socketPath],
        recovery,
        recoveryBindingError,
      )
    }
    throw error
  }
  return { kind: 'launchd', label: SERVICE_LABEL, launchAgentPath, socketPath: files.socketPath, created: existingState?.created ?? true }
}

export async function uninstallService(serviceState, runner = runFile, options = {}) {
  if (serviceState === null || serviceState === undefined) return { removed: false }
  const platformName = options.platformName ?? platform()
  if (platformName === 'win32') {
    const taskName = serviceState.taskName ?? WINDOWS_SERVICE_TASK
    await removeWindowsTaskForRollback(taskName, runner)
    if (serviceState.created && typeof serviceState.launcherPath === 'string') await rm(serviceState.launcherPath, { force: true })
    return { removed: serviceState.created === true }
  }
  if (platformName !== 'darwin') return { removed: false, unsupported: true }
  const domain = `gui/${process.getuid()}`
  await removeLaunchAgentForRollback(domain, serviceState.launchAgentPath, runner)
  if (serviceState.created) await rm(serviceState.launchAgentPath, { force: true })
  return { removed: serviceState.created }
}
