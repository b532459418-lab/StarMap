/**
 * Re-reading descriptions (3C-5 F) in the media service, on temporary private roots with a migrated synthetic library
 * (./media-inbox.fixture.mjs): scopes, field differences, the preview digest, and the write that computes the plan again
 * under the library lease and refuses any difference (E_MEDIA_PREVIEW_STALE) without writing a thing.
 */
import assert from 'node:assert/strict'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { COLOR, PLACE, imageBytes, importedV2Library, inboxFile, writeJson } from './media-inbox.fixture.mjs'
import { withLibraryOperation } from './library-operation-lock.mjs'
import { createMediaService, handleMediaStore } from './media-service.mjs'
import { storeFileOf } from './private-data-source.mjs'
import { openStore } from './store-host.mjs'
import { NOW } from './store-media.fixture.mjs'
import { pathKeyOf } from './store-media-registry.mjs'
import { applyMigration } from './compat/store-migrate.mjs'
import { projectToV2Files } from './compat/store-projection.mjs'
import { tempPrivateRoot } from './store-mode.fixture.mjs'
import { uuidv7 } from '../src/data/canonical/uuidv7.ts'
import { OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'

async function migratedLibrary(t, prefix) {
  const context = await tempPrivateRoot(t, prefix)
  const inbox = await importedV2Library(context.paths, { now: NOW })
  await applyMigration(context.paths, { now: NOW })
  return { ...context, inbox }
}

/** The media service on the library under the lease (as media:import runs it); `wrap` changes the store adapter. */
const withService = (paths, callback, { wrap = (store) => store, readImage } = {}) => withLibraryOperation(paths, async (leaseToken) => {
  const handle = openStore(storeFileOf(paths), { privatePaths: paths, policy: OFFICIAL_POLICY, writerSession: false })
  try {
    return await callback(createMediaService({ privatePaths: paths, store: wrap(handleMediaStore(handle)), ...(readImage ? { readImage } : {}) }), leaseToken)
  } finally { await handle.close() }
})
const preview = (paths, scope, options) => withService(paths, (service) => service.planReread({ scope }), options)
const reread = (paths, scope, planDigest, extra = {}) => withService(paths, (service, leaseToken) => service.rereadDescriptions({ scope, planDigest, requestId: extra.requestId ?? uuidv7(), leaseToken, ...extra }))

/** The store as a read-only connection sees it: revision, V2 view, registry, entities, check problems. */
async function storeState(paths) {
  const handle = openStore(storeFileOf(paths), { readOnly: true, policy: OFFICIAL_POLICY })
  try {
    const rows = handle.readRowsUnchecked()
    return { revision: rows.revision, files: projectToV2Files(rows).files, registry: handle.mediaRegistry(), entities: handle.mediaEntities(), problems: handle.check().problems }
  } finally { await handle.close() }
}
const assetAt = (state, portable) => {
  const source = state.registry.sources.find((item) => item.pathKey === pathKeyOf(portable) && item.state === 'present')
  return state.entities.find((entity) => entity.id === source?.recordId)?.fields.asset
}
const mediaOf = (state, id) => state.files.media.items.find((item) => item.id === id)
/** What a refused write must leave as it was. */
const written = (state) => ({ revision: state.revision, files: state.files, sources: state.registry.sources, assetFiles: state.registry.assetFiles })

test('a city\'s re-read: field differences with the store\'s values, a digest, and a write of exactly the previewed changes; retries and refusals', async (t) => {
  const { paths, inbox } = await migratedLibrary(t, 'starmap-media-reread-write-')
  const sidecar = path.join(paths.inboxRoot, 'Second Land', 'River Town', 'media.json')
  await writeJson(sidecar, { 'drone/pano-1.jpg': { kind: 'panorama360', titleEn: 'Synthetic panorama, renamed', date: '2026-08-01', resolution: '200 × 100' } })
  const before = await storeState(paths)
  const pano = assetAt(before, inbox.pano)
  const plan = await preview(paths, { cityId: PLACE.river })
  assert.match(plan.digest, /^[0-9a-f]{64}$/)
  assert.deepEqual([plan.revision, plan.scope, plan.libraryId.length > 0], [before.revision, { cityId: PLACE.river }, true])
  assert.deepEqual(plan.records.map((record) => [record.assetId, record.placeId, record.sources]), [[pano, PLACE.river, ['Second Land/River Town/drone/pano-1.jpg']]])
  assert.deepEqual(plan.records[0].diff, [
    { field: 'date', from: '2026-07-03', to: '2026-08-01' },
    { field: 'title', from: { names: { en: 'Synthetic panorama' } }, to: { names: { en: 'Synthetic panorama, renamed' } } },
  ])
  assert.deepEqual([plan.conflicts, plan.problems, plan.withoutSource], [[], [], []])
  // The same record by media id: the same changes, another scope, so another digest.
  const byId = await preview(paths, { mediaIds: [pano] })
  assert.deepEqual(byId.records.map((record) => record.diff), plan.records.map((record) => record.diff))
  assert.notEqual(byId.digest, plan.digest)
  assert.equal((await preview(paths, { cityId: PLACE.river })).digest, plan.digest, 'the same state gives the same digest')

  // Refusals before anything is written: no digest, a page on another revision, a read-only store.
  await assert.rejects(reread(paths, { cityId: PLACE.river }, undefined), { code: 'E_REQUEST_INVALID' })
  await assert.rejects(reread(paths, { cityId: PLACE.river }, plan.digest, { baseRevision: before.revision + 5 }), { code: 'E_STALE' })
  const readOnly = openStore(storeFileOf(paths), { readOnly: true, policy: OFFICIAL_POLICY })
  try {
    await assert.rejects(createMediaService({ privatePaths: paths, store: handleMediaStore(readOnly) }).rereadDescriptions({ scope: { cityId: PLACE.river }, planDigest: plan.digest, requestId: uuidv7() }), { code: 'E_STORE_READ_ONLY' })
  } finally { await readOnly.close() }
  assert.deepEqual(written(await storeState(paths)), written(before))

  const requestId = uuidv7()
  const result = await reread(paths, { cityId: PLACE.river }, plan.digest, { requestId, baseRevision: before.revision, kind: 'starmap.media.reread@test' })
  assert.equal(result.committed, true)
  assert.deepEqual(result.updatedIds, [pano])
  const after = await storeState(paths)
  assert.equal(after.revision, before.revision + 1)
  assert.deepEqual([mediaOf(after, pano).date, mediaOf(after, pano).title], ['2026-08-01', { names: { en: 'Synthetic panorama, renamed' } }])
  const source = after.registry.sources.find((item) => item.pathKey === pathKeyOf(inbox.pano))
  assert.equal(source.descriptionDigest, plan.records[0].sourceFacts[0].descriptionDigest, 'the source records the description it now has')
  // Everything else is as it was.
  assert.deepEqual(after.files.media.items.filter((item) => item.id !== pano), before.files.media.items.filter((item) => item.id !== pano))
  assert.deepEqual(after.problems, [])
  // A retry with the same request id answers the receipt; the same id for another request is a conflict.
  const retried = await reread(paths, { cityId: PLACE.river }, plan.digest, { requestId, baseRevision: before.revision, kind: 'starmap.media.reread@test' })
  assert.deepEqual([retried.duplicate, retried.receipt.revision], [true, after.revision])
  await assert.rejects(reread(paths, { cityId: PLACE.river }, plan.digest, { requestId, baseRevision: before.revision, kind: 'starmap.media.reread@other' }), { code: 'E_OPERATION_CONFLICT' })
  assert.equal((await storeState(paths)).revision, after.revision)
  // Nothing to change any more: no commit.
  const again = await preview(paths, { cityId: PLACE.river })
  assert.deepEqual(again.records.map((record) => record.changes), [[]])
  const nothing = await reread(paths, { cityId: PLACE.river }, again.digest)
  assert.deepEqual([nothing.committed, nothing.updatedIds], [false, []])
  assert.equal((await storeState(paths)).revision, after.revision)
})

test('a stale preview is refused and nothing is written: revision, sidecar, file content, file moved, a source registered meanwhile, conflicts, scope', async (t) => {
  const { paths, inbox } = await migratedLibrary(t, 'starmap-media-reread-stale-')
  const harbor = { cityId: PLACE.harbor }
  const river = { cityId: PLACE.river }
  const riverSidecar = path.join(paths.inboxRoot, 'Second Land', 'River Town', 'media.json')
  const panorama = (date) => writeJson(riverSidecar, { 'drone/pano-1.jpg': { kind: 'panorama360', titleEn: 'Synthetic panorama', date, resolution: '200 × 100' } })
  const importNow = () => withService(paths, (service, leaseToken) => service.importInbox({ requestId: uuidv7(), leaseToken, blockOnWarnings: false }))
  const stale = async (scope, change, why) => {
    const plan = await preview(paths, scope)
    await change()
    const before = await storeState(paths)
    await assert.rejects(reread(paths, scope, plan.digest), { code: 'E_MEDIA_PREVIEW_STALE' }, why)
    assert.deepEqual(written(await storeState(paths)), written(before), `${why}: nothing written`)
    return plan
  }
  const state = await storeState(paths)
  const assetA = assetAt(state, inbox.a)
  const assetB = assetAt(state, inbox.b)
  const harborPlan = await preview(paths, harbor)
  assert.deepEqual(harborPlan.records.map((record) => [record.assetId, record.changes]).sort(), [[assetA, []], [assetB, []]].sort())

  // The sidecar of a record that had no change: it would now be written.
  assert.deepEqual((await preview(paths, river)).records.map((record) => record.changes), [[]])
  await stale(river, () => panorama('2026-08-01'), 'sidecar')
  // The content of a source file.
  const bytes = await readFile(inboxFile(paths, inbox.b))
  await stale(harbor, async () => writeFile(inboxFile(paths, inbox.b), await imageBytes({ color: COLOR.grey })), 'content')
  await writeFile(inboxFile(paths, inbox.b), bytes)
  // A conflict appears: a-copy.jpg (a second source of a.jpg's record) moves into Hill Town's folder, and an import
  // registers the move (a registry-only commit: the revision stays). Then it goes again.
  const copyInHill = 'MediaInbox/Synthland/Hill Town/photos/a-copy.jpg'
  await stale(harbor, async () => {
    await rename(inboxFile(paths, inbox.aCopy), inboxFile(paths, copyInHill))
    const revision = (await storeState(paths)).revision
    assert.equal((await importNow()).committed, true)
    assert.equal((await storeState(paths)).revision, revision, 'a move keeps the revision')
  }, 'a conflict appears')
  const conflicted = await preview(paths, harbor)
  assert.deepEqual(conflicted.conflicts.map((conflict) => [conflict.assetId, conflict.sources.map((source) => source.path).sort()]),
    [[assetA, ['Synthland/Harbor Town/photos/a.jpg', 'Synthland/Hill Town/photos/a-copy.jpg']]])
  await stale(harbor, async () => {
    await rename(inboxFile(paths, copyInHill), inboxFile(paths, inbox.aCopy))
    assert.equal((await importNow()).committed, true)
  }, 'the conflict goes')
  assert.deepEqual((await preview(paths, harbor)).conflicts, [])
  // Another commit (another city's re-read) moves the revision.
  await stale(harbor, async () => {
    const plan = await preview(paths, river)
    assert.equal((await reread(paths, river, plan.digest)).committed, true)
  }, 'revision')
  // A file moved: its source is missing now; then an import registers the move.
  await stale(harbor, () => rename(inboxFile(paths, inbox.b), inboxFile(paths, 'MediaInbox/Synthland/Harbor Town/photos/b-moved.jpg')), 'moved')
  await stale(harbor, async () => assert.equal((await importNow()).committed, true), 'a source registered meanwhile')
  // The digest belongs to its scope.
  const plan = await preview(paths, harbor)
  await assert.rejects(reread(paths, { mediaIds: [assetB] }, plan.digest), { code: 'E_MEDIA_PREVIEW_STALE' })
  // The current preview is accepted.
  assert.equal((await reread(paths, harbor, plan.digest)).committed, false)
  assert.deepEqual((await storeState(paths)).problems, [])
})

test('scopes: unknown media and places are refused; a city takes the records whose file lies in its folder, and lists those without a source', async (t) => {
  const { paths, inbox } = await migratedLibrary(t, 'starmap-media-reread-scope-')
  await assert.rejects(preview(paths, { mediaIds: ['01960000-0000-7000-8000-00000000dead'] }), { code: 'E_MEDIA_NOT_FOUND' })
  await assert.rejects(preview(paths, { cityId: PLACE.synthland }), { code: 'E_UNKNOWN_PLACE_REF' })
  await assert.rejects(preview(paths, { cityId: '01960000-0000-7000-8000-00000000dead' }), { code: 'E_UNKNOWN_PLACE_REF' })
  await assert.rejects(preview(paths, {}), { code: 'E_REQUEST_INVALID' })
  await assert.rejects(preview(paths, { mediaIds: [] }), { code: 'E_REQUEST_INVALID' })
  const state = await storeState(paths)
  const assetC = assetAt(state, inbox.c)
  const assetB = assetAt(state, inbox.b)
  // c.jpg moves into Harbor Town's folder: an import keeps its place (Hill Town) and its source follows.
  const movedC = 'MediaInbox/Synthland/Harbor Town/photos/c.jpg'
  await rename(inboxFile(paths, inbox.c), inboxFile(paths, movedC))
  // b.jpg leaves the Inbox: its source becomes missing.
  await unlink(inboxFile(paths, inbox.b))
  assert.equal((await withService(paths, (service, leaseToken) => service.importInbox({ requestId: uuidv7(), leaseToken, blockOnWarnings: false }))).committed, true)
  const harbor = await preview(paths, { cityId: PLACE.harbor })
  const c = harbor.records.find((record) => record.assetId === assetC)
  assert.deepEqual([c.placeId, c.diff.find((entry) => entry.field === 'place')], [PLACE.hill, { field: 'place', from: PLACE.hill, to: PLACE.harbor }])
  assert.deepEqual(harbor.withoutSource.map((record) => record.assetId), [assetB])
  const hill = await preview(paths, { cityId: PLACE.hill })
  assert.deepEqual(hill.records.map((record) => record.assetId), [assetC], 'the city of its place lists it too')
})

test('dimensions: a record whose source has its asset\'s content takes the stored ones; otherwise the image is read', async (t) => {
  const { paths, inbox } = await migratedLibrary(t, 'starmap-media-reread-dimensions-')
  let reads = 0
  const readImage = async () => { reads += 1; return { width: 200, height: 100 } }
  const plan = await preview(paths, { cityId: PLACE.river }, { readImage })
  assert.equal(plan.records.length, 1)
  assert.equal(reads, 0, 'the stored dimensions of the same content')
  const pano = assetAt(await storeState(paths), inbox.pano)
  // Without the asset's link to that content, the file is read.
  const unlinked = (store) => ({ ...store, mediaRegistry: () => { const registry = store.mediaRegistry(); return { ...registry, assetFiles: registry.assetFiles.filter((link) => link.assetId !== pano) } } })
  const read = await preview(paths, { cityId: PLACE.river }, { readImage, wrap: unlinked })
  assert.equal(reads, 1)
  assert.deepEqual(read.records.map((record) => record.diff), plan.records.map((record) => record.diff))
  // The panorama check still applies to what was read: not 2:1 is a problem, nothing to write.
  const square = await preview(paths, { cityId: PLACE.river }, { readImage: async () => ({ width: 100, height: 100 }), wrap: unlinked })
  assert.deepEqual([square.records, square.problems.map((problem) => problem.reason)], [[], ['unreadable']])
})
