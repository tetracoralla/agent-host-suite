import { resolve } from 'node:path'
import { stageBundledReleaseCatalog, stageBundledReleaseCatalogForIds } from '../src/bundled-release.mjs'

const [source, destination, profile = 'standard'] = process.argv.slice(2)
if (source === undefined || destination === undefined) {
  throw new Error('Usage: node scripts/stage-bundled-release-catalog.mjs SOURCE DESTINATION [PROFILE]')
}
const componentIds = (process.env.AGENT_HOST_BUNDLED_COMPONENTS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
const result = componentIds.length > 0
  ? await stageBundledReleaseCatalogForIds(resolve(source), resolve(destination), componentIds)
  : await stageBundledReleaseCatalog(resolve(source), resolve(destination), profile)
process.stdout.write(`${JSON.stringify(result)}\n`)
