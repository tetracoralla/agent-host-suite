export function parseStrictJson(source, label = 'JSON') {
  assertNoDuplicateObjectKeys(source, label)
  const value = JSON.parse(source)
  assertJsonValue(value, label)
  return value
}

function assertJsonValue(value, label) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label}: JSON number must be finite`)
    return
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new Error(`${label}: sparse arrays are not permitted`)
      assertJsonValue(value[index], label)
    }
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) assertJsonValue(item, label)
    return
  }
  throw new Error(`${label}: unsupported JSON value ${typeof value}`)
}

function assertNoDuplicateObjectKeys(source, label) {
  let offset = 0

  function skipWhitespace() {
    while (/\s/u.test(source[offset] ?? '')) offset += 1
  }

  function parseString() {
    const start = offset
    offset += 1
    while (offset < source.length) {
      if (source[offset] === '\\') {
        offset += 2
      } else if (source[offset] === '"') {
        offset += 1
        return JSON.parse(source.slice(start, offset))
      } else {
        offset += 1
      }
    }
    throw new Error(`${label}: unterminated JSON string`)
  }

  function parseValue() {
    skipWhitespace()
    if (source[offset] === '{') return parseObject()
    if (source[offset] === '[') return parseArray()
    if (source[offset] === '"') {
      parseString()
      return
    }
    while (offset < source.length && !/[\s,\]}]/u.test(source[offset])) offset += 1
  }

  function parseObject() {
    const keys = new Set()
    offset += 1
    skipWhitespace()
    if (source[offset] === '}') {
      offset += 1
      return
    }
    while (offset < source.length) {
      skipWhitespace()
      if (source[offset] !== '"') return
      const key = parseString()
      if (keys.has(key)) throw new Error(`${label}: duplicate JSON object key ${key}`)
      keys.add(key)
      skipWhitespace()
      if (source[offset] !== ':') return
      offset += 1
      parseValue()
      skipWhitespace()
      if (source[offset] === '}') {
        offset += 1
        return
      }
      if (source[offset] !== ',') return
      offset += 1
    }
  }

  function parseArray() {
    offset += 1
    skipWhitespace()
    if (source[offset] === ']') {
      offset += 1
      return
    }
    while (offset < source.length) {
      parseValue()
      skipWhitespace()
      if (source[offset] === ']') {
        offset += 1
        return
      }
      if (source[offset] !== ',') return
      offset += 1
    }
  }

  parseValue()
}

export function assertExactKeys(value, expected, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} fields must be exactly ${wanted.join(', ')}`)
  }
}
