import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { withLifecycleMutation } from '../src/lifecycle-lock.mjs'
import { readStatePaths, loadState } from '../src/state.mjs'
import { writeEnvironmentCodex } from '../src/hosts/codex-config-resource.mjs'
import { recoveryDependencies } from './fixtures/codex-environment-interruption.mjs'

const script = fileURLToPath(new URL('./fixtures/codex-environment-interruption.mjs', import.meta.url))
const original = { plugins: { 'fixture@local': { enabled: true, fixture: 'retained' } }, preference: 'initial' }
const read = async (path) => JSON.parse(await readFile(path, 'utf8'))
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-codex-interruption-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'codex'))
  await writeFile(join(root, 'codex', 'config.toml'), JSON.stringify(original), { mode: 0o600 })
  await writeFile(join(root, 'second.json'), JSON.stringify({ value: 'before' }), { mode: 0o600 })
  return root
}
async function interrupt(root, phase = 'before-commit', action = '--interrupt') {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, action, root, phase], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, stderr }))
  })
  assert.equal(result.signal, 'SIGKILL', result.stderr)
}
const recover = (root) => withLifecycleMutation({ root: join(root, 'state') }, 'fixture.recover', recoveryDependencies(), async () => {})

test('Codex configuration survives process death and recovery preserves unrelated later user edits', async (t) => {
  const root = await fixture(t)
  await interrupt(root)
  const configPath = join(root, 'codex', 'config.toml')
  const changed = await read(configPath)
  assert.equal(changed.plugins['fixture@local'].enabled, false)
  changed.preference = 'later user edit'
  await writeFile(configPath, JSON.stringify(changed))
  await recover(root)
  assert.deepEqual(await read(configPath), { ...original, preference: 'later user edit' })
  assert.deepEqual(await read(join(root, 'second.json')), { value: 'before' })
  assert.equal(await loadState(await readStatePaths(join(root, 'state'))), null)
})

test('an owned Codex configuration conflict prevents every planned recovery effect', async (t) => {
  const root = await fixture(t)
  await interrupt(root)
  const path = join(root, 'codex', 'config.toml')
  const changed = await read(path)
  changed.plugins['fixture@local'].fixture = 'user changed this binding'
  await writeFile(path, JSON.stringify(changed))
  await assert.rejects(recover(root), { code: 'ENVIRONMENT_RESOURCE_CHANGED' })
  assert.deepEqual(await read(path), changed)
  assert.deepEqual(await read(join(root, 'second.json')), { value: 'after' })
  assert.equal((await read(join(root, 'state', 'state.json'))).schemaVersion, 'openadam.agent-host-changing.v0.1')
})

test('Codex intent-before-effect and undo-before-progress interruptions are repeatable', async (t) => {
  const prepared = await fixture(t)
  await interrupt(prepared, 'prepared')
  assert.deepEqual(await read(join(prepared, 'codex', 'config.toml')), original)
  await recover(prepared)
  const changed = await fixture(t)
  await interrupt(changed)
  await interrupt(changed, 'before-commit', '--interrupt-recovery')
  assert.deepEqual(await read(join(changed, 'codex', 'config.toml')), original)
  await recover(changed)
  assert.equal(await loadState(await readStatePaths(join(changed, 'state'))), null)
})

test('a committed Codex configuration transition is not undone after process death', async (t) => {
  const root = await fixture(t)
  await interrupt(root, 'committed')
  await recover(root)
  assert.equal((await read(join(root, 'codex', 'config.toml'))).plugins['fixture@local'].enabled, false)
  assert.deepEqual(await read(join(root, 'second.json')), { value: 'after' })
  assert.notEqual(await loadState(await readStatePaths(join(root, 'state'))), null)
})

test('a forged Codex resource cannot edit model or arbitrary configuration paths', async (t) => {
  for (const forge of [
    (step) => { step.changes[0].keys = ['model', 'anything'] },
    (step, root) => { step.proof.path = join(root, 'other.toml') },
  ]) {
    const root = await fixture(t)
    await interrupt(root)
    const path = join(root, 'state', '.environment-change.json')
    const journal = await read(path)
    forge(journal.steps.find((step) => step.kind === 'codex-config'), root)
    await writeFile(path, JSON.stringify(journal))
    await assert.rejects(recover(root), { code: 'ENVIRONMENT_CHANGE_INVALID' })
    assert.equal((await read(join(root, 'codex', 'config.toml'))).plugins['fixture@local'].enabled, false)
  }
})

