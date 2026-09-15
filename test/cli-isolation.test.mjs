import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createIsolatedCli,
  injectStateRoot,
  isolatedCliInvocation,
  runIsolatedCli,
} from './cli-isolation.mjs'

const FEATURED_PROBES = [
  ['setup', '--profile', 'featured', '--no-service', '--dry-run', '--json'],
  ['tools', 'set', '--profile', 'featured', '--json'],
  ['tools', 'set', '--profile', 'not-a-catalog', '--json'],
  ['doctor', '--featured-readiness', '--json'],
  ['repair', '--json'],
]

const MONITORING_AND_PAUSE_PROBES = [
  ['observability', 'disable', '--json'],
  ['observability', 'enable', '--json'],
  ['tools', 'pause', '--json'],
  ['tools', 'resume', '--json'],
]

async function listFiles(root) {
  const output = []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) output.push(...await listFiles(path))
    else output.push(path)
  }
  return output.sort()
}

async function snapshot(root) {
  const files = await listFiles(root)
  if (files === null) return null
  const records = []
  for (const path of files) {
    const info = await stat(path)
    records.push({
      path: path.slice(root.length),
      size: info.size,
      contents: await readFile(path, 'utf8'),
    })
  }
  return records
}

async function createTrap(t, { installed }) {
  const home = await mkdtemp(join(tmpdir(), 'agent-host-real-home-trap-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const stateRoot = join(home, '.local', 'state', 'openadam', 'agent-host-suite')
  const hostFiles = {
    claude: join(home, '.claude.json'),
    zcode: join(home, '.zcode', 'cli', 'config.json'),
    codex: join(home, '.codex', 'config.toml'),
  }
  if (installed) {
    await mkdir(stateRoot, { recursive: true, mode: 0o700 })
    await writeFile(join(stateRoot, 'canary.txt'), 'real-install-canary\n', { mode: 0o600 })
    await writeFile(join(stateRoot, 'state.json'), `${JSON.stringify({ trap: true, profile: 'featured' })}\n`, { mode: 0o600 })
    await mkdir(join(home, '.zcode', 'cli'), { recursive: true, mode: 0o700 })
    await mkdir(join(home, '.codex'), { recursive: true, mode: 0o700 })
    await writeFile(hostFiles.claude, '{"mcpServers":{"trap":true}}\n', { mode: 0o600 })
    await writeFile(hostFiles.zcode, '{"mcp":{"servers":{"trap":true}}}\n', { mode: 0o600 })
    await writeFile(hostFiles.codex, 'plugins = { trap = true }\n', { mode: 0o600 })
  }
  return { home, stateRoot, hostFiles }
}

function assertFeaturedProbesInjectStateRoot(isolated) {
  for (const args of FEATURED_PROBES) {
    const invocation = isolatedCliInvocation(args, isolated, {
      AGENT_HOST_STATE_ROOT: join(isolated.home, 'poison-real-state'),
    })
    const stateRootIndex = invocation.argv.indexOf('--state-root')
    assert.notEqual(stateRootIndex, -1, `${args.join(' ')} must pass --state-root`)
    assert.equal(invocation.argv[stateRootIndex + 1], isolated.stateRoot)
    assert.equal(invocation.env.HOME, isolated.home)
    assert.equal(invocation.env.AGENT_HOST_STATE_ROOT, join(isolated.home, 'poison-real-state'))
  }
  const listed = injectStateRoot(['profiles', 'list', '--json'], isolated.stateRoot)
  assert.equal(listed.includes('--state-root'), false)
}

function cliErrorCode(result) {
  assert.equal(result.stderr.trim().startsWith('{'), true, `CLI stderr was not JSON: ${result.stderr}`)
  return JSON.parse(result.stderr).error.code
}

async function runFeaturedProbes(isolated, poisonStateRoot) {
  return FEATURED_PROBES.map((args) => runIsolatedCli(args, isolated, {
    env: { AGENT_HOST_STATE_ROOT: poisonStateRoot },
  }))
}

test('CLI isolation injects a test state root instead of relying on AGENT_HOST_STATE_ROOT', async (t) => {
  const isolated = await createIsolatedCli(t)
  assertFeaturedProbesInjectStateRoot(isolated)
})

test('featured CLI probes do not touch a real install when one exists', async (t) => {
  const trap = await createTrap(t, { installed: true })
  const beforeState = await snapshot(trap.stateRoot)
  const beforeHome = await snapshot(trap.home)
  const isolated = await createIsolatedCli(t)
  assertFeaturedProbesInjectStateRoot(isolated)
  const results = await runFeaturedProbes(isolated, trap.stateRoot)
  assert.equal(cliErrorCode(results[0]), 'RELEASE_UNBOUND')
  assert.equal(cliErrorCode(results[1]), 'NOT_INSTALLED')
  assert.equal(cliErrorCode(results[2]), 'PROFILE_UNKNOWN')
  assert.equal(cliErrorCode(results[3]), 'NOT_INSTALLED')
  assert.equal(cliErrorCode(results[4]), 'NOT_INSTALLED')
  assert.deepEqual(await snapshot(trap.stateRoot), beforeState)
  assert.deepEqual(await snapshot(trap.home), beforeHome)
})

test('featured CLI probes do not create a real install when none exists', async (t) => {
  const trap = await createTrap(t, { installed: false })
  const isolated = await createIsolatedCli(t)
  assertFeaturedProbesInjectStateRoot(isolated)
  const results = await runFeaturedProbes(isolated, trap.stateRoot)
  assert.equal(cliErrorCode(results[0]), 'RELEASE_UNBOUND')
  assert.equal(cliErrorCode(results[1]), 'NOT_INSTALLED')
  assert.equal(cliErrorCode(results[2]), 'PROFILE_UNKNOWN')
  assert.equal(cliErrorCode(results[3]), 'NOT_INSTALLED')
  assert.equal(cliErrorCode(results[4]), 'NOT_INSTALLED')
  await assert.rejects(() => readdir(trap.stateRoot), (error) => error.code === 'ENOENT')
  await assert.rejects(() => readFile(trap.hostFiles.claude, 'utf8'), (error) => error.code === 'ENOENT')
  await assert.rejects(() => readFile(trap.hostFiles.codex, 'utf8'), (error) => error.code === 'ENOENT')
})

test('monitoring and pause CLI probes stay inside the test state root', async (t) => {
  const trap = await createTrap(t, { installed: true })
  const beforeState = await snapshot(trap.stateRoot)
  const beforeHome = await snapshot(trap.home)
  const isolated = await createIsolatedCli(t)
  for (const args of MONITORING_AND_PAUSE_PROBES) {
    const invocation = isolatedCliInvocation(args, isolated, {
      AGENT_HOST_STATE_ROOT: trap.stateRoot,
    })
    assert.equal(invocation.argv[invocation.argv.indexOf('--state-root') + 1], isolated.stateRoot)
    const result = runIsolatedCli(args, isolated, { env: { AGENT_HOST_STATE_ROOT: trap.stateRoot } })
    assert.equal(cliErrorCode(result), 'NOT_INSTALLED')
  }
  assert.deepEqual(await snapshot(trap.stateRoot), beforeState)
  assert.deepEqual(await snapshot(trap.home), beforeHome)
})
