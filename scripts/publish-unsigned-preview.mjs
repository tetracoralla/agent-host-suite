#!/usr/bin/env node
/**
 * Owner-operable unsigned preview publish path.
 *
 * GitHub OAuth tokens for this checkout lack the `workflow` scope, so
 * docs/unsigned-preview-release.yml cannot be promoted into
 * .github/workflows/ yet. This script is the supported owner path that:
 *   1) stages a closed Release asset set (DMG/ZIP + index + digests + optional
 *      bound catalog, including every referenced component archive)
 *   2) prints or runs `gh release create` with only those assets attached
 *
 * Product semantics: the first public unsigned preview is published as a
 * **non-prerelease** Release with `--latest`, so Host's
 * `/releases/latest/download/preview-distribution.json` probe can find it.
 * GitHub REST refuses make_latest on prereleases; `--prerelease --latest`
 * does not work.
 *
 * It never requests Apple notarization secrets.
 *
 * Usage:
 *   node scripts/publish-unsigned-preview.mjs prepare \
 *     --tag v0.2.0-unsigned.1 \
 *     --output .build/unsigned-preview \
 *     --dmg /absolute/Agent-Host-0.2.0-darwin-arm64.dmg \
 *     [--catalog /absolute/current.json] \
 *     [--zip /absolute/Agent-Host-0.2.0-win32-x64.zip]
 *
 *   `--catalog` rewrites every component artifact.url to this tag's Release
 *   download URL and attaches the exact local archives. Relative
 *   `artifacts/*.tar.gz` catalogs (the standard builder output) are not
 *   publishable as-is: a clean client would resolve them next to the
 *   downloaded current.json and get ENOENT. Missing local archives fail closed.
 *
 *   node scripts/publish-unsigned-preview.mjs publish \
 *     --tag v0.2.0-unsigned.1 \
 *     --assets .build/unsigned-preview \
 *     [--dry-run]
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { GITHUB_RELEASES_URL } from '../src/preview-download.mjs'
import { resolveArtifactUrl } from '../src/release-manifest.mjs'

const suiteRoot = fileURLToPath(new URL('..', import.meta.url))
const writePreviewPath = join(suiteRoot, 'scripts/write-preview-distribution.mjs')

export const ASSET_MANIFEST_SCHEMA = 'openadam.agent-host-unsigned-preview-assets.v0.1'
export const ASSET_MANIFEST_NAME = 'unsigned-preview-asset-manifest.json'
export const SAFE_RELEASE_ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const INDEX_NAME = 'preview-distribution.json'
const SUMS_NAME = 'SHA256SUMS'
const NOTES_NAME = 'RELEASE_NOTES.md'
const CATALOG_JSON_NAME = 'current.json'
const PROVENANCE_NAME = 'build-provenance.json'
const FIXED_ASSET_NAMES = new Set([
  INDEX_NAME,
  SUMS_NAME,
  NOTES_NAME,
  ASSET_MANIFEST_NAME,
  CATALOG_JSON_NAME,
  PROVENANCE_NAME,
])

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return null
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`--${name} requires a value`)
  }
  return value
}

function flag(name) {
  return process.argv.includes(`--${name}`)
}

function collect(name) {
  const values = []
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === `--${name}`) {
      const value = process.argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`--${name} requires a value`)
      values.push(value)
    }
  }
  return values
}

async function digestFile(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

async function requireFile(path, label) {
  const absolute = resolve(path)
  let info
  try {
    info = await stat(absolute)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error(`${label} is missing (not a regular file): ${absolute}`)
    }
    throw error
  }
  if (!info.isFile()) throw new Error(`${label} is not a regular file: ${absolute}`)
  return absolute
}

function normalizeTag(tag) {
  return tag.startsWith('v') ? tag : `v${tag}`
}

function releaseDownloadBase(tag) {
  return `${GITHUB_RELEASES_URL}/download/${tag}`
}

/**
 * GitHub `/releases/latest` excludes prereleases and REST make_latest rejects
 * them. Unsigned preview must publish as a non-prerelease latest Release.
 */
export function buildReleaseCreateArgs({ tag, assetPaths, notesPath, title }) {
  return [
    'release', 'create', tag,
    ...assetPaths,
    '--latest',
    '--title', title,
    '--notes-file', notesPath,
  ]
}

