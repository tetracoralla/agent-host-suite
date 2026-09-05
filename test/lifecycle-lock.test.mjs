import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ensurePrivateDirectory } from '../src/paths.mjs'
import { AgentHostError } from '../src/errors.mjs'
import { retireLifecycleRoot, withLifecycleMutation } from '../src/lifecycle-lock.mjs'
import { cleanupStorage } from '../src/storage.mjs'

const lockWorkerSource = String.raw`
import { access, appendFile } from 'node:fs/promises'
const [moduleUrl, root, startSignal, eventsPath, releaseSignal] = process.argv.slice(1)
const { withLifecycleMutation } = await import(moduleUrl)
process.stdout.write('READY\n')
while (true) {
  try {
    await access(startSignal)
    break
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2))
  }
}
try {
  await withLifecycleMutation({ root }, 'test.high-contention-worker', {}, async () => {
    await appendFile(eventsPath, 'S ' + process.pid + '\n')
    process.stdout.write('ENTERED\n')
    while (true) {
      try { await access(releaseSignal); break } catch (error) {
        if (error.code !== 'ENOENT') throw error
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
      }
    }
    await appendFile(eventsPath, 'E ' + process.pid + '\n')
  })
  process.stdout.write('RESULT ok\n')
} catch (error) {
  process.stdout.write('RESULT ' + (error.code ?? error.name) + '\n')
  process.stdout.write('DETAIL ' + JSON.stringify({ message: error.message, details: error.details }) + '\n')
}
`

const interruptedRecoveryWorkerSource = String.raw`
const [moduleUrl, root] = process.argv.slice(1)
const { withLifecycleMutation } = await import(moduleUrl)
try {
  await withLifecycleMutation({ root }, 'test.interrupted-recovery', {
    lifecycleRecoveryClaimPublished: async () => {
      process.stdout.write('CLAIM_PUBLISHED\n')
      await new Promise(() => {})
    },
  }, async () => {})
  process.stdout.write('UNEXPECTED_CALLBACK\n')
} catch (error) {
  process.stdout.write('RESULT ' + (error.code ?? error.name) + '\n')
  process.stdout.write('DETAIL ' + JSON.stringify({ message: error.message, details: error.details }) + '\n')
}
`

const recoveryGapWorkerSource = String.raw`
import { access } from 'node:fs/promises'
const [moduleUrl, root, continueSignal] = process.argv.slice(1)
const { withLifecycleMutation } = await import(moduleUrl)
try {
  await withLifecycleMutation({ root }, 'test.recovery-gap-reaper', {
    lifecycleRecoveryRetired: async () => {
      process.stdout.write('LOCK_RETIRED\n')
      while (true) {
        try {
          await access(continueSignal)
          break
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 2))
        }
      }
    },
  }, async () => {
    process.stdout.write('REAPER_CALLBACK\n')
  })
  process.stdout.write('RESULT ok\n')
} catch (error) {
  process.stdout.write('RESULT ' + (error.code ?? error.name) + '\n')
  process.stdout.write('DETAIL ' + JSON.stringify({ message: error.message, details: error.details }) + '\n')
}
`

async function temporaryStateRoot(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-host-lifecycle-lock-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'state')
  await mkdir(root)
  await ensurePrivateDirectory(root)
  return root
}

test('lifecycle mutation lock excludes concurrent owners and permits authenticated re-entry', async (t) => {
  const root = await temporaryStateRoot(t)
  const paths = { root }
  let release
  let entered = false
  const held = withLifecycleMutation(paths, 'test.held', {}, async (dependencies) => {
    entered = true
    await withLifecycleMutation(paths, 'test.nested', dependencies, async () => {})
    await new Promise((resolvePromise) => { release = resolvePromise })
  })
  while (!entered || release === undefined) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1))
  await assert.rejects(
    withLifecycleMutation(paths, 'test.contender', {}, async () => {}),
    (error) => error.code === 'LIFECYCLE_BUSY' && error.details.operation === 'test.held',
  )
  release()
  await held
  await withLifecycleMutation(paths, 'test.after', {}, async () => {})
  await assert.rejects(() => access(join(root, '.lifecycle-lock')), (error) => error.code === 'ENOENT')
})

