#!/usr/bin/env node

import { lstat, readdir, readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { loadInstance } from '../src/instance.mjs'

const root = resolve(import.meta.dirname, '..')
const required = [
  '.gitignore',
  'AGENTS.md',
  'LICENSE',
  'NOTICE',
  'package-lock.json',
  'README.md',
  'docs/PRODUCT_MODEL.md',
  'docs/REVIEW_CONTRACT.md',
  'examples/instance.example.json',
  'package.json',
  'schemas/http-capability-instance.schema.v0.1.json',
  'src/adapter.mjs',
  'src/instance.mjs',
  'src/json.mjs',
]
for (const path of required) await readFile(resolve(root, path))
const rootEntries = await readdir(root)
for (const forbidden of ['instance.json', '.env', '.secrets']) {
  if (rootEntries.includes(forbidden)) throw new Error(`tracked product root contains ${forbidden}`)
}
const publicFiles = []
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.verify'].includes(entry.name)) continue
    const path = resolve(directory, entry.name)
    const display = relative(root, path)
    if (entry.isDirectory()) {
      await walk(path)
    } else {
      const info = await lstat(path)
      if (!info.isFile() || entry.isSymbolicLink()) {
        throw new Error(`public tree contains non-regular entry ${display}`)
      }
      publicFiles.push(display)
    }
  }
}
await walk(root)
for (const path of publicFiles) {
  const body = await readFile(resolve(root, path), 'utf8')
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(body)) {
    throw new Error(`public file ${path} contains a private-key marker`)
  }
  if (/\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/u.test(body)) {
    throw new Error(`public file ${path} contains a credential-shaped value`)
  }
}
for (const path of ['package.json', 'package-lock.json', 'schemas/http-capability-instance.schema.v0.1.json']) {
  JSON.parse(await readFile(resolve(root, path), 'utf8'))
}
await loadInstance(['--instance', resolve(root, 'examples/instance.example.json')], {})
console.log(`PASS repository structure files=${publicFiles.length}`)
