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
import type { ViewItem } from '../../../worldgraph/store/formal.ts'
import type { StoreEntity } from '../../../worldgraph/store/types.ts'
import type { CanonicalPlace, PlaceId } from '../../canonical/types.ts'
import { OFFICIAL, VIEW_SCOPES } from '../../store/officialDefinitions.ts'
import type { OfficialReader } from '../../store/officialReader.ts'
import type { ViewTarget } from '../../store/v2RecordRows.ts'
import { viewListWriter, writeEditorLists } from '../../store/viewListRows.ts'
import {
  defaultTripTitle, parseAddCountry, parseAddTravelRecord, parseDeleteCountries, requireChosenCity, requireCityWithoutRecords, requireCoordinates,
  requireCountriesDeletable, requireCountryNotInFootprint, zhNameOf,
} from '../rules/footprint.ts'
import { decideJourney } from '../rules/journeys.ts'
import { requireNoCityCandidates } from '../rules/places.ts'
import { commandBatch, viewListAccess } from './batch.ts'
import { countryFor, createAnchor, createPlaces, newCity, prunePlaces, referencesOf } from './places.ts'
import {
  addCountryVisit, appendRecord, countryInFootprint, countryOfPlace, journeyCandidates, removeCountryVisit, removeRecords, reorderCountries, travelEntry,
  writeJourney,
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

// ---------------------------------------------------------------------------
// POST /countries/delete
// ---------------------------------------------------------------------------

/**
 * The media of some cities, in the official order (mediaOrder positions, then the media entity's id), as the official view
 * lists them: a media entity of the place type's field `place`, with an asset that exists and no earlier entity on it.
 */
function mediaOn(reader: OfficialReader, cityIds: ReadonlySet<PlaceId>): { readonly placeId: PlaceId; readonly asset: string; readonly entity: string }[] {
  const references = referencesOf(reader)
  const media = new Map<string, StoreEntity[]>()
  for (const cityId of cityIds) {
    for (const ref of references('entities', cityId)) {
      if (ref.fromTable !== 'entities' || ref.field !== 'fields.place') continue
      const entity = reader.index.get('entities', ref.fromId) as StoreEntity | undefined
      if (entity?.typeId !== OFFICIAL.media || typeof entity.fields.asset !== 'string' || !reader.index.get('assets', entity.fields.asset)) continue
      const list = media.get(entity.fields.asset) ?? []
      list.push(entity)
      media.set(entity.fields.asset, list)
    }
  }
  const items: { placeId: PlaceId; asset: string; entity: string }[] = []
  for (const [asset] of media) {
    // The official view keeps the first media entity (by id) of an asset whose place is a place.
    const first = references('assets', asset).filter((ref) => ref.fromTable === 'entities' && ref.field === 'fields.asset')
      .map((ref) => reader.index.get('entities', ref.fromId) as StoreEntity | undefined)
      .filter((entity): entity is StoreEntity => entity?.typeId === OFFICIAL.media && typeof entity.fields.place === 'string' && reader.isPlace(entity.fields.place))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]
    if (first && cityIds.has(first.fields.place as string)) items.push({ placeId: first.fields.place as string, asset, entity: first.id })
  }
  const at = new Map<string, ViewItem>()
  for (const item of reader.index.viewItemsOf(VIEW_SCOPES.mediaOrder)) if (item.itemTable === 'assets' && !at.has(item.itemId)) at.set(item.itemId, item)
  return items.sort((a, b) => {
    const x = at.get(a.asset), y = at.get(b.asset)
    if (x && y) return x.position < y.position ? -1 : x.position > y.position ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0
    if (x || y) return x ? -1 : 1
    return a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : 0
  })
}

export const deleteCountriesWrite = Object.freeze<NativeWrite>({
  status: 200,
  plan(reader, input, ctx) {
    const ids = parseDeleteCountries(input)
    const idSet = new Set(ids)
    const lists = reader.editorLists()
    const hidden = new Set(lists.hiddenCountryIds)
    // Every city of these countries, and the records (planned too) on them.
    const citiesOf = new Map(ids.map((id) => [id, reader.citiesOf(id).map((city) => city.id)] as const))
    const cityIds = new Set([...citiesOf.values()].flat())
    const recordsOf = (countryId: PlaceId) => (citiesOf.get(countryId) ?? []).flatMap((cityId) => reader.recordsOn(cityId))
    const added = new Set(reader.addedCountries().map((country) => country.placeId))
    requireCountriesDeletable(ids, {
      isHidden: (id) => hidden.has(id),
      hasData: (id) => recordsOf(id).length > 0 || added.has(id),
      mediaCities: () => {
        const counts = new Map<PlaceId, number>()
        for (const item of mediaOn(reader, cityIds)) counts.set(item.placeId, (counts.get(item.placeId) ?? 0) + 1)
        return [...counts].map(([placeId, count]) => ({ placeId, count }))
      },
      nameOf: (placeId) => zhNameOf(reader.place(placeId)),
    })

    const batch = commandBatch()
    // The editor lists without these countries and their cities.
    const omit = <T,>(record: Readonly<Record<string, T>>, keys: ReadonlySet<string>) => Object.fromEntries(Object.entries(record).filter(([key]) => !keys.has(key)))
    const after = {
      ...lists,
      countryOrder: lists.countryOrder.filter((id) => !idSet.has(id)),
      hiddenCountryIds: lists.hiddenCountryIds.filter((id) => !idSet.has(id)),
      cityOrderByCountry: Object.fromEntries(Object.entries(lists.cityOrderByCountry)
        .filter(([countryId]) => !idSet.has(countryId))
        .map(([countryId, cities]) => [countryId, cities.filter((id) => !cityIds.has(id))])),
      hiddenCityIds: lists.hiddenCityIds.filter((id) => !cityIds.has(id)),
      mediaOrderByCity: omit(lists.mediaOrderByCity, cityIds),
      coverMediaByCity: omit(lists.coverMediaByCity, cityIds),
      droneOrderByCity: omit(lists.droneOrderByCity, cityIds),
    }
    const { rows, sink } = viewListAccess(reader, batch, ctx.newId)
    const place = (id: unknown): ViewTarget | undefined => (typeof id === 'string' && reader.isPlace(id) ? { table: 'entities', id } : undefined)
    const media = (id: unknown): ViewTarget | undefined => (typeof id === 'string' && reader.index.get('assets', id) !== undefined ? { table: 'assets', id } : undefined)
    writeEditorLists(viewListWriter(rows, sink), lists, after, { before: place, after: place }, media)
    for (const id of ids) removeCountryVisit(reader, batch, id)
    // The records: their journeys first (a sequence lists its members), then their view rows and entries.
    const records = ids.flatMap(recordsOf)
    removeRecords(reader, batch, records, ctx.newId)
    prunePlaces(reader, batch, [...cityIds, ...ids])
    return { commands: batch.commands(), result: { deletedCountryIds: ids, deletedRecordCount: records.length } }
  },
})
