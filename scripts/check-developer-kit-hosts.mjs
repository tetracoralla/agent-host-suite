#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, lstat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { doctor } from '../src/doctor.mjs'
import { uninstallInstallation } from '../src/lifecycle.mjs'
import { setup } from '../src/setup.mjs'
import { loadState, prepareStatePaths } from '../src/state.mjs'

const execFileAsync = promisify(execFile)

function usage() {
  return 'Usage: node scripts/check-developer-kit-hosts.mjs --release-manifest /absolute/current.json'
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== '--release-manifest') throw new Error(usage())
  const releaseManifest = resolve(argv[1])
  if (!releaseManifest.startsWith('/')) throw new Error('The release manifest must resolve to an absolute path')
  return { releaseManifest }
}

function requiredDoctorChecks(report) {
  const required = [
    'developer-kit.cli',
    'host.codex',
    'host.codex.agent-tool-development-kit',
    'host.claude',
    'host.claude.agent-tool-development-kit',
    'host.zcode',
    'host.zcode.agent-tool-development-kit',
  ]
  return Object.fromEntries(required.map((id) => {
    const value = report.checks.find((item) => item.id === id)
    assert.equal(value?.status, 'ok', `fresh host check failed: ${id}`)
    return [id, value.status]
  }))
}

function completeOpportunity(value) {
  if (typeof value === 'string') return value.startsWith('TODO:') ? `Completed: ${value.slice(5).trim()}` : value
  if (Array.isArray(value)) return value.map(completeOpportunity)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, completeOpportunity(item)]))
  }
  return value
}

async function invokeJson(launcher, args, cwd) {
  const result = await execFileAsync(launcher, args, {
    cwd,
    timeout: 120_000,
    maxBuffer: 256 * 1024,
    env: Object.fromEntries(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL']
      .flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]])),
  })
  assert.equal(result.stderr, '')
  return JSON.parse(result.stdout)
}

async function exerciseInstalledWorkflow(launcher, workspaceRoot, expectedVersion) {
  await writeFile(join(workspaceRoot, 'selected.md'), '# Selected source\nOne bounded external-developer input.\n')
  await writeFile(join(workspaceRoot, 'trace-pack.json'), `${JSON.stringify({
    schemaVersion: 'openadam.agent-host-trace-analysis-pack.v0.1',
    generatedAt: '2026-09-02T00:00:00.000Z',
    source: {
      provider: 'zcode', adapterId: 'openadam.zcode-model-io', adapterVersion: '0.1.0',
      sourceFormat: 'zcode-model-io-jsonl', sourceBytes: 0, sourceSha256: null, sessionHashes: [],
    },
    privacy: {
      contentPolicy: 'metadata-only', selectedConversationContentIncluded: false,
      sensitiveContentConfirmed: false, transportSecretsExcluded: true,
      selectedContentMayContainUserSecrets: false,
      observerDatabaseRetention: false, sourcePathIncluded: false, credentialFieldsRedacted: 0,
    },
    limits: {
      maxInputBytes: 4096, maxEvents: 1, maxLineBytes: 1024,
      maxContentBytesPerEvent: 1024, maxOutputBytes: 4096, inputTruncated: false,
      eventLimitReached: false, outputTruncated: false, skippedLines: 0,
      contentTruncations: 0, eventsReturned: 0,
    },
    events: [],
    unknowns: ['semantic-correctness', 'result-adoption', 'non-use-reason'],
    interpretationStatus: 'not-performed',
  }, null, 2)}\n`)
  await writeFile(join(workspaceRoot, 'authorized-materials.json'), `${JSON.stringify({
    schemaVersion: 'openadam.authorized-material-set.v0.1',
    id: 'isolated-developer-check',
    title: 'Isolated developer check',
    purpose: 'Exercise the installed material and proposal flow without source access.',
    intendedProcessing: 'local-only',
    sources: [
      {
        id: 'selected-source', role: 'documentation', title: 'Selected source',
        location: { type: 'local-file', path: 'selected.md' },
      },
      {
        id: 'selected-trace', role: 'agent-trace', title: 'Metadata-only Agent trace',
        location: { type: 'local-file', path: 'trace-pack.json' },
      },
    ],
  }, null, 2)}\n`)
  const version = await invokeJson(launcher, ['--version', '--json'], workspaceRoot)
  assert.equal(version.version, expectedVersion)
  const materials = await invokeJson(launcher, ['materials', 'inspect', '--root', workspaceRoot, '--manifest', 'authorized-materials.json', '--json'], workspaceRoot)
  assert.equal(materials.status, 'ok')
  assert.equal(materials.materialSet.selectedFiles, 2)
  assert.equal(materials.processing.directoryCrawling, false)
  assert.equal(materials.processing.referencesFetched, false)
  const created = await invokeJson(launcher, ['opportunity', 'init', '--root', workspaceRoot, '--materials', 'authorized-materials.json', '--output', 'opportunity.json', '--json'], workspaceRoot)
  assert.equal(created.status, 'created')
  const proposal = completeOpportunity(JSON.parse(await readFile(join(workspaceRoot, 'opportunity.json'), 'utf8')))
  await writeFile(join(workspaceRoot, 'opportunity.json'), `${JSON.stringify(proposal, null, 2)}\n`)
  const checked = await invokeJson(launcher, ['opportunity', 'check', '--root', workspaceRoot, '--materials', 'authorized-materials.json', '--proposal', 'opportunity.json', '--json'], workspaceRoot)
  assert.equal(checked.status, 'ok')
  const destination = join(workspaceRoot, 'sample-provider')
  const initialized = await invokeJson(launcher, [
    'init', 'node-mcp-provider', '--destination', destination, '--id', 'org.example.sample-provider',
    '--package-name', '@example/sample-provider', '--plugin', 'sample-provider', '--operation', 'sample.run',
    '--name', 'Sample Provider', '--summary', 'One isolated external-developer fixture.',
    '--author', 'External Developer Fixture', '--license', 'Apache-2.0', '--json',
  ], workspaceRoot)
  assert.equal(initialized.status, 'created')
  const inspected = await invokeJson(launcher, ['inspect', '--root', destination, '--json'], workspaceRoot)
  assert.equal(inspected.status, 'ok')
  return {
    version: version.version,
    materialSources: materials.materialSet.sources,
    proposalChecks: checked.checks.length,
    scaffoldCreated: initialized.status === 'created',
    repositoryInspected: inspected.status === 'ok',
  }
}

