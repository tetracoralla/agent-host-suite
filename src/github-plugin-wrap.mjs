import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { AgentHostError } from './errors.mjs'
import { archiveListingLines } from './archive-member-path.mjs'
import {
  extractVerifiedProviderPluginArchive,
  inspectProviderPluginArchive,
} from './provider-plugin-archive.mjs'
import { MAX_COMPONENT_DESCRIPTOR_BYTES } from './release-artifacts.mjs'
import { probeMcpTools } from './mcp-health.mjs'
import {
  buildToolIntegration,
  existingPluginFile,
  inferArchiveRoot,
  inspectGitHubPluginRoot,
} from './github-plugin-contract.mjs'
import { bindPresentationLogo, logoMediaType, sanitizeSvg, LOGO_MAX_BYTES } from './tool-presentation.mjs'
import { runFile } from './process.mjs'
import { integrationRelativePath } from './tool-integration.mjs'

const execFileAsync = promisify(execFile)
const COMPONENT_SCHEMA = 'openadam.agent-host-component.v0.2'

function fail(code, message, details) {
  throw new AgentHostError(code, message, details)
}

function tarCommand() {
  return process.platform === 'win32' ? 'tar.exe' : '/usr/bin/tar'
}

async function sha256File(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return `sha256:${hash.digest('hex')}`
}

async function inventory(root) {
  const files = []
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      const info = await lstat(path)
      if (info.isSymbolicLink()) fail('GITHUB_PLUGIN_INVALID', `Wrapped component contains a link: ${relative(root, path)}`)
      if (info.isDirectory()) await walk(path)
      else if (info.isFile() && relative(root, path) !== 'component.json') {
        files.push({
          path: relative(root, path).split(sep).join('/'),
          sha256: await sha256File(path),
          bytes: info.size,
          executable: (info.mode & 0o111) !== 0,
        })
      } else if (!info.isFile()) fail('GITHUB_PLUGIN_INVALID', `Wrapped component contains a special file: ${relative(root, path)}`)
    }
  }
  await walk(root)
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

async function writeText(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, value, { mode: 0o600 })
}

async function copyTree(source, destination) {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await cp(source, destination, {
    recursive: true,
    verbatimSymlinks: true,
    filter: async (path) => {
      const info = await lstat(path)
      if (info.isSymbolicLink()) fail('GITHUB_PLUGIN_INVALID', 'Plugin archive may not contain symbolic links')
      if (!info.isFile() && !info.isDirectory()) fail('GITHUB_PLUGIN_INVALID', 'Plugin archive may not contain special files')
      return true
    },
  })
}

function sbom(id, version, license, origin) {
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `${id}-${version}`,
    documentNamespace: `https://openadam.dev/spdx/github-wrap/${encodeURIComponent(id)}/${encodeURIComponent(version)}/${origin?.assetSha256?.slice(7, 23) ?? 'local'}`,
    creationInfo: {
      created: '2000-01-01T00:00:00.000Z',
      creators: ['Tool: Agent Host GitHub plugin wrap'],
    },
    packages: [{
      SPDXID: 'SPDXRef-RootPackage',
      name: id,
      versionInfo: version,
      downloadLocation: origin?.assetUrl ?? 'NOASSERTION',
      licenseConcluded: license,
      licenseDeclared: license,
      filesAnalyzed: false,
    }],
  }
}

async function probeExtractedPlugin(contract, extractedRoot, nodeCommand) {
  const command = contract.executor === 'suite-node'
    ? (nodeCommand ?? process.execPath)
    : join(extractedRoot, contract.command)
  const args = contract.executor === 'suite-node'
    ? [join(extractedRoot, contract.command), ...contract.args]
    : contract.args
  return probeMcpTools({
    command,
    args,
    cwd: extractedRoot,
    expectedTools: contract.expectedTools,
    healthTimeoutMs: 20000,
    displayName: contract.presentation.displayName,
  })
}

