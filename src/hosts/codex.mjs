import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { homedir } from 'node:os'
import { AgentHostError } from '../errors.mjs'
import { resolveExecutable, runFile } from '../process.mjs'
import { fingerprintRelativeFiles } from '../development-manifest.mjs'
import { writePrivateJson } from '../json.mjs'
import { environmentDependencies } from '../environment-change.mjs'
import { equal, getCell, restoreFields } from '../environment-resource-state.mjs'
import { withCodexConfiguration } from './codex-config.mjs'
import { writeEnvironmentCodex } from './codex-config-resource.mjs'

const error = (code, message) => new AgentHostError(code, message)
const entriesOf = (state) => [...(state?.entries ?? []), ...(state?.inactiveEntries ?? [])]
const pluginKey = (selector) => ['plugins', selector]
const enabledKey = (selector) => ['plugins', selector, 'enabled']
const cellValue = (cell) => cell.present ? cell.value : null
const legacyUnsafe = (entry) => entry?.restorePlugin === true || entry?.displacedMarketplace != null || (entry?.displacedPlugins ?? []).some((item) => item.before === undefined)

function parse(result) {
  try { return JSON.parse(result.stdout) } catch { throw error('HOST_PROTOCOL_INVALID', 'Codex returned an invalid plugin response') }
}

async function session(runner, options, callback) {
  const inherited = environmentDependencies() ?? {}
  const executable = await resolveExecutable('codex', runner)
  if (executable === null) throw error('CODEX_NOT_INSTALLED', 'Codex CLI is not installed or not on PATH')
  const home = options.homeRoot ?? inherited.hostSkillHome
  const configRoot = options.managedState?.configPath === undefined
    ? options.configRoot ?? inherited.codexConfigRoot ?? (home === undefined ? undefined : join(home, '.codex'))
    : dirname(options.managedState.configPath)
  const factory = options.codexConfiguration ?? inherited.codexConfiguration ?? withCodexConfiguration
  return factory(executable, { configRoot, cwd: homedir(), signal: options.signal ?? inherited.signal }, async (client) => {
    const snapshot = await client.read()
    const invoke = (args) => runner(executable, args, {
      env: { ...process.env, CODEX_HOME: dirname(snapshot.filePath) }, cwd: dirname(snapshot.filePath),
    })
    const version = (await invoke(['--version'])).stdout.trim()
    return callback({ client, executable, version, invoke, snapshot })
  })
}

async function cacheMatches(path, files, fingerprint) {
  if (typeof path !== 'string' || !isAbsolute(path)) return false
  try {
    if (!Array.isArray(files) || files.length === 0 || new Set(files).size !== files.length
      || files.some((name) => typeof name !== 'string' || name.includes('\\') || name.split('/').some((part) => ['', '.', '..'].includes(part)))) return false
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) return false
    const expected = new Set(files)
    const remaining = new Set(files)
    const pending = ['']
    while (pending.length > 0) {
      const prefix = pending.pop()
      for (const entry of await readdir(join(path, prefix), { withFileTypes: true })) {
        const name = prefix === '' ? entry.name : prefix + '/' + entry.name
        if (entry.isSymbolicLink()) return false
        if (entry.isDirectory()) pending.push(name)
        else if (entry.isFile() && expected.has(name)) remaining.delete(name)
        else return false
      }
    }
    if (remaining.size > 0) return false
    return await fingerprintRelativeFiles(path, files) === fingerprint
  } catch { return false }
}

