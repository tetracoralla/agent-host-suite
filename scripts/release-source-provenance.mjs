import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { isAbsolute, join, relative, sep } from 'node:path'
import {
  BUILD_PROVENANCE_SCHEMA,
  normalizeRepositoryUrl,
  SOURCE_LOCK_SCHEMA,
  SOURCE_POLICIES,
  validateBuildProvenance,
  validateSourceLock,
} from '../src/release-provenance.mjs'

export { BUILD_PROVENANCE_SCHEMA, normalizeRepositoryUrl, SOURCE_LOCK_SCHEMA, SOURCE_POLICIES, validateBuildProvenance, validateSourceLock }

function fail(message) {
  throw new Error(`release source policy: ${message}`)
}

function command(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (value) => stdout.push(value))
    child.stderr.on('data', (value) => stderr.push(value))
    child.once('error', reject)
    child.once('exit', (status) => {
      if (status === 0) resolve(Buffer.concat(stdout).toString('utf8'))
      else reject(new Error(`${file} ${args.join(' ')} failed (${status}): ${Buffer.concat(stderr).toString('utf8').trim()}`))
    })
  })
}

export async function observeGitSource(root, runner = command) {
  const repositoryRoot = (await runner('/usr/bin/git', ['rev-parse', '--show-toplevel'], { cwd: root })).trim()
  const revision = (await runner('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })).trim()
  const dirty = (await runner('/usr/bin/git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repositoryRoot })).trim().length > 0
  let repository = null
  try {
    repository = normalizeRepositoryUrl((await runner('/usr/bin/git', ['remote', 'get-url', 'origin'], { cwd: repositoryRoot })).trim())
  } catch {
    repository = null
  }
  return { repositoryRoot: await realpath(repositoryRoot), repository, revision, dirty }
}

async function resolveRemoteRevision(repository, ref, runner = command) {
  const output = await runner('/usr/bin/git', ['ls-remote', repository, ref, `${ref}^{}`])
  const rows = output.trim().split('\n').filter(Boolean).map((line) => line.split(/\s+/u))
  const peeled = rows.find(([, name]) => name === `${ref}^{}`)?.[0]
  const direct = rows.find(([, name]) => name === ref)?.[0]
  const revision = peeled ?? direct
  if (!/^[0-9a-f]{40}$/u.test(revision ?? '')) fail(`remote tag is unavailable: ${repository} ${ref}`)
  return revision
}

export async function inspectBuildSources(sourcePolicy, sourceRoots, options = {}) {
  if (!SOURCE_POLICIES.includes(sourcePolicy)) fail(`unsupported policy: ${sourcePolicy}`)
  const entries = Object.entries(sourceRoots).sort(([left], [right]) => left.localeCompare(right))
  const observed = {}
  for (const [id, root] of entries) observed[id] = await observeGitSource(root, options.gitRunner)
  if (sourcePolicy === 'local-development') {
    return Object.fromEntries(entries.map(([id]) => [id, publicObservation(observed[id], null, sourcePolicy)]))
  }
  const dirty = entries.filter(([id]) => observed[id].dirty).map(([id]) => id)
  if (dirty.length > 0) fail(`clean source is required; dirty repositories: ${dirty.join(', ')}`)
  if (sourcePolicy === 'local-clean') {
    return Object.fromEntries(entries.map(([id]) => [id, publicObservation(observed[id], null, sourcePolicy)]))
  }
  if (typeof options.sourceLockPath !== 'string' || options.sourceLockPath.length === 0) {
    fail('AGENT_HOST_RELEASE_SOURCE_LOCK is required for remote-tagged builds')
  }
  const lock = validateSourceLock(JSON.parse(await readFile(options.sourceLockPath, 'utf8')), entries.map(([id]) => id))
  for (const [id] of entries) {
    const expected = lock.sources[id]
    const current = observed[id]
    if (current.repository !== expected.repository) fail(`${id} checkout origin differs from the locked repository`)
    if (current.revision !== expected.revision) fail(`${id} checkout revision differs from the locked revision`)
    const remoteRevision = await (options.remoteResolver ?? resolveRemoteRevision)(expected.repository, expected.ref, options.remoteRunner)
    if (remoteRevision !== expected.revision) fail(`${id} remote tag does not resolve to the locked revision`)
  }
  return Object.fromEntries(entries.map(([id]) => [id, publicObservation(observed[id], lock.sources[id], sourcePolicy)]))
}

function publicObservation(observed, locked, sourcePolicy) {
  return {
    repository: locked?.repository ?? observed.repository,
    revision: observed.revision,
    dirty: observed.dirty,
    sourcePolicy,
    ...(locked === null ? {} : { ref: locked.ref, remoteVerified: true }),
  }
}

async function rejectLinks(root) {
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = join(current, entry.name)
      const info = await lstat(target)
      if (info.isSymbolicLink()) fail(`remote source snapshot contains a symbolic link: ${relative(root, target)}`)
      if (info.isDirectory()) await walk(target)
    }
  }
  await walk(root)
}

export async function materializeGitSourceSnapshots(sourceRoots, observations, destinationRoot, runner = command) {
  await mkdir(destinationRoot, { recursive: true })
  const destination = await realpath(destinationRoot)
  const roots = {}
  for (const [id, configuredRoot] of Object.entries(sourceRoots).sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) fail(`source id cannot form a snapshot directory: ${id}`)
    const expected = observations[id]
    if (expected?.sourcePolicy !== 'remote-tagged' || expected.remoteVerified !== true) {
      fail(`source snapshot requires remote-tagged provenance: ${id}`)
    }
    const current = await observeGitSource(configuredRoot, runner)
    if (current.dirty || current.revision !== expected.revision || current.repository !== expected.repository) {
      fail(`source changed before isolated snapshot creation: ${id}`)
    }
    const configuredReal = await realpath(configuredRoot)
    const relation = relative(current.repositoryRoot, configuredReal)
    if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
      fail(`configured source root escapes its repository: ${id}`)
    }
    const snapshot = join(destination, id)
    const archive = join(destination, `${id}.tar`)
    await mkdir(snapshot, { recursive: true })
    try {
      await runner('/usr/bin/git', ['archive', '--format=tar', '--output', archive, expected.revision], { cwd: current.repositoryRoot })
      await runner('/usr/bin/tar', ['-xf', archive, '-C', snapshot])
    } finally {
      await rm(archive, { force: true })
    }
    await rejectLinks(snapshot)
    const projectedRoot = join(snapshot, relation)
    try {
      roots[id] = await realpath(projectedRoot)
    } catch (error) {
      if (error.code === 'ENOENT') fail(`configured source root is not tracked by the locked revision: ${id}`)
      throw error
    }
  }
  return roots
}

export function buildProvenance({ policy, releaseId, suiteVersion, createdAt, sources, reusedComponents }) {
  if (!SOURCE_POLICIES.includes(policy)) fail(`unsupported policy: ${policy}`)
  return {
    schemaVersion: BUILD_PROVENANCE_SCHEMA,
    policy,
    releaseId,
    suiteVersion,
    createdAt,
    sources,
    reusedComponents: [...reusedComponents].sort((left, right) => left.id.localeCompare(right.id)),
    distributionBoundary: policy === 'remote-tagged'
      ? 'source-checkouts-were-clean-and-matched-remote-release-tags-at-build-time'
      : 'local-build-only-not-a-remote-confirmed-distribution',
  }
}

export function sha256Text(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}
