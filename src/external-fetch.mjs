import { EnvHttpProxyAgent } from 'undici'

let proxyKey = null
let proxyDispatcher = null

function environmentProxy() {
  const fallback = process.env.all_proxy ?? process.env.ALL_PROXY
  const httpProxy = process.env.http_proxy ?? process.env.HTTP_PROXY ?? fallback
  const httpsProxy = process.env.https_proxy ?? process.env.HTTPS_PROXY ?? httpProxy
  if (!httpProxy && !httpsProxy) return null
  const noProxy = process.env.no_proxy ?? process.env.NO_PROXY ?? ''
  return { httpProxy, httpsProxy, noProxy: [noProxy, 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',') }
}

export function fetchExternal(url, options = {}) {
  const proxy = environmentProxy()
  if (proxy === null) return globalThis.fetch(url, options)
  const key = JSON.stringify(proxy)
  if (proxyKey !== key) {
    proxyDispatcher = new EnvHttpProxyAgent(proxy)
    proxyKey = key
  }
  return globalThis.fetch(url, { ...options, dispatcher: proxyDispatcher })
}
