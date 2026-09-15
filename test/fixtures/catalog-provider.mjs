import { createInterface } from 'node:readline'
import { catalogToolsForMode } from './managed-catalog-shapes.mjs'

const mode = process.argv[2] ?? 'normal'
const tools = catalogToolsForMode(mode)
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  const response = { jsonrpc: '2.0', id: request.id }
  if (request.method === 'initialize') response.result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'catalog-provider', version: '1.0.0' } }
  else if (request.method === 'tools/list') response.result = { tools }
  else response.error = { code: -32601, message: 'Only catalog observation is implemented' }
  process.stdout.write(JSON.stringify(response) + '\n')
}).on('close', () => process.exit(0))
