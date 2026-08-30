import { readFile } from 'node:fs/promises'
import { inspectCodex } from './hosts/codex.mjs'
import { inspectClaude } from './hosts/claude.mjs'
import { runFile } from './process.mjs'
import { inspectService } from './service.mjs'
import { mathProjectionSelection, semanticProbeOrder } from './runtime-config.mjs'
import { verifyReleaseComponent } from './release-artifacts.mjs'
import { probeMcpTools } from './mcp-health.mjs'
import { agentFacingManifest } from './profile.mjs'
import { inspectOperationsSkill } from './host-operations-skill.mjs'

function check(id, status, message, detail = undefined) {
  return { id, status, message, ...(detail === undefined ? {} : { detail }) }
}

export async function doctor(state, { deep = false, inspectAgentApps = true, runner = runFile, mcpProbe = probeMcpTools, contextAnalysis = null } = {}) {
  const checks = []
  const agentManifest = agentFacingManifest({ components: state.components }, state.agentComponents ?? Object.keys(state.components))
  for (const [id, component] of Object.entries(state.components)) {
    try {
      if (state.channel === 'release') await verifyReleaseComponent(component)
      else for (const path of component.identityFiles) await readFile(path)
      checks.push(check(`component.${id}`, 'ok', `${id} ${component.version} installed bytes match`))
    } catch (error) {
      checks.push(check(`component.${id}`, 'error', `${id} installed files are unavailable`, error.message))
    }
  }
  if (inspectAgentApps && state.hosts.codex !== undefined) {
    try {
      const current = await inspectCodex(agentManifest, runner, { managedState: state.hosts.codex, useManagedBindings: true })
      const missing = current.entries.filter((entry) => !entry.pluginPresent || !entry.pluginEnabled || entry.installedVersion !== entry.requestedVersion || !entry.installedIdentityMatched)
      const operationsSkill = await inspectOperationsSkill(state.hosts.codex.operationsSkill, runner)
      const ready = missing.length === 0 && operationsSkill.status === 'ok'
      checks.push(check('host.codex', ready ? 'ok' : 'error', ready ? 'Codex plugins and Agent Host operations Skill are installed' : 'One or more Codex integrations need attention', {
        plugins: missing,
        operationsSkill,
      }))
      for (const entry of current.entries) {
        const healthy = entry.pluginPresent && entry.pluginEnabled && entry.installedVersion === entry.requestedVersion && entry.installedIdentityMatched
        checks.push(check(
          `host.codex.${entry.component}`,
          healthy ? 'ok' : 'error',
          healthy ? `${entry.component} is ready in Codex` : `${entry.component} needs attention in Codex`,
          healthy ? undefined : {
            installed: entry.pluginPresent,
            enabled: entry.pluginEnabled,
            installedVersion: entry.installedVersion,
            requestedVersion: entry.requestedVersion,
            identityMatched: entry.installedIdentityMatched,
            identityError: entry.installedIdentityError,
          },
        ))
      }
      checks.push(check('host.codex.agent-host-operations', operationsSkill.status === 'ok' ? 'ok' : 'error', operationsSkill.status === 'ok' ? 'Agent Host operations Skill is ready in Codex' : 'Agent Host operations Skill needs attention in Codex', operationsSkill))
    } catch (error) {
      checks.push(check('host.codex', 'error', 'Codex host inspection failed', error.message))
    }
  }
  if (inspectAgentApps && state.hosts.claude !== undefined) {
    try {
      const current = await inspectClaude(agentManifest, runner, state.hosts.claude)
      const missing = current.entries.filter((entry) => !entry.present || !entry.identityMatched)
      const operationsSkill = await inspectOperationsSkill(state.hosts.claude.operationsSkill, runner)
      const ready = missing.length === 0 && operationsSkill.status === 'ok'
      checks.push(check('host.claude', ready ? 'ok' : 'error', ready ? 'Claude Code MCP entries and Agent Host operations Skill are present' : 'Claude Code integrations need attention', {
        entries: missing,
        operationsSkill,
      }))
      for (const entry of current.entries) {
        const healthy = entry.present && entry.identityMatched
        checks.push(check(`host.claude.${entry.component}`, healthy ? 'ok' : 'error', healthy ? `${entry.component} is ready in Claude Code` : `${entry.component} needs attention in Claude Code`))
      }
      checks.push(check('host.claude.agent-host-operations', operationsSkill.status === 'ok' ? 'ok' : 'error', operationsSkill.status === 'ok' ? 'Agent Host operations Skill is ready in Claude Code' : 'Agent Host operations Skill needs attention in Claude Code', operationsSkill))
    } catch (error) {
      checks.push(check('host.claude', 'error', 'Claude Code host inspection failed', error.message))
    }
  }
  if (deep) {
    for (const [id, component] of Object.entries(state.components).filter(([, item]) => item.toolIntegrationSchema !== undefined)) {
      try {
        const result = await mcpProbe(component)
        checks.push(check(`tool.${id}.installed`, 'ok', `${component.displayName ?? id} installed runtime is ready`, {
          tools: result.tools,
          server: result.server,
        }))
      } catch (error) {
        checks.push(check(`tool.${id}.installed`, 'error', `${component.displayName ?? id} installed runtime needs attention`, {
          code: error.code ?? 'TOOL_HEALTH_FAILED',
        }))
      }
    }
  }
  const service = await inspectService(
    state.runtime.service === null ? null : { ...state.runtime.service, socketPath: state.runtime.socketPath },
    runner,
  )
  checks.push(check('runtime.service', service.ready ? 'ok' : 'error', service.ready ? 'Direct Runtime service is ready' : 'Direct Runtime service is not ready', service))
  if (deep && service.ready) {
    const runtime = state.components['direct-execution-runtime']
    const projectionResult = await runner(runtime.command, [
      ...runtime.args, 'project', '--socket', state.runtime.socketPath, '--selection', '-',
    ], { input: `${JSON.stringify(mathProjectionSelection())}\n`, allowFailure: true, timeoutMs: 45_000 })
    let projection = null
    try { projection = JSON.parse(projectionResult.stdout) } catch {}
    const projectedOperation = projection?.contract?.inputSchema?.properties?.operation?.const ??
      projection?.contract?.inputSchema?.oneOf?.[0]?.properties?.operation?.const
    const projected = projectionResult.status === 0 &&
      projection?.target?.operationId === 'expression.evaluate' &&
      projectedOperation === 'expression.evaluate' &&
      typeof projection?.contract?.contractDigest === 'string'
    checks.push(check(
      'runtime.contract-projection',
      projected ? 'ok' : 'error',
      projected ? 'The selected Math operation contract is current' : 'The selected Math operation contract could not be projected',
      projected ? { schemaBytes: projection.contract.schemaBytes } : projection ?? projectionResult.stderr.trim(),
    ))
    const result = await runner(runtime.command, [
      ...runtime.args, 'run', '--socket', state.runtime.socketPath, '--work-order', '-',
    ], { input: `${JSON.stringify(semanticProbeOrder())}\n`, allowFailure: true, timeoutMs: 45_000 })
    let parsed = null
    try { parsed = JSON.parse(result.stdout) } catch {}
    const math = parsed?.calls?.find((item) => item.id === 'math')
    const mathBatch = parsed?.calls?.find((item) => item.id === 'math-batch')
    const time = parsed?.calls?.find((item) => item.id === 'time')
    const mathHealthy = math?.status === 'ok' && math?.result?.exact === '42' &&
      mathBatch?.status === 'ok' && mathBatch?.result?.status === 'ok' &&
      mathBatch?.result?.results?.[0]?.exact === '42' && mathBatch?.result?.results?.[1]?.exact === '3*x**2'
    const timeHealthy = time?.status === 'ok' && time?.result?.results?.[0]?.localDateTime === '2026-08-24T21:00'
    checks.push(check('tool.math-anchor.direct', mathHealthy ? 'ok' : 'error', mathHealthy ? 'Math Anchor direct execution is ready' : 'Math Anchor direct execution needs attention', { single: math, batch: mathBatch }))
    checks.push(check('tool.migratory-time.direct', timeHealthy ? 'ok' : 'error', timeHealthy ? 'Migratory Time direct execution is ready' : 'Migratory Time direct execution needs attention', time))
    const healthy = result.status === 0 && mathHealthy && timeHealthy
    checks.push(check('runtime.semantic-probe', healthy ? 'ok' : 'error', healthy ? 'Math, native batch, and time-zone direct probes returned the expected typed results' : 'A direct semantic probe failed', parsed ?? result.stderr.trim()))
  } else if (deep) {
    for (const id of ['math-anchor', 'migratory-time']) {
      if (state.components[id] === undefined) continue
      checks.push(check(`tool.${id}.direct`, 'error', `${id} direct readiness is unknown while the local execution service is not running`))
    }
  }
  if (state.observability?.enabled === true && Array.isArray(contextAnalysis?.budgetChecks) && contextAnalysis.budgetChecks.length > 0) {
    const exceeded = contextAnalysis.budgetChecks.filter((item) => item?.status === 'exceeded')
    checks.push(check(
      'context.catalog',
      exceeded.length === 0 ? 'ok' : 'warning',
      exceeded.length === 0
        ? 'The active tool catalog is within its declared context budgets'
        : `The active tool catalog exceeds ${exceeded.length} declared context budget${exceeded.length === 1 ? '' : 's'}`,
      { exceeded },
    ))
  }
  const errors = checks.filter((item) => item.status === 'error').length
  const warnings = checks.filter((item) => item.status === 'warning').length
  return { status: errors > 0 ? 'error' : warnings > 0 ? 'warning' : 'ok', checks }
}