/**
 * Model GitHub latest semantics for tests: only non-prerelease, non-draft
 * releases can occupy /releases/latest.
 */
export function githubLatestWouldResolve(release) {
  if (release == null || typeof release !== 'object') return false
  if (release.draft === true) return false
  if (release.prerelease === true) return false
  return true
}

function releaseNotes(tag) {
  return [
    `Agent Host unsigned preview ${tag}`,
    '',
    'This build is **not** Apple-notarized and is **not** an App Store or marketplace listing.',
    'It is an owner-published GitHub Release preview for external download.',
    'This Release is a **non-prerelease** marked latest so Host can probe',
    '`/releases/latest/download/preview-distribution.json`.',
    '',
    '## macOS (Apple silicon first)',
    '1. Download `Agent-Host-*-darwin-arm64.dmg` and `SHA256SUMS`.',
    '2. Compare the DMG digest to `SHA256SUMS`.',
    '3. Open the DMG.',
    '4. Control-click **Agent Host.app** → **Open** → confirm Gatekeeper.',
    '',
    '## Index',
    'Host probes `preview-distribution.json` at the Release `latest` convention URL.',
    'Tracked `catalog/preview-distribution.json` in git remains the unpublished placeholder until assets exist.',
  ].join('\n')
}

function dirnameSafe(path) {
  return resolve(path, '..')
}

function requireContainedPath(root, target, label) {
  const resolvedRoot = resolve(root)
  const resolvedTarget = resolve(target)
  const relation = relative(resolvedRoot, resolvedTarget)
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`${label} escapes the catalog directory`)
  }
  return resolvedTarget
}

async function findFileIfPresent(path) {
  try {
    const info = await stat(path)
    if (info.isFile()) return path
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return null
}

async function findLocalCatalogArtifact(catalogDir, assetName) {
  const nested = await findFileIfPresent(join(catalogDir, 'artifacts', assetName))
  if (nested != null) return nested
  return findFileIfPresent(join(catalogDir, assetName))
}

async function localArtifactPath(catalogDir, catalogPath, component) {
  const id = component?.id ?? 'unknown'
  const url = component?.artifact?.url
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error(`component ${id} is missing artifact.url`)
  }
  let resolved
  try {
    resolved = resolveArtifactUrl(catalogPath, url)
  } catch (error) {
    throw new Error(`component ${id} artifact URL is not publishable: ${error.message}`)
  }
  if (resolved.protocol === 'file:') {
    return requireContainedPath(catalogDir, fileURLToPath(resolved), `component ${id} artifact`)
  }
  if (resolved.protocol === 'https:') {
    const name = basename(resolved.pathname)
    if (!SAFE_RELEASE_ASSET_NAME.test(name)) {
      throw new Error(`component ${id} artifact URL does not end with a safe Release filename`)
    }
    const found = await findLocalCatalogArtifact(catalogDir, name)
    if (found == null) {
      throw new Error(
        `component ${id} artifact ${url} is not present next to the catalog `
        + `(looked for artifacts/${name} and ${name}). `
        + 'Refuse publishing a catalog a clean client cannot fetch from this Release.',
      )
    }
    return found
  }
  throw new Error(`component ${id} uses unsupported artifact protocol: ${resolved.protocol}`)
}

async function fileEntry(path, role) {
  const name = basename(path)
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`asset is not a regular file: ${path}`)
  return {
    name,
    role,
    sha256: await digestFile(path),
    bytes: info.size,
  }
}

