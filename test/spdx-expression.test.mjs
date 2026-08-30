import assert from 'node:assert/strict'
import test from 'node:test'
import { isSpdxExpressionSyntax } from '../src/spdx-expression.mjs'

test('private component SPDX syntax accepts composed expressions and rejects ambiguous labels', () => {
  for (const value of [
    'Apache-2.0',
    'MIT OR Apache-2.0',
    '(MIT OR Apache-2.0) AND LicenseRef-Private',
    'GPL-2.0-only WITH Classpath-exception-2.0',
    'DocumentRef-vendor:LicenseRef-Proprietary',
  ]) assert.equal(isSpdxExpressionSyntax(value), true, value)

  for (const value of [
    '',
    '   ',
    ' MIT',
    'MIT ',
    'MIT and Apache-2.0',
    'MIT OR',
    '(MIT OR Apache-2.0',
    'MIT\nOR Apache-2.0',
    'MIT / Apache-2.0',
  ]) assert.equal(isSpdxExpressionSyntax(value), false, JSON.stringify(value))
})
