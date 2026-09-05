#!/usr/bin/env node
import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareRuntimeConfig, resolveProviderExecutable } from '../src/config.mjs'
import { digestFile } from '../src/json.mjs'
import { createLaunchSnapshot } from '../src/launch-snapshot.mjs'
import { DirectExecutionRuntime } from '../src/runtime.mjs'
import {
  buildPackagedBinding,
  procedureCall,
  processGroupMembers,
  providerConfig,
  quantiles,
  readyInput,
  timedRun,
  verifyDirectory,
  workOrder,
} from './structured-data-procedure-pilot.mjs'
import { resolveProviderArtifacts, resolvePilotWorkspace } from './local-pilot-paths.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const workspace = resolvePilotWorkspace(root)
const procedureRoot = resolve(workspace, 'structured-data-preflight')
const capabilityRoot = resolve(workspace, 'capability-contracts/catalog/capabilities')

async function measureCold(config, repetitions = 3) {
  const executionSamples = []
  const completeSamples = []
  const resultBytes = []
  for (let index = 0; index < repetitions; index += 1) {
    const completeStarted = performance.now()
    const runtime = new DirectExecutionRuntime(await prepareRuntimeConfig(config))
    try {
      const measured = await timedRun(runtime, workOrder(`cold-${index}`, [
        procedureCall(`cold-${index}`, readyInput()),
      ]))
      assert.equal(measured.result.calls[0].status, 'ok')
      assert.equal(measured.result.calls[0].session, 'cold')
      executionSamples.push(measured.elapsedMs)
      resultBytes.push(measured.resultBytes)
    } finally {
      await runtime.close()
    }
    completeSamples.push(performance.now() - completeStarted)
  }
  return {
    executionsMs: quantiles(executionSamples),
    prepareRunCloseMs: quantiles(completeSamples),
    resultBytes: quantiles(resultBytes),
  }
}

async function inspectLaunchPlan(binding, packaged) {
  const snapshot = await createLaunchSnapshot(binding)
  try {
    assert.equal(snapshot.cwd, packaged.bindingRoot)
    assert.notEqual(snapshot.command, binding.adapterCommand)
    assert.equal(await digestFile(snapshot.command), binding.commandDigest)
    const environment = await snapshot.prepareEnvironment({ PATH: process.env.PATH })
    const stagedPathEntries = environment.PATH.split(delimiter).slice(0, packaged.providerPathEntries.length)
    assert.equal(stagedPathEntries.length, packaged.providerPathEntries.length)
    for (const pathEntry of stagedPathEntries) {
      assert.equal(pathEntry.startsWith(`${snapshot.rootPath}${sep}`), true)
      assert.equal((await lstat(pathEntry)).isDirectory(), true)
    }
    for (const pathEntry of packaged.providerPathEntries) {
      assert.equal(environment.PATH.split(delimiter).includes(pathEntry), false)
    }
    for (const identity of [
      ...packaged.providerIdentityFiles.fileVitals,
      ...packaged.providerIdentityFiles.batchTicket,
    ]) {
      const stagedIdentity = resolve(snapshot.rootPath, 'filesystem', relative(resolve('/'), identity))
      const info = await lstat(stagedIdentity)
      assert.equal(info.isFile(), true)
      assert.equal(info.isSymbolicLink(), false)
      assert.equal(stagedIdentity.startsWith(`${snapshot.rootPath}${sep}`), true)
      assert.equal(await digestFile(stagedIdentity), await digestFile(identity))
    }
    const snapshotBindingRoot = resolve(dirname(snapshot.command), '..')
    const runtimeArchive = resolve(snapshotBindingRoot, packaged.runtimeArchiveRelativePath)
    const runtimeArchiveInfo = await lstat(runtimeArchive)
    assert.equal(runtimeArchiveInfo.isFile(), true)
    assert.equal(runtimeArchiveInfo.isSymbolicLink(), false)
    assert.equal(runtimeArchive.startsWith(`${snapshot.rootPath}${sep}`), true)
    for (const relativePath of ['providers/file-vitals/runtime', 'providers/data-transformer/runtime']) {
      const info = await lstat(resolve(snapshotBindingRoot, relativePath))
      assert.equal(info.isDirectory(), true)
      assert.equal(info.isSymbolicLink(), false)
    }
    return {
      businessCwdPreserved: true,
      commandUsesPrivateSnapshot: true,
      runtimeArchiveUsesPrivateSnapshot: true,
      pythonRuntimeExpandsInsidePrivateSnapshot: true,
      procedureSiteExpandsInsidePrivateSnapshot: true,
      providerPathsUsePrivateSnapshot: true,
      commandDigest: binding.commandDigest,
    }
  } finally {
    await snapshot.dispose()
  }
}

