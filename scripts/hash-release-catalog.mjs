#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

async function catalogFiles(root, directory = root) {
  const files = []
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error('release catalog contains a symbolic link')
    if (entry.isDirectory()) files.push(...await catalogFiles(root, path))
    else if (entry.isFile()) files.push(path)
    else throw new Error('release catalog contains a special filesystem entry')
  }
  return files
}

export async function hashReleaseCatalog(catalogRoot) {
  const lexicalRoot = resolve(catalogRoot)
  const root = await realpath(lexicalRoot)
  const rootInfo = await lstat(lexicalRoot)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('release catalog root is not one regular directory')
  }
  const paths = await catalogFiles(root)
  const relativePaths = paths.map((path) => relative(root, path).split(sep).join('/'))
  for (const required of ['current.json', 'build-provenance.json']) {
    if (!relativePaths.includes(required)) throw new Error(`release catalog omitted ${required}`)
  }
  const hash = createHash('sha256')
  for (let index = 0; index < paths.length; index += 1) {
    const info = await lstat(paths[index])
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error('release catalog changed during hashing')
    }
    hash.update(`${relativePaths[index]}\0${info.size}\0`, 'utf8')
    for await (const chunk of createReadStream(paths[index])) hash.update(chunk)
    hash.update('\0', 'utf8')
  }
  return {
    sha256: `sha256:${hash.digest('hex')}`,
    files: paths.length,
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const catalogRoot = process.argv[2]
  if (catalogRoot === undefined) throw new Error('Usage: hash-release-catalog.mjs RELEASE_CATALOG_ROOT')
  process.stdout.write(`${JSON.stringify(await hashReleaseCatalog(catalogRoot))}\n`)
}
