import { createHash, randomUUID } from 'node:crypto'
import { chmod, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { platform } from 'node:os'
import { resolveLinkedSkillsRoot } from './agent-skill-location.mjs'
import { fingerprintRelativeFiles } from './development-manifest.mjs'
import { AgentHostError } from './errors.mjs'
import { runFile } from './process.mjs'

const COMPONENT_ID = 'agent-tool-development-kit'
const PROJECTION_SCHEMA = 'openadam.agent-host-developer-skill-projection.v0.1'

function componentFrom(manifest) {
  return manifest.components?.[COMPONENT_ID] ?? null
}

function providerComponentsFrom(manifest) {
  const values = Object.entries(manifest.components ?? {})
    .filter(([, component]) => component.providerSkill !== undefined)
    .map(([id, component]) => ({
      ...component,
      componentId: id,
      command: component.providerSkill.command,
      args: component.providerSkill.args,
      versionArguments: component.providerSkill.versionArguments,
      version: component.providerSkill.expectedVersion,
      developerSkill: component.providerSkill,
      developerKitIntegrationSchema: component.toolIntegrationSchema,
      projectionCollection: 'provider-skills',
    }))
  const ids = values.map((component) => component.developerSkill.id)
  const developerSkillId = componentFrom(manifest)?.developerSkill?.id
  if (new Set(ids).size !== ids.length || (developerSkillId !== undefined && ids.includes(developerSkillId))) {
    throw new AgentHostError('PROVIDER_SKILL_CONFLICT', 'Installed Providers declare the same linked Skill id')
  }
  return values
}

function productComponentsFrom(manifest) {
  const providerSkillIds = new Set(providerComponentsFrom(manifest).map((component) => component.developerSkill.id))
  const values = Object.entries(manifest.components ?? {})
    .filter(([, component]) => component.skillOnly !== true)
    .flatMap(([id, component]) => (component.productSkills ?? []).map((skill) => ({
      ...component,
      componentId: id,
      developerSkill: skill,
      developerKitIntegrationSchema: component.toolIntegrationSchema ?? 'openadam.agent-host-product-skill.v0.1',
      projectionCollection: 'product-skills',
      plainSkill: true,
    })))
    .filter((component) => !providerSkillIds.has(component.developerSkill.id))
  const ids = values.map((component) => component.developerSkill.id)
  const reserved = new Set([
    componentFrom(manifest)?.developerSkill?.id,
    ...providerSkillIds,
    'agent-host-operations',
  ].filter(Boolean))
  if (new Set(ids).size !== ids.length || ids.some((id) => reserved.has(id))) {
    throw new AgentHostError('PRODUCT_SKILL_CONFLICT', 'Installed products declare the same linked Skill id')
  }
  return values
}

function isContained(root, candidate) {
  const value = relative(root, candidate)
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value))
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

function batchQuote(value) {
  const text = String(value)
  if (/[\u0000\r\n"]/u.test(text)) throw new AgentHostError('DEVELOPER_SKILL_PROJECTION_INVALID', 'A Windows Skill launcher argument contains unsupported characters')
  return `"${text.replaceAll('%', '%%')}"`
}

function projectedLauncherRelativePath(skill) {
  return platform() === 'win32' ? `${skill.launcherRelativePath}.cmd` : skill.launcherRelativePath
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
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new AgentHostError('DEVELOPER_SKILL_PATH_UNSAFE', `Developer Skill directory is unsafe: ${path}`)
  }
}

async function inventory(root, current = root, output = []) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name)
    if (entry.isSymbolicLink()) throw new AgentHostError('DEVELOPER_SKILL_SOURCE_INVALID', `Developer Skill contains a symbolic link: ${path}`)
    if (entry.isDirectory()) await inventory(root, path, output)
    else if (entry.isFile()) output.push(relative(root, path).split(sep).join('/'))
    else throw new AgentHostError('DEVELOPER_SKILL_SOURCE_INVALID', `Developer Skill contains a special file: ${path}`)
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
  return `sha256:${hash.digest('hex')}`
}

