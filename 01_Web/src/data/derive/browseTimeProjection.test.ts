/// <reference types="node" />
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildBrowseTimeProjection, journeyTimeContext } from './browseTimeProjection.ts'
import { classifyRecordDate, type RecordDateInput } from '../../worldgraph/timeFilter.ts'
import { TRAVEL_LAYER_ID, WANT_TO_GO_LAYER_ID } from '../../worldgraph/layers.ts'
import type { TimeQueryContext, TimeQueryRecord } from '../../worldgraph/timeQuery.ts'

const visit = (recordId: string, date: RecordDateInput, extra: Partial<TimeQueryRecord> = {}): TimeQueryRecord => ({
  sourceKind: 'travel', recordId, placeId: 'city', countryId: 'country',
  date: classifyRecordDate(date), browsable: true, ...extra,
})
const context = (...records: TimeQueryRecord[]): TimeQueryContext => ({ records, originalRoutes: [] })
const yearFilter = (year: number, includeUncertain = false) => ({
  [TRAVEL_LAYER_ID]: { from: `${year}-01-01`, to: `${year}-12-31`, includeUncertain },
})
const ids = (records: readonly { record: TimeQueryRecord }[]) => records.map(match => match.record.recordId)

test('same city visits match individual dates and visits count independently', () => {
  const data = context(visit('old', { startDate: '2022-06-01' }), visit('new', { startDate: '2025-06-01' }))
  const none = buildBrowseTimeProjection(data, yearFilter(2023))
  assert.equal(none.travelRecordIds.size, 0)
  assert.equal(none.cityIds.size, 0)
  const all = buildBrowseTimeProjection(data, {})
  assert.deepEqual(all.travelStats.definite, { records: 2, cities: 1, countries: 1, countryEvidence: 0 })
})

test('cross-year records appear in each intersecting year but total identity remains one', () => {
  const data = context(visit('cross', { startDate: '2024-12-30', endDate: '2025-01-03' }))
  const all = buildBrowseTimeProjection(data, {})
  assert.deepEqual(all.journeyYears.map(group => group.year), [2025, 2024])
  assert.deepEqual(all.journeyYears.map(group => ids(group.records)), [['cross'], ['cross']])
  assert.equal(all.travelStats.definite.records, 1)
  assert.equal(all.travelRecordIds.size, 1)
  const filtered = buildBrowseTimeProjection(data, yearFilter(2025))
  assert.deepEqual(filtered.journeyYears.map(group => group.year), [2025])
})

test('year groups obey three-way intersection for closed and open query ranges', () => {
  const data = context(visit('long', { startDate: '2023-12-31', endDate: '2026-01-01' }))
  const query = { [TRAVEL_LAYER_ID]: { from: '2024-12-31', to: '2025-01-01', includeUncertain: false } }
  assert.deepEqual(buildBrowseTimeProjection(data, query).journeyYears.map(group => group.year), [2025, 2024])
  assert.deepEqual(buildBrowseTimeProjection(data, { [TRAVEL_LAYER_ID]: { to: '2024-01-01', includeUncertain: false } }).journeyYears.map(group => group.year), [2024, 2023])
  assert.deepEqual(buildBrowseTimeProjection(data, { [TRAVEL_LAYER_ID]: { from: '2026-01-01', includeUncertain: false } }).journeyYears.map(group => group.year), [2026])
})

test('reliable year and partial-month evidence stay in their year with original precision', () => {
  const data = context(visit('year', { startDate: '2025' }), visit('month', { startDate: '2025-06' }))
  const full = buildBrowseTimeProjection(data, yearFilter(2025, true))
  assert.deepEqual(full.journeyYears.map(group => group.year), [2025])
  assert.deepEqual(ids(full.journeyYears[0].records), ['year', 'month'])
  assert.equal(full.travelMatchesById.get('year')?.record.date.precision, 'year')
  assert.equal(full.travelMatchesById.get('month')?.result.match, 'uncertain')
  assert.deepEqual(full.uncertainJourneyRecords, [])
  const june = buildBrowseTimeProjection(data, { [TRAVEL_LAYER_ID]: { from: '2025-06-01', to: '2025-06-30', includeUncertain: true } })
  assert.equal(june.travelMatchesById.get('year')?.result.match, 'uncertain')
  assert.equal(june.travelStats.definite.records, 0)
  assert.equal(june.travelStats.uncertain.records, 2)
  assert.equal(buildBrowseTimeProjection(data, yearFilter(2026, true)).travelRecordIds.size, 0)
})

test('unknown and invalid dates use an independent group without zero or NaN years', () => {
  const data = context(visit('missing', {}), visit('bad', { startDate: '2025-02-29', year: 2025 }), visit('partial', { startDate: 'spring' }))
  const all = buildBrowseTimeProjection(data, {})
  assert.deepEqual(all.journeyYears, [])
  assert.deepEqual(ids(all.uncertainJourneyRecords), ['missing', 'bad', 'partial'])
  assert.equal(all.travelStats.uncertain.records, 3)
  assert.equal(buildBrowseTimeProjection(data, yearFilter(2025)).travelRecordIds.size, 0)
  assert.equal(buildBrowseTimeProjection(data, yearFilter(2025, true)).travelRecordIds.size, 3)
})

