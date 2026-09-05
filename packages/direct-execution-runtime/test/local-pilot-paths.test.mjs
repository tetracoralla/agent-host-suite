import assert from 'node:assert/strict'
import test from 'node:test'
import { chmod, cp, lstat, mkdtemp, mkdir, open, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, resolve } from 'node:path'
import { resolveProviderExecutable } from '../src/config.mjs'
import { digestFile } from '../src/json.mjs'
import { fakeRoot } from './helpers.mjs'
import {
  inspectProviderArtifactBytes,
  resolveMathAnchorRoot,
  resolveProviderArtifacts,
  resolvePilotWorkspace,
  resolveRequiredExecutables,
} from '../scripts/local-pilot-paths.mjs'
import { copyVerifiedProviderArtifact } from '../scripts/structured-data-procedure-pilot.mjs'

async function componentFiles(root, current = root, output = []) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = resolve(current, entry.name)
    const relativePath = path.slice(root.length + 1)
    if (relativePath === 'component.json') continue
    const info = await lstat(path)
    if (info.isDirectory()) await componentFiles(root, path, output)
    else if (info.isFile()) output.push({
      path: relativePath,
      sha256: await digestFile(path),
      bytes: info.size,
      executable: (info.mode & 0o111) !== 0,
    })
  }
  return output
}

async function writeMismatchedComponentDescriptor(root) {
  for (const [name, contents] of [
    ['LICENSE', 'fixture license\n'],
    ['NOTICE', 'fixture notice\n'],
    ['THIRD_PARTY_NOTICES.txt', 'fixture notices\n'],
    ['sbom.spdx.json', '{}\n'],
  ]) await writeFile(resolve(root, name), contents)
  const files = await componentFiles(root)
  await writeFile(resolve(root, 'component.json'), JSON.stringify({
    schemaVersion: 'openadam.agent-host-component.v0.1',
    id: 'node-runtime',
    version: '0.1.0',
    kind: 'node-runtime',
    files,
    identityFiles: ['adapter.mjs'],
    entrypoints: {},
    integration: null,
    legal: {
      license: 'LICENSE',
      notice: 'NOTICE',
      thirdPartyNotices: 'THIRD_PARTY_NOTICES.txt',
      sbom: 'sbom.spdx.json',
    },
  }))
}

async function writeHostComponentDescriptor(componentRoot, pluginRoot, directCapability) {
  for (const [name, contents] of [
    ['LICENSE', 'fixture license\n'],
    ['NOTICE', 'fixture notice\n'],
    ['THIRD_PARTY_NOTICES.txt', 'fixture notices\n'],
    ['sbom.spdx.json', '{}\n'],
  ]) await writeFile(resolve(componentRoot, name), contents)
  await mkdir(resolve(componentRoot, 'marketplace/.agents/plugins'), { recursive: true })
  await writeFile(
    resolve(componentRoot, 'marketplace/.agents/plugins/marketplace.json'),
    JSON.stringify({ name: 'provider-tool-local' }),
  )
  await writeFile(
    resolve(pluginRoot, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        'provider-tool': { command: './runtime/provider-tool', args: [], cwd: '.' },
      },
    }),
  )
  const files = await componentFiles(componentRoot)
  await writeFile(resolve(componentRoot, 'component.json'), JSON.stringify({
    schemaVersion: 'openadam.agent-host-component.v0.1',
    id: 'provider-tool',
    version: '0.1.0',
    kind: 'agent-tool',
    files,
    identityFiles: files.map((file) => file.path),
    entrypoints: {
      mcp: 'marketplace/plugins/provider-tool/runtime/provider-tool',
      capability: 'marketplace/plugins/provider-tool/runtime/provider-tool',
      capabilityManifest: 'marketplace/plugins/provider-tool/capabilities/provider.json',
      capabilityProfile: 'capability-contracts/capability-profile.json',
    },
    integration: {
      schemaVersion: 'openadam.agent-host-tool-integration.v0.4',
      displayName: 'Provider Tool',
      summary: 'Exercise one deterministic fixture capability.',
      codex: {
        marketplaceRoot: 'marketplace',
        marketplace: 'provider-tool-local',
        pluginRoot: 'marketplace/plugins/provider-tool',
        plugin: 'provider-tool',
        identityFiles: ['.codex-plugin/plugin.json', '.mcp.json'],
      },
      runtime: {
        transport: 'mcp-stdio',
        executor: 'component',
        command: 'marketplace/plugins/provider-tool/runtime/provider-tool',
        args: [],
        cwd: 'marketplace/plugins/provider-tool',
        workspaceEnvironment: [],
        expectedTools: ['provider_tool.echo'],
        timeoutMs: 5000,
      },
      directCapability,
      ownership: { uninstall: 'agent-host-created-only' },
    },
    legal: {
      license: 'LICENSE',
      notice: 'NOTICE',
      thirdPartyNotices: 'THIRD_PARTY_NOTICES.txt',
      sbom: 'sbom.spdx.json',
    },
  }))
}

