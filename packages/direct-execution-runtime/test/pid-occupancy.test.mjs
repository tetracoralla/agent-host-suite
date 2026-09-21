import assert from 'node:assert/strict'
import test from 'node:test'
import { ownedPidsStillLive, pidOccupancy } from './pid-occupancy.mjs'

function codedError(code, message = code) {
  return Object.assign(new Error(message), { code })
}

test('kill EPERM is occupancy, not a thrown probe failure', () => {
  const eperm = () => { throw codedError('EPERM', 'kill EPERM') }
  assert.equal(pidOccupancy(4321, eperm, 'win32'), 'uncertain')
  assert.equal(pidOccupancy(4321, eperm, 'linux'), 'uncertain')
})

test('kill occupancy distinguishes absent, alive, and inaccessible PIDs', () => {
  assert.equal(pidOccupancy(0), 'absent')
  assert.equal(pidOccupancy(-1), 'absent')
  assert.equal(pidOccupancy(process.pid), 'alive')
  assert.equal(pidOccupancy(2147483647), 'absent')
  assert.equal(pidOccupancy(99, () => true), 'alive')
  assert.equal(pidOccupancy(99, () => { throw codedError('ESRCH') }), 'absent')
  assert.equal(pidOccupancy(99, () => { throw codedError('EACCES') }, 'win32'), 'uncertain')
})

test('unexpected POSIX kill errors still surface; Windows probe stays non-throwing', () => {
  const boom = () => { throw codedError('EINVAL', 'kill EINVAL') }
  assert.throws(() => pidOccupancy(99, boom, 'linux'), { code: 'EINVAL' })
  assert.equal(pidOccupancy(99, boom, 'win32'), 'uncertain')
})

test('Windows EPERM occupancy is confirmed before treating the PID as live', async () => {
  const eperm = () => { throw Object.assign(new Error('kill EPERM'), { code: 'EPERM', errno: -4048 }) }
  const gone = await ownedPidsStillLive([4321, 4322], {
    platformName: 'win32',
    signalProcess: eperm,
    confirmUncertainPids: async (pids) => {
      assert.deepEqual(pids, [4321, 4322])
      return []
    },
  })
  assert.deepEqual(gone, [])

  const listed = await ownedPidsStillLive([4321], {
    platformName: 'win32',
    signalProcess: eperm,
    confirmUncertainPids: async () => [4321],
  })
  assert.deepEqual(listed, [4321])
})

test('POSIX EPERM occupancy counts as still live without a Windows confirmer', async () => {
  const eperm = () => { throw codedError('EPERM', 'kill EPERM') }
  const live = await ownedPidsStillLive([7], {
    platformName: 'linux',
    signalProcess: eperm,
  })
  assert.deepEqual(live, [7])
})
