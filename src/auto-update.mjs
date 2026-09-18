import { join } from 'node:path'
import { AgentHostError } from './errors.mjs'
import { readJson, writePrivateJson } from './json.mjs'
import { resolveStateRoot } from './paths.mjs'
import { prepareStatePaths } from './state.mjs'
import { readUpdatePreferences } from './update-preferences.mjs'
import { inspectToolUpdates, updateGitHubTool, downloadGitHubToolUpdate } from './tool-updates.mjs'
import { checkApplicationUpdate, packageJsonApplicationVersion, resolveInstalledApplicationVersion, updateApplication } from './application-update.mjs'
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
  const fetch = options.fetch ?? dependencies.fetch
  const signal = options.signal ?? dependencies.signal
  // Resolve the installed payload version once at entry so production maintenance
  // (which does not pass currentVersion) still drives app check/download/install.
  const resolved = await resolveInstalledApplicationVersion({
    stateRoot,
    currentVersion: options.currentVersion,
    platform: options.platform,
    applicationRoots: options.applicationRoots,
    currentRoot: options.currentRoot,
  }, dependencies)
  const currentVersion = options.currentVersion
    ?? resolved.version
    ?? await packageJsonApplicationVersion().catch(() => null)
  const paths = statePaths(resolveStateRoot(stateRoot))
  return withLifecycleMutation(paths, 'updates.auto', dependencies, async (locked) => {
    await writeJournal(stateRoot, { phase: 'checking', lastRunAt: new Date(now).toISOString() })
    const tools = await inspectToolUpdates(stateRoot, {
      fetch,
      signal,
      persist: true,
    }, locked)
    const application = await checkApplicationUpdate({
      fetch,
      signal,
      channel: preferences.channel,
      currentVersion,
      platform: options.platform,
    }).catch((error) => ({
      availability: 'check-failed',
      error: { code: error instanceof AgentHostError ? error.code : 'GITHUB_REQUEST_FAILED', message: error instanceof Error ? error.message : String(error) },
    }))
    const downloaded = []
    const installed = []
    if (preferences.autoInstall === true) {
      if (application.availability === 'update-available') {
        installed.push(await updateApplication({
          stateRoot,
          fetch,
          signal,
          channel: preferences.channel,
          currentVersion,
          platform: options.platform,
          dryRun: false,
        }, locked))
      }
      for (const tool of tools.filter((item) => item.availability === 'update-available')) {
        installed.push(await updateGitHubTool({
          stateRoot,
          target: tool.id,
          fetch,
          signal,
          probe: options.probe,
        }, locked))
      }
    } else if (preferences.autoDownload === true) {
      if (application.availability === 'update-available') {
        downloaded.push(await updateApplication({
          stateRoot,
          fetch,
          signal,
          channel: preferences.channel,
          currentVersion,
          platform: options.platform,
          downloadOnly: true,
          dryRun: false,
        }, locked))
      }
      for (const tool of tools.filter((item) => item.availability === 'update-available')) {
        downloaded.push(await downloadGitHubToolUpdate({
          stateRoot,
          target: tool.id,
          fetch,
          signal,
        }, locked))
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
        downloaded: downloaded.length,
      },
    })
    return result
  })
}
