import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { acquireArtifact } from '../src/release-artifacts.mjs'

const payload = Buffer.from('valid-bound-artifact-fixture\n')
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

function fixtureComponent(overrides = {}) {
  return {
    id: 'fixture',
    version: '1.0.0',
    platform: 'test',
    artifact: {
      url: 'https://fixture.invalid/archive.tar.gz',
      bytes: payload.length,
      sha256: sha256(payload),
      ...overrides.artifact,
    },
    ...overrides,
  }
}

async function withDownloads(run) {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-artifact-download-'))
  try {
    return await run({ downloads: root })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function responseFrom(body, headers = {}, { delayMs = 0 } = {}) {
  if (delayMs <= 0) return new Response(body, { status: 200, headers })
  return new Response(new ReadableStream({
    async start(controller) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      controller.enqueue(body instanceof Uint8Array ? body : Buffer.from(body))
      controller.close()
    },
  }), { status: 200, headers })
}

function hangingBody() {
  return new ReadableStream({
    start() {},
    cancel() {},
  })
}

async function leftoverTemporaryFiles(downloads) {
  return (await readdir(downloads)).filter((name) => name.includes('.tmp-'))
}

async function acquire(component, paths, headers, extra = {}) {
  const body = extra.body ?? payload
  const delayMs = extra.delayMs ?? 0
  const response = extra.response ?? responseFrom(body, headers, { delayMs })
  return acquireArtifact(component, '/unused/current.json', paths, {
    fetch: extra.fetch ?? (async (_url, options = {}) => {
      if (options.signal?.aborted === true) {
        throw options.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
      }
      if (extra.abortFetchAfterMs > 0) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, extra.abortFetchAfterMs)
          options.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(options.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
          }, { once: true })
        })
      }
      return response
    }),
    timeoutMs: extra.timeoutMs ?? 5_000,
    stallTimeoutMs: extra.stallTimeoutMs ?? 5_000,
    signal: extra.signal,
  })
}

test('matching Content-Length downloads the bound artifact', async () => {
  const component = fixtureComponent()
  await withDownloads(async (paths) => {
    const result = await acquire(component, paths, { 'content-length': String(payload.length) })
    assert.equal(result.created, true)
    assert.deepEqual(await readFile(result.path), payload)
    assert.deepEqual(await leftoverTemporaryFiles(paths.downloads), [])
  })
})

test('missing Content-Length is not treated as zero and still verifies bytes and SHA-256', async () => {
  const component = fixtureComponent()
  await withDownloads(async (paths) => {
    const result = await acquire(component, paths, {})
    assert.equal(result.created, true)
    assert.deepEqual(await readFile(result.path), payload)
  })
})

test('chunked transfer without Content-Length succeeds when the body matches the bound artifact', async () => {
  const component = fixtureComponent()
  await withDownloads(async (paths) => {
    const result = await acquire(component, paths, { 'transfer-encoding': 'chunked' })
    assert.equal(result.created, true)
    assert.deepEqual(await readFile(result.path), payload)
  })
})

test('unparseable Content-Length skips the early compare and still verifies the body', async () => {
  const component = fixtureComponent()
  await withDownloads(async (paths) => {
    const result = await acquire(component, paths, { 'content-length': 'not-a-length' })
    assert.equal(result.created, true)
    assert.deepEqual(await readFile(result.path), payload)
  })
})

test('wrong Content-Length fails before trusting the body', async () => {
  const component = fixtureComponent()
  await withDownloads(async (paths) => {
    await assert.rejects(
      acquire(component, paths, { 'content-length': String(payload.length + 1) }),
      (error) => error.code === 'RELEASE_ARTIFACT_SIZE_MISMATCH' && error.details.contentLength === payload.length + 1,
    )
    assert.deepEqual(await leftoverTemporaryFiles(paths.downloads), [])
  })
})

test('a matching Content-Length still fails if the stream continues past the bound size', async () => {
  const component = fixtureComponent()
  const oversized = Buffer.concat([payload, Buffer.from('trailing-overflow\n')])
  await withDownloads(async (paths) => {
    await assert.rejects(
      acquire(component, paths, { 'content-length': String(payload.length) }, { body: oversized }),
      (error) => error.code === 'RELEASE_ARTIFACT_SIZE_MISMATCH' && error.details.receivedBytes > component.artifact.bytes,
    )
    assert.deepEqual(await leftoverTemporaryFiles(paths.downloads), [])
  })
})

