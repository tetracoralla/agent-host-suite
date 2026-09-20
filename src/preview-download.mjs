import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { AgentHostError } from './errors.mjs'
import { acquireHttpsFile } from './release-artifacts.mjs'
import { currentReleasePlatform, defaultReleaseManifestPath, RELEASE_SCHEMA } from './release-manifest.mjs'

export const FEATURED_CATALOG_DOWNLOAD_ENV = 'AGENT_HOST_FEATURED_CATALOG_URL'
export const PREVIEW_DISTRIBUTION_SCHEMA = 'openadam.agent-host-preview-distribution.v0.1'
export const PREVIEW_FETCH_SCHEMA = 'openadam.agent-host-preview-fetch.v0.1'
export const GITHUB_RELEASES_URL = 'https://github.com/tetracoralla/agent-host-suite/releases'
export const GITHUB_PREVIEW_INDEX_CONVENTION = `${GITHUB_RELEASES_URL}/latest/download/preview-distribution.json`

export const UNSIGNED_MACOS_GATEKEEPER_NOTE = 'Unsigned macOS builds are not Apple-notarized, and this product does not ship Developer ID signed or App Store builds. After download, Control-click Agent Host.app (or the app inside the DMG), choose Open, then confirm the Gatekeeper warning. That warning is expected for this preview.'
export const WINDOWS_SMARTSCREEN_NOTE = 'Unsigned Windows ZIP packages are not Authenticode-signed. Windows SmartScreen may warn on first open; that warning is expected for this preview. Compare the ZIP to SHA256SUMS before extracting.'
export const PUBLIC_DOWNLOAD_NOT_CONFIGURED_NOTE = 'Public download is not configured. This checkout does not publish GitHub Release assets. After an owner publishes a Release or an HTTPS index, set AGENT_HOST_FEATURED_CATALOG_URL to that preview-distribution.json (or a bound current.json). This is not an app store.'

const PREVIEW_JSON_MAX_BYTES = 1_048_576
const CARRIER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const PREVIEW_DOWNLOAD_CODES = Object.freeze({
  failed: 'PREVIEW_DOWNLOAD_FAILED',
  cancelled: 'PREVIEW_DOWNLOAD_CANCELLED',
  timeout: 'PREVIEW_DOWNLOAD_TIMEOUT',
  stalled: 'PREVIEW_DOWNLOAD_STALLED',
  size: 'PREVIEW_DOWNLOAD_SIZE_MISMATCH',
  digest: 'PREVIEW_DOWNLOAD_DIGEST_MISMATCH',
})

function fail(code, message, details) {
  throw new AgentHostError(code, message, details)
}

function trimEnv(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function exactObject(value, allowed, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('PREVIEW_DOWNLOAD_INVALID', `${label} must be an object`)
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) fail('PREVIEW_DOWNLOAD_INVALID', `${label} contains unsupported fields`, { fields: unexpected })
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail('PREVIEW_DOWNLOAD_INVALID', `${label} must be a non-empty string`)
  return value
}

function optionalHttpsUrl(value, label) {
  if (value === null || value === undefined) return null
  const url = requiredString(value, label)
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    fail('PREVIEW_DOWNLOAD_INVALID', `${label} must be an HTTPS URL`)
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    fail('PREVIEW_DOWNLOAD_INVALID', `${label} must be an HTTPS URL without credentials`)
  }
  return parsed.href
}

function digestValue(value, label) {
  const digest = requiredString(value, label)
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) fail('PREVIEW_DOWNLOAD_INVALID', `${label} is not a SHA-256 digest`)
  return digest
}

function byteSize(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail('PREVIEW_DOWNLOAD_INVALID', `${label} must be a positive byte count`)
  return value
}

function siblingUrl(fileUrl, name) {
  return new URL(name, new URL('.', fileUrl)).href
}

