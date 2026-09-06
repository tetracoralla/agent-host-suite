import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { after } from 'node:test'
import { createHash } from 'node:crypto'
import { AgentHostError } from '../src/errors.mjs'
import { join } from 'node:path'

async function write(path, contents, mode = 0o600) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, contents, { mode })
  await chmod(path, mode)
}

async function json(path, value) {
  await write(path, `${JSON.stringify(value, null, 2)}\n`)
}

export async function createDevelopmentWorkspace(root) {
  const math = join(root, 'calculator')
  const time = join(root, 'migratory-time')
  const runtime = join(root, 'agent-host-suite', 'packages', 'direct-execution-runtime')
  const capability = join(root, 'capability-contracts')
  await json(join(math, 'plugins/math-anchor/.codex-plugin/plugin.json'), { name: 'math-anchor', version: '0.3.0' })
  await json(join(math, 'plugins/math-anchor/.mcp.json'), {
    mcpServers: { 'math-anchor': { command: './runtime/math-anchor-runtime/math-anchor-runtime', args: ['mcp'], cwd: '.' } },
  })
  await write(join(math, 'plugins/math-anchor/runtime/math-anchor-runtime/math-anchor-runtime'), '#!/bin/sh\n', 0o700)
  await json(join(math, 'plugins/math-anchor/runtime/math-anchor-runtime/.math-anchor-build-manifest.json'), { version: '0.3.0' })
  await write(join(math, 'plugins/math-anchor/skills/calculate/SKILL.md'), '---\nname: calculate\n---\n')
  await write(join(math, 'pyproject.toml'), '[project]\nname = "math-anchor"\nversion = "0.3.0"\n')
  await json(join(math, '.agents/plugins/marketplace.json'), { name: 'math-anchor' })

  await json(join(time, 'plugins/migratory-time/.codex-plugin/plugin.json'), { name: 'migratory-time', version: '2.0.0' })
  await json(join(time, 'plugins/migratory-time/.mcp.json'), {
    mcpServers: { 'migratory-time': { command: './server/index.mjs', args: [], cwd: '.' } },
  })
  await write(join(time, 'plugins/migratory-time/server/index.mjs'), 'process.stdin.resume()\n')
  await write(join(time, 'plugins/migratory-time/skills/convert-time-zones/SKILL.md'), '---\nname: convert-time-zones\n---\n')
  await json(join(time, 'capabilities/provider.json'), { schemaVersion: 'openadam.provider-manifest.v0.3' })
  await write(join(time, 'scripts/runCapabilityAdapter.mjs'), 'process.stdin.resume()\n')
  await json(join(time, 'capabilities/schemas/time-zone.convert.input.schema.json'), { type: 'object' })
  await json(join(time, 'capabilities/schemas/time-zone.convert.output.schema.json'), { type: 'object' })
  await json(join(time, '.agents/plugins/marketplace.json'), { name: 'migratory-time' })

  await json(join(runtime, 'package.json'), { name: '@openadam/direct-execution-runtime', version: '0.1.0' })
  await json(join(runtime, 'package-lock.json'), { lockfileVersion: 3 })
  await write(join(runtime, 'src/cli.mjs'), '')
  await write(join(runtime, 'src/runtime.mjs'), '')
  await write(join(runtime, 'src/host-service.mjs'), '')
  await write(join(runtime, 'src/host-client.mjs'), '')
  await write(join(runtime, 'src/host-protocol.mjs'), '')
  await write(join(runtime, 'src/operation-projection.mjs'), '')
  await write(join(runtime, 'src/sessions/mcp-session.mjs'), '')
  await write(join(runtime, 'src/schema.mjs'), '')
  await json(join(runtime, 'schemas/provider-config.schema.json'), { type: 'object' })
  await json(join(runtime, 'schemas/provider-config.schema.v0.2.json'), { type: 'object' })
  await json(join(runtime, 'schemas/host-service-observation.schema.json'), { type: 'object' })
  await json(join(runtime, 'schemas/host-service-observation.schema.v0.1.json'), { type: 'object' })
  await json(join(runtime, 'schemas/work-order.schema.json'), { type: 'object' })
  await json(join(runtime, 'schemas/contract-selection.schema.json'), { type: 'object' })
  await json(join(runtime, 'schemas/host-request.schema.json'), { type: 'object' })
  await json(join(capability, 'catalog/capabilities/time-zone-convert.v0.2.json'), { schemaVersion: 'openadam.capability-profile.v0.3' })
  return { root, math, time, runtime, capability }
}

