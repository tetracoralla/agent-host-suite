import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { pipeline } from 'node:stream/promises'

const suiteRoot = fileURLToPath(new URL('../', import.meta.url))
const workspaceRoot = dirname(suiteRoot)
const outputRoot = join(suiteRoot, '.build', 'internal-beta', 'release-catalog')
const outputStaging = `${outputRoot}.staging-${process.pid}`
const artifactRoot = join(outputStaging, 'artifacts')
const componentSchema = 'openadam.agent-host-component.v0.1'
const releaseVersion = process.env.AGENT_HOST_SUITE_VERSION ?? '0.1.0-dogfood.4'
const releaseId = process.env.AGENT_HOST_RELEASE_ID ?? 'local-dogfood-20260827.4'
const releaseCreatedAt = process.env.AGENT_HOST_RELEASE_CREATED_AT ?? '2026-08-27T00:00:00.000Z'
const platform = 'darwin-arm64'
const nodeVersion = '22.22.1'
const nodeArchiveName = `node-v${nodeVersion}-darwin-arm64.tar.gz`
const nodeUrl = `https://nodejs.org/dist/v${nodeVersion}/${nodeArchiveName}`
const nodeUpstreamSha256 = 'sha256:679ad4966339e4ef4900f57996714864e4211b898825bb840c3086c419fbcef2'
const sourceRoots = {
  runtime: join(workspaceRoot, 'direct-execution-runtime'),
  math: join(workspaceRoot, 'calculator'),
  time: join(workspaceRoot, 'migratory-time'),
  capability: join(workspaceRoot, 'capability-contracts'),
  observer: join(workspaceRoot, 'agent-tool-observer'),
  analyzer: join(workspaceRoot, 'context-surface-analyzer'),
  dataTransformer: join(workspaceRoot, 'data-transformer'),
  armorial: join(workspaceRoot, 'icon-svg-select'),
  laniakea: join(workspaceRoot, 'laniakea'),
  projective: join(workspaceRoot, 'perspective-tool'),
  equatorium: join(workspaceRoot, 'standard-expression-interpreter'),
  fileVitals: join(workspaceRoot, 'universal-inspector'),
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

async function sourceState(root) {
  const revision = (await command('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: root })).trim()
  const dirty = (await command('/usr/bin/git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root })).trim().length > 0
  return { revision, dirty }
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
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `${name}-${version}-${platform}`,
    documentNamespace: `https://openadam.dev/spdx/${releaseId}/${name}`,
    creationInfo: { created: releaseCreatedAt, creators: ['Tool: Agent Host internal Beta builder'] },
    packages: [
      { SPDXID: 'SPDXRef-RootPackage', name, versionInfo: version, downloadLocation: upstream?.url ?? 'NOASSERTION', licenseConcluded: license, licenseDeclared: license, filesAnalyzed: false, ...(upstream === null ? {} : { checksums: [{ algorithm: 'SHA256', checksumValue: upstream.sha256.slice(7) }] }) },
      ...packages.map((item, index) => ({ SPDXID: `SPDXRef-Dependency-${index + 1}`, name: item.name, versionInfo: item.version, downloadLocation: 'NOASSERTION', licenseConcluded: item.license, licenseDeclared: item.license, filesAnalyzed: false })),
    ],
    annotations: [{ annotationDate: releaseCreatedAt, annotationType: 'OTHER', annotator: 'Tool: Agent Host internal Beta builder', comment: `sourceRevision=${source?.revision ?? 'upstream'}; sourceDirty=${source?.dirty ?? false}` }],
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
  const fixedTime = new Date(releaseCreatedAt)
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
  const source = await sourceState(sourceRoots.runtime)
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  await writeJson(join(root, 'sbom.spdx.json'), sbom('direct-execution-runtime', pkg.version, 'Apache-2.0', source, notices.packages))
  const identityFiles = ['package.json', 'package-lock.json', 'src/cli.mjs', 'src/runtime.mjs', 'src/host-service.mjs', 'src/config.mjs', 'schemas/provider-config.schema.json', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt', 'sbom.spdx.json']
  return await finalizeComponent({ root, id: 'direct-execution-runtime', version: pkg.version, kind: 'direct-runtime', identityFiles, entrypoints: { cli: 'src/cli.mjs' }, integration: null })
}

async function buildLocalNodeUtility(workRoot, { id, kind, title, sourceRoot, entrypoint }) {
  const root = join(workRoot, id)
  for (const path of ['package.json', 'package-lock.json', 'src', 'LICENSE', 'NOTICE']) {
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
  const source = await sourceState(sourceRoot)
  await writeJson(join(root, 'sbom.spdx.json'), sbom(id, pkg.version, 'Apache-2.0', source, notices.packages))
  return await finalizeComponent({
    root,
    id,
    version: pkg.version,
    kind,
    identityFiles: ['package.json', 'package-lock.json', entrypoint, 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt', 'sbom.spdx.json'],
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

async function copyNodeIntoPlugin(workRoot, nodeComponent, pluginRoot) {
  const extracted = join(workRoot, `node-for-plugin-${basename(pluginRoot)}`)
  await mkdir(extracted, { recursive: true })
  await command('/usr/bin/tar', ['-xzf', join(artifactRoot, basename(nodeComponent.artifact.url)), '-C', extracted, './bin/node'])
  const relativePath = 'runtime/agent-host-node'
  await copyPath(join(extracted, 'bin/node'), join(pluginRoot, relativePath))
  await chmod(join(pluginRoot, relativePath), 0o755)
  return relativePath
}

async function buildAgentTool(workRoot, nodeComponent, spec) {
  const root = join(workRoot, spec.id)
  const marketplaceRoot = 'marketplace'
  const pluginRootRelative = `${marketplaceRoot}/plugins/${spec.plugin}`
  const pluginRoot = join(root, pluginRootRelative)
  let pluginSource = spec.pluginRoot
  if (spec.pluginArchive !== undefined) {
    const extracted = join(workRoot, `${spec.id}-provider-release`)
    await mkdir(extracted, { recursive: true })
    await command('/usr/bin/tar', ['-xzf', spec.pluginArchive, '-C', extracted])
    pluginSource = join(extracted, spec.pluginArchiveRoot)
  }
  await copyPath(pluginSource, pluginRoot)
  for (const path of spec.additionalPaths ?? []) await copyPath(join(spec.repositoryRoot, path), join(root, path))

  const pluginPath = join(pluginRoot, '.codex-plugin/plugin.json')
  const mcpPath = join(pluginRoot, '.mcp.json')
  const plugin = JSON.parse(await readFile(pluginPath, 'utf8'))
  const mcp = JSON.parse(await readFile(mcpPath, 'utf8'))
  const serverEntries = Object.entries(mcp.mcpServers ?? {})
  if (serverEntries.length !== 1) throw new Error(`${spec.id} must declare exactly one MCP server`)
  const [serverName, server] = serverEntries[0]
  let runtimeCommandRelative
  if (server.command === 'node') {
    const nodePath = await copyNodeIntoPlugin(workRoot, nodeComponent, pluginRoot)
    server.command = `./${nodePath}`
    runtimeCommandRelative = `${pluginRootRelative}/${nodePath}`
  } else {
    const relativeCommand = server.command.replace(/^\.\//u, '')
    if (relativeCommand === server.command && server.command.startsWith('/')) throw new Error(`${spec.id} MCP command must be relative`)
    runtimeCommandRelative = `${pluginRootRelative}/${relativeCommand}`
  }
  await writeJson(mcpPath, mcp)

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

  const legalRoot = spec.legalRoot ?? spec.pluginRoot
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
  const source = await sourceState(spec.repositoryRoot)
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
  return await finalizeComponent({
    root,
    id: spec.id,
    version: plugin.version,
    kind: spec.kind ?? 'agent-tool',
    identityFiles,
    entrypoints: { mcp: runtimeCommandRelative, ...(spec.entrypoints ?? {}) },
    integration: {
      schemaVersion: 'openadam.agent-host-tool-integration.v0.1',
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
        command: runtimeCommandRelative,
        args: server.args ?? [],
        cwd: pluginRootRelative,
        workspaceEnvironment: spec.workspaceEnvironment ?? [],
        expectedTools: spec.expectedTools,
        timeoutMs: spec.timeoutMs ?? 10000,
      },
      ownership: { uninstall: 'agent-host-created-only' },
    },
  })
}

async function buildMathAnchor(workRoot) {
  const root = join(workRoot, 'math-anchor')
  await copyPath(join(sourceRoots.math, '.agents/plugins/marketplace.json'), join(root, '.agents/plugins/marketplace.json'))
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
    integration: { pluginRoot: 'plugins/math-anchor', marketplaceRoot: '.', marketplace: 'openadam', plugin: plugin.name, pluginIdentityRelativeFiles, args: ['mcp'] },
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
  const source = await sourceState(sourceRoots.time)
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
  const workRoot = await mkdtemp(join(tmpdir(), 'agent-host-internal-beta-'))
  const cacheRoot = join(suiteRoot, '.build', 'download-cache')
  await mkdir(cacheRoot, { recursive: true })
  await rm(outputStaging, { recursive: true, force: true })
  await mkdir(artifactRoot, { recursive: true })
  try {
    const node = await buildNode(workRoot, cacheRoot)
    const components = [
      node,
      await buildDirectRuntime(workRoot),
      await buildMathAnchor(workRoot),
      await buildMigratoryTime(workRoot, node),
      await buildLocalNodeUtility(workRoot, {
        id: 'agent-tool-observer',
        kind: 'agent-tool-observer',
        title: 'Agent Tool Observer',
        sourceRoot: sourceRoots.observer,
        entrypoint: 'src/cli.mjs',
      }),
      await buildAgentTool(workRoot, node, {
        id: 'context-surface-analyzer',
        kind: 'context-surface-analyzer',
        displayName: 'Context Surface Analyzer',
        summary: 'Measure and compare explicit Agent tool catalogs.',
        marketplace: 'context-surface-analyzer',
        plugin: 'context-surface-analyzer',
        repositoryRoot: sourceRoots.analyzer,
        pluginRoot: join(sourceRoots.analyzer, 'plugins/context-surface-analyzer'),
        additionalPaths: ['package.json', 'package-lock.json', 'src'],
        identityFiles: ['package.json', 'package-lock.json', 'src/cli.js'],
        entrypoints: { cli: 'src/cli.js' },
        expectedTools: ['context.analyze', 'context.diff'],
      }),
      await buildAgentTool(workRoot, node, {
        id: 'data-transformer',
        displayName: 'BatchTicket',
        summary: 'Inspect, reshape, validate, and compare structured data.',
        marketplace: 'data-transformer-local',
        plugin: 'data-transformer',
        repositoryRoot: sourceRoots.dataTransformer,
        pluginRoot: process.env.AGENT_HOST_DATA_TRANSFORMER_PLUGIN_ROOT ?? join(sourceRoots.dataTransformer, 'dist/plugin/data-transformer-0.2.0-darwin-arm64'),
        pluginArchive: process.env.AGENT_HOST_DATA_TRANSFORMER_PLUGIN_ARCHIVE ?? join(sourceRoots.dataTransformer, 'dist/plugin/data-transformer-0.2.0-darwin-arm64.tar.gz'),
        pluginArchiveRoot: 'data-transformer-0.2.0-darwin-arm64',
        expectedTools: ['data_diff', 'data_inspect', 'data_transform', 'data_validate'],
        workspaceEnvironment: ['ADT_WORKSPACE_ROOT'],
        timeoutMs: 30000,
      }),
      await buildAgentTool(workRoot, node, {
        id: 'armorial',
        displayName: 'Armorial',
        summary: 'Choose project-aware icons without redrawing them.',
        marketplace: 'openadam-local',
        plugin: 'armorial',
        repositoryRoot: sourceRoots.armorial,
        pluginRoot: process.env.AGENT_HOST_ARMORIAL_PLUGIN_ROOT ?? join(sourceRoots.armorial, 'plugins/armorial'),
        pluginArchive: process.env.AGENT_HOST_ARMORIAL_PLUGIN_ARCHIVE ?? join(sourceRoots.armorial, '.release/armorial-0.5.0-codex-plugin-macos-arm64.tar.gz'),
        pluginArchiveRoot: 'armorial',
        expectedTools: ['browse_icons', 'choose_icon', 'get_icon', 'get_icons', 'resolve_icon', 'search_icons'],
      }),
      await buildAgentTool(workRoot, node, {
        id: 'laniakea',
        displayName: 'Laniakea',
        summary: 'Create, inspect, search, and revise Markdown mind maps.',
        marketplace: 'laniakea',
        plugin: 'laniakea',
        repositoryRoot: sourceRoots.laniakea,
        pluginRoot: join(sourceRoots.laniakea, 'plugins/laniakea'),
        expectedTools: ['create_mind_map', 'read_mind_map', 'search_mind_map', 'update_mind_map'],
      }),
      await buildAgentTool(workRoot, node, {
        id: 'projective',
        displayName: 'Projective',
        summary: 'Compose, inspect, render, and emit explicit projective planes.',
        marketplace: 'projective-local',
        plugin: 'projective',
        repositoryRoot: sourceRoots.projective,
        pluginRoot: process.env.AGENT_HOST_PROJECTIVE_PLUGIN_ROOT ?? join(sourceRoots.projective, 'plugins/projective'),
        pluginArchive: process.env.AGENT_HOST_PROJECTIVE_PLUGIN_ARCHIVE ?? join(sourceRoots.projective, 'artifacts/codex-plugin/projective-0.1.0+codex.20260824173741-codex-macos-arm64.tar.gz'),
        pluginArchiveRoot: 'projective',
        expectedTools: ['projective.compose', 'projective.css', 'projective.inspect', 'projective.render', 'projective.solve'],
        workspaceEnvironment: ['PROJECTIVE_WORKSPACE_ROOT'],
      }),
      await buildAgentTool(workRoot, node, {
        id: 'equatorium',
        displayName: 'Equatorium',
        summary: 'Interpret specification-dense standard expressions deterministically.',
        marketplace: 'equatorium',
        plugin: 'equatorium',
        repositoryRoot: sourceRoots.equatorium,
        pluginRoot: join(sourceRoots.equatorium, 'plugins/equatorium'),
        expectedTools: ['sei_run'],
      }),
      await buildAgentTool(workRoot, node, {
        id: 'file-vitals',
        displayName: 'File Vitals',
        summary: 'Inspect and inventory files before acting on them.',
        marketplace: 'file-vitals-local',
        plugin: 'file-vitals',
        repositoryRoot: sourceRoots.fileVitals,
        pluginRoot: process.env.AGENT_HOST_FILE_VITALS_PLUGIN_ROOT ?? join(sourceRoots.fileVitals, 'dist/plugin/file-vitals-0.3.2-darwin-arm64'),
        expectedTools: ['file_inspect', 'file_inspect_batch', 'workspace_inventory'],
        workspaceEnvironment: ['UFI_WORKSPACE_ROOT'],
      }),
    ]
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
    try {
      const previous = JSON.parse(await readFile(join(outputRoot, 'current.json'), 'utf8'))
      if (previous.releaseId === releaseId) {
        const priorDigests = new Map(previous.components.map((item) => [item.id, item.artifact.sha256]))
        const changed = components.filter((item) => priorDigests.get(item.id) !== item.artifact.sha256).map((item) => item.id)
        if (changed.length > 0) throw new Error(`${releaseId} is already bound to different component bytes: ${changed.join(', ')}`)
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
