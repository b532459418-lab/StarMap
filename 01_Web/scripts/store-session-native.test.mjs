/**
 * The host's store-native write flow (3C-5 C1 spec §2.1), with a stand-in planner: the protocol headers and the receipt
 * lookup as before, E_STALE against the live index, the planner's refusal as it is, one commit, the live index moved on
 * with the commit's changed rows (equal to the store read again, STARMAP_STORE_VERIFY), and V2 writes that keep working
 * on the same cache.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { storeFileOf } from './private-data-source.mjs'
import { openStore } from './store-host.mjs'
import { applyMigration } from './store-migrate.mjs'
import { STORE_BASE_REVISION_HEADER, STORE_REQUEST_ID_HEADER, createStoreSession } from './store-session.mjs'
import { quietly, tempPrivateRoot, writeV2Files } from './store-mode.fixture.mjs'
import { sequentialUuids } from '../src/data/canonical/v2.fixture.ts'
import { OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'
import { officialViewOf } from '../src/data/store/projectCanonical.ts'
import { fail } from '../src/data/v2write/errors.ts'
import { TEST_CATALOG, WRITE_EPOCH_MS, migratedFiles, placeNamed } from '../src/data/v2write/v2write.fixture.ts'

const MIGRATED_AT = '2026-09-26T00:00:00.000Z'
const ROUTE = 'POST /__travelatlas/editor/wanttogo/update'
let counter = 0
const requestId = () => `01960000-0000-7000-8000-${(++counter).toString(16).padStart(12, '0')}`
const headers = (base, id = requestId()) => ({ [STORE_REQUEST_ID_HEADER]: id, [STORE_BASE_REVISION_HEADER]: String(base) })
const contextOf = (n) => ({ newId: sequentialUuids(WRITE_EPOCH_MS + n * 1000), now: new Date(Date.UTC(2026, 8, 27, 8, n)), countryCatalog: TEST_CATALOG })

/** A stand-in native write: the note of a want-to-go item (the official reader finds it by its V2 id). */
const noteWrite = Object.freeze({
  status: 200,
  plan(reader, input, ctx) {
    const wish = reader.wish(input.id) ?? fail('E_WTG_NOT_FOUND', { id: input.id })
    const { entry } = wish
    const value = { ...entry, revision: entry.revision + 1, fields: { ...entry.fields, note: input.note }, updatedAt: ctx.now.toISOString() }
    return { commands: [{ op: 'update', table: 'entries', id: entry.id, expectedRevision: entry.revision, value }], result: { id: input.id, note: input.note } }
  },
})

/** A session on the migrated fixture; `nativeWrites` replaces the native planners (null: the real ones). */
async function nativeSession(t, nativeWrites = { [ROUTE]: noteWrite }) {
  const context = await tempPrivateRoot(t, 'starmap-store-native-')
  const files = migratedFiles()
  await writeV2Files(context.paths, files)
  await applyMigration(context.paths, { now: MIGRATED_AT })
  const output = quietly()
  const session = context.closeAfter(createStoreSession(context.paths, {
    log: output.log, countryCatalog: TEST_CATALOG, newId: sequentialUuids(Date.UTC(2032, 0, 1)), verify: true, ...(nativeWrites ? { nativeWrites } : {}),
  }))
  const write = (route, input, base, ctx, id) => session.writeRoute(...route.split(' '))({ headers: headers(base, id), input, ctx })
  const storeNow = async () => {
    const handle = openStore(storeFileOf(context.paths), { privatePaths: context.paths, readOnly: true, policy: OFFICIAL_POLICY })
    try { return handle.readModel() } finally { await handle.close() }
  }
  return { ...context, files, session, output, write, storeNow }
}

