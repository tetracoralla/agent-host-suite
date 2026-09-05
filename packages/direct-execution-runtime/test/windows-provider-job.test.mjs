import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { prepareRuntimeConfig } from '../src/config.mjs'
import { createLaunchSnapshot } from '../src/launch-snapshot.mjs'
import { fakeConfig } from './helpers.mjs'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

async function waitForExit(pid) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') return; throw error }
    await new Promise((done) => setTimeout(done, 20))
  }
  throw new Error(`Owned process ${pid} survived Host exit`)
}

test('Windows Provider Job retires even when its creating Host is forcibly terminated', {
  skip: process.platform !== 'win32', timeout: 45000,
}, async (t) => {
  const { spawn } = await import('node:child_process')
  const directory = await mkdtemp(join(tmpdir(), 'provider-host-exit-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const providerFile = join(directory, 'provider.mjs')
  const hostFile = join(directory, 'host.mjs')
  const pidFile = join(directory, 'provider.pid')
  const guardianPidFile = join(directory, 'guardian.pid')
  await writeFile(providerFile, "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000)")
  await writeFile(hostFile, [
    `import { spawnManagedProvider } from ${JSON.stringify(new URL('../src/process-tree.mjs', import.meta.url).href)}`,
    "import { writeFileSync } from 'node:fs'",
    'const [provider, pidFile, guardianPidFile] = process.argv.slice(2)',
    "const child = spawnManagedProvider(process.execPath, [provider, pidFile], { env: process.env, cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] })",
    'child.stdout.resume(); child.stderr.pipe(process.stderr)',
    'writeFileSync(guardianPidFile, String(child.pid))',
  ].join('\n'))
  const host = spawn(process.execPath, [hostFile, providerFile, pidFile, guardianPidFile], { stdio: ['ignore', 'ignore', 'pipe'] })
  let errors = ''
  host.stderr.on('data', (bytes) => { errors += bytes })
  t.after(() => { if (host.exitCode === null) host.kill('SIGKILL') })
  const closed = new Promise((resolve, reject) => { host.once('close', resolve); host.once('error', reject) })
  const providerPid = await Promise.race([waitForPid(pidFile), closed.then(() => { throw new Error(`Host exited early: ${errors}`) })])
  const guardianPid = await waitForPid(guardianPidFile)
  host.kill('SIGKILL')
  await closed
  await Promise.all([waitForExit(providerPid), waitForExit(guardianPid)])
})


test('Windows launch snapshot removal waits for a temporary exclusive file handle', {
  skip: process.platform !== 'win32', timeout: 45000,
}, async (t) => {
  const config = await prepareRuntimeConfig(fakeConfig())
  const snapshot = await createLaunchSnapshot(config.providers.get('test.fake-capability'))
  t.after(() => snapshot.dispose())
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', [
    '$file = [System.IO.File]::Open($env:OPENADAM_LOCKED_SNAPSHOT, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)',
    "try { [Console]::Out.WriteLine('HELD'); [Console]::Out.Flush(); [System.Threading.Thread]::Sleep(350) } finally { $file.Dispose() }",
  ].join('; ')], {
    env: { ...process.env, OPENADAM_LOCKED_SNAPSHOT: snapshot.command },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  t.after(() => { if (holder.exitCode === null) holder.kill('SIGKILL') })
  let stderr = ''
  holder.stderr.on('data', (bytes) => { stderr += bytes })
  const closed = new Promise((resolve, reject) => { holder.once('close', resolve); holder.once('error', reject) })
  await new Promise((resolve, reject) => {
    let text = ''
    holder.stdout.on('data', (bytes) => { text += bytes; if (text.includes('HELD')) resolve() })
    closed.then((code) => reject(new Error(`File holder exited before readiness (${code}): ${stderr}`)), reject)
  })
  await snapshot.dispose()
  assert.equal(await closed, 0, stderr)
  await assert.rejects(access(snapshot.rootPath), { code: 'ENOENT' })
})
