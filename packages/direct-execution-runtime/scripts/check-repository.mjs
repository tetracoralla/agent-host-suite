#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { fileURLToPath } from 'node:url'
import { parseStrictJson } from '../src/json.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const ignored = new Set(['.git', 'node_modules', '.verify', 'build'])

async function files(directory) {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) found.push(...await files(path))
    else found.push(path)
  }
  return found
}

const allFiles = await files(root)
for (const required of [
  'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md', 'CONTRIBUTING.md',
  'README.md', 'docs/INTEGRATIONS.md', 'docs/PUBLIC_DEMO.md',
  'examples/demo-math-anchor.mjs', 'examples/contract-selection.example.json',
  'examples/resolution-request.example.json',
  'examples/structured-data-preflight.work-order.example.json', 'schemas/README.md',
]) {
  if (!allFiles.includes(resolve(root, required))) throw new Error(`runtime package file is absent: ${required}`)
}
const sourceFiles = allFiles.filter((path) => path.endsWith('.mjs'))
for (const path of sourceFiles) {
  const checked = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' })
  if (checked.status !== 0) throw new Error(`syntax check failed for ${path}: ${checked.stderr}`)
}

const packageJson = parseStrictJson(await readFile(resolve(root, 'package.json'), 'utf8'), 'package.json')
if (packageJson.private !== true || packageJson.license !== 'Apache-2.0') {
  throw new Error('Agent Host runtime package must remain private from npm publication and use Apache-2.0')
}
if (
  packageJson.repository?.url !== 'git+https://github.com/tetracoralla/agent-host-suite.git' ||
  packageJson.repository?.directory !== 'packages/direct-execution-runtime' ||
  packageJson.homepage !== 'https://github.com/tetracoralla/agent-host-suite/tree/main/packages/direct-execution-runtime#readme' ||
  packageJson.bugs?.url !== 'https://github.com/tetracoralla/agent-host-suite/issues'
) {
  throw new Error('runtime package metadata must identify its Agent Host source location')
}
if (
  packageJson.scripts?.['check:providers'] ||
  packageJson.scripts?.['check:schema-parity'] !== 'node scripts/check-schema-parity.mjs' ||
  !packageJson.scripts?.['check:local-pilots']
) {
  throw new Error('sibling-provider validation must be exposed only as the maintainer-local pilot check')
}
if (
  packageJson.scripts['check:local-pilots'] !== 'node scripts/check-local-pilots.mjs' ||
  allFiles.includes(resolve(root, 'scripts/check-real-providers.mjs'))
) {
  throw new Error('maintainer pilot entry point must retain its explicit local-only identity')
}
if (packageJson.scripts?.['demo:math-anchor'] !== 'node examples/demo-math-anchor.mjs') {
  throw new Error('Math Anchor demo entry point is absent or drifted')
}
const packageLock = parseStrictJson(await readFile(resolve(root, 'package-lock.json'), 'utf8'), 'package-lock.json')
const lockedRoot = packageLock.packages?.['']
if (
  lockedRoot?.name !== packageJson.name ||
  lockedRoot?.version !== packageJson.version ||
  lockedRoot?.license !== packageJson.license ||
  !isDeepStrictEqual(lockedRoot?.bin, packageJson.bin)
) {
  throw new Error('package-lock root identity differs from package.json')
}
for (const packagedPublicFile of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md']) {
  if (!packageJson.files?.includes(packagedPublicFile)) {
    throw new Error(`package file is absent from package.json files: ${packagedPublicFile}`)
  }
}

// Package shape is checkable here; SDK references (including comments) do not
// establish which operations an entry point exposes. Review actual interfaces
// against this package's product contract.
if (allFiles.some((path) => path.endsWith('.mcp.json') || path.includes('/plugins/'))) {
  throw new Error('the v0.1 runtime must not package a model-facing plugin')
}
if (allFiles.some((path) => path.endsWith('.local.json'))) {
  throw new Error('machine-local provider bindings must not be tracked')
}
const productText = (await Promise.all(allFiles.map((path) => readFile(path).catch(() => Buffer.alloc(0))))).join('\n')
const developmentCoordinate = ['/Users', 'openadam', 'Development'].join('/')
if (productText.includes(developmentCoordinate)) {
  throw new Error('tracked product files must not persist development checkout coordinates')
}
const ajv = new Ajv2020({ allErrors: true, strict: false })
addFormats(ajv)
const providerSchema = parseStrictJson(await readFile(resolve(root, 'schemas/provider-config.schema.json'), 'utf8'))
const workOrderSchema = parseStrictJson(await readFile(resolve(root, 'schemas/work-order.schema.json'), 'utf8'))
const contractSelectionSchema = parseStrictJson(await readFile(resolve(root, 'schemas/contract-selection.schema.json'), 'utf8'))
const resolutionRequestSchema = parseStrictJson(await readFile(resolve(root, 'schemas/resolution-request.schema.json'), 'utf8'))
const resolutionResultSchema = parseStrictJson(await readFile(resolve(root, 'schemas/resolution-result.schema.json'), 'utf8'))
const exampleConfig = parseStrictJson(await readFile(resolve(root, 'examples/provider-config.example.json'), 'utf8'))
const exampleOrder = parseStrictJson(await readFile(resolve(root, 'examples/work-order.example.json'), 'utf8'))
const structuredDataProcedureOrder = parseStrictJson(
  await readFile(resolve(root, 'examples/structured-data-preflight.work-order.example.json'), 'utf8'),
)
const exampleSelection = parseStrictJson(await readFile(resolve(root, 'examples/contract-selection.example.json'), 'utf8'))
const exampleResolutionRequest = parseStrictJson(
  await readFile(resolve(root, 'examples/resolution-request.example.json'), 'utf8'),
)
if (!ajv.compile(providerSchema)(exampleConfig)) throw new Error('provider config example does not satisfy its schema')
if (!ajv.compile(workOrderSchema)(exampleOrder)) throw new Error('work-order example does not satisfy its schema')
if (!ajv.compile(workOrderSchema)(structuredDataProcedureOrder)) {
  throw new Error('Structured Data Preflight work-order example does not satisfy its schema')
}
if (!ajv.compile(contractSelectionSchema)(exampleSelection)) throw new Error('contract-selection example does not satisfy its schema')
if (!ajv.compile(resolutionRequestSchema)(exampleResolutionRequest)) {
  throw new Error('resolution-request example does not satisfy its schema')
}
ajv.compile(resolutionResultSchema)

const cli = resolve(root, 'src/cli.mjs')
if (((await stat(cli)).mode & 0o111) === 0) throw new Error('CLI entry point is not executable')
const evalsDriver = resolve(root, 'src/evals-driver.mjs')
if (((await stat(evalsDriver)).mode & 0o111) === 0) throw new Error('evaluator driver entry point is not executable')
process.stdout.write(`runtime package invariants passed for ${sourceFiles.length} executable modules\n`)
