import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'

const [dmgArgument, catalogArgument, destinationArgument] = process.argv.slice(2)
if (dmgArgument === undefined || catalogArgument === undefined || destinationArgument === undefined) {
  throw new Error('Usage: node scripts/write-internal-beta-distribution.mjs DMG RELEASE_CATALOG DESTINATION')
}
const dmgPath = resolve(dmgArgument)
const catalogPath = resolve(catalogArgument)
const destination = resolve(destinationArgument)
const release = JSON.parse(await readFile(catalogPath, 'utf8'))
const hash = createHash('sha256')
await pipeline(createReadStream(dmgPath), hash)
const info = await stat(dmgPath)
const manifest = {
  schemaVersion: 'openadam.agent-host-macos-distribution.v0.1',
  appVersion: '0.1.0',
  buildVersion: process.env.AGENT_HOST_APP_BUILD_VERSION ?? '1',
  suiteReleaseId: release.releaseId,
  suiteVersion: release.suiteVersion,
  status: 'internal-beta',
  platform: 'darwin-arm64',
  artifact: {
    file: basename(dmgPath),
    sha256: `sha256:${hash.digest('hex')}`,
    bytes: info.size,
    format: 'dmg',
  },
  license: {
    spdx: 'Apache-2.0',
    files: ['Agent Host.app/Contents/Resources/agent-host-suite/LICENSE', 'Agent Host.app/Contents/Resources/agent-host-suite/NOTICE', 'Agent Host.app/Contents/Resources/agent-host-suite/THIRD_PARTY_NOTICES.txt'],
  },
  signing: { kind: 'ad-hoc', developerId: false },
  notarization: { submitted: false, stapled: false },
}
await writeFile(destination, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
