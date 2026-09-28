import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { importLocalComponent, previewLocalComponent, removeLocalComponent, rollbackLocalComponent } from '../src/local-components.mjs'
import { loadState, readStatePaths } from '../src/state.mjs'
import { setup } from '../src/setup.mjs'
import { compatibleApplicationState, createCodexRunner, healthyCatalogPreflight } from './helpers.mjs'
import { createReleaseFixture } from './release-helpers.mjs'
import { buildFileVitalsPluginFromSource } from '../scripts/provider-source-build.mjs'
import { inspectBuildSources } from '../scripts/release-source-provenance.mjs'

// The canary builds the real File Vitals checkout and upgrades from a retained
// 0.3.2 package, so it stays opt-in. Override the previous package path with
// AGENT_HOST_FILE_VITALS_PREVIOUS_PACKAGE_ROOT when the retained root differs:
// AGENT_HOST_SUPPLY_LOOP=1 node --test --test-timeout=300000 test/file-vitals-supply-loop.test.mjs

const execFileAsync = promisify(execFile)
const sourceRoot = join(homedir(), 'Development/agent-tools/universal-inspector')
const previousPackageRoot = process.env.AGENT_HOST_FILE_VITALS_PREVIOUS_PACKAGE_ROOT
  ?? join(homedir(), 'Library/Application Support/OpenAdam/Agent Host Suite/packages/file-vitals/0.3.2-99b6eb54dcf1acf7')
const forbiddenPath = /universal-inspector|agent-tools|tools-dev/u

async function healthyComponentWarmup({ manifest, componentIds }) {
  return {
    status: 'ok',
    strategy: 'sequential-first-and-repeat',
    components: componentIds.map((id) => ({ id, version: manifest.components[id].version })),
  }
}

function runtimePaths(component) {
  return [
    component.command,
    component.cwd,
    component.root,
    component.pluginRoot,
    component.marketplaceRoot,
    ...(component.identityFiles ?? []),
    component.capabilityProvider?.adapterPath,
    component.capabilityProvider?.manifestPath,
    component.capabilityProvider?.profilePath,
    component.providerSkill?.root,
  ].filter((value) => typeof value === 'string')
}

