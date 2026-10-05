import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

const childSource = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
const [root, name, storeUrl] = process.argv.slice(1);
const original = fs.readFileSync;
let stopped = false;
fs.readFileSync = function(path, ...args) {
  const result = original(path, ...args);
  if (!stopped && path === join(root, 'coordinator.lock')) {
    stopped = true;
    fs.writeFileSync(join(root, 'observed-' + name), 'yes');
    while (!fs.existsSync(join(root, 'release-' + name)))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return result;
};
syncBuiltinESMExports();
try {
  const { Store } = await import(storeUrl);
  const store = new Store(root);
  fs.writeFileSync(join(root, 'result-' + name), 'acquired');
  while (!fs.existsSync(join(root, 'done')))
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  store.close();
} catch (error) {
  fs.writeFileSync(join(root, 'result-' + name), error.code ?? error.message);
}
`

async function waitFor(predicate) {
  const deadline = Date.now() + 10_000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Process did not reach the recovery barrier')
    await delay(10)
  }
}

test('concurrent stale coordinator recovery preserves one owner and crash releases the lease', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'procedure-store-recovery-'))
  const children = []
  t.after(async () => {
    await Promise.all(children.map((child) => new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve()
      child.once('exit', resolve)
      child.kill('SIGKILL')
    })))
    await rm(root, { recursive: true, force: true })
  })
  // A real exited process avoids assumptions about an arbitrary PID being dead.
  const exited = spawn(process.execPath, ['-e', ''])
  await new Promise((resolve) => exited.once('exit', resolve))
  await writeFile(join(root, 'coordinator.lock'), JSON.stringify({ pid: exited.pid, owner: 'dead-owner' }))
  const launch = (name) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource, root, name, new URL('../src/store.mjs', import.meta.url).href], { stdio: 'ignore' })
    children.push(child)
    return child
  }
  const exists = (name) => existsSync(join(root, name))
  const first = launch('a')
  await waitFor(() => exists('observed-a'))
  launch('b')
  await waitFor(() => exists('observed-b') || exists('result-b'))
  await writeFile(join(root, 'release-a'), '')
  await waitFor(() => exists('result-a'))
  await writeFile(join(root, 'release-b'), '')
  await waitFor(() => exists('result-b'))
  assert.equal(await readFile(join(root, 'result-a'), 'utf8'), 'acquired')
  assert.equal(await readFile(join(root, 'result-b'), 'utf8'), 'STORE_LOCKED')
  assert.equal(JSON.parse(await readFile(join(root, 'coordinator.lock'), 'utf8')).pid, first.pid)
  await new Promise((resolve) => { first.once('exit', resolve); first.kill('SIGKILL') })
  const { Store } = await import('../src/store.mjs')
  const recovered = new Store(root)
  assert.equal(JSON.parse(await readFile(join(root, 'coordinator.lock'), 'utf8')).pid, process.pid)
  recovered.close()
})