async function inspect(session, manifest, options) {
  const listed = parse(await session.invoke(['plugin', 'list', '--json']))
  if (!Array.isArray(listed.installed)) throw error('HOST_PROTOCOL_INVALID', 'Codex plugin listing lacks installed entries')
  const previous = entriesOf(options.managedState)
  const entries = []
  const seenComponents = new Set()
  for (const component of Object.values(manifest.components).filter((item) => item.plugin !== undefined)) {
    if (seenComponents.has(component.plugin) || new Set(previous.filter((item) => item.component === component.plugin).map((item) => item.selector)).size > 1) {
      throw error('CODEX_BINDING_AMBIGUOUS', 'A Codex component has more than one candidate or retained binding')
    }
    seenComponents.add(component.plugin)
    const managed = previous.find((item) => item.component === component.plugin)
    const expected = options.useManagedBindings === true && managed !== undefined ? managed : component
    const target = managed === undefined ? null : listed.installed.find((item) => item.pluginId === managed.selector)
    const installedIdentityMatched = target?.installed === true && await cacheMatches(managed?.installedPath, expected.pluginIdentityRelativeFiles, expected.pluginIdentityFingerprint)
    const duplicates = listed.installed.filter((item) => item.name === component.plugin && item.installed === true && item.enabled === true && item.pluginId !== managed?.selector)
    const ownedSelectors = new Set(previous.filter((item) => item.pluginCreated === true).map((item) => item.selector))
    if (duplicates.some((item) => !ownedSelectors.has(item.pluginId)) && options.replaceConflicts !== true && options.useManagedBindings !== true) {
      throw error('CODEX_PLUGIN_CONFLICT', 'Codex already enables another installation of ' + component.plugin + '; replacement must explicitly allow disabling it')
    }
    if (legacyUnsafe(managed) && options.useManagedBindings !== true) {
      throw error('CODEX_LEGACY_RESTORE_UNVERIFIABLE', 'The older Codex binding lacks exact recoverable displacement records')
    }
    if (managed !== undefined && managed.configurationVersion !== 1 && options.useManagedBindings !== true) {
      const registration = getCell(session.snapshot.config, pluginKey(managed.selector))
      const marketplace = getCell(session.snapshot.config, ['marketplaces', managed.marketplace])
      const otherRegistrations = Object.keys(session.snapshot.config.plugins ?? {}).filter((selector) =>
        selector !== managed.selector && selector.endsWith('@' + managed.marketplace))
      if (managed.pluginCreated !== true || managed.marketplaceCreated !== true || otherRegistrations.length > 0
        || !equal(marketplace, { present: true, value: { source_type: 'local', source: managed.marketplaceRoot } })
        || (registration.present && !equal(registration.value, { enabled: true }) && !equal(registration.value, { enabled: false }))) {
        throw error('CODEX_LEGACY_IDENTITY_UNVERIFIABLE', 'The legacy registration cannot be retired without changing shared or user-modified configuration')
      }
    }
    entries.push({
      component: component.plugin, marketplace: managed?.marketplace ?? component.marketplace,
      selector: managed?.selector ?? component.plugin + '@' + component.marketplace,
      marketplaceRoot: expected.marketplaceRoot, pluginRoot: expected.pluginRoot,
      pluginIdentityRelativeFiles: expected.pluginIdentityRelativeFiles, pluginIdentityFingerprint: expected.pluginIdentityFingerprint,
      marketplacePresent: managed !== undefined && getCell(session.snapshot.config, ['marketplaces', managed.marketplace]).present,
      pluginPresent: target?.installed === true, pluginEnabled: target?.enabled === true,
      installedVersion: target?.version ?? null, requestedVersion: component.version,
      installedIdentityMatched, installedIdentityError: installedIdentityMatched ? null : 'No matching cached installation was verified from an installation receipt',
      managedTarget: managed?.pluginCreated === true, migratableDuplicates: duplicates.map((item) => ({ selector: item.pluginId, marketplace: item.marketplaceName })),
    })
  }
  return { executable: session.executable, version: session.version, configPath: session.snapshot.filePath, entries }
}

export async function inspectCodex(manifest, runner = runFile, options = {}) {
  return session(runner, options, (current) => inspect(current, manifest, options))
}

