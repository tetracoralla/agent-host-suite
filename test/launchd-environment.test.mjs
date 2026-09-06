import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { withLifecycleMutation } from '../src/lifecycle-lock.mjs'
import { readStatePaths, loadState, saveState } from '../src/state.mjs'
import { installService, uninstallService } from '../src/service.mjs'
import { fixtureConfiguration, seedFixture } from './fixtures/launchd-environment-interruption.mjs'

const script = fileURLToPath(new URL('./fixtures/launchd-environment-interruption.mjs', import.meta.url))
const read = (path) => readFile(path, 'utf8').then(JSON.parse)
async function fixture(t, installed) {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-launchd-journal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const previous = await seedFixture(root, installed)
  const { dependencies, getJob, jobPath } = fixtureConfiguration(root)
  const file = dependencies.serviceLaunchAgentPath
  return { root, previous, dependencies, getJob, jobPath, file,
    beforeFile: await readFile(file, 'utf8').catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error)),
    beforeJob: await getJob(), paths: await readStatePaths(join(root, 'state')) }
}
async function interrupt(root, operation, phase, action = '--interrupt') {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, action, root, operation, phase], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (bytes) => { stderr = (stderr + bytes).slice(-8192) })
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, stderr }))
  })
  assert.equal(result.signal, 'SIGKILL', result.stderr)
}
const recover = (f) => withLifecycleMutation({ root: f.paths.root }, 'fixture.recover', f.dependencies, async () => {})
for (const operation of ['install', 'replace', 'remove']) {
  const phases = operation === 'install' ? ['prepared', 'written', 'started', 'ready']
    : operation === 'remove' ? ['prepared', 'stopped', 'ready'] : ['prepared', 'stopped', 'written', 'started', 'ready']
  for (const phase of phases) test(`LaunchAgent ${operation} recovers after owner death at ${phase}`, { skip: process.platform !== 'darwin' }, async (t) => {
    const f = await fixture(t, operation !== 'install')
    await interrupt(f.root, operation, phase)
    await assert.rejects(loadState(f.paths), { code: 'ENVIRONMENT_RECOVERY_REQUIRED' })
    await writeFile(join(f.root, 'user.json'), '{"selected":"after","unrelated":"later user choice"}')
    await recover(f)
    assert.deepEqual(await loadState(f.paths), f.previous)
    assert.equal(await readFile(f.file, 'utf8').catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error)), f.beforeFile)
    assert.deepEqual(await f.getJob(), f.beforeJob)
    assert.deepEqual(await read(join(f.root, 'user.json')), { selected: 'before', unrelated: 'later user choice' })
  })
}

test('LaunchAgent user job changes block the whole recovery before any resource is restored', { skip: process.platform !== 'darwin' }, async (t) => {
  const f = await fixture(t, true)
  await interrupt(f.root, 'replace', 'ready')
  const changed = await f.getJob()
  changed.definition.args.push('later user argument')
  await writeFile(f.jobPath, JSON.stringify(changed))
  const currentFile = await readFile(f.file, 'utf8')
  await assert.rejects(recover(f), { code: 'ENVIRONMENT_RESOURCE_CHANGED' })
  assert.equal(await readFile(f.file, 'utf8'), currentFile)
  assert.deepEqual(await f.getJob(), changed)
  assert.equal((await read(join(f.root, 'user.json'))).selected, 'after')
})

test('LaunchAgent recovery can repeat after restoring the service but before recording progress', { skip: process.platform !== 'darwin' }, async (t) => {
  const f = await fixture(t, true)
  await interrupt(f.root, 'replace', 'ready')
  await interrupt(f.root, 'replace', 'unused', '--interrupt-recovery')
  assert.deepEqual(await f.getJob(), f.beforeJob)
  await recover(f)
  assert.deepEqual(await loadState(f.paths), f.previous)
})

