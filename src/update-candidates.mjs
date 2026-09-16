import { join } from 'node:path'
import { AgentHostError } from './errors.mjs'
import { readJson, writePrivateJson } from './json.mjs'
import { resolveStateRoot } from './paths.mjs'
import { prepareStatePaths, statePaths } from './state.mjs'
import { withLifecycleMutation } from './lifecycle-lock.mjs'

export const UPDATE_CANDIDATES_SCHEMA = 'openadam.agent-host-update-candidates.v0.1'

function fail(code, message, details) {
  throw new AgentHostError(code, message, details)
}

function candidatesPath(root) {
  return join(root, 'update-candidates.json')
}

function emptyRecord() {
  return {
    schemaVersion: UPDATE_CANDIDATES_SCHEMA,
    updatedAt: null,
    catalog: null,
    tools: {},
  }
}

function validCandidate(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value.tag === null || typeof value.tag === 'string')
    && (value.version === null || typeof value.version === 'string')
    && (value.digest === null || value.digest === undefined || /^sha256:[0-9a-f]{64}$/u.test(value.digest))
    && (value.from === null || typeof value.from === 'string')
    && (value.platform === null || typeof value.platform === 'string')
    && typeof value.compatible === 'boolean'
    && typeof value.platformAvailable === 'boolean'
}

function validCatalog(value) {
  if (value === null) return true
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.fetchedAt === 'string'
    && (value.tag === null || typeof value.tag === 'string')
    && (value.digest === null || value.digest === undefined || /^sha256:[0-9a-f]{64}$/u.test(value.digest))
}

function validRecord(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.schemaVersion === UPDATE_CANDIDATES_SCHEMA
    && (value.updatedAt === null || typeof value.updatedAt === 'string')
    && validCatalog(value.catalog ?? null)
    && value.tools !== null
    && typeof value.tools === 'object'
    && !Array.isArray(value.tools)
    && Object.values(value.tools).every(validCandidate)
}

export async function readUpdateCandidates(stateRoot) {
  const root = resolveStateRoot(stateRoot)
  const value = await readJson(candidatesPath(root))
  if (value === null) return emptyRecord()
  if (!validRecord(value)) return { ...emptyRecord(), recoveredInvalid: true }
  return value
}

export async function writeUpdateCandidates(stateRoot, record) {
  const paths = await prepareStatePaths(resolveStateRoot(stateRoot))
  const value = {
    schemaVersion: UPDATE_CANDIDATES_SCHEMA,
    updatedAt: new Date().toISOString(),
    catalog: record.catalog ?? null,
    tools: record.tools ?? {},
  }
  if (!validRecord(value)) fail('UPDATE_CANDIDATE_INVALID', 'The persisted update candidate record is not valid')
  await writePrivateJson(candidatesPath(paths.root), value)
  return value
}

export async function mergeUpdateCandidates(stateRoot, patch, dependencies = {}) {
  const apply = async () => {
    const current = await readUpdateCandidates(stateRoot)
    const tools = { ...(current.recoveredInvalid === true ? {} : current.tools) }
    for (const [id, candidate] of Object.entries(patch.tools ?? {})) {
      tools[id] = { ...tools[id], ...candidate }
    }
    return writeUpdateCandidates(stateRoot, {
      catalog: patch.catalog === undefined ? current.catalog : patch.catalog,
      tools,
    })
  }
  if (dependencies.lifecycleLease !== undefined) return apply()
  const paths = statePaths(resolveStateRoot(stateRoot))
  try {
    return await withLifecycleMutation(paths, 'updates.candidates', dependencies, apply)
  } catch (error) {
    if (error instanceof AgentHostError && error.code === 'LIFECYCLE_BUSY') return readUpdateCandidates(stateRoot)
    throw error
  }
}

export function candidateFromRemote(remote, { platform, catalogId = null } = {}) {
  return {
    tag: remote.tag ?? null,
    version: remote.availableVersion ?? null,
    digest: remote.digest ?? null,
    from: remote.from ?? null,
    platform: platform ?? null,
    compatible: remote.compatible === true,
    platformAvailable: remote.platformAvailable === true,
    assetName: remote.assetName ?? null,
    assetUrl: remote.assetUrl ?? null,
    assetBytes: remote.assetBytes ?? null,
    releaseUrl: remote.releaseUrl ?? null,
    catalogId,
    checkedAt: new Date().toISOString(),
    downloadedPath: remote.downloadedPath ?? null,
  }
}
