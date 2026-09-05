import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { AgentHostError } from './errors.mjs'
import { canonicalJson } from './json.mjs'
import { requireContainedRealPath } from './paths.mjs'

async function requireFile(root, relativePath, label) {
  const path = await requireContainedRealPath(root, join(root, relativePath), label)
  const info = await stat(path)
  if (!info.isFile()) throw new AgentHostError('DEVELOPMENT_COMPONENT_INVALID', `${label} is not a file`, { path })
  return path
}

async function jsonFile(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

export async function fingerprintIdentityFiles(paths) {
  const files = paths.map((path) => ({ name: path, path }))
  const items = []
  for (const file of files) {
    const bytes = await readFile(file.path)
    items.push({ name: file.name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length })
  }
  return `sha256:${createHash('sha256').update(canonicalJson(items)).digest('hex')}`
}

export async function fingerprintRelativeFiles(root, relativePaths) {
  const files = []
  for (const relativePath of relativePaths) files.push({ name: relativePath, path: join(root, relativePath) })
  const items = []
  for (const file of files) {
    const bytes = await readFile(file.path)
    items.push({ name: file.name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length })
  }
  return `sha256:${createHash('sha256').update(canonicalJson(items)).digest('hex')}`
}

async function fingerprint(files) {
  const items = []
  for (const file of files) {
    const bytes = await readFile(file.path)
    items.push({ name: file.path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length })
  }
  return `sha256:${createHash('sha256').update(canonicalJson(items)).digest('hex')}`
}

function pythonProjectVersion(text) {
  const projectStart = text.indexOf('[project]')
  if (projectStart === -1) throw new AgentHostError('DEVELOPMENT_COMPONENT_INVALID', 'Math Anchor project metadata has no [project] section')
  const remaining = text.slice(projectStart + '[project]'.length)
  const nextSection = remaining.search(/^\[/mu)
  const section = nextSection === -1 ? remaining : remaining.slice(0, nextSection)
  const version = section.match(/^\s*version\s*=\s*"([^"]+)"\s*$/mu)?.[1]
  if (version === undefined) throw new AgentHostError('DEVELOPMENT_COMPONENT_INVALID', 'Math Anchor project version is missing')
  return version
}

export async function buildDevelopmentManifest(developmentRoot) {
  const suitePackage = await jsonFile(new URL('../package.json', import.meta.url))
  if (suitePackage.name !== '@openadam/agent-host-suite'
    || typeof suitePackage.version !== 'string'
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(suitePackage.version)) {
    throw new AgentHostError('DEVELOPMENT_COMPONENT_INVALID', 'The current Agent Host package identity is invalid')
  }
  const root = await requireContainedRealPath(developmentRoot, resolve(developmentRoot), 'development root')
  const roots = {
    math: await requireContainedRealPath(root, join(root, 'calculator'), 'Math Anchor root'),
    time: await requireContainedRealPath(root, join(root, 'migratory-time'), 'Migratory Time root'),
    runtime: await requireContainedRealPath(
      root,
      join(root, 'agent-host-suite', 'packages', 'direct-execution-runtime'),
      'Direct Runtime root',
    ),
    capability: await requireContainedRealPath(root, join(root, 'capability-contracts'), 'Capability Contracts root'),
  }

  const mathFiles = [
    ['plugin', 'plugins/math-anchor/.codex-plugin/plugin.json'],
    ['mcp', 'plugins/math-anchor/.mcp.json'],
    ['runtime', 'plugins/math-anchor/runtime/math-anchor-runtime/math-anchor-runtime'],
    ['runtime-manifest', 'plugins/math-anchor/runtime/math-anchor-runtime/.math-anchor-build-manifest.json'],
    ['skill', 'plugins/math-anchor/skills/calculate/SKILL.md'],
    ['project', 'pyproject.toml'],
    ['marketplace', '.agents/plugins/marketplace.json'],
  ]
  const mathIdentity = []
  for (const [name, relative] of mathFiles) mathIdentity.push({ name, path: await requireFile(roots.math, relative, `Math Anchor ${name}`) })
  const mathPlugin = await jsonFile(mathIdentity.find((item) => item.name === 'plugin').path)
  const mathVersion = pythonProjectVersion(await readFile(mathIdentity.find((item) => item.name === 'project').path, 'utf8'))
  if (mathPlugin.version !== mathVersion) {
    throw new AgentHostError('DEVELOPMENT_VERSION_DRIFT', 'Math Anchor plugin and project versions differ')
  }
  const mathMarketplace = await jsonFile(mathIdentity.find((item) => item.name === 'marketplace').path)
  const mathPluginIdentityRelativeFiles = [
    '.codex-plugin/plugin.json',
    '.mcp.json',
    'runtime/math-anchor-runtime/math-anchor-runtime',
    'runtime/math-anchor-runtime/.math-anchor-build-manifest.json',
    'skills/calculate/SKILL.md',
  ]

  const timeFiles = [
    ['plugin', 'plugins/migratory-time/.codex-plugin/plugin.json'],
    ['mcp', 'plugins/migratory-time/.mcp.json'],
    ['server', 'plugins/migratory-time/server/index.mjs'],
    ['skill', 'plugins/migratory-time/skills/convert-time-zones/SKILL.md'],
    ['manifest', 'capabilities/provider.json'],
    ['adapter', 'scripts/runCapabilityAdapter.mjs'],
    ['input-schema', 'capabilities/schemas/time-zone.convert.input.schema.json'],
    ['output-schema', 'capabilities/schemas/time-zone.convert.output.schema.json'],
    ['marketplace', '.agents/plugins/marketplace.json'],
  ]
  const timeIdentity = []
  for (const [name, relative] of timeFiles) timeIdentity.push({ name, path: await requireFile(roots.time, relative, `Migratory Time ${name}`) })
  const timePlugin = await jsonFile(timeIdentity.find((item) => item.name === 'plugin').path)
  const timeMarketplace = await jsonFile(timeIdentity.find((item) => item.name === 'marketplace').path)
  const timePluginIdentityRelativeFiles = [
    '.codex-plugin/plugin.json',
    '.mcp.json',
    'server/index.mjs',
    'skills/convert-time-zones/SKILL.md',
  ]

  const runtimeFiles = [
    ['package', 'package.json'],
    ['lock', 'package-lock.json'],
    ['cli', 'src/cli.mjs'],
    ['runtime', 'src/runtime.mjs'],
    ['service', 'src/host-service.mjs'],
    ['host-client', 'src/host-client.mjs'],
    ['host-protocol', 'src/host-protocol.mjs'],
    ['operation-projection', 'src/operation-projection.mjs'],
    ['mcp-session', 'src/sessions/mcp-session.mjs'],
    ['schema-loader', 'src/schema.mjs'],
    ['config-schema', 'schemas/provider-config.schema.json'],
    ['legacy-config-schema', 'schemas/provider-config.schema.v0.2.json'],
    ['service-observation-schema', 'schemas/host-service-observation.schema.json'],
    ['legacy-service-observation-schema', 'schemas/host-service-observation.schema.v0.1.json'],
    ['work-order-schema', 'schemas/work-order.schema.json'],
    ['selection-schema', 'schemas/contract-selection.schema.json'],
    ['host-request-schema', 'schemas/host-request.schema.json'],
  ]
  const runtimeIdentity = []
  for (const [name, relative] of runtimeFiles) runtimeIdentity.push({ name, path: await requireFile(roots.runtime, relative, `Direct Runtime ${name}`) })
  const runtimePackage = await jsonFile(runtimeIdentity.find((item) => item.name === 'package').path)
  const capabilityProfile = await requireFile(roots.capability, 'catalog/capabilities/time-zone-convert.v0.2.json', 'time-zone Capability Profile')

  return {
    schemaVersion: 'openadam.agent-host-development-set.v0.1',
    suiteVersion: suitePackage.version,
    channel: 'development',
    developmentRoot: root,
    components: {
      'math-anchor': {
        version: mathVersion,
        root: roots.math,
        pluginRoot: join(roots.math, 'plugins/math-anchor'),
        marketplaceRoot: roots.math,
        marketplace: mathMarketplace.name,
        plugin: mathPlugin.name,
        pluginIdentityRelativeFiles: mathPluginIdentityRelativeFiles,
        pluginIdentityFingerprint: await fingerprintRelativeFiles(join(roots.math, 'plugins/math-anchor'), mathPluginIdentityRelativeFiles),
        command: mathIdentity.find((item) => item.name === 'runtime').path,
        args: ['mcp'],
        cwd: join(roots.math, 'plugins/math-anchor'),
        identityFiles: mathIdentity.map((item) => item.path),
        fingerprint: await fingerprint(mathIdentity),
      },
      'migratory-time': {
        version: timePlugin.version,
        root: roots.time,
        pluginRoot: join(roots.time, 'plugins/migratory-time'),
        marketplaceRoot: roots.time,
        marketplace: timeMarketplace.name,
        plugin: timePlugin.name,
        pluginIdentityRelativeFiles: timePluginIdentityRelativeFiles,
        pluginIdentityFingerprint: await fingerprintRelativeFiles(join(roots.time, 'plugins/migratory-time'), timePluginIdentityRelativeFiles),
        command: process.execPath,
        args: [timeIdentity.find((item) => item.name === 'server').path],
        cwd: join(roots.time, 'plugins/migratory-time'),
        manifestPath: timeIdentity.find((item) => item.name === 'manifest').path,
        adapterPath: timeIdentity.find((item) => item.name === 'adapter').path,
        inputSchemaPath: timeIdentity.find((item) => item.name === 'input-schema').path,
        outputSchemaPath: timeIdentity.find((item) => item.name === 'output-schema').path,
        profilePath: capabilityProfile,
        identityFiles: timeIdentity.map((item) => item.path),
        fingerprint: await fingerprint(timeIdentity),
      },
      'direct-execution-runtime': {
        version: runtimePackage.version,
        root: roots.runtime,
        command: process.execPath,
        args: [runtimeIdentity.find((item) => item.name === 'cli').path],
        identityFiles: runtimeIdentity.map((item) => item.path),
        fingerprint: await fingerprint(runtimeIdentity),
      },
    },
  }
}

async function sourceInventory(root, directory, extensions) {
  const files = []
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isSymbolicLink()) throw new AgentHostError('DEVELOPMENT_COMPONENT_INVALID', `Source inventory contains a symlink: ${path}`)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))) files.push(path)
    }
  }
  await walk(join(root, directory))
  return files.sort()
}

