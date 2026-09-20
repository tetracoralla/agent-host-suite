import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PROBLEM_CLASSES,
  PRIMARY_ACTIONS,
  POST_SETUP_GUIDANCE_SCHEMA,
  buildPostSetupGuidance,
  guidanceFromSetupResult,
} from '../src/post-setup-guidance.mjs'

test('post-setup guidance points ready installs at starting work, not a checklist', () => {
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
    doctorBlockingErrors: [],
  })
  assert.equal(guidance.schemaVersion, POST_SETUP_GUIDANCE_SCHEMA)
  assert.equal(guidance.readyToWork, true)
  assert.equal(guidance.destinationIsWork, true)
  assert.equal(guidance.problemClass, PROBLEM_CLASSES.STALE_SESSION)
  assert.equal(guidance.primaryAction.id, PRIMARY_ACTIONS.START_NEW_TASK)
  assert.match(guidance.primaryAction.label, /Open a new Codex task to start work/u)
  assert.match(guidance.title, /start work/iu)
  assert.equal(guidance.gaps.some((line) => /already-open Agent task/u.test(line)), true)
  assert.equal(guidance.observed.some((line) => /installed/iu.test(line)), true)
  assert.doesNotMatch(guidance.summary, /not guaranteed/iu)
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
  assert.equal(guidance.primaryAction.id, PRIMARY_ACTIONS.CONNECT_AGENT)
  assert.match(guidance.recoveryPath, /Connect/u)
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
  assert.match(guidance.summary, /Armorial runtime probe failed/u)
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
  assert.equal(guidance.primaryAction.id, PRIMARY_ACTIONS.START_NEW_TASK)
})

test('unconfigured guidance stays on setup, still destinationIsWork', () => {
  const guidance = buildPostSetupGuidance({ configured: false })
  assert.equal(guidance.phase, 'setup')
  assert.equal(guidance.destinationIsWork, true)
  assert.equal(guidance.readyToWork, false)
})
