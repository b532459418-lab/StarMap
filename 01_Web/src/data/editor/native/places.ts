/**
 * Places in the store-native writes (3C-5 C1, shared by C2): the rows of a new place, the registry order, the cleanup of
 * places nobody refers to any more, and the country and city choice of the endpoints that take a place by name.
 *
 * - New rows have the source `starmap:user` with the row's id as record id, and UUIDv7 ids.
 * - The cleanup (D3): a candidate goes when no row of any layer refers to it — an entry, an entity field, a relation
 *   (other than the place's own part-of), a view item (other than its own placeOrder row) or setting — and no cover is
 *   keyed by it; rows this batch removes do not count. A city that goes no longer refers to its country, so it runs again
 *   (../rules/places.ts's pruneUnreferencedPlaces). The place goes with its anchors, part-of relations and placeOrder row.
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types).
 */
import type { FormalRow, FormalTable, ViewItem } from '../../../worldgraph/store/formal.ts'
import type { ReadModelTable } from '../../../worldgraph/readModel/types.ts'
import type { StoreAnchor, StoreEntity, StoreRelation } from '../../../worldgraph/store/types.ts'
import { namesOf } from '../../canonical/reconstruct.ts'
import type { CanonicalPlace, PlaceId } from '../../canonical/types.ts'
import { OFFICIAL, VIEW_SCOPES } from '../../store/officialDefinitions.ts'
import type { OfficialReader } from '../../store/officialReader.ts'
import { placeAnchor, placeEntity, placeRelation, sourceRef } from '../../store/v2RecordRows.ts'
import type { CatalogCountry } from '../../v2write/transaction.ts'
import { chooseCountry, pruneUnreferencedPlaces } from '../rules/places.ts'
import type { CommandBatch } from './batch.ts'
import { appendToOriginalOrder } from './originalOrder.ts'

const S = VIEW_SCOPES
/** The source of a row a store-native write creates. */
export const userSource = (id: string) => sourceRef(OFFICIAL.user, id)

/** The rows of a new place (entity, location anchor, part-of relation), created in that order. */
export function createPlace(batch: CommandBatch, place: CanonicalPlace, newId: () => string): void {
  batch.create('entities', { ...placeEntity(place), source: userSource(place.id) } satisfies StoreEntity)
  const anchorId = place.location ? newId() : undefined
  if (anchorId) batch.create('anchors', { ...placeAnchor(place, anchorId)!, source: userSource(anchorId) } satisfies StoreAnchor)
  const relationId = place.partOf !== undefined ? newId() : undefined
  if (relationId) batch.create('relations', { ...placeRelation(place, relationId)!, source: userSource(relationId) } satisfies StoreRelation)
}

/** A location anchor for a place that had none (fillMissingLocation). */
export function createAnchor(batch: CommandBatch, place: CanonicalPlace, newId: () => string): void {
  const anchorId = newId()
  batch.create('anchors', { ...placeAnchor(place, anchorId)!, source: userSource(anchorId) } satisfies StoreAnchor)
}

/** Every place, for the registry order (its projection order without a row: by id). */
export const placeKeys = (reader: OfficialReader) => () =>
  reader.index.entitiesOfType(OFFICIAL.place).map((entity) => ({ id: entity.id, after: ['', entity.id] as const }))

/** New places: their rows, and their placeOrder rows at the end of the registry. */
export function createPlaces(reader: OfficialReader, batch: CommandBatch, places: readonly CanonicalPlace[], newId: () => string): void {
  for (const place of places) createPlace(batch, place, newId)
  if (places.length) appendToOriginalOrder(reader, batch, newId, { scope: S.placeOrder, table: 'entities', keys: placeKeys(reader), added: places.map((place) => place.id) })
}

/**
 * The country of an ISO code (../rules/places.ts's chooseCountry): the existing place, or a new one from the catalog
 * (names, ISO code, the catalog's center as location).
 */
export function countryFor(reader: OfficialReader, iso: string, catalog: ReadonlyMap<string, CatalogCountry>, newId: () => string):
  { readonly place: CanonicalPlace; readonly created: boolean } {
  const choice = chooseCountry(reader.countries(), iso, catalog)
  if ('found' in choice) return { place: choice.found, created: false }
  const { code, entry } = choice.create
  return {
    place: { id: newId(), subtype: 'country', names: namesOf(entry.nameZh, entry.nameEn), externalIds: { iso3166Alpha2: code }, location: { lat: entry.centerLat, lng: entry.centerLng } },
    created: true,
  }
}

/** A new city (names, its country, a location when given). */
export const newCity = (id: string, names: { zh: string; en: string }, countryId: PlaceId, location: { lat: number; lng: number } | undefined): CanonicalPlace => ({
  id, subtype: 'city', names: namesOf(names.zh, names.en), partOf: countryId, ...(location !== undefined ? { location: { lat: location.lat, lng: location.lng } } : {}),
})

const missingRow = (table: string, id: string): never => { throw new Error(`the live index has no ${table} row ${id} that a reference names`) }
/** A row the index has (a reference names it). */
export const rowOf = (reader: OfficialReader, table: FormalTable, id: string): FormalRow =>
  (reader.index.get(table as ReadModelTable, id) as FormalRow | undefined) ?? missingRow(table, id)

/** The reverse references of the live index (the cleanup needs them). */
export function referencesOf(reader: OfficialReader) {
  const references = reader.index.referencesTo
  if (!references) throw new Error('the official reader needs reverse references (the live index)')
  return references
}

/** Rows of a place that are its own parts, not references to it: anchors, its part-of relation, its placeOrder row. */
function ownPart(reader: OfficialReader, table: FormalTable, id: string, placeId: string): boolean {
  if (table === 'anchors') return true
  if (table === 'relations') {
    const relation = reader.index.get('relations', id) as StoreRelation | undefined
    return relation?.fromEntityId === placeId && relation.typeId === OFFICIAL.partOf
  }
  if (table === 'viewItems') return (reader.index.get('viewItems', id) as ViewItem | undefined)?.scope === S.placeOrder
  return false
}

/** Remove the candidates nobody refers to any more (see the file header). Returns the removed place ids. */
export function prunePlaces(reader: OfficialReader, batch: CommandBatch, candidates: Iterable<PlaceId>): PlaceId[] {
  const references = referencesOf(reader)
  const referenced = (placeId: string) =>
    references('entities', placeId).some((ref) => !batch.removes(ref.fromTable, ref.fromId) && !ownPart(reader, ref.fromTable, ref.fromId, placeId))
    || (() => { const cover = reader.viewSetting(S.coverMediaByCity, placeId); return cover !== undefined && !batch.removes('viewSettings', cover.id) })()
  return pruneUnreferencedPlaces(
    candidates,
    (pending) => [...pending].filter((id) => reader.place(id) !== undefined && !referenced(id)),
    (removable) => {
      for (const placeId of removable) {
        for (const ref of references('entities', placeId)) {
          if (ref.fromTable === 'viewItems' || ref.fromTable === 'anchors' || ref.fromTable === 'relations') batch.remove(ref.fromTable, rowOf(reader, ref.fromTable, ref.fromId))
        }
        batch.remove('entities', rowOf(reader, 'entities', placeId))
      }
    },
  )
}
