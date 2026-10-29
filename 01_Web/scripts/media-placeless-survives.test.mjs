/**
 * Media without a place survive ordinary edits (3C-5 G, design §6.3). A migrated synthetic library served by the plugin
 * (./store-media.fixture.mjs servedLibrary) imports two files of the Inbox's `_no-place` and `_无地点` folders; then the
 * page's writes, the media operations and the host's backup, restore and pruning run one after the other. After each
 * step:
 * - their media entities and assets, their media registry rows (sources, asset links, files) and their items of the
 *   original media order are the same bytes as right after their import (SQLite rows read through a separate read-only
 *   connection, `revision` and `body` included);
 * - their sources are present, their files are on disk;
 * - the read model has them (officialReader placelessMedia()), the official view does not, and the page's path
 *   (readReadModel, then officialViewOf) reads the served read model without a problem.
 * A second test follows the documented way to delete such media for good (owner decision 6): give it a place (move the
 * file into a city folder, import, re-read), hide it in that city, delete hidden media.
 * Synthetic data only, on a temporary private root.
 */
import assert from 'node:assert/strict'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { COLOR, PLACE, imageBytes, inboxFile, makeImage, writeJson } from './media-inbox.fixture.mjs'
import { storeFileOf } from './private-data-source.mjs'
import { getPrivatePaths } from './private-profile.mjs'
import { backupStore, restoreStore } from './store-backup.mjs'
import { openStore } from './store-host.mjs'
import { NOW, exists, servedLibrary, sha256Of } from './store-media.fixture.mjs'
import { pathKeyOf } from './store-media-registry.mjs'
import { authorizedHeaders, editorPrefix, moduleOf, requestTo } from './store-mode.fixture.mjs'
import { rawConnection } from './store-sqlite.mjs'
import { uuidv7 } from '../src/data/canonical/uuidv7.ts'
import { isMediaReimportPreview, isMediaRereadPreview } from '../src/data/mediaMaintenance.ts'
import { assertMediaJob, assertMediaJobPreview } from '../src/data/mediaJobs.ts'
import { OFFICIAL_POLICY, VIEW_SCOPES } from '../src/data/store/officialDefinitions.ts'
import { officialReader } from '../src/data/store/officialReader.ts'
import { officialViewOf } from '../src/data/store/projectCanonical.ts'
import { readReadModel } from '../src/worldgraph/readModel/check.ts'
import { indexReadModel } from '../src/worldgraph/readModel/lookup.ts'

const NO_PLACE_PHOTO = 'MediaInbox/_no-place/photos/lost.jpg'
const NO_PLACE_DRONE = 'MediaInbox/_无地点/drone/flight.jpg'
const BACKUP_MARK = ['operations', 'store-backup', '01960000-0000-7000-8000-00000000b001.json']

/** The rows of the media without a place, as SQLite holds them (a separate read-only connection). */
function rowsOf(file, records) {
  const db = rawConnection(file, { readOnly: true })
  const among = (table, column, values, order = column) => db.prepare(`SELECT * FROM ${table} WHERE ${column} IN (${values.map(() => '?').join(', ')}) ORDER BY ${order}`).all(...values)
  try {
    const assetIds = records.map((record) => record.assetId)
    return {
      entities: among('entities', 'id', records.map((record) => record.entityId)),
      assets: among('assets', 'id', assetIds),
      assetFiles: among('media_asset_files', 'asset_id', assetIds),
      files: among('media_files', 'sha256', records.map((record) => record.sha256)),
      sources: among('media_sources', 'record_id', records.map((record) => record.entityId), 'seq'),
      mediaOrder: db.prepare(`SELECT * FROM view_items WHERE scope = ? AND item_table = 'assets' AND item_id IN (${assetIds.map(() => '?').join(', ')}) ORDER BY id`)
        .all(VIEW_SCOPES.mediaOrder, ...assetIds),
    }
  } finally { db.close() }
}