export function normalizePreviewDownloadUrl(value) {
  const raw = trimEnv(value)
  if (raw === '') return null
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    fail('PREVIEW_DOWNLOAD_INVALID_URL', 'The configured download URL is not a valid HTTPS URL')
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    fail('PREVIEW_DOWNLOAD_INVALID_URL', 'Preview downloads must use HTTPS without credentials')
  }
  parsed.hash = ''
  const hostPath = `${parsed.host}${parsed.pathname.replace(/\/$/u, '')}`
  if (hostPath === 'github.com/tetracoralla/agent-host-suite/releases'
    || hostPath === 'github.com/tetracoralla/agent-host-suite/releases/latest') {
    return GITHUB_PREVIEW_INDEX_CONVENTION
  }
  if (parsed.pathname.endsWith('/')) {
    parsed.pathname = `${parsed.pathname}preview-distribution.json`
  }
  return parsed.href
}

export function featuredCatalogDownload(env = process.env) {
  const raw = trimEnv(env[FEATURED_CATALOG_DOWNLOAD_ENV])
  const configured = raw.length > 0
  return {
    env: FEATURED_CATALOG_DOWNLOAD_ENV,
    configured,
    url: configured ? raw : null,
    publicReleasePublished: false,
    unsignedMacOS: true,
    notarized: false,
    marketplace: false,
    githubReleasesUrl: GITHUB_RELEASES_URL,
    indexConvention: GITHUB_PREVIEW_INDEX_CONVENTION,
    gatekeeperNote: UNSIGNED_MACOS_GATEKEEPER_NOTE,
    windowsSmartScreenNote: WINDOWS_SMARTSCREEN_NOTE,
    message: configured
      ? 'Unsigned preview. Not Apple-notarized. Not an app store. Host can fetch the bound catalog from this URL.'
      : `${PUBLIC_DOWNLOAD_NOT_CONFIGURED_NOTE} Non-developers: open ${GITHUB_RELEASES_URL} once an owner publishes an unsigned macOS arm64 DMG (not notarized, not a store). Host also probes ${GITHUB_PREVIEW_INDEX_CONVENTION} on source check.`,
  }
}


/**
 * Probe the public GitHub Releases convention URL for a published
 * preview-distribution.json. Returns null when the asset is absent (404) or
 * still the unpublished placeholder. Does not require AGENT_HOST_FEATURED_CATALOG_URL.
 */
export async function probePublicPreviewIndex(options = {}) {
  const downloads = options.downloads
  if (typeof downloads !== 'string' || downloads.length === 0) {
    fail('PREVIEW_DOWNLOAD_FAILED', 'A private downloads directory is required to probe the public preview index')
  }
  try {
    const document = await fetchPreviewDocument(GITHUB_PREVIEW_INDEX_CONVENTION, downloads, options)
    if (!looksLikePreviewIndex(document.value)) {
      return { found: false, reason: 'invalid', url: GITHUB_PREVIEW_INDEX_CONVENTION, index: null }
    }
    const index = validatePreviewDistribution(document.value)
    if (index.status === 'unpublished' || index.publicReleasePublished !== true) {
      return { found: false, reason: 'unpublished', url: document.url, index }
    }
    if (index.catalog === null && index.carriers.length === 0) {
      return { found: false, reason: 'empty', url: document.url, index }
    }
    return { found: true, reason: 'published', url: document.url, index }
  } catch (error) {
    if (error instanceof AgentHostError) {
      if (error.code === 'PREVIEW_DOWNLOAD_FAILED' && error.details?.status === 404) {
        return { found: false, reason: 'missing', url: GITHUB_PREVIEW_INDEX_CONVENTION, index: null }
      }
      if (error.code === 'PREVIEW_DOWNLOAD_NOT_CONFIGURED' || error.code === 'PREVIEW_DOWNLOAD_INVALID') {
        return { found: false, reason: 'invalid', url: GITHUB_PREVIEW_INDEX_CONVENTION, index: null, error }
      }
    }
    throw error
  }
}


