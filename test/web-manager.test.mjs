import assert from 'node:assert/strict'
import { access, chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import test from 'node:test'
import { AgentHostError } from '../src/errors.mjs'
import { buildDashboardGuidance, environmentActionInvalidatesDoctor, MANAGER_SETUP_PROFILES, startWebManager } from '../src/web-manager.mjs'
import { loadState, prepareStatePaths, saveState, STATE_SCHEMA } from '../src/state.mjs'
import { setup } from '../src/setup.mjs'
import { compatibleApplicationState, createCodexRunner, createDevelopmentWorkspace, healthyCatalogPreflight } from './helpers.mjs'

async function withFakeHostOnPath(t, name = 'codex') {
  const dir = await mkdtemp(join(tmpdir(), 'agent-host-fake-cli-'))
  const bin = join(dir, process.platform === 'win32' ? `${name}.cmd` : name)
  await writeFile(bin, process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  if (process.platform !== 'win32') await chmod(bin, 0o755)
  const previous = process.env.PATH
  process.env.PATH = `${dir}${delimiter}${previous}`
  t.after(async () => {
    process.env.PATH = previous
    await rm(dir, { recursive: true, force: true })
  })
}

test('browser Updates keeps a successful GitHub preview target for Add from GitHub', async () => {
  const page = await readFile(new URL('../src/web-manager.mjs', import.meta.url), 'utf8')
  assert.match(page, /lastGithubTarget/u)
  assert.match(page, /input\.value=lastGithubTarget/u)
  assert.match(page, /github:input\.value\|\|lastGithubTarget/u)
})

test('local Manager pause and empty tool set are distinct from on-demand Skills', async (t) => {
  const page = await readFile(new URL('../src/web-manager.mjs', import.meta.url), 'utf8')
  assert.match(page, /Pause all tools/u)
  assert.match(page, /Resume tools/u)
  assert.match(page, /Fully paused: no MCP and no on-demand Skill/u)
  assert.match(page, /On-demand Skill only/u)
  assert.match(page, /pause:true/u)
  assert.match(page, /resume:true/u)
})

test('local Manager requires its one-session cookie and same-origin action requests', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-web-manager-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  let readyResolve
  const ready = new Promise((resolve) => { readyResolve = resolve })
  const running = startWebManager({
    stateRoot,
    open: false,
    idleTimeoutMs: 60_000,
    onReady: readyResolve,
    fetch: async () => new Response('missing', { status: 404 }),
  })
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
  assert.match(document, /featured/u)
  assert.match(document, /Get featured tools/u)
  assert.match(document, /Add GitHub project/u)
  assert.match(document, /Check for updates/u)
  assert.match(document, /Install all updates/u)
  assert.match(document, /updates-install/u)
  assert.match(document, /Connect later/u)
  assert.equal(document.includes(url.split('/').at(-1)), false)

  const dashboard = await fetch(`${origin}/api/dashboard`, { headers: { cookie } })
  assert.equal(dashboard.status, 200)
  const value = await dashboard.json()
  assert.equal(value.snapshot.configured, false)
  assert.equal(value.usage.configured, false)
  assert.equal(value.preferences.language, 'system')
  assert.equal(value.catalog.featuredProfile, 'featured')
  assert.equal(value.catalog.marketplace, false)
  assert.equal(value.catalog.boundReleaseRequired, true)
  assert.equal(value.catalog.download.configured, false)
  assert.equal(value.catalog.download.notarized, false)
  assert.match(value.catalog.download.message, /Public download is not configured/u)
  assert.equal(value.source.notarized, false)
  assert.equal(value.source.publicReleasePublished, false)
  assert.equal(value.source.status, 'unpublished')
  assert.match(value.source.source.message, /unpublished/u)
  assert.match(document, /Check source/u)
  assert.match(document, /Catalog assets are unpublished/u)

  const checked = await fetch(`${origin}/api/action`, {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'source', check: true }),
  })
  assert.equal(checked.status, 200)
  const checkedBody = await checked.json()
  assert.equal(checkedBody.result.status, 'unpublished')
  assert.equal(checkedBody.result.notarized, false)
  assert.equal(checkedBody.dashboard.source.source.lastCheck.status, 'unpublished')
  assert.match(checkedBody.dashboard.source.source.recovery.message, /local bound catalog/u)

  const sourced = await fetch(`${origin}/api/action`, {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'source', url: 'https://example.invalid/preview-distribution.json' }),
  })
  assert.equal(sourced.status, 200)
  const sourcedBody = await sourced.json()
  assert.equal(sourcedBody.result.status, 'error')
  assert.equal(sourcedBody.dashboard.source.source.lastCheck.code, 'PREVIEW_DOWNLOAD_FAILED')
  assert.equal(sourcedBody.dashboard.source.source.url, 'https://example.invalid/preview-distribution.json')

  const cleared = await fetch(`${origin}/api/action`, {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'source', clear: true }),
  })
  assert.equal(cleared.status, 200)
  assert.equal((await cleared.json()).dashboard.source.source.kind, 'unset')
  assert.equal(value.catalog.profiles.some((profile) => profile.id === 'featured' && profile.agentComponents.includes('armorial')), true)
  assert.equal(MANAGER_SETUP_PROFILES.includes('featured'), true)

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

