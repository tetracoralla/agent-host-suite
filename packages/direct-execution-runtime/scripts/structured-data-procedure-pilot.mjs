import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { basename, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { digestFile, digestJson, jsonBytes, parseStrictJson } from '../src/json.mjs'
import { inspectProviderArtifactBytes, resolvePilotWorkspace } from './local-pilot-paths.mjs'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const workspace = resolvePilotWorkspace(root)
const procedureRoot = resolve(workspace, 'structured-data-preflight')
const procedureProfilePath = resolve(
  workspace,
  'procedure-contracts/catalog/procedures/structured-data-preflight.v0.3.json',
)
const sourceManifestPath = resolve(procedureRoot, 'procedure/implementation-manifest.json')
const sourceSchemaRoot = resolve(procedureRoot, 'src/structured_data_preflight/schemas')
const profileSchemaRoot = resolve(workspace, 'procedure-contracts/catalog/procedures/schemas')

export const verifyDirectory = resolve(root, '.verify')

const limits = {
  maxConcurrentCalls: 4,
  maxQueuedCalls: 16,
  maxWorkOrderCalls: 32,
  maxWorkOrderBytes: 1024 * 1024,
  maxProviderResponseBytes: 512 * 1024,
  maxResultBytes: 2 * 1024 * 1024,
  maxProtocolLineBytes: 1024 * 1024,
  maxStderrBytes: 64 * 1024,
  defaultTimeoutMs: 30_000,
  circuitBreakerFailureThreshold: 3,
  circuitBreakerCooldownMs: 250,
}

export function quantiles(samples) {
  const sorted = [...samples].sort((left, right) => left - right)
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))]
  return { samples: sorted.length, min: sorted[0], p50: at(0.5), p95: at(0.95), max: sorted.at(-1) }
}

async function findOnly(directory, expression, label) {
  const matches = (await readdir(directory))
    .filter((name) => expression.test(name))
    .map((name) => resolve(directory, name))
  if (matches.length !== 1) throw new Error(`expected one ${label}, found ${matches.length}`)
  return matches[0]
}

async function sourceSnapshot(repositoryRoot) {
  const [{ stdout: revision }, { stdout: status }] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot }),
    execFileAsync('git', ['status', '--short', '--untracked-files=all'], { cwd: repositoryRoot }),
  ])
  const dirty = []
  for (const line of status.split('\n').filter(Boolean)) {
    const state = line.slice(0, 2)
    const displayedPath = line.slice(3)
    const path = displayedPath.includes(' -> ') ? displayedPath.split(' -> ').at(-1) : displayedPath
    const contentDigest = await digestFile(resolve(repositoryRoot, path)).catch(() => null)
    if (!state.includes('D')) {
      assert.notEqual(contentDigest, null, `dirty source path is unavailable for hashing: ${path}`)
    }
    dirty.push({
      state,
      path,
      contentDigest,
    })
  }
  return { revision: revision.trim(), dirty }
}

async function writePythonEntrypoint(path, module) {
  await writeFile(path, [
    'import sys',
    'from pathlib import Path',
    'sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "site"))',
    `from ${module} import main`,
    "if __name__ == '__main__':",
    '    raise SystemExit(main())',
    '',
  ].join('\n'))
  await chmod(path, 0o600)
}

async function stageStandalonePython(bindingRoot) {
  const { stdout } = await execFileAsync('uv', ['python', 'find', '3.11'], {
    maxBuffer: 1024 * 1024,
  })
  const sourceInterpreter = await realpath(stdout.trim())
  const sourceRoot = resolve(sourceInterpreter, '../..')
  const runtimeRoot = resolve(bindingRoot, 'python')
  const interpreter = resolve(runtimeRoot, 'bin/python3.11')
  await mkdir(resolve(runtimeRoot, 'bin'), { recursive: true })
  await mkdir(resolve(runtimeRoot, 'lib'), { recursive: true })
  await Promise.all([
    copyFile(sourceInterpreter, interpreter),
    copyFile(resolve(sourceRoot, 'lib/libpython3.11.dylib'), resolve(runtimeRoot, 'lib/libpython3.11.dylib')),
    cp(resolve(sourceRoot, 'lib/python3.11'), resolve(runtimeRoot, 'lib/python3.11'), {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: true,
    }),
  ])
  await chmod(interpreter, 0o700)
  const { stdout: version } = await execFileAsync(
    interpreter,
    ['-I', '-c', 'import platform; print(platform.python_version())'],
  )
  assert.match(version.trim(), /^3\.11\./u)
  return { interpreter, root: runtimeRoot, version: version.trim() }
}