test('LaunchAgent recovery does not undo a committed replacement', { skip: process.platform !== 'darwin' }, async (t) => {
  const f = await fixture(t, true)
  await interrupt(f.root, 'replace', 'committed')
  const committed = await loadState(f.paths)
  const job = await f.getJob()
  await recover(f)
  assert.deepEqual(await loadState(f.paths), committed)
  assert.deepEqual(await f.getJob(), job)
  assert.notDeepEqual(job, f.beforeJob)
})

test('an unchanged ready LaunchAgent is retained without stopping or restarting it', { skip: process.platform !== 'darwin' }, async (t) => {
  const f = await fixture(t, true)
  const { files } = fixtureConfiguration(f.root)
  const before = f.dependencies.calls.length
  await withLifecycleMutation({ root: f.paths.root }, 'fixture.no-op', f.dependencies, async (_locked, paths) => {
    const current = await loadState(paths)
    const service = await installService({ command: process.execPath, args: [join(f.root, 'old-runtime.mjs'), 'old exact arguments'], fingerprint: 'sha256:' + '1'.repeat(64) }, files, f.dependencies.runner, current.runtime.service, { platformName: 'darwin' })
    await saveState(paths, { ...current, runtime: { service } })
  })
  assert.equal(f.dependencies.calls.slice(before).some(({ args }) => ['bootout', 'bootstrap'].includes(args[0])), false)
  assert.deepEqual(await loadState(f.paths), f.previous)
})

test('a later descriptor change is preserved and blocks uninstall before service or state mutations', { skip: process.platform !== 'darwin' }, async (t) => {
  const f = await fixture(t, true)
  const changed = f.beforeFile.replace('<key>KeepAlive</key>', '<!-- user change -->\n  <key>KeepAlive</key>')
  await writeFile(f.file, changed)
  const before = f.dependencies.calls.length
  await assert.rejects(withLifecycleMutation({ root: f.paths.root }, 'fixture.remove-changed', f.dependencies, async () => {
    await uninstallService(f.previous.runtime.service, f.dependencies.runner, { platformName: 'darwin' })
  }), { code: 'SERVICE_STATE_CHANGED' })
  assert.equal(await readFile(f.file, 'utf8'), changed)
  assert.deepEqual(await loadState(f.paths), f.previous)
  assert.equal(f.dependencies.calls.slice(before).some(({ args }) => ['bootout', 'bootstrap'].includes(args[0])), false)
})

test('multiple service replacements reverse through their recorded intermediate identities', { skip: process.platform !== 'darwin' }, async (t) => {
  const f = await fixture(t, true)
  const { files } = fixtureConfiguration(f.root)
  await assert.rejects(withLifecycleMutation({ root: f.paths.root }, 'fixture.multiple', f.dependencies, async () => {
    const first = await installService({ command: process.execPath, args: [join(f.root, 'second.mjs')] }, files, f.dependencies.runner, f.previous.runtime.service, { platformName: 'darwin' })
    await installService({ command: process.execPath, args: [join(f.root, 'third.mjs')] }, files, f.dependencies.runner, first, { platformName: 'darwin' })
    throw new Error('failure after both replacements')
  }), /failure after both replacements/)
  assert.equal(await readFile(f.file, 'utf8'), f.beforeFile)
  assert.deepEqual(await f.getJob(), f.beforeJob)
  assert.deepEqual(await loadState(f.paths), f.previous)
})

test('an invalid recorded service definition cannot reach native service mutation', { skip: process.platform !== 'darwin' }, async (t) => {
  const f = await fixture(t, true)
  await interrupt(f.root, 'replace', 'ready')
  const path = join(f.paths.root, '.environment-change.json')
  const journal = await read(path)
  journal.steps.find((step) => step.kind === 'launchd-service').after.job.definition.path = null
  await writeFile(path, JSON.stringify(journal))
  const before = f.dependencies.calls.length
  await assert.rejects(recover(f), { code: 'ENVIRONMENT_CHANGE_INVALID' })
  assert.equal(f.dependencies.calls.length, before)
})
