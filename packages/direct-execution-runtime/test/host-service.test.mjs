import { testSocketPath, assertEndpointAbsent } from './ipc-helpers.mjs'
import { access, chmod, mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareRuntimeConfig } from '../src/config.mjs'
import { requestDirectHost } from '../src/host-client.mjs'
import { HOST_REQUEST_VERSION, HOST_RESPONSE_VERSION } from '../src/host-protocol.mjs'
import { DirectHostService, waitForSocketIdentity } from '../src/host-service.mjs'
import { DirectExecutionRuntime } from '../src/runtime.mjs'
import { assertSchema, createValidator, loadBundledSchema } from '../src/schema.mjs'
import { fakeCall, fakeConfig, fakeMcpConfig, workOrder } from './helpers.mjs'

async function withService(task, config = fakeConfig(), serviceOptions = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), 'direct-host-service-'))
  const runtime = new DirectExecutionRuntime(await prepareRuntimeConfig(config))
  const socketPath = testSocketPath(directory)
  const service = new DirectHostService(runtime, { socketPath, ...serviceOptions })
  try {
    const ready = await service.start()
    return await task({ directory, runtime, service, socketPath, ready })
  } finally {
    await service.close()
    await rm(directory, { recursive: true, force: true })
  }
}

async function rawRequest(socketPath, text) {
  return await new Promise((resolvePromise, reject) => {
    const chunks = []
    const socket = connect({ path: socketPath })
    socket.once('connect', () => socket.end(`${text}\n`))
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.once('error', reject)
    socket.once('end', () => resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
  })
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true before timeout')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
  }
}

test('persistent host service reuses one provider session across separate clients', async () => {
  await withService(async ({ runtime, service, socketPath, ready }) => {
    const validateReady = createValidator().compile(await loadBundledSchema('host-service-observation.schema.json'))
    assertSchema(validateReady, ready, 'TEST_READY_INVALID', 'host readiness')
    if (process.platform !== 'win32') assert.equal((await stat(socketPath)).mode & 0o777, 0o600)
    const first = await requestDirectHost({
      socketPath,
      action: 'run',
      workOrder: workOrder('first-client', [fakeCall('first', { value: 'one' })]),
    })
    const second = await requestDirectHost({
      socketPath,
      action: 'run',
      workOrder: workOrder('second-client', [fakeCall('second', { value: 'two' })]),
    })
    assert.equal(first.calls[0].session, 'cold')
    assert.equal(second.calls[0].session, 'warm')
    assert.equal(second.calls[0].result.value, 'two')
    assert.equal(runtime.sessionSnapshot()[0].present, true)

    const projected = await requestDirectHost({
      socketPath,
      action: 'project',
      selection: {
        schemaVersion: 'openadam.direct-contract-selection.v0.1',
        providerId: 'test.fake-capability',
        target: {
          kind: 'capability',
          capabilityId: 'org.openadam.test.echo',
          capabilityVersion: '0.1.0',
          operationId: 'echo',
        },
      },
    })
    assert.equal(projected.contract.contractSource, 'configured-files')
    assert.equal(projected.target.operationId, 'echo')

    const duplicateRuntime = new DirectExecutionRuntime(await prepareRuntimeConfig(fakeConfig()))
    const duplicate = new DirectHostService(duplicateRuntime, { socketPath, replaceStaleSocket: true })
    await assert.rejects(() => duplicate.start(), (error) => error.code === 'HOST_SERVICE_IN_USE')
    await duplicate.close()

    await service.close()
    await assertEndpointAbsent(socketPath)
    assert.equal(runtime.sessionSnapshot()[0].present, false)
  })
})