function requireCapabilityImplementation(manifest, expected) {
  assert.equal(manifest.provider?.id, expected.providerId)
  assert.equal(manifest.provider?.version, expected.providerVersion)
  const implementation = manifest.implementations?.find(
    (candidate) =>
      candidate.capabilityId === expected.capabilityId &&
      candidate.capabilityVersion === expected.capabilityVersion,
  )
  assert.ok(implementation, `Capability implementation is absent: ${expected.capabilityId}`)
  assert.equal(implementation.adapter?.protocol, 'openadam.capability-jsonl.v0.1')
  assert.deepEqual(
    implementation.adapterBindings.map((binding) => binding.operationId).sort(),
    [...expected.operationIds].sort(),
  )
  return implementation
}

export function providerConfig(bindingRoot, identityFiles, overrides = {}) {
  return {
    schemaVersion: 'openadam.direct-provider-config.v0.2',
    limits: { ...limits, ...(overrides.limits ?? {}) },
    providers: [{
      providerId: 'org.openadam.structured-data-preflight',
      transport: 'procedure-jsonl-v0.2',
      lifecycle: overrides.lifecycle ?? 'persistent',
      rootPath: bindingRoot,
      profilePath: resolve(bindingRoot, 'procedure-profile.json'),
      implementationManifestPath: resolve(bindingRoot, 'procedure/implementation-manifest.json'),
      identityFiles,
      procedureId: 'org.openadam.structured-data.preflight',
      procedureVersion: '0.3.0',
      inputSchemaPath: resolve(bindingRoot, 'schemas/structured-data.preflight.input.schema.json'),
      outputSchemaPath: resolve(bindingRoot, 'schemas/structured-data.preflight.output.schema.json'),
    }],
  }
}

export function procedureCall(id, input, timeoutMs) {
  const call = {
    id,
    providerId: 'org.openadam.structured-data-preflight',
    target: {
      kind: 'procedure',
      procedureId: 'org.openadam.structured-data.preflight',
      procedureVersion: '0.3.0',
    },
    input,
  }
  if (timeoutMs !== undefined) call.timeoutMs = timeoutMs
  return call
}

export function workOrder(id, calls) {
  return { schemaVersion: 'openadam.direct-work-order.v0.1', id, calls }
}

export function readyInput(validation) {
  const input = { path: 'fixtures/users.json', sample_rows: 1, select: 'data.users[*]' }
  if (validation !== undefined) input.validation = validation
  return input
}

export async function timedRun(runtime, order) {
  const started = performance.now()
  const result = await runtime.runWorkOrder(order)
  return { elapsedMs: performance.now() - started, result, resultBytes: jsonBytes(result) }
}

export async function processGroupMembers(processGroupId) {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,pgid='])
  return stdout.trim().split('\n').flatMap((line) => {
    const [pid, group] = line.trim().split(/\s+/u).map(Number)
    return group === processGroupId ? [pid] : []
  })
}

async function regularFilesUnder(root, current = root, output = []) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = resolve(current, entry.name)
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new Error(`frozen Procedure binding contains a symbolic link: ${path}`)
    if (info.isDirectory()) await regularFilesUnder(root, path, output)
    else if (info.isFile()) output.push(path)
    else throw new Error(`frozen Procedure binding contains a special file: ${path}`)
  }
  return output
}

async function createRuntimeArchive(bindingRoot, temporaryRoot, runtimeFiles) {
  const archive = resolve(bindingRoot, 'artifacts/structured-data-preflight-runtime.tar.gz')
  const temporaryTar = resolve(temporaryRoot, 'structured-data-preflight-runtime.tar')
  const fileList = resolve(temporaryRoot, 'structured-data-preflight-runtime.files')
  const normalizedTime = new Date('2000-01-01T00:00:00.000Z')
  const entries = runtimeFiles
    .map((path) => relative(bindingRoot, path))
    .sort((left, right) => left.localeCompare(right))
  for (const entry of entries) {
    assert.equal(entry.startsWith('../'), false, `runtime archive entry escapes binding root: ${entry}`)
    assert.equal(entry.includes('\n'), false, `runtime archive entry contains a newline: ${entry}`)
    await utimes(resolve(bindingRoot, entry), normalizedTime, normalizedTime)
  }
  await writeFile(fileList, `${entries.join('\n')}\n`)
  await execFileAsync('/usr/bin/tar', [
    '-cf', temporaryTar,
    '--format=ustar',
    '--uid', '0',
    '--gid', '0',
    '--uname', 'root',
    '--gname', 'wheel',
    '-C', bindingRoot,
    '-T', fileList,
  ], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    maxBuffer: 4 * 1024 * 1024,
  })
  await execFileAsync('/usr/bin/gzip', ['-n', '-f', temporaryTar], { maxBuffer: 4 * 1024 * 1024 })
  await rename(`${temporaryTar}.gz`, archive)
  await rm(fileList, { force: true })
  return { archive, entries: entries.length }
}

