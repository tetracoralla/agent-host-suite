#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { importLocalComponent, localComponentStatus, previewLocalComponent, removeLocalComponent, rollbackLocalComponent } from '../src/local-components.mjs'
import { ManagedMcpStdioTransport } from '../src/managed-mcp-stdio-transport.mjs'
import { closeMcpProbeTransport } from '../src/mcp-probe-cleanup.mjs'
import { uninstallInstallation } from '../src/lifecycle.mjs'
import { cleanupRuntimeSocket, writeRuntimeFiles } from '../src/runtime-config.mjs'
import { setup } from '../src/setup.mjs'
import { exportSkillLinkCatalog } from '../src/skill-link-catalog.mjs'
import { loadState, prepareStatePaths } from '../src/state.mjs'
import { createCodexRunner, healthyCatalogPreflight } from '../test/helpers.mjs'
import { createReleaseFixture } from '../test/release-helpers.mjs'

const suiteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const toolsRoot = resolve(suiteRoot, '..')
const labsRoot = join(toolsRoot, 'agent-tool-labs', 'packages')
const miningRoot = resolve(process.env.SKILL_MINING_LAB_ROOT ?? join(labsRoot, 'skill-mining-lab'))
const refineryRoot = resolve(process.env.SKILL_REFINERY_ROOT ?? join(labsRoot, 'skill-refinery'))
const evalsRoot = resolve(process.env.AGENT_TOOL_EVALS_ROOT ?? join(labsRoot, 'agent-tool-evals'))

function moduleUrl(root, relativePath) {
  return pathToFileURL(join(root, relativePath)).href
}

async function requireSiblingRoot(root, label) {
  try {
    await access(join(root, 'package.json'))
  } catch {
    throw new Error(`${label} checkout is required at ${root}; set its explicit root environment variable`)
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

async function callInstalledTool(component, name, args) {
  const transport = new ManagedMcpStdioTransport({
    command: component.command,
    args: component.args,
    cwd: component.cwd,
    env: getDefaultEnvironment(),
    stderr: 'pipe',
    maxBufferSize: 4 * 1024 * 1024,
  })
  const client = new Client({ name: 'agent-host-skill-refinery-vertical', version: '0.1.0' }, { capabilities: {} })
  let primaryError = null
  try {
    await client.connect(transport)
    return await client.callTool({ name, arguments: args })
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    await closeMcpProbeTransport(
      transport,
      primaryError,
      'SKILL_REFINERY_VERTICAL_CLEANUP_FAILED',
      'The installed Provider process scope could not be removed',
    )
  }
}

async function openPackagedTools({ bundle, workspaceRoot, environmentVariable, label }) {
  const transport = new ManagedMcpStdioTransport({
    command: process.execPath,
    args: [join(bundle, 'src/server.mjs')],
    cwd: bundle,
    env: { ...getDefaultEnvironment(), [environmentVariable]: workspaceRoot },
    stderr: 'pipe',
    maxBufferSize: 8 * 1024 * 1024,
  })
  const client = new Client({ name: `agent-host-${label}-vertical`, version: '0.1.0' }, { capabilities: {} })
  try {
    await client.connect(transport)
  } catch (error) {
    await closeMcpProbeTransport(
      transport,
      error,
      'SKILL_REFINERY_VERTICAL_CLEANUP_FAILED',
      `The ${label} process scope could not be removed after connection failed`,
    )
    throw error
  }
  return {
    client,
    async close(primaryError = null) {
      await closeMcpProbeTransport(
        transport,
        primaryError,
        'SKILL_REFINERY_VERTICAL_CLEANUP_FAILED',
        `The ${label} process scope could not be removed`,
      )
    },
  }
}

async function callStructured(client, name, args) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError || result.structuredContent === undefined) {
    throw new Error(`${name} failed: ${result.content?.[0]?.text ?? 'no structured result'}`)
  }
  return result.structuredContent
}

