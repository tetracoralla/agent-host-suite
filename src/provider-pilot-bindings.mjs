import { relative, isAbsolute, sep } from 'node:path'

// These adapters read the original installed component records. They preserve
// rollback compatibility without making these products mandatory for the core.
const adapters = new Map([
  ['math-anchor', (component) => ({
    provider: {
      providerId: 'io.github.tetracoralla.math-anchor',
      transport: 'mcp-stdio',
      lifecycle: 'persistent',
      rootPath: component.pluginRoot,
      command: component.command,
      args: component.args,
      cwd: component.pluginRoot,
      identityFiles: component.identityFiles.filter((path) => {
        const child = relative(component.pluginRoot, path)
        return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
      }),
      expectedServer: { name: 'Math Anchor', version: component.version },
      allowedTools: ['math.run', 'math.batch', 'math.describe'],
      operationProjections: [{
        toolName: 'math.run', operationField: 'operation', argumentsField: 'arguments',
        batchToolName: 'math.batch', batchItemsField: 'items',
        schemaLookup: { toolName: 'math.describe', operationField: 'operation', resultPath: ['operation', 'inputSchema'] },
      }],
    },
    diagnostic: {
      calls: pilotProbeCalls().filter((call) => call.id !== 'time'),
      assess(calls) {
        const single = calls.find((call) => call.id === 'math')
        const batch = calls.find((call) => call.id === 'math-batch')
        return single?.status === 'ok' && single?.result?.exact === '42'
          && batch?.status === 'ok' && batch?.result?.status === 'ok'
          && batch?.result?.results?.length === 2
          && batch.result.results[0]?.exact === '42' && batch.result.results[1]?.exact === '3*x**2'
      },
      projection: {
        selection: mathProjectionSelection(),
        assess(value) {
          const operation = value?.contract?.inputSchema?.properties?.operation?.const
            ?? value?.contract?.inputSchema?.oneOf?.[0]?.properties?.operation?.const
          return value?.target?.operationId === 'expression.evaluate'
            && operation === 'expression.evaluate' && typeof value?.contract?.contractDigest === 'string'
        },
      },
    },
  })],
  ['migratory-time', (component) => ({
    provider: {
      providerId: 'io.github.tetracoralla.migratory-time',
      transport: 'capability-jsonl-v0.1', lifecycle: 'persistent',
      rootPath: component.root, profilePath: component.profilePath,
      manifestPath: component.manifestPath, identityFiles: [component.adapterPath],
      capabilityId: 'org.openadam.time-zone.convert', capabilityVersion: '0.2.0',
      contracts: [{ operationId: 'convert', inputSchemaPath: component.inputSchemaPath, outputSchemaPath: component.outputSchemaPath }],
    },
    diagnostic: {
      calls: pilotProbeCalls().filter((call) => call.id === 'time'),
      assess(calls) {
        const call = calls.find((item) => item.id === 'time')
        return call?.status === 'ok' && call?.result?.results?.length === 1
          && call.result.results[0]?.localDateTime === '2026-08-24T21:00'
      },
    },
  })],
])

export function resolvePilotBinding(id, component) {
  return adapters.get(id)?.(component) ?? null
}

function pilotProbeCalls() {
  return [
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
    ]
}


function mathProjectionSelection() {
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
