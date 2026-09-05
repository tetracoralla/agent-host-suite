import { posix, win32 } from 'node:path'
import { arch, platform } from 'node:os'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readJson } from './json.mjs'
import { AgentHostError } from './errors.mjs'
import { isDeveloperKitIntegrationSchema, validateDeveloperKitIntegration } from './developer-kit-integration.mjs'
import { isToolIntegrationSchema, validateToolIntegration } from './tool-integration.mjs'

export const RELEASE_SCHEMA = 'openadam.agent-host-release.v0.2'
export const COMPONENT_SCHEMA = 'openadam.agent-host-component.v0.1'
export const REQUIRED_RELEASE_COMPONENTS = ['node-runtime', 'direct-execution-runtime', 'math-anchor', 'migratory-time']
export const OBSERVABILITY_RELEASE_COMPONENTS = ['agent-tool-observer', 'context-surface-analyzer']

const SUITE_VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?$/u

const COMPONENT_KINDS = new Map([
  ['node-runtime', 'node-runtime'],
  ['direct-execution-runtime', 'direct-runtime'],
  ['math-anchor', 'math-anchor'],
  ['migratory-time', 'migratory-time'],
  ['agent-tool-observer', 'agent-tool-observer'],
  ['context-surface-analyzer', 'context-surface-analyzer'],
  ['agent-tool-development-kit', 'developer-kit'],
])

function expectedComponentKind(id) {
  return COMPONENT_KINDS.get(id) ?? 'agent-tool'
}

function fail(code, message, details) {
  throw new AgentHostError(code, message, details)
}

function compareNumericIdentifier(left, right) {
  const normalizedLeft = left.replace(/^0+(?=\d)/u, '')
  const normalizedRight = right.replace(/^0+(?=\d)/u, '')
  if (normalizedLeft.length !== normalizedRight.length) return normalizedLeft.length < normalizedRight.length ? -1 : 1
  return normalizedLeft === normalizedRight ? 0 : normalizedLeft < normalizedRight ? -1 : 1
}

export function compareSuiteVersions(left, right) {
  const leftMatch = String(left).match(SUITE_VERSION_PATTERN)
  const rightMatch = String(right).match(SUITE_VERSION_PATTERN)
  if (leftMatch === null || rightMatch === null) fail('RELEASE_MANIFEST_INVALID', 'Suite version comparison requires valid semantic versions')
  for (let index = 1; index <= 3; index += 1) {
    const comparison = compareNumericIdentifier(leftMatch[index], rightMatch[index])
    if (comparison !== 0) return comparison
  }
  const leftPrerelease = leftMatch[4]?.split('.') ?? null
  const rightPrerelease = rightMatch[4]?.split('.') ?? null
  if (leftPrerelease === null || rightPrerelease === null) {
    if (leftPrerelease === rightPrerelease) return 0
    return leftPrerelease === null ? 1 : -1
  }
  const length = Math.max(leftPrerelease.length, rightPrerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = leftPrerelease[index]
    const rightIdentifier = rightPrerelease[index]
    if (leftIdentifier === undefined || rightIdentifier === undefined) return leftIdentifier === undefined ? -1 : 1
    if (leftIdentifier === rightIdentifier) continue
    const leftNumeric = /^\d+$/u.test(leftIdentifier)
    const rightNumeric = /^\d+$/u.test(rightIdentifier)
    if (leftNumeric && rightNumeric) return compareNumericIdentifier(leftIdentifier, rightIdentifier)
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftIdentifier < rightIdentifier ? -1 : 1
  }
  return 0
}

function exactKeys(value, allowed, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('RELEASE_MANIFEST_INVALID', `${label} must be an object`)
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) fail('RELEASE_MANIFEST_INVALID', `${label} contains unsupported fields`, { fields: unexpected })
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail('RELEASE_MANIFEST_INVALID', `${label} must be a non-empty string`)
  return value
}

