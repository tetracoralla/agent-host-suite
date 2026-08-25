import { readFile } from 'node:fs/promises'
import { inspectCodex } from './hosts/codex.mjs'
import { inspectClaude } from './hosts/claude.mjs'
import { runFile } from './process.mjs'
import { inspectService } from './service.mjs'
import { semanticProbeOrder } from './runtime-config.mjs'

function check(id, status, message, detail = undefined) {
  return { id, status, message, ...(detail === undefined ? {} : { detail }) }
}

export async function doctor(state, { deep = false, runner = runFile } = {}) {
  const checks = []
  for (const [id, component] of Object.entries(state.components)) {
    try {
      for (const path of component.identityFiles) await readFile(path)
      checks.push(check(`component.${id}`, 'ok', `${id} ${component.version} files are readable`))
    } catch (error) {
      checks.push(check(`component.${id}`, 'error', `${id} installed files are unavailable`, error.message))
    }
  }
  if (state.hosts.codex !== undefined) {
    try {
      const current = await inspectCodex({ components: state.components }, runner)
      const missing = current.entries.filter((entry) => !entry.pluginPresent || !entry.pluginEnabled)
      checks.push(check('host.codex', missing.length === 0 ? 'ok' : 'error', missing.length === 0 ? 'Codex plugins are installed and enabled' : 'Codex plugins are missing or disabled', missing))
    } catch (error) {
      checks.push(check('host.codex', 'error', 'Codex host inspection failed', error.message))
    }
  }
  if (state.hosts.claude !== undefined) {
    try {
      await inspectClaude({ components: state.components }, runner, state.hosts.claude)
      checks.push(check('host.claude', 'ok', 'Claude Code MCP entries are present'))
    } catch (error) {
      checks.push(check('host.claude', 'error', 'Claude Code host inspection failed', error.message))
    }
  }
  const service = await inspectService(state.runtime.service, runner)
  checks.push(check('runtime.service', service.loaded ? 'ok' : 'error', service.loaded ? 'Direct Runtime service is loaded' : 'Direct Runtime service is not loaded', service))
  if (deep && service.loaded) {
    const runtime = state.components['direct-execution-runtime']
    const result = await runner(runtime.command, [
      ...runtime.args, 'run', '--socket', state.runtime.socketPath, '--work-order', '-',
    ], { input: `${JSON.stringify(semanticProbeOrder())}\n`, allowFailure: true, timeoutMs: 20_000 })
    let parsed = null
    try { parsed = JSON.parse(result.stdout) } catch {}
    const math = parsed?.calls?.find((item) => item.id === 'math')
    const time = parsed?.calls?.find((item) => item.id === 'time')
    const healthy = result.status === 0 && math?.status === 'ok' && math?.result?.exact === '42' && time?.status === 'ok' && time?.result?.results?.[0]?.localDateTime === '2026-08-24T21:00'
    checks.push(check('runtime.semantic-probe', healthy ? 'ok' : 'error', healthy ? 'Math and time-zone direct probes returned the expected typed results' : 'A direct semantic probe failed', parsed ?? result.stderr.trim()))
  }
  const errors = checks.filter((item) => item.status === 'error').length
  const warnings = checks.filter((item) => item.status === 'warning').length
  return { status: errors > 0 ? 'error' : warnings > 0 ? 'warning' : 'ok', checks }
}