test('lifecycle mutation lock reclaims only a lock whose recorded process is gone', async (t) => {
  const root = await temporaryStateRoot(t)
  const lock = join(root, '.lifecycle-lock')
  await mkdir(lock)
  await writeFile(join(lock, 'owner.json'), `${JSON.stringify({
    schemaVersion: 'openadam.agent-host-lifecycle-lock.v0.1',
    token: 'stale-owner',
    pid: 2_147_483_647,
    processStartedAt: '2026-01-01T00:00:00.000Z',
    operation: 'test.crashed',
    acquiredAt: '2026-01-01T00:00:00.000Z',
  })}\n`)
  await withLifecycleMutation({ root }, 'test.recovery', {}, async () => {})
  await assert.rejects(() => access(lock), (error) => error.code === 'ENOENT')
})

test('stale retirement retries sharing failures and rechecks owner identity before retry', async (t) => {
  for (const replaceOwner of [false, true]) {
    const root = await temporaryStateRoot(t)
    const lock = join(root, '.lifecycle-lock')
    const owner = {
      schemaVersion: 'openadam.agent-host-lifecycle-lock.v0.1',
      token: 'stale-owner', pid: 2_147_483_647,
      processStartedAt: '2026-01-01T00:00:00.000Z',
      operation: 'test.crashed', acquiredAt: '2026-01-01T00:00:00.000Z',
    }
    await mkdir(lock)
    await writeFile(join(lock, 'owner.json'), JSON.stringify(owner))
    let attempts = 0
    let entered = false
    const recovering = withLifecycleMutation({ root }, 'test.retry-retirement', {
      renameLifecycleLock: async (source, destination) => {
        attempts += 1
        if (attempts === 1) {
          if (replaceOwner) {
            await writeFile(join(lock, 'owner.json'), JSON.stringify({
              ...owner, token: 'replacement-owner', pid: process.pid,
              processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
            }))
          }
          throw Object.assign(new Error('sharing violation'), { code: 'EPERM' })
        }
        await rename(source, destination)
      },
    }, async () => { entered = true })
    if (replaceOwner) {
      await assert.rejects(recovering, { code: 'LIFECYCLE_BUSY' })
      assert.equal(attempts, 1)
      assert.equal(entered, false)
      assert.equal(JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')).token, 'replacement-owner')
    } else {
      await recovering
      assert.equal(attempts, 2)
      assert.equal(entered, true)
      await assert.rejects(access(lock), { code: 'ENOENT' })
    }
  }
})

test('lifecycle mutation lock rejects a reused live PID whose recorded start identity does not match', async (t) => {
  const root = await temporaryStateRoot(t)
  const lock = join(root, '.lifecycle-lock')
  await mkdir(lock)
  await writeFile(join(lock, 'owner.json'), `${JSON.stringify({
    schemaVersion: 'openadam.agent-host-lifecycle-lock.v0.1',
    token: 'reused-pid-owner',
    pid: process.pid,
    processStartedAt: '2020-01-01T00:00:00.000Z',
    operation: 'test.crashed-reused-pid',
    acquiredAt: '2020-01-01T00:00:00.000Z',
  })}\n`)
  await withLifecycleMutation({ root }, 'test.reused-pid-recovery', {}, async () => {})
  await assert.rejects(() => access(lock), (error) => error.code === 'ENOENT')
})

test('a live external PID with a Lord Howe ambiguous start identity fails closed on POSIX', { skip: process.platform === 'win32' }, async (t) => {
  const root = await temporaryStateRoot(t)
  const lock = join(root, '.lifecycle-lock')
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  t.after(() => child.kill())
  await new Promise((resolvePromise, reject) => {
    child.once('spawn', resolvePromise)
    child.once('error', reject)
  })
  const formatter = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Lord_Howe', dateStyle: 'full', timeStyle: 'medium', hour12: false,
  })
  assert.equal(
    formatter.format(new Date('2026-04-04T14:45:00.000Z')),
    formatter.format(new Date('2026-04-04T15:15:00.000Z')),
    'the repeated wall time is ambiguous by 30 minutes, not one hour',
  )
  await mkdir(lock)
  await writeFile(join(lock, 'owner.json'), `${JSON.stringify({
    schemaVersion: 'openadam.agent-host-lifecycle-lock.v0.1',
    token: 'ambiguous-live-owner',
    pid: child.pid,
    processStartedAt: '2026-04-04T15:15:00.000Z',
    operation: 'test.ambiguous-live-owner',
    acquiredAt: new Date().toISOString(),
  })}\n`)
  await assert.rejects(
    withLifecycleMutation({ root }, 'test.ambiguous-live-recovery', {}, async () => {}),
    (error) => error.code === 'LIFECYCLE_BUSY' && error.details.operation === 'test.ambiguous-live-owner',
  )
  await rm(lock, { recursive: true, force: true })
})

