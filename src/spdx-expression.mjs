const ATOM = /^[A-Za-z0-9][A-Za-z0-9.+:-]*$/u

function tokens(value) {
  const output = []
  let index = 0
  while (index < value.length) {
    const character = value[index]
    if (character === ' ' || character === '\t') {
      index += 1
      continue
    }
    if (character === '(' || character === ')') {
      output.push(character)
      index += 1
      continue
    }
    const match = value.slice(index).match(/^[A-Za-z0-9][A-Za-z0-9.+:-]*/u)
    if (match === null) return null
    output.push(match[0])
    index += match[0].length
  }
  return output
}

export function isSpdxExpressionSyntax(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || value.trim() !== value) return false
  const input = tokens(value)
  if (input === null || input.length === 0) return false
  let position = 0

  function atom() {
    const value = input[position]
    if (value === undefined || ['AND', 'OR', 'WITH', '(', ')'].includes(value) || !ATOM.test(value)) return false
    position += 1
    return true
  }

  function primary() {
    if (input[position] !== '(') return atom()
    position += 1
    if (!expression() || input[position] !== ')') return false
    position += 1
    return true
  }

  function withExpression() {
    if (!primary()) return false
    if (input[position] === 'WITH') {
      position += 1
      if (!atom()) return false
    }
    return true
  }

  function andExpression() {
    if (!withExpression()) return false
    while (input[position] === 'AND') {
      position += 1
      if (!withExpression()) return false
    }
    return true
  }

  function expression() {
    if (!andExpression()) return false
    while (input[position] === 'OR') {
      position += 1
      if (!andExpression()) return false
    }
    return true
  }

  return expression() && position === input.length
}
