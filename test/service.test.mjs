import { assertPrivateAccess } from '../src/private-permissions.mjs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { inspectService, installService, launchAgentContents, preflightServiceInstallation, retainedLaunchAgentProgram, restoreServiceRecoveryBundle, SERVICE_LABEL, uninstallService } from '../src/service.mjs'
import { bindServiceRecoveryFailure, loadServiceRecoveryBundle, persistServiceRecoveryBundle } from '../src/service-recovery.mjs'
import { recoverServiceInstallation } from '../src/lifecycle.mjs'
import { withLifecycleMutation } from '../src/lifecycle-lock.mjs'
import { canonicalJson } from '../src/json.mjs'

const cliModuleUrl = new URL('../src/cli.mjs', import.meta.url).href
const TEST_STATE_IDENTITY = `sha256:${createHash('sha256').update('absent-state-file').digest('hex')}`

function installedHostState(service) {
  return {
    schemaVersion: 'openadam.agent-host-state.v0.1',
    suiteVersion: '0.1.5',
    channel: 'release',
    profile: 'standard',
    installedAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
    components: {},
    hosts: {},
    runtime: { service },
    observability: {},
  }
}

function stateIdentity(state) {
  return `sha256:${createHash('sha256').update(canonicalJson(state)).digest('hex')}`
}

