/** RD-04 raw-record sidecar. Keep full source identities and original adjacency
 * before visibility, coordinates or dates remove any records. This never rebuilds
 * the application exports or changes stored records.
 *
 * ③ (scope-incremental): the context is three parts, each from its own inputs, so that the page's data store can keep the
 * parts a save did not change (../appStoreCore.ts): the travel records with the original routes (places, the travel
 * file, the hidden countries and cities), the want-to-go records (places, the items, the display rules) and the added
 * countries' visits (the added countries, the hidden countries). `deriveTimeQueryContext` is the three joined in that
 * order, as before.
 */
import { classifyRecordDate } from '../../worldgraph/timeFilter.ts'
import type { OriginalRouteCandidate, TimeQueryContext, TimeQueryRecord } from '../../worldgraph/timeQuery.ts'
import { classifyByPlace, displaySets, hiddenFromHomeFor } from '../canonical/classify.ts'
import { compareJourneyRecords, routeTypeBetween } from '../canonical/journeyRoutes.ts'
import { countryPlaceOf, indexPlaces, type PlaceIndex } from '../canonical/reconstruct.ts'
import type { CanonicalData, CanonicalTravelRecord } from '../canonical/types.ts'

type EditorState = CanonicalData['editorState']

/** The travel file's records (visited and planned) and the original routes between adjacent records of a journey. */
export const travelTimeRecords = (
  places: PlaceIndex,
  travel: CanonicalData['travel'],
  hiddenCountryIds: EditorState['hiddenCountryIds'],
  hiddenCityIds: EditorState['hiddenCityIds'],
): { readonly records: TimeQueryRecord[]; readonly originalRoutes: OriginalRouteCandidate[] } => {
  const sets = displaySets(travel.display)
  const hiddenCountries = new Set(hiddenCountryIds)
  const hiddenCities = new Set(hiddenCityIds)
  const countryOf = (placeId: string) => countryPlaceOf(places, places.get(placeId))?.id
  const records: TimeQueryRecord[] = []
  const journeys = new Map<string, CanonicalTravelRecord[]>()

  for (const record of travel.records) {
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

  const originalRoutes: OriginalRouteCandidate[] = []
  for (const [journeyId, entries] of journeys) {
    // The shared deterministic start_date/id order (code points, not the runtime locale), not a claim that
    // incomplete or invalid dates establish a real-world itinerary chronology.
    const ordered = [...entries].sort(compareJourneyRecords)
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
        // Same country place id on both ends is domestic (review C3; English names used to decide).
        kind: routeTypeBetween(fromCountry?.id, toCountry?.id),
      })
    }
  }
  return { records, originalRoutes }
}

/** The want-to-go records. */
export const wishTimeRecords = (
  places: PlaceIndex,
  items: CanonicalData['wantToGo']['items'],
  display: CanonicalData['travel']['display'],
): TimeQueryRecord[] => {
  const sets = displaySets(display)
  const countryOf = (placeId: string) => countryPlaceOf(places, places.get(placeId))?.id
  const records: TimeQueryRecord[] = []
  for (const item of items) {
    const countryId = countryOf(item.placeId)
    records.push({
      sourceKind: 'want-to-go', recordId: item.id, placeId: item.placeId,
      ...(countryId !== undefined ? { countryId } : {}),
      date: classifyRecordDate({ startDate: item.addedAt }),
      browsable: !item.hidden,
      navigationHidden: sets.navigationHiddenCities.has(item.placeId),
    })
  }
  return records
}

/** The visits of the added countries that have a date. */
export const countryVisitTimeRecords = (
  addedCountries: EditorState['addedCountries'],
  hiddenCountryIds: EditorState['hiddenCountryIds'],
): TimeQueryRecord[] => {
  const hiddenCountries = new Set(hiddenCountryIds)
  const records: TimeQueryRecord[] = []
  for (const country of addedCountries) {
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
  return records
}

/** The context of its three parts: the records in the order travel, want-to-go, added countries. */
export const timeQueryContextOf = (
  travel: ReturnType<typeof travelTimeRecords>,
  wishes: readonly TimeQueryRecord[],
  countryVisits: readonly TimeQueryRecord[],
): TimeQueryContext => ({ records: [...travel.records, ...wishes, ...countryVisits], originalRoutes: travel.originalRoutes })

export const deriveTimeQueryContext = (canonical: CanonicalData): TimeQueryContext => {
  const places = indexPlaces(canonical.places)
  const { editorState } = canonical
  return timeQueryContextOf(
    travelTimeRecords(places, canonical.travel, editorState.hiddenCountryIds, editorState.hiddenCityIds),
    wishTimeRecords(places, canonical.wantToGo.items, canonical.travel.display),
    countryVisitTimeRecords(editorState.addedCountries, editorState.hiddenCountryIds),
  )
}