test('only-end evidence never guesses a starting year and excludes queries beyond the bound', () => {
  const data = context(visit('end', { endDate: '2025-06-01' }))
  const included = buildBrowseTimeProjection(data, yearFilter(2024, true))
  assert.deepEqual(included.journeyYears, [])
  assert.deepEqual(ids(included.uncertainJourneyRecords), ['end'])
  assert.equal(buildBrowseTimeProjection(data, yearFilter(2026, true)).travelRecordIds.size, 0)
})

test('manual country evidence contributes countries without inventing visits or cities', () => {
  const data = context(
    visit('city', { startDate: '2022-01-01' }),
    visit('country', { startDate: '2025-03-01' }, { sourceKind: 'country-visit', placeId: 'country' }),
  )
  const browse = buildBrowseTimeProjection(data, yearFilter(2025))
  assert.deepEqual([...browse.countryIds], ['country'])
  assert.equal(browse.travelRecordIds.size, 0)
  assert.equal(browse.cityIds.size, 0)
  assert.deepEqual(browse.journeyYears, [])
  assert.deepEqual(browse.travelStats.definite, { records: 0, cities: 0, countries: 1, countryEvidence: 1 })
})

test('definite place evidence removes additional uncertain place counts but retains uncertain records', () => {
  const data = context(
    visit('known', { startDate: '2025-01-01' }), visit('unknown', {}),
    visit('country', { startDate: 'wrong' }, { sourceKind: 'country-visit', placeId: 'country' }),
    visit('other', {}, { placeId: 'other-city', countryId: 'other-country' }),
  )
  const browse = buildBrowseTimeProjection(data, yearFilter(2025, true))
  assert.deepEqual(browse.travelStats.definite, { records: 1, cities: 1, countries: 1, countryEvidence: 0 })
  assert.deepEqual(browse.travelStats.uncertain, { records: 2, cities: 1, countries: 1, countryEvidence: 1 })
  assert.deepEqual([...browse.uncertainCityIds], ['other-city'])
  assert.deepEqual([...browse.uncertainCountryIds], ['other-country'])
})

test('hidden sources do not enter counts while navigation-hidden sources retain evidence', () => {
  const data = context(visit('hidden', {}, { browsable: false }), visit('nav-hidden', { startDate: '2025-01-01' }, { navigationHidden: true }))
  const browse = buildBrowseTimeProjection(data, yearFilter(2025, true))
  assert.deepEqual([...browse.travelRecordIds], ['nav-hidden'])
  assert.equal(browse.travelStats.uncertain.records, 0)
  assert.equal(browse.travelStats.definite.records, 1)
})

test('planned and favorite same IDs remain independent from travel and its statistics', () => {
  const data = context(visit('same', { startDate: '2025-01-01' }),
    visit('same', { startDate: '2027-01-01' }, { sourceKind: 'planned' }),
    visit('same', { startDate: '2022-01-01' }, { sourceKind: 'want-to-go' }))
  const browse = buildBrowseTimeProjection(data, {
    ...yearFilter(2025), [WANT_TO_GO_LAYER_ID]: { from: '2027-01-01', to: '2027-12-31', includeUncertain: false },
  })
  assert.deepEqual(browse.includedRecords.map(match => match.record.sourceKind), ['travel', 'planned'])
  assert.equal(browse.travelStats.definite.records, 1)
  assert.deepEqual(ids(browse.journeyYears[0].records), ['same'])
})

test('duplicate source identities count once with first-wins Core semantics', () => {
  const record = visit('same', { startDate: '2025-01-01' })
  const browse = buildBrowseTimeProjection(context(record, record), {})
  assert.equal(browse.travelStats.definite.records, 1)
  assert.equal(browse.travelByPlace.get('city')?.length, 1)
})

test('projection works with frozen inputs and leaves their dates, routes and visibility untouched', () => {
  const data = context(visit('valid', { startDate: '2024-12-31', endDate: '2025-01-01' }), visit('unknown', {}))
  const before = JSON.stringify(data)
  for (const record of data.records) { Object.freeze(record.date.range); Object.freeze(record.date); Object.freeze(record) }
  Object.freeze(data.records); Object.freeze(data.originalRoutes); Object.freeze(data)
  const filters = Object.freeze(yearFilter(2025, true))
  const browse = buildBrowseTimeProjection(data, filters)
  assert.equal(browse.travelRecordIds.size, 2)
  assert.equal(JSON.stringify(data), before)
})

test('component fallback uses original interval and auxiliary year without parsing display summaries', () => {
  const data = journeyTimeContext([{ id: 'visit', date: '2024-12-31', cityId: 'city', countryId: 'country', title: 'Unchanged' }], {
    city: { id: 'city', lat: null, lng: null, visitedDateRange: 'untrusted display text', records: [{
      id: 'visit', city: 'City', city_en: 'City', country: 'Country', country_en: 'Country', lat: null, lng: null,
      start_date: '2024-12-31', end_date: '2025-01-02', year: 2024,
    }] },
  })
  assert.deepEqual(buildBrowseTimeProjection(data, {}).journeyYears.map(group => group.year), [2025, 2024])
})

test('latest-first uses reliable date evidence even when raw start is absent and unknown dates sort last', () => {
  const data = context(visit('unknown', { startDate: 'zzzz' }), visit('old-day', { startDate: '2024-12-31' }),
    visit('year', { year: 2025 }), visit('new-day', { startDate: '2025-03-01' }), visit('month', { startDate: '2025-06' }))
  assert.deepEqual(ids(buildBrowseTimeProjection(data, {}).orderedJourneyRecords), ['new-day', 'year', 'month', 'old-day', 'unknown'])
})
