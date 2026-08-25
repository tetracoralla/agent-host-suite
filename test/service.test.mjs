import assert from 'node:assert/strict'
import test from 'node:test'
import { launchAgentContents, SERVICE_LABEL } from '../src/service.mjs'

test('LaunchAgent uses an argument array and no shell interpretation', () => {
  const plist = launchAgentContents(
    { command: '/opt/node', args: ['/opt/runtime/cli.mjs'] },
    { configPath: '/private/config.json', socketPath: '/private/runtime.sock', observationLog: '/private/observations.jsonl' },
  )
  assert.match(plist, new RegExp(SERVICE_LABEL.replaceAll('.', '\\.')))
  assert.match(plist, /<string>\/opt\/node<\/string>/)
  assert.match(plist, /<string>serve<\/string>/)
  assert.match(plist, /<key>PATH<\/key>/)
  assert.match(plist, /\/opt\/homebrew\/bin/)
  assert.doesNotMatch(plist, /<key>Program<\/key>/)
  assert.doesNotMatch(plist, /sh -c/)
})
