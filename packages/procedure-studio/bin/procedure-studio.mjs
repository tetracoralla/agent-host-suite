#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { StudioProject } from '../src/project.mjs'
import { serveStudio } from '../src/server.mjs'

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exitCode = 64
}

function usage() {
  process.stdout.write(`Procedure Studio\n\nUsage:\n  procedure-studio serve --project PATH [--state-root PATH] [--port NUMBER] [--no-open]\n`)
}

function options(argv) {
  const result = { command: argv[0], open: true, port: 0 }
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--no-open') result.open = false
    else if (value === '--project' || value === '--state-root' || value === '--port') {
      const next = argv[++index]
      if (next === undefined) throw new Error(`${value} requires a value`)
      if (value === '--project') result.project = resolve(next)
      else if (value === '--state-root') result.stateRoot = resolve(next)
      else result.port = Number(next)
    } else throw new Error(`Unknown argument: ${value}`)
  }
  if (result.command !== 'serve') throw new Error('Expected the serve command')
  if (!result.project) throw new Error('--project is required')
  if (!Number.isSafeInteger(result.port) || result.port < 0 || result.port > 65535) throw new Error('--port must be an integer from 0 to 65535')
  result.stateRoot ??= resolve(homedir(), '.agent-host', 'procedure-studio')
  return result
}

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd.exe' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  child.unref()
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  usage()
} else {
  let selected
  try {
    selected = options(process.argv.slice(2))
  } catch (error) {
    fail(error.message)
  }
  if (selected) {
    try {
      const project = await StudioProject.open(selected.project, selected.stateRoot)
      const studio = await serveStudio({ project, stateRoot: selected.stateRoot, port: selected.port })
      process.stdout.write(`${JSON.stringify({ schemaVersion: 'openadam.procedure-studio-server.v0.1', status: 'ready', url: studio.url, project: selected.project, stateRoot: selected.stateRoot })}\n`)
      if (selected.open) openBrowser(studio.url)
      let closing = false
      const close = async () => {
        if (closing) return
        closing = true
        await studio.close()
      }
      process.once('SIGINT', () => void close().finally(() => process.exit(0)))
      process.once('SIGTERM', () => void close().finally(() => process.exit(0)))
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ error: { code: error.code ?? 'STUDIO_FAILED', message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } })}\n`)
      process.exitCode = 1
    }
  }
}
