import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createRuntimeConfig } from '../src/runtime-config.mjs'
import { prepareRuntimeConfig } from '../packages/direct-execution-runtime/src/config.mjs'
import { DirectExecutionRuntime } from '../packages/direct-execution-runtime/src/runtime.mjs'
import { DirectHostService } from '../packages/direct-execution-runtime/src/host-service.mjs'
import { requestDirectHost } from '../packages/direct-execution-runtime/src/host-client.mjs'
import { fakeConfig, fakeCall } from '../packages/direct-execution-runtime/test/helpers.mjs'
import { testSocketPath, assertEndpointAbsent } from '../packages/direct-execution-runtime/test/ipc-helpers.mjs'

test('Provider-only Host config runs through IPC, rejects bad input, recovers a crash, and closes owned sessions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ahpv-'))
  const config = createRuntimeConfig({ components: {
    'direct-execution-runtime': { version: '0.2.2' },
    independent: { capabilityProvider: fakeConfig().providers[0] },
  } })
  const runtime = new DirectExecutionRuntime(await prepareRuntimeConfig(config))
  const socketPath = testSocketPath(directory)
  const service = new DirectHostService(runtime, { socketPath })
  try {
    await service.start()
    const run = (id, input) => requestDirectHost({ socketPath, action: 'run', workOrder: {
      schemaVersion: 'openadam.direct-work-order.v0.2', purpose: 'validation', id,
      calls: [fakeCall(id, input)],
    } })
    const first = await run('first', { value: 'first answer' })
    assert.equal(first.calls[0].status, 'ok')
    assert.deepEqual(first.calls[0].result, { value: 'first answer' })
    assert.equal(first.calls[0].session, 'warm')
    const invalid = await run('invalid', { value: 42 })
    assert.equal(invalid.calls[0].status, 'host_error')
    assert.equal(invalid.calls[0].error.code, 'HOST_INPUT_INVALID')
    const crash = await run('crash', { value: 'crash', behavior: 'crash' })
    assert.equal(crash.calls[0].status, 'host_error')
    const recovered = await run('recovered', { value: 'recovered answer' })
    assert.equal(recovered.calls[0].status, 'ok')
    assert.deepEqual(recovered.calls[0].result, { value: 'recovered answer' })
    assert.equal(runtime.sessionSnapshot().length, 1)
  } finally {
    await service.close()
    await rm(directory, { recursive: true, force: true })
  }
  await assertEndpointAbsent(socketPath)
  assert.equal(runtime.sessionSnapshot()[0].present, false)
})
