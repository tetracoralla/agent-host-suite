import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  FEATURED_READINESS_BOUNDARY,
  FEATURED_READINESS_SCHEMA,
  inspectFeaturedReadiness,
} from '../src/featured-readiness.mjs'
import { inspectProviderSkills } from '../src/developer-kit-skill.mjs'
import { human } from '../src/cli.mjs'
import { createIsolatedCli, runIsolatedCli } from './cli-isolation.mjs'

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
  assert.equal(ok.userStatus, 'ok')
  assert.equal(ok.recipeStatus, 'ok')
  assert.equal(ok.adoptionEvidence, false)
  assert.equal(ok.schemaVersion, FEATURED_READINESS_SCHEMA)
  assert.equal(ok.assessmentBoundary, FEATURED_READINESS_BOUNDARY)
  assert.equal(ok.checks.find((item) => item.id === 'recipe.consistency')?.status, 'ok')
  assert.equal(ok.checks.find((item) => item.id === 'user.tools')?.status, 'ok')
  assert.equal(ok.checks.find((item) => item.id === 'projection.receipt.codex')?.status, 'ok')
  assert.match(human(ok), /Host precondition only/u)
  assert.match(human(ok), /not adoption/u)
  assert.match(human(ok), /User readiness: ok/u)
  assert.match(ok.nextSteps.completedWork, /not adoption evidence/u)

  const standard = await inspectFeaturedReadiness(featuredState({ profile: 'standard' }), {
    inspectAgentApps: false,
  })
  assert.equal(standard.status, 'warning')
  assert.equal(standard.userStatus, 'warning')
  assert.equal(standard.recipeStatus, 'warning')
  assert.equal(standard.adoptionEvidence, false)
  assert.equal(standard.checks.find((item) => item.id === 'user.tools')?.status, 'ok')
  assert.match(standard.checks.find((item) => item.id === 'recipe.consistency').message, /profile is standard|recipe is standard/u)

  const inactive = await inspectFeaturedReadiness(
    featuredState({ agentComponents: ['math-anchor', 'migratory-time'] }),
    { inspectAgentApps: false },
  )
  assert.equal(inactive.status, 'error')
  assert.equal(inactive.userStatus, 'error')
  assert.equal(inactive.checks.find((item) => item.id === 'user.tools')?.status, 'error')
  assert.match(inactive.nextSteps.missingTools, /armorial/u)
})

test('user-level readiness does not fail only because the profile is local-dogfood', async () => {
  const report = await inspectFeaturedReadiness(featuredState({ profile: 'local-dogfood' }), healthyCodex())
  assert.equal(report.adoptionEvidence, false)
  assert.equal(report.userStatus, 'ok')
  assert.equal(report.status, 'ok')
  assert.notEqual(report.recipeStatus, 'ok')
  assert.equal(report.checks.find((item) => item.id === 'recipe.consistency')?.status, 'warning')
  assert.match(report.checks.find((item) => item.id === 'recipe.consistency').message, /local-dogfood/u)
  assert.equal(report.checks.find((item) => item.id === 'recipe.consistency')?.detail.userLevelUsesProfileName, false)
  assert.equal(report.checks.find((item) => item.id === 'user.tools')?.status, 'ok')
  assert.equal(report.checks.find((item) => item.id === 'projection.receipt.codex')?.status, 'ok')
  assert.equal(report.checks.some((item) => item.status === 'error'), false)
  assert.match(human(report), /User readiness: ok/u)
  assert.match(human(report), /fresh Agent task/u)
})

