import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { human } from '../src/cli.mjs'
import { listProfileIds } from '../src/profile.mjs'

const cliPath = fileURLToPath(new URL('../bin/agent-host.mjs', import.meta.url))

test('manager --no-open prints a usable local entry before the server closes', { timeout: 15_000 }, async (t) => {
  const child = spawn(process.execPath, [cliPath, 'manager', '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = new Promise((resolve) => child.once('exit', resolve))
  t.after(async () => { child.kill(); await closed })
  const url = await new Promise((resolve, reject) => {
    let output = ''
    child.once('error', reject)
    child.once('exit', () => reject(new Error('Manager closed before publishing its entry')))
    child.stdout.on('data', (chunk) => {
      output += chunk
      if (output.includes('\n')) resolve(output.split('\n')[0])
    })
  })
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/auth\/[A-Za-z0-9_-]+$/u)
  const entry = await fetch(url, { redirect: 'manual' })
  assert.equal(entry.status, 303)
  const page = await fetch(new URL('/', url), { headers: { cookie: entry.headers.get('set-cookie').split(';')[0] } })
  assert.equal(page.status, 200)
  assert.match(await page.text(), /Agent Host/u)
})

test('CLI rejects known options that do not belong to the selected operation', () => {
  const cases = [
    [['profiles', 'list', '--state-root', '/tmp/state'], 'profiles list does not accept --state-root'],
    [['profiles', 'list', '--url', 'https://example.invalid/preview-distribution.json'], 'profiles list does not accept --url'],
    [['tools', 'set', '--tool', 'math-anchor', '--profile', 'featured'], 'tools set requires --tool or --profile, not both'],
    [['tools', 'set'], 'tools set requires --tool or --profile, not both'],
    [['tools', 'pause', '--tool', 'math-anchor'], 'tools pause does not accept --tool'],
    [['tools', 'resume', '--profile', 'standard'], 'tools resume does not accept --profile'],
    [['setup', '--no-host', '--host', 'zcode'], 'setup --no-host cannot be combined with --host'],
    [['profiles'], 'profiles requires an action'],
    [['status', '--deep'], 'status does not accept --deep'],
    [['status', '--quick'], 'status does not accept --quick'],
    [['doctor', '--quick'], 'doctor does not accept --quick'],
    [['doctor', '--featured-readiness', '--deep'], 'doctor --featured-readiness does not accept --deep'],
    [['source', 'status', '--url', 'https://example.invalid/preview-distribution.json'], 'source status does not accept --url'],
    [['source', 'clear', '--url', 'https://example.invalid/preview-distribution.json'], 'source clear does not accept --url'],
    [['source', 'check', '--url', 'https://example.invalid/preview-distribution.json', '--release-manifest', '/tmp/current.json'], 'source check accepts --url or --release-manifest, not both'],
    [['source', 'set'], 'source set requires --url or --release-manifest, not both'],
    [['host', 'status', 'codex', '--skip-agent-apps'], 'host status does not accept --skip-agent-apps'],
    [['component', 'list', '--artifact', '/tmp/private.tar.gz'], 'component list does not accept --artifact'],
    [['component', 'remove', 'private-fixture', '--activate'], 'component remove does not accept --activate'],
    [['component', 'list', '--standalone'], 'component list does not accept --standalone'],
    [['uninstall', '--dry-run'], 'uninstall does not accept --dry-run'],
    [['repair', '--profile', 'featured'], 'repair does not accept --profile'],
    [['update', '--plan-id', 'not-a-digest'], '--plan-id requires a SHA-256 digest'],
    [['service', 'recover', '--recovery', 'invalid', '--manifest-sha256', `sha256:${'0'.repeat(64)}`], 'service recover requires a valid --recovery identity'],
    [['service', 'recover', '--recovery', 'service-recovery-v2-00000000-0000-4000-8000-000000000000', '--manifest-sha256', 'invalid'], 'service recover requires a valid --manifest-sha256 digest'],
    [['service', 'recover', '--recovery', 'service-recovery-v2-00000000-0000-4000-8000-000000000000', '--manifest-sha256', `sha256:${'0'.repeat(64)}`, '--recovery-root', '/tmp/bundle'], 'Unknown argument: --recovery-root'],
  ]
  for (const [arguments_, expected] of cases) {
    const result = spawnSync(process.execPath, [cliPath, ...arguments_], { encoding: 'utf8' })
    assert.equal(result.status, 2)
    assert.equal(result.stderr.trim(), `CLI_USAGE: ${expected}`)
  }
})

test('service recovery rejects missing, empty, and unknown state roots without creating a scaffold', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'agent-host-cli-recovery-preflight-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const identity = 'service-recovery-v2-00000000-0000-4000-8000-000000000000'
  const digest = `sha256:${'0'.repeat(64)}`
  const invoke = (stateRoot) => spawnSync(process.execPath, [
    cliPath,
    'service', 'recover',
    '--recovery', identity,
    '--manifest-sha256', digest,
    '--state-root', stateRoot,
    '--json',
  ], { encoding: 'utf8' })

  const missingRoot = join(parent, 'missing')
  const missing = invoke(missingRoot)
  assert.equal(missing.status, 1)
  assert.equal(JSON.parse(missing.stderr).error.code, 'SERVICE_RECOVERY_STATE_INVALID')
  await assert.rejects(() => access(missingRoot), (error) => error.code === 'ENOENT')

  const emptyRoot = join(parent, 'state-disappeared')
  await mkdir(emptyRoot, { mode: 0o700 })
  await writeFile(join(emptyRoot, 'state.json'), '{}\n', { mode: 0o600 })
  await rm(join(emptyRoot, 'state.json'))
  const empty = invoke(emptyRoot)
  assert.equal(empty.status, 1)
  assert.equal(JSON.parse(empty.stderr).error.code, 'SERVICE_RECOVERY_STATE_INVALID')
  assert.deepEqual(await readdir(emptyRoot), [])

  const unknownRoot = join(parent, 'unknown')
  await mkdir(unknownRoot, { mode: 0o700 })
  await writeFile(join(unknownRoot, 'foreign.txt'), 'not an Agent Host state\n', { mode: 0o600 })
  const before = await readdir(unknownRoot)
  const unknown = invoke(unknownRoot)
  assert.equal(unknown.status, 1)
  assert.equal(JSON.parse(unknown.stderr).error.code, 'SERVICE_RECOVERY_STATE_INVALID')
  assert.deepEqual(await readdir(unknownRoot), before)
})

