import { createHash, randomUUID } from 'node:crypto'
import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { platform } from 'node:os'
import { fingerprintRelativeFiles } from '../development-manifest.mjs'
import { AgentHostError } from '../errors.mjs'
import { writePrivateJson } from '../json.mjs'
import { canonicalPathGrants, componentEnvironment } from '../component-environment.mjs'

const PROJECTION_SCHEMA = 'openadam.agent-host-codex-projection.v0.2'

function containedRelative(root, candidate, label) {
  const value = relative(root, candidate)
  if (value === '' || value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new AgentHostError('CODEX_PROJECTION_INVALID', `${label} is not contained by its marketplace root`)
  }
  return value
}

async function copyOptionalDirectory(source, destination) {
  try {
    const info = await lstat(source)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new AgentHostError('CODEX_PROJECTION_INVALID', `Codex projection source is not a real directory: ${source}`)
    }
    await cp(source, destination, { recursive: true, errorOnExist: true, force: false })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

async function regularFiles(root, current = root, result = []) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name)
    if (entry.isSymbolicLink()) throw new AgentHostError('CODEX_PROJECTION_INVALID', `Codex projection refuses symbolic links: ${path}`)
    if (entry.isDirectory()) await regularFiles(root, path, result)
    else if (entry.isFile()) result.push(relative(root, path).split(sep).join('/'))
    else throw new AgentHostError('CODEX_PROJECTION_INVALID', `Codex projection refuses special files: ${path}`)
  }
  return result.sort()
}

