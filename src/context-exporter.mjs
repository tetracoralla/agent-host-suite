import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { AgentHostError } from './errors.mjs'
import { canonicalJson, sha256 } from './json.mjs'

async function listProviderToolsOnce(id, component) {
  const transport = new StdioClientTransport({
    command: component.command,
    args: component.args,
    cwd: component.cwd ?? component.pluginRoot,
    stderr: 'pipe',
  })
  const client = new Client({ name: 'agent-host-context-exporter', version: '0.1.0' })
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
  } finally {
    await client.close().catch(() => {})
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
    budgets: {
      maxCatalogUtf8Bytes: 65536,
      maxToolCount: 64,
      maxLargestToolUtf8Bytes: 40000,
      maxResultUtf8Bytes: 65536,
    },
  } }
}

export async function exportManagedCatalog(components) {
  return (await exportManagedCatalogInventory(components)).snapshot
}
