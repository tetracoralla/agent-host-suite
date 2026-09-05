import { copyFile, lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { AgentHostError } from './errors.mjs'
import { readJson, writePrivateJson } from './json.mjs'
import { ensurePrivateDirectory } from './paths.mjs'

export const STATE_SCHEMA = 'openadam.agent-host-state.v0.1'

const STATE_REQUIRED_KEYS = [
  'schemaVersion', 'suiteVersion', 'channel', 'profile', 'installedAt', 'updatedAt',
  'components', 'hosts', 'runtime', 'observability',
]
const STATE_ALLOWED_KEYS = new Set([
  ...STATE_REQUIRED_KEYS,
  'releaseActivatedAt', 'bindingsActivatedAt', 'developmentRoot', 'workspaceRoot',
  'releaseId', 'releaseManifest', 'availableAgentComponents', 'agentComponents',
  'releaseSourceProvenance', 'privateComponents', 'rolledBackFrom', 'componentWarmupVersion',
])

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0) && new Set(value).size === value.length
}

export function validateState(state) {
  const invalid = []
  if (!plainObject(state)) throw new AgentHostError('STATE_SCHEMA_INVALID', 'The saved Agent Host state is not an object', { fields: ['$'] })
  for (const key of Object.keys(state)) if (!STATE_ALLOWED_KEYS.has(key)) invalid.push(key)
  for (const key of STATE_REQUIRED_KEYS) if (state[key] === undefined) invalid.push(key)
  if (state.schemaVersion !== STATE_SCHEMA) {
    throw new AgentHostError('STATE_SCHEMA_UNSUPPORTED', `Unsupported state schema: ${state.schemaVersion ?? 'missing'}`)
  }
  if (typeof state.suiteVersion !== 'string' || state.suiteVersion.length === 0) invalid.push('suiteVersion')
  if (!['development', 'release'].includes(state.channel)) invalid.push('channel')
  if (typeof state.profile !== 'string' || state.profile.length === 0) invalid.push('profile')
  for (const key of ['installedAt', 'updatedAt', 'releaseActivatedAt', 'bindingsActivatedAt']) {
    if (state[key] !== undefined && (typeof state[key] !== 'string' || !Number.isFinite(Date.parse(state[key])))) invalid.push(key)
  }
  for (const key of ['developmentRoot', 'releaseId', 'rolledBackFrom']) {
    if (state[key] !== undefined && (typeof state[key] !== 'string' || state[key].length === 0)) invalid.push(key)
  }
  if (state.releaseManifest !== undefined && !plainObject(state.releaseManifest)) invalid.push('releaseManifest')
  if (state.releaseSourceProvenance !== undefined) {
    const provenance = state.releaseSourceProvenance
    if (!plainObject(provenance)
      || Object.keys(provenance).some((key) => !['policy', 'recordSha256', 'remoteConfirmedAtBuildTime'].includes(key))
      || !['local-development', 'local-clean', 'remote-tagged'].includes(provenance.policy)
      || !/^sha256:[0-9a-f]{64}$/u.test(provenance.recordSha256 ?? '')
      || typeof provenance.remoteConfirmedAtBuildTime !== 'boolean'
      || provenance.remoteConfirmedAtBuildTime !== (provenance.policy === 'remote-tagged')) invalid.push('releaseSourceProvenance')
  }
  if (state.workspaceRoot !== undefined && state.workspaceRoot !== null && (typeof state.workspaceRoot !== 'string' || state.workspaceRoot.length === 0)) invalid.push('workspaceRoot')
  if (state.componentWarmupVersion !== undefined && state.componentWarmupVersion !== 1) invalid.push('componentWarmupVersion')
  for (const key of ['components', 'hosts', 'runtime', 'observability', 'privateComponents']) {
    if (state[key] !== undefined && !plainObject(state[key])) invalid.push(key)
  }
  const componentIDs = new Set(Object.keys(plainObject(state.components) ? state.components : {}))
  let available = componentIDs
  if (state.availableAgentComponents !== undefined) {
    if (!stringArray(state.availableAgentComponents) || state.availableAgentComponents.some((id) => !componentIDs.has(id))) invalid.push('availableAgentComponents')
    else available = new Set(state.availableAgentComponents)
  }
  if (state.agentComponents !== undefined && (!stringArray(state.agentComponents) || state.agentComponents.some((id) => !available.has(id)))) invalid.push('agentComponents')
  if (invalid.length > 0) {
    throw new AgentHostError('STATE_SCHEMA_INVALID', 'The saved Agent Host state does not match the supported shape', { fields: [...new Set(invalid)].sort() })
  }
  return state
}

