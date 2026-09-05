import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadBuildProvenance } from '../src/release-provenance.mjs'

const [catalogArgument, allowedArgument = 'local-development,local-clean,remote-tagged'] = process.argv.slice(2)
if (catalogArgument === undefined) throw new Error('Usage: node scripts/check-release-source-provenance.mjs CATALOG [ALLOWED_POLICIES]')
const catalog = resolve(catalogArgument)
const release = JSON.parse(await readFile(resolve(catalog, 'current.json'), 'utf8'))
const { record: provenance } = await loadBuildProvenance(resolve(catalog, 'build-provenance.json'), release)
const allowed = new Set(allowedArgument.split(',').map((value) => value.trim()).filter(Boolean))
if (!allowed.has(provenance.policy)) throw new Error(`release source policy ${provenance.policy} is not allowed; expected ${[...allowed].join(', ')}`)
process.stdout.write(`${JSON.stringify({ status: 'ok', policy: provenance.policy, releaseId: provenance.releaseId })}\n`)
