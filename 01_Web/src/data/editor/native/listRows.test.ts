/// <reference types="node" />
/**
 * The view rows of the native writes (3C-5 E review R1): the view operations' refusals of a place that is missing or of
 * the wrong kind (ported from the retired v2write/editorState.test.ts, whose PUT /state the operations replaced), and
 * positions in the original-order scopes and the lists — an append, a row without a position, positions that ran out
 * (ported from the retired store/diffV2.test.ts, whose diff wrote these rows before the native writes).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FormalState, ViewItem } from '../../../worldgraph/store/formal.ts'
import { positionBetween } from '../../../worldgraph/store/position.ts'
import { OFFICIAL, VIEW_SCOPES } from '../../store/officialDefinitions.ts'
import { listPositions } from '../../store/v2RecordRows.ts'
import { GHOST_ID } from '../editor.fixture.ts'
import { commitAsIs } from './native.fixture.ts'
import { Library } from './writes.fixture.ts'

const rowsOf = (state: FormalState, scope: string) => state.viewItems.filter((item) => item.scope === scope)
const lastRow = (state: FormalState, scope: string) => [...rowsOf(state, scope)].sort((a, b) => (a.position < b.position ? -1 : 1)).at(-1)!
/** Put the longest key on the last row of `scope`: no position fits after it. */
function exhaust(library: Library, scope: string): number {
  const last = lastRow(library.state, scope)
  commitAsIs(library.store, [{ op: 'update', table: 'viewItems', id: last.id, expectedRevision: last.revision, value: { ...last, revision: last.revision + 1, position: 'z'.repeat(64) } satisfies ViewItem }])
  assert.throws(() => positionBetween('z'.repeat(64)), { code: 'E_POSITION' })
  return rowsOf(library.state, scope).length
}
const view = (...operations: unknown[]) => ({ operations })

test('view operations naming a place that is missing or of the wrong kind → E_UNKNOWN_PLACE_REF with the field, the id and the kinds; nothing written', () => {
  const library = new Library()
  const iceland = library.place('Iceland').id, reykjavik = library.place('Reykjavik').id
  const countries = library.view.editorState.countryOrder
  const message = '编辑状态引用了不存在的地点，或地点类型不对，未保存。请刷新页面后重试。'
  const cases: [string, unknown, Record<string, unknown>][] = [
    ['a missing place in the country order', { op: 'order', scope: 'countries', ids: [GHOST_ID], baseline: countries }, { field: 'countryOrder', id: GHOST_ID, expected: 'country', actual: 'missing' }],
    ['a city in the country order', { op: 'order', scope: 'countries', ids: [reykjavik], baseline: countries }, { field: 'countryOrder', expected: 'country', actual: 'city' }],
    ['a city among the hidden countries', { op: 'hide', scope: 'countries', add: [reykjavik], remove: [] }, { field: 'hiddenCountryIds' }],
    ['a city as the key of a city order', { op: 'order', scope: 'cities', key: reykjavik, ids: [], baseline: [] }, { field: 'cityOrderByCountry' }],
    ['a country in a city order', { op: 'order', scope: 'cities', key: iceland, ids: [iceland], baseline: [] }, { field: `cityOrderByCountry.${iceland}` }],
    ['a country among the hidden cities', { op: 'hide', scope: 'cities', add: [iceland], remove: [] }, { field: 'hiddenCityIds', actual: 'country' }],
    ['a country as the key of a photo order', { op: 'order', scope: 'media', key: iceland, ids: [], baseline: [] }, { field: 'mediaOrderByCity' }],
    ['a missing city as the key of a cover', { op: 'cover', key: GHOST_ID, id: 'photo-reykjavik-1' }, { field: 'coverMediaByCity' }],
    ['a legacy key of a drone order', { op: 'order', scope: 'drone', key: 'faroe-islands__torshavn', ids: [], baseline: [] }, { field: 'droneOrderByCity', actual: 'missing' }],
  ]
  for (const [name, operation, expected] of cases) {
    const params = library.refuse('view', view(operation), 'E_UNKNOWN_PLACE_REF', undefined, message)
    for (const [key, value] of Object.entries(expected)) assert.equal(params[key], value, `${name}: ${key}`)
  }
  // Design 3C-5 §9 change 4: a media id that is no media is left out of the operation (PUT /state wrote it as it was).
  const outcome = library.run('view', view({ op: 'cover', key: GHOST_ID, id: 'not-a-media-id' }))
  assert.equal(outcome.commands, 0, JSON.stringify(outcome.error))
})