test('a killed published claimant does not block a high-contention recovery election or later ordinary acquisition', { timeout: process.platform === 'win32' ? 90_000 : 30_000 }, async (t) => {
  const root = await temporaryStateRoot(t)
  const directory = join(root, 'multiprocess-review')
  const lock = join(root, '.lifecycle-lock')
  const startSignal = join(directory, 'start')
  const releaseSignal = join(directory, 'release')
  const eventsPath = join(directory, 'events')
  await mkdir(directory)
  await mkdir(lock)
  await writeFile(join(lock, 'owner.json'), `${JSON.stringify({
    schemaVersion: 'openadam.agent-host-lifecycle-lock.v0.1',
    token: 'dead-owner-under-contention',
    pid: 2_147_483_647,
    processStartedAt: '2020-01-01T00:00:00.000Z',
    operation: 'test.dead-owner-under-contention',
    acquiredAt: '2020-01-01T00:00:00.000Z',
  })}\n`)

  const moduleUrl = new URL('../src/lifecycle-lock.mjs', import.meta.url).href
  const interrupted = spawn(process.execPath, ['--input-type=module', '-e', interruptedRecoveryWorkerSource, moduleUrl, root], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => {
    if (interrupted.exitCode === null) interrupted.kill()
  })
  let interruptedOutput = ''
  let interruptedError = ''
  const interruptedClosed = new Promise((resolvePromise) => interrupted.once('close', resolvePromise))
  await new Promise((resolvePromise, reject) => {
    interrupted.stdout.on('data', (chunk) => {
      interruptedOutput += chunk
      if (interruptedOutput.includes('CLAIM_PUBLISHED\n')) resolvePromise()
    })
    interrupted.stderr.on('data', (chunk) => { interruptedError += chunk })
    interrupted.once('error', reject)
    interrupted.once('close', (status) => reject(new Error(`interrupted recovery exited before publishing its claim (${status}): ${interruptedError}`)))
  })
  await access(lock)
  assert.equal((await readdir(join(lock, '.recovery-claims'))).some((name) => name.startsWith('claim-')), true)
  interrupted.kill()
  await interruptedClosed
  assert.equal(interruptedOutput.includes('UNEXPECTED_CALLBACK'), false)

  const workers = Array.from({ length: 24 }, () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', lockWorkerSource, moduleUrl, root, startSignal, eventsPath, releaseSignal], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    t.after(() => {
      if (child.exitCode === null) child.kill()
    })
    let stdout = ''
    let stderr = ''
    let enteredResolve
    const entered = new Promise((resolvePromise) => { enteredResolve = resolvePromise })
    let readyResolve
    let readyReject
    const ready = new Promise((resolvePromise, reject) => {
      readyResolve = resolvePromise
      readyReject = reject
    })
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (stdout.includes('READY\n')) readyResolve()
      if (stdout.includes('ENTERED\n')) enteredResolve()
    })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', readyReject)
    const done = new Promise((resolvePromise, reject) => {
      child.once('error', reject)
      child.once('close', (status) => resolvePromise({ status, stdout, stderr }))
    })
    return { ready, done, entered }
  })
  await Promise.all(workers.map((worker) => worker.ready))
  await writeFile(startSignal, 'start\n')
  // Keep every successful lease live until every contender has either entered
  // or returned. A fixed sleep can permit unrelated sequential acquisitions
  // when a Windows process is scheduled late.
  await Promise.all(workers.map((worker) => Promise.race([worker.done, worker.entered])))
  await writeFile(releaseSignal, 'release\n')
  const results = await Promise.all(workers.map((worker) => worker.done))
  for (const result of results) assert.equal(result.status, 0, result.stderr)
  const outcomes = results.map((result) => result.stdout.match(/RESULT ([A-Z0-9_]+|ok)/u)?.[1])
  assert.equal(outcomes.filter((outcome) => outcome === 'ok').length, 1, JSON.stringify(outcomes))
  assert.equal(outcomes.some((outcome) => ['LIFECYCLE_LOCK_LOST', 'LIFECYCLE_LOCK_INVALID'].includes(outcome)), false, JSON.stringify(outcomes))
  assert.equal(outcomes.every((outcome) => ['ok', 'LIFECYCLE_BUSY', 'LIFECYCLE_RECOVERY_BUSY'].includes(outcome)), true, JSON.stringify(results.filter((result, index) => !['ok', 'LIFECYCLE_BUSY', 'LIFECYCLE_RECOVERY_BUSY'].includes(outcomes[index]))))

  const events = (await readFile(eventsPath, 'utf8')).trim().split('\n')
  let active = 0
  let maximumActive = 0
  for (const event of events) {
    if (event.startsWith('S ')) {
      active += 1
      maximumActive = Math.max(maximumActive, active)
    } else if (event.startsWith('E ')) {
      active -= 1
    }
  }
  assert.equal(maximumActive, 1)
  assert.equal(active, 0)

  await withLifecycleMutation({ root }, 'test.ordinary-after-recovery', {}, async () => {
    await writeFile(join(directory, 'ordinary-acquisition'), 'ok\n')
  })
  assert.equal(await readFile(join(directory, 'ordinary-acquisition'), 'utf8'), 'ok\n')
})

