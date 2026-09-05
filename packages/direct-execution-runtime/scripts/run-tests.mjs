import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const tests = readdirSync(new URL('../test/', import.meta.url))
  .filter((name) => name.endsWith('.test.mjs')).sort()
  .map((name) => fileURLToPath(new URL(`../test/${name}`, import.meta.url)))
// Keep each test's explicit concurrency/cancellation workload. Independent
// Windows files must not compete for cold compiler/ACL subprocess resources
// while asserting transport errors inside a bounded request deadline.
const result = spawnSync(process.execPath, [
  '--test', '--test-timeout=180000',
  ...(process.platform === 'win32' ? ['--test-concurrency=1'] : []), ...tests,
], { stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
