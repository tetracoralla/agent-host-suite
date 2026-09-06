import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { withLifecycleMutation } from '../src/lifecycle-lock.mjs'
import { readStatePaths, loadState, saveState } from '../src/state.mjs'
import { installService, uninstallService, WINDOWS_SERVICE_TASK } from '../src/service.mjs'
import { windowsTask } from '../src/windows-task.mjs'
import { fixtureConfiguration, seedFixture } from './fixtures/windows-service-interruption.mjs'

const script = fileURLToPath(new URL('./fixtures/windows-service-interruption.mjs', import.meta.url))
const read = (path) => readFile(path, 'utf8').then(JSON.parse)

test('native Windows task validation accepts omitted empty action arguments', { skip: process.platform !== 'win32' }, async () => {
  // prepare and validate do not register a task. Exercise the actual COM XML
  // round trip, whose omitted Arguments property is null in Windows PowerShell.
  const taskName = WINDOWS_SERVICE_TASK + '.empty-arguments-' + process.pid
  const launcherPath = join(tmpdir(), 'agent-host-empty-arguments.cmd')
  const task = await windowsTask('prepare', taskName, { launcherPath })
  assert.deepEqual(await windowsTask('validate', taskName, { task, launcherPath }), task)
  const nonempty = { ...task, xml: task.xml.replace('</Exec>', '<Arguments>unexpected</Arguments></Exec>') }
  assert.notEqual(nonempty.xml, task.xml)
  await assert.rejects(windowsTask('validate', taskName, { task: nonempty, launcherPath }), { code: 'SERVICE_PRIOR_STATE_UNRESTORABLE' })
})