function validateCarrier(carrier) {
  exactObject(carrier, ['platform', 'kind', 'filename', 'url', 'sha256', 'bytes'], 'preview carrier')
  const platform = requiredString(carrier.platform, 'preview carrier platform')
  if (!['darwin-arm64', 'darwin-x86_64', 'win32-x64', 'win32-arm64'].includes(platform)) {
    fail('PREVIEW_DOWNLOAD_INVALID', `Unsupported preview carrier platform: ${platform}`)
  }
  if (!['dmg', 'zip'].includes(carrier.kind)) fail('PREVIEW_DOWNLOAD_INVALID', 'Preview carrier kind must be dmg or zip')
  const filename = requiredString(carrier.filename, 'preview carrier filename')
  if (!CARRIER_NAME.test(filename)) fail('PREVIEW_DOWNLOAD_INVALID', 'Preview carrier filename is not a safe asset name')
  return {
    platform,
    kind: carrier.kind,
    filename,
    url: optionalHttpsUrl(carrier.url, 'preview carrier URL'),
    sha256: digestValue(carrier.sha256, 'preview carrier digest'),
    bytes: byteSize(carrier.bytes, 'preview carrier size'),
  }
}

function validateCatalogPointer(catalog) {
  if (catalog === null) return null
  exactObject(catalog, ['url', 'sha256', 'bytes', 'provenanceUrl', 'provenanceSha256'], 'preview catalog pointer')
  return {
    url: optionalHttpsUrl(catalog.url, 'preview catalog URL'),
    sha256: digestValue(catalog.sha256, 'preview catalog digest'),
    bytes: byteSize(catalog.bytes, 'preview catalog size'),
    provenanceUrl: optionalHttpsUrl(catalog.provenanceUrl ?? null, 'preview provenance URL'),
    provenanceSha256: catalog.provenanceSha256 === undefined || catalog.provenanceSha256 === null
      ? null
      : digestValue(catalog.provenanceSha256, 'preview provenance digest'),
  }
}

export function validatePreviewDistribution(index) {
  exactObject(index, [
    'schemaVersion', 'status', 'notarized', 'marketplace', 'publicReleasePublished',
    'githubReleasesUrl', 'selfHostedIndexUrl', 'gatekeeperNote', 'windowsSmartScreenNote',
    'carriers', 'catalog',
  ], 'preview distribution')
  if (index.schemaVersion !== PREVIEW_DISTRIBUTION_SCHEMA) {
    fail('PREVIEW_DOWNLOAD_INVALID', `Unsupported preview distribution schema: ${index.schemaVersion ?? 'missing'}`)
  }
  if (!['unpublished', 'preview-unsigned'].includes(index.status)) {
    fail('PREVIEW_DOWNLOAD_INVALID', 'Preview distribution status is invalid')
  }
  if (index.notarized !== false) fail('PREVIEW_DOWNLOAD_INVALID', 'Preview distribution cannot claim Apple notarization')
  if (index.marketplace !== false) fail('PREVIEW_DOWNLOAD_INVALID', 'Preview distribution cannot claim a marketplace')
  if (typeof index.publicReleasePublished !== 'boolean') fail('PREVIEW_DOWNLOAD_INVALID', 'publicReleasePublished must be boolean')
  const githubReleasesUrl = optionalHttpsUrl(index.githubReleasesUrl, 'githubReleasesUrl')
  const selfHostedIndexUrl = optionalHttpsUrl(index.selfHostedIndexUrl ?? null, 'selfHostedIndexUrl')
  if (!Array.isArray(index.carriers)) fail('PREVIEW_DOWNLOAD_INVALID', 'Preview carriers must be an array')
  const carriers = index.carriers.map(validateCarrier)
  const platforms = carriers.map((item) => item.platform)
  if (new Set(platforms).size !== platforms.length) fail('PREVIEW_DOWNLOAD_INVALID', 'Preview carriers repeat a platform')
  const catalog = validateCatalogPointer(index.catalog)
  if (index.publicReleasePublished === true && catalog === null && carriers.length === 0) {
    fail('PREVIEW_DOWNLOAD_INVALID', 'A published preview index must name a bound catalog or at least one carrier')
  }
  if (index.status === 'unpublished' && (index.publicReleasePublished === true || catalog !== null || carriers.length > 0)) {
    fail('PREVIEW_DOWNLOAD_INVALID', 'An unpublished preview index cannot advertise assets')
  }
  return {
    schemaVersion: PREVIEW_DISTRIBUTION_SCHEMA,
    status: index.status,
    notarized: false,
    marketplace: false,
    publicReleasePublished: index.publicReleasePublished,
    githubReleasesUrl,
    selfHostedIndexUrl,
    gatekeeperNote: typeof index.gatekeeperNote === 'string' && index.gatekeeperNote.length > 0
      ? index.gatekeeperNote
      : UNSIGNED_MACOS_GATEKEEPER_NOTE,
    windowsSmartScreenNote: typeof index.windowsSmartScreenNote === 'string' && index.windowsSmartScreenNote.length > 0
      ? index.windowsSmartScreenNote
      : WINDOWS_SMARTSCREEN_NOTE,
    carriers,
    catalog,
  }
}

