import { resolveDirectBindings } from './provider-bindings.mjs'

export function createDiagnosticOrder(bindings, runtimeVersion = '0.2.2') {
  const version = runtimeVersion.match(/^(\d+)\.(\d+)\.(\d+)/u)?.slice(1).map(Number)
  const modern = version !== undefined && (version[0] > 0 || version[1] > 2 || (version[1] === 2 && version[2] >= 2))
  return {
    schemaVersion: modern ? 'openadam.direct-work-order.v0.2' : 'openadam.direct-work-order.v0.1',
    ...(modern ? { purpose: 'diagnostic' } : {}),
    id: 'agent-host-doctor',
    calls: bindings.flatMap(({ diagnostic }) => diagnostic?.calls ?? []),
  }
}

function check(id, status, message, detail) {
  return { id, status, message, ...(detail === undefined ? {} : { detail }) }
}

async function invoke(runtime, socketPath, action, flag, input, runner) {
  try {
    const result = await runner(runtime.command, [...runtime.args, action, '--socket', socketPath, flag, '-'], {
      input: `${JSON.stringify(input)}\n`, allowFailure: true, timeoutMs: 45_000,
    })
    let value = null
    try { value = JSON.parse(result.stdout) } catch {}
    return { ok: result.status === 0 && value !== null, value }
  } catch (error) {
    return { ok: false, value: null, code: error.code ?? 'DIRECT_DIAGNOSTIC_FAILED' }
  }
}

export async function inspectDirectProviders(state, service, runner) {
  let bindings
  try {
    bindings = resolveDirectBindings(state, { workspaceRoot: state.workspaceRoot })
  } catch (error) {
    return [check('runtime.provider-bindings', 'error', 'Direct Provider bindings could not be resolved', { code: error.code })]
  }
  const checks = []
  if (!service.ready) return bindings.map(({ componentId, displayName }) =>
    check(`tool.${componentId}.direct`, 'error', `${displayName} direct readiness is unknown while the local execution service is not running`))
  const runtime = state.components['direct-execution-runtime']
  if (runtime === undefined) return [check('runtime.provider-bindings', 'error', 'The installed Direct Runtime command is unavailable')]
  const tested = bindings.filter(({ diagnostic }) => diagnostic !== null)
  const projections = tested.filter(({ diagnostic }) => diagnostic.projection !== undefined)
  for (const { componentId, displayName, diagnostic } of projections) {
    const result = await invoke(runtime, state.runtime.socketPath, 'project', '--selection', diagnostic.projection.selection, runner)
    const ok = result.ok && diagnostic.projection.assess(result.value)
    checks.push(check(projections.length === 1 ? 'runtime.contract-projection' : `runtime.contract-projection.${componentId}`,
      ok ? 'ok' : 'error', ok ? `${displayName} selected contract is current` : `${displayName} selected contract could not be projected`,
      ok ? { schemaBytes: result.value.contract.schemaBytes } : { code: result.code ?? 'DIRECT_PROJECTION_FAILED' }))
  }
  if (tested.length > 0) {
    const order = createDiagnosticOrder(tested, runtime.version)
    const result = await invoke(runtime, state.runtime.socketPath, 'run', '--work-order', order, runner)
    const calls = Array.isArray(result.value?.calls) ? result.value.calls : []
    const exactCalls = calls.length === order.calls.length && new Set(calls.map((call) => call?.id)).size === calls.length
      && calls.every((call) => order.calls.some((expected) => expected.id === call?.id && expected.providerId === call?.providerId))
    let healthy = result.ok && exactCalls
    for (const { componentId, displayName, diagnostic } of tested) {
      const ok = result.ok && exactCalls && diagnostic.assess(calls)
      healthy &&= ok
      checks.push(check(`tool.${componentId}.direct`, ok ? 'ok' : 'error',
        ok ? `${displayName} direct execution is ready` : `${displayName} direct execution needs attention`))
    }
    checks.push(check('runtime.semantic-probe', healthy ? 'ok' : 'error',
      healthy ? 'Declared direct probes returned the expected typed results' : 'A declared direct semantic probe failed',
      { testedComponents: tested.map(({ componentId }) => componentId), code: result.code ?? null }))
  }
  for (const { componentId, displayName } of bindings.filter(({ diagnostic }) => diagnostic === null)) {
    checks.push(check(`tool.${componentId}.direct`, 'warning', `${displayName} has no declared direct semantic diagnostic`, { observation: 'not-observed' }))
  }
  return checks
}
