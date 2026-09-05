import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

const repositoryRoot = resolve(import.meta.dirname, '..')
const adapterPath = resolve(repositoryRoot, 'src/adapter.mjs')

async function listen(handler) {
  const server = createServer(handler)
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  return {
    endpoint: `http://127.0.0.1:${address.port}/capability`,
    close: () => new Promise((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose())
    }),
  }
}

function instance(endpoint, overrides = {}) {
  return {
    schemaVersion: 'openadam.http-capability-instance.v0.1',
    endpoint,
    capability: { id: 'org.openadam.test.echo', version: '0.1.0' },
    operations: ['echo'],
    auth: { kind: 'none' },
    timeoutMs: 1000,
    maxResponseBytes: 65536,
    ...overrides,
  }
}

async function runAdapter(instanceValue, lines) {
  const root = await mkdtemp(resolve(tmpdir(), 'capability-http-bridge-test-'))
  const instancePath = resolve(root, 'instance.json')
  await writeFile(instancePath, JSON.stringify(instanceValue))
  const child = spawn(process.execPath, [adapterPath, '--instance', instancePath], {
    cwd: repositoryRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  for (const line of lines) child.stdin.write(`${line}\n`)
  child.stdin.end()
  const exit = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('bridge fixture timed out'))
    }, 5000)
    child.once('error', reject)
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolveExit({ code, signal })
    })
  })
  await rm(root, { recursive: true, force: true })
  return { exit, stdout, stderr }
}

async function readJsonRequest(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

test('forwards typed calls over loopback HTTP and preserves semantic success and error envelopes', async () => {
  const observed = []
  const remote = await listen(async (request, response) => {
    const body = await readJsonRequest(request)
    observed.push({ body, headers: request.headers })
    response.setHeader('content-type', 'application/json; charset=utf-8')
    if (body.input.value === 'reject') {
      response.end(JSON.stringify({
        schemaVersion: 'openadam.remote-capability-response.v0.1',
        id: body.id,
        ok: false,
        error: { code: 'FAKE_REJECTED', message: 'Rejected by the semantic provider', retryable: false },
      }))
      return
    }
    response.end(JSON.stringify({
      schemaVersion: 'openadam.remote-capability-response.v0.1',
      id: body.id,
      ok: true,
      result: { value: body.input.value },
    }))
  })
  try {
    const result = await runAdapter(instance(remote.endpoint), [
      JSON.stringify({ id: 'one', operationId: 'echo', input: { value: 'alpha' } }),
      JSON.stringify({ id: 'two', operationId: 'echo', input: { value: 'reject' } }),
    ])
    assert.deepEqual(result.exit, { code: 0, signal: null })
    assert.equal(result.stderr, '')
    assert.deepEqual(result.stdout.trim().split('\n').map(JSON.parse), [
      { id: 'one', ok: true, result: { value: 'alpha' } },
      {
        id: 'two',
        ok: false,
        error: { code: 'FAKE_REJECTED', message: 'Rejected by the semantic provider', retryable: false },
      },
    ])
    assert.deepEqual(observed.map(({ body }) => body), [
      {
        schemaVersion: 'openadam.remote-capability-request.v0.1',
        capabilityId: 'org.openadam.test.echo',
        capabilityVersion: '0.1.0',
        id: 'one',
        operationId: 'echo',
        input: { value: 'alpha' },
      },
      {
        schemaVersion: 'openadam.remote-capability-request.v0.1',
        capabilityId: 'org.openadam.test.echo',
        capabilityVersion: '0.1.0',
        id: 'two',
        operationId: 'echo',
        input: { value: 'reject' },
      },
    ])
    assert.equal(observed[0].headers.authorization, undefined)
  } finally {
    await remote.close()
  }
})

test('rejects cleartext non-loopback endpoints before sending a request', async () => {
  const result = await runAdapter(instance('http://192.0.2.10/capability'), [])
  assert.equal(result.exit.code, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /stopped because its instance/)
  assert.equal(result.stderr.includes('192.0.2.10'), false)
})

test('rejects duplicate request fields without forwarding them', async () => {
  let requestCount = 0
  const remote = await listen((_request, response) => {
    requestCount += 1
    response.end()
  })
  try {
    const result = await runAdapter(instance(remote.endpoint), [
      '{"id":"one","id":"two","operationId":"echo","input":{"value":"a"}}',
    ])
    assert.equal(result.exit.code, 1)
    assert.equal(result.stdout, '')
    assert.equal(requestCount, 0)
  } finally {
    await remote.close()
  }
})

test('fails the transport boundary on wrong correlation or oversized remote output', async () => {
  let mode = 'correlation'
  const remote = await listen(async (request, response) => {
    const body = await readJsonRequest(request)
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({
      schemaVersion: 'openadam.remote-capability-response.v0.1',
      id: mode === 'correlation' ? 'wrong' : body.id,
      ok: true,
      result: { value: mode === 'large' ? 'x'.repeat(5000) : 'ok' },
    }))
  })
  try {
    const request = JSON.stringify({ id: 'one', operationId: 'echo', input: { value: 'a' } })
    const mismatch = await runAdapter(instance(remote.endpoint), [request])
    assert.equal(mismatch.exit.code, 1)
    assert.equal(mismatch.stdout, '')

    mode = 'large'
    const oversized = await runAdapter(
      instance(remote.endpoint, { maxResponseBytes: 1024 }),
      [request],
    )
    assert.equal(oversized.exit.code, 1)
    assert.equal(oversized.stdout, '')
  } finally {
    await remote.close()
  }
})

test('never accepts credentials embedded in the endpoint URL', async () => {
  const result = await runAdapter(
    instance('https://name:secret@provider.example.invalid/capability'),
    [],
  )
  assert.equal(result.exit.code, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr.includes('secret'), false)
})
