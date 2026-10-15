/**
 * The eight editor writes of the new-library mode through the session (3C-4a spec §2.2, §2.3): each one runs V2's
 * write function on the cached view, commits the diff and makes the files after the write the next read model
 * (no projection after start-up); the result equals V2 mode with the same input; the cache is dropped when the store is
 * not the cached one; STARMAP_STORE_VERIFY compares every commit with a fresh projection; a view that does not match
 * the store drops the cache.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { storeFileOf } from './private-data-source.mjs'
import { applyMigration } from './store-migrate.mjs'
import { STORE_BASE_REVISION_HEADER, STORE_REQUEST_ID_HEADER, createStoreSession } from './store-session.mjs'
import { rawConnection } from './store-sqlite.mjs'
import { quietly, tempPrivateRoot, writeV2Files } from './store-mode.fixture.mjs'
import { V2_EDITOR_ROUTES } from './v2-editor-store.mjs'
import { sequentialUuids } from '../src/data/canonical/v2.fixture.ts'
import { readV2 } from '../src/data/canonical/v2Reader.ts'
import { readEditorStateV1 } from '../src/data/v2write/index.ts'
import { TEST_CATALOG, WRITE_EPOCH_MS, migratedFiles, placeNamed } from '../src/data/v2write/v2write.fixture.ts'

const MIGRATED_AT = '2026-09-26T00:00:00.000Z'
let counter = 0
const requestId = () => `01960000-0000-7000-8000-${(++counter).toString(16).padStart(12, '0')}`
const headers = (base, id = requestId()) => ({ [STORE_REQUEST_ID_HEADER]: id, [STORE_BASE_REVISION_HEADER]: String(base) })
/** The V2 write context of step `n` (both modes get an identical one). */
const contextOf = (n) => ({ newId: sequentialUuids(WRITE_EPOCH_MS + n * 1000), now: new Date(Date.UTC(2026, 8, 27, 8, n)), countryCatalog: TEST_CATALOG })
const projections = (lines) => lines.filter((line) => line.includes('读模型')).length
const without = (body, keys) => Object.fromEntries(Object.entries(body).filter(([key]) => !keys.includes(key)))

async function migratedSession(t, options = {}) {
  const context = await tempPrivateRoot(t, 'starmap-store-editor-')
  const files = migratedFiles()
  await writeV2Files(context.paths, files)
  await applyMigration(context.paths, { now: MIGRATED_AT })
  const output = quietly()
  const session = context.closeAfter(createStoreSession(context.paths, {
    log: output.log, countryCatalog: TEST_CATALOG, newId: sequentialUuids(Date.UTC(2032, 0, 1)), ...options,
  }))
  const write = (route, input, base, ctx, id) => session.writeRoute(...route.split(' '))({ headers: headers(base, id), input, ctx })
  return { ...context, files, session, output, write }
}

