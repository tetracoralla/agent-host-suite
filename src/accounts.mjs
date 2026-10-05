import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { AgentHostError } from './errors.mjs'
import { withLifecycleMutation } from './lifecycle-lock.mjs'
import { resolveStateRoot } from './paths.mjs'
import { loadState, readStatePaths, saveState } from './state.mjs'

const execFileAsync = promisify(execFile)

export const ACCOUNT_SCHEMA = 'openadam.agent-host-account.v1'
export const ACCOUNT_LIST_SCHEMA = 'openadam.agent-host-accounts.v1'

// An Account record is a reusable reference, never a secret store: it names
// the Provider family, the API endpoint, and the macOS Keychain item that
// holds the credential. Execution adapters can resolve a record by id; the
// current implementation records and checks accounts, but does not yet bind
// these records into Procedure or Provider execution.
const SUPPORTED_PROVIDERS = new Set(['github-readonly'])
const DEFAULT_ENDPOINTS = new Map([
  ['github-readonly', 'https://api.github.com'],
])

function fail(code, message, details) {
  throw new AgentHostError(code, message, details)
}

function label(value, field, max) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    fail('ACCOUNT_INVALID', `${field} must be 1–${max} characters`)
  }
  return value
}

function accountSlug(name) {
  const slug = name.trim().toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  if (/^[a-z0-9][a-z0-9-]{0,63}$/u.test(slug)) return slug
  return `account-${createHash('sha256').update(name.trim()).digest('hex').slice(0, 16)}`
}

function validateEndpoint(endpoint) {
  let url
  try {
    url = new URL(endpoint)
  } catch {
    fail('ACCOUNT_INVALID', 'The account endpoint must be an absolute URL')
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    fail('ACCOUNT_INVALID', 'The account endpoint must not contain credentials, a query, or a fragment')
  }
  const loopback = url.hostname === 'localhost' || /^127\.\d+\.\d+\.\d+$/u.test(url.hostname) || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    fail('ACCOUNT_INVALID', 'The account endpoint must use HTTPS; HTTP is allowed only for loopback hosts')
  }
  return url.origin + (url.pathname.replace(/\/+$/u, '') || '')
}

function validateCredentialReference({ keychainService, keychainAccount }) {
  const service = label(keychainService, 'Keychain service name', 200)
  const account = label(keychainAccount, 'Keychain account name', 200)
  if (/[\r\n\0]/u.test(service) || /[\r\n\0]/u.test(account)) {
    fail('ACCOUNT_INVALID', 'Keychain reference names must be single-line strings')
  }
  return { kind: 'macos-keychain-bearer', service, account }
}

function readAccounts(state) {
  const accounts = state.accounts ?? {}
  if (accounts === null || typeof accounts !== 'object' || Array.isArray(accounts)) {
    fail('ACCOUNT_STATE_INVALID', 'The saved account records are not an object')
  }
  return accounts
}

function mustAccount(accounts, id) {
  const account = accounts[id]
  if (account === undefined) fail('ACCOUNT_NOT_FOUND', `Account ${id} is not recorded`)
  return account
}

function publicAccount(account) {
  return {
    schemaVersion: account.schemaVersion,
    id: account.id,
    provider: account.provider,
    name: account.name,
    endpoint: account.endpoint,
    credential: structuredClone(account.credential),
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    lastHealth: structuredClone(account.lastHealth ?? null),
  }
}

async function mutateAccounts(options, operation, dependencies) {
  const root = resolveStateRoot(options.stateRoot)
  const paths = await readStatePaths(root)
  const state = await loadState(paths)
  if (state === null) fail('NOT_INSTALLED', 'No Agent environment is installed')
  const result = { }
  await withLifecycleMutation(paths, `account-${randomUUID()}`, { ...dependencies, migrateState: true }, async (_inner, livePaths) => {
    const current = await loadState(livePaths)
    if (current === null) fail('NOT_INSTALLED', 'No Agent environment is installed')
    const outcome = operation(readAccounts(current), current)
    current.updatedAt = outcome.now
    if (outcome.save) {
      current.accounts = outcome.accounts
      await saveState(livePaths, current)
    }
    result.value = outcome.value
  })
  return result.value
}