async function main() {
  const { releaseManifest } = parseArguments(process.argv.slice(2))
  const root = await mkdtemp(join(tmpdir(), 'openadam-developer-host-check-'))
  const stateRoot = join(root, 'state')
  const hostHome = join(root, 'fresh-home')
  const workspaceRoot = join(root, 'workspace')
  const zcodeConfigPath = join(hostHome, '.zcode', 'cli', 'config.json')
  process.env.CODEX_HOME = join(root, 'codex')
  process.env.CLAUDE_CONFIG_DIR = join(hostHome, '.claude')
  process.env.DISABLE_AUTOUPDATER = '1'
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  let installed = false
  try {
    await Promise.all([
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(process.env.CODEX_HOME, { recursive: true }),
      mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true }),
    ])
    const result = await setup({
      profile: 'developer',
      hosts: ['codex', 'claude', 'zcode'],
      releaseManifest,
      stateRoot,
      workspaceRoot,
      noService: true,
      dryRun: false,
      enableObservability: false,
    }, { hostSkillHome: hostHome, zcodeConfigPath })
    installed = true
    const state = await loadState(await prepareStatePaths(stateRoot))
    assert.deepEqual(state.availableAgentComponents, [])
    assert.deepEqual(state.agentComponents, [])
    assert.equal(result.catalogPreflight.toolCount, 0)
    assert.equal(result.catalogPreflight.canonicalUtf8Bytes, 2)
    const report = await doctor(state, { deep: false })
    const checks = requiredDoctorChecks(report)
    const codexEntry = state.hosts.codex.entries.find(
      (item) => item.selector === 'agent-tool-development-kit@openadam-developer-tools',
    )
    assert.ok(codexEntry, 'Codex did not record the Developer Kit plugin')
    await assert.rejects(readFile(join(codexEntry.pluginRoot, '.mcp.json')), (error) => error.code === 'ENOENT')
    const claudeSkill = state.hosts.claude.developerSkill
    assert.equal((await lstat(claudeSkill.exposurePath)).isSymbolicLink(), true)
    assert.equal(claudeSkill.exposurePath, join(hostHome, '.claude', 'skills', 'build-openadam-agent-tools'))
    const zcodeSkill = state.hosts.zcode.developerSkill
    assert.equal((await lstat(zcodeSkill.exposurePath)).isSymbolicLink(), true)
    assert.equal(zcodeSkill.exposurePath, join(hostHome, '.zcode', 'skills', 'build-openadam-agent-tools'))
    assert.equal(zcodeSkill.projectionRoot.includes('/tools-dev/'), false)
    const zcodeConfig = JSON.parse(await readFile(zcodeConfigPath, 'utf8'))
    assert.deepEqual(zcodeConfig.mcp.servers, {})
    const externalWorkflow = await exerciseInstalledWorkflow(
      zcodeSkill.launcherPath,
      workspaceRoot,
      state.components['agent-tool-development-kit'].version,
    )
    const removed = await uninstallInstallation({ stateRoot, purgeData: true })
    installed = false
    assert.equal(removed.status, 'uninstalled')
    await assert.rejects(lstat(zcodeSkill.exposurePath), (error) => error.code === 'ENOENT')
    assert.deepEqual(JSON.parse(await readFile(zcodeConfigPath, 'utf8')).mcp.servers, {})
    console.log(JSON.stringify({
      status: 'ok',
      profile: result.profile,
      hosts: result.hosts,
      checks,
      developerKitMcpServers: 0,
      agentCatalogTools: result.catalogPreflight.toolCount,
      agentCatalogCanonicalUtf8Bytes: result.catalogPreflight.canonicalUtf8Bytes,
      claudeSkillLinked: true,
      zcodeSkillLinked: true,
      externalWorkflow,
      uninstall: removed.status,
    }))
  } finally {
    if (installed) await uninstallInstallation({ stateRoot, purgeData: true }).catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`)
  process.exitCode = 1
})