async function attachBoundCatalog({ catalogPath, outDir, versionTag, reservedNames }) {
  const catalogDir = dirnameSafe(catalogPath)
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
  if (catalog == null || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw new Error('catalog current.json must be an object')
  }
  if (catalog.status === 'draft-unbound') {
    throw new Error('Refusing to advertise the draft-unbound catalog')
  }
  if (!Array.isArray(catalog.components)) {
    throw new Error('catalog current.json is missing a components array')
  }

  const archiveEntries = []
  const copied = new Map()
  const expectedPrefix = `${releaseDownloadBase(versionTag)}/`

  for (const component of catalog.components) {
    const id = component?.id ?? 'unknown'
    const source = await requireFile(
      await localArtifactPath(catalogDir, catalogPath, component),
      `catalog artifact ${id}`,
    )
    const name = basename(source)
    if (!SAFE_RELEASE_ASSET_NAME.test(name)) {
      throw new Error(`component ${id} archive filename is not a safe Release asset name: ${name}`)
    }
    if (reservedNames.has(name)) {
      throw new Error(`component ${id} archive filename collides with a reserved Release asset: ${name}`)
    }
    const expectedHex = String(component.artifact?.sha256 ?? '').replace(/^sha256:/u, '')
    const digest = await digestFile(source)
    const info = await stat(source)
    if (digest !== expectedHex) {
      throw new Error(`component ${id} archive sha256 does not match current.json`)
    }
    if (info.size !== component.artifact.bytes) {
      throw new Error(`component ${id} archive size does not match current.json`)
    }
    const existing = copied.get(name)
    if (existing != null) {
      if (existing.sha256 !== digest || existing.bytes !== info.size) {
        throw new Error(`catalog archive name ${name} is used by different files`)
      }
    } else {
      const destination = join(outDir, name)
      if (resolve(source) !== destination) await copyFile(source, destination)
      copied.set(name, { sha256: digest, bytes: info.size })
      archiveEntries.push(await fileEntry(destination, 'component-archive'))
    }
    component.artifact.url = `${expectedPrefix}${name}`
  }

  const catalogDest = join(outDir, CATALOG_JSON_NAME)
  await writeFile(catalogDest, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o644 })
  const provenancePath = await requireFile(join(catalogDir, PROVENANCE_NAME), PROVENANCE_NAME)
  const provenanceDest = join(outDir, PROVENANCE_NAME)
  if (resolve(provenancePath) !== provenanceDest) await copyFile(provenancePath, provenanceDest)
  return {
    catalogDest,
    provenanceDest,
    uploadEntries: [
      await fileEntry(catalogDest, 'catalog'),
      await fileEntry(provenanceDest, 'provenance'),
      ...archiveEntries,
    ],
  }
}

function urlMatchesTag(url, tag, label) {
  const expectedPrefix = `${releaseDownloadBase(tag)}/`
  if (typeof url !== 'string' || !url.startsWith(expectedPrefix)) {
    throw new Error(
      `${label} URL must live under ${expectedPrefix} (got ${url ?? 'null'}). `
      + 'Refuse publishing an index that points at a different tag.',
    )
  }
}

