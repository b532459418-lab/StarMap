import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addLocalCountry, addLocalTravelRecord, addLocalWantToGo, convertLocalWantToGoToTravel,
  deleteHiddenLocalCountries, deleteHiddenLocalMedia, deleteHiddenLocalWantToGo,
  applyLocalViewOperations, reloadAfterLocalSave, searchLocalCities,
  searchLocalCountries, updateLocalWantToGo,
} from './localEditorApi.ts'
import { withLocalEditorWrite, type MediaImportPermit } from './localEditorCoordination.ts'
import { getMediaImportSession } from './mediaImportSession.ts'
import { LocalEditorError } from '../i18n/editorErrors.ts'

const responseOf = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
const file = new File(['neutral test bytes'], 'neutral.jpg', { type: 'image/jpeg' })
// The old upload and import client calls were removed (batch 7). These stand-ins make the same requests through the
// same write lease, so the media owner's permit is still exercised end to end.
const uploadMedia = (cityId: string, selected: File, permit?: MediaImportPermit) => withLocalEditorWrite(async () => {
  const response = await fetch(`/__travelatlas/editor/upload?cityId=${cityId}`, { method: 'POST', body: selected })
  return await response.json() as { sourcePath: string }
}, permit)
const importMedia = (sourcePaths: string[], permit?: MediaImportPermit) => withLocalEditorWrite(async () => {
  const response = await fetch('/__travelatlas/editor/import', { method: 'POST', body: JSON.stringify({ sourcePaths }) })
  return await response.json() as unknown
}, permit)
const busyError = (error: unknown) => error instanceof LocalEditorError && error.code === 'E_MEDIA_IMPORT_BUSY'
const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const withGlobals = async (run: (reloadCount: () => number) => Promise<void>) => {
  const originalFetch = globalThis.fetch
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let reloads = 0
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { reload: () => { reloads += 1 } } } })
  try {
    await run(() => reloads)
  } finally {
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
}

test('a pending registered media owner blocks every write before fetch while reads and owner import remain available', async () => withGlobals(async (reloadCount) => {
  const owner = getMediaImportSession('coordination-integration-pending-owner')
  let requests = 0
  globalThis.fetch = async (input, init) => {
    requests += 1
    const url = String(input)
    if (url.includes('/upload?')) return responseOf({ ok: true, fileName: file.name, bytes: file.size, sourcePath: 'Neutral/City/photos/neutral.jpg' })
    if (url.endsWith('/import')) {
      assert.deepEqual(JSON.parse(String(init?.body)), { sourcePaths: ['Neutral/City/photos/neutral.jpg'] })
      return responseOf({ ok: true, output: '', restoredMediaIds: ['media-neutral'] })
    }
    if (url.includes('/catalog/')) return responseOf({ ok: true, results: [] })
    assert.fail(`Unexpected write request: ${url}`)
  }
  try {
    await owner.upload([file], (selected, permit) => {
      assert.ok(permit)
      return uploadMedia('neutral-city', selected, permit)
    })
    assert.equal(owner.getSnapshot().phase, 'pending')
    assert.equal(requests, 1)
    const writes: Array<[string, () => Promise<unknown>]> = [
      ['add country', () => addLocalCountry('JP', '2026-10-03')],
      ['apply view operations', () => applyLocalViewOperations([{ op: 'hide', scope: 'countries', add: ['other-country'], remove: [] }])],
      ['add travel', () => addLocalTravelRecord({ country: 'Neutral', country_en: 'Neutral', city: 'City', city_en: 'City', start_date: '2026-10-03', lat: 35, lng: 135 })],
      ['delete media', () => deleteHiddenLocalMedia('other-city', ['media-other'])],
      ['delete countries', () => deleteHiddenLocalCountries(['other-country'])],
      ['add want to go', () => addLocalWantToGo({ place: { kind: 'country', nameEn: 'Neutral', countryCode: 'JP' } })],
      ['update want to go', () => updateLocalWantToGo('other-record', { hidden: true })],
      ['delete want to go', () => deleteHiddenLocalWantToGo(['other-record'])],
      ['convert to travel', () => convertLocalWantToGoToTravel({ source: 'want-to-go', id: 'other-record', startDate: '2026-10-03' })],
      ['upload without owner permit', () => uploadMedia('other-city', file)],
      ['import without owner permit', () => importMedia(['Neutral/Other/photos/other.jpg'])],
    ]
    for (const [name, write] of writes) {
      const before: number = requests
      await assert.rejects(write(), busyError, name)
      assert.equal(requests, before, `${name} must not issue any request`)
    }
    assert.throws(reloadAfterLocalSave, busyError)
    assert.equal(reloadCount(), 0)
    assert.deepEqual(await searchLocalCountries('Neutral'), [])
    assert.deepEqual(await searchLocalCities('City', 'JP'), [])
    assert.equal(requests, 3)
    await owner.importMedia((paths, permit) => {
      assert.ok(permit)
      return importMedia(paths, permit)
    })
    assert.equal(requests, 4)
    assert.equal(owner.getSnapshot().phase, 'idle')
    reloadAfterLocalSave()
    assert.equal(reloadCount(), 1)
  } finally {
    if (owner.getSnapshot().phase === 'pending') await owner.importMedia(async () => undefined)
  }
}))

test('an ordinary write keeps its lease through response parsing, blocking media upload and reload', async () => withGlobals(async (reloadCount) => {
  const parsed = deferred<{ ok: true; countryId: string }>()
  const parsingStarted = deferred<void>()
  let requests = 0
  const response = new Response('{}')
  response.json = async () => { parsingStarted.resolve(undefined); return parsed.promise }
  globalThis.fetch = async () => { requests += 1; return response }
  const writing = addLocalCountry('JP')
  await parsingStarted.promise
  const other = getMediaImportSession('coordination-integration-during-parse')
  let uploads = 0
  try {
    await assert.rejects(other.upload([file], async (selected, permit) => {
      uploads += 1
      return uploadMedia('neutral-city', selected, permit)
    }), busyError)
    assert.equal(uploads, 0)
    assert.equal(requests, 1)
    assert.equal(other.getSnapshot().phase, 'idle')
    assert.throws(reloadAfterLocalSave, busyError)
    assert.equal(reloadCount(), 0)
  } finally {
    parsed.resolve({ ok: true, countryId: 'neutral-country' })
    await writing
  }
  reloadAfterLocalSave()
  assert.equal(reloadCount(), 1)
}))

test('network, abort and malformed response errors always release the ordinary write lease', async () => withGlobals(async (reloadCount) => {
  for (const error of [new TypeError('Neutral network failure'), new DOMException('Neutral canceled write', 'AbortError')]) {
    globalThis.fetch = async () => { throw error }
    await assert.rejects(addLocalCountry('JP'), (actual) => actual === error)
    reloadAfterLocalSave()
  }
  globalThis.fetch = async () => new Response('<neutral invalid response>', { status: 503 })
  await assert.rejects(addLocalCountry('JP'), (error) => error instanceof LocalEditorError && error.code === 'E_EDITOR_RESPONSE_INVALID')
  reloadAfterLocalSave()
  assert.equal(reloadCount(), 3)
  const owner = getMediaImportSession('coordination-integration-after-failures')
  await owner.upload([file], async () => ({ sourcePath: 'Neutral/City/photos/neutral.jpg' }))
  assert.equal(owner.getSnapshot().phase, 'pending')
  await owner.importMedia(async () => undefined)
}))
