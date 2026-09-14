import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const cliPath = fileURLToPath(new URL('../bin/agent-host.mjs', import.meta.url))

function routeKey(args) {
  if (args[0] === 'profiles' && args[1] === 'list') return 'profiles list'
  return args[0]
}

export function injectStateRoot(args, stateRoot) {
  if (args.includes('--state-root') || args.includes('--standalone')) return [...args]
  if (args[0] === '--help' || args[0] === '-h' || args.includes('--help') || args.includes('-h')) return [...args]
  if (routeKey(args) === 'profiles list') return [...args]
  return [...args, '--state-root', stateRoot]
}

export function isolatedCliEnv(home, extra = {}) {
  const env = { ...process.env }
  delete env.AGENT_HOST_STATE_ROOT
  Object.assign(env, extra)
  // Parent harnesses may set both; Node then warns on stderr and pollutes --json.
  delete env.NO_COLOR
  env.HOME = home
  env.USERPROFILE = home
  env.XDG_STATE_HOME = join(home, '.local', 'state')
  env.LOCALAPPDATA = join(home, 'AppData', 'Local')
  env.APPDATA = join(home, 'AppData', 'Roaming')
  return env
}

export async function createIsolatedCli(t, prefix = 'agent-host-cli-isolation-') {
  const home = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(home, { recursive: true, force: true }))
  return {
    home,
    stateRoot: join(home, 'agent-host-state'),
    unusedStateRoot: join(home, 'unused-agent-host-state'),
  }
}

export function isolatedCliInvocation(args, isolated, extraEnv = {}) {
  return {
    argv: injectStateRoot(args, isolated.stateRoot),
    env: isolatedCliEnv(isolated.home, extraEnv),
    cliPath,
  }
}

export function runIsolatedCli(args, isolated, options = {}) {
  const { env: extraEnv, ...spawnOptions } = options
  const invocation = isolatedCliInvocation(args, isolated, extraEnv)
  return spawnSync(process.execPath, [cliPath, ...invocation.argv], {
    encoding: 'utf8',
    env: invocation.env,
    ...spawnOptions,
  })
}
