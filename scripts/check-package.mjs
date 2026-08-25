import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const temporary = await mkdtemp(join(tmpdir(), 'agent-host-package-'))
try {
  const packed = await execFileAsync('npm', ['pack', '--json', '--pack-destination', temporary], { cwd: root, maxBuffer: 4 * 1024 * 1024 })
  const report = JSON.parse(packed.stdout)[0]
  const names = new Set(report.files.map((item) => item.path))
  for (const required of ['bin/agent-host.mjs', 'src/cli.mjs', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt', 'README.md', 'catalog/profiles/standard.json']) {
    if (!names.has(required)) throw new Error(`package is missing ${required}`)
  }
  const packagePath = join(temporary, report.filename)
  const installRoot = join(temporary, 'install')
  await execFileAsync('npm', ['install', '--prefix', installRoot, packagePath], { maxBuffer: 4 * 1024 * 1024 })
  const binary = join(installRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'agent-host.cmd' : 'agent-host')
  const help = await execFileAsync(binary, ['--help'])
  if (!help.stdout.includes('agent-host setup')) throw new Error('installed CLI help is unavailable')
  console.log(JSON.stringify({ package: report.id, files: report.files.length, packedBytes: report.size, installedHelp: 'ok' }))
} finally {
  await rm(temporary, { recursive: true, force: true })
}
