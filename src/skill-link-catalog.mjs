import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { AgentHostError } from './errors.mjs'
import { canonicalJson, readJson } from './json.mjs'
import { resolveStateRoot } from './paths.mjs'
import { loadState, readStatePaths } from './state.mjs'
import { componentEnvironment } from './component-environment.mjs'
import { ManagedMcpStdioTransport } from './managed-mcp-stdio-transport.mjs'
import { closeMcpProbeTransport } from './mcp-probe-cleanup.mjs'

export const SKILL_LINK_CATALOG_SCHEMA = 'openadam.skill-link-catalog.v0.2'
export const SKILL_LINK_SCHEMA_DIGEST_ALGORITHM = 'openadam.skill-link-schema-pair.v0.1'
export const SKILL_LINK_CATALOG_MAX_ENTRIES = 4096
export const SKILL_LINK_CATALOG_MAX_BYTES = 1024 * 1024

function fail(code, message, details) {
  throw new AgentHostError(code, message, details)
}

function schemaDigest(inputSchema, outputSchema) {
  return `sha256:${createHash('sha256').update(canonicalJson({
    algorithm: SKILL_LINK_SCHEMA_DIGEST_ALGORITHM,
    inputSchema,
    outputSchema,
  })).digest('hex')}`
}

async function readSchema(path, label) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    fail('LINK_CATALOG_CONTRACT_UNAVAILABLE', `${label} is unavailable`, { cause: error.message })
  }
  if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) {
    fail('LINK_CATALOG_CONTRACT_LIMIT', `${label} exceeds the 1 MiB contract limit`)
  }
  try {
    const value = JSON.parse(text)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('schema must be an object')
    return value
  } catch (error) {
    fail('LINK_CATALOG_CONTRACT_INVALID', `${label} is invalid JSON Schema`, { cause: error.message })
  }
}

function activeToolComponents(state) {
  const active = state.agentComponents ?? Object.keys(state.components)
  return active
    .map((id) => [id, state.components[id]])
    .filter(([, component]) => component !== undefined && Array.isArray(component.expectedTools) && component.expectedTools.length > 0)
}

async function listMcpTools(component, workspaceRoot) {
  const env = getDefaultEnvironment()
  Object.assign(env, componentEnvironment(component, workspaceRoot ?? component.cwd))
  const transport = new ManagedMcpStdioTransport({
    command: component.command,
    args: component.args,
    cwd: component.cwd,
    env,
    stderr: 'pipe',
    maxBufferSize: 4 * 1024 * 1024,
  })
  const client = new Client({ name: 'agent-host-skill-link-catalog', version: '0.1.0' }, { capabilities: {} })
  const timeoutMs = component.healthTimeoutMs ?? 10000
  let timer
  let primaryError = null
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new AgentHostError('LINK_CATALOG_TOOL_TIMEOUT', `The ${component.displayName ?? 'installed tool'} catalog timed out`)), timeoutMs)
    })
    await Promise.race([client.connect(transport), timeout])
    return (await Promise.race([client.listTools(), timeout])).tools
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    clearTimeout(timer)
    await closeMcpProbeTransport(
      transport,
      primaryError,
      'LINK_CATALOG_TOOL_CLEANUP_FAILED',
      `The ${component.displayName ?? 'installed tool'} catalog process scope could not be removed`,
    )
  }
}

