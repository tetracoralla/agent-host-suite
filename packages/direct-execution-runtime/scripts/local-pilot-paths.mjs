import { lstat, opendir, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { prepareRuntimeConfig } from '../src/config.mjs'
import { digestFile, digestJson, parseStrictJson } from '../src/json.mjs'
import { validateComponentDescriptor } from '../../../src/release-manifest.mjs'

const MAX_ARTIFACT_FILES = 20_000
const MAX_ARTIFACT_ENTRIES = 20_000
const MAX_ARTIFACT_DEPTH = 64
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024
const MAX_ARTIFACT_INSPECTION_MS = 15_000

export function resolveMathAnchorRoot(workspace, environment = process.env) {
  const configured = environment.OPENADAM_MATH_ANCHOR_ROOT
  if (configured === undefined) return resolve(workspace, 'calculator')
  if (!isAbsolute(configured)) {
    throw new Error('OPENADAM_MATH_ANCHOR_ROOT must be an absolute path')
  }
  return resolve(configured)
}

export function resolvePilotWorkspace(runtimeRoot, environment = process.env) {
  const configured = environment.OPENADAM_DIRECT_PILOT_WORKSPACE_ROOT
  if (configured === undefined) return resolve(runtimeRoot, '../../..')
  if (!isAbsolute(configured)) {
    throw new Error('OPENADAM_DIRECT_PILOT_WORKSPACE_ROOT must be an absolute path')
  }
  return resolve(configured)
}

export async function resolveRequiredExecutables(commands, cwd, resolver) {
  const executables = {}
  const missing = []
  for (const command of commands) {
    try {
      executables[command] = await resolver(command, cwd)
    } catch (error) {
      if (error?.code !== 'HOST_PROVIDER_UNAVAILABLE') throw error
      missing.push(command)
    }
  }
  return { executables, missing }
}

async function findPackagedProviderRoot(executable) {
  let directory = dirname(executable)
  while (true) {
    const manifestPath = resolve(directory, 'capabilities/provider.json')
    const pluginManifestPath = resolve(directory, '.codex-plugin/plugin.json')
    try {
      const [manifestText, pluginManifestText] = await Promise.all([
        readFile(manifestPath, 'utf8'),
        readFile(pluginManifestPath, 'utf8'),
      ])
      return {
        root: await realpath(directory),
        manifestPath,
        pluginManifestPath,
        manifest: parseStrictJson(manifestText, `${manifestPath}`),
        pluginManifest: parseStrictJson(pluginManifestText, `${pluginManifestPath}`),
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new Error(`provider executable is not inside a packaged plugin artifact: ${executable}`)
}

function portableRelative(root, path) {
  return relative(root, path).split(sep).join('/')
}

async function inventoryArtifact(root, current = root, state = undefined, depth = 0) {
  const inventory = state ?? { files: [], entries: 0, expandedBytes: 0, startedAt: Date.now() }
  if (depth > MAX_ARTIFACT_DEPTH) throw new Error('provider artifact exceeds the maximum directory depth')
  const directory = await opendir(current)
  for await (const entry of directory) {
    inventory.entries += 1
    if (inventory.entries > MAX_ARTIFACT_ENTRIES) {
      throw new Error('provider artifact exceeds the bounded entry inventory')
    }
    if (Date.now() - inventory.startedAt > MAX_ARTIFACT_INSPECTION_MS) {
      throw new Error('provider artifact inspection exceeded its total time limit')
    }
    const path = resolve(current, entry.name)
    const info = await lstat(path)
    const relativePath = portableRelative(root, path)
    if (info.isSymbolicLink()) throw new Error(`provider artifact contains a symbolic link: ${relativePath}`)
    if (info.isDirectory()) await inventoryArtifact(root, path, inventory, depth + 1)
    else if (info.isFile()) {
      const nextBytes = inventory.expandedBytes + info.size
      if (
        inventory.files.length + 1 > MAX_ARTIFACT_FILES
        || info.size > MAX_ARTIFACT_BYTES
        || !Number.isSafeInteger(nextBytes)
        || nextBytes > MAX_ARTIFACT_BYTES
      ) {
        throw new Error('provider artifact exceeds the bounded file inventory')
      }
      inventory.expandedBytes = nextBytes
      inventory.files.push({
        path: relativePath,
        bytes: info.size,
        executable: (info.mode & 0o111) !== 0,
        sha256: await digestFile(path),
      })
    } else throw new Error(`provider artifact contains a special file: ${relativePath}`)
  }
  return inventory.files
}

export async function inspectProviderArtifactBytes(root) {
  const canonicalRoot = await realpath(root)
  const files = (await inventoryArtifact(canonicalRoot))
    .sort((left, right) => left.path.localeCompare(right.path))
  return {
    fileCount: files.length,
    expandedBytes: files.reduce((total, item) => total + item.bytes, 0),
    contentDigest: digestJson(files),
  }
}

async function findComponentRoot(pluginRoot) {
  let directory = pluginRoot
  while (true) {
    try {
      await lstat(resolve(directory, 'component.json'))
      return directory
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

async function inspectArtifactProvenance(pluginRoot, expected) {
  const componentRoot = await findComponentRoot(pluginRoot)
  const root = componentRoot ?? pluginRoot
  const files = (await inventoryArtifact(root)).sort((left, right) => left.path.localeCompare(right.path))
  const expandedBytes = files.reduce((total, item) => total + item.bytes, 0)
  const common = {
    fileCount: files.length,
    expandedBytes,
    contentDigest: digestJson(files),
  }
  if (componentRoot === null) return { kind: 'provider-release-artifact', root: pluginRoot, ...common }

  const descriptorPath = resolve(componentRoot, 'component.json')
  const descriptor = parseStrictJson(await readFile(descriptorPath, 'utf8'), descriptorPath)
  const releaseComponent = {
    id: descriptor?.id,
    version: descriptor?.version,
    license: {
      files: [descriptor?.legal?.license, descriptor?.legal?.notice, descriptor?.legal?.thirdPartyNotices]
        .filter((value) => typeof value === 'string'),
    },
  }
  validateComponentDescriptor(descriptor, releaseComponent)
  if (descriptor.id !== expected.componentId || descriptor.version !== expected.componentVersion) {
    throw new Error('Agent Host component identity differs from the expected Provider component')
  }
  const actual = new Map(files.filter((file) => file.path !== 'component.json').map((file) => [file.path, file]))
  if (
    actual.size !== descriptor.files.length
    || descriptor.files.some((expected) => {
      const observed = actual.get(expected.path)
      return observed === undefined
        || observed.bytes !== expected.bytes
        || observed.executable !== expected.executable
        || observed.sha256 !== expected.sha256
    })
  ) {
    throw new Error('Agent Host component file inventory differs from component.json')
  }
  const host = expected.hostIntegration
  if (host === undefined) {
    throw new Error('Agent Host component Direct Capability expectation is missing')
  }
  const componentPath = (path) => portableRelative(componentRoot, resolve(pluginRoot, path))
  const normalizeDirectCapability = (value) => ({
    ...value,
    identityFiles: [...value.identityFiles].sort(),
    contracts: [...value.contracts].sort((left, right) => left.operationId.localeCompare(right.operationId)),
  })
  const wanted = {
    providerId: expected.providerId,
    transport: 'capability-jsonl-v0.1',
    lifecycle: host.lifecycle,
    ...(host.workspaceRoot === undefined ? {} : { workspaceRoot: host.workspaceRoot }),
    capabilityId: expected.capabilityId,
    capabilityVersion: expected.capabilityVersion,
    adapter: {
      command: componentPath(expected.executableRelativePath),
      args: expected.adapterArgs ?? [],
      cwd: componentPath(expected.adapterCwdRelativePath ?? '.'),
    },
    manifest: componentPath('capabilities/provider.json'),
    profile: host.profileRelativePath,
    identityFiles: host.identityRelativePaths.map(componentPath),
    contracts: expected.contracts.map((contract) => ({
      operationId: contract.operationId,
      inputSchema: componentPath(contract.inputSchemaRelativePath),
      outputSchema: componentPath(contract.outputSchemaRelativePath),
    })),
  }
  const actualIntegration = descriptor.integration?.directCapability
  if (
    actualIntegration === undefined
    || digestJson(normalizeDirectCapability(actualIntegration)) !== digestJson(normalizeDirectCapability(wanted))
  ) {
    throw new Error('Agent Host component Direct Capability integration differs from the expected Provider binding')
  }
  return {
    kind: 'agent-host-component-artifact',
    root: componentRoot,
    componentId: descriptor.id,
    componentVersion: descriptor.version,
    descriptorDigest: await digestFile(descriptorPath),
    ...common,
  }
}

function exactAdapterBindings(implementation, expected) {
  const actual = implementation.adapterBindings
    .map(({ operationId, target }) => ({ operationId, target }))
    .sort((left, right) => left.operationId.localeCompare(right.operationId))
  const wanted = [...expected].sort((left, right) => left.operationId.localeCompare(right.operationId))
  return digestJson(actual) === digestJson(wanted)
}

export async function resolveProviderArtifacts(requirements, cwd, resolver) {
  const artifacts = {}
  for (const requirement of requirements) {
    const executable = await realpath(await resolver(requirement.command, cwd))
    const artifact = await findPackagedProviderRoot(executable)
    const relativeExecutable = relative(artifact.root, executable)
    if (
      relativeExecutable === ''
      || relativeExecutable.startsWith(`..${sep}`)
      || relativeExecutable.split(sep).join('/') !== requirement.executableRelativePath
    ) {
      throw new Error(
        `${requirement.command} is not the declared packaged runtime executable`,
      )
    }
    const provider = artifact.manifest.provider
    if (
      provider?.id !== requirement.providerId
      || provider?.version !== requirement.providerVersion
      || artifact.pluginManifest.name !== requirement.pluginName
      || artifact.pluginManifest.version !== requirement.providerVersion
    ) {
      throw new Error(
        `${requirement.command} provider identity differs from the Procedure binding`,
      )
    }
    const implementations = artifact.manifest.implementations
    const matches = Array.isArray(implementations)
      ? implementations.filter((implementation) => (
        implementation?.capabilityId === requirement.capabilityId
        && implementation?.capabilityVersion === requirement.capabilityVersion
      ))
      : []
    if (matches.length !== 1) {
      throw new Error(
        `${requirement.command} Capability identity differs from the Procedure binding`,
      )
    }
    if (!exactAdapterBindings(matches[0], requirement.operationBindings)) {
      throw new Error(`${requirement.command} operation bindings differ from the Procedure binding`)
    }
    const contracts = requirement.contracts.map((contract) => ({
      operationId: contract.operationId,
      inputSchemaPath: resolve(artifact.root, contract.inputSchemaRelativePath),
      outputSchemaPath: resolve(artifact.root, contract.outputSchemaRelativePath),
    }))
    const declaredExecutionIdentities = requirement.hostIntegration?.identityRelativePaths
      ?.map((path) => resolve(artifact.root, path)) ?? []
    const identityFiles = [...new Set([
      executable,
      artifact.manifestPath,
      artifact.pluginManifestPath,
      ...declaredExecutionIdentities,
      ...contracts.flatMap((contract) => [contract.inputSchemaPath, contract.outputSchemaPath]),
    ])]
    const prepared = await prepareRuntimeConfig({
      schemaVersion: 'openadam.direct-provider-config.v0.2',
      providers: [{
        providerId: requirement.providerId,
        transport: 'capability-jsonl-v0.1',
        lifecycle: 'per-call',
        rootPath: artifact.root,
        profilePath: requirement.profilePath,
        manifestPath: artifact.manifestPath,
        identityFiles,
        capabilityId: requirement.capabilityId,
        capabilityVersion: requirement.capabilityVersion,
        contracts,
      }],
    })
    const binding = prepared.providers.get(requirement.providerId)
    const expectedAdapterArgs = requirement.adapterArgs ?? []
    const expectedAdapterCwd = await realpath(resolve(artifact.root, requirement.adapterCwdRelativePath ?? '.'))
    if (
      binding?.adapterCommand !== executable
      || binding.providerVersion !== requirement.providerVersion
      || digestJson(binding.adapterArgs) !== digestJson(expectedAdapterArgs)
      || binding.adapterCwd !== expectedAdapterCwd
    ) {
      throw new Error(`${requirement.command} release launcher differs from the validated Provider Manifest`)
    }
    const [provenance, copyIdentity] = await Promise.all([
      inspectArtifactProvenance(artifact.root, {
        ...requirement,
        componentVersion: requirement.providerVersion,
      }),
      inspectProviderArtifactBytes(artifact.root),
    ])
    artifacts[requirement.command] = {
      executable,
      root: artifact.root,
      providerId: requirement.providerId,
      providerVersion: requirement.providerVersion,
      profileDigest: binding.profileDigest,
      manifestDigest: binding.manifestDigest,
      contractDigest: binding.contractDigest,
      identityFiles: binding.identityDigests,
      copyIdentity,
      provenance,
    }
  }
  return artifacts
}
