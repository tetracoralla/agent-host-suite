import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { inspectSourceStatus } from './source-status.mjs'
import { inspectToolUpdates, checkRegisteredTool, installGitHubTool, updateGitHubTool, updateAvailability } from './tool-updates.mjs'
import { browseRecommendedTools } from './github-project.mjs'
import { checkApplicationUpdate, recoverApplicationUpdate, updateApplication } from './application-update.mjs'
import { inspectAgentAppUpdates } from './agent-app-updates.mjs'
import { readUpdatePreferences, setUpdatePreferences } from './update-preferences.mjs'
import { executeAutoUpdates } from './auto-update.mjs'
import { loadState, readStatePaths } from './state.mjs'
import { resolveStateRoot } from './paths.mjs'

export const UPDATES_SCHEMA = 'openadam.agent-host-updates.v0.1'

const BOUNDARY = 'Application build, environment release, and tool versions are separate. GitHub catalog data cannot execute commands. profiles fetch --carrier is not application self-update. A fresh Agent task is required after a tool update takes effect.'

async function packageVersion() {
  const pkg = JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
  return pkg.version
}

export async function updatesStatus(options = {}, dependencies = {}) {
  await recoverApplicationUpdate(options.stateRoot).catch(() => {})
  const preferences = await readUpdatePreferences(options.stateRoot)
  if (options.skipScheduledAuto !== true && preferences.autoCheck === true) {
    await executeAutoUpdates(options.stateRoot, { ...options, skipIfNotDue: true }, dependencies).catch(() => {})
  }
  const source = await inspectSourceStatus(options, dependencies).catch((error) => ({ status: 'error', error }))
  const stateRoot = resolveStateRoot(options.stateRoot)
  const state = await loadState(await readStatePaths(stateRoot))
  const currentVersion = source?.application?.version ?? await packageVersion()
  const application = await checkApplicationUpdate({
    fetch: options.fetch,
    signal: options.signal,
    channel: options.channel ?? preferences.channel,
    currentVersion,
  }).catch((error) => ({
    schemaVersion: 'openadam.agent-host-application-update.v0.1',
    status: 'check-failed',
    availability: 'check-failed',
    currentVersion,
    error: { code: error.code, message: error.message },
  }))
  const tools = state === null
    ? []
    : await inspectToolUpdates(options.stateRoot, { fetch: options.fetch, signal: options.signal })
  const agentApps = await inspectAgentAppUpdates({ runner: dependencies.runner })
  const recommended = await browseRecommendedTools()
  const items = [
    {
      kind: 'application',
      id: 'agent-host',
      displayName: 'Agent Host',
      installedVersion: application.currentVersion,
      availableVersion: application.availableVersion ?? null,
      availability: application.availability,
      source: { kind: 'github-release', repository: 'tetracoralla/agent-host-suite', channel: application.channel ?? preferences.channel },
      lastCheck: application.status === 'ok' ? { at: new Date().toISOString(), status: application.availability } : application.error,
      notarized: false,
      note: application.note,
    },
    ...tools,
    ...agentApps,
  ]
  const failed = items.some((item) => item.availability === 'check-failed')
  return {
    schemaVersion: UPDATES_SCHEMA,
    status: failed ? 'partial' : 'ok',
    generatedAt: new Date().toISOString(),
    channel: options.channel ?? preferences.channel,
    preferences,
    source,
    recommended,
    items,
    assessmentBoundary: BOUNDARY,
  }
}

export async function updatesCheck(options = {}, dependencies = {}) {
  const report = await updatesStatus(options, dependencies)
  const tools = report.items.filter((item) => item.kind === 'tool' && item.source?.repository)
  const checks = []
  for (const tool of tools) {
    try {
      checks.push(await checkRegisteredTool(tool.id, {
        fetch: options.fetch,
        signal: options.signal,
        channel: report.channel,
        stateRoot: options.stateRoot,
      }))
    } catch (error) {
      checks.push({ id: tool.id, error: { code: error.code, message: error.message } })
    }
  }
  const byId = new Map(checks.filter((item) => item.version !== undefined).map((item) => [item.id, item]))
  const items = report.items.map((item) => {
    const check = byId.get(item.id)
    if (check === undefined) return item
    const availableVersion = check.version
    const availability = item.kind !== 'tool' ? item.availability : updateAvailability({
      installedVersion: item.installedVersion,
      availableVersion,
      platformAvailable: item.availability !== 'no-platform-asset',
    })
    return {
      ...item,
      availableVersion,
      availability,
      lastCheck: { at: new Date().toISOString(), status: availability, from: check.from },
    }
  })
  return { ...report, items, githubChecks: checks }
}

export async function updatesInstall(options, dependencies = {}) {
  if (options.includeApp === true) {
    const application = await updateApplication(options, dependencies)
    if (options.id === 'agent-host' || options.all !== true && options.target === undefined && options.tools === undefined) {
      return application
    }
  }
  if (options.id === 'agent-host') return updateApplication(options, dependencies)
  if (options.github !== undefined) return installGitHubTool(options, dependencies)
  if (options.all === true) {
    const report = await updatesStatus(options, dependencies)
    const results = []
    for (const item of report.items.filter((entry) => entry.kind === 'tool' && entry.availability === 'update-available')) {
      results.push(await updateGitHubTool({ ...options, target: item.id }, dependencies))
    }
    return { schemaVersion: UPDATES_SCHEMA, status: 'ok', results }
  }
  if (typeof options.target === 'string' || typeof options.id === 'string') {
    return updateGitHubTool({ ...options, target: options.target ?? options.id }, dependencies)
  }
  return updatesStatus(options, dependencies)
}

export { browseRecommendedTools, installGitHubTool, setUpdatePreferences, updateGitHubTool }
