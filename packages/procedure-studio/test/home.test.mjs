import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createStudioProjectFromTemplate, listStudioTemplates, projectDisplayName, readRecentProjects, recordRecentProject } from '../src/home.mjs'
import { packageProject } from '../src/packager.mjs'
import { StudioProject } from '../src/project.mjs'
import { StudioRuntime } from '../src/runtime.mjs'
import { serveStudio } from '../src/server.mjs'

const templatesUrl = new URL('../templates/', import.meta.url)
const exampleUrl = new URL('../examples/research-brief/', import.meta.url)

test('every bundled template scaffolds into a valid, packageable Procedure project', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'procedure-studio-templates-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const templates = await listStudioTemplates()
  assert.deepEqual(templates.map((item) => item.id), [
    'blank', 'capability-orchestration', 'git-dev-review', 'human-decision-recovery', 'research-verify',
  ])
  for (const template of templates) {
    const created = await createStudioProjectFromTemplate({
      templateId: template.id,
      name: 'Release Notes Digest',
      directory: join(root, template.id),
    })
    const project = await StudioProject.open(created.projectRoot, join(root, 'state'))
    assert.equal(project.validation.valid, true, `${template.id} must validate`)
    const state = project.publicState()
    assert.equal(state.project.componentId, 'release-notes-digest-procedure')
    assert.equal(state.document.integration.procedure.id, 'org.openadam.studio.release-notes-digest')
    assert.equal(state.document.integration.displayName, 'Release Notes Digest')
    assert.equal(state.scenarios.length, 1)
    assert.equal(await readFile(join(created.projectRoot, 'template.json'), 'utf8').then(() => 'present', (error) => error.code), 'ENOENT')
    const packaged = await packageProject(project)
    assert.equal(packaged.preview.health.status, 'ok', `${template.id} must package`)
    assert.equal(packaged.preview.component.procedureId, 'org.openadam.studio.release-notes-digest')
  }
})

test('template scaffolding refuses unknown templates, weak names, and occupied directories', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'procedure-studio-template-guards-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await assert.rejects(
    createStudioProjectFromTemplate({ templateId: 'unknown', name: 'Valid Name', directory: join(root, 'a') }),
    (error) => error.code === 'STUDIO_TEMPLATE_NOT_FOUND',
  )
  await assert.rejects(
    createStudioProjectFromTemplate({ templateId: 'blank', name: 'x', directory: join(root, 'b') }),
    (error) => error.code === 'STUDIO_PROJECT_NAME_INVALID',
  )
  await assert.rejects(
    createStudioProjectFromTemplate({ templateId: 'blank', name: 'Valid Name', directory: 'relative/path' }),
    (error) => error.code === 'STUDIO_PROJECT_DIRECTORY_INVALID',
  )
  const occupied = join(root, 'occupied')
  await cp(templatesUrl, occupied, { recursive: true })
  await assert.rejects(
    createStudioProjectFromTemplate({ templateId: 'blank', name: 'Valid Name', directory: occupied }),
    (error) => error.code === 'STUDIO_PROJECT_DIRECTORY_INVALID',
  )
  assert.equal(await createStudioProjectFromTemplate({ templateId: 'blank', name: '1st Number', directory: join(root, 'c') }).then(() => 'ok', (error) => error.code), 'STUDIO_PROJECT_NAME_INVALID')
  const chinese = await createStudioProjectFromTemplate({ templateId: 'blank', name: '发布说明', directory: join(root, 'd') }).then(() => null, (error) => error)
  assert.equal(chinese.code, 'STUDIO_PROJECT_NAME_INVALID')
  assert.match(chinese.message, /Latin letter/u)

  const kept = join(root, 'notes.txt')
  await writeFile(kept, 'keep-me')
  await assert.rejects(
    createStudioProjectFromTemplate({ templateId: 'blank', name: 'Valid Name', directory: kept }),
    (error) => error.code === 'STUDIO_PROJECT_DIRECTORY_INVALID',
  )
  assert.equal(await readFile(kept, 'utf8'), 'keep-me')

  const linkedTarget = join(root, 'linked-target')
  await writeFile(linkedTarget, 'keep-me')
  const link = join(root, 'linked-project')
  await symlink(linkedTarget, link)
  await assert.rejects(
    createStudioProjectFromTemplate({ templateId: 'blank', name: 'Valid Name', directory: link }),
    (error) => error.code === 'STUDIO_PROJECT_DIRECTORY_INVALID',
  )
  assert.equal(await readFile(linkedTarget, 'utf8'), 'keep-me')
  assert.equal((await lstat(link)).isSymbolicLink(), true)

  const weird = join(root, 'my..notes')
  const dotted = await createStudioProjectFromTemplate({ templateId: 'blank', name: 'Dot Dot', directory: weird })
  assert.equal(dotted.projectRoot, await realpath(weird))
  const viaParent = `${root}/missing/../normalized-target`
  const normalized = await createStudioProjectFromTemplate({ templateId: 'blank', name: 'Normalized Path', directory: viaParent })
  assert.equal(normalized.projectRoot, await realpath(join(root, 'normalized-target')))

  const empty = join(root, 'empty-locked')
  await mkdir(empty, { mode: 0o500 })
  try {
    await assert.rejects(
      createStudioProjectFromTemplate({ templateId: 'blank', name: 'Valid Name', directory: empty }),
      (error) => error.code !== undefined,
    )
    assert.deepEqual(await readdir(empty), [])
  } finally {
    await chmod(empty, 0o700)
  }
})

