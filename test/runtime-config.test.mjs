import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { cleanupRuntimeSocket, createRuntimeConfig, writeRuntimeFiles } from '../src/runtime-config.mjs'
import { prepareStatePaths } from '../src/state.mjs'
import { createValidator, loadBundledSchema } from '../packages/direct-execution-runtime/src/schema.mjs'

function runtimeManifest(version = '0.2.1', agentComponents = ['math-anchor', 'migratory-time']) {
  return {
    agentComponents,
    components: {
      'direct-execution-runtime': { version },
      'math-anchor': { version: '0.6.0', pluginRoot: '/private/math', command: '/private/math/bin', args: ['mcp'], identityFiles: ['/private/math/bin'] },
      'migratory-time': { version: '2.0.0', root: '/private/time', profilePath: '/private/time/profile.json', manifestPath: '/private/time/provider.json', adapterPath: '/private/time/adapter.mjs', inputSchemaPath: '/private/time/input.json', outputSchemaPath: '/private/time/output.json' },
    },
  }
}

test('built-in deterministic Providers use the reusable Direct Runtime conveyor', () => {
  const config = createRuntimeConfig({
    components: {
      'math-anchor': { version: '0.4.0', pluginRoot: '/private/math', command: '/private/math/bin', args: ['mcp'], identityFiles: [] },
      'migratory-time': { version: '2.0.0', root: '/private/time', profilePath: '/private/time/profile.json', manifestPath: '/private/time/provider.json', adapterPath: '/private/time/adapter.mjs', inputSchemaPath: '/private/time/input.json', outputSchemaPath: '/private/time/output.json' },
    },
  })
  assert.deepEqual(
    config.providers.slice(0, 2).map((provider) => [provider.providerId, provider.lifecycle]),
    [
      ['io.github.tetracoralla.math-anchor', 'persistent'],
      ['io.github.tetracoralla.migratory-time', 'persistent'],
    ],
  )
})

test('runtime config migration preserves old v0.2 rollback and scopes current preparation to active Providers', async () => {
  const retained = createRuntimeConfig(runtimeManifest('0.2.0', ['math-anchor']))
  assert.equal(retained.schemaVersion, 'openadam.direct-provider-config.v0.2')
  assert.equal(Object.hasOwn(retained, 'servicePreparation'), false)
  const validateV02 = createValidator().compile(await loadBundledSchema('provider-config.schema.v0.2.json'))
  assert.equal(validateV02(retained), true, JSON.stringify(validateV02.errors))

  const currentManifest = runtimeManifest('0.2.1', ['math-anchor'])
  currentManifest.components.inactive = {
    capabilityProvider: {
      providerId: 'io.example.inactive',
      transport: 'capability-jsonl-v0.1',
      lifecycle: 'persistent',
      rootPath: '/private/inactive',
      profilePath: '/private/inactive/profile.json',
      manifestPath: '/private/inactive/provider.json',
      identityFiles: ['/private/inactive/adapter.mjs'],
      capabilityId: 'org.example.inactive',
      capabilityVersion: '0.1.0',
      contracts: [{
        operationId: 'run',
        inputSchemaPath: '/private/inactive/input.json',
        outputSchemaPath: '/private/inactive/output.json',
      }],
    },
  }
  const current = createRuntimeConfig(currentManifest)
  assert.equal(current.schemaVersion, 'openadam.direct-provider-config.v0.3')
  assert.deepEqual(current.servicePreparation.providerIds, ['io.github.tetracoralla.math-anchor'])
  assert.equal(current.providers.some((provider) => provider.providerId === 'io.example.inactive'), true)
})

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
  assert.match(files.configPath, /provider-config-[a-f0-9]{24}\.json$/u)
  assert.equal(JSON.parse(await readFile(files.configPath, 'utf8')).schemaVersion, 'openadam.direct-provider-config.v0.2')
  assert.equal(Buffer.byteLength(files.socketPath, 'utf8') <= 103, true)
  if (process.platform === 'win32') {
    assert.equal(files.socketDirectory, null)
    assert.match(files.socketPath, /^\\\\\.\\pipe\\/u)
  } else assert.equal(files.socketPath, join(files.socketDirectory, 'direct-runtime.sock'))
})

test('an explicit isolated socket directory is created and cleaned without using the user cache root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ahri-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const paths = await prepareStatePaths(join(root, 'state'))
  const socketDirectory = join(root, 's')
  const files = await writeRuntimeFiles(paths, {
    components: {
      'math-anchor': { version: '0.4.0', pluginRoot: '/private/math', command: '/private/math/bin', args: ['mcp'], identityFiles: [] },
      'migratory-time': { version: '2.0.0', root: '/private/time', profilePath: '/private/time/profile.json', manifestPath: '/private/time/provider.json', adapterPath: '/private/time/adapter.mjs', inputSchemaPath: '/private/time/input.json', outputSchemaPath: '/private/time/output.json' },
    },
  }, { socketDirectory })
  if (process.platform === 'win32') {
    assert.equal(files.socketDirectory, null)
    assert.equal((await cleanupRuntimeSocket(paths, files, { socketDirectory })).removed, false)
    await assert.rejects(access(socketDirectory), (error) => error.code === 'ENOENT')
    return
  }
  assert.equal(files.socketDirectory, await realpath(socketDirectory))
  assert.equal((await cleanupRuntimeSocket(paths, files, { socketDirectory })).removed, true)
  await assert.rejects(access(socketDirectory), (error) => error.code === 'ENOENT')
})

test('runtime configuration grants an installed Direct Capability the explicit Host workspace', () => {
  const capabilityProvider = {
    providerId: 'io.example.structured-data',
    transport: 'capability-jsonl-v0.1',
    lifecycle: 'per-call',
    rootPath: '/private/data-transformer',
    profilePath: '/private/data-transformer/profile.json',
    manifestPath: '/private/data-transformer/provider.json',
    identityFiles: ['/private/data-transformer/adapter'],
    capabilityId: 'org.example.structured-data',
    capabilityVersion: '0.1.0',
    contracts: [{
      operationId: 'inspect',
      inputSchemaPath: '/private/data-transformer/input.json',
      outputSchemaPath: '/private/data-transformer/output.json',
    }],
    workspaceRootRequired: true,
  }
  const manifest = {
    components: {
      'math-anchor': { version: '0.4.0', pluginRoot: '/private/math', command: '/private/math/bin', args: ['mcp'], identityFiles: [] },
      'migratory-time': { version: '2.0.0', root: '/private/time', profilePath: '/private/time/profile.json', manifestPath: '/private/time/provider.json', adapterPath: '/private/time/adapter.mjs', inputSchemaPath: '/private/time/input.json', outputSchemaPath: '/private/time/output.json' },
      'data-transformer': { capabilityProvider },
    },
  }

  const config = createRuntimeConfig(manifest, { workspaceRoot: '/private/workspace' })
  const provider = config.providers.find((item) => item.providerId === capabilityProvider.providerId)
  assert.equal(provider.workspaceRoot, '/private/workspace')
  assert.equal(Object.hasOwn(provider, 'workspaceRootRequired'), false)
  assert.throws(
    () => createRuntimeConfig(manifest),
    (error) => error.code === 'RUNTIME_WORKSPACE_REQUIRED',
  )
})
