/// <reference types="node" />
/**
 * The client wrappers of the eight editor writes (3C-4a spec §2.4): in V2 mode the requests are exactly as before; in
 * the new-library mode each one carries the request id and base revision, retries an unknown outcome once with the same
 * request id, and a committed answer moves the page's base revision (two writes of one action are not stale).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addLocalCountry, addLocalTravelRecord, addLocalWantToGo, convertLocalWantToGoToTravel, deleteHiddenLocalCountries,
  deleteHiddenLocalWantToGo, setStoreBaseRevision, updateLocalEditorState, updateLocalWantToGo,
} from './localEditorApi.ts'
import { STORE_BASE_REVISION_HEADER, STORE_REQUEST_ID_HEADER } from './storeWriteProtocol.ts'
import { isUuidV7 } from './canonical/uuidv7.ts'
import type { TravelAtlasEditorState } from './editorState.ts'

type Sent = { url: string; method: string; headers: Record<string, string>; body: unknown }
const state = { countryOrder: [], hiddenCountryIds: [] } as unknown as TravelAtlasEditorState
const item = { id: 'wish-1', place: { nameEn: 'Synthetic' } }

/** Answers by path; `revision` is what a store write answers (undefined in V2 mode). */
function fakeServer(revision?: () => number, failFirst?: string) {
  const sent: Sent[] = []
  let failed = false
  const fetch = async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (!init?.method) return new Response(JSON.stringify({ ok: true, state }), { status: 200 })
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>))
    sent.push({ url, method: init.method, headers, body: JSON.parse(String(init.body)) })
    if (failFirst && !failed) { failed = true; return new Response(JSON.stringify({ ok: false, code: failFirst, error: failFirst }), { status: 500 }) }
    const store = revision ? { revision: revision(), duplicate: false, receipt: { requestId: headers[STORE_REQUEST_ID_HEADER] } } : {}
    const result = url.endsWith('/wanttogo') ? { id: 'wish-1', item } : url.endsWith('/state') ? { state } : {}
    return new Response(JSON.stringify({ ok: true, ...result, ...store }), { status: 200 })
  }
  return { sent, fetch }
}

const writes = [
  ['countries', () => addLocalCountry('JP', '2026-04-01')],
  ['records', () => addLocalTravelRecord({ placeId: 'city-1', start_date: '2026-04-01' })],
  ['countries/delete', () => deleteHiddenLocalCountries(['country-1'])],
  ['wanttogo', () => addLocalWantToGo({ placeId: 'city-1' })],
  ['wanttogo/update', () => updateLocalWantToGo('wish-1', { note: 'Synthetic' })],
  ['wanttogo/delete', () => deleteHiddenLocalWantToGo(['wish-1'])],
  ['wanttogo/convert', () => convertLocalWantToGoToTravel({ source: 'want-to-go', id: 'wish-1', startDate: '2026-04-01' })],
  ['state', () => updateLocalEditorState((current) => ({ ...current, hiddenCountryIds: ['country-1'] }))],
] as const

async function withFetch(fetch: typeof globalThis.fetch, run: () => Promise<void>) {
  const original = globalThis.fetch
  globalThis.fetch = fetch
  try { await run() } finally { globalThis.fetch = original; setStoreBaseRevision(undefined) }
}

test('V2 mode: the eight writes send the editor headers only', async () => {
  const server = fakeServer()
  await withFetch(server.fetch as typeof globalThis.fetch, async () => {
    setStoreBaseRevision(undefined)
    for (const [, run] of writes) await run()
  })
  assert.deepEqual(server.sent.map((request) => request.url.replace('/__travelatlas/editor/', '')), writes.map(([path]) => path))
  for (const request of server.sent) assert.deepEqual(request.headers, { 'content-type': 'application/json', 'x-travelatlas-local-editor': '1' })
  assert.equal(server.sent.find((request) => request.url.endsWith('/state'))!.method, 'PUT')
})

test('new-library mode: every write carries a request id and the base revision; a committed answer moves the base', async () => {
  let revision = 4
  const server = fakeServer(() => ++revision)
  await withFetch(server.fetch as typeof globalThis.fetch, async () => {
    setStoreBaseRevision(4)
    for (const [, run] of writes) await run()
  })
  assert.equal(server.sent.length, writes.length)
  server.sent.forEach((request, index) => {
    assert.ok(isUuidV7(request.headers[STORE_REQUEST_ID_HEADER]), request.url)
    assert.equal(request.headers[STORE_BASE_REVISION_HEADER], String(4 + index), `${request.url}: the revision the previous write answered`)
    assert.equal(request.headers['x-travelatlas-local-editor'], '1')
  })
  assert.equal(new Set(server.sent.map((request) => request.headers[STORE_REQUEST_ID_HEADER])).size, writes.length, 'one id per action')
})

test('new-library mode: an unknown outcome is sent again with the same request id and the same body', async () => {
  for (const [path, run] of writes) {
    const server = fakeServer(() => 2, 'E_OUTCOME_UNKNOWN')
    await withFetch(server.fetch as typeof globalThis.fetch, async () => {
      setStoreBaseRevision(1)
      await run()
    })
    assert.equal(server.sent.length, 2, path)
    assert.deepEqual(server.sent[1], server.sent[0], `${path}: the same request`)
  }
})

test('new-library mode: a replay answered with the receipt only is a committed want-to-go addition', async () => {
  const fetch = async () => new Response(JSON.stringify({ ok: true, revision: 3, duplicate: true, receipt: {} }), { status: 201 })
  await withFetch(fetch as typeof globalThis.fetch, async () => {
    setStoreBaseRevision(2)
    const result = await addLocalWantToGo({ placeId: 'city-1' })
    assert.equal(result.duplicate, true)
  })
  // In V2 mode an answer without the item is still invalid.
  await withFetch((async () => new Response(JSON.stringify({ ok: true }), { status: 201 })) as typeof globalThis.fetch, async () => {
    await assert.rejects(addLocalWantToGo({ placeId: 'city-1' }), { code: 'E_EDITOR_RESPONSE_INVALID' })
  })
})
