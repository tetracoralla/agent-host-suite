import { createHash } from 'node:crypto'
import { mkdir, realpath, rm, rmdir } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { resolveDirectBindings } from './provider-bindings.mjs'
import { AgentHostError } from './errors.mjs'
import { writePrivateJson } from './json.mjs'
import { ensurePrivateDirectory } from './paths.mjs'

const MAX_SOCKET_PATH_BYTES = 103

export function runtimeSocketDirectory(paths) {
  if (platform() === 'win32') return null
  if (platform() !== 'darwin') return join(paths.runtime, 'socket')
  const stateId = createHash('sha256').update(paths.root).digest('hex').slice(0, 16)
  return join(homedir(), 'Library', 'Caches', 'openAdam', 'AgentHost', stateId)
}

export function createRuntimeConfig(manifest, options = {}) {
  const bindings = resolveDirectBindings(manifest, options)
  const providers = bindings.map(({ provider }) => provider)
  const preparedProviderIds = bindings
    .filter(({ active, provider }) => active && provider.lifecycle === 'persistent')
    .map(({ provider }) => provider.providerId)
  const runtimeVersion = manifest.components['direct-execution-runtime']?.version ?? '0.0.0'
  const version = runtimeVersion.match(/^(\d+)\.(\d+)\.(\d+)/u)?.slice(1).map(Number)
  const supportsPreparation = version !== undefined && (
    version[0] > 0 || version[1] > 2 || (version[1] === 2 && version[2] >= 1)
  )
  return {
    schemaVersion: supportsPreparation
      ? 'openadam.direct-provider-config.v0.3'
      : 'openadam.direct-provider-config.v0.2',
    limits: {
      maxConcurrentCalls: 4,
      maxQueuedCalls: 32,
      maxWorkOrderCalls: 64,
      maxWorkOrderBytes: 262144,
      maxProviderResponseBytes: 262144,
      maxResultBytes: 524288,
      maxProtocolLineBytes: 1048576,
      maxStderrBytes: 32768,
      defaultTimeoutMs: 30000,
      circuitBreakerFailureThreshold: 3,
      circuitBreakerCooldownMs: 1000,
    },
    ...(supportsPreparation ? {
      servicePreparation: {
        mode: preparedProviderIds.length === 0 ? 'lazy' : 'persistent-providers',
        totalTimeoutMs: 60000,
        providerIds: preparedProviderIds,
      },
    } : {}),
    providers,
  }
}

export async function writeRuntimeFiles(paths, manifest, options = {}) {
  const config = createRuntimeConfig(manifest, options)
  const configDigest = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 24)
  const configPath = join(paths.runtime, `provider-config-${configDigest}.json`)
  const windowsPipe = platform() === 'win32'
  const socketDirectory = windowsPipe ? null : await ensurePrivateDirectory(options.socketDirectory ?? runtimeSocketDirectory(paths))
  const stateId = createHash('sha256').update(paths.root).digest('hex').slice(0, 24)
  const socketPath = windowsPipe ? `\\\\.\\pipe\\openadam-agent-host-${stateId}` : join(socketDirectory, 'direct-runtime.sock')
  if (!windowsPipe && Buffer.byteLength(socketPath, 'utf8') > MAX_SOCKET_PATH_BYTES) {
    throw new AgentHostError('RUNTIME_SOCKET_PATH_TOO_LONG', 'The private Direct Runtime socket path exceeds the platform limit')
  }
  const observationLog = join(paths.observations, 'direct-runtime.jsonl')
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 })
  await writePrivateJson(configPath, config)
  return { configPath, socketDirectory, socketPath, observationLog }
}

export async function cleanupRuntimeSocket(paths, runtime, options = {}) {
  if (platform() === 'win32') {
    const stateId = createHash('sha256').update(paths.root).digest('hex').slice(0, 24)
    const expectedPipe = `\\\\.\\pipe\\openadam-agent-host-${stateId}`
    return runtime?.socketPath === expectedPipe
      ? { removed: false, reason: 'named-pipe-has-no-filesystem-entry' }
      : { removed: false, reason: 'unmanaged-path' }
  }
  const configuredDirectory = options.socketDirectory ?? runtimeSocketDirectory(paths)
  let expectedDirectory
  try {
    expectedDirectory = await realpath(configuredDirectory)
  } catch (error) {
    if (error.code === 'ENOENT') return { removed: false, reason: 'missing' }
    throw error
  }
  const expectedSocket = join(expectedDirectory, 'direct-runtime.sock')
  if (runtime?.socketPath !== expectedSocket) return { removed: false, reason: 'unmanaged-path' }
  await rm(expectedSocket, { force: true })
  try {
    await rmdir(expectedDirectory)
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error
  }
  return { removed: true }
}