test('local Manager accepts featured setup and host-later setup without inventing a marketplace', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-web-featured-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  let readyResolve
  const ready = new Promise((resolve) => { readyResolve = resolve })
  const running = startWebManager({ stateRoot, open: false, idleTimeoutMs: 60_000, onReady: readyResolve })
  const { origin, url, server } = await ready
  t.after(() => server.close())
  const auth = await fetch(url, { redirect: 'manual' })
  const cookie = auth.headers.get('set-cookie').split(';')[0]

  const featured = await fetch(`${origin}/api/action`, {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'setup', profile: 'featured' }),
  })
  assert.equal(featured.status, 400)
  const featuredError = await featured.json()
  assert.equal(featuredError.error.code, 'RELEASE_UNBOUND')

  const withHost = await fetch(`${origin}/api/action`, {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'setup', host: 'zcode', profile: 'featured' }),
  })
  assert.equal(withHost.status, 400)
  assert.equal((await withHost.json()).error.code, 'RELEASE_UNBOUND')

  const rejected = await fetch(`${origin}/api/action`, {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'setup', host: 'zcode', profile: 'not-a-catalog' }),
  })
  assert.equal(rejected.status, 400)
  assert.equal((await rejected.json()).error.code, 'MANAGER_REQUEST_INVALID')

  const acquire = await fetch(`${origin}/api/action`, {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'update', profile: 'featured' }),
  })
  assert.equal(acquire.status, 400)
  assert.equal((await acquire.json()).error.code, 'NOT_INSTALLED')

  await new Promise((resolve) => server.close(resolve))
  await running
})