export function currentReleasePlatform(platformName = platform(), architecture = arch()) {
  const value = `${platformName}-${architecture}`
  if (!['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64'].includes(value)) {
    fail('RELEASE_PLATFORM_UNSUPPORTED', `No Agent Host release is available for ${value}`)
  }
  return value === 'darwin-x64' ? 'darwin-x86_64' : value
}

export function defaultReleaseManifestPath() {
  return fileURLToPath(new URL('../catalog/releases/current.json', import.meta.url))
}

function validateArtifactUrl(value, status) {
  requiredString(value, 'component artifact URL')
  if (status === 'published') {
    let parsed
    try {
      parsed = new URL(value)
    } catch {
      fail('RELEASE_MANIFEST_INVALID', 'Published component artifact URLs must be absolute HTTPS URLs')
    }
    if (parsed.protocol !== 'https:') fail('RELEASE_MANIFEST_INVALID', 'Published component artifact URLs must use HTTPS')
    return
  }
  if (value.includes('\\')) fail('RELEASE_MANIFEST_INVALID', 'Component artifact URLs cannot contain backslashes')
  const parsed = new URL(value, 'file:///release-manifest/')
  if (!['file:', 'https:'].includes(parsed.protocol)) fail('RELEASE_MANIFEST_INVALID', `Unsupported component artifact protocol: ${parsed.protocol}`)
  if (parsed.protocol === 'file:' && !value.startsWith('file:')) {
    const normalized = normalize(value)
    if (isAbsolute(normalized) || normalized === '..' || normalized.startsWith(`..${sep}`)) {
      fail('RELEASE_MANIFEST_INVALID', 'Relative component artifact URLs must remain beneath the release catalog')
    }
  }
}

function validateComponent(component, status) {
  exactKeys(component, ['id', 'version', 'platform', 'artifact', 'descriptorSha256', 'license'], 'release component')
  requiredString(component.id, 'component id')
  requiredString(component.version, `${component.id} version`)
  requiredString(component.platform, `${component.id} platform`)
  exactKeys(component.artifact, ['url', 'sha256', 'bytes', 'format'], `${component.id} artifact`)
  validateArtifactUrl(component.artifact.url, status)
  if (!/^sha256:[0-9a-f]{64}$/u.test(component.artifact.sha256 ?? '')) fail('RELEASE_MANIFEST_INVALID', `${component.id} artifact digest is invalid`)
  if (!Number.isSafeInteger(component.artifact.bytes) || component.artifact.bytes <= 0) fail('RELEASE_MANIFEST_INVALID', `${component.id} artifact size is invalid`)
  if (component.artifact.format !== 'tar.gz') fail('RELEASE_MANIFEST_INVALID', `${component.id} artifact format is unsupported`)
  if (!/^sha256:[0-9a-f]{64}$/u.test(component.descriptorSha256 ?? '')) fail('RELEASE_MANIFEST_INVALID', `${component.id} descriptor digest is invalid`)
  exactKeys(component.license, ['spdx', 'files'], `${component.id} license`)
  requiredString(component.license.spdx, `${component.id} SPDX license`)
  if (!Array.isArray(component.license.files) || component.license.files.length === 0 || component.license.files.some((item) => typeof item !== 'string' || item.length === 0)) {
    fail('RELEASE_MANIFEST_INVALID', `${component.id} license files are invalid`)
  }
}

