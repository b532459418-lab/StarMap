/**
 * `POST /records`, `POST /countries` and `POST /countries/delete` as store-native writes (3C-5 C2, design 3C-5 §3). The
 * decisions are ../rules/ (the same as the V2 write functions of ../../v2write/footprint.ts), in the same order; the rows
 * are ./records.ts's and ./places.ts's. The responses are the V2 functions'.
 *
 * - `POST /records`: the place first (by id: a chosen city, its missing location filled in; by name: the country by ISO,
 *   a new city only without candidates or with `createNew`), then `E_CITY_EXISTS` and the coordinates, then the journey
 *   choice; a new visited record, its journey, and the country order when the country first enters the footprint.
 * - `POST /countries`: the country by ISO (found or created from the catalog); `E_COUNTRY_EXISTS`; the added country
 *   (evidence with the catalog's region, the visit entry) and the country order.
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types).
 */
import type { CanonicalPlace, PlaceId } from '../../canonical/types.ts'
import type { OfficialReader } from '../../store/officialReader.ts'
import {
  defaultTripTitle, parseAddCountry, parseAddTravelRecord, requireChosenCity, requireCityWithoutRecords, requireCoordinates,
  requireCountryNotInFootprint,
} from '../rules/footprint.ts'
import { decideJourney } from '../rules/journeys.ts'
import { requireNoCityCandidates } from '../rules/places.ts'
import { commandBatch } from './batch.ts'
import { countryFor, createAnchor, createPlaces, newCity } from './places.ts'
import {
  addCountryVisit, appendRecord, countryInFootprint, countryOfPlace, journeyCandidates, reorderCountries, travelEntry, writeJourney,
} from './records.ts'
import type { NativeWrite } from './routes.ts'

/** Places a write creates or changes, seen before they are committed. */
function placesOf(reader: OfficialReader, changed: readonly CanonicalPlace[]) {
  const byId = new Map(changed.map((place) => [place.id, place] as const))
  return {
    placeOf: (placeId: PlaceId) => byId.get(placeId) ?? reader.place(placeId),
    isPlace: (placeId: PlaceId) => byId.has(placeId) || reader.isPlace(placeId),
  }
}

// ---------------------------------------------------------------------------
// POST /records
// ---------------------------------------------------------------------------

export const addTravelRecordWrite = Object.freeze<NativeWrite>({
  status: 201,
  plan(reader, input, ctx) {
    const { target, tripTitle: tripTitleInput, journeyChoice } = parseAddTravelRecord(input)
    const batch = commandBatch()
    const created: CanonicalPlace[] = []
    let country: CanonicalPlace, city: CanonicalPlace
    let filledLocation = false
    let coordinates: { lat: number; lng: number } | undefined
    if (target.kind === 'named') {
      const found = countryFor(reader, target.countryCode, ctx.countryCatalog, ctx.newId)
      country = found.place
      if (found.created) created.push(country)
      coordinates = target.coordinates
      requireNoCityCandidates(found.created ? [country] : [country, ...reader.citiesOf(country.id)], country.id,
        { names: target.names, location: coordinates, createNew: target.createNew })
      city = newCity(ctx.newId(), target.names, country.id, coordinates)
      created.push(city)
    } else {
      const place = reader.place(target.placeId)
      const parent = place?.subtype === 'city' && place.partOf !== undefined ? reader.place(place.partOf) : undefined
      requireChosenCity(place, parent, target.placeId)
      country = parent!
      city = place!
      // A city without a location gets the one given (fillMissingLocation).
      if (city.location === undefined && target.coordinates !== undefined) {
        city = { ...city, location: { lat: target.coordinates.lat, lng: target.coordinates.lng } }
        filledLocation = true
      }
      coordinates = city.location
    }
    const wasInFootprint = !created.includes(country) && countryInFootprint(reader, country.id)
    requireCityWithoutRecords(!created.includes(city) && reader.recordsOn(city.id).length > 0, city.id)
    requireCoordinates(coordinates)

    const tripTitle = tripTitleInput ?? defaultTripTitle(country, city)
    const entryId = ctx.newId()
    const decided = decideJourney(journeyChoice, () => journeyCandidates(reader, tripTitle), tripTitle)

    const now = ctx.now.toISOString()
    createPlaces(reader, batch, created, ctx.newId)
    if (filledLocation) createAnchor(batch, city, ctx.newId)
    batch.create('entries', travelEntry(entryId, city.id, target.dates, tripTitle, now))
    appendRecord(reader, batch, entryId, ctx.newId)
    writeJourney(reader, batch, decided, { entryId, id: entryId, start_date: target.dates.start }, ctx.newId)
    if (!wasInFootprint) {
      const { placeOf, isPlace } = placesOf(reader, created)
      reorderCountries(reader, batch, ctx.newId, {
        visits: [{ countryId: countryOfPlace(placeOf(city.id)), start_date: target.dates.start, end_date: target.dates.end }], placeOf, isPlace,
      })
    }
    return { commands: batch.commands(), result: { id: entryId, countryId: country.id, cityId: city.id } }
  },
})

// ---------------------------------------------------------------------------
// POST /countries
// ---------------------------------------------------------------------------

export const addCountryWrite = Object.freeze<NativeWrite>({
  status: 201,
  plan(reader, input, ctx) {
    const { countryCode, visitedDate } = parseAddCountry(input)
    const found = countryFor(reader, countryCode, ctx.countryCatalog, ctx.newId)
    const country = found.place
    requireCountryNotInFootprint(!found.created && countryInFootprint(reader, country.id), country.id)
    const region = ctx.countryCatalog.get(countryCode)?.region
    const batch = commandBatch()
    const now = ctx.now.toISOString()
    createPlaces(reader, batch, found.created ? [country] : [], ctx.newId)
    addCountryVisit(reader, batch, { placeId: country.id, ...(region ? { region } : {}), visitedDate }, now, ctx.newId)
    const { placeOf, isPlace } = placesOf(reader, found.created ? [country] : [])
    reorderCountries(reader, batch, ctx.newId, { added: [{ placeId: country.id, visitedDate }], placeOf, isPlace })
    return { commands: batch.commands(), result: { countryId: country.id } }
  },
})
