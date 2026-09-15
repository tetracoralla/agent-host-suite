import { readdir, readFile, stat } from 'node:fs/promises'
import { join, posix, relative, sep } from 'node:path'
import { AgentHostError } from './errors.mjs'
import { isAbsoluteArchiveMemberPath, posixArchiveMemberPath } from './archive-member-path.mjs'
import { presentationFromPackageMetadata } from './tool-presentation.mjs'
import { integrationRelativePath } from './tool-integration.mjs'

function fail(code, message, details) {
  throw new AgentHostError(code, message, details)
}

async function readJsonIfPresent(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    if (error instanceof SyntaxError) fail('GITHUB_PLUGIN_INVALID', `Plugin metadata is not valid JSON: ${path}`)
    throw error
  }
}

async function listFiles(root) {
  const files = []
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isSymbolicLink()) fail('GITHUB_PLUGIN_INVALID', 'Plugin archive may not contain symbolic links')
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) files.push(relative(root, path).split(sep).join('/'))
      else fail('GITHUB_PLUGIN_INVALID', 'Plugin archive may not contain special files')
    }
  }
  await walk(root)
  return files.sort()
}

async function skillIds(pluginRoot, pluginJson, files) {
  const declared = typeof pluginJson?.skills === 'string' ? pluginJson.skills : './skills/'
  let skillsRoot
  try {
    skillsRoot = integrationRelativePath(declared.replace(/^\.\//u, '').replace(/\/$/u, ''), 'plugin skills root')
  } catch {
    return []
  }
  const prefix = `${skillsRoot}/`
  const ids = new Set()
  for (const path of files) {
    if (path === `${skillsRoot}` || !path.startsWith(prefix)) continue
    const rest = path.slice(prefix.length)
    const [id, leaf] = rest.split('/')
    if (leaf === 'SKILL.md' && /^[a-z][a-z0-9-]*$/u.test(id)) ids.add(id)
  }
  return [...ids].sort()
}

function parseMcp(mcp) {
  const servers = mcp?.mcpServers
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
    fail('GITHUB_PLUGIN_INVALID', 'Plugin MCP catalog must declare mcpServers')
  }
  const entries = Object.entries(servers)
  if (entries.length !== 1) fail('GITHUB_PLUGIN_INVALID', 'Plugin must declare exactly one MCP server')
  const [serverName, server] = entries[0]
  if (server === null || typeof server !== 'object' || Array.isArray(server)) {
    fail('GITHUB_PLUGIN_INVALID', 'Plugin MCP server is invalid')
  }
  const command = server.command
  const args = Array.isArray(server.args) ? server.args.map((item) => String(item)) : []
  const cwd = typeof server.cwd === 'string' && server.cwd.length > 0 ? server.cwd : '.'
  return { serverName, command, args, cwd }
}

function cliCandidate(packageJson, files) {
  const bin = packageJson?.bin
  if (typeof bin === 'string') return bin.replace(/^\.\//u, '')
  if (bin !== null && typeof bin === 'object' && !Array.isArray(bin)) {
    const values = Object.values(bin).filter((item) => typeof item === 'string')
    if (values.length === 1) return values[0].replace(/^\.\//u, '')
  }
  for (const path of ['dist/adapters/cli.js', 'dist/cli.js', 'cli.js', 'cli.mjs', 'bin/cli.js']) {
    if (files.includes(path)) return path
  }
  return null
}

export async function inspectGitHubPluginRoot(pluginRoot) {
  const files = await listFiles(pluginRoot)
  const pluginJson = await readJsonIfPresent(join(pluginRoot, '.codex-plugin/plugin.json'))
  if (pluginJson === null) fail('GITHUB_PLUGIN_INVALID', 'Plugin archive is missing .codex-plugin/plugin.json')
  const mcp = await readJsonIfPresent(join(pluginRoot, '.mcp.json'))
  if (mcp === null) fail('GITHUB_PLUGIN_INVALID', 'Plugin archive is missing .mcp.json')
  const packageJson = await readJsonIfPresent(join(pluginRoot, 'package.json'))
  const id = typeof pluginJson.name === 'string' && /^[a-z][a-z0-9-]*$/u.test(pluginJson.name)
    ? pluginJson.name
    : fail('GITHUB_PLUGIN_INVALID', 'Plugin name is not a supported tool id')
  const version = typeof pluginJson.version === 'string' && pluginJson.version.length > 0
    ? pluginJson.version
    : fail('GITHUB_PLUGIN_INVALID', 'Plugin version is missing')
  const mcpRuntime = parseMcp(mcp)
  let executor
  let command
  let args
  if (mcpRuntime.command === 'node') {
    const script = mcpRuntime.args[0]
    if (typeof script !== 'string' || script.length === 0) fail('GITHUB_PLUGIN_INVALID', 'Plugin MCP node server is missing a script')
    command = integrationRelativePath(script.replace(/^\.\//u, ''), 'plugin MCP script')
    args = mcpRuntime.args.slice(1)
    executor = 'suite-node'
    if (!files.includes(command)) fail('GITHUB_PLUGIN_INVALID', `Plugin MCP script is absent: ${command}`)
  } else {
    command = integrationRelativePath(String(mcpRuntime.command).replace(/^\.\//u, ''), 'plugin MCP command')
    args = mcpRuntime.args
    executor = 'component'
    if (!files.includes(command)) fail('GITHUB_PLUGIN_INVALID', `Plugin MCP command is absent: ${command}`)
  }
  const skills = await skillIds(pluginRoot, pluginJson, files)
  const cli = cliCandidate(packageJson, files)
  const openadam = packageJson?.openadam !== null && typeof packageJson?.openadam === 'object' ? packageJson.openadam : {}
  const expectedTools = Array.isArray(openadam.modelTools)
    ? openadam.modelTools.filter((item) => typeof item === 'string')
    : Array.isArray(openadam.expectedTools)
      ? openadam.expectedTools.filter((item) => typeof item === 'string')
      : []
  const presentation = presentationFromPackageMetadata({
    packageJson,
    pluginJson,
    files,
  })
  const licenseSpdx = presentation.license ?? 'NOASSERTION'
  return {
    id,
    version,
    files,
    packageJson,
    pluginJson,
    mcp,
    serverName: mcpRuntime.serverName,
    executor,
    command,
    args,
    skills,
    cli: cli === null ? null : integrationRelativePath(cli, 'plugin CLI'),
    expectedTools,
    workspaceEnvironment: Array.isArray(openadam.workspaceEnvironment)
      ? openadam.workspaceEnvironment.filter((item) => typeof item === 'string')
      : [],
    presentation,
    licenseSpdx,
    requiresNode: executor === 'suite-node',
  }
}

export function buildToolIntegration(contract, { pluginRoot, marketplace, expectedTools, discoveryLauncher = 'scripts/agent-tool' }) {
  const tools = expectedTools ?? contract.expectedTools
  if (!Array.isArray(tools) || tools.length === 0) {
    fail('GITHUB_PLUGIN_INVALID', 'Plugin MCP catalog did not expose any tools to bind')
  }
  const identityFiles = [
    '.codex-plugin/plugin.json',
    '.mcp.json',
    ...(contract.files.includes('package.json') ? ['package.json'] : []),
    contract.command,
    ...contract.skills.flatMap((id) => [`skills/${id}/SKILL.md`]),
  ].filter((path, index, all) => all.indexOf(path) === index)
  const integration = {
    schemaVersion: contract.skills.length > 0 && contract.cli !== null
      ? 'openadam.agent-host-tool-integration.v0.3'
      : 'openadam.agent-host-tool-integration.v0.2',
    displayName: contract.presentation.displayName,
    summary: contract.presentation.summary,
    codex: {
      marketplaceRoot: 'marketplace',
      marketplace,
      pluginRoot,
      plugin: contract.id,
      identityFiles,
    },
    runtime: {
      transport: 'mcp-stdio',
      executor: contract.executor,
      command: `${pluginRoot}/${contract.command}`,
      args: contract.args,
      cwd: pluginRoot,
      workspaceEnvironment: contract.workspaceEnvironment,
      expectedTools: tools,
      timeoutMs: 10000,
    },
    ownership: { uninstall: 'agent-host-created-only' },
  }
  if (contract.skills.length > 0 && contract.cli !== null) {
    const skillId = contract.skills[0]
    integration.discovery = {
      kind: 'skill-cli',
      skill: {
        id: skillId,
        root: `${pluginRoot}/skills/${skillId}`,
        identityFiles: ['SKILL.md'],
        launcher: discoveryLauncher,
      },
      runtime: {
        executor: contract.executor === 'suite-node' ? 'suite-node' : 'component',
        command: `${pluginRoot}/${contract.cli}`,
        args: [],
        versionArguments: ['--version'],
      },
    }
  }
  return integration
}

export function inferArchiveRoot(entries) {
  const names = entries.map((entry) => posixArchiveMemberPath(entry)).filter(Boolean)
  const roots = new Set(names.map((entry) => entry.split('/')[0]))
  if (roots.size !== 1) fail('GITHUB_PLUGIN_INVALID', 'Plugin archive must contain one top-level directory')
  const root = [...roots][0]
  if (
    root === '' || root === '.' || root === '..'
    || root.includes('\\') || root.includes('/') || root.includes(':')
    || isAbsoluteArchiveMemberPath(root)
  ) {
    fail('GITHUB_PLUGIN_INVALID', 'Plugin archive root is invalid')
  }
  return root
}

export async function existingPluginFile(pluginRoot, names) {
  for (const name of names) {
    try {
      const info = await stat(join(pluginRoot, name))
      if (info.isFile()) return name
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return null
}

export { posix }
