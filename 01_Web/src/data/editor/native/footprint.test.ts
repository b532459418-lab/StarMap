/// <reference types="node" />
/**
 * The store-native footprint and country writes (3C-5 C2): the rows they write — `starmap:user` records whose V2 id is the
 * entry id, journeys whose id is the journey entity's (no `journey-` prefix), sequences in route order, added countries
 * as the official view reads them, and only the countryOrder rows that move. Results and refusals against the old engine
 * are the double run's (../doubleRun.test.ts).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FormalState } from '../../../worldgraph/store/formal.ts'
import { viewOf } from '../../store/diffV2.fixture.ts'
import { OFFICIAL, V2_SOURCES, VIEW_SCOPES } from '../../store/officialDefinitions.ts'
import { projectStoreToCanonical } from '../../store/projectCanonical.ts'
import { migratedFiles, placeNamed } from '../../v2write/v2write.fixture.ts'
import { doubleRunStore, editorRoute, nativeEngineOf, sameRequest, stepContext, type DoubleRunStore } from '../doubleRun.fixture.ts'
import { NATIVE_WRITES } from './routes.ts'

const canonicalOf = (state: FormalState) => projectStoreToCanonical(state, { source: 'local', track: false, freeze: false }).canonical
function run(store: DoubleRunStore, route: string, input: unknown, n: number) {
  const outcome = nativeEngineOf(NATIVE_WRITES[editorRoute(route)])(store, sameRequest(route, editorRoute(route), () => { throw new Error('native only') }, input), stepContext(n))
  if (outcome.state) store.state = outcome.state
  return outcome
}
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

test('POST /countries: an added country is a v2:country-visit evidence (region) and visit entry, with its addedCountryOrder row', () => {
  const store = doubleRunStore(migratedFiles())
  const before = store.state
  const saved = run(store, 'countries', { countryCode: 'DK', visitedDate: '2024-03-02' }, 1)
  assert.ok(saved.state, JSON.stringify(saved.error))
  const { countryId } = saved.result as { countryId: string }
  const [evidence] = fresh(before.evidence, store.state.evidence)
  assert.deepEqual([evidence.sourceId, evidence.recordId, evidence.attributes], [V2_SOURCES.countryVisit, countryId, { region: 'Europe' }])
  const [visit] = fresh(before.entries, store.state.entries)
  assert.deepEqual([visit.source.sourceId, visit.source.recordId, visit.source.evidenceIds, visit.fields], [V2_SOURCES.countryVisit, countryId, [evidence.id], { date: { raw: { startDate: '2024-03-02' } } }])
  assert.ok(fresh(before.viewItems, store.state.viewItems).some((row) => row.scope === VIEW_SCOPES.addedCountryOrder && row.itemId === countryId))
  assert.deepEqual(canonicalOf(store.state).editorState.addedCountries.at(-1), { placeId: countryId, region: 'Europe', visitedDate: '2024-03-02' })
  // Again: E_COUNTRY_EXISTS.
  assert.equal(run(store, 'countries', { countryCode: 'DK', visitedDate: '2024-03-02' }, 2).error?.code, 'E_COUNTRY_EXISTS')
})
