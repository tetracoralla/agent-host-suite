import { canonicalJson } from '../../src/json.mjs'

// Measured live combination: five tools + Migratory Time → 29 operations / 78,206 bytes.
export const SIX_TOOL_COMBINATION = Object.freeze({
  prefix: 'six_tool',
  toolCount: 29,
  canonicalUtf8Bytes: 78_206,
})

// Observed local-dogfood-scale inventory used by operations-snapshot fixtures.
export const TRUSTED_LARGE_CATALOG = Object.freeze({
  prefix: 'trusted',
  toolCount: 31,
  canonicalUtf8Bytes: 191_032,
})

export const RUNAWAY_CATALOG = Object.freeze({
  prefix: 'runaway',
  toolCount: 80,
  canonicalUtf8Bytes: 400_000,
})

export const RUNAWAY_TOOL_COUNT = 129

// Keep representative tools below the Host per-tool resource cap and near the
// measured 26 KiB largest operation of the trusted inventory.
const REPRESENTATIVE_MAX_TOOL_UTF8_BYTES = 32_768

function canonicalSize(tools) {
  return Buffer.byteLength(canonicalJson(tools), 'utf8')
}

function emptyTool(prefix, index, description) {
  return {
    name: `${prefix}_${String(index).padStart(3, '0')}`,
    description,
    inputSchema: { type: 'object', properties: {} },
  }
}

export function representativeCatalogTools({ prefix, toolCount, canonicalUtf8Bytes }) {
  const tools = Array.from({ length: toolCount }, (_, index) => emptyTool(prefix, index, 'Representative managed-catalog operation.'))
  let remaining = canonicalUtf8Bytes - canonicalSize(tools)
  if (remaining < 0) {
    throw new Error(`representative catalog ${prefix} is already ${canonicalSize(tools)} bytes`)
  }
  while (remaining > 0) {
    let progressed = false
    for (const tool of tools) {
      if (remaining <= 0) break
      const room = REPRESENTATIVE_MAX_TOOL_UTF8_BYTES - Buffer.byteLength(canonicalJson(tool), 'utf8')
      if (room <= 0) continue
      const add = Math.min(remaining, room)
      tool.description += 'x'.repeat(add)
      remaining -= add
      progressed = true
    }
    if (!progressed) {
      throw new Error(`representative catalog ${prefix} cannot reach ${canonicalUtf8Bytes} bytes`)
    }
  }
  const measured = canonicalSize(tools)
  if (measured !== canonicalUtf8Bytes) {
    throw new Error(`representative catalog ${prefix} measured ${measured} bytes`)
  }
  return tools
}

export function oversizedCountCatalogTools() {
  return Array.from({ length: RUNAWAY_TOOL_COUNT }, (_, index) => emptyTool('count', index, 'Oversized provider catalog.'))
}

export function catalogToolsForMode(mode = 'normal') {
  const tools = [
    { name: 'input_only', description: 'Result schema is available separately on demand.', inputSchema: { type: 'object', properties: {} } },
    { name: 'inline_output', description: 'Returns one typed object.', inputSchema: { type: 'object', properties: {} }, outputSchema: { type: 'object', properties: { value: { type: 'string' } } } },
  ]
  if (mode === 'large') tools[0].description = 'x'.repeat(70_000)
  if (mode === 'bad-input') tools[0].inputSchema = null
  if (mode === 'bad-output') tools[1].outputSchema = []
  if (mode === 'six-tool') return representativeCatalogTools(SIX_TOOL_COMBINATION)
  if (mode === 'trusted-large') return representativeCatalogTools(TRUSTED_LARGE_CATALOG)
  if (mode === 'runaway') return representativeCatalogTools(RUNAWAY_CATALOG)
  if (mode === 'oversized-count') return oversizedCountCatalogTools()
  return tools
}
