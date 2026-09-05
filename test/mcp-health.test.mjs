import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { probeMcpTools, probeMcpToolsFirstAndRepeat } from '../src/mcp-health.mjs'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))

async function waitForPidFile(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await delay(10)
  }
  throw new Error('health deadline fixture did not publish its descendant PID')
}

test('release probing separates first-launch allowance from the declared repeat budget', async () => {
  const time = [100, 18100, 20000, 20400]
  const timeouts = []
  const result = await probeMcpToolsFirstAndRepeat({ healthTimeoutMs: 30000 }, {
    now: () => time.shift(),
    probe: async (component) => {
      timeouts.push(component.healthTimeoutMs)
      return { status: 'ok', tools: ['example'], server: { name: 'fixture', version: '1' } }
    },
  })

  assert.deepEqual(timeouts, [60000, 30000])
  assert.equal(result.firstLaunchMs, 18000)
  assert.equal(result.repeatLaunchMs, 400)
  assert.deepEqual(result.repeat.tools, ['example'])
})

test('release probing retains the default ordinary health budget', async () => {
  const timeouts = []
  await probeMcpToolsFirstAndRepeat({}, {
    now: () => 0,
    probe: async (component) => {
      timeouts.push(component.healthTimeoutMs)
      return { status: 'ok', tools: [], server: null }
    },
  })

  assert.deepEqual(timeouts, [60000, 10000])
})

test('release probing rejects a catalog that changes after first launch', async () => {
  let launch = 0
  await assert.rejects(
    () => probeMcpToolsFirstAndRepeat({}, {
      now: () => 0,
      probe: async () => ({
        status: 'ok',
        tools: launch++ === 0 ? ['first'] : ['second'],
        server: { name: 'fixture', version: '1' },
      }),
    }),
    (error) => error.code === 'TOOL_HEALTH_CATALOG_UNSTABLE',
  )
})

test('release probing rejects same-name schema drift after first launch', async () => {
  let launch = 0
  await assert.rejects(
    () => probeMcpToolsFirstAndRepeat({}, {
      now: () => 0,
      probe: async () => ({
        status: 'ok',
        tools: ['same-name'],
        server: { name: 'fixture', version: '1' },
        catalogSha256: launch++ === 0 ? 'sha256:first' : 'sha256:second',
      }),
    }),
    (error) => error.code === 'TOOL_HEALTH_CATALOG_UNSTABLE',
  )
})

test('Host-owned MCP transport completes a real typed health probe', async () => {
  const providerRoot = resolve(repositoryRoot, 'packages/direct-execution-runtime/test/fixtures/fake-mcp')
  const result = await probeMcpTools({
    command: process.execPath,
    args: [resolve(providerRoot, 'server.mjs')],
    cwd: providerRoot,
    displayName: 'fixture MCP Provider',
    expectedTools: ['echo'],
    healthTimeoutMs: 10_000,
  })
  assert.equal(result.status, 'ok')
  assert.equal(result.tools.includes('echo'), true)
  assert.deepEqual(result.server, { name: 'direct-execution-fake-mcp', version: '0.1.0' })
  assert.match(result.catalogSha256, /^sha256:[0-9a-f]{64}$/u)
})

test('Host MCP health deadline removes a stubborn Provider descendant before rejecting', { skip: process.platform === 'win32' }, async (t) => {
  const providerRoot = await mkdtemp(resolve(tmpdir(), 'agent-host-health-stubborn-'))
  const scriptPath = resolve(providerRoot, 'server.mjs')
  const pidPath = resolve(providerRoot, 'descendant.pid')
  await writeFile(scriptPath, [
    "import { spawn } from 'node:child_process'",
    "import { writeFileSync } from 'node:fs'",
    "const descendant = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
    'writeFileSync(process.argv[2], JSON.stringify({ root: process.pid, descendant: descendant.pid }))',
    "process.on('SIGTERM', () => {})",
    "process.stdin.resume()",
    'setInterval(() => {}, 1000)',
    '',
  ].join('\n'))
  let processRecord
  t.after(async () => {
    if (processRecord !== undefined) {
      try { process.kill(-processRecord.root, 'SIGKILL') } catch {}
    }
    await rm(providerRoot, { recursive: true, force: true })
  })
  const running = probeMcpTools({
    command: process.execPath,
    args: [scriptPath, pidPath],
    cwd: providerRoot,
    displayName: 'stubborn fixture MCP Provider',
    expectedTools: ['echo'],
    healthTimeoutMs: 1_000,
  })
  const rejected = assert.rejects(running, (error) => error.code === 'TOOL_HEALTH_TIMEOUT')
  processRecord = await waitForPidFile(pidPath)
  await rejected
  assert.throws(() => process.kill(processRecord.root, 0), (error) => error.code === 'ESRCH')
  assert.throws(() => process.kill(-processRecord.root, 0), (error) => error.code === 'ESRCH')
  assert.equal(Number.isSafeInteger(processRecord.descendant) && processRecord.descendant > 0, true)
})
