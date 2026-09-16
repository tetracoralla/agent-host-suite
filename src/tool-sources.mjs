import { join } from 'node:path'
import { AgentHostError } from './errors.mjs'
import { readJson, writePrivateJson } from './json.mjs'
import { resolveStateRoot } from './paths.mjs'
import { prepareStatePaths } from './state.mjs'

export const TOOL_SOURCES_SCHEMA = 'openadam.agent-host-tool-sources.v0.1'

function fail(code, message, details) {
  throw new AgentHostError(code, message, details)
}

function sourcesPath(root) {
  return join(root, 'tool-sources.json')
}

function emptyRecord() {
  return { schemaVersion: TOOL_SOURCES_SCHEMA, updatedAt: null, tools: {} }
}

function validOrigin(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.kind === 'github-release'
    && typeof value.repository === 'string'
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value.repository)
    && typeof value.tag === 'string'
    && typeof value.assetUrl === 'string'
    && value.assetUrl.startsWith('https://')
    && typeof value.assetSha256 === 'string'
    && /^sha256:[0-9a-f]{64}$/u.test(value.assetSha256)
    && Number.isSafeInteger(value.assetBytes)
    && value.assetBytes > 0
}

function validEntry(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && validOrigin(value.origin)
    && (value.rollback === null
      || value.rollback === undefined
      || (typeof value.rollback === 'object'
        && (value.rollback.origin === null || value.rollback.origin === undefined || validOrigin(value.rollback.origin))))
}

function validRecord(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.schemaVersion === TOOL_SOURCES_SCHEMA
    && (value.updatedAt === null || typeof value.updatedAt === 'string')
    && value.tools !== null
    && typeof value.tools === 'object'
    && !Array.isArray(value.tools)
    && Object.values(value.tools).every(validEntry)
}

export async function readToolSources(stateRoot) {
  const root = resolveStateRoot(stateRoot)
  const value = await readJson(sourcesPath(root))
  if (value === null) return emptyRecord()
  if (!validRecord(value)) return { ...emptyRecord(), recoveredInvalid: true }
  return value
}

export async function writeToolSources(stateRoot, record) {
  const paths = await prepareStatePaths(resolveStateRoot(stateRoot))
  const value = {
    schemaVersion: TOOL_SOURCES_SCHEMA,
    updatedAt: new Date().toISOString(),
    tools: record.tools ?? {},
  }
  if (!validRecord(value)) fail('TOOL_SOURCE_INVALID', 'The tool update-source record is not valid')
  await writePrivateJson(sourcesPath(paths.root), value)
  return value
}

export function originIdentity(origin) {
  return origin?.kind === 'github-release' ? `github:${origin.repository}` : origin?.kind ?? 'unknown'
}

export function assertCompatibleOrigin(previous, next, { replaceSource = false } = {}) {
  if (previous === null || previous === undefined) return
  if (previous.kind !== next.kind || previous.repository !== next.repository) {
    if (replaceSource !== true) {
      fail(
        'GITHUB_SOURCE_CONFLICT',
        `Installed ${next.id ?? 'tool'} is trusted from ${originIdentity(previous)}; a name or logo change cannot silently switch it to ${originIdentity(next)}`,
        { previous: previous.repository, next: next.repository },
      )
    }
  }
}

export function githubOrigin({
  repository,
  tag,
  releaseUrl,
  assetName,
  assetUrl,
  assetSha256,
  assetBytes,
}) {
  return {
    kind: 'github-release',
    repository,
    tag,
    releaseUrl: releaseUrl ?? `https://github.com/${repository}/releases/tag/${tag}`,
    assetName,
    assetUrl,
    assetSha256,
    assetBytes,
  }
}

export async function recordToolSourceAfterRemove(stateRoot, id, {
  removedOrigin = null,
  removedVersion = null,
} = {}) {
  const current = await readToolSources(stateRoot)
  const tools = { ...(current.recoveredInvalid === true ? {} : current.tools) }
  const previous = tools[id]
  const origin = removedOrigin?.kind === 'github-release'
    ? removedOrigin
    : (previous?.origin?.kind === 'github-release' ? previous.origin : null)
  if (origin === null) {
    if (previous !== undefined) delete tools[id]
    else return current
  } else {
    // Remove is not a GitHub upgrade. Keep the removed binding as origin for
    // identity, but clear any prior upgrade/source-switch rollback so undo-remove
    // cannot resurrect a stale repository from an earlier source replacement.
    tools[id] = {
      origin,
      wrappedSha256: previous?.wrappedSha256,
      wrappedBytes: previous?.wrappedBytes,
      lastCheck: {
        at: new Date().toISOString(),
        status: 'removed',
        availableVersion: removedVersion ?? null,
      },
      rollback: null,
    }
  }
  return writeToolSources(stateRoot, { tools })
}

export async function restoreToolSourceAfterRollback(stateRoot, id, {
  restoredOrigin = null,
  restoredVersion = null,
  restoredRoot = null,
  replacedOrigin = null,
  replacedVersion = null,
  replacedRoot = null,
} = {}) {
  const current = await readToolSources(stateRoot)
  const tools = { ...(current.recoveredInvalid === true ? {} : current.tools) }
  const previous = tools[id]
  if (restoredOrigin === null || restoredOrigin === undefined) {
    if (previous !== undefined) delete tools[id]
  } else {
    tools[id] = {
      origin: restoredOrigin,
      wrappedSha256: previous?.rollback?.wrappedSha256 ?? previous?.wrappedSha256 ?? undefined,
      wrappedBytes: previous?.rollback?.wrappedBytes ?? previous?.wrappedBytes ?? undefined,
      lastCheck: {
        at: new Date().toISOString(),
        status: 'rolled-back',
        availableVersion: restoredVersion,
      },
      rollback: replacedOrigin === null || replacedOrigin === undefined ? null : {
        origin: replacedOrigin,
        version: replacedVersion,
        root: replacedRoot,
      },
    }
  }
  return writeToolSources(stateRoot, { tools })
}
