import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { buildProvenance, inspectBuildSources, materializeGitSourceSnapshots } from './release-source-provenance.mjs'
import {
  ARMORIAL_COMPATIBILITY_VERSION,
  buildArmorialPluginFromVerifiedSource,
  buildFileVitalsPluginFromSource,
  extractVerifiedProviderPluginArchive,
  fileVitalsSourceBuildRequired,
  FILE_VITALS_COMPATIBILITY_VERSION,
} from './provider-source-build.mjs'

const suiteRoot = fileURLToPath(new URL('../', import.meta.url))
const workspaceRoot = dirname(suiteRoot)
const suiteBuildRoot = join(suiteRoot, '.build')
const outputRoot = process.env.AGENT_HOST_OUTPUT_ROOT === undefined
  ? join(suiteRoot, '.build', 'internal-beta', 'release-catalog')
  : containedBuildOutput(process.env.AGENT_HOST_OUTPUT_ROOT)
const outputStaging = `${outputRoot}.staging-${process.pid}`
const artifactRoot = join(outputStaging, 'artifacts')
const componentSchema = 'openadam.agent-host-component.v0.1'
const releaseVersion = requiredEnvironment('AGENT_HOST_SUITE_VERSION')
const releaseId = requiredEnvironment('AGENT_HOST_RELEASE_ID')
const releaseCreatedAt = requiredEnvironment('AGENT_HOST_RELEASE_CREATED_AT')
const componentCreatedAt = process.env.AGENT_HOST_COMPONENT_CREATED_AT ?? '2000-01-01T00:00:00.000Z'
const reuseCatalogRoot = process.env.AGENT_HOST_REUSE_CATALOG_ROOT ?? null
const reuseComponentIds = new Set((process.env.AGENT_HOST_REUSE_COMPONENTS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean))
const reusedComponentIds = new Set()
const sourcePolicy = process.env.AGENT_HOST_SOURCE_POLICY ?? 'local-clean'
const sourceLockPath = process.env.AGENT_HOST_RELEASE_SOURCE_LOCK
const platform = 'darwin-arm64'
const nodeVersion = '22.22.1'
const nodeArchiveName = `node-v${nodeVersion}-darwin-arm64.tar.gz`
const nodeUrl = `https://nodejs.org/dist/v${nodeVersion}/${nodeArchiveName}`
const nodeUpstreamSha256 = 'sha256:679ad4966339e4ef4900f57996714864e4211b898825bb840c3086c419fbcef2'
const sourceRoots = {
  runtime: join(suiteRoot, 'packages', 'direct-execution-runtime'),
  math: process.env.AGENT_HOST_MATH_ANCHOR_SOURCE_ROOT ?? join(workspaceRoot, 'calculator'),
  time: process.env.AGENT_HOST_MIGRATORY_TIME_SOURCE_ROOT ?? join(workspaceRoot, 'migratory-time'),
  capability: process.env.AGENT_HOST_CAPABILITY_CONTRACTS_SOURCE_ROOT ?? join(workspaceRoot, 'capability-contracts'),
  observer: join(suiteRoot, 'packages', 'agent-tool-observer'),
  analyzer: join(suiteRoot, 'packages', 'context-surface-analyzer'),
  dataTransformer: process.env.AGENT_HOST_DATA_TRANSFORMER_SOURCE_ROOT ?? join(workspaceRoot, 'data-transformer'),
  armorial: process.env.AGENT_HOST_ARMORIAL_SOURCE_ROOT ?? join(workspaceRoot, 'icon-svg-select'),
  laniakea: process.env.AGENT_HOST_LANIAKEA_SOURCE_ROOT ?? join(workspaceRoot, 'laniakea'),
  projective: process.env.AGENT_HOST_PROJECTIVE_SOURCE_ROOT ?? join(workspaceRoot, 'perspective-tool'),
  equatorium: process.env.AGENT_HOST_EQUATORIUM_SOURCE_ROOT ?? join(workspaceRoot, 'standard-expression-interpreter'),
  fileVitals: process.env.AGENT_HOST_FILE_VITALS_SOURCE_ROOT ?? join(workspaceRoot, 'universal-inspector'),
  developerKit: process.env.AGENT_HOST_DEVELOPER_KIT_SOURCE_ROOT ?? join(workspaceRoot, 'agent-tool-development-kit'),
}
const componentSourceIds = Object.freeze({
  'direct-execution-runtime': ['suite'],
  'math-anchor': ['math-anchor'],
  'migratory-time': ['migratory-time', 'capability-contracts'],
  'agent-tool-observer': ['suite'],
  'context-surface-analyzer': ['suite'],
  'agent-tool-development-kit': ['agent-tool-development-kit'],
  'data-transformer': ['data-transformer', 'capability-contracts'],
  armorial: ['armorial'],
  laniakea: ['laniakea'],
  projective: ['projective'],
  equatorium: ['equatorium'],
  'file-vitals': ['file-vitals', 'capability-contracts'],
})
const logicalSourceRoots = Object.freeze({
  suite: suiteRoot,
  'math-anchor': sourceRoots.math,
  'migratory-time': sourceRoots.time,
  'capability-contracts': sourceRoots.capability,
  'agent-tool-development-kit': sourceRoots.developerKit,
  'data-transformer': sourceRoots.dataTransformer,
  armorial: sourceRoots.armorial,
  laniakea: sourceRoots.laniakea,
  projective: sourceRoots.projective,
  equatorium: sourceRoots.equatorium,
  'file-vitals': sourceRoots.fileVitals,
})
let sourceObservations = null

function useMaterializedSourceRoots(roots) {
  sourceRoots.runtime = join(roots.suite, 'packages', 'direct-execution-runtime')
  sourceRoots.observer = join(roots.suite, 'packages', 'agent-tool-observer')
  sourceRoots.analyzer = join(roots.suite, 'packages', 'context-surface-analyzer')
  sourceRoots.math = roots['math-anchor']
  sourceRoots.time = roots['migratory-time']
  sourceRoots.capability = roots['capability-contracts']
  sourceRoots.developerKit = roots['agent-tool-development-kit']
  sourceRoots.dataTransformer = roots['data-transformer']
  sourceRoots.armorial = roots.armorial
  sourceRoots.laniakea = roots.laniakea
  sourceRoots.projective = roots.projective
  sourceRoots.equatorium = roots.equatorium
  sourceRoots.fileVitals = roots['file-vitals']
}

async function providerReleaseInput(sourceId, environmentName, fallbackRelativePath, materializedRoots) {
  const originalRoot = await realpath(logicalSourceRoots[sourceId])
  const requested = process.env[environmentName] ?? join(originalRoot, fallbackRelativePath)
  if (materializedRoots === null) return requested
  const requestedReal = await realpath(requested)
  const relation = relative(originalRoot, requestedReal)
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`${environmentName} must remain inside the locked ${sourceId} repository for a remote-tagged build`)
  }
  return join(materializedRoots[sourceId], relation)
}

async function providerReleaseInputWhenBuilt(componentId, sourceId, environmentName, fallbackRelativePath, materializedRoots) {
  return reuseComponentIds.has(componentId)
    ? null
    : providerReleaseInput(sourceId, environmentName, fallbackRelativePath, materializedRoots)
}

function containedBuildOutput(value) {
  const output = resolve(value)
  const relation = relative(suiteBuildRoot, output)
  if (relation === '' || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error('AGENT_HOST_OUTPUT_ROOT must be one contained directory beneath the suite .build directory')
  }
  return output
}

