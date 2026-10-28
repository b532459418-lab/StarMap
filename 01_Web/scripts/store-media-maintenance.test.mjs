/**
 * The 3C-5 F endpoints through the local editor plugin on a migrated synthetic library (./store-media.fixture.mjs):
 * re-reading descriptions and re-importing, each a preview (no protocol headers, no lease) and a write (the protocol
 * headers, the preview's digest, under the lease). Refusals: stale previews, invalid requests, a media task left
 * unfinished, the lease held by another operation; retries answer the receipt; a write answers its changed rows.
 */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { PLACE, inboxFile, writeJson } from './media-inbox.fixture.mjs'
import { withLibraryOperation } from './library-operation-lock.mjs'
import { UUID_V7, servedLibrary } from './store-media.fixture.mjs'

const panorama = (paths, values) => writeJson(path.join(paths.inboxRoot, 'Second Land', 'River Town', 'media.json'), {
  'drone/pano-1.jpg': { kind: 'panorama360', titleEn: 'Synthetic panorama', date: '2026-07-03', resolution: '200 × 100', ...values },
})

test('re-reading through the endpoints: a preview without protocol or lease, a write of exactly that preview with its changed rows; stale, invalid and retried requests', async (t) => {
  const library = await servedLibrary(t, 'starmap-media-reread-endpoint-')
  const { paths, inbox } = library
  const pano = await library.assetAt(inbox.pano)
  await panorama(paths, { date: '2026-08-01', titleEn: 'Synthetic panorama, renamed' })
  const scope = { cityId: PLACE.river }
  const preview = await library.post('media/reread/preview', { scope })
  assert.equal(preview.status, 200, JSON.stringify(preview.body))
  assert.match(preview.body.planDigest, /^[0-9a-f]{64}$/)
  assert.deepEqual([preview.body.revision, preview.body.scope, preview.body.unchanged, preview.body.withoutSource, preview.body.conflicts, preview.body.problems], [1, scope, 0, 0, [], []])
  assert.deepEqual(preview.body.records.map((record) => [record.mediaId, record.cityId, record.changes.map((change) => change.field), record.sources.map((source) => source.path)]),
    [[pano, PLACE.river, ['date', 'title'], ['Second Land/River Town/drone/pano-1.jpg']]])
  assert.deepEqual(preview.body.records[0].changes[0], { field: 'date', from: '2026-07-03', to: '2026-08-01' })

  // Requests that are refused before anything is written.
  assert.equal((await library.post('media/reread', { scope, planDigest: preview.body.planDigest })).body.code, 'E_STALE', 'the write needs the protocol headers')
  for (const input of [{ scope: { cityId: PLACE.river, mediaId: pano } }, { scope }, { scope, planDigest: 'abc' }, { scope, planDigest: preview.body.planDigest, extra: true }]) {
    const refused = await library.write('media/reread', input, 1)
    assert.deepEqual([refused.status, refused.body.code], [400, 'E_REQUEST_INVALID'], JSON.stringify(input))
  }
  assert.deepEqual([(await library.post('media/reread/preview', { scope: { mediaId: '01960000-0000-7000-8000-00000000dead' } })).status, (await library.post('media/reread/preview', { scope: { mediaId: '01960000-0000-7000-8000-00000000dead' } })).body.code], [409, 'E_MEDIA_NOT_FOUND'])
  assert.equal((await library.post('media/reread/preview', { scope: { cityId: PLACE.synthland } })).body.code, 'E_UNKNOWN_PLACE_REF')
  assert.equal((await library.post('media/reread/preview', { scope, more: 1 })).body.code, 'E_REQUEST_INVALID')
  // The sidecar changes again after the preview: 409, nothing written.
  await panorama(paths, { date: '2026-08-02', titleEn: 'Synthetic panorama, renamed' })
  const stale = await library.write('media/reread', { scope, planDigest: preview.body.planDigest }, 1)
  assert.deepEqual([stale.status, stale.body.code], [409, 'E_MEDIA_PREVIEW_STALE'])
  assert.equal((await library.reading()).revision, 1)

  const fresh = await library.post('media/reread/preview', { scope: { mediaId: pano } })
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body))
  const id = library.nextId()
  const written = await library.write('media/reread', { scope: { mediaId: pano }, planDigest: fresh.body.planDigest }, 1, id)
  assert.equal(written.status, 200, JSON.stringify(written.body))
  assert.deepEqual([written.body.revision, written.body.updatedMediaIds, written.body.duplicate], [2, [pano], false])
  assert.ok(written.body.receipt && written.body.delta, 'the receipt and the changed rows (the page updates without reloading)')
  const media = (await library.reading()).files.media.items.find((item) => item.id === pano)
  assert.deepEqual([media.date, media.title], ['2026-08-02', { names: { en: 'Synthetic panorama, renamed' } }])
  const retried = await library.write('media/reread', { scope: { mediaId: pano }, planDigest: fresh.body.planDigest }, 1, id)
  assert.deepEqual([retried.status, retried.body.duplicate, retried.body.receipt.revision], [200, true, 2])
  const conflict = await library.write('media/reread', { scope, planDigest: fresh.body.planDigest }, 1, id)
  assert.deepEqual([conflict.status, conflict.body.code], [409, 'E_OPERATION_CONFLICT'])
  assert.equal((await library.reading()).revision, 2)
})

