import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { measureReadOnlyTreeUsage } from '../src/storage.mjs'

test('read-only installation measurement counts links without following their targets', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'agent-host-installation-usage-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const installation = join(parent, 'Agent Host.app')
  const outside = join(parent, 'outside.bin')
  await writeFile(outside, Buffer.alloc(1024 * 1024))
  await mkdir(installation)
  await writeFile(join(installation, 'small.bin'), 'small')
  await symlink(outside, join(installation, 'linked.bin'))

  const usage = await measureReadOnlyTreeUsage(installation)
  assert.equal(usage.files, 2)
  assert.equal(usage.apparentBytes < 1024 * 1024, true)
})