test('a body larger than the bound size is stopped before the extra bytes are kept', async () => {
  const component = fixtureComponent()
  const oversized = Buffer.concat([payload, Buffer.from('extra-bytes-that-must-not-be-kept\n')])
  await withDownloads(async (paths) => {
    await assert.rejects(
      acquire(component, paths, {}, { body: oversized }),
      (error) => error.code === 'RELEASE_ARTIFACT_SIZE_MISMATCH' && error.details.receivedBytes > component.artifact.bytes,
    )
    assert.deepEqual(await leftoverTemporaryFiles(paths.downloads), [])
  })
})

test('a truncated body fails the final size check', async () => {
  const component = fixtureComponent()
  await withDownloads(async (paths) => {
    await assert.rejects(
      acquire(component, paths, {}, { body: payload.subarray(0, payload.length - 1) }),
      (error) => error.code === 'RELEASE_ARTIFACT_SIZE_MISMATCH'
        && error.details.receivedBytes === payload.length - 1,
    )
    assert.deepEqual(await leftoverTemporaryFiles(paths.downloads), [])
  })
})

test('a same-size body with the wrong SHA-256 is rejected', async () => {
  const component = fixtureComponent()
  const wrong = Buffer.from('valid-bound-artifact-fixturX\n')
  assert.equal(wrong.length, payload.length)
  await withDownloads(async (paths) => {
    await assert.rejects(
      acquire(component, paths, { 'content-length': String(wrong.length) }, { body: wrong }),
      (error) => error.code === 'RELEASE_ARTIFACT_DIGEST_MISMATCH',
    )
    assert.deepEqual(await leftoverTemporaryFiles(paths.downloads), [])
  })
})

test('a hung download fails with an explicit timeout and leaves no temporary file', async () => {
  const component = fixtureComponent()
  await withDownloads(async (paths) => {
    await assert.rejects(
      acquire(component, paths, {}, { abortFetchAfterMs: 1_000, timeoutMs: 40, stallTimeoutMs: 0 }),
      (error) => error.code === 'RELEASE_DOWNLOAD_TIMEOUT',
    )
    assert.deepEqual(await leftoverTemporaryFiles(paths.downloads), [])
  })
})

test('a stalled response body fails closed without keeping a partial file', async () => {
  const component = fixtureComponent()
  await withDownloads(async (paths) => {
    await assert.rejects(
      acquire(component, paths, {}, {
        response: new Response(hangingBody(), { status: 200 }),
        timeoutMs: 2_000,
        stallTimeoutMs: 40,
      }),
      (error) => error.code === 'RELEASE_DOWNLOAD_STALLED',
    )
    assert.deepEqual(await leftoverTemporaryFiles(paths.downloads), [])
  })
})

test('caller cancellation fails with RELEASE_DOWNLOAD_CANCELLED and cleans up', async () => {
  const component = fixtureComponent()
  const controller = new AbortController()
  await withDownloads(async (paths) => {
    const pending = acquire(component, paths, {}, {
      abortFetchAfterMs: 1_000,
      timeoutMs: 5_000,
      stallTimeoutMs: 0,
      signal: controller.signal,
    })
    queueMicrotask(() => controller.abort())
    await assert.rejects(pending, (error) => error.code === 'RELEASE_DOWNLOAD_CANCELLED')
    assert.deepEqual(await leftoverTemporaryFiles(paths.downloads), [])
  })
})

test('a failed download can be retried after leftover cleanup', async () => {
  const component = fixtureComponent()
  await withDownloads(async (paths) => {
    await assert.rejects(
      acquire(component, paths, { 'content-length': String(payload.length + 1) }),
      (error) => error.code === 'RELEASE_ARTIFACT_SIZE_MISMATCH',
    )
    const result = await acquire(component, paths, {})
    assert.equal(result.created, true)
    assert.deepEqual(await readFile(result.path), payload)
    assert.deepEqual(await leftoverTemporaryFiles(paths.downloads), [])
  })
})
