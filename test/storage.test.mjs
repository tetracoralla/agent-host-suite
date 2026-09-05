import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { measureReadOnlyTreeUsage, storageStatus } from '../src/storage.mjs'
import { prepareStatePaths, saveState, STATE_SCHEMA } from '../src/state.mjs'

test('read-only installation measurement counts links without following their targets', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'agent-host-installation-usage-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const installation = join(parent, 'Agent Host.app')
  const outside = join(parent, 'outside.bin')
  await writeFile(outside, Buffer.alloc(1024 * 1024))
  await mkdir(installation)
  await writeFile(join(installation, 'small.bin'), 'small')
  await symlink(outside, join(installation, 'linked.bin'))

  const usage = await measureReadOnlyTreeUsage(installation)
  assert.equal(usage.files, 2)
  assert.equal(usage.apparentBytes < 1024 * 1024, true)
})

test('storage cleanup plans a legacy runtime configuration that no retained state names', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'agent-host-storage-legacy-config-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const stateRoot = join(parent, 'state')
  const paths = await prepareStatePaths(stateRoot)
  const now = new Date().toISOString()
  const configPath = join(paths.runtime, 'provider-config-0123456789abcdef01234567.json')
  await saveState(paths, {
    schemaVersion: STATE_SCHEMA,
    suiteVersion: '0.1.4-test',
    channel: 'development',
    profile: 'standard',
    installedAt: now,
    updatedAt: now,
    components: {},
    hosts: {},
    runtime: { configPath, service: null },
    observability: { enabled: false },
  })
  await writeFile(configPath, '{}\n')
  await writeFile(join(paths.runtime, 'provider-config.json'), '{}\n')

  const result = await storageStatus({ stateRoot })
  assert.equal(result.cleanup.runtimeConfigs, 1)
})

test('storage status counts a displaced Skill symlink backup without following its target', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'agent-host-storage-backup-link-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const stateRoot = join(parent, 'state')
  const paths = await prepareStatePaths(stateRoot)
  const now = new Date().toISOString()
  await saveState(paths, {
    schemaVersion: STATE_SCHEMA,
    suiteVersion: '0.1.2-test',
    releaseId: 'test-release',
    channel: 'release',
    profile: 'standard',
    installedAt: now,
    updatedAt: now,
    releaseActivatedAt: now,
    components: {},
    agentComponents: [],
    hosts: {},
    runtime: { service: null },
    observability: { enabled: false },
  })
  const outside = join(parent, 'outside-skill')
  await mkdir(outside)
  await writeFile(join(outside, 'large.bin'), Buffer.alloc(1024 * 1024))
  await symlink(outside, join(paths.backups, 'claude-displaced-skill'))

  const result = await storageStatus({ stateRoot })
  assert.equal(result.sections.backups.files, 1)
  assert.equal(result.sections.backups.apparentBytes < 1024 * 1024, true)
  assert.equal(result.cleanup.packageVersions, 0)
})
