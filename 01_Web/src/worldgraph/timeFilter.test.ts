/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyRecordDate,
  isCalendarDate,
  isTimeFilterActive,
  matchDateEvidence,
  matchRecordDate,
  normalizeTimeFilter,
  timeFilterForYear,
  type RecordDateInput,
  type TimeFilter,
} from './timeFilter.ts'

const filter = (input: unknown): TimeFilter => {
  const result = normalizeTimeFilter(input)
  assert.equal(result.ok, true)
  if (!result.ok) throw new Error('Invalid test condition')
  return result.filter
}
const yearFilter = (year: number, includeUncertain = false): TimeFilter => {
  const result = timeFilterForYear(year, includeUncertain)
  assert.equal(result.ok, true)
  if (!result.ok) throw new Error('Invalid test year')
  return result.filter
}

test('calendar validation checks Gregorian leap centuries and the supported year limits', () => {
  for (const day of ['0001-01-01', '9999-12-31', '2000-02-29', '2024-02-29', '2400-02-29']) {
    assert.equal(isCalendarDate(day), true, day)
  }
  for (const day of ['0000-01-01', '10000-01-01', '1900-02-29', '2100-02-29', '2025-02-29',
    '2024-02-31', '2025-04-31', '2025-00-01', '2025-13-01', '2025-01-00', '2025-01-32',
    '2025-1-01', '2025-01-1', '2025-01-01T00:00:00Z', ' 2025-01-01', '2025-01-01\n',
    '2025', '', undefined, null, 20250101]) {
    assert.equal(isCalendarDate(day), false, String(day))
  }
})

test('empty conditions normalize to all time and single bounds stay open', () => {
  assert.deepEqual(filter({}), { includeUncertain: false })
  assert.deepEqual(filter({ from: '', to: '', includeUncertain: true }), { includeUncertain: true })
  assert.deepEqual(filter({ from: '0001-01-01' }), { from: '0001-01-01', includeUncertain: false })
  assert.deepEqual(filter({ to: '9999-12-31' }), { to: '9999-12-31', includeUncertain: false })
  assert.equal(isTimeFilterActive(filter({ includeUncertain: true })), false)
  assert.equal(isTimeFilterActive(filter({ from: '2025-01-01' })), true)
})

test('invalid drafts return errors without a substitute effective condition', () => {
  for (const input of [null, [], '2025', { from: null }, { from: 2025 }, { to: '2025' },
    { from: '2025-02-29' }, { to: '2024-02-31' }, { includeUncertain: 'false' },
    { includeUncertain: null }, { from: '2025-12-31', to: '2025-01-01' }]) {
    const result = normalizeTimeFilter(input)
    assert.equal(result.ok, false, JSON.stringify(input))
    assert.equal('filter' in result, false)
  }
  assert.deepEqual(normalizeTimeFilter({ from: 'bad', to: 'bad', includeUncertain: 1 }), {
    ok: false, errors: ['invalid-from', 'invalid-to', 'invalid-include-uncertain'],
  })
})

test('year shortcuts accept only integer years in 0001–9999', () => {
  assert.deepEqual(yearFilter(1), filter({ from: '0001-01-01', to: '0001-12-31' }))
  assert.deepEqual(yearFilter(9999), filter({ from: '9999-01-01', to: '9999-12-31' }))
  for (const year of [0, 10000, -1, 2025.5, '2025', NaN, Infinity, null, undefined]) {
    assert.equal(timeFilterForYear(year).ok, false)
  }
  assert.equal(timeFilterForYear(2025, 'true').ok, false)
})

test('TF-02 shortcuts and manual equivalent intervals have identical results for every quality', () => {
  const records: RecordDateInput[] = [
    { startDate: '2025-06-15' }, { startDate: '2024-12-30', endDate: '2025-01-03' },
    { startDate: '2025' }, { year: 2025 }, { startDate: '2026' }, { startDate: '2025-06' },
    { endDate: '2024-12-31' }, { startDate: '2025-02-29', year: 2025 }, {},
  ]
  for (const includeUncertain of [false, true]) {
    const manual = filter({ from: '2025-01-01', to: '2025-12-31', includeUncertain })
    const shortcut = yearFilter(2025, includeUncertain)
    assert.deepEqual(shortcut, manual)
    assert.deepEqual(records.map(record => matchRecordDate(record, shortcut)),
      records.map(record => matchRecordDate(record, manual)))
  }
})

test('TF-01 individual 2022 and 2025 visits do not invent a 2023 visit', () => {
  for (const startDate of ['2022-06-01', '2025-06-01']) {
    const result = matchRecordDate({ startDate }, yearFilter(2023, true))
    assert.equal(result.match, 'excluded')
    assert.equal(result.included, false)
  }
})

