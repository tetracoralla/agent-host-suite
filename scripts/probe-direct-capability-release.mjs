import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { prepareRuntimeConfig } from '../packages/direct-execution-runtime/src/config.mjs'
import { DirectExecutionRuntime } from '../packages/direct-execution-runtime/src/runtime.mjs'
import { hostFacingManifest, loadProfile } from '../src/profile.mjs'
import { cleanupMaterializedRelease, materializeRelease } from '../src/release-artifacts.mjs'
import { loadReleaseManifest } from '../src/release-manifest.mjs'
import { createRuntimeConfig } from '../src/runtime-config.mjs'
import { prepareStatePaths } from '../src/state.mjs'

const manifestArgument = process.argv[2]
if (manifestArgument === undefined) {
  throw new Error('Usage: npm run probe:direct-capability-release -- <release-manifest>')
}
const manifestPath = resolve(manifestArgument)
const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-direct-capability-'))
const workspaceRoot = join(stateRoot, 'workspace')
let preparation = null
let runtime = null

function dataCall(id, source) {
  return {
    schemaVersion: 'openadam.direct-work-order.v0.1',
    id: `work-${id}`,
    calls: [{
      id,
      providerId: 'io.github.tetracoralla.batchticket',
      target: {
        kind: 'capability',
        capabilityId: 'org.openadam.structured-data.analyze',
        capabilityVersion: '0.1.0',
        operationId: 'inspect',
      },
      input: { source, sample_rows: 1 },
    }],
  }
}

function fileCall(id, input) {
  return {
    schemaVersion: 'openadam.direct-work-order.v0.1',
    id: `work-${id}`,
    calls: [{
      id,
      providerId: 'io.github.tetracoralla.file-vitals',
      target: {
        kind: 'capability',
        capabilityId: 'org.openadam.file.inspect',
        capabilityVersion: '0.1.0',
        operationId: 'inspect',
      },
      input,
    }],
  }
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}

function isInside(root, candidate) {
  const remainder = relative(root, candidate)
  return remainder === '' || (!isAbsolute(remainder) && remainder !== '..' && !remainder.startsWith(`..${sep}`))
}

async function timed(workOrder) {
  const startedAt = performance.now()
  const result = await runtime.runWorkOrder(workOrder)
  return { result, elapsedMs: performance.now() - startedAt }
}

