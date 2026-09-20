#!/usr/bin/env node
/**
 * Owner-operable unsigned preview publish path.
 *
 * GitHub OAuth tokens for this checkout lack the `workflow` scope, so
 * docs/unsigned-preview-release.yml cannot be promoted into
 * .github/workflows/ yet. This script is the supported owner path that:
 *   1) stages Release assets (DMG/ZIP + index + digests + optional catalog)
 *   2) prints or runs `gh release create` with those assets attached
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
import { basename, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { GITHUB_RELEASES_URL } from '../src/preview-download.mjs'

const suiteRoot = fileURLToPath(new URL('..', import.meta.url))
const writePreviewPath = join(suiteRoot, 'scripts/write-preview-distribution.mjs')

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
  const info = await stat(absolute)
  if (!info.isFile()) throw new Error(`${label} is not a regular file: ${absolute}`)
  return absolute
}

function releaseNotes(tag) {
  return [
    `Agent Host unsigned preview ${tag}`,
    '',
    'This build is **not** Apple-notarized and is **not** an App Store or marketplace listing.',
    'It is an owner-published GitHub Release preview for external download.',
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

  const outDir = resolve(output)
  await mkdir(outDir, { recursive: true, mode: 0o755 })

  const staged = []
  for (const path of [...dmgPaths, ...zipPaths]) {
    const absolute = await requireFile(path, 'carrier')
    const name = basename(absolute)
    const destination = join(outDir, name)
    await copyFile(absolute, destination)
    staged.push(destination)
  }

  let catalogPath = null
  let provenancePath = null
  if (catalogArg !== null) {
    catalogPath = await requireFile(catalogArg, 'catalog')
    provenancePath = await requireFile(join(dirnameSafe(catalogPath), 'build-provenance.json'), 'build-provenance.json')
    await copyFile(catalogPath, join(outDir, 'current.json'))
    await copyFile(provenancePath, join(outDir, 'build-provenance.json'))
    staged.push(join(outDir, 'current.json'), join(outDir, 'build-provenance.json'))
  }

  const versionTag = tag.startsWith('v') ? tag : `v${tag}`
  const baseUrl = `${GITHUB_RELEASES_URL}/download/${versionTag}`
  const indexPath = join(outDir, 'preview-distribution.json')

  const writeArgs = [
    writePreviewPath,
    '--output', indexPath,
    '--base-url', baseUrl,
  ]
  for (const path of staged.filter((item) => item.endsWith('.dmg'))) {
    writeArgs.push('--dmg', path)
  }
  for (const path of staged.filter((item) => item.endsWith('.zip'))) {
    writeArgs.push('--zip', path)
  }
  if (catalogPath !== null) {
    writeArgs.push('--catalog', join(outDir, 'current.json'))
  }

  const written = spawnSync(process.execPath, writeArgs, { stdio: 'inherit' })
  if (written.status !== 0) {
    throw new Error('write-preview-distribution.mjs failed')
  }
  staged.push(indexPath)

  const sums = []
  for (const name of await readdir(outDir)) {
    const path = join(outDir, name)
    const info = await stat(path)
    if (!info.isFile() || name === 'SHA256SUMS') continue
    sums.push(`${await digestFile(path)}  ${name}`)
  }
  sums.sort()
  const sumsPath = join(outDir, 'SHA256SUMS')
  await writeFile(sumsPath, `${sums.join('\n')}\n`, { mode: 0o644 })
  staged.push(sumsPath)

  const notesPath = join(outDir, 'RELEASE_NOTES.md')
  await writeFile(notesPath, `${releaseNotes(versionTag)}\n`, { mode: 0o644 })

  const command = [
    'gh', 'release', 'create', versionTag,
    ...staged.filter((path) => basename(path) !== 'RELEASE_NOTES.md').map((path) => `"${path}"`),
    '--prerelease',
    '--title', `"Agent Host unsigned preview ${versionTag}"`,
    '--notes-file', `"${notesPath}"`,
  ].join(' ')

  process.stdout.write(`Prepared unsigned preview assets in ${outDir}\n`)
  process.stdout.write('Owner publish command (attaches assets; no notarization):\n')
  process.stdout.write(`${command}\n`)
  process.stdout.write('Or run: node scripts/publish-unsigned-preview.mjs publish '
    + `--tag ${versionTag} --assets ${outDir}\n`)
}

function dirnameSafe(path) {
  return resolve(path, '..')
}

async function publish() {
  const tag = arg('tag')
  const assets = arg('assets')
  if (tag === null || assets === null) {
    throw new Error('publish requires --tag and --assets')
  }
  const versionTag = tag.startsWith('v') ? tag : `v${tag}`
  const assetsDir = resolve(assets)
  const info = await stat(assetsDir)
  if (!info.isDirectory()) throw new Error(`--assets must be a directory: ${assetsDir}`)

  const indexPath = join(assetsDir, 'preview-distribution.json')
  await requireFile(indexPath, 'preview-distribution.json')
  const index = JSON.parse(await readFile(indexPath, 'utf8'))
  if (index.publicReleasePublished !== true) {
    throw new Error('preview-distribution.json is not marked publicReleasePublished')
  }
  if (!Array.isArray(index.carriers) || index.carriers.length === 0) {
    throw new Error('preview-distribution.json has no carriers')
  }

  const notesPath = join(assetsDir, 'RELEASE_NOTES.md')
  try {
    await requireFile(notesPath, 'RELEASE_NOTES.md')
  } catch {
    await writeFile(notesPath, `${releaseNotes(versionTag)}\n`, { mode: 0o644 })
  }

  const files = []
  for (const name of await readdir(assetsDir)) {
    if (name === 'RELEASE_NOTES.md') continue
    const path = join(assetsDir, name)
    if ((await stat(path)).isFile()) files.push(path)
  }
  if (!files.some((path) => basename(path) === 'preview-distribution.json')) {
    throw new Error('assets directory must include preview-distribution.json')
  }
  if (!files.some((path) => basename(path) === 'SHA256SUMS')) {
    throw new Error('assets directory must include SHA256SUMS')
  }

  const args = [
    'release', 'create', versionTag,
    ...files,
    '--prerelease',
    '--title', `Agent Host unsigned preview ${versionTag}`,
    '--notes-file', notesPath,
  ]
  process.stdout.write(`gh ${args.map((part) => (/\s/u.test(part) ? `"${part}"` : part)).join(' ')}\n`)
  if (flag('dry-run')) {
    process.stdout.write('dry-run: not calling gh\n')
    return
  }
  const result = spawnSync('gh', args, { stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error('gh release create failed')
  }
  process.stdout.write(`Published ${versionTag}. Host source check can now see public carriers via the latest convention URL.\n`)
}

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
