import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { cleanupRuntimeSocket, writeRuntimeFiles } from '../src/runtime-config.mjs'
import { prepareStatePaths } from '../src/state.mjs'

test('runtime files use a private socket path within the platform byte limit', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-runtime-state-with-a-deliberately-long-root-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  const paths = await prepareStatePaths(stateRoot)
  const files = await writeRuntimeFiles(paths, {
    components: {
      'math-anchor': { version: '0.4.0', pluginRoot: '/private/math', command: '/private/math/bin', args: ['mcp'], identityFiles: [] },
      'migratory-time': { version: '2.0.0', root: '/private/time', profilePath: '/private/time/profile.json', manifestPath: '/private/time/provider.json', adapterPath: '/private/time/adapter.mjs', inputSchemaPath: '/private/time/input.json', outputSchemaPath: '/private/time/output.json' },
    },
  })
  t.after(() => cleanupRuntimeSocket(paths, files))
  assert.equal(Buffer.byteLength(files.socketPath, 'utf8') <= 103, true)
  assert.equal(files.socketPath, join(files.socketDirectory, 'direct-runtime.sock'))
})