test('an explicitly prepared service finishes persistent provider startup before publishing its Socket', async () => {
  const config = fakeConfig()
  config.schemaVersion = 'openadam.direct-provider-config.v0.3'
  config.servicePreparation = {
    mode: 'persistent-providers', totalTimeoutMs: 10000, providerIds: ['test.fake-capability'],
  }
  await withService(async ({ runtime, socketPath, ready }) => {
    assert.equal(ready.providerPreparation.status, 'completed')
    assert.equal(ready.providerPreparation.providers.length, 1)
    assert.equal(ready.providerPreparation.providers[0].sessionState, 'cold')
    assert.equal(ready.providerPreparation.providers[0].observation, 'process_started_unprobed')
    assert.equal(runtime.sessionSnapshot()[0].present, true)

    const first = await requestDirectHost({
      socketPath,
      action: 'run',
      workOrder: workOrder('prepared-first-client', [fakeCall('first', { value: 'ready' })]),
    })
    assert.equal(first.calls[0].status, 'ok')
    assert.equal(first.calls[0].session, 'warm')
  }, config)
})

test('concurrent start callers share one startup and receive readiness only after the Socket is live', async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), 'dx-concurrent-start-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const socketPath = testSocketPath(directory)
  const config = fakeConfig()
  config.schemaVersion = 'openadam.direct-provider-config.v0.3'
  config.servicePreparation = {
    mode: 'persistent-providers', totalTimeoutMs: 10000, providerIds: ['test.fake-capability'],
  }
  const runtime = new DirectExecutionRuntime(await prepareRuntimeConfig(config))
  const originalPreparation = runtime.preparePersistentProviders.bind(runtime)
  let preparations = 0
  runtime.preparePersistentProviders = async (...args) => {
    preparations += 1
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
    return await originalPreparation(...args)
  }
  const service = new DirectHostService(runtime, { socketPath })
  try {
    const first = service.start()
    const second = service.start()
    const [firstReady, secondReady] = await Promise.all([first, second])
    assert.strictEqual(firstReady, secondReady)
    assert.equal(preparations, 1)
    if (process.platform !== 'win32') assert.equal((await stat(socketPath)).isSocket(), true)
    const response = await requestDirectHost({
      socketPath,
      action: 'run',
      workOrder: workOrder('concurrent-start-ready', [fakeCall('ready', { value: 'ready' })]),
    })
    assert.equal(response.calls[0].result.value, 'ready')
  } finally {
    await service.close()
  }
})

test('close is single-flight with startup and leaves no falsely ready Socket or Provider session', async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), 'dx-start-close-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const socketPath = testSocketPath(directory)
  const config = fakeConfig()
  config.schemaVersion = 'openadam.direct-provider-config.v0.3'
  config.servicePreparation = {
    mode: 'persistent-providers', totalTimeoutMs: 10000, providerIds: ['test.fake-capability'],
  }
  const runtime = new DirectExecutionRuntime(await prepareRuntimeConfig(config))
  const originalPreparation = runtime.preparePersistentProviders.bind(runtime)
  runtime.preparePersistentProviders = async (...args) => {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
    return await originalPreparation(...args)
  }
  const service = new DirectHostService(runtime, { socketPath })
  const starting = service.start()
  const closing = service.close()
  await assert.rejects(() => service.start(), (error) => error.code === 'HOST_SERVICE_CLOSING')
  await assert.rejects(starting, (error) => error.code === 'HOST_SERVICE_CLOSING')
  await closing
  await assertEndpointAbsent(socketPath)
  assert.equal(runtime.sessionSnapshot().every((provider) => provider.present === false), true)
})

test('current and compatibility readiness schemas admit Windows named pipes but reject relative paths', async () => {
  const ajv = createValidator()
  for (const schemaName of ['host-service-observation.schema.json', 'host-service-observation.schema.v0.1.json']) {
    const schema = await loadBundledSchema(schemaName)
    const validate = ajv.compile(schema)
    const observation = {
      schemaVersion: schemaName.endsWith('.v0.1.json')
        ? 'openadam.direct-host-service-observation.v0.1'
        : 'openadam.direct-host-service-observation.v0.2',
      status: 'ready',
      socketPath: '\\\\.\\pipe\\openadam-agent-host',
      pid: 42,
      ...(schemaName.endsWith('.v0.1.json') ? {} : {
        providerPreparation: { status: 'skipped', strategy: 'lazy', providers: [], totalMs: 0 },
      }),
      limits: {
        maxConnections: 64,
        requestReceiveTimeoutMs: 1000,
        maxWorkOrderBytes: 1024,
        maxResultBytes: 262144,
      },
    }
    assert.equal(validate(observation), true, JSON.stringify(validate.errors))
    assert.equal(validate({ ...observation, socketPath: 'relative.sock' }), false)
  }
})

