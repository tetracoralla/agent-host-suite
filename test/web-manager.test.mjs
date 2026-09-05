import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { startWebManager } from '../src/web-manager.mjs'
import { prepareStatePaths, saveState, STATE_SCHEMA } from '../src/state.mjs'

test('local Manager requires its one-session cookie and same-origin action requests', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-web-manager-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  let readyResolve
  const ready = new Promise((resolve) => { readyResolve = resolve })
  const running = startWebManager({ stateRoot, open: false, idleTimeoutMs: 60_000, onReady: readyResolve })
  const { origin, url, server } = await ready
  t.after(() => server.close())

  const denied = await fetch(`${origin}/api/dashboard`)
  assert.equal(denied.status, 401)

  const auth = await fetch(url, { redirect: 'manual' })
  assert.equal(auth.status, 303)
  assert.equal(auth.headers.get('location'), '/')
  const cookie = auth.headers.get('set-cookie').split(';')[0]

  const page = await fetch(origin, { headers: { cookie } })
  assert.equal(page.status, 200)
  const document = await page.text()
  assert.match(document, /Usage & Reliability/u)
  assert.equal(document.includes(url.split('/').at(-1)), false)

  const dashboard = await fetch(`${origin}/api/dashboard`, { headers: { cookie } })
  assert.equal(dashboard.status, 200)
  const value = await dashboard.json()
  assert.equal(value.snapshot.configured, false)
  assert.equal(value.usage.configured, false)
  assert.equal(value.preferences.language, 'system')

  const language = await fetch(`${origin}/api/action`, {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'preferences', language: 'zh-Hans' }),
  })
  assert.equal(language.status, 200)
  const languageResult = await language.json()
  assert.equal(languageResult.result.language, 'zh-Hans')
  assert.equal(languageResult.dashboard.preferences.language, 'zh-Hans')
  assert.equal(languageResult.refreshError, null)

  const invalidLanguage = await fetch(`${origin}/api/action`, {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'preferences', language: 'unsupported' }),
  })
  assert.equal(invalidLanguage.status, 400)

  const crossOrigin = await fetch(`${origin}/api/action`, {
    method: 'POST',
    headers: { cookie, origin: 'https://example.invalid', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'cleanup' }),
  })
  assert.equal(crossOrigin.status, 403)

  await new Promise((resolve) => server.close(resolve))
  await running
})

test('a committed Manager action survives a failed refresh and recovers without replay', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-web-committed-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  await writeFile(join(stateRoot, 'state.json'), '{invalid')
  let readyResolve
  const ready = new Promise((resolve) => { readyResolve = resolve })
  const running = startWebManager({ stateRoot, open: false, onReady: readyResolve })
  const { origin, url, server } = await ready
  t.after(() => server.close())
  const auth = await fetch(url, { redirect: 'manual' })
  const cookie = auth.headers.get('set-cookie').split(';')[0]
  const response = await fetch(`${origin}/api/action`, {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'preferences', language: 'zh-Hans' }),
  })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.status, 'ok')
  assert.equal(result.result.language, 'zh-Hans')
  assert.equal(result.dashboard, null)
  assert.equal(result.refreshError.code, 'STATE_INVALID_JSON')
  const saved = await readFile(join(stateRoot, 'manager-preferences.json'), 'utf8')
  assert.equal(JSON.parse(saved).language, 'zh-Hans')
  // A failing read is handled without an unhandled shared-observation rejection.
  assert.equal((await fetch(`${origin}/api/dashboard`, { headers: { cookie } })).status, 400)
  await rm(join(stateRoot, 'state.json'))
  const refreshed = await fetch(`${origin}/api/dashboard`, { headers: { cookie } })
  assert.equal(refreshed.status, 200)
  assert.equal((await refreshed.json()).preferences.language, 'zh-Hans')
  assert.equal(await readFile(join(stateRoot, 'manager-preferences.json'), 'utf8'), saved)
  await new Promise((resolve) => server.close(resolve))
  await running
})

