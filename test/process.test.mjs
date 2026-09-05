import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
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

test('process runner timeout removes a stubborn POSIX command root and descendant', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-command-tree-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pidPath = join(root, 'descendant.pid')
  const scriptPath = join(root, 'stubborn-tree.mjs')
  await writeFile(scriptPath, [
    "import { spawn } from 'node:child_process'",
    "import { writeFileSync } from 'node:fs'",
    "const descendant = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
    'writeFileSync(process.argv[2], JSON.stringify({ root: process.pid, descendant: descendant.pid }))',
    "process.on('SIGTERM', () => {})",
    'setInterval(() => {}, 1000)',
    '',
  ].join('\n'))
  await assert.rejects(
    runFile(process.execPath, [scriptPath, pidPath], { timeoutMs: 2_000 }),
    (error) => error.code === 'HOST_COMMAND_TIMEOUT',
  )
  const processRecord = JSON.parse(await readFile(pidPath, 'utf8'))
  assert.throws(() => process.kill(processRecord.root, 0), (error) => error.code === 'ESRCH')
  assert.throws(() => process.kill(-processRecord.root, 0), (error) => error.code === 'ESRCH')
  assert.equal(Number.isSafeInteger(processRecord.descendant) && processRecord.descendant > 0, true)
})

test('process runner cancels a command through an AbortSignal', async () => {
  const controller = new AbortController()
  const running = runFile(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    timeoutMs: 5_000,
    signal: controller.signal,
  })
  controller.abort()
  await assert.rejects(running, { code: 'HOST_COMMAND_CANCELLED' })
})

test('process runner rejects an already-cancelled command before spawning it', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    runFile(process.execPath, ['-e', 'process.exit(0)'], { signal: controller.signal }),
    { code: 'HOST_COMMAND_CANCELLED' },
  )
})

test('tool search path appends standard install directories to a Finder-clean PATH', { skip: process.platform === 'win32' }, () => {
  const exampleHome = '/opt/openadam-example-home'
  const search = toolSearchPath('/usr/bin:/bin:/usr/sbin:/sbin', exampleHome)
  const entries = search.split(':')
  assert.deepEqual(entries.slice(0, 4), ['/usr/bin', '/bin', '/usr/sbin', '/sbin'])
  for (const expected of ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin', `${exampleHome}/.local/bin`, `${exampleHome}/bin`]) {
    assert.equal(entries.includes(expected), true, `expected ${expected} in the search path`)
  }
})

test('tool search path keeps custom entries first and never duplicates', { skip: process.platform === 'win32' }, () => {
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
  const fake = join(bin, process.platform === 'win32' ? 'fake-host-cli.cmd' : 'fake-host-cli')
  await writeFile(fake, '#!/bin/sh\nexit 0\n')
  await chmod(fake, 0o755)
  const discovered = await resolveExecutable('fake-host-cli', (command, args, options) =>
    runFile(command, args, { ...options, env: { ...options.env, PATH: `${options.env.PATH}${delimiter}${bin}` } }))
  assert.equal(await realpath(discovered), await realpath(fake))
})

test('resolveExecutable probes which with an augmented environment', { skip: process.platform === 'win32' }, async () => {
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
