/**
 * The three media endpoints in the new-library mode (3C-4c, design v2 §3 and §4; review §8), through the plugin itself
 * (its middleware and its virtual module, no server) on temporary private roots: a V2 library the V2 importer built from
 * synthetic images (./media-inbox.fixture.mjs), then migrated.
 *
 * - Import: upload then import with the uploaded path (an explicit addition at the end of its city order), a retry, a
 *   retry with another body, a stale base; R17 on the real request chain (a missing file's content uploaded is a new
 *   record, the same bytes put back by hand are the old record's move); a folder binding and a replaced file that block;
 *   the Inbox files rewritable and deletable right after an import (sharp keeps none open; this file does not touch
 *   sharp's cache itself).
 * - Deletion: hidden media deleted with their sources; a generated directory another record still links stays; a
 *   backup copying media pauses the file deletions and the next media write completes them.
 * - The library lease and a read-only store.
 */
import assert from 'node:assert/strict'
import { copyFile, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { withLibraryOperation } from './library-operation-lock.mjs'
import { COLOR, PLACE, imageBytes, importedV2Library, inboxFile, makeImage, writeJson } from './media-inbox.fixture.mjs'
import { createMediaService, handleMediaStore } from './media-service.mjs'
import { storeFileOf } from './private-data-source.mjs'
import { backupStore } from './store-backup.mjs'
import { openStore } from './store-host.mjs'
import { NOW, UUID_V7, exists, servedLibrary } from './store-media.fixture.mjs'
import { pathKeyOf } from './store-media-registry.mjs'
import { applyMigration } from './compat/store-migrate.mjs'
import { tempPrivateRoot, treeDigest } from './store-mode.fixture.mjs'
import { OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'

test('store-mode media import through the plugin', async (t) => {
  const library = await servedLibrary(t, 'starmap-store-media-import-')
  const { paths, inbox } = library
  let uploadedId
  const firstImport = { id: undefined, input: undefined }

  await t.test('upload, then import with the uploaded path: a new record at the end of its city order', async () => {
    const before = await library.reading()
    assert.equal(before.revision, 1)
    const uploaded = await library.upload(await imageBytes({ color: COLOR.purple }), { fileName: 'synthetic-upload.jpg' })
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body))
    assert.equal(uploaded.body.sourcePath, 'Synthland/Harbor Town/photos/synthetic-upload.jpg')
    assert.equal((await library.reading()).revision, 1, 'an upload commits nothing')
    firstImport.id = library.nextId()
    firstImport.input = { sourcePaths: [uploaded.body.sourcePath] }
    const imported = await library.write('import', firstImport.input, 1, firstImport.id)
    assert.equal(imported.status, 200, JSON.stringify(imported.body))
    assert.equal(imported.body.ok, true)
    assert.equal(imported.body.revision, 2)
    assert.equal(imported.body.duplicate, false)
    assert.equal(typeof imported.body.output, 'string')
    assert.equal(imported.body.restoredMediaIds.length, 1)
    uploadedId = imported.body.restoredMediaIds[0]
    assert.match(uploadedId, UUID_V7, 'a new record has a UUIDv7 asset id')
    const after = await library.reading()
    assert.equal(after.revision, 2)
    assert.equal(after.files.media.items.length, before.files.media.items.length + 1)
    const item = after.files.media.items.find((candidate) => candidate.id === uploadedId)
    assert.equal(item.placeId, PLACE.harbor)
    assert.equal(item.kind, 'photo')
    assert.equal(after.files.editorState.mediaOrderByCity[PLACE.harbor].at(-1), uploadedId)
    const registry = await library.registry()
    assert.deepEqual(registry.problems, [])
    assert.equal(await library.assetAt(`MediaInbox/${uploaded.body.sourcePath}`), uploadedId)
    const source = registry.sources.find((candidate) => candidate.pathKey === pathKeyOf(`MediaInbox/${uploaded.body.sourcePath}`))
    assert.equal(source.state, 'present')
    assert.ok((await readdir(library.generated(source.sha256))).length >= 2, 'the original and its derivatives')
  })

  await t.test('the same request again: the same answer; another body under its id: E_OPERATION_CONFLICT; a stale base: E_STALE', async () => {
    const before = await library.dataDigest()
    const replay = await library.write('import', firstImport.input, 1, firstImport.id)
    assert.equal(replay.status, 200, JSON.stringify(replay.body))
    assert.equal(replay.body.duplicate, true)
    assert.equal(replay.body.revision, 2)
    assert.deepEqual(replay.body.restoredMediaIds, [uploadedId])
    const conflict = await library.write('import', { sourcePaths: [] }, 1, firstImport.id)
    assert.equal(conflict.status, 409)
    assert.equal(conflict.body.code, 'E_OPERATION_CONFLICT')
    const stale = await library.write('import', {}, 1)
    assert.equal(stale.status, 409)
    assert.equal(stale.body.code, 'E_STALE')
    assert.equal((await library.reading()).revision, 2)
    assert.deepEqual(await library.dataDigest(), before)
  })

  await t.test('R17 on the request chain: a missing file\'s content uploaded is a new record; the same bytes put back by hand are a move', async () => {
    const bytes = await readFile(inboxFile(paths, inbox.b))
    const oldAsset = await library.assetAt(inbox.b)
    const oldSource = (await library.registry()).sources.find((source) => source.pathKey === pathKeyOf(inbox.b))
    const count = (await library.reading()).files.media.items.length
    await unlink(inboxFile(paths, inbox.b))
    const uploaded = await library.upload(bytes, { fileName: 'b-uploaded.jpg' })
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body))
    // Without the explicit path this scan would pair the file with b's missing source (a move); explicit, it is new.
    const imported = await library.write('import', { sourcePaths: [uploaded.body.sourcePath] }, 2)
    assert.equal(imported.status, 200, JSON.stringify(imported.body))
    assert.equal(imported.body.revision, 3)
    const [newAsset] = imported.body.restoredMediaIds
    assert.match(newAsset, UUID_V7)
    assert.notEqual(newAsset, oldAsset)
    let registry = await library.registry()
    const uploadedSource = registry.sources.find((source) => source.pathKey === pathKeyOf(`MediaInbox/${uploaded.body.sourcePath}`))
    assert.equal(uploadedSource.sha256, oldSource.sha256, 'the same content')
    assert.notEqual(uploadedSource.recordId, oldSource.recordId, 'two sources of one content are two records (D2, R17)')
    assert.equal(registry.sources.find((source) => source.seq === oldSource.seq).state, 'missing')
    assert.equal((await library.reading()).files.media.items.length, count + 1)
    assert.deepEqual(registry.problems, [])

    // The same bytes put back by hand under another name: the old record's source moved, no new record.
    const byHand = 'MediaInbox/Synthland/Harbor Town/photos/b-by-hand.jpg'
    await writeFile(inboxFile(paths, byHand), bytes)
    const moved = await library.write('import', {}, 3)
    assert.equal(moved.status, 200, JSON.stringify(moved.body))
    assert.equal(moved.body.revision, 3, 'a move changes the registry only: the revision stays (the receipt is written)')
    assert.equal(typeof moved.body.receipt?.requestId, 'string')
    assert.deepEqual(moved.body.restoredMediaIds, [])
    assert.match(moved.body.output, /移动 1/)
    registry = await library.registry()
    const movedSource = registry.sources.find((source) => source.seq === oldSource.seq)
    assert.equal(movedSource.pathKey, pathKeyOf(byHand))
    assert.equal(movedSource.state, 'present')
    assert.equal(await library.assetAt(byHand), oldAsset)
    assert.equal((await library.reading()).files.media.items.length, count + 1)
  })

  const hillPin = path.join(paths.inboxRoot, 'Synthland', 'Hill Town', 'place.json')
  const fileD = 'MediaInbox/Synthland/Hill Town/photos/d.jpg'
  const fileE = 'MediaInbox/Synthland/Hill Town/photos/e.jpg'
  await t.test('a folder binding to confirm blocks the import: 400 E_MEDIA_IMPORT_BLOCKED, nothing written', async () => {
    await unlink(hillPin)
    await makeImage(inboxFile(paths, fileD), { color: COLOR.grey })
    // e.jpg: a.jpg's content by hand. Content the library has already: a new record (D2) whose files exist, so the
    // import only reads its header (libvips then keeps the file open unless its file cache is off).
    await copyFile(inboxFile(paths, inbox.a), inboxFile(paths, fileE))
    const before = await library.dataDigest()
    const blocked = await library.write('import', {}, 3)
    assert.equal(blocked.status, 400, JSON.stringify(blocked.body))
    assert.equal(blocked.body.code, 'E_MEDIA_IMPORT_BLOCKED')
    assert.match(blocked.body.details, /待确认的文件夹绑定/)
    assert.equal((await library.reading()).revision, 3)
    assert.deepEqual(await library.dataDigest(), before, 'no place.json, no generated file, no commit')
  })

  await t.test('files a scan found are not added to a city order; right after the import the Inbox files can be rewritten and deleted', async () => {
    await writeJson(hillPin, { placeId: PLACE.hill })
    const imported = await library.write('import', {}, 3)
    assert.equal(imported.status, 200, JSON.stringify(imported.body))
    assert.equal(imported.body.revision, 4)
    const assetD = await library.assetAt(fileD)
    const assetE = await library.assetAt(fileE)
    assert.match(assetD, UUID_V7)
    assert.match(assetE, UUID_V7)
    const order = (await library.reading()).files.editorState.mediaOrderByCity[PLACE.hill] ?? []
    assert.equal(order.includes(assetD) || order.includes(assetE), false)
    // The import read both files (d.jpg: dimensions and derivatives; e.jpg: its header only). Windows refuses to
    // rewrite or delete a file libvips still holds open; the service keeps none (releaseImageFiles: sharp.cache(false)).
    await writeFile(inboxFile(paths, fileD), await imageBytes({ color: COLOR.yellow }))
    await unlink(inboxFile(paths, fileE))
  })

  await t.test('§8-1: a file replaced at its path needs confirming (409 E_MEDIA_SOURCE_MATCHES_UNCONFIRMED); acceptSourceMatches imports it as a new record', async () => {
    const before = await library.dataDigest()
    const count = (await library.reading()).files.media.items.length
    const assetD = await library.assetAt(fileD)
    const unconfirmed = await library.write('import', {}, 4)
    assert.equal(unconfirmed.status, 409, JSON.stringify(unconfirmed.body))
    assert.equal(unconfirmed.body.code, 'E_MEDIA_SOURCE_MATCHES_UNCONFIRMED')
    assert.match(unconfirmed.body.details, /同一路径的文件内容变了/)
    assert.equal((await library.reading()).revision, 4)
    assert.deepEqual(await library.dataDigest(), before)
    const confirmed = await library.write('import', { acceptSourceMatches: true }, 4)
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body))
    assert.equal(confirmed.body.revision, 5)
    const after = await library.reading()
    assert.equal(after.files.media.items.length, count + 1, 'the replacing file is a new record; the old one stays')
    assert.ok(after.files.media.items.some((item) => item.id === assetD))
    const replacing = await library.assetAt(fileD)
    assert.match(replacing, UUID_V7)
    assert.notEqual(replacing, assetD)
    const registry = await library.registry()
    assert.equal(registry.sources.find((source) => source.pathKey === pathKeyOf(fileE)).state, 'missing')
    assert.deepEqual(registry.problems, [])
  })

  await t.test('an uploaded path the Inbox no longer has: E_MEDIA_IMPORT_NO_RECORD before anything is written', async () => {
    const before = await library.dataDigest()
    const refused = await library.write('import', { sourcePaths: ['Synthland/Harbor Town/photos/never-uploaded.jpg'] }, 5)
    assert.equal(refused.status, 400, JSON.stringify(refused.body))
    assert.equal(refused.body.code, 'E_MEDIA_IMPORT_NO_RECORD')
    assert.deepEqual(await library.dataDigest(), before)
  })

  await t.test('the library lease: a media write while another operation holds it is 409 E_LIBRARY_BUSY', async () => {
    const before = await library.dataDigest()
    await withLibraryOperation(paths, async () => {
      for (const [route, input] of [['import', {}], ['media/delete', { cityId: PLACE.harbor, ids: [uploadedId] }]]) {
        const refused = await library.write(route, input, 5)
        assert.equal(refused.status, 409, route)
        assert.equal(refused.body.code, 'E_LIBRARY_BUSY')
      }
      const upload = await library.upload(await imageBytes({ color: COLOR.red }), { fileName: 'busy.jpg' })
      assert.equal(upload.status, 409)
      assert.equal(upload.body.code, 'E_LIBRARY_BUSY')
    })
    assert.deepEqual(await library.dataDigest(), before)
  })
})

