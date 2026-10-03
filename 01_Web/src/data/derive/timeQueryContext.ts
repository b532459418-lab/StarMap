/** RD-04 raw-record sidecar. Keep full source identities and original adjacency
 * before visibility, coordinates or dates remove any records. This never rebuilds
 * the application exports or changes stored records.
 */
import { classifyRecordDate } from '../../worldgraph/timeFilter.ts'
import type { OriginalRouteCandidate, TimeQueryContext, TimeQueryRecord } from '../../worldgraph/timeQuery.ts'
import { classifyByPlace, displaySets, hiddenFromHomeFor } from '../canonical/classify.ts'
import { countryPlaceOf, indexPlaces } from '../canonical/reconstruct.ts'
import type { CanonicalData, CanonicalTravelRecord } from '../canonical/types.ts'

/** This uses the legacy deterministic start_date/id ordering, not a claim that
 * incomplete or invalid dates establish a real-world itinerary chronology.
 */
const originalOrder = (a: CanonicalTravelRecord, b: CanonicalTravelRecord) =>
  `${a.start_date}-${a.id}`.localeCompare(`${b.start_date}-${b.id}`)

export const deriveTimeQueryContext = (canonical: CanonicalData): TimeQueryContext => {
  const places = indexPlaces(canonical.places)
  const sets = displaySets(canonical.travel.display)
  const hiddenCountries = new Set(canonical.editorState.hiddenCountryIds)
  const hiddenCities = new Set(canonical.editorState.hiddenCityIds)
  const countryOf = (placeId: string) => countryPlaceOf(places, places.get(placeId))?.id
  const records: TimeQueryRecord[] = []
  const journeys = new Map<string, CanonicalTravelRecord[]>()

  for (const record of canonical.travel.records) {
    const countryId = countryOf(record.placeId)
    const planned = record.status === 'planned'
    const category = classifyByPlace(record, countryId, sets)
    records.push({
      sourceKind: planned ? 'planned' : 'travel',
      recordId: record.id,
      placeId: record.placeId,
      ...(countryId !== undefined ? { countryId } : {}),
      ...(typeof record.journeyId === 'string' && record.journeyId.length > 0 ? { journeyId: record.journeyId } : {}),
      date: classifyRecordDate({ startDate: record.start_date, endDate: record.end_date, year: record.year }),
      // Planned memberships currently ignore travel display/editor hiding.
      browsable: planned || (!hiddenFromHomeFor(record, category)
        && !hiddenCountries.has(countryId ?? '') && !hiddenCities.has(record.placeId)),
      navigationHidden: sets.navigationHiddenCities.has(record.placeId),
    })
    // No synthetic unknown-journey fallback. An explicitly supplied value with
    // that spelling remains a valid journey identity.
    if (!planned && typeof record.journeyId === 'string' && record.journeyId.trim().length > 0) {
      const entries = journeys.get(record.journeyId) ?? []
      entries.push(record)
      journeys.set(record.journeyId, entries)
    }
  }

  for (const item of canonical.wantToGo.items) {
    const countryId = countryOf(item.placeId)
    records.push({
      sourceKind: 'want-to-go', recordId: item.id, placeId: item.placeId,
      ...(countryId !== undefined ? { countryId } : {}),
      date: classifyRecordDate({ startDate: item.addedAt }),
      browsable: !item.hidden,
      navigationHidden: sets.navigationHiddenCities.has(item.placeId),
    })
  }

  for (const country of canonical.editorState.addedCountries) {
    // Empty containers carry no evidence of a visit. Nonempty malformed dates
    // remain evidence requiring review; they must not disappear or be repaired.
    if (country.visitedDate === undefined || country.visitedDate === null || country.visitedDate === '') continue
    records.push({
      sourceKind: 'country-visit', recordId: country.placeId,
      placeId: country.placeId, countryId: country.placeId,
      date: classifyRecordDate({ startDate: country.visitedDate }),
      browsable: !hiddenCountries.has(country.placeId),
    })
  }

  const originalRoutes: OriginalRouteCandidate[] = []
  for (const [journeyId, entries] of journeys) {
    const ordered = [...entries].sort(originalOrder)
    for (let index = 1; index < ordered.length; index += 1) {
      const from = ordered[index - 1]
      const to = ordered[index]
      // Skip only this zero-length pair. The next pair still starts at `to`.
      if (from.placeId === to.placeId) continue
      const fromCountry = countryPlaceOf(places, places.get(from.placeId))
      const toCountry = countryPlaceOf(places, places.get(to.placeId))
      originalRoutes.push({
        id: JSON.stringify(['original-route', journeyId, from.id, to.id]),
        journeyId, fromRecordId: from.id, toRecordId: to.id,
        fromPlaceId: from.placeId, toPlaceId: to.placeId,
        // Preserve the existing route-kind convention (country English names).
        kind: (fromCountry?.names.en ?? '') === (toCountry?.names.en ?? '') ? 'main' : 'flight',
      })
    }
  }
  return { records, originalRoutes }
}
