import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  REQUIRED_RELEASE_COMPONENTS,
  buildRequiredProfileTool,
  buildWorkspacePackage,
  githubAssetMatchesPlatform,
  installProductionDependencies,
  officialNodeBinaryPath,
  profileRuntimeEntrypoint,
  readSourcePins,
  removeLinks,
} from '../scripts/build-unsigned-preview-catalog.mjs'

test('unsigned preview catalogs keep the default profile component set', async () => {
  const source = await readFile(new URL('../src/release-manifest.mjs', import.meta.url), 'utf8')
  assert.match(source, /const required = REQUIRED_RELEASE_COMPONENTS/u)
  assert.equal(source.includes("manifest.status === 'unsigned-preview'\n    ? ['node-runtime', 'direct-execution-runtime']"), false)
})

test('Windows official Node layout is the archive-root node.exe', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-node-layout-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'node.exe'), 'windows-node')
  assert.equal(await officialNodeBinaryPath(root, 'win32-x64'), join(root, 'node.exe'))
  await assert.rejects(() => officialNodeBinaryPath(root, 'darwin-arm64'), /bin\/node/u)
})

test('GitHub tool import refuses a different-platform native archive', () => {
  assert.equal(
    githubAssetMatchesPlatform(
      'armorial-0.8.0-host-component.tar.gz',
      { origin: { assetName: 'armorial-0.8.0-codex-plugin-macos-arm64.tar.gz' } },
      'win32-x64',
    ),
    false,
  )
  assert.equal(
    githubAssetMatchesPlatform(
      'armorial-0.8.0-host-component.tar.gz',
      { origin: { assetName: 'armorial-0.8.0-codex-plugin-macos-arm64.tar.gz' } },
      'darwin-arm64',
    ),
    true,
  )
})

test('Direct Runtime unsigned payload includes production dependencies', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-der-pack-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const artifactRoot = join(root, 'artifacts')
  await mkdir(artifactRoot, { recursive: true })
  const component = await buildWorkspacePackage({
    id: 'direct-execution-runtime',
    kind: 'direct-runtime',
    source: fileURLToPath(new URL('../packages/direct-execution-runtime', import.meta.url)),
    entrypoint: 'src/cli.mjs',
    title: 'Direct Execution Runtime',
    workRoot: root,
    artifactRoot,
    platform: 'test-platform',
    installDependencies: true,
  })
  assert.equal(component.id, 'direct-execution-runtime')
  const extracted = join(root, 'extracted')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)
  await mkdir(extracted, { recursive: true })
  const tar = process.platform === 'win32' ? 'tar.exe' : '/usr/bin/tar'
  await execFileAsync(tar, ['-xzf', join(artifactRoot, component.artifact.url.replace('artifacts/', '')), '-C', extracted])
  const sdk = join(extracted, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json')
  JSON.parse(await readFile(sdk, 'utf8'))
  try {
    await execFileAsync(process.execPath, [join(extracted, 'src/cli.mjs')], { timeout: 10000 })
    assert.fail('direct runtime CLI should print usage when invoked without a command')
  } catch (error) {
    const text = `${error.stderr ?? ''}${error.stdout ?? ''}${error.message ?? ''}`
    assert.equal(text.includes('ERR_MODULE_NOT_FOUND'), false)
    assert.match(text, /Usage:|HOST_CLI_USAGE|openadam-direct-exec/u)
  }
})

