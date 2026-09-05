#!/usr/bin/env node

import { assertExactKeys, parseStrictJson } from './json.mjs'
import { loadInstance, resolveAuthorization } from './instance.mjs'

const maxRequestLineBytes = 1024 * 1024

async function* readBoundedLines(input) {
  let buffered = []
  let bufferedBytes = 0
  let oversized = false
  for await (const chunkValue of input) {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue)
    let start = 0
    let newline = chunk.indexOf(0x0a, start)
    while (newline !== -1) {
      const segment = chunk.subarray(start, newline)
      if (oversized || bufferedBytes + segment.length > maxRequestLineBytes) {
        throw new Error(`request line exceeds ${maxRequestLineBytes} bytes`)
      }
      buffered.push(segment)
      const line = Buffer.concat(buffered, bufferedBytes + segment.length)
      yield line.subarray(0, line.at(-1) === 0x0d ? -1 : undefined).toString('utf8')
      buffered = []
      bufferedBytes = 0
      oversized = false
      start = newline + 1
      newline = chunk.indexOf(0x0a, start)
    }
    const remainder = chunk.subarray(start)
    if (oversized) continue
    if (bufferedBytes + remainder.length > maxRequestLineBytes) {
      buffered = []
      bufferedBytes = 0
      oversized = true
    } else if (remainder.length > 0) {
      buffered.push(remainder)
      bufferedBytes += remainder.length
    }
  }
  if (oversized) throw new Error(`request line exceeds ${maxRequestLineBytes} bytes`)
  if (bufferedBytes > 0) throw new Error('adapter input ended with a partial request line')
}

function validateRequest(request, instance) {
  assertExactKeys(request, ['id', 'operationId', 'input'], 'Capability request')
  if (typeof request.id !== 'string' || request.id.length < 1 || request.id.length > 128) {
    throw new Error('Capability request id must contain 1 through 128 characters')
  }
  if (!instance.operations.includes(request.operationId)) {
    throw new Error('Capability request operation is not allowed by this Provider Instance')
  }
}

function validateRemoteResponse(response, requestId) {
  if (response?.ok === true) {
    assertExactKeys(response, ['schemaVersion', 'id', 'ok', 'result'], 'remote response')
  } else {
    assertExactKeys(response, ['schemaVersion', 'id', 'ok', 'error'], 'remote response')
  }
  if (response.schemaVersion !== 'openadam.remote-capability-response.v0.1') {
    throw new Error('remote response schemaVersion is unsupported')
  }
  if (response.id !== requestId) throw new Error('remote response correlation id differs')
  if (response.ok === true) return { id: response.id, ok: true, result: response.result }
  if (response.ok !== false) throw new Error('remote response ok must be true or false')
  const errorKeys = Object.keys(response.error ?? {}).sort()
  const exact = JSON.stringify(errorKeys) === JSON.stringify(['code', 'message'])
    || JSON.stringify(errorKeys) === JSON.stringify(['code', 'message', 'retryable'])
  if (
    response.error === null
    || typeof response.error !== 'object'
    || Array.isArray(response.error)
    || !exact
    || typeof response.error.code !== 'string'
    || !/^[A-Z][A-Z0-9_]*$/u.test(response.error.code)
    || typeof response.error.message !== 'string'
    || response.error.message.length === 0
    || response.error.message.length > 4096
    || (
      Object.hasOwn(response.error, 'retryable')
      && typeof response.error.retryable !== 'boolean'
    )
  ) {
    throw new Error('remote provider error envelope is invalid')
  }
  return { id: response.id, ok: false, error: response.error }
}

async function readBoundedResponse(response, maximumBytes) {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maximumBytes)) {
    throw new Error('remote response exceeds the configured byte limit')
  }
  const chunks = []
  let bytes = 0
  if (response.body === null) throw new Error('remote response body is missing')
  for await (const chunk of response.body) {
    bytes += chunk.length
    if (bytes > maximumBytes) throw new Error('remote response exceeds the configured byte limit')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, bytes).toString('utf8')
}

async function invokeRemote(instance, request, authorization) {
  const remoteRequest = {
    schemaVersion: 'openadam.remote-capability-request.v0.1',
    capabilityId: instance.capability.id,
    capabilityVersion: instance.capability.version,
    id: request.id,
    operationId: request.operationId,
    input: request.input,
  }
  const response = await fetch(instance.endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(instance.timeoutMs),
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(authorization === undefined ? {} : { authorization }),
    },
    body: JSON.stringify(remoteRequest),
  })
  if (response.status !== 200) throw new Error('remote endpoint returned a non-success status')
  const contentType = response.headers.get('content-type') ?? ''
  if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    throw new Error('remote response content type is not application/json')
  }
  const body = await readBoundedResponse(response, instance.maxResponseBytes)
  return validateRemoteResponse(parseStrictJson(body, 'remote response'), request.id)
}

async function main() {
  const instance = await loadInstance(process.argv.slice(2))
  const authorization = await resolveAuthorization(instance.auth)
  for await (const line of readBoundedLines(process.stdin)) {
    if (line.length === 0) throw new Error('empty Capability request line')
    const request = parseStrictJson(line, 'Capability request')
    validateRequest(request, instance)
    const response = await invokeRemote(instance, request, authorization)
    process.stdout.write(`${JSON.stringify(response)}\n`)
  }
}

main().catch(() => {
  process.stderr.write('Capability HTTP Bridge stopped because its instance, credential, transport, or remote response boundary failed.\n')
  process.exitCode = 1
})
