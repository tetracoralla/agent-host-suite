import { platform } from 'node:os'
import { AgentHostError } from './errors.mjs'

export function skillLauncherScript({ command, args = [], environment = {} }, platformName = platform()) {
  function invalid() {
    throw new AgentHostError('SKILL_LAUNCHER_INVALID', 'A Skill launcher binding contains unsupported characters')
  }
  function quote(value) {
    if (typeof value !== 'string' || value.includes('\0')) invalid()
    if (platformName === 'win32') {
      if (/[\r\n"]/u.test(value)) invalid()
      return `"${value.replaceAll('%', '%%')}"`
    }
    return `'${value.replaceAll("'", `'\\''`)}'`
  }
  const variables = Object.entries(environment).sort(([left], [right]) => left.localeCompare(right))
  for (const [name, value] of variables) {
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(name)) invalid()
    quote(value)
  }
  if (platformName === 'win32') {
    return [
      '@echo off', 'setlocal DisableDelayedExpansion',
      ...variables.map(([name, value]) => `set ${quote(`${name}=${value}`)}`),
      `${[command, ...args].map(quote).join(' ')} %*`, '',
    ].join('\r\n')
  }
  // Set the child's environment without assigning shell variables. Accepted
  // Provider names may also be readonly or special variables in /bin/sh.
  const invocation = variables.length === 0 ? [command, ...args] : [
    '/usr/bin/env', ...variables.map(([name, value]) => `${name}=${value}`), command, ...args,
  ]
  return [
    '#!/bin/sh',
    `exec ${invocation.map(quote).join(' ')} "$@"`, '',
  ].join('\n')
}
