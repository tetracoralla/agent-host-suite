import './sync-platform-support.mjs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const required = [
  'AGENTS.md', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt', 'README.md', 'README.zh-CN.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md',
  'Package.swift', 'macos/Info.plist', 'macos/AgentHost.icns', 'macos/AgentHostIcon.png', 'macos/brand/AgentHost-1024.png', 'macos/brand/AgentHost-carrier-1024.png', 'macos/AgentHostMenuBar.svg', 'scripts/build-app-icon.sh',
  'windows/Install Agent Host.cmd', 'windows/Install-AgentHost.ps1', 'windows/Uninstall-AgentHost.ps1', 'scripts/package-windows.mjs',
  'docs/PRODUCT_MODEL.md', 'docs/ARCHITECTURE.md', 'docs/TERMINOLOGY.md', 'docs/TOOL_INTEGRATION.md', 'docs/BRAND.md', 'docs/RELEASE.md', 'docs/REVIEW_CONTRACT.md', 'docs/WINDOWS.md', 'docs/WINDOWS.zh-CN.md',
  'docs/DISCOVERY_PROJECTION.md', 'docs/FEATURED_CATALOG.md', 'docs/ADOPTION_ACCEPTANCE.md', 'docs/UNSIGNED_PREVIEW.md', 'docs/UPDATES.md',
  'docs/unsigned-preview-release.yml', 'docs/scan-github-tools.yml', '.github/workflows/unsigned-preview-release.yml', 'scripts/write-preview-distribution.mjs', 'scripts/admit-github-plugin.mjs', 'scripts/sync-github-catalog.mjs', 'scripts/verify-application-update.mjs', 'scripts/build-unsigned-preview-catalog.mjs',
  'catalog/github-tools.json', 'catalog/github-releases/current.json',
  'schemas/agent-host-github-tools.schema.v0.1.json', 'schemas/agent-host-github-catalog.schema.v0.1.json', 'schemas/agent-host-component.schema.v0.2.json',
  'schemas/agent-host-preview-distribution.schema.v0.1.json', 'catalog/preview-distribution.json',
  'scripts/check-manager-models.sh', 'scripts/write-internal-beta-distribution.mjs', 'scripts/check-macos-distribution.sh', 'Tests/AgentHostManagerChecks/main.swift',
  'scripts/release-source-provenance.mjs', 'scripts/check-release-source-provenance.mjs', 'scripts/provider-source-build.mjs', 'src/release-provenance.mjs',
  'schemas/agent-host-activity.schema.v0.1.json', 'schemas/agent-host-usage.schema.v0.1.json',
  'schemas/agent-host-trace-source-catalog.schema.v0.1.json', 'schemas/agent-host-trace-analysis-pack.schema.v0.1.json', 'schemas/agent-host-trace-analysis-pack.schema.v0.2.json',
  'schemas/agent-host-release-source-lock.schema.v0.1.json', 'schemas/agent-host-build-provenance.schema.v0.1.json',
  'schemas/agent-host-developer-kit-integration.schema.v0.1.json',
  'schemas/agent-host-profile.schema.v0.1.json', 'schemas/agent-host-profile.schema.v0.2.json',
  'schemas/agent-host-tool-integration.schema.v0.1.json', 'schemas/agent-host-tool-integration.schema.v0.2.json', 'schemas/agent-host-tool-integration.schema.v0.3.json', 'schemas/agent-host-tool-integration.schema.v0.4.json', 'schemas/agent-host-tool-integration.schema.v0.5.json',
  '.github/workflows/ci.yml', '.github/workflows/codeql.yml', '.github/workflows/release.yml',
]
for (const path of required) {
  if (!(await stat(join(root, path))).isFile()) throw new Error(`missing required public file: ${path}`)
}

