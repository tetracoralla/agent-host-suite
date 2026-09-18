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

function assertNoPreferenceConflict(patch) {
  if (patch.autoInstall === true && (patch.autoDownload === false || patch.autoCheck === false)) {
    throw new AgentHostError(
      'UPDATE_PREFERENCES_CONFLICT',
      'autoInstall requires autoDownload and autoCheck; omit the conflicting off flags or turn those on first',
    )
  }
  if (patch.autoDownload === true && patch.autoCheck === false) {
    throw new AgentHostError(
      'UPDATE_PREFERENCES_CONFLICT',
      'autoDownload requires autoCheck; omit the conflicting off flag or turn autoCheck on first',
    )
  }
}

function applyPreferencePatch(current, patch) {
  assertNoPreferenceConflict(patch)
  const next = {
    schemaVersion: UPDATE_PREFERENCES_SCHEMA,
    channel: patch.channel ?? current.channel,
    autoCheck: patch.autoCheck ?? current.autoCheck,
    autoDownload: patch.autoDownload ?? current.autoDownload,
    autoInstall: patch.autoInstall ?? current.autoInstall,
  }
  // Explicit off must cascade to dependent actions — never succeed while silently
  // reversing the user's off switch via autoInstall/autoDownload inheritance.
  if (patch.autoCheck === false) {
    next.autoDownload = false
    next.autoInstall = false
  } else if (patch.autoDownload === false) {
    next.autoInstall = false
  } else {
    if (next.autoInstall === true && next.autoDownload !== true) next.autoDownload = true
    if (next.autoDownload === true && next.autoCheck !== true) next.autoCheck = true
  }
  if (!valid(next)) throw new AgentHostError('UPDATE_PREFERENCES_INVALID', 'Update preferences are not valid')
  return next
}

export async function setUpdatePreferences(stateRoot, patch) {
  const paths = statePaths(resolveStateRoot(stateRoot))
  return await withLifecycleMutation(paths, 'updates.preferences', {}, async () => {
    await prepareStatePaths(resolveStateRoot(stateRoot))
    const current = await readUpdatePreferences(stateRoot)
    const next = applyPreferencePatch(current, patch ?? {})
    await writePrivateJson(pathFor(stateRoot), next)
    return { ...next, source: 'saved' }
  })
}
