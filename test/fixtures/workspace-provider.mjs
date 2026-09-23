import { appendFileSync, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline'

// A real subprocess fixture: record startup before using the grant so tests
// can distinguish pre-spawn refusal from a Provider that rejected its input.
if (process.argv[2]) appendFileSync(process.argv[2], JSON.stringify({
  workspace: process.env.PROVIDER_FIXTURE_WORKSPACE ?? null,
  extraRoots: process.env.PROVIDER_FIXTURE_EXTRA_ROOTS ?? null,
  cwd: process.cwd(),
}) + '\n')
const readInput = (root) => readFileSync(join(root, 'input.txt'), 'utf8')
const value = readInput(process.env.PROVIDER_FIXTURE_WORKSPACE)
const extras = (process.env.PROVIDER_FIXTURE_EXTRA_ROOTS ?? '').split(delimiter).filter(Boolean).map(readInput)
const tools = [{
  name: 'armorial.select', description: 'Read the fixture from the explicit workspace.',
  inputSchema: { type: 'object', additionalProperties: false },
  outputSchema: {
    type: 'object', additionalProperties: false, required: ['value', 'extras'],
    properties: { value: { const: value }, extras: { const: extras } },
  },
}]
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  const response = { jsonrpc: '2.0', id: request.id }
  if (request.method === 'initialize') response.result = {
    protocolVersion: request.params.protocolVersion, capabilities: { tools: {} },
    serverInfo: { name: 'workspace-provider', version: '0.7.0' },
  }
  else if (request.method === 'tools/list') response.result = { tools }
  else if (request.method === 'tools/call' && request.params.name === 'armorial.select') response.result = {
    content: [{ type: 'text', text: JSON.stringify({ value, extras }) }], structuredContent: { value, extras },
  }
  else response.error = { code: -32601, message: 'Unknown fixture method' }
  process.stdout.write(JSON.stringify(response) + '\n')
}).on('close', () => process.exit(0))