export function validateReleaseManifest(manifest) {
  exactKeys(manifest, ['schemaVersion', 'releaseId', 'suiteVersion', 'status', 'createdAt', 'platforms', 'components'], 'release manifest')
  if (manifest.schemaVersion !== RELEASE_SCHEMA) fail('RELEASE_SCHEMA_UNSUPPORTED', `Unsupported release schema: ${manifest.schemaVersion ?? 'missing'}`)
  requiredString(manifest.releaseId, 'release id')
  if (!SUITE_VERSION_PATTERN.test(manifest.suiteVersion ?? '')) fail('RELEASE_MANIFEST_INVALID', 'Suite version is invalid')
  if (!['draft-unbound', 'internal-beta', 'published'].includes(manifest.status)) fail('RELEASE_MANIFEST_INVALID', 'Release status is invalid')
  requiredString(manifest.createdAt, 'release creation time')
  if (Number.isNaN(Date.parse(manifest.createdAt))) fail('RELEASE_MANIFEST_INVALID', 'Release creation time is invalid')
  if (!Array.isArray(manifest.platforms) || manifest.platforms.length === 0 || new Set(manifest.platforms).size !== manifest.platforms.length) fail('RELEASE_MANIFEST_INVALID', 'Release platforms are invalid')
  if (!Array.isArray(manifest.components)) fail('RELEASE_MANIFEST_INVALID', 'Release components must be an array')
  if (manifest.status === 'draft-unbound') {
    if (manifest.components.length !== 0) fail('RELEASE_MANIFEST_INVALID', 'An unbound release cannot contain components')
    return manifest
  }
  for (const component of manifest.components) validateComponent(component, manifest.status)
  const selected = manifest.components.filter((item) => item.platform === currentReleasePlatform())
  const ids = selected.map((item) => item.id).sort()
  const missing = REQUIRED_RELEASE_COMPONENTS.filter((id) => !ids.includes(id))
  const invalid = ids.filter((id) => !/^[a-z][a-z0-9-]*$/u.test(id))
  const observabilityCount = OBSERVABILITY_RELEASE_COMPONENTS.filter((id) => ids.includes(id)).length
  if (new Set(ids).size !== ids.length || missing.length > 0 || invalid.length > 0 || ![0, OBSERVABILITY_RELEASE_COMPONENTS.length].includes(observabilityCount)) {
    fail('RELEASE_COMPONENT_SET_INVALID', 'The release does not contain one complete component set for this platform', {
      required: REQUIRED_RELEASE_COMPONENTS,
      optionalTogether: OBSERVABILITY_RELEASE_COMPONENTS,
      invalid,
      actual: ids,
    })
  }
  return manifest
}

export async function loadReleaseManifest(path = defaultReleaseManifestPath()) {
  const absolute = resolve(path)
  const manifest = await readJson(absolute)
  if (manifest === null) fail('RELEASE_MANIFEST_UNAVAILABLE', `Release manifest is unavailable: ${absolute}`)
  validateReleaseManifest(manifest)
  return { path: absolute, manifest }
}

export function selectedReleaseComponents(manifest) {
  const selected = manifest.components.filter((item) => item.platform === currentReleasePlatform())
  return new Map(selected.map((item) => [item.id, item]))
}

export function installDirectoryName(component) {
  return `${component.version}-${component.artifact.sha256.slice('sha256:'.length, 'sha256:'.length + 16)}`
}

export function resolveArtifactUrl(manifestPath, value) {
  if (/^https:\/\//u.test(value) || /^file:/u.test(value)) return new URL(value)
  const base = new URL('./', pathToFileURL(manifestPath))
  const resolved = new URL(value, base)
  const root = resolve(dirname(manifestPath))
  const target = resolve(fileURLToPath(resolved))
  const relation = relative(root, target)
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) fail('RELEASE_MANIFEST_INVALID', 'Artifact path escapes the release catalog')
  return resolved
}

function relativePath(value, label) {
  requiredString(value, label)
  if (value.includes('\\')) fail('COMPONENT_DESCRIPTOR_INVALID', `${label} cannot contain backslashes`)
  const normalized = posix.normalize(value)
  if ((posix.isAbsolute(normalized) || win32.isAbsolute(normalized)) || normalized === '..' || normalized.startsWith('../') || normalized === '.') fail('COMPONENT_DESCRIPTOR_INVALID', `${label} must be a contained relative file path`)
  return normalized
}

