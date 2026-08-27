import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { contextAnalyzerInvocation, disableObservability } from '../src/observability.mjs'
import { prepareStatePaths, saveState, STATE_SCHEMA } from '../src/state.mjs'

test('local dogfood cannot disable monitoring and leave a consent-bearing profile incomplete', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-observability-profile-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  const paths = await prepareStatePaths(stateRoot)
  await saveState(paths, {
    schemaVersion: STATE_SCHEMA,
    suiteVersion: '0.1.0-dogfood.3',
    channel: 'release',
    profile: 'local-dogfood',
    installedAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    components: {},
    hosts: {},
    runtime: {},
    observability: { enabled: true },
  })

  await assert.rejects(
    disableObservability({ stateRoot }),
    (error) => error.code === 'OBSERVABILITY_PROFILE_REQUIRES_ENABLED',
  )
})

test('context analysis uses its auxiliary CLI when the same component also exposes an MCP runtime', () => {
  assert.deepEqual(contextAnalyzerInvocation({
    command: '/private/package/runtime/node',
    args: ['./src/mcp-server.js'],
    cliCommand: '/private/package/node/bin/node',
    cliArgs: ['/private/package/src/cli.js'],
  }), {
    command: '/private/package/node/bin/node',
    args: ['/private/package/src/cli.js'],
  })
})