test('TF-03 trusted year is definite for full coverage, uncertain for a month, excluded for another year', () => {
  for (const input of [{ startDate: '2025' }, { year: 2025 }, { startDate: '', year: 2025 },
    { startDate: '2025', year: 2025, endDate: '' }]) {
    const date = classifyRecordDate(input)
    assert.equal(date.quality, 'valid')
    assert.equal(date.precision, 'year')
    assert.deepEqual(date.range, { from: '2025-01-01', to: '2025-12-31' })
    assert.equal(matchRecordDate(input, yearFilter(2025)).match, 'definite')
    for (const includeUncertain of [false, true]) {
      const june = matchRecordDate(input, filter({ from: '2025-06-01', to: '2025-06-30', includeUncertain }))
      assert.equal(june.match, 'uncertain')
      assert.equal(june.included, includeUncertain)
      const next = matchRecordDate(input, yearFilter(2026, includeUncertain))
      assert.equal(next.match, 'excluded')
      assert.equal(next.included, false)
    }
  }
})

test('trusted year also matches a wider or open interval covering the entire year', () => {
  const date = classifyRecordDate({ year: 2025 })
  for (const input of [{ from: '2024-01-01', to: '2026-12-31' }, { from: '2025-01-01' },
    { to: '2025-12-31' }, {}]) {
    assert.equal(matchDateEvidence(date, filter(input)).match, 'definite')
  }
  for (const input of [{ from: '2025-01-02' }, { to: '2025-12-30' }]) {
    assert.equal(matchDateEvidence(date, filter(input)).match, 'uncertain')
  }
})

test('TF-04 cross-year exact dates are not truncated or overridden by auxiliary year', () => {
  const input = { startDate: '2024-12-30', endDate: '2025-01-03', year: 2024 }
  assert.deepEqual(classifyRecordDate(input), {
    quality: 'valid', precision: 'day', range: { from: '2024-12-30', to: '2025-01-03' }, issues: [],
  })
  assert.equal(matchRecordDate(input, yearFilter(2024)).match, 'definite')
  assert.equal(matchRecordDate(input, yearFilter(2025)).match, 'definite')
  assert.equal(matchRecordDate(input, yearFilter(2026, true)).match, 'excluded')
  assert.deepEqual(classifyRecordDate({ ...input, year: 1990 }), classifyRecordDate(input))
  assert.deepEqual(classifyRecordDate({ ...input, year: 'bad' }), classifyRecordDate(input))
})

test('TF-05 exact intervals overlap at either closed boundary and exclude just outside', () => {
  const input = { startDate: '2025-06-10', endDate: '2025-06-20' }
  for (const [from, to] of [['2025-06-01', '2025-06-10'], ['2025-06-20', '2025-06-30'],
    ['2025-06-15', '2025-06-15'], ['2025-06-01', '2025-06-30']]) {
    assert.equal(matchRecordDate(input, filter({ from, to })).match, 'definite')
  }
  for (const [from, to] of [['2025-06-01', '2025-06-09'], ['2025-06-21', '2025-06-30']]) {
    assert.equal(matchRecordDate(input, filter({ from, to, includeUncertain: true })).match, 'excluded')
  }
})

test('TF-06 one-sided query bounds work for exact dates and reliable years', () => {
  const input = { startDate: '2024-12-30', endDate: '2025-01-03' }
  assert.equal(matchRecordDate(input, filter({ from: '2025-01-03' })).match, 'definite')
  assert.equal(matchRecordDate(input, filter({ from: '2025-01-04' })).match, 'excluded')
  assert.equal(matchRecordDate(input, filter({ to: '2024-12-30' })).match, 'definite')
  assert.equal(matchRecordDate(input, filter({ to: '2024-12-29' })).match, 'excluded')
  assert.equal(matchRecordDate({ year: 2025 }, filter({ to: '2024-12-31', includeUncertain: true })).included, false)
})

test('TF-07 omitted and empty end dates mean one day; malformed nonempty ends never fall back to one day', () => {
  for (const endDate of [undefined, null, '']) {
    const date = classifyRecordDate({ startDate: '2025-06-10', endDate })
    assert.equal(date.quality, 'valid')
    assert.deepEqual(date.range, { from: '2025-06-10', to: '2025-06-10' })
  }
  for (const endDate of ['bad', '2025-02-29', 2025, ' ']) {
    const date = classifyRecordDate({ startDate: '2025-06-10', endDate })
    assert.equal(date.quality, 'invalid')
    assert.equal(date.precision, 'unknown')
    assert.equal(date.range.to, undefined)
    assert.equal(matchDateEvidence(date, yearFilter(2025)).match, 'uncertain')
  }
})

