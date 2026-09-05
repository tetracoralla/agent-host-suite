import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { cp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { arch, platform } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { stageBundledReleaseCatalogForProfiles } from '../src/bundled-release.mjs'
import { currentReleasePlatform, loadReleaseManifest } from '../src/release-manifest.mjs'
import { loadBuildProvenance } from '../src/release-provenance.mjs'

const execFileAsync = promisify(execFile)
const suiteRoot = fileURLToPath(new URL('../', import.meta.url))

function fail(message) {
  throw new Error(message)
}

function portablePath(root, path) {
  return relative(root, path).split(sep).join('/')
}

async function digest(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

async function inventory(root, current = root) {
  const output = []
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name)
    const info = await stat(path)
    if (entry.isSymbolicLink()) fail(`Windows payload contains a symbolic link: ${portablePath(root, path)}`)
    if (entry.isDirectory()) output.push(...await inventory(root, path))
    else if (entry.isFile()) output.push({ path: portablePath(root, path), bytes: info.size, sha256: await digest(path) })
    else fail(`Windows payload contains a special file: ${portablePath(root, path)}`)
  }
  return output.sort((left, right) => left.path.localeCompare(right.path))
}

async function locateNodeLicense() {
  const executable = await realpath(process.execPath)
  const candidates = [
    join(dirname(executable), 'LICENSE'),
    join(dirname(dirname(executable)), 'LICENSE'),
  ]
  for (const candidate of candidates) {
    const info = await stat(candidate).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (info?.isFile()) return candidate
  }
  fail('The bundled Node.js license was not found beside the Node.js runtime')
}

async function writeLauncher(path, argumentsList) {
  const quoted = argumentsList.map((value) => `"${String(value)}"`).join(' ')
  await writeFile(path, `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${quoted} %*\r\n`, 'utf8')
}

