import { DatabaseSync } from 'node:sqlite'
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  chmodSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { assert, hash, id, now } from './value.mjs'
import { claimCheckout, releaseCheckout } from './workspace.mjs'

export class Store {
  constructor(root) {
    this.root = resolve(root)
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    chmodSync(this.root, 0o700)
    this.lock = join(this.root, 'coordinator.lock')
    this.owner = id()
    try {
      writeFileSync(
        this.lock,
        JSON.stringify({ pid: process.pid, owner: this.owner }),
        { flag: 'wx', mode: 0o600 },
      )
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let previous
      try {
        previous = JSON.parse(readFileSync(this.lock, 'utf8'))
      } catch {
        assert(false, 'STORE_LOCKED', 'The coordinator lock needs inspection')
      }
      assert(
        Number.isInteger(previous.pid) && previous.pid > 0,
        'STORE_LOCKED',
        'Invalid coordinator lock',
      )
      let alive = true
      try {
        process.kill(previous.pid, 0)
      } catch (e) {
        if (e.code === 'ESRCH') alive = false
      }
      assert(
        !alive,
        'STORE_LOCKED',
        'Another coordinator owns this state directory',
      )
      unlinkSync(this.lock)
      writeFileSync(
        this.lock,
        JSON.stringify({ pid: process.pid, owner: this.owner }),
        { flag: 'wx', mode: 0o600 },
      )
    }
    try {
      this.db = new DatabaseSync(join(this.root, 'tasks.sqlite'))
      this.db
        .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS receipts(task TEXT NOT NULL, request TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(task,request));
        CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS event_usage(task TEXT PRIMARY KEY, count INTEGER NOT NULL, bytes INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS event_retention(task TEXT PRIMARY KEY, discarded INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, task TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS methods(id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(id,revision));
        CREATE TABLE IF NOT EXISTS workspace_leases(workspace TEXT PRIMARY KEY, task TEXT NOT NULL);`)
      chmodSync(join(this.root, 'tasks.sqlite'), 0o600)
    } catch (error) {
      unlinkSync(this.lock)
      throw error
    }
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
  get(task) {
    const row = this.db.prepare('SELECT state FROM tasks WHERE id=?').get(task)
    assert(row, 'NOT_FOUND', 'Task not found')
    return JSON.parse(row.state)
  }
  maybeGet(task) {
    const row = this.db.prepare('SELECT state FROM tasks WHERE id=?').get(task)
    return row ? JSON.parse(row.state) : null
  }
  list() {
    return this.db
      .prepare('SELECT state FROM tasks ORDER BY rowid DESC LIMIT 200')
      .all()
      .map((row) => JSON.parse(row.state))
  }
  *allTasks() {
    for (const row of this.db
      .prepare('SELECT state FROM tasks ORDER BY rowid')
      .iterate())
      yield JSON.parse(row.state)
  }
  save(task) {
    const serialized = JSON.stringify(task)
    assert(
      Buffer.byteLength(serialized) <= 512000,
      'TASK_STATE_LIMIT',
      'Task state exceeds 512 KiB; preserve this run and continue with an explicit handoff',
    )
    this.db
      .prepare(
        'INSERT INTO tasks VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,state=excluded.state',
      )
      .run(task.id, task.revision, serialized)
  }
  checkEventBudget(task, bytes) {
    const usage = this.db
      .prepare('SELECT count,bytes FROM event_usage WHERE task=?')
      .get(task)
    assert(
      (usage?.count ?? 0) < 20000 &&
        (usage?.bytes ?? 0) + bytes <= 32 * 1024 * 1024,
      'EVENT_LIMIT',
      'Worker event history reached its bound; preserve this run and start an explicit handoff',
    )
  }
  event(task, kind, body, costBytes = 0) {
    const serialized = JSON.stringify(body)
    const bytes = Buffer.byteLength(serialized)
    assert(bytes <= 65536, 'EVENT_LIMIT', 'Event exceeds its bound')
    const stream = ['worker-event', 'late-event'].includes(kind)
    const cost = Math.max(bytes, costBytes)
    if (stream) this.checkEventBudget(task, cost)
    this.db
      .prepare('INSERT INTO events(task,at,kind,body) VALUES(?,?,?,?)')
      .run(task, now(), kind, serialized)
    if (stream)
      this.db
        .prepare(
          'INSERT INTO event_usage VALUES(?,1,?) ON CONFLICT(task) DO UPDATE SET count=count+1,bytes=bytes+excluded.bytes',
        )
        .run(task, cost)
    // High-volume transport output must not prevent pause/cancel/recovery state
    // from being recorded. Keep the latest 2,000 control observations separately.
    else {
      const removed = this.db
        .prepare(
          "DELETE FROM events WHERE task=? AND kind NOT IN ('worker-event','late-event') AND seq NOT IN (SELECT seq FROM events WHERE task=? AND kind NOT IN ('worker-event','late-event') ORDER BY seq DESC LIMIT 2000)",
        )
        .run(task, task).changes
      if (removed)
        this.db
          .prepare(
            'INSERT INTO event_retention VALUES(?,?) ON CONFLICT(task) DO UPDATE SET discarded=discarded+excluded.discarded',
          )
          .run(task, removed)
    }
  }
  retention(task) {
    return {
      discardedControlEvents:
        this.db
          .prepare('SELECT discarded FROM event_retention WHERE task=?')
          .get(task)?.discarded ?? 0,
      workerHistory: 'bounded-stop',
    }
  }
  events(task, after = 0, limit = 100) {
    return this.db
      .prepare(
        'SELECT seq,at,kind,body FROM events WHERE task=? AND seq>? ORDER BY seq LIMIT ?',
      )
      .all(task, after, Math.min(200, limit))
      .map((row) => ({ ...row, body: JSON.parse(row.body) }))
  }
  artifact(body) {
    const json = JSON.stringify(body)
    assert(
      Buffer.byteLength(json) <= 32 * 1024 * 1024,
      'ARTIFACT_LIMIT',
      'Artifact exceeds 32 MiB',
    )
    const key = hash(json)
    this.db
      .prepare('INSERT OR IGNORE INTO artifacts VALUES(?,?)')
      .run(key, json)
    return key
  }
  readArtifact(key) {
    const row = this.db
      .prepare('SELECT body FROM artifacts WHERE id=?')
      .get(key)
    assert(row, 'NOT_FOUND', 'Artifact not found')
    return JSON.parse(row.body)
  }
  command(taskId, request, expectedRevision, action, fn) {
    assert(
      typeof request === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(request),
      'INVALID_INPUT',
      'A bounded request ID is required',
    )
    return this.transaction(() => {
      const digest = hash({ expectedRevision, action })
      const prior = this.db
        .prepare('SELECT * FROM receipts WHERE task=? AND request=?')
        .get(taskId, request)
      if (prior) {
        assert(
          prior.digest === digest,
          'REQUEST_CONFLICT',
          'Request ID already used for different content',
        )
        return JSON.parse(prior.result)
      }
      const task = this.get(taskId)
      assert(
        task.revision === expectedRevision,
        'REVISION_CONFLICT',
        'Task changed; refresh before applying this action',
        { actualRevision: task.revision },
      )
      fn(task)
      task.revision++
      task.updatedAt = now()
      this.save(task)
      const result = { taskId, revision: task.revision, status: task.status }
      this.db
        .prepare('INSERT INTO receipts VALUES(?,?,?,?)')
        .run(taskId, request, digest, JSON.stringify(result))
      return result
    })
  }
  update(taskId, kind, fn) {
    return this.transaction(() => {
      const task = this.get(taskId)
      fn(task)
      task.revision++
      task.updatedAt = now()
      this.save(task)
      if (kind)
        this.event(taskId, kind, {
          revision: task.revision,
          status: task.status,
        })
      return task
    })
  }
  enqueue(taskId, command) {
    this.db
      .prepare('INSERT INTO outbox VALUES(?,?,?,?)')
      .run(command.id, taskId, 'pending', JSON.stringify(command))
  }
  pending() {
    return this.db
      .prepare("SELECT * FROM outbox WHERE status='pending' ORDER BY rowid")
      .all()
      .map((r) => ({ ...r, body: JSON.parse(r.body) }))
  }
  mark(commandId, status) {
    this.db
      .prepare('UPDATE outbox SET status=? WHERE id=?')
      .run(status, commandId)
  }
  claim(workspace, task, workerPid = null) {
    const row = this.db
      .prepare('SELECT task FROM workspace_leases WHERE workspace=?')
      .get(workspace)
    assert(
      !row || row.task === task,
      'WORKSPACE_BUSY',
      'Another task owns this checkout',
      { taskId: row?.task },
    )
    claimCheckout(workspace, this.root, task, workerPid)
    this.db
      .prepare('INSERT OR IGNORE INTO workspace_leases VALUES(?,?)')
      .run(workspace, task)
  }
  release(task) {
    for (const row of this.db
      .prepare('SELECT workspace FROM workspace_leases WHERE task=?')
      .all(task))
      releaseCheckout(row.workspace, this.root, task)
    this.db.prepare('DELETE FROM workspace_leases WHERE task=?').run(task)
  }
  putMethod(method) {
    const json = JSON.stringify(method)
    const prior = this.db
      .prepare('SELECT body FROM methods WHERE id=? AND revision=?')
      .get(method.id, method.revision)
    assert(
      !prior || prior.body === json,
      'METHOD_CONFLICT',
      'Method revisions are immutable',
    )
    this.db
      .prepare('INSERT OR IGNORE INTO methods VALUES(?,?,?)')
      .run(method.id, method.revision, json)
  }
  methods() {
    return this.db
      .prepare('SELECT body FROM methods ORDER BY id,revision DESC')
      .all()
      .map((r) => JSON.parse(r.body))
  }
  close() {
    if (!this.db) return
    this.db.close()
    this.db = null
    if (JSON.parse(readFileSync(this.lock, 'utf8')).owner === this.owner)
      unlinkSync(this.lock)
  }
}
