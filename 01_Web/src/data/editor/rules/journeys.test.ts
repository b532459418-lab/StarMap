/// <reference types="node" />
/**
 * The journey rules as the store-native writes use them (3C-5 C2): the candidates from only the records that matter
 * (the titled visited records and every member of their journeys) equal the candidates from every record, in any
 * order; decideJourney asks for candidates only when it needs them. The candidates themselves (the tests of the retired
 * v2write/journeyChoice.test.ts, 3C-5 E review R1) follow below.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JOURNEY_CANDIDATE_CITY_LIMIT, decideJourney, findJourneyCandidates, type JourneyRecord } from './journeys.ts'
import { V2WriteError } from '../errors.ts'

const NAMES: Record<string, Record<string, string>> = { a: { en: 'A', 'zh-Hans': '甲', fr: 'A' }, b: { en: 'B' }, c: { 'zh-Hans': '丙' } }
const records: JourneyRecord[] = [
  { id: 'r1', placeId: 'a', journeyId: 'j1', trip_title: 'Summer', start_date: '2024-07-01', end_date: '2024-07-03' },
  { id: 'r2', placeId: 'b', journeyId: 'j1', trip_title: 'Other title', start_date: '2024-07-05' },
  { id: 'r3', placeId: 'c', journeyId: 'j2', trip_title: 'Summer', start_date: '2023-07-01' },
  { id: 'r4', placeId: 'a', journeyId: 'j3', trip_title: 'Winter', start_date: '2025-01-01' },
  { id: 'r5', placeId: 'b', journeyId: 'j4', trip_title: 'Summer', start_date: '2026-07-01', status: 'planned' },
  { id: 'r6', placeId: 'c', trip_title: 'Summer', start_date: '2022-07-01' },
]

test('findJourneyCandidates: the titled visited records and their journeys\' members are enough, in any order', () => {
  const all = findJourneyCandidates(records, 'Summer', (id) => NAMES[id])
  assert.deepEqual(all.map((candidate) => [candidate.journeyId, candidate.startDate, candidate.endDate, candidate.cityCount]), [
    ['j1', '2024-07-01', '2024-07-05', 2], ['j2', '2023-07-01', '2023-07-01', 1],
  ])
  assert.deepEqual(all[0].cities, [{ placeId: 'a', names: { 'zh-Hans': '甲', en: 'A' } }, { placeId: 'b', names: { en: 'B' } }])
  const subset = [records[2], records[1], records[0]]
  assert.deepEqual(findJourneyCandidates(subset, 'Summer', (id) => NAMES[id]), all)
})

test('decideJourney: new needs no candidates; join must be a candidate; ask refuses with the candidates when there are any', () => {
  let asked = 0
  const candidates = () => { asked++; return findJourneyCandidates(records, 'Summer', (id) => NAMES[id]) }
  assert.deepEqual(decideJourney({ kind: 'new' }, candidates, 'Summer'), { new: true })
  assert.equal(asked, 0)
  assert.deepEqual(decideJourney({ kind: 'join', journeyId: 'j2' }, candidates, 'Summer'), { join: 'j2' })
  assert.throws(() => decideJourney({ kind: 'join', journeyId: 'j3' }, candidates, 'Summer'),
    (error) => error instanceof V2WriteError && error.code === 'E_UNKNOWN_JOURNEY' && (error.params as { journeyId: string }).journeyId === 'j3')
  assert.throws(() => decideJourney({ kind: 'ask' }, candidates, 'Summer'),
    (error) => error instanceof V2WriteError && error.code === 'E_JOURNEY_CHOICE_REQUIRED' && (error.params as { candidates: unknown[] }).candidates.length === 2)
  assert.deepEqual(decideJourney({ kind: 'ask' }, () => [], 'Spring'), { new: true })
})

// ---------------------------------------------------------------------------
// The candidates (3C-5 E review R1: ported from the retired v2write/journeyChoice.test.ts, at the rules' level)
// ---------------------------------------------------------------------------

const SUMMER = '暑假'
const CITY_NAMES: Record<string, Record<string, string>> = Object.fromEntries(
  ['reykjavik', 'vik', 'akureyri', 'torshavn', 'gjogv', 'klaksvik', 'bergen', 'nuuk'].map((id) => [id, { 'zh-Hans': `城${id}`, en: id }]),
)
const namesOf = (placeId: string) => CITY_NAMES[placeId]
const city = (placeId: string) => ({ placeId, names: CITY_NAMES[placeId] })
type Spec = { id: string; city: string; start: string; end?: string; title?: string; journeyId?: string; status?: string }
const recordsOf = (specs: readonly Spec[]): JourneyRecord[] => specs.map((spec) => ({
  id: spec.id, placeId: spec.city, start_date: spec.start, ...(spec.end ? { end_date: spec.end } : {}), ...(spec.title !== undefined ? { trip_title: spec.title } : {}),
  status: spec.status ?? 'visited', ...(spec.journeyId !== undefined ? { journeyId: spec.journeyId } : {}),
}))
/** Two earlier summers (2024 and 2023), and records that are no candidates. */
const TWO_SUMMERS: readonly Spec[] = [
  { id: 's24_akureyri', city: 'akureyri', start: '2024-07-04', end: '2024-07-10', title: SUMMER, journeyId: 'journey-summer-2024' },
  { id: 's24_reykjavik', city: 'reykjavik', start: '2024-07-01', end: '2024-07-03', title: SUMMER, journeyId: 'journey-summer-2024' },
  { id: 's23_torshavn', city: 'torshavn', start: '2023-07-05', title: SUMMER, journeyId: 'journey-summer-2023' },
  { id: 's23_gjogv', city: 'gjogv', start: '2023-07-06', end: '2023-07-08', title: SUMMER, journeyId: 'journey-summer-2023' },
  // A planned record is no journey of a visit; a record without journeyId belongs to none; another title is no candidate.
  { id: 'p_bergen', city: 'bergen', start: '2026-07-01', title: SUMMER, status: 'planned' },
  { id: 'v_nuuk', city: 'nuuk', start: '2022-07-01', title: SUMMER },
  { id: 'w_klaksvik', city: 'klaksvik', start: '2024-12-24', title: '寒假', journeyId: 'journey-winter-2024' },
]

