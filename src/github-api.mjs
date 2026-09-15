import { AgentHostError } from './errors.mjs'

export const GITHUB_API_ACCEPT = 'application/vnd.github+json'
export const GITHUB_USER_AGENT = 'openAdam-agent-host-suite'
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const SHA256_HEX = /^[0-9a-f]{64}$/u

function fail(code, message, details) {
  throw new AgentHostError(code, message, details)
}

export function parseGitHubResource(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('GITHUB_URL_INVALID', 'A GitHub project or Release URL is required')
  }
  const raw = value.trim()
  if (REPOSITORY.test(raw)) {
    const [owner, repo] = raw.split('/')
    return { owner, repo, repository: `${owner}/${repo}`, tag: null, assetName: null, kind: 'repository' }
  }
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    fail('GITHUB_URL_INVALID', 'The GitHub project must be an HTTPS github.com URL or owner/repo')
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    fail('GITHUB_URL_INVALID', 'GitHub project URLs must use HTTPS without credentials')
  }
  if (parsed.hostname !== 'github.com' && parsed.hostname !== 'www.github.com') {
    fail('GITHUB_URL_INVALID', 'Only github.com project URLs are accepted')
  }
  const parts = parsed.pathname.replace(/^\/|\/$/gu, '').split('/').filter(Boolean)
  if (parts.length < 2) fail('GITHUB_URL_INVALID', 'The GitHub URL does not name a repository')
  const owner = parts[0]
  const repo = parts[1].replace(/\.git$/u, '')
  if (!REPOSITORY.test(`${owner}/${repo}`)) fail('GITHUB_URL_INVALID', 'The GitHub repository identity is invalid')
  let tag = null
  let assetName = null
  let kind = 'repository'
  if (parts[2] === 'releases' && parts[3] === 'tag' && typeof parts[4] === 'string') {
    tag = decodeURIComponent(parts[4])
    kind = 'release'
  } else if (parts[2] === 'releases' && parts[3] === 'download' && typeof parts[4] === 'string' && typeof parts[5] === 'string') {
    tag = decodeURIComponent(parts[4])
    assetName = decodeURIComponent(parts[5])
    if (!ASSET_NAME.test(assetName)) fail('GITHUB_URL_INVALID', 'The GitHub release asset name is not a safe file name')
    kind = 'asset'
  } else if (parts[2] === 'releases' && (parts[3] === undefined || parts[3] === 'latest')) {
    kind = 'releases'
  } else if (parts.length > 2 && parts[2] !== 'tree' && parts[2] !== 'blob') {
    fail('GITHUB_URL_INVALID', 'The GitHub URL is not a repository, Release, or Release asset')
  }
  return { owner, repo, repository: `${owner}/${repo}`, tag, assetName, kind }
}

export function githubApiUrl(path) {
  return `https://api.github.com${path}`
}

