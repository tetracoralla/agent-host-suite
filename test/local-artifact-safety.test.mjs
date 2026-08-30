import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { previewLocalComponentArtifact } from '../src/release-artifacts.mjs'
import { createToolComponentFixture } from './release-helpers.mjs'

const execFileAsync = promisify(execFile)

test('local component admission rejects unclaimed empty directories', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-local-artifact-safety-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = await createToolComponentFixture(join(root, 'fixture'))
  const staging = join(root, 'staging')
  await mkdir(staging)
  await execFileAsync('/usr/bin/tar', ['-xzf', fixture.artifactPath, '-C', staging])
  await mkdir(join(staging, 'unclaimed-empty-directory'))
  const artifact = join(root, 'unclaimed-directory.tar.gz')
  await execFileAsync('/usr/bin/tar', ['-czf', artifact, '-C', staging, '.'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })

  await assert.rejects(
    previewLocalComponentArtifact(artifact),
    (error) => error.code === 'LOCAL_COMPONENT_FILE_SET_MISMATCH',
  )
})