test('TF-08 impossible days and inverted intervals require review', () => {
  for (const startDate of ['2025-02-29', '2024-02-31', '2025-04-31', '0000-01-01']) {
    assert.equal(classifyRecordDate({ startDate }).quality, 'invalid')
  }
  assert.equal(classifyRecordDate({ startDate: '2024-02-29' }).precision, 'day')
  const inverted = classifyRecordDate({ startDate: '2025-06-20', endDate: '2025-06-10', year: 2025 })
  assert.deepEqual(inverted, { quality: 'invalid', precision: 'unknown', range: {}, issues: ['reversed-range'] })
  assert.equal(matchDateEvidence(inverted, yearFilter(2025)).match, 'uncertain')
})

test('TF-09 end-only evidence reliably excludes later queries but never invents a start or definite hit', () => {
  for (const endDate of ['2025-06-10', '2025', '2025-06']) {
    const date = classifyRecordDate({ endDate })
    assert.equal(date.quality, 'partial')
    assert.equal(date.range.from, undefined)
    assert.equal(matchDateEvidence(date, yearFilter(2026, true)).match, 'excluded')
    assert.equal(matchDateEvidence(date, yearFilter(2026, true)).included, false)
    assert.equal(matchDateEvidence(date, yearFilter(2025)).match, 'uncertain')
    assert.equal(matchDateEvidence(date, yearFilter(2024)).match, 'uncertain')
  }
  const date = classifyRecordDate({ endDate: '2025-06-10' })
  assert.equal(matchDateEvidence(date, filter({ from: '2025-06-11', includeUncertain: true })).included, false)
  assert.equal(matchDateEvidence(date, filter({ from: '2025-06-10' })).match, 'uncertain')
})

test('TF-10 missing dates, partial month formats and invalid days have separate quality', () => {
  assert.equal(classifyRecordDate({}).quality, 'missing')
  assert.equal(classifyRecordDate({ startDate: '', endDate: null }).quality, 'missing')
  const month = classifyRecordDate({ startDate: '2025-06' })
  assert.equal(month.quality, 'partial')
  assert.equal(month.precision, 'unknown')
  assert.equal(matchDateEvidence(month, yearFilter(2025)).match, 'uncertain')
  assert.equal(matchDateEvidence(month, yearFilter(2026, true)).included, false)
  const otherFormat = classifyRecordDate({ startDate: 'June 2025' })
  assert.equal(otherFormat.quality, 'partial')
  assert.deepEqual(otherFormat.range, {})
  assert.equal(classifyRecordDate({ startDate: '2025-13' }).quality, 'invalid')
  assert.equal(classifyRecordDate({ startDate: 2025 }).quality, 'invalid')
})

test('invalid full dates with a year remain invalid, even if the query covers that entire year', () => {
  const date = classifyRecordDate({ startDate: '2025-02-29', year: 2025 })
  assert.equal(date.quality, 'invalid')
  assert.equal(date.precision, 'unknown')
  assert.equal(matchDateEvidence(date, yearFilter(2025)).match, 'uncertain')
  assert.equal(matchDateEvidence(date, yearFilter(2025)).included, false)
  assert.equal(matchDateEvidence(date, yearFilter(2025, true)).included, true)
  assert.equal(matchDateEvidence(date, yearFilter(2026, true)).included, false)
  // The invalid date's prefix alone is not independent reliable year evidence.
  assert.deepEqual(classifyRecordDate({ startDate: '2025-02-29' }).range, {})
})

test('conflicting year fields are invalid; neither disputed year determines exclusion', () => {
  for (const startDate of ['2025', '2025-06', '2025-13', '2025-02-29']) {
    const date = classifyRecordDate({ startDate, year: 2024 })
    assert.equal(date.quality, 'invalid')
    assert.ok(date.issues.includes('conflicting-year'))
    assert.deepEqual(date.range, {})
    assert.equal(matchDateEvidence(date, yearFilter(2024, true)).match, 'uncertain')
    assert.equal(matchDateEvidence(date, yearFilter(2025, true)).match, 'uncertain')
  }
})

test('explicit year must be a valid integer and cannot produce valid year evidence from malformed data', () => {
  for (const year of ['2025', 2025.5, 0, 10000, NaN]) {
    const date = classifyRecordDate({ year })
    assert.equal(date.quality, 'invalid')
    assert.ok(date.issues.includes('invalid-year'))
  }
  const date = classifyRecordDate({ startDate: '2025', year: '2025' })
  assert.equal(date.quality, 'invalid')
  assert.equal(matchDateEvidence(date, yearFilter(2025)).match, 'uncertain')
  assert.equal(matchDateEvidence(date, yearFilter(2026, true)).match, 'excluded')
})

