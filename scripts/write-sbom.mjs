import { execFile } from 'node:child_process'
import { chmod, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const target = process.argv[2]
if (target === undefined) throw new Error('Usage: node scripts/write-sbom.mjs TARGET')
const destination = resolve(target)
const result = await execFileAsync('npm', ['sbom', '--omit=dev', '--sbom-format', 'spdx'], {
  cwd: root,
  maxBuffer: 16 * 1024 * 1024,
})
JSON.parse(result.stdout)
await writeFile(destination, `${result.stdout.trim()}\n`, { mode: 0o600, flag: 'wx' })
await chmod(destination, 0o644)