test('a failed startup is terminal, leaves no residue, and a fresh service can retry the Socket', async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), 'dx-start-retry-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const socketPath = testSocketPath(directory)
  const config = fakeConfig()
  config.schemaVersion = 'openadam.direct-provider-config.v0.3'
  config.servicePreparation = {
    mode: 'persistent-providers', totalTimeoutMs: 10000, providerIds: ['test.fake-capability'],
  }
  const runtime = new DirectExecutionRuntime(await prepareRuntimeConfig(config))
  const originalPreparation = runtime.preparePersistentProviders.bind(runtime)
  let attempts = 0
  runtime.preparePersistentProviders = async (...args) => {
    attempts += 1
    if (attempts === 1) throw Object.assign(new Error('injected preparation failure'), { code: 'HOST_TIMEOUT' })
    return await originalPreparation(...args)
  }
  const service = new DirectHostService(runtime, { socketPath })
  await assert.rejects(() => service.start(), (error) => error.code === 'HOST_TIMEOUT')
  await assertEndpointAbsent(socketPath)
  assert.equal(runtime.sessionSnapshot().every((provider) => provider.present === false), true)
  await assert.rejects(() => service.start(), (error) => error.code === 'HOST_SERVICE_CLOSED')

  const retryRuntime = new DirectExecutionRuntime(await prepareRuntimeConfig(config))
  const retry = new DirectHostService(retryRuntime, { socketPath })
  try {
    const ready = await retry.start()
    assert.equal(ready.status, 'ready')
    if (process.platform !== 'win32') assert.equal((await stat(socketPath)).isSocket(), true)
  } finally {
    await retry.close()
  }
})

