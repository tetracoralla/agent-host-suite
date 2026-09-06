import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AgentHostError } from '../src/errors.mjs'
import { writePrivateJson } from '../src/json.mjs'
import { setup } from '../src/setup.mjs'
import { setActiveTools } from '../src/lifecycle.mjs'
import { listHistory, loadState, prepareStatePaths, saveState, STATE_SCHEMA, LEGACY_STATE_SCHEMA } from '../src/state.mjs'
import { createDevelopmentWorkspace } from './helpers.mjs'
import { configuration } from './fixtures/environment-interruption.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-state-migration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await createDevelopmentWorkspace(join(root, 'source'))
  const f = configuration(root)
  await mkdir(join(root, 'home'))
  await writeFile(f.dependencies.zcodeConfigPath, JSON.stringify({ preference: 'user', mcp: { servers: {} } }))
  return f
}

function olderApplication(candidate) {
  assert.equal(candidate.schemaVersion, STATE_SCHEMA)
  throw new AgentHostError('APPLICATION_STATE_INCOMPATIBLE', 'Fixture application only reads state v0.1')
}

async function legacyInstallation(t) {
  const f = await fixture(t)
  await setup(f.options, f.dependencies)
  const paths = await prepareStatePaths(f.options.stateRoot)
  const legacy = { ...await loadState(paths), schemaVersion: LEGACY_STATE_SCHEMA }
  // ZCode's ownership format is unchanged. This is an old-state fixture, not
  // an instruction to downgrade new Claude ownership records.
  await writePrivateJson(paths.state, legacy)
  return { ...f, paths, legacy }
}

test('old states remain unchanged on read and migrate only in the committed successor', async (t) => {
  const f = await legacyInstallation(t)
  const before = await readFile(f.paths.state, 'utf8')
  assert.deepEqual(await loadState(f.paths), f.legacy)
  assert.equal(await readFile(f.paths.state, 'utf8'), before)
  await saveState(f.paths, f.legacy, { retainCurrent: true })
  assert.equal((await loadState(f.paths)).schemaVersion, STATE_SCHEMA)
  assert.equal(f.legacy.schemaVersion, LEGACY_STATE_SCHEMA)
  const history = await listHistory(f.paths)
  assert.deepEqual(JSON.parse(await readFile(history[0], 'utf8')), f.legacy)
})

test('initial setup rejects an older application before runtime or host installation', async (t) => {
  const f = await fixture(t)
  const before = await readFile(f.dependencies.zcodeConfigPath, 'utf8')
  let wroteRuntime = false
  await assert.rejects(setup(f.options, {
    ...f.dependencies, applicationStatePreflight: olderApplication,
    writeRuntimeFiles: async () => { wroteRuntime = true; throw new Error('Unexpected runtime mutation') },
  }), { code: 'APPLICATION_STATE_INCOMPATIBLE' })
  assert.equal(wroteRuntime, false)
  assert.equal(await readFile(f.dependencies.zcodeConfigPath, 'utf8'), before)
  await assert.rejects(readFile(join(f.options.stateRoot, 'state.json')), { code: 'ENOENT' })
})

test('legacy tool-set migration checks the next version before changing bindings or old state', async (t) => {
  const f = await legacyInstallation(t)
  const before = await readFile(f.dependencies.zcodeConfigPath, 'utf8')
  const beforeState = await readFile(f.paths.state, 'utf8')
  for (const dryRun of [false, true]) {
    await assert.rejects(setActiveTools({ stateRoot: f.paths.root, tools: ['math-anchor'], dryRun }, {
      ...f.dependencies, applicationStatePreflight: olderApplication,
    }), { code: 'APPLICATION_STATE_INCOMPATIBLE' })
  }
  assert.equal(await readFile(f.paths.state, 'utf8'), beforeState)
  assert.equal(await readFile(f.dependencies.zcodeConfigPath, 'utf8'), before)
  await assert.rejects(readFile(join(f.paths.root, '.environment-change.json')), { code: 'ENOENT' })
})

test('successful legacy tool-set change retains old history and complete ownership in v0.2', async (t) => {
  const f = await legacyInstallation(t)
  let checked = 0
  await setActiveTools({ stateRoot: f.paths.root, tools: ['math-anchor'] }, {
    ...f.dependencies, applicationStatePreflight: async (candidate) => {
      checked += 1
      assert.equal(candidate.schemaVersion, STATE_SCHEMA)
      assert.equal((await loadState(f.paths)).schemaVersion, LEGACY_STATE_SCHEMA)
      return { checked: true, status: 'compatible' }
    },
  })
  assert.equal(checked, 1)
  const next = await loadState(f.paths)
  assert.equal(next.schemaVersion, STATE_SCHEMA)
  assert.deepEqual(next.agentComponents, ['math-anchor'])
  assert.equal(next.hosts.zcode.inactiveEntries.some((entry) => entry.component === 'migratory-time'), true)
  const historical = await Promise.all((await listHistory(f.paths)).map(async (path) => JSON.parse(await readFile(path, 'utf8'))))
  assert.equal(historical.some((entry) => JSON.stringify(entry) === JSON.stringify(f.legacy)), true)
})

test('failed legacy migration recovers the old version without publishing new ownership', async (t) => {
  const f = await legacyInstallation(t)
  const before = JSON.parse(await readFile(f.dependencies.zcodeConfigPath, 'utf8'))
  await assert.rejects(setActiveTools({ stateRoot: f.paths.root, tools: ['math-anchor'] }, {
    ...f.dependencies, saveState: async () => { throw new Error('Injected commit failure') },
  }))
  assert.deepEqual(await loadState(f.paths), f.legacy)
  assert.deepEqual(JSON.parse(await readFile(f.dependencies.zcodeConfigPath, 'utf8')), before)
  await assert.rejects(readFile(join(f.paths.root, '.environment-change.json')), { code: 'ENOENT' })
})

test('repeated setup and a failed preview preserve an existing installation and projections', async (t) => {
  for (const dryRun of [false, true]) {
    const f = await fixture(t)
    await setup(f.options, f.dependencies)
    const paths = await prepareStatePaths(f.options.stateRoot)
    const before = await readFile(paths.state, 'utf8')
    const marker = join(paths.hostProjections, 'existing-projection.txt')
    await writeFile(marker, 'belongs to the active installation')
    await assert.rejects(setup({ ...f.options, dryRun }, {
      ...f.dependencies,
      ...(dryRun ? { applicationStatePreflight: olderApplication } : {}),
    }), { code: dryRun ? 'APPLICATION_STATE_INCOMPATIBLE' : 'ALREADY_INSTALLED' })
    assert.equal(await readFile(paths.state, 'utf8'), before)
    assert.equal(await readFile(marker, 'utf8'), 'belongs to the active installation')
  }
})
