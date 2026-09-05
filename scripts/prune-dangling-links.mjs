#!/usr/bin/env node

import { lstat, readdir, rm, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const MAX_ENTRIES = 100_000

export async function pruneDanglingLinks(root) {
  if (typeof root !== 'string' || !isAbsolute(root) || root === '/') {
    throw new Error('prune root must be one explicit absolute non-root path')
  }
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('prune root must be one real directory')
  }
  let entries = 0
  let scannedLinks = 0
  let removedLinks = 0
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      entries += 1
      if (entries > MAX_ENTRIES) throw new Error(`prune root exceeds ${MAX_ENTRIES} entries`)
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (!entry.isSymbolicLink()) continue
      scannedLinks += 1
      try {
        await stat(path)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        await rm(path, { force: false })
        removedLinks += 1
      }
    }
  }
  await walk(root)
  return { scannedLinks, removedLinks }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error('Usage: prune-dangling-links.mjs /absolute/staging/root')
  const result = await pruneDanglingLinks(process.argv[2])
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
