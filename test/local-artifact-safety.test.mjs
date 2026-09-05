import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { platform } from 'node:os'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { materializeObservedLocalComponentArtifact, previewLocalComponentArtifact } from '../src/release-artifacts.mjs'
import { runFile } from '../src/process.mjs'
import { createToolComponentFixture } from './release-helpers.mjs'

const execFileAsync = promisify(execFile)
const tarCommand = platform() === 'win32' ? 'tar.exe' : '/usr/bin/tar'

test('local component admission rejects unclaimed empty directories', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-local-artifact-safety-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = await createToolComponentFixture(join(root, 'fixture'))
  const staging = join(root, 'staging')
  await mkdir(staging)
  await execFileAsync(tarCommand, ['-xzf', fixture.artifactPath, '-C', staging])
  await mkdir(join(staging, 'unclaimed-empty-directory'))
  const artifact = join(root, 'unclaimed-directory.tar.gz')
  await execFileAsync(tarCommand, ['-czf', artifact, '-C', staging, '.'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })

  await assert.rejects(
    previewLocalComponentArtifact(artifact),
    (error) => error.code === 'LOCAL_COMPONENT_FILE_SET_MISMATCH',
  )
})

test('archive inspection and extraction use size-aware installation timeouts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-local-artifact-timeout-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = await createToolComponentFixture(join(root, 'fixture'))
  const calls = []
  const runner = async (command, args, options = {}) => {
    if (command === tarCommand) calls.push({ args, timeoutMs: options.timeoutMs })
    return runFile(command, args, options)
  }

  await previewLocalComponentArtifact(fixture.artifactPath, { runner })

  const archiveCalls = calls.filter((call) => ['-tzf', '-tvzf', '-xOzf', '-xzf'].includes(call.args[0]))
  assert.equal(archiveCalls.length > 0, true)
  assert.equal(archiveCalls.every((call) => Number.isSafeInteger(call.timeoutMs) && call.timeoutMs >= 60_000), true)
})

test('materialization rejects a caller-forged archive observation', async () => {
  await assert.rejects(
    materializeObservedLocalComponentArtifact({}, {}, { packages: '/tmp' }),
    (error) => error.code === 'LOCAL_COMPONENT_OBSERVATION_INVALID',
  )
})
