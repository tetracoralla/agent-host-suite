import { join } from 'node:path'
import { AgentHostError } from './errors.mjs'
import { readJson, writePrivateJson } from './json.mjs'
import { resolveStateRoot } from './paths.mjs'
import { prepareStatePaths } from './state.mjs'
import { withLifecycleMutation } from './lifecycle-lock.mjs'
import { statePaths } from './state.mjs'

export const UPDATE_PREFERENCES_SCHEMA = 'openadam.agent-host-update-preferences.v0.1'

const defaults = Object.freeze({
  schemaVersion: UPDATE_PREFERENCES_SCHEMA,
  channel: 'stable',
  autoCheck: false,
  autoDownload: false,
  autoInstall: false,
})

function pathFor(stateRoot) {
  return join(resolveStateRoot(stateRoot), 'update-preferences.json')
}

function valid(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.schemaVersion === UPDATE_PREFERENCES_SCHEMA
    && ['stable', 'preview'].includes(value.channel)
    && typeof value.autoCheck === 'boolean'
    && typeof value.autoDownload === 'boolean'
    && typeof value.autoInstall === 'boolean'
    && Object.keys(value).every((key) => ['schemaVersion', 'channel', 'autoCheck', 'autoDownload', 'autoInstall'].includes(key))
}

export async function readUpdatePreferences(stateRoot) {
  const value = await readJson(pathFor(stateRoot))
  if (value === null) return { ...defaults, source: 'default' }
  if (!valid(value)) return { ...defaults, source: 'recovered-invalid' }
  return { ...value, source: 'saved' }
}

export async function setUpdatePreferences(stateRoot, patch) {
  const current = await readUpdatePreferences(stateRoot)
  const next = {
    schemaVersion: UPDATE_PREFERENCES_SCHEMA,
    channel: patch.channel ?? current.channel,
    autoCheck: patch.autoCheck ?? current.autoCheck,
    autoDownload: patch.autoDownload ?? current.autoDownload,
    autoInstall: patch.autoInstall ?? current.autoInstall,
  }
  if (next.autoInstall === true && next.autoDownload !== true) {
    next.autoDownload = true
  }
  if (next.autoDownload === true && next.autoCheck !== true) {
    next.autoCheck = true
  }
  if (!valid(next)) throw new AgentHostError('UPDATE_PREFERENCES_INVALID', 'Update preferences are not valid')
  const paths = statePaths(resolveStateRoot(stateRoot))
  return await withLifecycleMutation(paths, 'updates.preferences', {}, async () => {
    await prepareStatePaths(resolveStateRoot(stateRoot))
    await writePrivateJson(pathFor(stateRoot), next)
    return { ...next, source: 'saved' }
  })
}
