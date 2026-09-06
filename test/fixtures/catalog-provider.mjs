import { createInterface } from 'node:readline'

const mode = process.argv[2] ?? 'normal'
const tools = [
  { name: 'input_only', description: 'Result schema is available separately on demand.', inputSchema: { type: 'object', properties: {} } },
  { name: 'inline_output', description: 'Returns one typed object.', inputSchema: { type: 'object', properties: {} }, outputSchema: { type: 'object', properties: { value: { type: 'string' } } } },
]
if (mode === 'large') tools[0].description = 'x'.repeat(70_000)
if (mode === 'bad-input') tools[0].inputSchema = null
if (mode === 'bad-output') tools[1].outputSchema = []
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  const response = { jsonrpc: '2.0', id: request.id }
  if (request.method === 'initialize') response.result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'catalog-provider', version: '1.0.0' } }
  else if (request.method === 'tools/list') response.result = { tools }
  else response.error = { code: -32601, message: 'Only catalog observation is implemented' }
  process.stdout.write(JSON.stringify(response) + '\n')
}).on('close', () => process.exit(0))