test('a native write: one commit, the live index moved on (= the store read again), replays and conflicts as before', async (t) => {
  const { session, output, write, files, storeNow } = await nativeSession(t)
  const wish = files.wantToGo.items[0]
  assert.equal((await session.moduleExports()).revision, 1)
  const saved = await write(ROUTE, { id: wish.id, note: 'Synthetic native note' }, 1, contextOf(1))
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  assert.deepEqual({ ...saved.body, receipt: undefined }, { ok: true, id: wish.id, note: 'Synthetic native note', revision: 2, duplicate: false, receipt: undefined })
  assert.equal(session.lastSnapshot.revision, 2)
  assert.equal(session.lastSnapshot.hasLive, true, 'the write planned on the live index')
  assert.deepEqual(session.lastSnapshot.model, await storeNow(), 'the live index equals the store read again')
  assert.equal(officialViewOf(session.lastSnapshot.model, 'local').wantToGo.items.find((item) => item.id === wish.id).note, 'Synthetic native note')
  assert.match(output.lines.at(-1), /wanttogo\/update（原生）：规划 [\d.]+ ms（1 条命令），提交 [\d.]+ ms（修订号 2），更新索引 [\d.]+ ms，共 [\d.]+ ms$/)
  const timings = session.lastNativeTimings
  for (const key of ['indexMs', 'planMs', 'commitMs', 'applyMs', 'totalMs']) assert.equal(typeof timings[key], 'number', key)

  // The same request again: its response, and nothing written; the same id with another body is a conflict.
  const id = requestId()
  const first = await write(ROUTE, { id: wish.id, note: 'Synthetic second' }, 2, contextOf(2), id)
  assert.equal(first.body.revision, 3)
  const replay = await write(ROUTE, { id: wish.id, note: 'Synthetic second' }, 2, contextOf(2), id)
  assert.deepEqual(replay.body, { ...first.body, duplicate: true })
  const conflict = await write(ROUTE, { id: wish.id, note: 'Synthetic other' }, 2, contextOf(3), id)
  assert.equal(conflict.status, 409); assert.equal(conflict.body.code, 'E_OPERATION_CONFLICT')
  assert.equal(session.lastSnapshot.revision, 3)
})

test('a native write refuses a stale base revision, a page without the protocol and what the planner refuses; nothing is written', async (t) => {
  const { session, write, storeNow } = await nativeSession(t)
  await session.moduleExports()
  const stale = await write(ROUTE, { id: 'synthetic-missing', note: 'x' }, 0, contextOf(1))
  assert.equal(stale.status, 409); assert.equal(stale.body.code, 'E_STALE')
  const old = await session.writeRoute('POST', '/__travelatlas/editor/wanttogo/update')({ headers: {}, input: { id: 'x' } })
  assert.equal(old.status, 409); assert.equal(old.body.code, 'E_STALE')
  const refused = await write(ROUTE, { id: 'synthetic-missing', note: 'x' }, 1, contextOf(2))
  assert.equal(refused.status, 400); assert.equal(refused.body.code, 'E_WTG_NOT_FOUND'); assert.deepEqual(refused.body.params, { id: 'synthetic-missing' })
  assert.equal((await storeNow()).revision, 1)
})

test('native and V2 writes share the cache: a V2 write after a native one sees it, and the live index follows both', async (t) => {
  const { session, write, files, storeNow } = await nativeSession(t)
  const wish = files.wantToGo.items[0]
  await session.moduleExports()
  assert.equal((await write(ROUTE, { id: wish.id, note: 'Synthetic before V2' }, 1, contextOf(1))).body.revision, 2)
  // A V2 write (its V2 view is built again from the live index's read model).
  const country = await write('POST /__travelatlas/editor/countries', { countryCode: 'DK', visitedDate: '2024-03-02' }, 2, contextOf(2))
  assert.equal(country.status, 201, JSON.stringify(country.body))
  assert.equal(session.lastSnapshot.hasLive, true)
  assert.deepEqual(session.lastSnapshot.model, await storeNow())
  assert.equal(officialViewOf(session.lastSnapshot.model, 'local').wantToGo.items.find((item) => item.id === wish.id).note, 'Synthetic before V2')
  // The next native write plans on the index the V2 write moved on.
  const after = await write(ROUTE, { id: wish.id, note: 'Synthetic after' }, 3, contextOf(3))
  assert.equal(after.status, 200, JSON.stringify(after.body))
  assert.deepEqual(session.lastSnapshot.model, await storeNow())
  const nuuk = placeNamed(files, 'Nuuk').id
  assert.ok(officialViewOf(session.lastSnapshot.model, 'local').places.some((place) => place.id === nuuk))
})

const VIEW = 'POST /__travelatlas/editor/view'