test('featured readiness treats missing hosts and skipped receipts as Host gaps, not adoption', async () => {
  const none = await inspectFeaturedReadiness(featuredState({ hosts: {} }))
  assert.equal(none.status, 'error')
  assert.equal(none.adoptionEvidence, false)
  assert.equal(none.checks.find((item) => item.id === 'user.connection')?.status, 'error')
  assert.equal(none.checks.some((item) => item.id === 'projection.receipt'), false)

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

function agentAppRunner({ claude = '/fixture/claude', zcode = '/fixture/zcode' } = {}) {
  return async (command, args) => {
    if (command === 'where.exe' || (command === '/usr/bin/env' && args[0] === 'which')) {
      const name = command === 'where.exe' ? args[0] : args[1]
      if (name === 'claude') return { status: 0, stdout: `${claude}\n`, stderr: '' }
      if (name === 'zcode') return { status: 0, stdout: `${zcode}\n`, stderr: '' }
      return { status: 1, stdout: '', stderr: '' }
    }
    if (command === claude) return { status: 0, stdout: '2.1.233\n', stderr: '' }
    if (command === zcode && args[0] === 'version') return { status: 0, stdout: '{"version":"0.16.5"}\n', stderr: '' }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
  }
}

async function missingArmorialSkillState(t, hostId) {
  const root = await mkdtemp(join(tmpdir(), `agent-host-featured-${hostId}-skill-`))
  t.after(() => rm(root, { recursive: true, force: true }))
  const command = process.execPath
  const args = ['mcp']
  const missingSkill = join(root, 'missing-armorial-skill')
  const providerSkills = [{ id: 'icon-svg-select', projectionRoot: missingSkill }]
  const armorial = {
    version: '0.7.0', identityFiles: [], plugin: 'armorial', command, args,
    providerSkill: { id: 'icon-svg-select' },
  }
  if (hostId === 'claude') {
    const configPath = join(root, '.claude.json')
    await writeFile(configPath, JSON.stringify({
      mcpServers: { armorial: { type: 'stdio', command, args } },
    }))
    return {
      root, missingSkill, providerSkills,
      state: featuredState({
        components: {
          'math-anchor': { version: '0.4.0', identityFiles: [], plugin: 'math-anchor' },
          'migratory-time': { version: '2.0.0', identityFiles: [], plugin: 'migratory-time' },
          armorial,
        },
        hosts: { claude: { configPath, entries: [{ component: 'armorial' }], providerSkills } },
      }),
    }
  }
  const configPath = join(root, '.zcode', 'cli', 'config.json')
  await mkdir(join(root, '.zcode', 'cli'), { recursive: true })
  await writeFile(configPath, JSON.stringify({
    mcp: { servers: { armorial: { type: 'stdio', command, args, enabled: true } } },
  }))
  return {
    root, missingSkill, providerSkills,
    state: featuredState({
      components: {
        'math-anchor': { version: '0.4.0', identityFiles: [], plugin: 'math-anchor' },
        'migratory-time': { version: '2.0.0', identityFiles: [], plugin: 'migratory-time' },
        armorial,
      },
      hosts: { zcode: { configPath, entries: [{ component: 'armorial', created: true }], providerSkills } },
    }),
  }
}

test('featured readiness is not ok when Claude MCP is healthy but the Armorial Skill projection is missing', async (t) => {
  const { providerSkills, state } = await missingArmorialSkillState(t, 'claude')
  const skills = await inspectProviderSkills(providerSkills)
  assert.equal(skills.status, 'error')
  assert.equal(skills.skills[0].code, 'DEVELOPER_SKILL_PROJECTION_MISSING')
  const report = await inspectFeaturedReadiness(state, { runner: agentAppRunner() })
  assert.equal(report.adoptionEvidence, false)
  assert.notEqual(report.status, 'ok')
  const receipt = report.checks.find((item) => item.id === 'projection.receipt.claude')
  assert.equal(receipt.status, 'error')
  assert.equal(receipt.detail.present, true)
  assert.equal(receipt.detail.identityMatched, true)
  assert.equal(receipt.detail.providerSkills.skills[0].code, 'DEVELOPER_SKILL_PROJECTION_MISSING')
  assert.match(receipt.message, /Skill projection/u)
})

test('featured readiness is not ok when ZCode MCP is healthy but the Armorial Skill projection is missing', async (t) => {
  const { providerSkills, state } = await missingArmorialSkillState(t, 'zcode')
  const skills = await inspectProviderSkills(providerSkills)
  assert.equal(skills.status, 'error')
  assert.equal(skills.skills[0].code, 'DEVELOPER_SKILL_PROJECTION_MISSING')
  const report = await inspectFeaturedReadiness(state, { runner: agentAppRunner() })
  assert.equal(report.adoptionEvidence, false)
  assert.notEqual(report.status, 'ok')
  const receipt = report.checks.find((item) => item.id === 'projection.receipt.zcode')
  assert.equal(receipt.status, 'error')
  assert.equal(receipt.detail.present, true)
  assert.equal(receipt.detail.identityMatched, true)
  assert.equal(receipt.detail.providerSkills.skills[0].code, 'DEVELOPER_SKILL_PROJECTION_MISSING')
  assert.match(receipt.message, /Skill projection/u)
})

test('doctor --featured-readiness is a Host-only route and fails closed without an install', async (t) => {
  const isolated = await createIsolatedCli(t)
  const missing = runIsolatedCli(['doctor', '--featured-readiness', '--json'], isolated)
  assert.equal(missing.status, 1)
  assert.equal(JSON.parse(missing.stderr).error.code, 'NOT_INSTALLED')

  const deep = runIsolatedCli(['doctor', '--featured-readiness', '--deep'], isolated)
  assert.equal(deep.status, 2)
  assert.equal(deep.stderr.trim(), 'CLI_USAGE: doctor --featured-readiness does not accept --deep')
})

test('adoption fixtures never name an icon product and the protocol remains honest', async () => {
  const protocol = await readFile(protocolPath, 'utf8')
  assert.match(protocol, /fresh Agent task/u)
  assert.match(protocol, /are not adoption evidence/u)
  assert.match(protocol, /doctor --featured-readiness/u)
  assert.match(protocol, /docs\/fixtures\/adoption/u)
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