test('an ordinary publisher that wins the post-retirement path race prevents the reaper callback', { timeout: 30_000 }, async (t) => {
  const root = await temporaryStateRoot(t)
  const lock = join(root, '.lifecycle-lock')
  const continueSignal = join(root, 'continue-reaper')
  await mkdir(lock)
  await writeFile(join(lock, 'owner.json'), `${JSON.stringify({
    schemaVersion: 'openadam.agent-host-lifecycle-lock.v0.1',
    token: 'dead-owner-before-ordinary-publisher',
    pid: 2_147_483_647,
    processStartedAt: '2020-01-01T00:00:00.000Z',
    operation: 'test.dead-owner-before-ordinary-publisher',
    acquiredAt: '2020-01-01T00:00:00.000Z',
  })}\n`)

  const moduleUrl = new URL('../src/lifecycle-lock.mjs', import.meta.url).href
  const reaper = spawn(process.execPath, ['--input-type=module', '-e', recoveryGapWorkerSource, moduleUrl, root, continueSignal], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => {
    if (reaper.exitCode === null) reaper.kill()
  })
  let stdout = ''
  let stderr = ''
  const reaperDone = new Promise((resolvePromise, reject) => {
    reaper.once('error', reject)
    reaper.once('close', (status) => resolvePromise({ status }))
  })
  await new Promise((resolvePromise, reject) => {
    reaper.stdout.on('data', (chunk) => {
      stdout += chunk
      if (stdout.includes('LOCK_RETIRED\n')) resolvePromise()
    })
    reaper.stderr.on('data', (chunk) => { stderr += chunk })
    reaper.once('error', reject)
    reaper.once('close', (status) => reject(new Error(`reaper exited before retiring the stale lock (${status}): ${stderr}`)))
  })
  await assert.rejects(() => access(lock), (error) => error.code === 'ENOENT')

  let releaseOrdinary
  let ordinaryEntered = false
  const ordinary = withLifecycleMutation({ root }, 'test.ordinary-wins-recovery-gap', {}, async () => {
    ordinaryEntered = true
    await new Promise((resolvePromise) => { releaseOrdinary = resolvePromise })
  })
  while (!ordinaryEntered || releaseOrdinary === undefined) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1))
  await writeFile(continueSignal, 'continue\n')
  const { status } = await reaperDone
  assert.equal(status, 0, stderr)
  assert.equal(stdout.includes('REAPER_CALLBACK'), false, stdout)
  assert.equal(stdout.includes('RESULT LIFECYCLE_BUSY\n'), true, stdout)

  releaseOrdinary()
  await ordinary
  await assert.rejects(() => access(lock), (error) => error.code === 'ENOENT')
})