export async function validateClosedAssetSet({ assetsDir, tag, index, manifest }) {
  const versionTag = normalizeTag(tag)
  if (manifest.schemaVersion !== ASSET_MANIFEST_SCHEMA) {
    throw new Error(`unsupported asset manifest schema: ${manifest.schemaVersion}`)
  }
  if (manifest.tag !== versionTag) {
    throw new Error(
      `asset manifest tag ${manifest.tag} does not match publish --tag ${versionTag}`,
    )
  }
  if (manifest.githubReleasesUrl !== GITHUB_RELEASES_URL) {
    throw new Error(
      `asset manifest githubReleasesUrl must be ${GITHUB_RELEASES_URL}`,
    )
  }
  if (!Array.isArray(manifest.upload) || manifest.upload.length === 0) {
    throw new Error('asset manifest upload list is empty')
  }

  if (index.publicReleasePublished !== true) {
    throw new Error('preview-distribution.json is not marked publicReleasePublished')
  }
  if (!Array.isArray(index.carriers) || index.carriers.length === 0) {
    throw new Error('preview-distribution.json has no carriers')
  }
  if (index.githubReleasesUrl !== GITHUB_RELEASES_URL) {
    throw new Error(`preview-distribution.json githubReleasesUrl must be ${GITHUB_RELEASES_URL}`)
  }

  const expectedBase = releaseDownloadBase(versionTag)
  for (const carrier of index.carriers) {
    urlMatchesTag(carrier.url, versionTag, `carrier ${carrier.filename}`)
    if (carrier.url !== `${expectedBase}/${carrier.filename}`) {
      throw new Error(`carrier ${carrier.filename} URL basename mismatch`)
    }
  }
  if (index.catalog != null) {
    urlMatchesTag(index.catalog.url, versionTag, 'catalog')
    urlMatchesTag(index.catalog.provenanceUrl, versionTag, 'catalog provenance')
  }
  if (index.selfHostedIndexUrl != null) {
    const expectedIndexUrl = `${expectedBase}/${INDEX_NAME}`
    if (index.selfHostedIndexUrl !== expectedIndexUrl) {
      throw new Error(
        `selfHostedIndexUrl must be ${expectedIndexUrl} (got ${index.selfHostedIndexUrl})`,
      )
    }
  }

  const uploadByName = new Map()
  for (const entry of manifest.upload) {
    if (uploadByName.has(entry.name)) {
      throw new Error(`asset manifest repeats upload name ${entry.name}`)
    }
    uploadByName.set(entry.name, entry)
    const path = join(assetsDir, entry.name)
    await requireFile(path, entry.name)
    const info = await stat(path)
    if (info.size !== entry.bytes) {
      throw new Error(
        `asset ${entry.name} size mismatch: manifest ${entry.bytes}, disk ${info.size}`,
      )
    }
    const digest = await digestFile(path)
    if (digest !== entry.sha256) {
      throw new Error(
        `asset ${entry.name} sha256 mismatch: manifest ${entry.sha256}, disk ${digest}`,
      )
    }
  }

  if (!uploadByName.has(INDEX_NAME)) {
    throw new Error('closed asset set must include preview-distribution.json')
  }
  if (!uploadByName.has(SUMS_NAME)) {
    throw new Error('closed asset set must include SHA256SUMS')
  }

  for (const carrier of index.carriers) {
    const entry = uploadByName.get(carrier.filename)
    if (entry == null) {
      throw new Error(`closed asset set is missing declared carrier ${carrier.filename}`)
    }
    const expectedHex = String(carrier.sha256).replace(/^sha256:/u, '')
    if (entry.bytes !== carrier.bytes || entry.sha256 !== expectedHex) {
      throw new Error(
        `carrier ${carrier.filename} bytes/sha256 do not match preview-distribution.json `
        + '(refusing missing or tampered installer)',
      )
    }
  }

  if (index.catalog != null) {
    for (const [name, digestField, bytesField] of [
      [CATALOG_JSON_NAME, index.catalog.sha256, index.catalog.bytes],
      [PROVENANCE_NAME, index.catalog.provenanceSha256, null],
    ]) {
      const entry = uploadByName.get(name)
      if (entry == null) {
        throw new Error(`closed asset set is missing declared catalog asset ${name}`)
      }
      const expectedHex = String(digestField).replace(/^sha256:/u, '')
      if (entry.sha256 !== expectedHex) {
        throw new Error(`catalog asset ${name} sha256 does not match preview-distribution.json`)
      }
      if (bytesField != null && entry.bytes !== bytesField) {
        throw new Error(`catalog asset ${name} size does not match preview-distribution.json`)
      }
    }

    const catalog = JSON.parse(await readFile(join(assetsDir, CATALOG_JSON_NAME), 'utf8'))
    if (!Array.isArray(catalog.components)) {
      throw new Error('bound current.json is missing a components array')
    }
    for (const component of catalog.components) {
      const id = component?.id ?? 'unknown'
      const url = component?.artifact?.url
      if (typeof url !== 'string' || !url.startsWith(`${expectedBase}/`)) {
        throw new Error(
          `component ${id} artifact URL must be a downloadable Release asset under ${expectedBase}/ `
          + `(got ${url ?? 'null'}). Refuse publishing a catalog that a clean client cannot fetch.`,
        )
      }
      const name = url.slice(`${expectedBase}/`.length)
      if (!SAFE_RELEASE_ASSET_NAME.test(name) || name.includes('/')) {
        throw new Error(`component ${id} artifact asset name is not a safe Release filename: ${name}`)
      }
      const entry = uploadByName.get(name)
      if (entry == null) {
        throw new Error(`closed asset set is missing catalog archive ${name} referenced by ${id}`)
      }
      const expectedHex = String(component.artifact.sha256 ?? '').replace(/^sha256:/u, '')
      if (entry.sha256 !== expectedHex) {
        throw new Error(`catalog archive ${name} sha256 does not match current.json`)
      }
      if (entry.bytes !== component.artifact.bytes) {
        throw new Error(`catalog archive ${name} size does not match current.json`)
      }
    }
  }

  const uploadNames = new Set(manifest.upload.map((entry) => entry.name))
  const leftovers = []
  for (const name of await readdir(assetsDir)) {
    if (name === NOTES_NAME || name === ASSET_MANIFEST_NAME) continue
    const path = join(assetsDir, name)
    if (!(await stat(path)).isFile()) continue
    if (!uploadNames.has(name)) leftovers.push(name)
  }

  return {
    uploadPaths: manifest.upload.map((entry) => join(assetsDir, entry.name)),
    leftovers,
  }
}

