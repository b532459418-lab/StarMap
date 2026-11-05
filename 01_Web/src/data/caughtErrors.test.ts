/// <reference types="node" />
/**
 * The log and the browser tests' report of the errors an error boundary caught (robustness batch; ./caughtErrorLog.ts,
 * ./caughtErrorReport.ts): the boundary is named from React's `errorBoundary`, the report is one uncaught error whose
 * message starts with the prefix the page fixture and the CI marker check look for.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boundaryNameOf, logCaughtError } from './caughtErrorLog.ts'
import { caughtErrorReportOf, reportCaughtError } from './caughtErrorReport.ts'

test('the boundary is named by its name prop; another boundary, or none, is unknown', () => {
  assert.equal(boundaryNameOf({ errorBoundary: { props: { name: 'page:collection' } } }), 'page:collection')
  assert.equal(boundaryNameOf({ errorBoundary: { props: {} } }), 'unknown')
  assert.equal(boundaryNameOf({ errorBoundary: { props: { name: '' } } }), 'unknown')
  assert.equal(boundaryNameOf({ errorBoundary: null }), 'unknown')
  assert.equal(boundaryNameOf({}), 'unknown')
  assert.equal(boundaryNameOf(undefined), 'unknown')
})

test('a caught error is logged with its boundary and component stack', () => {
  const lines: unknown[][] = []
  const error = new Error('broken')
  logCaughtError(error, { errorBoundary: { props: { name: 'map:globe' } }, componentStack: '\n    at Globe' }, (...values) => { lines.push(values) })
  assert.equal(lines.length, 1)
  assert.equal(lines[0][0], error)
  assert.match(String(lines[0][1]), /caught by the error boundary "map:globe"\.\n {4}at Globe$/)
})

test('the report is one error naming the boundary and the original message', () => {
  assert.equal(caughtErrorReportOf('page:collection', new Error('Failed to fetch')).message, 'starmap:caught-error [page:collection] Failed to fetch')
  assert.equal(caughtErrorReportOf('map:no-webgl', 'not an Error').message, 'starmap:caught-error [map:no-webgl] not an Error')
  const reported: unknown[] = []
  reportCaughtError('dialog:want-to-go-add', new Error('x'), (error) => { reported.push(error) })
  assert.equal(reported.length, 1)
  assert.ok(reported[0] instanceof Error)
  assert.equal((reported[0] as Error).message, 'starmap:caught-error [dialog:want-to-go-add] x')
})
