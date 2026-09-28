import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pickDirectory as pickLocalDirectory } from '../../../src/directory-picker.mjs'
import { packageProject } from './packager.mjs'
import { StudioProject, publicProjectError } from './project.mjs'
import { StudioRuntime } from './runtime.mjs'
import { studioError } from './validation.mjs'
import { absoluteDirectoryPath, createStudioProjectFromTemplate, listStudioTemplates, projectDisplayName, readRecentProjects, recordRecentProject, suggestedProjectDirectory } from './home.mjs'

const moduleRoot = dirname(fileURLToPath(import.meta.url))
const webRoot = resolve(moduleRoot, '../web-dist')
const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

async function body(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 2 * 1024 * 1024) throw studioError('STUDIO_BODY_LIMIT', 'Request exceeds 2 MiB')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw studioError('STUDIO_INVALID_JSON', 'Request body must contain JSON')
  }
}

function sameToken(left, right) {
  return typeof left === 'string' && left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right))
}

function headers(res) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

async function staticResponse(res, pathname, token) {
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\//u, '')
  const normalized = normalize(requested)
  const path = resolve(webRoot, normalized)
  const relation = relative(webRoot, path)
  if (relation === '..' || relation.startsWith(`..${sep}`)) return false
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) {
    if (extname(pathname)) return false
    return staticResponse(res, '/', token)
  }
  let bytes = await readFile(path)
  if (requested === 'index.html') bytes = Buffer.from(bytes.toString('utf8').replace('__PROCEDURE_STUDIO_TOKEN__', token))
  res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' })
  res.end(bytes)
  return true
}

