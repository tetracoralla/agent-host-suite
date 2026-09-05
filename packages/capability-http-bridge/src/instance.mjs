import { execFile } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { assertExactKeys, parseStrictJson } from './json.mjs'

const execFileAsync = promisify(execFile)
const maxInstanceBytes = 64 * 1024
const stableId = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u
const semver = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

function inside(root, candidate) {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function assertString(value, label, maxLength) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`${label} must be a non-empty string of at most ${maxLength} characters`)
  }
}

function validateEndpoint(value) {
  assertString(value, 'instance endpoint', 2048)
  let endpoint
  try {
    endpoint = new URL(value)
  } catch {
    throw new Error('instance endpoint must be an absolute URL')
  }
  const isLoopbackHttp = endpoint.protocol === 'http:'
    && ['127.0.0.1', '[::1]'].includes(endpoint.hostname)
  if (endpoint.protocol !== 'https:' && !isLoopbackHttp) {
    throw new Error('instance endpoint must use HTTPS; HTTP is allowed only for numeric loopback')
  }
  if (endpoint.username !== '' || endpoint.password !== '') {
    throw new Error('instance endpoint must not contain credentials')
  }
  if (endpoint.search !== '' || endpoint.hash !== '') {
    throw new Error('instance endpoint must not contain a query or fragment')
  }
  return endpoint.toString()
}

function validateInstance(value) {
  assertExactKeys(
    value,
    ['schemaVersion', 'endpoint', 'capability', 'operations', 'auth', 'timeoutMs', 'maxResponseBytes'],
    'instance',
  )
  if (value.schemaVersion !== 'openadam.http-capability-instance.v0.1') {
    throw new Error('unsupported instance schemaVersion')
  }
  assertExactKeys(value.capability, ['id', 'version'], 'instance capability')
  if (!stableId.test(value.capability.id) || value.capability.id.length > 160) {
    throw new Error('instance capability id is invalid')
  }
  if (!semver.test(value.capability.version) || value.capability.version.length > 100) {
    throw new Error('instance capability version is invalid')
  }
  if (!Array.isArray(value.operations) || value.operations.length < 1 || value.operations.length > 128) {
    throw new Error('instance operations must contain between 1 and 128 operation ids')
  }
  for (const operation of value.operations) {
    if (typeof operation !== 'string' || operation.length > 160 || !stableId.test(operation)) {
      throw new Error('instance operation id is invalid')
    }
  }
  if (new Set(value.operations).size !== value.operations.length) {
    throw new Error('instance operation ids must be unique')
  }
  if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 100 || value.timeoutMs > 60000) {
    throw new Error('instance timeoutMs must be an integer from 100 through 60000')
  }
  if (
    !Number.isInteger(value.maxResponseBytes)
    || value.maxResponseBytes < 1024
    || value.maxResponseBytes > 1024 * 1024
  ) {
    throw new Error('instance maxResponseBytes must be an integer from 1024 through 1048576')
  }
  if (value.auth?.kind === 'none') {
    assertExactKeys(value.auth, ['kind'], 'instance auth')
  } else if (value.auth?.kind === 'macos-keychain-bearer') {
    assertExactKeys(value.auth, ['kind', 'service', 'account'], 'instance auth')
    assertString(value.auth.service, 'instance auth service', 200)
    assertString(value.auth.account, 'instance auth account', 200)
  } else {
    throw new Error('instance auth kind is unsupported')
  }
  return Object.freeze({
    ...structuredClone(value),
    endpoint: validateEndpoint(value.endpoint),
    operations: Object.freeze([...value.operations]),
    capability: Object.freeze({ ...value.capability }),
    auth: Object.freeze({ ...value.auth }),
  })
}

export async function loadInstance(argv, environment = process.env) {
  if (argv.length !== 2 || argv[0] !== '--instance') {
    throw new Error('usage: openadam-capability-http-bridge --instance RELATIVE_FILE')
  }
  const rootInput = environment.OPENADAM_PROVIDER_ROOT
  const root = typeof rootInput === 'string' && isAbsolute(rootInput)
    ? await realpath(rootInput)
    : await realpath(process.cwd())
  const candidate = isAbsolute(argv[1]) ? argv[1] : resolve(root, argv[1])
  if (!isAbsolute(argv[1]) && !inside(root, candidate)) {
    throw new Error('instance file escapes the Provider Instance root')
  }
  const path = await realpath(candidate)
  if (!isAbsolute(argv[1]) && !inside(root, path)) {
    throw new Error('instance file escapes the Provider Instance root')
  }
  const body = await readFile(path)
  if (body.length > maxInstanceBytes) throw new Error(`instance file exceeds ${maxInstanceBytes} bytes`)
  return validateInstance(parseStrictJson(body.toString('utf8'), 'instance file'))
}

export async function resolveAuthorization(auth) {
  if (auth.kind === 'none') return undefined
  if (process.platform !== 'darwin') {
    throw new Error('configured credential provider is unavailable on this platform')
  }
  let stdout
  try {
    const result = await execFileAsync(
      '/usr/bin/security',
      ['find-generic-password', '-w', '-s', auth.service, '-a', auth.account],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 },
    )
    stdout = result.stdout
  } catch {
    throw new Error('configured Keychain credential is unavailable')
  }
  const token = stdout.replace(/[\r\n]+$/u, '')
  if (token.length === 0 || token.length > 8192 || /[\r\n]/u.test(token)) {
    throw new Error('configured Keychain credential has an invalid shape')
  }
  return `Bearer ${token}`
}
