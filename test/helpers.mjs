import { chmod, mkdir, writeFile } from 'node:fs/promises'
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
  const runtime = join(root, 'direct-execution-runtime')
  const capability = join(root, 'capability-contracts')
  await json(join(math, 'plugins/math-anchor/.codex-plugin/plugin.json'), { name: 'math-anchor', version: '0.3.0' })
  await json(join(math, 'plugins/math-anchor/.mcp.json'), { mcpServers: {} })
  await write(join(math, 'plugins/math-anchor/runtime/math-anchor-runtime/math-anchor-runtime'), '#!/bin/sh\n', 0o700)
  await json(join(math, 'plugins/math-anchor/runtime/math-anchor-runtime/.math-anchor-build-manifest.json'), { version: '0.3.0' })
  await write(join(math, 'plugins/math-anchor/skills/calculate/SKILL.md'), '---\nname: calculate\n---\n')
  await write(join(math, 'pyproject.toml'), '[project]\nname = "math-anchor"\nversion = "0.3.0"\n')
  await json(join(math, '.agents/plugins/marketplace.json'), { name: 'math-anchor' })

  await json(join(time, 'plugins/migratory-time/.codex-plugin/plugin.json'), { name: 'migratory-time', version: '2.0.0' })
  await json(join(time, 'plugins/migratory-time/.mcp.json'), { mcpServers: {} })
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
  await json(join(runtime, 'schemas/provider-config.schema.json'), { type: 'object' })
  await json(join(capability, 'catalog/capabilities/time-zone-convert.v0.2.json'), { schemaVersion: 'openadam.capability-profile.v0.3' })
  return { root, math, time, runtime, capability }
}

export function createCodexRunner({ mathPresent = true, timePresent = false, legacyTimeRoot = null } = {}) {
  const calls = []
  const marketplaces = new Map()
  if (mathPresent) marketplaces.set('math-anchor', null)
  let plugins = new Map()
  if (mathPresent) plugins.set('math-anchor@math-anchor', { version: '0.3.0', enabled: true })
  if (timePresent) plugins.set('migratory-time@migratory-time', { version: '2.0.0', enabled: true })
  if (legacyTimeRoot !== null) plugins.set('migratory-time@personal', { version: '2.0.0+legacy', enabled: true, sourcePath: legacyTimeRoot })

  async function runner(command, args, options = {}) {
    calls.push({ command, args: [...args], options })
    if (command === '/usr/bin/env' && args[0] === 'which') return { status: 0, stdout: `/fake/${args[1]}\n`, stderr: '' }
    if (command === '/fake/codex' && args[0] === '--version') return { status: 0, stdout: 'codex-cli test\n', stderr: '' }
    if (command === '/fake/codex' && args.join(' ') === 'plugin marketplace list --json') {
      return {
        status: 0,
        stdout: JSON.stringify({ marketplaces: [...marketplaces].map(([name, source]) => ({ name, root: source, marketplaceSource: { sourceType: 'local', source } })) }),
        stderr: '',
      }
    }
    if (command === '/fake/codex' && args.join(' ') === 'plugin list --json') {
      return {
        status: 0,
        stdout: JSON.stringify({ installed: [...plugins].map(([pluginId, value]) => {
          const [name, marketplaceName] = pluginId.split('@')
          return { pluginId, name, marketplaceName, installed: true, enabled: value.enabled, version: value.version, source: value.sourcePath === undefined ? undefined : { source: 'local', path: value.sourcePath } }
        }) }),
        stderr: '',
      }
    }
    if (command === '/fake/codex' && args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {
      const source = args[3]
      const name = source.endsWith('calculator') ? 'math-anchor' : 'migratory-time'
      marketplaces.set(name, source)
      return { status: 0, stdout: '{}', stderr: '' }
    }
    if (command === '/fake/codex' && args[0] === 'plugin' && args[1] === 'add') {
      const selector = args[2]
      plugins.set(selector, { version: selector.startsWith('math') ? '0.3.0' : '2.0.0', enabled: true })
      return { status: 0, stdout: '{}', stderr: '' }
    }
    if (command === '/fake/codex' && args[0] === 'plugin' && args[1] === 'remove') {
      plugins.delete(args[2])
      return { status: 0, stdout: '{}', stderr: '' }
    }
    if (command === '/fake/codex' && args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'remove') {
      marketplaces.delete(args[3])
      return { status: 0, stdout: '{}', stderr: '' }
    }
    throw new Error(`unexpected fake command: ${command} ${args.join(' ')}`)
  }
  return { runner, calls, marketplaces, get plugins() { return plugins } }
}
