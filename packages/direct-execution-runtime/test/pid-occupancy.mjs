/** kill(0) occupancy: ESRCH is gone; EPERM/EACCES is occupied or inaccessible. */

export function pidOccupancy(pid, signalProcess = process.kill, platformName = process.platform) {
  if (!Number.isInteger(pid) || pid <= 0) return 'absent'
  try {
    signalProcess(pid, 0)
    return 'alive'
  } catch (error) {
    if (error?.code === 'ESRCH') return 'absent'
    // Same contract as Host processIsAlive / readyFileProbe: EPERM means the PID
    // is still occupied. Windows Job teardown and inaccessible PIDs also surface
    // EPERM/EACCES — the probe must not throw and crash check:package.
    if (error?.code === 'EPERM' || error?.code === 'EACCES') return 'uncertain'
    if (platformName === 'win32') return 'uncertain'
    throw error
  }
}

export async function ownedPidsStillLive(pids, options = {}) {
  const signalProcess = options.signalProcess ?? process.kill
  const platformName = options.platformName ?? process.platform
  const confirmUncertainPids = options.confirmUncertainPids
  const alive = []
  const uncertain = []
  for (const pid of pids) {
    const occupancy = pidOccupancy(pid, signalProcess, platformName)
    if (occupancy === 'alive') alive.push(pid)
    else if (occupancy === 'uncertain') uncertain.push(pid)
  }
  if (uncertain.length === 0) return alive
  if (platformName !== 'win32' || typeof confirmUncertainPids !== 'function') {
    return [...alive, ...uncertain]
  }
  return [...alive, ...(await confirmUncertainPids(uncertain))]
}
