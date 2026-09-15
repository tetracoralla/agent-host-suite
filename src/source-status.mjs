import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveApplicationCarrier } from './application-carrier.mjs'
import { AgentHostError } from './errors.mjs'
import { readJson, writePrivateJson } from './json.mjs'
import { resolveStateRoot } from './paths.mjs'
import {
  FEATURED_CATALOG_DOWNLOAD_ENV,
  GITHUB_PREVIEW_INDEX_CONVENTION,
  GITHUB_RELEASES_URL,
  fetchBoundCatalog,
  normalizePreviewDownloadUrl,
  validatePreviewDistribution,
} from './preview-download.mjs'
import { RELEASE_SCHEMA } from './release-manifest.mjs'
import { loadState, prepareStatePaths, readStatePaths } from './state.mjs'

export const SOURCE_STATUS_SCHEMA = 'openadam.agent-host-source-status.v0.1'
export const CATALOG_SOURCE_SCHEMA = 'openadam.agent-host-catalog-source.v0.1'
export const RELEASE_MANIFEST_ENV = 'AGENT_HOST_RELEASE_MANIFEST'

export const UNPUBLISHED_ASSETS_NOTE = 'Catalog assets are unpublished. This checkout has no GitHub Release assets. This is not notarized and not a store.'
export const APPLICATION_ENVIRONMENT_NOTE = 'The Manager application and the installed Agent environment can share this product name with different payloads. Application build, environment release, and tool versions are separate.'

const SUITE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const TRACKED_PREVIEW_INDEX = fileURLToPath(new URL('../catalog/preview-distribution.json', import.meta.url))
const INFO_PLIST = fileURLToPath(new URL('../macos/Info.plist', import.meta.url))

function catalogSourcePath(root) {
  return join(root, 'catalog-source.json')
}

function emptySavedSource() {
  return {
    schemaVersion: CATALOG_SOURCE_SCHEMA,
    kind: 'unset',
    url: null,
    path: null,
    lastCheck: null,
  }
}

function validSavedSource(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.schemaVersion === CATALOG_SOURCE_SCHEMA
    && ['unset', 'https', 'local'].includes(value.kind)
    && (value.url === null || (typeof value.url === 'string' && value.url.startsWith('https://')))
    && (value.path === null || typeof value.path === 'string')
    && (value.lastCheck === null || (typeof value.lastCheck === 'object' && !Array.isArray(value.lastCheck)))
    && Object.keys(value).every((key) => ['schemaVersion', 'kind', 'url', 'path', 'lastCheck'].includes(key))
}

export function catalogSourceCandidate(saved) {
  if (saved?.kind === 'https' && typeof saved.url === 'string' && saved.url.length > 0) return saved.url
  if (saved?.kind === 'local' && typeof saved.path === 'string' && saved.path.length > 0) return saved.path
  return ''
}

export function catalogSourceConfigured(saved) {
  return catalogSourceCandidate(saved) !== ''
}

export async function readCatalogSource(stateRoot) {
  const root = resolveStateRoot(stateRoot)
  const value = await readJson(catalogSourcePath(root))
  if (value === null) return emptySavedSource()
  if (!validSavedSource(value)) return { ...emptySavedSource(), recoveredInvalid: true }
  return value
}

async function writeCatalogSource(stateRoot, value) {
  const paths = await prepareStatePaths(resolveStateRoot(stateRoot))
  const record = {
    schemaVersion: CATALOG_SOURCE_SCHEMA,
    kind: value.kind,
    url: value.url ?? null,
    path: value.path ?? null,
    lastCheck: value.lastCheck ?? null,
  }
  if (!validSavedSource(record)) {
    throw new AgentHostError('CATALOG_SOURCE_INVALID', 'The catalog source record is not valid')
  }
  await writePrivateJson(catalogSourcePath(paths.root), record)
  return record
}

