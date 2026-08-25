import assert from 'node:assert/strict'
import test from 'node:test'
import { runFile } from '../src/process.mjs'

test('process runner sends bounded stdin to child commands', async () => {
  const script = "let value='';process.stdin.on('data',c=>value+=c);process.stdin.on('end',()=>process.stdout.write(value.toUpperCase()))"
  const result = await runFile(process.execPath, ['-e', script], { input: 'closed work order\n' })
  assert.equal(result.stdout, 'CLOSED WORK ORDER\n')
})

test('process runner terminates a command at its deadline', async () => {
  const result = await runFile(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 50, allowFailure: true })
  assert.equal(result.timedOut, true)
  assert.notEqual(result.status, 0)
})