test('partial start/end pairs cannot turn into exact or trusted-year hits', () => {
  for (const input of [
    { startDate: '2024', endDate: '2025-01-03' },
    { startDate: '2024-12', endDate: '2025-01-03' },
    { startDate: '2024-12-30', endDate: '2025' },
    { year: 2024, endDate: '2025-01-03' },
  ]) {
    const date = classifyRecordDate(input)
    assert.equal(date.quality, 'partial')
    assert.equal(matchDateEvidence(date, filter({ from: '2024-01-01', to: '2025-12-31' })).match, 'uncertain')
    assert.equal(matchDateEvidence(date, yearFilter(2026, true)).match, 'excluded')
    assert.equal(matchDateEvidence(date, yearFilter(2023, true)).match, 'excluded')
  }
})

test('invalid records retain independent reliable bounds only for exclusion', () => {
  const badStart = classifyRecordDate({ startDate: '2025-02-29', endDate: '2025-06-10' })
  assert.equal(badStart.quality, 'invalid')
  assert.deepEqual(badStart.range, { to: '2025-06-10' })
  assert.equal(matchDateEvidence(badStart, filter({ from: '2025-06-11', includeUncertain: true })).match, 'excluded')
  assert.equal(matchDateEvidence(badStart, yearFilter(2025)).match, 'uncertain')
  const badEnd = classifyRecordDate({ startDate: '2025-06-10', endDate: '2025-06-99' })
  assert.deepEqual(badEnd.range, { from: '2025-06-10' })
  assert.equal(matchDateEvidence(badEnd, filter({ to: '2025-06-09', includeUncertain: true })).included, false)
  assert.equal(matchDateEvidence(badEnd, yearFilter(2026)).match, 'uncertain')
  const conflictWithEnd = classifyRecordDate({ startDate: '2025', year: 2024, endDate: '2025-06-10' })
  assert.deepEqual(conflictWithEnd.range, { to: '2025-06-10' })
  assert.equal(matchDateEvidence(conflictWithEnd, yearFilter(2026, true)).included, false)
})

test('contradictory partial boundaries require review without unsafe exclusions', () => {
  const date = classifyRecordDate({ startDate: '2025', endDate: '2024-12-31' })
  assert.equal(date.quality, 'invalid')
  assert.ok(date.issues.includes('reversed-range'))
  assert.deepEqual(date.range, {})
  assert.equal(matchDateEvidence(date, yearFilter(2025, true)).match, 'uncertain')
})

test('missing and unbounded partial records remain uncertain under concrete queries', () => {
  for (const input of [{}, { startDate: 'unknown' }, { startDate: '2025-02-29' }]) {
    for (const includeUncertain of [false, true]) {
      const result = matchRecordDate(input, yearFilter(2025, includeUncertain))
      assert.equal(result.match, 'uncertain')
      assert.equal(result.included, includeUncertain)
    }
  }
})

test('TF-28 all time preserves inclusion regardless of quality and uncertain switch', () => {
  const records: RecordDateInput[] = [
    { startDate: '2025-06-10' }, { year: 2025 }, { endDate: '2025-06-10' }, {},
    { startDate: '2025-02-29' }, { startDate: '2025', year: 2024 },
    { startDate: '2025-06-20', endDate: '2025-06-10' },
  ]
  for (const record of records) {
    for (const includeUncertain of [false, true]) {
      const result = matchRecordDate(record, filter({ includeUncertain }))
      assert.equal(result.included, true)
      assert.notEqual(result.match, 'excluded')
      assert.deepEqual(result.date, classifyRecordDate(record))
    }
  }
  assert.equal(matchRecordDate({}, filter({})).match, 'uncertain')
})

test('source-independent injected dates give equal results and do not depend on source IDs', () => {
  const travel = { id: 'same', start_date: '2025-06-10' }
  const saved = { id: 'same', addedAt: '2025-06-10' }
  const country = { placeId: 'country', visitedDate: '2025-06-10' }
  const inputs = [{ startDate: travel.start_date }, { startDate: saved.addedAt }, { startDate: country.visitedDate }]
  const results = inputs.map(input => matchRecordDate(input, yearFilter(2025)))
  assert.deepEqual(results[0], results[1])
  assert.deepEqual(results[1], results[2])
})

test('TF-29 normalization, classification and matching preserve frozen inputs and are repeatable', () => {
  const input = Object.freeze({ startDate: '2024-12-30', endDate: '2025-01-03', year: 2024 })
  const draft = Object.freeze({ from: '2025-01-01', to: '2025-12-31', includeUncertain: true })
  const before = JSON.stringify({ input, draft })
  const condition = Object.freeze(filter(draft))
  const date = classifyRecordDate(input)
  Object.freeze(date.range)
  Object.freeze(date.issues)
  Object.freeze(date)
  assert.deepEqual(matchDateEvidence(date, condition), matchRecordDate(input, condition))
  assert.deepEqual(matchRecordDate(input, condition), matchRecordDate(input, condition))
  assert.equal(JSON.stringify({ input, draft }), before)
})