test('local Manager lists retained sessions and downloads one metadata-only pack', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-web-trace-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  const paths = await prepareStatePaths(stateRoot)
  await saveState(paths, {
    schemaVersion: STATE_SCHEMA,
    suiteVersion: '0.1.4',
    channel: 'release',
    profile: 'observability',
    installedAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
    components: { 'agent-tool-observer': { command: '/private/node', args: ['/private/observer.mjs'], root: '/private/observer' } },
    hosts: {},
    runtime: {},
    observability: { enabled: true, observer: { stateDir: '/private/observer-state' } },
  })
  const session = 'a'.repeat(64)
  const calls = []
  let emptyCatalog = false
  let exportedPath
  let readyResolve
  const ready = new Promise((resolve) => { readyResolve = resolve })
  const running = startWebManager({
    stateRoot,
    open: false,
    idleTimeoutMs: 60_000,
    onReady: readyResolve,
    traceSourceReader: async (options) => {
      calls.push(['sources', options])
      return {
        schemaVersion: 'openadam.agent-host-trace-source-catalog.v0.1',
        status: 'ok',
        provider: options.provider,
        privacy: { contentPolicy: 'metadata-only', sourcePathIncluded: false, rawConversationContentIncluded: false, toolArgumentsIncluded: false, toolResultsIncluded: false },
        sources: [{ sessionHash: session, firstEventAtMs: 1, lastEventAtMs: 2, totalEvents: emptyCatalog ? 0 : 3, modelSteps: emptyCatalog ? 0 : 1, toolCalls: emptyCatalog ? 0 : 1, toolResults: emptyCatalog ? 0 : 1, turnEnds: 0, completeness: 'unknown' }],
        interpretationStatus: 'not-performed',
      }
    },
    traceExporter: async (options) => {
      calls.push(['export', options])
      exportedPath = options.output
      const body = `${JSON.stringify({
        schemaVersion: 'openadam.agent-host-trace-analysis-pack.v0.2',
        source: { provider: options.provider, selectionKind: 'observer-retained-session', sessionHash: options.session },
        privacy: { contentPolicy: 'metadata-only', selectedConversationContentIncluded: false, sensitiveContentConfirmed: false, transportSecretsExcluded: true, selectedContentMayContainUserSecrets: false, observerPackRetained: false, sourceUsesObserverRetainedMetadata: true, sourcePathIncluded: false, toolArgumentsIncluded: false, toolResultsIncluded: false },
        limits: { eventsReturned: 0, eventsAvailable: 0 },
        events: [],
        interpretationStatus: 'not-performed',
      })}\n`
      await writeFile(options.output, body, { mode: 0o600 })
      return { status: 'completed', schemaVersion: 'openadam.agent-host-trace-analysis-pack.v0.2', outputPath: options.output, outputBytes: Buffer.byteLength(body), eventsReturned: 0, eventsAvailable: 0, contentPolicy: 'metadata-only', observerPackRetained: false, sourcePathStoredInPack: false, interpretationStatus: 'not-performed' }
    },
  })
  const { origin, url, server } = await ready
  t.after(() => server.close())
  const auth = await fetch(url, { redirect: 'manual' })
  const cookie = auth.headers.get('set-cookie').split(';')[0]

  const listed = await fetch(`${origin}/api/trace-sources?provider=zcode&limit=25`, { headers: { cookie } })
  assert.equal(listed.status, 200)
  assert.equal((await listed.json()).sources[0].sessionHash, session)
  emptyCatalog = true
  const empty = await fetch(`${origin}/api/trace-sources?provider=zcode&limit=25`, { headers: { cookie } })
  assert.equal(empty.status, 400)
  emptyCatalog = false
  const invalid = await fetch(`${origin}/api/trace-sources?provider=zcode&privatePath=/tmp`, { headers: { cookie } })
  assert.equal(invalid.status, 400)

  const rejected = await fetch(`${origin}/api/trace-export`, {
    method: 'POST',
    headers: { cookie, origin: 'https://example.invalid', 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'zcode', session }),
  })
  assert.equal(rejected.status, 403)
  const exported = await fetch(`${origin}/api/trace-export`, {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'zcode', session }),
  })
  assert.equal(exported.status, 200)
  assert.match(exported.headers.get('content-disposition'), /agent-host-zcode-trace-aaaaaaaaaaaa\.json/u)
  assert.equal((await exported.json()).privacy.contentPolicy, 'metadata-only')
  await assert.rejects(access(exportedPath))
  assert.equal(calls[0][1].stateRoot, stateRoot)
  assert.equal(calls[0][1].limit, 25)
  assert.equal(calls[2][0], 'export')
  assert.equal(calls[2][1].maxOutputBytes, 8 * 1024 * 1024)
  assert.equal(calls[2][1].signal instanceof AbortSignal, true)
  assert.equal(calls[2][1].signal.aborted, false)

  await new Promise((resolve) => server.close(resolve))
  await running
})

