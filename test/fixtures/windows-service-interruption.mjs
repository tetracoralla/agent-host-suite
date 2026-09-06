import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { secureWindowsDirectory } from '../../src/private-permissions.mjs'
import { join } from 'node:path'
import { withLifecycleMutation } from '../../src/lifecycle-lock.mjs'
import { writeEnvironmentJson } from '../../src/environment-resources.mjs'
import { loadState, readStatePaths, saveState, STATE_SCHEMA } from '../../src/state.mjs'
import { installService, uninstallService, WINDOWS_SERVICE_TASK } from '../../src/service.mjs'

const protocol = 'openadam.windows-task.v0.1'
const read = (path) => readFile(path, 'utf8').then(JSON.parse)
const write = (path, value) => writeFile(path, JSON.stringify(value))
function interruptAt(root, phase) {
  writeFileSync(join(root, 'interruption.json'), JSON.stringify({ phase }), { mode: 0o600 })
  process.kill(process.pid, 'SIGKILL')
}
export function fixtureConfiguration(root, phase = null) {
  const taskPath = join(root, 'task.json')
  const securityPath = join(root, 'file-security.json')
  const calls = []
  const getTask = () => read(taskPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
  const runner = async (command, args, options) => {
    if (command !== 'powershell.exe' || args.at(-2) !== '-File') throw new Error('Unexpected native task fixture request')
    const request = JSON.parse(options.input)
    calls.push(request)
    if (request.protocol !== protocol || request.taskName !== WINDOWS_SERVICE_TASK) throw new Error('Unexpected task fixture identity')
    if (['file-security', 'set-file-security', 'validate-file-security'].includes(request.operation)) {
      const records = await read(securityPath).catch((error) => error.code === 'ENOENT' ? {} : Promise.reject(error))
      let security = request.security
      if (request.operation !== 'validate-file-security') {
        const key = String((await lstat(request.path, { bigint: true })).ino)
        if (request.operation === 'set-file-security') { records[key] = security; await write(securityPath, records) }
        security = records[key] ?? 'O:fixture-userG:fixture-userD:P(A;;FA;;;fixture-user)'
      }
      return { status: 0, stdout: JSON.stringify({ protocol, security }), stderr: '' }
    }
    const task = await getTask()
    let result = task
    if (request.operation === 'prepare') {
      // An independent durable native task stand-in. XML/ACL are opaque to the
      // JS recovery implementation. This does not execute or validate Windows COM.
      result = { xml: '<Task><Action>' + request.launcherPath + '</Action><Settings><Enabled>true</Enabled></Settings></Task>',
        sddl: 'O:fixture-userG:fixture-userD:P(A;;FA;;;fixture-user)', state: 4 }
    } else if (request.operation === 'validate') {
      if (!request.task.xml.startsWith('<Task>') || !request.task.xml.endsWith('</Task>')) {
        return { status: 1, stdout: JSON.stringify({ protocol, error: 'SERVICE_DEFINITION_INVALID' }), stderr: '' }
      }
      result = request.task
    } else if (request.operation === 'remove' || request.operation === 'create' || request.operation === 'run') {
      const matches = task === null || request.expected === null ? task === request.expected
        : task.xml === request.expected.xml && task.sddl === request.expected.sddl
      if (!matches) return { status: 1, stdout: JSON.stringify({ protocol, error: 'ENVIRONMENT_RESOURCE_CHANGED' }), stderr: '' }
      if (request.operation === 'remove') {
        if (task !== null) {
          await write(taskPath, { ...task, state: 3 })
          if (phase === 'stopped') interruptAt(root, phase)
        }
        result = null
        await write(taskPath, result)
        if (phase === 'removed') interruptAt(root, phase)
      } else if (request.operation === 'create') {
        if (phase === 'written') interruptAt(root, phase)
        result = { ...request.task, state: request.task.state === 1 ? 1 : 3 }
        await write(taskPath, result)
        if (phase === 'registered') interruptAt(root, phase)
      } else {
        result = { ...task, state: 4 }
        await write(taskPath, result)
        if (phase === 'started') interruptAt(root, phase)
      }
    } else if (request.operation !== 'observe') throw new Error('Unexpected native task fixture operation')
    return { status: 0, stdout: JSON.stringify({ protocol, task: result }), stderr: '' }
  }
  const dependencies = { runner, calls, servicePlatform: 'win32', recoverEnvironmentChange: true,
    serviceLauncherPath: join(root, 'carrier', 'service.cmd'),
    serviceWaitForEndpoint: async () => (await getTask())?.state === 4,
    serviceEndpointReachable: async () => (await getTask())?.state === 4,
  }
  if (phase === 'prepared') dependencies.afterEnvironmentChangePrepared = ({ kind }) => {
    if (kind === 'windows-service') interruptAt(root, phase)
  }
  return { dependencies, getTask, taskPath, securityPath,
    files: { configPath: join(root, 'config.json'), socketPath: '\\\\.\\pipe\\fixture-runtime', observationLog: join(root, 'observations.jsonl') },
    runtime: { command: process.execPath, args: [join(root, 'new-runtime.mjs'), 'two words', '', '%literal%'], fingerprint: 'sha256:' + '2'.repeat(64) },
  }
}
export async function seedFixture(root, installed) {
  const { dependencies, files } = fixtureConfiguration(root)
  await secureWindowsDirectory(root)
  await mkdir(join(root, 'carrier'), { mode: 0o700 })
  const before = { schemaVersion: STATE_SCHEMA, suiteVersion: '0.1.6', channel: 'development', profile: 'standard',
    installedAt: '2026-09-06T00:00:00Z', updatedAt: '2026-09-06T00:00:00Z', components: {}, hosts: {}, runtime: { service: null }, observability: {} }
  await withLifecycleMutation({ root: join(root, 'state') }, 'fixture.seed', dependencies, async (_locked, paths) => {
    if (installed) {
      before.runtime.service = await installService({ command: process.execPath, args: [join(root, 'old-runtime.mjs'), 'old argument'], fingerprint: 'sha256:' + '1'.repeat(64) }, files, dependencies.runner, null, { platformName: 'win32' })
    }
    await saveState(paths, before)
  })
  await writeFile(join(root, 'user.json'), '{"selected":"before","unrelated":"original"}')
  return loadState(await readStatePaths(join(root, 'state')))
}
if (process.argv[2] === '--interrupt') {
  const [root, operation, phase] = process.argv.slice(3)
  const { dependencies, files, runtime } = fixtureConfiguration(root, phase)
  await withLifecycleMutation({ root: join(root, 'state') }, 'fixture.' + operation, dependencies, async (_locked, paths) => {
    const previous = await loadState(paths)
    await writeEnvironmentJson(join(root, 'user.json'), { selected: 'after', unrelated: 'original' }, [['selected']])
    const service = operation === 'remove'
      ? await uninstallService(previous.runtime.service, dependencies.runner, { platformName: 'win32' })
      : await installService(runtime, files, dependencies.runner, previous.runtime.service, { platformName: 'win32' })
    if (phase === 'committed') await saveState(paths, { ...previous, runtime: { service: operation === 'remove' ? null : service }, updatedAt: '2026-09-06T01:00:00Z' })
    interruptAt(root, phase)
  })
}
if (process.argv[2] === '--interrupt-recovery') {
  const root = process.argv[3]
  const { dependencies } = fixtureConfiguration(root)
  await withLifecycleMutation({ root: join(root, 'state') }, 'fixture.recover', {
    ...dependencies, afterEnvironmentRecoveryStep: ({ remaining }) => { if (remaining === 1) interruptAt(root, 'recovery') },
  }, async () => {})
}