test('browser Overview success handoff is sparse and wires real CTA paths', async () => {
  const page = await readFile(new URL('../src/web-manager.mjs', import.meta.url), 'utf8')
  assert.match(page, /renderPostSetupGuidance/u)
  assert.match(page, /guidance: buildDashboardGuidance/u)
  assert.match(page, /dataset\.testid='post-setup-primary-cta'/u)
  assert.match(page, /navigatePage\('tools'\)/u)
  assert.match(page, /action:'open-app'/u)
  assert.match(page, /action:'tools',resume:true/u)
  assert.match(page, /action:'doctor'/u)
  assert.match(page, /action:'workspace'/u)
  assert.match(page, /action:'pick-workspace'/u)
  assert.match(page, /action.id==='grant-workspace'\)\{\s*call\(\{action:'pick-workspace'/u)
  assert.match(page, /action:'repair'/u)
  assert.doesNotMatch(page, /t\(''\)/u)
  assert.doesNotMatch(page, /'':/u)
  assert.match(page, /--status-action:#f1f2f4/u)
  assert.equal(page.includes('[data-tone=action]{color:var(--status-action)}'), true)
  assert.match(page, /data-page/u)
  assert.match(page, /t\('Details'\)/u)
  // Main-card chrome must not dump teaching sections; keep labels only inside Details wiring.
  const renderFn = page.match(/function renderPostSetupGuidance[\s\S]*?^function renderEnvironment/mu)?.[0] || ''
  assert.match(renderFn, /start-status/u)
  assert.doesNotMatch(renderFn, /What Host confirmed/u)
  assert.doesNotMatch(renderFn, /Still open/u)
  assert.doesNotMatch(renderFn, /Recovery path/u)
  assert.doesNotMatch(renderFn, /Next step/u)
})

test('post-setup primary CTAs perform navigation or API side effects', async (t) => {
  await withFakeHostOnPath(t, 'codex')
  const root = await mkdtemp(join(tmpdir(), 'agent-host-web-cta-ws-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-web-cta-state-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stateRoot, { recursive: true, force: true })]))
  await createDevelopmentWorkspace(root)
  const fake = createCodexRunner({ mathPresent: false, timePresent: false })
  const installed = await setup(
    { profile: 'standard', hosts: ['codex'], developmentRoot: root, stateRoot, noService: true, dryRun: false, enableObservability: false },
    {
      runner: fake.runner,
      codexConfiguration: fake.configuration,
      hostSkillHome: join(stateRoot, 'host-home'),
      catalogPreflight: healthyCatalogPreflight,
      applicationStatePreflight: compatibleApplicationState,
    },
  )
  assert.equal(installed.status, 'installed')

  let readyResolve
  const ready = new Promise((resolve) => { readyResolve = resolve })
  const running = startWebManager({ stateRoot, open: false, idleTimeoutMs: 60_000, onReady: readyResolve })
  const { origin, url, server } = await ready
  t.after(() => server.close())
  const auth = await fetch(url, { redirect: 'manual' })
  const cookie = auth.headers.get('set-cookie').split(';')[0]

  const dashboard = await fetch(`${origin}/api/dashboard`, { headers: { cookie } })
  assert.equal(dashboard.status, 200)
  const body = await dashboard.json()
  assert.equal(body.guidance?.statusLine, 'Ready')
  assert.equal(body.guidance?.primaryAction?.id, 'open-app')
  assert.match(body.guidance?.primaryAction?.label || '', /^Open /u)
  assert.equal(body.guidance?.hint, 'Start a new task in the app')

  const openAttempt = await fetch(`${origin}/api/action`, {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'open-app', host: 'codex' }),
  })
  assert.ok([200, 400].includes(openAttempt.status), `open-app status ${openAttempt.status}`)
  const openBody = await openAttempt.json()
  if (openAttempt.status === 200) {
    assert.equal(openBody.result.status, 'opened')
    assert.equal(openBody.result.host, 'codex')
    assert.equal(['gui', 'terminal'].includes(openBody.result.method), true, 'open-app must launch a GUI or visible terminal')
  } else {
    assert.ok(
      ['MANAGER_REQUEST_INVALID', 'AGENT_APP_OPEN_UNAVAILABLE'].includes(openBody.error?.code),
      `unexpected open-app error ${openBody.error?.code}`,
    )
    if (openBody.error?.code === 'AGENT_APP_OPEN_UNAVAILABLE') {
      assert.match(openBody.error.details?.nextStep || openBody.error.message, /Open a terminal and run/u)
    }
  }

  const doctor = await fetch(`${origin}/api/action`, {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'doctor' }),
  })
  assert.ok([200, 400].includes(doctor.status), `doctor status ${doctor.status}`)

  // Behavioral: click open-tools CTA must activate data-page="tools" (not notice-only).
  const source = await readFile(new URL('../src/web-manager.mjs', import.meta.url), 'utf8')
  const script = [...source.matchAll(/<script>([\s\S]*?)<\/script>/gui)].map((m) => m[1]).join('\n')
  const fnMatch = script.match(/function navigatePage\(page\)\{[\s\S]*?\}\nfunction renderPostSetupGuidance\(root, guidance\)\{[\s\S]*?\n\}/u)
  assert.ok(fnMatch, 'expected navigatePage + renderPostSetupGuidance in page script')
  const clicks = []
  const fetches = []
  const buttons = []
  const pages = { current: 'environment' }
  const documentRef = {
    querySelector(sel) {
      if (sel === '#nav button[data-page="tools"]') {
        return { click() { clicks.push('tools'); pages.current = 'tools' } }
      }
      if (sel === '#agent-apps') return { scrollIntoView() { clicks.push('agent-apps') } }
      return null
    },
    createElement(tag) {
      const node = {
        tagName: tag,
        className: '',
        textContent: '',
        dataset: {},
        children: [],
        append(...args) { this.children.push(...args) },
        click() { this.onclick?.() },
      }
      Object.defineProperty(node, 'onclick', {
        configurable: true,
        get() { return this._onclick },
        set(fn) { this._onclick = fn; if (typeof fn === 'function') buttons.push(node) },
      })
      return node
    },
  }
  const harness = new Function('document', 'fetch', 't', 'call', 'setPage', 'notice', 'data', `
    const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n};
    const button=(label,run,cls='action')=>{const b=el('button',label,cls);b.onclick=run;return b};
    const $= (s)=>document.querySelector(s);
    ${fnMatch[0]}
    return { navigatePage, renderPostSetupGuidance };
  `)
  const api = harness(
    documentRef,
    async (path, init) => { fetches.push({ path, body: init?.body }); return { ok: true, async json() { return { status: 'ok', result: {}, dashboard: body } } } },
    (key) => key,
    (action) => { fetches.push({ path: '/api/action', body: JSON.stringify(action) }) },
    (page) => { pages.current = page; clicks.push('setPage:' + page) },
    () => { clicks.push('notice') },
    body,
  )
  const handoffRoot = documentRef.createElement('div')
  buttons.length = 0
  api.renderPostSetupGuidance(handoffRoot, {
    statusLine: 'No tools selected',
    statusTone: 'action',
    readyToWork: false,
    primaryAction: { id: 'open-tools', label: 'Tools' },
    observed: [],
    gaps: [],
  })
  const toolsCta = buttons.find((b) => b.dataset.testid === 'post-setup-primary-cta')
  assert.ok(toolsCta, 'tools CTA must render')
  toolsCta.click()
  assert.equal(pages.current, 'tools')
  assert.equal(clicks.includes('notice'), false)

  buttons.length = 0
  fetches.length = 0
  const handoffRoot2 = documentRef.createElement('div')
  api.renderPostSetupGuidance(handoffRoot2, {
    statusLine: 'Ready',
    statusTone: 'ready',
    readyToWork: true,
    primaryAction: { id: 'open-app', label: 'Open Codex' },
    primaryHostId: 'codex',
    hint: 'Start a new task in the app',
    observed: [],
    gaps: [],
  })
  const openCta = buttons.find((b) => b.dataset.testid === 'post-setup-primary-cta')
  assert.ok(openCta, 'open CTA must render')
  openCta.click()
  assert.ok(fetches.some((f) => String(f.body).includes('"open-app"') && String(f.body).includes('codex')), 'Open CTA must invoke open-app action')

  await new Promise((resolve) => server.close(resolve))
  await running
})

test('paused guidance CTA resumes tools through /api/action', async (t) => {
  await withFakeHostOnPath(t, 'codex')
  const root = await mkdtemp(join(tmpdir(), 'agent-host-web-pause-ws-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-web-pause-state-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stateRoot, { recursive: true, force: true })]))
  await createDevelopmentWorkspace(root)
  const fake = createCodexRunner({ mathPresent: false, timePresent: false })
  await setup(
    { profile: 'standard', hosts: ['codex'], developmentRoot: root, stateRoot, noService: true, dryRun: false, enableObservability: false },
    {
      runner: fake.runner,
      codexConfiguration: fake.configuration,
      hostSkillHome: join(stateRoot, 'host-home'),
      catalogPreflight: healthyCatalogPreflight,
      applicationStatePreflight: compatibleApplicationState,
    },
  )
  // Commit a deliberate pause into saved state (same shape setActiveTools writes).
  const paths = await prepareStatePaths(stateRoot)
  const state = await loadState(paths)
  state.resumeAgentComponents = [...(state.agentComponents ?? state.availableAgentComponents)]
  state.agentComponents = []
  state.agentToolsPaused = true
  await saveState(paths, state)

  let readyResolve
  const ready = new Promise((resolve) => { readyResolve = resolve })
  const running = startWebManager({ stateRoot, open: false, idleTimeoutMs: 60_000, onReady: readyResolve })
  const { origin, url, server } = await ready
  t.after(() => server.close())
  const auth = await fetch(url, { redirect: 'manual' })
  const cookie = auth.headers.get('set-cookie').split(';')[0]
  const dashboard = await fetch(`${origin}/api/dashboard`, { headers: { cookie } })
  assert.equal(dashboard.status, 200)
  const body = await dashboard.json()
  assert.equal(body.guidance?.problemClass, 'tools-paused')
  assert.equal(body.guidance?.statusLine, 'Tools paused')
  assert.equal(body.guidance?.primaryAction?.id, 'resume-tools')
  assert.equal(body.guidance?.primaryAction?.label, 'Resume')

  // Behavioral: Resume CTA must POST tools resume (not notice-only).
  const source = await readFile(new URL('../src/web-manager.mjs', import.meta.url), 'utf8')
  const script = [...source.matchAll(/<script>([\s\S]*?)<\/script>/gui)].map((m) => m[1]).join('\n')
  const fnMatch = script.match(/function navigatePage\(page\)\{[\s\S]*?\}\nfunction renderPostSetupGuidance\(root, guidance\)\{[\s\S]*?\n\}/u)
  assert.ok(fnMatch)
  const fetches = []
  const buttons = []
  const documentRef = {
    querySelector() { return null },
    createElement(tag) {
      const node = {
        tagName: tag, className: '', textContent: '', dataset: {}, children: [],
        append(...args) { this.children.push(...args) },
        click() { this.onclick?.() },
      }
      Object.defineProperty(node, 'onclick', {
        configurable: true,
        get() { return this._onclick },
        set(fn) { this._onclick = fn; if (typeof fn === 'function') buttons.push(node) },
      })
      return node
    },
  }
  const harness = new Function('document', 'fetch', 't', 'call', 'setPage', 'notice', 'data', `
    const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n};
    const button=(label,run,cls='action')=>{const b=el('button',label,cls);b.onclick=run;return b};
    const $= (s)=>document.querySelector(s);
    ${fnMatch[0]}
    return { renderPostSetupGuidance };
  `)
  const api = harness(documentRef, async () => ({ ok: true, async json() { return {} } }), (k) => k, (action) => { fetches.push(action) }, () => {}, () => {}, body)
  const handoff = documentRef.createElement('div')
  api.renderPostSetupGuidance(handoff, body.guidance)
  const cta = buttons.find((b) => b.dataset.testid === 'post-setup-primary-cta')
  assert.ok(cta)
  cta.click()
  assert.deepEqual(fetches[0], { action: 'tools', resume: true })

  await new Promise((resolve) => server.close(resolve))
  await running
})

test('dashboard guidance consumes missing host apps and unique connect targets', () => {
  const snapshot = {
    configured: true,
    environment: {
      hosts: { zcode: { version: '1' } },
      availableAgentComponents: ['math-anchor'],
      agentComponents: ['math-anchor'],
      workspaceGranted: false,
    },
  }
  const tools = { paused: false, availableAgentComponents: ['math-anchor'], activeAgentComponents: ['math-anchor'] }
  const missing = buildDashboardGuidance(snapshot, tools, [
    { host: 'zcode', appInstalled: false },
    { host: 'codex', appInstalled: true },
    { host: 'claude', appInstalled: false },
  ])
  assert.equal(missing.readyToWork, false)
  assert.equal(missing.problemClass, 'app-missing')
  assert.equal(missing.primaryAction.id, 'connect-agent')
  assert.equal(missing.connectHostId, 'codex')
  assert.equal(missing.primaryAction.label, 'Connect Codex')

  const many = buildDashboardGuidance({
    configured: true,
    environment: { hosts: {}, availableAgentComponents: ['math-anchor'], agentComponents: ['math-anchor'] },
  }, tools, [
    { host: 'zcode', appInstalled: true },
    { host: 'codex', appInstalled: true },
    { host: 'claude', appInstalled: false },
  ])
  assert.equal(many.problemClass, 'not-connected')
  assert.equal(many.primaryAction.label, 'Connect')
  assert.equal(many.connectHostId, null)

  const stale = buildDashboardGuidance({
    configured: true,
    environment: {
      hosts: { codex: { version: '1' } },
      availableAgentComponents: ['math-anchor'],
      agentComponents: ['math-anchor'],
    },
  }, tools, [
    { host: 'codex', appInstalled: true },
    { host: 'zcode', appInstalled: false },
    { host: 'claude', appInstalled: false },
  ], { checks: [{ id: 'component.math-anchor', status: 'error', message: 'missing' }] }, { doctorFreshness: 'stale' })
  assert.equal(stale.readyToWork, false)
  assert.equal(stale.problemClass, 'unverified')
  assert.equal(stale.primaryAction.id, 'run-full-check')
  assert.notEqual(stale.blockingCode, 'component.math-anchor')
})

test('repair and update invalidate a cached doctor; preview does not', () => {
  assert.equal(environmentActionInvalidatesDoctor({ action: 'repair' }), true)
  assert.equal(environmentActionInvalidatesDoctor({ action: 'update' }), true)
  assert.equal(environmentActionInvalidatesDoctor({ action: 'workspace' }), true)
  assert.equal(environmentActionInvalidatesDoctor({ action: 'github' }), true)
  assert.equal(environmentActionInvalidatesDoctor({ action: 'github', preview: true }), false)
  assert.equal(environmentActionInvalidatesDoctor({ action: 'doctor' }), false)
  assert.equal(environmentActionInvalidatesDoctor({ action: 'open-app' }), false)
})

test('Chinese tools and history pages drop empty translation keys and catalog essays', async () => {
  const page = await readFile(new URL('../src/web-manager.mjs', import.meta.url), 'utf8')
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/gui)].map((match) => match[1])
  const source = scripts.join('\n')
  assert.doesNotMatch(source, /t\(''\)/u)
  const zhMatch = source.match(/const zh=\{[\s\S]*?\n\};/u)
  assert.ok(zhMatch, 'expected zh dictionary')
  const zh = new Function(`${zhMatch[0]}; return zh`)()
  assert.equal(Object.hasOwn(zh, ''), false)
  const values = Object.values(zh).join('\n')
  assert.equal(values.includes('tools set --profile'), false)
  assert.equal(values.includes('AGENT_HOST_FEATURED_CATALOG_URL'), false)
  assert.equal(zh['Public download is not configured.'], '尚未配置公开下载。')
  assert.equal(zh['Choose folder'], '选择文件夹')
  assert.equal(zh['Enter path'], '输入路径')
  assert.equal(zh['Open Agent Host on this computer to choose a folder.'], '请在本机打开 Agent Host 以选择文件夹。')
})

test('connect CTA does not silently pick the first of multiple apps', async () => {
  const page = await readFile(new URL('../src/web-manager.mjs', import.meta.url), 'utf8')
  const script = [...page.matchAll(/<script>([\s\S]*?)<\/script>/gui)].map((m) => m[1]).join('\n')
  const fnMatch = script.match(/function navigatePage\(page\)\{[\s\S]*?\}\nfunction renderPostSetupGuidance\(root, guidance\)\{[\s\S]*?\n\}/u)
  assert.ok(fnMatch)
  const fetches = []
  const clicks = []
  const buttons = []
  const documentRef = {
    querySelector(sel) {
      if (sel === '#agent-apps') return { scrollIntoView() { clicks.push('agent-apps') } }
      return null
    },
    createElement(tag) {
      const node = {
        tagName: tag, className: '', textContent: '', dataset: {}, children: [],
        append(...args) { this.children.push(...args) },
        click() { this.onclick?.() },
      }
      Object.defineProperty(node, 'onclick', {
        configurable: true,
        get() { return this._onclick },
        set(fn) { this._onclick = fn; if (typeof fn === 'function') buttons.push(node) },
      })
      return node
    },
  }
  const harness = new Function('document', 'fetch', 't', 'call', 'setPage', 'notice', 'data', `
    const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n};
    const button=(label,run,cls='action')=>{const b=el('button',label,cls);b.onclick=run;return b};
    const $= (s)=>document.querySelector(s);
    ${fnMatch[0]}
    return { renderPostSetupGuidance };
  `)
  const api = harness(
    documentRef,
    async () => ({ ok: true, async json() { return {} } }),
    (key) => key,
    (action) => { fetches.push(action) },
    (pageName) => { clicks.push('setPage:' + pageName) },
    () => { clicks.push('notice') },
    {
      snapshot: { environment: { hosts: {} } },
      hosts: [
        { host: 'zcode', appInstalled: true },
        { host: 'codex', appInstalled: true },
      ],
    },
  )
  const root = documentRef.createElement('div')
  api.renderPostSetupGuidance(root, {
    statusLine: 'Connect Agent to use',
    statusTone: 'action',
    primaryAction: { id: 'connect-agent', label: 'Connect' },
    connectHostId: null,
    observed: [],
    gaps: [],
  })
  buttons.find((b) => b.dataset.testid === 'post-setup-primary-cta').click()
  assert.equal(fetches.length, 0)
  assert.equal(clicks.includes('agent-apps') || clicks.some((item) => String(item).startsWith('setPage:')), true)

  buttons.length = 0
  fetches.length = 0
  const uniqueRoot = documentRef.createElement('div')
  api.renderPostSetupGuidance(uniqueRoot, {
    statusLine: 'Connect Agent to use',
    statusTone: 'action',
    primaryAction: { id: 'connect-agent', label: 'Connect Codex', hostId: 'codex' },
    connectHostId: 'codex',
    observed: [],
    gaps: [],
  })
  buttons.find((b) => b.dataset.testid === 'post-setup-primary-cta').click()
  assert.deepEqual(fetches[0], { action: 'host', host: 'codex', connected: true })
})

test('grant-workspace CTA picks a folder instead of repeating doctor or teaching a path', async () => {
  const page = await readFile(new URL('../src/web-manager.mjs', import.meta.url), 'utf8')
  const script = [...page.matchAll(/<script>([\s\S]*?)<\/script>/gui)].map((m) => m[1]).join('\n')
  const fnMatch = script.match(/function navigatePage\(page\)\{[\s\S]*?\}\nfunction renderPostSetupGuidance\(root, guidance\)\{[\s\S]*?\n\}/u)
  assert.ok(fnMatch)
  const fetches = []
  const buttons = []
  const documentRef = {
    querySelector() { return null },
    createElement(tag) {
      const node = {
        tagName: tag, className: '', textContent: '', dataset: {}, children: [], value: '',
        append(...args) { this.children.push(...args) },
        click() { this.onclick?.() },
        setAttribute() {},
        focus() {},
      }
      Object.defineProperty(node, 'onclick', {
        configurable: true,
        get() { return this._onclick },
        set(fn) { this._onclick = fn; if (typeof fn === 'function') buttons.push(node) },
      })
      return node
    },
  }
  const harness = new Function('document', 'fetch', 't', 'call', 'setPage', 'notice', 'data', `
    const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n};
    const button=(label,run,cls='action')=>{const b=el('button',label,cls);b.onclick=run;return b};
    const $= (s)=>document.querySelector(s);
    ${fnMatch[0]}
    return { renderPostSetupGuidance };
  `)
  const api = harness(documentRef, async () => ({ ok: true, async json() { return {} } }), (k) => k, (action) => { fetches.push(action) }, () => {}, () => {}, { snapshot: { environment: { hosts: {} } }, hosts: [] })
  const root = documentRef.createElement('div')
  api.renderPostSetupGuidance(root, {
    statusLine: 'Need a project folder',
    statusTone: 'fault',
    primaryAction: { id: 'grant-workspace', label: 'Choose folder' },
    blockingCode: 'user.permissions',
    blockingMessage: 'EACCES: access denied to project folder',
    observed: [],
    gaps: [],
  })
  function findTestId(node, id) {
    if (node?.dataset?.testid === id) return node
    for (const child of node?.children || []) {
      const found = findTestId(child, id)
      if (found) return found
    }
    return null
  }
  buttons.find((b) => b.dataset.testid === 'post-setup-primary-cta').click()
  assert.equal(fetches.some((item) => item.action === 'doctor'), false)
  assert.deepEqual(fetches[0], { action: 'pick-workspace' })
  const card = root.children[0]
  assert.equal((card?.children || []).some((node) => node.dataset?.testid === 'grant-folder'), false)
  const advanced = findTestId(root, 'grant-folder-advanced')
  assert.ok(advanced, 'typed path stays an advanced fallback')
  const box = findTestId(root, 'grant-folder')
  const input = (box?.children || []).find((node) => node.tagName === 'input')
  const grant = buttons.find((b) => b.textContent === 'Grant folder')
  assert.ok(input && grant, 'advanced fallback still grants an explicit path')
  input.value = '/tmp/project'
  grant.click()
  assert.deepEqual(fetches[1], { action: 'workspace', path: '/tmp/project' })
})

test('workspace action grants an accessible project folder', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-web-grant-ws-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-web-grant-state-'))
  const folder = await mkdtemp(join(tmpdir(), 'agent-host-web-grant-folder-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stateRoot, { recursive: true, force: true }), rm(folder, { recursive: true, force: true })]))
  await createDevelopmentWorkspace(root)
  const fake = createCodexRunner({ mathPresent: false, timePresent: false })
  const installed = await setup(
    { profile: 'standard', hosts: [], noHost: true, developmentRoot: root, stateRoot, noService: true, dryRun: false, enableObservability: false },
    {
      runner: fake.runner,
      catalogPreflight: healthyCatalogPreflight,
      applicationStatePreflight: compatibleApplicationState,
    },
  )
  assert.equal(installed.status, 'installed')
  let readyResolve
  const ready = new Promise((resolve) => { readyResolve = resolve })
  const running = startWebManager({ stateRoot, open: false, idleTimeoutMs: 60_000, onReady: readyResolve })
  const { origin, url, server } = await ready
  t.after(() => server.close())
  const auth = await fetch(url, { redirect: 'manual' })
  const cookie = auth.headers.get('set-cookie').split(';')[0]
  const granted = await fetch(`${origin}/api/action`, {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'workspace', path: folder }),
  })
  assert.equal(granted.status, 200)
  const body = await granted.json()
  const grantedFolder = await realpath(folder)
  assert.equal(body.result.status, 'workspace-granted')
  assert.equal(body.result.workspaceRoot, grantedFolder)
  assert.match(body.result.nextStep, /new Agent task/u)
  const paths = await prepareStatePaths(stateRoot)
  const state = await loadState(paths)
  assert.equal(state.workspaceRoot, grantedFolder)
  await new Promise((resolve) => server.close(resolve))
  await running
})

