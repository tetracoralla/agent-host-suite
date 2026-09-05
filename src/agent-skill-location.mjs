import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { AgentHostError } from './errors.mjs'

const HOST_DIRECTORIES = Object.freeze({
  claude: '.claude',
  zcode: '.zcode',
})

function absoluteDirectory(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\u0000\r\n]/u.test(value)) {
    throw new AgentHostError('HOST_SKILL_ROOT_INVALID', `${label} is invalid`)
  }
  if (!isAbsolute(value)) throw new AgentHostError('HOST_SKILL_ROOT_INVALID', `${label} must be an absolute path`)
  return resolve(value)
}

export function resolveLinkedSkillsRoot(host, options = {}) {
  const directory = HOST_DIRECTORIES[host]
  if (directory === undefined) throw new AgentHostError('HOST_UNSUPPORTED', `Unsupported linked Skill host: ${host}`)
  if (options.homeRoot !== undefined) {
    return join(absoluteDirectory(options.homeRoot, `${host} home root`), directory, 'skills')
  }
  if (host === 'claude' && options.configRoot !== undefined) {
    return join(absoluteDirectory(options.configRoot, 'Claude configuration root'), 'skills')
  }
  if (host === 'claude' && process.env.CLAUDE_CONFIG_DIR !== undefined) {
    return join(absoluteDirectory(process.env.CLAUDE_CONFIG_DIR, 'CLAUDE_CONFIG_DIR'), 'skills')
  }
  return join(homedir(), directory, 'skills')
}