test('recent projects are recorded, deduplicated, and capped', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'procedure-studio-recents-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = await recordRecentProject(root, '/tmp/alpha', 'Alpha')
  assert.equal(first.entries.length, 1)
  await recordRecentProject(root, '/tmp/beta', 'Beta')
  const again = await recordRecentProject(root, '/tmp/alpha', 'Alpha Two')
  assert.deepEqual(again.entries.map((item) => item.path), ['/tmp/alpha', '/tmp/beta'])
  assert.equal(again.entries[0].name, 'Alpha Two')
  let latest = again
  for (let index = 0; index < 25; index += 1) {
    latest = await recordRecentProject(root, `/tmp/entry-${index}`, `Entry ${index}`)
  }
  assert.equal(latest.entries.length, 20)
  assert.equal((await readRecentProjects(root)).schemaVersion, 'openadam.procedure-studio-projects.v0.1')
  await writeFile(join(root, 'projects.json'), `${JSON.stringify({
    schemaVersion: 'openadam.procedure-studio-projects.v0.1',
    entries: [
      { path: '/tmp/ok', name: 'Ok', lastOpenedAt: '2000-01-01T00:00:00.000Z' },
      { path: 'relative/path', name: 'Relative' },
      { nope: true },
      { path: '/tmp/nameless' },
    ],
  })}\n`)
  const repaired = await readRecentProjects(root)
  assert.deepEqual(repaired.entries.map((item) => [item.path, item.name]), [
    ['/tmp/ok', 'Ok'],
    ['/tmp/nameless', 'nameless'],
  ])
  assert.equal(projectDisplayName({
    root: '/tmp/demo',
    publicState: () => ({ document: { integration: { displayName: '  ', procedure: { id: 'org.openadam.studio.demo' } } } }),
  }), 'org.openadam.studio.demo')
})

