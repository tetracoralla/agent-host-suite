// Explicit native Windows probe. It owns only a fresh suffixed task identity,
// temporary private root and named pipe. It invokes no Provider or model.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withLifecycleMutation } from '../src/lifecycle-lock.mjs'
import { writeEnvironmentJson } from '../src/environment-resources.mjs'
import { secureWindowsDirectory } from '../src/private-permissions.mjs'
import { runFile } from '../src/process.mjs'
import { installService, uninstallService, WINDOWS_SERVICE_TASK } from '../src/service.mjs'
import { loadState, readStatePaths, saveState, STATE_SCHEMA } from '../src/state.mjs'
import { windowsTask } from '../src/windows-task.mjs'

function interruptAt(root, phase) {
  writeFileSync(join(root, 'interruption.json'), JSON.stringify({ phase }), { mode: 0o600 })
  process.kill(process.pid, 'SIGKILL')
}
function configuration(root, taskName, phase) {
  assert.match(taskName, /^\\openAdam\\AgentHostRuntime\.probe-[0-9a-f-]{36}$/u)
  const runner = async (command, args, options) => {
    const request = command === 'powershell.exe' && args.at(-2) === '-File' ? JSON.parse(options.input) : null
    if (request?.operation === 'create' && phase === 'written') interruptAt(root, phase)
    const result = await runFile(command, args, options)
    if (result.status === 0 && ((request?.operation === 'create' && phase === 'registered')
      || (request?.operation === 'remove' && phase === 'removed'))) interruptAt(root, phase)
    return result
  }
  const dependencies = { runner, recoverEnvironmentChange: true, serviceTaskName: taskName,
    serviceLauncherPath: join(root, 'service.cmd') }
  if (phase === 'prepared') dependencies.afterEnvironmentChangePrepared = ({ kind }) => {
    if (kind === 'windows-service') interruptAt(root, phase)
  }
  return { dependencies,
    files: { configPath: join(root, 'config.json'), socketPath: '\\\\.\\pipe\\' + taskName.slice(taskName.lastIndexOf('\\') + 1), observationLog: join(root, 'observations.jsonl') },
    runtime: { command: process.execPath, args: [join(root, 'fixture.mjs'), 'new', 'two words', '', '%literal%'] },
  }
}

