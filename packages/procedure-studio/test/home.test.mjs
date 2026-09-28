import assert from 'node:assert/strict'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createStudioProjectFromTemplate, listStudioTemplates, readRecentProjects, recordRecentProject } from '../src/home.mjs'
import { packageProject } from '../src/packager.mjs'
import { StudioProject } from '../src/project.mjs'
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