test('repair after a doctor fault does not keep the stale blocking check', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-web-stale-doc-ws-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-web-stale-doc-state-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stateRoot, { recursive: true, force: true })]))
  await createDevelopmentWorkspace(root)
  const fake = createCodexRunner({ mathPresent: false, timePresent: false })
  const installed = await setup(
    { profile: 'standard', hosts: [], noHost: true, developmentRoot: root, stateRoot, noService: true, dryRun: false, enableObservability: false },
    {
      runner: fake.runner,
      catalogPreflight: healthyCatalogPreflight,
      applicationStatePreflight: compatibleApplicationState,
    },
  )
  assert.equal(installed.status, 'installed')
  const paths = await prepareStatePaths(stateRoot)
  const before = await loadState(paths)
  const identity = before.components['math-anchor']?.identityFiles?.[0]
  assert.equal(typeof identity, 'string')
  const original = await readFile(identity)
  await rm(identity)

  let readyResolve
  const ready = new Promise((resolve) => { readyResolve = resolve })
  const running = startWebManager({ stateRoot, open: false, idleTimeoutMs: 60_000, onReady: readyResolve })
  const { origin, url, server } = await ready
  t.after(() => server.close())
  const auth = await fetch(url, { redirect: 'manual' })
  const cookie = auth.headers.get('set-cookie').split(';')[0]
  const headers = { cookie, origin, 'content-type': 'application/json' }

  const diagnosed = await fetch(`${origin}/api/action`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action: 'doctor' }),
  })
  assert.equal(diagnosed.status, 200)
  const diagnosedBody = await diagnosed.json()
  const mathFault = (diagnosedBody.result?.checks || []).find((item) => item.id === 'component.math-anchor')
  assert.equal(mathFault?.status, 'error')
  assert.equal(diagnosedBody.dashboard.doctorFreshness, 'fresh')
  assert.equal(diagnosedBody.dashboard.guidance.blockingCode, 'component.math-anchor')

  const cached = await fetch(`${origin}/api/dashboard`, { headers: { cookie } })
  assert.equal(cached.status, 200)
  assert.equal((await cached.json()).guidance.blockingCode, 'component.math-anchor')

  await writeFile(identity, original)
  const repaired = await fetch(`${origin}/api/action`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action: 'repair' }),
  })
  assert.equal(repaired.status, 200)
  const repairedBody = await repaired.json()
  assert.equal(repairedBody.result.status, 'repaired')
  const repairedMath = (repairedBody.dashboard?.doctor?.checks || []).find((item) => item.id === 'component.math-anchor')
  assert.equal(repairedMath?.status, 'ok')
  assert.notEqual(repairedBody.dashboard.guidance.blockingCode, 'component.math-anchor')
  assert.equal(repairedBody.dashboard.doctorFreshness, 'fresh')

  const afterRepair = await fetch(`${origin}/api/dashboard`, { headers: { cookie } })
  assert.equal(afterRepair.status, 200)
  const afterBody = await afterRepair.json()
  const afterMath = (afterBody.doctor?.checks || []).find((item) => item.id === 'component.math-anchor')
  assert.equal(afterMath?.status, 'ok')
  assert.notEqual(afterBody.guidance.blockingCode, 'component.math-anchor')

  const redose = await fetch(`${origin}/api/action`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action: 'doctor' }),
  })
  assert.equal(redose.status, 200)
  const redoseMath = ((await redose.json()).result?.checks || []).find((item) => item.id === 'component.math-anchor')
  assert.equal(redoseMath?.status, 'ok')

  await new Promise((resolve) => server.close(resolve))
  await running
})