export async function addAccount(options, dependencies = {}) {
  const name = label(typeof options.name === 'string' ? options.name.trim() : options.name, 'Account name', 80)
  const provider = label(options.provider, 'Account provider', 64)
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    fail('ACCOUNT_PROVIDER_UNSUPPORTED', `Account provider ${provider} is not supported; supported providers: ${[...SUPPORTED_PROVIDERS].join(', ')}`)
  }
  const endpoint = validateEndpoint(options.endpoint ?? DEFAULT_ENDPOINTS.get(provider))
  const credential = validateCredentialReference(options)
  const id = options.id !== undefined ? label(options.id, 'Account id', 64) : accountSlug(name)
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(id)) {
    fail('ACCOUNT_INVALID', 'The account id must be lowercase letters, digits, and dashes')
  }
  const now = new Date().toISOString()
  const added = await mutateAccounts(options, (accounts) => {
    if (accounts[id] !== undefined) fail('ACCOUNT_EXISTS', `Account ${id} is already recorded`)
    accounts[id] = {
      schemaVersion: ACCOUNT_SCHEMA,
      id,
      provider,
      name,
      endpoint,
      credential,
      createdAt: now,
      updatedAt: now,
      lastHealth: null,
    }
    return { accounts, save: true, now, value: { status: 'ok', account: publicAccount(accounts[id]) } }
  }, dependencies)
  return added
}

export async function updateAccount(options, dependencies = {}) {
  const id = label(options.account, 'Account id', 64)
  return mutateAccounts(options, (accounts) => {
    const account = mustAccount(accounts, id)
    const changes = []
    if (options.name !== undefined) {
      account.name = label(typeof options.name === 'string' ? options.name.trim() : options.name, 'Account name', 80)
      changes.push('name')
    }
    if (options.endpoint !== undefined) {
      account.endpoint = validateEndpoint(options.endpoint)
      changes.push('endpoint')
    }
    const credential = {
      keychainService: options.keychainService ?? account.credential.service,
      keychainAccount: options.keychainAccount ?? account.credential.account,
    }
    const nextCredential = validateCredentialReference(credential)
    if (nextCredential.service !== account.credential.service || nextCredential.account !== account.credential.account) {
      account.credential = nextCredential
      changes.push('credential')
    }
    const now = new Date().toISOString()
    account.updatedAt = now
    // Endpoint or credential changes invalidate the recorded health evidence.
    if (changes.includes('endpoint') || changes.includes('credential')) account.lastHealth = null
    return { accounts, save: true, now, value: { status: 'ok', changed: changes, account: publicAccount(account) } }
  }, dependencies)
}

export async function removeAccount(options, dependencies = {}) {
  const id = label(options.account, 'Account id', 64)
  return mutateAccounts(options, (accounts) => {
    mustAccount(accounts, id)
    delete accounts[id]
    return {
      accounts,
      save: true,
      now: new Date().toISOString(),
      value: {
        status: 'ok',
        removed: id,
        // The Host record is gone; the Keychain item itself is user-owned
        // and is never deleted by the Host.
        keychainUntouched: true,
      },
    }
  }, dependencies)
}

export async function listAccounts(options = {}) {
  const paths = await readStatePaths(resolveStateRoot(options.stateRoot))
  const state = await loadState(paths)
  if (state === null) fail('NOT_INSTALLED', 'No Agent environment is installed')
  const accounts = readAccounts(state)
  return {
    schemaVersion: ACCOUNT_LIST_SCHEMA,
    accounts: Object.values(accounts)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(publicAccount),
  }
}

