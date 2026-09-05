import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { assessManagedCatalog, exportManagedCatalog } from '../src/context-exporter.mjs'
import { inspectProviderSkills, installProviderSkills, uninstallProviderSkills } from '../src/developer-kit-skill.mjs'
import { materializeCodexProjections } from '../src/hosts/codex-projection.mjs'
import { ManagedMcpStdioTransport } from '../src/managed-mcp-stdio-transport.mjs'
import { closeMcpProbeTransport } from '../src/mcp-probe-cleanup.mjs'
import { loadProfile } from '../src/profile.mjs'
import { hostFacingManifest, selectAgentComponents } from '../src/profile.mjs'
import { cleanupMaterializedRelease, materializeRelease } from '../src/release-artifacts.mjs'
import { loadReleaseManifest } from '../src/release-manifest.mjs'
import { runFile } from '../src/process.mjs'
import { prepareStatePaths } from '../src/state.mjs'

const manifestArgument = process.argv[2]
if (manifestArgument === undefined) {
  throw new Error('Usage: npm run probe:provider-discovery -- <release-manifest>')
}
const manifestPath = resolve(manifestArgument)
const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-provider-discovery-'))
const expectedArmorialVersion = '0.7.0'
let preparation = null
let claudeProviderSkills = []
let zcodeProviderSkills = []

async function treeBytes(root) {
  let bytes = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) bytes += await treeBytes(path)
    else if (entry.isFile()) bytes += (await stat(path)).size
    else throw new Error(`Provider discovery projection contains a special file: ${path}`)
  }
  return bytes
}

async function absent(path) {
  try {
    await access(path)
    return false
  } catch (error) {
    if (error.code === 'ENOENT') return true
    throw error
  }
}

async function timed(command, args, options = {}) {
  const start = performance.now()
  const result = await runFile(command, args, options)
  return { result, ms: performance.now() - start }
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}

async function connectActiveProvider(component) {
  const startedAt = performance.now()
  const transport = new ManagedMcpStdioTransport({
    command: component.command,
    args: component.args,
    cwd: component.cwd,
    env: getDefaultEnvironment(),
    stderr: 'pipe',
  })
  const client = new Client({ name: 'agent-host-provider-performance-probe', version: '0.1.0' }, { capabilities: {} })
  try {
    await client.connect(transport)
  } catch (error) {
    await closeMcpProbeTransport(
      transport,
      error,
      'PROVIDER_DISCOVERY_CLEANUP_FAILED',
      'The Provider discovery process scope could not be removed after connection failed',
    )
    throw error
  }
  return {
    client,
    transport,
    connectMs: performance.now() - startedAt,
    close: async (primaryError = null) => closeMcpProbeTransport(
      transport,
      primaryError,
      'PROVIDER_DISCOVERY_CLEANUP_FAILED',
      'The Provider discovery process scope could not be removed',
    ),
  }
}

