import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { Coordinator } from './coordinator.mjs'
import { probeProviders } from './adapters.mjs'
import { assert, errorValue } from './value.mjs'
import { declaredTaskOutputs, procedureDescription, procedureSummary, validateProcedureOutputs } from './product.mjs'
import { runRequestTaskId, validateRunRequest } from './run-request.mjs'

async function body(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    assert(size <= 512000, 'BODY_LIMIT', 'Request exceeds 512 KiB')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    assert(false, 'INVALID_JSON', 'Request must contain JSON')
  }
}
export async function serve({
  root,
  port = 0,
  coordinator = new Coordinator(root),
} = {}) {
  const token = randomBytes(32).toString('base64url')
  let origin
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    )
    const json = (status, value) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
      })
      res.end(JSON.stringify(value))
    }
    try {
      assert(
        req.headers.host === new URL(origin).host,
        'INVALID_ORIGIN',
        'Unexpected Host header',
      )
      const url = new URL(req.url, origin)
      const provided = req.headers.authorization?.replace(/^Bearer /, '') ?? ''
      assert(
        provided.length === token.length &&
          timingSafeEqual(Buffer.from(provided), Buffer.from(token)),
        'UNAUTHORIZED',
        'A valid private Bearer token is required',
      )
      assert(
        !req.headers.origin || req.headers.origin === origin,
        'INVALID_ORIGIN',
        'Cross-origin control requests are refused',
      )
      assert(
        !req.headers['sec-fetch-site'] ||
          ['same-origin', 'none'].includes(req.headers['sec-fetch-site']),
        'INVALID_ORIGIN',
        'Cross-site requests are refused',
      )
      if (req.method === 'GET' && url.pathname === '/api/tasks') {
        json(200, { tasks: coordinator.list() })
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/procedures') {
        json(200, {
          procedures: coordinator.procedureList().map(procedureSummary),
        })
        return
      }
      const procedureMatch = url.pathname.match(/^\/api\/procedures\/([^/]+)\/([^/]+)$/u)
      if (req.method === 'GET' && procedureMatch) {
        json(200, {
          procedure: procedureDescription(
            coordinator.procedure(
              decodeURIComponent(procedureMatch[1]),
              decodeURIComponent(procedureMatch[2]),
            ),
          ),
        })
        return
      }
      if (req.method === 'POST')
        assert(
          req.headers['content-type']?.startsWith('application/json'),
          'INVALID_CONTENT_TYPE',
          'JSON content type required',
        )
      if (req.method === 'POST' && url.pathname === '/api/tasks') {
        const requestBody = await body(req)
        const procedureRef = requestBody.procedure
        const procedure = coordinator.procedure(
          procedureRef.id,
          procedureRef.version,
        )
        const request = validateRunRequest(requestBody, procedure)
        const task = coordinator.create({
          taskId: runRequestTaskId(request),
          procedureRef: request.procedure,
          inputs: request.inputs,
          grants: request.grants,
          resources: request.resources,
          limits: request.limits,
          idempotencyKey: request.idempotencyKey,
        })
        if (task.status === 'ready' && task.nodeExecutions === 0)
          coordinator.command(task.id, {
            requestId: `start-${task.id}`,
            expectedRevision: 0,
            action: 'start',
          })
        json(201, coordinator.get(task.id))
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/probe') {
        const input = await body(req)
        assert(
          typeof input.workspace === 'string',
          'INVALID_INPUT',
          'Workspace is required',
        )
        json(200, { providers: await probeProviders(input.workspace) })
        return
      }
      const match = url.pathname.match(
        /^\/api\/tasks\/([a-f0-9-]{36})(?:\/(events|command|handoff|artifact|output))?$/,
      )
      assert(match, 'NOT_FOUND', 'Route not found')
      const task = coordinator.get(match[1])
      if (req.method === 'GET' && !match[2]) {
        json(200, task)
        return
      }
      if (req.method === 'GET' && match[2] === 'events') {
        const after = Number(url.searchParams.get('after') ?? 0)
        assert(
          Number.isSafeInteger(after) && after >= 0,
          'INVALID_INPUT',
          'Invalid event cursor',
        )
        json(200, {
          events: coordinator.store.events(task.id, after),
          retention: coordinator.store.retention(task.id),
        })
        return
      }
      if (req.method === 'GET' && match[2] === 'handoff') {
        json(200, coordinator.export(task.id))
        return
      }
      if (req.method === 'GET' && match[2] === 'output') {
        assert(
          task.status === 'complete',
          'INVALID_STATE',
          'Procedure Run is not complete',
        )
        const reference = task.procedureRef
        assert(
          reference && typeof reference.version === 'string',
          'INVALID_STATE',
          'Run has no installed Procedure identity',
        )
        const outputArtifacts = task.procedureProduct?.outputArtifacts
        assert(
          Array.isArray(outputArtifacts),
          'INVALID_STATE',
          'Run has no declared Procedure output snapshot',
        )
        json(200, {
          schemaVersion: 'openadam.procedure-output.v0.1',
          procedure: { id: reference.id, version: reference.version },
          runId: task.runId,
          outputs: validateProcedureOutputs(
            { outputSchema: task.procedureProduct.outputSchema },
            declaredTaskOutputs(outputArtifacts, task, coordinator.store),
          ),
        })
        return
      }
      if (req.method === 'GET' && match[2] === 'artifact') {
        const key = url.searchParams.get('id')
        assert(
          /^[a-f0-9]{64}$/.test(key ?? ''),
          'INVALID_INPUT',
          'Invalid artifact',
        )
        const refs = new Set([
          task.base,
          task.candidate?.artifact,
          ...Object.values(task.outputs ?? {}).map((output) => output.artifact),
          ...task.artifacts,
          ...task.attempts.flatMap((a) => [a.report, a.result, a.context]),
        ])
        assert(refs.has(key), 'NOT_FOUND', 'Artifact is not part of this task')
        json(200, coordinator.store.readArtifact(key))
        return
      }
      if (req.method === 'POST' && match[2] === 'command') {
        json(200, coordinator.command(task.id, await body(req)))
        return
      }
      assert(false, 'NOT_FOUND', 'Route not found')
    } catch (error) {
      json(
        ['UNAUTHORIZED', 'INVALID_ORIGIN'].includes(error.code)
          ? 403
          : error.code === 'NOT_FOUND'
            ? 404
            : error.code === 'REVISION_CONFLICT'
              ? 409
              : 400,
        { error: errorValue(error) },
      )
    }
  })
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  origin = `http://127.0.0.1:${server.address().port}`
  return {
    server,
    coordinator,
    origin,
    token,
    async close() {
      await new Promise((r) => server.close(r))
      await coordinator.close()
    },
  }
}
