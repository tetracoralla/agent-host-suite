import { isAbsolute } from 'node:path'
import { installedProcedureProducts, procedureEnvironmentExecutors } from '../../../src/procedure-products.mjs'
import { loadState, readStatePaths } from '../../../src/state.mjs'
import { studioError } from './validation.mjs'

// A Test Run executes Capability calls and subprocedure calls through the
// installed Agent environment named by `environmentRoot`. The executors
// resolve that environment again on every call, so installing, updating or
// removing a component takes effect without restarting Studio.
export function createStudioEnvironment(environmentRoot) {
  if (typeof environmentRoot !== 'string' || !isAbsolute(environmentRoot)) {
    throw studioError('STUDIO_ENVIRONMENT_ROOT_INVALID', 'The Agent environment root must be one absolute directory path')
  }
  return {
    root: environmentRoot,
    coordinatorOptions: () => procedureEnvironmentExecutors(environmentRoot),
    async status() {
      try {
        const paths = await readStatePaths(environmentRoot)
        const state = await loadState(paths)
        if (state === null) return { root: environmentRoot, available: false, procedures: 0, problem: null }
        return { root: environmentRoot, available: true, procedures: (await installedProcedureProducts(state)).length, problem: null }
      } catch (error) {
        return { root: environmentRoot, available: false, procedures: 0, problem: error.code ?? 'STUDIO_ENVIRONMENT_UNAVAILABLE' }
      }
    },
    async assertReadyFor(method) {
      const needsEnvironment = method.graph.nodes.some((node) => node.kind === 'direct-call' || node.kind === 'procedure-call')
      if (!needsEnvironment) return
      const status = await this.status()
      if (!status.available) {
        throw studioError(
          'STUDIO_EXECUTION_ENVIRONMENT_UNAVAILABLE',
          'Capability and subprocedure Test Runs execute through the installed Agent environment, which is unavailable. Install or reconnect the Agent environment, or start Procedure Studio with --environment pointing at one.',
          { environmentRoot, problem: status.problem ?? 'not-installed' },
        )
      }
    },
  }
}