test('candidates: two earlier journeys of the title, their date ranges and cities (in visit order), the latest first', () => {
  assert.deepEqual(findJourneyCandidates(recordsOf(TWO_SUMMERS), SUMMER, namesOf), [
    { journeyId: 'journey-summer-2024', title: SUMMER, startDate: '2024-07-01', endDate: '2024-07-10', cities: [city('reykjavik'), city('akureyri')], cityCount: 2 },
    { journeyId: 'journey-summer-2023', title: SUMMER, startDate: '2023-07-05', endDate: '2023-07-08', cities: [city('torshavn'), city('gjogv')], cityCount: 2 },
  ])
})

test('candidates: none for another title, a title not exactly equal, no title, or only planned records and records without a journey', () => {
  const records = recordsOf(TWO_SUMMERS)
  assert.deepEqual(findJourneyCandidates(records, '国庆', namesOf), [])
  assert.deepEqual(findJourneyCandidates(records, '暑假 ', namesOf), [], 'equal, not trimmed or case-folded')
  assert.deepEqual(findJourneyCandidates(records, undefined, namesOf), [])
  assert.deepEqual(findJourneyCandidates(records, '', namesOf), [])
  assert.deepEqual(findJourneyCandidates(recordsOf([
    { id: 'p_bergen', city: 'bergen', start: '2026-07-01', title: '春节', status: 'planned', journeyId: 'journey-plan' },
    { id: 'v_nuuk', city: 'nuuk', start: '2022-07-01', title: '春节', journeyId: '' },
  ]), '春节', namesOf), [])
})

test('candidates: the whole journey (records of another title count for dates and cities); cities once each, in visit order, at most five with the total', () => {
  const records = recordsOf([
    { id: 'a', city: 'reykjavik', start: '2021-08-01', title: SUMMER, journeyId: 'journey-long' },
    { id: 'b', city: 'vik', start: '2021-08-02', title: SUMMER, journeyId: 'journey-long' },
    { id: 'c', city: 'akureyri', start: '2021-08-03', title: '暑假 · 北部', journeyId: 'journey-long' },
    { id: 'd', city: 'reykjavik', start: '2021-08-04', title: SUMMER, journeyId: 'journey-long' },
    { id: 'e', city: 'torshavn', start: '2021-08-05', title: SUMMER, journeyId: 'journey-long' },
    { id: 'f', city: 'gjogv', start: '2021-08-06', title: SUMMER, journeyId: 'journey-long' },
    { id: 'g', city: 'klaksvik', start: '2021-08-07', end: '2021-08-09', title: '暑假 · 返程', journeyId: 'journey-long' },
  ])
  const [candidate, ...rest] = findJourneyCandidates(records, SUMMER, namesOf)
  assert.equal(rest.length, 0)
  assert.deepEqual([candidate.startDate, candidate.endDate, candidate.cityCount], ['2021-08-01', '2021-08-09', 6], 'the latest end comes from a record of another title')
  assert.equal(candidate.cities.length, JOURNEY_CANDIDATE_CITY_LIMIT)
  assert.deepEqual(candidate.cities, ['reykjavik', 'vik', 'akureyri', 'torshavn', 'gjogv'].map(city))
  assert.deepEqual(findJourneyCandidates(records, '暑假 · 返程', namesOf).map((item) => item.journeyId), ['journey-long'])
})

test('candidates: a stable order (latest date first, then journeyId), journeys without dates last, whatever the order of the records', () => {
  const specs: Spec[] = [
    { id: 'x1', city: 'reykjavik', start: '2024-07-01', end: '2024-07-10', title: SUMMER, journeyId: 'journey-b' },
    { id: 'x2', city: 'vik', start: '2024-07-05', end: '2024-07-10', title: SUMMER, journeyId: 'journey-a' },
    { id: 'x3', city: 'akureyri', start: '2025-01-01', title: SUMMER, journeyId: 'journey-c' },
    { id: 'x4', city: 'torshavn', start: '', title: SUMMER, journeyId: 'journey-0-undated' },
  ]
  const expected = ['journey-c', 'journey-a', 'journey-b', 'journey-0-undated']
  assert.deepEqual(findJourneyCandidates(recordsOf(specs), SUMMER, namesOf).map((item) => item.journeyId), expected)
  assert.deepEqual(findJourneyCandidates(recordsOf([...specs].reverse()), SUMMER, namesOf).map((item) => item.journeyId), expected)
  const undated = findJourneyCandidates(recordsOf(specs), SUMMER, namesOf).at(-1)!
  assert.equal(Object.hasOwn(undated, 'startDate') || Object.hasOwn(undated, 'endDate'), false)
})
