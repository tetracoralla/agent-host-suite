import { copyFile, mkdir, readdir, rm } from 'node:fs/promises'
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
  'privateComponents', 'rolledBackFrom',
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
  if (state.workspaceRoot !== undefined && state.workspaceRoot !== null && (typeof state.workspaceRoot !== 'string' || state.workspaceRoot.length === 0)) invalid.push('workspaceRoot')
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
    activity: join(root, 'activity.jsonl'),
  }
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
      await copyFile(paths.state, join(paths.history, `${timestamp}-${current.suiteVersion ?? 'unknown'}.json`))
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

export async function archiveAndRemoveState(paths, state) {
  await mkdir(paths.history, { recursive: true, mode: 0o700 })
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const archived = join(paths.history, `${timestamp}-uninstalled-${state.suiteVersion}.json`)
  await writePrivateJson(archived, { ...state, uninstalledAt: new Date().toISOString() })
  await rm(paths.state, { force: true })
  return basename(archived)
}