test('re-importing through the endpoints: candidates, a preview and a write of that file alone with a new id and its changed rows; an import counts the skipped files', async (t) => {
  const library = await servedLibrary(t, 'starmap-media-reimport-endpoint-')
  const { paths, inbox } = library
  const bytes = await readFile(inboxFile(paths, inbox.b))
  const assetB = await library.assetAt(inbox.b)
  let revision = await library.hide([assetB], 1)
  const deleted = await library.write('media/delete', { cityId: PLACE.harbor, ids: [assetB] }, revision)
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body))
  revision = deleted.body.revision
  await writeFile(inboxFile(paths, inbox.b), bytes)

  const listed = await library.post('media/reimport/candidates', { cityId: PLACE.harbor })
  assert.equal(listed.status, 200, JSON.stringify(listed.body))
  assert.deepEqual(listed.body.candidates.map((item) => [item.path, item.reason, item.cityId, item.pendingDeletion]), [['Synthland/Harbor Town/photos/b.jpg', 'same-path', PLACE.harbor, false]])
  assert.deepEqual([(await library.post('media/reimport/candidates', {})).body.candidates.length, (await library.post('media/reimport/candidates', { cityId: PLACE.river })).body.otherCities], [1, 1])
  assert.equal((await library.post('media/reimport/candidates', { cityId: 7 })).body.code, 'E_REQUEST_INVALID')

  const refusedLive = await library.post('media/reimport/preview', { path: 'Synthland/Harbor Town/photos/a.jpg' })
  assert.deepEqual([refusedLive.status, refusedLive.body.code], [409, 'E_MEDIA_REIMPORT_NOT_DELETED'])
  assert.equal((await library.post('media/reimport/preview', { path: '../outside.jpg' })).body.code, 'E_MEDIA_IMPORT_PATH_INVALID')
  const preview = await library.post('media/reimport/preview', { path: 'Synthland/Harbor Town/photos/b.jpg' })
  assert.equal(preview.status, 200, JSON.stringify(preview.body))
  assert.deepEqual([preview.body.file.reason, preview.body.record.cityId, preview.body.record.kind, preview.body.record.orderPosition, preview.body.otherNewFiles, preview.body.folderBindings],
    ['same-path', PLACE.harbor, 'photo', 'end', 0, []])
  const input = { path: 'Synthland/Harbor Town/photos/b.jpg', planDigest: preview.body.planDigest }
  assert.equal((await library.write('media/reimport', { ...input, acceptFolderBindings: 'yes' }, revision)).body.code, 'E_REQUEST_INVALID')
  const id = library.nextId()
  const written = await library.write('media/reimport', input, revision, id)
  assert.equal(written.status, 200, JSON.stringify(written.body))
  const [restored] = written.body.mediaIds
  assert.match(restored, UUID_V7)
  assert.notEqual(restored, assetB)
  assert.ok(written.body.delta, 'the changed rows')
  const reading = await library.reading()
  assert.equal(reading.files.editorState.mediaOrderByCity[PLACE.harbor].at(-1), restored)
  const retried = await library.write('media/reimport', input, revision, id)
  assert.deepEqual([retried.status, retried.body.duplicate, retried.body.mediaIds], [200, true, [restored]])
  // An ordinary import tells the page how many files deleted for good it skipped (c.jpg, deleted and put back).
  const cBytes = await readFile(inboxFile(paths, inbox.c))
  const assetC = await library.assetAt(inbox.c)
  revision = await library.hide([assetC], written.body.revision)
  const deletedC = await library.write('media/delete', { cityId: PLACE.hill, ids: [assetC] }, revision)
  assert.equal(deletedC.status, 200, JSON.stringify(deletedC.body))
  await writeFile(inboxFile(paths, inbox.c), cBytes)
  const imported = await library.write('import', {}, deletedC.body.revision)
  assert.equal(imported.status, 200, JSON.stringify(imported.body))
  assert.equal(imported.body.deletedSkipped, 1)
  assert.match(imported.body.output, /之前彻底删除过、又出现在投递箱里的文件（1）/)
  assert.deepEqual((await library.registry()).problems, [])
})

test('previews and writes are refused while another operation holds the lease or a media task is unfinished; a preview reads without the lease', async (t) => {
  const library = await servedLibrary(t, 'starmap-media-maintenance-refusals-')
  const { paths } = library
  const scope = { cityId: PLACE.river }
  const preview = await library.post('media/reread/preview', { scope })
  assert.equal(preview.status, 200)
  await withLibraryOperation(paths, async () => {
    for (const route of ['media/reread/preview', 'media/reimport/candidates']) {
      const busy = await library.post(route, route.includes('reread') ? { scope } : {})
      assert.deepEqual([busy.status, busy.body.code], [409, 'E_LIBRARY_BUSY'], route)
    }
    const write = await library.write('media/reread', { scope, planDigest: preview.body.planDigest }, 1)
    assert.deepEqual([write.status, write.body.code], [409, 'E_LIBRARY_BUSY'])
  })
  const task = await library.post('media/jobs', { countryId: PLACE.synthland, cityId: PLACE.harbor, kind: 'photo', files: [{ fileName: 'synthetic.jpg', bytes: 32 }] })
  assert.ok(task.status < 300, JSON.stringify(task.body))
  for (const [route, input] of [['media/reread/preview', { scope }], ['media/reimport/candidates', {}], ['media/reimport/preview', { path: 'Synthland/Harbor Town/photos/b.jpg' }]]) {
    const pending = await library.post(route, input)
    assert.deepEqual([pending.status, pending.body.code], [409, 'E_MEDIA_JOB_PENDING'], route)
  }
  const pendingWrite = await library.write('media/reread', { scope, planDigest: preview.body.planDigest }, 1)
  assert.equal(pendingWrite.body.code, 'E_MEDIA_JOB_PENDING')
  assert.equal((await library.reading()).revision, 1)
})
