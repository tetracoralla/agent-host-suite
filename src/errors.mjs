export class AgentHostError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'AgentHostError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export function asPublicError(error) {
  if (error instanceof AgentHostError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    }
  }
  return { code: 'AGENT_HOST_INTERNAL', message: error instanceof Error ? error.message : String(error) }
}
