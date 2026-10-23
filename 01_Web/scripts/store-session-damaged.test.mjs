/**
 * A damaged store in the new-library mode (3C-4b; design 3B §5 "打开检查失败 → 只读，提示从备份恢复"): when the open check
 * fails with E_STORE_CORRUPT but the store can still be read, the App shows the projected data as usual, the virtual
 * module carries privateStoreReadOnly, and every write endpoint answers 409 E_STORE_READ_ONLY. Corruption found while
 * running does the same from then on.
 *
 * The damage is real and deterministic: the b-tree page header of op_log's root page is overwritten (the projection
 * never reads op_log), and the last writer session is left unclosed, so the next open runs quick_check.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { closeSync, openSync, readFileSync, readSync, writeSync } from 'node:fs'
import { test } from 'node:test'
import { storeFileOf } from './private-data-source.mjs'
import { checkStoreFile } from './store-host.mjs'
import { applyMigration } from './store-migrate.mjs'
import { STORE_BASE_REVISION_HEADER, STORE_REQUEST_ID_HEADER, createStoreSession } from './store-session.mjs'
import { pragmaValue, rawConnection } from './store-sqlite.mjs'
import { servedCanonical } from './private-read-model.fixture.mjs'
import {
  authorizedHeaders, captureMiddleware, editorPrefix, moduleOf, requestTo, sampleV2Files, tempPrivateRoot, writeV2Files,
} from './store-mode.fixture.mjs'
import { readV2 } from '../src/data/canonical/v2Reader.ts'
import { OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'
import { officialViewOf } from '../src/data/store/projectCanonical.ts'

const NOW = '2026-10-15T00:00:00.000Z'
const UPDATE = 'POST /__travelatlas/editor/wanttogo/update'
let counter = 0
const requestId = () => `01960000-0000-7000-8000-${(0xdead00 + ++counter).toString(16).padStart(12, '0')}`
const headers = (id, base) => ({ [STORE_REQUEST_ID_HEADER]: id, [STORE_BASE_REVISION_HEADER]: String(base) })
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

async function migrated(t) {
  const context = await tempPrivateRoot(t, 'starmap-store-damaged-')
  const files = sampleV2Files()
  await writeV2Files(context.paths, files)
  await applyMigration(context.paths, { now: NOW })
  return { ...context, files, file: storeFileOf(context.paths), wish: files.wantToGo.items[0] }
}

/**
 * Test-only damage: overwrite the b-tree page header of `table`'s root page with 0xff bytes, and advance the file change
 * counter (header offsets 24 and 92) the way any other writer would, so that an open connection drops its page cache.
 */
function damagePage(file, table) {
  const db = rawConnection(file, { readOnly: true })
  const pageSize = pragmaValue(db, 'page_size')
  const rootPage = db.prepare('SELECT rootpage FROM sqlite_schema WHERE name = ?').get(table).rootpage
  db.close()
  const fd = openSync(file, 'r+')
  try {
    writeSync(fd, Buffer.alloc(16, 0xff), 0, 16, (rootPage - 1) * pageSize)
    const changes = Buffer.alloc(4)
    readSync(fd, changes, 0, 4, 24)
    changes.writeUInt32BE((changes.readUInt32BE(0) + 1) >>> 0)
    writeSync(fd, changes, 0, 4, 24)
    writeSync(fd, changes, 0, 4, 92)
  } finally { closeSync(fd) }
}
/** Leave the last writer session marked as not closed (as a killed dev server does): the next writable open runs quick_check. */
function markUnclean(file) {
  const db = rawConnection(file)
  try { db.exec('UPDATE store_meta SET clean_shutdown = 0') } finally { db.close() }
}

