import { fileURLToPath } from 'node:url'
import { AgentHostError } from './errors.mjs'
import { exactKeys } from './environment-resource-state.mjs'
import { runFile } from './process.mjs'

const protocol = 'openadam.windows-task.v0.1'
const script = fileURLToPath(new URL('./windows-task.ps1', import.meta.url))
export const windowsTaskNameValid = (value) => typeof value === 'string' && value.length <= 240
  && /^\\openAdam\\AgentHostRuntime(?:\.[A-Za-z0-9._-]+)?$/u.test(value)
export const windowsTaskValid = (value) => value === null || (exactKeys(value, ['xml', 'sddl', 'state'])
  && typeof value.xml === 'string' && value.xml.length > 0 && Buffer.byteLength(value.xml) <= 1048576
  && typeof value.sddl === 'string' && value.sddl.length > 0 && Buffer.byteLength(value.sddl) <= 65536
  && [0, 1, 2, 3, 4].includes(value.state))
const errors = new Set(['ENVIRONMENT_RESOURCE_CHANGED', 'SERVICE_PRIOR_STATE_UNRESTORABLE',
  'SERVICE_ROLLBACK_CLEANUP_INCOMPLETE', 'SERVICE_DEFINITION_INVALID', 'SERVICE_REQUEST_INVALID',
  'SERVICE_REQUEST_LIMIT', 'SERVICE_NATIVE_FAILED'])

export async function windowsTask(operation, taskName, data = {}, runner = runFile) {
  const fileOperation = ['file-security', 'set-file-security', 'validate-file-security'].includes(operation)
  if (!windowsTaskNameValid(taskName) || (!fileOperation && !['prepare', 'observe', 'validate', 'remove', 'create', 'run'].includes(operation))) {
    throw new AgentHostError('SERVICE_REQUEST_INVALID', 'The Windows task request is unsupported')
  }
  const input = JSON.stringify({ ...data, protocol, operation, taskName })
  if (Buffer.byteLength(input) > 4194304) throw new AgentHostError('SERVICE_REQUEST_LIMIT', 'The Windows task request exceeds its bound')
  const result = await runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    input, allowFailure: true, timeoutMs: 15000, maxBuffer: 4 * 1024 * 1024,
  })
  let response
  try { response = JSON.parse(result.stdout) } catch { /* below */ }
  if (result.timedOut || result.cancelled || result.overflowed || response?.protocol !== protocol
    || Buffer.byteLength(result.stdout ?? '') > 4 * 1024 * 1024) {
    throw new AgentHostError('SERVICE_STATE_UNAVAILABLE', 'Windows did not return a complete task response')
  }
  if (exactKeys(response, ['protocol', 'error']) && errors.has(response.error)) {
    throw new AgentHostError(response.error, 'Windows could not perform the recorded task operation')
  }
  if (fileOperation && result.status === 0 && exactKeys(response, ['protocol', 'security'])
    && typeof response.security === 'string' && response.security.length > 0 && Buffer.byteLength(response.security) <= 65536) return response.security
  if (fileOperation || result.status !== 0 || !exactKeys(response, ['protocol', 'task']) || !windowsTaskValid(response.task)) {
    throw new AgentHostError('SERVICE_STATE_UNAVAILABLE', 'Windows returned an unsupported task observation')
  }
  return response.task
}
