#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { DirectExecutionRuntime, DirectHostService, prepareRuntimeConfig, parseStrictJson } from '../src/index.mjs'
import { digestJson } from '../src/json.mjs'
import { resolveProviderExecutable } from '../src/config.mjs'
import { compareCalls, consumerOrder, timingSummary, timeZoneTarget } from './substitution-consumer.mjs'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const workspace = resolve(root, '../../..')

function sourceRoot(environment, fallback) {
  const value = process.env[environment]
  if (value !== undefined && (!isAbsolute(value) || value.trim() === '')) {
    throw new Error(`${environment} must name an absolute source root`)
  }
  return value ?? resolve(workspace, fallback)
}

async function sourceIdentity(source) {
  const options = { cwd: source, timeout: 5000, maxBuffer: 1024 * 1024 }
  try {
    const revision = (await execFileAsync('git', ['rev-parse', 'HEAD'], options)).stdout.trim()
    const status = (await execFileAsync('git', ['status', '--porcelain'], options)).stdout
    return { revision, dirty: status !== '' }
  } catch {
    return { revision: null, dirty: null }
  }
}

async function main() {
  if (process.argv.length !== 2) throw new Error('Usage: check-local-substitution.mjs (source roots are selected by environment)')
  if (process.platform === 'win32') {
    process.stdout.write(`${JSON.stringify({ status: 'incomplete', execution: 'not_run', reason: 'The development witness launcher requires POSIX.' })}\n`)
    process.exitCode = 2
    return
  }
  const standards = sourceRoot('OPENADAM_CAPABILITY_CONTRACTS_ROOT', 'capability-contracts')
  const migratory = sourceRoot('OPENADAM_MIGRATORY_TIME_SOURCE_ROOT', 'migratory-time')
  const required = [
    resolve(standards, 'scripts/time-zone-substitution-corpus.mjs'),
    resolve(standards, 'test/providers/python-zoneinfo/adapter.py'),
    resolve(migratory, 'capabilities/provider.json'),
  ]
  const unavailable = []
  for (const path of required) {
    try { await access(path) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      unavailable.push(path)
    }
  }
  if (unavailable.length > 0) {
    process.stdout.write(`${JSON.stringify({ status: 'incomplete', unavailable, execution: 'not_run' })}\n`)
    process.exitCode = 2
    return
  }
  const { generateTimeZoneCorpus, assertUtcConversion, DEFAULT_SEED, DEFAULT_SAMPLES } =
    await import(pathToFileURL(required[0]))
  const { loadJson, validateDifferentialSuite } = await import(pathToFileURL(resolve(standards, 'src/lib/contracts.mjs')))
  const selectedPython = process.env.OPENADAM_SUBSTITUTION_PYTHON
  if (selectedPython !== undefined && !isAbsolute(selectedPython)) throw new Error('OPENADAM_SUBSTITUTION_PYTHON must be absolute')
  const python = await resolveProviderExecutable(selectedPython ?? 'python3', root)
  const pythonObservation = parseStrictJson((await execFileAsync(python, ['-c',
    'import json,sys; print(json.dumps({"version":sys.version,"executable":sys.executable}))'],
  { timeout: 5000, maxBuffer: 64 * 1024 })).stdout, 'witness interpreter observation')
  const base = await loadJson(resolve(standards, 'catalog/differential/time-zone-convert.v0.2.json'))
  const profilePath = resolve(standards, 'catalog/capabilities/time-zone-convert.v0.2.json')
  const suite = generateTimeZoneCorpus(base)
  await validateDifferentialSuite({ profile: await loadJson(profilePath), profilePath, suite })
  assert.deepEqual(suite.comparisonPolicy.ignoredResultPaths.map((entry) => entry.pointer), ['/context/timeZoneDatabase'])
  const temporary = await realpath(await mkdtemp(resolve('/tmp', 'direct-sub-')))
  let runtime
  let service
  let report
  try {
    const witness = resolve(temporary, 'witness')
    await mkdir(witness)
    for (const file of ['adapter.py', 'provider.json']) {
      await copyFile(resolve(standards, 'test/providers/python-zoneinfo', file), resolve(witness, file))
    }
    // System Python shims are not relocatable on macOS. This explicit
    // development launcher keeps the interpreter an observed external
    // dependency; the Host still freezes and verifies launcher + adapter bytes.
    const launcher = resolve(witness, 'launch-witness')
    await writeFile(launcher, `#!/bin/sh\nexec '${python.replaceAll("'", "'\\''")}' "$@"\n`)
    await chmod(launcher, 0o700)
    const witnessManifestPath = resolve(witness, 'provider.json')
    const witnessManifest = await loadJson(witnessManifestPath)
    witnessManifest.implementations[0].adapter.command = './launch-witness'
    await writeFile(witnessManifestPath, JSON.stringify(witnessManifest))
    for (const kind of ['input', 'output']) {
      await copyFile(resolve(standards, `catalog/capabilities/schemas/time-zone.convert.v0.2.${kind}.schema.json`),
        resolve(witness, `${kind}.json`))
    }
    const providerRoots = [migratory, witness]
    const providers = []
    for (const [index, providerRoot] of providerRoots.entries()) {
      const manifestPath = resolve(providerRoot, index === 0 ? 'capabilities/provider.json' : 'provider.json')
      const manifest = await loadJson(manifestPath)
      providers.push({
        providerId: manifest.provider.id, transport: 'capability-jsonl-v0.1', lifecycle: 'persistent',
        rootPath: providerRoot, profilePath, manifestPath,
        identityFiles: index === 0 ? [resolve(providerRoot, 'scripts/runCapabilityAdapter.mjs')]
          : [resolve(providerRoot, 'adapter.py'), launcher],
        capabilityId: timeZoneTarget.capabilityId, capabilityVersion: timeZoneTarget.capabilityVersion,
        contracts: [{
          operationId: 'convert',
          inputSchemaPath: resolve(providerRoot, index === 0 ? 'capabilities/schemas/time-zone.convert.input.schema.json' : 'input.json'),
          outputSchemaPath: resolve(providerRoot, index === 0 ? 'capabilities/schemas/time-zone.convert.output.schema.json' : 'output.json'),
        }],
      })
    }
    assert.notEqual(providers[0].providerId, providers[1].providerId, 'substitution requires distinct Provider identities')
    const prepared = await prepareRuntimeConfig({
      schemaVersion: 'openadam.direct-provider-config.v0.2', providers,
      limits: { maxConcurrentCalls: 1, maxQueuedCalls: 256, maxWorkOrderCalls: 128, defaultTimeoutMs: 30000 },
    })
    runtime = new DirectExecutionRuntime(prepared)
    const resolution = await runtime.resolveBindings({
      schemaVersion: 'openadam.direct-resolution-request.v0.1', target: timeZoneTarget,
      constraints: { effectAllowance: 'read-only', dataLocality: 'local-process' },
    })
    assert.equal(resolution.summary.eligible, 2)
    assert.equal(resolution.summary.exactCandidates, 2)
    const projections = []
    for (const candidate of resolution.candidates) projections.push(await runtime.projectContract(candidate.selection))
    const contractDigest = projections[0].contract.contractDigest
    assert.equal(projections[1].contract.contractDigest, contractDigest)
    assert.ok(runtime.sessionSnapshot().every((session) => session.pid === null), 'resolution started target execution')
    const measurements = []
    let expected
    for (const provider of providers) {
      const providerId = provider.providerId
      const started = performance.now()
      const cold = await runtime.runWorkOrder(consumerOrder(suite.cases.slice(0, 1), providerId))
      const coldMs = performance.now() - started
      compareCalls(suite.cases.slice(0, 1), cold.calls, { providerId, contractDigest, assertUtcConversion })
      assert.equal(cold.calls[0].session, 'cold')
      const calls = []
      const times = []
      let resultBytes = 0
      for (const entry of suite.cases) {
        const start = performance.now()
        const result = await runtime.runWorkOrder(consumerOrder([entry], providerId))
        times.push(performance.now() - start)
        calls.push(...result.calls)
        resultBytes += Buffer.byteLength(JSON.stringify(result))
      }
      const outcomes = compareCalls(suite.cases, calls, { providerId, contractDigest, expected, assertUtcConversion })
      assert.ok(calls.every((call) => call.session === 'warm'), 'library sample did not reuse its Provider session')
      expected ??= outcomes
      measurements.push({
        providerId, providerVersion: cold.calls[0].binding.providerVersion,
        bindingDigest: cold.calls[0].binding.digest,
        timeZoneDatabases: [...new Set(calls.filter((call) => call.status === 'ok')
          .map((call) => call.result.context.timeZoneDatabase))],
        library: { coldMs: Number(coldMs.toFixed(3)), warmMs: timingSummary(times), resultEnvelopeBytes: resultBytes },
      })
    }
    const socketPath = resolve(temporary, 'host.sock')
    service = new DirectHostService(runtime, { socketPath })
    const ready = await service.start()
    const requestPath = resolve(temporary, 'order.json')
    for (const measurement of measurements) {
      const calls = []
      const times = []
      for (let start = 0; start < suite.cases.length; start += 128) {
        await writeFile(requestPath, JSON.stringify(consumerOrder(suite.cases.slice(start, start + 128), measurement.providerId)))
        const started = performance.now()
        const result = await execFileAsync(process.execPath, [resolve(root, 'src/cli.mjs'), 'run',
          '--socket', ready.socketPath, '--work-order', requestPath], { timeout: 45000, maxBuffer: 4 * 1024 * 1024 })
        times.push(performance.now() - started)
        calls.push(...parseStrictJson(result.stdout, 'CLI substitution result').calls)
      }
      compareCalls(suite.cases, calls, { providerId: measurement.providerId, contractDigest, expected, assertUtcConversion })
      assert.ok(calls.every((call) => call.session === 'warm'), 'CLI service sample did not reuse its Provider session')
      measurement.cliOverWarmService = { orders: times.length, orderWallMs: timingSummary(times), calls: calls.length }
    }
    // A rejected contract must not silently select the other Provider.
    const mismatch = await runtime.resolveBindings({
      schemaVersion: 'openadam.direct-resolution-request.v0.1', target: timeZoneTarget,
      constraints: { effectAllowance: 'read-only', dataLocality: 'local-process', requiredContractDigest: `sha256:${'0'.repeat(64)}` },
    })
    assert.equal(mismatch.summary.eligible, 0)
    assert.equal(mismatch.summary.ineligible, 2)
    const invalid = consumerOrder(suite.cases.slice(0, 1), providers[0].providerId)
    invalid.calls[0].input.extra = true
    const rejected = await runtime.runWorkOrder(invalid)
    assert.equal(rejected.calls[0].status, 'host_error')
    assert.equal(rejected.calls[0].error.code, 'HOST_INPUT_INVALID')
    report = {
      status: 'passed', scope: 'development-only bounded substitution experiment',
      capability: timeZoneTarget, contractDigest,
      corpus: { seed: DEFAULT_SEED, samples: DEFAULT_SAMPLES, cases: suite.cases.length, digest: digestJson(suite),
        generatedUtcCases: suite.cases.length - base.cases.length },
      consumer: { carriers: ['library', 'CLI over warm local service'], semanticDigest: digestJson(expected),
        sourceDigest: `sha256:${createHash('sha256').update(await readFile(resolve(root, 'scripts/substitution-consumer.mjs'))).digest('hex')}`,
        providerSpecificInputOrResultBranches: false },
      resolution: { exactCandidates: 2, contractMismatchRejected: true, invalidInputRejected: true },
      measurements,
      sources: { host: await sourceIdentity(root), standards: await sourceIdentity(standards), migratory: await sourceIdentity(migratory) },
      witnessInterpreter: { command: python, ...pythonObservation, frozen: false },
      execution: { modelCalls: 0, tokenUsage: null, monetaryCost: null, externalCostStatus: 'not_observed' },
      limits: [
        'One domain and one consumer exercised through two Host carriers; not two independent consumers.',
        'Python zoneinfo is a development witness, not a second released Provider product.',
        'Both engines depend on IANA time-zone data; agreement does not independently verify the upstream database.',
        'Generated UTC cases cover 2024-2028 and nine target zones; fixed cases carry the listed ambiguity and error boundaries.',
        'No Profile promotion, installed Agent adoption, UI route, model comparison, or universal savings claim.',
        'The witness launcher uses the explicitly observed external Python executable; it is not a standalone artifact.',
        'Interpreter executables and libraries, undeclared imports and time-zone databases are not all frozen by declared binding digests.',
      ],
    }
  } finally {
    try {
      if (service !== undefined) await service.close()
      else await runtime?.close()
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }
  process.stdout.write(`${JSON.stringify({ observedAt: new Date().toISOString(), ...report })}\n`)
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ status: 'failed', message: error.message })}\n`)
  process.exitCode = 1
})
