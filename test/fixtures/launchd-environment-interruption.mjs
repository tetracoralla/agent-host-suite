import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runFile } from '../../src/process.mjs'
import { installService, uninstallService, launchAgentContents, SERVICE_LABEL } from '../../src/service.mjs'
import { withLifecycleMutation } from '../../src/lifecycle-lock.mjs'
import { readStatePaths, loadState, saveState, STATE_SCHEMA } from '../../src/state.mjs'
import { writeEnvironmentJson } from '../../src/environment-resources.mjs'

const read = (path) => readFile(path, 'utf8').then(JSON.parse)
const write = (path, value) => writeFile(path, JSON.stringify(value))
export function printed(job) {
  const value = job.definition
  return 'gui/fixture/' + job.label + ' = {\n\tpath = ' + value.path + '\n\tstate = ' + (job.running ? 'running' : 'spawn scheduled')
    + '\n\tprogram = ' + value.program + '\n\targuments = {\n' + value.args.map((arg) => '\t\t' + arg + '\n').join('')
    + '\t}\n\tstdout path = ' + value.stdout + '\n\tstderr path = ' + value.stderr + '\n\tenvironment = {\n'
    + Object.entries(value.environment).map(([name, text]) => '\t\t' + name + ' => ' + text + '\n').join('') + '\t}\n}\n'
}
export function fixtureConfiguration(root, phase = null) {
  const jobPath = join(root, 'job.json')
  const calls = []
  const getJob = () => read(jobPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
  const runner = async (command, args, options = {}) => {
    calls.push({ command, args })
    if (command === '/usr/bin/plutil') return runFile(command, args, options)
    if (command !== '/bin/launchctl') throw new Error('Unexpected service fixture command')
    if (args[0] === 'print') {
      const job = await getJob()
      return job === null ? { status: 113, stdout: '', stderr: 'Could not find service "' + SERVICE_LABEL + '"' }
        : { status: 0, stdout: printed(job), stderr: '' }
    }
    if (args[0] === 'bootout') {
      await write(jobPath, null)
      if (phase === 'stopped') process.kill(process.pid, 'SIGKILL')
    } else if (args[0] === 'bootstrap') {
      if (phase === 'written') process.kill(process.pid, 'SIGKILL')
      const plist = JSON.parse((await runFile('/usr/bin/plutil', ['-convert', 'json', '-o', '-', args[2]])).stdout)
      await write(jobPath, { label: plist.Label, running: true, definition: { path: args[2], program: plist.Program ?? plist.ProgramArguments[0],
        args: plist.ProgramArguments, environment: plist.EnvironmentVariables ?? {}, stdout: plist.StandardOutPath ?? '', stderr: plist.StandardErrorPath ?? '' } })
      if (phase === 'started') process.kill(process.pid, 'SIGKILL')
    } else throw new Error('Unexpected service fixture operation')
    return { status: 0, stdout: '', stderr: '' }
  }
  const dependencies = { runner, calls, servicePlatform: 'darwin', recoverEnvironmentChange: true,
    serviceLaunchAgentPath: join(root, 'carrier', 'service.plist'),
    serviceWaitForEndpoint: async () => (await getJob())?.running === true,
    serviceEndpointReachable: async () => (await getJob())?.running === true,
  }
  if (phase === 'prepared') dependencies.afterEnvironmentChangePrepared = ({ kind }) => {
    if (kind === 'launchd-service') process.kill(process.pid, 'SIGKILL')
  }
  return { dependencies, getJob, jobPath,
    files: { configPath: join(root, 'config.json'), socketPath: join(root, 'service.sock'), observationLog: join(root, 'observations.jsonl') },
    runtime: { command: process.execPath, args: [join(root, 'new-runtime.mjs'), 'two words', '', ' leading '] },
  }
}
export async function seedFixture(root, installed) {
  const { dependencies, files } = fixtureConfiguration(root)
  await mkdir(join(root, 'carrier'))
  const before = { schemaVersion: STATE_SCHEMA, suiteVersion: '0.1.6', channel: 'development', profile: 'standard',
    installedAt: '2026-09-06T00:00:00Z', updatedAt: '2026-09-06T00:00:00Z', components: {}, hosts: {}, runtime: { service: null }, observability: {} }
  await withLifecycleMutation({ root: join(root, 'state') }, 'fixture.seed', dependencies, async (_locked, paths) => {
    if (installed) {
      const runtime = { command: process.execPath, args: [join(root, 'old-runtime.mjs'), 'old exact arguments'], fingerprint: 'sha256:' + '1'.repeat(64) }
      before.runtime.service = await installService(runtime, files, dependencies.runner, null, { platformName: 'darwin' })
    }
    await saveState(paths, before)
  })
  await writeFile(join(root, 'user.json'), '{"selected":"before","unrelated":"original"}')
  return await loadState(await readStatePaths(join(root, 'state')))
}
if (process.argv[2] === '--interrupt') {
  const root = process.argv[3]
  const operation = process.argv[4]
  const phase = process.argv[5]
  const { dependencies, files, runtime } = fixtureConfiguration(root, phase)
  await withLifecycleMutation({ root: join(root, 'state') }, 'fixture.' + operation, dependencies, async (_locked, paths) => {
    const previous = await loadState(paths)
    await writeEnvironmentJson(join(root, 'user.json'), { selected: 'after', unrelated: 'original' }, [['selected']])
    const service = operation === 'remove'
      ? await uninstallService(previous.runtime.service, dependencies.runner, { platformName: 'darwin' })
      : await installService(runtime, files, dependencies.runner, previous.runtime.service, { platformName: 'darwin' })
    if (phase === 'committed') await saveState(paths, { ...previous, runtime: { service: operation === 'remove' ? null : service }, updatedAt: '2026-09-06T01:00:00Z' })
    process.kill(process.pid, 'SIGKILL')
  })
}
if (process.argv[2] === '--interrupt-recovery') {
  const root = process.argv[3]
  const { dependencies } = fixtureConfiguration(root)
  await withLifecycleMutation({ root: join(root, 'state') }, 'fixture.recover', {
    ...dependencies, afterEnvironmentRecoveryStep: ({ remaining }) => { if (remaining === 1) process.kill(process.pid, 'SIGKILL') },
  }, async () => {})
}