test('store-mode deletion of hidden media through the plugin', async (t) => {
  const library = await servedLibrary(t, 'starmap-store-media-delete-')
  const { paths, inbox, directory } = library
  const contentA = (await library.registry()).sources.find((source) => source.pathKey === pathKeyOf(inbox.a)).sha256
  let revision = 1

  await t.test('a content another record still links keeps its generated directory; the last record takes it and every source', async () => {
    // The same content as a.jpg uploaded: a second record (D2) linked to the same generated directory.
    const uploaded = await library.upload(await readFile(inboxFile(paths, inbox.a)), { fileName: 'a-again.jpg' })
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body))
    const imported = await library.write('import', { sourcePaths: [uploaded.body.sourcePath] }, revision)
    assert.equal(imported.status, 200, JSON.stringify(imported.body))
    revision = imported.body.revision
    const [again] = imported.body.restoredMediaIds
    const original = await library.assetAt(inbox.a)
    assert.equal(await library.assetAt(inbox.aCopy), original, 'V2 merged a.jpg and a-copy.jpg into one record')
    assert.notEqual(again, original)

    const notHidden = await library.write('media/delete', { cityId: PLACE.harbor, ids: [again] }, revision)
    assert.equal(notHidden.status, 400, JSON.stringify(notHidden.body))
    assert.equal(notHidden.body.code, 'E_MEDIA_DELETE_NOT_HIDDEN')

    revision = await library.hide([again], revision)
    const first = await library.write('media/delete', { cityId: PLACE.harbor, ids: [again] }, revision)
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.deepEqual(first.body.deletedIds, [again])
    assert.equal(first.body.deletedSourceFiles, 1)
    revision = first.body.revision
    assert.equal(await exists(path.join(paths.inboxRoot, ...uploaded.body.sourcePath.split('/'))), false)
    assert.equal(await exists(library.generated(contentA)), true, 'a.jpg\'s record still links the directory')
    let registry = await library.registry()
    assert.deepEqual(registry.problems, [])
    assert.deepEqual(registry.pendingFileOps, [])
    assert.equal(registry.sources.find((source) => source.pathKey === pathKeyOf(`MediaInbox/${uploaded.body.sourcePath}`)).state, 'deleted')
    let reading = await library.reading()
    assert.equal(reading.revision, revision)
    assert.equal(reading.files.media.items.some((item) => item.id === again), false)
    assert.equal(reading.files.editorState.hiddenMediaIds.includes(again), false)
    assert.equal(reading.files.editorState.mediaOrderByCity[PLACE.harbor]?.includes(again) ?? false, false)

    revision = await library.hide([original], revision)
    const second = await library.write('media/delete', { cityId: PLACE.harbor, ids: [original] }, revision)
    assert.equal(second.status, 200, JSON.stringify(second.body))
    assert.equal(second.body.deletedSourceFiles, 2, 'a.jpg and a-copy.jpg')
    revision = second.body.revision
    for (const file of [inbox.a, inbox.aCopy]) assert.equal(await exists(inboxFile(paths, file)), false)
    assert.equal(await exists(library.generated(contentA)), false)
    registry = await library.registry()
    assert.deepEqual(registry.problems, [])
    assert.deepEqual(registry.pendingFileOps, [])
    assert.equal(registry.files.some((file) => file.sha256 === contentA), false)
    reading = await library.reading()
    assert.equal(reading.files.media.items.some((item) => item.id === original), false)
  })

  await t.test('a backup copying media pauses the file deletions; the backup has the files; the next media write completes them', async () => {
    const bFile = inboxFile(paths, inbox.b)
    const assetB = await library.assetAt(inbox.b)
    const contentB = (await library.registry()).sources.find((source) => source.pathKey === pathKeyOf(inbox.b)).sha256
    revision = await library.hide([assetB], revision)
    let during
    const backup = await backupStore(paths, {
      out: path.join(directory, 'backup'), now: NOW,
      onMediaCopy: async () => {
        during = await library.write('media/delete', { cityId: PLACE.harbor, ids: [assetB] }, revision)
        assert.equal(during.status, 200, JSON.stringify(during.body))
        assert.equal(during.body.deletedSourceFiles, 0)
        assert.match(during.body.output, /备份正在复制媒体/)
        assert.equal(await exists(bFile), true)
        assert.equal((await library.registry()).pendingFileOps.length, 2, 'the source and the generated directory wait')
      },
    })
    revision = during.body.revision
    assert.ok(backup.manifest.media.entries.some((entry) => entry.path === inbox.b), 'the backup copied the file the deletion waited for')
    assert.equal(await exists(bFile), true)
    // The next media write drains the queue first.
    const next = await library.write('import', {}, revision)
    assert.equal(next.status, 200, JSON.stringify(next.body))
    assert.equal(await exists(bFile), false)
    assert.equal(await exists(library.generated(contentB)), false)
    const registry = await library.registry()
    assert.deepEqual(registry.pendingFileOps, [])
    assert.deepEqual(registry.problems, [])
    await rm(path.join(directory, 'backup'), { recursive: true, force: true })
  })
})

test('the media service on a read-only store refuses imports and deletions: E_STORE_READ_ONLY', async (t) => {
  const { paths, closeAfter } = await tempPrivateRoot(t, 'starmap-store-media-readonly-')
  await importedV2Library(paths, { now: NOW })
  await applyMigration(paths, { now: NOW })
  const before = await treeDigest(paths.root)
  const handle = closeAfter(openStore(storeFileOf(paths), { readOnly: true, policy: OFFICIAL_POLICY }))
  const service = createMediaService({ privatePaths: paths, store: handleMediaStore(handle) })
  await assert.rejects(service.importInbox({ requestId: '01960000-0000-7000-8000-0000000000f1' }), { code: 'E_STORE_READ_ONLY' })
  await assert.rejects(service.deleteMedia({ requestId: '01960000-0000-7000-8000-0000000000f2', input: { cityId: PLACE.harbor, ids: ['x'] } }), { code: 'E_STORE_READ_ONLY' })
  assert.deepEqual(await treeDigest(paths.root), before)
})