async function semanticEntries(config) {
  if (!['openadam.direct-provider-config.v0.2', 'openadam.direct-provider-config.v0.3'].includes(config?.schemaVersion) || !Array.isArray(config.providers)) {
    fail('LINK_CATALOG_RUNTIME_CONFIG_INVALID', 'The current Direct Runtime configuration is not a supported provider set')
  }
  const entries = []
  for (const provider of config.providers) {
    if (provider.transport === 'capability-jsonl-v0.1') {
      for (const contract of provider.contracts ?? []) {
        const [inputSchema, outputSchema] = await Promise.all([
          readSchema(contract.inputSchemaPath, `${provider.providerId} ${contract.operationId} input schema`),
          readSchema(contract.outputSchemaPath, `${provider.providerId} ${contract.operationId} output schema`),
        ])
        entries.push({
          kind: 'capability',
          identity: `${provider.capabilityId}#${contract.operationId}`,
          version: provider.capabilityVersion,
          schemaDigest: schemaDigest(inputSchema, outputSchema),
        })
      }
    } else if (provider.transport === 'procedure-jsonl-v0.2') {
      const [inputSchema, outputSchema] = await Promise.all([
        readSchema(provider.inputSchemaPath, `${provider.providerId} Procedure input schema`),
        readSchema(provider.outputSchemaPath, `${provider.providerId} Procedure output schema`),
      ])
      entries.push({
        kind: 'procedure',
        identity: provider.procedureId,
        version: provider.procedureVersion,
        schemaDigest: schemaDigest(inputSchema, outputSchema),
      })
    }
  }
  return entries
}

async function toolEntries(state, probe) {
  const entries = []
  for (const [componentId, component] of activeToolComponents(state)) {
    const tools = await probe(component, state.workspaceRoot ?? null)
    const index = new Map(tools.map((tool) => [tool.name, tool]))
    for (const name of component.expectedTools) {
      const tool = index.get(name)
      if (tool === undefined) {
        fail('LINK_CATALOG_TOOL_MISSING', `${componentId} does not currently expose ${name}`)
      }
      if (tool.inputSchema === null || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema)
          || tool.outputSchema === null || typeof tool.outputSchema !== 'object' || Array.isArray(tool.outputSchema)) {
        fail('LINK_CATALOG_TOOL_SCHEMA_INCOMPLETE', `${componentId} exposes an incomplete schema for ${name}`)
      }
      entries.push({
        kind: 'tool',
        identity: name,
        version: component.version,
        schemaDigest: schemaDigest(tool.inputSchema, tool.outputSchema),
      })
    }
  }
  return entries
}

function finalize(entries) {
  if (entries.length > SKILL_LINK_CATALOG_MAX_ENTRIES) {
    fail('LINK_CATALOG_ENTRY_LIMIT', `The current Host catalog exceeds ${SKILL_LINK_CATALOG_MAX_ENTRIES} entries`)
  }
  entries.sort((left, right) => (
    left.kind.localeCompare(right.kind)
    || left.identity.localeCompare(right.identity)
    || left.version.localeCompare(right.version)
  ))
  const identities = new Map()
  for (const entry of entries) {
    const key = `${entry.kind}\u0000${entry.identity}\u0000${entry.version}`
    const previous = identities.get(key)
    if (previous !== undefined) {
      fail('LINK_CATALOG_IDENTITY_CONFLICT', `The current Host exposes conflicting contracts for ${entry.kind}:${entry.identity}@${entry.version}`, {
        schemaDigests: [previous.schemaDigest, entry.schemaDigest],
      })
    }
    identities.set(key, entry)
  }
  const catalog = { schemaVersion: SKILL_LINK_CATALOG_SCHEMA, entries }
  const bytes = Buffer.byteLength(JSON.stringify(catalog), 'utf8')
  if (bytes > SKILL_LINK_CATALOG_MAX_BYTES) {
    fail('LINK_CATALOG_OUTPUT_LIMIT', `The current Host catalog exceeds ${SKILL_LINK_CATALOG_MAX_BYTES} bytes`)
  }
  return catalog
}

export async function exportSkillLinkCatalog(options = {}, dependencies = {}) {
  const paths = await readStatePaths(resolveStateRoot(options.stateRoot))
  const state = await loadState(paths)
  if (state === null) fail('NOT_INSTALLED', 'No Agent environment is installed')
  const config = await readJson(state.runtime?.configPath)
  if (config === null) fail('LINK_CATALOG_RUNTIME_CONFIG_UNAVAILABLE', 'The current Direct Runtime configuration is unavailable')
  const [semantics, tools] = await Promise.all([
    semanticEntries(config),
    toolEntries(state, dependencies.listMcpTools ?? listMcpTools),
  ])
  return finalize([...semantics, ...tools])
}

export function skillLinkSchemaDigest(inputSchema, outputSchema) {
  return schemaDigest(inputSchema, outputSchema)
}
