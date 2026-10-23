/// <reference types="node" />
/** Store-native media records (3C-4c, ./mediaRecords.ts) on a migrated store in memory: what the V2 view shows after
 * creating and removing records, covers, explicit additions, and renumbering. Neutral fixtures and invented values. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { FormalCommand, FormalState, ViewItem } from '../../worldgraph/store/formal.ts'
import { applyChangeSet, planCommands } from '../../worldgraph/store/planner.ts'
import { memoryReader } from '../../worldgraph/store/reader.ts'
import { sequentialUuids } from '../canonical/v2.fixture.ts'
import { validateV2Files } from '../canonical/v2Schema.ts'
import type { CanonicalMediaItem } from '../canonical/types.ts'
import { removeMediaFromEditorState } from '../v2media/editorWrites.ts'
import { memoryScopeReader } from './scopeReader.ts'
import { storeFrom, viewOf } from './v2Store.fixture.ts'
import { createMediaRecordCommands, removeMediaRecordCommands, rereadChanges, rereadMediaRecordCommands, type NewMediaRecord } from './mediaRecords.ts'
import { OFFICIAL, OFFICIAL_POLICY, VIEW_SCOPES } from './officialDefinitions.ts'
import { NOW, edgeCaseFixture } from './v2Store.fixture.ts'

const apply = (state: FormalState, commands: readonly FormalCommand[]) =>
  applyChangeSet(state, planCommands(memoryReader(state), commands, { baseRevision: state.revision, now: NOW, policy: OFFICIAL_POLICY }))
const item = (overrides: Partial<CanonicalMediaItem> & { placeId: string; originalFileName: string }) => ({
  id: 'ignored', kind: 'photo', scope: 'city', src: '/media/user/0123456789abcdef/original.jpg',
  variants: { original: { src: '/media/user/0123456789abcdef/original.jpg', width: 4, height: 3 } }, width: 4, height: 3, isCover: false, status: 'ready',
  ...overrides,
}) as CanonicalMediaItem

function fixtureStore() {
  const store = storeFrom(edgeCaseFixture())
  const cities = store.view.places.places.filter(place => place.subtype === 'city')
  return { store, cities, allocateId: sequentialUuids(Date.UTC(2032, 0, 1)) }
}

test('created records project as V2 media items with the asset id, at the end of the media order; explicit ones join their city order', () => {
  const { store, cities, allocateId } = fixtureStore()
  const [city] = cities
  const records: NewMediaRecord[] = [
    { assetId: allocateId(), entityId: allocateId(), item: item({ placeId: city.id, originalFileName: 'new-photo.jpg', title: { names: { en: 'Synthetic new' } } }), appendToCityOrder: true },
    { assetId: allocateId(), entityId: allocateId(), item: item({ placeId: city.id, kind: 'aerialPhoto', originalFileName: 'flight.jpg', status: 'needsMetadata' }) },
  ]
  const plan = createMediaRecordCommands(records, { reader: memoryScopeReader(store.state), allocateId })
  const state = apply(store.state, plan.commands)
  const view = viewOf(state)
  assert.deepEqual(validateV2Files(view), [])
  assert.deepEqual(view.media.items.slice(-2).map(media => [media.id, media.placeId, media.kind, media.originalFileName]),
    records.map(record => [record.assetId, city.id, record.item.kind, record.item.originalFileName]))
  assert.deepEqual(view.media.items.at(-2)!.title, { names: { en: 'Synthetic new' } })
  assert.deepEqual(view.editorState.mediaOrderByCity[city.id]?.slice(-1), [records[0].assetId], 'the explicit photo is appended to its city order')
  assert.equal(view.editorState.droneOrderByCity[city.id]?.includes(records[1].assetId) ?? false, false, 'a scanned file is not added to an order')
  const entity = state.entities.find(row => row.id === records[0].entityId)!
  assert.deepEqual([entity.typeId, entity.source.sourceId, entity.source.recordId, entity.fields.asset], [OFFICIAL.media, OFFICIAL.user, records[0].entityId, records[0].assetId])
  // Everything else in the view is unchanged.
  const before = store.view
  assert.deepEqual({ ...view, media: { ...view.media, items: view.media.items.slice(0, -2) }, editorState: { ...view.editorState, mediaOrderByCity: before.editorState.mediaOrderByCity } },
    { ...before, media: { ...before.media, items: before.media.items.map(media => ({ ...media, isCover: view.media.items.find(other => other.id === media.id)!.isCover })) } })
})

test('covers follow markCovers in the cities whose photos change: a photo named cover takes over', () => {
  const { store, cities, allocateId } = fixtureStore()
  const city = cities.find(place => store.view.media.items.some(media => media.placeId === place.id && media.kind === 'photo'))!
  const existing = store.view.media.items.find(media => media.placeId === city.id && media.kind === 'photo')!
  assert.equal(existing.isCover, true)
  const record = { assetId: allocateId(), entityId: allocateId(), item: item({ placeId: city.id, originalFileName: 'cover-new.jpg' }) }
  const state = apply(store.state, createMediaRecordCommands([record], { reader: memoryScopeReader(store.state), allocateId }).commands)
  const view = viewOf(state)
  assert.deepEqual([view.media.items.find(media => media.id === record.assetId)!.isCover, view.media.items.find(media => media.id === existing.id)!.isCover], [true, false])
  // Removing it gives the cover back.
  const removed = apply(state, removeMediaRecordCommands([record.assetId], { reader: memoryScopeReader(state) }).commands)
  assert.equal(viewOf(removed).media.items.find(media => media.id === existing.id)!.isCover, true)
})

test('removing a record removes it everywhere the editor state names it, as V2’s removeMediaFromEditorState does; its ids are tombstoned', () => {
  const { store } = fixtureStore()
  const view = store.view
  const id = view.editorState.hiddenMediaIds.find(mediaId => view.media.items.some(media => media.id === mediaId))!
  const plan = removeMediaRecordCommands([id], { reader: memoryScopeReader(store.state) })
  const state = apply(store.state, plan.commands)
  const after = viewOf(state)
  const expected = removeMediaFromEditorState(view, [id], { now: new Date(NOW), countryCatalog: new Map(), newId: () => 'unused' }).writes[0].value as typeof view.editorState
  for (const key of ['hiddenMediaIds', 'hiddenDroneMediaIds', 'mediaOrderByCity', 'droneOrderByCity', 'coverMediaByCity'] as const) {
    // V2 keeps a list element that names no media (an unresolved one); the store does too, so both agree element for element.
    assert.deepEqual(after.editorState[key], expected[key], key)
  }
  assert.deepEqual(after.media.items.map(media => media.id), view.media.items.filter(media => media.id !== id).map(media => media.id))
  assert.ok(state.tombstones.some(row => row.table === 'assets' && row.id === id))
  assert.equal(state.entities.some(row => row.typeId === OFFICIAL.media && row.fields.asset === id), false)
  assert.deepEqual(validateV2Files(after), [])
})

test('when no position fits after the last element, the scope is renumbered in the same batch, order kept', () => {
  const { store, cities, allocateId } = fixtureStore()
  // The last row of the media order at the longest key (as after thousands of appends).
  const rows = store.state.viewItems.filter(row => row.scope === VIEW_SCOPES.mediaOrder).sort((a, b) => (a.position < b.position ? -1 : 1))
  const last = rows.at(-1)!
  const crowded = apply(store.state, [{ op: 'update', table: 'viewItems', id: last.id, expectedRevision: last.revision, value: { ...last, revision: last.revision + 1, position: 'z'.repeat(64) } as ViewItem }])
  const before = viewOf(crowded).media.items.map(media => media.id)
  const record = { assetId: allocateId(), entityId: allocateId(), item: item({ placeId: cities[0].id, originalFileName: 'late.jpg' }) }
  const plan = createMediaRecordCommands([record], { reader: memoryScopeReader(crowded), allocateId })
  assert.deepEqual(plan.renumbered, [VIEW_SCOPES.mediaOrder])
  const state = apply(crowded, plan.commands)
  assert.deepEqual(viewOf(state).media.items.map(media => media.id), [...before, record.assetId])
})

test('a title the store cannot hold stays verbatim and projects back', () => {
  const { store, cities, allocateId } = fixtureStore()
  const title = { names: { 'not a tag!': 'Synthetic' } }
  const record = { assetId: allocateId(), entityId: allocateId(), item: item({ placeId: cities[0].id, originalFileName: 't.jpg', title: title as CanonicalMediaItem['title'] }) }
  const state = apply(store.state, createMediaRecordCommands([record], { reader: memoryScopeReader(store.state), allocateId }).commands)
  assert.deepEqual(viewOf(state).media.items.find(media => media.id === record.assetId)!.title, title)
})

test('re-reading a description: city, title and described keys follow the Inbox; ids, orders, hidden lists, cover and files stay', () => {
  const { store, cities, allocateId } = fixtureStore()
  const [city, other] = cities
  const record: NewMediaRecord = { assetId: allocateId(), entityId: allocateId(), appendToCityOrder: true,
    item: item({ placeId: city.id, kind: 'aerialPhoto', originalFileName: 'drone.jpg', status: 'needsMetadata', title: { names: { en: 'Synthetic old' } } }) }
  const created = apply(store.state, createMediaRecordCommands([record], { reader: memoryScopeReader(store.state), allocateId }).commands)
  const before = viewOf(created)
  const described = item({ placeId: other.id, kind: 'aerialPhoto', originalFileName: 'drone.jpg', status: 'ready', date: '2026-08-01', resolution: '4 × 3',
    title: { names: { en: 'Synthetic new' } } } as Partial<CanonicalMediaItem> & { placeId: string; originalFileName: string })
  const reader = memoryScopeReader(created)
  assert.deepEqual(rereadChanges({ assetId: record.assetId, item: described }, { reader }).sort(), ['date', 'place', 'resolution', 'status', 'title'])
  assert.deepEqual(rereadChanges({ assetId: record.assetId, item: record.item }, { reader }), [], 'the same description changes nothing')
  assert.deepEqual(rereadMediaRecordCommands([{ assetId: record.assetId, item: record.item }], { reader }).commands, [])
  const state = apply(created, rereadMediaRecordCommands([{ assetId: record.assetId, item: described }], { reader }).commands)
  const view = viewOf(state)
  assert.deepEqual(validateV2Files(view), [])
  const media = view.media.items.find(entry => entry.id === record.assetId)!
  assert.deepEqual([media.placeId, media.date, media.resolution, media.status, media.title], [other.id, '2026-08-01', '4 × 3', 'ready', { names: { en: 'Synthetic new' } }])
  assert.deepEqual([media.src, media.variants, media.isCover, media.originalFileName], [before.media.items.find(entry => entry.id === record.assetId)!.src,
    before.media.items.find(entry => entry.id === record.assetId)!.variants, false, 'drone.jpg'])
  assert.deepEqual(view.media.items.map(entry => entry.id), before.media.items.map(entry => entry.id), 'the media order stays')
  assert.deepEqual(view.editorState.droneOrderByCity, before.editorState.droneOrderByCity, 'the city order stays')
  assert.ok(state.entities.some(row => row.id === record.entityId) && state.assets.some(row => row.id === record.assetId))
  // A description without a date removes it again.
  const again = apply(state, rereadMediaRecordCommands([{ assetId: record.assetId, item: { ...described, date: undefined } as unknown as CanonicalMediaItem }], { reader: memoryScopeReader(state) }).commands)
  assert.equal(viewOf(again).media.items.find(entry => entry.id === record.assetId)!.date, undefined)
})
