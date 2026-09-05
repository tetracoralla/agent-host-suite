import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AgentHostError } from './errors.mjs'

export const SOURCE_LOCK_SCHEMA = 'openadam.agent-host-release-source-lock.v0.1'
export const BUILD_PROVENANCE_SCHEMA = 'openadam.agent-host-build-provenance.v0.1'
export const SOURCE_POLICIES = Object.freeze(['local-development', 'local-clean', 'remote-tagged'])

function fail(message) {
  throw new AgentHostError('RELEASE_SOURCE_PROVENANCE_INVALID', `Release source provenance is invalid: ${message}`)
}

function exactObject(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
  const unexpected = Object.keys(value).filter((key) => !keys.includes(key))
  if (unexpected.length > 0) fail(`${label} contains unsupported fields: ${unexpected.join(', ')}`)
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`)
  return value
}

export function normalizeRepositoryUrl(value) {
  const repository = requiredString(value, 'repository URL').replace(/\.git$/u, '')
  let parsed
  try {
    parsed = new URL(repository)
  } catch {
    fail('repository URLs must be absolute HTTPS URLs')
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    fail('repository URLs must use HTTPS without embedded credentials')
  }
  parsed.hash = ''
  parsed.search = ''
  return parsed.href.replace(/\/$/u, '')
}

export function validateSourceLock(lock, expectedIds) {
  exactObject(lock, ['schemaVersion', 'sources'], 'source lock')
  if (lock.schemaVersion !== SOURCE_LOCK_SCHEMA) fail(`unsupported source lock schema: ${lock.schemaVersion ?? 'missing'}`)
  if (lock.sources === null || typeof lock.sources !== 'object' || Array.isArray(lock.sources)) {
    fail('source lock sources must be an object')
  }
  const expected = [...expectedIds].sort()
  const actual = Object.keys(lock.sources).sort()
  const missing = expected.filter((id) => !actual.includes(id))
  const extra = actual.filter((id) => !expected.includes(id))
  if (missing.length > 0 || extra.length > 0) fail(`source lock set differs from this build (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`)
  const sources = {}
  for (const id of expected) {
    const source = lock.sources[id]
    exactObject(source, ['repository', 'ref', 'revision'], `source lock entry ${id}`)
    const repository = normalizeRepositoryUrl(source.repository)
    const ref = requiredString(source.ref, `${id} ref`)
    if (!/^refs\/tags\/[A-Za-z0-9][A-Za-z0-9._+/-]*$/u.test(ref) || ref.includes('..') || ref.endsWith('/')) {
      fail(`${id} ref must name one immutable release tag`)
    }
    const revision = requiredString(source.revision, `${id} revision`)
    if (!/^[0-9a-f]{40}$/u.test(revision)) fail(`${id} revision must be one full commit SHA`)
    sources[id] = { repository, ref, revision }
  }
  return { schemaVersion: SOURCE_LOCK_SCHEMA, sources }
}

export function validateBuildProvenance(provenance, release) {
  exactObject(provenance, ['schemaVersion', 'policy', 'releaseId', 'suiteVersion', 'createdAt', 'sources', 'reusedComponents', 'distributionBoundary'], 'build provenance')
  if (provenance.schemaVersion !== BUILD_PROVENANCE_SCHEMA) fail(`unsupported build provenance schema: ${provenance.schemaVersion ?? 'missing'}`)
  if (!SOURCE_POLICIES.includes(provenance.policy)) fail(`unsupported policy: ${provenance.policy}`)
  if (provenance.releaseId !== release.releaseId || provenance.suiteVersion !== release.suiteVersion) fail('build provenance does not identify the bound release manifest')
  requiredString(provenance.createdAt, 'build provenance createdAt')
  if (!Number.isFinite(Date.parse(provenance.createdAt))) fail('build provenance createdAt must be a date-time')
  if (provenance.sources === null || typeof provenance.sources !== 'object' || Array.isArray(provenance.sources) || Object.keys(provenance.sources).length === 0) {
    fail('build provenance sources must be a non-empty object')
  }
  if (!Object.hasOwn(provenance.sources, 'suite')) fail('build provenance must identify the Agent Host suite source')
  for (const [id, source] of Object.entries(provenance.sources)) {
    exactObject(source, ['repository', 'revision', 'dirty', 'sourcePolicy', 'ref', 'remoteVerified'], `build provenance source ${id}`)
    if (source.repository !== null) normalizeRepositoryUrl(source.repository)
    if (!/^[0-9a-f]{40}$/u.test(source.revision ?? '')) fail(`${id} revision must be one full commit SHA`)
    if (typeof source.dirty !== 'boolean') fail(`${id} dirty must be boolean`)
    if (source.sourcePolicy !== provenance.policy) fail(`${id} source policy differs from the build policy`)
    if (provenance.policy === 'remote-tagged') {
      if (source.repository === null || source.dirty || source.remoteVerified !== true) fail(`${id} is not a clean remote-verified source`)
      if (!/^refs\/tags\//u.test(source.ref ?? '')) fail(`${id} does not name a remote release tag`)
    } else if ('remoteVerified' in source || 'ref' in source) {
      fail(`${id} claims remote verification under a local source policy`)
    }
  }
  if (!Array.isArray(provenance.reusedComponents)) fail('reusedComponents must be an array')
  const reusedIds = new Set()
  for (const component of provenance.reusedComponents) {
    exactObject(component, ['id', 'artifactSha256', 'fromReleaseId'], 'reused component')
    requiredString(component.id, 'reused component id')
    requiredString(component.fromReleaseId, 'reused component release id')
    if (!/^sha256:[0-9a-f]{64}$/u.test(component.artifactSha256 ?? '')) fail(`${component.id} reused artifact digest is invalid`)
    const releaseComponent = release.components?.find((item) => item.id === component.id)
    if (releaseComponent === undefined) fail(`reused component is absent from the release manifest: ${component.id}`)
    if (releaseComponent.artifact?.sha256 !== component.artifactSha256) {
      fail(`${component.id} reused artifact digest differs from the release manifest`)
    }
    if (reusedIds.has(component.id)) fail(`reused component is duplicated: ${component.id}`)
    reusedIds.add(component.id)
  }
  if (provenance.policy === 'remote-tagged' && provenance.reusedComponents.length > 0) fail('remote-tagged provenance cannot reuse components from another build')
  const expectedBoundary = provenance.policy === 'remote-tagged'
    ? 'source-checkouts-were-clean-and-matched-remote-release-tags-at-build-time'
    : 'local-build-only-not-a-remote-confirmed-distribution'
  if (provenance.distributionBoundary !== expectedBoundary) fail('distribution boundary differs from the source policy')
  return provenance
}

export async function loadBuildProvenance(path, release) {
  let contents
  try {
    contents = await readFile(path)
  } catch (error) {
    if (error.code === 'ENOENT') throw new AgentHostError('RELEASE_SOURCE_PROVENANCE_UNAVAILABLE', `Release source provenance is unavailable: ${path}`)
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(contents.toString('utf8'))
  } catch {
    fail('build provenance is not valid JSON')
  }
  return {
    record: validateBuildProvenance(parsed, release),
    sha256: `sha256:${createHash('sha256').update(contents).digest('hex')}`,
  }
}

export async function loadReleaseProvenance(release) {
  return loadBuildProvenance(join(dirname(release.path), 'build-provenance.json'), release.manifest)
}
