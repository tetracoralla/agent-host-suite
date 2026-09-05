import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pruneDanglingLinks } from '../scripts/prune-dangling-links.mjs'

test('packaging removes unresolved workspace links without touching valid package links', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-packaging-links-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const packages = join(root, 'node_modules', 'package')
  const bin = join(root, 'node_modules', '.bin')
  await mkdir(packages, { recursive: true })
  await mkdir(bin, { recursive: true })
  await writeFile(join(packages, 'cli.mjs'), 'export {}\n')
  await symlink('../package/cli.mjs', join(bin, 'valid'))
  await symlink('../../packages/workspace-only', join(root, 'node_modules', 'workspace-only'))

  const result = await pruneDanglingLinks(root)
  assert.deepEqual(result, { scannedLinks: 2, removedLinks: 1 })
  await assert.doesNotReject(() => stat(join(bin, 'valid')))
  await assert.rejects(
    lstat(join(root, 'node_modules', 'workspace-only')),
    (error) => error.code === 'ENOENT',
  )
})

test('packaging link cleanup rejects broad or indirect roots', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-packaging-link-root-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const linked = `${root}-link`
  t.after(() => rm(linked, { force: true }))
  await symlink(root, linked)
  await assert.rejects(pruneDanglingLinks('/'), /absolute non-root/u)
  await assert.rejects(pruneDanglingLinks(linked), /real directory/u)
})