/** The read model of a store file: what placelessMedia() and the official view give. */
async function readOf(file) {
  const handle = openStore(file, { readOnly: true, policy: OFFICIAL_POLICY })
  try { return { model: handle.readModel(), registry: handle.mediaRegistry(), problems: handle.check().problems } } finally { await handle.close() }
}

/** Create a media task for `files` ({ fileName, content }) and receive each one (as ./store-media-jobs.test.mjs does). */
async function receivedTask(library, files) {
  const created = await library.post('media/jobs', { countryId: PLACE.synthland, cityId: PLACE.harbor, kind: 'photo', files: files.map(({ fileName, content }) => ({ fileName, bytes: content.length })) })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  let job = created.body.job
  for (const { fileName, content } of files) {
    const intent = job.files.find((item) => item.fileName === fileName)
    const query = new URLSearchParams({ libraryId: job.libraryId, revision: String(job.revision), operationId: uuidv7(), sha256: sha256Of(content) })
    const received = await requestTo(library.handler, {
      url: `${editorPrefix}media/jobs/${job.jobId}/files/${intent.fileId}?${query}`, content,
      headers: { ...authorizedHeaders, 'content-length': String(content.length) },
    })
    assert.equal(received.status, 201, JSON.stringify(received.body))
    job = received.body.job
  }
  assertMediaJob(job)
  return job
}