async function runCompletionAndFailures(runtime, packaged) {
  const withoutValidation = await timedRun(runtime, workOrder('without-validation', [
    procedureCall('without-validation', readyInput()),
  ]))
  assert.equal(
    withoutValidation.result.calls[0].status,
    'ok',
    JSON.stringify(withoutValidation.result.calls[0]),
  )
  assert.equal(withoutValidation.result.calls[0].session, 'cold')
  assert.equal(withoutValidation.result.calls[0].result.readiness, 'ready')
  assert.equal(Object.hasOwn(withoutValidation.result.calls[0].result, 'validation'), false)

  const passValidation = await timedRun(runtime, workOrder('constraints-pass', [
    procedureCall('constraints-pass', readyInput({
      assertions: [{ id: 'has-rows', type: 'row_count', min: 1 }],
    })),
  ]))
  assert.equal(passValidation.result.calls[0].status, 'ok')
  assert.equal(passValidation.result.calls[0].session, 'warm')
  assert.equal(passValidation.result.calls[0].result.readiness, 'ready')
  assert.equal(passValidation.result.calls[0].result.validation.valid, true)

  const failedConstraints = await timedRun(runtime, workOrder('constraints-failed', [
    procedureCall('constraints-failed', readyInput({
      assertions: [{ id: 'wrong-count', type: 'row_count', eq: 99 }],
    })),
  ]))
  assert.equal(failedConstraints.result.calls[0].status, 'ok')
  assert.equal(failedConstraints.result.calls[0].result.readiness, 'constraints-failed')
  assert.equal(failedConstraints.result.calls[0].result.validation.valid, false)

  const failures = {}
  for (const [name, input, code] of [
    ['missing', { path: 'fixtures/missing.json' }, 'SOURCE_NOT_FOUND'],
    ['invalid-json', { path: 'fixtures/invalid.json' }, 'DATA_NOT_PARSEABLE'],
    ['path-escape', { path: '../outside.json' }, 'PATH_FORBIDDEN'],
    ['inspection-failed', { path: 'fixtures/users.json', select: 'missing[*]' }, 'DATA_INSPECTION_FAILED'],
    ['validation-failed', readyInput({ schema: { type: 'bogus' } }), 'DATA_VALIDATION_FAILED'],
  ]) {
    const result = await runtime.runWorkOrder(workOrder(name, [procedureCall(name, input)]))
    assert.equal(result.calls[0].status, 'provider_error')
    assert.equal(result.calls[0].error.code, code)
    failures[name] = { status: result.calls[0].status, code, retryable: result.calls[0].error.retryable }
  }

  const fileBinary = resolve(packaged.bindingRoot, 'providers/file-vitals/runtime/file-vitals-capability')
  const unavailableBinary = `${fileBinary}.unavailable`
  let frozenIdentitySurvival
  let missingIdentity
  await rename(fileBinary, unavailableBinary)
  try {
    frozenIdentitySurvival = await runtime.runWorkOrder(workOrder('frozen-identity-survival', [
      procedureCall('frozen-identity-survival', readyInput()),
    ]))
    assert.equal(frozenIdentitySurvival.calls[0].status, 'ok')
    assert.equal(frozenIdentitySurvival.calls[0].session, 'warm')
    await runtime.replaceProvider('org.openadam.structured-data-preflight')
    missingIdentity = await runtime.runWorkOrder(workOrder('missing-identity-cold-start', [
      procedureCall('missing-identity-cold-start', readyInput()),
    ]))
    assert.equal(missingIdentity.calls[0].status, 'host_error')
    assert.equal(missingIdentity.calls[0].error.code, 'HOST_PROVIDER_REPLACED')
  } finally {
    await rename(unavailableBinary, fileBinary)
  }
  const providerRecovery = await runtime.runWorkOrder(workOrder('provider-recovery', [
    procedureCall('provider-recovery', readyInput()),
  ]))
  assert.equal(providerRecovery.calls[0].status, 'ok')
  assert.equal(providerRecovery.calls[0].session, 'cold')
  failures['identity-freeze'] = {
    warmSnapshotStatusAfterSourceRename: frozenIdentitySurvival.calls[0].status,
    coldStartStatusWhileSourceMissing: missingIdentity.calls[0].status,
    coldStartCodeWhileSourceMissing: missingIdentity.calls[0].error.code,
    recoveryStatus: providerRecovery.calls[0].status,
    recoverySession: providerRecovery.calls[0].session,
  }

  failures['helper-identity-freeze'] = {}
  for (const [name, helper] of [
    ['file-vitals', resolve(packaged.bindingRoot, 'providers/file-vitals/runtime/finspect')],
    ['batch-ticket', resolve(packaged.bindingRoot, 'providers/data-transformer/runtime/adt-mcp/adt-mcp')],
  ]) {
    const unavailableHelper = `${helper}.unavailable`
    let warmSurvival
    let missingHelper
    await rename(helper, unavailableHelper)
    try {
      warmSurvival = await runtime.runWorkOrder(workOrder(`${name}-helper-warm-survival`, [
        procedureCall(`${name}-helper-warm-survival`, readyInput()),
      ]))
      assert.equal(warmSurvival.calls[0].status, 'ok')
      assert.equal(warmSurvival.calls[0].session, 'warm')
      await runtime.replaceProvider('org.openadam.structured-data-preflight')
      missingHelper = await runtime.runWorkOrder(workOrder(`${name}-helper-missing-cold`, [
        procedureCall(`${name}-helper-missing-cold`, readyInput()),
      ]))
      assert.equal(missingHelper.calls[0].status, 'host_error')
      assert.equal(missingHelper.calls[0].error.code, 'HOST_PROVIDER_REPLACED')
    } finally {
      await rename(unavailableHelper, helper)
    }
    const helperRecovery = await runtime.runWorkOrder(workOrder(`${name}-helper-recovery`, [
      procedureCall(`${name}-helper-recovery`, readyInput()),
    ]))
    assert.equal(helperRecovery.calls[0].status, 'ok')
    assert.equal(helperRecovery.calls[0].session, 'cold')
    failures['helper-identity-freeze'][name] = {
      warmSnapshotStatusAfterSourceRename: warmSurvival.calls[0].status,
      coldStartStatusWhileSourceMissing: missingHelper.calls[0].status,
      coldStartCodeWhileSourceMissing: missingHelper.calls[0].error.code,
      recoveryStatus: helperRecovery.calls[0].status,
      recoverySession: helperRecovery.calls[0].session,
    }
  }

  const invalidInput = await runtime.runWorkOrder(workOrder('invalid-input', [
    procedureCall('invalid-input', { path: 'fixtures/users.json', unexpected: true }),
  ]))
  assert.equal(invalidInput.calls[0].status, 'host_error')
  assert.equal(invalidInput.calls[0].error.code, 'HOST_INPUT_INVALID')
  failures.invalidInput = invalidInput.calls[0].error.code

  return {
    completion: {
      withoutValidation: { status: 'ok', readiness: 'ready', validationPresent: false },
      constraintsPass: { status: 'ok', readiness: 'ready', valid: true },
      constraintsFailed: { status: 'ok', readiness: 'constraints-failed', valid: false },
    },
    failures,
  }
}