test('the eight editor writes: the store equals V2 mode after each, verified, and read without a new projection', async (t) => {
  const { session, output, write, files, paths } = await migratedSession(t, { verify: true })
  let v2 = files
  const id = (en) => placeNamed(v2, en).id
  const wish = (en) => v2.wantToGo.items.find((item) => item.placeId === id(en)).id
  const steps = [
    ['POST /__travelatlas/editor/countries', () => ({ countryCode: 'DK', visitedDate: '2024-03-02' })],
    ['POST /__travelatlas/editor/records', () => ({
      country: '日本', country_en: 'Japan', city: '东京', city_en: 'Tokyo', start_date: '2026-05-01', lat: 35.68, lng: 139.69, country_code: 'JP',
    })],
    ['POST /__travelatlas/editor/wanttogo', () => ({ placeId: id('Bergen'), note: 'Synthetic fjord' })],
    ['POST /__travelatlas/editor/wanttogo/update', () => ({ id: wish('Nuuk'), note: 'Synthetic note', hidden: true })],
    ['POST /__travelatlas/editor/wanttogo/convert', () => ({ source: 'planned', recordId: v2.travel.records.find((r) => r.placeId === id('Bergen')).id, startDate: '2026-08-01' })],
    ['PUT /__travelatlas/editor/state', () => {
      const state = readEditorStateV1(v2, new Date())
      return { ...state, countryOrder: [...state.countryOrder].reverse(), hiddenCountryIds: [id('Norway')], hiddenCityIds: [] }
    }],
    ['POST /__travelatlas/editor/wanttogo/delete', () => ({ ids: [wish('Tromsø')] })],
    ['POST /__travelatlas/editor/countries/delete', () => ({ ids: [id('Norway')] })],
  ]
  assert.deepEqual(steps.map(([route]) => route).sort(), Object.keys(V2_EDITOR_ROUTES).sort())
  let revision = (await session.moduleExports()).revision
  assert.equal(revision, 1)
  for (const [index, [route, inputOf]] of steps.entries()) {
    const input = inputOf()
    const expected = V2_EDITOR_ROUTES[route].run(v2, structuredClone(input), contextOf(index))
    v2 = { ...v2, ...Object.fromEntries(expected.writes.map((step) => [step.file, step.value])) }
    const result = await write(route, input, revision, contextOf(index))
    assert.equal(result.status, V2_EDITOR_ROUTES[route].status, `${route}: ${JSON.stringify(result.body)}`)
    assert.equal(result.body.revision, revision + 1, route)
    assert.equal(result.body.duplicate, false)
    assert.deepEqual(without(result.body, ['revision', 'duplicate', 'receipt']), { ok: true, ...expected.result }, `${route}: V2's result`)
    revision = result.body.revision
    const read = await session.moduleExports()
    assert.equal(read.revision, revision)
    assert.deepEqual(readV2(read.files), readV2(v2), `${route}: the read model equals V2 mode`)
  }
  // One projection at start-up; every write refreshed the cache directly (STARMAP_STORE_VERIFY found no difference).
  assert.equal(projections(output.lines), 1)
  assert.equal(output.lines.filter((line) => line.includes('校验失败')).length, 0)
  assert.equal(output.lines.filter((line) => /V2 写入 [\d.]+ ms，差异 [\d.]+ ms（\d+ 条命令），提交 [\d.]+ ms/.test(line)).length, steps.length)
  // A new session projects the store from scratch: the same data.
  await session.close()
  const reopened = createStoreSession(paths, { log: () => {} })
  try {
    const read = await reopened.moduleExports()
    assert.equal(read.revision, revision)
    assert.deepEqual(readV2(read.files), readV2(v2))
  } finally { await reopened.close() }
})

test('a replayed request answers with the original V2 result in this process, and with the receipt after a restart', async (t) => {
  const { session, write, files, paths } = await migratedSession(t)
  const id = requestId()
  const route = 'POST /__travelatlas/editor/wanttogo'
  const input = { placeId: placeNamed(files, 'Bergen').id }
  const first = await write(route, input, 1, contextOf(1), id)
  assert.equal(first.status, 201)
  const replay = await write(route, input, 1, contextOf(2), id)
  assert.equal(replay.status, 201)
  assert.deepEqual(replay.body, { ...first.body, duplicate: true })
  assert.equal((await session.moduleExports()).revision, 2)
  await session.close()
  const restarted = createStoreSession(paths, { log: () => {}, countryCatalog: TEST_CATALOG })
  try {
    const later = await restarted.writeRoute(...route.split(' '))({ headers: headers(1, id), input })
    assert.equal(later.status, 201)
    assert.deepEqual(later.body, { ok: true, revision: 2, receipt: first.body.receipt, duplicate: true })
  } finally { await restarted.close() }
})

