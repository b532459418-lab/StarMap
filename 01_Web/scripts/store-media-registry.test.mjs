/**
 * The host's media registry (3C-4c, design v2 §2): the `media` block of a commit, its checks against the state inside
 * the transaction, the digest of requests without one, and check()'s registry rules (review §8-4). Temporary private
 * roots with the neutral 3C-1b edge fixture migrated into a store; invented hashes and paths.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { StoreHostError, rawConnection } from './store-sqlite.mjs'
import { checkStoreFile, openStore, requestDigest } from './store-host.mjs'
import { applyMigration } from './store-migrate.mjs'
import { storeFileOf } from './private-data-source.mjs'
import { directoryOf, pathKeyOf, validMediaBlock } from './store-media-registry.mjs'
import { edgeV2Files, tempPrivateRoot, writeV2Files } from './store-mode.fixture.mjs'
import { OFFICIAL, OFFICIAL_POLICY, VIEW_SCOPES } from '../src/data/store/officialDefinitions.ts'
import { positionBetween } from '../src/worldgraph/store/position.ts'

const NOW = '2026-10-16T00:00:00.000Z'
const sha = (n) => createHash('sha256').update(`synthetic content ${n}`).digest('hex')
const id = (n) => `019a0000-0000-7000-8000-${String(n).padStart(12, '0')}`
const fileBytes = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

/** A migrated store in a temporary private root, opened for writing with the library coordination of that root. */
async function migratedStore(t) {
  const { root, paths, closeAfter } = await tempPrivateRoot(t, 'starmap-media-registry-')
  await writeV2Files(paths, edgeV2Files())
  await applyMigration(paths, { now: NOW })
  const file = storeFileOf(paths)
  const handle = closeAfter(openStore(file, { privatePaths: paths, policy: OFFICIAL_POLICY, now: () => NOW }))
  const rows = handle.readRowsUnchecked()
  const city = rows.entities.find((entity) => entity.typeId === OFFICIAL.place && entity.fields.subtype === 'city')
  const place = rows.entities.find((entity) => entity.typeId === OFFICIAL.place && entity.fields.subtype === 'country')
  return { root, paths, file, handle, city, place }
}

/** Commands of one new store-native media record (asset and entity, UUIDv7, source starmap:user) at the end of the media order. */
function mediaRecord(handle, { assetId, entityId, placeId, content }) {
  const directory = content.slice(0, 16)
  const src = `/media/user/${directory}/original.jpg`
  const last = handle.read((reader) => reader.viewScope(VIEW_SCOPES.mediaOrder).items.map((item) => item.position).sort().at(-1))
  return [
    { op: 'create', table: 'assets', value: { id: assetId, revision: 0, source: { sourceId: OFFICIAL.user, recordId: assetId, evidenceIds: [] }, attributes: {
      kind: 'photo', scope: 'city', src, variants: { thumb: { src: `/media/user/${directory}/thumb.webp`, width: 4, height: 3 }, original: { src, width: 4, height: 3 } },
      width: 4, height: 3, originalFileName: 'synthetic.jpg', isCover: false, status: 'ready',
    } } },
    { op: 'create', table: 'entities', value: { id: entityId, revision: 0, typeId: OFFICIAL.media, title: { names: {} }, fields: { place: placeId, asset: assetId },
      source: { sourceId: OFFICIAL.user, recordId: entityId, evidenceIds: [] }, visibility: 'private' } },
    { op: 'create', table: 'viewItems', value: { id: `${VIEW_SCOPES.mediaOrder}#${assetId}`, revision: 0, scope: VIEW_SCOPES.mediaOrder, itemTable: 'assets', itemId: assetId,
      position: positionBetween(last, undefined), hidden: false } },
  ]
}
const fileEntry = (content) => ({ op: 'put', sha256: content, extension: '.jpg', bytes: 10, outputs: [
  { name: 'original.jpg', sha256: content, bytes: 10 }, { name: 'thumb.webp', sha256: sha(`${content} thumb`), bytes: 5 },
] })
const request = (handle, n, commands, media) => ({
  requestId: id(n), baseRevision: handle.meta().revision, kind: 'test.media', actor: 'test', commands, ...(media === undefined ? {} : { media }),
})
const rejected = (code) => (error) => error instanceof StoreHostError && error.code === code && error.outcome === 'not_committed'

