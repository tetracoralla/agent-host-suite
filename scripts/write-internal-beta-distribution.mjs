import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { hashReleaseCatalog } from './hash-release-catalog.mjs'

const [dmgArgument, catalogArgument, destinationArgument] = process.argv.slice(2)
if (dmgArgument === undefined || catalogArgument === undefined || destinationArgument === undefined) {
  throw new Error('Usage: node scripts/write-internal-beta-distribution.mjs DMG RELEASE_CATALOG DESTINATION')
}
const dmgPath = resolve(dmgArgument)
const catalogPath = resolve(catalogArgument)
const destination = resolve(destinationArgument)
const release = JSON.parse(await readFile(catalogPath, 'utf8'))
const suitePackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const sourceInfoPlist = await readFile(new URL('../macos/Info.plist', import.meta.url), 'utf8')
const infoVersionMatch = sourceInfoPlist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/u)
const provenancePath = resolve(dirname(catalogPath), 'build-provenance.json')
const provenance = JSON.parse(await readFile(provenancePath, 'utf8'))
const catalogIdentity = await hashReleaseCatalog(dirname(catalogPath))
if (typeof suitePackage.version !== 'string'
  || infoVersionMatch === null
  || release.suiteVersion !== suitePackage.version
  || infoVersionMatch[1] !== suitePackage.version
  || provenance.suiteVersion !== suitePackage.version
  || provenance.releaseId !== release.releaseId) {
  throw new Error('Host package, Manager app, release catalog, and source provenance versions must identify one distribution')
}
const provenanceHash = createHash('sha256').update(await readFile(provenancePath)).digest('hex')
const hash = createHash('sha256')
await pipeline(createReadStream(dmgPath), hash)
const info = await stat(dmgPath)
const manifest = {
  schemaVersion: 'openadam.agent-host-macos-distribution.v0.1',
  appVersion: suitePackage.version,
  buildVersion: process.env.AGENT_HOST_APP_BUILD_VERSION ?? '1',
  suiteReleaseId: release.releaseId,
  suiteVersion: release.suiteVersion,
  releaseCatalog: {
    file: 'Agent Host.app/Contents/Resources/agent-host-suite/catalog/releases/current.json',
    sha256: catalogIdentity.sha256,
    files: catalogIdentity.files,
  },
  status: 'internal-beta',
  platform: 'darwin-arm64',
  artifact: {
    file: basename(dmgPath),
    sha256: `sha256:${hash.digest('hex')}`,
    bytes: info.size,
    format: 'dmg',
  },
  sourceProvenance: {
    policy: provenance.policy,
    file: 'Agent Host.app/Contents/Resources/agent-host-suite/catalog/releases/build-provenance.json',
    sha256: `sha256:${provenanceHash}`,
  },
  license: {
    spdx: 'Apache-2.0',
    files: ['Agent Host.app/Contents/Resources/agent-host-suite/LICENSE', 'Agent Host.app/Contents/Resources/agent-host-suite/NOTICE', 'Agent Host.app/Contents/Resources/agent-host-suite/THIRD_PARTY_NOTICES.txt'],
  },
  signing: { kind: 'ad-hoc', developerId: false },
  notarization: { submitted: false, stapled: false },
}
await writeFile(destination, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
