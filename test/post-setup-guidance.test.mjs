import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PROBLEM_CLASSES,
  PRIMARY_ACTIONS,
  POST_SETUP_GUIDANCE_SCHEMA,
  buildPostSetupGuidance,
  guidanceFromSetupResult,
} from '../src/post-setup-guidance.mjs'
import { setup } from '../src/setup.mjs'
import { loadState, prepareStatePaths } from '../src/state.mjs'
import { compatibleApplicationState, createCodexRunner, createDevelopmentWorkspace, healthyCatalogPreflight } from './helpers.mjs'

test('post-setup guidance points ready installs at opening the Agent app', () => {
  const guidance = buildPostSetupGuidance({
    configured: true,
    connectedHosts: ['Codex'],
    installedToolCount: 3,
    activeToolCount: 3,
    agentToolsPaused: false,
    needsFreshTask: true,
    agentAppsVerified: true,
    justInstalled: true,
    primaryHostName: 'Codex',
    primaryHostId: 'codex',
    doctorBlockingErrors: [],
  })
  assert.equal(guidance.schemaVersion, POST_SETUP_GUIDANCE_SCHEMA)
  assert.equal(guidance.readyToWork, true)
  assert.equal(guidance.destinationIsWork, true)
  assert.equal(guidance.problemClass, PROBLEM_CLASSES.STALE_SESSION)
  assert.equal(guidance.statusLine, 'Ready')
  assert.equal(guidance.primaryAction.id, PRIMARY_ACTIONS.OPEN_APP)
  assert.equal(guidance.primaryAction.label, 'Open Codex')
  assert.equal(guidance.hint, 'Start a new task in the app')
  assert.equal(guidance.gaps.some((line) => /already-open Agent task/u.test(line)), true)
  assert.equal(guidance.observed.some((line) => /installed/iu.test(line)), true)
})

test('post-setup guidance classifies not-connected with a connect recovery path', () => {
  const guidance = buildPostSetupGuidance({
    configured: true,
    connectedHosts: [],
    installedToolCount: 3,
    activeToolCount: 3,
    justInstalled: true,
  })
  assert.equal(guidance.readyToWork, false)
  assert.equal(guidance.problemClass, PROBLEM_CLASSES.NOT_CONNECTED)
  assert.equal(guidance.statusLine, 'Connect Agent to use')
  assert.equal(guidance.primaryAction.id, PRIMARY_ACTIONS.CONNECT_AGENT)
  assert.equal(guidance.primaryAction.label, 'Connect')
})

test('deliberate pause is tools-paused with Resume, not tool-fault', () => {
  const guidance = buildPostSetupGuidance({
    configured: true,
    connectedHosts: ['Codex'],
    installedToolCount: 2,
    activeToolCount: 0,
    agentToolsPaused: true,
  })
  assert.equal(guidance.problemClass, PROBLEM_CLASSES.TOOLS_PAUSED)
  assert.equal(guidance.statusLine, 'Tools paused')
  assert.equal(guidance.primaryAction.id, PRIMARY_ACTIONS.RESUME_TOOLS)
  assert.equal(guidance.primaryAction.label, 'Resume')
})

test('post-setup guidance classifies tool faults without faking success', () => {
  const guidance = buildPostSetupGuidance({
    configured: true,
    connectedHosts: ['ZCode'],
    installedToolCount: 2,
    activeToolCount: 2,
    doctorBlockingErrors: [
      { id: 'component.armorial', message: 'Armorial runtime probe failed' },
    ],
  })
  assert.equal(guidance.readyToWork, false)
  assert.equal(guidance.problemClass, PROBLEM_CLASSES.TOOL_FAULT)
  assert.equal(guidance.primaryAction.id, PRIMARY_ACTIONS.REVIEW_REPAIR)
  assert.equal(guidance.primaryAction.label, 'Repair')
  assert.match(guidance.statusLine, /Armorial runtime probe failed/u)
})

