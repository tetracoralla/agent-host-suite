import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { hostStatus, toolSetStatus } from '../src/lifecycle.mjs'
import { localComponentStatus } from '../src/local-components.mjs'
import { observabilityStatus } from '../src/observability.mjs'
import { operationsSnapshot } from '../src/operations-snapshot.mjs'
import { exportSkillLinkCatalog } from '../src/skill-link-catalog.mjs'
import { storageStatus } from '../src/storage.mjs'
import { usageSummary } from '../src/usage-summary.mjs'

test('read-only Host surfaces never create a missing private state root', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'agent-host-read-only-state-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const stateRoot = join(parent, 'missing', 'private', 'state')
  const absentRunner = async () => ({ status: 1, stdout: '', stderr: '' })

  assert.equal((await operationsSnapshot({ stateRoot })).configured, false)
  assert.equal((await usageSummary({ stateRoot })).configured, false)
  assert.equal((await observabilityStatus({ stateRoot })).configured, false)
  assert.equal((await hostStatus({ stateRoot, target: 'codex', quick: true }, { runner: absentRunner })).configured, false)
  await assert.rejects(storageStatus({ stateRoot }), (error) => error.code === 'NOT_INSTALLED')
  await assert.rejects(toolSetStatus({ stateRoot }), (error) => error.code === 'NOT_INSTALLED')
  await assert.rejects(localComponentStatus({ stateRoot }), (error) => error.code === 'NOT_INSTALLED')
  await assert.rejects(exportSkillLinkCatalog({ stateRoot }), (error) => error.code === 'NOT_INSTALLED')

  await assert.rejects(() => access(stateRoot), (error) => error.code === 'ENOENT')
})