async function prepare() {
  const tag = arg('tag')
  const output = arg('output')
  if (tag === null || output === null) {
    throw new Error('prepare requires --tag and --output')
  }
  if (!/^v?\d+\.\d+\.\d+([.-].+)?$/u.test(tag)) {
    throw new Error(`--tag looks invalid: ${tag}`)
  }
  const dmgPaths = collect('dmg')
  const zipPaths = collect('zip')
  const catalogArg = arg('catalog')
  if (dmgPaths.length === 0 && zipPaths.length === 0) {
    throw new Error('prepare requires at least one --dmg or --zip')
  }

  const versionTag = normalizeTag(tag)
  const outDir = resolve(output)
  await mkdir(outDir, { recursive: true, mode: 0o755 })

  const uploadEntries = []
  const carrierPaths = []
  for (const path of [...dmgPaths, ...zipPaths]) {
    const absolute = await requireFile(path, 'carrier')
    const name = basename(absolute)
    const destination = join(outDir, name)
    await copyFile(absolute, destination)
    carrierPaths.push(destination)
    const role = name.endsWith('.dmg') || name.endsWith('.zip') ? 'carrier' : 'asset'
    uploadEntries.push(await fileEntry(destination, role))
  }

  const reservedNames = new Set(FIXED_ASSET_NAMES)
  for (const entry of uploadEntries) reservedNames.add(entry.name)

  let catalogPath = null
  if (catalogArg !== null) {
    const attached = await attachBoundCatalog({
      catalogPath: await requireFile(catalogArg, 'catalog'),
      outDir,
      versionTag,
      reservedNames,
    })
    catalogPath = attached.catalogDest
    uploadEntries.push(...attached.uploadEntries)
  }

  const baseUrl = releaseDownloadBase(versionTag)
  const indexPath = join(outDir, INDEX_NAME)
  const writeArgs = [
    writePreviewPath,
    '--output', indexPath,
    '--base-url', baseUrl,
  ]
  for (const path of carrierPaths.filter((item) => item.endsWith('.dmg'))) {
    writeArgs.push('--dmg', path)
  }
  for (const path of carrierPaths.filter((item) => item.endsWith('.zip'))) {
    writeArgs.push('--zip', path)
  }
  if (catalogPath !== null) {
    writeArgs.push('--catalog', catalogPath)
  }

  const written = spawnSync(process.execPath, writeArgs, { stdio: 'inherit' })
  if (written.status !== 0) {
    throw new Error('write-preview-distribution.mjs failed')
  }
  uploadEntries.push(await fileEntry(indexPath, 'index'))

  // Notes are not a Release asset upload; write them before SHA256SUMS so a
  // reused output dir cannot leave a stale notes digest in the checksum table.
  const notesPath = join(outDir, NOTES_NAME)
  await writeFile(notesPath, `${releaseNotes(versionTag)}\n`, { mode: 0o644 })

  // Closed set only — never hash leftover logs or prior run debris.
  const sumsLines = []
  for (const entry of uploadEntries) {
    sumsLines.push(`${entry.sha256}  ${entry.name}`)
  }
  sumsLines.sort()
  const sumsPath = join(outDir, SUMS_NAME)
  await writeFile(sumsPath, `${sumsLines.join('\n')}\n`, { mode: 0o644 })
  uploadEntries.push(await fileEntry(sumsPath, 'digests'))

  const manifest = {
    schemaVersion: ASSET_MANIFEST_SCHEMA,
    tag: versionTag,
    githubReleasesUrl: GITHUB_RELEASES_URL,
    indexFile: INDEX_NAME,
    notesFile: NOTES_NAME,
    upload: uploadEntries,
  }
  const manifestPath = join(outDir, ASSET_MANIFEST_NAME)
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })

  const index = JSON.parse(await readFile(indexPath, 'utf8'))
  const validated = await validateClosedAssetSet({
    assetsDir: outDir,
    tag: versionTag,
    index,
    manifest,
  })
  if (validated.leftovers.length > 0) {
    process.stdout.write(
      `note: ignoring non-manifest files in ${outDir}: ${validated.leftovers.join(', ')}\n`,
    )
  }

  const releaseArgs = buildReleaseCreateArgs({
    tag: versionTag,
    assetPaths: validated.uploadPaths.map((path) => `"${path}"`),
    notesPath: `"${notesPath}"`,
    title: `"Agent Host unsigned preview ${versionTag}"`,
  })
  const command = ['gh', ...releaseArgs].join(' ')

  const archiveCount = uploadEntries.filter((entry) => entry.role === 'component-archive').length
  process.stdout.write(`Prepared unsigned preview assets in ${outDir}\n`)
  if (archiveCount > 0) {
    process.stdout.write(
      `Included ${archiveCount} catalog archive(s) so a clean client can fetchBoundCatalog → acquireArtifact from this Release.\n`,
    )
  }
  process.stdout.write(
    'Owner publish command (non-prerelease --latest; attaches closed asset set only; no notarization):\n',
  )
  process.stdout.write(`${command}\n`)
  process.stdout.write('Or run: node scripts/publish-unsigned-preview.mjs publish '
    + `--tag ${versionTag} --assets ${outDir}\n`)
}

