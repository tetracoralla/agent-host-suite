import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writePrivateJson } from './json.mjs'
import { ensurePrivateDirectory } from './paths.mjs'

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
      defaultTimeoutMs: 10000,
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
        allowedTools: ['math.run', 'math.batch'],
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
  const socketDirectory = await ensurePrivateDirectory(join(paths.runtime, 'socket'))
  const configPath = join(paths.runtime, 'provider-config.json')
  const socketPath = join(socketDirectory, 'direct-runtime.sock')
  const observationLog = join(paths.observations, 'direct-runtime.jsonl')
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 })
  await writePrivateJson(configPath, createRuntimeConfig(manifest))
  return { configPath, socketPath, observationLog }
}

export function semanticProbeOrder() {
  return {
    schemaVersion: 'openadam.direct-work-order.v0.1',
    id: 'agent-host-doctor',
    calls: [
      {
        id: 'math',
        providerId: 'io.github.tetracoralla.math-anchor',
        target: { kind: 'mcp-tool', toolName: 'math.run' },
        input: { operation: 'expression.evaluate', arguments: { expression: '6*7' } },
      },
      {
        id: 'time',
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
