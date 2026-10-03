/// <reference types="node" />
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatRecordDate, formatRecordDateSummary } from './recordDateLabel.ts'
const labels = { unknown: 'Unknown', yearOnly: 'Year only', partial: 'Partial', missing: 'Missing', invalid: 'Needs review' }

test('full intervals preserve both source endpoints without applying query clipping', () => {
  assert.equal(formatRecordDate({ startDate: '2027-12-30', endDate: '2028-01-03', year: 2027 }, labels), '2027-12-30 – 2028-01-03')
  assert.equal(formatRecordDate({ startDate: '2025-01-01', endDate: '2025-01-01' }, labels), '2025-01-01')
})
test('year-only sources do not display invented January dates', () => {
  assert.equal(formatRecordDate({ startDate: '2025' }, labels), '2025 · Year only')
  assert.equal(formatRecordDate({ year: 1 }, labels), '0001 · Year only')
})
test('invalid dates retain the original text with review wording', () => {
  assert.equal(formatRecordDate({ startDate: '2025-02-29', year: 2025 }, labels), '2025-02-29 · Needs review')
  assert.equal(formatRecordDate({ startDate: '2025-02-01', endDate: '2025-01-01' }, labels), '2025-02-01 – 2025-01-01 · Needs review')
})
test('missing and partial dates keep separate quality labels', () => {
  assert.equal(formatRecordDate({}, labels), 'Unknown · Missing')
  assert.equal(formatRecordDate({ startDate: '2025-06' }, labels), '2025-06 · Partial')
  assert.equal(formatRecordDate({ endDate: '2025-06-01' }, labels), 'Unknown – 2025-06-01 · Partial')
})
test('non-string historical fields never render as objects or arrays', () => {
  assert.equal(formatRecordDate({ startDate: { year: 2025 }, endDate: [] }, labels), 'Unknown · Needs review')
  assert.equal(formatRecordDate({ startDate: 2025, year: 2025 }, labels), '2025 · Needs review')
})
test('wording is injected and neither labels nor original fields are changed', () => {
  const input = Object.freeze({ startDate: '2025-02-29' })
  const zh = Object.freeze({ unknown: '日期未知', yearOnly: '仅年份', partial: '日期不完整', missing: '日期缺失', invalid: '需核对' })
  assert.equal(formatRecordDate(input, zh), '2025-02-29 · 需核对')
  assert.deepEqual(input, { startDate: '2025-02-29' })
})
test('an already-coerced summary is rebuilt from mixed malformed and valid sources', () => {
  const records = [{ startDate: { broken: true } }, { startDate: '2025-01-01' }]
  assert.equal(formatRecordDateSummary('2025-01-01 - [object Object]', records, labels), 'Unknown · Needs review · 2025-01-01')
})
test('valid day summaries keep their original display and separator', () => {
  assert.equal(formatRecordDateSummary('2025-01-01 - 2025-06-01', [{ startDate: '2025-01-01' }, { startDate: '2025-06-01' }], labels), '2025-01-01 - 2025-06-01')
  assert.equal(formatRecordDateSummary('Date unknown', [], labels), 'Date unknown')
})
test('summary fallbacks expose year precision and safely handle empty non-string summaries', () => {
  assert.equal(formatRecordDateSummary('Date unknown', [{ year: 2025 }], labels), '2025 · Year only')
  assert.equal(formatRecordDateSummary({}, [], labels), 'Unknown')
})
