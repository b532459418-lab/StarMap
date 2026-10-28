/// <reference types="node" />
/**
 * 3C-5 F on the page: the answers of the re-read and re-import endpoints are checked before use; a preview is a read
 * without the request protocol; a write carries the request protocol on the preview's revision, hands the digest back,
 * and is not sent again after E_STALE (the page asks to preview again instead).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  listMediaReimportCandidates, previewMediaReimport, previewMediaReread, reimportMedia, rereadMedia, setLocalEditorStoreSync, setStoreBaseRevision,
} from './localEditorApi.ts'
import {
  isMediaReimportCandidates, isMediaReimportPreview, isMediaReimportResult, isMediaRereadPreview, isMediaRereadResult, isStalePreviewCode,
} from './mediaMaintenance.ts'
import { STORE_BASE_REVISION_HEADER, STORE_REQUEST_ID_HEADER } from './storeWriteProtocol.ts'
import { isUuidV7 } from './canonical/uuidv7.ts'

const DIGEST = 'a'.repeat(64)
const SHA = 'b'.repeat(64)
const rereadPreview = {
  ok: true, libraryId: 'library-1', revision: 7, planDigest: DIGEST, scope: { cityId: 'city-1' },
  records: [{ mediaId: 'media-1', cityId: 'city-1', changes: [{ field: 'date', from: '2026-07-03', to: '2026-08-01' }], sources: [{ path: 'A/B/drone/p.jpg', sha256: SHA, descriptionDigest: SHA }] }],
  unchanged: 2, registryOnly: 0, withoutSource: 1,
  conflicts: [{ mediaId: 'media-2', sources: [{ path: 'A/B/photos/x.jpg', descriptionDigest: SHA }] }],
  problems: [{ mediaId: 'media-3', path: 'A/B/photos/y.jpg', reason: 'missing', detail: 'A/B/photos/y.jpg：不在投递箱中。' }],
}
const candidates = {
  ok: true, libraryId: 'library-1', revision: 7, scannedFiles: 10, hashedFiles: 0, otherCities: 1,
  candidates: [{ path: 'A/B/photos/b.jpg', cityId: 'city-1', kind: 'photo', bytes: 12, sha256: SHA, reason: 'same-path', pendingDeletion: false }],
}
const reimportPreview = {
  ok: true, libraryId: 'library-1', revision: 7, planDigest: DIGEST,
  file: { path: 'A/B/photos/b.jpg', sha256: SHA, bytes: 12, reason: 'same-path', pendingDeletion: false },
  record: { cityId: 'city-1', kind: 'photo', title: null, date: null, reusesFiles: false, orderPosition: 'end' },
  otherNewFiles: 2, blockers: { errors: [], uncertain: [] }, folderBindings: [],
}

test('the answers are checked: shapes the page relies on, refusing anything else', () => {
  assert.ok(isMediaRereadPreview(rereadPreview))
  assert.equal(isMediaRereadPreview({ ...rereadPreview, planDigest: 'short' }), false)
  assert.equal(isMediaRereadPreview({ ...rereadPreview, scope: { cityId: 'city-1', mediaId: 'media-1' } }), false)
  assert.equal(isMediaRereadPreview({ ...rereadPreview, problems: [{ ...rereadPreview.problems[0], reason: 'other' }] }), false)
  assert.equal(isMediaRereadPreview({ ...rereadPreview, records: [{ ...rereadPreview.records[0], changes: [] }] }), false, 'a listed record has changes')
  assert.ok(isMediaRereadResult({ revision: 8, updatedMediaIds: ['media-1'], duplicate: false }))
  assert.equal(isMediaRereadResult({ revision: 8, duplicate: false }), false)
  assert.ok(isMediaReimportCandidates(candidates))
  assert.equal(isMediaReimportCandidates({ ...candidates, candidates: [{ ...candidates.candidates[0], reason: 'live' }] }), false)
  assert.ok(isMediaReimportPreview(reimportPreview))
  assert.ok(isMediaReimportPreview({ ...reimportPreview, record: null }))
  assert.equal(isMediaReimportPreview({ ...reimportPreview, record: { ...reimportPreview.record, orderPosition: 'start' } }), false)
  assert.ok(isMediaReimportResult({ revision: 8, mediaIds: ['media-9'], duplicate: false }))
  assert.deepEqual(['E_MEDIA_PREVIEW_STALE', 'E_STALE', 'E_LIBRARY_BUSY'].map(isStalePreviewCode), [true, true, false])
})

type Sent = { url: string; headers: Record<string, string>; body: unknown }
async function withServer(answer: (url: string, sent: Sent[]) => Response, run: (sent: Sent[]) => Promise<void>) {
  const sent: Sent[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input).replace('/__travelatlas/editor/', '')
    sent.push({ url, headers: { ...(init?.headers as Record<string, string>) }, body: JSON.parse(String(init?.body)) })
    return answer(url, sent)
  }) as typeof globalThis.fetch
  try { await run(sent) } finally { globalThis.fetch = original; setLocalEditorStoreSync(undefined); setStoreBaseRevision(undefined) }
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })

test('previews are reads without the request protocol; writes carry it on the preview\'s revision with its digest', async () => {
  await withServer((url) => {
    if (url === 'media/reread/preview') return json(rereadPreview)
    if (url === 'media/reimport/candidates') return json(candidates)
    if (url === 'media/reimport/preview') return json(reimportPreview)
    if (url === 'media/reread') return json({ ok: true, revision: 8, updatedMediaIds: ['media-1'], duplicate: false })
    return json({ ok: true, revision: 9, mediaIds: ['media-9'], duplicate: false })
  }, async (sent) => {
    setStoreBaseRevision(5)
    const reread = await previewMediaReread({ cityId: 'city-1' })
    assert.equal(reread.planDigest, DIGEST)
    assert.deepEqual((await listMediaReimportCandidates('city-1')).candidates.length, 1)
    await listMediaReimportCandidates()
    const reimport = await previewMediaReimport('A/B/photos/b.jpg')
    for (const request of sent) assert.deepEqual(request.headers, { 'content-type': 'application/json', 'x-travelatlas-local-editor': '1' }, request.url)
    assert.deepEqual(sent.map((request) => [request.url, request.body]), [
      ['media/reread/preview', { scope: { cityId: 'city-1' } }], ['media/reimport/candidates', { cityId: 'city-1' }], ['media/reimport/candidates', {}],
      ['media/reimport/preview', { path: 'A/B/photos/b.jpg' }],
    ])
    assert.deepEqual(await rereadMedia(reread), { ok: true, revision: 8, updatedMediaIds: ['media-1'], duplicate: false })
    await reimportMedia(reimport, { acceptFolderBindings: true })
    const [readWrite, importWrite] = sent.slice(4)
    assert.deepEqual([readWrite.url, readWrite.body, readWrite.headers[STORE_BASE_REVISION_HEADER]], ['media/reread', { scope: { cityId: 'city-1' }, planDigest: DIGEST }, '7'])
    assert.deepEqual([importWrite.url, importWrite.body, importWrite.headers[STORE_BASE_REVISION_HEADER]], ['media/reimport', { path: 'A/B/photos/b.jpg', planDigest: DIGEST, acceptFolderBindings: true }, '7'])
    assert.ok(isUuidV7(readWrite.headers[STORE_REQUEST_ID_HEADER]) && isUuidV7(importWrite.headers[STORE_REQUEST_ID_HEADER]))
  })
})

test('a write that confirms a preview is not sent again after E_STALE: the page previews again', async () => {
  let pulls = 0
  await withServer(() => json({ ok: false, code: 'E_STALE', error: 'stale' }, 409), async (sent) => {
    setLocalEditorStoreSync({ baseRevision: () => 9, applySaved: async () => {}, writeStarted: () => () => {}, pull: async () => { pulls++ }, waitForServer: async () => {} })
    await assert.rejects(rereadMedia({ scope: { cityId: 'city-1' }, planDigest: DIGEST, revision: 7 }), { code: 'E_STALE' })
    await assert.rejects(reimportMedia({ planDigest: DIGEST, revision: 7, file: { path: 'A/B/photos/b.jpg' } }), { code: 'E_STALE' })
    assert.equal(sent.length, 2, 'one request each')
    assert.equal(pulls, 0)
  })
  await withServer(() => json({ ok: false, code: 'E_MEDIA_PREVIEW_STALE', error: 'stale' }, 409), async () => {
    await assert.rejects(rereadMedia({ scope: { mediaId: 'media-1' }, planDigest: DIGEST, revision: 7 }), { code: 'E_MEDIA_PREVIEW_STALE' })
  })
  // An answer of another shape is refused.
  await withServer(() => json({ ok: true, planDigest: 'x' }), async () => {
    await assert.rejects(previewMediaReread({ mediaId: 'media-1' }), { code: 'E_EDITOR_RESPONSE_INVALID' })
  })
})
