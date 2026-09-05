import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { exportSkillLinkCatalog, skillLinkSchemaDigest } from '../src/skill-link-catalog.mjs'
import { prepareStatePaths, saveState } from '../src/state.mjs'

const now = '2026-08-31T00:00:00.000Z'

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-link-catalog-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const paths = await prepareStatePaths(join(root, 'state'))
  const contracts = join(root, 'contracts')
  await mkdir(contracts, { recursive: true })
  const capabilityInput = { type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type: 'string' } } }
  const capabilityOutput = { type: 'object', additionalProperties: false, required: ['valid'], properties: { valid: { type: 'boolean' } } }
  const procedureInput = { type: 'object', additionalProperties: false, required: ['source'], properties: { source: { type: 'string' } } }
  const procedureOutput = { type: 'object', additionalProperties: false, required: ['status'], properties: { status: { const: 'complete' } } }
  await Promise.all([
    writeJson(join(contracts, 'capability-input.json'), capabilityInput),
    writeJson(join(contracts, 'capability-output.json'), capabilityOutput),
    writeJson(join(contracts, 'procedure-input.json'), procedureInput),
    writeJson(join(contracts, 'procedure-output.json'), procedureOutput),
  ])
  const configPath = join(paths.runtime, 'provider-config.json')
  await writeJson(configPath, {
    schemaVersion: 'openadam.direct-provider-config.v0.2',
    providers: [
      {
        providerId: 'fixture.capability', transport: 'capability-jsonl-v0.1', lifecycle: 'per-call', rootPath: root,
        profilePath: join(contracts, 'profile.json'), manifestPath: join(contracts, 'manifest.json'), identityFiles: [join(contracts, 'manifest.json')],
        capabilityId: 'fixture.record.validate', capabilityVersion: '0.1.0',
        contracts: [{ operationId: 'validate', inputSchemaPath: join(contracts, 'capability-input.json'), outputSchemaPath: join(contracts, 'capability-output.json') }],
      },
      {
        providerId: 'fixture.procedure', transport: 'procedure-jsonl-v0.2', lifecycle: 'per-call', rootPath: root,
        profilePath: join(contracts, 'procedure-profile.json'), implementationManifestPath: join(contracts, 'procedure-manifest.json'), identityFiles: [join(contracts, 'procedure-manifest.json')],
        procedureId: 'fixture.document.prepare', procedureVersion: '0.2.0',
        inputSchemaPath: join(contracts, 'procedure-input.json'), outputSchemaPath: join(contracts, 'procedure-output.json'),
      },
    ],
  })
  await saveState(paths, {
    schemaVersion: 'openadam.agent-host-state.v0.1', suiteVersion: '0.1.1', channel: 'release', profile: 'standard',
    installedAt: now, updatedAt: now,
    components: {
      'fixture-tool': {
        version: '1.2.3', command: '/fixture/server', args: [], cwd: root,
        expectedTools: ['fixture.check'], workspaceEnvironment: [], healthTimeoutMs: 5000,
      },
    },
    availableAgentComponents: ['fixture-tool'], agentComponents: ['fixture-tool'], privateComponents: {},
    hosts: {}, runtime: { configPath }, observability: { enabled: false },
  })
  return { paths, capabilityInput, capabilityOutput, procedureInput, procedureOutput }
}

test('Host exports exact configured Capability, Procedure, and active Tool links', async (t) => {
  const { paths, capabilityInput, capabilityOutput, procedureInput, procedureOutput } = await fixture(t)
  const toolInput = { type: 'object', additionalProperties: false, required: ['record'], properties: { record: {} } }
  const toolOutput = { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } }
  const catalog = await exportSkillLinkCatalog({ stateRoot: paths.root }, {
    listMcpTools: async () => [{ name: 'fixture.check', inputSchema: toolInput, outputSchema: toolOutput }],
  })
  assert.deepEqual(catalog, {
    schemaVersion: 'openadam.skill-link-catalog.v0.2',
    entries: [
      { kind: 'capability', identity: 'fixture.record.validate#validate', version: '0.1.0', schemaDigest: skillLinkSchemaDigest(capabilityInput, capabilityOutput) },
      { kind: 'procedure', identity: 'fixture.document.prepare', version: '0.2.0', schemaDigest: skillLinkSchemaDigest(procedureInput, procedureOutput) },
      { kind: 'tool', identity: 'fixture.check', version: '1.2.3', schemaDigest: skillLinkSchemaDigest(toolInput, toolOutput) },
    ],
  })
})

test('Host catalog fails closed when an active expected Tool is absent', async (t) => {
  const { paths } = await fixture(t)
  await assert.rejects(
    exportSkillLinkCatalog({ stateRoot: paths.root }, { listMcpTools: async () => [] }),
    (error) => error.code === 'LINK_CATALOG_TOOL_MISSING',
  )
})

test('Host catalog rejects conflicting exact identities', async (t) => {
  const { paths } = await fixture(t)
  const statePath = join(paths.root, 'state.json')
  const state = JSON.parse(await (await import('node:fs/promises')).readFile(statePath, 'utf8'))
  state.components.second = { ...state.components['fixture-tool'], version: '1.2.3', expectedTools: ['fixture.check'] }
  state.availableAgentComponents.push('second')
  state.agentComponents.push('second')
  await saveState(paths, state)
  let call = 0
  await assert.rejects(
    exportSkillLinkCatalog({ stateRoot: paths.root }, {
      listMcpTools: async () => [{
        name: 'fixture.check',
        inputSchema: { type: 'string' },
        outputSchema: { type: call++ === 0 ? 'string' : 'number' },
      }],
    }),
    (error) => error.code === 'LINK_CATALOG_IDENTITY_CONFLICT',
  )
})