async function writeRuntimeLauncher(path, archiveName) {
  await writeFile(path, [
    '#!/bin/sh',
    'set -eu',
    'launcher_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)',
    'binding_root=$(CDPATH= cd -- "$launcher_dir/.." && pwd -P)',
    `archive="$binding_root/artifacts/${archiveName}"`,
    'runtime_root="$binding_root/.runtime"',
    'test ! -e "$runtime_root"',
    'mkdir "$runtime_root"',
    'COPYFILE_DISABLE=1 /usr/bin/tar -xzf "$archive" -C "$runtime_root"',
    'exec "$runtime_root/python/bin/python3.11" -I "$runtime_root/bin/sdp-procedure.py"',
    '',
  ].join('\n'))
  await chmod(path, 0o700)
}

function copiedIdentityFiles(artifact, copiedRoot) {
  return artifact.identityFiles.map((identity) => resolve(copiedRoot, identity.path))
}

export async function copyVerifiedProviderArtifact(artifact, copiedRoot) {
  await cp(artifact.root, copiedRoot, {
    recursive: true,
    force: false,
    errorOnExist: true,
    verbatimSymlinks: true,
  })
  const copyIdentity = await inspectProviderArtifactBytes(copiedRoot)
  assert.deepEqual(
    copyIdentity,
    artifact.copyIdentity,
    `${artifact.providerId} copied Provider bytes differ from the admitted artifact`,
  )
  return copyIdentity
}