test('service preparation shares one total deadline and never publishes a partially prepared Socket', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'dx-prep-'))
  const socketPath = testSocketPath(directory)
  const config = fakeMcpConfig({ args: ['--startup-delay=3000'] })
  const second = structuredClone(config.providers[0])
  second.providerId = 'test.fake-mcp-second'
  config.providers.push(second)
  config.schemaVersion = 'openadam.direct-provider-config.v0.3'
  config.servicePreparation = {
    mode: 'persistent-providers',
    totalTimeoutMs: 5000,
    providerIds: ['test.fake-mcp', 'test.fake-mcp-second'],
  }
  const runtime = new DirectExecutionRuntime(await prepareRuntimeConfig(config))
  const service = new DirectHostService(runtime, { socketPath })
  try {
    const starting = service.start()
    await waitFor(() => runtime.sessionSnapshot()[0].pid !== null, 4500)
    const preparedPid = runtime.sessionSnapshot()[0].pid
    await assert.rejects(starting, (error) => error.code === 'HOST_TIMEOUT')
    await assertEndpointAbsent(socketPath)
    assert.equal(runtime.sessionSnapshot().every((provider) => provider.present === false), true)
    assert.throws(() => process.kill(preparedPid, 0), (error) => error.code === 'ESRCH')
  } finally {
    await service.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('a pre-warmed runtime produces a valid warm readiness observation', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'dx-warm-ready-'))
  const socketPath = testSocketPath(directory)
  const config = fakeConfig()
  config.schemaVersion = 'openadam.direct-provider-config.v0.3'
  config.servicePreparation = {
    mode: 'persistent-providers', totalTimeoutMs: 10000, providerIds: ['test.fake-capability'],
  }
  const runtime = new DirectExecutionRuntime(await prepareRuntimeConfig(config))
  const service = new DirectHostService(runtime, { socketPath })
  try {
    await runtime.preparePersistentProviders()
    const ready = await service.start()
    assert.equal(ready.providerPreparation.providers[0].sessionState, 'warm')
    const validateReady = createValidator().compile(await loadBundledSchema('host-service-observation.schema.json'))
    assertSchema(validateReady, ready, 'TEST_READY_INVALID', 'host readiness')
  } finally {
    await service.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('cold host service waits for the listening Socket to become filesystem-visible', async () => {
  let inspections = 0
  let delays = 0
  const identity = await waitForSocketIdentity('/private/runtime.sock', {
    lstat: async () => {
      inspections += 1
      if (inspections < 3) throw Object.assign(new Error('not visible yet'), { code: 'ENOENT' })
      return { isSocket: () => true, dev: 1, ino: 2 }
    },
    delay: async () => { delays += 1 },
  })
  assert.equal(identity.ino, 2)
  assert.equal(inspections, 3)
  assert.equal(delays, 2)
})

test('invalid host protocol input is bounded and does not poison the next request', async () => {
  await withService(async ({ socketPath }) => {
    const invalid = await rawRequest(
      socketPath,
      `{"schemaVersion":"${HOST_REQUEST_VERSION}","id":"a","id":"b","action":"inspect"}`,
    )
    assert.equal(invalid.status, 'host_error')
    assert.equal(invalid.error.code, 'HOST_INVALID_JSON')
    const recovered = await requestDirectHost({
      socketPath,
      action: 'run',
      workOrder: workOrder('after-invalid', [fakeCall('ready', { value: 'ready' })]),
    })
    assert.equal(recovered.calls[0].result.value, 'ready')
  })
})

test('incomplete and delayed extra requests cannot retain admission or race the next client', async () => {
  await withService(async ({ runtime, socketPath }) => {
    const incomplete = await new Promise((resolvePromise, reject) => {
      const chunks = []
      const socket = connect({ path: socketPath })
      socket.once('connect', () => socket.write(`{"schemaVersion":"${HOST_REQUEST_VERSION}"`))
      socket.on('data', (chunk) => chunks.push(chunk))
      socket.once('error', reject)
      socket.once('end', () => resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
    })
    assert.equal(incomplete.error.code, 'HOST_TIMEOUT')

    const first = {
      schemaVersion: HOST_REQUEST_VERSION,
      id: 'first-pipelined',
      action: 'run',
      workOrder: workOrder('first-pipelined', [fakeCall('slow', { value: 'late', delayMs: 200 })]),
    }
    const second = { schemaVersion: HOST_REQUEST_VERSION, id: 'second-pipelined', action: 'inspect' }
    const pipelined = await new Promise((resolvePromise, reject) => {
      const chunks = []
      const socket = connect({ path: socketPath })
      socket.once('connect', () => {
        socket.write(`${JSON.stringify(first)}\n`)
        setTimeout(() => socket.end(`${JSON.stringify(second)}\n`), 10)
      })
      socket.on('data', (chunk) => chunks.push(chunk))
      socket.once('error', reject)
      socket.once('end', () => resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
    })
    assert.equal(pipelined.error.code, 'HOST_PROTOCOL_ERROR')
    assert.equal(runtime.admissionSnapshot().active, 0)
    assert.equal(runtime.admissionSnapshot().queued, 0)

    const recovered = await requestDirectHost({
      socketPath,
      action: 'run',
      workOrder: workOrder('request-framing-recovery', [fakeCall('ready', { value: 'ready' })]),
    })
    assert.equal(recovered.calls[0].status, 'ok', JSON.stringify(recovered.calls[0]))
  }, fakeConfig(), { requestReceiveTimeoutMs: 25 })
})

test('disconnect before a complete request line starts no work and preserves a cold recovery', async () => {
  await withService(async ({ runtime, socketPath }) => {
    const socket = connect({ path: socketPath })
    await new Promise((resolvePromise, reject) => {
      socket.once('connect', resolvePromise)
      socket.once('error', reject)
    })
    socket.write(`{"schemaVersion":"${HOST_REQUEST_VERSION}","id":"incomplete-disconnect"`)
    socket.destroy()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
    assert.equal(runtime.admissionSnapshot().active, 0)
    assert.equal(runtime.sessionSnapshot()[0].present, false)

    const recovered = await requestDirectHost({
      socketPath,
      action: 'run',
      workOrder: workOrder('incomplete-disconnect-recovery', [fakeCall('ready', { value: 'ready' })]),
    })
    assert.equal(recovered.calls[0].status, 'ok')
    assert.equal(recovered.calls[0].session, 'cold')
  })
})

test('reader abandonment after request-line transfer cannot corrupt work or admission', async () => {
  await withService(async ({ runtime, socketPath }) => {
    const request = {
      schemaVersion: HOST_REQUEST_VERSION,
      id: 'disconnect-client',
      action: 'run',
      workOrder: workOrder('disconnect', [fakeCall('slow', { value: 'late', delayMs: 500 })]),
    }
    const socket = connect({ path: socketPath })
    let responseBytes = 0
    socket.on('data', (chunk) => { responseBytes += chunk.length })
    await new Promise((resolvePromise, reject) => {
      socket.once('connect', resolvePromise)
      socket.once('error', reject)
    })
    socket.end(`${JSON.stringify(request)}\n`)
    // A full parallel test run can delay the adapter's cold start well beyond
    // the 500 ms provider delay. This assertion is about lifecycle cleanup,
    // not a two-second performance contract, so retain a bounded but realistic
    // allowance for the admitted call to start and settle.
    await waitFor(() => runtime.admissionSnapshot().active === 1, 5000)
    socket.destroy()
    await waitFor(() => runtime.admissionSnapshot().active === 0, 5000)
    assert.equal(responseBytes, 0)
    const recovered = await requestDirectHost({
      socketPath,
      action: 'run',
      workOrder: workOrder('disconnect-recovery', [fakeCall('ready', { value: 'ready' })]),
    })
    assert.equal(recovered.calls[0].status, 'ok')
    assert.equal(recovered.calls[0].session, 'warm')
    assert.equal(runtime.sessionSnapshot()[0].generation, 1)
  })
})

test('host shutdown aborts active work and reaps the owned provider process', async () => {
  await withService(async ({ runtime, service, socketPath }) => {
    const request = requestDirectHost({
      socketPath,
      action: 'run',
      workOrder: workOrder('shutdown-active', [fakeCall('slow', { value: 'late', delayMs: 500 })]),
    }).catch((error) => error)
    await waitFor(() => Number.isInteger(runtime.sessionSnapshot()[0].pid), 5000)
    const pid = runtime.sessionSnapshot()[0].pid

    await service.close()
    const clientError = await request
    assert.equal(clientError.code, 'HOST_TRANSPORT_ERROR')
    assert.equal(runtime.admissionSnapshot().active, 0)
    assert.equal(runtime.sessionSnapshot()[0].present, false)
    assert.throws(
      () => process.kill(pid, 0),
      (error) => error.code === 'ESRCH',
    )
    await assertEndpointAbsent(socketPath)
  })
})

test('host client resolves the first complete response line and rejects a second response in the same frame', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'direct-host-client-framing-'))
  const socketPath = testSocketPath(directory)
  const server = createServer((socket) => {
    const chunks = []
    socket.on('data', (chunk) => {
      chunks.push(chunk)
      const buffer = Buffer.concat(chunks)
      if (!buffer.includes(0x0a)) return
      socket.removeAllListeners('data')
      const request = JSON.parse(buffer.toString('utf8').split('\n')[0])
      const response = {
        schemaVersion: HOST_RESPONSE_VERSION,
        id: request.id,
        status: 'ok',
        result: {},
      }
      socket.write(`${JSON.stringify(response)}\n${JSON.stringify(response)}\n`)
    })
  })
  try {
    await new Promise((resolvePromise, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolvePromise)
    })
    await assert.rejects(
      () => requestDirectHost({ socketPath, action: 'inspect' }),
      (error) => error.code === 'HOST_PROTOCOL_ERROR' && /more than one response/.test(error.message),
    )
  } finally {
    await new Promise((resolvePromise) => server.close(() => resolvePromise()))
    await rm(directory, { recursive: true, force: true })
  }
})