function bytesIdentity(contents) {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`
}

test('service recovery cannot enter while another lifecycle mutation owns the selected state root', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-service-recovery-lock-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  let release
  let entered
  const ready = new Promise((resolvePromise) => { entered = resolvePromise })
  const held = withLifecycleMutation({ root: stateRoot }, 'test.service-recovery-owner', {}, async () => {
    entered()
    await new Promise((resolvePromise) => { release = resolvePromise })
  })
  await ready
  let restoreCalls = 0
  try {
    await assert.rejects(
      recoverServiceInstallation({
        stateRoot,
        recovery: 'service-recovery-v2-00000000-0000-4000-8000-000000000000',
        manifestSha256: `sha256:${'0'.repeat(64)}`,
      }, {
        preflightServiceRecovery: async () => stateRoot,
        restoreServiceRecoveryBundle: async () => { restoreCalls += 1 },
      }),
      (error) => error.code === 'LIFECYCLE_BUSY',
    )
    assert.equal(restoreCalls, 0)
  } finally {
    release()
    await held
  }
})

test('LaunchAgent uses an argument array and no shell interpretation', () => {
  const plist = launchAgentContents(
    { command: '/opt/node', args: ['/opt/runtime/cli.mjs'] },
    { configPath: '/private/config.json', socketPath: '/private/runtime.sock', observationLog: '/private/observations.jsonl' },
  )
  assert.match(plist, new RegExp(SERVICE_LABEL.replaceAll('.', '\\.')))
  assert.match(plist, /<string>\/opt\/node<\/string>/)
  assert.match(plist, /<string>serve<\/string>/)
  assert.match(plist, /<key>PATH<\/key>/)
  assert.match(plist, /\/opt\/homebrew\/bin/)
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/)
  assert.doesNotMatch(plist, /<key>Program<\/key>/)
  assert.doesNotMatch(plist, /sh -c/)
})

test('retained LaunchAgent program parsing accepts one direct identity and rejects ambiguous structure', () => {
  const directProgram = '<plist version="1.0"><dict><key>Program</key><string>/opt/direct-node</string></dict></plist>'
  assert.equal(retainedLaunchAgentProgram(Buffer.from(directProgram)), '/opt/direct-node')
  const argumentProgram = launchAgentContents(
    { command: '/opt/argument&node', args: ['/opt/runtime/cli.mjs'] },
    { configPath: '/opt/config.json', socketPath: '/opt/runtime.sock', observationLog: '/opt/observations.jsonl' },
  )
  assert.equal(retainedLaunchAgentProgram(Buffer.from(argumentProgram)), '/opt/argument&node')

  for (const descriptor of [
    '<plist version="1.0"><dict><key>Program</key><string>/opt/a</string><key>Program</key><string>/opt/b</string></dict></plist>',
    '<plist version="1.0"><dict><key>Program</key><string>/opt/a</string><key>ProgramArguments</key><array><string>/opt/a</string></array></dict></plist>',
    '<plist version="1.0"><dict><key>Wrapper</key><dict><key>Program</key><string>/opt/nested</string></dict></dict></plist>',
    '<plist version="1.0"><dict><key>ProgramArguments</key><array><dict><key>Command</key><string>/opt/nested</string></dict></array></dict></plist>',
    '<plist version="1.0"><dict><key>ProgramArguments</key><array><true/><string>/opt/late</string></array></dict></plist>',
    '<plist version="1.0"><dict><key>Program</key><string><dict></dict>/opt/nested-string</string></dict></plist>',
    '<plist version="1.0"><dict><key>Pro&#x67;ram</key><string>/opt/entity-key</string></dict></plist>',
    '<!DOCTYPE plist [<!ENTITY command "/opt/entity">]><plist version="1.0"><dict><key>Program</key><string>&command;</string></dict></plist>',
  ]) {
    assert.throws(
      () => retainedLaunchAgentProgram(Buffer.from(descriptor)),
      (error) => error.code === 'SERVICE_RECOVERY_BUNDLE_INVALID',
    )
  }
})

test('invalid retained LaunchAgent program structure fails before recovery mutation', { skip: process.platform !== 'darwin' }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-host-invalid-retained-program-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const recoveryRoot = join(directory, 'service-recovery')
  const launchAgentPath = join(directory, 'agent-host.plist')
  const replacementSocketPath = join(directory, 'new.sock')
  const failedReplacement = Buffer.from('failed replacement descriptor\n')
  await writeFile(launchAgentPath, failedReplacement, { mode: 0o600 })
  const persisted = await persistServiceRecoveryBundle({
    recoveryRoot,
    platform: 'darwin',
    target: { launchAgentPath, priorSocketPath: join(directory, 'old.sock'), replacementSocketPath },
    prior: { loaded: true, running: true, ready: true },
    descriptor: {
      contents: Buffer.from('<plist version="1.0"><dict><key>ProgramArguments</key><array><dict><key>Program</key><string>/opt/nested</string></dict></array></dict></plist>'),
      mode: 0o600,
    },
    replacement: {
      identity: bytesIdentity(failedReplacement),
      fileContents: failedReplacement,
      task: { label: SERVICE_LABEL },
    },
    lifecycle: {
      statePath: join(directory, 'state.json'),
      currentStateIdentity: TEST_STATE_IDENTITY,
      stateContents: null,
    },
  })
  const recovery = await bindServiceRecoveryFailure(recoveryRoot, persisted.identity, persisted.manifestSha256, {
    carrierContents: failedReplacement,
    task: { configured: true, path: launchAgentPath, program: '/opt/new-node', state: 'running' },
  })
  const calls = []
  await assert.rejects(
    restoreServiceRecoveryBundle(recovery, async (_command, args) => {
      calls.push(args)
      if (args[0] === 'print') {
        return { status: 0, stdout: `path = ${launchAgentPath}\nprogram = /opt/new-node\nstate = running\n`, stderr: '' }
      }
      throw new Error('invalid retained program mutated the service')
    }, { platformName: 'darwin', recoveryRoot }),
    (error) => error.code === 'SERVICE_RECOVERY_BUNDLE_INVALID',
  )
  assert.deepEqual(calls.map((args) => args[0]), ['print'])
  assert.deepEqual(await readFile(launchAgentPath), failedReplacement)
  assert.equal((await lstat(persisted.directory)).isDirectory(), true)
})

test('service preflight reports an existing LaunchAgent before setup mutates a host', { skip: process.platform !== 'darwin' }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-host-service-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'agent-host.plist')
  await writeFile(path, 'existing\n')
  let calls = 0
  await assert.rejects(
    preflightServiceInstallation(async () => { calls += 1 }, path),
    (error) => error.code === 'SERVICE_CONFLICT' && !error.message.includes(path),
  )
  assert.equal(calls, 0)
})

test('service preflight admits a missing path only when the launchd label is absent', { skip: process.platform !== 'darwin' }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-host-service-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'agent-host.plist')
  const ready = await preflightServiceInstallation(async () => ({
    status: 113,
    stdout: '',
    stderr: `Could not find service "${SERVICE_LABEL}" in domain\n`,
  }), path)
  assert.equal(ready.launchAgentPath, path)
})

test('service preflight and inspection do not convert host query failures into absence', { skip: process.platform !== 'darwin' }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-host-service-query-failure-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const launchAgentPath = join(directory, 'agent-host.plist')
  const failedQuery = async () => ({ status: 5, stdout: '', stderr: 'permission denied\n' })

  await assert.rejects(
    preflightServiceInstallation(failedQuery, launchAgentPath, 'darwin'),
    (error) => error.code === 'SERVICE_STATE_UNAVAILABLE',
  )
  await assert.rejects(
    inspectService({ launchAgentPath, socketPath: join(directory, 'runtime.sock') }, failedQuery, { platformName: 'darwin' }),
    (error) => error.code === 'SERVICE_STATE_UNAVAILABLE',
  )
  await assert.rejects(
    preflightServiceInstallation(failedQuery, launchAgentPath, 'win32'),
    (error) => error.code === 'SERVICE_STATE_UNAVAILABLE',
  )
  await assert.rejects(
    inspectService({ taskName: '\\openAdam\\AgentHostRuntime', socketPath: '\\\\.\\pipe\\agent-host-query-failure' }, failedQuery, { platformName: 'win32' }),
    (error) => error.code === 'SERVICE_STATE_UNAVAILABLE',
  )
})

test('service inspection does not adopt another installation when this state has no service', async () => {
  let calls = 0
  const status = await inspectService(null, async () => {
    calls += 1
    return { status: 0, stdout: 'another service', stderr: '' }
  })
  assert.equal(status.configured, false)
  assert.equal(status.loaded, false)
  assert.equal(calls, 0)
})

test('service inspection distinguishes a loaded crash loop from a ready socket service', { skip: process.platform !== 'darwin' }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-host-service-socket-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const socketPath = join(directory, 'missing.sock')
  const status = await inspectService(
    { launchAgentPath: join(directory, 'agent-host.plist'), socketPath },
    async () => ({ status: 0, stdout: 'state = spawn scheduled\nlast exit code = 1\n', stderr: '' }),
  )
  assert.equal(status.loaded, true)
  assert.equal(status.running, false)
  assert.equal(status.socketPresent, false)
  assert.equal(status.ready, false)
  assert.equal(status.lastExitCode, 1)
})

test('a historical macOS recovery bundle can be restored by another process', { skip: process.platform === 'win32' }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-host-service-durable-recovery-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const launchAgentPath = join(directory, 'agent-host.plist')
  const configPath = join(directory, 'config.json')
  const recoveryRoot = join(directory, 'service-recovery')
  const lifecycleStatePath = join(await realpath(directory), 'state.json')
  const priorSocketPath = join(directory, 'old.sock')
  const priorContents = Buffer.from(launchAgentContents(
    { command: '/opt/old-node', args: ['/opt/old-runtime/cli.mjs'] },
    { configPath, socketPath: priorSocketPath, observationLog: join(directory, 'old-observations.jsonl') },
  ))
  await writeFile(launchAgentPath, priorContents, { mode: 0o640 })
  const originalState = installedHostState({ launchAgentPath, socketPath: priorSocketPath, created: true })
  const originalStateBytes = Buffer.from(`${JSON.stringify(originalState, null, 2)}\n`)
  await writeFile(lifecycleStatePath, originalStateBytes, { mode: 0o600 })
  const replacement = Buffer.from(launchAgentContents(
    { command: '/opt/new-node', args: ['/opt/new-runtime/cli.mjs'] },
    { configPath, socketPath: join(directory, 'new.sock'), observationLog: join(directory, 'observations.jsonl') },
  ))
  const persisted = await persistServiceRecoveryBundle({
    recoveryRoot, platform: 'darwin',
    target: { launchAgentPath, priorSocketPath, replacementSocketPath: join(directory, 'new.sock') },
    prior: { loaded: true, running: true, ready: true },
    descriptor: { contents: priorContents, mode: 0o640 },
    replacement: { identity: bytesIdentity(replacement), fileContents: replacement, task: { label: SERVICE_LABEL } },
    lifecycle: { statePath: lifecycleStatePath, currentStateIdentity: stateIdentity(originalState), stateContents: originalStateBytes },
  })
  await writeFile(launchAgentPath, replacement, { mode: 0o600 })
  const recoveryReference = await bindServiceRecoveryFailure(recoveryRoot, persisted.identity, persisted.manifestSha256, {
    carrierContents: replacement, task: { configured: true, path: launchAgentPath, program: '/opt/new-node', state: 'running' },
  })
  const recoveryIdentity = recoveryReference.identity
  const bundleDirectory = join(recoveryRoot, recoveryIdentity)
  assert.deepEqual((await readdir(bundleDirectory)).sort(), ['launch-agent.plist', 'manifest.json'])
  await assertPrivateAccess(recoveryRoot, await lstat(recoveryRoot))
  await assertPrivateAccess(bundleDirectory, await lstat(bundleDirectory))
  assert.match(await readFile(launchAgentPath, 'utf8'), /<key>Label<\/key>/u)
  const failedReplacementDescriptor = await readFile(launchAgentPath)
  const retainedBundle = await loadServiceRecoveryBundle(recoveryRoot, recoveryIdentity)
  assert.deepEqual(retainedBundle.failureBinding.task, {
    configured: true,
    path: launchAgentPath,
    program: '/opt/new-node',
    state: 'running',
  })

  const recoveryCliScript = String.raw`
const { main } = await import(process.argv[1])
let calls = 0
let restored = false
const reference = JSON.parse(process.argv[3])
const failureJob = JSON.parse(process.argv[4])
const restoredJob = JSON.parse(process.argv[6])
const runner = async (_command, args) => {
  calls += 1
  if (args[0] === 'print') {
    const job = restored
      ? restoredJob
      : failureJob
    return { status: 0, stdout: ['path = ' + job.path, 'program = ' + job.program, 'state = ' + job.state, ''].join(String.fromCharCode(10)), stderr: '' }
  }
  if (args[0] === 'bootstrap') restored = true
  return { status: 0, stdout: '', stderr: '' }
}
const status = await main([
  'service', 'recover',
  '--recovery', reference.identity,
  '--manifest-sha256', reference.manifestSha256,
  '--state-root', process.argv[2],
  '--json',
], { runner, platformName: 'darwin', waitForEndpoint: async () => true, endpointReachable: async () => true })
process.stdout.write('__RECOVERY_CALLS__' + String(calls) + String.fromCharCode(10))
process.exitCode = status
`
  const recoverThroughCli = async (
    reference,
    failureJob = { path: launchAgentPath, program: '/opt/new-node', state: 'running' },
    restoredJob = { path: launchAgentPath, program: '/opt/old-node', state: 'running' },
  ) => {
    const result = spawnSync(process.execPath, [
      '--input-type=module', '-e', recoveryCliScript,
      cliModuleUrl, directory, JSON.stringify(reference), JSON.stringify(failureJob), launchAgentPath, JSON.stringify(restoredJob),
    ], { encoding: 'utf8' })
    const marker = result.stdout.match(/__RECOVERY_CALLS__([0-9]+)\n$/u)
    assert.notEqual(marker, null)
    return { ...result, stdout: result.stdout.slice(0, marker.index), calls: Number(marker[1]) }
  }

  await rm(lifecycleStatePath)
  const entriesBeforeMissingStateRecovery = await readdir(directory)
  const blockedByMissingState = await recoverThroughCli(recoveryReference)
  assert.equal(blockedByMissingState.status, 1)
  assert.equal(JSON.parse(blockedByMissingState.stderr).error.code, 'SERVICE_RECOVERY_STATE_INVALID')
  assert.equal(blockedByMissingState.calls, 0)
  assert.deepEqual(await readFile(launchAgentPath), failedReplacementDescriptor)
  assert.equal((await lstat(bundleDirectory)).isDirectory(), true)
  assert.deepEqual(await readdir(directory), entriesBeforeMissingStateRecovery)
  await writeFile(lifecycleStatePath, originalStateBytes, { mode: 0o600 })

  const newerState = { ...originalState, updatedAt: '2026-09-04T00:00:01.000Z' }
  await writeFile(lifecycleStatePath, `${JSON.stringify(newerState, null, 2)}\n`, { mode: 0o600 })
  const blockedByNewerState = await recoverThroughCli(recoveryReference)
  assert.equal(blockedByNewerState.status, 1)
  assert.equal(JSON.parse(blockedByNewerState.stderr).error.code, 'SERVICE_RECOVERY_TARGET_MISMATCH')
  assert.equal(blockedByNewerState.calls, 0)
  assert.deepEqual(await readFile(launchAgentPath), failedReplacementDescriptor)
  assert.equal((await lstat(bundleDirectory)).isDirectory(), true)
  await writeFile(lifecycleStatePath, originalStateBytes, { mode: 0o600 })

  await writeFile(launchAgentPath, 'newer descriptor must not be overwritten\n')
  const blockedByNewerCarrier = await recoverThroughCli(recoveryReference)
  assert.equal(blockedByNewerCarrier.status, 1)
  assert.equal(JSON.parse(blockedByNewerCarrier.stderr).error.code, 'SERVICE_RECOVERY_TARGET_MISMATCH')
  assert.equal(blockedByNewerCarrier.calls, 0)
  assert.equal(await readFile(launchAgentPath, 'utf8'), 'newer descriptor must not be overwritten\n')
  assert.equal((await lstat(bundleDirectory)).isDirectory(), true)
  await writeFile(launchAgentPath, failedReplacementDescriptor)

  for (const changedJob of [
    { path: join(directory, 'unrelated.plist'), program: '/opt/new-node', state: 'running' },
    { path: launchAgentPath, program: '/opt/unrelated-node', state: 'running' },
    { path: launchAgentPath, program: '/opt/new-node', state: 'exited' },
  ]) {
    const blockedByChangedJob = await recoverThroughCli(recoveryReference, changedJob)
    assert.equal(blockedByChangedJob.status, 1)
    assert.equal(JSON.parse(blockedByChangedJob.stderr).error.code, 'SERVICE_RECOVERY_TARGET_MISMATCH')
    assert.equal(blockedByChangedJob.calls, 1)
    assert.deepEqual(await readFile(launchAgentPath), failedReplacementDescriptor)
    assert.equal((await lstat(bundleDirectory)).isDirectory(), true)
  }

  const wrongDigest = await recoverThroughCli({ ...recoveryReference, manifestSha256: `sha256:${'0'.repeat(64)}` })
  assert.equal(wrongDigest.status, 1)
  assert.equal(JSON.parse(wrongDigest.stderr).error.code, 'SERVICE_RECOVERY_BUNDLE_INVALID')
  assert.equal(wrongDigest.calls, 0)
  assert.deepEqual(await readFile(launchAgentPath), failedReplacementDescriptor)
  assert.equal((await lstat(bundleDirectory)).isDirectory(), true)

  const unknown = await recoverThroughCli({ ...recoveryReference, identity: 'service-recovery-v2-00000000-0000-4000-8000-000000000000' })
  assert.equal(unknown.status, 1)
  assert.equal(JSON.parse(unknown.stderr).error.code, 'SERVICE_RECOVERY_BUNDLE_INVALID')
  assert.equal(unknown.calls, 0)
  assert.deepEqual(await readFile(launchAgentPath), failedReplacementDescriptor)
  assert.equal((await lstat(bundleDirectory)).isDirectory(), true)

  await writeFile(join(bundleDirectory, 'launch-agent.plist'), 'tampered prior bytes\n', { mode: 0o600 })
  const tampered = await recoverThroughCli(recoveryReference)
  assert.equal(tampered.status, 1)
  assert.equal(JSON.parse(tampered.stderr).error.code, 'SERVICE_RECOVERY_BUNDLE_INVALID')
  assert.equal(tampered.calls, 0)
  assert.deepEqual(await readFile(launchAgentPath), failedReplacementDescriptor)
  assert.equal((await lstat(bundleDirectory)).isDirectory(), true)
  await writeFile(join(bundleDirectory, 'launch-agent.plist'), priorContents, { mode: 0o600 })

  const wrongRestoredProgram = await recoverThroughCli(
    recoveryReference,
    { path: launchAgentPath, program: '/opt/new-node', state: 'running' },
    { path: launchAgentPath, program: '/opt/not-the-retained-program', state: 'running' },
  )
  assert.equal(wrongRestoredProgram.status, 1)
  const wrongRestoredError = JSON.parse(wrongRestoredProgram.stderr).error
  assert.equal(wrongRestoredError.code, 'SERVICE_RECOVERY_FAILED')
  assert.equal(wrongRestoredError.details.failure.code, 'SERVICE_RESTORE_FAILED')
  assert.deepEqual(wrongRestoredError.details.currentService, {
    schemaVersion: 'openadam.agent-host-service-recovery-observation.v0.1',
    platform: 'darwin',
    kind: 'launchd',
    configured: true,
    loaded: true,
    running: true,
    socketPresent: true,
    ready: true,
    lastExitCode: null,
    task: { configured: true, pathMatches: true, programMatches: false, state: 'running' },
  })
  assert.equal(JSON.stringify(wrongRestoredError).includes(directory), false)
  assert.deepEqual(await readFile(launchAgentPath), priorContents)
  assert.equal((await lstat(bundleDirectory)).isDirectory(), true)
  const refreshedRecovery = wrongRestoredError.details.recovery
  assert.equal(refreshedRecovery.phase, 'partial-restore')
  assert.equal(refreshedRecovery.retryable, true)
  assert.equal(refreshedRecovery.identity, recoveryReference.identity)
  assert.notEqual(refreshedRecovery.manifestSha256, recoveryReference.manifestSha256)
  assert.deepEqual(refreshedRecovery.action, {
    command: 'agent-host',
    arguments: [
      'service', 'recover',
      '--recovery', refreshedRecovery.identity,
      '--manifest-sha256', refreshedRecovery.manifestSha256,
    ],
  })
  const partialBundle = await loadServiceRecoveryBundle(recoveryRoot, recoveryIdentity)
  assert.equal(partialBundle.phase, 'partial-restore')
  assert.equal(partialBundle.manifestSha256, refreshedRecovery.manifestSha256)
  assert.deepEqual(partialBundle.failureBinding.task, {
    configured: true,
    path: launchAgentPath,
    program: '/opt/not-the-retained-program',
    state: 'running',
  })

  const staleInitialRecovery = await recoverThroughCli(
    recoveryReference,
    { path: launchAgentPath, program: '/opt/not-the-retained-program', state: 'running' },
  )
  assert.equal(staleInitialRecovery.status, 1)
  assert.equal(JSON.parse(staleInitialRecovery.stderr).error.code, 'SERVICE_RECOVERY_BUNDLE_INVALID')
  assert.equal(staleInitialRecovery.calls, 0)
  assert.deepEqual(await readFile(launchAgentPath), priorContents)

  const repeatedWrong = await recoverThroughCli(
    refreshedRecovery,
    { path: launchAgentPath, program: '/opt/not-the-retained-program', state: 'running' },
    { path: launchAgentPath, program: '/opt/still-not-the-retained-program', state: 'running' },
  )
  assert.equal(repeatedWrong.status, 1)
  const repeatedWrongError = JSON.parse(repeatedWrong.stderr).error
  assert.equal(repeatedWrongError.code, 'SERVICE_RECOVERY_FAILED')
  assert.equal(repeatedWrongError.details.recovery.phase, 'partial-restore')
  assert.equal(repeatedWrongError.details.recovery.retryable, true)
  assert.notEqual(repeatedWrongError.details.recovery.manifestSha256, refreshedRecovery.manifestSha256)
  assert.deepEqual(await readFile(launchAgentPath), priorContents)
  const latestRecovery = repeatedWrongError.details.recovery

  const stalePartialRecovery = await recoverThroughCli(
    refreshedRecovery,
    { path: launchAgentPath, program: '/opt/still-not-the-retained-program', state: 'running' },
  )
  assert.equal(stalePartialRecovery.status, 1)
  assert.equal(JSON.parse(stalePartialRecovery.stderr).error.code, 'SERVICE_RECOVERY_BUNDLE_INVALID')
  assert.equal(stalePartialRecovery.calls, 0)
  assert.deepEqual(await readFile(launchAgentPath), priorContents)

  const partialManifestPath = join(bundleDirectory, 'manifest.json')
  const partialManifestBytes = await readFile(partialManifestPath)
  await writeFile(partialManifestPath, `${partialManifestBytes.toString('utf8')} `, { mode: 0o600 })
  const tamperedPartial = await recoverThroughCli(
    latestRecovery,
    { path: launchAgentPath, program: '/opt/still-not-the-retained-program', state: 'running' },
  )
  assert.equal(tamperedPartial.status, 1)
  assert.equal(JSON.parse(tamperedPartial.stderr).error.code, 'SERVICE_RECOVERY_BUNDLE_INVALID')
  assert.equal(tamperedPartial.calls, 0)
  assert.deepEqual(await readFile(launchAgentPath), priorContents)
  await writeFile(partialManifestPath, partialManifestBytes, { mode: 0o600 })

  const restored = await recoverThroughCli(
    latestRecovery,
    { path: launchAgentPath, program: '/opt/still-not-the-retained-program', state: 'running' },
  )
  assert.equal(restored.status, 0)
  const restoredResult = JSON.parse(restored.stdout)
  assert.equal(restoredResult.schemaVersion, 'openadam.agent-host-service-recovery-result.v0.1')
  assert.equal(restoredResult.status, 'restored')
  assert.equal(restoredResult.recovery.retained, false)
  assert.equal(restoredResult.service.running, true)
  assert.equal(restoredResult.service.ready, true)
  assert.equal(JSON.stringify(restoredResult).includes(directory), false)
  assert.equal(restored.calls > 0, true)
  assert.deepEqual(await readFile(launchAgentPath), priorContents)
  await assert.rejects(() => access(bundleDirectory), (error) => error.code === 'ENOENT')
})

test('a historical Windows bundle retains checksummed launcher and Task XML until exact recovery', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-host-windows-durable-recovery-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const launcherPath = join(directory, 'service.cmd')
  const configPath = join(directory, 'config.json')
  const recoveryRoot = join(directory, 'service-recovery')
  const priorContents = Buffer.from('@echo durable prior\r\n')
  const priorXml = '<Task version="1.4"><Actions><Exec/></Actions></Task>'
  await writeFile(launcherPath, priorContents, { mode: 0o600 })
  const replacement = Buffer.from('@echo C:\\AgentHost\\new-node.exe\r\n')
  const persisted = await persistServiceRecoveryBundle({
    recoveryRoot, platform: 'win32',
    target: { launcherPath, taskName: '\\openAdam\\AgentHostRuntime', priorSocketPath: '\\\\.\\pipe\\agent-host-old-durable', replacementSocketPath: '\\\\.\\pipe\\agent-host-new-durable' },
    prior: { running: true, ready: true }, launcher: { contents: priorContents, mode: 0o600 }, taskXml: priorXml,
    replacement: { identity: bytesIdentity(replacement), fileContents: replacement, task: { taskName: '\\openAdam\\AgentHostRuntime', launcherPath } },
    lifecycle: { statePath: join(directory, 'state.json'), currentStateIdentity: TEST_STATE_IDENTITY, stateContents: null },
  })
  await writeFile(launcherPath, replacement, { mode: 0o600 })
  const recoveryReference = await bindServiceRecoveryFailure(recoveryRoot, persisted.identity, persisted.manifestSha256, {
    carrierContents: replacement, task: { configured: true, xmlSha256: bytesIdentity(Buffer.from(priorXml)) },
  })
  const recoveryIdentity = recoveryReference.identity
  const retained = await loadServiceRecoveryBundle(recoveryRoot, recoveryIdentity)
  assert.deepEqual(retained.launcher.contents, priorContents)
  assert.equal(retained.taskXml.toString('utf8'), priorXml)
  assert.deepEqual((await readdir(retained.directory)).sort(), ['manifest.json', 'runtime-service.cmd', 'scheduled-task.xml'])

  await writeFile(join(directory, 'state.json'), '{"suiteVersion":"newer-success"}\n')
  let newerStateCalls = 0
  await assert.rejects(
    restoreServiceRecoveryBundle(recoveryReference, async () => { newerStateCalls += 1 }, { platformName: 'win32', recoveryRoot }),
    (error) => error.code === 'SERVICE_RECOVERY_TARGET_MISMATCH',
  )
  assert.equal(newerStateCalls, 0)
  assert.match(await readFile(launcherPath, 'utf8'), /new-node\.exe/u)
  assert.equal((await lstat(retained.directory)).isDirectory(), true)
  await rm(join(directory, 'state.json'))

  let changedTaskCalls = 0
  await assert.rejects(
    restoreServiceRecoveryBundle(recoveryReference, async (_command, args) => {
      changedTaskCalls += 1
      if (args[0] === '/Query') return { status: 0, stdout: '<Task><Actions><Exec><Command>newer.exe</Command></Exec></Actions></Task>', stderr: '' }
      throw new Error('recovery mutated a mismatched task')
    }, { platformName: 'win32', recoveryRoot }),
    (error) => error.code === 'SERVICE_RECOVERY_TARGET_MISMATCH',
  )
  assert.equal(changedTaskCalls, 1)
  assert.match(await readFile(launcherPath, 'utf8'), /new-node\.exe/u)
  assert.equal((await lstat(retained.directory)).isDirectory(), true)

  await writeFile(join(retained.directory, 'scheduled-task.xml'), 'tampered', { mode: 0o600 })
  let recoveryCalls = 0
  await assert.rejects(
    restoreServiceRecoveryBundle(recoveryReference, async () => { recoveryCalls += 1 }, { platformName: 'win32', recoveryRoot }),
    (error) => error.code === 'SERVICE_RECOVERY_BUNDLE_INVALID',
  )
  assert.equal(recoveryCalls, 0)
  await writeFile(join(retained.directory, 'scheduled-task.xml'), priorXml, { mode: 0o600 })
  let restoredXml
  const restoreRunner = async (command, args) => {
    if (args[0] === '/Query' && args.includes('/XML')) return { status: 0, stdout: priorXml, stderr: '' }
    if (args[0] === '/Create' && args.includes('/XML')) restoredXml = await readFile(args[args.indexOf('/XML') + 1], 'utf8')
    if (command === 'powershell.exe') return { status: 0, stdout: 'PRESENT:Running\n', stderr: '' }
    return { status: 0, stdout: '', stderr: '' }
  }
  const restored = await restoreServiceRecoveryBundle(recoveryReference, restoreRunner, {
    platformName: 'win32', recoveryRoot, waitForEndpoint: async () => true,
  })
  assert.equal(restored.status, 'restored')
  assert.deepEqual(await readFile(launcherPath), priorContents)
  assert.equal(restoredXml, priorXml)
  await assert.rejects(() => access(retained.directory), (error) => error.code === 'ENOENT')
})

test('Windows inspection reports scheduled-task state separately from endpoint readiness', async () => {
  const serviceState = {
    launcherPath: 'C:\\AgentHost\\runtime.cmd',
    socketPath: '\\\\.\\pipe\\agent-host-state-test',
    taskName: '\\openAdam\\AgentHostRuntime',
  }
  const stopped = await inspectService(serviceState, async (command) => {
    assert.equal(command, 'powershell.exe')
    return { status: 0, stdout: 'PRESENT:Ready\n', stderr: '' }
  }, { platformName: 'win32', endpointReachable: async () => true })
  assert.deepEqual(
    { configured: stopped.configured, running: stopped.running, socketPresent: stopped.socketPresent, ready: stopped.ready, taskState: stopped.taskState },
    { configured: true, running: false, socketPresent: true, ready: false, taskState: 'Ready' },
  )

  const running = await inspectService(serviceState, async () => ({ status: 0, stdout: 'PRESENT:Running\n', stderr: '' }), {
    platformName: 'win32', endpointReachable: async () => false,
  })
  assert.deepEqual(
    { configured: running.configured, running: running.running, socketPresent: running.socketPresent, ready: running.ready, taskState: running.taskState },
    { configured: true, running: true, socketPresent: false, ready: false, taskState: 'Running' },
  )
})


for (const platformName of ['darwin', 'win32']) test(`service mutations on ${platformName} require a lifecycle transaction before any native command`, async () => {
  let calls = 0
  const runner = async () => { calls += 1; throw new Error('unexpected native mutation') }
  await assert.rejects(installService({}, {}, runner, null, { platformName }), { code: 'SERVICE_LIFECYCLE_REQUIRED' })
  await assert.rejects(uninstallService({ created: true }, runner, { platformName }), { code: 'SERVICE_LIFECYCLE_REQUIRED' })
  assert.equal(calls, 0)
})
