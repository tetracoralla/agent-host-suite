import { assertPrivateAccess } from '../src/private-permissions.mjs'
import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { inspectService, installService, launchAgentContents, preflightServiceInstallation, retainedLaunchAgentProgram, restoreServiceRecoveryBundle, SERVICE_LABEL, uninstallService } from '../src/service.mjs'
import { bindServiceRecoveryFailure, loadServiceRecoveryBundle, persistServiceRecoveryBundle } from '../src/service-recovery.mjs'
import { recoverServiceInstallation } from '../src/lifecycle.mjs'
import { withLifecycleMutation } from '../src/lifecycle-lock.mjs'
import { canonicalJson } from '../src/json.mjs'

const execFileAsync = promisify(execFile)
const serviceModuleUrl = new URL('../src/service.mjs', import.meta.url).href
const cliModuleUrl = new URL('../src/cli.mjs', import.meta.url).href
const TEST_STATE_IDENTITY = `sha256:${createHash('sha256').update('absent-state-file').digest('hex')}`

function recoveryLifecycle(directory) {
  return { statePath: join(directory, 'state.json'), currentStateIdentity: TEST_STATE_IDENTITY }
}

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

test('service replacement rejects a stale lifecycle identity even when the state file disappeared', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-host-service-missing-state-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const launchAgentPath = join(directory, 'agent-host.plist')
  await writeFile(launchAgentPath, 'prior descriptor\n')
  let calls = 0
  await assert.rejects(
    installService(
      { command: '/opt/new-node', args: ['/opt/new-runtime/cli.mjs'] },
      { configPath: join(directory, 'config.json'), socketPath: join(directory, 'new.sock'), observationLog: join(directory, 'observations.jsonl') },
      async (_command, args) => {
        calls += 1
        if (args[0] === 'print') return { status: 0, stdout: 'state = running\n', stderr: '' }
        throw new Error('service replacement mutated after a stale lifecycle identity')
      },
      { launchAgentPath, socketPath: join(directory, 'old.sock'), created: true },
      {
        platformName: 'darwin',
        existingEndpointReady: true,
        recoveryLifecycle: { statePath: join(directory, 'state.json'), currentStateIdentity: `sha256:${'7'.repeat(64)}` },
      },
    ),
    (error) => error.code === 'SERVICE_RECOVERY_CONTEXT_INVALID',
  )
  assert.equal(calls, 1)
  assert.equal(await readFile(launchAgentPath, 'utf8'), 'prior descriptor\n')
})

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

