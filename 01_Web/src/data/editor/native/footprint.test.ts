/// <reference types="node" />
/**
 * The store-native footprint and country writes (3C-5 C2): the rows they write — `starmap:user` records whose V2 id is the
 * entry id, journeys whose id is the journey entity's (no `journey-` prefix), sequences in route order, added countries
 * as the official view reads them, and only the countryOrder rows that move. Results and refusals are pinned by the
 * golden output (../golden.test.ts).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FormalCommand, FormalState } from '../../../worldgraph/store/formal.ts'
import { viewOf } from '../../store/v2Store.fixture.ts'
import { OFFICIAL, V2_SOURCES, VIEW_SCOPES } from '../../store/officialDefinitions.ts'
import { projectStoreToCanonical } from '../../store/projectCanonical.ts'
import { migratedFiles, placeNamed } from '../editor.fixture.ts'
import { doubleRunStore } from '../doubleRun.fixture.ts'
import { commitAsIs, customEntryOn, landmarkNear, runNative } from './native.fixture.ts'

const canonicalOf = (state: FormalState) => projectStoreToCanonical(state, { source: 'local', track: false, freeze: false }).canonical
const run = runNative
const fresh = <T extends { id: string }>(before: readonly T[], after: readonly T[]) => after.filter((row) => !before.some((old) => old.id === row.id))

test('POST /records: a starmap:user record (its V2 id is the entry id), its order row, a new journey whose id is the journey entity\'s', () => {
  const store = doubleRunStore(migratedFiles())
  const before = store.state
  const saved = run(store, 'records', { country: '日本', country_en: 'Japan', city: '东京', city_en: 'Tokyo', start_date: '2026-05-01', end_date: '2026-05-03', lat: 35.68, lng: 139.69, country_code: 'JP' }, 1)
  assert.ok(saved.state, JSON.stringify(saved.error))
  const { id, countryId, cityId } = saved.result as { id: string; countryId: string; cityId: string }
  const [entry] = fresh(before.entries, store.state.entries)
  assert.deepEqual([entry.id, entry.source.sourceId, entry.source.recordId, entry.layerId, entry.entityId], [id, OFFICIAL.user, id, OFFICIAL.travel, cityId])
  assert.deepEqual(entry.fields, { date: { raw: { startDate: '2026-05-01', endDate: '2026-05-03', year: 2026 } }, tripTitle: '日本 · 东京' })
  assert.equal(entry.extensions, undefined, 'no V2-only value')
  const [journey] = fresh(before.entities, store.state.entities).filter((row) => row.typeId === OFFICIAL.journey)
  assert.deepEqual([journey.source.sourceId, journey.source.recordId], [OFFICIAL.user, journey.id])
  const record = canonicalOf(store.state).travel.records.at(-1)!
  assert.deepEqual([record.id, record.placeId, record.journeyId, record.trip_title], [id, cityId, journey.id, '日本 · 东京'])
  assert.ok(canonicalOf(store.state).places.some((place) => place.id === countryId && place.subtype === 'country'))
  // Japan entered the footprint: the country order moved (only the rows whose position changes).
  assert.ok(canonicalOf(store.state).editorState.countryOrder.includes(countryId))
})

test('POST /records joining a journey: its sequence lists the members and the new record in route order', () => {
  const store = doubleRunStore(migratedFiles())
  const files = viewOf(store.state)
  const journeyId = '2025-north-atlantic-demo'
  const members = files.travel.records.filter((record) => record.journeyId === journeyId)
  const saved = run(store, 'records', { placeId: placeNamed(files, 'Nuuk').id, start_date: '2025-06-20', trip_title: '2025 North Atlantic Demo', journeyId, lat: 64.18, lng: -51.72 }, 1)
  assert.ok(saved.state, JSON.stringify(saved.error))
  const after = canonicalOf(store.state).travel.records.filter((record) => record.journeyId === journeyId)
  assert.equal(after.length, members.length + 1)
  const sequence = store.state.sequences.find((row) => row.entryIds.length === after.length)!
  const order = sequence.entryIds.map((entryId) => store.state.entries.find((row) => row.id === entryId)!)
  const dates = order.map((row) => (row.fields.date as { raw: { startDate: string } }).raw.startDate)
  assert.deepEqual(dates, [...dates].sort(), 'route order')
})

test('POST /countries: an added country is a starmap:user visit entry on the country citing an evidence row (region), with its addedCountryOrder row (3C-5 E)', () => {
  const store = doubleRunStore(migratedFiles())
  const before = store.state
  const saved = run(store, 'countries', { countryCode: 'DK', visitedDate: '2024-03-02' }, 1)
  assert.ok(saved.state, JSON.stringify(saved.error))
  const { countryId } = saved.result as { countryId: string }
  const [evidence] = fresh(before.evidence, store.state.evidence)
  const [visit] = fresh(before.entries, store.state.entries)
  assert.deepEqual([evidence.sourceId, evidence.recordId, evidence.attributes], [OFFICIAL.user, visit.id, { region: 'Europe' }])
  assert.deepEqual([visit.layerId, visit.entityId, visit.source.sourceId, visit.source.recordId, visit.source.evidenceIds, visit.fields],
    [OFFICIAL.travel, countryId, OFFICIAL.user, visit.id, [evidence.id], { date: { raw: { startDate: '2024-03-02' } } }])
  // No row of a V2 source (3C-5 E spec §2.6: the country's subtype marks the visit, not v2:country-visit).
  assert.ok(![evidence.sourceId, visit.source.sourceId].includes(V2_SOURCES.countryVisit))
  assert.ok(fresh(before.viewItems, store.state.viewItems).some((row) => row.scope === VIEW_SCOPES.addedCountryOrder && row.itemId === countryId))
  assert.deepEqual(canonicalOf(store.state).editorState.addedCountries.at(-1), { placeId: countryId, region: 'Europe', visitedDate: '2024-03-02' })
  // Again: E_COUNTRY_EXISTS.
  assert.equal(run(store, 'countries', { countryCode: 'DK', visitedDate: '2024-03-02' }, 2).error?.code, 'E_COUNTRY_EXISTS')
})

/** Japan with two visited cities (Tokyo, Kyoto) on a fresh store, Japan hidden: ready to be deleted. */
function japanToDelete(custom?: (placeId: string) => FormalCommand[]) {
  const store = doubleRunStore(migratedFiles())
  const tokyo = runNative(store, 'records', { country: '日本', country_en: 'Japan', city: '东京', city_en: 'Tokyo', start_date: '2026-05-01', lat: 35.68, lng: 139.69, country_code: 'JP' }, 1)
  const kyoto = runNative(store, 'records', { country: '日本', country_en: 'Japan', city: '京都', city_en: 'Kyoto', start_date: '2026-05-04', lat: 35.01, lng: 135.77, country_code: 'JP', newJourney: true }, 2)
  const { countryId: japan, cityId: tokyoId } = tokyo.result as { countryId: string; cityId: string }
  const { cityId: kyotoId } = kyoto.result as { cityId: string }
  if (custom) commitAsIs(store, custom(kyotoId))
  runNative(store, 'view', { operations: [{ op: 'hide', scope: 'countries', add: [japan], remove: [] }] }, 3)
  return { store, japan, tokyoId, kyotoId }
}
const has = (state: FormalState, id: string) => state.entities.some((row) => row.id === id)

