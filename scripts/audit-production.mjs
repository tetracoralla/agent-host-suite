import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const npm = process.env.npm_execpath
if (npm === undefined) throw new Error('Run this check through npm run audit:production')
const packages = await readdir(join(root, 'packages'), { withFileTypes: true })
const roots = [root, ...packages.filter((entry) => entry.isDirectory())
  .map((entry) => join(root, 'packages', entry.name))]
for (const directory of roots) {
  const lock = await stat(join(directory, 'package-lock.json')).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (lock === null) continue
  console.log(`Auditing production dependencies: ${relative(root, directory) || '.'}`)
  // Workspace audit uses the root lock. Distribution builders also consume
  // standalone package locks, which must be inspected in their own context.
  const result = spawnSync(process.execPath, [npm, 'audit',
    ...(directory === root ? [] : ['--workspaces=false']),
    '--omit=dev', '--audit-level=high', '--registry=https://registry.npmjs.org',
  ], { cwd: directory, stdio: 'inherit', timeout: 60_000 })
  if (result.error) throw result.error
  if (result.status !== 0) process.exitCode = result.status ?? 1
}