export async function describeAccount(options = {}) {
  const id = label(options.account, 'Account id', 64)
  const paths = await readStatePaths(resolveStateRoot(options.stateRoot))
  const state = await loadState(paths)
  if (state === null) fail('NOT_INSTALLED', 'No Agent environment is installed')
  return { status: 'ok', account: publicAccount(mustAccount(readAccounts(state), id)) }
}

async function keychainItemExists(credential, dependencies) {
  const platform = dependencies.platform ?? process.platform
  if (platform !== 'darwin') {
    return { present: false, detail: `Keychain credentials are unavailable on ${platform}` }
  }
  const runSecurity = dependencies.execFile ?? execFileAsync
  try {
    // No -w: existence only. The secret is never read into Host memory for
    // the availability part of the check.
    await runSecurity(
      '/usr/bin/security',
      ['find-generic-password', '-s', credential.service, '-a', credential.account],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 },
    )
    return { present: true, detail: null }
  } catch (error) {
    // The probe cannot distinguish a missing item from an unreadable or
    // locked Keychain, so it reports the observation, not the cause.
    return { present: false, detail: 'The referenced Keychain item was not found or could not be read' }
  }
}

async function authorizedProbe(account, dependencies) {
  const fetchImpl = dependencies.fetch ?? fetch
  const url = `${account.endpoint}/user`
  const runSecurity = dependencies.execFile ?? execFileAsync
  let stdout
  try {
    const result = await runSecurity(
      '/usr/bin/security',
      ['find-generic-password', '-w', '-s', account.credential.service, '-a', account.credential.account],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 },
    )
    stdout = result.stdout
  } catch {
    return { status: 'credential-missing', detail: 'The referenced Keychain item could not be read' }
  }
  const token = stdout.replace(/[\r\n]+$/u, '')
  if (token.length === 0 || token.length > 8192 || /[\r\n]/u.test(token)) {
    return { status: 'credential-missing', detail: 'The referenced Keychain credential has an invalid shape' }
  }
  try {
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(dependencies.timeoutMs ?? 10_000),
    })
    if (response.ok) return { status: 'healthy', detail: null }
    if (response.status === 401 || response.status === 403) {
      return { status: 'unauthorized', detail: `The endpoint answered ${response.status}` }
    }
    return { status: 'unreachable', detail: `The endpoint answered ${response.status}` }
  } catch (error) {
    return { status: 'unreachable', detail: error.cause?.code ?? error.message }
  }
}

export async function checkAccount(options, dependencies = {}) {
  const id = label(options.account, 'Account id', 64)
  const outcome = await mutateAccounts(options, (accounts, state) => {
    const account = mustAccount(accounts, id)
    return { accounts, save: false, now: new Date().toISOString(), value: account }
  }, dependencies)
  const availability = await keychainItemExists(outcome.credential, dependencies)
  const health = availability.present
    ? await authorizedProbe(outcome, dependencies)
    : { status: 'credential-missing', detail: availability.detail }
  const observedAt = new Date().toISOString()
  const recorded = await mutateAccounts(options, (accounts) => {
    const account = mustAccount(accounts, id)
    if (account.endpoint !== outcome.endpoint || account.credential.service !== outcome.credential.service || account.credential.account !== outcome.credential.account) {
      fail('ACCOUNT_CHANGED', 'The account changed while its health was being checked; check again')
    }
    account.lastHealth = { status: health.status, observedAt, ...(health.detail ? { detail: health.detail } : {}) }
    account.updatedAt = observedAt
    return { accounts, save: true, now: observedAt, value: { status: 'ok', account: publicAccount(account) } }
  }, dependencies)
  return {
    status: 'ok',
    health: recorded.account.lastHealth,
    account: recorded.account,
    boundary: 'Health observes one authorized endpoint request plus Keychain availability. It is not a guarantee of every operation the Provider exposes.',
  }
}

export function accountDependencyFingerprint(account) {
  return `sha256:${createHash('sha256').update(JSON.stringify({
    provider: account.provider,
    endpoint: account.endpoint,
    credential: account.credential,
  })).digest('hex')}`
}
