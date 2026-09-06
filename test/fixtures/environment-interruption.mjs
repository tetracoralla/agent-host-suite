import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { setup } from '../../src/setup.mjs'
import { archiveAndRemoveState, saveState } from '../../src/state.mjs'
import { uninstallInstallation } from '../../src/lifecycle.mjs'
import { withLifecycleMutation } from '../../src/lifecycle-lock.mjs'
import { compatibleApplicationState, healthyCatalogPreflight } from '../helpers.mjs'

function interruptAtBoundary() {
  writeFileSync(join(process.argv[3], 'interruption.json'), JSON.stringify({ action: process.argv[2], phase: process.argv[4], host: process.argv[5] }), { mode: 0o600 })
  process.kill(process.pid, 'SIGKILL')
}

export const runner = async (_command, args) => {
  if (args[0] === 'version') return { status: 0, stdout: '{"version":"fixture"}', stderr: '' }
  if (_command === 'where.exe' || (_command === '/usr/bin/env' && args[0] === 'which')) return { status: 0, stdout: process.execPath + '\n', stderr: '' }
  if (args.at(-1) === '--version') return { status: 0, stdout: '2.1.233\n', stderr: '' }
  throw new Error(`Unexpected external command: ${args[0]}`)
}

export function configuration(root, host = 'zcode') {
  return {
    options: { profile: 'standard', hosts: [host], developmentRoot: join(root, 'source'),
      stateRoot: join(root, 'state'), noService: true, dryRun: false, replaceHostConflicts: true, enableObservability: false },
    dependencies: { runner, applicationStatePreflight: compatibleApplicationState, catalogPreflight: healthyCatalogPreflight, hostSkillHome: join(root, 'home'),
      zcodeConfigPath: join(root, 'home', 'config.json'), zcodeExecutable: process.execPath,
      claudeConfigPath: join(root, 'home', 'claude-config.json'),
      socketDirectory: join(root, 'socket') },
  }
}

if (process.argv[2] === '--interrupt') {
  const { options, dependencies } = configuration(process.argv[3], process.argv[5])
  await setup(options, { ...dependencies, saveState: async (...args) => {
    if (process.argv[4] === 'after-commit') await saveState(...args)
    interruptAtBoundary()
  } })
}

if (process.argv[2] === '--interrupt-prepared') {
  const { options, dependencies } = configuration(process.argv[3], process.argv[5])
  await setup(options, { ...dependencies, afterEnvironmentChangePrepared: interruptAtBoundary })
}

if (process.argv[2] === '--interrupt-recovery') {
  await withLifecycleMutation({ root: join(process.argv[3], 'state') }, 'test.recover', {
    recoverEnvironmentChange: true,
    afterEnvironmentRecoveryStep: interruptAtBoundary,
  }, async () => {})
}

if (process.argv[2] === '--interrupt-uninstall') {
  const { options, dependencies } = configuration(process.argv[3], process.argv[5])
  await uninstallInstallation({ stateRoot: options.stateRoot, keepData: true }, {
    ...dependencies,
    archiveAndRemoveState: async (...args) => {
      if (process.argv[4] === 'after-commit') await archiveAndRemoveState(...args)
      interruptAtBoundary()
    },
  })
}
