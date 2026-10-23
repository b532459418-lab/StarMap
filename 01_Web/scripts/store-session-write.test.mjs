/**
 * The want-to-go update of the new-library mode through the session's handler (what the plugin calls for
 * POST /__travelatlas/editor/wanttogo/update): the request protocol, the outcomes and the replay of a committed request.
 * Since 3C-5 C1 its planner is store-native (src/data/editor/native/wantToGo.ts); the other seven endpoints are in
 * store-session-editor.test.mjs.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withLibraryOperation } from './library-operation-lock.mjs'
import { storeFileOf } from './private-data-source.mjs'
import { applyMigration } from './store-migrate.mjs'
import { STORE_BASE_REVISION_HEADER, STORE_REQUEST_ID_HEADER, STORE_WRITE_ROUTES, createStoreSession, storeProtocolOf } from './store-session.mjs'
import { rawConnection } from './store-sqlite.mjs'
import { sampleV2Files, tempPrivateRoot, treeDigest, writeV2Files } from './store-mode.fixture.mjs'
import { NATIVE_WRITES } from '../src/data/editor/native/routes.ts'
import { officialViewOf } from '../src/data/store/projectCanonical.ts'

const NOW = '2026-10-14T00:00:00.000Z'
const ROUTE = 'POST /__travelatlas/editor/wanttogo/update'
let counter = 0
const requestId = () => `01960000-0000-7000-8000-${(++counter).toString(16).padStart(12, '0')}`
const headers = (id, base) => ({ [STORE_REQUEST_ID_HEADER]: id, [STORE_BASE_REVISION_HEADER]: String(base) })

async function storeSession(t) {
  const context = await tempPrivateRoot(t, 'starmap-store-write-')
  const files = sampleV2Files()
  await writeV2Files(context.paths, files)
  await applyMigration(context.paths, { now: NOW })
  const session = context.closeAfter(createStoreSession(context.paths, { log: () => {}, now: () => '2026-10-15T00:00:00.000Z' }))
  const update = session.writeRoute(...ROUTE.split(' '))
  const items = async () => officialViewOf((await session.moduleExports()).model, 'local').wantToGo.items
  return { ...context, files, session, update, items, wish: files.wantToGo.items[0] }
}

test('the eight editor endpoints are the store write routes (media is not)', () => {
  assert.deepEqual(Object.keys(STORE_WRITE_ROUTES).sort(), Object.keys(NATIVE_WRITES).sort())
  assert.ok(Object.keys(STORE_WRITE_ROUTES).includes(ROUTE))
})

test('a note and the hidden state are saved, the response is the planner\'s item plus the receipt, and the revision moves by one each', async (t) => {
  const { update, items, wish, session } = await storeSession(t)
  const id = requestId()
  const saved = await update({ headers: headers(id, 1), input: { id: wish.id, note: '  Synthetic note  ' } })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  assert.equal(saved.body.ok, true)
  assert.equal(saved.body.revision, 2)
  assert.equal(saved.body.duplicate, false)
  assert.equal(saved.body.receipt.requestId, id)
  assert.equal(saved.body.receipt.baseRevision, 1)
  assert.equal(saved.body.item.id, wish.id)
  assert.equal(saved.body.item.note, 'Synthetic note')
  assert.equal(typeof saved.body.item.place.nameEn, 'string')
  assert.equal((await items()).find((item) => item.id === wish.id).note, 'Synthetic note')
  assert.equal((await session.moduleExports()).revision, 2)

  const hidden = await update({ headers: headers(requestId(), 2), input: { id: wish.id, hidden: true } })
  assert.equal(hidden.status, 200)
  assert.equal(hidden.body.item.hidden, true)
  const shown = await update({ headers: headers(requestId(), 3), input: { id: wish.id, hidden: false, note: '' } })
  assert.equal(shown.body.revision, 4)
  const item = (await items()).find((candidate) => candidate.id === wish.id)
  assert.equal(item.hidden, false)
  assert.equal(Object.hasOwn(item, 'note'), false)
})

test('the same request id again answers with the original receipt and writes nothing; different content is E_OPERATION_CONFLICT', async (t) => {
  const { update, wish, session, root } = await storeSession(t)
  const id = requestId()
  const first = await update({ headers: headers(id, 1), input: { id: wish.id, note: 'Synthetic once' } })
  assert.equal(first.status, 200)
  const before = await treeDigest(root)
  const replay = await update({ headers: headers(id, 1), input: { id: wish.id, note: 'Synthetic once' } })
  assert.equal(replay.status, 200)
  assert.equal(replay.body.duplicate, true)
  assert.deepEqual(replay.body.receipt, first.body.receipt)
  assert.equal(replay.body.revision, 2)
  assert.equal((await session.moduleExports()).revision, 2)
  for (const [input, base] of [[{ id: wish.id, note: 'Synthetic other' }, 1], [{ id: wish.id, note: 'Synthetic once' }, 2], [{ id: wish.id, note: 'Synthetic once', hidden: false }, 1]]) {
    const conflict = await update({ headers: headers(id, base), input })
    assert.equal(conflict.status, 409, JSON.stringify(input))
    assert.equal(conflict.body.code, 'E_OPERATION_CONFLICT')
  }
  assert.deepEqual(await treeDigest(root), before)
})

test('a stale or missing base revision is E_STALE; malformed headers and inputs are refused; nothing is written', async (t) => {
  const { update, wish, root, session } = await storeSession(t)
  assert.equal((await update({ headers: headers(requestId(), 1), input: { id: wish.id, note: 'Synthetic first' } })).status, 200)
  const before = await treeDigest(root)
  const cases = [
    [headers(requestId(), 1), { id: wish.id, note: 'Synthetic stale' }, 409, 'E_STALE'],
    [headers(requestId(), 7), { id: wish.id, note: 'Synthetic future' }, 409, 'E_STALE'],
    [{}, { id: wish.id, note: 'Synthetic old page' }, 409, 'E_STALE'],
    [{ [STORE_BASE_REVISION_HEADER]: '2' }, { id: wish.id, note: 'x' }, 409, 'E_STALE'],
    [headers('not-a-uuid', 2), { id: wish.id, note: 'x' }, 400, 'E_REQUEST_INVALID'],
    [headers('01960000-0000-7000-8000-00000000ABCD', 2), { id: wish.id, note: 'x' }, 400, 'E_REQUEST_INVALID'],
    [headers(requestId(), '2.5'), { id: wish.id, note: 'x' }, 400, 'E_REQUEST_INVALID'],
    [headers(requestId(), '-1'), { id: wish.id, note: 'x' }, 400, 'E_REQUEST_INVALID'],
    [headers(requestId(), 2), { id: wish.id }, 400, 'E_WTG_UPDATE_EMPTY'],
    [headers(requestId(), 2), { id: wish.id, hidden: 'yes' }, 400, 'E_HIDDEN_NOT_BOOLEAN'],
    [headers(requestId(), 2), { id: wish.id, note: 'x'.repeat(201) }, 400, 'E_NOTE_TOO_LONG'],
    [headers(requestId(), 2), { id: 'synthetic-missing', note: 'x' }, 400, 'E_WTG_NOT_FOUND'],
  ]
  for (const [requestHeaders, input, status, code] of cases) {
    const result = await update({ headers: requestHeaders, input })
    assert.equal(result.status, status, `${code} ${JSON.stringify(requestHeaders)}`)
    assert.equal(result.body.code, code)
    assert.equal(typeof result.body.error, 'string')
  }
  assert.deepEqual(await treeDigest(root), before)
  assert.equal((await session.moduleExports()).revision, 2)
  assert.deepEqual(storeProtocolOf({ [STORE_REQUEST_ID_HEADER]: [requestId(), requestId()], [STORE_BASE_REVISION_HEADER]: '1' }).failure.body.code, 'E_REQUEST_INVALID')
})

test('while somebody holds the library lock, or another process writes, the update is refused and nothing is written', async (t) => {
  const { update, wish, paths, session } = await storeSession(t)
  await session.open()
  await withLibraryOperation(paths, async () => {
    const busy = await update({ headers: headers(requestId(), 1), input: { id: wish.id, note: 'Synthetic busy' } })
    assert.equal(busy.status, 409)
    assert.equal(busy.body.code, 'E_LIBRARY_BUSY')
  })
  const other = rawConnection(storeFileOf(paths))
  other.exec('BEGIN IMMEDIATE')
  try {
    const locked = await update({ headers: headers(requestId(), 1), input: { id: wish.id, note: 'Synthetic locked' } })
    assert.equal(locked.status, 409)
    assert.equal(locked.body.code, 'E_STORE_BUSY')
  } finally { other.exec('ROLLBACK'); other.close() }
  assert.equal((await session.moduleExports()).revision, 1)
  // Free again: the same action (same request id) can now be saved.
  const id = requestId()
  assert.equal((await update({ headers: headers(id, 1), input: { id: wish.id, note: 'Synthetic later' } })).status, 200)
})
