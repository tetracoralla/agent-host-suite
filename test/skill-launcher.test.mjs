import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { skillLauncherScript } from '../src/skill-launcher.mjs'

test('Skill launcher quotes fixed bindings without changing the caller cwd', () => {
  const binding = { command: '/node', args: ["it's a CLI"], environment: { WORK_ROOT: '/a b/%value%/!' } }
  assert.equal(skillLauncherScript(binding, 'linux'), "#!/bin/sh\nexec '/usr/bin/env' 'WORK_ROOT=/a b/%value%/!' '/node' 'it'\\''s a CLI' \"$@\"\n")
  assert.equal(skillLauncherScript(binding, 'win32'), '@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "WORK_ROOT=/a b/%%value%%/!"\r\n"/node" "it\'s a CLI" %*\r\n')
})

test('POSIX Skill binding does not depend on mutating shell variables', { skip: process.platform === 'win32' }, () => {
  const binding = {
    command: process.execPath,
    args: ['-e', 'console.log(process.env.PROVIDER_FIXTURE_ROOT)'],
    environment: { PROVIDER_FIXTURE_ROOT: '/explicit-workspace' },
  }
  const result = spawnSync('/bin/sh', ['-s'], {
    input: `readonly PROVIDER_FIXTURE_ROOT='/not-the-grant'\n${skillLauncherScript(binding)}`,
    encoding: 'utf8', timeout: 5000,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), '/explicit-workspace')
})

test('Skill launcher rejects unrepresentable bindings before materialization', () => {
  for (const environment of [{ 'BAD;NAME': 'x' }, { WORK_ROOT: null }, { WORK_ROOT: 'a\0b' }]) {
    for (const platform of ['linux', 'win32']) {
      assert.throws(() => skillLauncherScript({ command: '/node', environment }, platform), (error) => error.code === 'SKILL_LAUNCHER_INVALID')
    }
  }
  for (const value of ['a"b', 'a\nb', 'a\rb']) {
    assert.throws(() => skillLauncherScript({ command: '/node', environment: { WORK_ROOT: value } }, 'win32'), (error) => error.code === 'SKILL_LAUNCHER_INVALID')
  }
})
