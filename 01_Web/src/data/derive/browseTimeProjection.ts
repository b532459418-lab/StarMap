/** Browse-only projection. Full source data and management inputs remain intact. */
import { TRAVEL_LAYER_ID } from '../../worldgraph/layers.ts'
import { recordRefKey } from '../../worldgraph/recordIdentity.ts'
import { classifyRecordDate, type TimeFilter } from '../../worldgraph/timeFilter.ts'
import { evaluateTimeQueryRecords, type LayerTimeFilters, type MatchedTimeRecord, type TimeQueryContext } from '../../worldgraph/timeQuery.ts'
import type { City, JourneyDay } from '../../types/travel.ts'

export interface BrowseEvidenceCounts {
  readonly records: number
  readonly cities: number
  readonly countries: number
  readonly countryEvidence: number
}

export interface JourneyTimeYear {
  readonly year: number
  readonly records: readonly MatchedTimeRecord[]
}

export interface BrowseTimeProjection {
  readonly matchedRecords: readonly MatchedTimeRecord[]
  readonly includedRecords: readonly MatchedTimeRecord[]
  readonly travelRecordIds: ReadonlySet<string>
  readonly travelMatchesById: ReadonlyMap<string, MatchedTimeRecord>
  readonly travelByPlace: ReadonlyMap<string, readonly MatchedTimeRecord[]>
  readonly countryIds: ReadonlySet<string>
  readonly cityIds: ReadonlySet<string>
  readonly definiteCountryIds: ReadonlySet<string>
  readonly uncertainCountryIds: ReadonlySet<string>
  readonly definiteCityIds: ReadonlySet<string>
  readonly uncertainCityIds: ReadonlySet<string>
  readonly travelStats: {
    readonly definite: BrowseEvidenceCounts
    readonly uncertain: BrowseEvidenceCounts
  }
  readonly journeyYears: readonly JourneyTimeYear[]
  readonly orderedJourneyRecords: readonly MatchedTimeRecord[]
  readonly uncertainJourneyRecords: readonly MatchedTimeRecord[]
}

const yearText = (year: number) => String(year).padStart(4, '0')

/** Only reliable bounded dates can name a year. A partial month retains its
 * known year, but unknown/unbounded or invalid evidence never invents one. */
const groupingRange = (match: MatchedTimeRecord) => {
  const { date } = match.record
  if (date.quality === 'invalid' || date.quality === 'missing') return undefined
  const { from, to } = date.range
  if (!from || !to) return undefined
  if (date.quality === 'partial' && from.slice(0, 4) !== to.slice(0, 4)) return undefined
  return { from, to }
}

export const buildBrowseTimeProjection = (
  context: TimeQueryContext, filters: LayerTimeFilters,
): BrowseTimeProjection => {
  const matchedRecords = evaluateTimeQueryRecords(context, filters)
  const includedRecords = matchedRecords.filter(match => match.result.included)
  const travelMatches = includedRecords.filter(match => match.record.sourceKind === 'travel')
  const travelMatchesById = new Map(travelMatches.map(match => [match.record.recordId, match]))
  const orderedJourneyRecords = [...travelMatches].sort((left, right) => {
    const leftRange = groupingRange(left)
    const rightRange = groupingRange(right)
    return Number(leftRange === undefined) - Number(rightRange === undefined)
      || (rightRange?.from ?? '').localeCompare(leftRange?.from ?? '')
      || right.record.recordId.localeCompare(left.record.recordId)
  })
  const travelRecordIds = new Set(travelMatchesById.keys())
  const travelByPlace = new Map<string, MatchedTimeRecord[]>()
  const definiteCityIds = new Set<string>()
  const uncertainCityIds = new Set<string>()
  const definiteCountryIds = new Set<string>()
  const uncertainCountryIds = new Set<string>()
  const definite = { records: 0, cities: 0, countries: 0, countryEvidence: 0 }
  const uncertain = { records: 0, cities: 0, countries: 0, countryEvidence: 0 }
  for (const match of includedRecords) {
    const { record, result } = match
    if (record.sourceKind !== 'travel' && record.sourceKind !== 'country-visit') continue
    const certain = result.match === 'definite'
    const counts = certain ? definite : uncertain
    if (record.countryId) (certain ? definiteCountryIds : uncertainCountryIds).add(record.countryId)
    if (record.sourceKind === 'country-visit') {
      counts.countryEvidence += 1
      continue
    }
    counts.records += 1
    const cities = certain ? definiteCityIds : uncertainCityIds
    cities.add(record.placeId)
    const visits = travelByPlace.get(record.placeId) ?? []
    visits.push(match)
    travelByPlace.set(record.placeId, visits)
  }
  // A place with definite evidence is not counted again as an additional
  // uncertain place. Its uncertain source records remain visible in the count.
  for (const id of definiteCityIds) uncertainCityIds.delete(id)
  for (const id of definiteCountryIds) uncertainCountryIds.delete(id)
  definite.cities = definiteCityIds.size
  definite.countries = definiteCountryIds.size
  uncertain.cities = uncertainCityIds.size
  uncertain.countries = uncertainCountryIds.size
  const cityIds = new Set([...definiteCityIds, ...uncertainCityIds])
  const countryIds = new Set([...definiteCountryIds, ...uncertainCountryIds])

  const filter: TimeFilter = filters[TRAVEL_LAYER_ID] ?? { includeUncertain: false }
  const years = new Map<number, MatchedTimeRecord[]>()
  const uncertainJourneyRecords: MatchedTimeRecord[] = []
  for (const match of travelMatches) {
    const range = groupingRange(match)
    if (!range) {
      uncertainJourneyRecords.push(match)
      continue
    }
    const from = filter.from && filter.from > range.from ? filter.from : range.from
    const to = filter.to && filter.to < range.to ? filter.to : range.to
    if (from > to) continue
    const first = Number(from.slice(0, 4))
    const last = Number(to.slice(0, 4))
    for (let year = first; year <= last; year += 1) {
      const text = yearText(year)
      if (range.from > `${text}-12-31` || range.to < `${text}-01-01`) continue
      const records = years.get(year) ?? []
      records.push(match)
      years.set(year, records)
    }
  }
  return {
    matchedRecords, includedRecords, travelRecordIds, travelMatchesById, travelByPlace,
    countryIds, cityIds, definiteCountryIds, uncertainCountryIds, definiteCityIds, uncertainCityIds,
    travelStats: { definite, uncertain },
    journeyYears: [...years].sort(([left], [right]) => right - left).map(([year, records]) => ({ year, records })),
    orderedJourneyRecords,
    uncertainJourneyRecords,
  }
}

/** Component fallback for callers not yet injecting the full raw-record context.
 * It reads supplied data only, avoiding module-level application projections. */
export const journeyTimeContext = (
  days: readonly JourneyDay[], cities: Readonly<Record<string, City>>,
): TimeQueryContext => ({
  originalRoutes: [],
  records: days.map(day => {
    const source = cities[day.cityId]?.records?.find(record => record.id === day.id)
    return {
      sourceKind: 'travel', recordId: day.id, placeId: day.cityId,
      ...(day.countryId ? { countryId: day.countryId } : {}),
      date: classifyRecordDate({ startDate: source?.start_date ?? day.date, endDate: source?.end_date, year: source?.year }),
      browsable: true,
    }
  }),
})

/** Source-aware membership lookup used by browse consumers without string IDs. */
export const includedBrowseRecordKeys = (projection: BrowseTimeProjection): ReadonlySet<string> =>
  new Set(projection.includedRecords.map(match => recordRefKey(match.record)))
