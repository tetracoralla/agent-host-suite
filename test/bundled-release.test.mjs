import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { stageBundledReleaseCatalog } from '../src/bundled-release.mjs'
import { createReleaseFixture } from './release-helpers.mjs'

test('a standard application payload excludes optional monitoring and dogfood artifacts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-bundled-release-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifestPath = await createReleaseFixture(join(root, 'source'), {
    suiteVersion: '0.1.0-beta.1', releaseId: 'fixture-beta-1', marker: 'bundle', includeObservability: true,
  })
  const destination = join(root, 'standard')
  const result = await stageBundledReleaseCatalog(dirname(manifestPath), destination, 'standard')
  assert.deepEqual(result.components, ['node-runtime', 'direct-execution-runtime', 'math-anchor', 'migratory-time'])
  const manifest = JSON.parse(await readFile(join(destination, 'current.json'), 'utf8'))
  assert.deepEqual(manifest.components.map((component) => component.id), result.components)
  assert.equal((await readdir(join(destination, 'artifacts'))).length, 4)
  await assert.rejects(access(join(destination, 'artifacts', 'agent-tool-observer-0.1.0-darwin-arm64.tar.gz')))
})

test('an observability application payload retains the complete consented component pair', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-bundled-observability-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifestPath = await createReleaseFixture(join(root, 'source'), {
    suiteVersion: '0.1.0-beta.1', releaseId: 'fixture-beta-1', marker: 'bundle', includeObservability: true,
  })
  const result = await stageBundledReleaseCatalog(dirname(manifestPath), join(root, 'observability'), 'observability')
  assert.equal(result.components.includes('agent-tool-observer'), true)
  assert.equal(result.components.includes('context-surface-analyzer'), true)
})
