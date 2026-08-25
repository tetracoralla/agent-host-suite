import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))

async function modules(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await modules(path))
    else if (entry.name.endsWith('.mjs')) result.push(path)
  }
  return result
}

const files = [...await modules(join(root, 'src')), ...await modules(join(root, 'scripts'))]
for (const file of files) await execFileAsync(process.execPath, ['--check', file])
console.log(`syntax passed for ${files.length} modules`)
