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
