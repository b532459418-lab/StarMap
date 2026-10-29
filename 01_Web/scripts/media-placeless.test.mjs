/**
 * Media without a place (3C-5 G) in the media service, on temporary private roots with a migrated synthetic library
 * (./media-inbox.fixture.mjs): the Inbox folder `_no-place` (or `_无地点`) and its files, the import of records without
 * a place, moves between it and city folders, re-reading that gives or removes a place, and the preview of a media task
 * listing such a file with placeId null. Synthetic data only.
 */
import assert from 'node:assert/strict'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { COLOR, PLACE, importedV2Library, inboxFile, makeImage, writeJson } from './media-inbox.fixture.mjs'
import { sha256File } from './file-hash.mjs'
import { walkInbox } from './media-inbox.mjs'
import { withLibraryOperation } from './library-operation-lock.mjs'
import { createMediaService, handleMediaStore } from './media-service.mjs'
import { scanInbox } from './media-scan.mjs'
import { storeFileOf } from './private-data-source.mjs'
import { getPrivatePaths } from './private-profile.mjs'
import { openStore } from './store-host.mjs'
import { NOW } from './store-media.fixture.mjs'
import { pathKeyOf } from './store-media-registry.mjs'
import { storeTaskPlanOf } from './store-media-jobs.mjs'
import { applyMigration } from './compat/store-migrate.mjs'
import { exportStoreV2 } from './compat/store-export-v2.mjs'
import { backupStore, restoreStore } from './store-backup.mjs'
import { projectToV2Files } from './compat/store-projection.mjs'
import { tempPrivateRoot } from './store-mode.fixture.mjs'
import { uuidv7 } from '../src/data/canonical/uuidv7.ts'
import { assertMediaJobPreview } from '../src/data/mediaJobs.ts'
import { OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'
import { officialReader } from '../src/data/store/officialReader.ts'
import { filterReadModelForPersonalBuild } from '../src/data/store/personalBuildReadModel.ts'
import { publicReadModelOf } from '../src/data/store/publicReadModel.ts'
import { officialViewOf } from '../src/data/store/projectCanonical.ts'
import { indexReadModel } from '../src/worldgraph/readModel/lookup.ts'
import { createMediaPlaceIndex } from '../src/data/v2media/importPlan.ts'

async function migratedLibrary(t, prefix) {
  const context = await tempPrivateRoot(t, prefix)
  const inbox = await importedV2Library(context.paths, { now: NOW })
  await applyMigration(context.paths, { now: NOW })
  return { ...context, inbox }
}
const withService = (paths, callback) => withLibraryOperation(paths, async (leaseToken) => {
  const handle = openStore(storeFileOf(paths), { privatePaths: paths, policy: OFFICIAL_POLICY, writerSession: false })
  try { return await callback(createMediaService({ privatePaths: paths, store: handleMediaStore(handle) }), leaseToken, handle) } finally { await handle.close() }
})
const importNow = (paths) => withService(paths, (service, leaseToken) => service.importInbox({ requestId: uuidv7(), leaseToken, blockOnWarnings: false }))
async function storeState(paths) {
  const handle = openStore(storeFileOf(paths), { readOnly: true, policy: OFFICIAL_POLICY })
  try {
    const rows = handle.readRowsUnchecked()
    return { revision: rows.revision, rows, files: projectToV2Files(rows).files, registry: handle.mediaRegistry(), entities: handle.mediaEntities(), problems: handle.check().problems, model: handle.readModel() }
  } finally { await handle.close() }
}
const sourceAt = (state, portable) => state.registry.sources.find((item) => item.pathKey === pathKeyOf(portable) && item.state === 'present')
const entityAt = (state, portable) => state.entities.find((entity) => entity.id === sourceAt(state, portable)?.recordId)

const NO_PLACE_PHOTO = 'MediaInbox/_no-place/photos/lost.jpg'
const NO_PLACE_DRONE = 'MediaInbox/_无地点/drone/flight.jpg'

async function writePlaceless(paths) {
  await makeImage(inboxFile(paths, NO_PLACE_PHOTO), { color: COLOR.purple })
  await makeImage(inboxFile(paths, NO_PLACE_DRONE), { color: COLOR.grey, width: 80, height: 40 })
  await writeJson(path.join(paths.inboxRoot, '_无地点', 'media.json'), { 'drone/flight.jpg': { kind: 'aerialPhoto', titleEn: 'Synthetic flight', date: '2026-07-04', resolution: '80 × 40' } })
}

test('the scan: files of _no-place and _无地点 have no place; other _ folders stay ignored; a file at the folder\'s root or a place in its media.json is refused; the V2 walk ignores them', async (t) => {
  const { paths } = await migratedLibrary(t, 'starmap-media-placeless-scan-')
  await writePlaceless(paths)
  await makeImage(inboxFile(paths, 'MediaInbox/_unsorted/photos/other.jpg'), { color: COLOR.red })
  const handle = openStore(storeFileOf(paths), { readOnly: true, policy: OFFICIAL_POLICY })
  let places
  try { places = (await handleMediaStore(handle).official()).reader.places() } finally { await handle.close() }
  let scan = await scanInbox({ privatePaths: paths, places, cache: [] })
  const facts = new Map(scan.facts.map((fact) => [fact.path, fact]))
  assert.deepEqual([NO_PLACE_PHOTO, NO_PLACE_DRONE].map((portable) => [facts.get(portable)?.placeId, facts.get(portable)?.countryFolder, facts.get(portable)?.kind]),
    [[null, null, 'photo'], [null, null, 'aerialPhoto']])
  assert.equal(facts.get(NO_PLACE_DRONE).metadata.titleEn, 'Synthetic flight')
  assert.equal(facts.has('MediaInbox/_unsorted/photos/other.jpg'), false, 'other _ folders are still ignored')
  assert.deepEqual(scan.errors, [])
  // A file at the folder's root, and a sidecar entry that names a place: refused (errors).
  await makeImage(path.join(paths.inboxRoot, '_no-place', 'root.jpg'), { color: COLOR.blue })
  await writeJson(path.join(paths.inboxRoot, '_无地点', 'media.json'), { 'drone/flight.jpg': { kind: 'aerialPhoto', placeId: PLACE.harbor } })
  scan = await scanInbox({ privatePaths: paths, places, cache: [] })
  assert.equal(scan.errors.length, 2, scan.errors.join('\n'))
  assert.match(scan.errors.join('\n'), /根目录有 1 个媒体文件/)
  assert.match(scan.errors.join('\n'), /不能给它指定地点/)
  // The V2 importer's walk (compat) does not know the folder.
  const seen = []
  await walkInbox({ inboxRoot: paths.inboxRoot, index: createMediaPlaceIndex(places), errors: [], warnings: [], pins: [], onFile: async ({ filePath }) => { seen.push(filePath) } })
  assert.equal(seen.some((file) => file.includes('_no-place') || file.includes('_无地点')), false)
})

test('the import makes records without a place: no place field, no city order, a report line; the official view leaves them out, placelessMedia lists them; a second import adds nothing', async (t) => {
  const { paths } = await migratedLibrary(t, 'starmap-media-placeless-import-')
  const before = await storeState(paths)
  await writePlaceless(paths)
  const plan = await withService(paths, (service) => service.planImport({ blockOnWarnings: false }))
  const lines = await withService(paths, (service) => service.reportLines(plan))
  assert.match(lines.join('\n'), /没有地点的新资料 2 条/)
  assert.equal((await importNow(paths)).committed, true)
  const after = await storeState(paths)
  for (const portable of [NO_PLACE_PHOTO, NO_PLACE_DRONE]) {
    const entity = entityAt(after, portable)
    assert.ok(entity, portable)
    assert.equal(Object.hasOwn(entity.fields, 'place'), false)
  }
  assert.deepEqual(after.files.media.items.length, before.files.media.items.length, 'not in the official view')
  assert.deepEqual(after.files.editorState.mediaOrderByCity, before.files.editorState.mediaOrderByCity)
  const placeless = officialReader(indexReadModel(after.model)).placelessMedia()
  assert.deepEqual(placeless.map((media) => [media.originalFileName, media.kind]).sort(), [['flight.jpg', 'aerialPhoto'], ['lost.jpg', 'photo']])
  assert.deepEqual(placeless.find((media) => media.kind === 'aerialPhoto').title, { names: { en: 'Synthetic flight' } })
  assert.deepEqual(after.problems, [])
  const again = await importNow(paths)
  assert.equal(again.committed ?? false, false, 'nothing new')
  assert.equal((await storeState(paths)).entities.length, after.entities.length)
})

test('moves between _no-place and a city folder keep the record and its place; a re-read gives the place, and removes it again', async (t) => {
  const { paths } = await migratedLibrary(t, 'starmap-media-placeless-move-')
  await writePlaceless(paths)
  await importNow(paths)
  const record = entityAt(await storeState(paths), NO_PLACE_PHOTO)
  // Into Harbor Town's photos: the same record (a move), still without a place, listed as moved into another city's folder.
  const inCity = 'MediaInbox/Synthland/Harbor Town/photos/lost.jpg'
  await rename(inboxFile(paths, NO_PLACE_PHOTO), inboxFile(paths, inCity))
  const plan = await withService(paths, (service) => service.planImport({ blockOnWarnings: false }))
  assert.deepEqual(plan.classification.moves.map((move) => move.recordId), [record.id])
  assert.deepEqual(plan.classification.crossCity.map((item) => [item.recordId, item.placeId]), [[record.id, null]])
  await importNow(paths)
  let state = await storeState(paths)
  assert.equal(entityAt(state, inCity).id, record.id)
  assert.equal(Object.hasOwn(entityAt(state, inCity).fields, 'place'), false)
  // A re-read of the path gives it Harbor Town (null → place).
  let preview = await withService(paths, (service) => service.planReread({ scope: { paths: [inCity] } }))
  assert.deepEqual(preview.records.map((item) => item.diff.find((entry) => entry.field === 'place')), [{ field: 'place', from: null, to: PLACE.harbor }])
  assert.equal((await withService(paths, (service, leaseToken) => service.rereadDescriptions({ scope: { paths: [inCity] }, planDigest: preview.digest, requestId: uuidv7(), leaseToken }))).committed, true)
  state = await storeState(paths)
  assert.equal(entityAt(state, inCity).fields.place, PLACE.harbor)
  const media = state.files.media.items.find((item) => item.id === entityAt(state, inCity).fields.asset)
  assert.deepEqual([media.placeId, media.isCover], [PLACE.harbor, false], 'in the official view now, not a cover')
  // Back into _no-place: a move again; the re-read by media id removes the place (place → null).
  await rename(inboxFile(paths, inCity), inboxFile(paths, NO_PLACE_PHOTO))
  await importNow(paths)
  const assetId = entityAt(await storeState(paths), NO_PLACE_PHOTO).fields.asset
  preview = await withService(paths, (service) => service.planReread({ scope: { mediaIds: [assetId] } }))
  assert.deepEqual(preview.records[0].diff.find((entry) => entry.field === 'place'), { field: 'place', from: PLACE.harbor, to: null })
  await withService(paths, (service, leaseToken) => service.rereadDescriptions({ scope: { mediaIds: [assetId] }, planDigest: preview.digest, requestId: uuidv7(), leaseToken }))
  state = await storeState(paths)
  assert.equal(Object.hasOwn(entityAt(state, NO_PLACE_PHOTO).fields, 'place'), false)
  assert.equal(state.files.media.items.some((item) => item.id === assetId), false, 'out of the official view again')
  // The re-read accepts a media id without a place (the official view does not have it).
  const again = await withService(paths, (service) => service.planReread({ scope: { mediaIds: [assetId] } }))
  assert.deepEqual(again.records.map((item) => item.changes), [[]])
  assert.deepEqual(state.problems, [])
})

test('a media task\'s preview lists a file of _no-place among the whole Inbox\'s sources with placeId null, and the page accepts it', async (t) => {
  const { paths } = await migratedLibrary(t, 'starmap-media-placeless-task-')
  await writePlaceless(paths)
  const taskFile = 'Synthland/Harbor Town/photos/task.jpg'
  await mkdir(path.dirname(inboxFile(paths, `MediaInbox/${taskFile}`)), { recursive: true })
  await makeImage(inboxFile(paths, `MediaInbox/${taskFile}`), { color: COLOR.yellow })
  const absolute = inboxFile(paths, `MediaInbox/${taskFile}`)
  const job = {
    jobId: '019a0000-0000-7000-8000-000000000a01', cityId: PLACE.harbor, kind: 'photo',
    files: [{ fileId: '019a0000-0000-7000-8000-000000000a02', sourcePath: taskFile, sha256: await sha256File(absolute), bytes: (await stat(absolute)).size }],
  }
  const preview = await withService(paths, async (service, _leaseToken, handle) => {
    const plan = await service.planImport({ explicitPaths: [`MediaInbox/${taskFile}`], blockOnWarnings: true })
    return storeTaskPlanOf({ plan, meta: handle.meta(), job, selectedFileIds: [job.files[0].fileId] })
  })
  const placeless = preview.summary.sources.filter((source) => source.placeId === null).map((source) => source.sourcePath).sort()
  assert.deepEqual(placeless, ['_no-place/photos/lost.jpg', '_无地点/drone/flight.jpg'])
  assert.deepEqual(preview.blockers, [])
  assert.doesNotThrow(() => assertMediaJobPreview({ jobId: job.jobId, revision: 1, selectedFileIds: [job.files[0].fileId], blockers: preview.blockers, plan: { digest: preview.digest, summary: preview.summary } }))
})

test('privacy and export: the public read model and the personal build leave media without a place out, store:export-v2 lists them, a backup checks their files and restores them', async (t) => {
  const { paths, directory } = await migratedLibrary(t, 'starmap-media-placeless-export-')
  await writePlaceless(paths)
  await importNow(paths)
  const state = await storeState(paths)
  const placeless = officialReader(indexReadModel(state.model)).placelessMedia()
  assert.equal(placeless.length, 2)
  const ids = placeless.flatMap((media) => [media.id, media.entityId])
  const directories = placeless.map((media) => media.src.split('/')[3])
  // The public read model: private entities only, so nothing of them.
  const publicText = JSON.stringify(publicReadModelOf(state.model))
  for (const id of ids) assert.equal(publicText.includes(id), false, id)
  // The personal build: neither their rows nor their files; what is shown stays.
  const build = filterReadModelForPersonalBuild(state.model)
  const buildText = JSON.stringify(build.model)
  for (const id of ids) assert.equal(buildText.includes(id), false, id)
  for (const name of ['lost.jpg', 'flight.jpg', 'Synthetic flight']) assert.equal(buildText.includes(name), false, name)
  assert.equal(build.mediaFiles.some((file) => directories.some((directory) => file.startsWith(`${directory}/`))), false)
  assert.ok(build.mediaFiles.length > 0, 'the media with a place keep their files')
  assert.deepEqual(officialReader(indexReadModel(build.model)).placelessMedia(), [])
  assert.deepEqual(officialViewOf(build.model, 'local'), officialViewOf(state.model, 'local'), 'the library hides nothing: the build shows all of it')
  // store:export-v2: valid V2 without them, a line that lists their asset ids, not in the source index, not "added" by V2.
  const exported = await exportStoreV2(paths, { out: path.join(directory, 'export'), now: NOW })
  assert.deepEqual(exported.placeless, placeless.map((media) => media.id))
  const text = exported.lines.join('\n')
  assert.match(text, /没有地点的媒体 2 条/)
  for (const media of placeless) assert.ok(exported.lines.includes(`  媒体 ${media.id}`), media.id)
  for (const name of ['lost.jpg', 'flight.jpg']) assert.equal(text.includes(name), false, `${name}: messages carry ids, never values`)
  assert.equal(exported.files.media.items.some((item) => placeless.some((media) => media.id === item.id)), false)
  assert.equal(Object.keys(exported.index.sourcesById).some((id) => placeless.some((media) => media.id === id)), false)
  assert.deepEqual([exported.losses.added, exported.losses.problems], [[], 0])
  // store:backup checks their files like the others: one missing is refused before the registry check would see it.
  await backupStore(paths, { out: path.join(directory, 'backup'), now: NOW })
  const restored = path.join(directory, 'restored')
  await restoreStore({ from: path.join(directory, 'backup'), to: restored, now: NOW })
  const handle = openStore(storeFileOf(getPrivatePaths({ STARMAP_PRIVATE_ROOT: restored })), { readOnly: true, policy: OFFICIAL_POLICY })
  try { assert.deepEqual(officialReader(indexReadModel(handle.readModel())).placelessMedia(), placeless) } finally { await handle.close() }
  const original = path.join(paths.root, ...placeless[0].src.slice(1).split('/'))
  await unlink(original)
  await assert.rejects(backupStore(paths, { out: path.join(directory, 'backup-2'), now: NOW }), { code: 'E_BACKUP_MEDIA_MISSING' })
})