async function run() {
  if (platform() !== 'win32') fail('package:windows must run on Windows so the payload contains a genuine Windows Node.js runtime')
  const releaseCatalog = process.env.AGENT_HOST_RELEASE_CATALOG
  if (!releaseCatalog) fail('AGENT_HOST_RELEASE_CATALOG must name one bound Windows release catalog')
  const profiles = (process.env.AGENT_HOST_BUNDLED_PROFILES ?? 'standard,observability,developer')
    .split(',').map((value) => value.trim()).filter(Boolean)
  const targetPlatform = currentReleasePlatform()
  if (!['win32-x64', 'win32-arm64'].includes(targetPlatform)) fail(`Unsupported Windows packaging architecture: ${arch()}`)

  const sourceCatalog = resolve(releaseCatalog)
  const release = await loadReleaseManifest(join(sourceCatalog, 'current.json'))
  if (release.manifest.status === 'draft-unbound') fail('A Windows application cannot be built from the draft-unbound catalog')
  if (!release.manifest.platforms.includes(targetPlatform)) fail(`The release catalog does not declare ${targetPlatform}`)
  const provenancePath = join(sourceCatalog, 'build-provenance.json')
  const { record: sourceProvenance } = await loadBuildProvenance(provenancePath, release.manifest)
  if (sourceProvenance.policy !== 'remote-tagged' && process.env.AGENT_HOST_ALLOW_LOCAL_SOURCE_DISTRIBUTION !== '1') {
    fail(`Windows distribution requires remote-tagged source provenance; received ${sourceProvenance.policy}`)
  }
  const sourceProvenanceSha256 = `sha256:${await digest(provenancePath)}`

  const packageJson = JSON.parse(await readFile(join(suiteRoot, 'package.json'), 'utf8'))
  if (release.manifest.suiteVersion !== packageJson.version) {
    fail(`Release suite version ${release.manifest.suiteVersion} differs from package version ${packageJson.version}`)
  }
  const buildRoot = resolve(process.env.AGENT_HOST_WINDOWS_BUILD_ROOT ?? join(suiteRoot, '.build', 'windows'))
  const workRoot = join(buildRoot, `work-${process.pid}`)
  const distributionRoot = join(buildRoot, 'distribution')
  const bundleName = `Agent-Host-${packageJson.version}-${targetPlatform}`
  const bundleRoot = join(workRoot, bundleName)
  const payloadRoot = join(bundleRoot, 'payload')
  const npmRoot = join(workRoot, 'npm')
  const packRoot = join(workRoot, 'pack')
  const stagedCatalog = join(workRoot, 'catalog')
  const npmExecPath = process.env.npm_execpath
  if (!npmExecPath) fail('npm_execpath is required; run this through npm run package:windows')

  await rm(workRoot, { recursive: true, force: true })
  await mkdir(packRoot, { recursive: true })
  await rm(distributionRoot, { recursive: true, force: true })
  await mkdir(distributionRoot, { recursive: true })
  try {
    await stageBundledReleaseCatalogForProfiles(sourceCatalog, stagedCatalog, profiles)
    const packed = await execFileAsync(process.execPath, [npmExecPath, 'pack', '--json', '--pack-destination', packRoot], {
      cwd: suiteRoot,
      maxBuffer: 8 * 1024 * 1024,
    })
    const report = JSON.parse(packed.stdout)[0]
    const packagePath = join(packRoot, report.filename)
    await execFileAsync(process.execPath, [npmExecPath, 'install', '--prefix', npmRoot, '--omit=dev', '--ignore-scripts', packagePath], {
      maxBuffer: 8 * 1024 * 1024,
    })

    const installedSuite = join(npmRoot, 'node_modules', '@openadam', 'agent-host-suite')
    await cp(installedSuite, join(payloadRoot, 'app'), { recursive: true, dereference: true })
    await cp(join(npmRoot, 'node_modules'), join(payloadRoot, 'app', 'node_modules'), { recursive: true, dereference: true })
    await rm(join(payloadRoot, 'app', 'node_modules', '@openadam', 'agent-host-suite'), { recursive: true, force: true })
    await rm(join(payloadRoot, 'app', 'catalog', 'releases'), { recursive: true, force: true })
    await cp(stagedCatalog, join(payloadRoot, 'app', 'catalog', 'releases'), { recursive: true, dereference: true })

    await mkdir(join(payloadRoot, 'runtime'), { recursive: true })
    await mkdir(join(payloadRoot, 'bin'), { recursive: true })
    await cp(await realpath(process.execPath), join(payloadRoot, 'runtime', 'node.exe'))
    await cp(await locateNodeLicense(), join(payloadRoot, 'runtime', 'LICENSE.node.txt'))
    await cp(join(suiteRoot, 'windows', 'Install-AgentHost.ps1'), join(payloadRoot, 'Install-AgentHost.ps1'))
    await cp(join(suiteRoot, 'windows', 'Uninstall-AgentHost.ps1'), join(payloadRoot, 'Uninstall-AgentHost.ps1'))
    await writeLauncher(join(payloadRoot, 'bin', 'agent-host.cmd'), ['%~dp0..\\runtime\\node.exe', '%~dp0..\\app\\bin\\agent-host.mjs'])
    await writeLauncher(join(payloadRoot, 'bin', 'Agent Host.cmd'), ['%~dp0..\\runtime\\node.exe', '%~dp0..\\app\\bin\\agent-host.mjs', 'manager'])

    const payloadFiles = await inventory(payloadRoot)
    const payloadManifest = {
      schemaVersion: 'openadam.agent-host-windows-payload.v0.1',
      suiteVersion: packageJson.version,
      releaseId: release.manifest.releaseId,
      platform: targetPlatform,
      profiles,
      sourceProvenance: {
        policy: sourceProvenance.policy,
        file: 'app/catalog/releases/build-provenance.json',
        sha256: sourceProvenanceSha256,
      },
      files: payloadFiles,
    }
    const payloadManifestText = `${JSON.stringify(payloadManifest, null, 2)}\n`
    await writeFile(join(payloadRoot, 'install-manifest.json'), payloadManifestText)
    await writeFile(join(bundleRoot, 'payload-manifest.json'), payloadManifestText)
    await cp(join(suiteRoot, 'windows', 'Install-AgentHost.ps1'), join(bundleRoot, 'Install-AgentHost.ps1'))
    await cp(join(suiteRoot, 'windows', 'Uninstall-AgentHost.ps1'), join(bundleRoot, 'Uninstall-AgentHost.ps1'))
    await cp(join(suiteRoot, 'windows', 'Install Agent Host.cmd'), join(bundleRoot, 'Install Agent Host.cmd'))

    const archivePath = join(distributionRoot, `${bundleName}.zip`)
    await execFileAsync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', 'Compress-Archive -LiteralPath $args[0] -DestinationPath $args[1] -CompressionLevel Optimal',
      bundleRoot, archivePath,
    ], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
    const archiveInfo = await stat(archivePath)
    const archiveSha256 = await digest(archivePath)
    await writeFile(join(distributionRoot, 'SHA256SUMS'), `${archiveSha256}  ${basename(archivePath)}\n`)
    await writeFile(join(distributionRoot, `${bundleName}.json`), `${JSON.stringify({
      schemaVersion: 'openadam.agent-host-windows-distribution.v0.1',
      suiteVersion: packageJson.version,
      releaseId: release.manifest.releaseId,
      platform: targetPlatform,
      profiles,
      sourceProvenance: {
        policy: sourceProvenance.policy,
        file: 'payload/app/catalog/releases/build-provenance.json',
        sha256: sourceProvenanceSha256,
      },
      archive: { file: basename(archivePath), bytes: archiveInfo.size, sha256: `sha256:${archiveSha256}` },
      installScope: 'current-user',
      codeSigning: 'unsigned',
    }, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify({ status: 'ok', archivePath, bytes: archiveInfo.size, sha256: archiveSha256, platform: targetPlatform, profiles })}\n`)
  } finally {
    await rm(workRoot, { recursive: true, force: true })
  }
}

await run()
