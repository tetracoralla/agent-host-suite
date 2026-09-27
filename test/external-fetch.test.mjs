import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { fetchExternal } from '../src/external-fetch.mjs'

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}

async function close(server) {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}

test('external fetch uses the configured proxy while loopback stays direct', async () => {
  const original = Object.fromEntries(
    ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'no_proxy', 'NO_PROXY']
      .map((key) => [key, process.env[key]]),
  )
  let proxyCalls = 0
  const proxy = createServer((request, response) => {
    proxyCalls += 1
    response.end('proxied')
  })
  proxy.on('connect', (_request, socket) => {
    proxyCalls += 1
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\nproxied'))
  })
  const local = createServer((_request, response) => response.end('local'))
  try {
    const proxyPort = await listen(proxy)
    const localPort = await listen(local)
    process.env.http_proxy = `http://127.0.0.1:${proxyPort}`
    process.env.https_proxy = process.env.http_proxy
    process.env.no_proxy = ''
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'NO_PROXY']) delete process.env[key]

    const remote = await fetchExternal('http://example.invalid/through-proxy', { signal: AbortSignal.timeout(5_000) })
    assert.equal(remote.status, 200)
    assert.equal(await remote.text(), 'proxied')
    const nearby = await fetchExternal(`http://127.0.0.1:${localPort}/direct`, { signal: AbortSignal.timeout(5_000) })
    assert.equal(nearby.status, 200)
    assert.equal(await nearby.text(), 'local')
    assert.equal(proxyCalls, 1)
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (proxy.listening) await close(proxy)
    if (local.listening) await close(local)
  }
})