try {
  await mkdir(workspaceRoot)
  await writeFile(join(workspaceRoot, 'users.json'), JSON.stringify([
    { id: 1, name: 'Ada' },
    { id: 2, name: 'Lin' },
  ]))
  const release = await loadReleaseManifest(manifestPath)
  const profile = await loadProfile('local-dogfood')
  const paths = await prepareStatePaths(join(stateRoot, 'state'))
  preparation = await materializeRelease(release, paths, { componentIds: profile.components })
  const manifest = preparation.manifest
  const dataTransformer = manifest.components['data-transformer']
  const fileVitals = manifest.components['file-vitals']
  assert.equal(dataTransformer.version, '0.2.0')
  assert.equal(fileVitals.version, '0.3.3')
  assert.equal(dataTransformer.capabilityProvider.lifecycle, 'persistent')
  assert.equal(dataTransformer.capabilityProvider.workspaceRootRequired, true)
  assert.equal(fileVitals.capabilityProvider.lifecycle, 'persistent')
  assert.equal(fileVitals.capabilityProvider.workspaceRootRequired, true)
  const inactiveAgentManifest = hostFacingManifest(
    manifest,
    profile.agentComponents.filter((id) => !['data-transformer', 'file-vitals'].includes(id)),
  )
  assert.equal(inactiveAgentManifest.components['data-transformer'], undefined)
  assert.equal(inactiveAgentManifest.components['file-vitals'], undefined)

  const prepared = await prepareRuntimeConfig(createRuntimeConfig(manifest, { workspaceRoot }))
  const bindings = new Map([
    ['io.github.tetracoralla.batchticket', {
      binding: prepared.providers.get('io.github.tetracoralla.batchticket'),
      component: dataTransformer,
    }],
    ['io.github.tetracoralla.file-vitals', {
      binding: prepared.providers.get('io.github.tetracoralla.file-vitals'),
      component: fileVitals,
    }],
  ])
  for (const [providerId, { binding, component }] of bindings) {
    assert.notEqual(binding, undefined, `${providerId} binding is absent`)
    assert.equal(binding.workspaceRoot, await realpath(workspaceRoot))
    const materializedComponentRoot = await realpath(component.root)
    assert.equal(isInside(materializedComponentRoot, binding.rootPath), true)
    for (const path of [binding.rootPath, binding.adapterCommand, binding.manifestPath]) {
      assert.equal(isInside(materializedComponentRoot, path), true)
    }
  }
  assert.equal(bindings.get('io.github.tetracoralla.batchticket').binding.providerVersion, '0.2.0')
  assert.equal(bindings.get('io.github.tetracoralla.file-vitals').binding.providerVersion, '0.3.3')

  runtime = new DirectExecutionRuntime(prepared)
  const dataCold = await timed(dataCall('data-cold', { path: 'users.json' }))
  assert.equal(dataCold.result.calls[0].status, 'ok')
  assert.equal(dataCold.result.calls[0].result.shape.rows, 2)

  const dataWarm = []
  for (let index = 0; index < 20; index += 1) {
    const sample = await timed(dataCall(`data-warm-${index}`, { path: 'users.json' }))
    assert.equal(sample.result.calls[0].status, 'ok')
    dataWarm.push(sample.elapsedMs)
  }

  const dataForbidden = await timed(dataCall('data-forbidden', { path: '../users.json' }))
  assert.equal(dataForbidden.result.calls[0].error.code, 'PATH_FORBIDDEN')
  const dataRecovered = await timed(dataCall('data-recovered', { path: 'users.json' }))
  assert.equal(dataRecovered.result.calls[0].status, 'ok')

  const fileCold = await timed(fileCall('file-cold', { path: 'users.json' }))
  assert.equal(fileCold.result.calls[0].status, 'ok')
  assert.equal(fileCold.result.calls[0].result.identity.media_type, 'application/json')
  const fileWarm = []
  for (let index = 0; index < 10; index += 1) {
    const sample = await timed(fileCall(`file-warm-${index}`, { path: 'users.json', mode: 'quick' }))
    assert.equal(sample.result.calls[0].status, 'ok')
    fileWarm.push(sample.elapsedMs)
  }
  const fileForbidden = await timed(fileCall('file-forbidden', { path: '../users.json' }))
  assert.equal(fileForbidden.result.calls[0].error.code, 'PATH_FORBIDDEN')
  const fileRecovered = await timed(fileCall('file-recovered', { path: 'users.json' }))
  assert.equal(fileRecovered.result.calls[0].status, 'ok')

  process.stdout.write(`${JSON.stringify({
    status: 'ok',
    releaseId: manifest.releaseId,
    carrier: 'direct-capability-jsonl',
    mcpActive: false,
    sourceCheckoutUsed: false,
    workspaceAuthority: 'host-explicit-root',
    providers: [
      {
        providerId: 'io.github.tetracoralla.batchticket',
        version: bindings.get('io.github.tetracoralla.batchticket').binding.providerVersion,
        coldMs: Math.round(dataCold.elapsedMs * 100) / 100,
        warmCalls: dataWarm.length,
        warmP50Ms: Math.round(percentile(dataWarm, 0.5) * 100) / 100,
        warmP95Ms: Math.round(percentile(dataWarm, 0.95) * 100) / 100,
        forbiddenPathCode: dataForbidden.result.calls[0].error.code,
        recoveryMs: Math.round(dataRecovered.elapsedMs * 100) / 100,
      },
      {
        providerId: 'io.github.tetracoralla.file-vitals',
        version: bindings.get('io.github.tetracoralla.file-vitals').binding.providerVersion,
        coldMs: Math.round(fileCold.elapsedMs * 100) / 100,
        warmCalls: fileWarm.length,
        warmP50Ms: Math.round(percentile(fileWarm, 0.5) * 100) / 100,
        warmP95Ms: Math.round(percentile(fileWarm, 0.95) * 100) / 100,
        forbiddenPathCode: fileForbidden.result.calls[0].error.code,
        recoveryMs: Math.round(fileRecovered.elapsedMs * 100) / 100,
      },
    ],
  }, null, 2)}\n`)
} finally {
  await runtime?.close().catch(() => {})
  if (preparation !== null) await cleanupMaterializedRelease(preparation)
  await rm(stateRoot, { recursive: true, force: true })
}