export function statePaths(root) {
  return {
    root,
    state: join(root, 'state.json'),
    history: join(root, 'history'),
    runtime: join(root, 'runtime'),
    observations: join(root, 'observations'),
    context: join(root, 'context'),
    backups: join(root, 'backups'),
    downloads: join(root, 'downloads'),
    packages: join(root, 'packages'),
    hostProjections: join(root, 'host-projections'),
    serviceRecovery: join(root, 'service-recovery'),
    activity: join(root, 'activity.jsonl'),
  }
}

export async function readStatePaths(root) {
  const info = await lstat(root).catch((error) => {
    if (error?.code === 'ENOENT') return null
    throw error
  })
  if (info === null) return statePaths(root)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new AgentHostError('STATE_ROOT_UNSAFE', `Private state path is not a real directory: ${root}`)
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new AgentHostError('STATE_ROOT_WRONG_OWNER', `Private state path is not owned by the current user: ${root}`)
  }
  if ((info.mode & 0o077) !== 0) {
    throw new AgentHostError('STATE_ROOT_PERMISSIONS_UNSAFE', 'The Agent Host state root must not be accessible by group or other users')
  }
  return statePaths(await realpath(root))
}

export async function prepareStatePaths(root) {
  const paths = statePaths(await ensurePrivateDirectory(root))
  await Promise.all([
    ensurePrivateDirectory(paths.history),
    ensurePrivateDirectory(paths.runtime),
    ensurePrivateDirectory(paths.observations),
    ensurePrivateDirectory(paths.context),
    ensurePrivateDirectory(paths.backups),
    ensurePrivateDirectory(paths.downloads),
    ensurePrivateDirectory(paths.packages),
    ensurePrivateDirectory(paths.hostProjections),
  ])
  return paths
}

export async function loadState(paths) {
  const state = await readJson(paths.state)
  if (state === null) return null
  return validateState(state)
}

export async function saveState(paths, state, { retainCurrent = false } = {}) {
  if (retainCurrent) {
    const current = await readJson(paths.state)
    if (current !== null) {
      const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
      await copyFile(paths.state, join(paths.history, `${timestamp}-${current.suiteVersion ?? 'unknown'}-${randomUUID().slice(0, 8)}.json`))
    }
  }
  await writePrivateJson(paths.state, state)
}

export async function listHistory(paths) {
  let entries
  try {
    entries = await readdir(paths.history)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  return entries.filter((name) => name.endsWith('.json')).sort().reverse().map((name) => join(paths.history, name))
}

function compatibilityIdentity(state) {
  const components = Object.fromEntries(Object.entries(state?.components ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, component]) => [id, component?.fingerprint ?? null]))
  return JSON.stringify({
    channel: state?.channel ?? null,
    suiteVersion: state?.suiteVersion ?? null,
    releaseId: state?.releaseId ?? null,
    components,
  })
}

// History also contains same-release operational snapshots written before a
// host connection or monitoring-state transition. Those snapshots are useful
// for recovery, but they are not a previous compatibility set. Whole-suite
// rollback must skip them or it can misleadingly "restore" the current release.
export async function loadRollbackState(paths, current) {
  const currentIdentity = compatibilityIdentity(current)
  for (const path of await listHistory(paths)) {
    if (path.includes('-uninstalled-')) continue
    const candidate = await readJson(path)
    if (candidate !== null && compatibilityIdentity(candidate) !== currentIdentity) return candidate
  }
  return null
}

export async function archiveAndRemoveState(paths, state) {
  await mkdir(paths.history, { recursive: true, mode: 0o700 })
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const archived = join(paths.history, `${timestamp}-uninstalled-${state.suiteVersion}-${randomUUID().slice(0, 8)}.json`)
  await writePrivateJson(archived, { ...state, uninstalledAt: new Date().toISOString() })
  await rm(paths.state, { force: true })
  return basename(archived)
}