export async function serveStudio({ project, stateRoot, port = 0, directoryPicker = pickLocalDirectory } = {}) {
  const token = randomBytes(32).toString('base64url')
  let session = null
  let turn = Promise.resolve()
  const exclusive = (operation) => {
    const result = turn.then(operation, operation)
    turn = result.then(() => undefined, () => undefined)
    return result
  }
  const openSession = async (opened) => {
    if (session !== null && session.projectRoot === opened.root) {
      await recordRecentProject(stateRoot, opened.root, projectDisplayName(session.project))
      return session
    }
    const runtime = await StudioRuntime.open(join(opened.stateRoot, 'runs'), opened)
    const previous = session
    session = { project: opened, runtime, projectRoot: opened.root }
    try {
      await recordRecentProject(stateRoot, opened.root, projectDisplayName(opened))
    } catch (error) {
      session = previous
      await runtime.close().catch(() => {})
      throw error
    }
    if (previous !== null) await previous.runtime.close().catch(() => {})
    return session
  }
  if (project !== undefined) await openSession(project)
  const activeHome = async () => {
    const recents = await readRecentProjects(stateRoot)
    const templates = await listStudioTemplates()
    const projects = await Promise.all(recents.entries.map(async (entry) => ({
      ...entry,
      exists: await stat(entry.path).then((info) => info.isDirectory()).catch(() => false),
    })))
    return {
      schemaVersion: 'openadam.procedure-studio-home.v0.1',
      templates,
      projects,
      active: session === null ? null : { projectRoot: session.projectRoot, displayName: projectDisplayName(session.project) },
    }
  }
  const requireSession = () => {
    if (session === null) throw studioError('STUDIO_PROJECT_NOT_OPEN', 'No Procedure Studio project is open; create one from a template or open a recent project first')
    return session
  }
  let origin = null
  const server = createServer(async (req, res) => {
    headers(res)
    try {
      if (req.headers.host !== new URL(origin).host) throw studioError('STUDIO_INVALID_ORIGIN', 'Unexpected Host header')
      const url = new URL(req.url, origin)
      if (url.pathname.startsWith('/api/')) {
        await exclusive(async () => {
        if (!sameToken(req.headers['x-procedure-studio-token'], token)) throw studioError('STUDIO_UNAUTHORIZED', 'A valid private Studio token is required')
        if (req.headers.origin && req.headers.origin !== origin) throw studioError('STUDIO_INVALID_ORIGIN', 'Cross-origin control requests are refused')
        if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) {
          throw studioError('STUDIO_INVALID_ORIGIN', 'Cross-site control requests are refused')
        }
        if (!['GET', 'HEAD'].includes(req.method) && !req.headers['content-type']?.startsWith('application/json')) {
          throw studioError('STUDIO_INVALID_CONTENT_TYPE', 'JSON content type is required')
        }
        if (req.method === 'GET' && url.pathname === '/api/home') {
          json(res, 200, await activeHome())
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/home/pick-directory') {
          const input = await body(req)
          if (!['create', 'open'].includes(input.purpose)) {
            throw studioError('STUDIO_DIRECTORY_PURPOSE_INVALID', 'Folder selection must be for creating or opening a project')
          }
          let picked
          try {
            picked = await directoryPicker()
          } catch (error) {
            if (error?.code === 'DIRECTORY_PICKER_UNAVAILABLE') {
              throw studioError(
                'STUDIO_DIRECTORY_PICKER_UNAVAILABLE',
                'Procedure Studio could not open the system folder picker. Try again from this computer\'s desktop session.',
              )
            }
            throw error
          }
          if (picked?.status !== 'picked') {
            json(res, 200, { status: 'cancelled' })
            return
          }
          const path = absoluteDirectoryPath(picked.path)
          if (path === null) throw studioError('STUDIO_PROJECT_PATH_INVALID', 'The selected folder did not resolve to one absolute directory path')
          json(res, 200, { status: 'picked', path })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/home/open') {
          const input = await body(req)
          const projectPath = absoluteDirectoryPath(input.path)
          if (projectPath === null) {
            throw studioError('STUDIO_PROJECT_PATH_INVALID', 'Project path must be one absolute directory path')
          }
          const opened = await StudioProject.open(projectPath, stateRoot)
          const next = await openSession(opened)
          json(res, 200, { home: await activeHome(), state: next.project.publicState(), runs: next.runtime.list() })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/home/create') {
          const input = await body(req)
          const directory = input.directory ?? suggestedProjectDirectory(input.parentDirectory, input.name)
          const created = await createStudioProjectFromTemplate({ ...input, directory })
          const opened = await StudioProject.open(created.projectRoot, stateRoot)
          const next = await openSession(opened)
          json(res, 201, { home: await activeHome(), state: next.project.publicState(), runs: next.runtime.list() })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/home/close') {
          const previous = session
          if (previous !== null) {
            await recordRecentProject(stateRoot, previous.projectRoot, projectDisplayName(previous.project))
            session = null
            await previous.runtime.close()
          }
          json(res, 200, await activeHome())
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/project') {
          const current = requireSession()
          json(res, 200, { state: current.project.publicState(), runs: current.runtime.list() })
          return
        }
        if (req.method === 'PATCH' && url.pathname === '/api/project') {
          const input = await body(req)
          const current = requireSession()
          json(res, 200, { state: await current.project.update(input), runs: current.runtime.list() })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/project/save') {
          const input = await body(req)
          const current = requireSession()
          json(res, 200, { state: await current.project.save(input.expectedRevision), runs: current.runtime.list() })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/project/reload') {
          const input = await body(req)
          const current = requireSession()
          json(res, 200, { state: await current.project.reload(input.expectedRevision), runs: current.runtime.list() })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/project/reconcile') {
          const input = await body(req)
          const current = requireSession()
          json(res, 200, { state: await current.project.reconcile(input.expectedRevision), runs: current.runtime.list() })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/proposal') {
          const input = await body(req)
          const current = requireSession()
          json(res, 200, { state: await current.project.loadProposal(input.expectedRevision, input.candidate), runs: current.runtime.list() })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/proposal/decision') {
          const input = await body(req)
          const current = requireSession()
          json(res, 200, { state: await current.project.decideProposal(input.expectedRevision, input), runs: current.runtime.list() })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/project/scenario') {
          const input = await body(req)
          const current = requireSession()
          json(res, 201, { state: await current.project.saveScenario(input.expectedRevision, input), runs: current.runtime.list() })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/project/scenarios/reload') {
          const input = await body(req)
          const current = requireSession()
          json(res, 200, { state: await current.project.reloadScenarios(input.expectedRevision), runs: current.runtime.list() })
          return
        }
        const scenarioMatch = url.pathname.match(/^\/api\/project\/scenario\/([a-z][a-z0-9_.-]{0,79})$/u)
        if (scenarioMatch && req.method === 'PUT') {
          const input = await body(req)
          const current = requireSession()
          json(res, 200, { state: await current.project.updateScenario(input.expectedRevision, scenarioMatch[1], input.candidate), runs: current.runtime.list() })
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/runs') {
          const current = requireSession()
          json(res, 200, { runs: current.runtime.list() })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/runs') {
          const input = await body(req)
          const current = requireSession()
          json(res, 201, { run: await current.runtime.start(input.scenarioId), runs: current.runtime.list() })
          return
        }
        const runMatch = url.pathname.match(/^\/api\/runs\/([a-f0-9-]{36})(?:\/(action|replay))?$/u)
        if (runMatch && req.method === 'GET' && !runMatch[2]) {
          const current = requireSession()
          json(res, 200, { run: current.runtime.get(runMatch[1]) })
          return
        }
        if (runMatch && req.method === 'POST' && runMatch[2] === 'action') {
          const current = requireSession()
          json(res, 200, { run: current.runtime.action(runMatch[1], await body(req)), runs: current.runtime.list() })
          return
        }
        if (runMatch && req.method === 'POST' && runMatch[2] === 'replay') {
          const input = await body(req)
          const current = requireSession()
          json(res, 201, { run: await current.runtime.replay(runMatch[1], input.nodeId), runs: current.runtime.list() })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/package') {
          const input = await body(req)
          const current = requireSession()
          current.project.assertRevision(input.expectedRevision)
          if (!current.project.publicState().source.saved) await current.project.save(input.expectedRevision)
          json(res, 201, { package: await packageProject(current.project), state: current.project.publicState(), runs: current.runtime.list() })
          return
        }
        throw studioError('STUDIO_NOT_FOUND', 'Route not found')
        })
        return
      }
      if (!['GET', 'HEAD'].includes(req.method) || !(await staticResponse(res, url.pathname, token))) {
        throw studioError('STUDIO_NOT_FOUND', 'Route not found')
      }
    } catch (error) {
      const status = error.code === 'STUDIO_UNAUTHORIZED' ? 401 : error.code === 'STUDIO_NOT_FOUND' ? 404 : error.code === 'STUDIO_REVISION_CONFLICT' || error.code === 'STUDIO_SOURCE_CONFLICT' ? 409 : 400
      json(res, status, publicProjectError(error))
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  const address = server.address()
  origin = `http://127.0.0.1:${address.port}`
  return {
    origin,
    url: `${origin}/?token=${encodeURIComponent(token)}`,
    token,
    close: async () => {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      await exclusive(async () => {
        const current = session
        session = null
        if (current !== null) await current.runtime.close()
      })
    },
  }
}
