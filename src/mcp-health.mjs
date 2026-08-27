import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { AgentHostError } from './errors.mjs'

export async function probeMcpTools(component) {
  if (typeof component.command !== 'string' || !Array.isArray(component.args) || typeof component.cwd !== 'string') {
    throw new AgentHostError('TOOL_HEALTH_CONFIG_INVALID', 'The installed tool health configuration is incomplete')
  }
  const timeoutMs = component.healthTimeoutMs ?? 10000
  const env = getDefaultEnvironment()
  for (const name of component.workspaceEnvironment ?? []) env[name] = component.cwd
  const transport = new StdioClientTransport({
    command: component.command,
    args: component.args,
    cwd: component.cwd,
    env,
    stderr: 'pipe',
    maxBufferSize: 4 * 1024 * 1024,
  })
  const client = new Client({ name: 'agent-host-health', version: '0.1.0' }, { capabilities: {} })
  let timer
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new AgentHostError('TOOL_HEALTH_TIMEOUT', `The ${component.displayName ?? 'installed tool'} health check timed out`)), timeoutMs)
    })
    await Promise.race([client.connect(transport), timeout])
    const response = await Promise.race([client.listTools(), timeout])
    const names = response.tools.map((tool) => tool.name).sort()
    const missing = (component.expectedTools ?? []).filter((name) => !names.includes(name))
    if (missing.length > 0) throw new AgentHostError('TOOL_HEALTH_TOOLS_MISSING', `${component.displayName ?? 'Installed tool'} did not expose its expected tools`, { missing })
    const incomplete = response.tools
      .filter((tool) => (component.expectedTools ?? names).includes(tool.name))
      .filter((tool) => tool.inputSchema === null || typeof tool.inputSchema !== 'object' || tool.outputSchema === null || typeof tool.outputSchema !== 'object')
      .map((tool) => tool.name)
    if (incomplete.length > 0) {
      throw new AgentHostError('TOOL_HEALTH_CATALOG_INCOMPLETE', `${component.displayName ?? 'Installed tool'} lacks complete typed tool catalog entries`, { tools: incomplete })
    }
    return { status: 'ok', tools: names, expectedTools: component.expectedTools ?? [], server: client.getServerVersion() ?? null }
  } finally {
    clearTimeout(timer)
    await transport.close().catch(() => {})
  }
}
