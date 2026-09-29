import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { addAccount, checkAccount, describeAccount, listAccounts, removeAccount, updateAccount } from '../src/accounts.mjs'
import { loadState, prepareStatePaths, readStatePaths, saveState } from '../src/state.mjs'

// Account records are reusable credential references: the Host never receives
// or stores the secret itself, so every test below works from a Keychain
// reference shape and injected probes instead of real credentials.

async function stateRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-accounts-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const paths = await prepareStatePaths(root)
  const now = new Date().toISOString()
  await saveState(paths, {
    schemaVersion: 'openadam.agent-host-state.v0.2',
    suiteVersion: '0.1.0-accounts-test',
    channel: 'development',
    profile: 'standard',
    installedAt: now,
    updatedAt: now,
    components: {},
    hosts: {},
    runtime: {},
    observability: {},
  })
  return root
}

function keychainProbe({ exists = true, token = 'fixture-token' } = {}) {
  return async (command, args) => {
    if (args.includes('-w')) {
      if (!exists) throw new Error('item not found')
      return { stdout: `${token}\n` }
    }
    if (!exists) throw new Error('item not found')
    return { stdout: '' }
  }
}

test('account records hold references only, and the lifecycle stays honest', async (t) => {
  const root = await stateRoot(t)
  const personal = await addAccount({
    stateRoot: root,
    name: 'GitHub Personal',
    provider: 'github-readonly',
    keychainService: 'openadam.test.github',
    keychainAccount: randomUUID(),
  })
  assert.equal(personal.account.id, 'github-personal')
  assert.equal(personal.account.endpoint, 'https://api.github.com')
  assert.deepEqual(Object.keys(personal.account).sort(),
    ['createdAt', 'credential', 'endpoint', 'id', 'lastHealth', 'name', 'provider', 'schemaVersion', 'updatedAt'])
  assert.deepEqual(personal.account.credential, {
    kind: 'macos-keychain-bearer',
    service: 'openadam.test.github',
    account: personal.account.credential.account,
  })

  const work = await addAccount({
    stateRoot: root,
    name: 'Work',
    provider: 'github-readonly',
    keychainService: 'openadam.test.github',
    keychainAccount: randomUUID(),
    endpoint: 'https://github.example.internal/api/v3',
  })
  assert.equal(work.account.id, 'work')
  assert.equal(work.account.endpoint, 'https://github.example.internal/api/v3')

  const listed = await listAccounts({ stateRoot: root })
  assert.deepEqual(listed.accounts.map((account) => account.id), ['github-personal', 'work'])
  assert.equal((await describeAccount({ stateRoot: root, account: 'work' })).account.name, 'Work')

  await assert.rejects(
    addAccount({ stateRoot: root, name: 'GitHub personal', provider: 'github-readonly', keychainService: 'x', keychainAccount: 'y' }),
    (error) => error.code === 'ACCOUNT_EXISTS',
  )
  await assert.rejects(
    addAccount({ stateRoot: root, name: 'Other', provider: 'figma', keychainService: 'x', keychainAccount: 'y' }),
    (error) => error.code === 'ACCOUNT_PROVIDER_UNSUPPORTED',
  )
  await assert.rejects(
    addAccount({ stateRoot: root, name: 'Insecure', provider: 'github-readonly', endpoint: 'http://example.com', keychainService: 'x', keychainAccount: 'y' }),
    (error) => error.code === 'ACCOUNT_INVALID',
  )

  const renamed = await updateAccount({ stateRoot: root, account: 'work', name: 'Work GitHub' })
  assert.deepEqual(renamed.changed, ['name'])
  assert.equal(renamed.account.name, 'Work GitHub')

  const healthy = await checkAccount({ stateRoot: root, account: 'work' }, {
    platform: 'darwin',
    execFile: keychainProbe({ exists: true }),
    fetch: async () => new Response('{}', { status: 200 }),
  })
  assert.equal(healthy.health.status, 'healthy')
  assert.equal(healthy.account.lastHealth.status, 'healthy')

  // Endpoint or credential-reference changes invalidate recorded evidence.
  const moved = await updateAccount({ stateRoot: root, account: 'work', endpoint: 'https://github.example.internal/api/v4' })
  assert.equal(moved.account.lastHealth, null)

  const unauthorized = await checkAccount({ stateRoot: root, account: 'work' }, {
    platform: 'darwin',
    execFile: keychainProbe({ exists: true, token: 'expired-token' }),
    fetch: async () => new Response('{"message":"Bad credentials"}', { status: 401 }),
  })
  assert.equal(unauthorized.health.status, 'unauthorized')

  const missing = await checkAccount({ stateRoot: root, account: 'github-personal' }, {
    platform: 'darwin',
    execFile: keychainProbe({ exists: false }),
  })
  assert.equal(missing.health.status, 'credential-missing')

  const persisted = await loadState(await readStatePaths(root))
  assert.equal(persisted.accounts.work.lastHealth.status, 'unauthorized')
  assert.equal(Object.keys(persisted.accounts).includes('token'), false)

  const removed = await removeAccount({ stateRoot: root, account: 'work' })
  assert.equal(removed.removed, 'work')
  assert.equal(removed.keychainUntouched, true)
  assert.deepEqual((await listAccounts({ stateRoot: root })).accounts.map((account) => account.id), ['github-personal'])
  await assert.rejects(
    removeAccount({ stateRoot: root, account: 'work' }),
    (error) => error.code === 'ACCOUNT_NOT_FOUND',
  )
})

test('the account CLI lifecycle records references without ever reading the real Keychain secret', async (t) => {
  const root = await stateRoot(t)
  const cli = (args) => JSON.parse(execFileSync(process.execPath, [join('bin', 'agent-host.mjs'), ...args, '--state-root', root, '--json'], { encoding: 'utf8' }))

  const added = cli(['account', 'add', '--provider', 'github-readonly', '--name', 'CLI Fixture', '--keychain-service', 'openadam.test.absent', '--keychain-account', randomUUID()])
  assert.equal(added.account.id, 'cli-fixture')
  assert.deepEqual(cli(['account', 'list']).accounts.map((account) => account.id), ['cli-fixture'])
  assert.equal(cli(['account', 'show', 'cli-fixture']).account.name, 'CLI Fixture')

  // The referenced Keychain item does not exist, so the honest health result
  // is credential-missing — and no secret or network access is involved.
  const checked = cli(['account', 'check', 'cli-fixture'])
  assert.equal(checked.health.status, 'credential-missing')

  assert.equal(cli(['account', 'remove', 'cli-fixture']).removed, 'cli-fixture')
  assert.deepEqual(cli(['account', 'list']).accounts, [])
})