test('when another writer moves the store, the cache is dropped and the store projected again', async (t) => {
  const { session, output, write, files } = await migratedSession(t)
  assert.equal((await session.moduleExports()).revision, 1)
  // Another writer (here: a commit on the same connection that bypasses the session's cache) changes a note.
  const handle = await session.open()
  const wish = files.wantToGo.items[0]
  const entry = handle.read((reader) => reader.get('entries', reader.findEntryByIdentity(wish.placeId, 'starmap:want-to-go', 'v2:want-to-go', wish.id)))
  await handle.commit({
    requestId: requestId(), baseRevision: 1, kind: 'test.other-writer', actor: 'test',
    commands: [{ op: 'update', table: 'entries', id: entry.id, expectedRevision: entry.revision, value: { ...entry, revision: entry.revision + 1, fields: { ...entry.fields, note: 'Synthetic other writer' } } }],
  })
  const read = await session.moduleExports()
  assert.equal(read.revision, 2)
  assert.equal(read.files.wantToGo.items.find((item) => item.id === wish.id).note, 'Synthetic other writer')
  assert.equal(projections(output.lines), 2, 'projected again')
  // A page built at revision 1 is stale; one built at 2 writes.
  const stale = await write('POST /__travelatlas/editor/wanttogo/update', { id: wish.id, note: 'Synthetic stale' }, 1, contextOf(1))
  assert.equal(stale.status, 409)
  assert.equal(stale.body.code, 'E_STALE')
  const saved = await write('POST /__travelatlas/editor/wanttogo/update', { id: wish.id, note: 'Synthetic later' }, 2, contextOf(2))
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  assert.equal((await session.moduleExports()).files.wantToGo.items.find((item) => item.id === wish.id).note, 'Synthetic later')
})

/** Another connection, through the adapter (the store's journal mode: TRUNCATE, so it can write while the session holds the store open). */
const storeConnection = (paths) => rawConnection(storeFileOf(paths))

/** Change a want-to-go entry's note behind the host's back (no new revision): the store and the cache now differ. */
function tamperNote(paths, wishId, note) {
  const db = storeConnection(paths)
  try {
    const changed = db.prepare("UPDATE entries SET body = json_set(body, '$.fields.note', ?) WHERE source_id = 'v2:want-to-go' AND record_id = ?").run(note, wishId).changes
    assert.equal(changed, 1)
  } finally { db.close() }
}

test('STARMAP_STORE_VERIFY: a commit whose fresh projection differs from the cache is E_STORE_VERIFY, and the projection replaces the cache', async (t) => {
  const previous = process.env.STARMAP_STORE_VERIFY
  process.env.STARMAP_STORE_VERIFY = '1'
  let context
  try { context = await migratedSession(t) } finally {
    if (previous === undefined) delete process.env.STARMAP_STORE_VERIFY; else process.env.STARMAP_STORE_VERIFY = previous
  }
  const { session, write, files, paths, output } = context
  await session.moduleExports()
  const [first, second] = files.wantToGo.items
  tamperNote(paths, first.id, 'Synthetic tampered')
  const result = await write('POST /__travelatlas/editor/wanttogo/update', { id: second.id, note: 'Synthetic verified' }, 1, contextOf(1))
  assert.equal(result.status, 500)
  assert.equal(result.body.code, 'E_STORE_FAILED')
  assert.deepEqual(result.body.params, { code: 'E_STORE_VERIFY' })
  assert.equal(output.lines.filter((line) => line.includes('校验失败（STARMAP_STORE_VERIFY）')).length, 1)
  // The write itself was committed; the read model is now the store's projection.
  const read = await session.moduleExports()
  assert.equal(read.revision, 2)
  assert.equal(read.files.wantToGo.items.find((item) => item.id === first.id).note, 'Synthetic tampered')
  assert.equal(read.files.wantToGo.items.find((item) => item.id === second.id).note, 'Synthetic verified')
})

test('without STARMAP_STORE_VERIFY the same change stays invisible until the store moves under another writer', async (t) => {
  const { session, write, files, paths } = await migratedSession(t, { verify: false })
  await session.moduleExports()
  const [first, second] = files.wantToGo.items
  tamperNote(paths, first.id, 'Synthetic tampered')
  const result = await write('POST /__travelatlas/editor/wanttogo/update', { id: second.id, note: 'Synthetic unverified' }, 1, contextOf(1))
  assert.equal(result.status, 200)
  // The cache is the files after the write: the change behind the host's back is not in it (why the check exists).
  assert.equal((await session.moduleExports()).files.wantToGo.items.find((item) => item.id === first.id).note, first.note)
})

