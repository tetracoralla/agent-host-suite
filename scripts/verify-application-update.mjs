import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { applyDirectorySwapUpdate, verifyReplacedApplication } from '../src/application-update.mjs'

const fixture = process.argv.includes('--fixture')
if (fixture !== true) {
  process.stdout.write(`Usage: node scripts/verify-application-update.mjs --fixture

This verifies the application replacement engine with an isolated directory swap.
It does not claim that a macOS /Applications replace or Windows Programs replace passed.

On a Mac, after downloading an unsigned DMG:
  1. Compare SHA-256 with SHA256SUMS
  2. Try to open the app; if blocked, System Settings → Privacy & Security → Open Anyway
  3. Run: agent-host app update --json
Native replacement is not simulated here.
`)
  process.exit(2)
}

const root = await mkdtemp(join(tmpdir(), 'agent-host-app-update-'))
const current = join(root, 'current')
const staged = join(root, 'staged')

async function writeVersionApp(appRoot, version) {
  const cli = join(appRoot, 'app', 'bin', 'agent-host.mjs')
  await mkdir(dirname(cli), { recursive: true })
  await writeFile(cli, `process.stdout.write(${JSON.stringify(version)} + '\\n')\n`)
  if (process.platform === 'win32') {
    const cmd = join(appRoot, 'bin', 'agent-host.cmd')
    await mkdir(dirname(cmd), { recursive: true })
    await writeFile(cmd, `@echo off\r\n"${process.execPath}" "%~dp0..\\app\\bin\\agent-host.mjs" %*\r\n`)
  } else {
    const shim = join(appRoot, 'bin', 'agent-host')
    await mkdir(dirname(shim), { recursive: true })
    await writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`, { mode: 0o755 })
    await chmod(shim, 0o755)
  }
}

await writeVersionApp(current, '0.2.0')
await writeVersionApp(staged, '0.2.1')
const applied = await applyDirectorySwapUpdate({ currentRoot: current, stagedRoot: staged })
const verified = await verifyReplacedApplication({
  root: applied.currentRoot,
  expectedVersion: '0.2.1',
})
process.stdout.write(`${JSON.stringify({ status: 'ok', applied, verified }, null, 2)}\n`)
