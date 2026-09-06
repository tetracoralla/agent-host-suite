import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { withCodexConfiguration } from '../src/hosts/codex-config.mjs'

const fixture = fileURLToPath(new URL('./fixtures/codex-config-server.mjs', import.meta.url))
async function optionsFor(t, mode = 'normal') {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-codex-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { configRoot: root, prefixArguments: [fixture, mode], timeoutMs: 2000,
    env: { ...process.env, CODEX_CONFIG_TEST_TRACE: join(root, 'requests.jsonl') } }
}

test('native configuration client scopes exact-key writes to the observed user layer and rejects stale versions', async (t) => {
  const options = await optionsFor(t)
  await withCodexConfiguration(process.execPath, options, async (client) => {
    const before = await client.read()
    const changed = { enabled: false, fixture: 'spaces and "quotes"\nnext line' }
    const keys = ['plugins', 'fixture.with.dots@local']
    await client.write(before, [{ keys, value: changed }])
    await assert.rejects(client.write(before, [{ keys, value: null }]), { code: 'CODEX_CONFIG_CHANGED' })
    const next = await client.read()
    assert.deepEqual(next.config.plugins[keys[1]], changed)
    assert.equal(next.config.preferences.fixture, 'unchanged')
    await client.write(next, [{ keys, value: null }])
    assert.equal(Object.hasOwn((await client.read()).config.plugins, keys[1]), false)
    await assert.rejects(client.write({ ...next, filePath: join(options.configRoot, 'other.toml') }, [{ keys, value: {} }]), { code: 'CODEX_CONFIG_PROTOCOL_INVALID' })
    await assert.rejects(client.write(next, [{ keys: ['model', 'anything'], value: {} }]), { code: 'CODEX_CONFIG_PROTOCOL_INVALID' })
  })
  const requests = (await readFile(options.env.CODEX_CONFIG_TEST_TRACE, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(requests.some((item) => item.method?.startsWith('thread/') || item.method?.startsWith('turn/')), false)
  assert.equal(requests.filter((item) => item.method === 'config/batchWrite').length, 3)
})

test('native configuration rejects interactive requests without forwarding them or executing tools', async (t) => {
  const options = await optionsFor(t, 'interactive')
  await withCodexConfiguration(process.execPath, options, async (client) => { await client.read() })
  const trace = await readFile(options.env.CODEX_CONFIG_TEST_TRACE, 'utf8')
  assert.match(trace, /Interactive requests are not supported/u)
})

test('native configuration handles malformed, oversized, missing-scope and failed responses without exposing raw output', async (t) => {
  for (const [mode, code] of [
    ['malformed', 'CODEX_CONFIG_PROTOCOL_INVALID'], ['invalid-utf8', 'CODEX_CONFIG_PROTOCOL_INVALID'],
    ['overflow', 'CODEX_CONFIG_LIMIT'], ['exit', 'CODEX_CONFIG_CLOSED'],
    ['no-user', 'CODEX_CONFIG_PROTOCOL_INVALID'], ['two-users', 'CODEX_CONFIG_PROTOCOL_INVALID'],
    ['rpc-error', 'CODEX_CONFIG_REQUEST_FAILED'],
  ]) {
    const options = await optionsFor(t, mode)
    await assert.rejects(withCodexConfiguration(process.execPath, { ...options, maxMessageBytes: 4096 }, async (client) => {
      const before = await client.read()
      await client.write(before, [{ keys: ['plugins', 'fixture@local'], value: { enabled: false } }])
    }), (error) => error.code === code && !JSON.stringify(error).includes('private secret') && !error.message.includes('private output'))
  }
})

test('native configuration deadlines, cancellation and missing executables settle and close their owned process', async (t) => {
  const options = await optionsFor(t, 'stall-read')
  await assert.rejects(withCodexConfiguration(process.execPath, { ...options, timeoutMs: 1000 }, (client) => client.read()), { code: 'CODEX_CONFIG_TIMEOUT' })
  const timeoutPid = JSON.parse((await readFile(options.env.CODEX_CONFIG_TEST_TRACE, 'utf8')).split('\n')[0]).pid
  assert.throws(() => process.kill(timeoutPid, 0), { code: 'ESRCH' })
  const cancelledOptions = await optionsFor(t, 'stall-read')
  const controller = new AbortController()
  const work = withCodexConfiguration(process.execPath, { ...cancelledOptions, signal: controller.signal }, async (client) => {
    const pending = client.read()
    controller.abort()
    return pending
  })
  await assert.rejects(work, { code: 'CODEX_CONFIG_CANCELLED' })
  const cancelledPid = JSON.parse((await readFile(cancelledOptions.env.CODEX_CONFIG_TEST_TRACE, 'utf8')).split('\n')[0]).pid
  assert.throws(() => process.kill(cancelledPid, 0), { code: 'ESRCH' })
  await assert.rejects(withCodexConfiguration(join(options.configRoot, 'absent-executable'), options, async () => {}), { code: 'CODEX_CONFIG_UNAVAILABLE' })
})
