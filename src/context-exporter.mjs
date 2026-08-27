import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { AgentHostError } from './errors.mjs'
import { canonicalJson, sha256 } from './json.mjs'

async function listProviderTools(id, component) {
  const transport = new StdioClientTransport({
    command: component.command,
    args: component.args,
    cwd: component.cwd ?? component.pluginRoot,
    stderr: 'pipe',
  })
  const client = new Client({ name: 'agent-host-context-exporter', version: '0.1.0' })
  try {
    await client.connect(transport, { timeout: 30_000, maxTotalTimeout: 30_000 })
    const result = await client.listTools(undefined, { timeout: 30_000, maxTotalTimeout: 30_000 })
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

export async function exportManagedCatalog(components) {
  const providerComponents = Object.entries(components)
    .filter(([, component]) => component.pluginRoot !== undefined && component.command !== undefined && Array.isArray(component.args))
    .sort(([left], [right]) => left.localeCompare(right))
  const catalogs = []
  for (const [id, component] of providerComponents) catalogs.push(...await listProviderTools(id, component))
  const revisionObject = providerComponents.map(([id, component]) => ({ id, version: component.version, fingerprint: component.fingerprint }))
  return {
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
  }
}
