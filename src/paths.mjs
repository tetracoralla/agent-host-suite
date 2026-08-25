import { homedir, platform } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises'
import { AgentHostError } from './errors.mjs'

export function defaultStateRoot() {
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'openAdam', 'Agent Host Suite')
  if (platform() === 'win32') {
    const base = process.env.LOCALAPPDATA
    if (base === undefined || base === '') throw new AgentHostError('STATE_ROOT_UNAVAILABLE', 'LOCALAPPDATA is not set')
    return join(base, 'openAdam', 'Agent Host Suite')
  }
  return join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'openadam', 'agent-host-suite')
}

export function resolveStateRoot(option) {
  const candidate = option ?? process.env.AGENT_HOST_STATE_ROOT ?? defaultStateRoot()
  if (!isAbsolute(candidate)) throw new AgentHostError('STATE_ROOT_NOT_ABSOLUTE', 'The state root must be an absolute path')
  return resolve(candidate)
}

export async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new AgentHostError('STATE_ROOT_UNSAFE', `Private state path is not a real directory: ${path}`)
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new AgentHostError('STATE_ROOT_WRONG_OWNER', `Private state path is not owned by the current user: ${path}`)
  }
  if ((info.mode & 0o077) !== 0) await chmod(path, 0o700)
  return realpath(path)
}

export async function requireContainedRealPath(root, path, label) {
  const [realRoot, realPath] = await Promise.all([realpath(root), realpath(path)])
  if (realPath !== realRoot && !realPath.startsWith(`${realRoot}${sep}`)) {
    throw new AgentHostError('DEVELOPMENT_PATH_ESCAPE', `${label} resolves outside the development root`, { path: realPath })
  }
  return realPath
}
