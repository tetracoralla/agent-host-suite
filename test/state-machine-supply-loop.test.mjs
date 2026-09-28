import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { importLocalComponent, previewLocalComponent, removeLocalComponent } from '../src/local-components.mjs'
import { loadState, readStatePaths } from '../src/state.mjs'
import { setup } from '../src/setup.mjs'
import { compatibleApplicationState, createCodexRunner, healthyCatalogPreflight } from './helpers.mjs'
import { createReleaseFixture } from './release-helpers.mjs'
import { inspectBuildSources } from '../scripts/release-source-provenance.mjs'

// The second real Provider rides the same generic agent-tool builder, private
// component import, and Host lifecycle the File Vitals canary used — only the
// plugin spec differs, and this plugin uses the node-executor MCP form. The
// canary reads the real checkout, so it stays opt-in:
// AGENT_HOST_SUPPLY_LOOP=1 node --test --test-timeout=300000 test/state-machine-supply-loop.test.mjs

const sourceRoot = join(homedir(), 'Development/agent-tools/state-machine-editor')
const forbiddenPath = /state-machine-editor|agent-tools|tools-dev/u

async function healthyComponentWarmup({ manifest, componentIds }) {
  return { status: 'ok', strategy: 'sequential-first-and-repeat', components: componentIds.map((id) => ({ id, version: manifest.components[id].version })) }
}

function runtimePaths(component) {
  return [
    component.command,
    component.cwd,
    component.root,
    component.pluginRoot,
    component.marketplaceRoot,
    ...(component.identityFiles ?? []),
    component.providerSkill?.root,
  ].filter((value) => typeof value === 'string')
}

function mcpToolsList(node, script, workspace) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [script], {
      cwd: workspace,
      env: { PATH: '/usr/bin:/bin', HOME: workspace, TMPDIR: workspace },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('state-machine MCP server did not answer tools/list in time'))
    }, 15_000)
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => {
      out += chunk
      const tools = /"machine\.validate"/u.test(out) && /"machine\.find_path"/u.test(out)
      if (tools) {
        clearTimeout(timer)
        child.stdin.end()
        child.on('exit', () => resolve(out))
        child.kill()
      }
    })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('error', (failure) => { clearTimeout(timer); reject(failure) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (!/"machine\.validate"/u.test(out)) reject(new Error(`state-machine MCP server exited ${code} before listing tools: ${err.slice(0, 300)}`))
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'supply-loop', version: '0.0.0' } } })}\n`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`)
  })
}

test('State Machine packs through the shared agent-tool builder, installs, serves MCP, and removes', {
  timeout: 240000,
  skip: process.env.AGENT_HOST_SUPPLY_LOOP !== '1',
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-state-machine-supply-'))
  const componentOutput = join('.build', `state-machine-supply-${process.pid}`)
  const previousEnvironment = Object.fromEntries([
    'AGENT_HOST_OUTPUT_ROOT',
    'AGENT_HOST_SUITE_VERSION',
    'AGENT_HOST_RELEASE_ID',
    'AGENT_HOST_RELEASE_CREATED_AT',
    'AGENT_HOST_COMPONENT_CREATED_AT',
    'AGENT_HOST_STATE_MACHINE_SOURCE_ROOT',
  ].map((name) => [name, process.env[name]]))
  Object.assign(process.env, {
    AGENT_HOST_OUTPUT_ROOT: componentOutput,
    AGENT_HOST_SUITE_VERSION: '0.2.0-state-machine-supply',
    AGENT_HOST_RELEASE_ID: 'state-machine-supply-loop',
    AGENT_HOST_RELEASE_CREATED_AT: '2000-01-01T00:00:00.000Z',
    AGENT_HOST_COMPONENT_CREATED_AT: '2000-01-01T00:00:00.000Z',
    AGENT_HOST_STATE_MACHINE_SOURCE_ROOT: sourceRoot,
  })
  t.after(async () => {
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(root, { recursive: true, force: true })
    await rm(join(process.cwd(), componentOutput), { recursive: true, force: true })
    await rm(join(process.cwd(), `${componentOutput}.staging-${process.pid}`), { recursive: true, force: true })
  })

  const observation = await inspectBuildSources('local-development', { 'state-machine': sourceRoot })
  const { buildStateMachineLocalComponent } = await import('../scripts/build-internal-beta-artifacts.mjs')
  const component = await buildStateMachineLocalComponent(join(root, 'component-work'), {
    repositoryRoot: sourceRoot,
    sourceObservation: observation['state-machine'],
  })
  assert.equal(component.version, '0.1.1')
  assert.equal(component.artifactPath.startsWith(sourceRoot), false)

  const releaseManifest = await createReleaseFixture(join(root, 'host-release'), {
    suiteVersion: '0.2.0-state-machine-supply',
    releaseId: 'state-machine-supply-loop',
    marker: 'state-machine',
  })
  const stateRoot = join(root, 'host-state')
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
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

  const preview = await previewLocalComponent({
    artifact: component.artifactPath,
    licenseSpdx: 'Apache-2.0',
    stateRoot,
    workspaceRoot: workspace,
  }, dependencies)
  assert.equal(preview.component.version, '0.1.1')
  const imported = await importLocalComponent({
    stateRoot,
    artifact: component.artifactPath,
    binding: preview.binding,
    activate: true,
  }, dependencies)
  assert.equal(imported.component.version, '0.1.1')

  const state = await loadState(await readStatePaths(stateRoot))
  const installed = state.components['state-machine']
  const packageDirectory = await realpath(join(await realpath(stateRoot), 'packages'))
  for (const path of runtimePaths(installed)) {
    const resolved = await realpath(path).catch(() => path)
    assert.equal(resolved.startsWith(sourceRoot), false, path)
    assert.equal(forbiddenPath.test(resolved), false, path)
    assert.equal(resolved === packageDirectory || resolved.startsWith(`${packageDirectory}/`), true, path)
  }

  // The release fixture's node-runtime is a shell stub, so the suite node
  // stands in as the executor; the zcode projection below carries the real
  // Host node path with the installed script as its argument.
  const served = await mcpToolsList(process.execPath, installed.args[0], workspace)
  assert.equal(/"machine\.(validate|step|simulate|inspect|diff|find_path)"/u.test(served), true)
  assert.equal(forbiddenPath.test(served), false)

  const zcode = JSON.parse(await readFile(zcodeConfigPath, 'utf8'))
  const zcodeServer = zcode.mcp?.servers?.['state-machine']
  assert.equal(zcodeServer === undefined, false)
  assert.equal(zcodeServer.command, installed.command)
  assert.equal(zcodeServer.cwd, installed.cwd)
  assert.equal(forbiddenPath.test(JSON.stringify(zcodeServer)), false)

  await removeLocalComponent({ stateRoot, target: 'state-machine' }, dependencies)
  const removed = await loadState(await readStatePaths(stateRoot))
  assert.equal(removed.components['state-machine'], undefined)
  const removedConfig = JSON.parse(await readFile(zcodeConfigPath, 'utf8'))
  assert.equal(removedConfig.mcp?.servers?.['state-machine'], undefined)
})
