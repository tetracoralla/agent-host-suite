import { copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { AgentHostError } from './errors.mjs'
import { readJson, writePrivateJson } from './json.mjs'
import { ensurePrivateDirectory } from './paths.mjs'

export const STATE_SCHEMA = 'openadam.agent-host-state.v0.1'

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
  if (state.schemaVersion !== STATE_SCHEMA) {
    throw new AgentHostError('STATE_SCHEMA_UNSUPPORTED', `Unsupported state schema: ${state.schemaVersion ?? 'missing'}`)
  }
  return state
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