export function catalogFetchRecovery(code, { lastCatalogPath = null } = {}) {
  const retry = 'Retry the source check after the network or file is available.'
  const chooseLocal = 'Choose a local bound current.json or preview-distribution.json with source set --release-manifest, or in Manager Settings.'
  const chooseRemote = 'Set an HTTPS preview-distribution.json or bound current.json with source set --url. This checkout does not publish GitHub Release assets.'
  const unpublished = `${UNPUBLISHED_ASSETS_NOTE} Use a local bound catalog, or retry after an owner publishes a Release.`
  const lastCatalog = typeof lastCatalogPath === 'string' && lastCatalogPath.length > 0
    ? ` A previously downloaded catalog remains at ${lastCatalogPath}.`
    : ''
  if (code === 'PREVIEW_DOWNLOAD_NOT_CONFIGURED' || code === 'PREVIEW_DOWNLOAD_UNPUBLISHED' || code == null) {
    return { action: 'unpublished', retry: true, chooseLocal: true, chooseRemote: true, message: unpublished + lastCatalog }
  }
  if (code === 'PREVIEW_DOWNLOAD_DIGEST_MISMATCH' || code === 'PREVIEW_DOWNLOAD_SIZE_MISMATCH') {
    return {
      action: 'discard-and-retry',
      retry: true,
      chooseLocal: true,
      chooseRemote: true,
      message: `The downloaded bytes did not match the published digest or size. Discard that file; do not install it.${lastCatalog} ${retry} ${chooseLocal}`,
    }
  }
  if (code === 'PREVIEW_DOWNLOAD_TIMEOUT' || code === 'PREVIEW_DOWNLOAD_STALLED' || code === 'PREVIEW_DOWNLOAD_CANCELLED') {
    return {
      action: 'retry-from-start',
      retry: true,
      chooseLocal: true,
      chooseRemote: false,
      message: `The download was interrupted. Host does not resume partial files; retry from the start or use a local catalog.${lastCatalog}`,
    }
  }
  if (code === 'PREVIEW_DOWNLOAD_FAILED') {
    return {
      action: 'retry-or-offline',
      retry: true,
      chooseLocal: true,
      chooseRemote: true,
      message: `The catalog could not be fetched (offline or unreachable). ${retry}${lastCatalog} ${chooseLocal}`,
    }
  }
  if (code === 'PREVIEW_DOWNLOAD_INVALID' || code === 'PREVIEW_DOWNLOAD_INVALID_URL' || code === 'PREVIEW_DOWNLOAD_UNSUPPORTED') {
    return {
      action: 'choose-valid-source',
      retry: false,
      chooseLocal: true,
      chooseRemote: true,
      message: `That source is not a preview-distribution.json or bound current.json. ${chooseLocal} ${chooseRemote}`,
    }
  }
  if (code === 'RELEASE_UNBOUND') {
    return {
      action: 'choose-bound-catalog',
      retry: false,
      chooseLocal: true,
      chooseRemote: true,
      message: `That catalog is draft-unbound. Point at a bound current.json.${lastCatalog}`,
    }
  }
  return {
    action: 'retry',
    retry: true,
    chooseLocal: true,
    chooseRemote: true,
    message: `${retry} ${chooseLocal}`,
  }
}

function plistString(text, key) {
  const match = text.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, 'u'))
  return match?.[1] ?? null
}