test('a malformed recovery claim fails closed without retiring the stale lock', async (t) => {
  const root = await temporaryStateRoot(t)
  const lock = join(root, '.lifecycle-lock')
  const claims = join(lock, '.recovery-claims')
  await mkdir(lock)
  await writeFile(join(lock, 'owner.json'), `${JSON.stringify({
    schemaVersion: 'openadam.agent-host-lifecycle-lock.v0.1',
    token: 'malformed-claim-target',
    pid: 2_147_483_647,
    processStartedAt: '2020-01-01T00:00:00.000Z',
    operation: 'test.malformed-claim-target',
    acquiredAt: '2020-01-01T00:00:00.000Z',
  })}\n`)
  await mkdir(claims)
  await writeFile(join(claims, 'claim-11111111-1111-4111-8111-111111111111.json'), '{}\n')

  await assert.rejects(
    withLifecycleMutation({ root }, 'test.malformed-claim', {}, async () => {}),
    (error) => error.code === 'LIFECYCLE_RECOVERY_INVALID',
  )
  await access(lock)
})

test('a null final recovery claim or ticket fails closed without entering the callback', async (t) => {
  for (const entryKind of ['claim', 'ticket']) {
    await t.test(entryKind, async () => {
      const root = await temporaryStateRoot(t)
      const lock = join(root, '.lifecycle-lock')
      const claims = join(lock, '.recovery-claims')
      const token = entryKind === 'claim'
        ? '11111111-1111-4111-8111-111111111111'
        : '22222222-2222-4222-8222-222222222222'
      await mkdir(lock)
      await writeFile(join(lock, 'owner.json'), `${JSON.stringify({
        schemaVersion: 'openadam.agent-host-lifecycle-lock.v0.1',
        token: `null-${entryKind}-target`,
        pid: 2_147_483_647,
        processStartedAt: '2020-01-01T00:00:00.000Z',
        operation: `test.null-${entryKind}-target`,
        acquiredAt: '2020-01-01T00:00:00.000Z',
      })}\n`)
      await mkdir(claims)
      await writeFile(join(claims, `${entryKind}-${token}.json`), 'null\n')

      let callbackEntered = false
      await assert.rejects(
        withLifecycleMutation({ root }, `test.null-${entryKind}`, {}, async () => {
          callbackEntered = true
        }),
        (error) => error.code === 'LIFECYCLE_RECOVERY_INVALID',
      )
      assert.equal(callbackEntered, false)
      await access(lock)
    })
  }
})