test('invalid retained LaunchAgent program structure fails before recovery mutation', async (t) => {
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

test('service preflight reports an existing LaunchAgent before setup mutates a host', async (t) => {
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

test('service preflight admits a missing path only when the launchd label is absent', async (t) => {
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

test('service preflight and inspection do not convert host query failures into absence', async (t) => {
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

test('service inspection distinguishes a loaded crash loop from a ready socket service', async (t) => {
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

test('fresh macOS service readiness failure removes its descriptor and Socket', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-host-service-fresh-failure-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const launchAgentPath = join(directory, 'agent-host.plist')
  const socketPath = join(directory, 'runtime.sock')
  await writeFile(socketPath, 'stale')
  const calls = []
  const runner = async (command, args) => {
    calls.push([command, ...args])
    return { status: 0, stdout: '', stderr: '' }
  }
  await assert.rejects(
    installService(
      { command: '/opt/node', args: ['/opt/runtime/cli.mjs'] },
      { configPath: join(directory, 'config.json'), socketPath, observationLog: join(directory, 'observations.jsonl') },
      runner,
      null,
      { platformName: 'darwin', launchAgentPath, waitForEndpoint: async () => false },
    ),
    (error) => error.code === 'SERVICE_START_FAILED',
  )
  await assert.rejects(() => access(launchAgentPath), (error) => error.code === 'ENOENT')
  await assert.rejects(() => access(socketPath), (error) => error.code === 'ENOENT')
  assert.equal(calls.some((call) => call[1] === 'bootout'), true)
})

test('macOS replacement failure restores exact prior descriptor and running service', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-host-service-replace-failure-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const launchAgentPath = join(directory, 'agent-host.plist')
  const oldSocketPath = join(directory, 'old.sock')
  const newSocketPath = join(directory, 'new.sock')
  const priorProgram = '/opt/old-node'
  const priorContents = Buffer.from(launchAgentContents(
    { command: priorProgram, args: ['/opt/old-runtime/cli.mjs'] },
    { configPath: join(directory, 'old-config.json'), socketPath: oldSocketPath, observationLog: join(directory, 'old-observations.jsonl') },
  ))
  await writeFile(launchAgentPath, priorContents, { mode: 0o640 })
  const calls = []
  const waits = []
  const runner = async (command, args) => {
    calls.push([command, ...args])
    if (args[0] === 'print') {
      return { status: 0, stdout: `path = ${launchAgentPath}\nprogram = ${priorProgram}\nstate = running\n`, stderr: '' }
    }
    return { status: 0, stdout: '', stderr: '' }
  }
  await assert.rejects(
    installService(
      { command: '/opt/new-node', args: ['/opt/new-runtime/cli.mjs'] },
      { configPath: join(directory, 'new-config.json'), socketPath: newSocketPath, observationLog: join(directory, 'observations.jsonl') },
      runner,
      { launchAgentPath, socketPath: oldSocketPath, created: true },
      {
        platformName: 'darwin',
        recoveryLifecycle: recoveryLifecycle(directory),
        existingEndpointReady: true,
        waitForEndpoint: async (path) => {
          waits.push(path)
          return waits.length > 1
        },
      },
    ),
    (error) => error.code === 'SERVICE_START_FAILED',
  )
  assert.deepEqual(await readFile(launchAgentPath), priorContents)
  assert.deepEqual(waits, [newSocketPath, oldSocketPath])
  assert.equal(calls.filter((call) => call[1] === 'bootstrap').length, 2)
  assert.equal(calls.filter((call) => call[1] === 'kickstart').length, 2)
})

test('macOS replacement retains recovery when rollback commands leave the replacement job active', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-host-service-restore-verification-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const launchAgentPath = join(directory, 'agent-host.plist')
  const recoveryRoot = join(directory, 'service-recovery')
  const oldSocketPath = join(directory, 'old.sock')
  const newSocketPath = join(directory, 'new.sock')
  const priorProgram = '/opt/old-node'
  const replacementProgram = '/opt/new-node'
  const priorContents = Buffer.from(launchAgentContents(
    { command: priorProgram, args: ['/opt/old-runtime/cli.mjs'] },
    { configPath: join(directory, 'old-config.json'), socketPath: oldSocketPath, observationLog: join(directory, 'old-observations.jsonl') },
  ))
  await writeFile(launchAgentPath, priorContents, { mode: 0o640 })
  let bootstrapCalls = 0
  let readinessCalls = 0
  const runner = async (_command, args) => {
    if (args[0] === 'print') {
      const program = bootstrapCalls > 1 ? replacementProgram : priorProgram
      return { status: 0, stdout: `path = ${launchAgentPath}\nprogram = ${program}\nstate = running\n`, stderr: '' }
    }
    if (args[0] === 'bootstrap') bootstrapCalls += 1
    return { status: 0, stdout: '', stderr: '' }
  }

  let failure
  try {
    await installService(
      { command: replacementProgram, args: ['/opt/new-runtime/cli.mjs'] },
      { configPath: join(directory, 'new-config.json'), socketPath: newSocketPath, observationLog: join(directory, 'new-observations.jsonl') },
      runner,
      { launchAgentPath, socketPath: oldSocketPath, created: true },
      {
        platformName: 'darwin', recoveryRoot, recoveryLifecycle: recoveryLifecycle(directory), existingEndpointReady: true,
        waitForEndpoint: async () => {
          readinessCalls += 1
          return readinessCalls > 1
        },
      },
    )
  } catch (error) {
    failure = error
  }

  assert.equal(failure?.code, 'SERVICE_INSTALL_ROLLBACK_FAILED')
  assert.equal(failure.details.rollback.code, 'SERVICE_RESTORE_FAILED')
  assert.match(failure.details.recovery.identity, /^service-recovery-v2-/u)
  assert.deepEqual(await readFile(launchAgentPath), priorContents)
  assert.deepEqual(await readdir(recoveryRoot), [failure.details.recovery.identity])
})

test('macOS failed rollback cleanup verifies absence and otherwise preserves recovery files', async (t) => {
  for (const replacement of [false, true]) {
    for (const outcome of ['absent', 'present', 'query-failure']) {
      const directory = await mkdtemp(join(tmpdir(), `agent-host-service-cleanup-${replacement}-${outcome}-`))
      t.after(() => rm(directory, { recursive: true, force: true }))
      const launchAgentPath = join(directory, 'agent-host.plist')
      const socketPath = join(directory, 'new.sock')
      const priorProgram = '/opt/old-node'
      const priorContents = Buffer.from(launchAgentContents(
        { command: priorProgram, args: ['/opt/old-runtime/cli.mjs'] },
        { configPath: join(directory, 'old-config.json'), socketPath: join(directory, 'old.sock'), observationLog: join(directory, 'old-observations.jsonl') },
      ))
      if (replacement) await writeFile(launchAgentPath, priorContents, { mode: 0o640 })
      await writeFile(socketPath, 'stale socket placeholder\n')
      let printCalls = 0
      let bootoutCalls = 0
      let bootstrapCalls = 0
      const runner = async (command, args) => {
        if (args[0] === 'print') {
          printCalls += 1
          if (replacement && printCalls === 1) return { status: 0, stdout: 'state = running\n', stderr: '' }
          if (replacement && bootstrapCalls > 1) {
            return { status: 0, stdout: `path = ${launchAgentPath}\nprogram = ${priorProgram}\nstate = running\n`, stderr: '' }
          }
          if (outcome === 'absent') {
            return { status: 113, stdout: '', stderr: `Could not find service "${SERVICE_LABEL}" in domain\n` }
          }
          if (outcome === 'present') return { status: 0, stdout: 'state = running\n', stderr: '' }
          return { status: 5, stdout: '', stderr: 'permission denied\n' }
        }
        if (args[0] === 'bootout') {
          bootoutCalls += 1
          if (replacement && bootoutCalls === 1) return { status: 0, stdout: '', stderr: '' }
          return { status: 5, stdout: '', stderr: 'bootout failed\n' }
        }
        if (args[0] === 'bootstrap') bootstrapCalls += 1
        return { status: 0, stdout: '', stderr: '' }
      }
      let failure
      try {
        await installService(
          { command: '/opt/new-node', args: ['/opt/new-runtime/cli.mjs'] },
          { configPath: join(directory, 'config.json'), socketPath, observationLog: join(directory, 'observations.jsonl') },
          runner,
          replacement ? { launchAgentPath, socketPath: join(directory, 'old.sock'), created: true } : null,
          {
            platformName: 'darwin',
            launchAgentPath,
            ...(replacement ? { recoveryLifecycle: recoveryLifecycle(directory) } : {}),
            existingEndpointReady: false,
            waitForEndpoint: async () => false,
          },
        )
      } catch (error) {
        failure = error
      }
      assert.notEqual(failure, undefined, `${replacement}:${outcome}`)
      if (outcome === 'absent') {
        assert.equal(failure.code, 'SERVICE_START_FAILED')
        if (replacement) assert.deepEqual(await readFile(launchAgentPath), priorContents)
        else await assert.rejects(() => access(launchAgentPath), (error) => error.code === 'ENOENT')
        await assert.rejects(() => access(socketPath), (error) => error.code === 'ENOENT')
      } else {
        assert.equal(failure.code, 'SERVICE_INSTALL_ROLLBACK_FAILED')
        assert.equal(failure.details.installation.code, 'SERVICE_START_FAILED')
        assert.equal(
          failure.details.rollback.code,
          outcome === 'present' ? 'SERVICE_ROLLBACK_CLEANUP_INCOMPLETE' : 'SERVICE_ROLLBACK_STATE_UNAVAILABLE',
        )
        assert.equal(failure.details.installation.message.includes(directory), false)
        assert.equal(failure.details.rollback.message.includes(directory), false)
        assert.equal([...failure.details.installation.message].length <= 512, true)
        assert.equal([...failure.details.rollback.message].length <= 512, true)
        assert.equal(failure.details.recovery === undefined, !replacement)
        if (replacement) {
          assert.match(failure.details.recovery.identity, /^service-recovery-v2-/u)
          assert.equal(JSON.stringify(failure.details.recovery).includes(directory), false)
        }
        assert.match(await readFile(launchAgentPath, 'utf8'), /<key>Label<\/key>/u)
        assert.equal(await readFile(socketPath, 'utf8'), 'stale socket placeholder\n')
      }
    }
  }
})

test('macOS replacement persists an owner-only recovery bundle that another process can restore', { skip: process.platform === 'win32' }, async (t) => {
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
  const installScript = String.raw`
const { installService, SERVICE_LABEL } = await import(process.argv[1])
let printCalls = 0
let bootoutCalls = 0
const runner = async (_command, args) => {
  if (args[0] === 'print') {
    printCalls += 1
    const program = printCalls === 1 ? '/opt/old-node' : '/opt/new-node'
    return { status: 0, stdout: ['path = ' + process.argv[2], 'program = ' + program, 'state = running', ''].join(String.fromCharCode(10)), stderr: '' }
  }
  if (args[0] === 'bootout') {
    bootoutCalls += 1
    return bootoutCalls === 1
      ? { status: 0, stdout: '', stderr: '' }
      : { status: 5, stdout: '', stderr: 'still present' }
  }
  return { status: 0, stdout: '', stderr: '' }
}
try {
  await installService(
    { command: '/opt/new-node', args: ['/opt/new-runtime/cli.mjs'] },
    { configPath: process.argv[3], socketPath: process.argv[4], observationLog: process.argv[5] },
    runner,
    { launchAgentPath: process.argv[2], socketPath: process.argv[6], created: true },
    {
      platformName: 'darwin',
      existingEndpointReady: true,
      waitForEndpoint: async () => false,
      recoveryLifecycle: { statePath: process.argv[7], currentStateIdentity: process.argv[8] },
    },
  )
  process.exitCode = 2
} catch (error) {
  process.stdout.write(JSON.stringify({ code: error.code, details: error.details }) + String.fromCharCode(10))
}
`
  const installed = await execFileAsync(process.execPath, [
    '--input-type=module', '-e', installScript,
    serviceModuleUrl, launchAgentPath, configPath, join(directory, 'new.sock'), join(directory, 'observations.jsonl'), priorSocketPath, lifecycleStatePath, stateIdentity(originalState),
  ], { encoding: 'utf8' })
  const failure = JSON.parse(installed.stdout)
  assert.equal(failure.code, 'SERVICE_INSTALL_ROLLBACK_FAILED')
  assert.equal(JSON.stringify(failure).includes(directory), false)
  assert.deepEqual(failure.details.recovery.action, {
    command: 'agent-host',
    arguments: [
      'service', 'recover',
      '--recovery', failure.details.recovery.identity,
      '--manifest-sha256', failure.details.recovery.manifestSha256,
    ],
  })
  const recoveryIdentity = failure.details.recovery.identity
  const recoveryReference = failure.details.recovery
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

test('fresh Windows service readiness failure deletes its task and launcher', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-host-windows-service-fresh-failure-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const files = {
    configPath: join(directory, 'config.json'),
    socketPath: '\\\\.\\pipe\\agent-host-fresh-test',
    observationLog: join(directory, 'observations.jsonl'),
  }
  const calls = []
  const runner = async (command, args) => {
    calls.push([command, ...args])
    return { status: 0, stdout: '', stderr: '' }
  }
  await assert.rejects(
    installService(
      { command: 'C:\\AgentHost\\node.exe', args: ['C:\\AgentHost\\cli.mjs'] },
      files,
      runner,
      null,
      { platformName: 'win32', waitForEndpoint: async () => false },
    ),
    (error) => error.code === 'SERVICE_START_FAILED',
  )
  await assert.rejects(() => access(join(directory, 'direct-runtime-service.cmd')), (error) => error.code === 'ENOENT')
  assert.equal(calls.some((call) => call.includes('/Delete')), true)
})

test('Windows replacement failure restores exact launcher and retained task XML', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-host-windows-service-replace-failure-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const launcherPath = join(directory, 'service.cmd')
  const priorContents = Buffer.from('@echo prior\r\n')
  await writeFile(launcherPath, priorContents, { mode: 0o600 })
  const oldSocketPath = '\\\\.\\pipe\\agent-host-old-test'
  const newSocketPath = '\\\\.\\pipe\\agent-host-new-test'
  const priorXml = '<Task version="1.4"><Actions/></Task>'
  const calls = []
  const waits = []
  const runner = async (command, args) => {
    calls.push([command, ...args])
    if (args[0] === '/Query' && args.includes('/XML')) return { status: 0, stdout: priorXml, stderr: '' }
    if (command === 'powershell.exe') return { status: 0, stdout: 'PRESENT:Running\n', stderr: '' }
    return { status: 0, stdout: '', stderr: '' }
  }
  await assert.rejects(
    installService(
      { command: 'C:\\AgentHost\\new-node.exe', args: ['C:\\AgentHost\\new-cli.mjs'] },
      { configPath: join(directory, 'new-config.json'), socketPath: newSocketPath, observationLog: join(directory, 'observations.jsonl') },
      runner,
      { launcherPath, socketPath: oldSocketPath, taskName: '\\openAdam\\AgentHostRuntime', created: true },
      {
        platformName: 'win32',
        recoveryLifecycle: recoveryLifecycle(directory),
        existingEndpointReady: true,
        waitForEndpoint: async (path) => {
          waits.push(path)
          return waits.length > 1
        },
      },
    ),
    (error) => error.code === 'SERVICE_START_FAILED',
  )
  assert.deepEqual(await readFile(launcherPath), priorContents)
  assert.deepEqual(waits, [newSocketPath, oldSocketPath])
  assert.equal(calls.some((call) => call.includes('/XML') && call[1] === '/Create'), true)
  assert.equal(calls.some((call) => call.includes('/Delete')), true)
})

test('Windows replacement retains recovery when rollback commands restore the wrong task', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-host-windows-restore-verification-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const launcherPath = join(directory, 'service.cmd')
  const recoveryRoot = join(directory, 'service-recovery')
  const priorContents = Buffer.from('@echo prior\r\n')
  const priorXml = '<Task version="1.4"><Actions><Exec>prior</Exec></Actions></Task>'
  await writeFile(launcherPath, priorContents, { mode: 0o600 })
  let taskRestored = false
  let readinessCalls = 0
  const runner = async (command, args) => {
    if (args[0] === '/Query' && args.includes('/XML')) {
      return {
        status: 0,
        stdout: taskRestored ? '<Task version="1.4"><Actions><Exec>replacement</Exec></Actions></Task>' : priorXml,
        stderr: '',
      }
    }
    if (args[0] === '/Create' && args.includes('/XML')) taskRestored = true
    if (command === 'powershell.exe') return { status: 0, stdout: 'PRESENT:Running\n', stderr: '' }
    return { status: 0, stdout: '', stderr: '' }
  }

  let failure
  try {
    await installService(
      { command: 'C:\\AgentHost\\new-node.exe', args: ['C:\\AgentHost\\new-cli.mjs'] },
      { configPath: join(directory, 'new-config.json'), socketPath: '\\\\.\\pipe\\agent-host-new-verify', observationLog: join(directory, 'new-observations.jsonl') },
      runner,
      { launcherPath, socketPath: '\\\\.\\pipe\\agent-host-old-verify', taskName: '\\openAdam\\AgentHostRuntime', created: true },
      {
        platformName: 'win32', recoveryRoot, recoveryLifecycle: recoveryLifecycle(directory), existingEndpointReady: true,
        waitForEndpoint: async () => {
          readinessCalls += 1
          return readinessCalls > 1
        },
      },
    )
  } catch (error) {
    failure = error
  }

  assert.equal(failure?.code, 'SERVICE_INSTALL_ROLLBACK_FAILED')
  assert.equal(failure.details.rollback.code, 'SERVICE_RESTORE_FAILED')
  assert.match(failure.details.recovery.identity, /^service-recovery-v2-/u)
  assert.deepEqual(await readFile(launcherPath), priorContents)
  assert.deepEqual(await readdir(recoveryRoot), [failure.details.recovery.identity])
})

test('service replacement retires its recovery bundle when descriptor mutation never starts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-host-service-pre-mutation-failure-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const launcherPath = join(directory, `${'x'.repeat(240)}.cmd`)
  const priorContents = Buffer.from('@echo unchanged prior\r\n')
  const recoveryRoot = join(directory, 'recovery')
  await writeFile(launcherPath, priorContents, { mode: 0o600 })
  const runner = async (command, args) => {
    if (args[0] === '/Query' && args.includes('/XML')) {
      return { status: 0, stdout: '<Task version="1.4"><Actions/></Task>', stderr: '' }
    }
    if (command === 'powershell.exe') return { status: 0, stdout: 'PRESENT:Ready\n', stderr: '' }
    return { status: 0, stdout: '', stderr: '' }
  }
  await assert.rejects(
    installService(
      { command: 'C:\\AgentHost\\new-node.exe', args: ['C:\\AgentHost\\new-cli.mjs'] },
      { configPath: join(directory, 'config.json'), socketPath: '\\\\.\\pipe\\agent-host-new-pre-mutation', observationLog: join(directory, 'observations.jsonl') },
      runner,
      { launcherPath, socketPath: '\\\\.\\pipe\\agent-host-old-pre-mutation', taskName: '\\openAdam\\AgentHostRuntime', created: true },
      { platformName: 'win32', existingEndpointReady: false, recoveryRoot, recoveryLifecycle: recoveryLifecycle(directory) },
    ),
    (error) => error.code === 'ENAMETOOLONG',
  )
  assert.deepEqual(await readFile(launcherPath), priorContents)
  assert.deepEqual(await readdir(recoveryRoot), [])
})

test('Windows failed rollback cleanup verifies absence after End and Delete before touching the launcher', async (t) => {
  const cases = [
    { replacement: false, failingCommand: '/End', outcome: 'absent' },
    { replacement: false, failingCommand: '/Delete', outcome: 'present' },
    { replacement: false, failingCommand: '/Delete', outcome: 'query-failure' },
    { replacement: true, failingCommand: '/Delete', outcome: 'absent' },
    { replacement: true, failingCommand: '/End', outcome: 'present' },
    { replacement: true, failingCommand: '/End', outcome: 'query-failure' },
  ]
  for (const fixture of cases) {
    const directory = await mkdtemp(join(tmpdir(), `agent-host-windows-cleanup-${fixture.replacement}-${fixture.outcome}-`))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const launcherPath = join(directory, 'service.cmd')
    const effectiveLauncherPath = fixture.replacement ? launcherPath : join(directory, 'direct-runtime-service.cmd')
    const priorContents = Buffer.from('@echo prior\r\n')
    if (fixture.replacement) await writeFile(launcherPath, priorContents, { mode: 0o600 })
    let powershellCalls = 0
    let taskRestored = false
    const runner = async (command, args) => {
      if (args[0] === '/Query' && args.includes('/XML')) {
        return { status: 0, stdout: '<Task version="1.4"><Actions/></Task>', stderr: '' }
      }
      if (args[0] === '/Create' && args.includes('/XML')) taskRestored = true
      if (command === 'powershell.exe') {
        powershellCalls += 1
        if (fixture.replacement && powershellCalls === 1) return { status: 0, stdout: 'PRESENT:Running\n', stderr: '' }
        if (taskRestored) return { status: 0, stdout: 'PRESENT:Running\n', stderr: '' }
        if (fixture.outcome === 'query-failure') return { status: 5, stdout: '', stderr: 'query failed\n' }
        return { status: 0, stdout: `${fixture.outcome.toUpperCase()}\n`, stderr: '' }
      }
      if (args[0] === fixture.failingCommand) return { status: 5, stdout: '', stderr: 'removal failed\n' }
      return { status: 0, stdout: '', stderr: '' }
    }
    const files = {
      configPath: join(directory, 'config.json'),
      socketPath: '\\\\.\\pipe\\agent-host-cleanup-test',
      observationLog: join(directory, 'observations.jsonl'),
    }
    let failure
    try {
      await installService(
        { command: 'C:\\AgentHost\\new-node.exe', args: ['C:\\AgentHost\\new-cli.mjs'] },
        files,
        runner,
        fixture.replacement
          ? { launcherPath, socketPath: '\\\\.\\pipe\\agent-host-old-cleanup-test', taskName: '\\openAdam\\AgentHostRuntime', created: true }
          : null,
        {
          platformName: 'win32',
          ...(fixture.replacement ? { recoveryLifecycle: recoveryLifecycle(directory) } : {}),
          existingEndpointReady: false,
          waitForEndpoint: async () => false,
        },
      )
    } catch (error) {
      failure = error
    }
    assert.notEqual(failure, undefined, JSON.stringify(fixture))
    if (fixture.outcome === 'absent') {
      assert.equal(failure.code, 'SERVICE_START_FAILED')
      if (fixture.replacement) assert.deepEqual(await readFile(effectiveLauncherPath), priorContents)
      else await assert.rejects(() => access(effectiveLauncherPath), (error) => error.code === 'ENOENT')
    } else {
      assert.equal(failure.code, 'SERVICE_INSTALL_ROLLBACK_FAILED')
      assert.equal(failure.details.installation.code, 'SERVICE_START_FAILED')
      assert.equal(
        failure.details.rollback.code,
        fixture.outcome === 'present' ? 'SERVICE_ROLLBACK_CLEANUP_INCOMPLETE' : 'SERVICE_ROLLBACK_STATE_UNAVAILABLE',
      )
      assert.equal(failure.details.installation.message.includes(directory), false)
      assert.equal(failure.details.rollback.message.includes(directory), false)
      assert.equal([...failure.details.installation.message].length <= 512, true)
      assert.equal([...failure.details.rollback.message].length <= 512, true)
      assert.match(await readFile(effectiveLauncherPath, 'utf8'), /new-node\.exe/u)
    }
  }
})

test('Windows replacement retains checksummed launcher and Task XML until exact recovery', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-host-windows-durable-recovery-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const launcherPath = join(directory, 'service.cmd')
  const configPath = join(directory, 'config.json')
  const recoveryRoot = join(directory, 'service-recovery')
  const priorContents = Buffer.from('@echo durable prior\r\n')
  const priorXml = '<Task version="1.4"><Actions><Exec/></Actions></Task>'
  await writeFile(launcherPath, priorContents, { mode: 0o600 })
  let powershellCalls = 0
  const installRunner = async (command, args) => {
    if (args[0] === '/Query' && args.includes('/XML')) return { status: 0, stdout: priorXml, stderr: '' }
    if (command === 'powershell.exe') {
      powershellCalls += 1
      return { status: 0, stdout: 'PRESENT:Running\n', stderr: '' }
    }
    if (args[0] === '/Delete') return { status: 5, stdout: '', stderr: 'still present' }
    return { status: 0, stdout: '', stderr: '' }
  }
  let failure
  try {
    await installService(
      { command: 'C:\\AgentHost\\new-node.exe', args: ['C:\\AgentHost\\new-cli.mjs'] },
      { configPath, socketPath: '\\\\.\\pipe\\agent-host-new-durable', observationLog: join(directory, 'observations.jsonl') },
      installRunner,
      { launcherPath, socketPath: '\\\\.\\pipe\\agent-host-old-durable', taskName: '\\openAdam\\AgentHostRuntime', created: true },
      { platformName: 'win32', existingEndpointReady: true, waitForEndpoint: async () => false, recoveryLifecycle: recoveryLifecycle(directory) },
    )
  } catch (error) {
    failure = error
  }
  assert.equal(failure.code, 'SERVICE_INSTALL_ROLLBACK_FAILED')
  assert.equal(JSON.stringify(failure.details.recovery).includes(directory), false)
  const recoveryIdentity = failure.details.recovery.identity
  const recoveryReference = failure.details.recovery
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

test('macOS replacement refuses a loaded but stopped service before any mutation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-host-service-stopped-replace-failure-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const launchAgentPath = join(directory, 'agent-host.plist')
  const priorContents = Buffer.from('prior stopped launch agent bytes\n')
  await writeFile(launchAgentPath, priorContents, { mode: 0o640 })
  const calls = []
  const runner = async (command, args) => {
    calls.push([command, ...args])
    if (args[0] === 'print') return { status: 0, stdout: 'state = exited\nlast exit code = 0\n', stderr: '' }
    return { status: 0, stdout: '', stderr: '' }
  }
  await assert.rejects(
    installService(
      { command: '/opt/new-node', args: ['/opt/new-runtime/cli.mjs'] },
      { configPath: join(directory, 'new-config.json'), socketPath: join(directory, 'new.sock'), observationLog: join(directory, 'observations.jsonl') },
      runner,
      { launchAgentPath, socketPath: join(directory, 'old.sock'), created: true },
      { platformName: 'darwin', existingEndpointReady: false, waitForEndpoint: async () => false },
    ),
    (error) => error.code === 'SERVICE_PRIOR_STATE_UNRESTORABLE',
  )
  assert.deepEqual(await readFile(launchAgentPath), priorContents)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1], 'print')
})

test('macOS replacement refuses an unverified prior service state before any mutation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-host-service-unverified-replace-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const launchAgentPath = join(directory, 'agent-host.plist')
  const priorContents = Buffer.from('prior launch agent bytes\n')
  await writeFile(launchAgentPath, priorContents, { mode: 0o640 })
  const calls = []
  const runner = async (command, args) => {
    calls.push([command, ...args])
    return { status: 5, stdout: '', stderr: 'permission denied\n' }
  }
  await assert.rejects(
    installService(
      { command: '/opt/new-node', args: ['/opt/new-runtime/cli.mjs'] },
      { configPath: join(directory, 'new-config.json'), socketPath: join(directory, 'new.sock'), observationLog: join(directory, 'observations.jsonl') },
      runner,
      { launchAgentPath, socketPath: join(directory, 'old.sock'), created: true },
      { platformName: 'darwin', existingEndpointReady: false, waitForEndpoint: async () => false },
    ),
    (error) => error.code === 'SERVICE_STATE_UNAVAILABLE',
  )
  assert.deepEqual(await readFile(launchAgentPath), priorContents)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1], 'print')
})

