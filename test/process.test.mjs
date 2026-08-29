import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveExecutable, runFile, toolSearchPath } from '../src/process.mjs'

test('process runner sends bounded stdin to child commands', async () => {
  const script = "let value='';process.stdin.on('data',c=>value+=c);process.stdin.on('end',()=>process.stdout.write(value.toUpperCase()))"
  const result = await runFile(process.execPath, ['-e', script], { input: 'closed work order\n' })
  assert.equal(result.stdout, 'CLOSED WORK ORDER\n')
})

test('process runner terminates a command at its deadline', async () => {
  const result = await runFile(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 50, allowFailure: true })
  assert.equal(result.timedOut, true)
  assert.notEqual(result.status, 0)
})

test('tool search path appends standard install directories to a Finder-clean PATH', () => {
  const search = toolSearchPath('/usr/bin:/bin:/usr/sbin:/sbin', '/Users/example')
  const entries = search.split(':')
  assert.deepEqual(entries.slice(0, 4), ['/usr/bin', '/bin', '/usr/sbin', '/sbin'])
  for (const expected of ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin', '/Users/example/.local/bin', '/Users/example/bin']) {
    assert.equal(entries.includes(expected), true, `expected ${expected} in the search path`)
  }
})

test('tool search path keeps custom entries first and never duplicates', () => {
  const custom = '/opt/homebrew/bin:/usr/local/bin:/my/own/bin'
  const entries = toolSearchPath(custom, homedir()).split(':')
  assert.deepEqual(entries.slice(0, 3), ['/opt/homebrew/bin', '/usr/local/bin', '/my/own/bin'])
  assert.equal(new Set(entries).size, entries.length, 'search path must not contain duplicates')
})

test('resolveExecutable finds hosts outside a GUI-clean PATH', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-process-discovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bin = join(root, 'bin')
  await mkdir(bin)
  const fake = join(bin, 'fake-host-cli')
  await writeFile(fake, '#!/bin/sh\nexit 0\n')
  await chmod(fake, 0o755)
  const discovered = await resolveExecutable('fake-host-cli', (command, args, options) =>
    runFile(command, args, { ...options, env: { ...options.env, PATH: `${options.env.PATH}:${bin}` } }))
  assert.equal(discovered, fake)
})

test('resolveExecutable probes which with an augmented environment', async () => {
  let capturedOptions
  const result = await resolveExecutable('definitely-not-a-real-host-cli', (command, args, options) => {
    capturedOptions = options
    return { status: 1, signal: null, stdout: '', stderr: 'not found', timedOut: false, overflowed: false }
  })
  assert.equal(result, null)
  assert.equal(capturedOptions.allowFailure, true)
  assert.equal(
    capturedOptions.env.PATH.split(':').includes('/opt/homebrew/bin'),
    true,
    'which must run against a PATH that includes Homebrew locations',
  )
})
