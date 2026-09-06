import { preflightApplicationState } from './application-carrier.mjs'
import { loadState, STATE_SCHEMA, stateForWrite } from './state.mjs'
import { runFile } from './process.mjs'

export async function checkApplicationState(state, dependencies) {
  return (dependencies.applicationStatePreflight ?? preflightApplicationState)(stateForWrite(state), {
    runner: dependencies.applicationRunner ?? runFile,
    carrier: dependencies.applicationCarrier,
    resolver: dependencies.resolveApplicationCarrier,
  })
}

// Run under the lifecycle lease, after interrupted work has been recovered and
// before the callback can mutate a host or service. New installations check
// their proposed state in setup, once their source and profile are known.
export async function preflightStateMigration(paths, dependencies) {
  const previous = await loadState(paths)
  if (previous !== null && previous.schemaVersion !== STATE_SCHEMA) {
    await checkApplicationState(previous, dependencies)
  }
}