export function validateComponentDescriptor(descriptor, releaseComponent) {
  exactKeys(descriptor, ['schemaVersion', 'id', 'version', 'kind', 'files', 'identityFiles', 'entrypoints', 'integration', 'legal'], 'component descriptor')
  if (descriptor.schemaVersion !== COMPONENT_SCHEMA) fail('COMPONENT_DESCRIPTOR_INVALID', `Unsupported component descriptor schema: ${descriptor.schemaVersion ?? 'missing'}`)
  if (descriptor.id !== releaseComponent.id || descriptor.version !== releaseComponent.version) fail('COMPONENT_DESCRIPTOR_INVALID', 'Component descriptor identity differs from the release manifest')
  if (descriptor.kind !== expectedComponentKind(descriptor.id)) fail('COMPONENT_DESCRIPTOR_INVALID', `Unexpected component kind for ${descriptor.id}`)
  if (!Array.isArray(descriptor.files) || descriptor.files.length === 0) fail('COMPONENT_DESCRIPTOR_INVALID', `${descriptor.id} has no files`)
  const paths = new Set()
  for (const item of descriptor.files) {
    exactKeys(item, ['path', 'sha256', 'bytes', 'executable'], `${descriptor.id} file`)
    const path = relativePath(item.path, `${descriptor.id} file path`)
    if (paths.has(path)) fail('COMPONENT_DESCRIPTOR_INVALID', `${descriptor.id} repeats file ${path}`)
    paths.add(path)
    if (!/^sha256:[0-9a-f]{64}$/u.test(item.sha256 ?? '') || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || typeof item.executable !== 'boolean') fail('COMPONENT_DESCRIPTOR_INVALID', `${descriptor.id} file metadata is invalid`)
  }
  if (!Array.isArray(descriptor.identityFiles) || descriptor.identityFiles.length === 0) fail('COMPONENT_DESCRIPTOR_INVALID', `${descriptor.id} identity files are missing`)
  for (const path of descriptor.identityFiles) if (!paths.has(relativePath(path, `${descriptor.id} identity file`))) fail('COMPONENT_DESCRIPTOR_INVALID', `${descriptor.id} identity file is not in its file inventory: ${path}`)
  exactKeys(descriptor.entrypoints, Object.keys(descriptor.entrypoints), `${descriptor.id} entrypoints`)
  for (const [name, path] of Object.entries(descriptor.entrypoints)) if (!paths.has(relativePath(path, `${descriptor.id} ${name} entrypoint`))) fail('COMPONENT_DESCRIPTOR_INVALID', `${descriptor.id} entrypoint is not in its file inventory: ${path}`)
  exactKeys(descriptor.legal, ['license', 'notice', 'thirdPartyNotices', 'sbom'], `${descriptor.id} legal metadata`)
  for (const [name, path] of Object.entries(descriptor.legal)) if (!paths.has(relativePath(path, `${descriptor.id} ${name}`))) fail('COMPONENT_DESCRIPTOR_INVALID', `${descriptor.id} legal file is not in its file inventory: ${path}`)
  for (const path of releaseComponent.license.files) if (!paths.has(relativePath(path, `${descriptor.id} release license file`))) fail('COMPONENT_DESCRIPTOR_INVALID', `${descriptor.id} release license file is not in its file inventory: ${path}`)
  if (descriptor.integration !== null && (typeof descriptor.integration !== 'object' || Array.isArray(descriptor.integration))) fail('COMPONENT_DESCRIPTOR_INVALID', `${descriptor.id} integration metadata is invalid`)
  if (descriptor.kind === 'agent-tool' || isToolIntegrationSchema(descriptor.integration?.schemaVersion)) {
    validateToolIntegration(descriptor.integration, paths)
  }
  if (descriptor.kind === 'developer-kit' || isDeveloperKitIntegrationSchema(descriptor.integration?.schemaVersion)) {
    validateDeveloperKitIntegration(descriptor.integration, paths)
  }
  return descriptor
}

export function containedComponentPath(root, value, label) {
  const normalized = relativePath(value, label)
  const target = join(root, normalized)
  const relation = relative(root, target)
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) fail('COMPONENT_DESCRIPTOR_INVALID', `${label} escapes the installed component`)
  return target
}
