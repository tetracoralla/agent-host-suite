import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withLifecycleMutation } from '../../src/lifecycle-lock.mjs'
import { writeEnvironmentCodex } from '../../src/hosts/codex-config-resource.mjs'
import { withCodexConfiguration } from '../../src/hosts/codex-config.mjs'
import { writeEnvironmentJson } from '../../src/environment-resources.mjs'
import { saveState, STATE_SCHEMA } from '../../src/state.mjs'

const server = fileURLToPath(new URL('./codex-config-server.mjs', import.meta.url))
export function recoveryDependencies(native = false) {
  const env = { ...process.env }
  for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'AZURE_OPENAI_API_KEY']) delete env[name]
  return {
    recoverEnvironmentChange: true,
    ...(native ? {} : { runner: async () => ({ status: 0, stdout: process.execPath + '\n', stderr: '' }) }),
    codexConfiguration: (executable, options, callback) => withCodexConfiguration(executable, {
      ...options, env, ...(native ? {} : { prefixArguments: [server, 'normal'] }),
    }, callback),
  }
}

if (process.argv[2] === '--interrupt') {
  const root = process.argv[3]
  const phase = process.argv[4]
  const native = process.argv[5] === 'native'
  const dependencies = recoveryDependencies(native)
  if (phase === 'prepared') dependencies.afterEnvironmentChangePrepared = () => process.kill(process.pid, 'SIGKILL')
  await withLifecycleMutation({ root: join(root, 'state') }, 'fixture.codex-transition', dependencies, async (_locked, paths) => {
    await dependencies.codexConfiguration(native ? 'codex' : process.execPath, { configRoot: join(root, 'codex') }, async (client) => {
      const before = await client.read()
      await writeEnvironmentCodex(client, before, [{ keys: ['plugins', 'fixture@local'], value: { ...before.config.plugins['fixture@local'], enabled: false } }])
    })
    await writeEnvironmentJson(join(root, 'second.json'), { value: 'after' }, [['value']])
    if (phase === 'committed') await saveState(paths, {
      schemaVersion: STATE_SCHEMA, suiteVersion: '0.1.6', channel: 'development', profile: 'standard',
      installedAt: '2026-09-06T00:00:00Z', updatedAt: '2026-09-06T00:00:00Z',
      components: {}, hosts: {}, runtime: {}, observability: { enabled: false },
    })
    process.kill(process.pid, 'SIGKILL')
  })
}

if (process.argv[2] === '--interrupt-recovery') {
  await withLifecycleMutation({ root: join(process.argv[3], 'state') }, 'fixture.codex-recovery', {
    ...recoveryDependencies(process.argv[5] === 'native'),
    afterEnvironmentRecoveryStep: ({ remaining }) => { if (remaining === 0) process.kill(process.pid, 'SIGKILL') },
  }, async () => {})
}