async function freshBinding(component) {
  const base = component.hostProjectionRoot
  if (typeof base !== 'string' || !isAbsolute(base)) throw error('CODEX_PROJECTION_REQUIRED', 'Codex installation requires a materialized Host projection')
  const root = await realpath(base)
  const pluginSource = await realpath(component.pluginRoot)
  const part = relative(root, pluginSource)
  if (part === '' || part === '..' || part.startsWith('..' + sep) || isAbsolute(part)) throw error('CODEX_PROJECTION_INVALID', 'The plugin is outside its Host projection')
  if (!await cacheMatches(pluginSource, component.pluginIdentityRelativeFiles, component.pluginIdentityFingerprint)) {
    throw error('CODEX_PROJECTION_INVALID', 'The projected plugin differs from its verified source')
  }
  const marketplace = 'agent-host-' + randomUUID().replaceAll('-', '')
  const nativeRoot = join(root, 'native-bindings', marketplace)
  const marketplaceRoot = join(nativeRoot, 'marketplace')
  const pluginRoot = join(marketplaceRoot, 'plugins', component.plugin)
  try {
    await mkdir(join(marketplaceRoot, '.agents', 'plugins'), { recursive: true, mode: 0o700 })
    await cp(pluginSource, pluginRoot, { recursive: true, errorOnExist: true, force: false })
    await writePrivateJson(join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), {
      name: marketplace, interface: { displayName: 'Agent Host Local' },
      plugins: [{ name: component.plugin, source: { source: 'local', path: './plugins/' + component.plugin },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } }],
    })
    if (!await cacheMatches(pluginRoot, component.pluginIdentityRelativeFiles, component.pluginIdentityFingerprint)) {
      throw error('CODEX_PROJECTION_INVALID', 'The native binding copy differs from its verified projection')
    }
  } catch (failure) { await rm(nativeRoot, { recursive: true, force: true }); throw failure }
  return { marketplace, nativeMarketplaceRoot: marketplaceRoot, selector: component.plugin + '@' + marketplace }
}

async function changeSession(current, callback) {
  const undo = []
  const change = async (changes, apply = null) => {
    const before = await current.client.read()
    const record = { changes: changes.map(({ keys, value }) => ({ keys, before: getCell(before.config, keys),
      after: value === null ? { present: false } : { present: true, value } })) }
    undo.push(record)
    return writeEnvironmentCodex(current.client, before, changes, apply)
  }
  try { return await callback(change) } catch (cause) {
    // The lifecycle engine owns multi-resource recovery. Standalone adapter
    // callers still receive compensation through the same native field rules.
    if (environmentDependencies() === null) {
      try {
        for (const step of undo.reverse()) {
          const before = await current.client.read()
          restoreFields(step, before.config)
          const changes = step.changes.filter((item) => !equal(getCell(before.config, item.keys), item.before))
            .map((item) => ({ keys: item.keys, value: cellValue(item.before) }))
          if (changes.length > 0) await writeEnvironmentCodex(current.client, before, changes)
        }
      } catch (recovery) {
        throw new AgentHostError('CODEX_RECOVERY_REQUIRED', 'Codex configuration could not be fully restored; its conflicting entries were preserved', {
          causeCode: cause.code ?? 'HOST_COMMAND_FAILED', recoveryCode: recovery.code ?? 'HOST_COMMAND_FAILED',
        })
      }
    }
    throw cause
  }
}