test('media without a place survive the page\'s writes, the media operations, a backup and restore, and pruning, to the byte', { timeout: 300_000 }, async (t) => {
  const library = await servedLibrary(t, 'starmap-media-placeless-survives-')
  const { paths, inbox, root, directory } = library
  const file = storeFileOf(paths)
  const revision = async () => (await library.reading()).revision
  const ok = (response, status = 200) => { assert.equal(response.status, status, JSON.stringify(response.body)); return response.body }

  // Two files without a place, imported from the Inbox.
  await makeImage(inboxFile(paths, NO_PLACE_PHOTO), { color: COLOR.purple })
  await makeImage(inboxFile(paths, NO_PLACE_DRONE), { color: COLOR.grey, width: 80, height: 40 })
  await writeJson(path.join(paths.inboxRoot, '_无地点', 'media.json'), { 'drone/flight.jpg': { kind: 'aerialPhoto', titleEn: 'Synthetic flight', date: '2026-07-04', resolution: '80 × 40' } })
  ok(await library.write('import', {}, 1))
  const registry = await library.registry()
  const records = [NO_PLACE_PHOTO, NO_PLACE_DRONE].map((portable) => {
    const source = registry.sources.find((item) => item.pathKey === pathKeyOf(portable) && item.state === 'present')
    const entity = registry.entities.find((item) => item.id === source.recordId)
    assert.equal(Object.hasOwn(entity.fields, 'place'), false, portable)
    return { portable, entityId: entity.id, assetId: entity.fields.asset, sha256: source.sha256 }
  })
  const assetIds = records.map((record) => record.assetId).sort()
  const baseline = rowsOf(file, records)
  assert.deepEqual([baseline.entities.length, baseline.assets.length, baseline.assetFiles.length, baseline.files.length, baseline.sources.length, baseline.mediaOrder.length], [2, 2, 2, 2, 2, 2])
  const originals = (await readOf(file)).model
  const srcOf = new Map(officialReader(indexReadModel(originals)).placelessMedia().map((media) => [media.id, media.src]))
  const steps = []

  /** The three checks after one step (`page`: the served read model through the page's path too). */
  async function survives(label, { at = root, page = true } = {}) {
    const atFile = at === root ? file : storeFileOf(getPrivatePaths({ STARMAP_PRIVATE_ROOT: at }))
    assert.deepEqual(rowsOf(atFile, records), baseline, `${label}: the rows are the same bytes`)
    const read = await readOf(atFile)
    assert.deepEqual(read.problems, [], label)
    for (const record of records) {
      assert.ok(read.registry.sources.some((source) => source.recordId === record.entityId && source.state === 'present' && source.pathKey === pathKeyOf(record.portable)), `${label}: ${record.portable} present`)
      assert.ok(await exists(path.join(at, ...record.portable.split('/'))), `${label}: ${record.portable} on disk`)
      assert.ok(await exists(path.join(at, ...srcOf.get(record.assetId).slice(1).split('/'))), `${label}: the original of ${record.portable}`)
    }
    assert.deepEqual(officialReader(indexReadModel(read.model)).placelessMedia().map((media) => media.id).sort(), assetIds, `${label}: in the read model`)
    assert.equal(officialViewOf(read.model, 'local').media.items.some((item) => assetIds.includes(item.id)), false, `${label}: not in the official view`)
    if (page) {
      const served = readReadModel(JSON.parse(JSON.stringify((await moduleOf(library.plugin)).privateReadModel)))
      assert.deepEqual(officialReader(indexReadModel(served)).placelessMedia().map((media) => media.id).sort(), assetIds, `${label}: served`)
      assert.equal(officialViewOf(served, 'local').media.items.some((item) => assetIds.includes(item.id)), false, `${label}: the page does not show them`)
    }
    steps.push(label)
  }
  await survives('import')

  // --- The page's writes (the eight store-native editor writes, and a view operation of every kind).
  ok(await library.write('countries', { countryCode: 'DK', visitedDate: '2024-03-02' }, await revision()), 201)
  await survives('add a country')
  ok(await library.write('records', {
    country: '日本', country_en: 'Japan', city: '东京', city_en: 'Tokyo', start_date: '2026-05-01', lat: 35.68, lng: 139.69, country_code: 'JP',
  }, await revision()), 201)
  await survives('add a footprint record')
  let files = (await library.reading()).files
  const japan = files.places.places.find((place) => place.names.en === 'Japan').id
  ok(await library.write('wanttogo', { placeId: PLACE.hill, note: 'Synthetic hill' }, await revision()), 201)
  ok(await library.write('wanttogo', { placeId: PLACE.river, note: 'Synthetic river' }, await revision()), 201)
  await survives('add want-to-go items')
  files = (await library.reading()).files
  const wishOn = (placeId) => files.wantToGo.items.find((item) => item.placeId === placeId).id
  const [hillWish, riverWish] = [wishOn(PLACE.hill), wishOn(PLACE.river)]
  ok(await library.write('wanttogo/update', { id: hillWish, note: 'Synthetic note', hidden: true }, await revision()))
  await survives('update a want-to-go item')
  ok(await library.write('wanttogo/convert', { source: 'want-to-go', id: riverWish, startDate: '2026-08-01' }, await revision()))
  await survives('convert a want-to-go item')
  ok(await library.write('wanttogo/delete', { ids: [hillWish] }, await revision()))
  await survives('delete a want-to-go item')
  files = (await library.reading()).files
  const harborPhotos = files.editorState.mediaOrderByCity[PLACE.harbor] ?? []
  const harborIds = files.media.items.filter((item) => item.placeId === PLACE.harbor && item.kind === 'photo').map((item) => item.id)
  assert.ok(harborIds.length >= 2)
  const countryOrder = files.editorState.countryOrder
  ok(await library.write('view', { operations: [
    { op: 'order', scope: 'countries', ids: [...countryOrder].reverse(), baseline: countryOrder },
    { op: 'order', scope: 'media', key: PLACE.harbor, ids: [...harborIds].reverse(), baseline: harborPhotos },
    { op: 'cover', key: PLACE.harbor, id: harborIds[0] },
    { op: 'hide', scope: 'cities', add: [PLACE.hill], remove: [] },
    { op: 'hide', scope: 'countries', add: [japan], remove: [] },
  ] }, await revision()))
  await survives('view operations: orders, a cover, hidden places')
  ok(await library.write('countries/delete', { ids: [japan] }, await revision()))
  await survives('delete a country with its city and records')
  ok(await library.write('view', { operations: [{ op: 'hide', scope: 'cities', add: [], remove: [PLACE.hill] }] }, await revision()))
  await survives('restore a hidden city')

  // --- Media operations.
  const uploaded = ok(await library.upload(await imageBytes({ color: COLOR.yellow }), { fileName: 'synthetic-upload.jpg' }), 201)
  ok(await library.write('import', { sourcePaths: [uploaded.sourcePath] }, await revision()))
  await survives('upload, then import the uploaded file')
  await makeImage(inboxFile(paths, 'MediaInbox/Synthland/Hill Town/photos/d.jpg'), { color: COLOR.blue, width: 50, height: 40 })
  ok(await library.write('import', {}, await revision()))
  await survives('import the whole Inbox again (a new file elsewhere)')
  const job = await receivedTask(library, [{ fileName: 'task-photo.jpg', content: await imageBytes({ color: COLOR.green, width: 30, height: 20 }) }])
  const selected = job.files.filter((item) => item.phase === 'received').map((item) => item.fileId)
  const previewed = ok(await library.post(`media/jobs/${job.jobId}/preview`, { libraryId: job.libraryId, revision: job.revision, selectedFileIds: selected }))
  const preview = { jobId: job.jobId, revision: previewed.job.revision, plan: { digest: previewed.plan.digest, summary: previewed.plan.summary }, selectedFileIds: previewed.plan.selectedFileIds, blockers: previewed.plan.blockers }
  assertMediaJobPreview(preview)
  assert.deepEqual(preview.blockers, [])
  assert.deepEqual(preview.plan.summary.sources.filter((source) => source.placeId === null).map((source) => source.sourcePath).sort(), ['_no-place/photos/lost.jpg', '_无地点/drone/flight.jpg'])
  ok(await library.post(`media/jobs/${job.jobId}/import`, {
    libraryId: job.libraryId, revision: job.revision, selectedFileIds: preview.selectedFileIds, operationId: uuidv7(), planDigest: preview.plan.digest,
  }))
  await survives('a media task\'s import')
  // Hide b.jpg and delete it for good while a backup copies media: its files wait in the queue.
  const bBytes = await readFile(inboxFile(paths, inbox.b))
  const bAsset = await library.assetAt(inbox.b)
  const mark = path.join(root, ...BACKUP_MARK)
  await writeJson(mark, { format: 'starmap.store-backup.media-copy', backupId: '01960000-0000-7000-8000-00000000b001', startedAt: NOW, pid: 1 })
  ok(await library.write('view', { operations: [{ op: 'hide', scope: 'media', add: [bAsset], remove: [] }] }, await revision()))
  ok(await library.write('media/delete', { cityId: PLACE.harbor, ids: [bAsset] }, await revision()))
  await unlink(mark)
  assert.ok((await library.registry()).pendingFileOps.length > 0, 'the deletion of the files is queued')
  await survives('delete a hidden photo for good (its files queued)')
  // A city re-read.
  await writeJson(path.join(paths.inboxRoot, 'Second Land', 'River Town', 'media.json'), { 'drone/pano-1.jpg': { kind: 'panorama360', titleEn: 'Synthetic panorama, renamed', date: '2026-08-01', resolution: '200 × 100' } })
  const reread = ok(await library.post('media/reread/preview', { scope: { cityId: PLACE.river } }))
  assert.ok(isMediaRereadPreview(reread), JSON.stringify(reread))
  assert.deepEqual([reread.conflicts, reread.problems], [[], []])
  assert.ok(reread.records.length > 0, JSON.stringify(reread))
  assert.equal(reread.records.some((record) => assetIds.includes(record.mediaId)), false)
  ok(await library.write('media/reread', { scope: { cityId: PLACE.river }, planDigest: reread.planDigest }, await revision()))
  await survives('re-read a city')
  // The next import runs the queue first: b.jpg and its files go.
  ok(await library.write('import', {}, await revision()))
  assert.deepEqual((await library.registry()).pendingFileOps, [], 'the queue ran')
  assert.equal(await exists(inboxFile(paths, inbox.b)), false)
  await survives('run the queued deletions')
  // b.jpg back in the Inbox: re-imported.
  await writeFile(inboxFile(paths, inbox.b), bBytes)
  const reimport = ok(await library.post('media/reimport/preview', { path: 'Synthland/Harbor Town/photos/b.jpg' }))
  assert.ok(isMediaReimportPreview(reimport), JSON.stringify(reimport))
  ok(await library.write('media/reimport', { path: 'Synthland/Harbor Town/photos/b.jpg', planDigest: reimport.planDigest }, await revision()))
  await survives('re-import a file deleted for good')

  // --- The host: a backup, its restore into a new root, and pruning the restored store's history.
  const backup = path.join(directory, 'backup')
  await backupStore(paths, { out: backup, now: NOW })
  await survives('backup')
  const restored = path.join(directory, 'restored')
  await restoreStore({ from: backup, to: restored, now: NOW })
  await survives('restore into a new root', { at: restored, page: false })
  const restoredPaths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: restored })
  const handle = openStore(storeFileOf(restoredPaths), { privatePaths: restoredPaths, policy: OFFICIAL_POLICY })
  let pruned
  try {
    pruned = await handle.pruneLogs({ now: '2031-01-01T00:00:00.000Z', retention: { receipts: { days: 0, count: 1 }, opLog: { days: 0, count: 1 } } })
  } finally { await handle.close() }
  assert.ok(pruned.receipts > 0 && pruned.opLog > 0, JSON.stringify(pruned))
  await survives('prune the restored store\'s history', { at: restored, page: false })

  assert.equal(steps.length, 20)
})

