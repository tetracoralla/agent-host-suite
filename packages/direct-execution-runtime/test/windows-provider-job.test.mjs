import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnManagedProvider, closeProviderProcessTree, managedProviderSpawnOptions } from '../src/process-tree.mjs'

async function waitForPid(file) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const value = await readFile(file, 'utf8').catch(() => '')
    if (/^[1-9][0-9]*$/u.test(value)) return Number(value)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Provider descendant did not start')
}

test('Windows Job retires descendants after root exit and explicit cancellation', {
  skip: process.platform !== 'win32', timeout: 45000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'provider-job-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const script = join(directory, 'provider.mjs')
  await writeFile(script, [
    "import { spawn } from 'node:child_process'",
    "import { writeFileSync } from 'node:fs'",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
    'writeFileSync(process.argv[2], String(child.pid))',
    "if (process.argv[3] === 'exit') setTimeout(() => process.exit(0), 100)",
    'else setInterval(() => {}, 1000)',
  ].join('\n'))
  for (const mode of ['exit', 'cancel']) {
    const pidFile = join(directory, `${mode}.pid`)
    const guardian = spawnManagedProvider(process.execPath, [script, pidFile, mode], {
      cwd: directory, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], ...managedProviderSpawnOptions(),
    })
    let errors = ''
    guardian.stderr.on('data', (bytes) => { errors += bytes })
    const closed = new Promise((resolve, reject) => {
      guardian.once('close', (code) => resolve(code))
      guardian.once('error', reject)
    })
    t.after(() => closeProviderProcessTree(guardian))
    const pid = await Promise.race([waitForPid(pidFile), closed.then((code) => { throw new Error(`Guardian closed before launch (${code}): ${errors}`) })])
    if (mode === 'cancel') await closeProviderProcessTree(guardian)
    const code = await closed
    if (mode === 'exit') assert.equal(code, 0, errors)
    await closeProviderProcessTree(guardian)
    assert.throws(() => process.kill(pid, 0), (error) => error.code === 'ESRCH')
  }
})
