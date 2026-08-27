import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { inspectService, launchAgentContents, preflightServiceInstallation, SERVICE_LABEL } from '../src/service.mjs'

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
  assert.doesNotMatch(plist, /<key>Program<\/key>/)
  assert.doesNotMatch(plist, /sh -c/)
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
  const ready = await preflightServiceInstallation(async () => ({ status: 1, stdout: '', stderr: '' }), path)
  assert.equal(ready.launchAgentPath, path)
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