export async function buildPackagedBinding(temporaryRoot, providerArtifacts) {
  const fileProviderArtifact = providerArtifacts['file-vitals-capability']
  const dataProviderArtifact = providerArtifacts['adt-capability']
  assert.ok(fileProviderArtifact, 'File Vitals release artifact is absent')
  assert.ok(dataProviderArtifact, 'BatchTicket release artifact is absent')
  const bindingRoot = resolve(temporaryRoot, 'binding')
  const artifacts = resolve(bindingRoot, 'artifacts')
  const commands = resolve(bindingRoot, 'bin')
  const providerRoot = resolve(bindingRoot, 'providers')
  const packagedFileRoot = resolve(providerRoot, 'file-vitals')
  const packagedDataRoot = resolve(providerRoot, 'data-transformer')
  const site = resolve(bindingRoot, 'site')
  await Promise.all([
    ...['artifacts', 'bin', 'providers', 'site', 'fixtures', 'procedure', 'schemas']
      .map((name) => mkdir(resolve(bindingRoot, name), { recursive: true })),
  ])

  const buildStarted = performance.now()
  const snapshotBefore = {
    procedureImplementation: await sourceSnapshot(procedureRoot),
    procedureProfile: await sourceSnapshot(resolve(workspace, 'procedure-contracts')),
    capabilityProfiles: await sourceSnapshot(resolve(workspace, 'capability-contracts')),
  }
  await execFileAsync('uv', [
    'build', '--offline', '--wheel', '--no-create-gitignore', '--out-dir', artifacts, procedureRoot,
  ], { maxBuffer: 4 * 1024 * 1024 })
  const pythonRuntime = await stageStandalonePython(bindingRoot)
  const fileProviderManifestPath = resolve(fileProviderArtifact.root, 'capabilities/provider.json')
  const dataProviderManifestPath = resolve(dataProviderArtifact.root, 'capabilities/provider.json')
  const [fileManifestText, dataManifestText] = await Promise.all([
    readFile(fileProviderManifestPath, 'utf8'),
    readFile(dataProviderManifestPath, 'utf8'),
  ])
  const fileManifest = parseStrictJson(fileManifestText, 'File Vitals Provider Manifest')
  const dataManifest = parseStrictJson(dataManifestText, 'BatchTicket Provider Manifest')
  const fileImplementation = requireCapabilityImplementation(fileManifest, {
    providerId: 'io.github.tetracoralla.file-vitals',
    providerVersion: '0.3.3',
    capabilityId: 'org.openadam.file.inspect',
    capabilityVersion: '0.1.0',
    operationIds: ['inspect'],
  })
  const dataImplementation = requireCapabilityImplementation(dataManifest, {
    providerId: 'io.github.tetracoralla.batchticket',
    providerVersion: '0.2.0',
    capabilityId: 'org.openadam.structured-data.analyze',
    capabilityVersion: '0.1.0',
    operationIds: ['inspect', 'validate'],
  })
  const procedureWheel = await findOnly(
    artifacts, /^structured_data_preflight-0\.1\.0-.*\.whl$/u, 'Structured Data Preflight wheel',
  )
  await execFileAsync('uv', [
    'pip', 'install', '--offline', '--python', pythonRuntime.interpreter, '--target', site, procedureWheel,
  ], { maxBuffer: 8 * 1024 * 1024 })
  const [fileProviderCopyIdentity, dataProviderCopyIdentity] = await Promise.all([
    copyVerifiedProviderArtifact(fileProviderArtifact, packagedFileRoot),
    copyVerifiedProviderArtifact(dataProviderArtifact, packagedDataRoot),
  ])
  const packagedFileBinary = resolve(packagedFileRoot, 'runtime/file-vitals-capability')
  const procedureEntrypoint = resolve(commands, 'sdp-procedure.py')
  await Promise.all([
    writePythonEntrypoint(procedureEntrypoint, 'structured_data_preflight.adapter'),
    copyFile(procedureProfilePath, resolve(bindingRoot, 'procedure-profile.json')),
    copyFile(resolve(procedureRoot, 'fixtures/users.json'), resolve(bindingRoot, 'fixtures/users.json')),
    copyFile(resolve(procedureRoot, 'fixtures/invalid.json'), resolve(bindingRoot, 'fixtures/invalid.json')),
    copyFile(
      resolve(sourceSchemaRoot, 'structured-data.preflight.input.schema.json'),
      resolve(bindingRoot, 'schemas/structured-data.preflight.input.schema.json'),
    ),
    copyFile(
      resolve(sourceSchemaRoot, 'structured-data.preflight.output.schema.json'),
      resolve(bindingRoot, 'schemas/structured-data.preflight.output.schema.json'),
    ),
    copyFile(
      resolve(profileSchemaRoot, 'structured-data.preflight.v0.1.input.schema.json'),
      resolve(bindingRoot, 'schemas/structured-data.preflight.v0.1.input.schema.json'),
    ),
    copyFile(
      resolve(profileSchemaRoot, 'structured-data.preflight.v0.1.output.schema.json'),
      resolve(bindingRoot, 'schemas/structured-data.preflight.v0.1.output.schema.json'),
    ),
  ])

  const manifest = parseStrictJson(
    await readFile(sourceManifestPath, 'utf8'),
    'Structured Data Preflight implementation manifest',
  )
  const implementation = manifest.implementations.find(
    (candidate) =>
      candidate.procedureId === 'org.openadam.structured-data.preflight' &&
      candidate.procedureVersion === '0.3.0',
  )
  assert.ok(implementation, 'current Procedure implementation is absent')
  const capabilityProviders = new Map([
    [fileManifest.provider.id, { manifest: fileManifest, implementation: fileImplementation }],
    [dataManifest.provider.id, { manifest: dataManifest, implementation: dataImplementation }],
  ])
  for (const stage of implementation.stages) {
    const provider = capabilityProviders.get(stage.provider.id)
    assert.ok(provider, `Procedure stage provider is not the rebuilt provider: ${stage.stageId}`)
    assert.equal(stage.provider.version, provider.manifest.provider.version)
    assert.equal(stage.capabilityId, provider.implementation.capabilityId)
    assert.equal(stage.capabilityVersion, provider.implementation.capabilityVersion)
    assert.equal(stage.transport, 'capability-jsonl')
    const adapterBinding = provider.implementation.adapterBindings.find(
      (binding) => binding.operationId === stage.operationId,
    )
    assert.ok(adapterBinding, `Procedure stage operation is absent from its provider: ${stage.stageId}`)
    assert.equal(stage.target, adapterBinding.target)
  }
  const runtimeFiles = [
    procedureEntrypoint,
    ...await regularFilesUnder(pythonRuntime.root),
    ...await regularFilesUnder(site),
  ]
  const runtimeArchive = await createRuntimeArchive(bindingRoot, temporaryRoot, runtimeFiles)
  const procedureLauncher = resolve(commands, 'structured-data-preflight')
  await writeRuntimeLauncher(procedureLauncher, basename(runtimeArchive.archive))
  await Promise.all([
    rm(pythonRuntime.root, { recursive: true, force: true }),
    rm(site, { recursive: true, force: true }),
    rm(procedureEntrypoint, { force: true }),
  ])
  implementation.adapter = {
    protocol: 'openadam.procedure-jsonl.v0.2',
    command: './bin/structured-data-preflight',
    args: [],
    cwd: '.',
  }
  await writeFile(
    resolve(bindingRoot, 'procedure/implementation-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )

  const identityFiles = [...new Set([
    procedureLauncher,
    runtimeArchive.archive,
    procedureWheel,
    ...copiedIdentityFiles(fileProviderArtifact, packagedFileRoot),
    ...copiedIdentityFiles(dataProviderArtifact, packagedDataRoot),
  ])]
  const providerIdentityFiles = {
    fileVitals: copiedIdentityFiles(fileProviderArtifact, packagedFileRoot),
    batchTicket: copiedIdentityFiles(dataProviderArtifact, packagedDataRoot),
  }
  const snapshotAfter = {
    procedureImplementation: await sourceSnapshot(procedureRoot),
    procedureProfile: await sourceSnapshot(resolve(workspace, 'procedure-contracts')),
    capabilityProfiles: await sourceSnapshot(resolve(workspace, 'capability-contracts')),
  }
  assert.deepEqual(snapshotAfter, snapshotBefore, 'Provider source changed while artifacts were being rebuilt')
  return {
    bindingRoot: await realpath(bindingRoot),
    runtimeArchiveRelativePath: relative(bindingRoot, runtimeArchive.archive),
    providerPathEntries: [
      resolve(packagedFileRoot, 'runtime'),
      resolve(packagedDataRoot, 'runtime'),
    ],
    providerIdentityFiles,
    identityFiles,
    stageBindings: implementation.stages.map((stage) => ({
      stageId: stage.stageId,
      capabilityId: stage.capabilityId,
      capabilityVersion: stage.capabilityVersion,
      operationId: stage.operationId,
      providerId: stage.provider.id,
      providerVersion: stage.provider.version,
      transport: stage.transport,
      target: stage.target,
    })),
    packageArtifacts: {
      procedureWheel: basename(procedureWheel),
      pythonRuntime: {
        version: pythonRuntime.version,
        provenance: 'uv-managed-standalone-runtime-copied-into-candidate-binding',
        archivedFiles: runtimeArchive.entries,
      },
      fileProviderBinary: basename(packagedFileBinary),
      providerManifestDigests: {
        fileVitals: digestJson(fileManifest),
        batchTicket: digestJson(dataManifest),
      },
      dataProviderArtifact: {
        copiedRoot: packagedDataRoot,
        copiedExecutable: resolve(packagedDataRoot, relative(dataProviderArtifact.root, dataProviderArtifact.executable)),
        providerId: dataProviderArtifact.providerId,
        providerVersion: dataProviderArtifact.providerVersion,
        admittedProvenance: dataProviderArtifact.provenance,
        copyIdentity: dataProviderCopyIdentity,
      },
      fileVitalsProviderArtifact: {
        copiedRoot: packagedFileRoot,
        copiedExecutable: resolve(packagedFileRoot, relative(fileProviderArtifact.root, fileProviderArtifact.executable)),
        providerId: fileProviderArtifact.providerId,
        providerVersion: fileProviderArtifact.providerVersion,
        admittedProvenance: fileProviderArtifact.provenance,
        copyIdentity: fileProviderCopyIdentity,
      },
      sourceSnapshot: snapshotBefore,
      buildMs: performance.now() - buildStarted,
      dependencyRuntime: 'Structured Data Preflight expands one identity-verified runtime archive containing a copied standalone Python 3.11 runtime, the rebuilt wheel installation, and resolved dependencies inside each private Host launch snapshot; both Capability stages run from copied, semantically validated Provider artifacts.',
      note: 'The Procedure wheel is rebuilt from recorded current source. Its launcher, runtime archive, wheel, and Provider identities are frozen before launch. The archive carries the interpreter, standard library, dependencies, and entrypoint; no source checkout is a runtime fallback and no artifact location is promoted into an installed-or-active claim.',
    },
  }
}
