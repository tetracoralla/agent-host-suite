const token = document.querySelector('meta[name="procedure-studio-token"]')?.content ?? ''

export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'X-Procedure-Studio-Token': token,
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers ?? {}),
    },
  })
  const value = await response.json().catch(() => ({ error: { code: 'STUDIO_BAD_RESPONSE', message: 'Studio returned an unreadable response' } }))
  if (!response.ok) {
    const error = new Error(value.error?.message ?? `Studio request failed (${response.status})`)
    error.code = value.error?.code ?? 'STUDIO_REQUEST_FAILED'
    error.details = value.error?.details
    throw error
  }
  return value
}

export function json(method, value) {
  return { method, body: JSON.stringify(value) }
}
