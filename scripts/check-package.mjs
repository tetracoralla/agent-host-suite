import { execFile, spawnSync } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const npmExecPath = process.env.npm_execpath
if (!npmExecPath) throw new Error('npm_execpath is required to check the package portably')
const temporary = await mkdtemp(join(tmpdir(), 'agent-host-package-'))
try {
  const packed = await execFileAsync(process.execPath, [npmExecPath, 'pack', '--json', '--pack-destination', temporary], { cwd: root, maxBuffer: 4 * 1024 * 1024 })
  const report = JSON.parse(packed.stdout)[0]
  const names = new Set(report.files.map((item) => item.path))
  for (const required of ['bin/agent-host.mjs', 'src/cli.mjs', 'src/service-recovery.mjs', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt', 'README.md', 'README.zh-CN.md', 'docs/WINDOWS.md', 'docs/WINDOWS.zh-CN.md', 'docs/TRACE_PLANE.md', 'docs/TRACE_PLANE.zh-CN.md', 'catalog/profiles/standard.json', 'skills/agent-host-operations/SKILL.md', 'skills/agent-host-operations/scripts/agent-host', 'skills/agent-host-operations/scripts/agent-host.cmd']) {
    if (!names.has(required)) throw new Error(`package is missing ${required}`)
  }
  const packagePath = join(temporary, report.filename)
  const installRoot = join(temporary, 'install')
  await execFileAsync(process.execPath, [npmExecPath, 'install', '--prefix', installRoot, packagePath], { maxBuffer: 4 * 1024 * 1024 })
  const binaryShim = join(installRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'agent-host.cmd' : 'agent-host')
  await access(binaryShim)
  const installedEntry = join(installRoot, 'node_modules', '@openadam', 'agent-host-suite', 'bin', 'agent-host.mjs')
  const help = await execFileAsync(process.execPath, [installedEntry, '--help'])
  if (!help.stdout.includes('agent-host setup') || !help.stdout.includes('agent-host service recover --recovery ID --manifest-sha256 SHA256')) {
    throw new Error('installed CLI help is unavailable')
  }
  const installedCliModule = join(installRoot, 'node_modules', '@openadam', 'agent-host-suite', 'src', 'cli.mjs')
  const installedServiceModule = join(installRoot, 'node_modules', '@openadam', 'agent-host-suite', 'src', 'service.mjs')
  const installedRecoveryModule = join(installRoot, 'node_modules', '@openadam', 'agent-host-suite', 'src', 'service-recovery.mjs')
  await execFileAsync(process.execPath, ['--input-type=module', '-e', `const cli = await import(${JSON.stringify(pathToFileURL(installedCliModule).href)}); const service = await import(${JSON.stringify(pathToFileURL(installedServiceModule).href)}); const recovery = await import(${JSON.stringify(pathToFileURL(installedRecoveryModule).href)}); if (typeof cli.main !== 'function' || typeof service.restoreServiceRecoveryBundle !== 'function' || typeof service.retainedLaunchAgentProgram !== 'function' || typeof recovery.rebindServiceRecoveryPartialRestore !== 'function') process.exit(2); if (service.retainedLaunchAgentProgram(Buffer.from('<plist version="1.0"><dict><key>Program</key><string>/opt/node</string></dict></plist>')) !== '/opt/node') process.exit(3); try { service.retainedLaunchAgentProgram(Buffer.from('<plist version="1.0"><dict><key>ProgramArguments</key><array><dict><key>Program</key><string>/opt/nested</string></dict></array></dict></plist>')); process.exit(4) } catch (error) { if (error.code !== 'SERVICE_RECOVERY_BUNDLE_INVALID') process.exit(5) }`])
  const isolatedRecoveryState = join(temporary, 'isolated-recovery-state')
  const missingRecovery = spawnSync(process.execPath, [
    installedEntry,
    'service', 'recover',
    '--recovery', 'service-recovery-v2-00000000-0000-4000-8000-000000000000',
    '--manifest-sha256', `sha256:${'0'.repeat(64)}`,
    '--state-root', isolatedRecoveryState,
    '--json',
  ], { encoding: 'utf8' })
  if (missingRecovery.status !== 1 || JSON.parse(missingRecovery.stderr).error.code !== 'SERVICE_RECOVERY_STATE_INVALID') {
    throw new Error('installed CLI service recovery route is unavailable')
  }
  await access(isolatedRecoveryState).then(
    () => { throw new Error('installed CLI service recovery created an unknown state root') },
    (error) => { if (error.code !== 'ENOENT') throw error },
  )
  console.log(JSON.stringify({ package: report.id, files: report.files.length, packedBytes: report.size, installedHelp: 'ok', installedRecoveryRoute: 'ok', installedRecoveryVerification: 'ok' }))
} finally {
  await rm(temporary, { recursive: true, force: true })
}
