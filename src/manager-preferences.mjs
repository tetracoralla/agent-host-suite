import { join } from 'node:path'
import { readJson, writePrivateJson } from './json.mjs'
import { resolveStateRoot } from './paths.mjs'
import { AgentHostError } from './errors.mjs'
import { statePaths } from './state.mjs'
import { withLifecycleMutation } from './lifecycle-lock.mjs'

export const MANAGER_PREFERENCES_SCHEMA = 'openadam.agent-host-manager-preferences.v0.1'
const LANGUAGES = new Set(['system', 'en', 'zh-Hans'])

function preferencesPath(stateRoot) {
  return join(resolveStateRoot(stateRoot), 'manager-preferences.json')
}

function valid(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.schemaVersion === MANAGER_PREFERENCES_SCHEMA
    && LANGUAGES.has(value.language)
    && Object.keys(value).every((key) => ['schemaVersion', 'language'].includes(key))
}

export async function readManagerPreferences(stateRoot) {
  try {
    const value = await readJson(preferencesPath(stateRoot))
    if (value === null) return { schemaVersion: MANAGER_PREFERENCES_SCHEMA, language: 'system', source: 'default' }
    if (!valid(value)) return { schemaVersion: MANAGER_PREFERENCES_SCHEMA, language: 'system', source: 'recovered-invalid' }
    return { ...value, source: 'saved' }
  } catch {
    return { schemaVersion: MANAGER_PREFERENCES_SCHEMA, language: 'system', source: 'recovered-invalid' }
  }
}

export async function setManagerLanguage(stateRoot, language) {
  if (!LANGUAGES.has(language)) {
    throw new AgentHostError('MANAGER_LANGUAGE_INVALID', 'Choose System default, English, or Simplified Chinese')
  }
  const value = { schemaVersion: MANAGER_PREFERENCES_SCHEMA, language }
  const paths = statePaths(resolveStateRoot(stateRoot))
  return await withLifecycleMutation(paths, 'manager.language', {}, async (_locked, preparedPaths) => {
    await writePrivateJson(join(preparedPaths.root, 'manager-preferences.json'), value)
    return { ...value, source: 'saved' }
  })
}
