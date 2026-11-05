/// <reference types="node" />
/**
 * The error boundaries' state and the code-load marking (robustness batch; ./errorBoundaryState.ts, ./codeLoad.ts).
 * Their rendering is covered by the browser cases (critical-flows.spec.mjs, "Error boundaries").
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { caughtErrorState, initialErrorBoundaryState, resetErrorState } from './errorBoundaryState.ts'
import { CodeLoadError, codeOf } from './codeLoad.ts'

test('a boundary catches any thrown value, and a reset clears it and mounts the children again', () => {
  assert.deepEqual(initialErrorBoundaryState, { caught: false, error: undefined, attempt: 0 })
  const error = new Error('broken')
  const caught = { ...initialErrorBoundaryState, ...caughtErrorState(error) }
  assert.equal(caught.caught, true)
  assert.equal(caught.error, error)
  assert.equal(caught.attempt, 0, 'catching does not remount')
  // undefined and null are thrown values too.
  assert.equal(caughtErrorState(undefined).caught, true)
  assert.equal(caughtErrorState(null).caught, true)
  const reset = resetErrorState(caught)
  assert.deepEqual(reset, { caught: false, error: undefined, attempt: 1 })
  assert.equal(resetErrorState(reset).attempt, 2, 'each retry is a new mount')
})

test('a failed load becomes a CodeLoadError with the same message and the cause; a loaded module passes through', async () => {
  const module = { Page: () => null }
  assert.equal(await codeOf(Promise.resolve(module)), module)
  const failure = new TypeError('Failed to fetch dynamically imported module: http://127.0.0.1:5173/src/components/CollectionPage.tsx')
  const rejection = await codeOf(Promise.reject(failure)).then(() => undefined, (error: unknown) => error)
  assert.ok(rejection instanceof CodeLoadError)
  assert.ok(rejection instanceof Error)
  assert.equal(rejection.name, 'CodeLoadError')
  assert.equal(rejection.message, failure.message)
  assert.equal(rejection.cause, failure)
  const odd = await codeOf(Promise.reject('offline')).then(() => undefined, (error: unknown) => error)
  assert.ok(odd instanceof CodeLoadError)
  assert.equal(odd.message, 'offline')
})
