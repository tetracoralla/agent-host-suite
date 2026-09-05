import test from 'node:test'
import assert from 'node:assert/strict'
import { createValidator, loadBundledSchema } from '../src/schema.mjs'

function compile(ajv, schema) {
  return ajv.compile(schema)
}

test('uint32 format enforces the unsigned 32-bit integer range', () => {
  const validate = compile(createValidator(), {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: { axis: { type: 'integer', format: 'uint32' } },
    required: ['axis'],
  })
  assert.equal(validate({ axis: 0 }), true)
  assert.equal(validate({ axis: 4096 }), true)
  assert.equal(validate({ axis: 4294967295 }), true)
  assert.equal(validate({ axis: -1 }), false)
  assert.equal(validate({ axis: 4294967296 }), false)
  assert.equal(validate({ axis: 1.5 }), false)
})

test('uint64 format enforces the unsigned 64-bit integer range', () => {
  const validate = compile(createValidator(), {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: { pixels: { type: 'integer', format: 'uint64' } },
    required: ['pixels'],
  })
  assert.equal(validate({ pixels: 0 }), true)
  assert.equal(validate({ pixels: 67108864 }), true)
  assert.equal(validate({ pixels: -1 }), false)
  assert.equal(validate({ pixels: 18446744073709551615 }), false)
})

test('direct-eval denied roots accept cross-platform absolute roots only', async () => {
  const schema = await loadBundledSchema('evals-direct-driver-request.schema.json')
  const validate = compile(createValidator(), schema.properties.isolation)
  for (const root of ['/private/source', 'C:\\Users\\fixture\\source', '\\\\server\\share\\source']) {
    assert.equal(validate({ mode: 'deny-read-roots', deniedReadRoots: [root] }), true, `${root}: ${JSON.stringify(validate.errors)}`)
  }
  for (const root of ['relative/source', 'C:relative', '\\single-root', '\\\\server']) {
    assert.equal(validate({ mode: 'deny-read-roots', deniedReadRoots: [root] }), false, root)
  }
})
