/** RD-04 calendar matching. Raw source fields are supplied by the caller.
 * No source IDs, visibility decisions, storage, clocks or application imports.
 */

export interface TimeFilter {
  readonly from?: string
  readonly to?: string
  readonly includeUncertain: boolean
}

export type TimeFilterError = 'invalid-filter' | 'invalid-from' | 'invalid-to'
  | 'reversed-range' | 'invalid-include-uncertain' | 'invalid-year'

export type TimeFilterNormalization =
  | { readonly ok: true; readonly filter: TimeFilter }
  | { readonly ok: false; readonly errors: readonly TimeFilterError[] }

/** Inject start_date/end_date/year, or addedAt/visitedDate as startDate.
 * Unknown types are accepted here so malformed historical data can be classified.
 */
export interface RecordDateInput {
  readonly startDate?: unknown
  readonly endDate?: unknown
  readonly year?: unknown
}

export interface CalendarRange {
  readonly from?: string
  readonly to?: string
}

export type DateQuality = 'valid' | 'partial' | 'missing' | 'invalid'
export type DatePrecision = 'day' | 'year' | 'unknown'
export type DateIssue = 'invalid-start' | 'invalid-end' | 'invalid-year'
  | 'partial-start' | 'partial-end' | 'conflicting-year' | 'reversed-range'

export interface DateEvidence {
  readonly quality: DateQuality
  readonly precision: DatePrecision
  /** Exact interval for day precision; possible interval otherwise.
   * Missing bounds mean unbounded, not an invented calendar date.
   */
  readonly range: CalendarRange
  readonly issues: readonly DateIssue[]
}

export type DateMatch = 'definite' | 'uncertain' | 'excluded'
export interface DateMatchResult {
  readonly match: DateMatch
  /** All time includes every input, even when its date remains uncertain.
   * Callers still apply their existing visibility/container rules.
   */
  readonly included: boolean
  readonly date: DateEvidence
}

const validYear = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 9999

const yearRange = (year: number): { from: string; to: string } => {
  const text = String(year).padStart(4, '0')
  return { from: `${text}-01-01`, to: `${text}-12-31` }
}

/** Strict proleptic Gregorian date; no Date parsing or timezone conversion. */
export const isCalendarDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  if (!validYear(year) || month < 1 || month > 12 || day < 1) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day <= days[month - 1]
}

/** Blank UI bounds become absent. Errors contain no replacement filter: a
 * caller can keep its last effective condition instead of applying bad drafts.
 * null/wrong types are rejected (including persisted includeUncertain strings).
 */
export const normalizeTimeFilter = (input: unknown): TimeFilterNormalization => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['invalid-filter'] }
  }
  const raw = input as Record<string, unknown>
  const errors: TimeFilterError[] = []
  const from = raw.from === '' || raw.from === undefined ? undefined : raw.from
  const to = raw.to === '' || raw.to === undefined ? undefined : raw.to
  if (from !== undefined && !isCalendarDate(from)) errors.push('invalid-from')
  if (to !== undefined && !isCalendarDate(to)) errors.push('invalid-to')
  if (raw.includeUncertain !== undefined && typeof raw.includeUncertain !== 'boolean') {
    errors.push('invalid-include-uncertain')
  }
  if (isCalendarDate(from) && isCalendarDate(to) && from > to) errors.push('reversed-range')
  if (errors.length) return { ok: false, errors }
  const filter: { from?: string; to?: string; includeUncertain: boolean } = {
    includeUncertain: raw.includeUncertain === true,
  }
  if (typeof from === 'string') filter.from = from
  if (typeof to === 'string') filter.to = to
  return { ok: true, filter }
}

/** The shortcut produces precisely the same condition as manually entered dates. */
export const timeFilterForYear = (year: unknown, includeUncertain: unknown = false): TimeFilterNormalization => {
  if (!validYear(year)) return { ok: false, errors: ['invalid-year'] }
  return normalizeTimeFilter({ ...yearRange(year), includeUncertain })
}

export const isTimeFilterActive = (filter: TimeFilter): boolean =>
  filter.from !== undefined || filter.to !== undefined

type ParsedDate = {
  kind: 'missing' | 'day' | 'year' | 'partial' | 'invalid'
  year?: number
  date?: string
  range: CalendarRange
}

// Record null, undefined and empty strings mean not provided. Only strict YYYY,
// YYYY-MM and complete calendar dates yield a reliable year. Other nonempty
// strings remain partial without guessed bounds; YYYY-MM never promises a day.
const parseRecordField = (value: unknown): ParsedDate => {
  if (value === undefined || value === null || value === '') return { kind: 'missing', range: {} }
  if (typeof value !== 'string') return { kind: 'invalid', range: {} }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const year = Number(value.slice(0, 4))
    return isCalendarDate(value)
      ? { kind: 'day', date: value, year, range: { from: value, to: value } }
      : { kind: 'invalid', year: validYear(year) ? year : undefined, range: {} }
  }
  if (/^\d{4}$/.test(value)) {
    const year = Number(value)
    return validYear(year) ? { kind: 'year', year, range: yearRange(year) } : { kind: 'invalid', range: {} }
  }
  if (/^\d{4}-\d{2}$/.test(value)) {
    const year = Number(value.slice(0, 4))
    const month = Number(value.slice(5))
    return validYear(year) && month >= 1 && month <= 12
      ? { kind: 'partial', year, range: yearRange(year) }
      : { kind: 'invalid', year: validYear(year) ? year : undefined, range: {} }
  }
  return { kind: 'partial', range: {} }
}

