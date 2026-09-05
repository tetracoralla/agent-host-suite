import assert from 'node:assert/strict'
import childProcess, { execFile } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { windowsAccessListsSync } from '../src/windows-private-access.mjs'
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { assertPrivateAccess } from '../src/private-permissions.mjs'
import { ensurePrivateDirectory } from '../src/paths.mjs'
import { readStatePaths } from '../src/state.mjs'

const execute = promisify(execFile)

test('private state rejects a shared directory without repairing it during a read', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-access-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await ensurePrivateDirectory(root)
  const file = join(root, 'owned.json')
  await writeFile(file, '{"retained":true}\n', { mode: 0o600 })
  await Promise.all([
    assertPrivateAccess(root, await lstat(root)),
    assertPrivateAccess(file, await lstat(file)),
  ])
  if (process.platform === 'win32') {
    // Use the well-known Everyone SID, independent of Windows display language.
    await execute('icacls.exe', [root, '/grant', '*S-1-1-0:(OI)(CI)(RX)'], { windowsHide: true })
  } else {
    await chmod(root, 0o755)
  }
  await assert.rejects(readStatePaths(root), { code: 'STATE_ROOT_PERMISSIONS_UNSAFE' })
  await assert.rejects(assertPrivateAccess(root, await lstat(root)), { code: 'STATE_ROOT_PERMISSIONS_UNSAFE' })
  // Only the explicitly mutating preparation path repairs access.
  await ensurePrivateDirectory(root)
  await assertPrivateAccess(root, await lstat(root))
  assert.equal(await readFile(file, 'utf8'), '{"retained":true}\n')
})


test('Windows access inspection retries only one helper timeout with the same request', (t) => {
  const calls = []
  const mock = t.mock.method(childProcess, 'execFileSync', (...args) => {
    calls.push(args)
    if (calls.length === 1) throw Object.assign(new Error('helper startup expired'), { code: 'ETIMEDOUT' })
    return '[{"status":"private"}]'
  })
  syncBuiltinESMExports()
  try {
    assert.deepEqual(windowsAccessListsSync([{ path: 'C:\\owned\\state', ensure: false }]), [{ status: 'private' }])
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[0], calls[1])
    assert.equal(JSON.parse(calls[1][2].env.OPENADAM_PRIVATE_REQUESTS)[0].ensure, false)
  } finally { mock.mock.restore(); syncBuiltinESMExports() }
})

test('Windows access inspection does not retry denied access or malformed output and bounds repeated timeouts', (t) => {
  for (const mode of ['denied', 'malformed', 'timeout', 'signal-timeout', 'cancelled']) {
    let calls = 0
    const mock = t.mock.method(childProcess, 'execFileSync', () => {
      calls += 1
      if (mode === 'malformed') return 'not-json'
      if (mode === 'signal-timeout' || mode === 'cancelled') throw Object.assign(new Error(mode), { killed: true, signal: mode === 'cancelled' ? 'SIGKILL' : 'SIGTERM' })
      throw Object.assign(new Error(mode), { code: mode === 'timeout' ? 'ETIMEDOUT' : 'EACCES' })
    })
    syncBuiltinESMExports()
    try {
      assert.throws(() => windowsAccessListsSync([{ path: 'C:\\owned\\state', ensure: false }]))
      assert.equal(calls, ['timeout', 'signal-timeout'].includes(mode) ? 2 : 1)
    } finally { mock.mock.restore(); syncBuiltinESMExports() }
  }
})
