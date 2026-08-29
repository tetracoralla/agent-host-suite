import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentHostError } from './errors.mjs'
import { readJson } from './json.mjs'
import { resolveStateRoot } from './paths.mjs'
import { verifyReleaseComponent } from './release-artifacts.mjs'
import { listHistory, loadState, prepareStatePaths } from './state.mjs'

function allocatedBytes(info) {
  return Number.isFinite(info.blocks) ? Number(info.blocks) * 512 : Number(info.size)
}

async function treeUsage(path, options = {}) {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return { apparentBytes: 0, allocatedBytes: 0, files: 0, directories: 0 }
    throw error
  }
  if (info.isSymbolicLink()) {
    if (options.allowSymbolicLinks !== true) throw new AgentHostError('STORAGE_PATH_UNSAFE', `Storage inventory refuses symbolic links: ${path}`)
    return { apparentBytes: Number(info.size), allocatedBytes: allocatedBytes(info), files: 1, directories: 0 }
  }
  if (info.isFile()) {
    return { apparentBytes: Number(info.size), allocatedBytes: allocatedBytes(info), files: 1, directories: 0 }
  }
  if (!info.isDirectory()) throw new AgentHostError('STORAGE_PATH_UNSAFE', `Storage inventory refuses special files: ${path}`)
  const total = { apparentBytes: Number(info.size), allocatedBytes: allocatedBytes(info), files: 0, directories: 1 }
  for (const entry of await readdir(path)) {
    const child = await treeUsage(join(path, entry), options)
    total.apparentBytes += child.apparentBytes
    total.allocatedBytes += child.allocatedBytes
    total.files += child.files
    total.directories += child.directories
  }
  return total
}

