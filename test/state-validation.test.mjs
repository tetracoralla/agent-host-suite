import { writePrivateJson } from '../src/json.mjs'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { STATE_SCHEMA, loadState, prepareStatePaths, saveState, validateState } from '../src/state.mjs'

const now = '2026-08-30T00:00:00.000Z'
const valid = {
  schemaVersion: STATE_SCHEMA,
  suiteVersion: '0.1.1',
  channel: 'release',
  profile: 'standard',
  installedAt: now,
  updatedAt: now,
  releaseActivatedAt: now,
  bindingsActivatedAt: now,
  releaseId: 'fixture-release',
  releaseManifest: { schemaVersion: 'openadam.agent-host-release.v0.2' },
  releaseSourceProvenance: {
    policy: 'local-clean',
    recordSha256: `sha256:${'a'.repeat(64)}`,
    remoteConfirmedAtBuildTime: false,
  },
  workspaceRoot: null,
  components: { 'math-anchor': { version: '0.4.0' } },
  availableAgentComponents: ['math-anchor'],
  agentComponents: ['math-anchor'],
  privateComponents: {},
  hosts: {},
  runtime: {},
  observability: { enabled: false },
}

test('saved state validation accepts the current lifecycle shape and its public schema names every field', async () => {
  assert.equal(validateState(structuredClone(valid)).suiteVersion, '0.1.1')
  const schema = JSON.parse(await readFile(new URL('../schemas/agent-host-state.schema.v0.1.json', import.meta.url), 'utf8'))
  for (const key of Object.keys(valid)) assert.equal(Object.hasOwn(schema.properties, key), true, key)
})

test('saved state validation rejects structural corruption before lifecycle work begins', () => {
  const cases = [
    [{ ...valid, components: [] }, ['components', 'availableAgentComponents']],
    [{ ...valid, agentComponents: ['foreign-tool'] }, ['agentComponents']],
    [{ ...valid, updatedAt: 'not-a-date' }, ['updatedAt']],
    [{ ...valid, unexpected: true }, ['unexpected']],
  ]
  for (const [state, fields] of cases) {
    assert.throws(
      () => validateState(structuredClone(state)),
      (error) => error.code === 'STATE_SCHEMA_INVALID' && fields.every((field) => error.details.fields.includes(field)),
    )
  }
})

test('concurrent private state writes in one process do not collide on temporary names', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-state-write-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const paths = await prepareStatePaths(root)
  const versions = ['0.1.1', '0.1.2', '0.1.3', '0.1.4', '0.1.5', '0.1.6']
  await Promise.all(versions.map((suiteVersion) => saveState(paths, { ...structuredClone(valid), suiteVersion })))
  const loaded = await loadState(paths)
  assert.equal(versions.includes(loaded.suiteVersion), true)
  assert.deepEqual((await readdir(paths.root)).filter((name) => name.includes('.tmp-')), [])
})


test('failed atomic state replacement preserves the destination and leaves subsequent writes usable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-state-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const destination = join(root, 'state.json')
  await mkdir(destination)
  await writeFile(join(destination, 'keep.txt'), 'retained')
  await assert.rejects(writePrivateJson(destination, { revision: 1 }))
  assert.equal(await readFile(join(destination, 'keep.txt'), 'utf8'), 'retained')
  assert.deepEqual((await readdir(root)).filter((name) => name.includes('.tmp-')), [])
  await rm(destination, { recursive: true })
  await writePrivateJson(destination, { revision: 2 })
  assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), { revision: 2 })
})