async function runPartialAndInterruption(runtime) {
  const partial = await runtime.runWorkOrder(workOrder('partial', [
    procedureCall('partial-ready', readyInput()),
    procedureCall('partial-missing', { path: 'fixtures/missing.json' }),
  ]))
  assert.equal(partial.status, 'partial')
  assert.deepEqual(partial.calls.map((call) => call.id), ['partial-ready', 'partial-missing'])
  assert.deepEqual(partial.calls.map((call) => call.status), ['ok', 'provider_error'])
  assert.deepEqual(partial.summary, { calls: 2, succeeded: 1, failed: 1 })

  const cancelledProcessGroup = runtime.sessionSnapshot()[0].pid
  assert.ok(Number.isInteger(cancelledProcessGroup))
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 5)
  const cancelled = await runtime.runWorkOrder(workOrder('cancelled', [
    procedureCall('cancelled', readyInput({
      assertions: Array.from({ length: 500 }, (_, index) => ({
        id: `row-count-${index}`, type: 'row_count', min: 0,
      })),
    })),
  ]), { signal: controller.signal })
  assert.equal(cancelled.calls[0].error.code, 'HOST_CANCELLED')
  assert.equal(runtime.sessionSnapshot()[0].pid, null)
  const remainingCancelled = await processGroupMembers(cancelledProcessGroup)
  assert.deepEqual(remainingCancelled, [])
  const cancelRecovery = await runtime.runWorkOrder(workOrder('cancel-recovery', [
    procedureCall('cancel-recovery', readyInput()),
  ]))
  assert.equal(cancelRecovery.calls[0].session, 'cold')

  const timedOutProcessGroup = runtime.sessionSnapshot()[0].pid
  assert.ok(Number.isInteger(timedOutProcessGroup))
  const timedOut = await runtime.runWorkOrder(workOrder('timed-out', [
    procedureCall('timed-out', readyInput({
      assertions: Array.from({ length: 500 }, (_, index) => ({
        id: `timeout-row-count-${index}`, type: 'row_count', min: 0,
      })),
    }), 10),
  ]))
  assert.equal(timedOut.calls[0].error.code, 'HOST_TIMEOUT')
  assert.equal(runtime.sessionSnapshot()[0].pid, null)
  const remainingTimedOut = await processGroupMembers(timedOutProcessGroup)
  assert.deepEqual(remainingTimedOut, [])
  const timeoutRecovery = await runtime.runWorkOrder(workOrder('timeout-recovery', [
    procedureCall('timeout-recovery', readyInput()),
  ]))
  assert.equal(timeoutRecovery.calls[0].session, 'cold')

  return {
    partial: {
      status: partial.status,
      callStatuses: partial.calls.map((call) => call.status),
      summary: partial.summary,
    },
    cancellationRecovery: {
      cancelledCode: cancelled.calls[0].error.code,
      processGroupMembersAfterCancel: remainingCancelled.length,
      recoveryStatus: cancelRecovery.calls[0].status,
      recoverySession: cancelRecovery.calls[0].session,
    },
    timeoutRecovery: {
      timeoutCode: timedOut.calls[0].error.code,
      processGroupMembersAfterTimeout: remainingTimedOut.length,
      recoveryStatus: timeoutRecovery.calls[0].status,
      recoverySession: timeoutRecovery.calls[0].session,
    },
  }
}

