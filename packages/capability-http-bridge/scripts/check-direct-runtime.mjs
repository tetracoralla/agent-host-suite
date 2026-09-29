#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  DirectExecutionRuntime,
  prepareRuntimeConfig,
} from '../../direct-execution-runtime/src/index.mjs'

const repositoryRoot = resolve(import.meta.dirname, '..')
const runtimeFixture = resolve(repositoryRoot, '../direct-execution-runtime/test/fixtures/fake-capability')
const execFileAsync = promisify(execFile)
const keychainPilot = process.env.AGENT_HOST_KEYCHAIN_PILOT === '1'
const credential = keychainPilot
  ? {
      service: `org.openadam.agent-host.http-bridge-pilot.${randomUUID()}`,
      account: `pilot-${randomUUID()}`,
      token: `temporary-${randomUUID()}`,
    }
  : null

const server = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.deepEqual(
    {
      schemaVersion: body.schemaVersion,
      capabilityId: body.capabilityId,
      capabilityVersion: body.capabilityVersion,
      operationId: body.operationId,
    },
    {
      schemaVersion: 'openadam.remote-capability-request.v0.1',
      capabilityId: 'org.openadam.test.echo',
      capabilityVersion: '0.1.0',
      operationId: 'echo',
    },
  )
  assert.equal(request.headers.authorization, credential === null ? undefined : `Bearer ${credential.token}`)
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({
    schemaVersion: 'openadam.remote-capability-response.v0.1',
    id: body.id,
    ok: true,
    result: { value: body.input.value },
  }))
})


const TRANSIENT_TEMP_RM_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'])

async function rmTempTree(target) {
  const maxAttempts = process.platform === 'win32' ? 10 : 1
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true })
      return
    } catch (error) {
      if (error?.code === 'ENOENT') return
      if (attempt + 1 >= maxAttempts || !TRANSIENT_TEMP_RM_CODES.has(error?.code)) throw error
      await new Promise((done) => setTimeout(done, 50 * (attempt + 1)))
    }
  }
}

const root = await mkdtemp(resolve(tmpdir(), 'capability-http-direct-pilot-'))
let runtime
let keychainEntryCreated = false
try {
  if (credential !== null) {
    if (process.platform !== 'darwin') throw new Error('AGENT_HOST_KEYCHAIN_PILOT requires macOS Keychain')
    await execFileAsync('/usr/bin/security', [
      'add-generic-password',
      '-U',
      '-s', credential.service,
      '-a', credential.account,
      '-w', credential.token,
    ], { timeout: 5000, maxBuffer: 16 * 1024 })
    keychainEntryCreated = true
  }
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  await cp(runtimeFixture, root, { recursive: true })
  await cp(resolve(repositoryRoot, 'src'), resolve(root, 'bridge'), { recursive: true })
  await writeFile(resolve(root, 'instance.json'), JSON.stringify({
    schemaVersion: 'openadam.http-capability-instance.v0.1',
    endpoint: `http://127.0.0.1:${address.port}/capability`,
    capability: { id: 'org.openadam.test.echo', version: '0.1.0' },
    operations: ['echo'],
    auth: credential === null
      ? { kind: 'none' }
      : { kind: 'macos-keychain-bearer', service: credential.service, account: credential.account },
    timeoutMs: 1000,
    maxResponseBytes: 65536,
  }))
  const manifestPath = resolve(root, 'provider.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.provider.id = 'test.http-capability-provider'
  manifest.provider.name = 'HTTP Capability Provider Pilot'
  manifest.implementations[0].adapter.args = [
    'bridge/adapter.mjs',
    '--instance',
    'instance.json',
  ]
  manifest.implementations[0].adapterBindings[0].target = 'bridge/adapter.mjs#echo'
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2))

  const config = {
    schemaVersion: 'openadam.direct-provider-config.v0.2',
    limits: {
      maxConcurrentCalls: 2,
      maxQueuedCalls: 4,
      maxWorkOrderCalls: 16,
      maxWorkOrderBytes: 262144,
      maxProviderResponseBytes: 65536,
      maxResultBytes: 262144,
      maxProtocolLineBytes: 1048576,
      maxStderrBytes: 4096,
      // The whole-call budget includes cold Node startup, identity hashing,
      // and platform process isolation. Keep it tolerant of a loaded builder;
      // the actual loopback HTTP deadline remains one second above.
      defaultTimeoutMs: 30000,
      circuitBreakerFailureThreshold: 3,
      circuitBreakerCooldownMs: 50,
    },
    providers: [{
      providerId: 'test.http-capability-provider',
      transport: 'capability-jsonl-v0.1',
      lifecycle: 'per-call',
      rootPath: root,
      profilePath: resolve(root, 'capability-profile.json'),
      manifestPath,
      identityFiles: [
        resolve(root, 'bridge/adapter.mjs'),
        resolve(root, 'bridge/instance.mjs'),
        resolve(root, 'bridge/json.mjs'),
        resolve(root, 'instance.json'),
      ],
      capabilityId: 'org.openadam.test.echo',
      capabilityVersion: '0.1.0',
      contracts: [{
        operationId: 'echo',
        inputSchemaPath: resolve(root, 'echo.input.schema.json'),
        outputSchemaPath: resolve(root, 'echo.output.schema.json'),
      }],
    }],
  }
  runtime = new DirectExecutionRuntime(await prepareRuntimeConfig(config))
  const result = await runtime.runWorkOrder({
    schemaVersion: 'openadam.direct-work-order.v0.1',
    id: 'http-provider-pilot',
    calls: [{
      id: 'remote-echo',
      providerId: 'test.http-capability-provider',
      target: {
        kind: 'capability',
        capabilityId: 'org.openadam.test.echo',
        capabilityVersion: '0.1.0',
        operationId: 'echo',
      },
      input: { value: 'remote-boundary-observed' },
    }],
  })
  assert.equal(result.status, 'ok', JSON.stringify(result))
  assert.deepEqual(result.calls[0].result, { value: 'remote-boundary-observed' })
  assert.equal(result.execution.modelCalls, 0)
  assert.equal(runtime.providers.sessionSnapshots()[0].present, false)
  console.log(
    `PASS Direct Runtime executed one typed Capability through a local JSONL bridge and an observed loopback HTTP provider; modelCalls=0 credential=${credential === null ? 'none' : 'macos-keychain-reference'} providerProcessResident=false`,
  )
} finally {
  if (runtime !== undefined) await runtime.close()
  await new Promise((resolveClose) => server.close(() => resolveClose()))
  await rmTempTree(root)
  if (keychainEntryCreated) {
    await execFileAsync('/usr/bin/security', [
      'delete-generic-password',
      '-s', credential.service,
      '-a', credential.account,
    ], { timeout: 5000, maxBuffer: 16 * 1024 })
  }
}