test('host client accepts a service that responds before any client EOF (installed 0.1.x framing)', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'direct-host-client-legacy-'))
  const socketPath = testSocketPath(directory)
  const server = createServer((socket) => {
    const chunks = []
    socket.on('data', (chunk) => {
      chunks.push(chunk)
      const buffer = Buffer.concat(chunks)
      if (!buffer.includes(0x0a)) return
      const request = JSON.parse(buffer.toString('utf8').split('\n')[0])
      const response = {
        schemaVersion: HOST_RESPONSE_VERSION,
        id: request.id,
        status: 'ok',
        result: { legacy: true },
      }
      socket.write(`${JSON.stringify(response)}\n`)
      // Deliberately keeps the write side open afterwards: the client must
      // settle on the first complete line instead of waiting for an EOF.
    })
  })
  try {
    await new Promise((resolvePromise, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolvePromise)
    })
    const result = await requestDirectHost({ socketPath, action: 'inspect' })
    assert.equal(result.legacy, true)
  } finally {
    await new Promise((resolvePromise) => server.close(() => resolvePromise()))
    await rm(directory, { recursive: true, force: true })
  }
})

test('host service answers a client that keeps its write side open', async () => {
  await withService(async ({ socketPath }) => {
    const response = await new Promise((resolvePromise, reject) => {
      const chunks = []
      const socket = connect({ path: socketPath })
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('service never answered a client that did not half-close'))
      }, 5_000)
      socket.once('connect', () => {
        socket.write(`{"schemaVersion":"${HOST_REQUEST_VERSION}","id":"no-half-close","action":"inspect"}\n`)
      })
      socket.on('data', (chunk) => chunks.push(chunk))
      socket.once('end', () => {
        clearTimeout(timer)
        socket.destroy()
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      })
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
    assert.equal(response.id, 'no-half-close')
    assert.equal(response.status, 'ok')
  })
})