test('the home server creates, opens, and switches Procedure projects behind its private token', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'procedure-studio-home-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const exampleRoot = join(root, 'research-brief')
  await cp(exampleUrl, exampleRoot, { recursive: true })
  const stateRoot = join(root, 'studio-state')
  const studio = await serveStudio({ stateRoot, port: 0 })
  try {
    const headers = { 'x-procedure-studio-token': studio.token, 'content-type': 'application/json' }
    const unauthorized = await fetch(`${studio.origin}/api/home`)
    assert.equal(unauthorized.status, 401)

    const initial = await (await fetch(`${studio.origin}/api/home`, { headers })).json()
    assert.equal(initial.active, null)
    assert.equal(initial.projects.length, 0)
    assert.deepEqual(initial.templates.map((item) => item.id), [
      'blank', 'capability-orchestration', 'git-dev-review', 'human-decision-recovery', 'research-verify',
    ])

    const notOpen = await (await fetch(`${studio.origin}/api/project`, { headers })).json()
    assert.equal(notOpen.error.code, 'STUDIO_PROJECT_NOT_OPEN')

    const created = await fetch(`${studio.origin}/api/home/create`, {
      method: 'POST', headers,
      body: JSON.stringify({ templateId: 'research-verify', name: 'Home Research', directory: join(root, 'home-research') }),
    })
    assert.equal(created.status, 201)
    const createdValue = await created.json()
    assert.equal(createdValue.state.validation.valid, true)
    assert.equal(createdValue.state.document.integration.displayName, 'Home Research')
    assert.equal(createdValue.home.active.displayName, 'Home Research')

    const opened = await fetch(`${studio.origin}/api/home/open`, {
      method: 'POST', headers,
      body: JSON.stringify({ path: exampleRoot }),
    })
    assert.equal(opened.status, 200)
    const openedValue = await opened.json()
    assert.equal(openedValue.state.document.integration.displayName, 'Research Brief')
    assert.equal(openedValue.home.active.displayName, 'Research Brief')

    const home = await (await fetch(`${studio.origin}/api/home`, { headers })).json()
    assert.deepEqual(home.projects.map((item) => item.name), ['Research Brief', 'Home Research'])
    assert.equal(home.projects.every((item) => item.exists === true), true)

    const state = await (await fetch(`${studio.origin}/api/project`, { headers })).json()
    assert.equal(state.state.document.integration.displayName, 'Research Brief')

    const missing = await fetch(`${studio.origin}/api/home/open`, {
      method: 'POST', headers,
      body: JSON.stringify({ path: join(root, 'missing-project') }),
    })
    assert.equal(missing.status, 400)
    assert.equal((await missing.json()).error.code, 'STUDIO_PROJECT_UNAVAILABLE')

    const badCreate = await fetch(`${studio.origin}/api/home/create`, {
      method: 'POST', headers,
      body: JSON.stringify({ templateId: 'blank', name: 'Valid Name', directory: exampleRoot }),
    })
    assert.equal((await badCreate.json()).error.code, 'STUDIO_PROJECT_DIRECTORY_INVALID')

    const closed = await (await fetch(`${studio.origin}/api/home/close`, { method: 'POST', headers, body: '{}' })).json()
    assert.equal(closed.active, null)
    assert.equal(closed.projects.length, 2)
    const afterClose = await (await fetch(`${studio.origin}/api/project`, { headers })).json()
    assert.equal(afterClose.error.code, 'STUDIO_PROJECT_NOT_OPEN')
  } finally {
    await studio.close()
  }
})

async function liveCoordinatorLocks(root) {
  const found = []
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name === 'coordinator.lock') {
        const owner = JSON.parse(await readFile(path, 'utf8'))
        if (owner.pid === process.pid) found.push(path)
      }
    }
  }
  await walk(root)
  return found
}

