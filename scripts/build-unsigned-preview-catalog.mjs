import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { arch, platform as osPlatform } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { currentReleasePlatform, REQUIRED_RELEASE_COMPONENTS, validateReleaseManifest } from '../src/release-manifest.mjs'
import { runFile } from '../src/process.mjs'

const execFileAsync = promisify(execFile)
const suiteRoot = fileURLToPath(new URL('../', import.meta.url))
const NODE_VERSION = '22.22.1'

function argument(name, fallback = undefined) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  return process.argv[index + 1] ?? true
}

async function sha256File(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return `sha256:${hash.digest('hex')}`
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

async function inventory(root) {
  const files = []
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      const info = await stat(path)
      if (entry.isSymbolicLink()) throw new Error(`component staging contains a link: ${relative(root, path)}`)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && relative(root, path) !== 'component.json') {
        files.push({
          path: relative(root, path).split(sep).join('/'),
          sha256: await sha256File(path),
          bytes: info.size,
          executable: (info.mode & 0o111) !== 0,
        })
      }
    }
  }
  await walk(root)
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

async function gitRevision() {
  try {
    const { stdout } = await execFileAsync('git', ['-C', suiteRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
    return stdout.trim()
  } catch {
    return '0'.repeat(40)
  }
}

function tarCommand() {
  return process.platform === 'win32' ? 'tar.exe' : '/usr/bin/tar'
}

async function finalizeComponent({ root, id, version, kind, identityFiles, entrypoints, integration = null, license = 'Apache-2.0', artifactRoot, platform }) {
  const files = await inventory(root)
  const paths = new Set(files.map((item) => item.path))
  for (const path of identityFiles) {
    if (!paths.has(path)) throw new Error(`${id} identity file is absent: ${path}`)
  }
  const descriptor = {
    schemaVersion: 'openadam.agent-host-component.v0.1',
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
  const archiveFile = `${id}-${version}-${platform}.tar.gz`
  const archivePath = join(artifactRoot, archiveFile)
  await execFileAsync(tarCommand(), ['-czf', archivePath, '-C', root, '.'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  const info = await stat(archivePath)
  return {
    id,
    version,
    platform,
    artifact: { url: `artifacts/${archiveFile}`, sha256: await sha256File(archivePath), bytes: info.size, format: 'tar.gz' },
    descriptorSha256: await sha256File(descriptorPath),
    license: { spdx: license, files: ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt'] },
  }
}

async function copyLegal(root, title) {
  await cp(join(suiteRoot, 'LICENSE'), join(root, 'LICENSE'))
  await writeFile(join(root, 'NOTICE'), `${title}\n`, { mode: 0o600 })
  await writeFile(join(root, 'THIRD_PARTY_NOTICES.txt'), `# Third-Party Notices\n\n${title} notices are recorded in LICENSE and NOTICE.\n`, { mode: 0o600 })
  await writeJson(join(root, 'sbom.spdx.json'), {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: title,
    documentNamespace: `https://openadam.dev/spdx/unsigned-preview/${encodeURIComponent(title)}`,
    creationInfo: { created: '2000-01-01T00:00:00.000Z', creators: ['Tool: Agent Host unsigned preview catalog'] },
    packages: [],
  })
}

async function buildNode(workRoot, artifactRoot, platform) {
  const nodePlatform = platform.startsWith('darwin-')
    ? `darwin-${platform.endsWith('x86_64') ? 'x64' : 'arm64'}`
    : platform.startsWith('win32-')
      ? `win-${platform.endsWith('arm64') ? 'arm64' : 'x64'}`
      : failPlatform(platform)
  const archiveName = process.platform === 'win32'
    ? `node-v${NODE_VERSION}-${nodePlatform}.zip`
    : `node-v${NODE_VERSION}-${nodePlatform}.tar.gz`
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${archiveName}`
  const sumsUrl = `https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`
  const cache = join(workRoot, archiveName)
  const sumsPath = join(workRoot, 'SHASUMS256.txt')
  await execFileAsync(process.platform === 'win32' ? 'curl.exe' : '/usr/bin/curl', ['--fail', '--silent', '--show-error', '--location', '--output', sumsPath, sumsUrl])
  await execFileAsync(process.platform === 'win32' ? 'curl.exe' : '/usr/bin/curl', ['--fail', '--silent', '--show-error', '--location', '--output', cache, url])
  const sums = await readFile(sumsPath, 'utf8')
  const line = sums.split(/\r?\n/u).find((item) => item.endsWith(`  ${archiveName}`))
  if (line === undefined) throw new Error('Node SHASUMS256.txt does not name the official archive')
  const expected = `sha256:${line.slice(0, 64).toLowerCase()}`
  if (await sha256File(cache) !== expected) throw new Error('official Node archive checksum mismatch')
  const extracted = join(workRoot, 'node-upstream')
  const root = join(workRoot, 'node-runtime')
  await mkdir(extracted, { recursive: true })
  await mkdir(join(root, 'bin'), { recursive: true })
  await execFileAsync(tarCommand(), [archiveName.endsWith('.zip') ? '-xf' : '-xzf', cache, '-C', extracted])
  const entries = await readdir(extracted)
  const upstreamRoot = join(extracted, entries[0])
  const nodeName = platform.startsWith('win32-') ? 'node.exe' : 'node'
  const nodeSource = await officialNodeBinaryPath(upstreamRoot, platform)
  await mkdir(join(root, 'bin'), { recursive: true })
  await cp(nodeSource, join(root, 'bin', nodeName))
  if (!platform.startsWith('win32-')) await chmod(join(root, 'bin', nodeName), 0o755)
  await cp(join(upstreamRoot, 'LICENSE'), join(root, 'LICENSE'))
  await writeFile(join(root, 'NOTICE'), `Node.js ${NODE_VERSION} official binary subset.\nUpstream: ${url}\n`, { mode: 0o600 })
  await cp(join(upstreamRoot, 'LICENSE'), join(root, 'THIRD_PARTY_NOTICES.txt'))
  await writeJson(join(root, 'sbom.spdx.json'), {
    spdxVersion: 'SPDX-2.3', dataLicense: 'CC0-1.0', SPDXID: 'SPDXRef-DOCUMENT', name: 'node-runtime',
    documentNamespace: `https://openadam.dev/spdx/node/${NODE_VERSION}`,
    creationInfo: { created: '2000-01-01T00:00:00.000Z', creators: ['Tool: Agent Host unsigned preview catalog'] },
    packages: [],
  })
  return finalizeComponent({
    root,
    id: 'node-runtime',
    version: NODE_VERSION,
    kind: 'node-runtime',
    identityFiles: [`bin/${nodeName}`, 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt', 'sbom.spdx.json'],
    entrypoints: { node: `bin/${nodeName}` },
    license: 'MIT',
    artifactRoot,
    platform,
  })
}

function failPlatform(value) {
  throw new Error(`Unsupported unsigned preview platform: ${value}`)
}

async function pathExists(path) {
  return stat(path).then(() => true).catch((error) => error.code === 'ENOENT' ? false : Promise.reject(error))
}

export async function officialNodeBinaryPath(upstreamRoot, targetPlatform) {
  const nodeName = targetPlatform.startsWith('win32-') ? 'node.exe' : 'node'
  const windowsLayout = join(upstreamRoot, nodeName)
  const unixLayout = join(upstreamRoot, 'bin', nodeName)
  if (targetPlatform.startsWith('win32-')) {
    if (await pathExists(windowsLayout)) return windowsLayout
    if (await pathExists(unixLayout)) return unixLayout
    throw new Error(`official Windows Node layout is missing ${nodeName} at the archive root`)
  }
  if (await pathExists(unixLayout)) return unixLayout
  throw new Error(`official Node layout is missing bin/${nodeName}`)
}

async function removeLinks(root) {
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isSymbolicLink()) await rm(path, { force: true })
      else if (entry.isDirectory()) await walk(path)
    }
  }
  await walk(root)
}

async function resolveNpmCli() {
  if (typeof process.env.npm_execpath === 'string' && process.env.npm_execpath.length > 0) {
    return process.env.npm_execpath
  }
  // Direct `node --test` / script invocation outside `npm run`.
  for (const candidate of [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]) {
    if (await pathExists(candidate)) return candidate
  }
  return null
}

async function installProductionDependencies(root) {
  const npmCli = await resolveNpmCli()
  const args = ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']
  if (npmCli !== null) {
    await execFileAsync(process.execPath, [npmCli, ...args], {
      cwd: root,
      env: { ...process.env, npm_config_update_notifier: 'false' },
    })
  } else if (process.platform === 'win32') {
    // Node refuses to spawn .cmd without a shell (EINVAL); keep production install.
    await execFileAsync('npm.cmd', args, {
      cwd: root,
      env: { ...process.env, npm_config_update_notifier: 'false' },
      shell: true,
      windowsHide: true,
    })
  } else {
    await execFileAsync('npm', args, {
      cwd: root,
      env: { ...process.env, npm_config_update_notifier: 'false' },
    })
  }
  const modules = join(root, 'node_modules')
  if (await pathExists(modules)) await removeLinks(modules)
}

async function buildWorkspacePackage({ id, kind, source, entrypoint, workRoot, artifactRoot, platform, title, extraPaths = [], extraIdentityFiles = [], installDependencies = false }) {
  const root = join(workRoot, id)
  for (const path of ['package.json', 'package-lock.json', 'src', 'LICENSE', 'NOTICE', ...extraPaths]) {
    const from = join(source, path)
    if (await pathExists(from)) {
      await cp(from, join(root, path), { recursive: true })
    }
  }
  const schemas = join(source, 'schemas')
  if (await stat(schemas).then((info) => info.isDirectory()).catch(() => false)) {
    await cp(schemas, join(root, 'schemas'), { recursive: true })
  }
  if (installDependencies === true && await pathExists(join(root, 'package-lock.json'))) {
    await installProductionDependencies(root)
  }
  await copyLegal(root, title)
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const identityFiles = ['package.json', entrypoint, 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt', 'sbom.spdx.json', ...extraIdentityFiles]
  return finalizeComponent({
    root,
    id,
    version: pkg.version,
    kind,
    identityFiles,
    entrypoints: { cli: entrypoint },
    artifactRoot,
    platform,
  })
}

export function githubAssetMatchesPlatform(name, descriptor, platform) {
  const assetName = descriptor.origin?.assetName ?? name
  const darwin = platform.startsWith('darwin-')
  const windows = platform.startsWith('win32-')
  if ((assetName.includes('macos-') || assetName.includes('darwin-')) && darwin !== true) return false
  if ((assetName.includes('windows-') || assetName.includes('win32-')) && windows !== true) return false
  if (typeof descriptor.platform === 'string' && descriptor.platform !== 'local' && descriptor.platform !== platform) return false
  return true
}

async function importGithubTools(githubToolsRoot, artifactRoot, platform) {
  if (githubToolsRoot === undefined) return []
  const components = []
  const entries = await readdir(githubToolsRoot)
  for (const name of entries.filter((item) => item.endsWith('-host-component.tar.gz'))) {
    const source = join(githubToolsRoot, name)
    const descriptorResult = await runFile(tarCommand(), ['-xOzf', source, './component.json'], {
      timeoutMs: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    const descriptor = JSON.parse(descriptorResult.stdout)
    if (githubAssetMatchesPlatform(name, descriptor, platform) !== true) {
      throw new Error(`${descriptor.id} was admitted for a different platform than ${platform}; each runner must download its own GitHub assets`)
    }
    const destName = `${descriptor.id}-${descriptor.version}-${platform}.tar.gz`
    const dest = join(artifactRoot, destName)
    await cp(source, dest)
    const info = await stat(dest)
    const license = descriptor.legal?.sbom === 'sbom.spdx.json' ? (descriptor.presentation?.license ?? 'NOASSERTION') : 'NOASSERTION'
    components.push({
      id: descriptor.id,
      version: descriptor.version,
      platform,
      artifact: { url: `artifacts/${destName}`, sha256: await sha256File(dest), bytes: info.size, format: 'tar.gz' },
      descriptorSha256: `sha256:${createHash('sha256').update(descriptorResult.stdout).digest('hex')}`,
      license: { spdx: license === 'NOASSERTION' ? 'NOASSERTION' : license, files: ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt'] },
    })
  }
  return components
}

async function copyPluginTree(sourceRoot, destinationRoot) {
  await cp(sourceRoot, destinationRoot, { recursive: true })
}

const SCRIPT_ENTRYPOINT_EXTENSIONS = new Set(['.mjs', '.js', '.cjs', '.ts'])

function hasScriptEntrypointExtension(entrypoint) {
  const base = entrypoint.split(/[\\/]/u).pop() ?? entrypoint
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return false
  return SCRIPT_ENTRYPOINT_EXTENSIONS.has(base.slice(dot).toLowerCase())
}

export function profileRuntimeEntrypoint(baseEntrypoint, platform) {
  if (typeof baseEntrypoint !== 'string' || baseEntrypoint.length === 0) return baseEntrypoint
  const windows = typeof platform === 'string' && platform.startsWith('win32-')
  if (windows) {
    // Native Windows binaries (no extension / known binary basenames) get .exe.
    // Node/script entrypoints such as server/index.mjs must stay unchanged —
    // appending .exe would invent index.mjs.exe and fail the runtime check.
    if (baseEntrypoint.endsWith('.exe') || hasScriptEntrypointExtension(baseEntrypoint)) {
      return baseEntrypoint
    }
    return `${baseEntrypoint}.exe`
  }
  if (baseEntrypoint.endsWith('.exe')) return baseEntrypoint.slice(0, -4)
  return baseEntrypoint
}

async function existingRelative(root, relative) {
  return (await pathExists(join(root, relative))) ? relative : null
}

async function collectSkillFiles(pluginRoot) {
  const output = []
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name === 'SKILL.md') output.push(relative(pluginRoot, path).split(sep).join('/'))
    }
  }
  const skills = join(pluginRoot, 'skills')
  if (await pathExists(skills) === true) await walk(skills)
  return output.sort()
}

function resolveCapabilityContractsRoot() {
  if (typeof process.env.AGENT_HOST_CAPABILITY_CONTRACTS_SOURCE_ROOT === 'string'
    && process.env.AGENT_HOST_CAPABILITY_CONTRACTS_SOURCE_ROOT.length > 0) {
    return process.env.AGENT_HOST_CAPABILITY_CONTRACTS_SOURCE_ROOT
  }
  const sourcesRoot = process.env.AGENT_HOST_PROFILE_SOURCES_ROOT
  if (typeof sourcesRoot === 'string' && sourcesRoot.length > 0) {
    return join(sourcesRoot, 'capability-contracts')
  }
  return join(dirname(suiteRoot), 'capability-contracts')
}

async function copyIfPresent(source, destination) {
  if (await pathExists(source) !== true) return false
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true })
  return true
}

async function buildRequiredProfileTool({ id, kind, sourceRoot, pluginRelative, identityFiles, entrypoint, workRoot, artifactRoot, platform, title, artifactPath = null, pins = null }) {
  // ARTIFACT wins whenever provided — even if a source checkout also exists.
  // Workflow drafts always check out pins into SOURCE_ROOT; that must not hide a
  // verified platform archive that actually contains the runtime entrypoint.
  let resolvedRoot
  let resolvedFrom = null
  if (typeof artifactPath === 'string' && artifactPath.length > 0) {
    resolvedRoot = await materializeProfileArtifact(id, artifactPath, workRoot)
    resolvedFrom = 'artifact'
  } else {
    resolvedRoot = sourceRoot
    resolvedFrom = 'source'
  }
  if (resolvedRoot === undefined || await pathExists(resolvedRoot) !== true) {
    throw new Error(`${id} is required for the unsigned preview catalog. Set AGENT_HOST_${id.replaceAll('-', '_').toUpperCase()}_SOURCE_ROOT to a built plugin tree that already contains the runtime entrypoint, or AGENT_HOST_${id.replaceAll('-', '_').toUpperCase()}_ARTIFACT to a version-pinned platform archive.`)
  }
  const resolvedEntrypoint = profileRuntimeEntrypoint(entrypoint, platform)
  await assertPinnedVersion(id, resolvedRoot, pluginRelative, pins)
  const pluginSource = join(resolvedRoot, pluginRelative)
  if (await pathExists(pluginSource) !== true) {
    throw new Error(`${id} ${resolvedFrom} does not contain ${pluginRelative}`)
  }
  const root = join(workRoot, id)
  await mkdir(join(root, dirname(pluginRelative)), { recursive: true })
  await copyPluginTree(pluginSource, join(root, pluginRelative))

  // Prefer Host-facing marketplace naming; fall back to the source marketplace.
  const marketplaceCandidates = [
    join(resolvedRoot, 'integrations/agent-host/marketplace.json'),
    join(resolvedRoot, '.agents/plugins/marketplace.json'),
  ]
  let marketplaceName = id === 'math-anchor' ? 'math-anchor-agent-host' : id
  let wroteMarketplace = false
  for (const candidate of marketplaceCandidates) {
    if (await pathExists(candidate) !== true) continue
    await mkdir(join(root, '.agents/plugins'), { recursive: true })
    const marketplace = JSON.parse(await readFile(candidate, 'utf8'))
    if (id === 'math-anchor') marketplace.name = 'math-anchor-agent-host'
    marketplaceName = marketplace.name ?? marketplaceName
    await writeJson(join(root, '.agents/plugins/marketplace.json'), marketplace)
    wroteMarketplace = true
    break
  }
  if (!wroteMarketplace) {
    await mkdir(join(root, '.agents/plugins'), { recursive: true })
    await writeJson(join(root, '.agents/plugins/marketplace.json'), {
      name: marketplaceName,
      interface: { displayName: title },
      plugins: [{
        name: id,
        source: { source: 'local', path: `./plugins/${id}` },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Productivity',
      }],
    })
  }

  // Migratory Time consumer contract needs repo-level capabilities / scripts / package metadata
  // and the Capability Profile from capability-contracts — not only the plugin subtree.
  if (id === 'migratory-time') {
    for (const relativePath of [
      'package.json',
      'package-lock.json',
      'capabilities/provider.json',
      'capabilities/schemas',
      'scripts/runCapabilityAdapter.mjs',
      'scripts/capabilityProviderLib.mjs',
    ]) {
      const copied = await copyIfPresent(join(resolvedRoot, relativePath), join(root, relativePath))
      if (!copied && ['capabilities/provider.json', 'scripts/runCapabilityAdapter.mjs'].includes(relativePath)) {
        throw new Error(`${id} ${resolvedFrom} is missing ${relativePath}; Host materializeRelease requires the full Migratory Time consumer contract`)
      }
    }
    const capabilityRoot = resolveCapabilityContractsRoot()
    const profileCopies = [
      ['catalog/capabilities/time-zone-convert.v0.2.json', 'capability-contracts/time-zone-convert.v0.2.json'],
      ['catalog/capabilities/schemas/time-zone.convert.v0.2.input.schema.json', 'capability-contracts/schemas/time-zone.convert.v0.2.input.schema.json'],
      ['catalog/capabilities/schemas/time-zone.convert.v0.2.output.schema.json', 'capability-contracts/schemas/time-zone.convert.v0.2.output.schema.json'],
    ]
    for (const [fromRelative, toRelative] of profileCopies) {
      const copied = await copyIfPresent(join(capabilityRoot, fromRelative), join(root, toRelative))
      if (!copied) {
        throw new Error(`${id} requires capability-contracts at ${capabilityRoot} (${fromRelative}); set AGENT_HOST_CAPABILITY_CONTRACTS_SOURCE_ROOT`)
      }
    }
    // Reuse the cross-platform npm launcher + removeLinks path. Default npm ci
    // leaves node_modules/.bin symlinks that finalize/inventory rejects.
    // Dependency failure must abort the build (do not swallow install errors).
    if (await pathExists(join(root, 'package-lock.json')) === true) {
      await installProductionDependencies(root)
    }
  }

  // Prefer source legal files when present; otherwise fall back to suite placeholders.
  const licenseCopied = await copyIfPresent(join(resolvedRoot, 'LICENSE'), join(root, 'LICENSE'))
  const noticeCopied = await copyIfPresent(join(resolvedRoot, 'NOTICE'), join(root, 'NOTICE'))
  if (!licenseCopied || !noticeCopied) await copyLegal(root, title)
  else {
    if (await pathExists(join(root, 'THIRD_PARTY_NOTICES.txt')) !== true) {
      const third = join(resolvedRoot, 'THIRD_PARTY_NOTICES.txt')
      if (await pathExists(third)) await cp(third, join(root, 'THIRD_PARTY_NOTICES.txt'))
      else await writeFile(join(root, 'THIRD_PARTY_NOTICES.txt'), `# Third-Party Notices\n\n${title}\n`, { mode: 0o600 })
    }
    if (await pathExists(join(root, 'sbom.spdx.json')) !== true) {
      await writeJson(join(root, 'sbom.spdx.json'), {
        spdxVersion: 'SPDX-2.3',
        dataLicense: 'CC0-1.0',
        SPDXID: 'SPDXRef-DOCUMENT',
        name: title,
        documentNamespace: `https://openadam.dev/spdx/unsigned-preview/${encodeURIComponent(title)}`,
        creationInfo: { created: '2000-01-01T00:00:00.000Z', creators: ['Tool: Agent Host unsigned preview catalog'] },
        packages: [],
      })
    }
  }

  const presentIdentity = []
  for (const path of identityFiles) {
    const candidate = profileRuntimeEntrypoint(path, platform) === resolvedEntrypoint
      ? resolvedEntrypoint
      : path
    if (await pathExists(join(root, candidate))) presentIdentity.push(candidate)
    else if (candidate !== path && await pathExists(join(root, path))) presentIdentity.push(path)
  }
  if (!presentIdentity.includes(resolvedEntrypoint) && await pathExists(join(root, resolvedEntrypoint)) !== true) {
    throw new Error(`${id} is missing its runtime entrypoint ${resolvedEntrypoint} (from ${resolvedFrom}); use script/package_runtime.sh (or a verified platform ARTIFACT), not a source tree that only builds the Swift GUI`)
  }
  const versionFile = join(root, pluginRelative, '.codex-plugin/plugin.json')
  const plugin = await pathExists(versionFile)
    ? JSON.parse(await readFile(versionFile, 'utf8'))
    : { version: '0.0.0', name: id }
  const pluginName = plugin.name ?? id
  const skillFiles = await collectSkillFiles(join(root, pluginRelative))
  const runtimeWithinPlugin = resolvedEntrypoint.startsWith(`${pluginRelative}/`)
    ? resolvedEntrypoint.slice(pluginRelative.length + 1)
    : resolvedEntrypoint
  // Keep only identity files that exist in the staged tree.
  const presentPluginIdentity = []
  for (const item of ['.codex-plugin/plugin.json', '.mcp.json', runtimeWithinPlugin, ...skillFiles]) {
    if (await pathExists(join(root, pluginRelative, item))) presentPluginIdentity.push(item)
  }

  let entrypoints
  let integration
  let extraIdentity = []
  if (id === 'migratory-time') {
    entrypoints = {
      server: 'plugins/migratory-time/server/index.mjs',
      adapter: 'scripts/runCapabilityAdapter.mjs',
      manifest: 'capabilities/provider.json',
      inputSchema: 'capabilities/schemas/time-zone.convert.input.schema.json',
      outputSchema: 'capabilities/schemas/time-zone.convert.output.schema.json',
      profile: 'capability-contracts/time-zone-convert.v0.2.json',
    }
    for (const required of Object.values(entrypoints)) {
      if (await pathExists(join(root, required)) !== true) {
        throw new Error(`${id} is missing consumer entrypoint file ${required}`)
      }
    }
    extraIdentity = [
      'package.json',
      '.agents/plugins/marketplace.json',
      ...Object.values(entrypoints),
      'scripts/capabilityProviderLib.mjs',
      'capability-contracts/schemas/time-zone.convert.v0.2.input.schema.json',
      'capability-contracts/schemas/time-zone.convert.v0.2.output.schema.json',
    ]
    integration = {
      pluginRoot: pluginRelative,
      marketplaceRoot: '.',
      marketplace: marketplaceName,
      plugin: pluginName,
      pluginIdentityRelativeFiles: presentPluginIdentity,
    }
  } else if (id === 'math-anchor') {
    entrypoints = { command: resolvedEntrypoint }
    extraIdentity = ['.agents/plugins/marketplace.json']
    integration = {
      pluginRoot: pluginRelative,
      marketplaceRoot: '.',
      marketplace: marketplaceName,
      plugin: pluginName,
      pluginIdentityRelativeFiles: presentPluginIdentity,
      args: ['mcp'],
    }
  } else {
    entrypoints = { command: resolvedEntrypoint }
    integration = {
      pluginRoot: pluginRelative,
      marketplaceRoot: '.',
      marketplace: marketplaceName,
      plugin: pluginName,
      pluginIdentityRelativeFiles: presentPluginIdentity,
    }
  }

  const identity = [...new Set([
    'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt', 'sbom.spdx.json',
    ...presentIdentity,
    resolvedEntrypoint,
    ...extraIdentity,
    ...presentPluginIdentity.map((item) => `${pluginRelative}/${item}`),
  ].filter((item) => item !== undefined))]
  const presentFinalIdentity = []
  for (const item of identity) {
    if (await pathExists(join(root, item))) presentFinalIdentity.push(item)
  }

  return finalizeComponent({
    root,
    id,
    version: plugin.version ?? '0.0.0',
    kind,
    identityFiles: presentFinalIdentity,
    entrypoints,
    integration,
    artifactRoot,
    platform,
  })
}

async function readSourcePins() {
  const pinPath = join(suiteRoot, 'catalog/unsigned-preview-source-pins.json')
  if (await pathExists(pinPath) !== true) return null
  return JSON.parse(await readFile(pinPath, 'utf8'))
}

function resolveProfileSource(id, fallbackRelative) {
  const envName = `AGENT_HOST_${id.replaceAll('-', '_').toUpperCase()}_SOURCE_ROOT`
  if (typeof process.env[envName] === 'string' && process.env[envName].length > 0) return process.env[envName]
  const sourcesRoot = process.env.AGENT_HOST_PROFILE_SOURCES_ROOT
  if (typeof sourcesRoot === 'string' && sourcesRoot.length > 0) {
    return join(sourcesRoot, id)
  }
  const sibling = join(dirname(suiteRoot), fallbackRelative)
  return sibling
}

function resolveProfileArtifact(id) {
  const envName = `AGENT_HOST_${id.replaceAll('-', '_').toUpperCase()}_ARTIFACT`
  if (typeof process.env[envName] === 'string' && process.env[envName].length > 0) return process.env[envName]
  return null
}

async function materializeProfileArtifact(id, artifactPath, workRoot) {
  if (await pathExists(artifactPath) !== true) {
    throw new Error(`${id} artifact path does not exist: ${artifactPath}`)
  }
  const root = join(workRoot, `${id}-artifact`)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const info = await stat(artifactPath)
  if (info.isDirectory()) {
    await cp(artifactPath, root, { recursive: true })
    return root
  }
  // Version-pinned platform archive: extract into an isolated source root.
  await execFileAsync(tarCommand(), ['-xzf', artifactPath, '-C', root], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  return root
}

async function assertPinnedVersion(id, sourceRoot, pluginRelative, pins) {
  const expected = pins?.sources?.[id]?.expectedVersion
  const override = process.env[`AGENT_HOST_${id.replaceAll('-', '_').toUpperCase()}_VERSION`]
  const requiredVersion = override || expected
  if (requiredVersion === undefined || requiredVersion === null || requiredVersion === '') return
  const versionFile = join(sourceRoot, pluginRelative, '.codex-plugin/plugin.json')
  if (await pathExists(versionFile) !== true) {
    throw new Error(`${id} is missing ${pluginRelative}/.codex-plugin/plugin.json while a pinned version was required`)
  }
  const plugin = JSON.parse(await readFile(versionFile, 'utf8'))
  if (plugin.version !== requiredVersion) {
    throw new Error(`${id} source version ${plugin.version} does not match pinned ${requiredVersion}`)
  }
}

export { buildWorkspacePackage, importGithubTools, buildRequiredProfileTool, resolveProfileSource, resolveProfileArtifact, readSourcePins, REQUIRED_RELEASE_COMPONENTS, installProductionDependencies, removeLinks }

export async function main() {
const output = resolve(argument('--output', join(suiteRoot, '.build/unsigned-catalog')))
const githubTools = argument('--github-tools')
const platform = currentReleasePlatform(osPlatform(), arch())
const pkg = JSON.parse(await readFile(join(suiteRoot, 'package.json'), 'utf8'))
const workRoot = join(output, `.work-${process.pid}`)
const artifactRoot = join(output, 'artifacts')
await rm(output, { recursive: true, force: true })
await mkdir(artifactRoot, { recursive: true, mode: 0o755 })
await mkdir(workRoot, { recursive: true, mode: 0o700 })
try {
  const pins = await readSourcePins()
  const components = [
    await buildNode(workRoot, artifactRoot, platform),
    await buildWorkspacePackage({
      id: 'direct-execution-runtime',
      kind: 'direct-runtime',
      source: join(suiteRoot, 'packages/direct-execution-runtime'),
      entrypoint: 'src/cli.mjs',
      title: 'Direct Execution Runtime',
      workRoot,
      artifactRoot,
      platform,
      installDependencies: true,
    }),
    await buildRequiredProfileTool({
      id: 'math-anchor',
      kind: 'math-anchor',
      sourceRoot: resolveProfileSource('math-anchor', 'calculator'),
      artifactPath: resolveProfileArtifact('math-anchor'),
      pins,
      pluginRelative: 'plugins/math-anchor',
      identityFiles: [
        'plugins/math-anchor/.codex-plugin/plugin.json',
        'plugins/math-anchor/.mcp.json',
        'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt', 'sbom.spdx.json',
      ],
      entrypoint: 'plugins/math-anchor/runtime/math-anchor-runtime/math-anchor-runtime',
      title: 'Math Anchor',
      workRoot,
      artifactRoot,
      platform,
    }),
    await buildRequiredProfileTool({
      id: 'migratory-time',
      kind: 'migratory-time',
      sourceRoot: resolveProfileSource('migratory-time', 'migratory-time'),
      artifactPath: resolveProfileArtifact('migratory-time'),
      pins,
      pluginRelative: 'plugins/migratory-time',
      identityFiles: [
        'plugins/migratory-time/.codex-plugin/plugin.json',
        'plugins/migratory-time/.mcp.json',
        'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt', 'sbom.spdx.json',
      ],
      entrypoint: 'plugins/migratory-time/server/index.mjs',
      title: 'Migratory Time',
      workRoot,
      artifactRoot,
      platform,
    }),
    await buildWorkspacePackage({
      id: 'agent-tool-observer',
      kind: 'agent-tool-observer',
      source: join(suiteRoot, 'packages/agent-tool-observer'),
      entrypoint: 'src/cli.mjs',
      title: 'Agent Tool Observer',
      workRoot,
      artifactRoot,
      platform,
      extraPaths: ['adapters', 'integrations'],
      extraIdentityFiles: [
        'adapters/claude-code-hooks.json',
        'adapters/claude-project-events.json',
        'adapters/codex-session-events.json',
        'adapters/deepseek-harness-session-events.json',
        'adapters/gemini-cli-otel.json',
        'adapters/github-copilot-cli-hooks.json',
        'adapters/zcode-model-io.json',
      ],
    }),
    await buildWorkspacePackage({
      id: 'context-surface-analyzer',
      kind: 'context-surface-analyzer',
      source: join(suiteRoot, 'packages/context-surface-analyzer'),
      entrypoint: 'src/cli.js',
      title: 'Context Surface Analyzer',
      workRoot,
      artifactRoot,
      platform,
    }),
    ...await importGithubTools(githubTools === undefined ? undefined : resolve(githubTools), artifactRoot, platform),
  ]
  const manifest = {
    schemaVersion: 'openadam.agent-host-release.v0.2',
    releaseId: `unsigned-preview-${pkg.version}`,
    suiteVersion: pkg.version,
    status: 'unsigned-preview',
    createdAt: new Date().toISOString(),
    platforms: [platform],
    components,
  }
  validateReleaseManifest(manifest)
  const missingRequired = REQUIRED_RELEASE_COMPONENTS.filter((id) => !manifest.components.some((item) => item.id === id))
  if (missingRequired.length > 0) {
    throw new Error(`unsigned preview catalog is incomplete; missing required components: ${missingRequired.join(', ')}`)
  }
  await writeJson(join(output, 'current.json'), manifest)
  const revision = await gitRevision()
  await writeJson(join(output, 'build-provenance.json'), {
    schemaVersion: 'openadam.agent-host-build-provenance.v0.1',
    policy: 'local-development',
    releaseId: manifest.releaseId,
    suiteVersion: pkg.version,
    createdAt: manifest.createdAt,
    sources: {
      suite: {
        repository: 'https://github.com/tetracoralla/agent-host-suite.git',
        revision,
        dirty: true,
        sourcePolicy: 'local-development',
      },
    },
    reusedComponents: [],
    distributionBoundary: 'local-build-only-not-a-remote-confirmed-distribution',
  })
  process.stdout.write(`${JSON.stringify({ status: 'ok', catalog: output, components: components.map((item) => item.id) }, null, 2)}\n`)
} finally {
  await rm(workRoot, { recursive: true, force: true }).catch(() => {})
}
}

const invokedAsCli = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (invokedAsCli) {
  await main()
}