function requiredEnvironment(name) {
  const value = process.env[name]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} is required for an immutable release build`)
  }
  return value.trim()
}

function command(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (value) => stdout.push(value))
    child.stderr.on('data', (value) => stderr.push(value))
    child.once('error', reject)
    child.once('exit', (status) => {
      if (status === 0) resolve(Buffer.concat(stdout).toString('utf8'))
      else reject(new Error(`${file} ${args.join(' ')} failed (${status}): ${Buffer.concat(stderr).toString('utf8').trim()}`))
    })
  })
}

async function sha256(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return `sha256:${hash.digest('hex')}`
}

let priorRelease = null

async function reuseComponent(id) {
  if (reuseCatalogRoot === null) throw new Error(`AGENT_HOST_REUSE_CATALOG_ROOT is required to reuse ${id}`)
  if (priorRelease === null) {
    priorRelease = JSON.parse(await readFile(join(reuseCatalogRoot, 'current.json'), 'utf8'))
  }
  const component = priorRelease.components?.find((item) => item.id === id)
  if (component === undefined) throw new Error(`prior release does not contain reusable component ${id}`)
  const artifactUrl = component.artifact?.url
  if (typeof artifactUrl !== 'string' || artifactUrl !== `artifacts/${basename(artifactUrl)}`) {
    throw new Error(`reusable component ${id} has an unsafe artifact URL`)
  }
  const source = join(reuseCatalogRoot, artifactUrl)
  const info = await lstat(source)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`reusable component ${id} artifact is not a regular file`)
  if (info.size !== component.artifact.bytes) throw new Error(`reusable component ${id} artifact size drifted`)
  if (await sha256(source) !== component.artifact.sha256) throw new Error(`reusable component ${id} artifact digest drifted`)
  await copyPath(source, join(outputStaging, artifactUrl))
  reusedComponentIds.add(id)
  return component
}

async function buildOrReuse(id, builder) {
  if (reuseComponentIds.has(id)) return reuseComponent(id)
  return builder()
}

async function writeText(path, text, mode = 0o644) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, { mode })
  await chmod(path, mode)
}

async function writeJson(path, value) {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function copyPath(source, destination) {
  await access(source)
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true, preserveTimestamps: false, verbatimSymlinks: false })
}

async function removeLinks(root) {
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      const info = await lstat(path)
      if (info.isSymbolicLink()) await rm(path, { force: true })
      else if (info.isDirectory()) await walk(path)
    }
  }
  await walk(root)
}

function sourceState(sourceId) {
  const source = sourceObservations?.[sourceId]
  if (source === undefined) throw new Error(`source provenance was not inspected for ${sourceId}`)
  return source
}

async function dependencyPackages(root) {
  const output = []
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.bin') continue
      const path = join(current, entry.name)
      if (entry.name.startsWith('@')) {
        await walk(path)
        continue
      }
      const packagePath = join(path, 'package.json')
      try {
        const pkg = JSON.parse(await readFile(packagePath, 'utf8'))
        output.push({ name: pkg.name ?? entry.name, version: pkg.version ?? 'unknown', license: pkg.license ?? 'NOASSERTION', path })
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      const nested = join(path, 'node_modules')
      try {
        await walk(nested)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
  }
  await walk(join(root, 'node_modules'))
  return output.sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`))
}

async function legalNotices(root, title) {
  const packages = await dependencyPackages(root)
  const sections = [`# Third-Party Notices\n\n${title} includes the following production dependency packages.\n`]
  for (const pkg of packages) {
    const candidates = (await readdir(pkg.path)).filter((name) => /^(?:licen[cs]e|copying|notice)(?:\..*)?$/iu.test(name)).sort()
    const texts = []
    for (const name of candidates) {
      const path = join(pkg.path, name)
      if ((await stat(path)).isFile()) texts.push(`\n--- ${name} ---\n${(await readFile(path, 'utf8')).trim()}\n`)
    }
    sections.push(`\n## ${pkg.name}@${pkg.version}\n\nDeclared license: ${pkg.license}\n${texts.join('')}`)
  }
  return { packages, text: `${sections.join('\n').trim()}\n` }
}

function sbom(name, version, license, source, packages = [], upstream = null) {
  const sourceIdentity = source?.revision ?? upstream?.sha256?.slice(7) ?? 'unversioned'
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `${name}-${version}-${platform}`,
    documentNamespace: `https://openadam.dev/spdx/components/${encodeURIComponent(name)}/${encodeURIComponent(version)}/${platform}/${sourceIdentity}${source?.dirty === true ? '-dirty' : ''}`,
    creationInfo: { created: componentCreatedAt, creators: ['Tool: Agent Host internal Beta builder'] },
    packages: [
      { SPDXID: 'SPDXRef-RootPackage', name, versionInfo: version, downloadLocation: upstream?.url ?? 'NOASSERTION', licenseConcluded: license, licenseDeclared: license, filesAnalyzed: false, ...(upstream === null ? {} : { checksums: [{ algorithm: 'SHA256', checksumValue: upstream.sha256.slice(7) }] }) },
      ...packages.map((item, index) => ({ SPDXID: `SPDXRef-Dependency-${index + 1}`, name: item.name, versionInfo: item.version, downloadLocation: 'NOASSERTION', licenseConcluded: item.license, licenseDeclared: item.license, filesAnalyzed: false })),
    ],
    annotations: [{ annotationDate: componentCreatedAt, annotationType: 'OTHER', annotator: 'Tool: Agent Host internal Beta builder', comment: `sourceRevision=${source?.revision ?? 'upstream'}; sourceDirty=${source?.dirty ?? false}; sourcePolicy=${source?.sourcePolicy ?? 'upstream'}; sourceRef=${source?.ref ?? 'none'}` }],
  }
}

async function inventory(root) {
  const files = []
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      const info = await lstat(path)
      if (info.isSymbolicLink()) throw new Error(`component staging contains a link: ${relative(root, path)}`)
      if (info.isDirectory()) await walk(path)
      else if (info.isFile() && relative(root, path) !== 'component.json') {
        files.push({ path: relative(root, path), sha256: await sha256(path), bytes: info.size, executable: (info.mode & 0o111) !== 0 })
      } else if (!info.isFile()) throw new Error(`component staging contains a special file: ${relative(root, path)}`)
    }
  }
  await walk(root)
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

