import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { githubAssetMatchesPlatform, officialNodeBinaryPath, buildWorkspacePackage } from '../scripts/build-unsigned-preview-catalog.mjs'

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
    return sourceRoot
  }

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
  const { access } = await import('node:fs/promises')
  await assert.rejects(() => access(fileURLToPath(new URL('../.github/workflows/unsigned-preview-release.yml', import.meta.url))))
})
