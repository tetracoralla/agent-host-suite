import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
