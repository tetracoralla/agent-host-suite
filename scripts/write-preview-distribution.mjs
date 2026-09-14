import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import {
  GITHUB_RELEASES_URL,
  PREVIEW_DISTRIBUTION_SCHEMA,
  UNSIGNED_MACOS_GATEKEEPER_NOTE,
  WINDOWS_SMARTSCREEN_NOTE,
  validatePreviewDistribution,
} from '../src/preview-download.mjs'

function argument(name) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return null
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`--${name} requires a value`)
  }
  return value
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
  return `sha256:${hash.digest('hex')}`
}

function platformFromFilename(filename) {
  if (filename.includes('darwin-arm64')) return 'darwin-arm64'
  if (filename.includes('darwin-x86_64') || filename.includes('darwin-x64')) return 'darwin-x86_64'
  if (filename.includes('win32-arm64')) return 'win32-arm64'
  if (filename.includes('win32-x64')) return 'win32-x64'
  throw new Error(`Cannot infer preview platform from ${filename}; rename to Agent-Host-{version}-{platform}.{dmg|zip}`)
}

function kindFromFilename(filename) {
  if (filename.endsWith('.dmg')) return 'dmg'
  if (filename.endsWith('.zip')) return 'zip'
  throw new Error(`Preview carrier must be a .dmg or .zip: ${filename}`)
}

const output = argument('output')
if (output === null) {
  throw new Error('Usage: node scripts/write-preview-distribution.mjs --output preview-distribution.json [--catalog current.json] [--base-url https://host/path] [--dmg FILE] [--zip FILE]')
}

const catalogArgument = argument('catalog')
const baseUrl = argument('base-url')
const carriers = []
for (const path of [...collect('dmg'), ...collect('zip')]) {
  const absolute = resolve(path)
  const filename = basename(absolute)
  const info = await stat(absolute)
  if (!info.isFile()) throw new Error(`${absolute} is not a regular file`)
  if (baseUrl === null) throw new Error('--base-url is required when attaching a DMG or ZIP')
  carriers.push({
    platform: platformFromFilename(filename),
    kind: kindFromFilename(filename),
    filename,
    url: `${baseUrl.replace(/\/$/u, '')}/${filename}`,
    sha256: await digestFile(absolute),
    bytes: info.size,
  })
}

let catalog = null
if (catalogArgument !== null) {
  const catalogPath = resolve(catalogArgument)
  const info = await stat(catalogPath)
  if (!info.isFile()) throw new Error(`${catalogPath} is not a regular file`)
  const release = JSON.parse(await readFile(catalogPath, 'utf8'))
  if (release.status === 'draft-unbound') throw new Error('Refusing to advertise the draft-unbound catalog')
  if (baseUrl === null) throw new Error('--base-url is required when attaching a bound catalog')
  const provenancePath = resolve(dirname(catalogPath), 'build-provenance.json')
  const provenanceInfo = await stat(provenancePath)
  if (!provenanceInfo.isFile()) throw new Error(`build-provenance.json is required next to ${catalogPath}`)
  const prefix = baseUrl.replace(/\/$/u, '')
  catalog = {
    url: `${prefix}/current.json`,
    sha256: await digestFile(catalogPath),
    bytes: info.size,
    provenanceUrl: `${prefix}/build-provenance.json`,
    provenanceSha256: await digestFile(provenancePath),
  }
}

const unpublished = catalog === null && carriers.length === 0
const index = validatePreviewDistribution({
  schemaVersion: PREVIEW_DISTRIBUTION_SCHEMA,
  status: unpublished ? 'unpublished' : 'preview-unsigned',
  notarized: false,
  marketplace: false,
  publicReleasePublished: !unpublished,
  githubReleasesUrl: GITHUB_RELEASES_URL,
  selfHostedIndexUrl: unpublished ? null : (baseUrl === null ? null : `${baseUrl.replace(/\/$/u, '')}/preview-distribution.json`),
  gatekeeperNote: UNSIGNED_MACOS_GATEKEEPER_NOTE,
  windowsSmartScreenNote: WINDOWS_SMARTSCREEN_NOTE,
  carriers,
  catalog,
})

await writeFile(resolve(output), `${JSON.stringify(index, null, 2)}\n`, { mode: 0o644 })
process.stdout.write(`${resolve(output)}\n`)
