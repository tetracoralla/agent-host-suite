#!/usr/bin/env node
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { serve } from '../src/server.mjs'
import { probeProviders } from '../src/adapters.mjs'

const args = process.argv.slice(2)
const option = (key, fallback) => {
  const index = args.indexOf(key)
  return index < 0 ? fallback : args[index + 1]
}
try {
  if (args[0] === 'probe')
    console.log(
      JSON.stringify(
        await probeProviders(resolve(option('--workspace', process.cwd()))),
        null,
        2,
      ),
    )
  else if (args[0] === 'serve') {
    const running = await serve({
      root: resolve(
        option('--state-root', `${homedir()}/.agent-host/procedures`),
      ),
      port: Number(option('--port', '0')),
    })
    console.log(
      JSON.stringify({
        origin: running.origin,
        token: running.token,
        stateRoot: running.coordinator.store.root,
        procedures: running.coordinator.procedureList().length,
        message:
          'Private local Procedure API. No Procedure products are available unless the embedding Host supplies its installed registry. Keep the Bearer token private.',
      }),
    )
    let closing = false
    for (const signal of ['SIGINT', 'SIGTERM'])
      process.on(signal, () => {
        if (closing) return
        closing = true
        void running.close().then(
          () => process.exit(0),
          (e) => {
            console.error(e.message)
            process.exit(1)
          },
        )
      })
  } else
    console.log(
      'agent-procedure serve [--state-root PATH] [--port PORT]\nagent-procedure probe [--workspace PATH]\nStart the headless private Procedure API, or probe protocol availability without model calls. See README.md for the authenticated /api contract.',
    )
} catch (error) {
  console.error(
    JSON.stringify({
      error: {
        code: error.code ?? 'FAILED',
        message: error.message,
        details: error.details,
      },
    }),
  )
  process.exitCode = 1
}
