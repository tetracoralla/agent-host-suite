import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  FEATURED_READINESS_BOUNDARY,
  FEATURED_READINESS_SCHEMA,
  inspectFeaturedReadiness,
} from '../src/featured-readiness.mjs'
import { human } from '../src/cli.mjs'

const cliPath = fileURLToPath(new URL('../bin/agent-host.mjs', import.meta.url))
const adoptionRoot = fileURLToPath(new URL('../docs/fixtures/adoption/', import.meta.url))
const protocolPath = fileURLToPath(new URL('../docs/ADOPTION_ACCEPTANCE.md', import.meta.url))

function featuredState(overrides = {}) {
  return {
    profile: 'featured',
    channel: 'release',
    components: {
      'math-anchor': { version: '0.4.0', identityFiles: [], plugin: 'math-anchor' },
      'migratory-time': { version: '2.0.0', identityFiles: [], plugin: 'migratory-time' },
      armorial: { version: '0.7.0', identityFiles: [], plugin: 'armorial' },
    },
    agentComponents: ['math-anchor', 'migratory-time', 'armorial'],
    availableAgentComponents: ['math-anchor', 'migratory-time', 'armorial'],
    hosts: {
      codex: { entries: [{ component: 'armorial' }] },
    },
    runtime: { service: null },
    ...overrides,
  }
}

function healthyCodex(entry = {}) {
  return {
    inspectCodexHost: async () => ({
      entries: [{
        component: 'armorial',
        pluginPresent: true,
        pluginEnabled: true,
        installedVersion: '0.7.0',
        requestedVersion: '0.7.0',
        installedIdentityMatched: true,
        cacheStatus: 'matched',
        liveCacheObserved: true,
        ...entry,
      }],
    }),
    inspectClaudeHost: async () => ({ entries: [] }),
    inspectZcodeHost: async () => ({ entries: [] }),
  }
}

test('featured readiness requires the featured working set and does not claim adoption', async () => {
  const ok = await inspectFeaturedReadiness(featuredState(), healthyCodex())
  assert.equal(ok.status, 'ok')
  assert.equal(ok.adoptionEvidence, false)
  assert.equal(ok.schemaVersion, FEATURED_READINESS_SCHEMA)
  assert.equal(ok.assessmentBoundary, FEATURED_READINESS_BOUNDARY)
  assert.equal(ok.checks.find((item) => item.id === 'featured.working-set')?.status, 'ok')
  assert.equal(ok.checks.find((item) => item.id === 'projection.receipt.codex')?.status, 'ok')
  assert.match(human(ok), /Host precondition only/u)
  assert.match(human(ok), /not adoption/u)

  const standard = await inspectFeaturedReadiness(featuredState({ profile: 'standard' }), {
    inspectAgentApps: false,
  })
  assert.equal(standard.status, 'error')
  assert.equal(standard.adoptionEvidence, false)
  assert.match(standard.checks[0].message, /profile is standard/u)

  const inactive = await inspectFeaturedReadiness(
    featuredState({ agentComponents: ['math-anchor', 'migratory-time'] }),
    { inspectAgentApps: false },
  )
  assert.equal(inactive.status, 'error')
  assert.deepEqual(inactive.checks[0].detail.missing, ['armorial'])
})

test('featured readiness treats missing hosts and skipped receipts as Host gaps, not adoption', async () => {
  const none = await inspectFeaturedReadiness(featuredState({ hosts: {} }))
  assert.equal(none.status, 'error')
  assert.equal(none.adoptionEvidence, false)
  assert.equal(none.checks.find((item) => item.id === 'projection.receipt')?.status, 'error')

  const skipped = await inspectFeaturedReadiness(featuredState(), { inspectAgentApps: false })
  assert.equal(skipped.status, 'warning')
  assert.equal(skipped.adoptionEvidence, false)
  assert.equal(skipped.checks.find((item) => item.id === 'projection.receipt')?.detail.skipped, true)

  const broken = await inspectFeaturedReadiness(featuredState(), healthyCodex({
    installedIdentityMatched: false,
    cacheStatus: 'missing',
    pluginPresent: false,
  }))
  assert.equal(broken.status, 'error')
  assert.equal(broken.checks.find((item) => item.id === 'projection.receipt.codex')?.status, 'error')
})

test('featured readiness inspects Claude and ZCode receipts without treating them as session uptake', async () => {
  const state = featuredState({
    hosts: {
      claude: { entries: [{ component: 'armorial' }] },
      zcode: { entries: [{ component: 'armorial' }] },
    },
  })
  const report = await inspectFeaturedReadiness(state, {
    inspectCodexHost: async () => ({ entries: [] }),
    inspectClaudeHost: async () => ({ entries: [{ component: 'armorial', present: true, identityMatched: true }] }),
    inspectZcodeHost: async () => ({ entries: [{ component: 'armorial', present: true, identityMatched: false }] }),
  })
  assert.equal(report.status, 'error')
  assert.equal(report.adoptionEvidence, false)
  assert.equal(report.checks.find((item) => item.id === 'projection.receipt.claude')?.status, 'ok')
  assert.equal(report.checks.find((item) => item.id === 'projection.receipt.zcode')?.status, 'error')
})

test('doctor --featured-readiness is a Host-only route and fails closed without an install', () => {
  const missing = spawnSync(process.execPath, [cliPath, 'doctor', '--featured-readiness', '--json'], { encoding: 'utf8' })
  assert.equal(missing.status, 1)
  assert.equal(JSON.parse(missing.stderr).error.code, 'NOT_INSTALLED')

  const deep = spawnSync(process.execPath, [cliPath, 'doctor', '--featured-readiness', '--deep'], { encoding: 'utf8' })
  assert.equal(deep.status, 2)
  assert.equal(deep.stderr.trim(), 'CLI_USAGE: doctor --featured-readiness does not accept --deep')
})

test('adoption fixtures never name an icon product and the protocol remains honest', async () => {
  const protocol = await readFile(protocolPath, 'utf8')
  assert.match(protocol, /fresh Agent task/u)
  assert.match(protocol, /are not adoption evidence/u)
  assert.match(protocol, /doctor --featured-readiness/u)
  assert.match(protocol, /docs\/fixtures\/adoption/u)
  assert.match(protocol, /did \*\*not\*\* complete live unnamed adoption/u)
  assert.match(protocol, /Lucide/u)
  assert.match(protocol, /Host `status`/u)

  const forbidden = /\barmorial\b|\blucide\b|\biconpark\b|请使用/iu
  async function files(directory) {
    const output = []
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) output.push(...await files(path))
      else output.push(path)
    }
    return output
  }
  const fixtureFiles = await files(adoptionRoot)
  assert.deepEqual(
    fixtureFiles.map((path) => relative(adoptionRoot, path).split(sep).join('/')).sort(),
    [
      'library/brief.md',
      'library/index.html',
      'ops-console/brief.md',
      'ops-console/index.html',
      'settings/brief.md',
      'settings/index.html',
    ],
  )
  for (const path of fixtureFiles) {
    const text = await readFile(path, 'utf8')
    assert.equal(forbidden.test(text), false, `${path} names a steered icon product`)
    if (path.endsWith('brief.md')) {
      assert.match(text, /index\.html/u)
      assert.doesNotMatch(text, /please use/iu)
    }
    if (path.endsWith('index.html')) {
      assert.match(text, /icon-slot/u)
    }
  }
})
