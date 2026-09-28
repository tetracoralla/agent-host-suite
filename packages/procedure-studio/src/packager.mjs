import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { pipeline } from 'node:stream/promises'
import { previewLocalComponent } from '../../../src/local-components.mjs'
import { currentReleasePlatformOrLocal, validateComponentDescriptor } from '../../../src/release-manifest.mjs'
import { relativeProjectPath, resolveContained, studioError } from './validation.mjs'

const execFileAsync = promisify(execFile)
const LEGAL = {
  license: 'LICENSE',
  notice: 'NOTICE',
  thirdPartyNotices: 'THIRD_PARTY_NOTICES.txt',
  sbom: 'sbom.spdx.json',
}

async function digest(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return `sha256:${hash.digest('hex')}`
}

async function sourceFile(root, path) {
  const requested = resolveContained(root, path, `Package file ${path}`)
  const info = await lstat(requested).catch(() => null)
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw studioError('STUDIO_PACKAGE_SOURCE_INVALID', `Package source must be one regular contained file: ${path}`)
  }
  if (info.size > 16 * 1024 * 1024) {
    throw studioError('STUDIO_PACKAGE_SOURCE_INVALID', `Package source exceeds 16 MiB: ${path}`)
  }
  return requested
}

async function inventory(root, paths) {
  const output = []
  for (const path of [...paths].sort()) {
    const absolute = join(root, path)
    const info = await stat(absolute)
    output.push({ path, sha256: await digest(absolute), bytes: info.size, executable: false })
  }
  return output
}

async function copySources(project, stage, paths) {
  for (const path of paths) {
    const source = await sourceFile(project.root, path)
    const target = join(stage, path)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await copyFile(source, target)
    await chmod(target, 0o600)
  }
}

function releaseDescriptor(project, files, identityFiles) {
  const integration = structuredClone(project.document.integration)
  return {
    schemaVersion: 'openadam.agent-host-component.v0.3',
    id: project.config.componentId,
    version: integration.procedure.version,
    kind: 'procedure',
    files,
    identityFiles,
    entrypoints: {},
    presentation: {
      displayName: integration.displayName,
      summary: integration.summary,
      author: project.config.author,
      license: project.config.licenseSpdx,
    },
    integration,
    legal: LEGAL,
  }
}

function validationReleaseComponent(project, descriptor) {
  return {
    id: descriptor.id,
    version: descriptor.version,
    platform: currentReleasePlatformOrLocal(),
    artifact: { url: 'file:///pending.tar.gz', sha256: `sha256:${'0'.repeat(64)}`, bytes: 1, format: 'tar.gz' },
    descriptorSha256: `sha256:${'0'.repeat(64)}`,
    license: { spdx: project.config.licenseSpdx, files: [LEGAL.license, LEGAL.notice, LEGAL.thirdPartyNotices] },
  }
}

export async function packageProject(project) {
  if (!project.validation.valid) {
    throw studioError('STUDIO_VALIDATION_FAILED', 'Fix validation errors before packaging', { diagnostics: project.validation.diagnostics })
  }
  const integrationPath = relativeProjectPath(project.root, project.paths.integration)
  const productPaths = new Set([
    integrationPath,
    project.document.integration.procedure.inputSchema,
    project.document.integration.procedure.outputSchema,
    project.document.integration.execution.method,
    ...(project.document.integration.execution.identityFiles ?? []),
    ...Object.values(LEGAL),
  ])
  const identityFiles = [...new Set([
    integrationPath,
    project.document.integration.procedure.inputSchema,
    project.document.integration.procedure.outputSchema,
    project.document.integration.execution.method,
    ...(project.document.integration.execution.identityFiles ?? []),
  ])].sort()
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'procedure-studio-package-'))
  const stage = join(temporaryRoot, 'component')
  try {
    await mkdir(stage, { recursive: true, mode: 0o700 })
    await copySources(project, stage, productPaths)
    const files = await inventory(stage, productPaths)
    const descriptor = releaseDescriptor(project, files, identityFiles)
    validateComponentDescriptor(descriptor, validationReleaseComponent(project, descriptor))
    const descriptorPath = join(stage, 'component.json')
    await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 })
    const platform = currentReleasePlatformOrLocal()
    const archiveName = `${descriptor.id}-${descriptor.version}-${platform}.tar.gz`
    const temporaryArchive = join(temporaryRoot, archiveName)
    await execFileAsync(process.platform === 'win32' ? 'tar.exe' : '/usr/bin/tar', ['-czf', temporaryArchive, '-C', stage, '.'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
      maxBuffer: 1024 * 1024,
    })
    const outputRoot = project.config.paths.output
    await mkdir(outputRoot, { recursive: true, mode: 0o700 })
    const destination = resolve(outputRoot, archiveName)
    const relation = relative(outputRoot, destination)
    if (relation.startsWith(`..${sep}`) || relation === '..') throw studioError('STUDIO_PACKAGE_OUTPUT_INVALID', 'Package output escapes its configured directory')
    const pending = join(outputRoot, `.${basename(archiveName)}.${process.pid}.tmp`)
    await copyFile(temporaryArchive, pending)
    await rename(pending, destination)
    const preview = await previewLocalComponent({
      artifact: destination,
      licenseSpdx: project.config.licenseSpdx,
      standalone: true,
    })
    const archiveInfo = await stat(destination)
    return {
      schemaVersion: 'openadam.procedure-studio-package-result.v0.1',
      status: 'ready',
      artifact: {
        path: destination,
        sha256: await digest(destination),
        bytes: archiveInfo.size,
      },
      descriptorSha256: await digest(descriptorPath),
      preview,
      effects: {
        sourceSaved: true,
        formalAgentHostStateChanged: false,
        published: false,
      },
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

export async function readPackagedDescriptor(artifactPath) {
  const { stdout } = await execFileAsync(process.platform === 'win32' ? 'tar.exe' : '/usr/bin/tar', ['-xOzf', artifactPath, './component.json'], { maxBuffer: 1024 * 1024 })
  return JSON.parse(stdout)
}
