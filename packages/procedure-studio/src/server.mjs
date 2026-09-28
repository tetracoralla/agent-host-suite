import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packageProject } from './packager.mjs'
import { publicProjectError } from './project.mjs'
import { StudioRuntime } from './runtime.mjs'
import { studioError } from './validation.mjs'

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

export async function serveStudio({ project, stateRoot, port = 0 } = {}) {
  const token = randomBytes(32).toString('base64url')
  const runtime = await StudioRuntime.open(join(stateRoot, 'runs'), project)
  let origin = null
  const server = createServer(async (req, res) => {
    headers(res)
    try {
      if (req.headers.host !== new URL(origin).host) throw studioError('STUDIO_INVALID_ORIGIN', 'Unexpected Host header')
      const url = new URL(req.url, origin)
      if (url.pathname.startsWith('/api/')) {
        if (!sameToken(req.headers['x-procedure-studio-token'], token)) throw studioError('STUDIO_UNAUTHORIZED', 'A valid private Studio token is required')
        if (req.headers.origin && req.headers.origin !== origin) throw studioError('STUDIO_INVALID_ORIGIN', 'Cross-origin control requests are refused')
        if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) {
          throw studioError('STUDIO_INVALID_ORIGIN', 'Cross-site control requests are refused')
        }
        if (!['GET', 'HEAD'].includes(req.method) && !req.headers['content-type']?.startsWith('application/json')) {
          throw studioError('STUDIO_INVALID_CONTENT_TYPE', 'JSON content type is required')
        }
        if (req.method === 'GET' && url.pathname === '/api/project') {
          json(res, 200, { state: project.publicState(), runs: runtime.list() })
          return
        }
        if (req.method === 'PATCH' && url.pathname === '/api/project') {
          const input = await body(req)
          json(res, 200, { state: await project.update(input), runs: runtime.list() })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/project/save') {
          const input = await body(req)
          json(res, 200, { state: await project.save(input.expectedRevision), runs: runtime.list() })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/project/reload') {
          const input = await body(req)
          json(res, 200, { state: await project.reload(input.expectedRevision), runs: runtime.list() })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/project/reconcile') {
          const input = await body(req)
          json(res, 200, { state: await project.reconcile(input.expectedRevision), runs: runtime.list() })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/proposal') {
          const input = await body(req)
          json(res, 200, { state: await project.loadProposal(input.expectedRevision, input.candidate), runs: runtime.list() })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/proposal/decision') {
          const input = await body(req)
          json(res, 200, { state: await project.decideProposal(input.expectedRevision, input), runs: runtime.list() })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/project/scenario') {
          const input = await body(req)
          json(res, 201, { state: await project.saveScenario(input.expectedRevision, input), runs: runtime.list() })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/project/scenarios/reload') {
          const input = await body(req)
          json(res, 200, { state: await project.reloadScenarios(input.expectedRevision), runs: runtime.list() })
          return
        }
        const scenarioMatch = url.pathname.match(/^\/api\/project\/scenario\/([a-z][a-z0-9_.-]{0,79})$/u)
        if (scenarioMatch && req.method === 'PUT') {
          const input = await body(req)
          json(res, 200, { state: await project.updateScenario(input.expectedRevision, scenarioMatch[1], input.candidate), runs: runtime.list() })
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/runs') {
          json(res, 200, { runs: runtime.list() })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/runs') {
          const input = await body(req)
          json(res, 201, { run: await runtime.start(input.scenarioId), runs: runtime.list() })
          return
        }
        const runMatch = url.pathname.match(/^\/api\/runs\/([a-f0-9-]{36})(?:\/(action|replay))?$/u)
        if (runMatch && req.method === 'GET' && !runMatch[2]) {
          json(res, 200, { run: runtime.get(runMatch[1]) })
          return
        }
        if (runMatch && req.method === 'POST' && runMatch[2] === 'action') {
          json(res, 200, { run: runtime.action(runMatch[1], await body(req)), runs: runtime.list() })
          return
        }
        if (runMatch && req.method === 'POST' && runMatch[2] === 'replay') {
          const input = await body(req)
          json(res, 201, { run: await runtime.replay(runMatch[1], input.nodeId), runs: runtime.list() })
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/package') {
          const input = await body(req)
          project.assertRevision(input.expectedRevision)
          if (!project.publicState().source.saved) await project.save(input.expectedRevision)
          json(res, 201, { package: await packageProject(project), state: project.publicState(), runs: runtime.list() })
          return
        }
        throw studioError('STUDIO_NOT_FOUND', 'Route not found')
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
      await runtime.close()
    },
  }
}
