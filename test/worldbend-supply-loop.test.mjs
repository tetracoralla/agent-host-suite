import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { componentEnvironment } from '../src/component-environment.mjs'
import { importLocalComponent, previewLocalComponent, removeLocalComponent } from '../src/local-components.mjs'
import { loadState, readStatePaths } from '../src/state.mjs'
import { setup } from '../src/setup.mjs'
import { compatibleApplicationState, createCodexRunner, healthyCatalogPreflight } from './helpers.mjs'
import { createReleaseFixture } from './release-helpers.mjs'

// Worldbend owns its sealed package. This opt-in canary consumes those exact
// bytes rather than rebuilding or running the source checkout:
// AGENT_HOST_SUPPLY_LOOP=1 node --test --test-timeout=300000 test/worldbend-supply-loop.test.mjs
// Override the immutable archive with AGENT_HOST_WORLDBEND_ARTIFACT when needed.

const sourceRoot = join(homedir(), 'Development/agent-tools/perspective-tool')
const forbiddenPath = /perspective-tool|agent-tools|tools-dev/u

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

async function defaultArtifact() {
  const artifactRoot = join(sourceRoot, 'artifacts', 'agent-host')
  const releases = await Promise.all((await readdir(artifactRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const reportPath = join(artifactRoot, entry.name, 'package-report.json')
      return { name: entry.name, modifiedAt: await stat(reportPath).then((info) => info.mtimeMs, () => 0) }
    }))
  releases.sort((left, right) => right.modifiedAt - left.modifiedAt || right.name.localeCompare(left.name))
  for (const release of releases) {
    const reportPath = join(artifactRoot, release.name, 'package-report.json')
    let report
    try {
      report = JSON.parse(await readFile(reportPath, 'utf8'))
    } catch {
      continue
    }
    if (report?.id === 'worldbend' && typeof report.archive === 'string') return join(artifactRoot, release.name, report.archive)
  }
  throw new Error(`No sealed Worldbend Agent Host artifact found under ${artifactRoot}`)
}

function exerciseMcp(component, workspace, privateRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(component.command, component.args, {
      cwd: component.cwd,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: privateRoot,
        TMPDIR: privateRoot,
        ...componentEnvironment(component, workspace),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const replies = new Map()
    const finish = (failure, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdin.end()
      child.kill()
      if (failure !== null) reject(failure)
      else resolve(result)
    }
    const timer = setTimeout(() => {
      finish(new Error(`Worldbend MCP did not complete the semantic probe: ${stderr.slice(0, 500)}`))
    }, 20_000)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      const lines = stdout.split('\n')
      stdout = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim().length === 0) continue
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (message.id !== undefined) replies.set(message.id, message)
      }
      if (replies.has(2) && replies.has(3)) finish(null, replies)
    })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (failure) => finish(failure))
    child.on('exit', (code) => {
      if (!settled) finish(new Error(`Worldbend MCP exited ${code} before completing the semantic probe: ${stderr.slice(0, 500)}`))
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'supply-loop', version: '0.0.0' } } })}\n`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`)
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'worldbend.run',
        arguments: {
          operation: 'pose',
          arguments: {
            elementSize: { width: 640, height: 360 },
            pose: { perspective: 1400, rotateX: 3, rotateY: -8 },
          },
        },
      },
    })}\n`)
  })
}

test('Worldbend installs from sealed product bytes, serves a real spatial operation, projects, and removes', {
  timeout: 120000,
  skip: process.env.AGENT_HOST_SUPPLY_LOOP !== '1',
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-worldbend-supply-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const artifact = process.env.AGENT_HOST_WORLDBEND_ARTIFACT ?? await defaultArtifact()
  const releaseManifest = await createReleaseFixture(join(root, 'host-release'), {
    suiteVersion: '0.2.0-worldbend-supply',
    releaseId: 'worldbend-supply-loop',
    marker: 'worldbend',
  })
  const stateRoot = join(root, 'host-state')
  const workspace = join(root, 'workspace')
  const privateRoot = join(root, 'provider-private')
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(privateRoot, { recursive: true }),
  ])
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
    artifact,
    licenseSpdx: 'Apache-2.0',
    stateRoot,
    workspaceRoot: workspace,
  }, dependencies)
  assert.deepEqual(preview.health.repeat.tools, ['worldbend.describe', 'worldbend.run', 'worldbend.search'])
  const imported = await importLocalComponent({
    stateRoot,
    artifact,
    binding: preview.binding,
    workspaceRoot: workspace,
    activate: true,
  }, dependencies)
  assert.equal(imported.component.productType, 'provider')

  const state = await loadState(await readStatePaths(stateRoot))
  const component = state.components.worldbend
  const packageDirectory = await realpath(join(await realpath(stateRoot), 'packages'))
  for (const path of runtimePaths(component)) {
    const resolved = await realpath(path).catch(() => path)
    assert.equal(resolved.startsWith(sourceRoot), false, path)
    assert.equal(forbiddenPath.test(resolved), false, path)
    assert.equal(resolved === packageDirectory || resolved.startsWith(`${packageDirectory}/`), true, path)
  }

  const replies = await exerciseMcp(component, workspace, privateRoot)
  const toolNames = replies.get(2).result.tools.map((tool) => tool.name).sort()
  assert.deepEqual(toolNames, ['worldbend.describe', 'worldbend.run', 'worldbend.search'])
  assert.equal(replies.get(3).error, undefined)
  assert.equal(replies.get(3).result.structuredContent.ok, true)
  assert.equal(replies.get(3).result.structuredContent.result.spec.destination.space, 'pixel')
  assert.equal(typeof replies.get(3).result.structuredContent.result.css.transform, 'string')
  assert.equal(forbiddenPath.test(JSON.stringify([...replies.values()])), false)

  const zcode = JSON.parse(await readFile(zcodeConfigPath, 'utf8'))
  const zcodeServer = zcode.mcp?.servers?.worldbend
  assert.equal(zcodeServer.command, component.command)
  assert.equal(zcodeServer.cwd, component.cwd)
  assert.equal(zcodeServer.env.WORLDBEND_WORKSPACE_ROOT, await realpath(workspace))
  assert.equal(forbiddenPath.test(JSON.stringify(zcodeServer)), false)

  await removeLocalComponent({ stateRoot, target: 'worldbend' }, dependencies)
  const removed = await loadState(await readStatePaths(stateRoot))
  assert.equal(removed.components.worldbend, undefined)
  assert.equal(removed.agentComponents.includes('worldbend'), false)
  const removedConfig = JSON.parse(await readFile(zcodeConfigPath, 'utf8'))
  assert.equal(removedConfig.mcp?.servers?.worldbend, undefined)
})
