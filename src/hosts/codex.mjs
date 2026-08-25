import { AgentHostError } from '../errors.mjs'
import { resolveExecutable, runFile } from '../process.mjs'
import { fingerprintRelativeFiles } from '../development-manifest.mjs'

function parseJsonOutput(result, label) {
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    throw new AgentHostError('HOST_PROTOCOL_INVALID', `${label} returned invalid JSON: ${error.message}`)
  }
}

export async function inspectCodex(manifest, runner = runFile, options = {}) {
  const executable = await resolveExecutable('codex', runner)
  if (executable === null) throw new AgentHostError('CODEX_NOT_INSTALLED', 'Codex CLI is not installed or not on PATH')
  const versionResult = await runner(executable, ['--version'])
  const marketplaces = parseJsonOutput(await runner(executable, ['plugin', 'marketplace', 'list', '--json']), 'Codex marketplace list')
  const plugins = parseJsonOutput(await runner(executable, ['plugin', 'list', '--json']), 'Codex plugin list')
  const entries = []
  for (const component of Object.values(manifest.components).filter((item) => item.plugin !== undefined)) {
    const existingMarketplace = marketplaces.marketplaces.find((item) => item.name === component.marketplace)
    const existingPlugin = plugins.installed.find((item) => item.pluginId === `${component.plugin}@${component.marketplace}`)
    const duplicatePlugins = plugins.installed.filter((item) => item.name === component.plugin && item.pluginId !== `${component.plugin}@${component.marketplace}` && item.installed === true && item.enabled === true)
    if (existingMarketplace !== undefined) {
      const existingSource = existingMarketplace.marketplaceSource?.source ?? existingMarketplace.root
      if (existingSource !== component.marketplaceRoot && existingMarketplace.root !== component.marketplaceRoot) {
        throw new AgentHostError('CODEX_MARKETPLACE_CONFLICT', `Codex marketplace ${component.marketplace} already points elsewhere`, {
          current: existingSource,
          requested: component.marketplaceRoot,
        })
      }
    }
    const migratableDuplicates = []
    for (const duplicate of duplicatePlugins) {
      const sourcePath = duplicate.source?.path
      if (typeof sourcePath !== 'string') {
        throw new AgentHostError('CODEX_PLUGIN_CONFLICT', `Codex already enables ${duplicate.pluginId} with a different or unverifiable identity`, {
          currentVersion: duplicate.version ?? null,
          requestedVersion: component.version,
        })
      }
      let duplicateFingerprint
      try {
        duplicateFingerprint = await fingerprintRelativeFiles(sourcePath, component.pluginIdentityRelativeFiles)
      } catch (error) {
        throw new AgentHostError('CODEX_PLUGIN_CONFLICT', `Codex already enables ${duplicate.pluginId}, but its plugin bytes cannot be verified`, { message: error.message })
      }
      if (duplicateFingerprint !== component.pluginIdentityFingerprint && options.replaceConflicts !== true) {
        throw new AgentHostError('CODEX_PLUGIN_CONFLICT', `Codex already enables ${duplicate.pluginId} with different plugin bytes`)
      }
      migratableDuplicates.push({
        selector: duplicate.pluginId,
        marketplace: duplicate.marketplaceName,
        version: duplicate.version,
        sourcePath,
        identityMatched: duplicateFingerprint === component.pluginIdentityFingerprint,
      })
    }
    entries.push({
      component: component.plugin,
      marketplace: component.marketplace,
      marketplaceRoot: component.marketplaceRoot,
      selector: `${component.plugin}@${component.marketplace}`,
      marketplacePresent: existingMarketplace !== undefined,
      pluginPresent: existingPlugin?.installed === true,
      pluginEnabled: existingPlugin?.enabled === true,
      installedVersion: existingPlugin?.version ?? null,
      requestedVersion: component.version,
      managedTarget: options.managedState?.entries?.some((item) => item.selector === `${component.plugin}@${component.marketplace}` && item.pluginCreated === true) === true,
      migratableDuplicates,
    })
  }
  return { executable, version: versionResult.stdout.trim(), entries }
}

export async function installCodex(manifest, runner = runFile, options = {}) {
  const inspection = await inspectCodex(manifest, runner, options)
  const installed = []
  for (const entry of inspection.entries) {
    let marketplaceCreated = false
    let pluginCreated = false
    const displacedPlugins = []
    for (const duplicate of entry.migratableDuplicates) {
      await runner(inspection.executable, ['plugin', 'remove', duplicate.selector, '--json'])
      displacedPlugins.push(duplicate)
    }
    if (!entry.marketplacePresent) {
      await runner(inspection.executable, ['plugin', 'marketplace', 'add', entry.marketplaceRoot, '--json'])
      marketplaceCreated = true
    }
    if (entry.pluginPresent && entry.installedVersion !== entry.requestedVersion) {
      if (!entry.managedTarget && options.replaceConflicts !== true) {
        throw new AgentHostError('CODEX_PLUGIN_CONFLICT', `${entry.selector} is installed at ${entry.installedVersion}, not ${entry.requestedVersion}`)
      }
      await runner(inspection.executable, ['plugin', 'remove', entry.selector, '--json'])
      await runner(inspection.executable, ['plugin', 'add', entry.selector, '--json'])
      pluginCreated = entry.managedTarget
    } else if (!entry.pluginPresent || !entry.pluginEnabled) {
      await runner(inspection.executable, ['plugin', 'add', entry.selector, '--json'])
      pluginCreated = true
    }
    installed.push({ ...entry, marketplaceCreated, pluginCreated, displacedPlugins })
  }
  const current = await inspectCodex(manifest, runner, { replaceConflicts: true, managedState: options.managedState })
  for (const entry of current.entries) {
    if (!entry.pluginPresent || !entry.pluginEnabled) {
      throw new AgentHostError('CODEX_PLUGIN_UNAVAILABLE', `Codex did not expose installed plugin ${entry.selector}`)
    }
  }
  return { kind: 'codex', version: inspection.version, entries: installed, restartRequired: true }
}

export async function uninstallCodex(hostState, runner = runFile) {
  const executable = await resolveExecutable('codex', runner)
  if (executable === null) return { kind: 'codex', unavailable: true, removed: [] }
  const removed = []
  for (const entry of [...hostState.entries].reverse()) {
    if (entry.pluginCreated) {
      const result = await runner(executable, ['plugin', 'remove', entry.selector, '--json'], { allowFailure: true })
      removed.push({ target: entry.selector, kind: 'plugin', status: result.status })
    }
    if (entry.marketplaceCreated) {
      const result = await runner(executable, ['plugin', 'marketplace', 'remove', entry.marketplace, '--json'], { allowFailure: true })
      removed.push({ target: entry.marketplace, kind: 'marketplace', status: result.status })
    }
    for (const displaced of entry.displacedPlugins ?? []) {
      const result = await runner(executable, ['plugin', 'add', displaced.selector, '--json'], { allowFailure: true })
      removed.push({ target: displaced.selector, kind: 'restored-plugin', status: result.status })
    }
  }
  return { kind: 'codex', removed }
}
