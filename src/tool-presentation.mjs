import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, join, posix } from 'node:path'
import { AgentHostError } from './errors.mjs'
import { integrationRelativePath } from './tool-integration.mjs'

export const LOGO_MAX_BYTES = 256 * 1024
export const REMOTE_IMAGE_MAX_BYTES = 512 * 1024
const LOGO_MEDIA = new Map([
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
])
const WELL_KNOWN_LOGOS = [
  'logo.svg', 'logo.png', 'icon.svg', 'icon.png',
  'assets/logo.svg', 'assets/logo.png', 'assets/icon.svg', 'assets/icon.png',
]

function fail(code, message, details) {
  throw new AgentHostError(code, message, details)
}

function stringField(value, maximum) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maximum
    ? value.trim()
    : null
}

function authorField(value) {
  if (typeof value === 'string') return stringField(value, 120)
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return stringField(value.name, 120)
  }
  return null
}

function homepageField(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return null
    return parsed.href
  } catch {
    return null
  }
}

export function sanitizeSvg(text) {
  if (typeof text !== 'string' || text.length === 0) fail('TOOL_LOGO_INVALID', 'SVG logo is empty')
  if (text.length > LOGO_MAX_BYTES) fail('TOOL_LOGO_INVALID', 'SVG logo exceeds the supported size')
  if (/<script[\s>]/iu.test(text)
    || /on[a-z]+\s*=/iu.test(text)
    || /<foreignObject[\s>]/iu.test(text)
    || /<\?xml-stylesheet/iu.test(text)
    || /(?:xlink:)?href\s*=\s*["']\s*(?:https?:|javascript:|data:)/iu.test(text)
    || /url\(\s*["']?(?:https?:|javascript:)/iu.test(text)) {
    fail('TOOL_LOGO_INVALID', 'SVG logo may not include scripts, event handlers, or external references')
  }
  return text
}

export function logoMediaType(path) {
  return LOGO_MEDIA.get(extname(path).toLowerCase()) ?? null
}

export function presentationFromPackageMetadata({
  packageJson = null,
  pluginJson = null,
  hostIntegration = null,
  files = [],
} = {}) {
  const openadam = packageJson?.openadam !== null && typeof packageJson?.openadam === 'object' && !Array.isArray(packageJson.openadam)
    ? packageJson.openadam
    : {}
  const displayName = stringField(hostIntegration?.displayName, 80)
    ?? stringField(openadam.displayName, 80)
    ?? stringField(pluginJson?.interface?.displayName, 80)
    ?? stringField(pluginJson?.displayName, 80)
    ?? stringField(packageJson?.displayName, 80)
    ?? stringField(pluginJson?.name, 80)
    ?? stringField(packageJson?.name, 80)
    ?? 'Agent tool'
  const summary = stringField(hostIntegration?.summary, 180)
    ?? stringField(openadam.summary, 180)
    ?? stringField(pluginJson?.interface?.shortDescription, 180)
    ?? stringField(packageJson?.description, 180)
    ?? 'Installed Agent tool'
  const author = authorField(openadam.author) ?? authorField(packageJson?.author)
  const homepage = homepageField(openadam.homepage) ?? homepageField(packageJson?.homepage)
  const license = stringField(openadam.license, 80)
    ?? stringField(packageJson?.license, 80)
    ?? stringField(pluginJson?.license, 80)
  const declaredLogo = stringField(openadam.logo, 200)
    ?? stringField(pluginJson?.logo, 200)
    ?? stringField(packageJson?.logo, 200)
    ?? WELL_KNOWN_LOGOS.find((path) => files.includes(path))
    ?? null
  return {
    displayName: displayName.slice(0, 80),
    summary: summary.slice(0, 180),
    ...(author === null ? {} : { author }),
    ...(homepage === null ? {} : { homepage }),
    ...(license === null ? {} : { license }),
    logoPath: declaredLogo,
  }
}

export function bindPresentationLogo(presentation, { pluginRoot, files, digest, bytes, mediaType }) {
  if (presentation.logoPath === null || presentation.logoPath === undefined) {
    const { logoPath: _logoPath, ...rest } = presentation
    return rest
  }
  let path
  try {
    path = integrationRelativePath(presentation.logoPath, 'tool logo')
  } catch {
    const { logoPath: _logoPath, ...rest } = presentation
    return rest
  }
  if (!files.has(path) && !files.has(`${pluginRoot}/${path}`)) {
    const { logoPath: _logoPath, ...rest } = presentation
    return rest
  }
  const relative = files.has(path) ? path : `${pluginRoot}/${path}`
  const type = mediaType ?? logoMediaType(relative)
  if (type === null || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > LOGO_MAX_BYTES || !/^sha256:[0-9a-f]{64}$/u.test(digest ?? '')) {
    const { logoPath: _logoPath, ...rest } = presentation
    return rest
  }
  const { logoPath: _logoPath, ...rest } = presentation
  return {
    ...rest,
    logo: { path: relative, sha256: digest, bytes, mediaType: type },
  }
}

export async function presentInstalledLogo(component, fallback = null) {
  const logo = component?.logo ?? fallback
  if (logo === null || logo === undefined) return logo ?? null
  if (typeof component?.root !== 'string' || typeof logo.path !== 'string') return logo
  try {
    const verified = await readVerifiedLogoBytes(component.root, logo)
    if (verified === null) return logo
    return {
      ...logo,
      absolutePath: join(component.root, ...String(logo.path).split('/')),
      bytes: verified.bytes.length,
      mediaType: verified.mediaType,
      sha256: logo.sha256,
    }
  } catch {
    return logo
  }
}

export async function readVerifiedLogoBytes(root, logo) {
  if (logo === null || logo === undefined) return null
  const relative = posix.normalize(logo.path)
  if (relative.startsWith('..') || posix.isAbsolute(relative)) fail('TOOL_LOGO_INVALID', 'Tool logo path must stay inside the package')
  const bytes = await readFile(new URL(relative, `file://${root.replace(/\/$/u, '/')}/`)).catch(() => {
    fail('TOOL_LOGO_INVALID', 'Tool logo file is missing')
  })
  if (bytes.length !== logo.bytes) fail('TOOL_LOGO_INVALID', 'Tool logo size does not match its digest record')
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  if (digest !== logo.sha256) fail('TOOL_LOGO_INVALID', 'Tool logo does not match its SHA-256')
  if (logo.mediaType === 'image/svg+xml') sanitizeSvg(bytes.toString('utf8'))
  return { bytes, mediaType: logo.mediaType }
}

export function fallbackPresentation(id) {
  return {
    displayName: String(id ?? 'Agent tool'),
    summary: 'Installed Agent tool',
  }
}

export async function fetchRemotePreviewImage(url, { fetch = globalThis.fetch, signal, maxBytes = REMOTE_IMAGE_MAX_BYTES } = {}) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    fail('TOOL_LOGO_INVALID', 'Remote logo URL is invalid')
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    fail('TOOL_LOGO_INVALID', 'Remote logos must use HTTPS without credentials')
  }
  const response = await fetch(parsed, { method: 'GET', redirect: 'follow', signal, headers: { accept: 'image/*' } })
  if (!response.ok) fail('TOOL_LOGO_INVALID', 'Remote logo could not be downloaded', { status: response.status })
  const contentType = String(response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/gif'].includes(contentType)) {
    fail('TOOL_LOGO_INVALID', 'Remote logo content type is not a supported image')
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length < 1 || buffer.length > maxBytes) fail('TOOL_LOGO_INVALID', 'Remote logo exceeds the supported size')
  if (contentType === 'image/svg+xml') sanitizeSvg(buffer.toString('utf8'))
  return {
    bytes: buffer,
    mediaType: contentType,
    sha256: `sha256:${createHash('sha256').update(buffer).digest('hex')}`,
  }
}