test('pick-workspace uses a real folder picker, cancel and inaccessible keep the previous grant', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-web-pick-ws-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-web-pick-state-'))
  const folder = await mkdtemp(join(tmpdir(), 'agent-host-web-pick-folder-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stateRoot, { recursive: true, force: true }), rm(folder, { recursive: true, force: true })]))
  await createDevelopmentWorkspace(root)
  const fake = createCodexRunner({ mathPresent: false, timePresent: false })
  const installed = await setup(
    { profile: 'standard', hosts: [], noHost: true, developmentRoot: root, stateRoot, noService: true, dryRun: false, enableObservability: false },
    {
      runner: fake.runner,
      catalogPreflight: healthyCatalogPreflight,
      applicationStatePreflight: compatibleApplicationState,
    },
  )
  assert.equal(installed.status, 'installed')
  const picks = [
    { status: 'picked', path: folder },
    { status: 'cancelled' },
    { status: 'picked', path: join(folder, 'missing-agent-host-folder') },
  ]
  let readyResolve
  const ready = new Promise((resolve) => { readyResolve = resolve })
  const running = startWebManager({
    stateRoot,
    open: false,
    idleTimeoutMs: 60_000,
    onReady: readyResolve,
    pickDirectory: async () => {
      const next = picks.shift()
      if (next === undefined) {
        throw new AgentHostError('DIRECTORY_PICKER_UNAVAILABLE', 'Open Agent Host on this computer to choose a folder.')
      }
      return next
    },
  })
  const { origin, url, server } = await ready
  t.after(() => server.close())
  const auth = await fetch(url, { redirect: 'manual' })
  const cookie = auth.headers.get('set-cookie').split(';')[0]
  const headers = { cookie, origin, 'content-type': 'application/json' }

  const granted = await fetch(`${origin}/api/action`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action: 'pick-workspace' }),
  })
  assert.equal(granted.status, 200)
  const grantedBody = await granted.json()
  const grantedFolder = await realpath(folder)
  assert.equal(grantedBody.result.status, 'workspace-granted')
  assert.equal(grantedBody.result.workspaceRoot, grantedFolder)
  assert.equal((await loadState(await prepareStatePaths(stateRoot))).workspaceRoot, grantedFolder)

  const cancelled = await fetch(`${origin}/api/action`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action: 'pick-workspace' }),
  })
  assert.equal(cancelled.status, 200)
  assert.equal((await cancelled.json()).result.status, 'cancelled')
  assert.equal((await loadState(await prepareStatePaths(stateRoot))).workspaceRoot, grantedFolder)

  const inaccessible = await fetch(`${origin}/api/action`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action: 'pick-workspace' }),
  })
  assert.equal(inaccessible.status, 400)
  assert.equal((await inaccessible.json()).error.code, 'WORKSPACE_ROOT_INVALID')
  assert.equal((await loadState(await prepareStatePaths(stateRoot))).workspaceRoot, grantedFolder)

  const unavailable = await fetch(`${origin}/api/action`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action: 'pick-workspace' }),
  })
  assert.equal(unavailable.status, 400)
  assert.equal((await unavailable.json()).error.code, 'DIRECTORY_PICKER_UNAVAILABLE')
  assert.equal((await loadState(await prepareStatePaths(stateRoot))).workspaceRoot, grantedFolder)

  const continued = await fetch(`${origin}/api/dashboard`, { headers: { cookie } })
  assert.equal(continued.status, 200)
  assert.equal((await continued.json()).snapshot.environment.workspaceGranted, true)

  const page = await readFile(new URL('../src/web-manager.mjs', import.meta.url), 'utf8')
  assert.match(page, /revealGrantPathFallback/u)
  assert.match(page, /DIRECTORY_PICKER_UNAVAILABLE/u)

  await new Promise((resolve) => server.close(resolve))
  await running
})

