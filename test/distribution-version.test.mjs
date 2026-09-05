import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const writer = new URL('../scripts/write-internal-beta-distribution.mjs', import.meta.url)
const distributionChecker = new URL('../scripts/check-macos-distribution.sh', import.meta.url)
const appPackager = new URL('../scripts/package-macos-app.sh', import.meta.url)
const suitePackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

async function fixture(t, version = suitePackage.version) {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-distribution-version-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const catalogRoot = join(root, 'catalog')
  await mkdir(catalogRoot)
  await mkdir(join(catalogRoot, 'artifacts'))
  const release = { releaseId: 'fixture-release', suiteVersion: version }
  const provenance = { policy: 'local-development', releaseId: release.releaseId, suiteVersion: version }
  const catalog = join(catalogRoot, 'current.json')
  const dmg = join(root, 'Agent Host.dmg')
  const destination = join(root, 'distribution.json')
  await writeFile(catalog, `${JSON.stringify(release)}\n`)
  await writeFile(join(catalogRoot, 'build-provenance.json'), `${JSON.stringify(provenance)}\n`)
  await writeFile(dmg, 'fixture dmg bytes\n')
  return { catalog, dmg, destination }
}

test('internal Beta distribution derives one Host, Manager, catalog, and provenance version identity', async (t) => {
  const { catalog, dmg, destination } = await fixture(t)
  await execFileAsync(process.execPath, [writer.pathname, dmg, catalog, destination])
  const manifest = JSON.parse(await readFile(destination, 'utf8'))
  assert.equal(manifest.appVersion, suitePackage.version)
  assert.equal(manifest.suiteVersion, suitePackage.version)
  assert.equal(manifest.status, 'internal-beta')
  assert.equal(manifest.suiteReleaseId, 'fixture-release')
  assert.match(manifest.releaseCatalog.sha256, /^sha256:[0-9a-f]{64}$/u)
  assert.equal(manifest.releaseCatalog.files, 2)
})

test('distribution check rejects an unrelated same-version release catalog before mounting', async (t) => {
  const { catalog, dmg, destination } = await fixture(t)
  await execFileAsync(process.execPath, [writer.pathname, dmg, catalog, destination])
  const unrelatedRoot = await mkdtemp(join(tmpdir(), 'agent-host-unrelated-catalog-'))
  t.after(() => rm(unrelatedRoot, { recursive: true, force: true }))
  await mkdir(join(unrelatedRoot, 'artifacts'))
  await writeFile(join(unrelatedRoot, 'current.json'), `${JSON.stringify({
    releaseId: 'unrelated-same-version-release',
    suiteVersion: suitePackage.version,
  })}\n`)
  await writeFile(join(unrelatedRoot, 'build-provenance.json'), `${JSON.stringify({
    policy: 'local-development',
    releaseId: 'unrelated-same-version-release',
    suiteVersion: suitePackage.version,
  })}\n`)

  await assert.rejects(
    execFileAsync('/bin/zsh', [distributionChecker.pathname, 'internal-beta', dmg, destination], {
      env: { ...process.env, AGENT_HOST_RELEASE_CATALOG: unrelatedRoot },
    }),
    /distribution manifest and release catalog identity differ/u,
  )
})

test('internal Beta distribution refuses a release version that differs from the Host and Manager identity', async (t) => {
  const { catalog, dmg, destination } = await fixture(t, '0.1.0')
  await assert.rejects(
    execFileAsync(process.execPath, [writer.pathname, dmg, catalog, destination]),
    /Host package, Manager app, release catalog, and source provenance versions must identify one distribution/u,
  )
  await assert.rejects(() => access(destination), (error) => error.code === 'ENOENT')
})

test('macOS app packaging refuses a stale catalog before starting a Swift build', async (t) => {
  const { catalog } = await fixture(t, '0.1.0')
  const catalogRoot = join(catalog, '..')
  await assert.rejects(
    execFileAsync('/bin/zsh', [appPackager.pathname, 'debug'], {
      env: { ...process.env, AGENT_HOST_RELEASE_CATALOG: catalogRoot },
    }),
    /Host package, Manager app, and release catalog versions differ/u,
  )
})