/** One committed record with its file, link, source and scan cache row. */
async function committedRecord(store, n = 1) {
  const { handle, city } = store
  const record = { assetId: id(1000 + n), entityId: id(2000 + n), content: sha(n), path: `MediaInbox/Synthetic/City/photos/p${n}.jpg` }
  const sent = request(handle, n, mediaRecord(handle, { ...record, placeId: city.id }), {
    files: [fileEntry(record.content)],
    assetFiles: [{ op: 'put', assetId: record.assetId, sha256: record.content }],
    sources: [{ op: 'add', path: record.path, sha256: record.content, recordId: record.entityId, state: 'present', descriptionDigest: sha(`${n} description`) }],
    scanCache: [{ op: 'put', path: record.path, size: 10, mtimeMs: 1_700_000_000_000.5, sha256: record.content }],
  })
  const commit = await handle.commit(sent)
  return { ...record, sent, commit }
}

test('a request without a media block keeps exactly the digest it had before 3C-4c; a media block is part of the digest', () => {
  // Computed with the host of e0e5500, before the media block existed (review §5-3: old receipts still answer retries).
  const plain = { requestId: '018f0000-0000-7000-8000-000000000001', baseRevision: 3, kind: 'starmap.editor.state@abc', actor: 'local-editor',
    commands: [{ op: 'remove', table: 'viewItems', id: 'starmap:editor/hidden-media#x', expectedRevision: 2 }] }
  assert.equal(requestDigest(plain), 'a60e7910c1ab5da78736d2da6dcf9155936c8f99001d6c978548de8898b15f93')
  const withMedia = { ...plain, media: validMediaBlock({ scanCache: [{ op: 'remove', pathKey: 'mediainbox/a/b/photos/c.jpg' }] }) }
  assert.notEqual(requestDigest(withMedia), requestDigest(plain))
  // The block is normalized before it is digested: the same operations give the same digest.
  assert.equal(requestDigest({ ...plain, media: validMediaBlock({ scanCache: [{ op: 'remove', pathKey: 'mediainbox/a/b/photos/c.jpg' }], files: [] }) }), requestDigest(withMedia))
})

test('a media block commits with the records it describes, in one transaction, and replays like any request', async (t) => {
  const store = await migratedStore(t)
  const { handle } = store
  const before = handle.meta().revision
  const record = await committedRecord(store)
  assert.equal(record.commit.status, 'committed')
  assert.equal(record.commit.revision, before + 1)
  assert.deepEqual(record.commit.receipt.media, { files: 1, assetFiles: 1, sources: 1, scanCache: 1 })
  const registry = handle.mediaRegistry()
  assert.equal(registry.revision, before + 1)
  assert.deepEqual(registry.files.map(({ sha256, directory }) => ({ sha256, directory })), [{ sha256: record.content, directory: directoryOf(record.content) }])
  assert.deepEqual(registry.assetFiles, [{ assetId: record.assetId, sha256: record.content }])
  assert.deepEqual(registry.sources.map(({ path, pathKey, recordId, state, confirmedRequest }) => ({ path, pathKey, recordId, state, confirmedRequest })),
    [{ path: record.path, pathKey: pathKeyOf(record.path), recordId: record.entityId, state: 'present', confirmedRequest: id(1) }])
  assert.deepEqual(registry.scanCache, [{ pathKey: pathKeyOf(record.path), size: 10, mtimeMs: 1_700_000_000_000.5, sha256: record.content }])
  // The same request again (a lost response): its original receipt, nothing written twice.
  const replay = await handle.commit(record.sent)
  assert.equal(replay.status, 'duplicate')
  assert.deepEqual(replay.receipt, record.commit.receipt)
  // The same request id with another media block is another intent: refused, nothing written.
  await assert.rejects(handle.commit({ ...record.sent, media: { ...record.sent.media, scanCache: [] } }),
    (error) => error instanceof StoreHostError && error.code === 'E_OPERATION_CONFLICT')
  assert.equal(handle.mediaRegistry().sources.length, 1)
  assert.deepEqual(handle.check().problems, [])
})

