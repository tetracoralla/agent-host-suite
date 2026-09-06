import { createInterface } from 'node:readline'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const mode = process.argv[2]
const filePath = join(process.env.CODEX_HOME, 'config.toml')
let config = { plugins: { 'fixture@local': { enabled: true } }, preferences: { fixture: 'unchanged' } }
const fingerprint = () => 'sha256:' + createHash('sha256').update(JSON.stringify(config)).digest('hex')
let currentVersion = fingerprint()
async function refresh() {
  try { config = JSON.parse(await readFile(filePath, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  currentVersion = fingerprint()
}
if (process.env.CODEX_CONFIG_TEST_TRACE) await appendFile(process.env.CODEX_CONFIG_TEST_TRACE, JSON.stringify({ pid: process.pid }) + '\n')
const send = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\n')
createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line)
  if (mode === 'stall') return
  if (process.env.CODEX_CONFIG_TEST_TRACE) await appendFile(process.env.CODEX_CONFIG_TEST_TRACE, JSON.stringify({ method: message.method ?? null, error: message.error ?? null }) + '\n')
  if (message.method === 'initialized') return
  if (message.method === 'initialize') { send(message.id, { userAgent: 'fixture' }); return }
  if (mode === 'stall-read' && message.method === 'config/read') return
  if (message.method === undefined) return
  if (mode === 'malformed') { process.stdout.write('private output that must not be exposed\n'); return }
  if (mode === 'invalid-utf8') { process.stdout.write(Buffer.from([0xff, 10])); return }
  if (mode === 'overflow') { process.stdout.write('x'.repeat(8192)); return }
  if (mode === 'exit') { process.exit(0) }
  if (mode === 'interactive') process.stdout.write(JSON.stringify({ id: 'unexpected-input', method: 'item/tool/requestUserInput', params: { fixture: true } }) + '\n')
  if (message.method === 'config/read') {
    await refresh()
    const user = { name: { type: 'user', file: filePath }, version: currentVersion, config }
    send(message.id, { layers: mode === 'no-user' ? [] : mode === 'two-users' ? [user, user] : [user] })
    return
  }
  if (message.method === 'config/batchWrite') {
    await refresh()
    if (mode === 'rpc-error') {
      process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32600, message: 'private secret configuration detail' } }) + '\n')
      return
    }
    if (message.params.expectedVersion !== currentVersion) {
      process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32600, data: { config_write_error_code: 'configVersionConflict' }, message: 'private configuration value' } }) + '\n')
      return
    }
    if (message.params.reloadUserConfig !== false || message.params.filePath !== filePath) throw new Error('Unexpected mutation scope')
    for (const edit of message.params.edits) {
      const keys = [...edit.keyPath.matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map((part) => JSON.parse(part[0]))
      if (![2, 3].includes(keys.length)) throw new Error('Invalid quoted config key path')
      let parent = config
      for (const key of keys.slice(0, -1)) {
        if (!Object.hasOwn(parent, key)) Object.defineProperty(parent, key, { value: {}, enumerable: true, configurable: true, writable: true })
        parent = parent[key]
      }
      if (edit.value === null) delete parent[keys.at(-1)]
      else Object.defineProperty(parent, keys.at(-1), { value: edit.value, enumerable: true, configurable: true, writable: true })
    }
    currentVersion = fingerprint()
    await writeFile(filePath, JSON.stringify(config) + '\n', { mode: 0o600 })
    send(message.id, { status: 'ok', version: currentVersion, filePath })
    return
  }
  throw new Error('Unexpected native API method')
})
