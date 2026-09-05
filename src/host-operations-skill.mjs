import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, symlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { platform } from 'node:os'
import { fileURLToPath } from 'node:url'
import { resolveLinkedSkillsRoot } from './agent-skill-location.mjs'
import { fingerprintRelativeFiles } from './development-manifest.mjs'
import { AgentHostError } from './errors.mjs'
import { inspectCodex, installCodex, uninstallCodex } from './hosts/codex.mjs'
import { writePrivateJson } from './json.mjs'

export const OPERATIONS_SKILL_ID = 'agent-host-operations'
const OPERATIONS_MARKETPLACE = 'agent-host-local'
const SOURCE_ROOT = fileURLToPath(new URL(`../skills/${OPERATIONS_SKILL_ID}/`, import.meta.url))
const PACKAGE_JSON = fileURLToPath(new URL('../package.json', import.meta.url))

function isContained(root, candidate) {
  const value = relative(root, candidate)
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value))
}

async function inventory(root, current = root, output = []) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name)
    if (entry.isSymbolicLink()) throw new AgentHostError('HOST_SKILL_SOURCE_INVALID', `Agent Host Skill contains a symbolic link: ${path}`)
    if (entry.isDirectory()) await inventory(root, path, output)
    else if (entry.isFile()) output.push(relative(root, path))
    else throw new AgentHostError('HOST_SKILL_SOURCE_INVALID', `Agent Host Skill contains a special file: ${path}`)
  }
  return output.sort()
}