export async function installCodex(manifest, runner = runFile, options = {}) {
  return session(runner, options, async (current) => {
    const inspection = await inspect(current, manifest, options)
    return changeSession(current, async (change) => {
      const installed = []
      for (const component of Object.values(manifest.components).filter((item) => item.plugin !== undefined)) {
        const prior = entriesOf(options.managedState).find((item) => item.component === component.plugin)
        const observed = inspection.entries.find((item) => item.component === component.plugin)
        const snapshot = await current.client.read()
        const priorCell = prior === undefined ? { present: false } : getCell(snapshot.config, pluginKey(prior.selector))
        const displacedPlugins = [...(prior?.displacedPlugins ?? [])]
        for (const duplicate of observed.migratableDuplicates) {
          const before = await current.client.read()
          const keys = enabledKey(duplicate.selector)
          if (!displacedPlugins.some((item) => item.selector === duplicate.selector)) {
            displacedPlugins.push({ ...duplicate, before: getCell(before.config, keys) })
          }
          await change([{ keys, value: false }])
        }
        const sameProjection = prior?.configurationVersion === 1 && prior.pluginRoot === component.pluginRoot
          && prior.pluginIdentityFingerprint === component.pluginIdentityFingerprint
        if (sameProjection && observed.installedIdentityMatched) {
          const expected = { ...(prior.pluginBinding ?? {}), enabled: observed.pluginEnabled }
          if (!equal(priorCell, { present: true, value: expected }) && options.replaceConflicts !== true) {
            throw error('CODEX_PLUGIN_CHANGED', 'The managed Codex registration changed after installation')
          }
          if (!observed.pluginEnabled) await change([{ keys: enabledKey(prior.selector), value: true }])
          installed.push({ ...prior, pluginBinding: { ...priorCell.value, enabled: true }, displacedPlugins })
          continue
        }
        if (sameProjection && priorCell.present && options.replaceConflicts !== true) {
          throw error('CODEX_PLUGIN_CHANGED', 'The cached Codex installation changed or cannot be verified; replacement requires a new Host binding')
        }
        const native = await freshBinding(component)
        const available = await current.client.read()
        if (getCell(available.config, pluginKey(native.selector)).present || getCell(available.config, ['marketplaces', native.marketplace]).present) {
          throw error('CODEX_PLUGIN_CONFLICT', 'The new Host binding identity is already registered')
        }
        const marketplaceBinding = { source_type: 'local', source: native.nativeMarketplaceRoot }
        await change([{ keys: ['marketplaces', native.marketplace], value: marketplaceBinding },
          { keys: pluginKey(native.selector), value: { enabled: false } }])
        let receipt
        // Codex's public installer writes enabled=true as well as filling its
        // own cache. The fresh selector was previously unreferenced, so undo
        // can remove its registration without overwriting an earlier cache.
        await change([{ keys: enabledKey(native.selector), value: true }], async () => {
          receipt = parse(await current.invoke(['plugin', 'add', native.selector, '--json']))
        })
        if (!await cacheMatches(receipt?.installedPath, component.pluginIdentityRelativeFiles, component.pluginIdentityFingerprint)) {
          throw error('CODEX_PLUGIN_UNAVAILABLE', 'Codex did not install the verified plugin bytes at its returned installation path')
        }
        if (prior !== undefined && prior.pluginCreated === true) {
          const before = await current.client.read()
          const existing = getCell(before.config, pluginKey(prior.selector))
          if (prior.configurationVersion === 1 && existing.present && !equal(existing.value, prior.pluginBinding)
            && !equal(existing.value, { ...prior.pluginBinding, enabled: false })) {
            throw error('CODEX_PLUGIN_CHANGED', 'The previous managed Codex registration changed after installation')
          }
          await change([{ keys: pluginKey(prior.selector), value: null }])
          const previousMarketplace = prior.configurationVersion === 1 ? prior.marketplaceBinding
            : { source_type: 'local', source: prior.marketplaceRoot }
          if (prior.marketplaceCreated === true
            && equal(getCell((await current.client.read()).config, ['marketplaces', prior.marketplace]), { present: true, value: previousMarketplace })) {
            await change([{ keys: ['marketplaces', prior.marketplace], value: null }])
          }
        } else if (prior !== undefined && priorCell.present) {
          if (options.replaceConflicts !== true) throw error('CODEX_PLUGIN_CONFLICT', 'Replacing an adopted Codex plugin requires explicit replacement')
          if (!displacedPlugins.some((item) => item.selector === prior.selector)) {
            displacedPlugins.push({ selector: prior.selector, marketplace: prior.marketplace, before: getCell(snapshot.config, enabledKey(prior.selector)) })
          }
          await change([{ keys: enabledKey(prior.selector), value: false }])
        }
        installed.push({ ...native, component: component.plugin, configurationVersion: 1,
          marketplaceRoot: component.marketplaceRoot, pluginRoot: component.pluginRoot,
          pluginIdentityRelativeFiles: component.pluginIdentityRelativeFiles, pluginIdentityFingerprint: component.pluginIdentityFingerprint,
          requestedVersion: component.version, installedVersion: component.version, installedPath: receipt.installedPath,
          marketplaceCreated: true, pluginCreated: true, marketplaceBinding, pluginBinding: { enabled: true },
          displacedMarketplace: null, restorePlugin: false, displacedPlugins })
      }
      return { kind: 'codex', configurationVersion: 1, configPath: current.snapshot.filePath, version: current.version, entries: installed, restartRequired: true }
    })
  })
}