function projectionDigest(component, workspaceRoot) {
  const grant = (component.workspaceEnvironment ?? []).length === 0 ? '' : workspaceRoot ?? ''
  const grants = canonicalPathGrants(component.pathGrants)
  const digest = createHash('sha256')
    .update(PROJECTION_SCHEMA)
    .update('\0')
    .update(component.fingerprint)
    .update('\0')
    .update(component.command ?? '')
    .update('\0')
    .update(JSON.stringify(component.args ?? []))
    .update('\0')
    .update(component.cwd ?? '')
    .update('\0')
    .update(grant)
    .update('\0')
  if (Object.keys(grants).length > 0) digest.update(JSON.stringify(grants)).update('\0')
  return digest
    .update(component.skillOnly === true ? 'skill-only' : 'mcp-active')
    .digest('hex')
    .slice(0, 16)
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

function batchQuote(value) {
  const text = String(value)
  if (/[\u0000\r\n"]/u.test(text)) throw new AgentHostError('CODEX_PROJECTION_INVALID', 'A Windows Skill launcher argument contains unsupported characters')
  return `"${text.replaceAll('%', '%%')}"`
}

function projectedLauncherRelativePath(skill) {
  return platform() === 'win32' ? `${skill.launcherRelativePath}.cmd` : skill.launcherRelativePath
}

async function readPluginManifest(component) {
  let plugin
  try {
    plugin = JSON.parse(await readFile(join(component.pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'))
  } catch (error) {
    throw new AgentHostError('CODEX_PROJECTION_INVALID', `Cannot read ${component.displayName ?? component.plugin} plugin manifest: ${error.message}`)
  }
  if (plugin === null || typeof plugin !== 'object' || Array.isArray(plugin)) {
    throw new AgentHostError('CODEX_PROJECTION_INVALID', `${component.displayName ?? component.plugin} plugin manifest is invalid`)
  }
  return plugin
}

async function assertSkillOnlyPlugin(component) {
  const plugin = await readPluginManifest(component)
  if (plugin.skills !== './skills/' || plugin.mcpServers !== undefined) {
    throw new AgentHostError('CODEX_PROJECTION_INVALID', `${component.displayName ?? component.plugin} must remain a Skill-only Codex plugin`)
  }
}

function launcherBinding(component) {
  if (component.developerSkill !== undefined) {
    return { skill: component.developerSkill, command: component.command, args: component.args }
  }
  if (component.providerSkill !== undefined) {
    return { skill: component.providerSkill, command: component.providerSkill.command, args: component.providerSkill.args }
  }
  return null
}

async function writeSkillLauncher(component, stagingPlugin) {
  const binding = launcherBinding(component)
  if (binding === null) return
  const { skill } = binding
  if (skill === null || typeof skill !== 'object' || typeof skill.id !== 'string' || typeof skill.launcherRelativePath !== 'string') {
    throw new AgentHostError('CODEX_PROJECTION_INVALID', `${component.displayName ?? component.plugin} Skill metadata is invalid`)
  }
  const skillRoot = join(stagingPlugin, 'skills', skill.id)
  const launcher = join(skillRoot, projectedLauncherRelativePath(skill))
  containedRelative(skillRoot, launcher, `${component.displayName ?? component.plugin} launcher`)
  await mkdir(dirname(launcher), { recursive: true, mode: 0o700 })
  const script = platform() === 'win32'
    ? `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${[binding.command, ...binding.args].map(batchQuote).join(' ')} %*\r\n`
    : `#!/bin/sh\nexec ${shellQuote(binding.command)} ${binding.args.map(shellQuote).join(' ')} "$@"\n`
  await writeFile(launcher, script, { mode: 0o500, flag: 'wx' })
  await chmod(launcher, 0o500)
}

async function readMcpProjection(component, workspaceRoot) {
  let source
  try {
    source = JSON.parse(await readFile(join(component.pluginRoot, '.mcp.json'), 'utf8'))
  } catch (error) {
    throw new AgentHostError('CODEX_PROJECTION_INVALID', `Cannot read ${component.displayName ?? component.plugin} MCP configuration: ${error.message}`)
  }
  if (source === null || typeof source !== 'object' || Array.isArray(source) || source.mcpServers === null || typeof source.mcpServers !== 'object' || Array.isArray(source.mcpServers)) {
    throw new AgentHostError('CODEX_PROJECTION_INVALID', `${component.displayName ?? component.plugin} MCP configuration is invalid`)
  }
  const entries = Object.entries(source.mcpServers)
  if (entries.length !== 1) {
    throw new AgentHostError('CODEX_PROJECTION_INVALID', `${component.displayName ?? component.plugin} must expose exactly one MCP server in its Codex plugin`)
  }
  if ((component.workspaceEnvironment ?? []).length > 0 && workspaceRoot === null) {
    throw new AgentHostError('WORKSPACE_GRANT_REQUIRED', `${component.displayName ?? component.plugin} requires --workspace-root so Codex can grant its deterministic tools an explicit local workspace`, {
      component: component.plugin,
      variables: component.workspaceEnvironment,
    })
  }
  const [name, current] = entries[0]
  if (current === null || typeof current !== 'object' || Array.isArray(current)) {
    throw new AgentHostError('CODEX_PROJECTION_INVALID', `${component.displayName ?? component.plugin} MCP server configuration is invalid`)
  }
  const environment = componentEnvironment(component, workspaceRoot)
  const projected = {
    ...current,
    command: component.command,
    args: component.args,
    cwd: component.cwd,
    ...(Object.keys(environment).length === 0 ? {} : { env: environment }),
  }
  delete projected.env_vars
  if (Object.keys(environment).length === 0) delete projected.env
  return { ...source, mcpServers: { [name]: projected } }
}

async function materializeComponent(componentId, component, projectionRoot, workspaceRoot) {
  if (component.skillOnly === true && component.providerSkill === undefined) await assertSkillOnlyPlugin(component)
  const digest = projectionDigest(component, workspaceRoot)
  const componentProjectionRoot = join(projectionRoot, componentId, digest)
  const marketplaceRoot = join(componentProjectionRoot, 'marketplace')
  const relativePluginRoot = containedRelative(component.marketplaceRoot, component.pluginRoot, `${componentId} plugin root`)
  const pluginRoot = join(marketplaceRoot, relativePluginRoot)
  let exists = false
  try {
    exists = (await stat(join(componentProjectionRoot, 'projection.json'))).isFile()
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (!exists) {
    const stagingRoot = join(projectionRoot, componentId, `.staging-${process.pid}-${randomUUID()}`)
    const stagingMarketplace = join(stagingRoot, 'marketplace')
    const stagingPlugin = join(stagingMarketplace, relativePluginRoot)
    try {
      await mkdir(join(stagingMarketplace, '.agents', 'plugins'), { recursive: true, mode: 0o700 })
      await mkdir(join(stagingPlugin, '.codex-plugin'), { recursive: true, mode: 0o700 })
      await copyFile(
        join(component.marketplaceRoot, '.agents', 'plugins', 'marketplace.json'),
        join(stagingMarketplace, '.agents', 'plugins', 'marketplace.json'),
      )
      if (component.skillOnly === true && component.providerSkill !== undefined) {
        const plugin = await readPluginManifest(component)
        if (plugin.skills !== './skills/') throw new AgentHostError('CODEX_PROJECTION_INVALID', `${component.displayName ?? component.plugin} discovery plugin must expose Skills`)
        delete plugin.mcpServers
        await writePrivateJson(join(stagingPlugin, '.codex-plugin', 'plugin.json'), plugin)
      } else {
        await copyFile(
          join(component.pluginRoot, '.codex-plugin', 'plugin.json'),
          join(stagingPlugin, '.codex-plugin', 'plugin.json'),
        )
      }
      await copyOptionalDirectory(join(component.pluginRoot, 'skills'), join(stagingPlugin, 'skills'))
      await copyOptionalDirectory(join(component.pluginRoot, 'assets'), join(stagingPlugin, 'assets'))
      await writeSkillLauncher(component, stagingPlugin)
      if (component.skillOnly !== true) await writePrivateJson(join(stagingPlugin, '.mcp.json'), await readMcpProjection(component, workspaceRoot))
      await writePrivateJson(join(stagingRoot, 'projection.json'), {
        schemaVersion: PROJECTION_SCHEMA,
        component: componentId,
        componentFingerprint: component.fingerprint,
        workspaceRoot,
        packageMarketplaceRoot: component.marketplaceRoot,
        packagePluginRoot: component.pluginRoot,
      })
      await mkdir(dirname(componentProjectionRoot), { recursive: true, mode: 0o700 })
      try {
        await rename(stagingRoot, componentProjectionRoot)
      } catch (error) {
        if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error
      }
    } finally {
      await rm(stagingRoot, { recursive: true, force: true })
    }
  }
  const pluginIdentityRelativeFiles = await regularFiles(pluginRoot)
  if (component.skillOnly === true) await assertSkillOnlyPlugin({ ...component, pluginRoot })
  const projectedSkill = component.developerSkill === undefined ? undefined : {
    ...component.developerSkill,
    root: join(pluginRoot, 'skills', component.developerSkill.id),
    launcherPath: join(pluginRoot, 'skills', component.developerSkill.id, projectedLauncherRelativePath(component.developerSkill)),
  }
  const projectedProviderSkill = component.providerSkill === undefined ? undefined : {
    ...component.providerSkill,
    root: join(pluginRoot, 'skills', component.providerSkill.id),
    launcherPath: join(pluginRoot, 'skills', component.providerSkill.id, projectedLauncherRelativePath(component.providerSkill)),
  }
  return {
    ...component,
    marketplaceRoot,
    pluginRoot,
    pluginIdentityRelativeFiles,
    pluginIdentityFingerprint: await fingerprintRelativeFiles(pluginRoot, pluginIdentityRelativeFiles),
    ...(projectedSkill === undefined ? {} : { developerSkill: projectedSkill }),
    ...(projectedProviderSkill === undefined ? {} : { providerSkill: projectedProviderSkill }),
  }
}

export async function resolveWorkspaceRoot(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new AgentHostError('WORKSPACE_ROOT_INVALID', 'The workspace root must be an absolute directory path')
  }
  let root
  try {
    root = await realpath(resolve(value))
  } catch (error) {
    throw new AgentHostError('WORKSPACE_ROOT_INVALID', `The workspace root is unavailable: ${error.message}`)
  }
  if (!(await stat(root)).isDirectory()) throw new AgentHostError('WORKSPACE_ROOT_INVALID', 'The workspace root must be a directory')
  return root
}

export async function materializeCodexProjections(manifest, projectionRoot, workspaceRoot) {
  await mkdir(projectionRoot, { recursive: true, mode: 0o700 })
  const components = { ...manifest.components }
  for (const [componentId, component] of Object.entries(components)) {
    if (component.plugin === undefined) continue
    components[componentId] = await materializeComponent(componentId, component, projectionRoot, workspaceRoot)
  }
  return { ...manifest, components }
}

export async function pruneCodexProjections(projectionRoot, activeMarketplaceRoots) {
  let root
  try {
    root = await realpath(projectionRoot)
  } catch (error) {
    if (error.code === 'ENOENT') return { removed: 0 }
    throw error
  }
  const active = new Set(await Promise.all(activeMarketplaceRoots.map((path) => realpath(dirname(path)))))
  let removed = 0
  for (const component of await readdir(root, { withFileTypes: true })) {
    const componentRoot = join(root, component.name)
    if (component.isSymbolicLink() || !component.isDirectory()) {
      throw new AgentHostError('CODEX_PROJECTION_INVALID', `Codex projection storage contains an unsafe entry: ${componentRoot}`)
    }
    for (const entry of await readdir(componentRoot, { withFileTypes: true })) {
      const path = join(componentRoot, entry.name)
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new AgentHostError('CODEX_PROJECTION_INVALID', `Codex projection storage contains an unsafe entry: ${path}`)
      }
      const resolved = await realpath(path)
      if (active.has(resolved)) continue
      await rm(resolved, { recursive: true, force: false })
      removed += 1
    }
  }
  return { removed }
}