async function fingerprint(root, files) {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file)
    hash.update('\0')
    hash.update(await readFile(join(root, file)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function sourceIdentity() {
  const info = await lstat(SOURCE_ROOT)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new AgentHostError('HOST_SKILL_SOURCE_INVALID', 'The packaged Agent Host Skill is unavailable')
  const files = await inventory(SOURCE_ROOT)
  if (!files.includes('SKILL.md') || !files.includes('scripts/agent-host') || !files.includes('scripts/agent-host.cmd')) {
    throw new AgentHostError('HOST_SKILL_SOURCE_INVALID', 'The packaged Agent Host Skill is incomplete')
  }
  return { files, fingerprint: await fingerprint(SOURCE_ROOT, files) }
}

async function existing(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function resolvedSymlink(path, info) {
  if (info?.isSymbolicLink() !== true) return null
  try {
    return await realpath(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function ensureRealDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new AgentHostError('HOST_SKILL_PATH_UNSAFE', `Agent Skill directory is unsafe: ${path}`)
}

async function materializeLinkedSkill(paths, identity, host) {
  const componentRoot = join(paths.hostProjections, 'operations-skills', host, OPERATIONS_SKILL_ID)
  const projectionRoot = join(componentRoot, identity.fingerprint.slice(0, 16))
  const current = await existing(projectionRoot)
  if (current !== null) {
    if (current.isSymbolicLink() || !current.isDirectory()) throw new AgentHostError('HOST_SKILL_PROJECTION_INVALID', `Agent Host Skill projection is unsafe: ${projectionRoot}`)
    if (await fingerprint(projectionRoot, identity.files) !== identity.fingerprint) {
      throw new AgentHostError('HOST_SKILL_PROJECTION_INVALID', 'Existing Agent Host Skill projection bytes differ')
    }
    return projectionRoot
  }
  const staging = join(componentRoot, `.staging-${process.pid}-${randomUUID()}`)
  await mkdir(componentRoot, { recursive: true, mode: 0o700 })
  try {
    await cp(SOURCE_ROOT, staging, { recursive: true, errorOnExist: true, force: false })
    if (await fingerprint(staging, identity.files) !== identity.fingerprint) {
      throw new AgentHostError('HOST_SKILL_PROJECTION_INVALID', 'Agent Host Skill projection copy differs from its packaged source')
    }
    await rename(staging, projectionRoot)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return projectionRoot
}

async function materializeCodexPlugin(paths, identity) {
  const packageManifest = JSON.parse(await readFile(PACKAGE_JSON, 'utf8'))
  const projectionFingerprint = createHash('sha256')
    .update(identity.fingerprint)
    .update('\0')
    .update(packageManifest.version)
    .digest('hex')
  const componentRoot = join(paths.hostProjections, 'operations-skills', 'codex', OPERATIONS_SKILL_ID)
  const projectionRoot = join(componentRoot, projectionFingerprint.slice(0, 16))
  const marketplaceRoot = join(projectionRoot, 'marketplace')
  const pluginRoot = join(marketplaceRoot, 'plugins', OPERATIONS_SKILL_ID)
  const marker = join(pluginRoot, '.codex-plugin', 'plugin.json')
  const projectionInfo = await existing(projectionRoot)
  if (projectionInfo !== null && (projectionInfo.isSymbolicLink() || !projectionInfo.isDirectory())) {
    throw new AgentHostError('HOST_SKILL_PROJECTION_INVALID', 'The Agent Host operations plugin projection is unsafe')
  }
  if (projectionInfo !== null && await existing(marker) === null) {
    throw new AgentHostError('HOST_SKILL_PROJECTION_INVALID', 'The Agent Host operations plugin projection is incomplete')
  }
  if (await existing(marker) === null) {
    const staging = join(componentRoot, `.staging-${process.pid}-${randomUUID()}`)
    const stagingMarketplace = join(staging, 'marketplace')
    const stagingPlugin = join(stagingMarketplace, 'plugins', OPERATIONS_SKILL_ID)
    try {
      await mkdir(join(stagingMarketplace, '.agents', 'plugins'), { recursive: true, mode: 0o700 })
      await mkdir(join(stagingPlugin, '.codex-plugin'), { recursive: true, mode: 0o700 })
      await cp(SOURCE_ROOT, join(stagingPlugin, 'skills', OPERATIONS_SKILL_ID), { recursive: true, errorOnExist: true, force: false })
      await writePrivateJson(join(stagingMarketplace, '.agents', 'plugins', 'marketplace.json'), {
        name: OPERATIONS_MARKETPLACE,
        interface: { displayName: 'Agent Host Local' },
        plugins: [{
          name: OPERATIONS_SKILL_ID,
          source: { source: 'local', path: `./plugins/${OPERATIONS_SKILL_ID}` },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: 'Productivity',
        }],
      })
      await writePrivateJson(join(stagingPlugin, '.codex-plugin', 'plugin.json'), {
        name: OPERATIONS_SKILL_ID,
        version: packageManifest.version,
        description: 'Inspect the locally installed Agent Host through its bounded published operations interface.',
        author: { name: 'openAdam' },
        license: 'Apache-2.0',
        skills: './skills/',
        interface: {
          displayName: 'Agent Host Operations',
          shortDescription: 'Inspect local Agent Host state without reading its internals.',
          developerName: 'openAdam',
          category: 'Productivity',
          capabilities: ['Read'],
        },
      })
      await mkdir(componentRoot, { recursive: true, mode: 0o700 })
      await rename(staging, projectionRoot)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
  const projectedSkillRoot = join(pluginRoot, 'skills', OPERATIONS_SKILL_ID)
  const projectedFiles = await inventory(projectedSkillRoot)
  if (JSON.stringify(projectedFiles) !== JSON.stringify(identity.files) || await fingerprint(projectedSkillRoot, projectedFiles) !== identity.fingerprint) {
    throw new AgentHostError('HOST_SKILL_PROJECTION_INVALID', 'The Agent Host operations plugin Skill bytes differ from the packaged source')
  }
  const [pluginManifest, marketplaceManifest] = await Promise.all([
    readFile(marker, 'utf8').then(JSON.parse),
    readFile(join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), 'utf8').then(JSON.parse),
  ])
  if (pluginManifest.name !== OPERATIONS_SKILL_ID || pluginManifest.version !== packageManifest.version || pluginManifest.skills !== './skills/' || pluginManifest.mcpServers !== undefined) {
    throw new AgentHostError('HOST_SKILL_PROJECTION_INVALID', 'The Agent Host operations plugin manifest differs from the packaged contract')
  }
  const marketplaceEntry = marketplaceManifest.plugins?.find((item) => item.name === OPERATIONS_SKILL_ID)
  if (marketplaceManifest.name !== OPERATIONS_MARKETPLACE || marketplaceEntry?.source?.path !== `./plugins/${OPERATIONS_SKILL_ID}`) {
    throw new AgentHostError('HOST_SKILL_PROJECTION_INVALID', 'The Agent Host operations marketplace manifest differs from the packaged contract')
  }
  const files = await inventory(pluginRoot)
  const pluginIdentityFingerprint = await fingerprintRelativeFiles(pluginRoot, files)
  return {
    projectionRoot,
    component: {
      version: packageManifest.version,
      fingerprint: projectionFingerprint,
      marketplaceRoot,
      pluginRoot,
      marketplace: OPERATIONS_MARKETPLACE,
      plugin: OPERATIONS_SKILL_ID,
      displayName: 'Agent Host Operations',
      pluginIdentityRelativeFiles: files,
      pluginIdentityFingerprint,
    },
  }
}

function mergeCodexOwnership(previous, next) {
  if (previous === null || previous === undefined) return next
  return {
    ...next,
    entries: next.entries.map((entry) => {
      const old = previous.entries.find((item) => item.selector === entry.selector)
      return {
        ...entry,
        marketplaceCreated: entry.marketplaceCreated || old?.marketplaceCreated === true,
        pluginCreated: entry.pluginCreated || old?.pluginCreated === true,
        displacedMarketplace: old?.displacedMarketplace ?? (old?.marketplaceCreated === true ? null : entry.displacedMarketplace ?? null),
        restorePlugin: old?.restorePlugin === true || (old?.pluginCreated !== true && entry.restorePlugin === true),
        displacedPlugins: [...new Map([...(old?.displacedPlugins ?? []), ...(entry.displacedPlugins ?? [])].map((item) => [item.selector, item])).values()],
      }
    }),
  }
}

function codexManifest(component) {
  return { components: { [OPERATIONS_SKILL_ID]: component } }
}

function managedCodexComponent(managed) {
  const entry = managed.binding.entries[0]
  return {
    version: entry.requestedVersion,
    marketplaceRoot: entry.marketplaceRoot,
    pluginRoot: entry.pluginRoot,
    marketplace: entry.marketplace,
    plugin: entry.component,
    displayName: 'Agent Host Operations',
    pluginIdentityRelativeFiles: entry.pluginIdentityRelativeFiles,
    pluginIdentityFingerprint: entry.pluginIdentityFingerprint,
  }
}

export async function preflightOperationsSkill(host, paths, runner, options = {}) {
  const identity = await sourceIdentity()
  if (host === 'codex') {
    const projection = await materializeCodexPlugin(paths, identity)
    const inspection = await inspectCodex(codexManifest(projection.component), runner, {
      managedState: options.previous?.binding,
      replaceConflicts: options.replaceConflicts,
    })
    const entry = inspection.entries[0]
    return {
      id: OPERATIONS_SKILL_ID,
      carrier: 'codex-plugin',
      fingerprint: identity.fingerprint,
      selector: entry.selector,
      present: entry.pluginPresent,
      enabled: entry.pluginEnabled,
      replacementRequired: entry.marketplaceNeedsReplacement || entry.migratableDuplicates.length > 0,
    }
  }
  if (!['claude', 'zcode'].includes(host)) throw new AgentHostError('HOST_UNSUPPORTED', `Unsupported Agent Host Skill target: ${host}`)
  const exposurePath = options.previous?.exposurePath ?? join(resolveLinkedSkillsRoot(host, options), OPERATIONS_SKILL_ID)
  const info = await existing(exposurePath)
  const managedTarget = await resolvedSymlink(exposurePath, info)
  const expectedTarget = options.previous?.projectionRoot ?? null
  const alreadyManaged = expectedTarget !== null && managedTarget === expectedTarget
  const conflict = info !== null && !alreadyManaged
  if (conflict && options.replaceConflicts !== true) {
    throw new AgentHostError('HOST_SKILL_CONFLICT', `${host} already exposes ${OPERATIONS_SKILL_ID} from another source`, { exposurePath })
  }
  return {
    id: OPERATIONS_SKILL_ID,
    carrier: `${host}-skill-link`,
    fingerprint: identity.fingerprint,
    exposurePath,
    present: info !== null,
    alreadyManaged,
    replacementRequired: conflict,
  }
}

export async function installOperationsSkill(host, paths, runner, previous = null, options = {}) {
  const identity = await sourceIdentity()
  if (host === 'codex') {
    const projection = await materializeCodexPlugin(paths, identity)
    const binding = await installCodex(codexManifest(projection.component), runner, {
      managedState: previous?.binding,
      replaceConflicts: options.replaceConflicts,
    })
    return {
      kind: 'codex-plugin',
      id: OPERATIONS_SKILL_ID,
      fingerprint: identity.fingerprint,
      projectionRoot: projection.projectionRoot,
      binding: mergeCodexOwnership(previous?.binding, binding),
    }
  }
  if (!['claude', 'zcode'].includes(host)) throw new AgentHostError('HOST_UNSUPPORTED', `Unsupported Agent Host Skill target: ${host}`)
  const projectionRoot = await materializeLinkedSkill(paths, identity, host)
  const exposurePath = previous?.exposurePath ?? join(resolveLinkedSkillsRoot(host, options), OPERATIONS_SKILL_ID)
  await ensureRealDirectory(dirname(exposurePath))
  const info = await existing(exposurePath)
  const managedTarget = await resolvedSymlink(exposurePath, info)
  let displaced = previous?.displaced ?? null
  if (managedTarget !== projectionRoot) {
    const previousManaged = previous?.projectionRoot !== undefined && managedTarget === previous.projectionRoot
    if (info !== null && !previousManaged) {
      if (options.replaceConflicts !== true) {
        throw new AgentHostError('HOST_SKILL_CONFLICT', `${host} already exposes ${OPERATIONS_SKILL_ID} from another source`, { exposurePath })
      }
      const backupPath = join(paths.backups, `${host}-${OPERATIONS_SKILL_ID}-${randomUUID()}`)
      await rename(exposurePath, backupPath)
      displaced = { backupPath }
    } else if (info !== null) {
      await rm(exposurePath, { force: false })
    }
    const temporary = `${exposurePath}.tmp-${process.pid}-${randomUUID()}`
    try {
      await symlink(projectionRoot, temporary, platform() === 'win32' ? 'junction' : 'dir')
      await rename(temporary, exposurePath)
    } finally {
      await rm(temporary, { force: true })
    }
  }
  if (previous?.projectionRoot !== undefined && previous.projectionRoot !== projectionRoot) {
    const componentRoot = join(paths.hostProjections, 'operations-skills', host, OPERATIONS_SKILL_ID)
    if (!isContained(componentRoot, previous.projectionRoot)) {
      throw new AgentHostError('HOST_SKILL_PROJECTION_INVALID', 'Previous Agent Host Skill projection escaped private host storage')
    }
    await rm(previous.projectionRoot, { recursive: true, force: true })
  }
  return {
    kind: `${host}-skill-link`,
    id: OPERATIONS_SKILL_ID,
    exposurePath,
    projectionRoot,
    files: identity.files,
    fingerprint: identity.fingerprint,
    displaced,
  }
}

export async function inspectOperationsSkill(managed, runner) {
  if (managed === null || managed === undefined) return { status: 'missing', id: OPERATIONS_SKILL_ID }
  if (managed.kind === 'codex-plugin') {
    try {
      const current = await inspectCodex(codexManifest(managedCodexComponent(managed)), runner, {
        managedState: managed.binding,
        useManagedBindings: true,
      })
      const entry = current.entries[0]
      const healthy = entry.pluginPresent && entry.pluginEnabled && entry.installedVersion === entry.requestedVersion && entry.installedIdentityMatched
      return {
        status: healthy ? 'ok' : 'error',
        id: OPERATIONS_SKILL_ID,
        carrier: 'codex-plugin',
        selector: entry.selector,
        version: entry.installedVersion,
        identityMatched: entry.installedIdentityMatched,
      }
    } catch (error) {
      return { status: 'error', id: OPERATIONS_SKILL_ID, carrier: 'codex-plugin', code: error.code ?? 'HOST_SKILL_INSPECTION_FAILED' }
    }
  }
  const projectionInfo = await existing(managed.projectionRoot)
  if (projectionInfo === null || projectionInfo.isSymbolicLink() || !projectionInfo.isDirectory()) {
    return { status: 'error', id: OPERATIONS_SKILL_ID, carrier: managed.kind, code: 'HOST_SKILL_PROJECTION_MISSING' }
  }
  let actualFingerprint
  try {
    actualFingerprint = await fingerprint(managed.projectionRoot, managed.files)
  } catch {
    return { status: 'error', id: OPERATIONS_SKILL_ID, carrier: managed.kind, code: 'HOST_SKILL_PROJECTION_INVALID' }
  }
  const exposureInfo = await existing(managed.exposurePath)
  const exposureTarget = await resolvedSymlink(managed.exposurePath, exposureInfo)
  const healthy = actualFingerprint === managed.fingerprint && exposureTarget === managed.projectionRoot
  return {
    status: healthy ? 'ok' : 'error',
    id: OPERATIONS_SKILL_ID,
    carrier: managed.kind,
    exposurePath: managed.exposurePath,
    projectionRoot: managed.projectionRoot,
    fingerprintMatched: actualFingerprint === managed.fingerprint,
    exposureMatched: exposureTarget === managed.projectionRoot,
  }
}

export async function uninstallOperationsSkill(managed, runner) {
  if (managed === null || managed === undefined) return { removed: false, restored: false }
  if (managed.kind === 'codex-plugin') return uninstallCodex(managed.binding, runner)
  const exposureInfo = await existing(managed.exposurePath)
  const exposureTarget = await resolvedSymlink(managed.exposurePath, exposureInfo)
  let removed = false
  let preservedChangedTarget = false
  if (exposureInfo !== null) {
    if (exposureTarget === managed.projectionRoot) {
      await rm(managed.exposurePath, { force: false })
      removed = true
    } else {
      preservedChangedTarget = true
    }
  }
  let restored = false
  if (!preservedChangedTarget && managed.displaced?.backupPath !== undefined && await existing(managed.displaced.backupPath) !== null) {
    if (await existing(managed.exposurePath) !== null) {
      throw new AgentHostError('HOST_SKILL_RESTORE_CONFLICT', `Cannot restore the displaced ${OPERATIONS_SKILL_ID} Skill because its path is occupied`)
    }
    await rename(managed.displaced.backupPath, managed.exposurePath)
    restored = true
  }
  return { removed, restored, preservedChangedTarget }
}