function projectionDigest(component) {
  return createHash('sha256')
    .update(PROJECTION_SCHEMA)
    .update('\0')
    .update(component.fingerprint)
    .update('\0')
    .update(component.command ?? '')
    .update('\0')
    .update(JSON.stringify(component.args ?? []))
    .digest('hex')
    .slice(0, 16)
}

async function verifyComponent(component) {
  const skill = component?.developerSkill
  if (component?.developerKitIntegrationSchema === undefined || skill === null || typeof skill !== 'object'
    || typeof skill.id !== 'string' || typeof skill.root !== 'string' || !Array.isArray(skill.identityRelativeFiles)
    || typeof skill.identityFingerprint !== 'string'
    || (component.plainSkill !== true && (typeof skill.launcherRelativePath !== 'string'
      || typeof component.command !== 'string' || !Array.isArray(component.args) || !Array.isArray(component.versionArguments)))) {
    throw new AgentHostError('DEVELOPER_SKILL_SOURCE_INVALID', 'The installed Developer Kit does not declare a complete Skill integration')
  }
  const root = await realpath(skill.root)
  const info = await lstat(root)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new AgentHostError('DEVELOPER_SKILL_SOURCE_INVALID', 'The installed Developer Skill root is unsafe')
  if (await fingerprintRelativeFiles(root, skill.identityRelativeFiles) !== skill.identityFingerprint) {
    throw new AgentHostError('DEVELOPER_SKILL_SOURCE_INVALID', 'The installed Developer Skill identity differs from its component metadata')
  }
  if (component.plainSkill !== true) {
    const launcher = join(root, skill.launcherRelativePath)
    if (!isContained(root, launcher) || launcher === root) throw new AgentHostError('DEVELOPER_SKILL_SOURCE_INVALID', 'The Developer Skill launcher path escapes its Skill root')
  }
  return { ...skill, root }
}

