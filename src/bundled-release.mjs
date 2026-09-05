import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, lstat, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { AgentHostError } from './errors.mjs'
import { loadProfile } from './profile.mjs'
import { loadReleaseManifest, validateReleaseManifest } from './release-manifest.mjs'
import { loadBuildProvenance, validateBuildProvenance } from './release-provenance.mjs'

function containedArtifact(sourceRoot, value) {
  if (/^https:\/\//u.test(value) || /^file:/u.test(value)) return null
  const normalized = normalize(value)
  if (isAbsolute(normalized)) throw new AgentHostError('BUNDLED_RELEASE_ARTIFACT_UNSAFE', 'A bundled release artifact path must be relative')
  const source = resolve(sourceRoot, normalized)
  const relation = relative(sourceRoot, source)
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new AgentHostError('BUNDLED_RELEASE_ARTIFACT_UNSAFE', 'A bundled release artifact escapes its catalog')
  }
  return { source, relative: normalized }
}

async function artifactDigest(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return `sha256:${hash.digest('hex')}`
}

async function verifyBoundArtifact(path, component, label) {
  const info = await lstat(path).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (info === null || !info.isFile()) {
    throw new AgentHostError(
      'BUNDLED_RELEASE_ARTIFACT_MISMATCH',
      `${component.id} ${label} must be an existing regular file without a symlink`,
    )
  }
  if (info.size !== component.artifact.bytes) {
    throw new AgentHostError(
      'BUNDLED_RELEASE_ARTIFACT_MISMATCH',
      `${component.id} ${label} does not match its release manifest size`,
    )
  }
  if (await artifactDigest(path) !== component.artifact.sha256) {
    throw new AgentHostError(
      'BUNDLED_RELEASE_ARTIFACT_MISMATCH',
      `${component.id} ${label} does not match its release manifest digest`,
    )
  }
  return info.size
}

export async function stageBundledReleaseCatalog(sourceRoot, destinationRoot, profileId) {
  return stageBundledReleaseCatalogForProfiles(sourceRoot, destinationRoot, [profileId])
}

export async function stageBundledReleaseCatalogForProfiles(sourceRoot, destinationRoot, profileIds) {
  if (!Array.isArray(profileIds) || profileIds.length === 0 || new Set(profileIds).size !== profileIds.length) {
    throw new AgentHostError('BUNDLED_RELEASE_PROFILE_INVALID', 'At least one unique release profile is required')
  }
  const sourceManifest = join(resolve(sourceRoot), 'current.json')
  const release = await loadReleaseManifest(sourceManifest)
  const profiles = await Promise.all(profileIds.map((id) => loadProfile(id)))
  const selected = new Set(profiles.flatMap((profile) => profile.components))
  const components = release.manifest.components.filter((component) => selected.has(component.id))
  const missing = [...selected].filter((id) => !components.some((component) => component.id === id))
  if (missing.length > 0) {
    throw new AgentHostError('BUNDLED_RELEASE_PROFILE_INCOMPLETE', 'The release cannot build the requested application profiles', { profiles: profileIds, components: missing })
  }
  const manifest = validateReleaseManifest({ ...release.manifest, components })
  const destination = resolve(destinationRoot)
  const staging = `${destination}.staging-${process.pid}`
  await rm(staging, { recursive: true, force: true })
  await mkdir(join(staging, 'artifacts'), { recursive: true, mode: 0o755 })
  let artifactBytes = 0
  try {
    for (const component of components) {
      const artifact = containedArtifact(dirname(sourceManifest), component.artifact.url)
      if (artifact === null) continue
      await verifyBoundArtifact(artifact.source, component, 'source artifact')
      const target = join(staging, artifact.relative)
      await mkdir(dirname(target), { recursive: true, mode: 0o755 })
      await cp(artifact.source, target, { force: false })
      artifactBytes += await verifyBoundArtifact(target, component, 'bundled artifact')
    }
    await writeFile(join(staging, 'current.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
    const sourceProvenance = join(dirname(sourceManifest), 'build-provenance.json')
    const provenanceInfo = await stat(sourceProvenance).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (provenanceInfo !== null) {
      if (!provenanceInfo.isFile()) throw new AgentHostError('BUNDLED_RELEASE_PROVENANCE_INVALID', 'Build provenance is not a regular file')
      const { record } = await loadBuildProvenance(sourceProvenance, release.manifest)
      const projected = validateBuildProvenance({
        ...record,
        reusedComponents: record.reusedComponents.filter((component) => selected.has(component.id)),
      }, manifest)
      await writeFile(join(staging, 'build-provenance.json'), `${JSON.stringify(projected, null, 2)}\n`, { mode: 0o644 })
    }
    await rm(destination, { recursive: true, force: true })
    await mkdir(dirname(destination), { recursive: true, mode: 0o755 })
    await rename(staging, destination)
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  return {
    status: 'ok',
    profiles: profileIds,
    components: components.map((component) => component.id),
    artifactBytes,
    destination,
  }
}
