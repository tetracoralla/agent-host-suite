import { windowsAccessList } from './windows-private-access.mjs'
import { platform } from 'node:os'
import { AgentHostError } from './errors.mjs'

const pendingReads = new Map()

// Windows stat.mode is synthetic and cannot describe an NTFS access list.
// Use SIDs rather than localized account names, and keep path data out of code.

async function windowsAccess(path, ensure) {
  const key = `${ensure}:${path}`
  if (pendingReads.has(key)) return pendingReads.get(key)
  const operation = (async () => {
    let value
    try {
      value = await windowsAccessList(path, ensure)
    } catch {
      throw new AgentHostError('STATE_ROOT_PERMISSIONS_UNAVAILABLE', 'Windows could not verify the private Agent Host access list')
    }
    if (value.status === 'error') {
      const reason = String(value.reason).replace(/[^A-Za-z0-9_.,-]/gu, '').slice(0, 160)
      const line = Number.isSafeInteger(value.line) ? value.line : 0
      throw new AgentHostError('STATE_ROOT_PERMISSIONS_UNAVAILABLE', `Windows access-list verification failed (${reason}, line ${line})`)
    }
    if (value.status === 'wrong-owner') {
      throw new AgentHostError('STATE_ROOT_WRONG_OWNER', 'Private Agent Host state is not owned by the current Windows identity')
    }
    if (!['private', 'secured'].includes(value.status)) {
      throw new AgentHostError('STATE_ROOT_PERMISSIONS_UNSAFE', 'Agent Host state grants access to another Windows identity')
    }
  })()
  pendingReads.set(key, operation)
  try { return await operation } finally { pendingReads.delete(key) }
}

export async function assertPrivateAccess(path, info) {
  if (platform() === 'win32') return windowsAccess(path, false)
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new AgentHostError('STATE_ROOT_WRONG_OWNER', 'Private Agent Host state is not owned by the current user')
  }
  if ((info.mode & 0o077) !== 0) {
    throw new AgentHostError('STATE_ROOT_PERMISSIONS_UNSAFE', 'The Agent Host state root must not be accessible by group or other users')
  }
}

export async function secureWindowsDirectory(path) {
  if (platform() === 'win32') await windowsAccess(path, true)
}