export async function inspectApplicationBuild(options = {}) {
  const suiteRoot = options.suiteRoot ?? SUITE_ROOT
  const pkg = JSON.parse(await readFile(join(suiteRoot, 'package.json'), 'utf8'))
  let shortVersion = pkg.version
  let build = null
  try {
    const plist = await readFile(options.infoPlistPath ?? INFO_PLIST, 'utf8')
    shortVersion = plistString(plist, 'CFBundleShortVersionString') ?? shortVersion
    build = plistString(plist, 'CFBundleVersion')
  } catch {
    build = null
  }
  const carrier = options.carrier === undefined
    ? await resolveApplicationCarrier(options)
    : options.carrier
  if (carrier !== null && carrier !== undefined) {
    return {
      kind: carrier.kind,
      productName: 'Agent Host',
      version: shortVersion,
      build,
      path: carrier.root,
      note: APPLICATION_ENVIRONMENT_NOTE,
    }
  }
  return {
    kind: 'source-checkout',
    productName: 'Agent Host',
    version: shortVersion,
    build,
    path: suiteRoot,
    note: APPLICATION_ENVIRONMENT_NOTE,
  }
}

function componentVersions(state) {
  if (state == null) return []
  return Object.entries(state.components ?? {})
    .map(([id, component]) => ({
      id,
      version: component?.version ?? null,
      displayName: component?.displayName ?? null,
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

async function lastDownloadedCatalog(paths) {
  const catalogPath = join(paths.downloads, 'preview-catalog', 'current.json')
  try {
    await access(catalogPath, constants.R_OK)
    return catalogPath
  } catch {
    return null
  }
}

function envUrl(env) {
  const value = typeof env[FEATURED_CATALOG_DOWNLOAD_ENV] === 'string' ? env[FEATURED_CATALOG_DOWNLOAD_ENV].trim() : ''
  return value
}

function envManifest(env) {
  const value = typeof env[RELEASE_MANIFEST_ENV] === 'string' ? env[RELEASE_MANIFEST_ENV].trim() : ''
  return value
}

function resolvedKind(saved, env) {
  if (catalogSourceConfigured(saved)) return saved.kind
  if (envUrl(env) !== '') return 'env-url'
  if (envManifest(env) !== '') return 'env-manifest'
  return 'unset'
}

export async function inspectSourceStatus(options = {}, dependencies = {}) {
  const env = dependencies.env ?? process.env
  const root = resolveStateRoot(options.stateRoot)
  const paths = await readStatePaths(root)
  const saved = dependencies.savedCatalogSource ?? await readCatalogSource(paths.root)
  const state = await loadState(paths)
  const lastCatalogPath = await lastDownloadedCatalog(paths)
  const kind = resolvedKind(saved, env)
  const url = saved.kind === 'https' ? saved.url : (kind === 'env-url' ? envUrl(env) : null)
  const path = saved.kind === 'local' ? saved.path : (kind === 'env-manifest' ? envManifest(env) : null)
  const unpublished = kind === 'unset'
  const lastCheck = saved.lastCheck
  const recovery = catalogFetchRecovery(lastCheck?.code ?? (unpublished ? 'PREVIEW_DOWNLOAD_UNPUBLISHED' : null), { lastCatalogPath })
  return {
    schemaVersion: SOURCE_STATUS_SCHEMA,
    status: lastCheck?.status ?? (unpublished ? 'unpublished' : 'ok'),
    notarized: false,
    marketplace: false,
    publicReleasePublished: false,
    application: await inspectApplicationBuild(dependencies),
    environment: state === null
      ? { configured: false, suiteVersion: null, releaseId: null, channel: null, profile: null, updatedAt: null }
      : {
        configured: true,
        suiteVersion: state.suiteVersion,
        releaseId: state.releaseId ?? null,
        channel: state.channel,
        profile: state.profile,
        updatedAt: state.updatedAt ?? null,
      },
    components: componentVersions(state),
    source: {
      kind,
      url,
      path,
      envUrl: envUrl(env) || null,
      envManifest: envManifest(env) || null,
      githubReleasesUrl: GITHUB_RELEASES_URL,
      indexConvention: GITHUB_PREVIEW_INDEX_CONVENTION,
      lastDownloadedCatalog: lastCatalogPath,
      lastCheck,
      unpublished,
      message: unpublished ? UNPUBLISHED_ASSETS_NOTE : (lastCheck?.message ?? 'A catalog source is configured.'),
      recovery,
    },
    assessmentBoundary: 'This report names application build, environment release, and tool versions. It does not publish a GitHub Release or claim Apple notarization.',
  }
}

function looksLikeReleaseManifest(value) {
  return value !== null && typeof value === 'object' && value.schemaVersion === RELEASE_SCHEMA
}

function looksLikePreviewIndex(value) {
  return value !== null && typeof value === 'object' && value.schemaVersion === 'openadam.agent-host-preview-distribution.v0.1'
}

async function inspectLocalCatalog(path) {
  const absolute = resolve(path)
  let value
  try {
    value = await readJson(absolute)
  } catch (error) {
    if (error instanceof AgentHostError && error.code === 'STATE_INVALID_JSON') {
      throw new AgentHostError('PREVIEW_DOWNLOAD_INVALID', `The local catalog file is not valid JSON: ${absolute}`)
    }
    throw error
  }
  if (value === null) {
    throw new AgentHostError('PREVIEW_DOWNLOAD_FAILED', `The local catalog file is unavailable: ${absolute}`)
  }
  if (looksLikePreviewIndex(value)) {
    const index = validatePreviewDistribution(value)
    if (index.status === 'unpublished' || index.catalog === null) {
      throw new AgentHostError('PREVIEW_DOWNLOAD_UNPUBLISHED', UNPUBLISHED_ASSETS_NOTE, { path: absolute })
    }
    return { kind: 'preview-index', path: absolute, index, release: null }
  }
  if (looksLikeReleaseManifest(value)) {
    if (value.status === 'draft-unbound') {
      throw new AgentHostError('RELEASE_UNBOUND', 'No verified compatibility release is bound in this catalog', { path: absolute })
    }
    return { kind: 'release-manifest', path: absolute, index: null, release: value }
  }
  throw new AgentHostError(
    'PREVIEW_DOWNLOAD_INVALID',
    'The local file must be preview-distribution.json or a bound current.json',
    { path: absolute },
  )
}

async function inspectTrackedUnpublished() {
  const index = validatePreviewDistribution(JSON.parse(await readFile(TRACKED_PREVIEW_INDEX, 'utf8')))
  return {
    kind: 'tracked-unpublished',
    path: TRACKED_PREVIEW_INDEX,
    index,
    release: null,
  }
}

function lastCheckRecord({ status, code, message, recovery, sourceUrl = null, sourcePath = null }) {
  return {
    at: new Date().toISOString(),
    status,
    code,
    message,
    sourceUrl,
    sourcePath,
    recovery,
  }
}

function unpublishedCode(code) {
  return code === 'PREVIEW_DOWNLOAD_UNPUBLISHED' || code === 'PREVIEW_DOWNLOAD_NOT_CONFIGURED'
}

function failureCheck(error, lastCatalogPath, sourceUrl, sourcePath) {
  const code = error instanceof AgentHostError ? error.code : 'AGENT_HOST_INTERNAL'
  const message = error instanceof Error ? error.message : String(error)
  return lastCheckRecord({
    status: unpublishedCode(code) ? 'unpublished' : 'error',
    code,
    message,
    recovery: catalogFetchRecovery(code, { lastCatalogPath }),
    sourceUrl,
    sourcePath,
  })
}

export async function checkCatalogSource(options = {}, dependencies = {}) {
  const env = dependencies.env ?? process.env
  const root = resolveStateRoot(options.stateRoot)
  const paths = await prepareStatePaths(root)
  const saved = await readCatalogSource(paths.root)
  const lastCatalogPath = await lastDownloadedCatalog(paths)
  const overrideUrl = typeof options.url === 'string' ? options.url.trim() : ''
  const overrideManifest = typeof options.releaseManifest === 'string' ? options.releaseManifest.trim() : ''
  const candidate = overrideUrl || overrideManifest || catalogSourceCandidate(saved) || envUrl(env) || envManifest(env)
  let record
  try {
    if (candidate === '') {
      const unpublished = await inspectTrackedUnpublished()
      record = lastCheckRecord({
        status: 'unpublished',
        code: 'PREVIEW_DOWNLOAD_UNPUBLISHED',
        message: UNPUBLISHED_ASSETS_NOTE,
        recovery: catalogFetchRecovery('PREVIEW_DOWNLOAD_UNPUBLISHED', { lastCatalogPath }),
        sourcePath: unpublished.path,
      })
    } else if (/^https:\/\//iu.test(candidate)) {
      const url = normalizePreviewDownloadUrl(candidate)
      const fetched = await fetchBoundCatalog(url, {
        downloads: paths.downloads,
        fetch: dependencies.fetch,
        signal: dependencies.signal,
      })
      record = lastCheckRecord({
        status: 'ok',
        code: null,
        message: 'Fetched an unsigned preview catalog. Compare SHA-256 values. This is not notarized and not a store.',
        recovery: catalogFetchRecovery(null, { lastCatalogPath: fetched.manifestPath }),
        sourceUrl: fetched.sourceUrl ?? url,
        sourcePath: fetched.manifestPath,
      })
    } else {
      const local = await inspectLocalCatalog(candidate)
      record = lastCheckRecord({
        status: 'ok',
        code: null,
        message: local.kind === 'preview-index'
          ? 'Local preview index names a bound catalog. This is not notarized and not a store.'
          : `Local bound catalog ${local.release.suiteVersion ?? ''}`.trim(),
        recovery: catalogFetchRecovery(null, { lastCatalogPath: local.path }),
        sourcePath: local.path,
      })
    }
  } catch (error) {
    const sourceUrl = /^https:\/\//iu.test(candidate) ? candidate : null
    const sourcePath = sourceUrl === null && candidate !== '' ? resolve(candidate) : null
    record = failureCheck(error, lastCatalogPath, sourceUrl, sourcePath)
  }
  await writeCatalogSource(paths.root, { ...saved, lastCheck: record })
  return inspectSourceStatus(options, { ...dependencies, env })
}

function assertAbsoluteLocalPath(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AgentHostError('CLI_USAGE', `${label} requires a path`)
  }
  if (!isAbsolute(value)) {
    throw new AgentHostError('CATALOG_SOURCE_INVALID', 'A local catalog path must be absolute')
  }
  return resolve(value)
}

export async function setCatalogSource(options = {}, dependencies = {}) {
  const url = typeof options.url === 'string' ? options.url.trim() : ''
  const manifest = typeof options.releaseManifest === 'string' ? options.releaseManifest.trim() : ''
  if ((url === '') === (manifest === '')) {
    throw new AgentHostError('CLI_USAGE', 'source set requires --url or --release-manifest, not both')
  }
  const root = resolveStateRoot(options.stateRoot)
  let next
  if (url !== '') {
    const normalized = normalizePreviewDownloadUrl(url)
    if (normalized === null) {
      throw new AgentHostError('PREVIEW_DOWNLOAD_INVALID_URL', 'The catalog URL must be HTTPS')
    }
    next = { schemaVersion: CATALOG_SOURCE_SCHEMA, kind: 'https', url: normalized, path: null, lastCheck: null }
  } else {
    next = {
      schemaVersion: CATALOG_SOURCE_SCHEMA,
      kind: 'local',
      url: null,
      path: assertAbsoluteLocalPath(manifest, '--release-manifest'),
      lastCheck: null,
    }
  }
  await writeCatalogSource(root, next)
  return checkCatalogSource(options, dependencies)
}

export async function clearCatalogSource(options = {}, dependencies = {}) {
  const root = resolveStateRoot(options.stateRoot)
  await writeCatalogSource(root, emptySavedSource())
  return inspectSourceStatus(options, dependencies)
}