async function downloadJsonFile(url, destination, { expectedBytes, expectedSha256, fetch, signal, label }) {
  const acquired = await acquireHttpsFile({
    url,
    destination,
    expectedBytes: expectedBytes ?? null,
    maxBytes: expectedBytes ?? PREVIEW_JSON_MAX_BYTES,
    expectedSha256: expectedSha256 ?? null,
    fetch,
    signal,
    label,
    codes: PREVIEW_DOWNLOAD_CODES,
  })
  let parsed
  try {
    parsed = JSON.parse(await readFile(acquired.path, 'utf8'))
  } catch {
    fail('PREVIEW_DOWNLOAD_INVALID', `${label} is not valid JSON`)
  }
  return { ...acquired, value: parsed }
}

function looksLikeReleaseManifest(value) {
  return value !== null && typeof value === 'object' && value.schemaVersion === RELEASE_SCHEMA
}

function looksLikePreviewIndex(value) {
  return value !== null && typeof value === 'object' && value.schemaVersion === PREVIEW_DISTRIBUTION_SCHEMA
}

export async function fetchPreviewDocument(url, downloads, options = {}) {
  const normalized = normalizePreviewDownloadUrl(url)
  if (normalized === null) fail('PREVIEW_DOWNLOAD_NOT_CONFIGURED', PUBLIC_DOWNLOAD_NOT_CONFIGURED_NOTE)
  const destination = join(downloads, 'preview-index', 'downloaded.json')
  await rm(destination, { force: true })
  const document = await downloadJsonFile(normalized, destination, {
    fetch: options.fetch ?? globalThis.fetch,
    signal: options.signal,
    label: 'preview index',
  })
  return { url: normalized, ...document }
}

async function materializeCatalogFiles(catalogUrl, pointer, downloads, options) {
  const catalogDir = join(downloads, 'preview-catalog')
  await mkdir(catalogDir, { recursive: true, mode: 0o700 })
  const manifestPath = join(catalogDir, 'current.json')
  const provenancePath = join(catalogDir, 'build-provenance.json')
  const manifest = await downloadJsonFile(catalogUrl, manifestPath, {
    expectedBytes: pointer?.bytes,
    expectedSha256: pointer?.sha256,
    fetch: options.fetch ?? globalThis.fetch,
    signal: options.signal,
    label: 'bound current.json',
  })
  if (!looksLikeReleaseManifest(manifest.value)) {
    fail('PREVIEW_DOWNLOAD_INVALID', 'The configured URL did not return a bound Agent Host release manifest')
  }
  if (manifest.value.status === 'draft-unbound') {
    fail('RELEASE_UNBOUND', 'No verified compatibility release is bound in this download')
  }
  const provenanceUrl = pointer?.provenanceUrl ?? siblingUrl(catalogUrl, 'build-provenance.json')
  try {
    await downloadJsonFile(provenanceUrl, provenancePath, {
      expectedBytes: null,
      expectedSha256: pointer?.provenanceSha256 ?? null,
      fetch: options.fetch ?? globalThis.fetch,
      signal: options.signal,
      label: 'build-provenance.json',
    })
  } catch (error) {
    if (error instanceof AgentHostError && error.code === 'PREVIEW_DOWNLOAD_FAILED' && error.details?.status === 404) {
      fail(
        'PREVIEW_DOWNLOAD_FAILED',
        'The bound catalog downloaded, but build-provenance.json was not found next to current.json',
        { catalogUrl, provenanceUrl },
      )
    }
    throw error
  }
  return { manifestPath, provenancePath, manifest: manifest.value }
}

