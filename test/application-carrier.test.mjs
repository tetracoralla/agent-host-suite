import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { preflightApplicationState, resolveApplicationCarrier } from '../src/application-carrier.mjs'
import { inspectMaintenance, maintenanceBatch, maintenancePlist } from '../src/maintenance-service.mjs'
import { STATE_SCHEMA } from '../src/state.mjs'

function fixtureState() {
  return {
    schemaVersion: STATE_SCHEMA,
    suiteVersion: '0.1.4-development.2',
    channel: 'release',
    profile: 'standard',
    installedAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    releaseSourceProvenance: {
      policy: 'local-development',
      recordSha256: `sha256:${'0'.repeat(64)}`,
      remoteConfirmedAtBuildTime: false,
    },
    components: {},
    hosts: {},
    runtime: {},
    observability: { enabled: false },
  }
}

test('application discovery resolves the packaged macOS shim and Windows private runtime', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-application-carrier-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const macContents = join(root, 'Agent Host.app', 'Contents')
  const macShim = join(macContents, 'MacOS', 'agent-host')
  await mkdir(join(macContents, 'MacOS'), { recursive: true })
  await writeFile(macShim, '#!/bin/sh\n')
  await chmod(macShim, 0o700)
  assert.deepEqual(await resolveApplicationCarrier({ platformName: 'darwin', applicationRoots: [macContents] }), {
    kind: 'macos-application',
    root: join(root, 'Agent Host.app'),
    executable: macShim,
    prefixArguments: [],
  })

  const windowsRoot = join(root, 'Agent Host')
  const windowsNode = join(windowsRoot, 'runtime', 'node.exe')
  const windowsCli = join(windowsRoot, 'app', 'bin', 'agent-host.mjs')
  await mkdir(join(windowsRoot, 'runtime'), { recursive: true })
  await mkdir(join(windowsRoot, 'app', 'bin'), { recursive: true })
  await writeFile(windowsNode, 'fixture')
  await writeFile(windowsCli, 'fixture')
  await chmod(windowsNode, 0o700)
  assert.deepEqual(await resolveApplicationCarrier({ platformName: 'win32', applicationRoots: [windowsRoot] }), {
    kind: 'windows-application',
    root: windowsRoot,
    executable: windowsNode,
    prefixArguments: [windowsCli],
  })
})

test('maintenance launchers contain only the stable installed application command', () => {
  const macCarrier = {
    executable: '/Applications/Agent Host.app/Contents/MacOS/agent-host',
    prefixArguments: [],
  }
  const plist = maintenancePlist('/private/agent-host-state', macCarrier)
  assert.match(plist, /\/Applications\/Agent Host\.app\/Contents\/MacOS\/agent-host/u)
  assert.doesNotMatch(plist, /tools-dev|bin\/agent-host\.mjs/u)

  const windowsCarrier = {
    executable: 'C:\\Program Files\\Agent Host\\runtime\\node.exe',
    prefixArguments: ['C:\\Program Files\\Agent Host\\app\\bin\\agent-host.mjs'],
  }
  const batch = maintenanceBatch('C:\\Users\\Fixture\\Agent Host State', windowsCarrier)
  assert.match(batch, /"C:\\Program Files\\Agent Host\\runtime\\node\.exe"/u)
  assert.match(batch, /"C:\\Program Files\\Agent Host\\app\\bin\\agent-host\.mjs"/u)
  assert.doesNotMatch(batch, /tools-dev/u)
})

test('maintenance inspection rejects a source-checkout command and accepts the installed app shim', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-maintenance-inspection-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const plistPath = join(root, 'maintenance.plist')
  const stateRoot = join(root, 'state')
  const carrier = {
    kind: 'fixture-macos-application',
    root: '/Applications/Agent Host.app',
    executable: '/Applications/Agent Host.app/Contents/MacOS/agent-host',
    prefixArguments: [],
  }
  await writeFile(plistPath, maintenancePlist(stateRoot, {
    executable: '/opt/homebrew/bin/node',
    prefixArguments: ['/private/tools-dev/agent-host-suite/bin/agent-host.mjs'],
  }))
  assert.deepEqual(await inspectMaintenance(stateRoot, { plistPath }, {
    platformName: 'darwin', applicationCarrier: carrier,
  }), {
    ready: false,
    reason: 'application-command-mismatch',
    carrier: 'fixture-macos-application',
  })
  await writeFile(plistPath, maintenancePlist(stateRoot, carrier))
  assert.deepEqual(await inspectMaintenance(stateRoot, { plistPath }, {
    platformName: 'darwin', applicationCarrier: carrier,
  }), {
    ready: true,
    reason: null,
    carrier: 'fixture-macos-application',
    commandStyle: 'application-shim',
  })

  await writeFile(plistPath, maintenancePlist(stateRoot, {
    executable: join(stateRoot, 'packages', 'node-runtime', 'fixture', 'bin', 'node'),
    prefixArguments: ['/Applications/Agent Host.app/Contents/Resources/agent-host-suite/bin/agent-host.mjs'],
  }))
  assert.deepEqual(await inspectMaintenance(stateRoot, { plistPath }, {
    platformName: 'darwin', applicationCarrier: carrier,
  }), {
    ready: true,
    reason: null,
    carrier: 'fixture-macos-application',
    commandStyle: 'installed-application-cli',
  })
})

test('application state preflight catches an older application before state mutation', async () => {
  let temporaryStateRoot = null
  const carrier = { kind: 'fixture-old-application', executable: '/fixture/agent-host', prefixArguments: [] }
  await assert.rejects(
    preflightApplicationState(fixtureState(), {
      carrier,
      runner: async (_command, args) => {
        temporaryStateRoot = args[args.indexOf('--state-root') + 1]
        const candidate = JSON.parse(await readFile(join(temporaryStateRoot, 'state.json'), 'utf8'))
        assert.equal(candidate.releaseSourceProvenance.policy, 'local-development')
        return {
          status: 1,
          stdout: '',
          stderr: '{"status":"error","error":{"code":"STATE_SCHEMA_INVALID"}}',
          timedOut: false,
          overflowed: false,
        }
      },
    }),
    (error) => error.code === 'APPLICATION_STATE_INCOMPATIBLE'
      && error.details.output.includes('STATE_SCHEMA_INVALID'),
  )
  await assert.rejects(readFile(join(temporaryStateRoot, 'state.json')), (error) => error.code === 'ENOENT')
})

test('application state preflight reports compatibility through the packaged route', async () => {
  const calls = []
  const result = await preflightApplicationState(fixtureState(), {
    carrier: { kind: 'fixture-current-application', executable: '/fixture/agent-host', prefixArguments: [] },
    runner: async (command, args, options) => {
      calls.push({ command, args, options })
      return { status: 0, stdout: '{"status":"ok"}', stderr: '', timedOut: false, overflowed: false }
    },
  })
  assert.deepEqual(result, { status: 'compatible', checked: true, carrier: 'fixture-current-application' })
  assert.deepEqual(calls[0].args.slice(-5), ['status', '--state-root', calls[0].args[2], '--json'])
  assert.equal(calls[0].options.env.AGENT_HOST_BOOTSTRAP_ROOT.startsWith(calls[0].args[2]), true)
})
