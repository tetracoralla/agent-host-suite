import assert from 'node:assert/strict'
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import {
  BUILD_PROVENANCE_SCHEMA,
  inspectBuildSources,
  materializeGitSourceSnapshots,
  SOURCE_LOCK_SCHEMA,
  validateBuildProvenance,
  validateSourceLock,
} from '../scripts/release-source-provenance.mjs'
import {
  buildArmorialPluginFromVerifiedSource,
  buildFileVitalsPluginFromSource,
  extractVerifiedProviderPluginArchive,
  fileVitalsSourceBuildRequired,
  inspectProviderPluginArchive,
} from '../scripts/provider-source-build.mjs'

const execFileAsync = promisify(execFile)

function octalField(value, length) {
  return `${value.toString(8).padStart(length - 1, '0')}\0`
}

function tarArchive(entries) {
  const blocks = []
  for (const { name, contents } of entries) {
    const payload = Buffer.from(contents)
    const header = Buffer.alloc(512)
    header.write(name, 0, 100, 'utf8')
    header.write(octalField(0o644, 8), 100, 8, 'ascii')
    header.write(octalField(0, 8), 108, 8, 'ascii')
    header.write(octalField(0, 8), 116, 8, 'ascii')
    header.write(octalField(payload.length, 12), 124, 12, 'ascii')
    header.write(octalField(0, 12), 136, 12, 'ascii')
    header.fill(0x20, 148, 156)
    header.write('0', 156, 1, 'ascii')
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
    blocks.push(header, payload, Buffer.alloc((512 - (payload.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks), { level: 9, mtime: 0 })
}

async function repository(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-source-policy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await execFileAsync((process.platform === 'win32' ? 'git.exe' : '/usr/bin/git'), ['init', '-q'], { cwd: root })
  await execFileAsync((process.platform === 'win32' ? 'git.exe' : '/usr/bin/git'), ['config', 'user.name', 'Agent Host Test'], { cwd: root })
  await execFileAsync((process.platform === 'win32' ? 'git.exe' : '/usr/bin/git'), ['config', 'user.email', 'agent-host@example.invalid'], { cwd: root })
  await writeFile(join(root, '.gitignore'), 'ignored-output\n')
  await writeFile(join(root, 'package.json'), '{}\n')
  await execFileAsync((process.platform === 'win32' ? 'git.exe' : '/usr/bin/git'), ['add', '.gitignore', 'package.json'], { cwd: root })
  await execFileAsync((process.platform === 'win32' ? 'git.exe' : '/usr/bin/git'), ['commit', '-qm', 'fixture'], { cwd: root })
  await execFileAsync((process.platform === 'win32' ? 'git.exe' : '/usr/bin/git'), ['remote', 'add', 'origin', 'https://github.com/tetracoralla/fixture.git'], { cwd: root })
  const { stdout } = await execFileAsync((process.platform === 'win32' ? 'git.exe' : '/usr/bin/git'), ['rev-parse', 'HEAD'], { cwd: root })
  return { root, revision: stdout.trim() }
}

async function armorialRepository(t, { failRelease = false, linkedRelease = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-armorial-source-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await execFileAsync((process.platform === 'win32' ? 'git.exe' : '/usr/bin/git'), ['init', '-q'], { cwd: root })
  await execFileAsync((process.platform === 'win32' ? 'git.exe' : '/usr/bin/git'), ['config', 'user.name', 'Agent Host Test'], { cwd: root })
  await execFileAsync((process.platform === 'win32' ? 'git.exe' : '/usr/bin/git'), ['config', 'user.email', 'agent-host@example.invalid'], { cwd: root })
  await mkdir(join(root, 'scripts'))
  await mkdir(join(root, 'payload', 'armorial', '.codex-plugin'), { recursive: true })
  await writeFile(join(root, '.gitignore'), '.release/\nnode_modules/\n')
  await writeFile(join(root, 'package.json'), `${JSON.stringify({
    name: 'armorial',
    version: '0.7.0',
    type: 'module',
    scripts: { 'release:plugin': 'node scripts/release.mjs' },
  }, null, 2)}\n`)
  await writeFile(join(root, 'package-lock.json'), `${JSON.stringify({
    name: 'armorial',
    version: '0.7.0',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'armorial', version: '0.7.0' } },
  }, null, 2)}\n`)
  const manifest = `${JSON.stringify({ name: 'armorial', version: '0.7.0' }, null, 2)}\n`
  await writeFile(join(root, 'payload', 'armorial', 'package.json'), manifest)
  await writeFile(join(root, 'payload', 'armorial', '.codex-plugin', 'plugin.json'), manifest)
  await writeFile(join(root, 'scripts', 'release.mjs'), String.raw`
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const output = process.env.ARMORIAL_RELEASE_DIRECTORY
mkdirSync(output, { recursive: true })
const archiveName = 'armorial-0.7.0-codex-plugin-macos-arm64.tar.gz'
if (${failRelease ? 'true' : 'false'}) {
  writeFileSync(join(output, archiveName + '.partial'), 'partial\n')
  throw new Error('fixture source build failed after a partial write')
}

const temporary = join(output, archiveName + '.tar')
if (${linkedRelease ? 'true' : 'false'}) symlinkSync('/tmp/armorial-source-build-outside', join('payload', 'armorial', 'escape'))
execFileSync('/usr/bin/tar', [
  '-cf', temporary, '--format=ustar', '--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'wheel',
  '-C', 'payload', 'armorial/package.json', 'armorial/.codex-plugin/plugin.json', ${linkedRelease ? "'armorial/escape'," : ''}
])
execFileSync('/usr/bin/gzip', ['-n', '-f', temporary])
const archive = join(output, archiveName)
renameSync(temporary + '.gz', archive)
const digest = createHash('sha256').update(readFileSync(archive)).digest('hex')
writeFileSync(archive + '.sha256', digest + '  ' + archiveName + '\n')
`)
  await execFileAsync((process.platform === 'win32' ? 'git.exe' : '/usr/bin/git'), ['add', '.'], { cwd: root })
  await execFileAsync((process.platform === 'win32' ? 'git.exe' : '/usr/bin/git'), ['commit', '-qm', 'armorial fixture'], { cwd: root })
  await execFileAsync((process.platform === 'win32' ? 'git.exe' : '/usr/bin/git'), ['remote', 'add', 'origin', 'https://github.com/tetracoralla/armorial-fixture.git'], { cwd: root })
  const { stdout } = await execFileAsync((process.platform === 'win32' ? 'git.exe' : '/usr/bin/git'), ['rev-parse', 'HEAD'], { cwd: root })
  return { root, revision: stdout.trim() }
}

async function fileVitalsRepository(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-file-vitals-source-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await execFileAsync((process.platform === 'win32' ? 'git.exe' : '/usr/bin/git'), ['init', '-q'], { cwd: root })
  await execFileAsync((process.platform === 'win32' ? 'git.exe' : '/usr/bin/git'), ['config', 'user.name', 'Agent Host Test'], { cwd: root })
  await execFileAsync((process.platform === 'win32' ? 'git.exe' : '/usr/bin/git'), ['config', 'user.email', 'agent-host@example.invalid'], { cwd: root })
  const bundle = 'file-vitals-0.3.3-darwin-arm64'
  await mkdir(join(root, '.codex-plugin'), { recursive: true })
  await mkdir(join(root, 'payload', bundle, '.codex-plugin'), { recursive: true })
  await mkdir(join(root, 'payload', bundle, 'capabilities'), { recursive: true })
  await mkdir(join(root, 'payload', bundle, 'runtime'), { recursive: true })
  await mkdir(join(root, 'scripts'), { recursive: true })
  await writeFile(join(root, '.gitignore'), 'dist/\n')
  const plugin = `${JSON.stringify({ name: 'file-vitals', version: '0.3.3' })}\n`
  await writeFile(join(root, '.codex-plugin/plugin.json'), plugin)
  await writeFile(join(root, 'payload', bundle, '.codex-plugin/plugin.json'), plugin)
  await writeFile(join(root, 'payload', bundle, 'capabilities/provider.json'), `${JSON.stringify({
    provider: { id: 'io.github.tetracoralla.file-vitals', version: '0.3.3' },
    implementations: [{
      capabilityId: 'org.openadam.file.inspect',
      capabilityVersion: '0.1.0',
      adapter: {
        protocol: 'openadam.capability-jsonl.v0.1',
        command: './runtime/file-vitals-capability',
        args: [],
        cwd: '.',
      },
    }],
  })}\n`)
  for (const name of ['finspect', 'file-vitals-capability', 'file-vitals-transport-schema-probe']) {
    const path = join(root, 'payload', bundle, 'runtime', name)
    await writeFile(path, '#!/bin/sh\nexit 0\n')
    await chmod(path, 0o755)
  }
  await writeFile(join(root, 'scripts/build_plugin.sh'), `#!/bin/bash
set -euo pipefail
bundle='${bundle}'
rm -rf dist/plugin
mkdir -p dist/plugin
cp -R "payload/$bundle" "dist/plugin/$bundle"
find "dist/plugin/$bundle" -type f -exec touch -t 200001010000 {} +
list="$(mktemp)"
(cd dist/plugin && find "$bundle" -type f -print | LC_ALL=C sort > "$list")
tarfile="$(mktemp)"
COPYFILE_DISABLE=1 /usr/bin/tar -cf "$tarfile" --format=ustar --uid 0 --gid 0 --uname root --gname wheel -C dist/plugin -T "$list"
/usr/bin/gzip -n -f "$tarfile"
mv "$tarfile.gz" "dist/plugin/$bundle.tar.gz"
(cd dist/plugin && shasum -a 256 "$bundle.tar.gz" > "$bundle.tar.gz.sha256")
rm -f "$list"
`)
  await chmod(join(root, 'scripts/build_plugin.sh'), 0o755)
  await execFileAsync((process.platform === 'win32' ? 'git.exe' : '/usr/bin/git'), ['add', '.'], { cwd: root })
  await execFileAsync((process.platform === 'win32' ? 'git.exe' : '/usr/bin/git'), ['commit', '-qm', 'file vitals fixture'], { cwd: root })
  await execFileAsync((process.platform === 'win32' ? 'git.exe' : '/usr/bin/git'), ['remote', 'add', 'origin', 'https://github.com/tetracoralla/file-vitals-fixture.git'], { cwd: root })
  const { stdout } = await execFileAsync((process.platform === 'win32' ? 'git.exe' : '/usr/bin/git'), ['rev-parse', 'HEAD'], { cwd: root })
  return { root, revision: stdout.trim() }
}

async function remoteObservation(t, fixture) {
  const sourceLockPath = join(tmpdir(), `agent-host-armorial-source-lock-${process.pid}-${Date.now()}.json`)
  t.after(() => rm(sourceLockPath, { force: true }))
  await writeFile(sourceLockPath, `${JSON.stringify({
    schemaVersion: SOURCE_LOCK_SCHEMA,
    sources: {
      armorial: {
        repository: 'https://github.com/tetracoralla/armorial-fixture.git',
        ref: 'refs/tags/v0.7.0',
        revision: fixture.revision,
      },
    },
  })}\n`)
  return (await inspectBuildSources('remote-tagged', { armorial: fixture.root }, {
    sourceLockPath,
    remoteResolver: async () => fixture.revision,
  })).armorial
}

test('local-clean source policy rejects a dirty repository before packaging', async (t) => {
  const fixture = await repository(t)
  await writeFile(join(fixture.root, 'uncommitted.txt'), 'dirty\n')
  await assert.rejects(
    inspectBuildSources('local-clean', { suite: fixture.root }),
    /dirty repositories: suite/u,
  )
  const development = await inspectBuildSources('local-development', { suite: fixture.root })
  assert.equal(development.suite.dirty, true)
  assert.equal(development.suite.sourcePolicy, 'local-development')
})

test('remote-tagged source policy requires the checkout and remote tag to match the lock', async (t) => {
  const fixture = await repository(t)
  // The lock is release input rather than tracked content. Keeping it outside
  // the checkout avoids the impossible cycle where a commit contains its own
  // final revision.
  const externalLock = join(tmpdir(), `agent-host-source-lock-${process.pid}-${Date.now()}.json`)
  t.after(() => rm(externalLock, { force: true }))
  await writeFile(externalLock, `${JSON.stringify({
    schemaVersion: SOURCE_LOCK_SCHEMA,
    sources: {
      suite: {
        repository: 'https://github.com/tetracoralla/fixture.git',
        ref: 'refs/tags/v1.0.0',
        revision: fixture.revision,
      },
    },
  })}\n`)
  const verified = await inspectBuildSources('remote-tagged', { suite: fixture.root }, {
    sourceLockPath: externalLock,
    remoteResolver: async () => fixture.revision,
  })
  assert.equal(verified.suite.ref, 'refs/tags/v1.0.0')
  assert.equal(verified.suite.remoteVerified, true)
})

test('remote-tagged builds materialize only tracked files from the locked revision', async (t) => {
  const fixture = await repository(t)
  await writeFile(join(fixture.root, 'ignored-output'), 'stale local artifact\n')
  const externalLock = join(tmpdir(), `agent-host-source-lock-${process.pid}-${Date.now()}.json`)
  const snapshotRoot = await mkdtemp(join(tmpdir(), 'agent-host-source-snapshot-'))
  t.after(() => rm(externalLock, { force: true }))
  t.after(() => rm(snapshotRoot, { recursive: true, force: true }))
  await writeFile(externalLock, `${JSON.stringify({
    schemaVersion: SOURCE_LOCK_SCHEMA,
    sources: {
      suite: {
        repository: 'https://github.com/tetracoralla/fixture.git',
        ref: 'refs/tags/v1.0.0',
        revision: fixture.revision,
      },
    },
  })}\n`)
  const verified = await inspectBuildSources('remote-tagged', { suite: fixture.root }, {
    sourceLockPath: externalLock,
    remoteResolver: async () => fixture.revision,
  })
  const snapshots = await materializeGitSourceSnapshots({ suite: fixture.root }, verified, join(snapshotRoot, 'sources'))
  assert.equal(await readFile(join(snapshots.suite, 'package.json'), 'utf8'), '{}\n')
  await assert.rejects(readFile(join(snapshots.suite, 'ignored-output')), (error) => error.code === 'ENOENT')
})

test('remote-tagged Armorial builds twice from a git-archive source snapshot without a local release artifact', { skip: process.platform !== 'darwin' }, async (t) => {
  const fixture = await armorialRepository(t)
  const observation = await remoteObservation(t, fixture)
  assert.equal(observation.sourcePolicy, 'remote-tagged')
  assert.equal(observation.remoteVerified, true)
  const snapshots = []
  const results = []
  for (let index = 0; index < 2; index += 1) {
    const runRoot = await mkdtemp(join(tmpdir(), `agent-host-armorial-source-run-${index}-`))
    t.after(() => rm(runRoot, { recursive: true, force: true }))
    const materialized = await materializeGitSourceSnapshots(
      { armorial: fixture.root },
      { armorial: observation },
      join(runRoot, 'sources'),
    )
    await assert.rejects(() => access(join(materialized.armorial, '.release')), (error) => error.code === 'ENOENT')
    const scratchRoot = join(runRoot, 'scratch')
    await mkdir(scratchRoot)
    snapshots.push(materialized.armorial)
    results.push(await buildArmorialPluginFromVerifiedSource({
      sourceRoot: materialized.armorial,
      scratchRoot,
      sourceObservation: observation,
    }))
  }
  assert.equal(results[0].version, '0.7.0')
  assert.equal(results[0].sourceRevision, fixture.revision)
  assert.equal(results[0].sourcePolicy, 'remote-tagged')
  assert.equal(results[0].sha256, results[1].sha256)
  assert.deepEqual(await readFile(results[0].archivePath), await readFile(results[1].archivePath))
  assert.equal(snapshots.every((value) => !value.includes('.release')), true)
})

test('remote-tagged File Vitals builds twice from tracked source without a prebuilt dist artifact', { skip: process.platform !== 'darwin' }, async (t) => {
  const fixture = await fileVitalsRepository(t)
  const observation = {
    repository: 'https://github.com/tetracoralla/file-vitals-fixture',
    revision: fixture.revision,
    dirty: false,
    sourcePolicy: 'remote-tagged',
    ref: 'refs/tags/v0.3.3',
    remoteVerified: true,
  }
  const results = []
  for (let index = 0; index < 2; index += 1) {
    const runRoot = await mkdtemp(join(tmpdir(), `agent-host-file-vitals-source-run-${index}-`))
    t.after(() => rm(runRoot, { recursive: true, force: true }))
    const materialized = await materializeGitSourceSnapshots(
      { 'file-vitals': fixture.root },
      { 'file-vitals': observation },
      join(runRoot, 'sources'),
    )
    await assert.rejects(() => access(join(materialized['file-vitals'], 'dist')), (error) => error.code === 'ENOENT')
    const scratchRoot = join(runRoot, 'scratch')
    await mkdir(scratchRoot)
    results.push(await buildFileVitalsPluginFromSource({
      sourceRoot: materialized['file-vitals'],
      scratchRoot,
      sourceObservation: observation,
    }))
  }
  assert.equal(results[0].version, '0.3.3')
  assert.equal(results[0].sourceRevision, fixture.revision)
  assert.equal(results[0].sourcePolicy, 'remote-tagged')
  assert.equal(results[0].sha256, results[1].sha256)
  assert.deepEqual(await readFile(results[0].archivePath), await readFile(results[1].archivePath))
})

test('File Vitals artifact overrides are paired development inputs and cannot bypass a clean or remote build', () => {
  assert.equal(fileVitalsSourceBuildRequired({
    sourcePolicy: 'local-development',
    reuseRequested: false,
  }), true)
  assert.equal(fileVitalsSourceBuildRequired({
    sourcePolicy: 'local-development',
    reuseRequested: false,
    pluginRootOverride: '/tmp/plugin',
    archiveOverride: '/tmp/plugin.tar.gz',
  }), false)
  assert.throws(
    () => fileVitalsSourceBuildRequired({
      sourcePolicy: 'local-development',
      reuseRequested: false,
      pluginRootOverride: '/tmp/plugin',
    }),
    /requires both plugin root and archive/u,
  )
  for (const sourcePolicy of ['local-clean', 'remote-tagged']) {
    assert.throws(
      () => fileVitalsSourceBuildRequired({
        sourcePolicy,
        reuseRequested: false,
        pluginRootOverride: '/tmp/plugin',
        archiveOverride: '/tmp/plugin.tar.gz',
      }),
      /development-only/u,
    )
  }
})

test('File Vitals source build rejects an oversized generated archive before copy, checksum read, or archive commands', { skip: process.platform !== 'darwin' }, async (t) => {
  const fixture = await fileVitalsRepository(t)
  const runRoot = await mkdtemp(join(tmpdir(), 'agent-host-file-vitals-oversized-'))
  t.after(() => rm(runRoot, { recursive: true, force: true }))
  const scratchRoot = join(runRoot, 'scratch')
  await mkdir(scratchRoot)
  let calls = 0
  const runner = async () => {
    calls += 1
    if (calls !== 1) throw new Error('archive inspection must not run for an oversized source output')
    const releaseRoot = join(fixture.root, 'dist/plugin')
    const bundle = 'file-vitals-0.3.3-darwin-arm64'
    await mkdir(releaseRoot, { recursive: true })
    await writeFile(join(releaseRoot, `${bundle}.tar.gz`), '')
    await truncate(join(releaseRoot, `${bundle}.tar.gz`), 128 * 1024 * 1024 + 1)
    await writeFile(join(releaseRoot, `${bundle}.tar.gz.sha256`), 'unread placeholder\n')
    return { status: 0, stdout: '', stderr: '' }
  }
  await assert.rejects(
    buildFileVitalsPluginFromSource({
      sourceRoot: fixture.root,
      scratchRoot,
      sourceObservation: {
        repository: 'https://github.com/tetracoralla/file-vitals-fixture',
        revision: fixture.revision,
        dirty: false,
        sourcePolicy: 'remote-tagged',
        ref: 'refs/tags/v0.3.3',
        remoteVerified: true,
      },
      runner,
    }),
    /bounded regular compressed input/u,
  )
  assert.equal(calls, 1)
  assert.deepEqual(await readdir(scratchRoot), [])
})

test('File Vitals source build fully inspects an unsafe generated archive before its first copy', { skip: process.platform !== 'darwin' }, async (t) => {
  const fixture = await fileVitalsRepository(t)
  const runRoot = await mkdtemp(join(tmpdir(), 'agent-host-file-vitals-unsafe-'))
  t.after(() => rm(runRoot, { recursive: true, force: true }))
  const scratchRoot = join(runRoot, 'scratch')
  await mkdir(scratchRoot)
  let runnerCalls = 0
  let copyCalls = 0
  const runner = async (_command, args) => {
    runnerCalls += 1
    if (runnerCalls === 1) {
      const releaseRoot = join(fixture.root, 'dist/plugin')
      const bundle = 'file-vitals-0.3.3-darwin-arm64'
      await mkdir(releaseRoot, { recursive: true })
      await writeFile(join(releaseRoot, `${bundle}.tar.gz`), 'unsafe fixture archive')
      await writeFile(join(releaseRoot, `${bundle}.tar.gz.sha256`), 'unread placeholder\n')
      return { status: 0, stdout: '', stderr: '' }
    }
    if (args[0] === '-tzf') {
      return { status: 0, stdout: 'file-vitals-0.3.3-darwin-arm64/../escape\n', stderr: '' }
    }
    throw new Error('unsafe source archive reached a later inspection stage')
  }
  await assert.rejects(
    buildFileVitalsPluginFromSource({
      sourceRoot: fixture.root,
      scratchRoot,
      sourceObservation: {
        repository: 'https://github.com/tetracoralla/file-vitals-fixture',
        revision: fixture.revision,
        dirty: false,
        sourcePolicy: 'remote-tagged',
        ref: 'refs/tags/v0.3.3',
        remoteVerified: true,
      },
      runner,
      copier: async () => { copyCalls += 1 },
    }),
    /unsafe path/u,
  )
  assert.equal(copyCalls, 0)
  assert.deepEqual(await readdir(scratchRoot), [])
})

test('failed verified Armorial source build removes every partial release output', { skip: process.platform !== 'darwin' }, async (t) => {
  const fixture = await armorialRepository(t, { failRelease: true })
  const observation = await remoteObservation(t, fixture)
  const runRoot = await mkdtemp(join(tmpdir(), 'agent-host-armorial-source-failure-'))
  t.after(() => rm(runRoot, { recursive: true, force: true }))
  const materialized = await materializeGitSourceSnapshots(
    { armorial: fixture.root },
    { armorial: observation },
    join(runRoot, 'sources'),
  )
  const scratchRoot = join(runRoot, 'scratch')
  await mkdir(scratchRoot)
  await assert.rejects(
    buildArmorialPluginFromVerifiedSource({
      sourceRoot: materialized.armorial,
      scratchRoot,
      sourceObservation: observation,
    }),
    (error) => error.code === 'HOST_COMMAND_FAILED' && error.details?.output.includes('fixture source build failed'),
  )
  assert.deepEqual(await readdir(scratchRoot), [])
})

test('verified Armorial source build rejects linked archive members and removes the candidate', { skip: process.platform !== 'darwin' }, async (t) => {
  const fixture = await armorialRepository(t, { linkedRelease: true })
  const observation = await remoteObservation(t, fixture)
  const runRoot = await mkdtemp(join(tmpdir(), 'agent-host-armorial-linked-release-'))
  t.after(() => rm(runRoot, { recursive: true, force: true }))
  const materialized = await materializeGitSourceSnapshots(
    { armorial: fixture.root },
    { armorial: observation },
    join(runRoot, 'sources'),
  )
  const scratchRoot = join(runRoot, 'scratch')
  await mkdir(scratchRoot)
  await assert.rejects(
    buildArmorialPluginFromVerifiedSource({
      sourceRoot: materialized.armorial,
      scratchRoot,
      sourceObservation: observation,
    }),
    /linked or special archive member/u,
  )
  assert.deepEqual(await readdir(scratchRoot), [])
})

test('Provider archive inspection closes path, type, count, expansion, compressed-size, and total-time bounds before extraction', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-provider-archive-inspection-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const archivePath = join(root, 'provider.tar.gz')
  await writeFile(archivePath, 'bounded fixture input')
  const validEntries = 'provider/\nprovider/package.json\n'
  const validVerbose = 'drwx------  0 root wheel 0 Jan  1 00:00 provider/\n-rw-------  0 root wheel 12 Jan  1 00:00 provider/package.json\n'
  const runnerFor = (listing, verbose = validVerbose, calls = []) => async (_command, args) => {
    calls.push(args)
    if (args[0] === '-tzf') return { status: 0, stdout: listing, stderr: '' }
    if (args[0] === '-tvzf') return { status: 0, stdout: verbose, stderr: '' }
    throw new Error('archive inspection attempted extraction')
  }
  const validCalls = []
  const valid = await inspectProviderPluginArchive({ archivePath, expectedRoot: 'provider', runner: runnerFor(validEntries, validVerbose, validCalls) })
  assert.equal(valid.fileCount, 1)
  assert.equal(valid.expandedBytes, 12)
  assert.deepEqual(validCalls.map((args) => args[0]), ['-tzf', '-tvzf'])

  const tooMany = Array.from({ length: 20_001 }, (_, index) => `provider/${index}`).join('\n') + '\n'
  const expandedEntries = Array.from({ length: 6 }, (_, index) => `provider/${index}`).join('\n') + '\n'
  const expandedVerbose = Array.from({ length: 6 }, (_, index) => `-rw-------  0 root wheel 209715200 Jan  1 00:00 provider/${index}`).join('\n') + '\n'
  const caseCollisionEntries = 'provider/A.json\nprovider/a.json\n'
  const caseCollisionVerbose = '-rw-------  0 root wheel 1 Jan  1 00:00 provider/A.json\n-rw-------  0 root wheel 1 Jan  1 00:00 provider/a.json\n'
  const canonicalCollisionEntries = 'provider/café.json\nprovider/café.json\n'
  const canonicalCollisionVerbose = '-rw-------  0 root wheel 1 Jan  1 00:00 provider/café.json\n-rw-------  0 root wheel 1 Jan  1 00:00 provider/café.json\n'
  const cases = [
    { listing: 'provider/../escape\n', pattern: /unsafe path/u },
    { listing: tooMany, pattern: /entry count/u },
    { listing: validEntries, verbose: 'drwx------  0 root wheel 0 Jan  1 00:00 provider/\nlrwx------  0 root wheel 0 Jan  1 00:00 provider/package.json -> /tmp/outside\n', pattern: /linked or special archive member/u },
    { listing: validEntries, verbose: 'drwx------  0 root wheel 0 Jan  1 00:00 provider/\n-rw-------  0 root wheel 268435457 Jan  1 00:00 provider/package.json\n', pattern: /member outside the expanded-size limit/u },
    { listing: expandedEntries, verbose: expandedVerbose, pattern: /cumulative expanded-size limit/u },
    { listing: caseCollisionEntries, verbose: caseCollisionVerbose, targetFilesystem: 'macos-default', pattern: /collide on the macOS target filesystem/u },
    { listing: canonicalCollisionEntries, verbose: canonicalCollisionVerbose, targetFilesystem: 'macos-default', pattern: /collide on the macOS target filesystem/u },
  ]
  for (const fixture of cases) {
    const calls = []
    await assert.rejects(
      inspectProviderPluginArchive({
        archivePath,
        expectedRoot: 'provider',
        runner: runnerFor(fixture.listing, fixture.verbose, calls),
        ...(fixture.targetFilesystem === undefined ? {} : { targetFilesystem: fixture.targetFilesystem }),
      }),
      fixture.pattern,
    )
    assert.equal(calls.some((args) => args[0].startsWith('-x')), false)
  }

  let clockIndex = 0
  const clock = [0, 0, 15_001]
  await assert.rejects(
    inspectProviderPluginArchive({
      archivePath,
      expectedRoot: 'provider',
      runner: runnerFor(validEntries),
      now: () => clock[Math.min(clockIndex++, clock.length - 1)],
    }),
    /total time limit/u,
  )

  const oversizedPath = join(root, 'oversized.tar.gz')
  await writeFile(oversizedPath, '')
  await truncate(oversizedPath, 128 * 1024 * 1024 + 1)
  let oversizedRunnerCalled = false
  await assert.rejects(
    inspectProviderPluginArchive({ archivePath: oversizedPath, expectedRoot: 'provider', runner: async () => { oversizedRunnerCalled = true } }),
    /bounded regular compressed input/u,
  )
  assert.equal(oversizedRunnerCalled, false)

  const oversizedWork = join(root, 'oversized-work')
  await assert.rejects(
    extractVerifiedProviderPluginArchive({
      sourceArchive: oversizedPath,
      archiveWork: oversizedWork,
      expectedRoot: 'provider',
      runner: async () => { oversizedRunnerCalled = true },
    }),
    /bounded regular compressed input/u,
  )
  await assert.rejects(() => access(oversizedWork), (error) => error.code === 'ENOENT')

  const digestBoundWork = join(root, 'digest-bound-work')
  await assert.rejects(
    extractVerifiedProviderPluginArchive({
      sourceArchive: archivePath,
      archiveWork: digestBoundWork,
      expectedRoot: 'provider',
      expectedSha256: `sha256:${'0'.repeat(64)}`,
      runner: runnerFor(validEntries),
    }),
    /digest changed after the verified source build/u,
  )
  await assert.rejects(() => access(digestBoundWork), (error) => error.code === 'ENOENT')
})

test('macOS Provider extraction rejects real case-folding archive collisions before scratch extraction or publication', { skip: process.platform !== 'darwin' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-provider-real-collision-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const archivePath = join(root, 'provider.tar.gz')
  await writeFile(archivePath, tarArchive([
    { name: 'provider/A.json', contents: '{}\n' },
    { name: 'provider/a.json', contents: '{}\n' },
  ]))

  const portable = await inspectProviderPluginArchive({
    archivePath,
    expectedRoot: 'provider',
    targetFilesystem: 'portable-case-sensitive',
  })
  assert.equal(portable.fileCount, 2)

  const archiveWork = join(root, 'archive-work')
  const published = join(root, 'published')
  await assert.rejects(
    extractVerifiedProviderPluginArchive({
      sourceArchive: archivePath,
      archiveWork,
      expectedRoot: 'provider',
      targetFilesystem: 'macos-default',
    }),
    /collide on the macOS target filesystem/u,
  )
  await assert.rejects(() => access(archiveWork), (error) => error.code === 'ENOENT')
  await assert.rejects(() => access(published), (error) => error.code === 'ENOENT')
})

test('source lock rejects branches and embedded credentials', () => {
  assert.throws(() => validateSourceLock({
    schemaVersion: SOURCE_LOCK_SCHEMA,
    sources: { suite: { repository: 'https://token@github.com/tetracoralla/fixture.git', ref: 'refs/heads/main', revision: 'a'.repeat(40) } },
  }, ['suite']), /HTTPS without embedded credentials|immutable release tag/u)
})

test('source lock rejects a missing source map with the stable provenance error', () => {
  assert.throws(() => validateSourceLock({
    schemaVersion: SOURCE_LOCK_SCHEMA,
    sources: null,
  }, ['suite']), (error) => error.code === 'RELEASE_SOURCE_PROVENANCE_INVALID')
})

test('build provenance requires the suite source and only names reused release components', () => {
  const release = {
    releaseId: 'fixture-release',
    suiteVersion: '1.0.0',
    components: [{ id: 'known', artifact: { sha256: `sha256:${'a'.repeat(64)}` } }],
  }
  const provenance = {
    schemaVersion: BUILD_PROVENANCE_SCHEMA,
    policy: 'local-development',
    releaseId: release.releaseId,
    suiteVersion: release.suiteVersion,
    createdAt: '2026-09-02T00:00:00.000Z',
    sources: {
      suite: {
        repository: null,
        revision: '0'.repeat(40),
        dirty: true,
        sourcePolicy: 'local-development',
      },
    },
    reusedComponents: [{
      id: 'unknown',
      artifactSha256: `sha256:${'b'.repeat(64)}`,
      fromReleaseId: 'prior-release',
    }],
    distributionBoundary: 'local-build-only-not-a-remote-confirmed-distribution',
  }
  assert.throws(() => validateBuildProvenance(provenance, release), /absent from the release manifest/u)
  assert.throws(() => validateBuildProvenance({ ...provenance, sources: { other: provenance.sources.suite }, reusedComponents: [] }, release), /must identify the Agent Host suite source/u)
})
