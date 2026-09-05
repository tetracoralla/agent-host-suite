import assert from 'node:assert/strict'
import test from 'node:test'
import { validateToolIntegration } from '../src/tool-integration.mjs'

function fixture() {
  return {
    schemaVersion: 'openadam.agent-host-tool-integration.v0.1',
    displayName: 'File Vitals',
    summary: 'Inspect local files before acting on them.',
    codex: {
      marketplaceRoot: 'marketplace',
      marketplace: 'file-vitals-local',
      pluginRoot: 'marketplace/plugins/file-vitals',
      plugin: 'file-vitals',
      identityFiles: ['.codex-plugin/plugin.json', '.mcp.json'],
    },
    runtime: {
      transport: 'mcp-stdio',
      command: 'marketplace/plugins/file-vitals/runtime/finspect',
      args: ['mcp'],
      cwd: 'marketplace/plugins/file-vitals',
      workspaceEnvironment: ['UFI_WORKSPACE_ROOT'],
      expectedTools: ['inspect_file'],
      timeoutMs: 10000,
    },
    ownership: { uninstall: 'agent-host-created-only' },
  }
}

const files = new Set([
  'marketplace/.agents/plugins/marketplace.json',
  'marketplace/plugins/file-vitals/.codex-plugin/plugin.json',
  'marketplace/plugins/file-vitals/.mcp.json',
  'marketplace/plugins/file-vitals/runtime/finspect',
])

test('tool integration accepts one closed immutable Codex and MCP binding', () => {
  assert.equal(validateToolIntegration(fixture(), files).displayName, 'File Vitals')
})

test('tool integration v0.2 accepts a contained script executed by the shared Suite Node runtime', () => {
  const value = fixture()
  value.schemaVersion = 'openadam.agent-host-tool-integration.v0.2'
  value.runtime.executor = 'suite-node'
  value.runtime.command = 'marketplace/plugins/file-vitals/server/index.mjs'
  const withScript = new Set([...files, value.runtime.command])
  assert.equal(validateToolIntegration(value, withScript).runtime.executor, 'suite-node')
})

test('tool integration v0.3 accepts one Skill and version-locked CLI discovery carrier', () => {
  const value = fixture()
  value.schemaVersion = 'openadam.agent-host-tool-integration.v0.3'
  value.runtime.executor = 'suite-node'
  value.runtime.command = 'marketplace/plugins/file-vitals/server/index.mjs'
  value.discovery = {
    kind: 'skill-cli',
    skill: {
      id: 'file-vitals',
      root: 'marketplace/plugins/file-vitals/skills/file-vitals',
      identityFiles: ['SKILL.md'],
      launcher: 'scripts/file-vitals',
    },
    runtime: {
      executor: 'suite-node',
      command: 'marketplace/plugins/file-vitals/dist/cli.js',
      args: [],
      versionArguments: ['--version'],
    },
  }
  const withDiscovery = new Set([
    ...files,
    value.runtime.command,
    value.discovery.runtime.command,
    'marketplace/plugins/file-vitals/skills/file-vitals/SKILL.md',
  ])
  assert.equal(validateToolIntegration(value, withDiscovery).discovery.kind, 'skill-cli')

  const sourceOwnedLauncher = new Set([...withDiscovery, 'marketplace/plugins/file-vitals/skills/file-vitals/scripts/file-vitals'])
  assert.throws(() => validateToolIntegration(value, sourceOwnedLauncher), (error) => error.code === 'TOOL_INTEGRATION_INVALID')
})

test('tool integration v0.3 requires a closed discovery carrier', () => {
  const value = fixture()
  value.schemaVersion = 'openadam.agent-host-tool-integration.v0.3'
  value.runtime.executor = 'component'
  assert.throws(() => validateToolIntegration(value, files), (error) => error.code === 'TOOL_INTEGRATION_INVALID')
})

test('tool integration v0.4 accepts one closed Direct Capability binding', () => {
  const value = fixture()
  value.schemaVersion = 'openadam.agent-host-tool-integration.v0.4'
  value.runtime.executor = 'component'
  value.directCapability = {
    providerId: 'io.example.file-vitals',
    transport: 'capability-jsonl-v0.1',
    lifecycle: 'per-call',
    workspaceRoot: 'host-required',
    capabilityId: 'org.example.file.inspect',
    capabilityVersion: '0.1.0',
    adapter: {
      command: 'marketplace/plugins/file-vitals/runtime/finspect',
      args: ['capability'],
      cwd: 'marketplace/plugins/file-vitals',
    },
    manifest: 'marketplace/plugins/file-vitals/capabilities/provider.json',
    profile: 'capability-contracts/profile.json',
    identityFiles: ['marketplace/plugins/file-vitals/runtime/finspect'],
    contracts: [{
      operationId: 'inspect',
      inputSchema: 'capability-contracts/schemas/input.json',
      outputSchema: 'capability-contracts/schemas/output.json',
    }],
  }
  const withCapability = new Set([
    ...files,
    value.directCapability.manifest,
    value.directCapability.profile,
    value.directCapability.contracts[0].inputSchema,
    value.directCapability.contracts[0].outputSchema,
  ])
  assert.equal(validateToolIntegration(value, withCapability).directCapability.transport, 'capability-jsonl-v0.1')

  value.directCapability.identityFiles = [value.directCapability.manifest]
  assert.throws(() => validateToolIntegration(value, withCapability), (error) => error.code === 'TOOL_INTEGRATION_INVALID')
})

test('tool integration v0.5 declares optional host path environments separately from the workspace', () => {
  const value = fixture()
  value.schemaVersion = 'openadam.agent-host-tool-integration.v0.5'
  value.runtime.executor = 'component'
  value.runtime.optionalPathEnvironment = ['PLUGIN_CACHE_ROOTS', 'APPLICATION_ROOTS']
  assert.deepEqual(validateToolIntegration(value, files).runtime.optionalPathEnvironment, ['PLUGIN_CACHE_ROOTS', 'APPLICATION_ROOTS'])

  value.runtime.optionalPathEnvironment.push('UFI_WORKSPACE_ROOT')
  assert.throws(() => validateToolIntegration(value, files), (error) => error.code === 'TOOL_INTEGRATION_INVALID')
})

test('tool integration v0.1 rejects an undeclared executor', () => {
  const value = fixture()
  value.runtime.executor = 'suite-node'
  assert.throws(() => validateToolIntegration(value, files), (error) => error.code === 'TOOL_INTEGRATION_INVALID')
})

test('tool integration rejects arbitrary commands, unknown fields, and weak ownership', () => {
  const commandEscape = fixture()
  commandEscape.runtime.command = '../bin/tool'
  assert.throws(() => validateToolIntegration(commandEscape, files), (error) => error.code === 'TOOL_INTEGRATION_INVALID')

  const unknown = fixture()
  unknown.marketplace = { rating: 5 }
  assert.throws(() => validateToolIntegration(unknown, files), (error) => error.code === 'TOOL_INTEGRATION_INVALID')

  const ownership = fixture()
  ownership.ownership.uninstall = 'remove-anything'
  assert.throws(() => validateToolIntegration(ownership, files), (error) => error.code === 'TOOL_INTEGRATION_INVALID')
})
