import { resolve } from 'node:path'
import { stageBundledReleaseCatalog } from '../src/bundled-release.mjs'

const [source, destination, profile = 'standard'] = process.argv.slice(2)
if (source === undefined || destination === undefined) {
  throw new Error('Usage: node scripts/stage-bundled-release-catalog.mjs SOURCE DESTINATION [PROFILE]')
}
const result = await stageBundledReleaseCatalog(resolve(source), resolve(destination), profile)
process.stdout.write(`${JSON.stringify(result)}\n`)