test('Windows replacement failure restores a stopped scheduled task without running it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-host-windows-service-stopped-replace-failure-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const launcherPath = join(directory, 'service.cmd')
  const priorContents = Buffer.from('@echo prior stopped\r\n')
  await writeFile(launcherPath, priorContents, { mode: 0o600 })
  const priorXml = '<Task version="1.4"><Actions/></Task>'
  const calls = []
  const waits = []
  const runner = async (command, args) => {
    calls.push([command, ...args])
    if (args[0] === '/Query' && args.includes('/XML')) return { status: 0, stdout: priorXml, stderr: '' }
    if (command === 'powershell.exe') return { status: 0, stdout: 'PRESENT:Ready\n', stderr: '' }
    return { status: 0, stdout: '', stderr: '' }
  }
  await assert.rejects(
    installService(
      { command: 'C:\\AgentHost\\new-node.exe', args: ['C:\\AgentHost\\new-cli.mjs'] },
      { configPath: join(directory, 'new-config.json'), socketPath: '\\\\.\\pipe\\agent-host-new-stopped-test', observationLog: join(directory, 'observations.jsonl') },
      runner,
      { launcherPath, socketPath: '\\\\.\\pipe\\agent-host-old-stopped-test', taskName: '\\openAdam\\AgentHostRuntime', created: true },
      {
        platformName: 'win32',
        recoveryLifecycle: recoveryLifecycle(directory),
        existingEndpointReady: false,
        waitForEndpoint: async (path) => {
          waits.push(path)
          return false
        },
      },
    ),
    (error) => error.code === 'SERVICE_START_FAILED',
  )
  assert.deepEqual(await readFile(launcherPath), priorContents)
  assert.equal(calls.filter((call) => call[1] === '/Run').length, 1)
  assert.deepEqual(waits, ['\\\\.\\pipe\\agent-host-new-stopped-test'])
  assert.equal(calls.some((call) => call.includes('/XML') && call[1] === '/Create'), true)
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

test('service uninstall retains its descriptor or launcher unless removal succeeds or exact absence is confirmed', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-host-service-uninstall-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const macDescriptor = join(directory, 'agent-host.plist')
  const windowsLauncher = join(directory, 'agent-host.cmd')
  await writeFile(macDescriptor, 'descriptor\n')
  await writeFile(windowsLauncher, 'launcher\n')

  await assert.rejects(
    uninstallService(
      { created: true, launchAgentPath: macDescriptor },
      async (_command, args) => args[0] === 'bootout'
        ? { status: 5, stdout: '', stderr: 'failed' }
        : { status: 0, stdout: 'state = running\n', stderr: '' },
      { platformName: 'darwin' },
    ),
    (error) => error.code === 'SERVICE_ROLLBACK_CLEANUP_INCOMPLETE',
  )
  assert.equal(await readFile(macDescriptor, 'utf8'), 'descriptor\n')

  await assert.rejects(
    uninstallService(
      { created: true, taskName: '\\openAdam\\AgentHostRuntime', launcherPath: windowsLauncher },
      async (command, args) => command === 'powershell.exe'
        ? { status: 5, stdout: '', stderr: 'query failed' }
        : args[0] === '/End'
          ? { status: 0, stdout: '', stderr: '' }
          : { status: 5, stdout: '', stderr: 'delete failed' },
      { platformName: 'win32' },
    ),
    (error) => error.code === 'SERVICE_ROLLBACK_STATE_UNAVAILABLE',
  )
  assert.equal(await readFile(windowsLauncher, 'utf8'), 'launcher\n')
})