test('recovery election removes only bounded dead-claim garbage and retains a live claimant', async (t) => {
  const root = await temporaryStateRoot(t)
  const lock = join(root, '.lifecycle-lock')
  const claims = join(lock, '.recovery-claims')
  const targetOwnerToken = 'dead-garbage-target'
  const deadToken = '11111111-1111-4111-8111-111111111111'
  const liveToken = '22222222-2222-4222-8222-222222222222'
  const processStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString()
  await mkdir(lock)
  await writeFile(join(lock, 'owner.json'), `${JSON.stringify({
    schemaVersion: 'openadam.agent-host-lifecycle-lock.v0.1',
    token: targetOwnerToken,
    pid: 2_147_483_647,
    processStartedAt: '2020-01-01T00:00:00.000Z',
    operation: 'test.dead-garbage-target',
    acquiredAt: '2020-01-01T00:00:00.000Z',
  })}\n`)
  await mkdir(claims)
  const claim = (token, pid, startedAt) => ({
    schemaVersion: 'openadam.agent-host-lifecycle-recovery-claim.v0.1',
    token,
    targetOwnerToken,
    pid,
    processStartedAt: startedAt,
    operation: `recover:test.${token}`,
    acquiredAt: new Date().toISOString(),
  })
  const ticket = (token, value) => ({
    schemaVersion: 'openadam.agent-host-lifecycle-recovery-ticket.v0.1',
    token,
    targetOwnerToken,
    ticket: value,
  })
  await writeFile(join(claims, `claim-${deadToken}.json`), `${JSON.stringify(claim(deadToken, 2_147_483_647, '2020-01-01T00:00:00.000Z'))}\n`)
  await writeFile(join(claims, `ticket-${deadToken}.json`), `${JSON.stringify(ticket(deadToken, 1))}\n`)
  await writeFile(join(claims, `claim-${liveToken}.json`), `${JSON.stringify(claim(liveToken, process.pid, processStartedAt))}\n`)
  await writeFile(join(claims, `ticket-${liveToken}.json`), `${JSON.stringify(ticket(liveToken, 1))}\n`)

  await assert.rejects(
    withLifecycleMutation({ root }, 'test.dead-claim-cleanup', {}, async () => {}),
    (error) => error.code === 'LIFECYCLE_RECOVERY_BUSY',
  )
  const retained = await readdir(claims)
  assert.equal(retained.includes(`claim-${deadToken}.json`), false)
  assert.equal(retained.includes(`ticket-${deadToken}.json`), false)
  assert.equal(retained.includes(`claim-${liveToken}.json`), true)
  assert.equal(retained.includes(`ticket-${liveToken}.json`), true)
})

test('oversized dead recovery garbage converges through bounded cleanup passes before election', async (t) => {
  const root = await temporaryStateRoot(t)
  const lock = join(root, '.lifecycle-lock')
  const claims = join(lock, '.recovery-claims')
  const targetOwnerToken = 'bounded-dead-garbage-target'
  await mkdir(lock)
  await writeFile(join(lock, 'owner.json'), `${JSON.stringify({
    schemaVersion: 'openadam.agent-host-lifecycle-lock.v0.1',
    token: targetOwnerToken,
    pid: 2_147_483_647,
    processStartedAt: '2020-01-01T00:00:00.000Z',
    operation: 'test.bounded-dead-garbage-target',
    acquiredAt: '2020-01-01T00:00:00.000Z',
  })}\n`)
  await mkdir(claims)
  for (let index = 0; index < 129; index += 1) {
    const token = randomUUID()
    await writeFile(join(claims, `claim-${token}.json`), `${JSON.stringify({
      schemaVersion: 'openadam.agent-host-lifecycle-recovery-claim.v0.1',
      token,
      targetOwnerToken,
      pid: 2_147_483_647,
      processStartedAt: '2020-01-01T00:00:00.000Z',
      operation: `recover:test.dead-garbage-${index}`,
      acquiredAt: '2020-01-01T00:00:00.000Z',
    })}\n`)
    await writeFile(join(claims, `ticket-${token}.json`), `${JSON.stringify({
      schemaVersion: 'openadam.agent-host-lifecycle-recovery-ticket.v0.1',
      token,
      targetOwnerToken,
      ticket: 1,
    })}\n`)
  }

  await assert.rejects(
    withLifecycleMutation({ root }, 'test.bounded-dead-garbage-first-pass', {}, async () => {}),
    (error) => error.code === 'LIFECYCLE_RECOVERY_BUSY',
  )
  assert.equal((await readdir(claims)).length <= 4, true)
  await withLifecycleMutation({ root }, 'test.bounded-dead-garbage-second-pass', {}, async () => {})
  await assert.rejects(() => access(lock), (error) => error.code === 'ENOENT')
})

test('lifecycle mutation lock fails closed for an incomplete published owner', async (t) => {
  const root = await temporaryStateRoot(t)
  const lock = join(root, '.lifecycle-lock')
  await mkdir(lock)
  await writeFile(join(lock, 'owner.json'), '{}\n')
  await assert.rejects(
    withLifecycleMutation({ root }, 'test.invalid', {}, async () => {}),
    { code: 'LIFECYCLE_LOCK_INVALID' },
  )
  await rm(lock, { recursive: true, force: true })
})