function contained(root, candidate) {
  const relation = relative(root, candidate)
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`))
}

async function inventorySections(paths, packageInventory = null) {
  const sections = {}
  for (const name of ['packages', 'hostProjections', 'downloads', 'history', 'backups', 'runtime', 'observations', 'context']) {
    sections[name] = name === 'packages' && packageInventory !== null ? packageInventory.total : await treeUsage(paths[name])
  }
  sections.total = Object.values(sections).reduce((total, item) => ({
    apparentBytes: total.apparentBytes + item.apparentBytes,
    allocatedBytes: total.allocatedBytes + item.allocatedBytes,
    files: total.files + item.files,
    directories: total.directories + item.directories,
  }), { apparentBytes: 0, allocatedBytes: 0, files: 0, directories: 0 })
  return sections
}

async function packageUsageByComponent(paths) {
  const rootInfo = await lstat(paths.packages)
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new AgentHostError('STORAGE_PATH_UNSAFE', `Package storage root is unsafe: ${paths.packages}`)
  }
  const components = {}
  const total = { apparentBytes: Number(rootInfo.size), allocatedBytes: allocatedBytes(rootInfo), files: 0, directories: 1 }
  for (const name of await readdir(paths.packages)) {
    const path = join(paths.packages, name)
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new AgentHostError('STORAGE_PATH_UNSAFE', `Package storage contains an unsafe component entry: ${path}`)
    }
    const usage = await treeUsage(path)
    components[name] = usage
    total.apparentBytes += usage.apparentBytes
    total.allocatedBytes += usage.allocatedBytes
    total.files += usage.files
    total.directories += usage.directories
  }
  return { components, total }
}

async function managerAppUsage() {
  const sourceDirectory = dirname(fileURLToPath(import.meta.url))
  const candidate = resolve(sourceDirectory, '../../../..')
  if (!candidate.endsWith('.app')) return null
  try {
    const info = await lstat(candidate)
    if (!info.isDirectory() || info.isSymbolicLink()) return null
    return await measureReadOnlyTreeUsage(candidate)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

// Measure a read-only installation tree without following links. Private storage
// keeps the stricter no-link policy because cleanup can mutate those paths.
export async function measureReadOnlyTreeUsage(path) {
  return await treeUsage(path, { allowSymbolicLinks: true })
}

async function rollbackState(paths) {
  const history = await listHistory(paths)
  const target = history.find((path) => !path.includes('-uninstalled-'))
  return target === undefined ? null : await readJson(target)
}

async function retainedPackageRoots(paths, states) {
  const packageRoot = await realpath(paths.packages)
  const retained = new Map()
  for (const [reason, state] of states) {
    for (const [id, component] of Object.entries(state?.components ?? {})) {
      if (typeof component.root !== 'string') continue
      let root
      try {
        root = await realpath(component.root)
      } catch (error) {
        if (error.code === 'ENOENT') {
          throw new AgentHostError('STORAGE_RETAINED_PACKAGE_MISSING', `Cannot clean storage while retained ${reason} bytes are missing`, { component: id })
        }
        throw error
      }
      if (contained(packageRoot, root)) retained.set(root, { reason, component: id, version: component.version })
    }
  }
  return { packageRoot, retained }
}

async function verifyRetainedStates(states) {
  for (const [reason, state] of states) {
    if (state?.channel !== 'release') continue
    for (const [id, component] of Object.entries(state.components ?? {})) {
      try {
        await verifyReleaseComponent(component)
      } catch (error) {
        throw new AgentHostError('STORAGE_RETAINED_BYTES_UNVERIFIED', `Cannot clean storage because ${reason} component bytes failed verification`, {
          component: id,
          cause: error.message,
        })
      }
    }
  }
}

function releaseActivationMs(state) {
  const value = Date.parse(state.releaseActivatedAt ?? state.updatedAt ?? state.installedAt ?? '')
  return Number.isFinite(value) ? value : 0
}

async function packagePlan(paths, current, rollback) {
  const states = [['current', current], ...(rollback === null ? [] : [['rollback', rollback]])]
  const { packageRoot, retained } = await retainedPackageRoots(paths, states)
  const cutoffMs = releaseActivationMs(current)
  const removable = []
  const retainedEntries = []
  for (const componentName of await readdir(packageRoot)) {
    const componentParent = join(packageRoot, componentName)
    const parentInfo = await lstat(componentParent)
    if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
      throw new AgentHostError('STORAGE_PATH_UNSAFE', `Package storage contains an unsafe entry: ${componentParent}`)
    }
    for (const name of await readdir(componentParent)) {
      const path = join(componentParent, name)
      const info = await lstat(path)
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
        throw new AgentHostError('STORAGE_PATH_UNSAFE', `Package storage contains an unsafe entry: ${path}`)
      }
      const resolved = await realpath(path)
      const keep = retained.get(resolved)
      if (keep !== undefined) {
        retainedEntries.push({ path, ...keep })
        continue
      }
      if (name.startsWith('.staging-') || info.mtimeMs >= cutoffMs) {
        retainedEntries.push({ path, reason: 'recent-or-staging', component: componentName, version: null })
        continue
      }
      removable.push({
        path,
        component: componentName,
        usage: await treeUsage(path),
        identity: { dev: Number(info.dev), ino: Number(info.ino), mtimeMs: Number(info.mtimeMs) },
      })
    }
  }
  return { states, retained: retainedEntries, removable }
}

async function downloadPlan(paths, current) {
  const cutoffMs = releaseActivationMs(current)
  const removable = []
  const retained = []
  for (const name of await readdir(paths.downloads)) {
    const path = join(paths.downloads, name)
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new AgentHostError('STORAGE_PATH_UNSAFE', `Download storage contains an unsafe entry: ${path}`)
    }
    if (name.includes('.tmp-') || info.mtimeMs >= cutoffMs) {
      retained.push({ path, reason: 'recent-or-in-progress' })
      continue
    }
    removable.push({
      path,
      usage: await treeUsage(path),
      identity: { dev: Number(info.dev), ino: Number(info.ino), mtimeMs: Number(info.mtimeMs) },
    })
  }
  return { retained, removable }
}

function planSummary(packageResult, downloadResult) {
  const candidates = [...packageResult.removable, ...downloadResult.removable]
  return {
    packageVersions: packageResult.removable.length,
    downloads: downloadResult.removable.length,
    apparentBytes: candidates.reduce((sum, item) => sum + item.usage.apparentBytes, 0),
    allocatedBytes: candidates.reduce((sum, item) => sum + item.usage.allocatedBytes, 0),
  }
}

async function removeCandidate(candidate) {
  const current = await lstat(candidate.path)
  if (Number(current.dev) !== candidate.identity.dev
    || Number(current.ino) !== candidate.identity.ino
    || Number(current.mtimeMs) !== candidate.identity.mtimeMs) {
    throw new AgentHostError('STORAGE_CHANGED_DURING_CLEANUP', `Storage changed after preflight: ${candidate.path}`)
  }
  await rm(candidate.path, { recursive: current.isDirectory(), force: false })
}

export async function storageStatus(options = {}) {
  const paths = await prepareStatePaths(resolveStateRoot(options.stateRoot))
  const current = await loadState(paths)
  if (current === null) throw new AgentHostError('NOT_INSTALLED', 'No Agent environment is installed')
  const rollback = await rollbackState(paths)
  const packages = await packagePlan(paths, current, rollback)
  const downloads = await downloadPlan(paths, current)
  const [packageInventory, managerApp] = await Promise.all([packageUsageByComponent(paths), managerAppUsage()])
  const sections = await inventorySections(paths, packageInventory)
  return {
    status: 'ok',
    stateRoot: paths.root,
    current: { suiteVersion: current.suiteVersion, releaseId: current.releaseId ?? null },
    rollback: rollback === null ? null : { suiteVersion: rollback.suiteVersion, releaseId: rollback.releaseId ?? null },
    sections,
    packagesByComponent: packageInventory.components,
    installation: {
      privateState: sections.total,
      managerApp,
      apparentBytes: sections.total.apparentBytes + (managerApp?.apparentBytes ?? 0),
      allocatedBytes: sections.total.allocatedBytes + (managerApp?.allocatedBytes ?? 0),
    },
    cleanup: {
      ...planSummary(packages, downloads),
      retainedPackageVersions: packages.retained.length,
    },
  }
}

export async function cleanupStorage(options = {}) {
  const paths = await prepareStatePaths(resolveStateRoot(options.stateRoot))
  const current = await loadState(paths)
  if (current === null) throw new AgentHostError('NOT_INSTALLED', 'No Agent environment is installed')
  const rollback = await rollbackState(paths)
  const packages = await packagePlan(paths, current, rollback)
  const downloads = await downloadPlan(paths, current)
  const summary = planSummary(packages, downloads)
  const before = await inventorySections(paths)
  if (options.dryRun === true) {
    return {
      status: 'ready', dryRun: true, currentVersion: current.suiteVersion,
      rollbackVersion: rollback?.suiteVersion ?? null, plan: summary, before, after: before,
    }
  }
  await verifyRetainedStates(packages.states)
  for (const candidate of downloads.removable) await removeCandidate(candidate)
  for (const candidate of packages.removable) await removeCandidate(candidate)
  const after = await inventorySections(paths)
  return {
    status: 'cleaned', dryRun: false, currentVersion: current.suiteVersion,
    rollbackVersion: rollback?.suiteVersion ?? null, removed: summary, before, after,
    reclaimedAllocatedBytes: Math.max(0, before.total.allocatedBytes - after.total.allocatedBytes),
  }
}
