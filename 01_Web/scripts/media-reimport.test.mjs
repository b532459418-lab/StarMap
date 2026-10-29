/**
 * Re-importing (3C-5 F) in the media service, on temporary private roots with a migrated synthetic library served by
 * the plugin (./store-media.fixture.mjs) where a record was deleted for good and its file put back: the candidates,
 * the explicit-only import (the given file only; the rest of the Inbox, the registry and the scan cache left alone),
 * the preview digest checked under the lease, and the file never deleted by its own restoration.
 */
import assert from 'node:assert/strict'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { COLOR, PLACE, imageBytes, inboxFile, makeImage, writeJson } from './media-inbox.fixture.mjs'
import { withLibraryOperation } from './library-operation-lock.mjs'
import { createMediaService, handleMediaStore } from './media-service.mjs'
import { storeFileOf } from './private-data-source.mjs'
import { openStore } from './store-host.mjs'
import { NOW, UUID_V7, exists, servedLibrary } from './store-media.fixture.mjs'
import { pathKeyOf } from './store-media-registry.mjs'
import { projectToV2Files } from './compat/store-projection.mjs'
import { uuidv7 } from '../src/data/canonical/uuidv7.ts'
import { OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'

/** The media service on the library under the lease; `wrap` changes the store adapter (a failure injected at commit). */
const withService = (paths, callback, { wrap = (store) => store } = {}) => withLibraryOperation(paths, async (leaseToken) => {
  const handle = openStore(storeFileOf(paths), { privatePaths: paths, policy: OFFICIAL_POLICY, writerSession: false })
  try {
    return await callback(createMediaService({ privatePaths: paths, store: wrap(handleMediaStore(handle)) }), leaseToken)
  } finally { await handle.close() }
})
const candidates = (paths, cityId) => withService(paths, (service) => service.listReimportable({ cityId }))
const preview = (paths, portable, options = {}) => withService(paths, (service) => service.planReimport({ paths: [portable], ...options }))
const reimport = (paths, portable, planDigest, extra = {}, options) => withService(paths, (service, leaseToken) => service.reimportFiles({
  paths: [portable], planDigest, requestId: extra.requestId ?? uuidv7(), leaseToken, ...extra,
}), options)

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
/** Everything a refused or failed re-import must leave as it was. */
const written = (state) => ({ revision: state.revision, files: state.files, registry: state.registry })
const BACKUP_MARK = ['operations', 'store-backup', '01960000-0000-7000-8000-00000000b001.json']

/**
 * A served library where the record of b.jpg (a Harbor Town photo; `pano`: the River Town panorama) was deleted for
 * good. `queued`: a backup copied media meanwhile, so the deletion of the files waits (the file stays, its
 * delete-source queued) and the backup is over afterwards; otherwise the file was deleted and is put back.
 */
async function deletedAndBack(t, prefix, { which = 'b', queued = false } = {}) {
  const library = await servedLibrary(t, prefix)
  const { paths, inbox, root } = library
  const target = inbox[which]
  const bytes = await readFile(inboxFile(paths, target))
  const asset = await library.assetAt(target)
  const mark = path.join(root, ...BACKUP_MARK)
  if (queued) await writeJson(mark, { format: 'starmap.store-backup.media-copy', backupId: '01960000-0000-7000-8000-00000000b001', startedAt: NOW, pid: 1 })
  const hidden = await library.write('view', { operations: [{ op: 'hide', scope: which === 'pano' ? 'drone' : 'media', add: [asset], remove: [] }] }, 1)
  assert.equal(hidden.status, 200, JSON.stringify(hidden.body))
  const deleted = await library.write('media/delete', { cityId: which === 'pano' ? PLACE.river : PLACE.harbor, ids: [asset] }, hidden.body.revision)
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body))
  await library.plugin.buildEnd()
  if (queued) await unlink(mark)
  else {
    assert.equal(await exists(inboxFile(paths, target)), false, 'the deletion removed the file')
    await writeFile(inboxFile(paths, target), bytes)
  }
  return { ...library, target, bytes, asset }
}