export async function fetchBoundCatalog(url, options = {}) {
  const downloads = options.downloads
  if (typeof downloads !== 'string' || downloads.length === 0) {
    fail('PREVIEW_DOWNLOAD_FAILED', 'A private downloads directory is required to fetch a remote catalog')
  }
  const document = await fetchPreviewDocument(url, downloads, options)
  if (looksLikePreviewIndex(document.value)) {
    const index = validatePreviewDistribution(document.value)
    if (index.catalog === null) {
      if (options.allowMissingCatalog === true && index.publicReleasePublished === true && index.carriers.length > 0) {
        return { sourceUrl: document.url, index, manifestPath: null, provenancePath: null, manifest: null }
      }
      fail(
        'PREVIEW_DOWNLOAD_NOT_CONFIGURED',
        'The preview index has no bound catalog yet. GitHub Release assets have not been published. This is not an app store.',
        { githubReleasesUrl: index.githubReleasesUrl },
      )
    }
    const catalog = await materializeCatalogFiles(index.catalog.url, index.catalog, downloads, options)
    return { sourceUrl: document.url, index, ...catalog }
  }
  if (looksLikeReleaseManifest(document.value)) {
    const catalog = await materializeCatalogFiles(document.url, null, downloads, options)
    return { sourceUrl: document.url, index: null, ...catalog }
  }
  fail(
    'PREVIEW_DOWNLOAD_INVALID',
    'The configured URL must be preview-distribution.json or a bound current.json, not a GitHub Releases HTML page or an installer',
  )
}

export async function fetchPreviewCarrier(index, downloads, options = {}) {
  let platform
  try {
    platform = currentReleasePlatform()
  } catch (error) {
    if (error instanceof AgentHostError && error.code === 'RELEASE_PLATFORM_UNSUPPORTED') {
      fail(
        'PREVIEW_CARRIER_UNAVAILABLE',
        `No unsigned preview installer is listed for this operating system. Public download is not a store. ${error.message}`,
      )
    }
    throw error
  }
  const carrier = index.carriers.find((item) => item.platform === platform)
  if (carrier === undefined) {
    fail(
      'PREVIEW_CARRIER_UNAVAILABLE',
      `No unsigned preview installer is listed for ${platform}. Public download is not a store; after an owner publishes a Release, the preview index names the DMG or Windows ZIP.`,
      { platform, available: index.carriers.map((item) => item.platform) },
    )
  }
  const destination = join(downloads, 'preview-carriers', carrier.filename)
  const acquired = await acquireHttpsFile({
    url: carrier.url,
    destination,
    expectedBytes: carrier.bytes,
    maxBytes: carrier.bytes,
    expectedSha256: carrier.sha256,
    fetch: options.fetch ?? globalThis.fetch,
    signal: options.signal,
    label: carrier.filename,
    codes: PREVIEW_DOWNLOAD_CODES,
  })
  return { ...acquired, carrier }
}

function isWindowsDrivePath(candidate) {
  // Drive letters are filesystem paths, not URL schemes. The URL-scheme regex below
  // would otherwise treat "C:\\..." as protocol "C:" on Windows runners.
  return /^[A-Za-z]:[\\/]/u.test(candidate)
}