test('local pilot uses an explicit absolute Math Anchor checkout or the legacy sibling', () => {
  const workspace = resolve('/tmp', 'openadam-workspace')
  assert.equal(resolveMathAnchorRoot(workspace, {}), resolve(workspace, 'calculator'))
  assert.equal(
    resolveMathAnchorRoot(workspace, { OPENADAM_MATH_ANCHOR_ROOT: resolve('/tmp/moved-math-anchor') }),
    resolve('/tmp/moved-math-anchor'),
  )
  assert.throws(
    () => resolveMathAnchorRoot(workspace, { OPENADAM_MATH_ANCHOR_ROOT: 'relative/path' }),
    /must be an absolute path/,
  )
})

test('local pilot workspace accepts only an explicit absolute override', () => {
  const runtimeRoot = resolve('/tmp', 'agent-host-suite/packages/direct-execution-runtime')
  assert.equal(
    resolvePilotWorkspace(runtimeRoot, {}),
    resolve('/tmp'),
  )
  assert.equal(
    resolvePilotWorkspace(runtimeRoot, { OPENADAM_DIRECT_PILOT_WORKSPACE_ROOT: resolve('/tmp/tools-dev') }),
    resolve('/tmp/tools-dev'),
  )
  assert.throws(
    () => resolvePilotWorkspace(runtimeRoot, { OPENADAM_DIRECT_PILOT_WORKSPACE_ROOT: 'relative/path' }),
    /must be an absolute path/,
  )
})

test('provider executable resolution rejects a relative safe PATH', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'openadam-relative-path-'))
  const previousPath = process.env.PATH
  try {
    await mkdir(resolve(root, 'bin'))
    const executable = resolve(root, 'bin/provider-tool')
    await writeFile(executable, '#!/bin/sh\nexit 0\n')
    await chmod(executable, 0o700)
    process.env.PATH = 'bin'
    await assert.rejects(
      () => resolveProviderExecutable('provider-tool', root),
      (error) => error.code === 'HOST_CONFIG_INVALID' && /absolute directories/.test(error.message),
    )

    process.env.PATH = resolve(root, 'bin')
    assert.equal(await resolveProviderExecutable('provider-tool', root), await realpath(executable))
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    await rm(root, { recursive: true, force: true })
  }
})

test('provider executable resolution validates every safe PATH entry before selecting', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'openadam-complete-path-'))
  const previousPath = process.env.PATH
  try {
    const bin = resolve(root, 'bin')
    await mkdir(bin)
    const executable = resolve(bin, 'provider-tool')
    await writeFile(executable, '#!/bin/sh\nexit 0\n')
    await chmod(executable, 0o700)
    for (const unsafePath of [`${bin}${delimiter}relative`, `${bin}${delimiter}`]) {
      process.env.PATH = unsafePath
      await assert.rejects(
        () => resolveProviderExecutable('provider-tool', root),
        (error) => error.code === 'HOST_CONFIG_INVALID' && /absolute directories/.test(error.message),
      )
    }
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    await rm(root, { recursive: true, force: true })
  }
})