try {
  const release = await loadReleaseManifest(manifestPath)
  const profile = await loadProfile('local-dogfood')
  const paths = await prepareStatePaths(stateRoot)
  preparation = await materializeRelease(release, paths, { componentIds: profile.components })
  const manifest = preparation.manifest
  const activeIds = selectAgentComponents(profile.agentComponents, profile.defaultAgentComponents)
  const inactiveManifest = hostFacingManifest(manifest, activeIds)
  const armorial = inactiveManifest.components.armorial
  assert.equal(armorial.skillOnly, true)
  assert.equal(armorial.providerSkill?.expectedVersion, expectedArmorialVersion)

  const inactiveProjection = await materializeCodexProjections(inactiveManifest, join(stateRoot, 'inactive-projections'), stateRoot)
  const inactiveArmorial = inactiveProjection.components.armorial
  const inactivePlugin = JSON.parse(await readFile(join(inactiveArmorial.pluginRoot, '.codex-plugin/plugin.json'), 'utf8'))
  assert.equal(inactivePlugin.skills, './skills/')
  assert.equal('mcpServers' in inactivePlugin, false)
  assert.equal(await absent(join(inactiveArmorial.pluginRoot, '.mcp.json')), true)

  const launcher = inactiveArmorial.providerSkill.launcherPath
  const version = await timed(launcher, ['--version'], { cwd: inactiveArmorial.pluginRoot, timeoutMs: 5_000 })
  assert.equal(version.result.stdout.trim(), inactiveArmorial.providerSkill.expectedVersion)
  const resolved = await timed(launcher, ['resolve', 'search', '--format', 'json'], { cwd: inactiveArmorial.pluginRoot, timeoutMs: 5_000 })
  const resolvedValue = JSON.parse(resolved.result.stdout)
  assert.equal(resolvedValue.status, 'ok')
  assert.equal(resolvedValue.icon?.id, 'icon-park:search')
  assert.match(String(resolvedValue.icon?.asset?.svg), /<svg/u)

  const closedFailure = await timed(launcher, ['resolve', 'membership', '--format', 'json'], {
    cwd: inactiveArmorial.pluginRoot,
    timeoutMs: 5_000,
    allowFailure: true,
  })
  assert.equal(closedFailure.result.status, 2)
  const closedFailureValue = JSON.parse(closedFailure.result.stdout)
  assert.equal(closedFailureValue.status, 'error')
  assert.equal(closedFailureValue.error?.code, 'ICON_NOT_FOUND')
  const recovered = await timed(launcher, ['get', 'icon-park:star', '--format', 'json'], { cwd: inactiveArmorial.pluginRoot, timeoutMs: 5_000 })
  assert.equal(JSON.parse(recovered.result.stdout).status, 'ok')

  const claudePaths = {
    hostProjections: join(stateRoot, 'claude-projections'),
    backups: join(stateRoot, 'claude-backups'),
  }
  claudeProviderSkills = await installProviderSkills('claude', inactiveManifest, claudePaths, [], {
    homeRoot: join(stateRoot, 'claude-home'),
  })
  const claudeArmorial = claudeProviderSkills.find((item) => item.id === 'icon-svg-select')
  assert.notEqual(claudeArmorial, undefined)
  assert.equal((await inspectProviderSkills(claudeProviderSkills)).status, 'ok')
  const claudeResolved = await timed(claudeArmorial.launcherPath, ['resolve', 'location', '--format', 'json'], {
    cwd: claudeArmorial.projectionRoot,
    timeoutMs: 5_000,
  })
  assert.equal(JSON.parse(claudeResolved.result.stdout).icon?.id, 'icon-park:local')

  const zcodePaths = {
    hostProjections: join(stateRoot, 'zcode-projections'),
    backups: join(stateRoot, 'zcode-backups'),
  }
  zcodeProviderSkills = await installProviderSkills('zcode', inactiveManifest, zcodePaths, [], {
    homeRoot: join(stateRoot, 'zcode-home'),
  })
  const zcodeArmorial = zcodeProviderSkills.find((item) => item.id === 'icon-svg-select')
  assert.notEqual(zcodeArmorial, undefined)
  assert.equal((await inspectProviderSkills(zcodeProviderSkills)).status, 'ok')
  const zcodeResolved = await timed(zcodeArmorial.launcherPath, ['resolve', 'location', '--format', 'json'], {
    cwd: zcodeArmorial.projectionRoot,
    timeoutMs: 5_000,
  })
  assert.equal(JSON.parse(zcodeResolved.result.stdout).icon?.id, 'icon-park:local')

  const sustained = []
  for (let index = 0; index < 25; index += 1) {
    const iteration = await timed(launcher, ['resolve', 'search', '--format', 'json'], { cwd: inactiveArmorial.pluginRoot, timeoutMs: 5_000 })
    assert.equal(JSON.parse(iteration.result.stdout).status, 'ok')
    sustained.push(iteration.ms)
  }

  const webpageIconIds = [
    'icon-park:user',
    'icon-park:shopping-bag',
    'icon-park:search',
    'icon-park:box',
    'icon-park:local',
    'icon-park:coupon',
    'icon-park:star',
    'icon-park:gift',
    'icon-park:magic',
    'icon-park:heart',
    'icon-park:share',
    'icon-park:check',
    'icon-park:lock',
    'icon-park:grid-four',
    'icon-park:logout',
    'icon-park:help',
    'icon-park:facebook',
    'icon-park:instagram',
    'icon-park:tiktok',
  ]
  const webpageBatch = await timed(launcher, ['batch', ...webpageIconIds, '--format', 'json'], {
    cwd: inactiveArmorial.pluginRoot,
    timeoutMs: 5_000,
  })
  const webpageBatchValue = JSON.parse(webpageBatch.result.stdout)
  assert.equal(webpageBatchValue.status, 'ok')
  assert.equal(webpageBatchValue.items.length, webpageIconIds.length)
  assert.equal(webpageBatchValue.items.every((item) => item.status === 'ok' && /<svg/u.test(item.icon?.asset?.svg)), true)

  const activeManifest = hostFacingManifest(manifest, [...activeIds, 'armorial'])
  const activeProjection = await materializeCodexProjections(activeManifest, join(stateRoot, 'active-projections'), stateRoot)
  const activeArmorial = activeProjection.components.armorial
  assert.equal(activeArmorial.skillOnly, false)
  assert.equal(JSON.parse(await readFile(join(activeArmorial.pluginRoot, '.codex-plugin/plugin.json'), 'utf8')).mcpServers, './.mcp.json')
  assert.equal(await absent(join(activeArmorial.pluginRoot, '.mcp.json')), false)
  assert.equal((await runFile(activeArmorial.providerSkill.launcherPath, ['--version'], { timeoutMs: 5_000 })).stdout.trim(), expectedArmorialVersion)

  const firstActive = await connectActiveProvider(activeArmorial)
  const warmCalls = []
  let firstActiveError = null
  try {
    const tools = await firstActive.client.listTools()
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      'browse_icons',
      'choose_icon',
      'get_icon',
      'get_icons',
      'resolve_icon',
      'search_icons',
    ])
    for (let index = 0; index < 50; index += 1) {
      const startedAt = performance.now()
      const result = await firstActive.client.callTool({ name: 'resolve_icon', arguments: { intent: 'search' } })
      warmCalls.push(performance.now() - startedAt)
      assert.equal(result.isError, undefined)
      assert.equal(result.structuredContent?.result?.icon?.id, 'icon-park:search')
    }
  } catch (error) {
    firstActiveError = error
    throw error
  } finally {
    await firstActive.close(firstActiveError)
  }

  const recoveredActive = await connectActiveProvider(activeArmorial)
  let recoveredCallMs
  let recoveredActiveError = null
  try {
    const startedAt = performance.now()
    const result = await recoveredActive.client.callTool({ name: 'get_icon', arguments: { id: 'icon-park:star' } })
    recoveredCallMs = performance.now() - startedAt
    assert.equal(result.isError, undefined)
    assert.equal(result.structuredContent?.result?.icon?.id, 'icon-park:star')
  } catch (error) {
    recoveredActiveError = error
    throw error
  } finally {
    await recoveredActive.close(recoveredActiveError)
  }

  const baselineComponents = Object.fromEntries(activeIds.map((id) => [id, manifest.components[id]]))
  const baselineCatalog = assessManagedCatalog(await exportManagedCatalog(baselineComponents))
  const expandedCatalog = assessManagedCatalog(await exportManagedCatalog({ ...baselineComponents, armorial: manifest.components.armorial }))
  const fullInventoryCatalog = assessManagedCatalog(await exportManagedCatalog(Object.fromEntries(
    profile.agentComponents.map((id) => [id, manifest.components[id]]),
  )))
  assert.equal(baselineCatalog.status, 'within')
  assert.equal(expandedCatalog.status, 'within')
  assert.equal(fullInventoryCatalog.status, 'exceeded')

  process.stdout.write(`${JSON.stringify({
    status: 'ok',
    releaseId: manifest.releaseId,
    provider: { id: 'armorial', version: armorial.version },
    inactive: {
      carrier: 'skill-cli',
      mcpPresent: false,
      skillAndLauncherBytes: await treeBytes(inactiveArmorial.providerSkill.root),
      firstVersionMs: Math.round(version.ms * 100) / 100,
      firstResolveMs: Math.round(resolved.ms * 100) / 100,
      closedFailureMs: Math.round(closedFailure.ms * 100) / 100,
      recoveryMs: Math.round(recovered.ms * 100) / 100,
      sustainedCalls: sustained.length,
      sustainedP50Ms: Math.round(percentile(sustained, 0.5) * 100) / 100,
      sustainedP95Ms: Math.round(percentile(sustained, 0.95) * 100) / 100,
      webpageTask: {
        iconCount: webpageIconIds.length,
        batchMs: Math.round(webpageBatch.ms * 100) / 100,
        handwrittenSvgCount: 0,
        socialIcons: ['icon-park:facebook', 'icon-park:instagram', 'icon-park:tiktok'],
      },
    },
    claude: {
      carrier: 'optional-claude-skill-link',
      installedProviderSkills: claudeProviderSkills.map((item) => item.id),
      mcpPresent: false,
      locationResolveMs: Math.round(claudeResolved.ms * 100) / 100,
      locationIcon: 'icon-park:local',
    },
    zcode: {
      carrier: 'zcode-skill-link',
      installedProviderSkills: zcodeProviderSkills.map((item) => item.id),
      mcpPresent: false,
      locationResolveMs: Math.round(zcodeResolved.ms * 100) / 100,
      locationIcon: 'icon-park:local',
    },
    active: {
      carrier: 'mcp+skill-cli',
      mcpPresent: true,
      firstConnectMs: Math.round(firstActive.connectMs * 100) / 100,
      warmCalls: warmCalls.length,
      warmP50Ms: Math.round(percentile(warmCalls, 0.5) * 100) / 100,
      warmP95Ms: Math.round(percentile(warmCalls, 0.95) * 100) / 100,
      reconnectMs: Math.round(recoveredActive.connectMs * 100) / 100,
      recoveredCallMs: Math.round(recoveredCallMs * 100) / 100,
    },
    catalog: {
      baseline: baselineCatalog,
      withArmorial: expandedCatalog,
      fullInventory: fullInventoryCatalog,
      avoidedActiveBytes: expandedCatalog.canonicalUtf8Bytes - baselineCatalog.canonicalUtf8Bytes,
    },
  }, null, 2)}\n`)
} finally {
  if (zcodeProviderSkills.length > 0) await uninstallProviderSkills(zcodeProviderSkills).catch(() => {})
  if (claudeProviderSkills.length > 0) await uninstallProviderSkills(claudeProviderSkills).catch(() => {})
  if (preparation !== null) await cleanupMaterializedRelease(preparation)
  await rm(stateRoot, { recursive: true, force: true })
}
