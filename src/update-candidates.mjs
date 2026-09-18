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

function validDigest(value) {
  return value === null || value === undefined || /^sha256:[0-9a-f]{64}$/u.test(value)
}

function validCandidate(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value.tag === null || typeof value.tag === 'string')
    && (value.version === null || typeof value.version === 'string')
    && validDigest(value.digest)
    && validDigest(value.upstreamDigest)
    && validDigest(value.wrappedDigest)
    && (value.from === null || typeof value.from === 'string')
    && (value.platform === null || typeof value.platform === 'string')
    && typeof value.compatible === 'boolean'
    && typeof value.platformAvailable === 'boolean'
    && (value.downloadedPath === null || value.downloadedPath === undefined || typeof value.downloadedPath === 'string')
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

function repositoryFromCandidate(candidate) {
  if (typeof candidate?.repository === 'string' && candidate.repository.length > 0) return candidate.repository
  const releaseUrl = candidate?.releaseUrl
  if (typeof releaseUrl === 'string') {
    const match = /github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/u.exec(releaseUrl)
    if (match) return match[1]
  }
  return null
}

function upstreamDigestOf(candidate) {
  if (candidate === null || candidate === undefined) return null
  if (typeof candidate.upstreamDigest === 'string') return candidate.upstreamDigest
  // Inspect populates digest from the remote/upstream asset. After a Host wrap,
  // digest may equal wrappedDigest — only treat digest as upstream when it is not
  // the wrapped digest.
  if (typeof candidate.digest === 'string'
    && (candidate.wrappedDigest === undefined || candidate.wrappedDigest === null || candidate.digest !== candidate.wrappedDigest)) {
    return candidate.digest
  }
  return null
}

/** Cache identity: repo + asset + platform + upstream digest (not tag alone). */
export function sameCandidateCacheIdentity(previous, next) {
  if (previous === null || previous === undefined || next === null || next === undefined) return false
  if (previous.tag !== next.tag || previous.platform !== next.platform) return false
  if ((previous.assetName ?? null) !== (next.assetName ?? null)) return false
  if ((previous.assetUrl ?? null) !== (next.assetUrl ?? null)) return false
  const previousRepo = repositoryFromCandidate(previous)
  const nextRepo = repositoryFromCandidate(next)
  if (previousRepo !== null && nextRepo !== null && previousRepo !== nextRepo) return false
  const previousUpstream = upstreamDigestOf(previous)
  const nextUpstream = upstreamDigestOf(next)
  if (previousUpstream !== null && nextUpstream !== null && previousUpstream !== nextUpstream) return false
  return true
}

function mergeCandidate(previous, next) {
  if (next === null) return null
  const merged = { ...(previous ?? {}), ...next }
  const explicitCache = Object.prototype.hasOwnProperty.call(next, 'downloadedPath')
  if (explicitCache) return merged
  // Inspect refreshes omit downloadedPath. Keep a Host-managed verified cache only
  // when repo/asset/platform/upstream digest still identify the same bytes.
  if (sameCandidateCacheIdentity(previous, merged) && typeof previous.downloadedPath === 'string') {
    merged.downloadedPath = previous.downloadedPath
    if (previous.wrappedDigest !== undefined) merged.wrappedDigest = previous.wrappedDigest
    if (previous.upstreamDigest !== undefined && previous.upstreamDigest !== null) {
      merged.upstreamDigest = previous.upstreamDigest
    } else if (typeof merged.digest === 'string' && merged.digest !== previous.wrappedDigest) {
      merged.upstreamDigest = merged.digest
    }
    return merged
  }
  if (typeof previous?.downloadedPath === 'string') {
    // Remote bytes changed under the same tag (or asset/repo drifted): drop cache.
    merged.downloadedPath = null
    merged.upstreamDigest = upstreamDigestOf(merged)
    merged.wrappedDigest = null
  }
  return merged
}

export async function mergeUpdateCandidates(stateRoot, patch, dependencies = {}) {
  const apply = async () => {
    const current = await readUpdateCandidates(stateRoot)
    const tools = { ...(current.recoveredInvalid === true ? {} : current.tools) }
    for (const [id, candidate] of Object.entries(patch.tools ?? {})) {
      if (candidate === null) delete tools[id]
      else tools[id] = mergeCandidate(tools[id], candidate)
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
  const candidate = {
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
  }
  // Only set cache fields when the remote payload explicitly carries them.
  // Inspect refreshes must not null out a Host-managed verified download.
  if (remote.downloadedPath !== undefined) candidate.downloadedPath = remote.downloadedPath
  if (remote.upstreamDigest !== undefined) candidate.upstreamDigest = remote.upstreamDigest
  if (remote.wrappedDigest !== undefined) candidate.wrappedDigest = remote.wrappedDigest
  return candidate
}

export async function clearUpdateCandidate(stateRoot, id, dependencies = {}) {
  return mergeUpdateCandidates(stateRoot, { tools: { [id]: null } }, dependencies)
}
