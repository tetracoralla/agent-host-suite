import { realpath, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, resolve } from 'node:path'
import { AgentHostError } from './errors.mjs'

function invalidPathGrant(name, path, cause) {
  return new AgentHostError('PATH_GRANT_INVALID', `Optional path grant ${name} must name an existing absolute directory`, {
    name,
    path,
    ...(cause === undefined ? {} : { cause }),
  })
}

export async function resolvePathGrant(name, value) {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
    throw invalidPathGrant(name, value)
  }
  let root
  let info
  try {
    root = await realpath(resolve(value))
    info = await stat(root)
  } catch (error) {
    throw invalidPathGrant(name, value, error.code ?? 'PATH_UNAVAILABLE')
  }
  if (!info.isDirectory()) throw invalidPathGrant(name, value, 'NOT_A_DIRECTORY')
  return root
}

export async function validateComponentPathGrants(component) {
  const declared = new Set(component.optionalPathEnvironment ?? [])
  const entries = Object.entries(component.pathGrants ?? {})
  let total = 0
  for (const [name, roots] of entries) {
    if (!declared.has(name)) {
      throw new AgentHostError('PATH_GRANT_UNDECLARED', `The component does not declare optional path environment ${name}`, {
        declared: [...declared].sort(),
      })
    }
    if (!Array.isArray(roots) || roots.length === 0) throw invalidPathGrant(name, roots)
    total += roots.length
    if (total > 64) throw invalidPathGrant(name, roots, 'GRANT_LIMIT_EXCEEDED')
    for (const root of roots) await resolvePathGrant(name, root)
  }
}

export function componentEnvironment(component, workspaceRoot) {
  const environment = Object.fromEntries(
    (component.workspaceEnvironment ?? []).map((name) => [name, workspaceRoot]),
  )
  for (const [name, roots] of Object.entries(component.pathGrants ?? {})) {
    environment[name] = roots.join(delimiter)
  }
  return environment
}

export function canonicalPathGrants(pathGrants = {}) {
  return Object.fromEntries(
    Object.entries(pathGrants)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, roots]) => [name, [...roots]]),
  )
}
