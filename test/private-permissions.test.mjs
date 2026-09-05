import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
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
  await assertPrivateAccess(root, await lstat(root))
  await assertPrivateAccess(file, await lstat(file))
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
