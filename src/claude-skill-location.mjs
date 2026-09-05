import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { AgentHostError } from './errors.mjs'

function absoluteDirectory(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\u0000\r\n]/u.test(value)) {
    throw new AgentHostError('CLAUDE_CONFIG_ROOT_INVALID', `${label} is invalid`)
  }
  if (!isAbsolute(value)) {
    throw new AgentHostError('CLAUDE_CONFIG_ROOT_INVALID', `${label} must be an absolute path`)
  }
  return resolve(value)
}

export function resolveClaudeSkillsRoot(options = {}) {
  if (options.homeRoot !== undefined) {
    return join(absoluteDirectory(options.homeRoot, 'Claude home root'), '.claude', 'skills')
  }
  if (options.configRoot !== undefined) {
    return join(absoluteDirectory(options.configRoot, 'Claude configuration root'), 'skills')
  }
  if (process.env.CLAUDE_CONFIG_DIR !== undefined) {
    return join(absoluteDirectory(process.env.CLAUDE_CONFIG_DIR, 'CLAUDE_CONFIG_DIR'), 'skills')
  }
  return join(homedir(), '.claude', 'skills')
}