test('candidates, and a re-import of the given file only: a new record at the end of its city order, nothing else of the Inbox, registry or scan cache changed', async (t) => {
  const { paths, target, bytes, asset, generated } = await deletedAndBack(t, 'starmap-media-reimport-write-')
  const again = 'MediaInbox/Synthland/Harbor Town/photos/b-again.jpg'
  await writeFile(inboxFile(paths, again), bytes)
  const unrelated = 'MediaInbox/Synthland/Hill Town/photos/new.jpg'
  await makeImage(inboxFile(paths, unrelated), { color: COLOR.purple })
  const listed = await candidates(paths, PLACE.harbor)
  assert.deepEqual(listed.candidates.map((item) => [item.relativePath, item.reason, item.cityId, item.pendingDeletion]), [
    ['Synthland/Harbor Town/photos/b-again.jpg', 'new-path', PLACE.harbor, false],
    ['Synthland/Harbor Town/photos/b.jpg', 'same-path', PLACE.harbor, false],
  ])
  assert.equal(listed.otherCities, 0)
  assert.deepEqual([(await candidates(paths, PLACE.river)).candidates, (await candidates(paths, PLACE.river)).otherCities], [[], 2])
  // An ordinary import still skips the file put back (rule 3 unchanged).
  const ordinary = await withService(paths, (service) => service.planImport({ blockOnWarnings: false }))
  assert.deepEqual(ordinary.classification.deletedSkips.map((item) => item.fact.path), [target])

  const before = await storeState(paths)
  const plan = await preview(paths, target)
  assert.match(plan.digest, /^[0-9a-f]{64}$/)
  assert.deepEqual(plan.files.map((file) => [file.path, file.reason]), [['Synthland/Harbor Town/photos/b.jpg', 'same-path']])
  assert.deepEqual(plan.records.map((record) => [record.cityId, record.kind, record.reusesFiles]), [[PLACE.harbor, 'photo', false]])
  assert.equal(plan.otherNewFiles, 2, 'b-again (to confirm) and new.jpg: shown, not imported')
  assert.deepEqual(written(await storeState(paths)), written(before), 'a preview writes nothing')

  const requestId = uuidv7()
  const result = await reimport(paths, target, plan.digest, { requestId, baseRevision: before.revision })
  assert.equal(result.committed, true)
  const after = await storeState(paths)
  const restored = assetAt(after, target)
  assert.match(restored, UUID_V7)
  assert.notEqual(restored, asset)
  assert.equal(after.files.editorState.mediaOrderByCity[PLACE.harbor].at(-1), restored, 'appended to its city order')
  const content = after.registry.sources.find((source) => source.pathKey === pathKeyOf(target) && source.state === 'present').sha256
  assert.ok(await exists(generated(content)), 'its generated files exist again')
  // Only that file: its new source; the deleted one stays deleted; the other files and the scan cache are untouched.
  const added = after.registry.sources.filter((source) => !before.registry.sources.some((old) => old.seq === source.seq))
  assert.deepEqual(added.map((source) => [source.path, source.state]), [[target, 'present']])
  assert.deepEqual(after.registry.sources.filter((source) => before.registry.sources.some((old) => old.seq === source.seq)), before.registry.sources)
  assert.deepEqual(after.registry.scanCache, before.registry.scanCache)
  assert.equal(after.files.media.items.length, before.files.media.items.length + 1)
  assert.deepEqual(after.problems, [])
  // A retry answers the receipt; the same id for another request is a conflict.
  const retried = await reimport(paths, target, plan.digest, { requestId, baseRevision: before.revision })
  assert.deepEqual([retried.duplicate, retried.receipt.revision], [true, after.revision])
  await assert.rejects(reimport(paths, target, plan.digest, { requestId, baseRevision: before.revision, kind: 'starmap.media.reimport@other' }), { code: 'E_OPERATION_CONFLICT' })
  // The file is a source now: no longer a candidate, and an ordinary import does not skip it any more.
  assert.deepEqual((await candidates(paths, PLACE.harbor)).candidates.map((item) => item.relativePath), ['Synthland/Harbor Town/photos/b-again.jpg'])

  // The same content at a new path: its generated files are reused.
  const second = await preview(paths, again)
  assert.deepEqual([second.files[0].reason, second.records[0].reusesFiles], ['new-path', true])
  assert.equal((await reimport(paths, again, second.digest)).committed, true)
  const last = await storeState(paths)
  assert.equal(last.files.media.items.length, before.files.media.items.length + 2)
  assert.notEqual(assetAt(last, again), restored)
  assert.equal(last.registry.sources.some((source) => source.pathKey === pathKeyOf(unrelated)), false, 'the unrelated file is still not imported')
  assert.deepEqual(last.problems, [])
})