test('a view that does not match the store is E_VIEW_MISMATCH and drops the cache', async (t) => {
  const { session, write, files, paths, output } = await migratedSession(t)
  await session.moduleExports()
  const wish = files.wantToGo.items[0]
  const db = storeConnection(paths)
  try {
    db.prepare("UPDATE entries SET record_id = 'synthetic-renamed', body = json_set(body, '$.source.recordId', 'synthetic-renamed') WHERE source_id = 'v2:want-to-go' AND record_id = ?").run(wish.id)
  } finally { db.close() }
  const result = await write('POST /__travelatlas/editor/wanttogo/update', { id: wish.id, note: 'Synthetic' }, 1, contextOf(1))
  assert.equal(result.status, 500)
  assert.deepEqual(result.body.params, { code: 'E_VIEW_MISMATCH' })
  const read = await session.moduleExports()
  assert.equal(projections(output.lines), 2, 'projected again')
  assert.equal(read.revision, 1, 'nothing was written')
  assert.ok(read.files.wantToGo.items.some((item) => item.id === 'synthetic-renamed'))
})

test('refusals of the V2 write come back as V2 sends them, and nothing is written', async (t) => {
  const { session, write, files } = await migratedSession(t)
  const choice = await write('POST /__travelatlas/editor/records', {
    placeId: placeNamed(files, 'Nuuk').id, start_date: '2025-06-20', trip_title: '2025 North Atlantic Demo', lat: 64.18, lng: -51.72,
  }, 1, contextOf(1))
  assert.equal(choice.status, 409)
  assert.equal(choice.body.code, 'E_JOURNEY_CHOICE_REQUIRED')
  assert.equal(choice.body.params.candidates[0].journeyId, '2025-north-atlantic-demo')
  const exists = await write('POST /__travelatlas/editor/countries', { countryCode: 'IS', visitedDate: '2024-01-01' }, 1, contextOf(2))
  assert.equal(exists.status, 400)
  assert.equal(exists.body.code, 'E_COUNTRY_EXISTS')
  assert.equal((await session.moduleExports()).revision, 1)
  // The user chooses the journey: the migrated journey is found through id_map (the host reader's idMapping).
  const handle = await session.open()
  const journeyEntity = handle.read((reader) => reader.idMapping('journey', 'v2:journey', '2025-north-atlantic-demo'))
  assert.equal(typeof journeyEntity, 'string')
  const joined = await write('POST /__travelatlas/editor/records', {
    placeId: placeNamed(files, 'Nuuk').id, start_date: '2025-06-20', trip_title: '2025 North Atlantic Demo', lat: 64.18, lng: -51.72,
    journeyId: '2025-north-atlantic-demo',
  }, 1, contextOf(3))
  assert.equal(joined.status, 201, JSON.stringify(joined.body))
  const sequence = handle.read((reader) => reader.dependents('entities', journeyEntity).filter((ref) => ref.fromTable === 'sequences').map((ref) => reader.get('sequences', ref.fromId)))
  assert.equal(sequence.length, 1)
  assert.equal(sequence[0].entryIds.length, 7, 'six records and the new one')
  // viewScope: every row of one scope, in id order.
  const scope = handle.read((reader) => reader.viewScope('starmap:editor/country-order'))
  assert.deepEqual(scope.items.map((item) => item.itemId), readEditorStateV1((await session.moduleExports()).files, new Date()).countryOrder.slice().sort((a, b) => {
    const ids = Object.fromEntries(scope.items.map((item) => [item.itemId, item.id]))
    return ids[a] < ids[b] ? -1 : 1
  }))
  assert.deepEqual(handle.read((reader) => reader.viewScope('synthetic:none')), { items: [], settings: [] })
})