test('a media block without commands keeps the revision and still writes its receipt (a scan that only moved sources)', async (t) => {
  const store = await migratedStore(t)
  const { handle } = store
  const record = await committedRecord(store)
  const [source] = handle.mediaRegistry().sources
  const revision = handle.meta().revision
  const moved = 'MediaInbox/Synthetic/Renamed city/photos/p1.jpg'
  const result = await handle.commit(request(handle, 5, [], { sources: [{ op: 'update', seq: source.seq, path: moved }] }))
  assert.equal(result.status, 'committed')
  assert.equal(result.revision, revision, 'no row changed: the revision stays')
  assert.equal(handle.lookup(id(5)).found, true)
  const after = handle.mediaRegistry().sources[0]
  assert.deepEqual([after.path, after.pathKey, after.state, after.recordId, after.stateAt], [moved, pathKeyOf(moved), 'present', record.entityId, source.stateAt])
  // A state change records when it happened.
  await handle.commit(request(handle, 6, [], { sources: [{ op: 'update', seq: source.seq, state: 'missing' }] }))
  assert.equal(handle.mediaRegistry().sources[0].state, 'missing')
  // Replaying the move answers with its receipt.
  const replay = await handle.commit({ ...request(handle, 5, [], { sources: [{ op: 'update', seq: source.seq, path: moved }] }), baseRevision: revision })
  assert.equal(replay.status, 'duplicate')
})

test('every block that would break the registry is refused inside the transaction: nothing is written', async (t) => {
  const store = await migratedStore(t)
  const { handle, city, place } = store
  const record = await committedRecord(store)
  const [source] = handle.mediaRegistry().sources
  const snapshot = () => JSON.stringify({ meta: handle.meta(), registry: handle.mediaRegistry() })
  const fresh = { assetId: id(1100), entityId: id(2100), content: sha(100) }
  const cases = [
    ['a link to an asset that does not exist', [], { files: [fileEntry(fresh.content)], assetFiles: [{ op: 'put', assetId: fresh.assetId, sha256: fresh.content }] }],
    ['a link to a file that is not registered', mediaRecord(handle, { ...fresh, placeId: city.id }), { assetFiles: [{ op: 'put', assetId: fresh.assetId, sha256: fresh.content }] }],
    ['a source of an entity that is not media', [], { sources: [{ op: 'add', path: 'MediaInbox/a/b/photos/x.jpg', sha256: fresh.content, recordId: place.id, state: 'present' }] }],
    ['a source of an entity that does not exist', [], { sources: [{ op: 'add', path: 'MediaInbox/a/b/photos/x.jpg', sha256: fresh.content, recordId: id(9999), state: 'missing' }] }],
    ['a second present source at the same path (another case)', [], {
      sources: [{ op: 'add', path: record.path.toUpperCase().replace('MEDIAINBOX', 'MediaInbox'), sha256: fresh.content, recordId: record.entityId, state: 'present' }] }],
    ['a removed asset that keeps its link', removal(handle, record), { sources: [{ op: 'update', seq: source.seq, state: 'deleted' }] }],
    ['a removed media entity that keeps a source', removal(handle, record), { assetFiles: [{ op: 'remove', assetId: record.assetId }] }],
    ['a file that is still linked', [], { files: [{ op: 'remove', sha256: record.content }] }],
    ['another content with the same 64-bit prefix', [], { files: [fileEntry(`${record.content.slice(0, 16)}${'0'.repeat(48)}`)] }],
    ['the same content with other bytes', [], { files: [{ ...fileEntry(record.content), bytes: 11 }] }],
    ['an update of a source that does not exist', [], { sources: [{ op: 'update', seq: 999, state: 'missing' }] }],
    // Without any media block: a request may not write an asset whose files the registry does not know.
    ['a content-addressed asset written without its link', mediaRecord(handle, { ...fresh, placeId: city.id }), undefined],
  ]
  for (const [name, commands, media] of cases) {
    const before = snapshot()
    await assert.rejects(handle.commit(request(handle, 50, commands, media)), rejected('E_MEDIA_REGISTRY'), name)
    assert.equal(snapshot(), before, `${name}: nothing written`)
    assert.equal(handle.lookup(id(50)).found, false, name)
  }
  // A deletion that clears everything it leaves behind commits.
  const deleted = await handle.commit(request(handle, 51, removal(handle, record), {
    assetFiles: [{ op: 'remove', assetId: record.assetId }], files: [{ op: 'remove', sha256: record.content }],
    sources: [{ op: 'update', seq: source.seq, state: 'deleted' }],
    fileOps: [
      { kind: 'delete-source', target: record.path, detail: { sha256: record.content } },
      { kind: 'delete-generated', target: directoryOf(record.content), detail: { sha256: record.content } },
    ],
  }))
  assert.equal(deleted.status, 'committed')
  const registry = handle.mediaRegistry()
  assert.deepEqual([registry.files.length, registry.assetFiles.length, registry.sources[0].state], [0, 0, 'deleted'])
  assert.deepEqual(registry.pendingFileOps.map(({ kind, target, requestId }) => ({ kind, target, requestId })), [
    { kind: 'delete-source', target: record.path, requestId: id(51) },
    { kind: 'delete-generated', target: directoryOf(record.content), requestId: id(51) },
  ])
  assert.deepEqual(handle.check().problems, [])
})