async function remove(hostState, runner, options, suspend) {
  return session(runner, { ...options, managedState: hostState }, (current) => changeSession(current, async (change) => {
    const results = []
    for (const entry of [...hostState.entries].reverse()) {
      if (legacyUnsafe(entry)) throw error('CODEX_LEGACY_RESTORE_UNVERIFIABLE', 'The older Codex binding lacks exact recoverable displacement records')
      if (entry.pluginCreated !== true) {
        if (suspend) throw error('TOOL_SET_UNMANAGED_BINDING', 'An adopted Codex plugin cannot be hidden without explicit replacement')
        continue
      }
      if (entry.configurationVersion !== 1) throw error('CODEX_LEGACY_IDENTITY_UNVERIFIABLE', 'The older Codex installation has no cached-byte receipt; migrate it before removal')
      const snapshot = await current.client.read()
      const actual = getCell(snapshot.config, pluginKey(entry.selector))
      const suspended = { ...entry.pluginBinding, enabled: false }
      if (Object.keys(snapshot.config.plugins ?? {}).some((selector) => selector !== entry.selector && selector.endsWith('@' + entry.marketplace))) {
        throw error('CODEX_MARKETPLACE_CHANGED', 'Another registration now depends on the Host marketplace; its supporting files must remain recorded')
      }
      if (actual.present && !equal(actual.value, entry.pluginBinding) && !equal(actual.value, suspended)) {
        // This registration may still depend on Host-owned source and runtime
        // paths. Keep its ownership state until the changed binding is resolved;
        // forgetting it here would let a later purge delete referenced bytes.
        throw error('CODEX_PLUGIN_CHANGED', 'The managed Codex registration was changed by another writer; its binding and supporting files must remain recorded')
      }
      if (actual.present) await change([{ keys: suspend ? enabledKey(entry.selector) : pluginKey(entry.selector), value: suspend ? false : null }])
      if (!suspend) {
        for (const displaced of entry.displacedPlugins ?? []) {
          const keys = enabledKey(displaced.selector)
          const value = getCell((await current.client.read()).config, keys)
          if (equal(value, { present: true, value: false })) await change([{ keys, value: cellValue(displaced.before) }])
          else if (!equal(value, displaced.before)) results.push({ target: displaced.selector, status: 'preserved-user-change' })
        }
        if (equal(getCell((await current.client.read()).config, ['marketplaces', entry.marketplace]), { present: true, value: entry.marketplaceBinding })) {
          await change([{ keys: ['marketplaces', entry.marketplace], value: null }])
        }
      }
      results.push({ target: entry.selector, kind: 'plugin', status: 0 })
    }
    return { kind: 'codex', [suspend ? 'suspended' : 'removed']: results }
  }))
}

export async function uninstallCodex(hostState, runner = runFile, options = {}) { return remove(hostState, runner, options, false) }
export async function suspendCodex(hostState, runner = runFile, options = {}) { return remove(hostState, runner, options, true) }