if (process.platform !== 'win32') {
  process.stdout.write(JSON.stringify({ status: 'unavailable', reason: 'Native Windows is required; no service was operated' }) + '\n')
  process.exitCode = 2
} else if (process.argv[2] === '--child') {
  const [root, operation, phase, taskName] = process.argv.slice(3)
  const { dependencies, files, runtime } = configuration(root, taskName, phase)
  await withLifecycleMutation({ root: join(root, 'state') }, 'probe.' + operation, dependencies, async (_locked, paths) => {
    const previous = await loadState(paths)
    await writeEnvironmentJson(join(root, 'user.json'), { selected: 'after' }, [['selected']])
    const service = operation === 'remove' ? await uninstallService(previous.runtime.service, dependencies.runner)
      : await installService(runtime, files, dependencies.runner, previous.runtime.service)
    if (phase === 'committed') await saveState(paths, { ...previous, runtime: { service: operation === 'remove' ? null : service }, updatedAt: '2026-09-06T01:00:00Z' })
    interruptAt(root, phase)
  })
} else {
  const report = { route: 'native Windows Task Scheduler, isolated source lifecycle, named-pipe fixture and owner process termination', cases: [] }
  for (const [operation, phase] of [['install', 'prepared'], ['install', 'registered'], ['replace', 'removed'], ['replace', 'written'], ['replace', 'ready'], ['replace', 'committed'], ['remove', 'removed'], ['remove', 'ready']]) {
    const root = await mkdtemp(join(tmpdir(), 'agent-host-native-windows-'))
    const taskName = WINDOWS_SERVICE_TASK + '.probe-' + randomUUID()
    const { dependencies, files } = configuration(root, taskName)
    let failed = false
    try {
      await secureWindowsDirectory(root)
      await writeFile(join(root, 'fixture.mjs'), 'import {createServer} from "node:net"; const socket=process.argv[process.argv.indexOf("--socket")+1]; const server=createServer(s=>s.end()); server.listen(socket); process.on("SIGTERM",()=>server.close(()=>process.exit(0)));\n')
      await writeFile(join(root, 'user.json'), '{"selected":"before"}')
      await withLifecycleMutation({ root: join(root, 'state') }, 'probe.seed', dependencies, async (_locked, paths) => {
        const service = operation === 'install' ? null : await installService({ command: process.execPath, args: [join(root, 'fixture.mjs'), 'old'] }, files, dependencies.runner)
        await saveState(paths, { schemaVersion: STATE_SCHEMA, suiteVersion: '0.1.6', channel: 'development', profile: 'standard',
          installedAt: '2026-09-06T00:00:00Z', updatedAt: '2026-09-06T00:00:00Z', components: {}, hosts: {}, runtime: { service }, observability: {} })
      })
      const paths = await readStatePaths(join(root, 'state'))
      const before = await loadState(paths)
      const beforeTask = await windowsTask('observe', taskName)
      const beforeFile = await readFile(dependencies.serviceLauncherPath, 'utf8').catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
      const stopped = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', root, operation, phase, taskName], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
        let stderr = ''
        child.stderr.on('data', (bytes) => { stderr = (stderr + bytes).slice(-8192) })
        child.once('error', reject)
        child.once('close', (code, signal) => resolve({ code, signal, stderr }))
      })
      // Windows represents TerminateProcess as an exit code rather than a POSIX
      // signal. The durable pointer/commit below proves the selected boundary.
      assert.notEqual(stopped.code, 0, stopped.stderr)
      const interruption = await readFile(join(root, 'interruption.json'), 'utf8').catch((error) => {
        if (error.code !== 'ENOENT') throw error
        throw new Error('Native child exited before the selected interruption: ' + stopped.stderr.slice(-4096))
      })
      assert.deepEqual(JSON.parse(interruption), { phase })
      if (phase !== 'committed') await assert.rejects(loadState(paths), { code: 'ENVIRONMENT_RECOVERY_REQUIRED' })
      await withLifecycleMutation({ root: paths.root }, 'probe.recover', dependencies, async () => {})
      const restored = await loadState(paths)
      if (phase === 'committed') assert.equal(restored.updatedAt, '2026-09-06T01:00:00Z')
      else {
        assert.deepEqual(restored, before)
        assert.deepEqual(await windowsTask('observe', taskName), beforeTask)
        assert.equal(await readFile(dependencies.serviceLauncherPath, 'utf8').catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error)), beforeFile)
      }
      assert.equal(JSON.parse(await readFile(join(root, 'user.json'), 'utf8')).selected, phase === 'committed' ? 'after' : 'before')
      await withLifecycleMutation({ root: paths.root }, 'probe.uninstall', dependencies, async (_locked, lockedPaths) => {
        if (restored.runtime.service !== null) await uninstallService(restored.runtime.service, dependencies.runner)
        await saveState(lockedPaths, { ...restored, runtime: { service: null } })
      })
      assert.equal(await windowsTask('observe', taskName), null)
      report.cases.push({ operation, phase, status: 'passed' })
    } catch (error) {
      failed = true
      report.cases.push({ operation, phase, status: 'failed', code: error.code ?? 'PROBE_FAILED', message: error.message, retainedRoot: root, taskName })
      process.exitCode = 1
    } finally {
      // Failed records remain for diagnosis. Do not use force-delete to turn a
      // failed ownership or definition check into a successful cleanup claim.
      if (!failed) await rm(root, { recursive: true, force: true })
    }
    if (failed) break
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
}