test('only files deleted for good and back: a live source, a file never deleted and a missing path are refused; the command line takes any Inbox file', async (t) => {
  const { paths, inbox } = await deletedAndBack(t, 'starmap-media-reimport-eligible-')
  const fresh = 'MediaInbox/Synthland/Harbor Town/photos/fresh.jpg'
  await makeImage(inboxFile(paths, fresh), { color: COLOR.purple })
  const before = await storeState(paths)
  await assert.rejects(preview(paths, inbox.a), { code: 'E_MEDIA_REIMPORT_NOT_DELETED', params: { reason: 'live' } })
  await assert.rejects(preview(paths, fresh), { code: 'E_MEDIA_REIMPORT_NOT_DELETED', params: { reason: 'not-deleted' } })
  await assert.rejects(preview(paths, 'MediaInbox/Synthland/Harbor Town/photos/never.jpg'), { code: 'E_MEDIA_REIMPORT_NOT_DELETED', params: { reason: 'missing' } })
  // A digest of another file does not open a way in either.
  const plan = await preview(paths, inbox.b)
  await assert.rejects(reimport(paths, fresh, plan.digest), { code: 'E_MEDIA_REIMPORT_NOT_DELETED' })
  await assert.rejects(reimport(paths, inbox.b, undefined), { code: 'E_REQUEST_INVALID' })
  assert.deepEqual(written(await storeState(paths)), written(before))
  // The command line's scope: any Inbox file; a live one has nothing to create.
  const any = await preview(paths, fresh, { onlyDeleted: false })
  assert.deepEqual([any.files[0].reason, any.records.length], ['any', 1])
  assert.equal((await reimport(paths, fresh, any.digest, { onlyDeleted: false })).committed, true)
  const live = await preview(paths, inbox.a, { onlyDeleted: false })
  assert.deepEqual([live.files[0].reason, live.records.length], ['live', 0])
  assert.equal((await reimport(paths, inbox.a, live.digest, { onlyDeleted: false })).committed, false)
})

test('a stale preview is refused before anything is written; other new files and confirmations elsewhere do not matter', async (t) => {
  const { paths, inbox, target, bytes } = await deletedAndBack(t, 'starmap-media-reimport-stale-')
  const stale = async (change, expected, why) => {
    const plan = await preview(paths, target)
    await change()
    const before = await storeState(paths)
    await assert.rejects(reimport(paths, target, plan.digest), { code: expected }, why)
    assert.deepEqual(written(await storeState(paths)), written(before), `${why}: nothing written`)
  }
  // Another commit moves the revision (a re-read of another city).
  await writeJson(path.join(paths.inboxRoot, 'Second Land', 'River Town', 'media.json'), { 'drone/pano-1.jpg': { kind: 'panorama360', titleEn: 'Other', date: '2026-07-03', resolution: '200 × 100' } })
  await stale(async () => {
    const plan = await withService(paths, (service) => service.planReread({ scope: { cityId: PLACE.river } }))
    assert.equal((await withService(paths, (service, leaseToken) => service.rereadDescriptions({ scope: { cityId: PLACE.river }, planDigest: plan.digest, requestId: uuidv7(), leaseToken }))).committed, true)
  }, 'E_MEDIA_PREVIEW_STALE', 'revision')
  // Its folder binding changes (the description of the file: its place).
  const placeFile = path.join(paths.inboxRoot, 'Synthland', 'Harbor Town', 'place.json')
  const binding = await readFile(placeFile)
  await stale(() => writeJson(placeFile, { placeId: PLACE.hill }), 'E_MEDIA_PREVIEW_STALE', 'description')
  await writeFile(placeFile, binding)
  // Its content changes: it is no longer a file deleted before (eligibility comes first).
  await stale(async () => writeFile(inboxFile(paths, target), await imageBytes({ color: COLOR.grey })), 'E_MEDIA_REIMPORT_NOT_DELETED', 'content')
  await writeFile(inboxFile(paths, target), bytes)
  // It moves away.
  const away = 'MediaInbox/Synthland/Harbor Town/photos/b-away.jpg'
  await stale(() => rename(inboxFile(paths, target), inboxFile(paths, away)), 'E_MEDIA_REIMPORT_NOT_DELETED', 'moved')
  await rename(inboxFile(paths, away), inboxFile(paths, target))

  // A new file elsewhere and a confirmation elsewhere after the preview: the re-import still writes only the file.
  const plan = await preview(paths, target)
  const unrelated = 'MediaInbox/Synthland/Hill Town/photos/new.jpg'
  await makeImage(inboxFile(paths, unrelated), { color: COLOR.purple })
  await writeFile(inboxFile(paths, inbox.a), await imageBytes({ color: COLOR.yellow, width: 90 }))
  const before = await storeState(paths)
  const sourceA = before.registry.sources.find((source) => source.pathKey === pathKeyOf(inbox.a))
  assert.equal((await reimport(paths, target, plan.digest)).committed, true)
  const after = await storeState(paths)
  assert.equal(after.files.media.items.length, before.files.media.items.length + 1)
  assert.equal(after.registry.sources.some((source) => source.pathKey === pathKeyOf(unrelated)), false, 'the new file is not imported')
  assert.deepEqual(after.registry.sources.find((source) => source.seq === sourceA.seq), sourceA, 'the replaced file\'s source is not marked missing')
  assert.deepEqual(after.registry.scanCache, before.registry.scanCache)
  assert.deepEqual(after.problems, [])
})