test('trace CLI rejects ambiguous selection before installed state is read', () => {
  const session = 'a'.repeat(64)
  const cases = [
    [['observability', 'trace-sources'], 'observability trace-sources requires --provider'],
    [['observability', 'export-trace', '--provider', 'zcode', '--output', '/tmp/pack.json'], 'observability export-trace requires --provider, exactly one of --file or --session, and --output'],
    [['observability', 'export-trace', '--provider', 'zcode', '--file', '/tmp/source.jsonl', '--session', session, '--output', '/tmp/pack.json'], 'observability export-trace requires --provider, exactly one of --file or --session, and --output'],
    [['observability', 'export-trace', '--provider', 'zcode', '--file', '/tmp/source.jsonl', '--from-ms', '1', '--output', '/tmp/pack.json'], '--from-ms and --to-ms require --session'],
    [['observability', 'trace-sources', '--provider', 'zcode', '--from-ms', '2', '--to-ms', '1'], '--from-ms must not be after --to-ms'],
  ]
  for (const [arguments_, expected] of cases) {
    const result = spawnSync(process.execPath, [cliPath, ...arguments_], { encoding: 'utf8' })
    assert.equal(result.status, 2)
    assert.equal(result.stderr.trim(), `CLI_USAGE: ${expected}`)
  }
})