export function githubReleaseAssetUrl(repository, tag, assetName) {
  if (!REPOSITORY.test(repository) || typeof tag !== 'string' || tag.length === 0 || !ASSET_NAME.test(assetName)) {
    fail('GITHUB_URL_INVALID', 'GitHub release asset coordinates are invalid')
  }
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`
}

export function parseSha256File(text, expectedName = null) {
  if (typeof text !== 'string' || text.trim() === '') fail('GITHUB_CHECKSUM_INVALID', 'The GitHub checksum file is empty')
  const line = text.trim().split(/\r?\n/u)[0].trim()
  const match = line.match(/^([0-9a-fA-F]{64})(?:\s+\*?(\S+))?$/u)
  if (match === null) fail('GITHUB_CHECKSUM_INVALID', 'The GitHub checksum file is not a SHA-256 digest')
  const digest = match[1].toLowerCase()
  if (!SHA256_HEX.test(digest)) fail('GITHUB_CHECKSUM_INVALID', 'The GitHub checksum file is not a SHA-256 digest')
  const name = match[2] ?? null
  if (expectedName !== null && name !== null && name !== expectedName && name !== `./${expectedName}`) {
    fail('GITHUB_CHECKSUM_INVALID', 'The GitHub checksum file names a different asset')
  }
  return { sha256: `sha256:${digest}`, assetName: name }
}

async function readGithubJson(url, { fetch = globalThis.fetch, signal } = {}) {
  let response
  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal,
      headers: {
        accept: GITHUB_API_ACCEPT,
        'user-agent': GITHUB_USER_AGENT,
      },
    })
  } catch (error) {
    fail('GITHUB_NETWORK', `GitHub could not be reached${error instanceof Error ? `: ${error.message}` : ''}`)
  }
  if (response.status === 403 || response.status === 429) {
    fail('GITHUB_RATE_LIMITED', 'GitHub rate-limited this unauthenticated request. Retry later; public catalog pins still work without a token.', {
      status: response.status,
    })
  }
  if (response.status === 404) fail('GITHUB_NOT_FOUND', 'The GitHub project or Release was not found', { status: 404 })
  if (!response.ok) fail('GITHUB_REQUEST_FAILED', 'GitHub returned an unexpected status', { status: response.status })
  const contentType = String(response.headers.get('content-type') ?? '')
  if (!contentType.includes('json')) fail('GITHUB_REQUEST_FAILED', 'GitHub did not return JSON metadata')
  const text = await response.text()
  if (text.length > 2 * 1024 * 1024) fail('GITHUB_REQUEST_FAILED', 'GitHub metadata exceeded the supported size')
  try {
    return JSON.parse(text)
  } catch {
    fail('GITHUB_REQUEST_FAILED', 'GitHub metadata is not valid JSON')
  }
}

function releaseSummary(release) {
  if (release === null || typeof release !== 'object' || Array.isArray(release)) {
    fail('GITHUB_RELEASE_INVALID', 'GitHub Release metadata is invalid')
  }
  const tag = typeof release.tag_name === 'string' ? release.tag_name : ''
  if (tag.length === 0) fail('GITHUB_RELEASE_INVALID', 'GitHub Release is missing a tag')
  const assets = Array.isArray(release.assets) ? release.assets.map((asset) => {
    if (asset === null || typeof asset !== 'object') fail('GITHUB_RELEASE_INVALID', 'GitHub Release asset metadata is invalid')
    const name = typeof asset.name === 'string' ? asset.name : ''
    if (!ASSET_NAME.test(name)) fail('GITHUB_RELEASE_INVALID', 'GitHub Release asset name is not a safe file name')
    const url = typeof asset.browser_download_url === 'string' ? asset.browser_download_url : ''
    if (!url.startsWith('https://')) fail('GITHUB_RELEASE_INVALID', 'GitHub Release asset URL must be HTTPS')
    const bytes = Number.isSafeInteger(asset.size) ? asset.size : null
    return {
      name,
      url,
      bytes,
      contentType: typeof asset.content_type === 'string' ? asset.content_type : null,
    }
  }) : []
  return {
    tag,
    name: typeof release.name === 'string' && release.name.length > 0 ? release.name : tag,
    htmlUrl: typeof release.html_url === 'string' ? release.html_url : null,
    body: typeof release.body === 'string' ? release.body.slice(0, 4000) : '',
    prerelease: release.prerelease === true,
    draft: release.draft === true,
    publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
    targetCommit: typeof release.target_commitish === 'string' ? release.target_commitish : null,
    assets,
  }
}

export async function fetchGitHubRepository(repository, options = {}) {
  const parsed = parseGitHubResource(repository)
  const repo = await readGithubJson(githubApiUrl(`/repos/${parsed.repository}`), options)
  const owner = repo?.owner && typeof repo.owner === 'object' ? repo.owner : {}
  return {
    repository: parsed.repository,
    name: typeof repo.name === 'string' ? repo.name : parsed.repo,
    description: typeof repo.description === 'string' && repo.description.length > 0 ? repo.description.slice(0, 180) : null,
    htmlUrl: typeof repo.html_url === 'string' ? repo.html_url : `https://github.com/${parsed.repository}`,
    homepage: typeof repo.homepage === 'string' && repo.homepage.startsWith('https://') ? repo.homepage : null,
    license: typeof repo.license?.spdx_id === 'string' ? repo.license.spdx_id : null,
    owner: {
      login: typeof owner.login === 'string' ? owner.login : parsed.owner,
      htmlUrl: typeof owner.html_url === 'string' ? owner.html_url : `https://github.com/${parsed.owner}`,
      avatarUrl: typeof owner.avatar_url === 'string' && owner.avatar_url.startsWith('https://') ? owner.avatar_url : null,
    },
  }
}

export async function fetchGitHubRelease(repository, tag, options = {}) {
  const parsed = parseGitHubResource(repository)
  if (tag === 'latest' || tag === null || tag === undefined) {
    return releaseSummary(await readGithubJson(githubApiUrl(`/repos/${parsed.repository}/releases/latest`), options))
  }
  return releaseSummary(await readGithubJson(
    githubApiUrl(`/repos/${parsed.repository}/releases/tags/${encodeURIComponent(tag)}`),
    options,
  ))
}

export async function fetchGitHubReleases(repository, { fetch, signal, channel = 'stable' } = {}) {
  const parsed = parseGitHubResource(repository)
  const releases = await readGithubJson(githubApiUrl(`/repos/${parsed.repository}/releases?per_page=30`), { fetch, signal })
  if (!Array.isArray(releases)) fail('GITHUB_RELEASE_INVALID', 'GitHub Release list is invalid')
  const summaries = releases.map(releaseSummary).filter((item) => item.draft !== true)
  if (channel === 'preview') return summaries.filter((item) => item.prerelease === true)
  return summaries.filter((item) => item.prerelease !== true)
}

export function selectReleaseAsset(release, { assetName = null, platform = null, namePattern = null } = {}) {
  const assets = release?.assets ?? []
  if (assetName !== null) {
    const exact = assets.find((asset) => asset.name === assetName)
    if (exact === undefined) fail('GITHUB_ASSET_UNAVAILABLE', 'The GitHub Release does not include the named asset', { assetName })
    return exact
  }
  const pluginArchives = assets.filter((asset) => asset.name.endsWith('.tar.gz') && !asset.name.endsWith('.sha256.tar.gz'))
  if (typeof namePattern === 'string') {
    const match = pluginArchives.find((asset) => asset.name === namePattern)
    if (match !== undefined) return match
  }
  if (typeof platform === 'string') {
    const token = platform.replace('darwin-', 'macos-').replace('win32-', 'windows-')
    const match = pluginArchives.find((asset) => asset.name.includes(token) || asset.name.includes(platform))
    if (match !== undefined) return match
  }
  if (pluginArchives.length === 1) return pluginArchives[0]
  fail('GITHUB_ASSET_UNAVAILABLE', 'This GitHub Release has no installable archive for the current platform')
}