async function materializeLinkedDeveloperSkill(component, paths, host) {
  const skill = await verifyComponent(component)
  const componentRoot = join(paths.hostProjections, component.projectionCollection ?? 'developer-skills', host, skill.id)
  const projectionRoot = join(componentRoot, projectionDigest(component))
  const projectionInfo = await existing(projectionRoot)
  if (projectionInfo !== null && (projectionInfo.isSymbolicLink() || !projectionInfo.isDirectory())) {
    throw new AgentHostError('DEVELOPER_SKILL_PROJECTION_INVALID', 'The Developer Skill projection is unsafe')
  }
  if (projectionInfo === null) {
    const staging = join(componentRoot, `.staging-${process.pid}-${randomUUID()}`)
    try {
      await mkdir(componentRoot, { recursive: true, mode: 0o700 })
      await cp(skill.root, staging, { recursive: true, errorOnExist: true, force: false })
      if (component.plainSkill !== true) {
        const launcherRelativePath = projectedLauncherRelativePath(skill)
        const launcher = join(staging, launcherRelativePath)
        if (!isContained(staging, launcher) || launcher === staging) throw new AgentHostError('DEVELOPER_SKILL_PROJECTION_INVALID', 'The projected Developer Skill launcher escapes its Skill root')
        await mkdir(dirname(launcher), { recursive: true, mode: 0o700 })
        const contents = platform() === 'win32'
          ? `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${[component.command, ...component.args].map(batchQuote).join(' ')} %*\r\n`
          : `#!/bin/sh\nexec ${shellQuote(component.command)} ${component.args.map(shellQuote).join(' ')} "$@"\n`
        await writeFile(launcher, contents, { mode: 0o500, flag: 'wx' })
        await chmod(launcher, 0o500)
      }
      await rename(staging, projectionRoot)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
  const resolvedProjectionRoot = await realpath(projectionRoot)
  const files = await inventory(resolvedProjectionRoot)
  const launcherRelativePath = component.plainSkill === true ? null : projectedLauncherRelativePath(skill)
  const launcherPath = launcherRelativePath === null ? null : join(resolvedProjectionRoot, launcherRelativePath)
  if (launcherRelativePath !== null && !files.includes(launcherRelativePath)) throw new AgentHostError('DEVELOPER_SKILL_PROJECTION_INVALID', 'The projected Developer Skill launcher is missing')
  return {
    id: skill.id,
    projectionRoot: resolvedProjectionRoot,
    launcherPath,
    versionArguments: component.plainSkill === true ? [] : component.versionArguments,
    expectedVersion: component.plainSkill === true ? null : component.version,
    command: component.plainSkill === true ? null : component.command,
    commandArgs: component.plainSkill === true ? [] : component.args,
    files,
    fingerprint: await fingerprint(resolvedProjectionRoot, files),
  }
}

async function preflightLinked(host, manifest, paths, previous, options) {
  const component = componentFrom(manifest)
  if (component === null) return null
  return preflightLinkedComponent(host, component, paths, previous, options)
}

async function preflightLinkedComponent(host, component, paths, previous, options) {
  const projection = await materializeLinkedDeveloperSkill(component, paths, host)
  const exposurePath = previous?.exposurePath ?? join(resolveLinkedSkillsRoot(host, options), projection.id)
  const info = await existing(exposurePath)
  const managedTarget = await resolvedSymlink(exposurePath, info)
  const alreadyManaged = previous?.projectionRoot !== undefined && managedTarget === previous.projectionRoot
  if (info !== null && !alreadyManaged && options.replaceConflicts !== true) {
    throw new AgentHostError('DEVELOPER_SKILL_CONFLICT', `${host} already exposes ${projection.id} from another source`, { exposurePath })
  }
  return {
    ...projection,
    carrier: `${host}-skill-link`,
    exposurePath,
    present: managedTarget === projection.projectionRoot,
    replacementRequired: info !== null && managedTarget !== projection.projectionRoot,
  }
}

export async function preflightDeveloperKitSkill(host, manifest, paths, options = {}) {
  if (host === 'codex' || componentFrom(manifest) === null) return null
  if (!['claude', 'zcode'].includes(host)) throw new AgentHostError('HOST_UNSUPPORTED', `Unsupported Developer Skill target: ${host}`)
  return preflightLinked(host, manifest, paths, options.previous, options)
}

export async function installDeveloperKitSkill(host, manifest, paths, previous = null, options = {}) {
  if (host === 'codex') return null
  if (!['claude', 'zcode'].includes(host)) throw new AgentHostError('HOST_UNSUPPORTED', `Unsupported Developer Skill target: ${host}`)
  const component = componentFrom(manifest)
  if (component === null) {
    if (previous !== null && previous !== undefined) await uninstallDeveloperKitSkill(previous)
    return null
  }
  return installLinkedComponent(host, component, paths, previous, options)
}

async function installLinkedComponent(host, component, paths, previous, options) {
  const prepared = await preflightLinkedComponent(host, component, paths, previous, options)
  await ensureRealDirectory(dirname(prepared.exposurePath))
  const info = await existing(prepared.exposurePath)
  const managedTarget = await resolvedSymlink(prepared.exposurePath, info)
  let displaced = previous?.displaced ?? null
  if (managedTarget !== prepared.projectionRoot) {
    const previousManaged = previous?.projectionRoot !== undefined && managedTarget === previous.projectionRoot
    if (info !== null && !previousManaged) {
      if (options.replaceConflicts !== true) throw new AgentHostError('DEVELOPER_SKILL_CONFLICT', `${host} already exposes ${prepared.id} from another source`)
      const backupPath = join(paths.backups, `${host}-${prepared.id}-${randomUUID()}`)
      await rename(prepared.exposurePath, backupPath)
      displaced = { backupPath }
    } else if (info !== null) {
      await rm(prepared.exposurePath, { force: false })
    }
    const temporary = `${prepared.exposurePath}.tmp-${process.pid}-${randomUUID()}`
    try {
      await symlink(prepared.projectionRoot, temporary, platform() === 'win32' ? 'junction' : 'dir')
      await rename(temporary, prepared.exposurePath)
    } finally {
      await rm(temporary, { force: true })
    }
  }
  if (previous?.projectionRoot !== undefined && previous.projectionRoot !== prepared.projectionRoot) {
    const componentRoot = join(paths.hostProjections, component.projectionCollection ?? 'developer-skills', host, prepared.id)
    if (!isContained(componentRoot, previous.projectionRoot)) throw new AgentHostError('DEVELOPER_SKILL_PROJECTION_INVALID', 'Previous Developer Skill projection escaped private Host storage')
    await rm(previous.projectionRoot, { recursive: true, force: true })
  }
  return {
    kind: `${host}-skill-link`,
    id: prepared.id,
    exposurePath: prepared.exposurePath,
    projectionRoot: prepared.projectionRoot,
    launcherPath: prepared.launcherPath,
    versionArguments: prepared.versionArguments,
    expectedVersion: prepared.expectedVersion,
    command: prepared.command,
    commandArgs: prepared.commandArgs,
    files: prepared.files,
    fingerprint: prepared.fingerprint,
    displaced,
  }
}

export async function preflightProviderSkills(host, manifest, paths, options = {}) {
  if (host === 'codex') return []
  if (!['claude', 'zcode'].includes(host)) throw new AgentHostError('HOST_UNSUPPORTED', `Unsupported Provider Skill target: ${host}`)
  const previous = options.previous ?? []
  const prepared = []
  for (const component of providerComponentsFrom(manifest)) {
    prepared.push(await preflightLinkedComponent(
      host,
      component,
      paths,
      previous.find((item) => item.id === component.developerSkill.id),
      options,
    ))
  }
  return prepared
}

export async function installProviderSkills(host, manifest, paths, previous = [], options = {}) {
  if (host === 'codex') return []
  if (!['claude', 'zcode'].includes(host)) throw new AgentHostError('HOST_UNSUPPORTED', `Unsupported Provider Skill target: ${host}`)
  await preflightProviderSkills(host, manifest, paths, { ...options, previous })
  const installed = []
  const desired = providerComponentsFrom(manifest)
  try {
    for (const component of desired) {
      installed.push(await installLinkedComponent(
        host,
        component,
        paths,
        previous.find((item) => item.id === component.developerSkill.id),
        options,
      ))
    }
  } catch (error) {
    for (const managed of [...installed].reverse()) {
      if (!previous.some((item) => item.id === managed.id)) await uninstallDeveloperKitSkill(managed).catch(() => {})
    }
    throw error
  }
  const desiredIds = new Set(desired.map((component) => component.developerSkill.id))
  for (const stale of previous.filter((item) => !desiredIds.has(item.id))) await uninstallDeveloperKitSkill(stale)
  return installed
}

export async function inspectProviderSkills(managed, runner = runFile) {
  const skills = []
  for (const item of managed ?? []) skills.push(await inspectDeveloperKitSkill(item, runner))
  return {
    status: skills.every((item) => item.status === 'ok') ? 'ok' : 'error',
    skills,
  }
}

export async function preflightProductSkills(host, manifest, paths, options = {}) {
  if (host === 'codex') return []
  if (!['claude', 'zcode'].includes(host)) throw new AgentHostError('HOST_UNSUPPORTED', `Unsupported Product Skill target: ${host}`)
  const previous = options.previous ?? []
  const prepared = []
  for (const component of productComponentsFrom(manifest)) {
    prepared.push(await preflightLinkedComponent(
      host,
      component,
      paths,
      previous.find((item) => item.id === component.developerSkill.id),
      options,
    ))
  }
  return prepared
}

export async function installProductSkills(host, manifest, paths, previous = [], options = {}) {
  if (host === 'codex') return []
  if (!['claude', 'zcode'].includes(host)) throw new AgentHostError('HOST_UNSUPPORTED', `Unsupported Product Skill target: ${host}`)
  await preflightProductSkills(host, manifest, paths, { ...options, previous })
  const installed = []
  const desired = productComponentsFrom(manifest)
  try {
    for (const component of desired) {
      installed.push(await installLinkedComponent(
        host,
        component,
        paths,
        previous.find((item) => item.id === component.developerSkill.id),
        options,
      ))
    }
  } catch (error) {
    for (const managed of [...installed].reverse()) {
      if (!previous.some((item) => item.id === managed.id)) await uninstallDeveloperKitSkill(managed).catch(() => {})
    }
    throw error
  }
  const desiredIds = new Set(desired.map((component) => component.developerSkill.id))
  for (const stale of previous.filter((item) => !desiredIds.has(item.id))) await uninstallDeveloperKitSkill(stale)
  return installed
}

export async function inspectProductSkills(managed, runner = runFile) {
  return inspectProviderSkills(managed, runner)
}

export async function uninstallProductSkills(managed) {
  return uninstallProviderSkills(managed)
}

export async function uninstallProviderSkills(managed) {
  const results = []
  for (const item of [...(managed ?? [])].reverse()) results.push({ id: item.id, ...await uninstallDeveloperKitSkill(item) })
  return results
}

export async function inspectDeveloperKitSkill(managed, runner = runFile) {
  if (managed === null || managed === undefined) return { status: 'absent' }
  const projectionInfo = await existing(managed.projectionRoot)
  if (projectionInfo === null || projectionInfo.isSymbolicLink() || !projectionInfo.isDirectory()) {
    return { status: 'error', id: managed.id, code: 'DEVELOPER_SKILL_PROJECTION_MISSING' }
  }
  let actualFingerprint
  try {
    actualFingerprint = await fingerprint(managed.projectionRoot, managed.files)
  } catch {
    return { status: 'error', id: managed.id, code: 'DEVELOPER_SKILL_PROJECTION_INVALID' }
  }
  const exposureInfo = await existing(managed.exposurePath)
  const exposureTarget = await resolvedSymlink(managed.exposurePath, exposureInfo)
  const version = managed.launcherPath === null
    ? { status: 0, stdout: '' }
    : await runner(
      managed.command ?? managed.launcherPath,
      [...(managed.commandArgs ?? []), ...managed.versionArguments],
      { allowFailure: true, timeoutMs: 5_000 },
    )
  let reportedVersion = null
  if (managed.launcherPath !== null) {
    reportedVersion = version.stdout.trim() || null
    try {
      const parsed = JSON.parse(version.stdout)
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.version === 'string') reportedVersion = parsed.version
      else if (typeof parsed === 'string') reportedVersion = parsed
    } catch {}
  }
  const healthy = actualFingerprint === managed.fingerprint
    && exposureTarget === managed.projectionRoot
    && version.status === 0
    && (managed.launcherPath === null || reportedVersion === managed.expectedVersion)
  return {
    status: healthy ? 'ok' : 'error',
    id: managed.id,
    carrier: managed.kind,
    exposurePath: managed.exposurePath,
    projectionRoot: managed.projectionRoot,
    fingerprintMatched: actualFingerprint === managed.fingerprint,
    exposureMatched: exposureTarget === managed.projectionRoot,
    expectedVersion: managed.expectedVersion,
    reportedVersion,
  }
}

export async function uninstallDeveloperKitSkill(managed) {
  if (managed === null || managed === undefined) return { removed: false, restored: false }
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
    if (await existing(managed.exposurePath) !== null) throw new AgentHostError('DEVELOPER_SKILL_RESTORE_CONFLICT', `Cannot restore the displaced ${managed.id} Skill because its path is occupied`)
    await rename(managed.displaced.backupPath, managed.exposurePath)
    restored = true
  }
  return { removed, restored, preservedChangedTarget }
}