test('provider executable resolution rejects an executable directory', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'openadam-directory-command-'))
  const previousPath = process.env.PATH
  try {
    const search = resolve(root, 'search')
    await mkdir(resolve(search, 'provider-tool'), { recursive: true })
    process.env.PATH = search
    await assert.rejects(
      () => resolveProviderExecutable('provider-tool', root),
      (error) => error.code === 'HOST_PROVIDER_UNAVAILABLE',
    )
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    await rm(root, { recursive: true, force: true })
  }
})

test('optional Procedure prerequisite inventory reports every missing executable', async () => {
  const available = new Map([
    ['uv', '/opt/tools/uv'],
    ['adt-capability', '/opt/tools/adt-capability'],
  ])
  const result = await resolveRequiredExecutables(
    ['uv', 'file-vitals-capability', 'adt-capability'],
    '/tmp/provider',
    async (command) => {
      if (available.has(command)) return available.get(command)
      const error = new Error('unavailable')
      error.code = 'HOST_PROVIDER_UNAVAILABLE'
      throw error
    },
  )
  assert.deepEqual(result, {
    executables: {
      uv: '/opt/tools/uv',
      'adt-capability': '/opt/tools/adt-capability',
    },
    missing: ['file-vitals-capability'],
  })
})

test('optional Procedure artifact validation requires the exact full semantic identity and runtime path', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'openadam-provider-artifact-'))
  try {
    await cp(fakeRoot, root, { recursive: true })
    const runtime = resolve(root, 'runtime')
    await mkdir(runtime)
    await mkdir(resolve(root, 'capabilities'))
    await mkdir(resolve(root, '.codex-plugin'))
    const executable = resolve(runtime, 'provider-tool')
    const helper = resolve(runtime, 'provider-helper')
    await cp(resolve(root, 'adapter.mjs'), executable)
    await cp(resolve(root, 'adapter.mjs'), helper)
    await chmod(executable, 0o700)
    await chmod(helper, 0o700)
    await writeFile(
      resolve(root, '.codex-plugin/plugin.json'),
      JSON.stringify({ name: 'provider-tool', version: '0.1.0' }),
    )
    const manifestPath = resolve(root, 'provider.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.implementations[0].adapter = {
      protocol: 'openadam.capability-jsonl.v0.1',
      command: './runtime/provider-tool',
      args: [],
      cwd: '.',
    }
    await writeFile(
      resolve(root, 'capabilities/provider.json'),
      JSON.stringify(manifest),
    )
    const requirement = {
      command: 'provider-tool',
      componentId: 'provider-tool',
      executableRelativePath: 'runtime/provider-tool',
      adapterArgs: [],
      adapterCwdRelativePath: '.',
      pluginName: 'provider-tool',
      providerId: 'test.fake-capability',
      providerVersion: '0.1.0',
      capabilityId: 'org.openadam.test.echo',
      capabilityVersion: '0.1.0',
      hostIntegration: {
        identityRelativePaths: ['runtime/provider-tool', 'runtime/provider-helper'],
      },
      profilePath: resolve(root, 'capability-profile.json'),
      contracts: [{
        operationId: 'echo',
        inputSchemaRelativePath: 'echo.input.schema.json',
        outputSchemaRelativePath: 'echo.output.schema.json',
      }],
      operationBindings: [
        { operationId: 'echo', target: 'adapter.mjs#echo' },
      ],
    }

    const artifacts = await resolveProviderArtifacts(
      [requirement],
      root,
      async () => executable,
    )
    assert.equal(artifacts['provider-tool'].root, await realpath(root))
    assert.equal(artifacts['provider-tool'].providerVersion, '0.1.0')
    assert.equal(artifacts['provider-tool'].provenance.kind, 'provider-release-artifact')
    assert.match(artifacts['provider-tool'].contractDigest, /^sha256:[a-f0-9]{64}$/u)
    assert.deepEqual(
      artifacts['provider-tool'].identityFiles
        .map((identity) => identity.path)
        .filter((path) => path.startsWith('runtime/')),
      ['runtime/provider-helper', 'runtime/provider-tool'],
    )
    assert.deepEqual(
      artifacts['provider-tool'].copyIdentity,
      await inspectProviderArtifactBytes(root),
    )

    const copiedRoot = `${root}-copied-after-admission`
    await writeFile(executable, '#!/bin/sh\nexit 9\n')
    await assert.rejects(
      () => copyVerifiedProviderArtifact(artifacts['provider-tool'], copiedRoot),
      /copied Provider bytes differ from the admitted artifact/u,
    )
    await rm(copiedRoot, { recursive: true, force: true })
    await cp(resolve(root, 'adapter.mjs'), executable)
    await chmod(executable, 0o700)

    await assert.rejects(
      () => resolveProviderArtifacts(
        [{ ...requirement, providerVersion: '0.2.0' }],
        root,
        async () => executable,
      ),
      /provider identity differs/,
    )

    const invalidArgs = structuredClone(manifest)
    invalidArgs.implementations[0].adapter.args = ['--unexpected']
    await writeFile(resolve(root, 'capabilities/provider.json'), JSON.stringify(invalidArgs))
    await assert.rejects(
      () => resolveProviderArtifacts([requirement], root, async () => executable),
      /release launcher differs/,
    )
    await writeFile(resolve(root, 'capabilities/provider.json'), JSON.stringify(manifest))

    await symlink('/tmp/outside-provider-artifact', resolve(root, 'linked-entry'))
    await assert.rejects(
      () => resolveProviderArtifacts([requirement], root, async () => executable),
      /symbolic link/,
    )
    await rm(resolve(root, 'linked-entry'))

    const oversizedPath = resolve(root, 'oversized-entry')
    const oversized = await open(oversizedPath, 'w')
    await oversized.truncate(1024 * 1024 * 1024 + 1)
    await oversized.close()
    await assert.rejects(
      () => resolveProviderArtifacts([requirement], root, async () => executable),
      /bounded file inventory/,
    )
    await rm(oversizedPath)

    await writeMismatchedComponentDescriptor(root)
    await assert.rejects(
      () => resolveProviderArtifacts([requirement], root, async () => executable),
      /component identity differs/,
    )
    await rm(resolve(root, 'component.json'))

    const invalidManifest = structuredClone(manifest)
    invalidManifest.unexpected = true
    await writeFile(resolve(root, 'capabilities/provider.json'), JSON.stringify(invalidManifest))
    await assert.rejects(
      () => resolveProviderArtifacts([requirement], root, async () => executable),
      (error) => error.code === 'HOST_BINDING_INVALID' && /Provider Manifest/.test(error.message),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('optional Procedure adapter admission rejects a project virtualenv launcher', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'openadam-provider-source-'))
  try {
    const launcher = resolve(root, '.venv/bin/file-vitals-capability')
    await mkdir(resolve(root, '.venv/bin'), { recursive: true })
    await mkdir(resolve(root, 'capabilities'))
    await mkdir(resolve(root, '.codex-plugin'))
    await writeFile(launcher, '#!/bin/sh\nexit 0\n')
    await chmod(launcher, 0o700)
    await writeFile(
      resolve(root, '.codex-plugin/plugin.json'),
      JSON.stringify({ version: '0.3.3' }),
    )
    await writeFile(
      resolve(root, 'capabilities/provider.json'),
      JSON.stringify({
        provider: { id: 'io.github.tetracoralla.file-vitals', version: '0.3.3' },
        implementations: [],
      }),
    )
    await assert.rejects(
      () => resolveProviderArtifacts([{
        command: 'file-vitals-capability',
        componentId: 'file-vitals',
        executableRelativePath: 'runtime/file-vitals-capability',
        adapterArgs: [],
        adapterCwdRelativePath: '.',
        pluginName: 'file-vitals',
        providerId: 'io.github.tetracoralla.file-vitals',
        providerVersion: '0.3.3',
        capabilityId: 'org.openadam.file.inspect',
        capabilityVersion: '0.1.0',
        profilePath: resolve(root, 'capability-profile.json'),
        contracts: [],
        operationBindings: [],
      }], root, async () => launcher),
      /not the declared packaged runtime executable/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('optional Procedure admission rejects a valid Host component whose Direct metadata names another binding', async () => {
  const componentRoot = await mkdtemp(resolve(tmpdir(), 'openadam-host-provider-component-'))
  try {
    const pluginRoot = resolve(componentRoot, 'marketplace/plugins/provider-tool')
    await mkdir(pluginRoot, { recursive: true })
    await cp(fakeRoot, pluginRoot, { recursive: true })
    await mkdir(resolve(pluginRoot, 'runtime'))
    await mkdir(resolve(pluginRoot, 'capabilities'))
    await mkdir(resolve(pluginRoot, '.codex-plugin'))
    await mkdir(resolve(componentRoot, 'capability-contracts'), { recursive: true })
    const executable = resolve(pluginRoot, 'runtime/provider-tool')
    await cp(resolve(pluginRoot, 'adapter.mjs'), executable)
    await chmod(executable, 0o700)
    await writeFile(
      resolve(pluginRoot, '.codex-plugin/plugin.json'),
      JSON.stringify({ name: 'provider-tool', version: '0.1.0' }),
    )
    const manifest = JSON.parse(await readFile(resolve(pluginRoot, 'provider.json'), 'utf8'))
    manifest.implementations[0].adapter = {
      protocol: 'openadam.capability-jsonl.v0.1',
      command: './runtime/provider-tool',
      args: [],
      cwd: '.',
    }
    await writeFile(resolve(pluginRoot, 'capabilities/provider.json'), JSON.stringify(manifest))
    await cp(
      resolve(pluginRoot, 'capability-profile.json'),
      resolve(componentRoot, 'capability-contracts/capability-profile.json'),
    )
    await writeHostComponentDescriptor(componentRoot, pluginRoot, {
      providerId: 'test.different-provider',
      transport: 'capability-jsonl-v0.1',
      lifecycle: 'persistent',
      workspaceRoot: 'host-required',
      capabilityId: 'org.openadam.test.echo',
      capabilityVersion: '0.1.0',
      adapter: {
        command: 'marketplace/plugins/provider-tool/runtime/provider-tool',
        args: [],
        cwd: 'marketplace/plugins/provider-tool',
      },
      manifest: 'marketplace/plugins/provider-tool/capabilities/provider.json',
      profile: 'capability-contracts/capability-profile.json',
      identityFiles: ['marketplace/plugins/provider-tool/runtime/provider-tool'],
      contracts: [{
        operationId: 'echo',
        inputSchema: 'marketplace/plugins/provider-tool/echo.input.schema.json',
        outputSchema: 'marketplace/plugins/provider-tool/echo.output.schema.json',
      }],
    })
    await assert.rejects(
      () => resolveProviderArtifacts([{
        command: 'provider-tool',
        componentId: 'provider-tool',
        executableRelativePath: 'runtime/provider-tool',
        adapterArgs: [],
        adapterCwdRelativePath: '.',
        pluginName: 'provider-tool',
        providerId: 'test.fake-capability',
        providerVersion: '0.1.0',
        capabilityId: 'org.openadam.test.echo',
        capabilityVersion: '0.1.0',
        hostIntegration: {
          lifecycle: 'persistent',
          workspaceRoot: 'host-required',
          profileRelativePath: 'capability-contracts/capability-profile.json',
          identityRelativePaths: ['runtime/provider-tool'],
        },
        profilePath: resolve(pluginRoot, 'capability-profile.json'),
        contracts: [{
          operationId: 'echo',
          inputSchemaRelativePath: 'echo.input.schema.json',
          outputSchemaRelativePath: 'echo.output.schema.json',
        }],
        operationBindings: [{ operationId: 'echo', target: 'adapter.mjs#echo' }],
      }], pluginRoot, async () => executable),
      /Direct Capability integration differs from the expected Provider binding/u,
    )
  } finally {
    await rm(componentRoot, { recursive: true, force: true })
  }
})


test('native Node executable resolves through the complete safe PATH', async () => {
  const executable = await resolveProviderExecutable('node')
  assert.equal(await realpath(executable), await realpath(process.execPath))
})
