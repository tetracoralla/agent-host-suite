import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { doctor } from '../src/doctor.mjs'
import { setup } from '../src/setup.mjs'
import { loadState, prepareStatePaths } from '../src/state.mjs'
import { createCodexRunner, createDevelopmentWorkspace } from './helpers.mjs'

function serviceDownRunner(base) {
  return async (command, args, options = {}) => {
    if (command === '/bin/launchctl') return { status: 1, stdout: '', stderr: 'no such service' }
    return base(command, args, options)
  }
}

test('deep doctor reports per-tool direct checks while the service is not running', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-workspace-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-state-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(stateRoot, { recursive: true, force: true })]))
  await createDevelopmentWorkspace(root)
  const fake = createCodexRunner({ mathPresent: false, timePresent: false })
  await setup({ profile: 'standard', hosts: ['codex'], developmentRoot: root, stateRoot, noService: true, dryRun: false, enableObservability: false }, { runner: fake.runner })
  const state = await loadState(await prepareStatePaths(stateRoot))

  const deep = await doctor(state, { deep: true, runner: serviceDownRunner(fake.runner) })
  const statuses = Object.fromEntries(deep.checks.map((item) => [item.id, item.status]))
  assert.equal(statuses['runtime.service'], 'error')
  assert.equal(statuses['tool.math-anchor.direct'], 'error')
  assert.equal(statuses['tool.migratory-time.direct'], 'error')
  assert.equal(deep.status, 'error')

  const shallow = await doctor(state, { runner: serviceDownRunner(fake.runner) })
  assert.equal(shallow.checks.filter((item) => item.id.startsWith('tool.')).length, 0)
})

test('deep doctor probes generic installed tools through their MCP binding contract', async () => {
  const state = {
    channel: 'development',
    components: {
      'file-vitals': {
        version: '0.3.2',
        displayName: 'File Vitals',
        toolIntegrationSchema: 'openadam.agent-host-tool-integration.v0.1',
        identityFiles: [],
        command: '/private/file-vitals',
        args: ['mcp'],
        cwd: '/private',
        expectedTools: ['inspect_file'],
      },
    },
    hosts: {},
    runtime: { service: null },
  }
  const result = await doctor(state, {
    deep: true,
    runner: async () => ({ status: 0, stdout: '', stderr: '' }),
    mcpProbe: async (component) => ({ status: 'ok', tools: component.expectedTools, server: { name: 'file-vitals', version: '0.3.2' } }),
  })
  assert.equal(result.checks.find((item) => item.id === 'tool.file-vitals.installed')?.status, 'ok')
})