test('a damaged page found by the open check: the store opens read-only, the data still projects, writes are E_STORE_READ_ONLY, a replay still answers', async (t) => {
  const context = await migrated(t)
  const { paths, file, wish } = context
  // One committed request before the damage, to replay afterwards.
  const before = createStoreSession(paths, { log: () => {}, now: () => NOW })
  const committedId = requestId()
  const committed = await before.writeRoute(...UPDATE.split(' '))({ headers: headers(committedId, 1), input: { id: wish.id, note: 'Synthetic before damage' } })
  assert.equal(committed.status, 200, JSON.stringify(committed.body))
  const expected = officialViewOf((await before.moduleExports()).model, 'local')
  await before.close()

  markUnclean(file)
  damagePage(file, 'op_log')
  assert.deepEqual((await checkStoreFile(file, { policy: OFFICIAL_POLICY })).ok, false, 'library:recover sees the damage')
  const bytes = sha256(file)

  const lines = []
  const session = context.closeAfter(createStoreSession(paths, { log: (line) => lines.push(line), now: () => NOW }))
  const read = await session.moduleExports()
  assert.equal(read.readOnly, true)
  assert.equal(read.revision, 2)
  assert.deepEqual(officialViewOf(read.model, 'local'), expected, 'the data projects as before')
  assert.equal(await session.isDamaged(), true)
  assert.match(lines[0], /^\[StarMap store\] 新库没有通过打开检查（E_STORE_CORRUPT），以只读方式打开：.*E_STORE_READ_ONLY.*npm run store:restore/)

  // Every editor write is refused, confirmed not committed; the replay of the committed request answers with its receipt.
  const writes = [
    [UPDATE, { id: wish.id, note: 'Synthetic after damage' }],
    ['POST /__travelatlas/editor/wanttogo', { placeId: context.files.places.places[0].id }],
    ['POST /__travelatlas/editor/countries', { countryCode: 'JP', visitedDate: '2026-04-01' }],
    ['POST /__travelatlas/editor/wanttogo/delete', { ids: [wish.id] }],
  ]
  for (const [route, input] of writes) {
    const refused = await session.writeRoute(...route.split(' '))({ headers: headers(requestId(), 2), input })
    assert.equal(refused.status, 409, route)
    assert.equal(refused.body.code, 'E_STORE_READ_ONLY', route)
    assert.match(refused.body.error, /新库可能已损坏，当前只读，本次没有保存。请从备份恢复：npm run store:restore/)
  }
  const replay = await session.writeRoute(...UPDATE.split(' '))({ headers: headers(committedId, 1), input: { id: wish.id, note: 'Synthetic before damage' } })
  assert.equal(replay.status, 200)
  assert.equal(replay.body.duplicate, true)
  assert.deepEqual(replay.body.receipt, committed.body.receipt)
  await session.idle()
  assert.equal(session.pruneState.runs, 0, 'a read-only store is never pruned')
  await session.close()
  assert.equal(sha256(file), bytes, 'not a byte written')
})

test('corruption found while running turns the session read-only: the write that meets it fails, later writes are E_STORE_READ_ONLY', async (t) => {
  const context = await migrated(t)
  const { paths, file, wish } = context
  const session = context.closeAfter(createStoreSession(paths, { log: () => {}, now: () => NOW, prune: false }))
  assert.equal((await session.moduleExports()).readOnly, false)
  damagePage(file, 'op_log')
  const update = session.writeRoute(...UPDATE.split(' '))
  const failed = await update({ headers: headers(requestId(), 1), input: { id: wish.id, note: 'Synthetic meets the damage' } })
  assert.equal(failed.status, 500, JSON.stringify(failed.body))
  assert.equal(failed.body.code, 'E_STORE_FAILED')
  assert.equal(failed.body.params.code, 'E_STORE_CORRUPT')
  const read = await session.moduleExports()
  assert.equal(read.readOnly, true)
  assert.equal(read.revision, 1)
  const refused = await update({ headers: headers(requestId(), 1), input: { id: wish.id, note: 'Synthetic later' } })
  assert.equal(refused.status, 409)
  assert.equal(refused.body.code, 'E_STORE_READ_ONLY')
  await session.close()
  // The session was not closed cleanly: the next open checks the file, finds the damage and opens read-only again.
  const again = context.closeAfter(createStoreSession(paths, { log: () => {} }))
  assert.equal((await again.moduleExports()).readOnly, true)
})

test('the plugin: the virtual module exports privateStoreReadOnly, every write endpoint (media included) is 409 E_STORE_READ_ONLY, reads work', async (t) => {
  const context = await migrated(t)
  const { root, file, wish } = context
  markUnclean(file)
  damagePage(file, 'op_log')
  const originalEnvironment = process.env
  process.env = { STARMAP_PRIVATE_ROOT: root }
  try {
    const { travelAtlasLocalEditor } = await import('./local-editor-plugin.mjs')
    const plugin = travelAtlasLocalEditor({ profile: 'personal', privateRoot: root })
    context.closeAfter({ close: () => plugin.buildEnd() })
    const module = await moduleOf(plugin)
    assert.equal(module.privateStoreReadOnly, true)
    assert.equal(module.privateStoreRevision, 1)
    assert.deepEqual(servedCanonical(module), readV2(context.files))
    const handler = captureMiddleware(plugin).handlers[1]
    // Reads work (3C-5 E: the read model's endpoint; GET /state is gone).
    const read = await requestTo(handler, { url: `${editorPrefix}read-model`, method: 'GET', headers: {} })
    assert.equal(read.status, 200)
    const protocol = { ...authorizedHeaders, ...headers(requestId(), 1) }
    const editor = await requestTo(handler, { url: `${editorPrefix}wanttogo/update`, headers: protocol, content: Buffer.from(JSON.stringify({ id: wish.id, note: 'Synthetic' })) })
    assert.deepEqual([editor.status, editor.body.code], [409, 'E_STORE_READ_ONLY'])
    for (const route of ['upload', 'import', 'media/delete', 'media/jobs']) {
      const media = await requestTo(handler, { url: editorPrefix + route, content: Buffer.from('{') })
      assert.deepEqual([media.status, media.body.code], [409, 'E_STORE_READ_ONLY'], route)
      assert.equal(media.bodyReads, 0, route)
    }
  } finally {
    process.env = originalEnvironment
  }
})
