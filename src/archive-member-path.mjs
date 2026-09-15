export function archiveListingLines(stdout) {
  return String(stdout ?? '').split(/\r?\n/u).filter((line) => line.length > 0)
}

export function posixArchiveMemberPath(value) {
  let text = String(value)
  if (text.endsWith('\r')) text = text.slice(0, -1)
  return text.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '')
}

export function isAbsoluteArchiveMemberPath(value) {
  return value.startsWith('/')
    || value.startsWith('\\')
    || value.startsWith('//')
    || /^[A-Za-z]:/u.test(value)
}

export function isSafeArchiveMemberPath(value, { expectedRoot, allowEmpty = false } = {}) {
  if (typeof value !== 'string') return false
  const line = value.endsWith('\r') ? value.slice(0, -1) : value
  if (line.length === 0) return allowEmpty === true
  if (/[\u0000-\u001f\u007f]/u.test(line)) return false
  if (isAbsoluteArchiveMemberPath(line)) return false
  const normalized = posixArchiveMemberPath(line)
  if (normalized === '') return allowEmpty === true
  if (normalized === '.' || normalized === '..') return false
  const parts = normalized.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..' || /^[A-Za-z]:$/u.test(part))) {
    return false
  }
  if (typeof expectedRoot !== 'string') return true
  return normalized === expectedRoot || normalized.startsWith(`${expectedRoot}/`)
}
