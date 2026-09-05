import { AgentHostError } from './errors.mjs'
import { probeMcpToolsFirstAndRepeat } from './mcp-health.mjs'

export const COMPONENT_WARMUP_POLICY_VERSION = 1

const SPECIALIZED_EXPECTED_TOOLS = {
  'math-anchor': ['math.batch', 'math.describe', 'math.run', 'math.search'],
  'migratory-time': ['convert_time', 'current_times', 'list_time_zones', 'search_time_zones'],
}

function probeTarget(id, component, workspaceRoot) {
  if (component === undefined || typeof component.command !== 'string') return null
  const expectedTools = component.expectedTools ?? SPECIALIZED_EXPECTED_TOOLS[id]
  if (!Array.isArray(expectedTools) || expectedTools.length === 0) return null
  return {
    ...component,
    cwd: component.cwd ?? component.pluginRoot ?? component.root,
    expectedTools,
    healthTimeoutMs: component.healthTimeoutMs ?? (id === 'math-anchor' ? 30_000 : 10_000),
    healthWorkspaceRoot: workspaceRoot,
  }
}

export async function warmInstalledAgentComponents({
  manifest,
  componentIds,
  workspaceRoot,
}, dependencies = {}) {
  const probe = dependencies.probe ?? probeMcpToolsFirstAndRepeat
  const results = []

  if (componentIds.length === 0) {
    return { status: 'skipped', strategy: 'no-agent-tool-fingerprint-change', components: [] }
  }

  for (const id of componentIds) {
    const component = manifest.components[id]
    const target = probeTarget(id, component, workspaceRoot)
    if (target === null) {
      throw new AgentHostError(
        'COMPONENT_WARMUP_UNAVAILABLE',
        `The installed Agent tool ${id} does not expose a warm-up health target`,
        { component: id },
      )
    }
    const health = await probe(target)
    results.push({
      id,
      version: component.version,
      firstLaunchMs: health.firstLaunchMs,
      repeatLaunchMs: health.repeatLaunchMs,
      tools: health.repeat.tools,
      catalogUtf8Bytes: health.repeat.catalogUtf8Bytes,
      largestToolUtf8Bytes: health.repeat.largestToolUtf8Bytes,
      catalogSha256: health.repeat.catalogSha256,
    })
  }

  return {
    status: 'ok',
    strategy: 'sequential-first-and-repeat',
    components: results,
  }
}
