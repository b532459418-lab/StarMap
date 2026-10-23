/// <reference types="node" />
/**
 * The journey rules as the store-native writes use them (3C-5 C2): the candidates from only the records that matter
 * (the titled visited records and every member of their journeys) equal the candidates from every record, in any
 * order; decideJourney asks for candidates only when it needs them. The V2 behaviour is ../../v2write/journeyChoice.test.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideJourney, findJourneyCandidates, type JourneyRecord } from './journeys.ts'
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