async function publish() {
  const tag = arg('tag')
  const assets = arg('assets')
  if (tag === null || assets === null) {
    throw new Error('publish requires --tag and --assets')
  }
  const versionTag = normalizeTag(tag)
  const assetsDir = resolve(assets)
  const info = await stat(assetsDir)
  if (!info.isDirectory()) throw new Error(`--assets must be a directory: ${assetsDir}`)

  const manifestPath = join(assetsDir, ASSET_MANIFEST_NAME)
  await requireFile(manifestPath, ASSET_MANIFEST_NAME)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

  const indexPath = join(assetsDir, INDEX_NAME)
  await requireFile(indexPath, INDEX_NAME)
  const index = JSON.parse(await readFile(indexPath, 'utf8'))

  const notesPath = join(assetsDir, NOTES_NAME)
  try {
    await requireFile(notesPath, NOTES_NAME)
  } catch {
    await writeFile(notesPath, `${releaseNotes(versionTag)}\n`, { mode: 0o644 })
  }

  const validated = await validateClosedAssetSet({
    assetsDir,
    tag: versionTag,
    index,
    manifest,
  })
  if (validated.leftovers.length > 0) {
    process.stdout.write(
      `note: refusing to upload non-manifest leftovers: ${validated.leftovers.join(', ')}\n`,
    )
  }

  const args = buildReleaseCreateArgs({
    tag: versionTag,
    assetPaths: validated.uploadPaths,
    notesPath,
    title: `Agent Host unsigned preview ${versionTag}`,
  })
  process.stdout.write(`gh ${args.map((part) => (/\s/u.test(part) ? `"${part}"` : part)).join(' ')}\n`)
  if (flag('dry-run')) {
    process.stdout.write('dry-run: not calling gh\n')
    return
  }
  const result = spawnSync('gh', args, { stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error('gh release create failed')
  }
  process.stdout.write(
    `Published ${versionTag} as non-prerelease latest. `
    + 'Host source check can probe carriers via /releases/latest/download/preview-distribution.json.\n',
  )
}

const isMain = process.argv[1] != null
  && fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (isMain) {
  const action = process.argv[2]
  if (action === 'prepare') {
    await prepare()
  } else if (action === 'publish') {
    await publish()
  } else {
    process.stderr.write(`Usage:
  node scripts/publish-unsigned-preview.mjs prepare --tag vX.Y.Z --output DIR --dmg FILE [--catalog current.json] [--zip FILE]
  node scripts/publish-unsigned-preview.mjs publish --tag vX.Y.Z --assets DIR [--dry-run]
`)
    process.exitCode = 2
  }
}
