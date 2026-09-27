import { createHash, randomUUID } from 'node:crypto'

export class ProcedureError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.code = code
    this.details = details
  }
}
export function assert(condition, code, message, details) {
  if (!condition) throw new ProcedureError(code, message, details)
}
export const id = () => randomUUID()
export const hash = (value) =>
  createHash('sha256')
    .update(
      typeof value === 'string' || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(value),
    )
    .digest('hex')
export const clone = (value) => structuredClone(value)
export const now = () => new Date().toISOString()
export const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
export function text(value, label, max = 16000) {
  assert(
    typeof value === 'string' &&
      value.trim().length > 0 &&
      value.length <= max &&
      !value.includes('\0'),
    'INVALID_INPUT',
    `${label} must contain 1–${max} characters`,
  )
  return value
}
export function integer(value, label, min, max) {
  assert(
    Number.isSafeInteger(value) && value >= min && value <= max,
    'INVALID_INPUT',
    `${label} must be ${min}–${max}`,
  )
  return value
}
export function errorValue(error) {
  return {
    code: error.code ?? 'INTERNAL_ERROR',
    message: String(error.message ?? error).slice(0, 4000),
    details: error.details ?? {},
  }
}