test('open-app uses the GUI/terminal opener and reports a next step when no window exists', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-web-open-ws-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-web-open-state-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stateRoot, { recursive: true, force: true })]))
  await createDevelopmentWorkspace(root)
  const fake = createCodexRunner({ mathPresent: false, timePresent: false })
  await setup(
    { profile: 'standard', hosts: ['codex'], developmentRoot: root, stateRoot, noService: true, dryRun: false, enableObservability: false },
    {
      runner: fake.runner,
      codexConfiguration: fake.configuration,
      hostSkillHome: join(stateRoot, 'host-home'),
      catalogPreflight: healthyCatalogPreflight,
      applicationStatePreflight: compatibleApplicationState,
    },
  )
  let readyResolve
  const ready = new Promise((resolve) => { readyResolve = resolve })
  const running = startWebManager({
    stateRoot,
    open: false,
    idleTimeoutMs: 60_000,
    onReady: readyResolve,
    openAgentApp: async (host) => ({ status: 'opened', host, method: 'gui', launched: '/Applications/Codex.app' }),
  })
  const { origin, url, server } = await ready
  t.after(() => server.close())
  const auth = await fetch(url, { redirect: 'manual' })
  const cookie = auth.headers.get('set-cookie').split(';')[0]
  const opened = await fetch(`${origin}/api/action`, {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'open-app', host: 'codex' }),
  })
  assert.equal(opened.status, 200)
  const openedBody = await opened.json()
  assert.equal(openedBody.result.method, 'gui')
  assert.equal(openedBody.result.launched, '/Applications/Codex.app')
  await new Promise((resolve) => server.close(resolve))
  await running
})

test('embedded Manager browser scripts parse without SyntaxError', async () => {
  const page = await readFile(new URL('../src/web-manager.mjs', import.meta.url), 'utf8')
  // 大小写不敏感：CodeQL js/bad-tag-filter 要求 script 标签匹配覆盖 <SCRIPT> 等变体。
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/gui)].map((match) => match[1])
  assert.ok(scripts.length >= 1, 'expected at least one embedded <script> in managerDocument')
  for (const [index, source] of scripts.entries()) {
    try {
      // Parse only: constructing Function validates syntax without executing browser DOM code.
      new Function(source)
    } catch (error) {
      assert.fail(`embedded <script> #${index + 1} failed to parse: ${error.message}`)
    }
  }
})
