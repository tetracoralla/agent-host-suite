import { appendFile, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

export const ACTIVITY_SCHEMA = 'openadam.agent-host-activity.v0.1'
const MAX_ACTIVITY_BYTES = 262_144
const MAX_ACTIVITY_ENTRIES = 500

export async function recordActivity(paths, type, summary, detail = undefined) {
  const entry = {
    schemaVersion: ACTIVITY_SCHEMA,
    id: randomUUID(),
    occurredAt: new Date().toISOString(),
    type,
    summary,
    ...(detail === undefined ? {} : { detail }),
  }
  await appendFile(paths.activity, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 })
  if ((await stat(paths.activity)).size > MAX_ACTIVITY_BYTES) await compactActivity(paths)
  return entry
}

async function compactActivity(paths) {
  const entries = await listActivity(paths, { limit: MAX_ACTIVITY_ENTRIES })
  const temporary = `${paths.activity}.tmp-${process.pid}`
  const contents = entries.reverse().map((entry) => JSON.stringify(entry)).join('\n')
  try {
    await writeFile(temporary, contents === '' ? '' : `${contents}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, paths.activity)
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function listActivity(paths, { limit = 100 } = {}) {
  let text
  try {
    text = await readFile(paths.activity, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const entries = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let value
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    if (value?.schemaVersion === ACTIVITY_SCHEMA && typeof value.id === 'string' && typeof value.occurredAt === 'string') {
      entries.push(value)
    }
  }
  return entries.sort((left, right) => right.occurredAt.localeCompare(left.occurredAt)).slice(0, limit)
}
