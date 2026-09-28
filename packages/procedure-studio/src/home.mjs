import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { studioError } from './validation.mjs'

const moduleRoot = dirname(fileURLToPath(import.meta.url))
const templatesRoot = resolve(moduleRoot, '../templates')
const recentSchema = 'openadam.procedure-studio-projects.v0.1'
const templateSchema = 'openadam.procedure-studio-template.v0.1'

export async function listStudioTemplates() {
  const templates = []
  for (const entry of await readdir(templatesRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue
    const template = JSON.parse(await readFile(join(templatesRoot, entry.name, 'template.json'), 'utf8'))
    if (template.schemaVersion !== templateSchema) {
      throw studioError('STUDIO_TEMPLATE_INVALID', `Unsupported Studio template schema: ${template.schemaVersion ?? 'missing'}`)
    }
    templates.push({ id: template.id, name: template.name, summary: template.summary })
  }
  return templates.sort((left, right) => left.id.localeCompare(right.id))
}

async function atomicJson(path, value) {
  const { rename } = await import('node:fs/promises')
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

export async function readRecentProjects(stateRoot) {
  try {
    const value = JSON.parse(await readFile(join(stateRoot, 'projects.json'), 'utf8'))
    if (value.schemaVersion !== recentSchema || !Array.isArray(value.entries)) {
      throw new Error('invalid')
    }
    return value
  } catch {
    return { schemaVersion: recentSchema, entries: [] }
  }
}

export async function recordRecentProject(stateRoot, projectRoot, displayName) {
  const current = await readRecentProjects(stateRoot)
  const entry = { path: resolve(projectRoot), name: displayName, lastOpenedAt: new Date().toISOString() }
  const entries = [entry, ...current.entries.filter((item) => item.path !== entry.path)].slice(0, 20)
  await mkdir(stateRoot, { recursive: true, mode: 0o700 })
  await atomicJson(join(stateRoot, 'projects.json'), { schemaVersion: recentSchema, entries })
  return { schemaVersion: recentSchema, entries }
}

function projectSlug(name) {
  const slug = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 48)
  if (!/^[a-z]/u.test(slug)) throw studioError('STUDIO_PROJECT_NAME_INVALID', 'Project name must begin with a letter')
  if (slug.length < 2) throw studioError('STUDIO_PROJECT_NAME_INVALID', 'Project name is too short to derive a Procedure identity')
  return slug
}

export async function createStudioProjectFromTemplate({ templateId, name, directory } = {}) {
  if (typeof templateId !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(templateId)) {
    throw studioError('STUDIO_TEMPLATE_NOT_FOUND', 'Choose one Studio template')
  }
  if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 80) {
    throw studioError('STUDIO_PROJECT_NAME_INVALID', 'Project name must contain 2–80 characters')
  }
  if (typeof directory !== 'string' || !directory.startsWith('/') || directory.includes('..')) {
    throw studioError('STUDIO_PROJECT_DIRECTORY_INVALID', 'Project directory must be one absolute path')
  }
  const templateRoot = join(templatesRoot, templateId)
  const templateInfo = await stat(templateRoot).then((info) => info.isDirectory() ? info : null).catch(() => null)
  if (templateInfo === null) throw studioError('STUDIO_TEMPLATE_NOT_FOUND', `Studio template was not found: ${templateId}`)
  const projectRoot = resolve(directory)
  const existing = await readdir(projectRoot).catch(() => null)
  if (existing !== null && existing.length > 0) {
    throw studioError('STUDIO_PROJECT_DIRECTORY_INVALID', 'Project directory must be new or empty')
  }
  const displayName = name.trim()
  const slug = projectSlug(displayName)
  await mkdir(projectRoot, { recursive: true, mode: 0o700 })
  try {
    await cp(templateRoot, projectRoot, { recursive: true })
    const studioProject = JSON.parse(await readFile(join(projectRoot, 'studio.project.json'), 'utf8'))
    studioProject.componentId = `${slug}-procedure`
    await writeFile(join(projectRoot, 'studio.project.json'), `${JSON.stringify(studioProject, null, 2)}\n`, { mode: 0o600 })
    const integration = JSON.parse(await readFile(join(projectRoot, 'procedure.integration.json'), 'utf8'))
    integration.displayName = displayName
    integration.procedure.id = `org.openadam.studio.${slug}`
    await writeFile(join(projectRoot, 'procedure.integration.json'), `${JSON.stringify(integration, null, 2)}\n`, { mode: 0o600 })
    const method = JSON.parse(await readFile(join(projectRoot, 'method.json'), 'utf8'))
    method.name = displayName
    await writeFile(join(projectRoot, 'method.json'), `${JSON.stringify(method, null, 2)}\n`, { mode: 0o600 })
    return { projectRoot, displayName }
  } catch (error) {
    await rm(projectRoot, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}