async function finalizeComponent({ root, id, version, kind, identityFiles, entrypoints, integration, license = 'Apache-2.0' }) {
  const files = await inventory(root)
  const paths = new Set(files.map((item) => item.path))
  for (const path of identityFiles) if (!paths.has(path)) throw new Error(`${id} identity file is absent: ${path}`)
  const descriptor = {
    schemaVersion: componentSchema,
    id,
    version,
    kind,
    files,
    identityFiles,
    entrypoints,
    integration,
    legal: { license: 'LICENSE', notice: 'NOTICE', thirdPartyNotices: 'THIRD_PARTY_NOTICES.txt', sbom: 'sbom.spdx.json' },
  }
  const descriptorPath = join(root, 'component.json')
  await writeJson(descriptorPath, descriptor)
  const descriptorSha256 = await sha256(descriptorPath)
  const archiveFile = `${id}-${version}-${platform}.tar.gz`
  const archivePath = join(artifactRoot, archiveFile)
  const archiveFiles = [...files.map((item) => item.path), 'component.json'].sort()
  if (archiveFiles.some((path) => path.includes('\n') || path.startsWith('-'))) throw new Error(`${id} contains an unsafe archive path`)
  const fixedTime = new Date(componentCreatedAt)
  for (const path of archiveFiles) await utimes(join(root, path), fixedTime, fixedTime)
  const listPath = `${archivePath}.files`
  const uncompressedPath = `${archivePath}.tmp`
  await writeFile(listPath, `${archiveFiles.map((path) => `./${path}`).join('\n')}\n`, { mode: 0o600 })
  await command('/usr/bin/tar', [
    '-cf', uncompressedPath, '--format=ustar', '--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'wheel',
    '-C', root, '-T', listPath,
  ], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  await command('/usr/bin/gzip', ['-n', '-f', uncompressedPath])
  await rename(`${uncompressedPath}.gz`, archivePath)
  await rm(listPath, { force: true })
  const archiveInfo = await stat(archivePath)
  return {
    id,
    version,
    platform,
    artifact: { url: `artifacts/${archiveFile}`, sha256: await sha256(archivePath), bytes: archiveInfo.size, format: 'tar.gz' },
    descriptorSha256,
    license: { spdx: license, files: ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt'] },
  }
}

async function downloadNode(cacheRoot) {
  const destination = join(cacheRoot, nodeArchiveName)
  try {
    if (await sha256(destination) === nodeUpstreamSha256) return destination
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await rm(destination, { force: true })
  await command('/usr/bin/curl', ['--fail', '--silent', '--show-error', '--location', '--output', destination, nodeUrl])
  if (await sha256(destination) !== nodeUpstreamSha256) throw new Error('official Node archive checksum mismatch')
  return destination
}

async function buildNode(workRoot, cacheRoot) {
  const upstream = await downloadNode(cacheRoot)
  const extracted = join(workRoot, 'node-upstream')
  const root = join(workRoot, 'node-runtime')
  await mkdir(extracted, { recursive: true })
  await mkdir(join(root, 'bin'), { recursive: true })
  await command('/usr/bin/tar', ['-xzf', upstream, '-C', extracted, `${nodeArchiveName.slice(0, -7)}/bin/node`, `${nodeArchiveName.slice(0, -7)}/LICENSE`])
  const upstreamRoot = join(extracted, nodeArchiveName.slice(0, -7))
  await copyPath(join(upstreamRoot, 'bin/node'), join(root, 'bin/node'))
  await chmod(join(root, 'bin/node'), 0o755)
  await copyPath(join(upstreamRoot, 'LICENSE'), join(root, 'LICENSE'))
  await writeText(join(root, 'NOTICE'), `Node.js ${nodeVersion} official macOS arm64 binary subset.\nUpstream: ${nodeUrl}\nUpstream SHA-256: ${nodeUpstreamSha256}\n`)
  await copyPath(join(upstreamRoot, 'LICENSE'), join(root, 'THIRD_PARTY_NOTICES.txt'))
  await writeJson(join(root, 'sbom.spdx.json'), sbom('node-runtime', nodeVersion, 'MIT', null, [], { url: nodeUrl, sha256: nodeUpstreamSha256 }))
  return await finalizeComponent({ root, id: 'node-runtime', version: nodeVersion, kind: 'node-runtime', identityFiles: ['bin/node', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt', 'sbom.spdx.json'], entrypoints: { node: 'bin/node' }, integration: null, license: 'MIT' })
}

async function installProductionDependencies(root) {
  await command('/usr/bin/env', ['npm', 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, env: { ...process.env, npm_config_update_notifier: 'false' } })
  await removeLinks(join(root, 'node_modules'))
}

async function buildDirectRuntime(workRoot) {
  const root = join(workRoot, 'direct-execution-runtime')
  for (const path of ['package.json', 'package-lock.json', 'src', 'schemas', 'LICENSE', 'NOTICE']) await copyPath(join(sourceRoots.runtime, path), join(root, path))
  await installProductionDependencies(root)
  const notices = await legalNotices(root, 'Direct Execution Runtime')
  await writeText(join(root, 'THIRD_PARTY_NOTICES.txt'), notices.text)
  const source = sourceState('suite')
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  await writeJson(join(root, 'sbom.spdx.json'), sbom('direct-execution-runtime', pkg.version, 'Apache-2.0', source, notices.packages))
  const identityFiles = ['package.json', 'package-lock.json', 'src/cli.mjs', 'src/runtime.mjs', 'src/host-service.mjs', 'src/config.mjs', 'schemas/provider-config.schema.json', 'schemas/provider-config.schema.v0.2.json', 'schemas/host-service-observation.schema.json', 'schemas/host-service-observation.schema.v0.1.json', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt', 'sbom.spdx.json']
  return await finalizeComponent({ root, id: 'direct-execution-runtime', version: pkg.version, kind: 'direct-runtime', identityFiles, entrypoints: { cli: 'src/cli.mjs' }, integration: null })
}

async function buildDeveloperKit() {
  const pkg = JSON.parse(await readFile(join(sourceRoots.developerKit, 'package.json'), 'utf8'))
  const archiveFile = `agent-tool-development-kit-${pkg.version}-${platform}.tar.gz`
  const archivePath = join(artifactRoot, archiveFile)
  const output = await command(process.execPath, [
    join(sourceRoots.developerKit, 'scripts', 'build-developer-component.mjs'),
    '--output', archivePath,
  ], { cwd: sourceRoots.developerKit })
  let result
  try {
    result = JSON.parse(output)
  } catch (error) {
    throw new Error(`Developer Kit builder returned invalid JSON: ${error.message}`)
  }
  const info = await stat(archivePath)
  if (result.component?.id !== 'agent-tool-development-kit' || result.component.version !== pkg.version
    || result.component.kind !== 'developer-kit' || result.artifact?.bytes !== info.size
    || result.artifact?.sha256 !== await sha256(archivePath)) {
    throw new Error('Developer Kit builder output does not match its staged component artifact')
  }
  return {
    id: result.component.id,
    version: result.component.version,
    platform,
    artifact: { url: `artifacts/${archiveFile}`, sha256: result.artifact.sha256, bytes: result.artifact.bytes, format: 'tar.gz' },
    descriptorSha256: result.descriptorSha256,
    license: result.license,
  }
}

async function buildLocalNodeUtility(workRoot, {
  id,
  kind,
  title,
  sourceRoot,
  sourceId,
  entrypoint,
  additionalPaths = [],
  additionalIdentityFiles = [],
}) {
  const root = join(workRoot, id)
  for (const path of ['package.json', 'package-lock.json', 'src', ...additionalPaths, 'LICENSE', 'NOTICE']) {
    await copyPath(join(sourceRoot, path), join(root, path))
  }
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const dependencies = Object.keys(pkg.dependencies ?? {})
  let notices
  if (dependencies.length > 0) {
    await installProductionDependencies(root)
    notices = await legalNotices(root, title)
  } else {
    notices = { packages: [], text: `# Third-Party Notices\n\n${title} has no bundled third-party package dependencies.\n` }
  }
  await writeText(join(root, 'THIRD_PARTY_NOTICES.txt'), notices.text)
  const source = sourceState(sourceId)
  await writeJson(join(root, 'sbom.spdx.json'), sbom(id, pkg.version, 'Apache-2.0', source, notices.packages))
  return await finalizeComponent({
    root,
    id,
    version: pkg.version,
    kind,
    identityFiles: [
      'package.json',
      'package-lock.json',
      entrypoint,
      ...additionalIdentityFiles,
      'LICENSE',
      'NOTICE',
      'THIRD_PARTY_NOTICES.txt',
      'sbom.spdx.json',
    ],
    entrypoints: { cli: entrypoint },
    integration: null,
  })
}

async function existingFile(candidates) {
  for (const path of candidates) {
    try {
      if ((await stat(path)).isFile()) return path
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return null
}

async function collectSkillFiles(pluginRoot) {
  const output = []
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name === 'SKILL.md') output.push(relative(pluginRoot, path))
    }
  }
  const skills = join(pluginRoot, 'skills')
  try {
    await walk(skills)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return output.sort()
}

function containedPluginPath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')) throw new Error(`${label} is invalid`)
  const path = normalize(value.replace(/^\.\//u, ''))
  if (isAbsolute(path) || path === '.' || path === '..' || path.startsWith(`..${sep}`)) throw new Error(`${label} must be a contained plugin path`)
  return path
}

async function buildAgentTool(workRoot, spec) {
  const root = join(workRoot, spec.id)
  const marketplaceRoot = 'marketplace'
  const pluginRootRelative = `${marketplaceRoot}/plugins/${spec.plugin}`
  const pluginRoot = join(root, pluginRootRelative)
  let pluginSource = spec.pluginRoot
  if (spec.pluginArchive !== undefined) {
    const archiveWork = join(workRoot, `${spec.id}-provider-release`)
    const extracted = await extractVerifiedProviderPluginArchive({
      sourceArchive: spec.pluginArchive,
      archiveWork,
      expectedRoot: spec.pluginArchiveRoot,
      expectedSha256: spec.pluginArchiveSha256,
      label: `${spec.id} Provider`,
      targetFilesystem: 'macos-default',
    })
    pluginSource = extracted.extractedRoot
  }
  await copyPath(pluginSource, pluginRoot)
  for (const path of spec.additionalPaths ?? []) await copyPath(join(spec.repositoryRoot, path), join(root, path))

  const pluginPath = join(pluginRoot, '.codex-plugin/plugin.json')
  const mcpPath = join(pluginRoot, '.mcp.json')
  const plugin = JSON.parse(await readFile(pluginPath, 'utf8'))
  const mcp = JSON.parse(await readFile(mcpPath, 'utf8'))
  if (spec.expectedVersion !== undefined && plugin.version !== spec.expectedVersion) {
    throw new Error(`${spec.id} plugin version differs from the required compatibility version`)
  }
  const serverEntries = Object.entries(mcp.mcpServers ?? {})
  if (serverEntries.length !== 1) throw new Error(`${spec.id} must declare exactly one MCP server`)
  const [serverName, server] = serverEntries[0]
  let runtimeCommandRelative
  let runtimeArgs
  let runtimeExecutor
  if (server.command === 'node') {
    const [script, ...args] = server.args ?? []
    const relativeScript = containedPluginPath(script, `${spec.id} MCP script`)
    const scriptPath = join(pluginRoot, relativeScript)
    if (await existingFile([scriptPath]) === null) throw new Error(`${spec.id} MCP script is absent: ${relativeScript}`)
    runtimeCommandRelative = `${pluginRootRelative}/${relativeScript}`
    runtimeArgs = args
    runtimeExecutor = 'suite-node'
  } else {
    const relativeCommand = containedPluginPath(server.command, `${spec.id} MCP command`)
    runtimeCommandRelative = `${pluginRootRelative}/${relativeCommand}`
    runtimeArgs = server.args ?? []
    runtimeExecutor = 'component'
  }

  await writeJson(join(root, marketplaceRoot, '.agents/plugins/marketplace.json'), {
    name: spec.marketplace,
    interface: { displayName: spec.displayName },
    plugins: [{
      name: spec.plugin,
      source: { source: 'local', path: `./plugins/${spec.plugin}` },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Productivity',
    }],
  })

  const legalRoot = spec.legalRoot ?? pluginSource
  const licensePath = await existingFile([join(legalRoot, 'LICENSE'), join(spec.repositoryRoot, 'LICENSE')])
  const noticePath = await existingFile([join(legalRoot, 'NOTICE'), join(spec.repositoryRoot, 'NOTICE')])
  const thirdPartyPath = await existingFile([
    join(legalRoot, 'THIRD_PARTY_NOTICES.txt'), join(legalRoot, 'THIRD_PARTY_NOTICES.md'),
    join(legalRoot, 'legal/THIRD_PARTY_NOTICES.txt'), join(legalRoot, 'legal/THIRD_PARTY_NOTICES.md'),
    join(spec.repositoryRoot, 'THIRD_PARTY_NOTICES.txt'), join(spec.repositoryRoot, 'THIRD_PARTY_NOTICES.md'),
  ])
  if (licensePath === null || noticePath === null) throw new Error(`${spec.id} legal files are incomplete`)
  await copyPath(licensePath, join(root, 'LICENSE'))
  await copyPath(noticePath, join(root, 'NOTICE'))
  if (thirdPartyPath === null) await writeText(join(root, 'THIRD_PARTY_NOTICES.txt'), `# Third-Party Notices\n\n${spec.displayName} declares no separately bundled third-party package notices in this integration artifact.\n`)
  else await copyPath(thirdPartyPath, join(root, 'THIRD_PARTY_NOTICES.txt'))
  const source = sourceState(spec.sourceId)
  await writeJson(join(root, 'sbom.spdx.json'), sbom(spec.id, plugin.version, plugin.license ?? 'Apache-2.0', source, []))

  const providerSbom = await existingFile([
    join(legalRoot, 'SBOM.spdx.json'), join(legalRoot, 'sbom.spdx.json'),
    join(legalRoot, 'legal/sbom.cdx.json'), join(legalRoot, 'sbom/projective-macos-arm64.spdx.json'),
  ])
  const providerSbomRelative = providerSbom === null ? null : `provider-sbom/${basename(providerSbom)}`
  if (providerSbom !== null) await copyPath(providerSbom, join(root, providerSbomRelative))

  const skillFiles = await collectSkillFiles(pluginRoot)
  const runtimeCommandWithinPlugin = relative(pluginRoot, join(root, runtimeCommandRelative))
  const pluginIdentityRelativeFiles = [
    '.codex-plugin/plugin.json', '.mcp.json',
    ...(await existingFile([join(pluginRoot, 'package.json')]) === null ? [] : ['package.json']),
    runtimeCommandWithinPlugin,
    ...skillFiles,
  ]
  const identityFiles = [
    `${marketplaceRoot}/.agents/plugins/marketplace.json`,
    ...pluginIdentityRelativeFiles.map((path) => `${pluginRootRelative}/${path}`),
    'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt', 'sbom.spdx.json',
    ...(providerSbomRelative === null ? [] : [providerSbomRelative]),
    ...(spec.identityFiles ?? []),
  ]
  let discovery = null
  if (spec.discovery !== undefined) {
    const skillId = spec.discovery.skillId
    if (typeof skillId !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(skillId)) throw new Error(`${spec.id} discovery Skill id is invalid`)
    const skillRoot = `${pluginRootRelative}/skills/${skillId}`
    const skillIdentityFiles = spec.discovery.identityFiles ?? ['SKILL.md']
    for (const path of skillIdentityFiles) {
      if (await existingFile([join(root, skillRoot, containedPluginPath(path, `${spec.id} discovery Skill identity file`))]) === null) {
        throw new Error(`${spec.id} discovery Skill identity file is absent: ${path}`)
      }
    }
    const discoveryCommandWithinPlugin = containedPluginPath(spec.discovery.command, `${spec.id} discovery CLI command`)
    const discoveryCommand = `${pluginRootRelative}/${discoveryCommandWithinPlugin}`
    if (await existingFile([join(root, discoveryCommand)]) === null) throw new Error(`${spec.id} discovery CLI is absent: ${discoveryCommandWithinPlugin}`)
    discovery = {
      kind: 'skill-cli',
      skill: {
        id: skillId,
        root: skillRoot,
        identityFiles: skillIdentityFiles,
        launcher: containedPluginPath(spec.discovery.launcher, `${spec.id} discovery launcher`),
      },
      runtime: {
        executor: spec.discovery.executor ?? 'suite-node',
        command: discoveryCommand,
        args: spec.discovery.args ?? [],
        versionArguments: spec.discovery.versionArguments ?? ['--version'],
      },
    }
  }
  let directCapability = null
  let directCapabilityComponentIdentityFiles = []
  if (spec.directCapability !== undefined) {
    const capabilityRoot = 'capability-contracts'
    const profileRelative = `${capabilityRoot}/${basename(spec.directCapability.profileSource)}`
    await copyPath(spec.directCapability.profileSource, join(root, profileRelative))
    const contracts = []
    for (const contract of spec.directCapability.contracts) {
      const profileInputSchema = `${capabilityRoot}/schemas/${basename(contract.inputSchemaSource)}`
      const profileOutputSchema = `${capabilityRoot}/schemas/${basename(contract.outputSchemaSource)}`
      await copyPath(contract.inputSchemaSource, join(root, profileInputSchema))
      await copyPath(contract.outputSchemaSource, join(root, profileOutputSchema))
      const inputSchema = `${pluginRootRelative}/${containedPluginPath(contract.providerInputSchema, `${spec.id} Direct Capability input schema`)}`
      const outputSchema = `${pluginRootRelative}/${containedPluginPath(contract.providerOutputSchema, `${spec.id} Direct Capability output schema`)}`
      if (await existingFile([join(root, inputSchema)]) === null || await existingFile([join(root, outputSchema)]) === null) {
        throw new Error(`${spec.id} Direct Capability contract schemas are absent`)
      }
      contracts.push({ operationId: contract.operationId, inputSchema, outputSchema, profileInputSchema, profileOutputSchema })
    }
    const manifestWithinPlugin = containedPluginPath(spec.directCapability.manifest, `${spec.id} Direct Capability manifest`)
    const manifest = `${pluginRootRelative}/${manifestWithinPlugin}`
    if (await existingFile([join(root, manifest)]) === null) throw new Error(`${spec.id} Direct Capability manifest is absent`)
    const adapterWithinPlugin = containedPluginPath(spec.directCapability.adapterCommand, `${spec.id} Direct Capability adapter`)
    const adapterCommand = `${pluginRootRelative}/${adapterWithinPlugin}`
    if (await existingFile([join(root, adapterCommand)]) === null) throw new Error(`${spec.id} Direct Capability adapter is absent`)
    const providerManifest = JSON.parse(await readFile(join(root, manifest), 'utf8'))
    const implementations = Array.isArray(providerManifest.implementations)
      ? providerManifest.implementations.filter((implementation) => (
        implementation?.capabilityId === spec.directCapability.capabilityId
        && implementation?.capabilityVersion === spec.directCapability.capabilityVersion
      ))
      : []
    const implementation = implementations.length === 1 ? implementations[0] : null
    const expectedAdapterArgs = spec.directCapability.args ?? []
    if (
      providerManifest.provider?.id !== spec.directCapability.providerId
      || providerManifest.provider?.version !== plugin.version
      || implementation?.adapter?.protocol !== 'openadam.capability-jsonl.v0.1'
      || containedPluginPath(implementation.adapter.command, `${spec.id} Provider Manifest adapter`) !== adapterWithinPlugin
      || JSON.stringify(implementation.adapter.args ?? []) !== JSON.stringify(expectedAdapterArgs)
      || (implementation.adapter.cwd ?? '.') !== '.'
    ) {
      throw new Error(`${spec.id} Direct Capability Provider Manifest differs from the Host integration`)
    }
    const capabilityIdentityFiles = [adapterCommand, runtimeCommandRelative]
    directCapability = {
      providerId: spec.directCapability.providerId,
      transport: 'capability-jsonl-v0.1',
      lifecycle: spec.directCapability.lifecycle ?? 'per-call',
      ...(spec.directCapability.workspaceRoot === undefined ? {} : { workspaceRoot: spec.directCapability.workspaceRoot }),
      capabilityId: spec.directCapability.capabilityId,
      capabilityVersion: spec.directCapability.capabilityVersion,
      adapter: {
        command: adapterCommand,
        args: expectedAdapterArgs,
        cwd: pluginRootRelative,
      },
      manifest,
      profile: profileRelative,
      identityFiles: [...new Set(capabilityIdentityFiles)],
      contracts: contracts.map(({ operationId, inputSchema, outputSchema }) => ({ operationId, inputSchema, outputSchema })),
    }
    directCapabilityComponentIdentityFiles = [
      manifest,
      profileRelative,
      ...contracts.flatMap((contract) => [contract.inputSchema, contract.outputSchema, contract.profileInputSchema, contract.profileOutputSchema]),
    ]
  }
  const integrationSchema = directCapability !== null
    ? 'openadam.agent-host-tool-integration.v0.4'
    : discovery === null
      ? 'openadam.agent-host-tool-integration.v0.2'
      : 'openadam.agent-host-tool-integration.v0.3'
  const componentIdentityFiles = [...new Set([
    ...identityFiles,
    ...(directCapability?.identityFiles ?? []),
    ...directCapabilityComponentIdentityFiles,
  ])]
  return await finalizeComponent({
    root,
    id: spec.id,
    version: plugin.version,
    kind: spec.kind ?? 'agent-tool',
    identityFiles: componentIdentityFiles,
    entrypoints: {
      mcp: runtimeCommandRelative,
      ...(directCapability === null ? {} : {
        capability: directCapability.adapter.command,
        capabilityManifest: directCapability.manifest,
        capabilityProfile: directCapability.profile,
      }),
      ...(spec.entrypoints ?? {}),
    },
    integration: {
      schemaVersion: integrationSchema,
      displayName: spec.displayName,
      summary: spec.summary,
      codex: {
        marketplaceRoot,
        marketplace: spec.marketplace,
        pluginRoot: pluginRootRelative,
        plugin: spec.plugin,
        identityFiles: pluginIdentityRelativeFiles,
      },
      runtime: {
        transport: 'mcp-stdio',
        executor: runtimeExecutor,
        command: runtimeCommandRelative,
        args: runtimeArgs,
        cwd: pluginRootRelative,
        workspaceEnvironment: spec.workspaceEnvironment ?? [],
        expectedTools: spec.expectedTools,
        timeoutMs: spec.timeoutMs ?? 10000,
      },
      ...(discovery === null ? {} : { discovery }),
      ...(directCapability === null ? {} : { directCapability }),
      ownership: { uninstall: 'agent-host-created-only' },
    },
  })
}

async function buildMathAnchor(workRoot) {
  const root = join(workRoot, 'math-anchor')
  await copyPath(join(sourceRoots.math, '.agents/plugins/marketplace.json'), join(root, '.agents/plugins/marketplace.json'))
  const marketplacePath = join(root, '.agents/plugins/marketplace.json')
  const marketplace = JSON.parse(await readFile(marketplacePath, 'utf8'))
  marketplace.name = 'math-anchor-agent-host'
  await writeJson(marketplacePath, marketplace)
  await copyPath(join(sourceRoots.math, 'plugins/math-anchor'), join(root, 'plugins/math-anchor'))
  await copyPath(join(sourceRoots.math, 'LICENSE'), join(root, 'LICENSE'))
  await copyPath(join(sourceRoots.math, 'NOTICE'), join(root, 'NOTICE'))
  await copyPath(join(sourceRoots.math, 'plugins/math-anchor/runtime/math-anchor-runtime/THIRD_PARTY_NOTICES.txt'), join(root, 'THIRD_PARTY_NOTICES.txt'))
  await copyPath(join(sourceRoots.math, 'plugins/math-anchor/runtime/math-anchor-runtime/sbom.spdx.json'), join(root, 'sbom.spdx.json'))
  const plugin = JSON.parse(await readFile(join(root, 'plugins/math-anchor/.codex-plugin/plugin.json'), 'utf8'))
  const pluginIdentityRelativeFiles = ['.codex-plugin/plugin.json', '.mcp.json', 'runtime/math-anchor-runtime/math-anchor-runtime', 'runtime/math-anchor-runtime/.math-anchor-build-manifest.json', 'skills/calculate/SKILL.md']
  const identityFiles = ['.agents/plugins/marketplace.json', ...pluginIdentityRelativeFiles.map((path) => `plugins/math-anchor/${path}`), 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt', 'sbom.spdx.json']
  return await finalizeComponent({
    root,
    id: 'math-anchor',
    version: plugin.version,
    kind: 'math-anchor',
    identityFiles,
    entrypoints: { command: 'plugins/math-anchor/runtime/math-anchor-runtime/math-anchor-runtime' },
    integration: { pluginRoot: 'plugins/math-anchor', marketplaceRoot: '.', marketplace: marketplace.name, plugin: plugin.name, pluginIdentityRelativeFiles, args: ['mcp'] },
  })
}

async function buildMigratoryTime(workRoot, nodeComponent) {
  const root = join(workRoot, 'migratory-time')
  for (const path of ['package.json', 'package-lock.json', 'plugins/migratory-time', 'capabilities/provider.json', 'capabilities/schemas', 'scripts/runCapabilityAdapter.mjs', 'scripts/capabilityProviderLib.mjs', 'LICENSE', 'NOTICE']) await copyPath(join(sourceRoots.time, path), join(root, path))
  await copyPath(join(sourceRoots.time, '.agents/plugins/marketplace.json'), join(root, '.agents/plugins/marketplace.json'))
  await copyPath(join(sourceRoots.capability, 'catalog/capabilities/time-zone-convert.v0.2.json'), join(root, 'capability-contracts/time-zone-convert.v0.2.json'))
  await copyPath(join(sourceRoots.capability, 'catalog/capabilities/schemas/time-zone.convert.v0.2.input.schema.json'), join(root, 'capability-contracts/schemas/time-zone.convert.v0.2.input.schema.json'))
  await copyPath(join(sourceRoots.capability, 'catalog/capabilities/schemas/time-zone.convert.v0.2.output.schema.json'), join(root, 'capability-contracts/schemas/time-zone.convert.v0.2.output.schema.json'))
  await installProductionDependencies(root)
  const nodeExtract = join(workRoot, 'node-for-migratory-time')
  await mkdir(nodeExtract, { recursive: true })
  await command('/usr/bin/tar', ['-xzf', join(artifactRoot, basename(nodeComponent.artifact.url)), '-C', nodeExtract, './bin/node'])
  await copyPath(join(nodeExtract, 'bin/node'), join(root, 'plugins/migratory-time/runtime/node'))
  await chmod(join(root, 'plugins/migratory-time/runtime/node'), 0o755)
  const mcpPath = join(root, 'plugins/migratory-time/.mcp.json')
  const mcp = JSON.parse(await readFile(mcpPath, 'utf8'))
  mcp.mcpServers.migratory_time.command = 'runtime/node'
  await writeJson(mcpPath, mcp)
  const manifestPath = join(root, 'capabilities/provider.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.implementations[0].adapter.command = 'plugins/migratory-time/runtime/node'
  await writeJson(manifestPath, manifest)
  const notices = await legalNotices(root, 'Migratory Time')
  await writeText(join(root, 'THIRD_PARTY_NOTICES.txt'), notices.text)
  const source = sourceState('migratory-time')
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const plugin = JSON.parse(await readFile(join(root, 'plugins/migratory-time/.codex-plugin/plugin.json'), 'utf8'))
  await writeJson(join(root, 'sbom.spdx.json'), sbom('migratory-time', plugin.version, 'Apache-2.0', source, notices.packages))
  const pluginIdentityRelativeFiles = ['.codex-plugin/plugin.json', '.mcp.json', 'server/index.mjs', 'runtime/node', 'skills/convert-time-zones/SKILL.md']
  const identityFiles = ['package.json', 'package-lock.json', '.agents/plugins/marketplace.json', ...pluginIdentityRelativeFiles.map((path) => `plugins/migratory-time/${path}`), 'capabilities/provider.json', 'capabilities/schemas/time-zone.convert.input.schema.json', 'capabilities/schemas/time-zone.convert.output.schema.json', 'scripts/runCapabilityAdapter.mjs', 'scripts/capabilityProviderLib.mjs', 'capability-contracts/time-zone-convert.v0.2.json', 'capability-contracts/schemas/time-zone.convert.v0.2.input.schema.json', 'capability-contracts/schemas/time-zone.convert.v0.2.output.schema.json', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt', 'sbom.spdx.json']
  return await finalizeComponent({
    root,
    id: 'migratory-time',
    version: plugin.version,
    kind: 'migratory-time',
    identityFiles,
    entrypoints: { server: 'plugins/migratory-time/server/index.mjs', adapter: 'scripts/runCapabilityAdapter.mjs', manifest: 'capabilities/provider.json', inputSchema: 'capabilities/schemas/time-zone.convert.input.schema.json', outputSchema: 'capabilities/schemas/time-zone.convert.output.schema.json', profile: 'capability-contracts/time-zone-convert.v0.2.json' },
    integration: { pluginRoot: 'plugins/migratory-time', marketplaceRoot: '.', marketplace: 'migratory-time', plugin: 'migratory-time', pluginIdentityRelativeFiles },
  })
}

async function main() {
  const knownComponentIds = new Set(['node-runtime', ...Object.keys(componentSourceIds)])
  const unknownReuseIds = [...reuseComponentIds].filter((id) => !knownComponentIds.has(id))
  if (unknownReuseIds.length > 0) throw new Error(`requested reusable components are unknown: ${unknownReuseIds.join(', ')}`)
  if (sourcePolicy === 'remote-tagged' && reuseComponentIds.size > 0) {
    throw new Error('remote-tagged builds cannot reuse a prior local component catalog')
  }
  const requiredSourceIds = new Set(['suite'])
  for (const [componentId, sourceIds] of Object.entries(componentSourceIds)) {
    if (!reuseComponentIds.has(componentId)) for (const sourceId of sourceIds) requiredSourceIds.add(sourceId)
  }
  const requiredSourceRoots = Object.fromEntries([...requiredSourceIds].sort().map((id) => [id, logicalSourceRoots[id]]))
  sourceObservations = await inspectBuildSources(sourcePolicy, requiredSourceRoots, { sourceLockPath })

  const workRoot = await mkdtemp(join(tmpdir(), 'agent-host-internal-beta-'))
  try {
    const materializedRoots = sourcePolicy === 'remote-tagged'
      ? await materializeGitSourceSnapshots(requiredSourceRoots, sourceObservations, join(workRoot, 'remote-sources'))
      : null
    if (materializedRoots !== null) useMaterializedSourceRoots(materializedRoots)
    const armorialSourceBuild = materializedRoots === null || reuseComponentIds.has('armorial')
      ? null
      : await buildArmorialPluginFromVerifiedSource({
        sourceRoot: materializedRoots.armorial,
        scratchRoot: workRoot,
        sourceObservation: sourceObservations.armorial,
      })
    const fileVitalsOverrides = [
      process.env.AGENT_HOST_FILE_VITALS_PLUGIN_ROOT,
      process.env.AGENT_HOST_FILE_VITALS_PLUGIN_ARCHIVE,
    ]
    const rebuildFileVitals = fileVitalsSourceBuildRequired({
      sourcePolicy,
      reuseRequested: reuseComponentIds.has('file-vitals'),
      pluginRootOverride: fileVitalsOverrides[0],
      archiveOverride: fileVitalsOverrides[1],
    })
    const fileVitalsSourceBuild = rebuildFileVitals
      ? await buildFileVitalsPluginFromSource({
        sourceRoot: sourceRoots.fileVitals,
        scratchRoot: workRoot,
        sourceObservation: sourceObservations['file-vitals'],
      })
      : null
    const providerReleaseInputs = {
      dataTransformerPluginRoot: await providerReleaseInputWhenBuilt('data-transformer', 'data-transformer', 'AGENT_HOST_DATA_TRANSFORMER_PLUGIN_ROOT', 'dist/plugin/data-transformer-0.2.0-darwin-arm64', materializedRoots),
      dataTransformerPluginArchive: await providerReleaseInputWhenBuilt('data-transformer', 'data-transformer', 'AGENT_HOST_DATA_TRANSFORMER_PLUGIN_ARCHIVE', 'dist/plugin/data-transformer-0.2.0-darwin-arm64.tar.gz', materializedRoots),
      armorialPluginRoot: armorialSourceBuild === null
        ? await providerReleaseInputWhenBuilt('armorial', 'armorial', 'AGENT_HOST_ARMORIAL_PLUGIN_ROOT', 'plugins/armorial', materializedRoots)
        : materializedRoots.armorial,
      armorialPluginArchive: armorialSourceBuild === null
        ? await providerReleaseInputWhenBuilt('armorial', 'armorial', 'AGENT_HOST_ARMORIAL_PLUGIN_ARCHIVE', `.release/armorial-${ARMORIAL_COMPATIBILITY_VERSION}-codex-plugin-macos-arm64.tar.gz`, materializedRoots)
        : armorialSourceBuild.archivePath,
      armorialPluginArchiveSha256: armorialSourceBuild?.sha256,
      projectivePluginRoot: await providerReleaseInputWhenBuilt('projective', 'projective', 'AGENT_HOST_PROJECTIVE_PLUGIN_ROOT', 'plugins/projective', materializedRoots),
      projectivePluginArchive: await providerReleaseInputWhenBuilt('projective', 'projective', 'AGENT_HOST_PROJECTIVE_PLUGIN_ARCHIVE', 'artifacts/codex-plugin/projective-0.1.0+codex.20260824173741-codex-macos-arm64.tar.gz', materializedRoots),
      fileVitalsPluginRoot: fileVitalsSourceBuild === null
        ? await providerReleaseInputWhenBuilt('file-vitals', 'file-vitals', 'AGENT_HOST_FILE_VITALS_PLUGIN_ROOT', `dist/plugin/file-vitals-${FILE_VITALS_COMPATIBILITY_VERSION}-darwin-arm64`, materializedRoots)
        : fileVitalsSourceBuild.pluginRoot,
      fileVitalsPluginArchive: fileVitalsSourceBuild === null
        ? await providerReleaseInputWhenBuilt('file-vitals', 'file-vitals', 'AGENT_HOST_FILE_VITALS_PLUGIN_ARCHIVE', `dist/plugin/file-vitals-${FILE_VITALS_COMPATIBILITY_VERSION}-darwin-arm64.tar.gz`, materializedRoots)
        : fileVitalsSourceBuild.archivePath,
      fileVitalsPluginArchiveSha256: fileVitalsSourceBuild?.sha256,
    }
    const cacheRoot = join(suiteRoot, '.build', 'download-cache')
    await mkdir(cacheRoot, { recursive: true })
    await rm(outputStaging, { recursive: true, force: true })
    await mkdir(artifactRoot, { recursive: true })
    const node = await buildOrReuse('node-runtime', () => buildNode(workRoot, cacheRoot))
    const components = [
      node,
      await buildOrReuse('direct-execution-runtime', () => buildDirectRuntime(workRoot)),
      await buildOrReuse('math-anchor', () => buildMathAnchor(workRoot)),
      await buildOrReuse('migratory-time', () => buildMigratoryTime(workRoot, node)),
      await buildOrReuse('agent-tool-observer', () => buildLocalNodeUtility(workRoot, {
        id: 'agent-tool-observer',
        kind: 'agent-tool-observer',
        title: 'Agent Tool Observer',
        sourceRoot: sourceRoots.observer,
        sourceId: 'suite',
        entrypoint: 'src/cli.mjs',
        additionalPaths: ['adapters', 'integrations'],
        additionalIdentityFiles: [
          'adapters/claude-code-hooks.json',
          'adapters/claude-project-events.json',
          'adapters/codex-session-events.json',
          'adapters/deepseek-harness-session-events.json',
          'adapters/gemini-cli-otel.json',
          'adapters/github-copilot-cli-hooks.json',
          'adapters/zcode-model-io.json',
          'integrations/deepseek-harness/index.mjs',
          'integrations/deepseek-harness/package.json',
        ],
      })),
      await buildOrReuse('context-surface-analyzer', () => buildLocalNodeUtility(workRoot, {
        id: 'context-surface-analyzer',
        kind: 'context-surface-analyzer',
        title: 'Context Surface Analyzer',
        sourceRoot: sourceRoots.analyzer,
        sourceId: 'suite',
        entrypoint: 'src/cli.js',
      })),
      await buildOrReuse('agent-tool-development-kit', () => buildDeveloperKit()),
      await buildOrReuse('data-transformer', () => buildAgentTool(workRoot, {
        id: 'data-transformer',
        displayName: 'BatchTicket',
        summary: 'Inspect, reshape, validate, and compare structured data.',
        marketplace: 'data-transformer-local',
        plugin: 'data-transformer',
        sourceId: 'data-transformer',
        repositoryRoot: sourceRoots.dataTransformer,
        pluginRoot: providerReleaseInputs.dataTransformerPluginRoot,
        pluginArchive: providerReleaseInputs.dataTransformerPluginArchive,
        pluginArchiveRoot: 'data-transformer-0.2.0-darwin-arm64',
        expectedTools: ['data_diff', 'data_inspect', 'data_transform', 'data_validate'],
        workspaceEnvironment: ['ADT_WORKSPACE_ROOT'],
        timeoutMs: 30000,
        directCapability: {
          providerId: 'io.github.tetracoralla.batchticket',
          capabilityId: 'org.openadam.structured-data.analyze',
          capabilityVersion: '0.1.0',
          lifecycle: 'persistent',
          workspaceRoot: 'host-required',
          manifest: 'capabilities/provider.json',
          adapterCommand: 'runtime/adt-capability',
          profileSource: join(sourceRoots.capability, 'catalog/capabilities/structured-data-analyze.v0.1.json'),
          contracts: [
            {
              operationId: 'inspect',
              inputSchemaSource: join(sourceRoots.capability, 'catalog/capabilities/schemas/structured-data.inspect.v0.1.input.schema.json'),
              outputSchemaSource: join(sourceRoots.capability, 'catalog/capabilities/schemas/structured-data.inspect.v0.1.output.schema.json'),
              providerInputSchema: 'capabilities/schemas/structured-data.inspect.input.schema.json',
              providerOutputSchema: 'capabilities/schemas/structured-data.inspect.output.schema.json',
            },
            {
              operationId: 'validate',
              inputSchemaSource: join(sourceRoots.capability, 'catalog/capabilities/schemas/structured-data.validate.v0.1.input.schema.json'),
              outputSchemaSource: join(sourceRoots.capability, 'catalog/capabilities/schemas/structured-data.validate.v0.1.output.schema.json'),
              providerInputSchema: 'capabilities/schemas/structured-data.validate.input.schema.json',
              providerOutputSchema: 'capabilities/schemas/structured-data.validate.output.schema.json',
            },
          ],
        },
      })),
      await buildOrReuse('armorial', () => buildAgentTool(workRoot, {
        id: 'armorial',
        displayName: 'Armorial',
        summary: 'Choose project-aware icons without redrawing them.',
        marketplace: 'openadam-local',
        plugin: 'armorial',
        sourceId: 'armorial',
        repositoryRoot: sourceRoots.armorial,
        pluginRoot: providerReleaseInputs.armorialPluginRoot,
        pluginArchive: providerReleaseInputs.armorialPluginArchive,
        pluginArchiveSha256: providerReleaseInputs.armorialPluginArchiveSha256,
        pluginArchiveRoot: 'armorial',
        expectedTools: ['browse_icons', 'choose_icon', 'get_icon', 'get_icons', 'resolve_icon', 'search_icons'],
        discovery: {
          skillId: 'icon-svg-select',
          identityFiles: ['SKILL.md', 'references/html-retrofit.md', 'references/selection-messages.md'],
          command: 'dist/adapters/cli.js',
          launcher: 'scripts/armorial',
          versionArguments: ['--version'],
        },
      })),
      await buildOrReuse('laniakea', () => buildAgentTool(workRoot, {
        id: 'laniakea',
        displayName: 'Laniakea',
        summary: 'Create, inspect, search, and revise Markdown mind maps.',
        marketplace: 'laniakea',
        plugin: 'laniakea',
        sourceId: 'laniakea',
        repositoryRoot: sourceRoots.laniakea,
        pluginRoot: join(sourceRoots.laniakea, 'plugins/laniakea'),
        expectedTools: ['create_mind_map', 'read_mind_map', 'search_mind_map', 'update_mind_map'],
      })),
      await buildOrReuse('projective', () => buildAgentTool(workRoot, {
        id: 'projective',
        displayName: 'Projective',
        summary: 'Compose, inspect, render, and emit explicit projective planes.',
        marketplace: 'projective-local',
        plugin: 'projective',
        sourceId: 'projective',
        repositoryRoot: sourceRoots.projective,
        pluginRoot: providerReleaseInputs.projectivePluginRoot,
        pluginArchive: providerReleaseInputs.projectivePluginArchive,
        pluginArchiveRoot: 'projective',
        expectedTools: ['projective.compose', 'projective.css', 'projective.inspect', 'projective.render', 'projective.solve'],
        workspaceEnvironment: ['PROJECTIVE_WORKSPACE_ROOT'],
      })),
      await buildOrReuse('equatorium', () => buildAgentTool(workRoot, {
        id: 'equatorium',
        displayName: 'Equatorium',
        summary: 'Interpret specification-dense standard expressions deterministically.',
        marketplace: 'equatorium',
        plugin: 'equatorium',
        sourceId: 'equatorium',
        repositoryRoot: sourceRoots.equatorium,
        pluginRoot: join(sourceRoots.equatorium, 'plugins/equatorium'),
        expectedTools: ['sei_run'],
      })),
      await buildOrReuse('file-vitals', () => buildAgentTool(workRoot, {
        id: 'file-vitals',
        displayName: 'File Vitals',
        summary: 'Inspect and inventory files before acting on them.',
        marketplace: 'file-vitals-local',
        plugin: 'file-vitals',
        sourceId: 'file-vitals',
        repositoryRoot: sourceRoots.fileVitals,
        pluginRoot: providerReleaseInputs.fileVitalsPluginRoot,
        pluginArchive: providerReleaseInputs.fileVitalsPluginArchive,
        pluginArchiveSha256: providerReleaseInputs.fileVitalsPluginArchiveSha256,
        pluginArchiveRoot: `file-vitals-${FILE_VITALS_COMPATIBILITY_VERSION}-darwin-arm64`,
        expectedVersion: FILE_VITALS_COMPATIBILITY_VERSION,
        expectedTools: ['file_inspect', 'file_inspect_batch', 'workspace_inventory'],
        workspaceEnvironment: ['UFI_WORKSPACE_ROOT'],
        directCapability: {
          providerId: 'io.github.tetracoralla.file-vitals',
          capabilityId: 'org.openadam.file.inspect',
          capabilityVersion: '0.1.0',
          lifecycle: 'persistent',
          workspaceRoot: 'host-required',
          manifest: 'capabilities/provider.json',
          adapterCommand: 'runtime/file-vitals-capability',
          profileSource: join(sourceRoots.capability, 'catalog/capabilities/file-inspect.v0.1.json'),
          contracts: [{
            operationId: 'inspect',
            inputSchemaSource: join(sourceRoots.capability, 'catalog/capabilities/schemas/file.inspect.v0.1.input.schema.json'),
            outputSchemaSource: join(sourceRoots.capability, 'catalog/capabilities/schemas/file.inspect.v0.1.output.schema.json'),
            providerInputSchema: 'capabilities/schemas/file.inspect.input.schema.json',
            providerOutputSchema: 'capabilities/schemas/file.inspect.output.schema.json',
          }],
        },
      })),
    ]
    const unreused = [...reuseComponentIds].filter((id) => !reusedComponentIds.has(id))
    if (unreused.length > 0) throw new Error(`requested reusable components were not staged: ${unreused.join(', ')}`)
    const postBuildSources = await inspectBuildSources(sourcePolicy, requiredSourceRoots, { sourceLockPath })
    if (JSON.stringify(postBuildSources) !== JSON.stringify(sourceObservations)) {
      throw new Error('source repositories changed while release components were being built')
    }
    const releaseManifest = {
      schemaVersion: 'openadam.agent-host-release.v0.2',
      releaseId,
      suiteVersion: releaseVersion,
      status: 'internal-beta',
      createdAt: releaseCreatedAt,
      platforms: [platform],
      components,
    }
    await writeJson(join(outputStaging, 'current.json'), releaseManifest)
    const sourceProvenance = buildProvenance({
      policy: sourcePolicy,
      releaseId,
      suiteVersion: releaseVersion,
      createdAt: releaseCreatedAt,
      sources: sourceObservations,
      reusedComponents: components
        .filter((component) => reusedComponentIds.has(component.id))
        .map((component) => ({
          id: component.id,
          artifactSha256: component.artifact.sha256,
          fromReleaseId: priorRelease.releaseId,
        })),
    })
    await writeJson(join(outputStaging, 'build-provenance.json'), sourceProvenance)
    try {
      const previous = JSON.parse(await readFile(join(outputRoot, 'current.json'), 'utf8'))
      if (previous.releaseId === releaseId) {
        const priorDigests = new Map(previous.components.map((item) => [item.id, item.artifact.sha256]))
        const changed = components.filter((item) => priorDigests.get(item.id) !== item.artifact.sha256).map((item) => item.id)
        if (changed.length > 0) throw new Error(`${releaseId} is already bound to different component bytes: ${changed.join(', ')}`)
        const previousProvenance = JSON.parse(await readFile(join(outputRoot, 'build-provenance.json'), 'utf8'))
        if (JSON.stringify(previousProvenance) !== JSON.stringify(sourceProvenance)) {
          throw new Error(`${releaseId} is already bound to different source provenance`)
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await rm(outputRoot, { recursive: true, force: true })
    await rename(outputStaging, outputRoot)
    process.stdout.write(`${join(outputRoot, 'current.json')}\n`)
  } finally {
    await rm(workRoot, { recursive: true, force: true })
    await rm(outputStaging, { recursive: true, force: true }).catch(() => {})
  }
}

await main()
