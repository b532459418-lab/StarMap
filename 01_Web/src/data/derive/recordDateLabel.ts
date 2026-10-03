import { classifyRecordDate, type RecordDateInput } from '../../worldgraph/timeFilter.ts'

export interface RecordDateLabels {
  unknown: string
  yearOnly: string
  partial: string
  missing: string
  invalid: string
}

/** Preserve source strings and precision; callers supply localized wording.
 * Malformed non-string fields never become an object label or a guessed date.
 */
export const formatRecordDate = (input: RecordDateInput, labels: RecordDateLabels): string => {
  const evidence = classifyRecordDate(input)
  const year = typeof input.year === 'number' && Number.isInteger(input.year) && input.year >= 1 && input.year <= 9999
    ? String(input.year).padStart(4, '0') : undefined
  const start = typeof input.startDate === 'string' && input.startDate ? input.startDate : year ?? labels.unknown
  const text = typeof input.endDate === 'string' && input.endDate && input.endDate !== start
    ? `${start} – ${input.endDate}` : start
  return evidence.quality !== 'valid' ? `${text} · ${labels[evidence.quality]}`
    : evidence.precision === 'year' ? `${text} · ${labels.yearOnly}` : text
}

/** Keep existing summaries for complete valid dates. A summary may already be a
 * string containing coerced malformed fields, so inspect its original records.
 */
export const formatRecordDateSummary = (summary: unknown, records: readonly RecordDateInput[], labels: RecordDateLabels): string => {
  const reliable = records.every(record => {
    const date = classifyRecordDate(record)
    return date.quality === 'valid' && date.precision === 'day'
  })
  if (typeof summary === 'string' && reliable) return summary
  return records.length ? [...new Set(records.map(record => formatRecordDate(record, labels)))].join(' · ') : labels.unknown
}