async function runBounded(command, args, options = {}) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let timedOut = false
    const limit = 2 * 1024 * 1024
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs ?? 15_000)
    timer.unref?.()
    const append = (current, chunk) => {
      const next = Buffer.concat([current, chunk])
      if (next.length > limit) child.kill('SIGKILL')
      return next.subarray(0, limit + 1)
    }
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk) })
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk) })
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new Error(`${command} ${args.join(' ')} timed out`))
      } else if (stdout.length > limit || stderr.length > limit) {
        reject(new Error(`${command} ${args.join(' ')} exceeded its output limit`))
      } else if (code !== 0) {
        reject(new Error(`${command} ${args.join(' ')} exited ${code}: ${stderr.toString('utf8').trim()}`))
      } else {
        resolvePromise({ stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') })
      }
    })
  })
}

async function runJson(command, args, options) {
  const result = await runBounded(command, args, options)
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(`${command} ${args.join(' ')} returned invalid JSON: ${error.message}`)
  }
}

function componentWarmup({ manifest, componentIds }) {
  return Promise.resolve({
    status: 'ok',
    strategy: 'isolated-integration-fixture',
    components: componentIds.map((id) => ({ id, version: manifest.components[id].version })),
  })
}

async function main() {
  await Promise.all([
    requireSiblingRoot(miningRoot, 'Skill Mining Lab'),
    requireSiblingRoot(refineryRoot, 'Skill Refinery'),
    requireSiblingRoot(evalsRoot, 'Agent Tool Evals'),
  ])
  const { validateExperimentInputs } = await import(moduleUrl(evalsRoot, 'src/plan.mjs'))
  const [miningBuild, refineryBuild] = await Promise.all([
    runJson(process.execPath, [join(miningRoot, 'scripts/build-plugin.mjs'), '--replace'], { cwd: miningRoot, timeoutMs: 120_000 }),
    runJson(process.execPath, [join(refineryRoot, 'scripts/build-plugin.mjs'), '--replace'], { cwd: refineryRoot, timeoutMs: 120_000 }),
  ])

  const root = await mkdtemp(join(tmpdir(), 'oa-sth-'))
  let miningTools
  let refineryTools
  let primaryError = null
  try {
    miningTools = await openPackagedTools({ bundle: miningBuild.destination, workspaceRoot: root, environmentVariable: 'SKILL_MINING_WORKSPACE_ROOT', label: 'skill-mining' })
    refineryTools = await openPackagedTools({ bundle: refineryBuild.destination, workspaceRoot: root, environmentVariable: 'SKILL_REFINERY_WORKSPACE_ROOT', label: 'skill-refinery' })
    const releaseManifest = await createReleaseFixture(join(root, 'host-release'), {
      suiteVersion: '0.1.1-skill-refinery-vertical',
      releaseId: 'skill-refinery-vertical',
      marker: 'skill-refinery-vertical',
    })
    const stateRoot = join(root, 'host-state')
    const socketDirectory = join(root, 's')
    const hostSkillHome = join(root, 'host-skill-home')
    const fakeCodex = createCodexRunner({ mathPresent: false, timePresent: false, mathMarketplace: 'openadam' })
    const isolatedRuntime = {
      writeRuntimeFiles: (paths, manifest) => writeRuntimeFiles(paths, manifest, { socketDirectory }),
      cleanupRuntimeSocket: (paths, runtime) => cleanupRuntimeSocket(paths, runtime, { socketDirectory }),
    }
    await setup({
      profile: 'standard',
      hosts: ['codex'],
      releaseManifest,
      stateRoot,
      noService: true,
      dryRun: false,
      enableObservability: false,
    }, {
      runner: fakeCodex.runner,
      hostSkillHome,
      componentWarmup,
      catalogPreflight: healthyCatalogPreflight,
      ...isolatedRuntime,
    })
    const sourceRoot = join(root, 'owned-skills')
    const skillRoot = join(sourceRoot, 'private-order-review')
    const miningOutput = join(root, 'mining')
    await mkdir(skillRoot, { recursive: true, mode: 0o700 })
    const skillPath = join(skillRoot, 'SKILL.md')
    const skillText = `---\nname: private-order-review\ndescription: Review private orders without spending model reasoning on fixed record-shape checks.\n---\n\n# Validation\n\nEvery order record must contain a non-empty customer_id and a non-negative amount before commercial judgment begins.\n\n# Judgment\n\nThe Agent decides whether a structurally valid order needs commercial follow-up.\n`
    await writeFile(skillPath, skillText, { mode: 0o600 })

    const scanned = await callStructured(miningTools.client, 'skill_mining_scan', {
      sourceDirectory: 'owned-skills/private-order-review',
      sourceKind: 'owned-integration-fixture',
      outputDirectory: 'mining',
    })
    assert.equal(scanned.scope, 'single-skill')
    assert.equal(scanned.totals.skills, 1)
    const sourceInputs = {
      manifestPath: scanned.artifacts.manifestPath,
      fragmentsPath: scanned.artifacts.fragmentsPath,
      sourceObservationsPath: scanned.artifacts.sourceObservationsPath,
    }
    const inspected = await callStructured(refineryTools.client, 'skill_refinery_inspect', { ...sourceInputs, limit: 128 })
    const validationIndex = inspected.fragments.filter((item) => item.section.includes('Validation'))
    assert.ok(validationIndex.length > 0, 'the packaged fragment index must expose the Validation section')
    const selected = await callStructured(refineryTools.client, 'skill_refinery_read_fragments', {
      ...sourceInputs,
      fragmentIds: validationIndex.slice(0, 8).map((item) => item.id),
    })
    const fragment = selected.fragments.find((item) => item.text.includes('Every order record must contain'))
    assert.ok(fragment, 'the deterministic validation fragment must be mined from the real Skill source')
    const citation = fragment.citation
    const corpus = {
      schemaVersion: 'openadam.skill-mining-corpus.v0.2',
      sourceKind: scanned.sourceKind,
      corpusDigestAlgorithm: 'openadam.skill-corpus-digest.v0.2',
      rootDigest: scanned.rootDigest,
    }
    const extractionPlan = {
      schemaVersion: 'openadam.skill-extraction-plan.v0.2',
      id: 'plan.private-order-review',
      corpus,
      sourceUseReview: {
        purpose: 'private-derivation',
        declaredDisposition: 'proceed',
        bases: [{
          kind: 'owner-authorization',
          skill: null,
          observedDigest: null,
          statement: 'This fixed integration corpus is owned and authorized for private local derivation.',
        }],
        notes: 'Integration fixture only; no publication or legal conclusion.',
      },
      entries: [{
        id: 'entry.order-shape',
        disposition: 'candidate-capability',
        citations: [citation],
        candidateId: 'candidate.order-shape',
        exactLink: null,
        rationale: 'The Agent-authored fixture identifies a closed structural validation operation.',
        residualAgentJudgment: ['Decide whether a structurally valid order needs commercial follow-up.'],
      }],
      exclusions: ['Commercial follow-up judgment remains with the Agent.'],
      notes: 'Fixed Agent-authored integration input; deterministic tools only validate its binding.',
    }
    const candidate = {
      schemaVersion: 'openadam.skill-candidate-dossier.v0.2',
      id: 'candidate.order-shape',
      kind: 'capability',
      workingName: 'Private order shape validation',
      status: 'ready-for-pilot',
      sourceFragments: [fragment.id],
      problem: 'Repeated private-order structure checks consume Agent reasoning.',
      desiredResult: 'Return bounded deterministic structural validation issues.',
      inputs: ['one explicit JSON value'],
      outputs: ['valid flag and bounded issues'],
      stages: [],
      stableErrors: ['INVALID_INPUT'],
      implementationBasis: ['Owner-authored closed JSON Schema'],
      validationRoutes: ['Golden valid and invalid records through the generated provider'],
      independentAuthority: ['JSON Schema assertion semantics'],
      secondProviderPath: [],
      exclusions: ['Commercial judgment'],
      confidence: 0.8,
      notes: 'Agent-authored integration dossier; structural validation does not approve its semantics.',
    }
    const catalog = await exportSkillLinkCatalog({ stateRoot }, { listMcpTools: async () => [] })
    assert.ok(catalog.entries.some((entry) => entry.kind === 'capability' && entry.identity === 'org.openadam.time-zone.convert#convert'))
    const planPath = join(miningOutput, 'extraction-plan.json')
    const candidatesPath = join(miningOutput, 'candidates.jsonl')
    const catalogPath = join(miningOutput, 'link-catalog.json')
    await Promise.all([
      writeJson(planPath, extractionPlan),
      writeFile(candidatesPath, `${JSON.stringify(candidate)}\n`, { mode: 0o600 }),
      writeJson(catalogPath, catalog),
    ])
    const miningToolInputs = {
      ...sourceInputs,
      extractionPlanPath: 'mining/extraction-plan.json',
    }
    const validatedPlan = await callStructured(miningTools.client, 'skill_mining_validate_plan', {
      ...miningToolInputs,
      reportPath: 'mining/plan-validation.json',
    })
    const validatedCandidates = await callStructured(miningTools.client, 'skill_mining_validate_candidates', {
      ...miningToolInputs,
      candidatesPath: 'mining/candidates.jsonl',
      reportPath: 'mining/candidate-validation.json',
    })
    const validatedLinks = await callStructured(miningTools.client, 'skill_mining_validate_links', {
      ...miningToolInputs,
      catalogPath: 'mining/link-catalog.json',
      reportPath: 'mining/link-validation.json',
    })
    assert.equal(validatedPlan.semanticAssessment, 'not-performed')
    assert.equal(validatedCandidates.semanticAssessment, 'not-performed')
    assert.equal(validatedLinks.semanticAssessment, 'not-performed')

    const relativeMiningPaths = Object.fromEntries(Object.entries({
      manifestPath: join('mining', 'corpus-manifest.json'),
      fragmentsPath: join('mining', 'skill-fragments.jsonl'),
      sourceObservationsPath: join('mining', 'source-observations.json'),
      extractionPlanPath: join('mining', 'extraction-plan.json'),
      planValidationPath: join('mining', 'plan-validation.json'),
      candidatesPath: join('mining', 'candidates.jsonl'),
      candidateValidationPath: join('mining', 'candidate-validation.json'),
      catalogPath: join('mining', 'link-catalog.json'),
      linkValidationPath: join('mining', 'link-validation.json'),
    }))
    const bindings = await callStructured(refineryTools.client, 'skill_refinery_plan_bindings', { ...relativeMiningPaths, candidateId: candidate.id })
    assert.equal(bindings.candidate.mechanicallyBuildable, true)
    const refinementPlan = {
      schemaVersion: 'openadam.skill-refinery-plan.v0.1',
      id: 'local.private.order-shape',
      version: '0.1.0',
      source: bindings.source,
      tool: {
        name: 'private-order-shape',
        displayName: 'Private Order Shape',
        summary: 'Validate the explicit private order record shape.',
        operationName: 'private_order_shape_validate',
        operationDescription: 'Check one explicit value against the owner-approved private order JSON Schema and return bounded structural issues.',
      },
      lowering: {
        template: 'json-schema-validator.v0.1',
        targetSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['customer_id', 'amount'],
          properties: {
            customer_id: { type: 'string', minLength: 1, maxLength: 128 },
            amount: { type: 'number', minimum: 0 },
          },
        },
      },
      thinSkill: {
        description: 'Validate private order structure before the Agent applies commercial judgment.',
        instructions: [
          'Call the validator with one explicit order value.',
          'Keep commercial follow-up and anomaly importance as Agent judgment.',
        ],
      },
      license: {
        spdx: 'LicenseRef-Private-Use-Only',
        text: 'Private local use only. No redistribution license is granted.\n',
        notice: 'Private Order Shape is an owner-local generated artifact.\n',
      },
    }
    const refinementPlanPath = join(root, 'refinement-plan.json')
    await writeJson(refinementPlanPath, refinementPlan)
    const refineryInput = { ...relativeMiningPaths, refinementPlanPath: 'refinement-plan.json' }
    const planCheck = await callStructured(refineryTools.client, 'skill_refinery_plan_check', refineryInput)
    assert.equal(planCheck.valid, true)
    assert.equal(planCheck.buildable, true)
    const built = await callStructured(refineryTools.client, 'skill_refinery_build_pack', { ...refineryInput, outputDirectory: 'refinery/private-order-shape' })
    const verified = await callStructured(refineryTools.client, 'skill_refinery_verify_pack', {
      packDirectory: built.packDirectory,
      archivePath: built.archivePath,
      manifestPath: relativeMiningPaths.manifestPath,
      fragmentsPath: relativeMiningPaths.fragmentsPath,
      sourceObservationsPath: relativeMiningPaths.sourceObservationsPath,
    })
    assert.equal(verified.valid, true)
    assert.equal(verified.sourceStatus, 'current')
    assert.equal(verified.archive.status, 'verified')

    const artifact = join(root, built.archivePath)
    const preview = await previewLocalComponent({
      stateRoot,
      artifact,
      licenseSpdx: refinementPlan.license.spdx,
    })
    assert.equal(preview.component.id, refinementPlan.tool.name)
    assert.deepEqual(preview.component.expectedTools, [refinementPlan.tool.operationName])
    assert.equal(preview.health.first.status, 'ok')
    assert.equal(preview.health.repeat.status, 'ok')

    const hostDependencies = {
      runner: fakeCodex.runner,
      hostSkillHome,
      catalogPreflight: healthyCatalogPreflight,
      ...isolatedRuntime,
    }
    const imported = await importLocalComponent({
      stateRoot,
      artifact,
      binding: preview.binding,
      activate: true,
      replace: false,
      replaceHostConflicts: false,
      dryRun: false,
    }, hostDependencies)
    assert.equal(imported.status, 'imported')
    assert.equal(imported.component.active, true)
    assert.equal(fakeCodex.plugins.has('private-order-shape@private-private-order-shape'), true)
    const listed = await localComponentStatus({ stateRoot, target: refinementPlan.tool.name })
    assert.equal(listed.components[0].active, true)

    let state = await loadState(await prepareStatePaths(stateRoot))
    let installedComponent = state.components[refinementPlan.tool.name]
    const validCall = await callInstalledTool(installedComponent, refinementPlan.tool.operationName, {
      value: { customer_id: 'customer-1', amount: 10 },
    })
    const invalidCall = await callInstalledTool(installedComponent, refinementPlan.tool.operationName, {
      value: { customer_id: '', amount: -1, unexpected: true },
    })
    assert.equal(validCall.structuredContent.valid, true)
    assert.equal(invalidCall.structuredContent.valid, false)
    assert.deepEqual(invalidCall.structuredContent.issues.map((issue) => issue.keyword), ['minimum', 'minLength', 'additionalProperties'])

    const actualCodex = process.env.CODEX_EXECUTABLE ?? '/opt/homebrew/bin/codex'
    await access(actualCodex)
    const isolatedCodexHome = join(root, 'eval-codex-home')
    await mkdir(isolatedCodexHome, { recursive: true, mode: 0o700 })
    await writeFile(join(isolatedCodexHome, 'config.toml'), '# isolated Skill Refinery vertical preflight\n', { mode: 0o600 })
    const codexEnvironment = { ...process.env, CODEX_HOME: isolatedCodexHome }
    const targetEntry = state.hosts.codex.entries.find((entry) => entry.selector === 'private-order-shape@private-private-order-shape')
    assert.ok(targetEntry, 'Agent Host state must retain the exact private Codex selector')
    await runJson(actualCodex, ['plugin', 'marketplace', 'add', targetEntry.marketplaceRoot, '--json'], { env: codexEnvironment })
    await runJson(actualCodex, ['plugin', 'add', targetEntry.selector, '--json'], { env: codexEnvironment })
    const pluginInventory = await runJson(actualCodex, ['plugin', 'list', '--json'], { env: codexEnvironment })
    const installedPlugins = pluginInventory.installed?.filter((plugin) => plugin.installed === true && plugin.enabled === true) ?? []
    assert.deepEqual(installedPlugins.map((plugin) => plugin.pluginId), [targetEntry.selector])
    const targetServer = await runJson(actualCodex, ['mcp', 'get', refinementPlan.tool.name, '--json'], { env: codexEnvironment })
    assert.equal(targetServer.enabled, true)
    assert.equal(targetServer.transport.type, 'stdio')
    assert.equal(targetServer.transport.command, installedComponent.command)
    assert.deepEqual(targetServer.transport.args, installedComponent.args)
    assert.equal(targetServer.transport.cwd, installedComponent.cwd)
    const codexVersionOutput = (await runBounded(actualCodex, ['--version'], { env: codexEnvironment })).stdout.trim()
    const codexVersion = /^codex-cli\s+(\S+)$/.exec(codexVersionOutput)?.[1]
    assert.ok(codexVersion, `unexpected Codex version output: ${codexVersionOutput}`)

    const evaluationSuite = {
      schemaVersion: 'openadam.agent-tool-eval.task-suite.v0.1',
      id: 'private-order-shape.agent-selection-smoke',
      version: '0.1.0',
      title: 'Private Order Shape isolated Agent selection smoke',
      targetRef: { id: refinementPlan.tool.name, version: refinementPlan.version },
      tasks: [{
        id: 'invalid-order-shape',
        prompt: 'Validate the order {"customer_id":"","amount":-1,"unexpected":true}. Return only the exact word invalid when the order shape is invalid.',
        opportunity: 'required',
        tags: ['private', 'validation'],
        evaluator: { kind: 'string-equality', actualPointer: '', expected: 'invalid', trim: true, caseSensitive: true },
      }],
    }
    const evaluationExperiment = {
      schemaVersion: 'openadam.agent-tool-eval.experiment.v0.1',
      id: 'private-order-shape.codex.development-smoke',
      title: 'Private Order Shape isolated Codex Plugin availability',
      purpose: 'development-smoke',
      suiteRef: { id: evaluationSuite.id, version: evaluationSuite.version },
      targetRef: structuredClone(evaluationSuite.targetRef),
      agent: { provider: 'openai', model: 'gpt-5.6-luna' },
      harness: { id: 'codex-cli', version: codexVersion },
      repeats: 1,
      seed: 'private-order-shape-vertical-2026-08-31',
      budget: {
        perRunTimeoutMs: 120_000,
        maxStdoutBytes: 65_536,
        maxStderrBytes: 65_536,
        maxReportBytes: 2_097_152,
        maxTotalTokens: 50_000,
        maxOutputTokens: 2_000,
        maxToolCalls: 4,
      },
      capture: { answer: 'digest', toolArguments: 'digest', toolResults: 'digest' },
      driver: {
        id: 'codex-cli-driver',
        version: '0.5.0',
        command: process.execPath,
        args: [
          join(evalsRoot, 'src/adapters/codex-driver.mjs'),
          '--codex', actualCodex,
          '--model', 'gpt-5.6-luna',
          '--target-plugin-id', targetEntry.selector,
          '--target-mcp-server-id', refinementPlan.tool.name,
          '--target-tool-prefix', 'private_order_shape_',
          '--isolated-plugin-home', isolatedCodexHome,
          '--target-runtime-root', state.components['node-runtime'].root,
          '--target-runtime-root', installedComponent.root,
        ],
        cwd: evalsRoot,
      },
      oracleIsolation: { mode: 'deny-read-roots' },
      conditions: {
        baseline: { capabilityAvailable: false, declaredDifference: 'target-capability-availability' },
        treatment: { capabilityAvailable: true, declaredDifference: 'target-capability-availability' },
      },
    }
    const evaluationPreflight = await validateExperimentInputs(evaluationSuite, evaluationExperiment)
    assert.equal(evaluationPreflight.plannedRuns, 2)

    await writeFile(skillPath, `${skillText}\nThe owned source now also requires a human review note.\n`, { mode: 0o600 })
    const drifted = await callStructured(miningTools.client, 'skill_mining_scan', {
      sourceDirectory: 'owned-skills/private-order-review',
      sourceKind: 'owned-integration-fixture',
      outputDirectory: 'mining-drifted',
    })
    const stale = await callStructured(refineryTools.client, 'skill_refinery_verify_pack', {
      packDirectory: built.packDirectory,
      manifestPath: drifted.artifacts.manifestPath,
      fragmentsPath: drifted.artifacts.fragmentsPath,
      sourceObservationsPath: drifted.artifacts.sourceObservationsPath,
    })
    assert.equal(stale.valid, true)
    assert.equal(stale.sourceStatus, 'stale')

    const removed = await removeLocalComponent({ stateRoot, target: refinementPlan.tool.name, dryRun: false }, hostDependencies)
    assert.equal(removed.component.installed, false)
    assert.equal(fakeCodex.plugins.has('private-order-shape@private-private-order-shape'), false)
    const restored = await rollbackLocalComponent({ stateRoot, target: refinementPlan.tool.name, dryRun: false }, hostDependencies)
    assert.equal(restored.component.active, true)
    state = await loadState(await prepareStatePaths(stateRoot))
    installedComponent = state.components[refinementPlan.tool.name]
    const restoredCall = await callInstalledTool(installedComponent, refinementPlan.tool.operationName, {
      value: { customer_id: 'customer-2', amount: 0 },
    })
    assert.equal(restoredCall.structuredContent.valid, true)

    const uninstalled = await uninstallInstallation({ stateRoot, purgeData: true, dryRun: false }, hostDependencies)
    assert.equal(uninstalled.status, 'uninstalled')
    await assert.rejects(access(stateRoot), (error) => error.code === 'ENOENT')

    process.stdout.write(`${JSON.stringify({
      schemaVersion: 'openadam.skill-to-host-vertical.v0.1',
      status: 'passed',
      corpus: {
        skills: scanned.totals.skills,
        fragments: scanned.totals.fragments,
        rootDigest: scanned.rootDigest,
        intake: 'packaged-single-skill-mcp',
      },
      candidate: {
        id: candidate.id,
        validationRoute: 'packaged-skill-mining-mcp',
        semanticAssessment: 'agent-authored-fixture-not-product-acceptance',
      },
      refinery: {
        template: refinementPlan.lowering.template,
        archiveSha256: built.archive.sha256,
        sourceBeforeDrift: verified.sourceStatus,
        sourceAfterDrift: stale.sourceStatus,
      },
      host: {
        linkCatalogEntries: catalog.entries.length,
        previewed: true,
        imported: true,
        activated: true,
        liveCatalog: preview.component.expectedTools,
        liveValidCall: validCall.structuredContent.valid,
        liveInvalidCall: invalidCall.structuredContent.valid,
        removed: true,
        rolledBack: true,
        purged: true,
      },
      coldAgentPreflight: {
        codexVersion,
        isolatedEnabledPlugins: installedPlugins.length,
        targetServer: targetServer.name,
        providerRuntimeRoots: 2,
        plannedModelRuns: evaluationPreflight.plannedRuns,
        modelRunsExecuted: 0,
        evaluationLevel: 'input-and-runtime-preflight-only',
        capabilityFrontier: 'unobserved',
        longHorizonHumanPractice: 'unobserved',
        effectPreservationGate: false,
      },
      assessment: {
        establishes: [
          'packaged-exact-single-skill-mining-scan',
          'packaged-mining-plan-candidate-and-link-validation',
          'packaged-refinery-inspection-and-build',
          'agent-authored-plan-revalidated',
          'real-refinery-archive',
          'isolated-host-preview-import-activation',
          'live-installed-provider-calls',
          'source-drift-detection',
          'remove-rollback-and-final-purge',
          'isolated-codex-plugin-and-mcp-discovery',
          'agent-evaluation-structure-and-runtime-root-preflight',
        ],
        doesNotEstablish: [
          'natural-agent-selection',
          'agent-authored-semantic-correctness',
          'stronger-agent-capability-frontier',
          'expert-human-or-long-horizon-equivalence',
          'token-or-latency-benefit',
          'public-release',
          'external-adoption',
          'business-acceptance',
        ],
      },
    }, null, 2)}\n`)
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    let cleanupError = null
    for (const tools of [refineryTools, miningTools]) {
      try {
        await tools?.close(primaryError)
      } catch (error) {
        cleanupError ??= error
      }
    }
    await rm(root, { recursive: true, force: true })
    if (cleanupError !== null) throw cleanupError
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    status: 'failed',
    error: { code: error?.code ?? 'UNKNOWN', message: error?.message ?? String(error) },
  })}\n`)
  process.exitCode = 1
})
