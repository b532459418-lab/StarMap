/// <reference types="node" />
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyRecordDate } from '../../worldgraph/timeFilter.ts'
import { deriveTimeQueryContext } from './timeQueryContext.ts'
import type { CanonicalData, CanonicalTravelRecord } from '../canonical/types.ts'

const record = (id: string, placeId: string, start_date: string, extra: Partial<CanonicalTravelRecord> = {}): CanonicalTravelRecord => ({
  id, placeId, start_date, lat: null, lng: null, journeyId: 'trip', ...extra,
})

const fixture = (): CanonicalData => ({
  places: [
    { id: 'country', subtype: 'country', names: { en: 'Exampleland' } },
    { id: 'other-country', subtype: 'country', names: { en: 'Elsewhere' } },
    { id: 'A', subtype: 'city', partOf: 'country', names: { en: 'Alpha' }, location: { lat: 0, lng: 0 } },
    { id: 'B', subtype: 'city', partOf: 'country', names: { en: 'Beta' } },
    { id: 'C', subtype: 'city', partOf: 'country', names: { en: 'Gamma' }, location: { lat: 1, lng: 2 } },
  ],
  travel: {
    source: 'sample', meta: { schemaVersion: 2, generatedAt: '2000-01-01' },
    display: { homeHiddenCountryIds: [], originCountryIds: [], regionCountryIds: [], regionIncludes: [], navigationHiddenCityIds: [] },
    records: [record('r-A', 'A', '2025-01-01'), record('r-B', 'B', '2025-01-02'), record('r-C', 'C', '2025-01-03')],
  },
  wantToGo: { source: 'none', items: [], problems: [] },
  editorState: {
    schemaVersion: 2, addedCountries: [], countryOrder: [], hiddenCountryIds: [],
    cityOrderByCountry: {}, hiddenCityIds: [], mediaOrderByCity: {}, hiddenMediaIds: [],
    coverMediaByCity: {}, droneOrderByCity: {}, hiddenDroneMediaIds: [],
  },
  media: { items: [], problems: [] },
})

const edges = (data: CanonicalData) => deriveTimeQueryContext(data).originalRoutes.map(route => [route.fromRecordId, route.toRecordId])
const hidden = (data: CanonicalData, recordId: string) => deriveTimeQueryContext(data).records.find(entry => entry.recordId === recordId)!.browsable

test('hidden middle visits stay in original adjacency under every existing hide mechanism', () => {
  for (const mode of ['home', 'city', 'country'] as const) {
    const data = fixture()
    if (mode === 'home') data.travel.records[1].hiddenFromHome = true
    if (mode === 'city') data.editorState.hiddenCityIds = ['B']
    if (mode === 'country') {
      data.places.find(place => place.id === 'B')!.partOf = 'other-country'
      data.editorState.hiddenCountryIds = ['other-country']
    }
    assert.equal(hidden(data, 'r-B'), false, mode)
    assert.equal(hidden(data, 'r-A'), true, mode)
    assert.equal(hidden(data, 'r-C'), true, mode)
    assert.deepEqual(edges(data), [['r-A', 'r-B'], ['r-B', 'r-C']], mode)
  }
})

test('missing coordinates never remove a middle record before original candidates are built', () => {
  const data = fixture()
  assert.equal(data.places.find(place => place.id === 'B')!.location, undefined)
  assert.deepEqual(edges(data), [['r-A', 'r-B'], ['r-B', 'r-C']])
  assert.equal(hidden(data, 'r-B'), true)
  assert.deepEqual(data.places.find(place => place.id === 'A')!.location, { lat: 0, lng: 0 })
})

test('same-city repeated visit remains the exact predecessor of the next city', () => {
  const data = fixture()
  data.travel.records[1].placeId = 'A'
  assert.deepEqual(edges(data), [['r-B', 'r-C']])
})

test('only explicitly nonempty journey IDs create candidates; explicit unknown-journey is legitimate', () => {
  for (const journeyId of [undefined, '', '   ', 'unknown-journey']) {
    const data = fixture()
    data.travel.records.forEach(entry => { entry.journeyId = journeyId })
    assert.equal(deriveTimeQueryContext(data).originalRoutes.length, journeyId === 'unknown-journey' ? 2 : 0)
  }
})

test('original order follows start_date plus ID deterministically and keeps independent journey groups', () => {
  const data = fixture()
  data.travel.records = [
    record('z', 'C', '2025-01-02'), record('b', 'B', '2025-01-01'),
    record('a', 'A', '2025-01-01'), record('else', 'A', '2020-01-01', { journeyId: 'other' }),
  ]
  assert.deepEqual(edges(data), [['a', 'b'], ['b', 'z']])
})

test('source namespaces preserve colliding travel, planned and want-to-go raw IDs', () => {
  const data = fixture()
  data.travel.records = [record('same', 'A', '2022-01-01'), record('same', 'A', '2027-01-01', { status: 'planned' })]
  data.wantToGo.items = [{ id: 'same', placeId: 'A', addedAt: '2023-01-01', hidden: false, source: 'travel-map:planned' }]
  const result = deriveTimeQueryContext(data)
  assert.deepEqual(result.records.map(entry => [entry.sourceKind, entry.recordId, entry.date.range.from]), [
    ['travel', 'same', '2022-01-01'], ['planned', 'same', '2027-01-01'], ['want-to-go', 'same', '2023-01-01'],
  ])
  assert.deepEqual(result.originalRoutes, [])
})