test('post-setup guidance classifies permission faults', () => {
  const guidance = buildPostSetupGuidance({
    configured: true,
    connectedHosts: ['Claude Code'],
    installedToolCount: 1,
    activeToolCount: 1,
    doctorBlockingErrors: [
      { id: 'runtime.service', message: 'EACCES writing launch agent' },
    ],
  })
  assert.equal(guidance.problemClass, PROBLEM_CLASSES.PERMISSION)
  assert.equal(guidance.primaryAction.id, PRIMARY_ACTIONS.GRANT_WORKSPACE)
  assert.equal(guidance.primaryAction.label, 'Fix access')
})

test('setup result guidance requires a fresh task when hosts were connected', () => {
  const guidance = guidanceFromSetupResult({
    status: 'installed',
    hosts: ['codex'],
    availableAgentComponents: ['math-anchor', 'migratory-time', 'armorial'],
    agentComponents: ['math-anchor', 'migratory-time', 'armorial'],
    restartRequired: true,
  }, { primaryHostName: 'Codex' })
  assert.equal(guidance.readyToWork, true)
  assert.equal(guidance.problemClass, PROBLEM_CLASSES.STALE_SESSION)
  assert.equal(guidance.primaryAction.id, PRIMARY_ACTIONS.OPEN_APP)
  assert.equal(guidance.primaryAction.label, 'Open Codex')
})

test('guidanceFromSetupResult without component fields reports zero installed tools', () => {
  const guidance = guidanceFromSetupResult({
    status: 'installed',
    hosts: ['codex'],
    restartRequired: true,
  })
  assert.equal(guidance.observed.some((line) => /does not yet see installed Agent tool packages/u.test(line)), true)
})

test('guidanceFromSetupResult uses availableAgentComponents from setup return', () => {
  const guidance = guidanceFromSetupResult({
    status: 'installed',
    hosts: [],
    availableAgentComponents: ['math-anchor', 'migratory-time'],
    agentComponents: ['math-anchor', 'migratory-time'],
    restartRequired: false,
  })
  assert.equal(guidance.observed.some((line) => /2 installed tool packages/u.test(line)), true)
  assert.equal(guidance.observed.some((line) => /does not yet see installed/u.test(line)), false)
})

test('unconfigured guidance stays on setup, still destinationIsWork', () => {
  const guidance = buildPostSetupGuidance({ configured: false })
  assert.equal(guidance.phase, 'setup')
  assert.equal(guidance.destinationIsWork, true)
  assert.equal(guidance.readyToWork, false)
  assert.equal(guidance.primaryAction.label, 'Set up')
})


test('real setup return guidance matches installed tool packages on disk', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-guidance-setup-ws-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-guidance-setup-state-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stateRoot, { recursive: true, force: true })]))
  await createDevelopmentWorkspace(root)
  const fake = createCodexRunner({ mathPresent: false, timePresent: false })
  const result = await setup(
    {
      profile: 'standard',
      hosts: ['codex'],
      developmentRoot: root,
      stateRoot,
      noService: true,
      dryRun: false,
      enableObservability: false,
    },
    {
      runner: fake.runner,
      codexConfiguration: fake.configuration,
      hostSkillHome: join(stateRoot, 'host-home'),
      catalogPreflight: healthyCatalogPreflight,
      applicationStatePreflight: compatibleApplicationState,
    },
  )
  assert.equal(result.status, 'installed')
  assert.ok(Array.isArray(result.availableAgentComponents), 'setup must return availableAgentComponents')
  assert.ok(result.availableAgentComponents.includes('math-anchor'))
  assert.ok(result.availableAgentComponents.includes('migratory-time'))
  assert.equal(result.guidance?.observed?.some((line) => /does not yet see installed Agent tool packages/u.test(line)), false)
  assert.equal(result.guidance?.observed?.some((line) => /installed tool package/u.test(line)), true)

  const paths = await prepareStatePaths(stateRoot)
  const state = await loadState(paths)
  assert.deepEqual(state.availableAgentComponents, result.availableAgentComponents)
  assert.deepEqual(state.agentComponents, result.agentComponents)
})
