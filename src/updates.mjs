import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { inspectSourceStatus } from './source-status.mjs'
import { inspectToolUpdates, checkRegisteredTool, installGitHubTool, updateGitHubTool, updateAvailability } from './tool-updates.mjs'
import { browseRecommendedTools } from './github-project.mjs'
import { checkApplicationUpdate, packageJsonApplicationVersion, recoverApplicationUpdate, resolveInstalledApplicationVersion, updateApplication } from './application-update.mjs'
import { inspectAgentAppUpdates } from './agent-app-updates.mjs'
import { readUpdatePreferences, setUpdatePreferences } from './update-preferences.mjs'
import { executeAutoUpdates } from './auto-update.mjs'
import { loadState, readStatePaths } from './state.mjs'
import { resolveStateRoot } from './paths.mjs'
import { AgentHostError } from './errors.mjs'

export const UPDATES_SCHEMA = 'openadam.agent-host-updates.v0.1'

const BOUNDARY = 'Application build, environment release, and tool versions are separate. GitHub catalog data cannot execute commands. profiles fetch --carrier is not application self-update. A fresh Agent task is required after a tool update takes effect.'

async function packageVersion() {
  const pkg = JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
  return pkg.version
}

function publicError(error) {
  return {
    code: error instanceof AgentHostError ? error.code : 'UPDATES_FAILED',
    message: error instanceof Error ? error.message : String(error),
  }
}

export async function updatesStatus(options = {}, dependencies = {}) {
  const recovery = await recoverApplicationUpdate(options.stateRoot, dependencies).catch((error) => ({
    recovered: false,
    error: publicError(error),
  }))
  const preferences = await readUpdatePreferences(options.stateRoot)
  let auto = null
  if (options.skipScheduledAuto !== true && preferences.autoCheck === true) {
    try {
      auto = await executeAutoUpdates(options.stateRoot, { ...options, skipIfNotDue: true }, dependencies)
    } catch (error) {
      auto = { status: 'error', error: publicError(error) }
    }
  }
  const source = await inspectSourceStatus(options, dependencies).catch((error) => ({ status: 'error', error }))
  const stateRoot = resolveStateRoot(options.stateRoot)
  const state = await loadState(await readStatePaths(stateRoot))
  const resolved = await resolveInstalledApplicationVersion(options, dependencies)
  const currentVersion = options.currentVersion
    ?? resolved.version
    ?? source?.application?.version
    ?? await packageJsonApplicationVersion().catch(() => packageVersion())
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
    : await inspectToolUpdates(options.stateRoot, { fetch: options.fetch, signal: options.signal }, dependencies)
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
  const failed = items.some((item) => item.availability === 'check-failed') || auto?.status === 'error'
  return {
    schemaVersion: UPDATES_SCHEMA,
    status: failed ? 'partial' : 'ok',
    generatedAt: new Date().toISOString(),
    channel: options.channel ?? preferences.channel,
    preferences,
    source,
    recommended,
    items,
    auto,
    recovery: recovery?.recovered === true || recovery?.error !== undefined ? recovery : undefined,
    assessmentBoundary: BOUNDARY,
  }
}

export async function updatesCheck(options = {}, dependencies = {}) {
  const report = await updatesStatus({ ...options, skipScheduledAuto: options.skipScheduledAuto }, dependencies)
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
  const items = report.items.map((item) => {
    if (item.kind !== 'tool') return item
    const check = checks.find((entry) => entry.id === item.id)
    if (check === undefined || check.version === undefined) return item
    const compatible = check.compatible ?? item.candidate?.compatible ?? true
    const platformAvailable = check.platformAvailable ?? item.candidate?.platformAvailable ?? item.availability !== 'no-platform-asset'
    const availability = updateAvailability({
      installedVersion: item.installedVersion,
      availableVersion: check.version,
      compatible,
      platformAvailable,
    })
    return {
      ...item,
      availableVersion: check.version,
      availability,
      lastCheck: { at: new Date().toISOString(), status: availability, from: check.from },
      candidate: item.candidate === null || item.candidate === undefined ? item.candidate : {
        ...item.candidate,
        tag: check.tag ?? item.candidate.tag,
        version: check.version,
        from: check.from ?? item.candidate.from,
        digest: check.digest ?? item.candidate.digest,
        compatible,
        platformAvailable,
      },
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
    const report = await updatesStatus({ ...options, skipScheduledAuto: true }, dependencies)
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