test('a busy lifecycle mutation has zero state-root side effects before admission', async (t) => {
  const root = await temporaryStateRoot(t)
  const lock = join(root, '.lifecycle-lock')
  await mkdir(lock)
  await writeFile(join(lock, 'owner.json'), `${JSON.stringify({
    schemaVersion: 'openadam.agent-host-lifecycle-lock.v0.1',
    token: 'live-owner',
    pid: process.pid,
    processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    operation: 'test.live-owner',
    acquiredAt: new Date().toISOString(),
  })}\n`)
  const before = await readdir(root)
  await assert.rejects(
    cleanupStorage({ stateRoot: root }),
    (error) => error.code === 'LIFECYCLE_BUSY' && error.details.operation === 'test.live-owner',
  )
  assert.deepEqual(await readdir(root), before)
  await rm(lock, { recursive: true, force: true })
})

test('a failed mutation on a newly published pure scaffold leaves no state root', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-host-missing-root-mutation-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'missing', 'private', 'state')
  await assert.rejects(cleanupStorage({ stateRoot: root }), (error) => error.code === 'NOT_INSTALLED')
  await assert.rejects(() => access(root), (error) => error.code === 'ENOENT')
})

test('a successful empty mutation on a newly published pure scaffold leaves no state root', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-host-missing-root-empty-mutation-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'missing', 'private', 'state')
  const result = await withLifecycleMutation({ root }, 'test.empty-success', {}, async () => 'completed')
  assert.equal(result, 'completed')
  await assert.rejects(() => access(root), (error) => error.code === 'ENOENT')
})

test('a failed first mutation retains non-scaffold diagnostic state', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-host-retained-first-mutation-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'state')
  await assert.rejects(
    withLifecycleMutation({ root }, 'test.retained-diagnostic', {}, async (_dependencies, paths) => {
      await writeFile(join(paths.context, 'retained-diagnostic.json'), '{}\n')
      throw new AgentHostError('TEST_MUTATION_FAILED', 'The test mutation failed after retaining diagnostic state')
    }),
    (error) => error.code === 'TEST_MUTATION_FAILED',
  )
  assert.equal(await readFile(join(root, 'context', 'retained-diagnostic.json'), 'utf8'), '{}\n')
  await assert.rejects(() => access(join(root, '.lifecycle-lock')), (error) => error.code === 'ENOENT')
})

test('a mutation failure plus lease-release failure returns a bounded path-free compound error', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-host-compound-lifecycle-failure-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'state')
  await assert.rejects(
    withLifecycleMutation({ root }, 'test.compound-failure', {}, async (_dependencies, paths) => {
      await rm(join(paths.root, '.lifecycle-lock'), { recursive: true, force: false })
      throw new AgentHostError('TEST_MUTATION_FAILED', `Original mutation failed at ${paths.root}`)
    }),
    (error) => {
      assert.equal(error.code, 'LIFECYCLE_MUTATION_RELEASE_FAILED')
      assert.deepEqual(error.details, {
        operation: 'test.compound-failure',
        mutation: { code: 'TEST_MUTATION_FAILED', message: 'Original mutation failed at <private-path>' },
        release: { code: 'LIFECYCLE_LOCK_LOST', message: 'The Agent Host lifecycle lock changed before the current mutation completed' },
      })
      const serialized = JSON.stringify(error.details)
      assert.equal(serialized.includes(directory), false)
      assert.equal(Buffer.byteLength(serialized, 'utf8') < 2048, true)
      return true
    },
  )
})

test('retiring a lifecycle root keeps cleanup isolated from a replacement root', async (t) => {
  const root = await temporaryStateRoot(t)
  let retiredRoot
  await withLifecycleMutation({ root }, 'test.retire', {}, async (dependencies) => {
    retiredRoot = await retireLifecycleRoot(dependencies.lifecycleLease, 'test-retired')
    await withLifecycleMutation({ root }, 'test.replacement', {}, async (_replacementDependencies, preparedPaths) => {
      await writeFile(join(preparedPaths.root, 'replacement-marker'), 'replacement\n')
    })
  })
  await rm(retiredRoot, { recursive: true, force: false })
  assert.equal(await readFile(join(root, 'replacement-marker'), 'utf8'), 'replacement\n')
})
