import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exportManagedCatalog } from '../src/context-exporter.mjs'
import { readJson } from '../src/json.mjs'
import { loadProfile } from '../src/profile.mjs'
import { cleanupMaterializedRelease, materializeRelease } from '../src/release-artifacts.mjs'
import { loadReleaseManifest } from '../src/release-manifest.mjs'
import { runFile } from '../src/process.mjs'
import { prepareStatePaths } from '../src/state.mjs'

const suiteRoot = fileURLToPath(new URL('../', import.meta.url))
const manifestPath = process.argv[2] ?? join(suiteRoot, '.build/internal-beta/release-catalog/current.json')
const outputRoot = join(suiteRoot, '.build', 'cost-experiment')
const stateRoot = await mkdtemp(join(tmpdir(), 'agent-host-catalog-measure-'))
let preparation = null

try {
  await mkdir(outputRoot, { recursive: true })
  const release = await loadReleaseManifest(manifestPath)
  const localProfile = await loadProfile('local-dogfood')
  const paths = await prepareStatePaths(stateRoot)
  preparation = await materializeRelease(release, paths, { componentIds: localProfile.components })
  const analyzer = preparation.manifest.components['context-surface-analyzer']
  const node = preparation.manifest.components['node-runtime']
  const analyzerDescriptor = await readJson(analyzer.descriptorPath)
  const analyzerCli = join(analyzer.root, analyzerDescriptor.entrypoints.cli)
  const snapshots = {}
  const measurements = {}

  for (const id of ['standard', 'local-dogfood']) {
    const profile = await loadProfile(id)
    const components = Object.fromEntries(profile.agentComponents.filter((componentId) => preparation.manifest.components[componentId] !== undefined).map((componentId) => [componentId, preparation.manifest.components[componentId]]))
    const snapshot = await exportManagedCatalog(components)
    const snapshotPath = join(outputRoot, `catalog-${id}.json`)
    await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`)
    const analyzed = await runFile(node.command, [analyzerCli, 'analyze', snapshotPath], { cwd: analyzer.root, timeoutMs: 120_000 })
    snapshots[id] = snapshotPath
    measurements[id] = JSON.parse(analyzed.stdout)
  }

  const diffResult = await runFile(node.command, [analyzerCli, 'diff', snapshots.standard, snapshots['local-dogfood']], { cwd: analyzer.root, timeoutMs: 120_000 })
  const document = {
    schemaVersion: 'openadam.agent-host-profile-catalog-measurement.v0.1',
    generatedAt: new Date().toISOString(),
    releaseId: preparation.manifest.releaseId,
    profiles: measurements,
    delta: JSON.parse(diffResult.stdout),
  }
  const destination = join(outputRoot, 'latest-profile-catalogs.json')
  await writeFile(destination, `${JSON.stringify(document, null, 2)}\n`)
  process.stdout.write(`${destination}\n`)
} finally {
  if (preparation !== null) await cleanupMaterializedRelease(preparation)
  await rm(stateRoot, { recursive: true, force: true })
}