test('a re-import never deletes the file it restores: a queued delete-source of that path and content is cancelled (no backup copying)', async (t) => {
  const { paths, target, asset, generated } = await deletedAndBack(t, 'starmap-media-reimport-queued-', { queued: true })
  let state = await storeState(paths)
  const queued = state.registry.pendingFileOps.map((operation) => [operation.kind, operation.target])
  assert.deepEqual(queued.map(([kind]) => kind).sort(), ['delete-generated', 'delete-source'])
  assert.ok(await exists(inboxFile(paths, target)), 'the deletion waited')
  const listed = await candidates(paths, PLACE.harbor)
  assert.deepEqual(listed.candidates.map((item) => [item.relativePath, item.pendingDeletion]), [['Synthland/Harbor Town/photos/b.jpg', true]])
  const plan = await preview(paths, target)
  assert.deepEqual([plan.files[0].pendingDeletion, plan.records[0].reusesFiles], [true, true])
  assert.equal((await reimport(paths, target, plan.digest)).committed, true)
  assert.ok(await exists(inboxFile(paths, target)), 'the file stays')
  state = await storeState(paths)
  const restored = assetAt(state, target)
  assert.match(restored, UUID_V7)
  assert.notEqual(restored, asset)
  assert.deepEqual(state.registry.pendingFileOps.map((operation) => operation.kind), ['delete-generated'], 'the delete-source is cancelled')
  // The next media operation runs the queue: the generated files are linked again, so their deletion is cancelled too.
  const drained = await withService(paths, (service, leaseToken) => service.drain(leaseToken))
  assert.deepEqual([drained.cancelled, drained.deletedDirectories, drained.deletedSources], [1, 0, 0])
  state = await storeState(paths)
  assert.deepEqual(state.registry.pendingFileOps, [])
  const content = state.registry.sources.find((source) => source.pathKey === pathKeyOf(target) && source.state === 'present').sha256
  assert.ok(await exists(path.join(generated(content), state.registry.files.find((file) => file.sha256 === content).outputs[0].name)))
  assert.ok(await exists(inboxFile(paths, target)))
  assert.deepEqual(state.problems, [])
})

test('a failure at the commit writes nothing: the file stays in the Inbox, the store and the registry unchanged', async (t) => {
  const { paths, target } = await deletedAndBack(t, 'starmap-media-reimport-failure-', { queued: true })
  const before = await storeState(paths)
  const plan = await preview(paths, target)
  const failing = (store) => ({ ...store, commit: async () => { throw Object.assign(new Error('injected'), { code: 'E_INJECTED' }) } })
  await assert.rejects(reimport(paths, target, plan.digest, {}, { wrap: failing }), { code: 'E_INJECTED' })
  assert.ok(await exists(inboxFile(paths, target)), 'the file stays')
  assert.deepEqual(written(await storeState(paths)), written(before), 'store and registry unchanged, the queued deletions included')
  // The preview is still good: the same digest writes now.
  assert.equal((await reimport(paths, target, plan.digest)).committed, true)
})