test('D3: deleting a country keeps a city that a custom layer\'s entity or entry still refers to (and its country; design §9 change 9)', () => {
  for (const [label, custom] of [['an entity field of a custom layer', landmarkNear], ['an entry of a custom layer', customEntryOn]] as const) {
    const { store, japan, tokyoId, kyotoId } = japanToDelete(custom)
    const deleted = runNative(store, 'countries/delete', { ids: [japan] }, 4)
    assert.deepEqual(deleted.result, { deletedCountryIds: [japan], deletedRecordCount: 2 }, label)
    assert.equal(has(store.state, tokyoId), false, `${label}: Tokyo goes`)
    assert.ok(has(store.state, kyotoId), `${label}: Kyoto stays`)
    assert.ok(has(store.state, japan), `${label}: Japan stays (Kyoto is part of it)`)
    const view = canonicalOf(store.state)
    assert.equal(view.travel.records.some((record) => record.placeId === tokyoId || record.placeId === kyotoId), false, label)
    assert.equal(view.editorState.countryOrder.includes(japan) || view.editorState.hiddenCountryIds.includes(japan), false, label)
  }
})

test('D3, the other way: the cities only the deleted country\'s footprint referred to go, with the country, their records and journeys', () => {
  const { store, japan, tokyoId, kyotoId } = japanToDelete()
  const journeys = store.state.entities.filter((row) => row.typeId === OFFICIAL.journey).length
  runNative(store, 'countries/delete', { ids: [japan] }, 4)
  for (const id of [japan, tokyoId, kyotoId]) assert.equal(has(store.state, id), false, id)
  assert.equal(store.state.entities.filter((row) => row.typeId === OFFICIAL.journey).length, journeys - 2, 'the two journeys left without members')
  assert.equal(store.state.viewItems.some((row) => [japan, tokyoId, kyotoId].includes(row.itemId)), false)
})