test('planned ignores travel hiding while want-to-go follows only its own hidden flag', () => {
  const data = fixture()
  data.travel.display.homeHiddenCountryIds = ['country']
  data.travel.display.navigationHiddenCityIds = ['A']
  data.editorState.hiddenCountryIds = ['country']
  data.editorState.hiddenCityIds = ['A']
  data.travel.records.push(record('planned', 'A', '2027-01-01', { status: 'planned', hiddenFromHome: true }))
  data.wantToGo.items = [
    { id: 'visible', placeId: 'A', addedAt: '2025-01-01', hidden: false },
    { id: 'hidden', placeId: 'A', addedAt: '2025-01-01', hidden: true },
  ]
  const records = deriveTimeQueryContext(data).records
  assert.equal(records.find(entry => entry.recordId === 'planned')!.browsable, true)
  assert.equal(records.find(entry => entry.recordId === 'visible')!.browsable, true)
  assert.equal(records.find(entry => entry.recordId === 'hidden')!.browsable, false)
  assert.equal(records.find(entry => entry.recordId === 'planned')!.navigationHidden, true)
})

test('travel classification precedence and explicit home visibility override are preserved', () => {
  const data = fixture()
  data.travel.display.homeHiddenCountryIds = ['country']
  assert.equal(hidden(data, 'r-A'), false)
  data.travel.records[0].hiddenFromHome = false
  assert.equal(hidden(data, 'r-A'), true)
  data.travel.records[1].travelCategory = 'destination'
  assert.equal(hidden(data, 'r-B'), true)
  data.travel.display.regionCountryIds = ['country']
  assert.equal(hidden(data, 'r-C'), true)
})

test('country evidence survives existing city visits and empty containers are not synthetic visits', () => {
  const data = fixture()
  data.editorState.addedCountries = [
    { placeId: 'country', visitedDate: '2020-02-02' },
    { placeId: 'other-country' }, { placeId: 'empty', visitedDate: '' },
    { placeId: 'invalid-country', visitedDate: '2025-02-29' },
  ]
  data.travel.display.homeHiddenCountryIds = ['country']
  const evidence = deriveTimeQueryContext(data).records.filter(entry => entry.sourceKind === 'country-visit')
  assert.deepEqual(evidence.map(entry => entry.recordId), ['country', 'invalid-country'])
  assert.equal(evidence[0].countryId, 'country')
  assert.equal(evidence[0].browsable, true)
  assert.equal(evidence[1].date.quality, 'invalid')
  data.editorState.hiddenCountryIds = ['country']
  assert.equal(deriveTimeQueryContext(data).records.find(entry => entry.sourceKind === 'country-visit' && entry.placeId === 'country')!.browsable, false)
})

test('date evidence uses original start, end and year fields including planned end dates', () => {
  const data = fixture()
  data.travel.records = [
    record('cross-year', 'A', '2024-12-30', { end_date: '2025-01-03', year: 2024 }),
    record('year', 'B', '2025'),
    record('planned', 'C', '2027-01-01', { end_date: '2027-02-03', status: 'planned' }),
    record('invalid', 'C', '2025-02-29', { year: 2025 }),
  ]
  const result = deriveTimeQueryContext(data)
  for (const [index, original] of data.travel.records.entries()) {
    assert.deepEqual(result.records[index].date, classifyRecordDate({ startDate: original.start_date, endDate: original.end_date, year: original.year }))
  }
  assert.deepEqual(result.records[2].date.range, { from: '2027-01-01', to: '2027-02-03' })
})

test('route IDs are collision-safe across opaque delimiter-containing identities', () => {
  const first = fixture()
  first.travel.records = [record('a__b', 'A', '2025-01-01', { journeyId: 'j' }), record('c', 'C', '2025-01-02', { journeyId: 'j' })]
  const second = fixture()
  second.travel.records = [record('b', 'A', '2025-01-01', { journeyId: 'j__a' }), record('c', 'C', '2025-01-02', { journeyId: 'j__a' })]
  const a = deriveTimeQueryContext(first).originalRoutes[0]
  const b = deriveTimeQueryContext(second).originalRoutes[0]
  assert.notEqual(a.id, b.id)
  assert.equal(a.fromRecordId, 'a__b')
  assert.equal(b.journeyId, 'j__a')
})

const freezeDeep = (value: unknown): void => {
  if (value === null || typeof value !== 'object') return
  Object.values(value).forEach(freezeDeep)
  Object.freeze(value)
}

test('frozen complete inputs are untouched and returned evidence cannot mutate their facts', () => {
  const data = fixture()
  data.travel.records.reverse()
  const before = JSON.stringify(data)
  freezeDeep(data)
  const context = deriveTimeQueryContext(data)
  assert.equal(context.records.length, 3)
  assert.deepEqual(context.originalRoutes.map(route => route.fromRecordId), ['r-A', 'r-B'])
  assert.equal(JSON.stringify(data), before)
  assert.notEqual(context.records[0].date, data.travel.records[0])
})
