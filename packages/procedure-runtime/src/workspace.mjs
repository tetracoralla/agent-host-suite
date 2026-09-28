import { execFileSync } from 'node:child_process'
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  copyFileSync,
  renameSync,
} from 'node:fs'
import { join, resolve, relative, isAbsolute, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { assert, hash, id } from './value.mjs'

export function git(cwd, args, options = {}) {
  return execFileSync(
    'git',
    ['-c', 'core.fsmonitor=false', '-C', cwd, ...args],
    {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 30000,
      ...options,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_LITERAL_PATHSPECS: '1',
        ...options.env,
      },
    },
  )
}
export function workspaceRoot(path) {
  const root = realpathSync(path)
  assert(
    realpathSync(git(root, ['rev-parse', '--show-toplevel']).trim()) === root,
    'WORKSPACE_ROOT',
    'Choose the Git checkout root',
  )
  return root
}
export function safePath(root, path) {
  assert(
    typeof path === 'string' &&
      path.length > 0 &&
      !isAbsolute(path) &&
      !path.split(/[\\/]/).includes('..') &&
      !path.split(/[\\/]/).includes('.git') &&
      !path.includes('\0'),
    'INVALID_PATH',
    'Path must stay inside the checkout',
  )
  const abs = resolve(root, path)
  assert(
    !relative(root, abs).startsWith('..'),
    'INVALID_PATH',
    'Path leaves checkout',
  )
  return abs
}
export function snapshot(root) {
  root = realpathSync(root)
  let head = null
  try {
    head = git(root, ['rev-parse', '--verify', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch {}
  const index = git(root, ['ls-files', '--stage', '-z'])
  assert(
    !index.split('\0').some((l) => l.startsWith('160000 ')),
    'SUBMODULE_UNSUPPORTED',
    'Submodule contents need a separate snapshot binding',
  )
  const paths = [
    ...new Set(
      git(root, [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z',
      ])
        .split('\0')
        .filter(Boolean),
    ),
  ].sort()
  assert(
    paths.length <= 100000,
    'WORKSPACE_LIMIT',
    'Checkout exceeds 100,000 source paths',
  )
  const files = Object.create(null)
  let bytes = 0
  for (const path of paths) {
    const abs = safePath(root, path)
    let st
    try {
      st = lstatSync(abs)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      files[path] = { kind: 'deleted' }
      continue
    }
    const parent = realpathSync(dirname(abs))
    assert(
      parent === root || parent.startsWith(root + '/'),
      'PATH_ESCAPE',
      'A source parent symlink leaves the checkout',
      { path },
    )
    if (st.isSymbolicLink()) {
      files[path] = { kind: 'symlink', value: readlinkSync(abs) }
      continue
    }
    assert(
      st.isFile() && st.size <= 32 * 1024 * 1024,
      'WORKSPACE_LIMIT',
      'Unsupported file or file larger than 32 MiB',
      { path },
    )
    bytes += st.size
    assert(
      bytes <= 1024 * 1024 * 1024,
      'WORKSPACE_LIMIT',
      'Source snapshot exceeds 1 GiB',
    )
    files[path] = {
      kind: 'file',
      sha256: hash(readFileSync(abs)),
      executable: !!(st.mode & 0o111),
    }
  }
  const status = git(root, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ])
  const value = { head, index, files, status }
  return { ...value, identity: hash(value) }
}
export function dirtyPaths(root) {
  const paths = new Set([
    ...git(root, ['diff', '--name-only', '-z']).split('\0'),
    ...git(root, ['diff', '--cached', '--name-only', '-z']).split('\0'),
    ...git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split(
      '\0',
    ),
  ])
  paths.delete('')
  return [...paths].sort()
}
export function changedPaths(before, after) {
  // Removing a tracked deletion from the index removes its snapshot tombstone,
  // not another working file. Treat both representations as physically absent.
  const present = (item) => (item?.kind === 'deleted' ? undefined : item)
  return [
    ...new Set([...Object.keys(before.files), ...Object.keys(after.files)]),
  ]
    .filter(
      (p) =>
        JSON.stringify(present(before.files[p])) !==
        JSON.stringify(present(after.files[p])),
    )
    .sort()
}
export function candidate(root, base, protectedPaths) {
  const next = snapshot(root)
  assert(
    next.head === base.head,
    'HEAD_CHANGED',
    'Git HEAD changed outside the coordinator',
  )
  const paths = [
    ...new Set([
      ...changedPaths(base, next),
      ...(base.includedPaths ?? Object.keys(base.contents ?? {})),
    ]),
  ].sort()
  const conflicts = paths.filter((p) => protectedPaths.includes(p))
  assert(
    !conflicts.length,
    'PROTECTED_DRIFT',
    'Pre-existing work changed; inspect ownership before continuing',
    { paths: conflicts },
  )
  return { ...next, paths, contents: captureContents(root, next, paths) }
}
export function captureContents(root, state, paths) {
  const contents = Object.create(null)
  let bytes = 0
  for (const path of paths) {
    const item = state.files[path]
    if (item?.kind === 'file') {
      const data = readFileSync(safePath(root, path))
      bytes += data.length
      assert(
        bytes <= 20 * 1024 * 1024,
        'CANDIDATE_LIMIT',
        'Changed content exceeds 20 MiB',
      )
      assert(
        hash(data) === item.sha256,
        'CANDIDATE_DRIFT',
        'File changed while taking the candidate snapshot',
      )
      contents[path] = data.toString('base64')
    } else if (item?.kind === 'symlink')
      contents[path] = Buffer.from(item.value).toString('base64')
  }
  return contents
}
export function assertCandidate(root, expected) {
  const actual = snapshot(root)
  assert(
    actual.identity === expected.identity,
    'CANDIDATE_DRIFT',
    'Checkout changed after review; review the new candidate',
    { expected: expected.identity, actual: actual.identity },
  )
  return actual
}
export function stage(root, expected) {
  replaceIndex(root, (env) => {
    assertCandidate(root, expected)
    writeCandidateIndex(root, expected, env)
    assertCandidate(root, expected)
  })
  const after = snapshot(root)
  assert(
    after.head === expected.head && changedPaths(expected, after).length === 0,
    'CANDIDATE_DRIFT',
    'Working files changed during staging; the index contains only the saved candidate',
  )
  return after
}

function indexEntries(index, paths) {
  const wanted = new Set(paths)
  return index
    .split('\0')
    .filter((line) => wanted.has(line.slice(line.indexOf('\t') + 1)))
    .sort()
}

// Preserve the complete existing index and coordinate with ordinary Git writers.
// Only publish an index built from saved bytes, never a second working-file read.
function replaceIndex(root, update) {
  const path = resolve(
    root,
    git(root, ['rev-parse', '--git-path', 'index']).trim(),
  )
  const lock = path + '.lock'
  const temp = path + `.procedure-${id()}`
  try {
    writeFileSync(lock, '', { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error.code === 'EEXIST') error.code = 'INDEX_LOCKED'
    throw error
  }
  const env = { GIT_INDEX_FILE: temp }
  try {
    const initial = existsSync(path) ? readFileSync(path) : null
    if (initial) copyFileSync(path, temp)
    else git(root, ['read-tree', '--empty'], { env })
    update(env)
    const current = existsSync(path) ? readFileSync(path) : null
    assert(
      hash(initial) === hash(current),
      'INDEX_CHANGED',
      'Another writer replaced the Git index; no staged work was overwritten',
    )
    renameSync(temp, path)
  } finally {
    for (const own of [lock, temp, temp + '.lock'])
      if (existsSync(own)) unlinkSync(own)
  }
}

function writeCandidateIndex(root, expected, env) {
  for (const path of expected.paths) {
    const item = expected.files[path]
    if (!item || item.kind === 'deleted') {
      git(root, ['update-index', '--force-remove', '--', path], { env })
      continue
    }
    assert(
      typeof expected.contents?.[path] === 'string',
      'CANDIDATE_BYTES_MISSING',
      'Candidate content is missing; take a new snapshot',
    )
    const data = Buffer.from(expected.contents[path], 'base64')
    assert(
      item.kind === 'symlink'
        ? data.toString() === item.value
        : hash(data) === item.sha256,
      'CANDIDATE_CORRUPT',
      'Candidate content does not match its identity',
    )
    const blob = git(
      root,
      [
        'hash-object',
        '-w',
        ...(item.kind === 'file' ? ['--path', path] : []),
        '--stdin',
      ],
      { env, input: data },
    ).trim()
    git(
      root,
      [
        'update-index',
        '--add',
        '--cacheinfo',
        `${item.kind === 'symlink' ? '120000' : item.executable ? '100755' : '100644'},${blob},${path}`,
      ],
      { env },
    )
  }
}
export function diff(root) {
  return {
    staged: git(root, [
      'diff',
      '--cached',
      '--no-ext-diff',
      '--no-textconv',
      '--binary',
    ]),
    unstaged: git(root, ['diff', '--no-ext-diff', '--no-textconv', '--binary']),
    untracked: git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
      .split('\0')
      .filter(Boolean),
  }
}

// Every worker inherits this filesystem boundary, including shell descendants.
// It does not certify network effects or an external MCP service's permissions.
export function workerSandbox(
  root,
  { writable, workspaceAdapter = 'git', stateRoot, contextRoot, protectedPaths = [], runtime },
) {
  assert(
    process.platform === 'darwin',
    'ENCLOSURE_UNAVAILABLE',
    'This build verifies worker filesystem confinement on macOS only',
  )
  assert(
    ['git', 'none'].includes(workspaceAdapter),
    'ENCLOSURE_UNAVAILABLE',
    'Worker sandbox requires a supported workspace adapter',
  )
  root = realpathSync(root)
  stateRoot = realpathSync(stateRoot)
  const gitDir = workspaceAdapter === 'git'
    ? realpathSync(git(root, ['rev-parse', '--absolute-git-dir']).trim())
    : null
  const common = workspaceAdapter === 'git'
    ? realpathSync(resolve(root, git(root, ['rev-parse', '--git-common-dir']).trim()))
    : null
  const quoted = (p) => JSON.stringify(p)
  const deny = workspaceAdapter === 'git'
    ? [
        gitDir,
        common,
        join(root, '.git'),
        stateRoot,
        ...protectedPaths.map((p) => safePath(root, p)),
      ]
    : [stateRoot]
  const rules = ['(version 1)', '(allow default)']
  if (runtime === 'codex' || runtime === 'grok') {
    // Codex's supported externalSandbox mode avoids nested sandbox_apply on
    // macOS. The enclosing policy therefore also owns the workspace write
    // boundary; only harness persistence, temp and this checkout are writable.
    const homePath =
      runtime === 'codex'
        ? process.env.CODEX_HOME || join(homedir(), '.codex')
        : process.env.GROK_HOME || join(homedir(), '.grok')
    const home = realpathSync(homePath)
    assert(
      runtime !== 'grok' || home === resolve(homePath),
      'ENCLOSURE_UNAVAILABLE',
      'Grok home must not contain symlink components',
    )
    const roots = [
      root,
      home,
      realpathSync(tmpdir()),
      '/private/tmp',
      '/private/var/tmp',
    ]
    const protectedNames =
      runtime === 'codex'
        ? [
            'config.toml',
            'auth.json',
            '.env',
            'AGENTS.md',
            'hooks.json',
            'hooks',
            'skills',
            'plugins',
            'memories',
          ]
        : [
            'config.toml',
            'auth.json',
            'trusted_folders.toml',
            'managed_config.toml',
            'requirements.toml',
            'sandbox.toml',
            'hooks',
            'hooks-paths',
          ]
    deny.push(...protectedNames.map((p) => join(home, p)))
    if (runtime === 'grok' && existsSync(join(home, 'hooks-paths'))) {
      for (const entry of readFileSync(join(home, 'hooks-paths'), 'utf8')
        .split('\n')
        .map((p) => p.trim())
        .filter(isAbsolute)) {
        assert(
          existsSync(entry) && realpathSync(entry) === resolve(entry),
          'ENCLOSURE_UNAVAILABLE',
          'Global hook targets must exist without symlink components',
        )
        deny.push(entry)
      }
    }
    for (const protectedPath of deny) {
      let parent = dirname(protectedPath)
      while (parent !== '/') {
        rules.push(`(deny file-write-unlink (literal ${quoted(parent)}))`)
        parent = dirname(parent)
      }
    }
    rules.push(
      `(deny file-write* (require-all ${[
        ...roots.map((p) => `(require-not (subpath ${quoted(p)}))`),
        ...['/dev/null', '/dev/tty'].map(
          (p) => `(require-not (literal ${quoted(p)}))`,
        ),
      ].join(' ')}))`,
    )
  }
  if (contextRoot) {
    contextRoot = realpathSync(contextRoot)
    assert(
      contextRoot.startsWith(stateRoot + '/worker-context/'),
      'INVALID_CONTEXT',
      'Worker context must be inside its private task directory',
    )
    rules.push(
      `(deny file-read* (require-all (subpath ${quoted(stateRoot)}) (require-not (subpath ${quoted(contextRoot)}))))`,
    )
  } else rules.push(`(deny file-read* (subpath ${quoted(stateRoot)}))`)
  if (!writable) rules.push(`(deny file-write* (subpath ${quoted(root)}))`)
  for (const p of new Set(deny))
    rules.push(
      `(deny file-write* (subpath ${quoted(p)}) (literal ${quoted(p)}))`,
    )
  for (const path of protectedPaths) {
    let parent = dirname(safePath(root, path))
    while (parent !== root) {
      rules.push(`(deny file-write-unlink (literal ${quoted(parent)}))`)
      parent = dirname(parent)
    }
  }
  // Protect coordinator state and its parent directory entries from rename/delete.
  rules.push(
    `(deny file-write-unlink (literal ${quoted(root)}) (literal ${quoted(stateRoot)}))`,
  )
  return ['/usr/bin/sandbox-exec', ['-p', rules.join('\n')]]
}

export function prepareCommit(root, expected, message, stateRoot) {
  assertCandidate(root, expected)
  assert(expected.paths.length, 'EMPTY_CANDIDATE', 'No task changes to commit')
  const temp = join(stateRoot, `commit-${id()}`)
  mkdirSync(temp, { mode: 0o700 })
  const env = { GIT_INDEX_FILE: join(temp, 'index') }
  try {
    git(
      root,
      expected.head ? ['read-tree', expected.head] : ['read-tree', '--empty'],
      { env },
    )
    writeCandidateIndex(root, expected, env)
    const tree = git(root, ['write-tree'], { env }).trim()
    assertCandidate(root, expected)
    const commit = git(
      root,
      [
        'commit-tree',
        tree,
        ...(expected.head ? ['-p', expected.head] : []),
        '-m',
        message,
      ],
      { env },
    ).trim()
    return {
      commit,
      tree,
      expectedHead: expected.head,
      paths: expected.paths,
      previousIndex: indexEntries(expected.index, expected.paths),
      targetIndex: indexEntries(
        git(root, ['ls-files', '--stage', '-z'], { env }),
        expected.paths,
      ),
    }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}
export function applyCommit(root, prepared) {
  try {
    replaceIndex(root, (env) => {
      let head = null
      try {
        head = git(root, ['rev-parse', '--verify', 'HEAD'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim()
      } catch {}
      assert(
        head === prepared.expectedHead || head === prepared.commit,
        'HEAD_CHANGED',
        'HEAD changed during commit finalization',
      )
      const current = indexEntries(
        git(root, ['ls-files', '--stage', '-z']),
        prepared.paths,
      )
      assert(
        hash(current) === hash(prepared.previousIndex) ||
          (head === prepared.commit &&
            hash(current) === hash(prepared.targetIndex)),
        'INDEX_CHANGED',
        'Candidate paths were staged again after approval; preserve and reconcile those edits before finalization',
      )
      git(
        root,
        ['reset', '--quiet', prepared.commit, '--', ...prepared.paths],
        { env },
      )
      if (head !== prepared.commit)
        git(root, [
          'update-ref',
          'HEAD',
          prepared.commit,
          prepared.expectedHead ?? '0'.repeat(prepared.commit.length),
        ])
    })
  } catch (error) {
    if (!error.code) error.code = 'COMMIT_EFFECT_UNCERTAIN'
    error.details = {
      ...error.details,
      preparedCommit: prepared.commit,
      indexReconciliation: 'required',
    }
    throw error
  }
  return { commit: prepared.commit, tree: prepared.tree }
}
export function commitCandidate(root, expected, message, stateRoot) {
  const prepared = prepareCommit(root, expected, message, stateRoot)
  assertCandidate(root, expected)
  return applyCommit(root, prepared)
}

function leasePath(root) {
  return join(
    git(root, ['rev-parse', '--absolute-git-dir']).trim(),
    'agent-procedure-lease.json',
  )
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code !== 'ESRCH'
  }
}
// Workers are detached process-group leaders. A vanished root PID alone does
// not establish that its shell/tool descendants have stopped writing.
export function workerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (alive(pid)) return true
  if (process.platform === 'win32') return false
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}
function coordinatorLockReleased(stateRoot) {
  const lock = join(stateRoot, 'coordinator.lock')
  if (!existsSync(lock)) return true
  try {
    return !alive(JSON.parse(readFileSync(lock, 'utf8')).pid)
  } catch {
    return false
  }
}
function leaseRecord(stateRoot, taskId, workerPid, delegation) {
  const record = {
    owner: realpathSync(stateRoot),
    taskId,
    pid: process.pid,
    workerPid,
  }
  if (delegation?.owner && delegation?.taskId) {
    record.delegatedBy = {
      owner: realpathSync(delegation.owner),
      taskId: delegation.taskId,
    }
  }
  return record
}
export function claimCheckout(root, stateRoot, taskId, workerPid = null, delegation = null) {
  const path = leasePath(root)
  const record = leaseRecord(stateRoot, taskId, workerPid, delegation)
  try {
    writeFileSync(path, JSON.stringify(record), { flag: 'wx', mode: 0o600 })
    return
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
  }
  const prior = JSON.parse(readFileSync(path, 'utf8'))
  const same = prior.owner === record.owner && prior.taskId === taskId
  assert(
    (same && prior.pid === process.pid) ||
      (!alive(prior.pid) && !workerAlive(prior.workerPid)),
    'WORKSPACE_BUSY',
    'Another coordinator or unreconciled worker owns this checkout',
    { taskId: prior.taskId },
  )
  if (same && prior.pid === process.pid)
    writeFileSync(
      path,
      JSON.stringify({
        ...record,
        workerPid: workerPid ?? prior.workerPid,
        ...(prior.delegatedBy ? { delegatedBy: prior.delegatedBy } : {}),
      }),
      { mode: 0o600 },
    )
  else {
    unlinkSync(path)
    writeFileSync(path, JSON.stringify(record), { flag: 'wx', mode: 0o600 })
  }
}
export function reclaimDelegatedCheckout(root, stateRoot, taskId) {
  const path = leasePath(root)
  if (!existsSync(path)) {
    claimCheckout(root, stateRoot, taskId)
    return
  }
  const prior = JSON.parse(readFileSync(path, 'utf8'))
  const owner = realpathSync(stateRoot)
  const returned = prior.delegatedBy?.owner === owner && prior.delegatedBy?.taskId === taskId
  const sameProcessClosed = prior.pid === process.pid
    && !workerAlive(prior.workerPid)
    && returned
    && coordinatorLockReleased(prior.owner)
  if (sameProcessClosed) {
    unlinkSync(path)
    try {
      writeFileSync(
        path,
        JSON.stringify({ owner, taskId, pid: process.pid, workerPid: null }),
        { flag: 'wx', mode: 0o600 },
      )
      return
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  claimCheckout(root, stateRoot, taskId)
}
export function releaseCheckout(root, stateRoot, taskId) {
  const path = leasePath(root)
  if (!existsSync(path)) return
  const value = JSON.parse(readFileSync(path, 'utf8'))
  assert(
    value.owner === realpathSync(stateRoot) && value.taskId === taskId,
    'WORKSPACE_BUSY',
    'Checkout lease belongs to another task',
  )
  unlinkSync(path)
}