async function files(directory) {
  const output = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.build' || entry.name === '.verify') continue
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
for (const path of publicFiles.filter((item) => /\.(?:cmd|md|mjs|json|ps1|toml|yml|yaml|swift|plist|sh|txt)$/u.test(item))) {
  const text = await readFile(path, 'utf8')
  for (const value of forbidden) if (text.includes(value)) throw new Error(`${relative(root, path)} contains forbidden tracked material: ${value}`)
}
for (const relativePath of [
  'src/mcp-health.mjs',
  'src/context-exporter.mjs',
  'src/skill-link-catalog.mjs',
  'scripts/probe-provider-discovery.mjs',
  'scripts/check-skill-refinery-vertical.mjs',
]) {
  const source = await readFile(join(root, relativePath), 'utf8')
  if (source.includes('StdioClientTransport')) {
    throw new Error(`${relativePath} must use the Host-owned process-scope MCP transport`)
  }
  if (!source.includes('ManagedMcpStdioTransport')) {
    throw new Error(`${relativePath} does not bind the Host-owned process-scope MCP transport`)
  }
}
const release = JSON.parse(await readFile(join(root, 'catalog/releases/draft-unbound.v0.1.json'), 'utf8'))
if (release.status !== 'draft-unbound' || release.components.length !== 0) throw new Error('unbound release catalog must fail closed')
const featured = JSON.parse(await readFile(join(root, 'catalog/profiles/featured.json'), 'utf8'))
if (featured.id !== 'featured' || featured.extends !== 'standard' || !featured.components.includes('armorial') || !featured.agentComponents.includes('armorial')) {
  throw new Error('featured catalog must admit armorial on top of standard')
}
const featuredDefaults = featured.defaultAgentComponents ?? []
if (!['math-anchor', 'migratory-time', 'armorial'].every((id) => featuredDefaults.includes(id))) {
  throw new Error('featured default working set must include math-anchor, migratory-time, and armorial')
}
const dogfood = JSON.parse(await readFile(join(root, 'catalog/profiles/local-dogfood.json'), 'utf8'))
const dogfoodOnly = dogfood.components.filter((id) => id !== 'armorial')
if (dogfoodOnly.some((id) => featured.components.includes(id))) {
  throw new Error('featured catalog must not include local-dogfood-only tools')
}
const featuredDoc = await readFile(join(root, 'docs/FEATURED_CATALOG.md'), 'utf8')
if (!featuredDoc.includes('--profile featured') || !featuredDoc.includes('profiles list') || !featuredDoc.includes('draft-unbound')) {
  throw new Error('featured catalog document must name the CLI path and unbound fail-closed')
}
if (!featuredDoc.includes('not a public marketplace') || !featuredDoc.includes('--development-root')) {
  throw new Error('featured catalog document must remain a non-marketplace admission list with a bound-release path')
}
if (!featuredDoc.includes('--no-host') || !featuredDoc.includes('Get featured tools') || !featuredDoc.includes('working set')) {
  throw new Error('featured catalog document must distinguish inventory install from working-set selection and allow setup without an Agent app')
}
if (!featuredDoc.includes('Gatekeeper') || !featuredDoc.includes('AGENT_HOST_FEATURED_CATALOG_URL')) {
  throw new Error('featured catalog document must keep unsigned macOS Gatekeeper copy and an honest download hook')
}
if (!featuredDoc.includes('UNSIGNED_PREVIEW.md') || featuredDoc.includes('until a Developer ID signed build exists')) {
  throw new Error('featured catalog document must point at unsigned preview download and must not promise a future notarized build')
}
if (!featuredDoc.includes('profiles fetch') || !featuredDoc.includes('public download is not configured')) {
  throw new Error('featured catalog document must name profiles fetch and the unconfigured download state')
}
if (!featuredDoc.includes('source status') || !featuredDoc.includes('Catalog assets are unpublished')) {
  throw new Error('featured catalog document must name source status and unpublished catalog assets')
}
if (!featuredDoc.includes('experimental variable')) {
  throw new Error('featured catalog document must treat recipe consistency as an experimental variable')
}
const previewDoc = await readFile(join(root, 'docs/UNSIGNED_PREVIEW.md'), 'utf8')
if (!previewDoc.includes('Control-click') || !previewDoc.includes('AGENT_HOST_FEATURED_CATALOG_URL') || !previewDoc.includes('preview-distribution.json')) {
  throw new Error('unsigned preview document must name Gatekeeper, the catalog URL hook, and the index asset')
}
if (previewDoc.includes('notarytool') || previewDoc.includes('APPLE_NOTARY')) {
  throw new Error('unsigned preview document must not instruct Apple notarization')
}
if (!previewDoc.includes('UPDATES.md') || !previewDoc.includes('unsigned-preview-release.yml')) {
  throw new Error('unsigned preview document must name the unsigned pipeline draft and UPDATES.md')
}
const unsignedWorkflow = await readFile(join(root, 'docs/unsigned-preview-release.yml'), 'utf8')
if (unsignedWorkflow.includes('notarytool') || unsignedWorkflow.includes('APPLE_NOTARY') || unsignedWorkflow.includes('APPLE_DEVELOPER_ID')) {
  throw new Error('unsigned preview workflow draft must not require Apple notarization credentials')
}
if (!unsignedWorkflow.includes('Unsigned preview') || !unsignedWorkflow.includes('admit-github-plugin.mjs')) {
  throw new Error('unsigned preview workflow draft must admit GitHub tools on a clean runner without Apple secrets')
}
if (unsignedWorkflow.includes('needs: github-tools') || unsignedWorkflow.includes('name: github-tools')) {
  throw new Error('unsigned preview workflow must not reuse one OS GitHub-tool archive on other platforms')
}
const liveUnsigned = await readFile(join(root, '.github/workflows/unsigned-preview-release.yml'), 'utf8')
if (liveUnsigned.includes('notarytool') || liveUnsigned.includes('APPLE_NOTARY') || liveUnsigned.includes('needs: github-tools')) {
  throw new Error('live unsigned preview workflow must admit per platform and must not require Apple notarization')
}
if (unsignedWorkflow.includes('createReleaseFixture') || unsignedWorkflow.includes('test/release-helpers.mjs')) {
  throw new Error('unsigned preview workflow must not package test fixtures as the application payload')
}
if (!unsignedWorkflow.includes('build-unsigned-preview-catalog.mjs')) {
  throw new Error('unsigned preview workflow must build a verified catalog on the runner')
}
const readme = await readFile(join(root, 'README.md'), 'utf8')
if (!readme.includes('not Apple-notarized') && !readme.includes('No notarization')) {
  throw new Error('README must state that preview distribution is not notarized')
}
if (!readme.includes('AGENT_HOST_FEATURED_CATALOG_URL') || !readme.includes('UNSIGNED_PREVIEW.md')) {
  throw new Error('README must name the catalog download hook and unsigned preview document')
}
if (!readme.includes('UPDATES.md') || !readme.includes('profiles fetch --carrier')) {
  throw new Error('README must name GitHub updates and that carrier fetch is not application replacement')
}
const readmeZh = await readFile(join(root, 'README.zh-CN.md'), 'utf8')
if (!readmeZh.includes('无公证') || !readmeZh.includes('AGENT_HOST_FEATURED_CATALOG_URL')) {
  throw new Error('Chinese README must state 无公证 and the catalog download hook')
}
const unpublished = JSON.parse(await readFile(join(root, 'catalog/preview-distribution.json'), 'utf8'))
if (unpublished.publicReleasePublished !== false || unpublished.notarized !== false || unpublished.catalog !== null || unpublished.carriers.length !== 0) {
  throw new Error('tracked preview-distribution.json must remain an unpublished placeholder')
}
const draftWorkflow = await readFile(join(root, 'docs/unsigned-preview-release.yml'), 'utf8')
if (draftWorkflow.includes('notarytool') || draftWorkflow.includes('APPLE_NOTARY')) {
  throw new Error('unsigned preview workflow draft must not require Apple notarization')
}
if (!featuredDoc.includes('ADOPTION_ACCEPTANCE.md')) {
  throw new Error('featured catalog document must point at the unnamed adoption protocol')
}
const adoptionDoc = await readFile(join(root, 'docs/ADOPTION_ACCEPTANCE.md'), 'utf8')
if (!adoptionDoc.includes('fresh Agent task') || !adoptionDoc.includes('not adoption evidence') || !adoptionDoc.includes('doctor --featured-readiness')) {
  throw new Error('adoption protocol must require a fresh Agent task and refuse Host status as evidence')
}
if (!adoptionDoc.includes('recipe.consistency') || !adoptionDoc.includes('userStatus') || !adoptionDoc.includes('local-dogfood')) {
  throw new Error('adoption protocol must separate user-level readiness from recipe consistency')
}
if (!adoptionDoc.includes('experimental variable') || adoptionDoc.includes('unnamed adoption cannot be scored on that Host even when user-level readiness')) {
  throw new Error('adoption protocol must record working set as an experimental variable and must not gate scoring on recipe name')
}
if (!adoptionDoc.includes('docs/fixtures/adoption')) {
  throw new Error('adoption protocol must ship unnamed fixtures')
}
const adoptionFixtureRoot = join(root, 'docs/fixtures/adoption')
const steered = /\barmorial\b|\blucide\b|\biconpark\b|请使用/iu
async function adoptionFixtures(directory) {
  const output = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) output.push(...await adoptionFixtures(path))
    else output.push(path)
  }
  return output
}
const adoptionFiles = await adoptionFixtures(adoptionFixtureRoot)
if (adoptionFiles.length === 0) throw new Error('adoption fixtures are missing')
for (const path of adoptionFiles) {
  const text = await readFile(path, 'utf8')
  if (steered.test(text)) throw new Error(`${relative(root, path)} names a steered icon product`)
}
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
