import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentHostError } from '../src/errors.mjs'
import { pickDirectory } from '../src/directory-picker.mjs'

test('macOS choose-folder maps a POSIX path and user cancel', async () => {
  const picked = await pickDirectory({
    platform: 'darwin',
    findCommand: async () => '/usr/bin/osascript',
    runner: async () => ({ status: 0, stdout: '/Users/me/project/\n', stderr: '' }),
  })
  assert.deepEqual(picked, { status: 'picked', path: '/Users/me/project/' })

  const cancelled = await pickDirectory({
    platform: 'darwin',
    findCommand: async () => '/usr/bin/osascript',
    runner: async () => ({ status: 0, stdout: 'CANCELLED\n', stderr: '' }),
  })
  assert.deepEqual(cancelled, { status: 'cancelled' })
})

test('Windows FolderBrowserDialog cancel and pick', async () => {
  const cancelled = await pickDirectory({
    platform: 'win32',
    runner: async () => ({ status: 0, stdout: 'CANCELLED\r\n', stderr: '' }),
  })
  assert.deepEqual(cancelled, { status: 'cancelled' })

  const picked = await pickDirectory({
    platform: 'win32',
    runner: async () => ({ status: 0, stdout: 'C:\\Users\\me\\project\r\n', stderr: '' }),
  })
  assert.deepEqual(picked, { status: 'picked', path: 'C:\\Users\\me\\project' })
})

test('Linux zenity cancel is not a grant, missing picker stays unavailable', async () => {
  const cancelled = await pickDirectory({
    platform: 'linux',
    findCommand: async (name) => (name === 'zenity' ? '/usr/bin/zenity' : null),
    runner: async () => ({ status: 1, stdout: '', stderr: '' }),
  })
  assert.deepEqual(cancelled, { status: 'cancelled' })

  await assert.rejects(
    () => pickDirectory({
      platform: 'linux',
      findCommand: async () => null,
      runner: async () => ({ status: 127, stdout: '', stderr: 'not found' }),
    }),
    (error) => error instanceof AgentHostError
      && error.code === 'DIRECTORY_PICKER_UNAVAILABLE'
      && /Open Agent Host on this computer/u.test(error.message),
  )
})
