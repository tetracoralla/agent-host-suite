import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { loadProfile } from '../src/profile.mjs'
import { cleanupMaterializedRelease, materializeRelease } from '../src/release-artifacts.mjs'
import { loadReleaseManifest } from '../src/release-manifest.mjs'
import { loadReleaseProvenance } from '../src/release-provenance.mjs'
import { probeMcpToolsFirstAndRepeat } from '../src/mcp-health.mjs'
import { prepareStatePaths } from '../src/state.mjs'

const suiteRoot = fileURLToPath(new URL('../', import.meta.url))
const execFileAsync = promisify(execFile)
const catalogRoot = process.env.AGENT_HOST_RELEASE_CATALOG
const manifestPath = resolve(process.argv[2] ?? (catalogRoot === undefined
  ? join(suiteRoot, '.build/internal-beta/release-catalog/current.json')
  : join(catalogRoot, 'current.json')))
const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-release-probe-'))
let preparation = null

try {
  const release = await loadReleaseManifest(manifestPath)
  const provenance = await loadReleaseProvenance(release)
  const profile = await loadProfile('local-dogfood')
  const paths = await prepareStatePaths(stateRoot)
  preparation = await materializeRelease(release, paths, { componentIds: profile.components })
  const components = preparation.manifest.components
  const math = components['math-anchor']
  if (math.marketplace !== 'math-anchor-agent-host') {
    throw new Error(`Math Anchor must use its Agent Host-owned marketplace, got ${math.marketplace}`)
  }
  const mathMarketplace = JSON.parse(await readFile(join(math.marketplaceRoot, '.agents/plugins/marketplace.json'), 'utf8'))
  if (mathMarketplace.name !== math.marketplace) {
    throw new Error(`Math Anchor marketplace descriptor drifted: ${mathMarketplace.name}`)
  }
  const results = []
  const failures = []

  for (const [id, component] of Object.entries(components)) {
    for (const path of [component.root, component.command, component.cwd].filter(Boolean)) {
      if (path.includes('/tools-dev/')) throw new Error(`${id} still resolves through tools-dev: ${path}`)
    }
    if (component.toolIntegrationSchema !== undefined) {
      try {
        const probe = await probeMcpToolsFirstAndRepeat(component)
        results.push({
          id,
          version: component.version,
          tools: probe.repeat.tools,
          firstLaunchMs: probe.firstLaunchMs,
          repeatLaunchMs: probe.repeatLaunchMs,
          catalogUtf8Bytes: probe.repeat.catalogUtf8Bytes,
          largestToolUtf8Bytes: probe.repeat.largestToolUtf8Bytes,
          catalogSha256: probe.repeat.catalogSha256,
        })
      } catch (error) {
        failures.push({ id, code: error.code ?? 'PROBE_FAILED', message: error.message, details: error.details ?? null })
      }
    }
  }

  for (const [id, expectedTools] of [
    ['math-anchor', ['math.batch', 'math.run']],
    ['migratory-time', []],
  ]) {
    const component = components[id]
    try {
      const probe = await probeMcpToolsFirstAndRepeat({
        ...component,
        cwd: component.root,
        expectedTools,
        healthTimeoutMs: 30000,
      })
      results.push({
        id,
        version: component.version,
        tools: probe.repeat.tools,
        firstLaunchMs: probe.firstLaunchMs,
        repeatLaunchMs: probe.repeatLaunchMs,
        catalogUtf8Bytes: probe.repeat.catalogUtf8Bytes,
        largestToolUtf8Bytes: probe.repeat.largestToolUtf8Bytes,
        catalogSha256: probe.repeat.catalogSha256,
      })
    } catch (error) {
      failures.push({ id, code: error.code ?? 'PROBE_FAILED', message: error.message, details: error.details ?? null })
    }
  }

  if (failures.length > 0) throw new Error(`internal Beta tool catalog probe failed: ${JSON.stringify(failures)}`)
  const { stdout: directStdout } = await execFileAsync(process.execPath, [
    join(suiteRoot, 'scripts/probe-direct-capability-release.mjs'),
    manifestPath,
  ], { maxBuffer: 4 * 1024 * 1024 })
  const directCapability = JSON.parse(directStdout)
  if (directCapability.status !== 'ok') throw new Error('Direct Capability release probe did not pass')
  process.stdout.write(`${JSON.stringify({
    status: 'ok',
    releaseId: preparation.manifest.releaseId,
    sourcePolicy: provenance.record.policy,
    profile: profile.id,
    components: results,
    directCapability,
  }, null, 2)}\n`)
} finally {
  if (preparation !== null) await cleanupMaterializedRelease(preparation)
  await rm(stateRoot, { recursive: true, force: true })
}