/** Read-time classification only: nothing is repaired or written back.
 * Complete start dates take precedence over auxiliary year, including cross-year
 * intervals. For other starts a conflicting year is invalid and neither disputed
 * year restricts the range. An independent valid end can still supply an upper bound.
 */
export const classifyRecordDate = (input: RecordDateInput): DateEvidence => {
  const start = parseRecordField(input.startDate)
  const end = parseRecordField(input.endDate)
  const issues: DateIssue[] = []
  if (start.kind === 'invalid') issues.push('invalid-start')
  if (end.kind === 'invalid') issues.push('invalid-end')
  if (start.kind === 'partial') issues.push('partial-start')
  if (end.kind === 'partial' && end.year === undefined) issues.push('invalid-end')
  else if (end.kind === 'partial' || end.kind === 'year') issues.push('partial-end')

  const hasYear = input.year !== undefined && input.year !== null
  const auxiliaryYear = validYear(input.year) ? input.year : undefined
  // Auxiliary years cannot truncate or invalidate a complete start date.
  if (start.kind !== 'day' && hasYear && auxiliaryYear === undefined) issues.push('invalid-year')
  const conflict = start.kind !== 'day' && start.year !== undefined
    && auxiliaryYear !== undefined && start.year !== auxiliaryYear
  if (conflict) issues.push('conflicting-year')

  if (start.kind === 'day' && (end.kind === 'day' || end.kind === 'missing')) {
    const from = start.date!
    const to = end.date ?? from
    if (from > to) return { quality: 'invalid', precision: 'unknown', range: {}, issues: ['reversed-range'] }
    return { quality: 'valid', precision: 'day', range: { from, to }, issues: [] }
  }

  const knownYear = conflict ? undefined : start.year ?? auxiliaryYear
  const invalid = issues.some(issue => issue.startsWith('invalid-') || issue === 'conflicting-year')
  if (!invalid && knownYear !== undefined && end.kind === 'missing'
    && (start.kind === 'year' || start.kind === 'missing')) {
    return { quality: 'valid', precision: 'year', range: yearRange(knownYear), issues: [] }
  }

  // Use start only as a lower bound and end only as an upper bound. A single
  // uncertain start with no end stays within its reliable year, never a fake day.
  // A malformed full day supplies no bounds; an agreeing auxiliary year is
  // independent evidence used for exclusion only, never for definite matching.
  const startRange = conflict ? {} : start.kind === 'invalid'
    ? auxiliaryYear === undefined ? {} : yearRange(auxiliaryYear)
    : start.range.from === undefined && auxiliaryYear !== undefined ? yearRange(auxiliaryYear) : start.range
  const range: { from?: string; to?: string } = {}
  if (startRange.from !== undefined) range.from = startRange.from
  if (end.kind === 'missing') {
    if (startRange.to !== undefined) range.to = startRange.to
  } else if (end.range.to !== undefined) range.to = end.range.to
  // Contradictory boundaries cannot safely tell us which field is wrong.
  if (range.from !== undefined && range.to !== undefined && range.from > range.to) {
    return { quality: 'invalid', precision: 'unknown', range: {}, issues: [...issues, 'reversed-range'] }
  }
  const missing = start.kind === 'missing' && end.kind === 'missing' && !hasYear
  return { quality: invalid ? 'invalid' : missing ? 'missing' : 'partial', precision: 'unknown', range, issues }
}

/** Accept a validated condition (normalizeTimeFilter/timeFilterForYear).
 * A possible range supports exclusion; only valid day/year evidence supports
 * definite matching. includeUncertain never overrides a disjoint reliable range.
 */
export const matchDateEvidence = (date: DateEvidence, filter: TimeFilter): DateMatchResult => {
  const active = isTimeFilterActive(filter)
  const disjoint = (date.range.to !== undefined && filter.from !== undefined && date.range.to < filter.from)
    || (date.range.from !== undefined && filter.to !== undefined && filter.to < date.range.from)
  let match: DateMatch = 'uncertain'
  if (active && disjoint) match = 'excluded'
  else if (date.quality === 'valid' && date.precision === 'day') match = 'definite'
  else if (date.quality === 'valid' && date.precision === 'year'
    && (filter.from === undefined || (date.range.from !== undefined && filter.from <= date.range.from))
    && (filter.to === undefined || (date.range.to !== undefined && date.range.to <= filter.to))) match = 'definite'
  return { match, included: !active || match === 'definite' || (match === 'uncertain' && filter.includeUncertain), date }
}

export const matchRecordDate = (input: RecordDateInput, filter: TimeFilter): DateMatchResult =>
  matchDateEvidence(classifyRecordDate(input), filter)
