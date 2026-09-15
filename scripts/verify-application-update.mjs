import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyDirectorySwapUpdate, verifyReplacedApplication } from '../src/application-update.mjs'

const fixture = process.argv.includes('--fixture')
if (fixture !== true) {
  process.stdout.write(`Usage: node scripts/verify-application-update.mjs --fixture

This verifies the application replacement engine with an isolated directory swap.
It does not claim that a macOS /Applications replace or Windows Programs replace passed.

On a Mac, after downloading an unsigned DMG:
  1. Compare SHA-256 with SHA256SUMS
  2. Control-click Open (Gatekeeper)
  3. Run: agent-host app update --json
Native replacement is not simulated here.
`)
  process.exit(2)
}

const root = await mkdtemp(join(tmpdir(), 'agent-host-app-update-'))
const current = join(root, 'current')
const staged = join(root, 'staged')
await mkdir(join(current, 'bin'), { recursive: true })
await mkdir(join(staged, 'bin'), { recursive: true })
const currentScript = '#!/bin/sh\necho 0.2.0\n'
const stagedScript = '#!/bin/sh\necho 0.2.1\n'
await writeFile(join(current, 'bin/agent-host'), currentScript, { mode: 0o755 })
await writeFile(join(staged, 'bin/agent-host'), stagedScript, { mode: 0o755 })
await chmod(join(current, 'bin/agent-host'), 0o755)
await chmod(join(staged, 'bin/agent-host'), 0o755)
const applied = await applyDirectorySwapUpdate({ currentRoot: current, stagedRoot: staged })
const verified = await verifyReplacedApplication({
  root: applied.currentRoot,
  expectedVersion: '0.2.1',
  command: join(applied.currentRoot, 'bin/agent-host'),
  args: [],
})
process.stdout.write(`${JSON.stringify({ status: 'ok', applied, verified }, null, 2)}\n`)