export async function createDevelopmentObservabilityWorkspace(root) {
  const observer = join(root, 'agent-host-suite', 'packages', 'agent-tool-observer')
  const analyzer = join(root, 'agent-host-suite', 'packages', 'context-surface-analyzer')
  await json(join(observer, 'package.json'), { name: '@openadam/agent-tool-observer', version: '0.3.0' })
  await json(join(observer, 'package-lock.json'), { lockfileVersion: 3 })
  await write(join(observer, 'src/cli.mjs'), '')
  await write(join(observer, 'src/report.mjs'), '')
  await json(join(analyzer, 'package.json'), { name: '@openadam/context-surface-analyzer', version: '0.1.2' })
  await json(join(analyzer, 'package-lock.json'), { lockfileVersion: 3 })
  await write(join(analyzer, 'src/cli.js'), '')
  await write(join(analyzer, 'src/core.js'), '')
  return { observer, analyzer }
}

export async function healthyCatalogPreflight(components) {
  return {
    status: 'within',
    canonicalUtf8Bytes: Object.keys(components).length * 100,
    largestToolUtf8Bytes: Object.keys(components).length === 0 ? 0 : 100,
    toolCount: Object.keys(components).length,
    budgets: { maxCatalogUtf8Bytes: 65_536, maxToolCount: 64, maxLargestToolUtf8Bytes: 40_000, maxResultUtf8Bytes: 65_536 },
    exceeded: [],
  }
}

export async function compatibleApplicationState() {
  return { status: 'compatible', checked: true, carrier: 'test-application' }
}

