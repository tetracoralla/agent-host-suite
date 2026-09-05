import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
  currentReleasePlatform,
  installDirectoryName,
  resolveArtifactUrl,
  selectedReleaseComponents,
  validateComponentDescriptor,
} from './release-manifest.mjs'
import { runFile } from './process.mjs'
import { isDeveloperKitIntegrationSchema } from './developer-kit-integration.mjs'
import { isToolIntegrationSchema, TOOL_INTEGRATION_SCHEMA_V2, TOOL_INTEGRATION_SCHEMA_V3, TOOL_INTEGRATION_SCHEMA_V4, TOOL_INTEGRATION_SCHEMA_V5 } from './tool-integration.mjs'
import { isSpdxExpressionSyntax } from './spdx-expression.mjs'

function fail(code, message, details) {
  throw new AgentHostError(code, message, details)
}

const MAX_LOCAL_COMPONENT_ARCHIVE_BYTES = 512 * 1024 * 1024
const MAX_LOCAL_COMPONENT_FILES = 20_000
const MAX_LOCAL_COMPONENT_EXPANDED_BYTES = 1024 * 1024 * 1024
const MAX_COMPONENT_DESCRIPTOR_BYTES = 1024 * 1024
const MIN_ARCHIVE_COMMAND_TIMEOUT_MS = 60_000
const MAX_ARCHIVE_COMMAND_TIMEOUT_MS = 10 * 60_000
const ARCHIVE_TIMEOUT_MS_PER_MIB = 2_000
const observedLocalArtifacts = new WeakSet()

function tarCommand() {
  return platform() === 'win32' ? 'tar.exe' : '/usr/bin/tar'
}

function portableRelative(root, path) {
  return relative(root, path).split(sep).join('/')
}

function archiveCommandTimeoutMs(bytes) {
  const mebibytes = Math.max(1, Math.ceil(bytes / (1024 * 1024)))
  return Math.min(
    MAX_ARCHIVE_COMMAND_TIMEOUT_MS,
    MIN_ARCHIVE_COMMAND_TIMEOUT_MS + mebibytes * ARCHIVE_TIMEOUT_MS_PER_MIB,
  )
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
  if (/[\u0000-\u001f\u007f]/u.test(value) || value.includes('\\') || isAbsolute(value)) return false
  const parts = value.split('/')
  return !parts.includes('..') && !parts.includes('')
}