test('a concurrent user edit after intent publication rejects the stale native write and keeps that edit', async (t) => {
  const root = await fixture(t)
  const configPath = join(root, 'codex', 'config.toml')
  const dependencies = recoveryDependencies()
  await assert.rejects(withLifecycleMutation({ root: join(root, 'state') }, 'fixture.concurrent-write', {
    ...dependencies,
    afterEnvironmentChangePrepared: async () => {
      await writeFile(configPath, JSON.stringify({ ...original, preference: 'concurrent user edit' }))
    },
  }, async () => {
    await dependencies.codexConfiguration(process.execPath, { configRoot: join(root, 'codex') }, async (client) => {
      await writeEnvironmentCodex(client, await client.read(), [{ keys: ['plugins', 'fixture@local'], value: { enabled: false } }])
    })
  }), { code: 'CODEX_CONFIG_CHANGED' })
  assert.deepEqual(await read(configPath), { ...original, preference: 'concurrent user edit' })
  assert.equal(await loadState(await readStatePaths(join(root, 'state'))), null)
})

test('enabled-only recovery retains later metadata in the same plugin registration', async (t) => {
  const root = await fixture(t)
  const dependencies = recoveryDependencies()
  const configPath = join(root, 'codex', 'config.toml')
  await assert.rejects(withLifecycleMutation({ root: join(root, 'state') }, 'fixture.enabled', dependencies, async () => {
    await dependencies.codexConfiguration(process.execPath, { configRoot: join(root, 'codex') }, async (client) => {
      await writeEnvironmentCodex(client, await client.read(), [{ keys: ['plugins', 'fixture@local', 'enabled'], value: false }])
      const later = await read(configPath)
      later.plugins['fixture@local'].fixture = 'later metadata'
      await writeFile(configPath, JSON.stringify(later))
      throw new Error('fixture interruption')
    })
  }), /fixture interruption/)
  assert.deepEqual((await read(configPath)).plugins['fixture@local'], { enabled: true, fixture: 'later metadata' })
})

test('native install callback publishes enablement intent before its side effect', async (t) => {
  const root = await fixture(t)
  const dependencies = recoveryDependencies()
  const configPath = join(root, 'codex', 'config.toml')
  await assert.rejects(withLifecycleMutation({ root: join(root, 'state') }, 'fixture.native-install', dependencies, async () => {
    await dependencies.codexConfiguration(process.execPath, { configRoot: join(root, 'codex') }, async (client) => {
      await writeEnvironmentCodex(client, await client.read(), [{ keys: ['plugins', 'fixture@local', 'enabled'], value: false }], async () => {
        const journal = await read(join(root, 'state', '.environment-change.json'))
        assert.deepEqual(journal.steps[0].changes[0].after, { present: true, value: false })
        const changed = await read(configPath)
        changed.plugins['fixture@local'].enabled = false
        await writeFile(configPath, JSON.stringify(changed))
        throw new Error('installer failed after its write')
      })
    })
  }), /installer failed after its write/)
  assert.deepEqual(await read(configPath), original)
})

test('one native change cannot overlap a complete registration and its enabled field', async (t) => {
  const root = await fixture(t)
  const dependencies = recoveryDependencies()
  await dependencies.codexConfiguration(process.execPath, { configRoot: join(root, 'codex') }, async (client) => {
    const before = await client.read()
    const changes = [{ keys: ['plugins', 'fixture@local'], value: { enabled: false } },
      { keys: ['plugins', 'fixture@local', 'enabled'], value: true }]
    await assert.rejects(writeEnvironmentCodex(client, before, changes), { code: 'ENVIRONMENT_CHANGE_INVALID' })
    await assert.rejects(client.write(before, changes), { code: 'CODEX_CONFIG_PROTOCOL_INVALID' })
    assert.deepEqual((await client.read()).config, before.config)
  })
})