test('POST /editor/view: the operations merged into the current lists; a drag writes one row; nothing to change commits nothing; refusals as PUT /state', async (t) => {
  const { session, write, files, storeNow, output } = await nativeSession(t, null)
  await session.moduleExports()
  const lists = () => officialViewOf(session.lastSnapshot.model, 'local').editorState
  const iceland = placeNamed(files, 'Iceland').id, norway = placeNamed(files, 'Norway').id
  const before = lists()
  const saved = await write(VIEW, { operations: [
    { op: 'hide', scope: 'countries', add: [norway], remove: [] },
    { op: 'order', scope: 'countries', ids: [...before.countryOrder].reverse(), baseline: before.countryOrder },
    { op: 'hide', scope: 'media', add: ['synthetic-missing'], remove: [] },
  ] }, 1, contextOf(1))
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  assert.equal(saved.body.revision, 2)
  assert.deepEqual(lists().hiddenCountryIds, [...before.hiddenCountryIds, norway])
  assert.deepEqual(lists().countryOrder, [...before.countryOrder].reverse())
  assert.deepEqual(lists().hiddenMediaIds, before.hiddenMediaIds, 'a media id that is no asset is ignored')
  assert.deepEqual(session.lastSnapshot.model, await storeNow(), 'the live index equals the store read again')
  assert.match(output.lines.at(-1), /view（原生）：规划 [\d.]+ ms（\d+ 条命令），提交 [\d.]+ ms（修订号 2）/)

  // A drag: the last country first; the others keep their positions, one row moves.
  const order = lists().countryOrder
  const dragged = await write(VIEW, { operations: [{ op: 'order', scope: 'countries', ids: [order.at(-1), ...order.slice(0, -1)], baseline: order }] }, 2, contextOf(2))
  assert.equal(dragged.body.revision, 3)
  assert.equal(session.lastNativeTimings.commands, 1)
  assert.deepEqual(lists().countryOrder, [order.at(-1), ...order.slice(0, -1)])

  // The same hide again: nothing to change, nothing committed, the same revision.
  const same = await write(VIEW, { operations: [{ op: 'hide', scope: 'countries', add: [norway], remove: [] }] }, 3, contextOf(3))
  assert.equal(same.status, 200)
  assert.deepEqual({ ...same.body }, { ok: true, revision: 3, duplicate: false, unchanged: true })
  assert.match(output.lines.at(-1), /没有改动，不提交（修订号 3）/)

  // Refusals: the merged lists are checked as PUT /state checked the page's state; a malformed operation names its field.
  const notCity = await write(VIEW, { operations: [{ op: 'hide', scope: 'cities', add: [iceland], remove: [] }] }, 3, contextOf(4))
  assert.equal(notCity.status, 400); assert.equal(notCity.body.code, 'E_UNKNOWN_PLACE_REF')
  assert.deepEqual(notCity.body.params, { field: 'hiddenCityIds', id: iceland, expected: 'city', actual: 'country' })
  const malformed = await write(VIEW, { operations: [{ op: 'move' }] }, 3, contextOf(5))
  assert.equal(malformed.status, 400); assert.equal(malformed.body.code, 'E_EDITOR_STATE_INVALID'); assert.deepEqual(malformed.body.params, { field: 'operations[0].op' })
  assert.equal((await storeNow()).revision, 3)
})

test('the three want-to-go endpoints are native: add (201), update, delete with the place cleanup; each one commit, the live index = the store', async (t) => {
  const { session, write, storeNow, output } = await nativeSession(t, null)
  await session.moduleExports()
  const view = () => officialViewOf(session.lastSnapshot.model, 'local')
  const added = await write('POST /__travelatlas/editor/wanttogo', { place: { kind: 'city', nameZh: '大阪', nameEn: 'Osaka', countryCode: 'JP', lat: 34.69, lng: 135.5 } }, 1, contextOf(1))
  assert.equal(added.status, 201, JSON.stringify(added.body))
  assert.equal(added.body.revision, 2)
  assert.deepEqual(added.body.item.place, { kind: 'city', nameZh: '大阪', nameEn: 'Osaka', countryCode: 'JP', lat: 34.69, lng: 135.5 })
  assert.equal(view().wantToGo.items.at(-1).id, added.body.id)
  assert.match(output.lines.at(-1), /wanttogo（原生）：规划 [\d.]+ ms（\d+ 条命令），提交/)
  const choice = await write('POST /__travelatlas/editor/wanttogo', { place: { kind: 'city', nameEn: 'Osaka', countryCode: 'JP' } }, 2, contextOf(2))
  assert.equal(choice.status, 409); assert.equal(choice.body.code, 'E_PLACE_CHOICE_REQUIRED')
  assert.deepEqual(choice.body.params.candidates.map((candidate) => candidate.names.en), ['Osaka'])
  const hidden = await write('POST /__travelatlas/editor/wanttogo/update', { id: added.body.id, hidden: true, note: 'Synthetic' }, 2, contextOf(3))
  assert.equal(hidden.status, 200); assert.deepEqual([hidden.body.item.hidden, hidden.body.item.note, hidden.body.revision], [true, 'Synthetic', 3])
  const deleted = await write('POST /__travelatlas/editor/wanttogo/delete', { ids: [added.body.id] }, 3, contextOf(4))
  assert.equal(deleted.status, 200); assert.deepEqual([deleted.body.deletedIds, deleted.body.revision], [[added.body.id], 4])
  assert.equal(view().places.some((place) => ['Osaka', 'Japan'].includes(place.names.en)), false, 'the places only the item used are gone')
  assert.deepEqual(session.lastSnapshot.model, await storeNow())
})