function archiveEntryName(raw) {
  return raw.replace(/^\.\//u, '').replace(/\/$/u, '')
}

function expectedArchiveDirectories(files) {
  const directories = new Set()
  for (const file of files) {
    let directory = dirname(file)
    while (directory !== '.') {
      directories.add(directory)
      directory = dirname(directory)
    }
  }
  return directories
}

async function inspectArchive(path, runner) {
  const archiveInfo = await stat(path)
  const timeoutMs = archiveCommandTimeoutMs(archiveInfo.size)
  const listing = await runner(tarCommand(), ['-tzf', path], { timeoutMs })
  const entries = listing.stdout.split('\n').filter(Boolean)
  if (entries.length === 0 || !entries.some((entry) => entry.replace(/^\.\//u, '') === 'component.json')) fail('RELEASE_ARCHIVE_INVALID', 'Release archive does not contain component.json')
  for (const entry of entries) if (!safeArchiveEntry(entry)) fail('RELEASE_ARCHIVE_UNSAFE', `Release archive contains an unsafe path: ${entry}`)
  const verbose = await runner(tarCommand(), ['-tvzf', path], { timeoutMs })
  const verboseLines = verbose.stdout.split('\n').filter(Boolean)
  for (const line of verboseLines) {
    if (!['-', 'd'].includes(line[0])) fail('RELEASE_ARCHIVE_UNSAFE', 'Release archives cannot contain links or special files')
  }
  return { entries, verboseLines }
}

function localArchiveSizes(verboseLines) {
  const sizes = []
  for (const line of verboseLines.filter((value) => value[0] === '-')) {
    const match = line.match(/^\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s+/u)
    if (match === null) fail('LOCAL_COMPONENT_ARCHIVE_INVALID', 'The local component archive inventory could not be bounded before extraction')
    const value = Number(match[1])
    if (!Number.isSafeInteger(value) || value < 0) fail('LOCAL_COMPONENT_ARCHIVE_INVALID', 'The local component archive contains an invalid file size')
    sizes.push(value)
  }
  return sizes
}

function digestBytes(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

async function localArtifactObservation(path, runner) {
  const absolute = resolve(path)
  if (!isAbsolute(path)) fail('LOCAL_COMPONENT_PATH_INVALID', 'The local component artifact path must be absolute')
  const info = await lstat(absolute).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (info === null || info.isSymbolicLink() || !info.isFile()) {
    fail('LOCAL_COMPONENT_PATH_INVALID', 'The local component artifact must be one real tar.gz file')
  }
  if (info.size <= 0 || info.size > MAX_LOCAL_COMPONENT_ARCHIVE_BYTES) {
    fail('LOCAL_COMPONENT_ARCHIVE_BOUNDS', 'The local component artifact exceeds the supported archive size', {
      maximumBytes: MAX_LOCAL_COMPONENT_ARCHIVE_BYTES,
      actualBytes: info.size,
    })
  }
  const artifactPath = await realpath(absolute)
  const archive = await inspectArchive(artifactPath, runner)
  const archiveTimeoutMs = archiveCommandTimeoutMs(info.size)
  const descriptorResult = await runner(tarCommand(), ['-xOzf', artifactPath, './component.json'], {
    maxBuffer: MAX_COMPONENT_DESCRIPTOR_BYTES,
    timeoutMs: archiveTimeoutMs,
  }).catch(async (error) => {
    if (error.code !== 'HOST_COMMAND_FAILED') throw error
    return runner(tarCommand(), ['-xOzf', artifactPath, 'component.json'], {
      maxBuffer: MAX_COMPONENT_DESCRIPTOR_BYTES,
      timeoutMs: archiveTimeoutMs,
    })
  })
  let descriptor
  try {
    descriptor = JSON.parse(descriptorResult.stdout)
  } catch (error) {
    fail('COMPONENT_DESCRIPTOR_INVALID', `The local component descriptor is invalid JSON: ${error.message}`)
  }
  const releaseComponent = {
    id: descriptor?.id,
    version: descriptor?.version,
    platform: 'local',
    artifact: {
      url: pathToFileURL(artifactPath).href,
      sha256: await digestFile(artifactPath),
      bytes: info.size,
      format: 'tar.gz',
    },
    descriptorSha256: digestBytes(descriptorResult.stdout),
    license: {
      spdx: 'NOASSERTION',
      files: descriptor?.legal === null || typeof descriptor?.legal !== 'object'
        ? []
        : [...new Set([descriptor.legal.license, descriptor.legal.notice, descriptor.legal.thirdPartyNotices].filter((value) => typeof value === 'string'))],
    },
  }
  validateComponentDescriptor(descriptor, releaseComponent)
  const expandedBytes = descriptor.files.reduce((sum, file) => sum + file.bytes, 0)
  const normalizedEntries = archive.entries.map(archiveEntryName).filter((entry) => entry !== '')
  const normalizedEntrySet = new Set(normalizedEntries)
  if (normalizedEntrySet.size !== normalizedEntries.length) {
    fail('LOCAL_COMPONENT_FILE_SET_MISMATCH', 'The local component archive repeats a normalized path')
  }
  const archiveFiles = archive.entries
    .filter((entry) => !entry.endsWith('/'))
    .map(archiveEntryName)
    .filter((entry) => entry !== '')
  const archiveFileSet = new Set(archiveFiles)
  const expectedFileSet = new Set(['component.json', ...descriptor.files.map((file) => file.path)])
  const expectedDirectorySet = expectedArchiveDirectories(expectedFileSet)
  const unexpectedDirectories = archive.entries
    .filter((entry) => entry.endsWith('/'))
    .map(archiveEntryName)
    .filter((entry) => entry !== '' && !expectedDirectorySet.has(entry))
  const fileSetMismatch = archiveFileSet.size !== archiveFiles.length || archiveFileSet.size !== expectedFileSet.size || [...archiveFileSet].some((path) => !expectedFileSet.has(path))
  const archiveSizes = localArchiveSizes(archive.verboseLines)
  const archiveExpandedBytes = archiveSizes.reduce((sum, value) => sum + value, 0)
  if (fileSetMismatch || unexpectedDirectories.length > 0 || archiveSizes.length !== archiveFiles.length) {
    fail('LOCAL_COMPONENT_FILE_SET_MISMATCH', 'The local component archive inventory differs from its descriptor')
  }
  if (descriptor.files.length > MAX_LOCAL_COMPONENT_FILES || expandedBytes > MAX_LOCAL_COMPONENT_EXPANDED_BYTES || archiveExpandedBytes > MAX_LOCAL_COMPONENT_EXPANDED_BYTES + MAX_COMPONENT_DESCRIPTOR_BYTES) {
    fail('LOCAL_COMPONENT_FILE_BOUNDS', 'The local component file inventory exceeds the supported bounds', {
      maximumFiles: MAX_LOCAL_COMPONENT_FILES,
      maximumExpandedBytes: MAX_LOCAL_COMPONENT_EXPANDED_BYTES,
      actualFiles: descriptor.files.length,
      actualExpandedBytes: expandedBytes,
      actualArchiveExpandedBytes: archiveExpandedBytes,
    })
  }
  const observation = {
    artifactPath,
    releaseComponent,
    descriptor,
    limits: {
      maximumArchiveBytes: MAX_LOCAL_COMPONENT_ARCHIVE_BYTES,
      maximumFiles: MAX_LOCAL_COMPONENT_FILES,
      maximumExpandedBytes: MAX_LOCAL_COMPONENT_EXPANDED_BYTES,
    },
    observed: {
      archiveSha256: releaseComponent.artifact.sha256,
      archiveBytes: releaseComponent.artifact.bytes,
      descriptorSha256: releaseComponent.descriptorSha256,
      fileCount: descriptor.files.length,
      expandedBytes,
    },
  }
  observedLocalArtifacts.add(observation)
  return observation
}

export async function observeLocalComponentArtifact(path, dependencies = {}) {
  return localArtifactObservation(path, dependencies.runner ?? runFile)
}

export async function previewLocalComponentArtifact(path, dependencies = {}) {
  const runner = dependencies.runner ?? runFile
  const observation = await localArtifactObservation(path, runner)
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'agent-host-component-preview-'))
  try {
    const boundArchive = join(temporaryRoot, 'component.tar.gz')
    await copyFile(observation.artifactPath, boundArchive)
    if (!(await verifyArchive(boundArchive, observation.releaseComponent))) {
      fail('LOCAL_COMPONENT_BINDING_MISMATCH', 'The local component artifact changed while it was being previewed')
    }
    await installArtifact(observation.releaseComponent, boundArchive, { packages: temporaryRoot }, runner, { archiveInspected: true })
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
  return observation
}

function requireLocalBinding(binding, observation) {
  const expectedKeys = ['archiveSha256', 'archiveBytes', 'descriptorSha256', 'id', 'version', 'platform', 'spdx']
  if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) {
    fail('LOCAL_COMPONENT_BINDING_REQUIRED', 'Import requires the exact facts returned by component preview')
  }
  const unsupported = Object.keys(binding).filter((key) => !expectedKeys.includes(key))
  if (unsupported.length > 0 || expectedKeys.some((key) => binding[key] === undefined)) {
    fail('LOCAL_COMPONENT_BINDING_INVALID', 'The local component binding is incomplete or contains unsupported fields', { fields: unsupported })
  }
  const actual = {
    archiveSha256: observation.releaseComponent.artifact.sha256,
    archiveBytes: observation.releaseComponent.artifact.bytes,
    descriptorSha256: observation.releaseComponent.descriptorSha256,
    id: observation.descriptor.id,
    version: observation.descriptor.version,
    platform: currentReleasePlatform(),
  }
  const mismatches = Object.entries(actual).filter(([key, value]) => binding[key] !== value).map(([key]) => key)
  if (!isSpdxExpressionSyntax(binding.spdx)) mismatches.push('spdx')
  if (mismatches.length > 0) {
    fail('LOCAL_COMPONENT_BINDING_MISMATCH', 'The local component artifact differs from its approved preview facts', { fields: [...new Set(mismatches)] })
  }
  return { ...observation.releaseComponent, platform: actual.platform, license: { ...observation.releaseComponent.license, spdx: binding.spdx } }
}

export async function materializeLocalComponentArtifact(path, binding, paths, dependencies = {}) {
  const runner = dependencies.runner ?? runFile
  const observation = await localArtifactObservation(path, runner)
  return materializeObservedLocalComponentArtifact(observation, binding, paths, { runner })
}

export async function materializeObservedLocalComponentArtifact(observation, binding, paths, dependencies = {}) {
  if (!observedLocalArtifacts.has(observation)) {
    fail('LOCAL_COMPONENT_OBSERVATION_INVALID', 'Local component materialization requires a current observation from this process')
  }
  const runner = dependencies.runner ?? runFile
  const releaseComponent = requireLocalBinding(binding, observation)
  const temporaryRoot = await mkdtemp(join(paths.downloads ?? tmpdir(), 'agent-host-local-component-'))
  try {
    const boundArchive = join(temporaryRoot, 'component.tar.gz')
    await copyFile(observation.artifactPath, boundArchive)
    if (!(await verifyArchive(boundArchive, releaseComponent))) {
      fail('LOCAL_COMPONENT_BINDING_MISMATCH', 'The local component artifact changed while it was being imported')
    }
    const installed = await installArtifact(releaseComponent, boundArchive, paths, runner, { archiveInspected: true })
    return { ...observation, releaseComponent, installed }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

async function inventoryFiles(root, current = root) {
  const output = []
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name)
    const info = await lstat(path)
    if (info.isSymbolicLink()) fail('RELEASE_ARCHIVE_UNSAFE', `Installed component contains a symbolic link: ${portableRelative(root, path)}`)
    if (info.isDirectory()) output.push(...await inventoryFiles(root, path))
    else if (info.isFile()) output.push({ path, relative: portableRelative(root, path), info })
    else fail('RELEASE_ARCHIVE_UNSAFE', `Installed component contains a special file: ${portableRelative(root, path)}`)
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
    if (item.executable && platform() !== 'win32') await access(file.path, constants.X_OK)
  }
  if (applyModes) await chmod(descriptorPath, 0o400)
  return { root: resolvedRoot, descriptor, descriptorPath }
}

async function installArtifact(component, archivePath, paths, runner, options = {}) {
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
    if (options.archiveInspected !== true) await inspectArchive(archivePath, runner)
    const extractionArgs = ['-xzf', archivePath, '-C', staging]
    if (platform() !== 'win32') extractionArgs.push('--no-same-owner')
    await runner(tarCommand(), extractionArgs, {
      timeoutMs: archiveCommandTimeoutMs(component.artifact.bytes),
    })
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

async function productSkills(pluginRoot, identityRelativeFiles) {
  const ids = [...new Set(identityRelativeFiles.flatMap((path) => {
    const match = path.match(/^skills\/([a-z][a-z0-9-]*)\/SKILL\.md$/u)
    return match === null ? [] : [match[1]]
  }))]
  const output = []
  for (const id of ids) {
    const root = await realpath(join(pluginRoot, 'skills', id))
    const rootInfo = await lstat(root)
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      fail('COMPONENT_DESCRIPTOR_INVALID', `Product Skill root is unsafe: ${id}`)
    }
    const files = []
    async function walk(current) {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const path = join(current, entry.name)
        if (entry.isSymbolicLink()) fail('COMPONENT_DESCRIPTOR_INVALID', `Product Skill contains a symbolic link: ${id}`)
        if (entry.isDirectory()) await walk(path)
        else if (entry.isFile()) files.push(portableRelative(root, path))
        else fail('COMPONENT_DESCRIPTOR_INVALID', `Product Skill contains a special file: ${id}`)
      }
    }
    await walk(root)
    files.sort()
    if (!files.includes('SKILL.md')) fail('COMPONENT_DESCRIPTOR_INVALID', `Product Skill is missing SKILL.md: ${id}`)
    output.push({
      id,
      root,
      identityRelativeFiles: files,
      identityFingerprint: await fingerprintRelativeFiles(root, files),
    })
  }
  return output
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
      productSkills: await productSkills(mathPluginRoot, mathIntegration.pluginIdentityRelativeFiles),
      command: containedComponentPath(math.root, math.descriptor.entrypoints.command, 'Math Anchor command'),
      args: mathIntegration.args ?? ['mcp'],
      cwd: mathPluginRoot,
    }),
    'migratory-time': await component(time, {
      pluginRoot: timePluginRoot,
      marketplaceRoot: directoryPath(time.root, timeIntegration.marketplaceRoot, 'Migratory Time marketplace root'),
      marketplace: timeIntegration.marketplace,
      plugin: timeIntegration.plugin,
      pluginIdentityRelativeFiles: timeIntegration.pluginIdentityRelativeFiles,
      pluginIdentityFingerprint: await fingerprintRelativeFiles(timePluginRoot, timeIntegration.pluginIdentityRelativeFiles),
      productSkills: await productSkills(timePluginRoot, timeIntegration.pluginIdentityRelativeFiles),
      command: nodeCommand,
      args: [containedComponentPath(time.root, time.descriptor.entrypoints.server, 'Migratory Time server')],
      cwd: timePluginRoot,
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
    if (!isDeveloperKitIntegrationSchema(item.descriptor.integration?.schemaVersion)) continue
    const developerKit = item.descriptor.integration
    const pluginRoot = directoryPath(item.root, developerKit.codex.pluginRoot, `${developerKit.displayName} plugin root`)
    const skillRoot = directoryPath(item.root, developerKit.skill.root, `${developerKit.displayName} Skill root`)
    const cliEntrypoint = containedComponentPath(item.root, developerKit.cli.command, `${developerKit.displayName} CLI entrypoint`)
    components[id] = await component(item, {
      displayName: developerKit.displayName,
      summary: developerKit.summary,
      command: nodeCommand,
      args: [cliEntrypoint, ...developerKit.cli.args],
      versionArguments: developerKit.cli.versionArguments,
      pluginRoot,
      marketplaceRoot: directoryPath(item.root, developerKit.codex.marketplaceRoot, `${developerKit.displayName} marketplace root`),
      marketplace: developerKit.codex.marketplace,
      plugin: developerKit.codex.plugin,
      pluginIdentityRelativeFiles: developerKit.codex.identityFiles,
      pluginIdentityFingerprint: await fingerprintRelativeFiles(pluginRoot, developerKit.codex.identityFiles),
      skillOnly: true,
      developerSkill: {
        id: developerKit.skill.id,
        root: skillRoot,
        identityRelativeFiles: developerKit.skill.identityFiles,
        identityFingerprint: await fingerprintRelativeFiles(skillRoot, developerKit.skill.identityFiles),
        launcherRelativePath: developerKit.skill.launcher,
      },
      developerKitIntegrationSchema: developerKit.schemaVersion,
    })
  }
  for (const [id, item] of installed) {
    if (!isToolIntegrationSchema(item.descriptor.integration?.schemaVersion)) continue
    const tool = item.descriptor.integration
    const pluginRoot = directoryPath(item.root, tool.codex.pluginRoot, `${tool.displayName} plugin root`)
    const runtimeEntrypoint = containedComponentPath(item.root, tool.runtime.command, `${tool.displayName} runtime command`)
    const usesSuiteNode = [TOOL_INTEGRATION_SCHEMA_V2, TOOL_INTEGRATION_SCHEMA_V3, TOOL_INTEGRATION_SCHEMA_V4, TOOL_INTEGRATION_SCHEMA_V5].includes(tool.schemaVersion) && tool.runtime.executor === 'suite-node'
    let providerSkill = null
    if (tool.schemaVersion === TOOL_INTEGRATION_SCHEMA_V3) {
      const discovery = tool.discovery
      const skillRoot = directoryPath(item.root, discovery.skill.root, `${tool.displayName} discovery Skill root`)
      const discoveryEntrypoint = containedComponentPath(item.root, discovery.runtime.command, `${tool.displayName} discovery CLI entrypoint`)
      providerSkill = {
        id: discovery.skill.id,
        root: skillRoot,
        identityRelativeFiles: discovery.skill.identityFiles,
        identityFingerprint: await fingerprintRelativeFiles(skillRoot, discovery.skill.identityFiles),
        launcherRelativePath: discovery.skill.launcher,
        command: discovery.runtime.executor === 'suite-node' ? nodeCommand : discoveryEntrypoint,
        args: discovery.runtime.executor === 'suite-node'
          ? [discoveryEntrypoint, ...discovery.runtime.args]
          : discovery.runtime.args,
        versionArguments: discovery.runtime.versionArguments,
        expectedVersion: item.descriptor.version,
      }
    }
    const auxiliaryCli = id === 'context-surface-analyzer' && components[id] !== undefined
      ? { cliCommand: components[id].command, cliArgs: components[id].args }
      : {}
    const capabilityProvider = tool.schemaVersion === TOOL_INTEGRATION_SCHEMA_V4
      ? {
          providerId: tool.directCapability.providerId,
          transport: tool.directCapability.transport,
          lifecycle: tool.directCapability.lifecycle,
          workspaceRootRequired: tool.directCapability.workspaceRoot === 'host-required',
          rootPath: pluginRoot,
          profilePath: containedComponentPath(item.root, tool.directCapability.profile, `${tool.displayName} Capability Profile`),
          manifestPath: containedComponentPath(item.root, tool.directCapability.manifest, `${tool.displayName} Provider Manifest`),
          identityFiles: tool.directCapability.identityFiles.map((path) => containedComponentPath(item.root, path, `${tool.displayName} Capability identity file`)),
          capabilityId: tool.directCapability.capabilityId,
          capabilityVersion: tool.directCapability.capabilityVersion,
          contracts: tool.directCapability.contracts.map((contract) => ({
            operationId: contract.operationId,
            inputSchemaPath: containedComponentPath(item.root, contract.inputSchema, `${tool.displayName} Capability input schema`),
            outputSchemaPath: containedComponentPath(item.root, contract.outputSchema, `${tool.displayName} Capability output schema`),
          })),
        }
      : null
    components[id] = await component(item, {
      displayName: tool.displayName,
      summary: tool.summary,
      pluginRoot,
      marketplaceRoot: directoryPath(item.root, tool.codex.marketplaceRoot, `${tool.displayName} marketplace root`),
      marketplace: tool.codex.marketplace,
      plugin: tool.codex.plugin,
      pluginIdentityRelativeFiles: tool.codex.identityFiles,
      pluginIdentityFingerprint: await fingerprintRelativeFiles(pluginRoot, tool.codex.identityFiles),
      productSkills: await productSkills(pluginRoot, tool.codex.identityFiles),
      command: usesSuiteNode ? nodeCommand : runtimeEntrypoint,
      args: usesSuiteNode ? [runtimeEntrypoint, ...tool.runtime.args] : tool.runtime.args,
      cwd: directoryPath(item.root, tool.runtime.cwd, `${tool.displayName} runtime directory`),
      workspaceEnvironment: tool.runtime.workspaceEnvironment ?? [],
      optionalPathEnvironment: tool.runtime.optionalPathEnvironment ?? [],
      pathGrants: {},
      expectedTools: tool.runtime.expectedTools,
      healthTimeoutMs: tool.runtime.timeoutMs,
      toolIntegrationSchema: tool.schemaVersion,
      ...(providerSkill === null ? {} : { providerSkill }),
      ...(capabilityProvider === null ? {} : { capabilityProvider }),
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
  const createdComponentIds = []
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
      if (result.created) {
        createdRoots.push(result.root)
        createdComponentIds.push(id)
      }
      installed.set(id, result)
    }
    return {
      manifest: await buildRuntimeManifest(manifest, installed),
      release: structuredClone(manifest),
      manifestPath,
      createdRoots,
      createdComponentIds,
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