test('component preview rejects ambiguous standalone and installed-state selection', () => {
  const result = spawnSync(process.execPath, [cliPath, 'component', 'preview', '--artifact', '/tmp/private.tar.gz', '--license-spdx', 'Apache-2.0', '--standalone', '--state-root', '/tmp/state'], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.equal(result.stderr.trim(), 'CLI_USAGE: component preview cannot combine --standalone with --state-root')
})

test('human storage status reports the current footprint and cleanup candidates', () => {
  const usage = (allocatedBytes, apparentBytes = allocatedBytes) => ({ allocatedBytes, apparentBytes, files: 0, directories: 0 })
  const output = human({
    status: 'ok',
    sections: {
      total: usage(10 * 1024 * 1024, 9 * 1024 * 1024),
      packages: usage(6 * 1024 * 1024),
      hostProjections: usage(32 * 1024),
      downloads: usage(0),
      runtime: usage(1024 * 1024),
      observations: usage(2 * 1024 * 1024),
      context: usage(512 * 1024),
      history: usage(256 * 1024),
      backups: usage(256 * 1024),
    },
    cleanup: { packageVersions: 2, downloads: 1, runtimeConfigs: 3, allocatedBytes: 3 * 1024 * 1024 },
  })
  assert.match(output, /Storage · 10\.0 MiB allocated \(9\.00 MiB apparent\)/u)
  assert.match(output, /Packages 6\.00 MiB/u)
  assert.match(output, /Cleanup · 2 package versions, 1 downloads, 3 runtime configs, 3\.00 MiB eligible/u)
  assert.notEqual(output, 'ok')
})

test('human operations snapshot stays compact and reports monitoring freshness', () => {
  const output = human({
    schemaVersion: 'openadam.agent-host-operations-snapshot.v0.1',
    configured: true,
    environment: { suiteVersion: '0.1.0-dogfood.18', profile: 'local' },
    observability: { enabled: true, refreshedAt: '2026-08-28T12:00:00.000Z' },
    storage: { allocatedBytes: 4 * 1024 * 1024 },
  })
  assert.equal(output, 'Agent Host 0.1.0-dogfood.18 · local · monitoring refreshed 2026-08-28T12:00:00.000Z · 4.00 MiB allocated')
})

test('human observability status renders monitoring state instead of crashing on missing hosts', () => {
  const enabled = human({
    status: 'ok',
    configured: true,
    enabled: true,
    consentedAt: '2026-08-25T16:43:29.188Z',
    latest: { refreshedAt: '2026-08-28T13:43:19.792Z', deployment: {} },
    analysis: { status: 'ok', format: 'context-surface.analysis.v0.1' },
    privacy: { rawPromptStored: false, rawToolArgumentsStored: false, rawToolResultsStored: false, networkUsedByObserver: false, modelCallsByObserver: 0 },
  })
  assert.equal(enabled, 'Observability enabled · last refresh 2026-08-28T13:43:19.792Z.')
  const disabled = human({ status: 'ok', configured: true, enabled: false, consentedAt: null, latest: null, analysis: null, privacy: {} })
  assert.equal(disabled, 'Observability disabled · local data preserved.')
  const notInstalled = human({ status: 'ok', configured: false, enabled: false, privacy: {} })
  assert.equal(notInstalled, 'Observability off · no Agent environment installed.')
})

test('profiles list names the featured admission set without a store', async () => {
  const listed = spawnSync(process.execPath, [cliPath, 'profiles', 'list', '--json'], { encoding: 'utf8' })
  assert.equal(listed.status, 0, listed.stderr)
  const catalog = JSON.parse(listed.stdout)
  assert.equal(catalog.marketplace, false)
  assert.equal(catalog.boundReleaseRequired, true)
  assert.equal(catalog.featuredProfile, 'featured')
  const featured = catalog.profiles.find((profile) => profile.id === 'featured')
  assert.equal(featured.featured, true)
  assert.equal(featured.dogfood, false)
  assert.equal(featured.agentComponents.includes('armorial'), true)
  const dogfood = catalog.profiles.find((profile) => profile.id === 'local-dogfood')
  assert.equal(dogfood.dogfood, true)
  assert.equal(dogfood.featured, false)
  const help = spawnSync(process.execPath, [cliPath, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /agent-host profiles list/u)
  assert.match(help.stdout, /agent-host profiles fetch/u)
  assert.match(help.stdout, /agent-host repair/u)
  assert.match(help.stdout, /agent-host tools pause/u)
  assert.match(help.stdout, /agent-host tools resume/u)
  assert.match(help.stdout, /--plan-id SHA256/u)
  assert.match(help.stdout, /--no-host/u)
  assert.match(help.stdout, /doctor \[--deep \| --featured-readiness\]/u)
  assert.match(help.stdout, /agent-host source status/u)
  assert.match(help.stdout, /agent-host source set/u)
  assert.match(help.stdout, /--profile standard\|featured\|developer\|observability\|local-dogfood/u)
  for (const id of await listProfileIds()) assert.match(help.stdout, new RegExp(`\\b${id}\\b`, 'u'))
  const humanOutput = human(catalog)
  assert.match(humanOutput, /Featured catalog · not a marketplace · bound release required/u)
  assert.match(humanOutput, /public download is not configured/u)
  assert.match(humanOutput, /featured · Featured tools · featured · math-anchor, migratory-time, armorial/u)
  assert.match(humanOutput, /local-dogfood · Standard \+ local tools · dogfood/u)
})

test('human tool-set status reports Host selection rather than Agent-app enablement', () => {
  const output = human({
    schemaVersion: 'openadam.agent-host-tool-set.v0.1',
    status: 'ok',
    activeAgentComponents: ['math-anchor'],
    availableAgentComponents: ['math-anchor', 'migratory-time'],
    inactiveAgentComponents: ['migratory-time'],
    freshSession: { requiredAfterChange: true, currentSessionUptake: 'not-observed' },
  })
  assert.equal(output, 'Agent tools · 1 of 2 selected for new tasks')
  const paused = human({
    schemaVersion: 'openadam.agent-host-tool-set.v0.1',
    status: 'ok',
    paused: true,
    activeAgentComponents: [],
    availableAgentComponents: ['math-anchor', 'migratory-time'],
    inactiveAgentComponents: ['math-anchor', 'migratory-time'],
  })
  assert.equal(paused, 'Agent tools · paused · 0 of 2 projected for new tasks')
})

test('human private component result surfaces a post-commit activity warning without reporting failure', () => {
  const output = human({
    status: 'imported',
    component: { id: 'private-fixture', version: '0.1.0', installed: true, active: false },
    warnings: [{
      code: 'ACTIVITY_LOG_WRITE_FAILED',
      message: 'The private component change succeeded, but its activity entry could not be recorded.',
    }],
  })
  assert.equal(output, 'private-fixture 0.1.0 · imported · activity log unavailable')
})

test('human private component result surfaces pending projection cleanup without reporting failure', () => {
  const output = human({
    status: 'removed',
    component: { id: 'private-fixture', version: null, installed: false, active: false },
    warnings: [{
      code: 'CODEX_PROJECTION_CLEANUP_FAILED',
      message: 'The private component change succeeded, but stale Codex projection cleanup could not be completed.',
    }],
  })
  assert.equal(output, 'private-fixture removed · removed · stale projection cleanup pending')
})

test('human update and repair previews name versions and leave tool versions unchanged for repair', () => {
  assert.equal(
    human({
      status: 'ready', dryRun: true, kind: 'repair', suiteVersion: '0.2.0',
    }),
    'Repair preview · tool versions unchanged · 0.2.0',
  )
  assert.equal(
    human({
      status: 'repaired', suiteVersion: '0.2.0',
    }),
    'Environment repaired · tool versions unchanged · 0.2.0',
  )
  assert.equal(
    human({
      status: 'ready',
      dryRun: true,
      fromVersion: '0.2.0',
      toVersion: '0.2.0',
      source: { kind: 'bundled-catalog' },
      componentChanges: [
        { id: 'agent-tool-observer', action: 'downgrade', currentVersion: '0.6.4', targetVersion: '0.6.0' },
      ],
    }),
    'Update preview · bundled catalog · 0.2.0 · 1 component',
  )
})

test('human service recovery reports observed running and ready state', () => {
  const output = human({
    schemaVersion: 'openadam.agent-host-service-recovery-result.v0.1',
    status: 'restored',
    service: { configured: true, loaded: true, running: true, ready: true },
  })
  assert.equal(output, 'Service restored · running · ready')
})

test('human CLI service rollback and partial recovery failures print the shipped path-free recovery action', () => {
  const identity = 'service-recovery-v2-00000000-0000-4000-8000-000000000000'
  const digest = `sha256:${'0'.repeat(64)}`
  const script = String.raw`
const { main } = await import(process.argv[1])
const { AgentHostError } = await import(process.argv[2])
const identity = process.argv[3]
const digest = process.argv[4]
const code = process.argv[6]
const status = await main([
  'service', 'recover', '--recovery', identity, '--manifest-sha256', digest,
  '--state-root', process.argv[5],
], {
  preflightServiceRecovery: async () => process.argv[5],
  restoreServiceRecoveryBundle: async () => {
    throw new AgentHostError(code, 'automatic recovery failed', {
      recovery: {
        identity,
        manifestSha256: digest,
        action: { command: 'agent-host', arguments: ['service', 'recover', '--recovery', identity, '--manifest-sha256', digest] },
      },
    })
  },
})
process.exitCode = status
`
  const stateRoot = `/tmp/agent-host-cli-recovery-${process.pid}`
  for (const code of ['SERVICE_INSTALL_ROLLBACK_FAILED', 'SERVICE_RECOVERY_FAILED']) {
    const result = spawnSync(process.execPath, [
      '--input-type=module', '-e', script,
      new URL('../src/cli.mjs', import.meta.url).href,
      new URL('../src/errors.mjs', import.meta.url).href,
      identity, digest, stateRoot, code,
    ], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.equal(result.stderr.trim(), `${code}: automatic recovery failed\nRecovery: agent-host service recover --recovery ${identity} --manifest-sha256 ${digest}`)
  }
})
