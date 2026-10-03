/// <reference types="node" />
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyRecordDate } from './timeFilter.ts'
import { evaluateTimeQueryRecords, timeRecordLayer, type TimeQueryContext, type TimeQueryRecord } from './timeQuery.ts'
import type { RecordSourceKind } from './recordIdentity.ts'

const record = (sourceKind: RecordSourceKind, recordId: string, startDate?: string, extra: Partial<TimeQueryRecord> = {}): TimeQueryRecord => ({
  sourceKind, recordId, placeId: 'city', countryId: 'country', browsable: true,
  date: classifyRecordDate({ startDate }), ...extra,
})
const context = (...records: TimeQueryRecord[]): TimeQueryContext => ({ records, originalRoutes: [] })
const year2025 = { from: '2025-01-01', to: '2025-12-31', includeUncertain: false }

test('source kinds choose their own layer; country evidence does not share the want-to-go filter', () => {
  assert.equal(timeRecordLayer({ sourceKind: 'travel', recordId: 'x' }), 'travel')
  assert.equal(timeRecordLayer({ sourceKind: 'country-visit', recordId: 'x' }), 'travel')
  assert.equal(timeRecordLayer({ sourceKind: 'planned', recordId: 'x' }), 'want_to_go')
  assert.equal(timeRecordLayer({ sourceKind: 'want-to-go', recordId: 'x' }), 'want_to_go')
})

test('colliding opaque IDs keep source identity and each layer evaluates independently', () => {
  const data = context(record('travel', 'x__:', '2022-01-01'), record('planned', 'x__:', '2027-01-01'),
    record('want-to-go', 'x__:', '2025-01-01'), record('country-visit', 'x__:', '2025-01-01'))
  const results = evaluateTimeQueryRecords(data, { travel: year2025, want_to_go: { from: '2027-01-01', to: '2027-12-31', includeUncertain: false } })
  assert.deepEqual(results.map(({ record, result }) => [record.sourceKind, result.match, result.included]), [
    ['travel', 'excluded', false], ['planned', 'definite', true], ['want-to-go', 'excluded', false], ['country-visit', 'definite', true],
  ])
})

test('hidden records are absent from date-quality notifications; navigation hiding stays independent', () => {
  const data = context(record('travel', 'hidden', undefined, { browsable: false }),
    record('travel', 'navigation-only', undefined, { navigationHidden: true }),
    record('want-to-go', 'hidden-wish', undefined, { browsable: false }))
  const result = evaluateTimeQueryRecords(data, { travel: year2025 })
  assert.deepEqual(result.map(entry => entry.record.recordId), ['navigation-only'])
  assert.equal(result[0].result.match, 'uncertain')
  assert.equal(result[0].result.included, false)
})

test('uncertain inclusion never overrides a known disjoint year and does not filter the other layer', () => {
  const data = context(record('travel', 'old-year', '2022'), record('travel', 'missing'), record('planned', 'future', '2027-01-01'))
  const result = evaluateTimeQueryRecords(data, { travel: { ...year2025, includeUncertain: true } })
  assert.deepEqual(result.map(entry => [entry.record.recordId, entry.result.included]), [
    ['old-year', false], ['missing', true], ['future', true],
  ])
  assert.equal(result[1].result.match, 'uncertain')
})

test('all-time retains missing evidence; duplicate IDs within one source keep the first record', () => {
  const data = context(record('travel', 'same'), record('travel', 'same', '2025-01-01'), record('planned', 'same'))
  const result = evaluateTimeQueryRecords(data, {})
  assert.equal(result.length, 2)
  assert.ok(result.every(entry => entry.result.included))
  assert.ok(result.every(entry => entry.result.match === 'uncertain'))
})

test('frozen contexts and conditions remain unchanged across evaluations', () => {
  const data = context(record('travel', 'trip', '2025-06-01'))
  const filters = { travel: year2025 }
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  const before = JSON.stringify({ data, filters })
  freeze(data)
  freeze(filters)
  assert.deepEqual(evaluateTimeQueryRecords(data, filters), evaluateTimeQueryRecords(data, filters))
  assert.equal(JSON.stringify({ data, filters }), before)
})