async function archiveExistingComponent(source, destination) {
  await execFileAsync('/usr/bin/tar', ['-czf', destination, '-C', source, '.'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  return destination
}

async function inspectInstalled(component, workspace, sample) {
  const stdout = execFileSync(component.command, [sample, '--json'], {
    cwd: workspace,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: workspace,
      TMPDIR: workspace,
    },
    encoding: 'utf8',
  })
  assert.equal(forbiddenPath.test(stdout), false)
  const result = JSON.parse(stdout)
  assert.equal(typeof result, 'object')
  assert.equal(result === null, false)
  return result
}

test('File Vitals builds from source, installs outside that source, runs, then updates, rolls back and removes', {
  timeout: 180000,
  skip: process.env.AGENT_HOST_SUPPLY_LOOP !== '1',
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-file-vitals-supply-'))
  const originalPath = process.env.PATH
  t.after(() => {
    process.env.PATH = originalPath
    return rm(root, { recursive: true, force: true })
  })
  const observation = await inspectBuildSources('local-development', { 'file-vitals': sourceRoot })
  const venv = join(root, 'check-venv')
  execFileSync('python3', ['-m', 'venv', venv], { stdio: 'inherit' })
  execFileSync(join(venv, 'bin', 'pip'), ['install', '--disable-pip-version-check', '-r', join(sourceRoot, 'scripts/requirements-check.txt')], { stdio: 'inherit' })
  process.env.PATH = `${join(venv, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`
  const scratchRoot = join(root, 'scratch')
  await mkdir(scratchRoot, { recursive: true })
  const built = await buildFileVitalsPluginFromSource({
    sourceRoot,
    scratchRoot,
    sourceObservation: observation['file-vitals'],
  })
  assert.equal(built.pluginRoot.startsWith(sourceRoot), false)
  assert.equal(forbiddenPath.test(built.pluginRoot), false)
  const componentOutput = join('.build', `file-vitals-supply-${process.pid}`)
  const previousBuildEnvironment = Object.fromEntries([
    'AGENT_HOST_OUTPUT_ROOT',
    'AGENT_HOST_SUITE_VERSION',
    'AGENT_HOST_RELEASE_ID',
    'AGENT_HOST_RELEASE_CREATED_AT',
    'AGENT_HOST_COMPONENT_CREATED_AT',
  ].map((name) => [name, process.env[name]]))
  Object.assign(process.env, {
    AGENT_HOST_OUTPUT_ROOT: componentOutput,
    AGENT_HOST_SUITE_VERSION: '0.2.0-file-vitals-supply',
    AGENT_HOST_RELEASE_ID: 'file-vitals-supply-loop',
    AGENT_HOST_RELEASE_CREATED_AT: '2000-01-01T00:00:00.000Z',
    AGENT_HOST_COMPONENT_CREATED_AT: '2000-01-01T00:00:00.000Z',
  })
  t.after(async () => {
    for (const [name, value] of Object.entries(previousBuildEnvironment)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(join(process.cwd(), componentOutput), { recursive: true, force: true })
    await rm(join(process.cwd(), `${componentOutput}.staging-${process.pid}`), { recursive: true, force: true })
  })
  const { buildFileVitalsComponent } = await import('../scripts/build-internal-beta-artifacts.mjs')
  const current = await buildFileVitalsComponent(join(root, 'component-work'), {
    repositoryRoot: sourceRoot,
    capabilityRoot: join(process.cwd(), '..', 'capability-contracts'),
    pluginRoot: built.pluginRoot,
    pluginArchive: built.archivePath,
    pluginArchiveSha256: built.sha256,
    sourceObservation: observation['file-vitals'],
  })
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  const sample = join(workspace, 'sample.txt')
  await writeFile(sample, 'supply loop\n')

  const releaseManifest = await createReleaseFixture(join(root, 'host-release'), {
    suiteVersion: '0.2.0-file-vitals-supply',
    releaseId: 'file-vitals-supply-loop',
    marker: 'file-vitals',
  })
  const stateRoot = join(root, 'host-state')
  const hostSkillHome = join(root, 'host-home')
  const zcodeConfigPath = join(hostSkillHome, '.zcode', 'cli', 'config.json')
  const fake = createCodexRunner({ mathPresent: false, timePresent: false, mathMarketplace: 'openadam', mathVersion: '0.4.0' })
  const runner = async (command, args, options) => {
    if (args[0] === 'version') return { status: 0, stdout: '0.16.5\n', stderr: '' }
    return fake.runner(command, args, options)
  }
  const dependencies = {
    runner,
    codexConfiguration: fake.configuration,
    hostSkillHome,
    zcodeConfigPath,
    zcodeExecutable: process.execPath,
    componentWarmup: healthyComponentWarmup,
    catalogPreflight: healthyCatalogPreflight,
    applicationStatePreflight: compatibleApplicationState,
  }
  await setup({
    profile: 'standard',
    hosts: ['codex', 'zcode'],
    releaseManifest,
    stateRoot,
    workspaceRoot: workspace,
    noService: true,
    dryRun: false,
    enableObservability: false,
  }, dependencies)

  await access(previousPackageRoot)
  const previousArchive = await archiveExistingComponent(previousPackageRoot, join(root, 'file-vitals-0.3.2-rebuilt.tar.gz'))
  const previous = await previewLocalComponent({
    artifact: previousArchive,
    licenseSpdx: 'Apache-2.0',
    stateRoot,
    workspaceRoot: workspace,
  }, dependencies)
  await importLocalComponent({
    stateRoot,
    artifact: previousArchive,
    binding: previous.binding,
    workspaceRoot: workspace,
    activate: true,
  }, dependencies)
  const installedPrevious = (await loadState(await readStatePaths(stateRoot))).components['file-vitals']
  assert.equal(installedPrevious.version, '0.3.2')
  await inspectInstalled(installedPrevious, workspace, sample)

  const preview = await previewLocalComponent({
    artifact: current.artifactPath,
    licenseSpdx: 'Apache-2.0',
    stateRoot,
    workspaceRoot: workspace,
  }, dependencies)
  assert.deepEqual(preview.health.repeat.tools, ['file_inspect', 'file_inspect_batch', 'workspace_inventory'])
  const imported = await importLocalComponent({
    stateRoot,
    artifact: current.artifactPath,
    binding: preview.binding,
    workspaceRoot: workspace,
    activate: true,
    replace: true,
  }, dependencies)
  assert.equal(imported.component.version, '0.3.3')
  const state = await loadState(await readStatePaths(stateRoot))
  const component = state.components['file-vitals']
  const packageDirectory = await realpath(join(await realpath(stateRoot), 'packages'))
  for (const path of runtimePaths(component)) {
    const resolved = await realpath(path).catch(() => path)
    assert.equal(resolved.startsWith(sourceRoot), false, path)
    assert.equal(forbiddenPath.test(resolved), false, path)
    assert.equal(resolved === packageDirectory || resolved.startsWith(`${packageDirectory}/`), true, path)
  }
  const packageRoot = component.root
  assert.equal((await lstat(component.command)).isSymbolicLink(), false)
  const inspected = await inspectInstalled(component, workspace, sample)
  assert.equal(JSON.stringify(inspected).includes(sourceRoot), false)

  const zcode = JSON.parse(await readFile(zcodeConfigPath, 'utf8'))
  const zcodeServer = zcode.mcp.servers['file-vitals']
  assert.equal(zcodeServer.command, component.command)
  assert.equal(zcodeServer.cwd, component.cwd)
  assert.equal(forbiddenPath.test(JSON.stringify(zcodeServer)), false)
  const codexProjection = state.hosts.codex.plugins?.find?.((plugin) => plugin.plugin === 'file-vitals')
    ?? state.hosts.codex.productPlugins?.find?.((plugin) => plugin.id === 'file-vitals' || plugin.plugin === 'file-vitals')
  if (codexProjection !== undefined) {
    const projectionText = JSON.stringify(codexProjection)
    assert.equal(forbiddenPath.test(projectionText), false)
  }

  await rollbackLocalComponent({ stateRoot, target: 'file-vitals', workspaceRoot: workspace }, dependencies)
  const rolled = (await loadState(await readStatePaths(stateRoot))).components['file-vitals']
  assert.equal(rolled.version, '0.3.2')
  assert.equal(rolled.command === component.command, false)
  await inspectInstalled(rolled, workspace, sample)
  const afterRollback = JSON.parse(await readFile(zcodeConfigPath, 'utf8')).mcp.servers['file-vitals']
  assert.equal(afterRollback.command, rolled.command)

  await removeLocalComponent({ stateRoot, target: 'file-vitals' }, dependencies)
  const removed = await loadState(await readStatePaths(stateRoot))
  assert.equal(removed.components['file-vitals'], undefined)
  assert.equal(removed.agentComponents.includes('file-vitals'), false)
  assert.equal(removed.privateComponents['file-vitals'].current, null)
  const removedConfig = JSON.parse(await readFile(zcodeConfigPath, 'utf8'))
  assert.equal(removedConfig.mcp.servers['file-vitals'], undefined)
  assert.equal((await lstat(packageRoot)).isDirectory(), true)
})
