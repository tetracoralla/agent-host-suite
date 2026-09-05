import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { AgentHostError } from './errors.mjs'
import { canonicalJson, sha256 } from './json.mjs'
import { ManagedMcpStdioTransport } from './managed-mcp-stdio-transport.mjs'
import { closeMcpProbeTransport } from './mcp-probe-cleanup.mjs'

export const MANAGED_CATALOG_BUDGETS = Object.freeze({
  maxCatalogUtf8Bytes: 65_536,
  maxToolCount: 64,
  maxLargestToolUtf8Bytes: 40_000,
  maxResultUtf8Bytes: 65_536,
})

async function listProviderToolsOnce(id, component) {
  const transport = new ManagedMcpStdioTransport({
    command: component.command,
    args: component.args,
    cwd: component.cwd ?? component.pluginRoot,
    stderr: 'pipe',
  })
  const client = new Client({ name: 'agent-host-context-exporter', version: '0.1.0' })
  let primaryError = null
  try {
    await client.connect(transport, { timeout: 45_000, maxTotalTimeout: 45_000 })
    const result = await client.listTools(undefined, { timeout: 45_000, maxTotalTimeout: 45_000 })
    if (!Array.isArray(result.tools) || result.tools.length > 128) {
      throw new AgentHostError('CATALOG_EXPORT_LIMIT', `${id} returned an invalid or oversized tool catalog`)
    }
    return result.tools.map((tool) => {
      if (typeof tool.name !== 'string' || typeof tool.description !== 'string' || tool.inputSchema === undefined || tool.outputSchema === undefined) {
        throw new AgentHostError('CATALOG_EXPORT_INVALID', `${id} tool ${tool.name ?? 'unknown'} lacks a complete typed catalog entry`)
      }
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
      }
    })
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    await closeMcpProbeTransport(
      transport,
      primaryError,
      'CATALOG_EXPORT_CLEANUP_FAILED',
      `${id} provider catalog process scope could not be removed`,
    )
  }
}

export function retryableCatalogError(error) {
  return error?.code === -32001 || /timed out|timeout/iu.test(error?.message ?? '')
}

function semanticToolKey(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/gu, '')
}

export function validateManagedToolBindings(bindings) {
  const observed = new Map()
  for (const binding of bindings) {
    for (const toolName of binding.toolNames ?? []) {
      const key = semanticToolKey(toolName)
      const prior = observed.get(key)
      if (key.length === 0 || prior !== undefined) {
        throw new AgentHostError('AGENT_TOOL_BINDING_CONFLICT', `Agent-visible tool bindings conflict before deployment observation: ${prior?.toolName ?? toolName} and ${toolName}`, {
          semanticKey: key,
          first: prior ?? null,
          conflicting: { component: binding.id, toolName },
        })
      }
      observed.set(key, { component: binding.id, toolName })
    }
  }
  return bindings
}

async function listProviderTools(id, component) {
  try {
    return await listProviderToolsOnce(id, component)
  } catch (error) {
    if (!retryableCatalogError(error)) throw error
    return await listProviderToolsOnce(id, component)
  }
}

export async function exportManagedCatalogInventory(components) {
  const providerComponents = Object.entries(components)
    .filter(([, component]) => component.pluginRoot !== undefined && component.command !== undefined && Array.isArray(component.args))
    .sort(([left], [right]) => left.localeCompare(right))
  const catalogs = []
  const bindings = []
  for (const [id, component] of providerComponents) {
    const tools = await listProviderTools(id, component)
    catalogs.push(...tools)
    bindings.push({
      id,
      version: component.version,
      artifactSha256: component.releaseArtifact?.artifact?.sha256 ?? null,
      toolNames: tools.map((tool) => tool.name),
    })
  }
  validateManagedToolBindings(bindings)
  const revisionObject = providerComponents.map(([id, component]) => ({ id, version: component.version, fingerprint: component.fingerprint }))
  return { bindings, snapshot: {
    format: 'context-surface.snapshot.v0.1',
    source: {
      id: `agent-host-suite:managed-${providerComponents.map(([id]) => id).join('+')}-catalog`,
      revision: sha256(canonicalJson(revisionObject)),
    },
    tools: catalogs,
    measurements: [],
    budgets: MANAGED_CATALOG_BUDGETS,
  } }
}

export async function exportManagedCatalog(components) {
  return (await exportManagedCatalogInventory(components)).snapshot
}

export function assessManagedCatalog(snapshot) {
  const toolBytes = snapshot.tools.map((tool) => Buffer.byteLength(canonicalJson(tool), 'utf8'))
  const summary = {
    canonicalUtf8Bytes: Buffer.byteLength(canonicalJson(snapshot.tools), 'utf8'),
    largestToolUtf8Bytes: Math.max(0, ...toolBytes),
    toolCount: snapshot.tools.length,
    budgets: snapshot.budgets,
  }
  const headroom = {
    catalogUtf8Bytes: snapshot.budgets.maxCatalogUtf8Bytes - summary.canonicalUtf8Bytes,
    largestToolUtf8Bytes: snapshot.budgets.maxLargestToolUtf8Bytes - summary.largestToolUtf8Bytes,
    toolCount: snapshot.budgets.maxToolCount - summary.toolCount,
  }
  const exceeded = [
    ['catalog.canonicalUtf8Bytes', summary.canonicalUtf8Bytes, snapshot.budgets.maxCatalogUtf8Bytes],
    ['catalog.largestToolUtf8Bytes', summary.largestToolUtf8Bytes, snapshot.budgets.maxLargestToolUtf8Bytes],
    ['counts.tools', summary.toolCount, snapshot.budgets.maxToolCount],
  ].filter(([, actual, limit]) => actual > limit).map(([metric, actual, limit]) => ({ metric, actual, limit }))
  return { ...summary, headroom, status: exceeded.length === 0 ? 'within' : 'exceeded', exceeded }
}

export async function preflightManagedCatalog(components) {
  const { bindings, snapshot } = await exportManagedCatalogInventory(components)
  const expected = Object.keys(components).sort()
  const measured = bindings.map((binding) => binding.id).sort()
  if (JSON.stringify(expected) !== JSON.stringify(measured)) {
    throw new AgentHostError('AGENT_TOOL_CATALOG_UNMEASURABLE', 'The proposed Agent tool set contains a component without a measurable live catalog', { expected, measured })
  }
  const assessment = assessManagedCatalog(snapshot)
  if (assessment.status === 'exceeded') {
    throw new AgentHostError(
      'AGENT_TOOL_CATALOG_BUDGET_EXCEEDED',
      'The proposed Agent tool set exceeds its declared context budget; activate a smaller working set',
      { components: expected, ...assessment },
    )
  }
  return assessment
}