/** Commands removing a committed record: its order row, entity and asset. */
function removal(handle, record) {
  return handle.read((reader) => {
    const rows = [
      ['viewItems', `${VIEW_SCOPES.mediaOrder}#${record.assetId}`], ['entities', record.entityId], ['assets', record.assetId],
    ]
    return rows.map(([table, rowId]) => ({ op: 'remove', table, id: rowId, expectedRevision: reader.get(table, rowId).revision }))
  })
}

test('a malformed media block is refused before the transaction', async (t) => {
  const store = await migratedStore(t)
  const { handle } = store
  const cases = [
    ['an unknown list', { other: [] }],
    ['a hash that is not SHA-256', { files: [{ ...fileEntry(sha(1)), sha256: 'abc' }] }],
    ['a source outside MediaInbox', { sources: [{ op: 'add', path: 'media/user/x.jpg', sha256: sha(1), recordId: id(1), state: 'present' }] }],
    ['a path that leaves its folder', { sources: [{ op: 'add', path: 'MediaInbox/../x.jpg', sha256: sha(1), recordId: id(1), state: 'present' }] }],
    ['an unknown state', { sources: [{ op: 'add', path: 'MediaInbox/a/x.jpg', sha256: sha(1), recordId: id(1), state: 'gone' }] }],
    ['an update that changes nothing', { sources: [{ op: 'update', seq: 1 }] }],
    ['one asset twice', { assetFiles: [{ op: 'remove', assetId: 'a' }, { op: 'remove', assetId: 'a' }] }],
    ['a generated directory outside media/user', { fileOps: [{ kind: 'delete-generated', target: 'MediaInbox/a', detail: {} }] }],
    ['an unknown file operation', { fileOps: [{ kind: 'move', target: 'media/user/a', detail: {} }] }],
    ['a scan cache time that is not a number', { scanCache: [{ op: 'put', path: 'MediaInbox/a/x.jpg', size: 1, mtimeMs: '1', sha256: sha(1) }] }],
  ]
  for (const [name, media] of cases) {
    await assert.rejects(handle.commit(request(handle, 60, [], media)), rejected('E_MEDIA_BLOCK'), name)
  }
  assert.equal(handle.lookup(id(60)).found, false)
})

test('check() reports assets whose files lie elsewhere or are not registered, and a live source without its media entity (review §8-4)', async (t) => {
  const store = await migratedStore(t)
  const record = await committedRecord(store)
  const unlinked = await committedRecord(store, 2)
  await store.handle.close()
  const db = rawConnection(store.file)
  try {
    // A content-addressed asset whose link is gone.
    db.prepare('DELETE FROM media_asset_files WHERE asset_id = ?').run(unlinked.assetId)
    // The asset's thumbnail now points into another directory than the file its link names.
    const body = JSON.parse(db.prepare('SELECT body FROM assets WHERE id = ?').get(record.assetId).body)
    body.attributes.variants.thumb.src = '/media/user/ffffffffffffffff/thumb.webp'
    db.prepare('UPDATE assets SET body = ? WHERE id = ?').run(JSON.stringify(body), record.assetId)
    // A present source names an entity that does not exist.
    db.prepare("INSERT INTO media_sources (path, path_key, sha256, record_id, state, confirmed_request, confirmed_at, state_at) VALUES (?, ?, ?, ?, 'missing', ?, ?, ?)")
      .run('MediaInbox/a/b/photos/q.jpg', 'mediainbox/a/b/photos/q.jpg', sha(7), id(7777), id(1), NOW, NOW)
    // A deleted source may name a removed record: not a problem.
    db.prepare("INSERT INTO media_sources (path, path_key, sha256, record_id, state, confirmed_request, confirmed_at, state_at) VALUES (?, ?, ?, ?, 'deleted', ?, ?, ?)")
      .run('MediaInbox/a/b/photos/r.jpg', 'mediainbox/a/b/photos/r.jpg', sha(8), id(8888), id(1), NOW, NOW)
  } finally { db.close() }
  const before = fileBytes(store.file)
  const check = await checkStoreFile(store.file, { policy: OFFICIAL_POLICY })
  assert.deepEqual(check.problems, ['E_MEDIA_ASSET_DIRECTORY: 2', 'E_MEDIA_SOURCE_RECORD: 1'])
  assert.equal(fileBytes(store.file), before, 'the check writes nothing')
})