async function settledRun(runtime, runId) {
  const deadline = Date.now() + 8000
  let latest = null
  while (Date.now() < deadline) {
    latest = runtime.get(runId)
    if (['complete', 'failed', 'cancelled'].includes(latest.status)) return latest
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Test Run stayed ${latest?.status ?? 'missing'}: ${JSON.stringify(latest?.problem ?? null)}`)
}

test('project sessions keep Test Runs apart and a failed switch leaves the current project open', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'procedure-studio-session-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateRoot = join(root, 'studio-state')
  const alpha = await createStudioProjectFromTemplate({
    templateId: 'blank',
    name: 'Alpha Run',
    directory: join(root, 'alpha'),
  })
  const beta = await createStudioProjectFromTemplate({
    templateId: 'blank',
    name: 'Beta Run',
    directory: join(root, 'beta'),
  })
  const alphaProject = await StudioProject.open(alpha.projectRoot, stateRoot)
  const runtime = await StudioRuntime.open(join(alphaProject.stateRoot, 'runs'), alphaProject, {
    adapterFactory: (binding) => ({
      async initialize() { return { steer: 'unsupported', interrupt: 'supported' } },
      async session(existing) { return { provider: binding.provider, id: existing ?? randomUUID(), model: 'fixture-only' } },
      async start() {
        return {
          status: 'complete',
          text: JSON.stringify({
            outcome: 'complete',
            summary: 'Completed the bounded Studio fixture step',
            plan: 'Return declared outputs',
            findings: [],
            checks: [],
            resolvedFindingIds: [],
            acknowledgedDecisionIds: [],
            outputs: { result: 'alpha-result' },
          }),
        }
      },
      async interrupt() {},
      async close() {},
    }),
  })
  const started = await runtime.start('default')
  const completed = await settledRun(runtime, started.id)
  assert.equal(completed.status, 'complete')
  assert.equal(completed.outputs.result.value, 'alpha-result')
  await runtime.close()

  const studio = await serveStudio({ stateRoot, port: 0 })
  try {
    const headers = { 'x-procedure-studio-token': studio.token, 'content-type': 'application/json' }
    const openedAlpha = await fetch(`${studio.origin}/api/home/open`, {
      method: 'POST', headers, body: JSON.stringify({ path: alpha.projectRoot }),
    })
    assert.equal(openedAlpha.status, 200)
    const alphaValue = await openedAlpha.json()
    assert.equal(alphaValue.runs.some((item) => item.id === started.id), true)

    const betaProject = await StudioProject.open(beta.projectRoot, stateRoot)
    const digest = betaProject.publicState().documentDigest.replace(/^sha256:/u, '')
    const lockDirectory = join(betaProject.stateRoot, 'runs', digest)
    await mkdir(lockDirectory, { recursive: true })
    await writeFile(join(lockDirectory, 'coordinator.lock'), JSON.stringify({ pid: process.pid, owner: 'held' }))
    const blocked = await fetch(`${studio.origin}/api/home/open`, {
      method: 'POST', headers, body: JSON.stringify({ path: beta.projectRoot }),
    })
    assert.equal(blocked.status, 400)
    assert.equal((await blocked.json()).error.code, 'STORE_LOCKED')
    const stillAlpha = await (await fetch(`${studio.origin}/api/project`, { headers })).json()
    assert.equal(stillAlpha.state.document.integration.displayName, 'Alpha Run')
    assert.equal(stillAlpha.runs.some((item) => item.id === started.id), true)
    const reopenedAlpha = await fetch(`${studio.origin}/api/home/open`, {
      method: 'POST', headers, body: JSON.stringify({ path: alpha.projectRoot }),
    })
    assert.equal(reopenedAlpha.status, 200)
    assert.equal((await reopenedAlpha.json()).runs.some((item) => item.id === started.id), true)
    await rm(lockDirectory, { recursive: true, force: true })

    const openedBeta = await fetch(`${studio.origin}/api/home/open`, {
      method: 'POST', headers, body: JSON.stringify({ path: `${root}/missing/../beta` }),
    })
    assert.equal(openedBeta.status, 200)
    const betaValue = await openedBeta.json()
    assert.equal(betaValue.state.document.integration.displayName, 'Beta Run')
    assert.equal(betaValue.runs.some((item) => item.id === started.id), false)
    assert.equal(await stat(join(stateRoot, 'runs')).then(() => 'present', (error) => error.code), 'ENOENT')

    const alias = join(root, 'alpha-alias')
    await symlink(alpha.projectRoot, alias)
    const [first, second] = await Promise.all([
      fetch(`${studio.origin}/api/home/open`, { method: 'POST', headers, body: JSON.stringify({ path: alias }) }),
      fetch(`${studio.origin}/api/home/open`, { method: 'POST', headers, body: JSON.stringify({ path: beta.projectRoot }) }),
    ])
    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    const home = await (await fetch(`${studio.origin}/api/home`, { headers })).json()
    assert.deepEqual(home.projects.map((item) => item.path).sort(), [alphaProject.root, betaProject.root].sort())
    assert.equal((await liveCoordinatorLocks(stateRoot)).length, 1)
    const current = await (await fetch(`${studio.origin}/api/project`, { headers })).json()
    if (current.state.document.integration.displayName === 'Alpha Run') {
      assert.equal(current.runs.some((item) => item.id === started.id), true)
    } else {
      assert.equal(current.runs.some((item) => item.id === started.id), false)
    }
  } finally {
    await studio.close()
  }
})