test('Observer unsigned payload includes the adapter catalog', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-observer-pack-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const artifactRoot = join(root, 'artifacts')
  await mkdir(artifactRoot, { recursive: true })
  const component = await buildWorkspacePackage({
    id: 'agent-tool-observer',
    kind: 'agent-tool-observer',
    source: fileURLToPath(new URL('../packages/agent-tool-observer', import.meta.url)),
    entrypoint: 'src/cli.mjs',
    title: 'Agent Tool Observer',
    workRoot: root,
    artifactRoot,
    platform: 'test-platform',
    extraPaths: ['adapters', 'integrations'],
    extraIdentityFiles: [
      'adapters/claude-code-hooks.json',
      'adapters/claude-project-events.json',
      'adapters/codex-session-events.json',
      'adapters/deepseek-harness-session-events.json',
      'adapters/gemini-cli-otel.json',
      'adapters/github-copilot-cli-hooks.json',
      'adapters/zcode-model-io.json',
    ],
  })
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)
  const extracted = join(root, 'extracted')
  await mkdir(extracted, { recursive: true })
  const tar = process.platform === 'win32' ? 'tar.exe' : '/usr/bin/tar'
  await execFileAsync(tar, ['-xzf', join(artifactRoot, component.artifact.url.replace('artifacts/', '')), '-C', extracted])
  JSON.parse(await readFile(join(extracted, 'adapters/codex-session-events.json'), 'utf8'))
  const help = await execFileAsync(process.execPath, [join(extracted, 'src/cli.mjs'), '--help'], { timeout: 15000 })
  assert.equal(help.stderr.includes('TRACE_ADAPTER_CATALOG_MISSING'), false)
})

test('R5 unsigned catalog refuses missing Math Anchor / Migratory Time inputs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-r5-missing-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { buildRequiredProfileTool } = await import('../scripts/build-unsigned-preview-catalog.mjs')
  await assert.rejects(
    () => buildRequiredProfileTool({
      id: 'math-anchor',
      kind: 'math-anchor',
      sourceRoot: join(root, 'missing-math'),
      pluginRelative: 'plugins/math-anchor',
      identityFiles: ['plugins/math-anchor/.codex-plugin/plugin.json'],
      entrypoint: 'plugins/math-anchor/runtime/math-anchor-runtime/math-anchor-runtime',
      title: 'Math Anchor',
      workRoot: join(root, 'work'),
      artifactRoot: join(root, 'artifacts'),
      platform: 'test-platform',
    }),
    /math-anchor is required|SOURCE_ROOT|ARTIFACT/u,
  )
})

