// Metadata-only wire boundary; parity is verified against the Runtime validator.

export const EXECUTION_OUTCOME_META_KEY = 'io.openadam.executionOutcome.v1'
const STATUS = new Set(['completed', 'partial', 'error', 'cancelled', 'unknown'])
const ITEM_KEYS = ['total', 'completed', 'errors', 'cancelled', 'unknown']

function exactObject(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key))
}

export function validExecutionOutcome(value) {
  if (!exactObject(value, ['status', 'items', 'errorCodes']) || !STATUS.has(value.status)) return false
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 16_384 || !Array.isArray(value.errorCodes) || value.errorCodes.length > 64) return false
  const codes = new Set()
  for (const item of value.errorCodes) {
    if (!exactObject(item, ['code', 'count']) || typeof item.code !== 'string'
      || !/^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/.test(item.code)
      || codes.has(item.code) || !Number.isSafeInteger(item.count) || item.count < 1 || item.count > 100_000) return false
    codes.add(item.code)
  }
  if (value.items !== null) {
    if (!exactObject(value.items, ITEM_KEYS)
      || !ITEM_KEYS.every((key) => Number.isSafeInteger(value.items[key]) && value.items[key] >= 0 && value.items[key] <= 100_000)) return false
    const { total, completed, errors, cancelled, unknown } = value.items
    if (total !== completed + errors + cancelled + unknown) return false
    if (value.status === 'completed' && (errors + cancelled + unknown > 0 || value.errorCodes.length > 0)) return false
    if (value.errorCodes.reduce((sum, item) => sum + item.count, 0) > errors + cancelled + unknown) return false
  } else if (value.status === 'completed' && value.errorCodes.length > 0) return false
  return true
}