export async function resolveReleaseManifestPath(options = {}, dependencies = {}) {
  const env = dependencies.env ?? process.env
  const explicit = trimEnv(options.releaseManifest)
  const preview = trimEnv(env[FEATURED_CATALOG_DOWNLOAD_ENV])
  const saved = dependencies.savedCatalogSource
  const savedCandidate = saved?.kind === 'https'
    ? trimEnv(saved.url)
    : saved?.kind === 'local'
      ? trimEnv(saved.path)
      : ''
  const candidate = explicit || preview || savedCandidate
  if (candidate === '') return defaultReleaseManifestPath()
  if (/^https:\/\//iu.test(candidate)) {
    const fetched = await fetchBoundCatalog(candidate, {
      downloads: dependencies.paths?.downloads,
      fetch: dependencies.fetch,
      signal: dependencies.signal,
    })
    return fetched.manifestPath
  }
  if (!isWindowsDrivePath(candidate) && /^[a-z][a-z0-9+.-]*:/iu.test(candidate)) {
    fail('PREVIEW_DOWNLOAD_UNSUPPORTED', `Unsupported catalog URL protocol: ${candidate.split(':', 1)[0]}:`)
  }
  return resolve(candidate)
}

export async function fetchPreviewRelease(options = {}, dependencies = {}) {
  const env = dependencies.env ?? process.env
  const explicit = trimEnv(options.url) || trimEnv(env[FEATURED_CATALOG_DOWNLOAD_ENV])
  const requested = explicit || GITHUB_PREVIEW_INDEX_CONVENTION
  if (explicit === '') {
    // Fall through to the public convention URL; fetchBoundCatalog still fails closed when unpublished/missing.
  }
  const downloads = dependencies.paths?.downloads
  let fetched
  try {
    fetched = await fetchBoundCatalog(requested, {
      downloads,
      fetch: dependencies.fetch,
      signal: dependencies.signal,
      allowMissingCatalog: options.carrier === true,
    })
  } catch (error) {
    if (
      explicit === ''
      && error instanceof AgentHostError
      && (error.code === 'PREVIEW_DOWNLOAD_FAILED' || error.code === 'PREVIEW_DOWNLOAD_NOT_CONFIGURED')
    ) {
      fail('PREVIEW_DOWNLOAD_NOT_CONFIGURED', PUBLIC_DOWNLOAD_NOT_CONFIGURED_NOTE, { cause: error.code })
    }
    throw error
  }
  let carrier = null
  if (options.carrier === true) {
    if (fetched.index === null) {
      fail(
        'PREVIEW_CARRIER_UNAVAILABLE',
        'A bound current.json does not list Host installers. Point AGENT_HOST_FEATURED_CATALOG_URL at preview-distribution.json to download a DMG or Windows ZIP.',
      )
    }
    carrier = await fetchPreviewCarrier(fetched.index, downloads, dependencies)
  }
  return {
    schemaVersion: PREVIEW_FETCH_SCHEMA,
    status: 'ok',
    notarized: false,
    marketplace: false,
    publicReleasePublished: fetched.index?.publicReleasePublished === true,
    sourceUrl: fetched.sourceUrl,
    githubReleasesUrl: fetched.index?.githubReleasesUrl ?? GITHUB_RELEASES_URL,
    catalogPath: fetched.manifestPath,
    provenancePath: fetched.provenancePath,
    carrierPath: carrier?.path ?? null,
    carrier: carrier?.carrier ?? null,
    index: fetched.index,
    gatekeeperNote: fetched.index?.gatekeeperNote ?? UNSIGNED_MACOS_GATEKEEPER_NOTE,
    windowsSmartScreenNote: fetched.index?.windowsSmartScreenNote ?? WINDOWS_SMARTSCREEN_NOTE,
    message: 'Fetched an unsigned preview catalog. Compare SHA-256 values; macOS still needs Control-click → Open. This is not notarized and not an app store.',
  }
}