test('R5 unsigned catalog builds a complete default profile from explicit SOURCE_ROOT fixtures', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-r5-complete-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { buildRequiredProfileTool, buildWorkspacePackage, REQUIRED_RELEASE_COMPONENTS } = await import('../scripts/build-unsigned-preview-catalog.mjs')
  const artifactRoot = join(root, 'artifacts')
  const workRoot = join(root, 'work')
  await mkdir(artifactRoot, { recursive: true })

  async function seedProfile(id, entrypointRelative, version) {
    const sourceRoot = join(root, 'sources', id)
    const plugin = join(sourceRoot, 'plugins', id)
    await mkdir(join(plugin, dirname(entrypointRelative)), { recursive: true })
    await mkdir(join(plugin, '.codex-plugin'), { recursive: true })
    await writeFile(join(plugin, '.codex-plugin/plugin.json'), `${JSON.stringify({ name: id, version }, null, 2)}\n`)
    await writeFile(join(plugin, '.mcp.json'), `${JSON.stringify({ mcpServers: { [id]: { command: 'node', args: ['server.mjs'] } } }, null, 2)}\n`)
    await writeFile(join(plugin, entrypointRelative), '#!/bin/sh\necho ok\n')
    await writeFile(join(sourceRoot, 'LICENSE'), 'Apache-2.0\n')
    await writeFile(join(sourceRoot, 'NOTICE'), `${id}\n`)
    await mkdir(join(sourceRoot, '.agents/plugins'), { recursive: true })
    await writeFile(join(sourceRoot, '.agents/plugins/marketplace.json'), `${JSON.stringify({
      name: id === 'math-anchor' ? 'math-anchor-agent-host' : id,
      plugins: [{ name: id, source: { source: 'local', path: `./plugins/${id}` } }],
    }, null, 2)}\n`)
    if (id === 'migratory-time') {
      await writeFile(join(sourceRoot, 'package.json'), `${JSON.stringify({ name: id, version, private: true }, null, 2)}\n`)
      await mkdir(join(sourceRoot, 'capabilities/schemas'), { recursive: true })
      await writeFile(join(sourceRoot, 'capabilities/provider.json'), `${JSON.stringify({
        provider: { id: 'migratory-time', version },
        implementations: [{ capabilityId: 'time-zone.convert', capabilityVersion: '0.2', adapter: { protocol: 'openadam.capability-jsonl.v0.1', command: 'plugins/migratory-time/runtime/node', args: [] } }],
      }, null, 2)}\n`)
      await writeFile(join(sourceRoot, 'capabilities/schemas/time-zone.convert.input.schema.json'), '{}\n')
      await writeFile(join(sourceRoot, 'capabilities/schemas/time-zone.convert.output.schema.json'), '{}\n')
      await mkdir(join(sourceRoot, 'scripts'), { recursive: true })
      await writeFile(join(sourceRoot, 'scripts/runCapabilityAdapter.mjs'), 'export {}\n')
      await writeFile(join(sourceRoot, 'scripts/capabilityProviderLib.mjs'), 'export {}\n')
    }
    return sourceRoot
  }

  const execFileAsync = promisify(execFile)
  process.env.AGENT_HOST_CAPABILITY_CONTRACTS_SOURCE_ROOT = fileURLToPath(new URL('./fixtures/capability-contracts', import.meta.url))
  const mathRoot = await seedProfile('math-anchor', 'runtime/math-anchor-runtime/math-anchor-runtime', '0.7.1')
  const timeRoot = await seedProfile('migratory-time', 'server/index.mjs', '2.0.0+codex.20260830163923')

  const components = [
    {
      id: 'node-runtime',
      version: '22.22.1',
      platform: 'test-platform',
      artifact: { url: 'artifacts/node.tar.gz', sha256: `sha256:${'a'.repeat(64)}`, bytes: 10, format: 'tar.gz' },
      descriptorSha256: `sha256:${'b'.repeat(64)}`,
      license: { spdx: 'Apache-2.0', files: ['LICENSE'] },
    },
    await buildWorkspacePackage({
      id: 'direct-execution-runtime',
      kind: 'direct-runtime',
      source: fileURLToPath(new URL('../packages/direct-execution-runtime', import.meta.url)),
      entrypoint: 'src/cli.mjs',
      title: 'Direct Execution Runtime',
      workRoot,
      artifactRoot,
      platform: 'test-platform',
      installDependencies: true,
    }),
    await buildRequiredProfileTool({
      id: 'math-anchor',
      kind: 'math-anchor',
      sourceRoot: mathRoot,
      pluginRelative: 'plugins/math-anchor',
      identityFiles: [
        'plugins/math-anchor/.codex-plugin/plugin.json',
        'plugins/math-anchor/.mcp.json',
      ],
      entrypoint: 'plugins/math-anchor/runtime/math-anchor-runtime/math-anchor-runtime',
      title: 'Math Anchor',
      workRoot,
      artifactRoot,
      platform: 'test-platform',
      pins: { sources: { 'math-anchor': { expectedVersion: '0.7.1' } } },
    }),
    await buildRequiredProfileTool({
      id: 'migratory-time',
      kind: 'migratory-time',
      sourceRoot: timeRoot,
      pluginRelative: 'plugins/migratory-time',
      identityFiles: [
        'plugins/migratory-time/.codex-plugin/plugin.json',
        'plugins/migratory-time/.mcp.json',
      ],
      entrypoint: 'plugins/migratory-time/server/index.mjs',
      title: 'Migratory Time',
      workRoot,
      artifactRoot,
      platform: 'test-platform',
      pins: { sources: { 'migratory-time': { expectedVersion: '2.0.0+codex.20260830163923' } } },
    }),
  ]
  const ids = components.map((item) => item.id)
  for (const id of REQUIRED_RELEASE_COMPONENTS) {
    assert.equal(ids.includes(id), true, `missing ${id}`)
  }
  for (const component of components.filter((item) => item.id === 'math-anchor' || item.id === 'migratory-time')) {
    assert.equal(typeof component.artifact?.url, 'string')
    const archivePath = join(artifactRoot, component.artifact.url.replace(/^artifacts\//u, ''))
    const extract = join(root, `extract-${component.id}`)
    await mkdir(extract, { recursive: true })
    await execFileAsync(process.platform === 'win32' ? 'tar.exe' : '/usr/bin/tar', ['-xzf', archivePath, '-C', extract])
    const descriptor = JSON.parse(await readFile(join(extract, 'component.json'), 'utf8'))
    assert.notEqual(descriptor.integration, null)
    assert.equal(descriptor.integration.pluginRoot, `plugins/${component.id}`)
    if (component.id === 'migratory-time') {
      for (const name of ['server', 'adapter', 'manifest', 'inputSchema', 'outputSchema', 'profile']) {
        assert.equal(typeof descriptor.entrypoints[name], 'string', name)
      }
    } else {
      assert.equal(typeof descriptor.entrypoints.command, 'string')
    }
    assert.match(component.artifact.sha256, /^sha256:[0-9a-f]{64}$/u)
    assert.equal(component.platform, 'test-platform')
  }
})

test('R5 docs unsigned-preview workflow draft obtains pinned profile sources and stays under docs/', async () => {
  const workflow = await readFile(new URL('../docs/unsigned-preview-release.yml', import.meta.url), 'utf8')
  assert.match(workflow, /docs\/\)\. Copy to/u)
  assert.match(workflow, /workflow` scope/u)
  assert.match(workflow, /tetracoralla\/math-anchor/u)
  assert.match(workflow, /tetracoralla\/migratory-time/u)
  assert.match(workflow, /62562762ba60093a804a72ad917a5a3753c840c3/u)
  assert.match(workflow, /0355fd34c99cd9c51a0eeecf20f20ef6369cdd54/u)
  assert.match(workflow, /AGENT_HOST_MATH_ANCHOR_SOURCE_ROOT/u)
  assert.match(workflow, /AGENT_HOST_MIGRATORY_TIME_SOURCE_ROOT/u)
  assert.match(workflow, /script\/package_runtime\.sh/u)
  assert.doesNotMatch(workflow, /elif \[ -f Package\.swift \]; then\s*\n\s*swift build -c release/u)
  assert.match(workflow, /AGENT_HOST_MATH_ANCHOR_ARTIFACT_URL/u)
  assert.match(workflow, /ARTIFACT wins over SOURCE_ROOT/u)
  // D2: both pre-supplied path and URL download must export absolute ARTIFACT via GITHUB_ENV.
  assert.match(workflow, /Using pre-supplied Math Anchor ARTIFACT[\s\S]*?GITHUB_ENV/u)
  assert.match(workflow, /Downloading Math Anchor Windows ARTIFACT[\s\S]*?GITHUB_ENV/u)
  assert.equal((workflow.match(/AGENT_HOST_MATH_ANCHOR_ARTIFACT=\$resolved/g) ?? []).length, 2)
  const { access } = await import('node:fs/promises')
  await assert.rejects(() => access(fileURLToPath(new URL('../.github/workflows/unsigned-preview-release.yml', import.meta.url))))
})

test('D ARTIFACT wins over SOURCE_ROOT that lacks the runtime entrypoint', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-d-artifact-wins-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { buildRequiredProfileTool, profileRuntimeEntrypoint } = await import('../scripts/build-unsigned-preview-catalog.mjs')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)
  const tar = process.platform === 'win32' ? 'tar.exe' : '/usr/bin/tar'

  const sourceRoot = join(root, 'source-without-runtime')
  const plugin = join(sourceRoot, 'plugins/math-anchor')
  await mkdir(join(plugin, '.codex-plugin'), { recursive: true })
  await writeFile(join(plugin, '.codex-plugin/plugin.json'), `${JSON.stringify({ name: 'math-anchor', version: '0.7.1' })}\n`)
  await writeFile(join(plugin, '.mcp.json'), '{}\n')
  await writeFile(join(sourceRoot, 'LICENSE'), 'Apache-2.0\n')
  await writeFile(join(sourceRoot, 'NOTICE'), 'source-only\n')
  // Deliberately no runtime/ tree — mirrors pinned Math Anchor before package_runtime.

  const artifactTree = join(root, 'artifact-tree')
  const artifactPlugin = join(artifactTree, 'plugins/math-anchor')
  const entry = 'plugins/math-anchor/runtime/math-anchor-runtime/math-anchor-runtime'
  await mkdir(join(artifactPlugin, 'runtime/math-anchor-runtime'), { recursive: true })
  await mkdir(join(artifactPlugin, '.codex-plugin'), { recursive: true })
  await writeFile(join(artifactPlugin, '.codex-plugin/plugin.json'), `${JSON.stringify({ name: 'math-anchor', version: '0.7.1' })}\n`)
  await writeFile(join(artifactPlugin, '.mcp.json'), '{}\n')
  await writeFile(join(artifactTree, entry), '#!/bin/sh\necho math-anchor-runtime\n', { mode: 0o755 })
  await writeFile(join(artifactTree, 'LICENSE'), 'Apache-2.0\n')
  await writeFile(join(artifactTree, 'NOTICE'), 'artifact-tree\n')
  const artifactArchive = join(root, 'math-anchor-artifact.tgz')
  await execFileAsync(tar, ['-czf', artifactArchive, '-C', artifactTree, '.'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })

  await assert.rejects(
    () => buildRequiredProfileTool({
      id: 'math-anchor',
      kind: 'math-anchor',
      sourceRoot,
      pluginRelative: 'plugins/math-anchor',
      identityFiles: ['plugins/math-anchor/.codex-plugin/plugin.json', 'plugins/math-anchor/.mcp.json'],
      entrypoint: entry,
      workRoot: join(root, 'work-fail'),
      artifactRoot: join(root, 'artifacts-fail'),
      platform: 'test-platform',
      title: 'Math Anchor',
      pins: { sources: { 'math-anchor': { expectedVersion: '0.7.1' } } },
    }),
    /missing its runtime entrypoint|package_runtime/u,
  )

  const artifactRootOk = join(root, 'artifacts-ok')
  await mkdir(artifactRootOk, { recursive: true })
  const component = await buildRequiredProfileTool({
    id: 'math-anchor',
    kind: 'math-anchor',
    sourceRoot,
    artifactPath: artifactArchive,
    pluginRelative: 'plugins/math-anchor',
    identityFiles: ['plugins/math-anchor/.codex-plugin/plugin.json', 'plugins/math-anchor/.mcp.json'],
    entrypoint: entry,
    workRoot: join(root, 'work-ok'),
    artifactRoot: artifactRootOk,
    platform: 'test-platform',
    title: 'Math Anchor',
    pins: { sources: { 'math-anchor': { expectedVersion: '0.7.1' } } },
  })
  assert.equal(component.id, 'math-anchor')
  assert.equal(component.version, '0.7.1')
  assert.match(component.artifact.sha256, /^sha256:[0-9a-f]{64}$/u)
  assert.equal(profileRuntimeEntrypoint(entry, 'win32-x64'), `${entry}.exe`)
  assert.equal(profileRuntimeEntrypoint(`${entry}.exe`, 'darwin-arm64'), entry)
  assert.equal(profileRuntimeEntrypoint('plugins/migratory-time/server/index.mjs', 'win32-x64'), 'plugins/migratory-time/server/index.mjs')
})

test('D1 profileRuntimeEntrypoint appends .exe only for native Windows binaries', () => {
  const math = 'plugins/math-anchor/runtime/math-anchor-runtime/math-anchor-runtime'
  const migratory = 'plugins/migratory-time/server/index.mjs'
  assert.equal(profileRuntimeEntrypoint(math, 'win32-x64'), `${math}.exe`)
  assert.equal(profileRuntimeEntrypoint(`${math}.exe`, 'win32-x64'), `${math}.exe`)
  assert.equal(profileRuntimeEntrypoint(migratory, 'win32-x64'), migratory)
  assert.equal(profileRuntimeEntrypoint('plugins/demo/server/index.js', 'win32-x64'), 'plugins/demo/server/index.js')
  assert.equal(profileRuntimeEntrypoint('plugins/demo/server/index.cjs', 'win32-x64'), 'plugins/demo/server/index.cjs')
  assert.equal(profileRuntimeEntrypoint('plugins/demo/server/index.ts', 'win32-x64'), 'plugins/demo/server/index.ts')
  assert.equal(profileRuntimeEntrypoint(math, 'darwin-arm64'), math)
  assert.equal(profileRuntimeEntrypoint(`${math}.exe`, 'darwin-arm64'), math)
  assert.equal(profileRuntimeEntrypoint(migratory, 'darwin-arm64'), migratory)
})

test('D1 win32 builder keeps Migratory Time .mjs and requires Math Anchor .exe', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-d1-win32-entry-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { buildRequiredProfileTool } = await import('../scripts/build-unsigned-preview-catalog.mjs')
  const artifactRoot = join(root, 'artifacts')
  const workRoot = join(root, 'work')
  await mkdir(artifactRoot, { recursive: true })

  async function seedProfile(id, entrypointRelative, version, { windowsNative = false } = {}) {
    const sourceRoot = join(root, 'sources', id)
    const plugin = join(sourceRoot, 'plugins', id)
    await mkdir(join(plugin, dirname(entrypointRelative)), { recursive: true })
    await mkdir(join(plugin, '.codex-plugin'), { recursive: true })
    await writeFile(join(plugin, '.codex-plugin/plugin.json'), `${JSON.stringify({ name: id, version }, null, 2)}\n`)
    await writeFile(join(plugin, '.mcp.json'), `${JSON.stringify({ mcpServers: { [id]: { command: 'node', args: ['server.mjs'] } } }, null, 2)}\n`)
    const onDisk = windowsNative ? `${entrypointRelative}.exe` : entrypointRelative
    await mkdir(join(plugin, dirname(onDisk)), { recursive: true })
    await writeFile(join(plugin, onDisk), windowsNative ? 'MZ-native-stub\n' : 'export {}\n')
    await writeFile(join(sourceRoot, 'LICENSE'), 'Apache-2.0\n')
    await writeFile(join(sourceRoot, 'NOTICE'), `${id}\n`)
    await mkdir(join(sourceRoot, '.agents/plugins'), { recursive: true })
    await writeFile(join(sourceRoot, '.agents/plugins/marketplace.json'), `${JSON.stringify({
      name: id === 'math-anchor' ? 'math-anchor-agent-host' : id,
      plugins: [{ name: id, source: { source: 'local', path: `./plugins/${id}` } }],
    }, null, 2)}\n`)
    if (id === 'migratory-time') {
      await writeFile(join(sourceRoot, 'package.json'), `${JSON.stringify({ name: id, version, private: true }, null, 2)}\n`)
      await mkdir(join(sourceRoot, 'capabilities/schemas'), { recursive: true })
      await writeFile(join(sourceRoot, 'capabilities/provider.json'), `${JSON.stringify({
        provider: { id: 'migratory-time', version },
        implementations: [{ capabilityId: 'time-zone.convert', capabilityVersion: '0.2', adapter: { protocol: 'openadam.capability-jsonl.v0.1', command: 'plugins/migratory-time/runtime/node', args: [] } }],
      }, null, 2)}\n`)
      await writeFile(join(sourceRoot, 'capabilities/schemas/time-zone.convert.input.schema.json'), '{}\n')
      await writeFile(join(sourceRoot, 'capabilities/schemas/time-zone.convert.output.schema.json'), '{}\n')
      await mkdir(join(sourceRoot, 'scripts'), { recursive: true })
      await writeFile(join(sourceRoot, 'scripts/runCapabilityAdapter.mjs'), 'export {}\n')
      await writeFile(join(sourceRoot, 'scripts/capabilityProviderLib.mjs'), 'export {}\n')
    }
    return sourceRoot
  }

  process.env.AGENT_HOST_CAPABILITY_CONTRACTS_SOURCE_ROOT = fileURLToPath(new URL('./fixtures/capability-contracts', import.meta.url))
  const mathRoot = await seedProfile(
    'math-anchor',
    'runtime/math-anchor-runtime/math-anchor-runtime',
    '0.7.1',
    { windowsNative: true },
  )
  const timeRoot = await seedProfile('migratory-time', 'server/index.mjs', '2.0.0+codex.20260830163923')

  const math = await buildRequiredProfileTool({
    id: 'math-anchor',
    kind: 'math-anchor',
    sourceRoot: mathRoot,
    pluginRelative: 'plugins/math-anchor',
    identityFiles: [
      'plugins/math-anchor/.codex-plugin/plugin.json',
      'plugins/math-anchor/.mcp.json',
    ],
    entrypoint: 'plugins/math-anchor/runtime/math-anchor-runtime/math-anchor-runtime',
    title: 'Math Anchor',
    workRoot,
    artifactRoot,
    platform: 'win32-x64',
    pins: { sources: { 'math-anchor': { expectedVersion: '0.7.1' } } },
  })
  assert.equal(math.id, 'math-anchor')
  assert.equal(math.platform, 'win32-x64')

  const migratory = await buildRequiredProfileTool({
    id: 'migratory-time',
    kind: 'migratory-time',
    sourceRoot: timeRoot,
    pluginRelative: 'plugins/migratory-time',
    identityFiles: [
      'plugins/migratory-time/.codex-plugin/plugin.json',
      'plugins/migratory-time/.mcp.json',
    ],
    entrypoint: 'plugins/migratory-time/server/index.mjs',
    title: 'Migratory Time',
    workRoot,
    artifactRoot,
    platform: 'win32-x64',
    pins: { sources: { 'migratory-time': { expectedVersion: '2.0.0+codex.20260830163923' } } },
  })
  assert.equal(migratory.id, 'migratory-time')
  assert.equal(migratory.platform, 'win32-x64')

  // Regression: pre-fix builder looked for server/index.mjs.exe and failed closed.
  await assert.rejects(
    () => buildRequiredProfileTool({
      id: 'migratory-time',
      kind: 'migratory-time',
      sourceRoot: join(root, 'sources', 'missing-mjs-exe'),
      pluginRelative: 'plugins/migratory-time',
      identityFiles: ['plugins/migratory-time/.codex-plugin/plugin.json'],
      entrypoint: 'plugins/migratory-time/server/index.mjs',
      title: 'Migratory Time',
      workRoot: join(root, 'work-missing'),
      artifactRoot: join(root, 'artifacts-missing'),
      platform: 'win32-x64',
    }),
    /migratory-time is required|SOURCE_ROOT|ARTIFACT/u,
  )
})


test('R3 / F4 installProductionDependencies strips node_modules bin links', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-r3-links-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'package.json'), `${JSON.stringify({
    name: 'link-probe',
    version: '1.0.0',
    private: true,
    dependencies: { which: '4.0.0' },
  }, null, 2)}\n`)
  const execFileAsync = promisify(execFile)
  const npmCli = process.env.npm_execpath
  if (typeof npmCli === 'string' && npmCli.length > 0) {
    await execFileAsync(process.execPath, [npmCli, 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: root,
      env: { ...process.env, npm_config_update_notifier: 'false' },
    })
  } else {
    await execFileAsync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: root,
      env: { ...process.env, npm_config_update_notifier: 'false' },
    })
  }
  assert.equal(await stat(join(root, 'package-lock.json')).then(() => true, () => false), true)
  await installProductionDependencies(root)
  const bin = join(root, 'node_modules', '.bin')
  if (await stat(bin).then(() => true, () => false)) {
    const { readdir } = await import('node:fs/promises')
    for (const name of await readdir(bin)) {
      const info = await lstat(join(bin, name))
      assert.equal(info.isSymbolicLink(), false, `link remained: ${name}`)
    }
  }
  const modules = join(root, 'node_modules')
  await mkdir(join(modules, '.bin'), { recursive: true })
  const { symlink } = await import('node:fs/promises')
  const linkPath = join(modules, '.bin', 'synthetic-link')
  await writeFile(join(modules, 'which-target'), 'x\n')
  await symlink('../which-target', linkPath)
  await removeLinks(modules)
  await assert.rejects(() => lstat(linkPath), (error) => error.code === 'ENOENT')
})

test('R4 / F4 unsigned preview pins and workflow declare capability-contracts', async () => {
  const pins = await readSourcePins()
  assert.equal(typeof pins.sources['capability-contracts']?.revision, 'string')
  assert.match(pins.sources['capability-contracts'].revision, /^[0-9a-f]{40}$/u)
  const workflow = await readFile(new URL('../docs/unsigned-preview-release.yml', import.meta.url), 'utf8')
  assert.match(workflow, /capability-contracts/u)
  assert.match(workflow, /AGENT_HOST_CAPABILITY_CONTRACTS_SOURCE_ROOT/u)
  assert.match(workflow, /ef51ab875c7c6f99f6777bc066fe1929d5b136d0/u)
})
