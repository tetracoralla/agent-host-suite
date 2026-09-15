import { join } from 'node:path'
import { AgentHostError } from './errors.mjs'
import { readJson, writePrivateJson } from './json.mjs'
import { resolveStateRoot } from './paths.mjs'
import { prepareStatePaths } from './state.mjs'
import { readUpdatePreferences } from './update-preferences.mjs'
import { inspectToolUpdates, updateGitHubTool } from './tool-updates.mjs'
import { checkApplicationUpdate, updateApplication } from './application-update.mjs'
import { withLifecycleMutation } from './lifecycle-lock.mjs'
import { statePaths } from './state.mjs'

export const AUTO_UPDATE_SCHEMA = 'openadam.agent-host-auto-update.v0.1'
const DUE_MS = 60 * 60 * 1000

function journalPath(root) {
  return join(root, 'auto-update.json')
}

function emptyJournal() {
  return {
    schemaVersion: AUTO_UPDATE_SCHEMA,
    phase: 'idle',
    lastRunAt: null,
    lastResult: null,
    error: null,
  }
}

export async function readAutoUpdateJournal(stateRoot) {
  const value = await readJson(journalPath(resolveStateRoot(stateRoot)))
  if (value === null) return emptyJournal()
  if (value.schemaVersion !== AUTO_UPDATE_SCHEMA) return { ...emptyJournal(), recoveredInvalid: true }
  return value
}

async function writeJournal(stateRoot, value) {
  const paths = await prepareStatePaths(resolveStateRoot(stateRoot))
  const record = { ...emptyJournal(), ...value, schemaVersion: AUTO_UPDATE_SCHEMA }
  await writePrivateJson(journalPath(paths.root), record)
  return record
}

function due(journal, now) {
  if (typeof journal.lastRunAt !== 'string') return true
  const last = Date.parse(journal.lastRunAt)
  if (!Number.isFinite(last)) return true
  return now - last >= DUE_MS
}

export async function executeAutoUpdates(stateRoot, options = {}, dependencies = {}) {
  const now = options.now ?? Date.now()
  const preferences = await readUpdatePreferences(stateRoot)
  if (preferences.autoCheck !== true && options.force !== true) {
    return { status: 'skipped', reason: 'auto-check-disabled', preferences }
  }
  const journal = await readAutoUpdateJournal(stateRoot)
  if (options.force !== true && options.skipIfNotDue === true && due(journal, now) !== true) {
    return { status: 'skipped', reason: 'recent', preferences, journal }
  }
  const paths = statePaths(resolveStateRoot(stateRoot))
  return withLifecycleMutation(paths, 'updates.auto', dependencies, async () => {
    await writeJournal(stateRoot, { phase: 'checking', lastRunAt: new Date(now).toISOString() })
    const tools = await inspectToolUpdates(stateRoot, {
      fetch: options.fetch,
      signal: options.signal,
      persist: true,
    })
    const application = await checkApplicationUpdate({
      fetch: options.fetch,
      signal: options.signal,
      channel: preferences.channel,
      currentVersion: options.currentVersion,
    }).catch((error) => ({
      availability: 'check-failed',
      error: { code: error instanceof AgentHostError ? error.code : 'GITHUB_REQUEST_FAILED', message: error instanceof Error ? error.message : String(error) },
    }))
    const downloaded = []
    const installed = []
    if (preferences.autoDownload === true && application.availability === 'update-available') {
      downloaded.push(await updateApplication({
        stateRoot,
        fetch: options.fetch,
        signal: options.signal,
        channel: preferences.channel,
        currentVersion: options.currentVersion,
        dryRun: preferences.autoInstall !== true,
      }, dependencies))
    }
    if (preferences.autoInstall === true) {
      for (const tool of tools.filter((item) => item.availability === 'update-available')) {
        installed.push(await updateGitHubTool({
          stateRoot,
          target: tool.id,
          fetch: options.fetch,
          signal: options.signal,
        }, dependencies))
      }
    }
    const result = {
      status: 'ok',
      preferences,
      application,
      tools: tools.map((item) => ({
        id: item.id,
        availability: item.availability,
        installedVersion: item.installedVersion,
        availableVersion: item.availableVersion,
      })),
      downloaded,
      installed,
    }
    await writeJournal(stateRoot, {
      phase: 'complete',
      lastRunAt: new Date(now).toISOString(),
      lastResult: {
        application: application.availability,
        toolsChecked: tools.length,
        installed: installed.length,
      },
    })
    return result
  })
}
