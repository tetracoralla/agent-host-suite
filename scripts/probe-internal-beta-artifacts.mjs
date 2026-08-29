import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadProfile } from '../src/profile.mjs'
import { cleanupMaterializedRelease, materializeRelease } from '../src/release-artifacts.mjs'
import { loadReleaseManifest } from '../src/release-manifest.mjs'
import { probeMcpTools } from '../src/mcp-health.mjs'
import { prepareStatePaths } from '../src/state.mjs'

const suiteRoot = fileURLToPath(new URL('../', import.meta.url))
const manifestPath = resolve(process.argv[2] ?? join(suiteRoot, '.build/internal-beta/release-catalog/current.json'))
const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-release-probe-'))
let preparation = null

try {
  const release = await loadReleaseManifest(manifestPath)
  const profile = await loadProfile('local-dogfood')
  const paths = await prepareStatePaths(stateRoot)
  preparation = await materializeRelease(release, paths, { componentIds: profile.components })
  const components = preparation.manifest.components
  const results = []
  const failures = []

  for (const [id, component] of Object.entries(components)) {
    for (const path of [component.root, component.command, component.cwd].filter(Boolean)) {
      if (path.includes('/tools-dev/')) throw new Error(`${id} still resolves through tools-dev: ${path}`)
    }
    if (component.toolIntegrationSchema !== undefined) {
      try {
        const probe = await probeMcpTools(component)
        results.push({ id, version: component.version, tools: probe.tools })
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
      const probe = await probeMcpTools({
        ...component,
        cwd: component.root,
        expectedTools,
        healthTimeoutMs: 30000,
      })
      results.push({ id, version: component.version, tools: probe.tools })
    } catch (error) {
      failures.push({ id, code: error.code ?? 'PROBE_FAILED', message: error.message, details: error.details ?? null })
    }
  }

  if (failures.length > 0) throw new Error(`internal Beta tool catalog probe failed: ${JSON.stringify(failures)}`)
  process.stdout.write(`${JSON.stringify({ status: 'ok', releaseId: preparation.manifest.releaseId, profile: profile.id, components: results }, null, 2)}\n`)
} finally {
  if (preparation !== null) await cleanupMaterializedRelease(preparation)
  await rm(stateRoot, { recursive: true, force: true })
}
