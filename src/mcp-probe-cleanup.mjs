import { AgentHostError } from './errors.mjs'

function boundedFailure(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'UNCLASSIFIED_ERROR',
    message: [...String(error?.message ?? error ?? 'Unknown failure')].slice(0, 512).join(''),
  }
}
export async function closeMcpProbeTransport(transport, primaryError, code, message) {
  try {
    await transport.close()
  } catch (cleanupError) {
    throw new AgentHostError(code, message, {
      operation: primaryError === null ? null : boundedFailure(primaryError),
      cleanup: boundedFailure(cleanupError),
    })
  }
}
