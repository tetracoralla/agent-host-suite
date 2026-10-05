import { DatabaseSync } from 'node:sqlite'
import { chmodSync } from 'node:fs'

// SQLite owns the OS-level writer lease and releases it on process exit.
// Owner metadata alone cannot serialize two concurrent stale-lock recoveries.
export function tryAcquireFileLease(path) {
  let database
  try {
    database = new DatabaseSync(path)
    chmodSync(path, 0o600)
    database.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY);')
    return { close: () => database.close() }
  } catch (error) {
    database?.close()
    if (error.errcode === 5 || error.errcode === 6) return null
    throw error
  }
}
