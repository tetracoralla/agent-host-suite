import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { AgentHostError } from './errors.mjs'
import { canonicalJson, sha256 } from './json.mjs'
import { ManagedMcpStdioTransport } from './managed-mcp-stdio-transport.mjs'
import { closeMcpProbeTransport } from './mcp-probe-cleanup.mjs'
import { componentEnvironment } from './component-environment.mjs'

// Context Surface Analyzer snapshot contract the Host actually writes and
// analyzes (`packages/context-surface-analyzer/src/constants.js`): 512 KiB
// snapshot parse, 128 tools, 64 KiB strings/schemas. Catalog admission uses
// these Host export/analysis limits, not a model context window.
const CONTEXT_SURFACE_MAX_TOOLS = 128
const CONTEXT_SURFACE_MAX_STRING_BYTES = 64 * 1024
// Pretty-printed snapshot JSON (`writePrivateJson`) is larger than canonical
// tools bytes. 384 KiB leaves headroom under the 512 KiB snapshot parse cap.
const MANAGED_CATALOG_MAX_UTF8_BYTES = 384 * 1024

// Small-working-set product preference. Not an admission gate and not a token
// measurement. Profiles keep a small default; users enlarge the working set.
export const MANAGED_CATALOG_PREFERENCES = Object.freeze({
  preferredCatalogUtf8Bytes: 65_536,
})

// Resource protection for the selected managed catalog. These limits do not
// measure a host's assembled prompt, deferred tools, or model token usage.
export const MANAGED_CATALOG_BUDGETS = Object.freeze({
  maxCatalogUtf8Bytes: MANAGED_CATALOG_MAX_UTF8_BYTES,
  maxToolCount: CONTEXT_SURFACE_MAX_TOOLS,
  maxLargestToolUtf8Bytes: CONTEXT_SURFACE_MAX_STRING_BYTES,
  maxResultUtf8Bytes: 65_536,
})

async function listProviderToolsOnce(id, component, workspaceRoot) {
  const transport = new ManagedMcpStdioTransport({
    command: component.command,
    args: component.args,
    cwd: component.cwd ?? component.pluginRoot,
    env: componentEnvironment(component, workspaceRoot),
    stderr: 'pipe',
  })
  const client = new Client({ name: 'agent-host-context-exporter', version: '0.1.0' })
  let primaryError = null
  try {
    await client.connect(transport, { timeout: 45_000, maxTotalTimeout: 45_000 })
    const result = await client.listTools(undefined, { timeout: 45_000, maxTotalTimeout: 45_000 })
    if (!Array.isArray(result.tools) || result.tools.length > MANAGED_CATALOG_BUDGETS.maxToolCount) {
      throw new AgentHostError('CATALOG_EXPORT_LIMIT', `${id} returned an invalid or oversized tool catalog`)
    }
    return result.tools.map((tool) => {
      if (typeof tool.name !== 'string' || typeof tool.description !== 'string' || tool.inputSchema === undefined) {
        throw new AgentHostError('CATALOG_EXPORT_INVALID', `${id} tool ${tool.name ?? 'unknown'} lacks its name, description or input schema`)
      }
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
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

async function listProviderTools(id, component, workspaceRoot) {
  try {
    return await listProviderToolsOnce(id, component, workspaceRoot)
  } catch (error) {
    if (!retryableCatalogError(error)) throw error
    return await listProviderToolsOnce(id, component, workspaceRoot)
  }
}

export async function exportManagedCatalogInventory(components, { workspaceRoot = null } = {}) {
  const providerComponents = Object.entries(components)
    .filter(([, component]) => component.pluginRoot !== undefined && component.command !== undefined && Array.isArray(component.args))
    .sort(([left], [right]) => left.localeCompare(right))
  const catalogs = []
  const bindings = []
  for (const [id, component] of providerComponents) {
    const tools = await listProviderTools(id, component, workspaceRoot)
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

export async function exportManagedCatalog(components, options = {}) {
  return (await exportManagedCatalogInventory(components, options)).snapshot
}

function limitBreaches(rows) {
  return rows.filter(([, actual, limit]) => actual > limit).map(([metric, actual, limit]) => ({ metric, actual, limit }))
}

export function assessManagedCatalog(snapshot) {
  const budgets = snapshot.budgets ?? MANAGED_CATALOG_BUDGETS
  const preferences = MANAGED_CATALOG_PREFERENCES
  const toolBytes = snapshot.tools.map((tool) => Buffer.byteLength(canonicalJson(tool), 'utf8'))
  const summary = {
    canonicalUtf8Bytes: Buffer.byteLength(canonicalJson(snapshot.tools), 'utf8'),
    largestToolUtf8Bytes: Math.max(0, ...toolBytes),
    toolCount: snapshot.tools.length,
    budgets,
    preferences,
  }
  const headroom = {
    catalogUtf8Bytes: budgets.maxCatalogUtf8Bytes - summary.canonicalUtf8Bytes,
    largestToolUtf8Bytes: budgets.maxLargestToolUtf8Bytes - summary.largestToolUtf8Bytes,
    toolCount: budgets.maxToolCount - summary.toolCount,
  }
  const exceeded = limitBreaches([
    ['catalog.canonicalUtf8Bytes', summary.canonicalUtf8Bytes, budgets.maxCatalogUtf8Bytes],
    ['catalog.largestToolUtf8Bytes', summary.largestToolUtf8Bytes, budgets.maxLargestToolUtf8Bytes],
    ['counts.tools', summary.toolCount, budgets.maxToolCount],
  ])
  const preferenceOver = limitBreaches([
    ['catalog.canonicalUtf8Bytes', summary.canonicalUtf8Bytes, preferences.preferredCatalogUtf8Bytes],
  ])
  return {
    ...summary,
    headroom,
    status: exceeded.length === 0 ? 'within' : 'exceeded',
    exceeded,
    preference: {
      status: preferenceOver.length === 0 ? 'within' : 'over',
      over: preferenceOver,
      headroom: {
        catalogUtf8Bytes: preferences.preferredCatalogUtf8Bytes - summary.canonicalUtf8Bytes,
      },
    },
  }
}

export async function preflightManagedCatalog(components, options = {}) {
  const { bindings, snapshot } = await exportManagedCatalogInventory(components, options)
  const expected = Object.keys(components).sort()
  const measured = bindings.map((binding) => binding.id).sort()
  if (JSON.stringify(expected) !== JSON.stringify(measured)) {
    throw new AgentHostError('AGENT_TOOL_CATALOG_UNMEASURABLE', 'The proposed Agent tool set contains a component without a measurable live catalog', { expected, measured })
  }
  const assessment = assessManagedCatalog(snapshot)
  if (assessment.status === 'exceeded') {
    throw new AgentHostError(
      'AGENT_TOOL_CATALOG_BUDGET_EXCEEDED',
      'The proposed Agent tool catalog exceeds Host resource-protection limits; activate a smaller working set',
      { components: expected, ...assessment },
    )
  }
  return assessment
}