async function runBudget(packaged) {
  const prepared = await prepareRuntimeConfig(providerConfig(
    packaged.bindingRoot,
    packaged.identityFiles,
    { limits: { maxProviderResponseBytes: 1024 } },
  ))
  const runtime = new DirectExecutionRuntime(prepared)
  try {
    const limited = await runtime.runWorkOrder(workOrder('limited-output', [
      procedureCall('limited-output', readyInput({
        assertions: Array.from({ length: 20 }, (_, index) => ({
          id: `row-count-${index}`, type: 'row_count', min: 0,
        })),
      })),
    ]))
    assert.equal(limited.calls[0].error.code, 'HOST_PROVIDER_RESPONSE_TOO_LARGE')
    const recovery = await runtime.runWorkOrder(workOrder('budget-recovery', [
      procedureCall('budget-recovery', { path: 'fixtures/missing.json' }),
    ]))
    assert.equal(recovery.calls[0].error.code, 'SOURCE_NOT_FOUND')
    assert.equal(recovery.calls[0].session, 'cold')
    return {
      limitBytes: 1024,
      code: limited.calls[0].error.code,
      recovery: recovery.calls[0].error.code,
      recoverySession: recovery.calls[0].session,
    }
  } finally {
    await runtime.close()
  }
}

async function main() {
  const temporaryRoot = await realpath(await mkdtemp(resolve(tmpdir(), 'direct-structured-preflight-')))
  const priorPath = process.env.PATH
  let runtime
  try {
    const configuredExecutables = {
      'file-vitals-capability': process.env.OPENADAM_FILE_VITALS_CAPABILITY,
      'adt-capability': process.env.OPENADAM_DATA_TRANSFORMER_CAPABILITY,
    }
    for (const [command, executable] of Object.entries(configuredExecutables)) {
      if (executable !== undefined && !isAbsolute(executable)) {
        throw new Error(`${command} override must be an absolute path`)
      }
    }
    const artifacts = await resolveProviderArtifacts([
      {
        command: 'file-vitals-capability',
        componentId: 'file-vitals',
        executableRelativePath: 'runtime/file-vitals-capability',
        adapterArgs: [],
        adapterCwdRelativePath: '.',
        pluginName: 'file-vitals',
        providerId: 'io.github.tetracoralla.file-vitals',
        providerVersion: '0.3.3',
        capabilityId: 'org.openadam.file.inspect',
        capabilityVersion: '0.1.0',
        hostIntegration: {
          lifecycle: 'persistent',
          workspaceRoot: 'host-required',
          profileRelativePath: 'capability-contracts/file-inspect.v0.1.json',
          identityRelativePaths: [
            'runtime/file-vitals-capability',
            'runtime/finspect',
          ],
        },
        profilePath: resolve(capabilityRoot, 'file-inspect.v0.1.json'),
        contracts: [{
          operationId: 'inspect',
          inputSchemaRelativePath: 'capabilities/schemas/file.inspect.input.schema.json',
          outputSchemaRelativePath: 'capabilities/schemas/file.inspect.output.schema.json',
        }],
        operationBindings: [
          { operationId: 'inspect', target: 'cmd/capability-adapter#inspect' },
        ],
      },
      {
        command: 'adt-capability',
        componentId: 'data-transformer',
        executableRelativePath: 'runtime/adt-capability',
        adapterArgs: [],
        adapterCwdRelativePath: '.',
        pluginName: 'data-transformer',
        providerId: 'io.github.tetracoralla.batchticket',
        providerVersion: '0.2.0',
        capabilityId: 'org.openadam.structured-data.analyze',
        capabilityVersion: '0.1.0',
        hostIntegration: {
          lifecycle: 'persistent',
          workspaceRoot: 'host-required',
          profileRelativePath: 'capability-contracts/structured-data-analyze.v0.1.json',
          identityRelativePaths: [
            'runtime/adt-capability',
            'runtime/adt-mcp/adt-mcp',
          ],
        },
        profilePath: resolve(capabilityRoot, 'structured-data-analyze.v0.1.json'),
        contracts: [
          {
            operationId: 'inspect',
            inputSchemaRelativePath: 'capabilities/schemas/structured-data.inspect.input.schema.json',
            outputSchemaRelativePath: 'capabilities/schemas/structured-data.inspect.output.schema.json',
          },
          {
            operationId: 'validate',
            inputSchemaRelativePath: 'capabilities/schemas/structured-data.validate.input.schema.json',
            outputSchemaRelativePath: 'capabilities/schemas/structured-data.validate.output.schema.json',
          },
        ],
        operationBindings: [
          { operationId: 'inspect', target: 'python:data_transformer.capability_adapter#inspect' },
          { operationId: 'validate', target: 'python:data_transformer.capability_adapter#validate' },
        ],
      },
    ], procedureRoot, async (command, cwd) => (
      configuredExecutables[command] ?? resolveProviderExecutable(command, cwd)
    ))
    const packaged = await buildPackagedBinding(temporaryRoot, artifacts)
    process.env.PATH = `${packaged.providerPathEntries.join(delimiter)}${delimiter}${priorPath ?? ''}`
    const config = providerConfig(packaged.bindingRoot, packaged.identityFiles)
    const preparedStarted = performance.now()
    const prepared = await prepareRuntimeConfig(config)
    const bindingPreparationMs = performance.now() - preparedStarted
    const binding = prepared.providers.get('org.openadam.structured-data-preflight')
    assert.ok(binding, 'prepared Procedure binding is absent')
    const launchPlan = await inspectLaunchPlan(binding, packaged)
    runtime = new DirectExecutionRuntime(prepared)
    const snapshotBefore = runtime.sessionSnapshot()[0]
    assert.equal(snapshotBefore.present, false)
    assert.equal(binding.identityDigests.length, packaged.identityFiles.length)

    const contract = await runCompletionAndFailures(runtime, packaged)
    const inspected = await runtime.inspectBindings()
    assert.equal(inspected.providers[0].observation, 'live_call_response_observed')
    assert.equal(inspected.providers[0].live.providerVersion, '0.1.0')
    assert.equal(inspected.providers[0].live.procedureVersion, '0.3.0')
    const interruption = await runPartialAndInterruption(runtime)

    const warmSamples = []
    const warmBytes = []
    for (let index = 0; index < 10; index += 1) {
      const measured = await timedRun(runtime, workOrder(`warm-${index}`, [
        procedureCall(`warm-${index}`, readyInput()),
      ]))
      assert.equal(measured.result.calls[0].status, 'ok')
      assert.equal(measured.result.calls[0].session, 'warm')
      warmSamples.push(measured.elapsedMs)
      warmBytes.push(measured.resultBytes)
    }
    await runtime.close()
    runtime = undefined

    const report = {
      schemaVersion: 'openadam.direct-structured-data-procedure-observation.v0.1',
      observedAt: new Date().toISOString(),
      environment: { platform: process.platform, architecture: process.arch, node: process.version },
      scope: {
        procedure: 'org.openadam.structured-data.preflight@0.3.0',
        implementation: 'org.openadam.structured-data-preflight@0.1.0',
        modelCallsInsideRuntime: 0,
        agentRoute: 'not_run',
        installedHost: 'not_run',
        formalSlo: null,
        boundary: 'Temporary frozen compatibility binding. Structured Data Preflight comes from a current source-built wheel; File Vitals and BatchTicket come from exact semantically validated artifacts whose provenance class is reported separately. This does not install the candidate Procedure or establish any artifact as an active Agent Host binding.',
      },
      packageArtifacts: packaged.packageArtifacts,
      binding: {
        statusBeforeCall: snapshotBefore.present ? 'session_present' : 'session_absent',
        statusAfterCall: inspected.providers[0].observation,
        bindingDigest: binding.bindingDigest,
        profileDigest: binding.profileDigest,
        implementationManifestDigest: binding.implementationManifestDigest,
        identityFiles: binding.identityDigests,
        stageBindings: packaged.stageBindings,
        launchPlan,
        preparationMs: bindingPreparationMs,
      },
      ...contract,
      ...interruption,
      budget: await runBudget(packaged),
      latency: {
        coldDirect: await measureCold(config),
        warmDirect: {
          executionsMs: quantiles(warmSamples),
          resultBytes: quantiles(warmBytes),
        },
        note: 'Current-machine observations only. Artifact build time is excluded from execution latency, and no SLO is declared.',
      },
    }
    await mkdir(verifyDirectory, { recursive: true })
    await writeFile(
      resolve(verifyDirectory, 'structured-data-procedure.latest.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    )
    process.stdout.write(`${JSON.stringify({
      procedure: report.scope.procedure,
      completion: report.completion,
      failures: report.failures,
      partial: report.partial,
      cancellationRecovery: report.cancellationRecovery,
      timeoutRecovery: report.timeoutRecovery,
      budget: report.budget,
      coldDirectMs: report.latency.coldDirect.executionsMs,
      warmDirectMs: report.latency.warmDirect.executionsMs,
      report: '.verify/structured-data-procedure.latest.json',
    })}\n`)
  } finally {
    if (runtime !== undefined) await runtime.close()
    process.env.PATH = priorPath
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

await main()
