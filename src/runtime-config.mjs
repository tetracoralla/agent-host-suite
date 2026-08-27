import { createHash } from 'node:crypto'
import { mkdir, rm, rmdir } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { AgentHostError } from './errors.mjs'
import { writePrivateJson } from './json.mjs'
import { ensurePrivateDirectory } from './paths.mjs'

const MAX_SOCKET_PATH_BYTES = 103

export function runtimeSocketDirectory(paths) {
  if (platform() !== 'darwin') return join(paths.runtime, 'socket')
  const stateId = createHash('sha256').update(paths.root).digest('hex').slice(0, 16)
  return join(homedir(), 'Library', 'Caches', 'openAdam', 'AgentHost', stateId)
}

export function createRuntimeConfig(manifest) {
  const math = manifest.components['math-anchor']
  const time = manifest.components['migratory-time']
  return {
    schemaVersion: 'openadam.direct-provider-config.v0.2',
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
    providers: [
      {
        providerId: 'io.github.tetracoralla.math-anchor',
        transport: 'mcp-stdio',
        lifecycle: 'persistent',
        rootPath: math.pluginRoot,
        command: math.command,
        args: math.args,
        cwd: math.pluginRoot,
        identityFiles: math.identityFiles.filter((path) => path.startsWith(math.pluginRoot)),
        expectedServer: { name: 'Math Anchor', version: math.version },
        allowedTools: ['math.run', 'math.batch', 'math.describe'],
        operationProjections: [{
          toolName: 'math.run',
          operationField: 'operation',
          argumentsField: 'arguments',
          batchToolName: 'math.batch',
          batchItemsField: 'items',
          schemaLookup: {
            toolName: 'math.describe',
            operationField: 'operation',
            resultPath: ['operation', 'inputSchema'],
          },
        }],
      },
      {
        providerId: 'io.github.tetracoralla.migratory-time',
        transport: 'capability-jsonl-v0.1',
        lifecycle: 'persistent',
        rootPath: time.root,
        profilePath: time.profilePath,
        manifestPath: time.manifestPath,
        identityFiles: [time.adapterPath],
        capabilityId: 'org.openadam.time-zone.convert',
        capabilityVersion: '0.2.0',
        contracts: [{
          operationId: 'convert',
          inputSchemaPath: time.inputSchemaPath,
          outputSchemaPath: time.outputSchemaPath,
        }],
      },
    ],
  }
}

export async function writeRuntimeFiles(paths, manifest) {
  const socketDirectory = await ensurePrivateDirectory(runtimeSocketDirectory(paths))
  const configPath = join(paths.runtime, 'provider-config.json')
  const socketPath = join(socketDirectory, 'direct-runtime.sock')
  if (Buffer.byteLength(socketPath, 'utf8') > MAX_SOCKET_PATH_BYTES) {
    throw new AgentHostError('RUNTIME_SOCKET_PATH_TOO_LONG', 'The private Direct Runtime socket path exceeds the platform limit')
  }
  const observationLog = join(paths.observations, 'direct-runtime.jsonl')
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 })
  await writePrivateJson(configPath, createRuntimeConfig(manifest))
  return { configPath, socketDirectory, socketPath, observationLog }
}

export async function cleanupRuntimeSocket(paths, runtime) {
  const expectedDirectory = runtimeSocketDirectory(paths)
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

export function semanticProbeOrder() {
  return {
    schemaVersion: 'openadam.direct-work-order.v0.1',
    id: 'agent-host-doctor',
    calls: [
      {
        id: 'math',
        timeoutMs: 30000,
        providerId: 'io.github.tetracoralla.math-anchor',
        target: {
          kind: 'mcp-operation',
          toolName: 'math.run',
          operationId: 'expression.evaluate',
        },
        input: { operation: 'expression.evaluate', arguments: { expression: '6*7' } },
      },
      {
        id: 'math-batch',
        timeoutMs: 30000,
        providerId: 'io.github.tetracoralla.math-anchor',
        target: { kind: 'mcp-tool', toolName: 'math.batch' },
        input: {
          items: [
            { operation: 'expression.evaluate', arguments: { expression: '6*7' } },
            { operation: 'calculus.derivative', arguments: { expression: 'x^3', variable: 'x' } },
          ],
        },
      },
      {
        id: 'time',
        timeoutMs: 30000,
        providerId: 'io.github.tetracoralla.migratory-time',
        target: {
          kind: 'capability',
          capabilityId: 'org.openadam.time-zone.convert',
          capabilityVersion: '0.2.0',
          operationId: 'convert',
        },
        input: {
          localDateTime: '2026-08-24T12:00',
          sourceTimeZone: 'UTC',
          targetTimeZones: ['Asia/Tokyo'],
          disambiguation: 'reject',
        },
      },
    ],
  }
}

export function mathProjectionSelection() {
  return {
    schemaVersion: 'openadam.direct-contract-selection.v0.1',
    providerId: 'io.github.tetracoralla.math-anchor',
    target: {
      kind: 'mcp-operation',
      toolName: 'math.run',
      operationId: 'expression.evaluate',
    },
  }
}
