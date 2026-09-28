import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
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

function recentEntry(item) {
  if (item === null || typeof item !== 'object' || typeof item.path !== 'string' || !isAbsolute(item.path)) return null
  const name = typeof item.name === 'string' && item.name.trim().length > 0 ? item.name.trim() : basename(item.path)
  const lastOpenedAt = typeof item.lastOpenedAt === 'string' && item.lastOpenedAt.length > 0 ? item.lastOpenedAt : new Date(0).toISOString()
  return { path: item.path, name, lastOpenedAt }
}

export async function readRecentProjects(stateRoot) {
  try {
    const value = JSON.parse(await readFile(join(stateRoot, 'projects.json'), 'utf8'))
    if (value.schemaVersion !== recentSchema || !Array.isArray(value.entries)) {
      throw new Error('invalid')
    }
    return { schemaVersion: recentSchema, entries: value.entries.flatMap((item) => {
      const entry = recentEntry(item)
      return entry === null ? [] : [entry]
    }) }
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

export function projectDisplayName(project) {
  const integration = project.publicState().document.integration
  const name = typeof integration?.displayName === 'string' ? integration.displayName.trim() : ''
  if (name.length > 0) return name
  const procedureId = typeof integration?.procedure?.id === 'string' ? integration.procedure.id.trim() : ''
  if (procedureId.length > 0) return procedureId
  return basename(project.root)
}

function projectSlug(name) {
  const slug = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 48)
  if (!/^[a-z][a-z0-9-]{1,}$/u.test(slug)) {
    throw studioError('STUDIO_PROJECT_NAME_INVALID', 'Project name must include a Latin letter so Studio can derive a Procedure id')
  }
  return slug
}

export function absoluteDirectoryPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !isAbsolute(value)) return null
  return resolve(value)
}

async function discardScaffold(target, created) {
  if (created) {
    await rm(target, { recursive: true, force: true }).catch(() => {})
    return
  }
  const entries = await readdir(target).catch(() => [])
  await Promise.all(entries.map((name) => rm(join(target, name), { recursive: true, force: true }).catch(() => {})))
}

export async function createStudioProjectFromTemplate({ templateId, name, directory } = {}) {
  if (typeof templateId !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(templateId)) {
    throw studioError('STUDIO_TEMPLATE_NOT_FOUND', 'Choose one Studio template')
  }
  if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 80) {
    throw studioError('STUDIO_PROJECT_NAME_INVALID', 'Project name must contain 2–80 characters')
  }
  const displayName = name.trim()
  const slug = projectSlug(displayName)
  const requested = absoluteDirectoryPath(directory)
  if (requested === null) {
    throw studioError('STUDIO_PROJECT_DIRECTORY_INVALID', 'Project directory must be one absolute path')
  }
  const templateRoot = join(templatesRoot, templateId)
  const templateInfo = await stat(templateRoot).then((info) => info.isDirectory() ? info : null).catch(() => null)
  if (templateInfo === null) throw studioError('STUDIO_TEMPLATE_NOT_FOUND', `Studio template was not found: ${templateId}`)
  const parent = dirname(requested)
  const leaf = basename(requested)
  if (leaf.length === 0 || leaf === '.' || leaf === '..') {
    throw studioError('STUDIO_PROJECT_DIRECTORY_INVALID', 'Project directory must be one absolute path')
  }
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const target = join(await realpath(parent), leaf)
  if (target === dirname(target)) {
    throw studioError('STUDIO_PROJECT_DIRECTORY_INVALID', 'Project directory must be one absolute path')
  }
  const existing = await lstat(target).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existing?.isSymbolicLink()) {
    throw studioError('STUDIO_PROJECT_DIRECTORY_INVALID', 'Project directory must be a real directory, not a link')
  }
  if (existing !== null && !existing.isDirectory()) {
    throw studioError('STUDIO_PROJECT_DIRECTORY_INVALID', 'Project directory must be new or empty')
  }
  if (existing?.isDirectory()) {
    const entries = await readdir(target)
    if (entries.length > 0) throw studioError('STUDIO_PROJECT_DIRECTORY_INVALID', 'Project directory must be new or empty')
  }
  let created = false
  const replaceEmptyDirectory = existing?.isDirectory() === true
  try {
    if (existing === null) {
      await mkdir(target, { mode: 0o700 })
      created = true
    }
    await cp(templateRoot, target, {
      recursive: true,
      filter: (source) => basename(source) !== 'template.json',
    })
    const studioProject = JSON.parse(await readFile(join(target, 'studio.project.json'), 'utf8'))
    studioProject.componentId = `${slug}-procedure`
    await writeFile(join(target, 'studio.project.json'), `${JSON.stringify(studioProject, null, 2)}\n`, { mode: 0o600 })
    const integration = JSON.parse(await readFile(join(target, 'procedure.integration.json'), 'utf8'))
    integration.displayName = displayName
    integration.procedure.id = `org.openadam.studio.${slug}`
    await writeFile(join(target, 'procedure.integration.json'), `${JSON.stringify(integration, null, 2)}\n`, { mode: 0o600 })
    const method = JSON.parse(await readFile(join(target, 'method.json'), 'utf8'))
    method.name = displayName
    await writeFile(join(target, 'method.json'), `${JSON.stringify(method, null, 2)}\n`, { mode: 0o600 })
    return { projectRoot: target, displayName }
  } catch (error) {
    if (created || replaceEmptyDirectory) await discardScaffold(target, created)
    throw error
  }
}