test('the documented way to delete media without a place: give it a place (move, import, re-read), hide it in that city, delete hidden media', async (t) => {
  const library = await servedLibrary(t, 'starmap-media-placeless-delete-')
  const { paths } = library
  const revision = async () => (await library.reading()).revision
  const ok = (response, status = 200) => { assert.equal(response.status, status, JSON.stringify(response.body)); return response.body }
  await makeImage(inboxFile(paths, NO_PLACE_PHOTO), { color: COLOR.purple })
  ok(await library.write('import', {}, 1))
  const assetId = await library.assetAt(NO_PLACE_PHOTO)
  assert.equal((await library.reading()).files.media.items.some((item) => item.id === assetId), false, 'not shown')
  // Move it into Harbor Town's photos and import: the same record, still without a place.
  const inCity = 'MediaInbox/Synthland/Harbor Town/photos/lost.jpg'
  await rename(inboxFile(paths, NO_PLACE_PHOTO), inboxFile(paths, inCity))
  ok(await library.write('import', {}, await revision()))
  assert.equal(await library.assetAt(inCity), assetId, 'a move')
  // Re-read it (the page's scope by media id; the command line takes the path): "none → Harbor Town".
  const preview = ok(await library.post('media/reread/preview', { scope: { mediaId: assetId } }))
  assert.ok(isMediaRereadPreview(preview), JSON.stringify(preview))
  assert.deepEqual(preview.records.map((record) => [record.mediaId, record.changes.find((change) => change.field === 'place')]), [[assetId, { field: 'place', from: null, to: PLACE.harbor }]])
  ok(await library.write('media/reread', { scope: { mediaId: assetId }, planDigest: preview.planDigest }, await revision()))
  assert.equal((await library.reading()).files.media.items.find((item) => item.id === assetId)?.placeId, PLACE.harbor, 'shown in Harbor Town now')
  // Hide it there, then delete hidden media: the record, its source file and its files go.
  const hidden = await library.hide([assetId], await revision())
  ok(await library.write('media/delete', { cityId: PLACE.harbor, ids: [assetId] }, hidden))
  const registry = await library.registry()
  assert.equal(registry.entities.some((entity) => entity.fields.asset === assetId), false)
  assert.equal(await exists(inboxFile(paths, inCity)), false, 'its source file is deleted with it')
  assert.deepEqual([registry.pendingFileOps, registry.problems], [[], []])
})
