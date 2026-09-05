import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir, platform, tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentHostError } from './errors.mjs'
import { writePrivateJson } from './json.mjs'
import { runFile } from './process.mjs'

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))]
}

async function usable(path, mode) {
  try {
    await access(path, mode)
    return true
  } catch {
    return false
  }
}

function macApplicationRoots(suiteRoot, homeRoot) {
  return unique([
    resolve(suiteRoot, '..', '..'),
    '/Applications/Agent Host.app/Contents',
    join(homeRoot, 'Applications', 'Agent Host.app', 'Contents'),
  ])
}

function windowsApplicationRoots(suiteRoot, localAppData, searchPath) {
  const roots = [resolve(suiteRoot, '..')]
  if (typeof localAppData === 'string' && localAppData.length > 0) {
    roots.push(join(localAppData, 'Programs', 'openAdam', 'Agent Host'))
  }
  for (const entry of String(searchPath ?? '').split(delimiter).filter(Boolean)) {
    roots.push(resolve(entry, '..'))
  }
  return unique(roots)
}

export async function resolveApplicationCarrier(options = {}) {
  const platformName = options.platformName ?? platform()
  const suiteRoot = options.suiteRoot ?? fileURLToPath(new URL('../', import.meta.url))
  if (platformName === 'darwin') {
    for (const contentsRoot of options.applicationRoots ?? macApplicationRoots(suiteRoot, options.homeRoot ?? homedir())) {
      const executable = join(contentsRoot, 'MacOS', 'agent-host')
      if (await usable(executable, constants.X_OK)) {
        return { kind: 'macos-application', root: dirname(contentsRoot), executable, prefixArguments: [] }
      }
    }
    return null
  }
  if (platformName === 'win32') {
    for (const root of options.applicationRoots ?? windowsApplicationRoots(
      suiteRoot,
      options.localAppData ?? process.env.LOCALAPPDATA,
      options.searchPath ?? process.env.PATH,
    )) {
      const executable = join(root, 'runtime', 'node.exe')
      const cli = join(root, 'app', 'bin', 'agent-host.mjs')
      if (await usable(executable, constants.X_OK) && await usable(cli, constants.R_OK)) {
        return { kind: 'windows-application', root, executable, prefixArguments: [cli] }
      }
    }
    return null
  }
  return null
}

export async function requireApplicationCarrier(options = {}) {
  const carrier = options.carrier ?? await (options.resolver ?? resolveApplicationCarrier)(options)
  if (carrier === null) {
    throw new AgentHostError(
      'APPLICATION_CARRIER_UNAVAILABLE',
      'The installed Agent Host application is unavailable; maintenance cannot be bound to a temporary or source checkout command.',
    )
  }
  return carrier
}

function boundedFailure(result) {
  return [result.stderr, result.stdout]
    .filter((value) => typeof value === 'string' && value.trim() !== '')
    .join('\n')
    .trim()
    .slice(0, 2048)
}

export async function preflightApplicationState(state, options = {}) {
  const carrier = options.carrier ?? await (options.resolver ?? resolveApplicationCarrier)(options)
  if (carrier === null) return { status: 'not-installed', checked: false }
  const root = await mkdtemp(join(options.temporaryRoot ?? tmpdir(), 'agent-host-app-state-preflight-'))
  try {
    await mkdir(root, { recursive: true, mode: 0o700 })
    await writePrivateJson(join(root, 'state.json'), state)
    const runner = options.runner ?? runFile
    const result = await runner(carrier.executable, [
      ...(carrier.prefixArguments ?? []),
      'status', '--state-root', root, '--json',
    ], {
      allowFailure: true,
      timeoutMs: options.timeoutMs ?? 15_000,
      env: { ...process.env, AGENT_HOST_BOOTSTRAP_ROOT: join(root, 'bootstrap') },
      maxBuffer: 1024 * 1024,
    })
    if (result.status !== 0 || result.timedOut === true || result.overflowed === true) {
      const output = boundedFailure(result)
      throw new AgentHostError(
        'APPLICATION_STATE_INCOMPATIBLE',
        'The installed Agent Host application cannot read the proposed environment state; update the application before changing tools.',
        {
          carrier: carrier.kind,
          ...(output === '' ? {} : { output }),
        },
      )
    }
    return { status: 'compatible', checked: true, carrier: carrier.kind }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