export async function buildDevelopmentObservabilityManifest(developmentRoot) {
  const root = await requireContainedRealPath(developmentRoot, resolve(developmentRoot), 'development root')
  const observerRoot = await requireContainedRealPath(
    root,
    join(root, 'agent-host-suite', 'packages', 'agent-tool-observer'),
    'Agent Tool Observer root',
  )
  const analyzerRoot = await requireContainedRealPath(
    root,
    join(root, 'agent-host-suite', 'packages', 'context-surface-analyzer'),
    'Context Surface Analyzer root',
  )
  const observerPackagePath = await requireFile(observerRoot, 'package.json', 'Agent Tool Observer package')
  const analyzerPackagePath = await requireFile(analyzerRoot, 'package.json', 'Context Surface Analyzer package')
  const observerPackage = await jsonFile(observerPackagePath)
  const analyzerPackage = await jsonFile(analyzerPackagePath)
  const observerIdentityFiles = [
    observerPackagePath,
    await requireFile(observerRoot, 'package-lock.json', 'Agent Tool Observer package lock'),
    ...await sourceInventory(observerRoot, 'src', ['.mjs']),
  ]
  const analyzerIdentityFiles = [
    analyzerPackagePath,
    await requireFile(analyzerRoot, 'package-lock.json', 'Context Surface Analyzer package lock'),
    ...await sourceInventory(analyzerRoot, 'src', ['.js']),
  ]
  return {
    'agent-tool-observer': {
      version: observerPackage.version,
      root: observerRoot,
      command: process.execPath,
      args: [join(observerRoot, 'src/cli.mjs')],
      identityFiles: observerIdentityFiles,
      fingerprint: await fingerprintIdentityFiles(observerIdentityFiles),
    },
    'context-surface-analyzer': {
      version: analyzerPackage.version,
      root: analyzerRoot,
      command: process.execPath,
      args: [join(analyzerRoot, 'src/cli.js')],
      identityFiles: analyzerIdentityFiles,
      fingerprint: await fingerprintIdentityFiles(analyzerIdentityFiles),
    },
  }
}
