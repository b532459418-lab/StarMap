/// <reference types="node" />
/** The client protocol of a new-library write: one request id per action, kept on the single retry of an unknown outcome. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LocalEditorError } from '../i18n/editorErrors.ts'
import { STORE_BASE_REVISION_HEADER, STORE_REQUEST_ID_HEADER, isUnconfirmedOutcome, sendStoreWrite, type StoreWriteHeaders } from './storeWriteProtocol.ts'
import { isUuidV7 } from './canonical/uuidv7.ts'

const error = (code: string) => new LocalEditorError({ code, error: code })

test('headers: a UUIDv7 request id and the base revision', async () => {
  const seen: StoreWriteHeaders[] = []
  const result = await sendStoreWrite(async (headers) => { seen.push(headers); return 'saved' }, { baseRevision: 7, onUnconfirmed: () => assert.fail() })
  assert.equal(result, 'saved')
  assert.equal(seen.length, 1)
  assert.ok(isUuidV7(seen[0][STORE_REQUEST_ID_HEADER]))
  assert.equal(seen[0][STORE_BASE_REVISION_HEADER], '7')
})

for (const [name, failure] of [
  ['E_OUTCOME_UNKNOWN', error('E_OUTCOME_UNKNOWN')],
  ['a broken connection', new TypeError('Failed to fetch')],
  ['an unreadable response', error('E_EDITOR_RESPONSE_INVALID')],
] as const) {
  test(`${name}: one retry with the same request id; a committed request answers with its receipt`, async () => {
    const seen: StoreWriteHeaders[] = []
    let unconfirmed = 0
    const result = await sendStoreWrite(async (headers) => {
      seen.push(headers)
      if (seen.length === 1) throw failure
      return 'original receipt'
    }, { baseRevision: 3, onUnconfirmed: () => { unconfirmed++ }, newRequestId: () => '01960000-0000-7000-8000-00000000d001' })
    assert.equal(result, 'original receipt')
    assert.equal(seen.length, 2)
    assert.equal(seen[1], seen[0])
    assert.equal(unconfirmed, 0)
  })
}

test('still unknown after the retry: the whole page must reload, and E_OUTCOME_UNKNOWN is thrown', async () => {
  let attempts = 0, unconfirmed = 0
  await assert.rejects(
    sendStoreWrite(async () => { attempts++; throw attempts === 1 ? new TypeError('Failed to fetch') : error('E_OUTCOME_UNKNOWN') }, { baseRevision: 0, onUnconfirmed: () => { unconfirmed++ } }),
    (thrown) => thrown instanceof LocalEditorError && thrown.code === 'E_OUTCOME_UNKNOWN',
  )
  assert.equal(attempts, 2)
  assert.equal(unconfirmed, 1)
})

test('confirmed failures are not retried and do not block the page', async () => {
  for (const code of ['E_STALE', 'E_OPERATION_CONFLICT', 'E_LIBRARY_BUSY', 'E_STORE_BUSY', 'E_WTG_NOT_FOUND', 'E_STORE_MODE_LIMITED', 'E_EDITOR_RELOAD_REQUIRED']) {
    let attempts = 0
    await assert.rejects(
      sendStoreWrite(async () => { attempts++; throw error(code) }, { baseRevision: 1, onUnconfirmed: () => assert.fail(code) }),
      (thrown) => thrown instanceof LocalEditorError && thrown.code === code,
    )
    assert.equal(attempts, 1, code)
    assert.equal(isUnconfirmedOutcome(error(code)), false, code)
  }
  // A failed second attempt that is confirmed (the first one was unknown) is reported as it is.
  let attempts = 0
  await assert.rejects(
    sendStoreWrite(async () => { attempts++; throw attempts === 1 ? error('E_OUTCOME_UNKNOWN') : error('E_STALE') }, { baseRevision: 1, onUnconfirmed: () => assert.fail() }),
    (thrown) => thrown instanceof LocalEditorError && thrown.code === 'E_STALE',
  )
  const abort = new DOMException('aborted', 'AbortError')
  assert.equal(isUnconfirmedOutcome(abort), false)
})