async function fixture(t, installed) {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-windows-journal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const previous = await seedFixture(root, installed)
  const { dependencies, getTask, taskPath } = fixtureConfiguration(root)
  const file = dependencies.serviceLauncherPath
  return { root, previous, dependencies, getTask, taskPath, file,
    beforeFile: await readFile(file, 'utf8').catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error)),
    beforeTask: await getTask(), paths: await readStatePaths(join(root, 'state')) }
}
async function interrupt(root, operation, phase, action = '--interrupt') {
  await rm(join(root, 'interruption.json'), { force: true })
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, action, root, operation, phase], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (bytes) => { stderr = (stderr + bytes).slice(-8192) })
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, stderr }))
  })
  if (process.platform === 'win32') assert.notEqual(result.code, 0, result.stderr)
  else assert.equal(result.signal, 'SIGKILL', result.stderr)
  assert.deepEqual(await read(join(root, 'interruption.json')), { phase: action === '--interrupt-recovery' ? 'recovery' : phase })
}
const recover = (f) => withLifecycleMutation({ root: f.paths.root }, 'fixture.recover', f.dependencies, async () => {})
test('an inherited launcher ACL already matching the target is not rewritten', async (t) => {
  const f = await fixture(t, false)
  const { files, runtime } = fixtureConfiguration(f.root)
  const runner = async (command, args, options) => {
    assert.notEqual(JSON.parse(options.input).operation, 'set-file-security')
    return f.dependencies.runner(command, args, options)
  }
  await withLifecycleMutation({ root: f.paths.root }, 'fixture.inherited-acl', { ...f.dependencies, runner }, async (_locked, paths) => {
    const service = await installService(runtime, files, runner, null, { platformName: 'win32' })
    await saveState(paths, { ...f.previous, runtime: { service } })
  })
  assert.equal((await f.getTask()).state, 4)
})
for (const operation of ['install', 'replace', 'remove']) {
  const phases = operation === 'install' ? ['prepared', 'written', 'registered', 'started', 'ready']
    : operation === 'remove' ? ['prepared', 'stopped', 'removed', 'ready'] : ['prepared', 'stopped', 'removed', 'written', 'registered', 'started', 'ready']
  for (const phase of phases) test(`Windows protocol fixture ${operation} recovers after owner death at ${phase}`, async (t) => {
    const f = await fixture(t, operation !== 'install')
    await interrupt(f.root, operation, phase)
    await assert.rejects(loadState(f.paths), { code: 'ENVIRONMENT_RECOVERY_REQUIRED' })
    await writeFile(join(f.root, 'user.json'), '{"selected":"after","unrelated":"later user choice"}')
    await recover(f)
    assert.deepEqual(await loadState(f.paths), f.previous)
    assert.equal(await readFile(f.file, 'utf8').catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error)), f.beforeFile)
    assert.deepEqual(await f.getTask(), f.beforeTask)
    assert.deepEqual(await read(join(f.root, 'user.json')), { selected: 'before', unrelated: 'later user choice' })
  })
}
for (const field of ['xml', 'sddl']) test(`a later Windows task ${field} edit blocks whole-journal recovery before any undo`, async (t) => {
  const f = await fixture(t, true)
  await interrupt(f.root, 'replace', 'ready')
  const changed = await f.getTask()
  changed[field] += 'later user edit'
  await writeFile(f.taskPath, JSON.stringify(changed))
  const file = await readFile(f.file, 'utf8')
  await assert.rejects(recover(f), { code: 'ENVIRONMENT_RESOURCE_CHANGED' })
  assert.equal(await readFile(f.file, 'utf8'), file)
  assert.deepEqual(await f.getTask(), changed)
  assert.equal((await read(join(f.root, 'user.json'))).selected, 'after')
})
test('Windows service recovery repeats after undo before recording progress', async (t) => {
  const f = await fixture(t, true)
  await interrupt(f.root, 'replace', 'ready')
  await interrupt(f.root, 'replace', 'unused', '--interrupt-recovery')
  assert.deepEqual(await f.getTask(), f.beforeTask)
  await recover(f)
  assert.deepEqual(await loadState(f.paths), f.previous)
})
test('Windows service recovery preserves the authoritative committed replacement', async (t) => {
  const f = await fixture(t, true)
  await interrupt(f.root, 'replace', 'committed')
  const committed = await loadState(f.paths)
  const file = await readFile(f.file, 'utf8')
  await recover(f)
  assert.deepEqual(await loadState(f.paths), committed)
  assert.equal(await readFile(f.file, 'utf8'), file)
  assert.notEqual(file, f.beforeFile)
})
test('unchanged healthy Windows service retains its registration and process', async (t) => {
  const f = await fixture(t, true)
  const { files } = fixtureConfiguration(f.root)
  await withLifecycleMutation({ root: f.paths.root }, 'fixture.no-op', f.dependencies, async (_locked, paths) => {
    const service = await installService({ command: process.execPath, args: [join(f.root, 'old-runtime.mjs'), 'old argument'], fingerprint: 'sha256:' + '1'.repeat(64) }, files, f.dependencies.runner, f.previous.runtime.service, { platformName: 'win32' })
    await saveState(paths, { ...f.previous, runtime: { service } })
  })
  assert.equal(f.dependencies.calls.some(({ operation }) => ['create', 'remove', 'run'].includes(operation)), false)
  assert.deepEqual(await loadState(f.paths), f.previous)
})
test('a Runtime change at the same command restarts the task without rewriting an unchanged launcher', async (t) => {
  const f = await fixture(t, true)
  const { files } = fixtureConfiguration(f.root)
  const inode = (await lstat(f.file, { bigint: true })).ino
  await withLifecycleMutation({ root: f.paths.root }, 'fixture.same-command', f.dependencies, async (_locked, paths) => {
    const service = await installService({ command: process.execPath, args: [join(f.root, 'old-runtime.mjs'), 'old argument'], fingerprint: 'sha256:' + '2'.repeat(64) }, files, f.dependencies.runner, f.previous.runtime.service, { platformName: 'win32' })
    await saveState(paths, { ...f.previous, runtime: { service } })
  })
  assert.equal((await lstat(f.file, { bigint: true })).ino, inode)
  assert.deepEqual(f.dependencies.calls.filter(({ operation }) => ['create', 'remove', 'run'].includes(operation)).map(({ operation }) => operation), ['remove', 'create', 'run'])
})
test('recovery after task stop retains the unchanged launcher object', async (t) => {
  const f = await fixture(t, true)
  const inode = (await lstat(f.file, { bigint: true })).ino
  await interrupt(f.root, 'replace', 'stopped')
  await recover(f)
  assert.equal((await lstat(f.file, { bigint: true })).ino, inode)
  assert.deepEqual(await f.getTask(), f.beforeTask)
})
test('an edited owned launcher blocks uninstall before native mutations', async (t) => {
  const f = await fixture(t, true)
  const changed = f.beforeFile + 'rem user modification\r\n'
  await writeFile(f.file, changed)
  await assert.rejects(withLifecycleMutation({ root: f.paths.root }, 'fixture.uninstall', f.dependencies, async () => {
    await uninstallService(f.previous.runtime.service, f.dependencies.runner, { platformName: 'win32' })
  }), { code: 'SERVICE_STATE_CHANGED' })
  assert.equal(f.dependencies.calls.some(({ operation }) => ['create', 'remove', 'run'].includes(operation)), false)
  assert.equal(await readFile(f.file, 'utf8'), changed)
  assert.deepEqual(await loadState(f.paths), f.previous)
})
test('a later launcher ACL edit blocks whole-journal recovery without changing the task', async (t) => {
  const f = await fixture(t, true)
  await interrupt(f.root, 'replace', 'ready')
  const { securityPath } = fixtureConfiguration(f.root)
  const records = await read(securityPath).catch((error) => error.code === 'ENOENT' ? {} : Promise.reject(error))
  const key = String((await lstat(f.file, { bigint: true })).ino)
  records[key] = 'O:fixture-userG:fixture-userD:P(A;;FR;;;fixture-user)'
  await writeFile(securityPath, JSON.stringify(records))
  const task = await f.getTask()
  await assert.rejects(recover(f), { code: 'ENVIRONMENT_RESOURCE_CHANGED' })
  assert.deepEqual(await f.getTask(), task)
  assert.equal((await read(securityPath))[key], records[key])
  assert.equal((await read(join(f.root, 'user.json'))).selected, 'after')
})
test('a read-only launcher blocks replacement before any native task change', async (t) => {
  const f = await fixture(t, true)
  const { files, runtime } = fixtureConfiguration(f.root)
  await chmod(f.file, 0o400)
  t.after(() => chmod(f.file, 0o600).catch(() => {}))
  await assert.rejects(withLifecycleMutation({ root: f.paths.root }, 'fixture.readonly', f.dependencies, async () => {
    await installService(runtime, files, f.dependencies.runner, f.previous.runtime.service, { platformName: 'win32' })
  }), { code: 'SERVICE_PRIOR_STATE_UNRESTORABLE' })
  assert.equal(f.dependencies.calls.some(({ operation }) => ['create', 'remove', 'run'].includes(operation)), false)
  assert.deepEqual(await loadState(f.paths), f.previous)
})
for (const state of [1, 3]) test(`recovery retains a previously stopped Windows task (${state}) without starting it`, async (t) => {
  const f = await fixture(t, true)
  // State 1 is disabled in the definition as well as the observed native state.
  const beforeTask = { ...f.beforeTask, state, xml: state === 1 ? f.beforeTask.xml.replace('true', 'false') : f.beforeTask.xml }
  await writeFile(f.taskPath, JSON.stringify(beforeTask))
  // Model the legacy service whose prior state lacks a recorded task digest.
  delete f.previous.runtime.service.taskIdentity
  await withLifecycleMutation({ root: f.paths.root }, 'fixture.legacy', f.dependencies, (_locked, paths) => saveState(paths, f.previous))
  await interrupt(f.root, 'replace', 'ready')
  await recover(f)
  assert.deepEqual(await f.getTask(), beforeTask)
  assert.equal(f.dependencies.calls.some(({ operation }) => operation === 'run'), false)
})
for (const state of [0, 2]) test(`unknown or queued Windows state (${state}) blocks replacement before mutation`, async (t) => {
  const f = await fixture(t, true)
  await writeFile(f.taskPath, JSON.stringify({ ...f.beforeTask, state }))
  const { files, runtime } = fixtureConfiguration(f.root)
  await assert.rejects(withLifecycleMutation({ root: f.paths.root }, 'fixture.replace', f.dependencies, async () => {
    await installService(runtime, files, f.dependencies.runner, f.previous.runtime.service, { platformName: 'win32' })
  }), { code: 'SERVICE_PRIOR_STATE_UNRESTORABLE' })
  assert.equal(f.dependencies.calls.some(({ operation }) => ['create', 'remove', 'run'].includes(operation)), false)
  assert.equal(await readFile(f.file, 'utf8'), f.beforeFile)
})
test('Windows task transport rejects unknown or incomplete native responses', async () => {
  for (const result of [
    { status: 0, stdout: 'not JSON' },
    { status: 0, stdout: '{"protocol":"openadam.windows-task.v0.1","task":null,"extra":true}' },
    { status: 0, stdout: '{"protocol":"openadam.windows-task.v0.1","task":null}', timedOut: true },
    { status: 1, stdout: '{"protocol":"openadam.windows-task.v0.1","error":"ARBITRARY_NATIVE_TEXT"}' },
  ]) await assert.rejects(windowsTask('observe', WINDOWS_SERVICE_TASK, {}, async () => result), { code: 'SERVICE_STATE_UNAVAILABLE' })
})
