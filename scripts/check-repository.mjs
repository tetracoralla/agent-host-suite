import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const required = [
  'AGENTS.md', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt', 'README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md',
  'Package.swift', 'macos/Info.plist', 'macos/AgentHostIcon.svg', 'macos/AgentHostMenuBar.svg', 'scripts/build-app-icon.sh', 'docs/PRODUCT_MODEL.md', 'docs/ARCHITECTURE.md', 'docs/TERMINOLOGY.md', 'docs/TOOL_INTEGRATION.md', 'docs/BRAND.md', 'docs/RELEASE.md', 'docs/REVIEW_CONTRACT.md',
  'scripts/check-manager-models.sh', 'Tests/AgentHostManagerChecks/main.swift',
  'schemas/agent-host-activity.schema.v0.1.json',
  'schemas/agent-host-tool-integration.schema.v0.1.json', 'schemas/agent-host-tool-integration.schema.v0.2.json',
  '.github/workflows/ci.yml', '.github/workflows/codeql.yml', '.github/workflows/release.yml',
]
for (const path of required) {
  if (!(await stat(join(root, path))).isFile()) throw new Error(`missing required public file: ${path}`)
}

async function files(directory) {
  const output = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.build') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) output.push(...await files(path))
    else output.push(path)
  }
  return output
}

const publicFiles = await files(root)
for (const path of publicFiles.filter((item) => item.endsWith('.json'))) JSON.parse(await readFile(path, 'utf8'))
const forbidden = [
  ['/Users', 'openadam', ''].join('/'),
  ['BEGIN', 'PRIVATE', 'KEY'].join(' '),
  ['APPLE', 'DEVELOPER', 'ID', 'P12', 'BASE64='].join('_'),
]
for (const path of publicFiles.filter((item) => /\.(?:md|mjs|json|toml|yml|yaml|swift|plist|sh|txt)$/u.test(item))) {
  const text = await readFile(path, 'utf8')
  for (const value of forbidden) if (text.includes(value)) throw new Error(`${relative(root, path)} contains forbidden tracked material: ${value}`)
}
const release = JSON.parse(await readFile(join(root, 'catalog/releases/draft-unbound.v0.1.json'), 'utf8'))
if (release.status !== 'draft-unbound' || release.components.length !== 0) throw new Error('unbound release catalog must fail closed')
const infoPlist = await readFile(join(root, 'macos/Info.plist'), 'utf8')
if (!infoPlist.includes('<key>CFBundleIconFile</key><string>AgentHost</string>')) throw new Error('macOS app icon is not bound in Info.plist')
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const packageLock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
if (packageLock.version !== packageJson.version || packageLock.packages?.['']?.version !== packageJson.version) {
  throw new Error('package-lock root identity differs from package.json')
}
if (!infoPlist.includes(`<key>CFBundleShortVersionString</key><string>${packageJson.version}</string>`)) {
  throw new Error('macOS app version differs from package.json')
}
console.log(`repository invariants passed for ${publicFiles.length} public files`)