// A public-config fixture: registrations, source trees and cached bytes have
// distinct lifetimes. The JSON file is a test transport, not a TOML parser.
export function createCodexRunner({ mathPresent = true, timePresent = false, legacyTimeRoot = null, mathVersion = '0.3.0', mathMarketplace = 'math-anchor', mathMarketplaceRoot = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agent-host-codex-fixture-'))
  after(() => rm(root, { recursive: true, force: true }))
  const filePath = join(root, 'config.toml')
  const calls = []
  const marketplaces = new Map()
  const plugins = new Map()
  const caches = new Map()
  let config = { plugins: {}, marketplaces: {} }
  if (mathPresent) marketplaces.set(mathMarketplace, mathMarketplaceRoot)
  if (mathPresent) plugins.set(`math-anchor@${mathMarketplace}`, { version: mathVersion, enabled: true, installed: true })
  if (timePresent) plugins.set('migratory-time@migratory-time', { version: '2.0.0', enabled: true, installed: true })
  if (legacyTimeRoot !== null) plugins.set('migratory-time@personal', { version: '2.0.0+legacy', enabled: true, installed: true, sourcePath: legacyTimeRoot })
  const version = () => 'sha256:' + createHash('sha256').update(JSON.stringify(config)).digest('hex')
  const clone = (value) => structuredClone(value)
  async function snapshot() {
    // Existing test callers may seed another user registration before a read.
    for (const [name, source] of marketplaces) config.marketplaces[name] ??= { source_type: 'local', source }
    for (const [selector, value] of plugins) config.plugins[selector] ??= { enabled: value.enabled }
    await writeFile(filePath, JSON.stringify(config), { mode: 0o600 })
    return { filePath, config: clone(config), version: version() }
  }
  function reflect() {
    for (const selector of plugins.keys()) if (!Object.hasOwn(config.plugins, selector)) plugins.delete(selector)
    for (const [selector, binding] of Object.entries(config.plugins)) {
      plugins.set(selector, { ...(plugins.get(selector) ?? caches.get(selector) ?? { installed: false }), enabled: binding.enabled !== false })
    }
    marketplaces.clear()
    for (const [name, binding] of Object.entries(config.marketplaces)) marketplaces.set(name, binding.source)
  }
  const client = {
    read: snapshot,
    async write(previous, changes) {
      if (previous.version !== version()) throw new AgentHostError('CODEX_CONFIG_CHANGED', 'Fixture version changed')
      for (const { keys, value } of changes) {
        let target = config
        for (const key of keys.slice(0, -1)) {
          if (!Object.hasOwn(target, key)) Object.defineProperty(target, key, { value: {}, writable: true, configurable: true, enumerable: true })
          target = target[key]
        }
        if (value === null) delete target[keys.at(-1)]
        else Object.defineProperty(target, keys.at(-1), { value: clone(value), writable: true, configurable: true, enumerable: true })
      }
      reflect()
      return snapshot()
    },
  }
  const configuration = async (_executable, _options, callback) => callback(client)
  async function runner(command, args, options = {}) {
    calls.push({ command, args: [...args], options })
    if (command === 'where.exe' || (command === '/usr/bin/env' && args[0] === 'which')) return { status: 0, stdout: `/fake/${args.at(-1)}\n`, stderr: '' }
    if (command === '/fake/codex' && args[0] === '--version') return { status: 0, stdout: 'codex-cli test\n', stderr: '' }
    if (command === '/fake/codex' && args.join(' ') === 'plugin list --json') {
      await snapshot()
      return { status: 0, stdout: JSON.stringify({ installed: [...plugins].map(([pluginId, value]) => {
        const [name, marketplaceName] = pluginId.split('@')
        const marketplaceRoot = marketplaces.get(marketplaceName)
        const sourcePath = value.sourcePath ?? (typeof marketplaceRoot === 'string' ? join(marketplaceRoot, 'plugins', name) : undefined)
        return { pluginId, name, marketplaceName, installed: value.installed !== false, enabled: value.enabled, version: value.version,
          source: sourcePath === undefined ? undefined : { source: 'local', path: sourcePath } }
      }) }), stderr: '' }
    }
    if (command === '/fake/codex' && args[0] === 'plugin' && args[1] === 'add') {
      const selector = args[2]
      const [name, marketplaceName] = selector.split('@')
      const marketplaceRoot = marketplaces.get(marketplaceName)
      const sourcePath = join(marketplaceRoot, 'plugins', name)
      const manifest = JSON.parse(await readFile(join(sourcePath, '.codex-plugin', 'plugin.json'), 'utf8'))
      const installedPath = join(root, 'cache', selector)
      await mkdir(join(root, 'cache'), { recursive: true })
      await cp(sourcePath, installedPath, { recursive: true, errorOnExist: true, force: false })
      const record = { version: manifest.version, enabled: true, installed: true, sourcePath, installedPath }
      caches.set(selector, record)
      plugins.set(selector, record)
      config.plugins[selector] = { ...config.plugins[selector], enabled: true }
      await snapshot()
      return { status: 0, stdout: JSON.stringify({ installedPath, pluginId: selector }), stderr: '' }
    }
    throw new Error(`unexpected fake command: ${command} ${args.join(' ')}`)
  }
  return { runner, configuration, client, calls, marketplaces, plugins, caches, root,
    enabledPlugins(name) { return [...plugins].filter(([selector, value]) => selector.split('@')[0] === name && value.installed !== false && value.enabled).map(([selector, value]) => ({ selector, ...value })) },
  }
}

export function createClaudeRunner() {
  const calls = []
  const entries = new Map()
  const prefix = ['--disable-slash-commands', '--no-chrome', '--setting-sources', 'user']
  async function runner(command, args) {
    calls.push({ command, args: [...args] })
    if (command === 'where.exe' || (command === '/usr/bin/env' && args[0] === 'which')) return { status: 0, stdout: '/fake/claude\n', stderr: '' }
    if (command !== '/fake/claude' || JSON.stringify(args.slice(0, prefix.length)) !== JSON.stringify(prefix)) {
      throw new Error(`unexpected fake command: ${command} ${args.join(' ')}`)
    }
    const current = args.slice(prefix.length)
    if (current[0] === '--version') return { status: 0, stdout: 'claude test\n', stderr: '' }
    if (current[0] === 'mcp' && current[1] === 'get') {
      const entry = entries.get(current[2])
      if (entry === undefined) return { status: 1, stdout: `No MCP server named "${current[2]}".\n`, stderr: '' }
      return { status: 0, stdout: `Command: ${entry.command}\nArgs: ${entry.args.join(' ')}\n`, stderr: '' }
    }
    if (current[0] === 'mcp' && current[1] === 'add') {
      const name = current[4]
      const separator = current.indexOf('--')
      entries.set(name, { command: current[separator + 1], args: current.slice(separator + 2) })
      return { status: 0, stdout: '', stderr: '' }
    }
    if (current[0] === 'mcp' && current[1] === 'remove') {
      entries.delete(current[4])
      return { status: 0, stdout: '', stderr: '' }
    }
    throw new Error(`unexpected fake Claude command: ${current.join(' ')}`)
  }
  return { runner, calls, entries }
}
