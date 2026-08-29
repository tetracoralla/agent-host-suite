import { execFile } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const npmExecPath = process.env.npm_execpath
if (!npmExecPath) throw new Error('npm_execpath is required to check the package portably')
const temporary = await mkdtemp(join(tmpdir(), 'agent-host-package-'))
try {
  const packed = await execFileAsync(process.execPath, [npmExecPath, 'pack', '--json', '--pack-destination', temporary], { cwd: root, maxBuffer: 4 * 1024 * 1024 })
  const report = JSON.parse(packed.stdout)[0]
  const names = new Set(report.files.map((item) => item.path))
  for (const required of ['bin/agent-host.mjs', 'src/cli.mjs', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt', 'README.md', 'catalog/profiles/standard.json', 'skills/agent-host-operations/SKILL.md', 'skills/agent-host-operations/scripts/agent-host']) {
    if (!names.has(required)) throw new Error(`package is missing ${required}`)
  }
  const packagePath = join(temporary, report.filename)
  const installRoot = join(temporary, 'install')
  await execFileAsync(process.execPath, [npmExecPath, 'install', '--prefix', installRoot, packagePath], { maxBuffer: 4 * 1024 * 1024 })
  const binaryShim = join(installRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'agent-host.cmd' : 'agent-host')
  await access(binaryShim)
  const installedEntry = join(installRoot, 'node_modules', '@openadam', 'agent-host-suite', 'bin', 'agent-host.mjs')
  const help = await execFileAsync(process.execPath, [installedEntry, '--help'])
  if (!help.stdout.includes('agent-host setup')) throw new Error('installed CLI help is unavailable')
  console.log(JSON.stringify({ package: report.id, files: report.files.length, packedBytes: report.size, installedHelp: 'ok' }))
} finally {
  await rm(temporary, { recursive: true, force: true })
}