test('a new item is appended to its original-order scope with positionBetween(the last position, undefined)', () => {
  const library = new Library()
  const before = lastRow(library.state, VIEW_SCOPES.wantToGoOrder).position
  const { id } = library.save<{ id: string }>('wanttogo', { placeId: library.place('Bergen').id })
  const row = rowsOf(library.state, VIEW_SCOPES.wantToGoOrder).find((item) => item.itemId === id)!
  assert.equal(row.position, positionBetween(before, undefined))
  assert.equal(row.layerId, OFFICIAL.wantToGo)
})

test('an item without a row in its order (created outside the editor) comes last and is written by id; the next append renumbers the scope', () => {
  const library = new Library()
  const userId = '01960000-0000-7000-8000-00000000c002', now = '2026-09-27T07:00:00.000Z'
  commitAsIs(library.store, [{ op: 'create', table: 'entries', value: {
    id: userId, revision: 0, layerId: OFFICIAL.wantToGo, entityId: library.place('Bergen').id, fields: { addedAt: '2026-09-20' },
    source: { sourceId: OFFICIAL.user, recordId: userId, evidenceIds: [] }, createdAt: now, updatedAt: now,
  } }])
  assert.equal(library.view.wantToGo.items.at(-1)!.id, userId, 'after the positioned items, by its entry id')
  library.save('wanttogo/update', { id: userId, note: 'Synthetic later', hidden: true })
  const items = library.view.wantToGo.items.map((item) => item.id)
  const { id } = library.save<{ id: string }>('wanttogo', { placeId: library.place('Reykjavik').id })
  assert.deepEqual(library.view.wantToGo.items.map((item) => item.id), [...items, id])
  const rows = rowsOf(library.state, VIEW_SCOPES.wantToGoOrder)
  assert.equal(new Set(rows.map((row) => row.itemId)).size, items.length + 1, 'every item has its one row now')
  assert.equal(rows.length, items.length + 1)
  library.save('wanttogo/delete', { ids: [userId] })
  assert.equal(library.view.wantToGo.items.some((item) => item.id === userId), false)
})

test('an original-order scope whose positions ran out is renumbered with listPositions in the same write', () => {
  const library = new Library()
  const count = exhaust(library, VIEW_SCOPES.wantToGoOrder)
  const items = library.view.wantToGo.items.map((item) => item.id)
  const { id } = library.save<{ id: string }>('wanttogo', { placeId: library.place('Bergen').id })
  const rows = rowsOf(library.state, VIEW_SCOPES.wantToGoOrder)
  assert.equal(rows.length, count + 1)
  assert.ok(rows.every((row) => row.position.length <= 2), 'short keys again')
  assert.deepEqual(library.view.wantToGo.items.map((item) => item.id), [...items, id], 'the order kept')
})

test('a list whose positions ran out is renumbered; only the rows whose position changes are written', () => {
  const library = new Library()
  exhaust(library, VIEW_SCOPES.countryOrder)
  const order = library.view.editorState.countryOrder
  assert.equal(order.length, 2)
  const greenland = library.place('Greenland').id
  const outcome = library.run('view', view({ op: 'order', scope: 'countries', ids: [...order, greenland], baseline: order }))
  assert.ok(outcome.state, JSON.stringify(outcome.error))
  assert.equal(outcome.commands, 3, 'two rows move to the new keys, one row is new')
  assert.deepEqual(rowsOf(library.state, VIEW_SCOPES.countryOrder).map((row) => row.position).sort(), [...listPositions(3)])
  assert.deepEqual(library.view.editorState.countryOrder, [...order, greenland])
})
