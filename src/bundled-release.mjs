import { cp, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { AgentHostError } from './errors.mjs'
import { loadProfile } from './profile.mjs'
import { loadReleaseManifest, validateReleaseManifest } from './release-manifest.mjs'

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

export async function stageBundledReleaseCatalog(sourceRoot, destinationRoot, profileId) {
  const sourceManifest = join(resolve(sourceRoot), 'current.json')
  const release = await loadReleaseManifest(sourceManifest)
  const profile = await loadProfile(profileId)
  const selected = new Set(profile.components)
  const components = release.manifest.components.filter((component) => selected.has(component.id))
  const missing = profile.components.filter((id) => !components.some((component) => component.id === id))
  if (missing.length > 0) {
    throw new AgentHostError('BUNDLED_RELEASE_PROFILE_INCOMPLETE', `The release cannot build the ${profile.displayName} application payload`, { components: missing })
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
      const target = join(staging, artifact.relative)
      await mkdir(dirname(target), { recursive: true, mode: 0o755 })
      await cp(artifact.source, target, { force: false })
      artifactBytes += Number((await stat(target)).size)
    }
    await writeFile(join(staging, 'current.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
    await rm(destination, { recursive: true, force: true })
    await mkdir(dirname(destination), { recursive: true, mode: 0o755 })
    await rename(staging, destination)
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  return {
    status: 'ok',
    profile: profile.id,
    components: components.map((component) => component.id),
    artifactBytes,
    destination,
  }
}