test('local Manager rejects a retained export whose file contradicts its metadata-only receipt', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-web-trace-invalid-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  let readyResolve
  let exportedPath
  const ready = new Promise((resolve) => { readyResolve = resolve })
  const running = startWebManager({
    stateRoot,
    open: false,
    idleTimeoutMs: 60_000,
    onReady: readyResolve,
    traceExporter: async (options) => {
      exportedPath = options.output
      const body = `${JSON.stringify({
        schemaVersion: 'openadam.agent-host-trace-analysis-pack.v0.2',
        source: { provider: options.provider, selectionKind: 'observer-retained-session', sessionHash: options.session },
        privacy: { contentPolicy: 'selected-content' },
        limits: { eventsReturned: 0, eventsAvailable: 0 },
        events: [],
        interpretationStatus: 'not-performed',
      })}\n`
      await writeFile(options.output, body, { mode: 0o600 })
      return { status: 'completed', schemaVersion: 'openadam.agent-host-trace-analysis-pack.v0.2', outputPath: options.output, outputBytes: Buffer.byteLength(body), eventsReturned: 0, eventsAvailable: 0, contentPolicy: 'metadata-only', observerPackRetained: false, sourcePathStoredInPack: false, interpretationStatus: 'not-performed' }
    },
  })
  const { origin, url, server } = await ready
  t.after(() => server.close())
  const auth = await fetch(url, { redirect: 'manual' })
  const cookie = auth.headers.get('set-cookie').split(';')[0]
  const exported = await fetch(`${origin}/api/trace-export`, {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'zcode', session: 'a'.repeat(64) }),
  })
  assert.equal(exported.status, 400)
  assert.equal((await exported.json()).error.code, 'TRACE_EXPORT_CONTENT_INVALID')
  await assert.rejects(access(exportedPath))
  await new Promise((resolve) => server.close(resolve))
  await running
})

test('local Manager cancels an abandoned trace export and removes its temporary output', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-web-trace-cancel-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  let readyResolve
  let exportStartedResolve
  const ready = new Promise((resolve) => { readyResolve = resolve })
  const exportStarted = new Promise((resolve) => { exportStartedResolve = resolve })
  let exportedPath
  const running = startWebManager({
    stateRoot,
    open: false,
    idleTimeoutMs: 60_000,
    onReady: readyResolve,
    traceExporter: async (options) => {
      exportedPath = options.output
      await writeFile(options.output, '{}\n', { mode: 0o600 })
      exportStartedResolve()
      await new Promise((resolve, reject) => {
        if (options.signal.aborted) {
          reject(new Error('cancelled'))
          return
        }
        options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      })
    },
  })
  const { origin, url, server } = await ready
  t.after(() => server.close())
  const auth = await fetch(url, { redirect: 'manual' })
  const cookie = auth.headers.get('set-cookie').split(';')[0]
  const controller = new AbortController()
  const pending = fetch(`${origin}/api/trace-export`, {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'zcode', session: 'a'.repeat(64) }),
    signal: controller.signal,
  })
  await exportStarted
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await access(exportedPath)
      await new Promise((resolve) => setTimeout(resolve, 10))
    } catch {
      break
    }
  }
  await assert.rejects(access(exportedPath))

  await new Promise((resolve) => server.close(resolve))
  await running
})