test('host service refuses a socket directory accessible by other users', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'direct-host-insecure-'))
  const runtime = new DirectExecutionRuntime(await prepareRuntimeConfig(fakeConfig()))
  try {
    await chmod(directory, 0o755)
    const service = new DirectHostService(runtime, { socketPath: testSocketPath(directory) })
    await assert.rejects(() => service.start(), (error) => error.code === 'HOST_CONFIG_INVALID')
    await service.close()
  } finally {
    await chmod(directory, 0o700)
    await rm(directory, { recursive: true, force: true })
  }
})

test('host service rejects an overlong Unix Socket path before listening can truncate it', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'direct-host-long-socket-'))
  const runtime = new DirectExecutionRuntime(await prepareRuntimeConfig(fakeConfig()))
  try {
    const service = new DirectHostService(runtime, { socketPath: resolve(directory, 'x'.repeat(180)) })
    await assert.rejects(() => service.start(), (error) => error.code === 'HOST_CONFIG_INVALID' && error.message.includes('platform limit'))
    await service.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('host service rejects a socket path that exceeds the limit only after parent canonicalization', {
  skip: process.platform !== 'darwin',
}, async () => {
  const directory = await mkdtemp('/var/tmp/direct-host-canonical-socket-')
  const socketName = 'runtime.sock'
  const segmentBytes = 103 - Buffer.byteLength(directory) - Buffer.byteLength(socketName) - 2
  assert.ok(segmentBytes > 0)
  const socketDirectory = resolve(directory, 'x'.repeat(segmentBytes))
  await mkdir(socketDirectory, { mode: 0o700 })
  const socketPath = resolve(socketDirectory, socketName)
  const canonicalSocketPath = resolve(await realpath(socketDirectory), socketName)
  assert.equal(Buffer.byteLength(socketPath), 103)
  assert.ok(Buffer.byteLength(canonicalSocketPath) > 103)

  const runtime = new DirectExecutionRuntime(await prepareRuntimeConfig(fakeConfig()))
  const service = new DirectHostService(runtime, { socketPath })
  try {
    await assert.rejects(
      () => service.start(),
      (error) => error.code === 'HOST_CONFIG_INVALID' && /Canonical host socket path/.test(error.message),
    )
    await assertEndpointAbsent(socketPath)
    await assert.rejects(() => access(canonicalSocketPath), (error) => error.code === 'ENOENT')
  } finally {
    await service.close()
    await rm(directory, { recursive: true, force: true })
  }
})
