import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { AgentHostError } from './errors.mjs'
import { fingerprintIdentityFiles, fingerprintRelativeFiles } from './development-manifest.mjs'
import { readJson } from './json.mjs'
import { ensurePrivateDirectory } from './paths.mjs'
import {
  COMPONENT_SCHEMA,
  REQUIRED_RELEASE_COMPONENTS,
  containedComponentPath,
  installDirectoryName,
  resolveArtifactUrl,
  selectedReleaseComponents,
  validateComponentDescriptor,
} from './release-manifest.mjs'
import { runFile } from './process.mjs'
import { isToolIntegrationSchema, TOOL_INTEGRATION_SCHEMA_V2 } from './tool-integration.mjs'

function fail(code, message, details) {
  throw new AgentHostError(code, message, details)
}

async function digestFile(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return `sha256:${hash.digest('hex')}`
}

function archiveName(component) {
  return `${component.id}-${component.version}-${component.platform}-${component.artifact.sha256.slice(7, 23)}.tar.gz`
}

async function verifyArchive(path, component) {
  const info = await stat(path).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (info === null || !info.isFile()) return false
  if (info.size !== component.artifact.bytes) return false
  return await digestFile(path) === component.artifact.sha256
}

async function acquireArtifact(component, manifestPath, paths) {
  const destination = join(paths.downloads, archiveName(component))
  if (await verifyArchive(destination, component)) return { path: destination, created: false }
  await rm(destination, { force: true })
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`
  const url = resolveArtifactUrl(manifestPath, component.artifact.url)
  try {
    if (url.protocol === 'file:') {
      await copyFile(fileURLToPath(url), temporary)
    } else if (url.protocol === 'https:') {
      const response = await fetch(url, { redirect: 'error' })
      if (!response.ok || response.body === null) fail('RELEASE_DOWNLOAD_FAILED', `Failed to download ${component.id}`, { status: response.status })
      const length = Number(response.headers.get('content-length'))
      if (Number.isFinite(length) && length !== component.artifact.bytes) fail('RELEASE_ARTIFACT_SIZE_MISMATCH', `${component.id} download size differs from the release manifest`)
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { mode: 0o600, flags: 'wx' }))
    } else {
      fail('RELEASE_DOWNLOAD_FAILED', `Unsupported artifact protocol: ${url.protocol}`)
    }
    if (!(await verifyArchive(temporary, component))) fail('RELEASE_ARTIFACT_DIGEST_MISMATCH', `${component.id} archive does not match its bound size and SHA-256`)
    await rename(temporary, destination)
    return { path: destination, created: true }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

function safeArchiveEntry(raw) {
  const value = raw.replace(/^\.\//u, '').replace(/\/$/u, '')
  if (value === '') return true
  if (value.includes('\\') || isAbsolute(value)) return false
  const parts = value.split('/')
  return !parts.includes('..') && !parts.includes('')
}

async function inspectArchive(path, runner) {
  const listing = await runner('/usr/bin/tar', ['-tzf', path])
  const entries = listing.stdout.split('\n').filter(Boolean)
  if (entries.length === 0 || !entries.some((entry) => entry.replace(/^\.\//u, '') === 'component.json')) fail('RELEASE_ARCHIVE_INVALID', 'Release archive does not contain component.json')
  for (const entry of entries) if (!safeArchiveEntry(entry)) fail('RELEASE_ARCHIVE_UNSAFE', `Release archive contains an unsafe path: ${entry}`)
  const verbose = await runner('/usr/bin/tar', ['-tvzf', path])
  for (const line of verbose.stdout.split('\n').filter(Boolean)) {
    if (!['-', 'd'].includes(line[0])) fail('RELEASE_ARCHIVE_UNSAFE', 'Release archives cannot contain links or special files')
  }
}

async function inventoryFiles(root, current = root) {
  const output = []
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name)
    const info = await lstat(path)
    if (info.isSymbolicLink()) fail('RELEASE_ARCHIVE_UNSAFE', `Installed component contains a symbolic link: ${relative(root, path)}`)
    if (info.isDirectory()) output.push(...await inventoryFiles(root, path))
    else if (info.isFile()) output.push({ path, relative: relative(root, path), info })
    else fail('RELEASE_ARCHIVE_UNSAFE', `Installed component contains a special file: ${relative(root, path)}`)
  }
  return output.sort((left, right) => left.relative.localeCompare(right.relative))
}

async function verifyInstalledComponent(root, releaseComponent, { applyModes = true } = {}) {
  const resolvedRoot = await realpath(root)
  const descriptorPath = join(resolvedRoot, 'component.json')
  if (await digestFile(descriptorPath) !== releaseComponent.descriptorSha256) fail('COMPONENT_DESCRIPTOR_DIGEST_MISMATCH', `${releaseComponent.id} descriptor digest differs from the release manifest`)
  const descriptor = validateComponentDescriptor(await readJson(descriptorPath), releaseComponent)
  const actual = await inventoryFiles(resolvedRoot)
  const expected = new Map(descriptor.files.map((item) => [item.path, item]))
  const actualPaths = actual.map((item) => item.relative).filter((path) => path !== 'component.json')
  if (actualPaths.length !== expected.size || actualPaths.some((path) => !expected.has(path))) fail('COMPONENT_FILE_SET_MISMATCH', `${releaseComponent.id} installed file set differs from its descriptor`)
  for (const file of actual.filter((item) => item.relative !== 'component.json')) {
    const item = expected.get(file.relative)
    if (file.info.size !== item.bytes || await digestFile(file.path) !== item.sha256) fail('COMPONENT_FILE_DIGEST_MISMATCH', `${releaseComponent.id} file differs from its descriptor: ${file.relative}`)
    if (applyModes) await chmod(file.path, item.executable ? 0o500 : 0o400)
    if (item.executable) await access(file.path, constants.X_OK)
  }
  if (applyModes) await chmod(descriptorPath, 0o400)
  return { root: resolvedRoot, descriptor, descriptorPath }
}

async function installArtifact(component, archivePath, paths, runner) {
  const parent = await ensurePrivateDirectory(join(paths.packages, component.id))
  const destination = join(parent, installDirectoryName(component))
  try {
    return { ...await verifyInstalledComponent(destination, component), created: false }
  } catch (error) {
    if (error.code !== 'ENOENT') await rm(destination, { recursive: true, force: true }).catch(() => {})
  }
  const staging = join(parent, `.staging-${process.pid}-${Date.now()}`)
  await mkdir(staging, { mode: 0o700 })
  try {
    await inspectArchive(archivePath, runner)
    await runner('/usr/bin/tar', ['-xzf', archivePath, '-C', staging, '--no-same-owner'])
    const installed = await verifyInstalledComponent(staging, component)
    await rename(staging, destination)
    return { ...installed, root: destination, descriptorPath: join(destination, 'component.json'), created: true }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

function directoryPath(root, value, label) {
  if (typeof value !== 'string' || value.includes('\\')) fail('COMPONENT_DESCRIPTOR_INVALID', `${label} is invalid`)
  const target = resolve(root, value)
  const relation = relative(root, target)
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) fail('COMPONENT_DESCRIPTOR_INVALID', `${label} escapes the installed component`)
  return target
}

function requireEntrypoints(installed, names) {
  for (const name of names) {
    if (typeof installed.descriptor.entrypoints[name] !== 'string') fail('COMPONENT_DESCRIPTOR_INVALID', `${installed.descriptor.id} is missing the ${name} entrypoint`)
  }
}

function integration(installed) {
  const value = installed.descriptor.integration
  if (value === null) fail('COMPONENT_DESCRIPTOR_INVALID', `${installed.descriptor.id} integration metadata is missing`)
  for (const name of ['pluginRoot', 'marketplaceRoot', 'marketplace', 'plugin', 'pluginIdentityRelativeFiles']) {
    if (value[name] === undefined) fail('COMPONENT_DESCRIPTOR_INVALID', `${installed.descriptor.id} integration field is missing: ${name}`)
  }
  if (!Array.isArray(value.pluginIdentityRelativeFiles) || value.pluginIdentityRelativeFiles.length === 0) fail('COMPONENT_DESCRIPTOR_INVALID', `${installed.descriptor.id} plugin identity files are invalid`)
  return value
}

async function buildRuntimeManifest(release, installed) {
  const node = installed.get('node-runtime')
  const runtime = installed.get('direct-execution-runtime')
  const math = installed.get('math-anchor')
  const time = installed.get('migratory-time')
  requireEntrypoints(node, ['node'])
  requireEntrypoints(runtime, ['cli'])
  requireEntrypoints(math, ['command'])
  requireEntrypoints(time, ['server', 'adapter', 'manifest', 'inputSchema', 'outputSchema', 'profile'])
  const mathIntegration = integration(math)
  const timeIntegration = integration(time)
  const identities = (item) => [item.descriptorPath, ...item.descriptor.identityFiles.map((path) => containedComponentPath(item.root, path, `${item.descriptor.id} identity file`))]
  const component = async (item, values) => ({
    version: item.descriptor.version,
    root: item.root,
    identityFiles: identities(item),
    fingerprint: await fingerprintIdentityFiles(identities(item)),
    descriptorPath: item.descriptorPath,
    releaseArtifact: release.components.find((entry) => entry.id === item.descriptor.id),
    ...values,
  })
  const nodeCommand = containedComponentPath(node.root, node.descriptor.entrypoints.node, 'Node entrypoint')
  const mathPluginRoot = directoryPath(math.root, mathIntegration.pluginRoot, 'Math Anchor plugin root')
  const timePluginRoot = directoryPath(time.root, timeIntegration.pluginRoot, 'Migratory Time plugin root')
  const components = {
    'node-runtime': await component(node, { command: nodeCommand, args: [] }),
    'direct-execution-runtime': await component(runtime, {
      command: nodeCommand,
      args: [containedComponentPath(runtime.root, runtime.descriptor.entrypoints.cli, 'Direct Runtime CLI')],
    }),
    'math-anchor': await component(math, {
      pluginRoot: mathPluginRoot,
      marketplaceRoot: directoryPath(math.root, mathIntegration.marketplaceRoot, 'Math Anchor marketplace root'),
      marketplace: mathIntegration.marketplace,
      plugin: mathIntegration.plugin,
      pluginIdentityRelativeFiles: mathIntegration.pluginIdentityRelativeFiles,
      pluginIdentityFingerprint: await fingerprintRelativeFiles(mathPluginRoot, mathIntegration.pluginIdentityRelativeFiles),
      command: containedComponentPath(math.root, math.descriptor.entrypoints.command, 'Math Anchor command'),
      args: mathIntegration.args ?? ['mcp'],
    }),
    'migratory-time': await component(time, {
      pluginRoot: timePluginRoot,
      marketplaceRoot: directoryPath(time.root, timeIntegration.marketplaceRoot, 'Migratory Time marketplace root'),
      marketplace: timeIntegration.marketplace,
      plugin: timeIntegration.plugin,
      pluginIdentityRelativeFiles: timeIntegration.pluginIdentityRelativeFiles,
      pluginIdentityFingerprint: await fingerprintRelativeFiles(timePluginRoot, timeIntegration.pluginIdentityRelativeFiles),
      command: nodeCommand,
      args: [containedComponentPath(time.root, time.descriptor.entrypoints.server, 'Migratory Time server')],
      adapterPath: containedComponentPath(time.root, time.descriptor.entrypoints.adapter, 'Migratory Time adapter'),
      manifestPath: containedComponentPath(time.root, time.descriptor.entrypoints.manifest, 'Migratory Time provider manifest'),
      inputSchemaPath: containedComponentPath(time.root, time.descriptor.entrypoints.inputSchema, 'Migratory Time input schema'),
      outputSchemaPath: containedComponentPath(time.root, time.descriptor.entrypoints.outputSchema, 'Migratory Time output schema'),
      profilePath: containedComponentPath(time.root, time.descriptor.entrypoints.profile, 'Migratory Time Capability Profile'),
    }),
  }
  const observer = installed.get('agent-tool-observer')
  const analyzer = installed.get('context-surface-analyzer')
  if (observer !== undefined && analyzer !== undefined) {
    requireEntrypoints(observer, ['cli'])
    requireEntrypoints(analyzer, ['cli'])
    components['agent-tool-observer'] = await component(observer, {
      command: nodeCommand,
      args: [containedComponentPath(observer.root, observer.descriptor.entrypoints.cli, 'Agent Tool Observer CLI')],
    })
    components['context-surface-analyzer'] = await component(analyzer, {
      command: nodeCommand,
      args: [containedComponentPath(analyzer.root, analyzer.descriptor.entrypoints.cli, 'Context Surface Analyzer CLI')],
    })
  }
  for (const [id, item] of installed) {
    if (!isToolIntegrationSchema(item.descriptor.integration?.schemaVersion)) continue
    const tool = item.descriptor.integration
    const pluginRoot = directoryPath(item.root, tool.codex.pluginRoot, `${tool.displayName} plugin root`)
    const runtimeEntrypoint = containedComponentPath(item.root, tool.runtime.command, `${tool.displayName} runtime command`)
    const usesSuiteNode = tool.schemaVersion === TOOL_INTEGRATION_SCHEMA_V2 && tool.runtime.executor === 'suite-node'
    const auxiliaryCli = id === 'context-surface-analyzer' && components[id] !== undefined
      ? { cliCommand: components[id].command, cliArgs: components[id].args }
      : {}
    components[id] = await component(item, {
      displayName: tool.displayName,
      summary: tool.summary,
      pluginRoot,
      marketplaceRoot: directoryPath(item.root, tool.codex.marketplaceRoot, `${tool.displayName} marketplace root`),
      marketplace: tool.codex.marketplace,
      plugin: tool.codex.plugin,
      pluginIdentityRelativeFiles: tool.codex.identityFiles,
      pluginIdentityFingerprint: await fingerprintRelativeFiles(pluginRoot, tool.codex.identityFiles),
      command: usesSuiteNode ? nodeCommand : runtimeEntrypoint,
      args: usesSuiteNode ? [runtimeEntrypoint, ...tool.runtime.args] : tool.runtime.args,
      cwd: directoryPath(item.root, tool.runtime.cwd, `${tool.displayName} runtime directory`),
      workspaceEnvironment: tool.runtime.workspaceEnvironment ?? [],
      expectedTools: tool.runtime.expectedTools,
      healthTimeoutMs: tool.runtime.timeoutMs,
      toolIntegrationSchema: tool.schemaVersion,
      ...auxiliaryCli,
    })
  }
  return {
    schemaVersion: release.schemaVersion,
    suiteVersion: release.suiteVersion,
    releaseId: release.releaseId,
    channel: 'release',
    components,
  }
}

export async function materializeRelease({ path: manifestPath, manifest }, paths, dependencies = {}) {
  if (manifest.status === 'draft-unbound') fail('RELEASE_UNBOUND', 'No verified compatibility release is bound in this build')
  const runner = dependencies.runner ?? runFile
  const selected = selectedReleaseComponents(manifest)
  const installed = new Map()
  const createdRoots = []
  const createdDownloads = []
  const componentIds = dependencies.componentIds ?? [...selected.keys()]
  const missing = REQUIRED_RELEASE_COMPONENTS.filter((id) => !componentIds.includes(id))
  if (missing.length > 0) fail('PROFILE_COMPONENTS_MISSING', 'The selected profile omits required Agent Host components', { components: missing })
  try {
    for (const id of componentIds) {
      const component = selected.get(id)
      if (component === undefined) fail('PROFILE_COMPONENTS_MISSING', 'The selected release does not contain a profile component', { component: id })
      const acquired = await acquireArtifact(component, manifestPath, paths)
      if (acquired.created) createdDownloads.push(acquired.path)
      const result = await installArtifact(component, acquired.path, paths, runner)
      if (result.created) createdRoots.push(result.root)
      installed.set(id, result)
    }
    return {
      manifest: await buildRuntimeManifest(manifest, installed),
      release: structuredClone(manifest),
      manifestPath,
      createdRoots,
      createdDownloads,
    }
  } catch (error) {
    await cleanupMaterializedRelease({ createdRoots, createdDownloads })
    throw error
  }
}

export async function cleanupMaterializedRelease(preparation) {
  for (const root of [...(preparation?.createdRoots ?? [])].reverse()) await rm(root, { recursive: true, force: true }).catch(() => {})
  for (const path of preparation?.createdDownloads ?? []) await rm(path, { force: true }).catch(() => {})
}

export async function discardMaterializedDownloads(preparation) {
  for (const path of preparation?.createdDownloads ?? []) await rm(path, { force: true }).catch(() => {})
  if (preparation !== null && preparation !== undefined) preparation.createdDownloads = []
}

export async function verifyReleaseComponent(component) {
  if (component?.root === undefined || component?.releaseArtifact === undefined) fail('COMPONENT_RELEASE_METADATA_MISSING', 'Release component verification metadata is missing')
  await verifyInstalledComponent(component.root, component.releaseArtifact, { applyModes: false })
  return true
}

export async function descriptorDigest(path) {
  return await digestFile(path)
}

export function componentDescriptorSchema() {
  return COMPONENT_SCHEMA
}
