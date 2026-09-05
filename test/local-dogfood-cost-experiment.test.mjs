import assert from 'node:assert/strict'
import test from 'node:test'
import { assessCostExperimentTask } from '../scripts/local-dogfood-cost-assessment.mjs'

function summary(finalText, toolSequence = []) {
  return { finalText, toolSequence, toolCallCount: toolSequence.length }
}

test('cost experiment accepts an exact no-tool reply with or without one quote pair', () => {
  const task = { expected: 'no-tool' }
  assert.equal(assessCostExperimentTask(task, summary('收到')), true)
  assert.equal(assessCostExperimentTask(task, summary('“收到”')), true)
  assert.equal(assessCostExperimentTask(task, summary('"收到"')), true)
  assert.equal(assessCostExperimentTask(task, summary('已收到')), false)
  assert.equal(assessCostExperimentTask(task, summary('收到', ['shell'])), false)
})

test('cost experiment file task requires the installed file tool and the requested value', () => {
  const task = { expected: 'file' }
  assert.equal(assessCostExperimentTask(task, summary('@openadam/agent-host-suite', ['mcp__file_vitals__file_inspect'])), true)
  assert.equal(assessCostExperimentTask(task, summary('@openadam/agent-host-suite', ['shell'])), false)
  assert.equal(assessCostExperimentTask(task, summary('another-package', ['file_inspect'])), false)
})