async function logoRecord(pluginRootRelative, extractedRoot, presentation, fileSet) {
  const candidate = presentation.logoPath
  if (typeof candidate !== 'string') return presentation
  const relative = candidate.replace(/^\.\//u, '')
  const absolute = join(extractedRoot, relative)
  const info = await stat(absolute).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (info === null || !info.isFile() || info.size < 1 || info.size > LOGO_MAX_BYTES) {
    const { logoPath: _ignored, ...rest } = presentation
    return rest
  }
  const mediaType = logoMediaType(relative)
  if (mediaType === null) {
    const { logoPath: _ignored, ...rest } = presentation
    return rest
  }
  const bytes = await readFile(absolute)
  if (mediaType === 'image/svg+xml') {
    try {
      sanitizeSvg(bytes.toString('utf8'))
    } catch {
      const { logoPath: _ignored, ...rest } = presentation
      return rest
    }
  }
  return bindPresentationLogo(presentation, {
    pluginRoot: pluginRootRelative,
    files: fileSet,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    bytes: info.size,
    mediaType,
  })
}

export async function wrapGitHubPluginArchive({
  archivePath,
  expectedSha256,
  origin,
  expectedTools,
  expectedComponentId,
  expectedVersion,
  pluginPath,
  nodeCommand,
  probe = true,
  runner = runFile,
  workRoot,
  outputPath,
}) {
  const listing = await runner(tarCommand(), ['-tzf', archivePath], { timeoutMs: 15_000, maxBuffer: 4 * 1024 * 1024 })
  const entries = archiveListingLines(listing.stdout)
  const expectedRoot = inferArchiveRoot(entries)
  await inspectProviderPluginArchive({
    archivePath,
    expectedRoot,
    label: origin?.repository ?? 'GitHub plugin',
    runner,
    targetFilesystem: 'portable-case-sensitive',
  })
  const parent = workRoot ?? await mkdtemp(join(tmpdir(), 'agent-host-github-wrap-'))
  const archiveWork = join(parent, 'provider')
  const stage = join(parent, 'component')
  const ownsParent = workRoot === undefined
  try {
    const extracted = await extractVerifiedProviderPluginArchive({
      sourceArchive: archivePath,
      archiveWork,
      expectedRoot,
      expectedSha256,
      label: origin?.repository ?? 'GitHub plugin',
      runner,
      targetFilesystem: 'portable-case-sensitive',
    })
    const pluginSource = pluginPath === undefined ? extracted.extractedRoot
      : join(extracted.extractedRoot, integrationRelativePath(pluginPath, 'repository plugin path'))
    const contract = await inspectGitHubPluginRoot(pluginSource)
    if (expectedVersion !== undefined && contract.version !== expectedVersion) fail('GITHUB_TOOL_IDENTITY_DRIFT', 'Plugin version differs from its catalog pin')
    if (typeof expectedComponentId === 'string'
      && expectedComponentId.length > 0
      && contract.id !== expectedComponentId) {
      fail('GITHUB_TOOL_IDENTITY_DRIFT', `Update target ${expectedComponentId} does not match component id ${contract.id}`, {
        target: expectedComponentId,
        componentId: contract.id,
        repository: origin?.repository ?? null,
        tag: origin?.tag ?? null,
      })
    }
    let tools = expectedTools ?? contract.expectedTools
    let health = null
    if (probe === true || tools.length === 0) {
      health = await probeExtractedPlugin(contract, pluginSource, nodeCommand)
      if (tools.length === 0) tools = health.tools
      const missing = tools.filter((name) => !health.tools.includes(name))
      if (missing.length > 0) {
        fail('TOOL_HEALTH_TOOLS_MISSING', `${contract.presentation.displayName} did not expose its expected tools`, { missing })
      }
    }
    const pluginRootRelative = `marketplace/plugins/${contract.id}`
    const pluginDest = join(stage, pluginRootRelative)
    await copyTree(pluginSource, pluginDest)
    const marketplace = `${contract.id}-github`
    await writeJson(join(stage, 'marketplace/.agents/plugins/marketplace.json'), {
      name: marketplace,
      interface: { displayName: contract.presentation.displayName },
      plugins: [{
        name: contract.id,
        source: { source: 'local', path: `./plugins/${contract.id}` },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Productivity',
      }],
    })
    const licenseName = await existingPluginFile(pluginSource, ['LICENSE', 'LICENSE.txt', 'LICENSE.md'])
    const noticeName = await existingPluginFile(pluginSource, ['NOTICE', 'NOTICE.txt'])
    const thirdPartyName = await existingPluginFile(pluginSource, [
      'THIRD_PARTY_NOTICES.txt', 'THIRD_PARTY_NOTICES.md', 'legal/THIRD_PARTY_NOTICES.txt',
    ])
    if (licenseName === null) fail('GITHUB_PLUGIN_INVALID', 'Plugin archive is missing a LICENSE file')
    await copyTree(join(pluginSource, licenseName), join(stage, 'LICENSE'))
    if (noticeName === null) {
      await writeText(join(stage, 'NOTICE'), `${contract.presentation.displayName} ${contract.version}\n\nThis Agent Host component wraps the upstream GitHub plugin archive without modifying plugin bytes.\n`)
    } else {
      await copyTree(join(pluginSource, noticeName), join(stage, 'NOTICE'))
    }
    if (thirdPartyName === null) {
      await writeText(join(stage, 'THIRD_PARTY_NOTICES.txt'), `# Third-Party Notices\n\n${contract.presentation.displayName} declares no separately bundled third-party package notices in this integration artifact.\n`)
    } else {
      await copyTree(join(pluginSource, thirdPartyName), join(stage, 'THIRD_PARTY_NOTICES.txt'))
    }
    await writeJson(join(stage, 'sbom.spdx.json'), sbom(contract.id, contract.version, contract.licenseSpdx, origin))
    const files = await inventory(stage)
    const fileSet = new Set(files.map((item) => item.path))
    const presentation = await logoRecord(pluginRootRelative, pluginSource, contract.presentation, new Set([
      ...contract.files,
      ...[...fileSet].map((path) => path.startsWith(`${pluginRootRelative}/`) ? path.slice(pluginRootRelative.length + 1) : path),
    ]))
    delete presentation.logoPath
    if (presentation.logo !== undefined) {
      const wrappedLogo = files.find((item) => item.path === `${pluginRootRelative}/${presentation.logo.path}` || item.path === presentation.logo.path)
      if (wrappedLogo !== undefined) {
        presentation.logo = {
          ...presentation.logo,
          path: wrappedLogo.path,
          sha256: wrappedLogo.sha256,
          bytes: wrappedLogo.bytes,
        }
      }
    }
    const integration = buildToolIntegration(contract, {
      pluginRoot: pluginRootRelative,
      marketplace,
      expectedTools: tools,
      discoveryLauncher: `scripts/${contract.id}`,
    })
    const identityFiles = [
      'marketplace/.agents/plugins/marketplace.json',
      ...integration.codex.identityFiles.map((path) => `${pluginRootRelative}/${path}`),
      'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt', 'sbom.spdx.json',
    ]
    const descriptor = {
      schemaVersion: COMPONENT_SCHEMA,
      id: contract.id,
      version: contract.version,
      kind: 'agent-tool',
      files,
      identityFiles,
      entrypoints: { mcp: integration.runtime.command },
      integration,
      presentation,
      ...(origin === undefined ? {} : { origin }),
      legal: { license: 'LICENSE', notice: 'NOTICE', thirdPartyNotices: 'THIRD_PARTY_NOTICES.txt', sbom: 'sbom.spdx.json' },
    }
    const descriptorPath = join(stage, 'component.json')
    const descriptorText = `${JSON.stringify(descriptor)}\n`
    if (Buffer.byteLength(descriptorText) > MAX_COMPONENT_DESCRIPTOR_BYTES) {
      fail('COMPONENT_DESCRIPTOR_LIMIT', 'Wrapped component.json exceeds the shared descriptor size bound', {
        bytes: Buffer.byteLength(descriptorText),
        maximumBytes: MAX_COMPONENT_DESCRIPTOR_BYTES,
      })
    }
    await mkdir(dirname(descriptorPath), { recursive: true })
    await writeFile(descriptorPath, descriptorText, { mode: 0o600 })
    const stagedArchive = join(parent, `${contract.id}-${contract.version}-host-component.tar.gz`)
    // Prefer a reproducible wrap so lost-cache re-acquires match historical digests when possible.
    // Upstream identity remains the release asset digest; local wrap digest is rebound on cache miss.
    const deterministicArgs = process.platform === 'win32'
      ? ['-czf', stagedArchive, '-C', stage, '.']
      : ['--mtime=1970-01-01T00:00:00Z', '--owner=0', '--group=0', '--numeric-owner', '--sort=name', '-czf', stagedArchive, '-C', stage, '.']
    try {
      await execFileAsync(tarCommand(), deterministicArgs, {
        env: { ...process.env, COPYFILE_DISABLE: '1', TAR_OPTIONS: '' },
      })
    } catch {
      await execFileAsync(tarCommand(), ['-czf', stagedArchive, '-C', stage, '.'], {
        env: { ...process.env, COPYFILE_DISABLE: '1' },
      })
    }
    const wrappedPath = outputPath ?? join(await mkdtemp(join(tmpdir(), 'agent-host-github-component-')), basename(stagedArchive))
    await mkdir(dirname(wrappedPath), { recursive: true, mode: 0o700 })
    await rename(stagedArchive, wrappedPath)
    const wrappedInfo = await stat(wrappedPath)
    const wrappedSha256 = await sha256File(wrappedPath)
    const upstreamSha256 = expectedSha256 ?? await sha256File(archivePath)
    const upstreamBytes = (await stat(archivePath)).size
    return {
      contract,
      descriptor,
      presentation,
      health,
      wrapped: {
        path: wrappedPath,
        sha256: wrappedSha256,
        bytes: wrappedInfo.size,
      },
      upstream: {
        sha256: upstreamSha256,
        bytes: upstreamBytes,
        archiveRoot: expectedRoot,
      },
      origin,
    }
  } finally {
    if (ownsParent) await rm(parent, { recursive: true, force: true }).catch(() => {})
  }
}
