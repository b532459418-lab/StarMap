/** One V2 record -> its formal store rows (3C-4a): the mapping of the V2 migration (./migrateV2.ts), one record at a
 * time, so that the migration and the incremental write path (./diffV2.ts) write the same rows for the same record.
 *
 * - Places: the `starmap:place` entity (id unchanged), its location anchor and its `starmap:part-of` relation.
 * - Footprint and planned records: an entry of `starmap:travel` (source `v2:travel`) or `starmap:want-to-go`
 *   (source `v2:planned`); `hiddenFromHome` and the journey membership are returned beside the entry (view state and
 *   a sequence, never fields).
 * - Want-to-go items: an entry of `starmap:want-to-go` (source `v2:want-to-go`); `hidden` is returned beside it.
 * - Added countries: one evidence row per country, plus a `starmap:travel` entry (source `v2:country-visit`) when it
 *   has a visit date.
 * - Media: the asset (id = the V2 media id) and the `starmap:media` entity.
 * - Journeys: the `starmap:journey` entity and its sequence in the original adjacency.
 * - View state: one view item or setting row; list elements resolved to view items, or unresolved.
 * - File headers: the file-level metadata of the five files, kept in `v2:import`'s extensions.
 *
 * The caller chooses every id that is not derived from a V2 id (entries, media and journey entities from the identity
 * ledger or a fresh UUIDv7; view rows; the ids of rows that replace a tombstoned id) and the entry timestamps.
 * `leftover` decides how the verbatim V2 values of a row become `extensions` (the migration also counts them).
 *
 * Pure: no IO, clock or randomness. The returned rows are fresh objects.
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types).
 */
import type { ViewItem, ViewItemTable, ViewSetting } from '../../worldgraph/store/formal.ts'
import type {
  AssetReference, EntrySequence, Evidence, JsonObject, JsonValue, LayerEntry, ReadonlyTitle, SourceRef, StoreAnchor, StoreEntity, StoreRelation,
} from '../../worldgraph/store/types.ts'
import { validateRow } from '../../worldgraph/store/rows.ts'
import { positionBetween } from '../../worldgraph/store/position.ts'
import { isCalendarDate } from '../../worldgraph/timeFilter.ts'
import { compareJourneyRecords } from '../canonical/journeyRoutes.ts'
import type { CanonicalPlace } from '../canonical/types.ts'
import type { V2FileKey, V2Files, V2TravelRecord } from '../canonical/v2Schema.ts'
import { OFFICIAL, UNRESOLVED_KEY_PREFIX, V2_SOURCES } from './officialDefinitions.ts'

/** `extensions: { v2 }` for the verbatim V2 values left on a row (the migration also counts their keys per kind). */
export type Leftover = (kind: string, rest: Record<string, JsonValue>) => { extensions?: JsonObject }
/** Leftover without counting: `extensions.v2` when anything is left. */
export const plainLeftover: Leftover = (_kind, rest) => (Object.keys(rest).length ? { extensions: { v2: rest } } : {})
/** `createdAt` / `updatedAt` of an entry. */
export interface EntryTimes { readonly createdAt: string; readonly updatedAt: string }
/** A view row target. */
export interface ViewTarget { readonly table: ViewItemTable; readonly id: string }

export const without = (value: object, keys: readonly string[]): Record<string, JsonValue> =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))) as Record<string, JsonValue>
export const sourceRef = (sourceId: string, recordId: string, evidenceIds: readonly string[] = []): SourceRef => ({ sourceId, recordId, evidenceIds })
/** True when Core accepts `title` as a row title (language tags, originalLanguage). */
export function fitsStoreTitle(title: unknown): title is ReadonlyTitle {
  try { validateRow('sources', { id: 'title-probe', revision: 0, title, origin: 'user' }, { get: () => undefined }); return true } catch { return false }
}
/** Non-blank string journeyId of a non-planned record: the record belongs to that journey. */
export const journeyOf = (record: Record<string, unknown>): string | undefined =>
  record.status !== 'planned' && typeof record.journeyId === 'string' && record.journeyId.trim() ? record.journeyId : undefined

// ---------------------------------------------------------------------------
// File headers
// ---------------------------------------------------------------------------

/** Per V2 file, the keys that are records or view state; every other top-level key is file metadata (a header). */
export const V2_HEADER_EXCLUDED: Readonly<Record<V2FileKey, readonly string[]>> = Object.freeze({
  places: ['places'],
  travel: ['records', 'display'],
  wantToGo: ['items'],
  editorState: [
    'addedCountries', 'countryOrder', 'hiddenCountryIds', 'cityOrderByCountry', 'hiddenCityIds',
    'mediaOrderByCity', 'hiddenMediaIds', 'coverMediaByCity', 'droneOrderByCity', 'hiddenDroneMediaIds',
  ],
  media: ['items'],
})
/** The header of one V2 file. */
export const v2HeaderOf = (key: V2FileKey, file: object): Record<string, JsonValue> => without(file, V2_HEADER_EXCLUDED[key])
/** The headers of the five files, as `v2:import` keeps them under `extensions.v2`. */
export const v2Headers = (files: V2Files): Record<V2FileKey, Record<string, JsonValue>> => ({
  places: v2HeaderOf('places', files.places),
  travel: v2HeaderOf('travel', files.travel),
  wantToGo: v2HeaderOf('wantToGo', files.wantToGo),
  editorState: v2HeaderOf('editorState', files.editorState),
  media: v2HeaderOf('media', files.media),
})

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

export const placeAnchorId = (placeId: string): string => `v2:place-location:${placeId}`
export const placeRelationId = (placeId: string): string => `v2:part-of:${placeId}`

/** The `starmap:place` entity of a place (id unchanged). */
export function placeEntity(place: CanonicalPlace, leftover: Leftover = plainLeftover): StoreEntity {
  const { id, subtype, names, originalLanguage, externalIds } = place
  // partOf and location become a relation and an anchor; legacyKeys stays verbatim.
  const extra = without(place, ['id', 'subtype', 'names', 'originalLanguage', 'externalIds', 'partOf', 'location'])
  const title = { names, ...(originalLanguage !== undefined ? { originalLanguage } : {}) }
  const fields: Record<string, JsonValue> = { subtype }
  if (externalIds !== undefined) {
    const { iso3166Alpha2, ...others } = externalIds as Record<string, JsonValue>
    if (typeof iso3166Alpha2 === 'string') fields.iso3166Alpha2 = iso3166Alpha2
    else if (iso3166Alpha2 !== undefined) others.iso3166Alpha2 = iso3166Alpha2
    // Kept when there are other keys, or when externalIds exists without a code.
    if (Object.keys(others).length || fields.iso3166Alpha2 === undefined) extra.externalIds = others
  }
  const fits = fitsStoreTitle(title)
  if (!fits) Object.assign(extra, title)
  return {
    id, revision: 0, typeId: OFFICIAL.place, title: fits ? title : { names: {} }, fields, source: sourceRef(V2_SOURCES.place, id), visibility: 'private',
    ...leftover('place', extra),
  }
}

/** The location anchor of a place, or undefined without a location. */
export function placeAnchor(place: CanonicalPlace, id: string = placeAnchorId(place.id)): StoreAnchor | undefined {
  const anchor = place.location
  if (!anchor) return undefined
  return {
    id, revision: 0, entityId: place.id, source: sourceRef(V2_SOURCES.place, place.id), kind: 'location',
    lat: anchor.lat, lng: anchor.lng, ...(anchor.approximate !== undefined ? { approximate: anchor.approximate } : {}),
    precision: place.subtype === 'city' ? 'city' : 'region',
  } satisfies StoreAnchor
}

/** The part-of relation of a place (city -> country), or undefined without `partOf`. */
export function placeRelation(place: CanonicalPlace, id: string = placeRelationId(place.id)): StoreRelation | undefined {
  if (place.partOf === undefined) return undefined
  return {
    id, revision: 0, typeId: OFFICIAL.partOf, fromEntityId: place.id, toEntityId: place.partOf, fields: {},
    source: sourceRef(V2_SOURCES.place, place.id),
  } satisfies StoreRelation
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

type V2MediaItem = V2Files['media']['items'][number]

/** The asset of a media item: the V2 media id and every key but placeId and title as attributes. */
export function mediaAsset(item: V2MediaItem): AssetReference {
  const attributes = without(item, ['id', 'placeId', 'title'])
  return { id: item.id, revision: 0, source: sourceRef(V2_SOURCES.media, item.id), attributes } satisfies AssetReference
}

/** The `starmap:media` entity of a media item, linking its place and its asset. */
export function mediaEntity(item: V2MediaItem, entityId: string, leftover: Leftover = plainLeftover): StoreEntity {
  const { id, placeId, title } = item
  const fits = title !== undefined && fitsStoreTitle(title)
  return {
    id: entityId, revision: 0, typeId: OFFICIAL.media, title: fits ? title : { names: {} },
    fields: { place: placeId, asset: id }, source: sourceRef(V2_SOURCES.media, id), visibility: 'private',
    ...leftover('media', title !== undefined && !fits ? { title: title as unknown as JsonValue } : {}),
  } satisfies StoreEntity
}

// ---------------------------------------------------------------------------
// Added countries
// ---------------------------------------------------------------------------

type V2AddedCountry = V2Files['editorState']['addedCountries'][number]

/** A non-empty string visit date of an added country. */
export const countryVisitDate = (country: { visitedDate?: unknown }): string | undefined =>
  (typeof country.visitedDate === 'string' && country.visitedDate !== '' ? country.visitedDate : undefined)
export const countryEvidenceId = (placeId: string): string => `v2:country-visit:${placeId}`

/** The evidence row of an added country: the container, even an empty one. */
export function countryEvidence(country: V2AddedCountry, id: string = countryEvidenceId(country.placeId)): Evidence {
  const attributes = without(country, countryVisitDate(country) !== undefined ? ['placeId', 'visitedDate'] : ['placeId'])
  return { id, revision: 0, sourceId: V2_SOURCES.countryVisit, recordId: country.placeId, attributes } satisfies Evidence
}

/** The visit entry of an added country with a visit date (pointing at its evidence), or undefined. */
export function countryVisitEntry(country: V2AddedCountry, entryId: string, evidenceId: string, times: EntryTimes): LayerEntry | undefined {
  const date = countryVisitDate(country)
  if (date === undefined) return undefined
  return {
    id: entryId, revision: 0, layerId: OFFICIAL.travel, entityId: country.placeId,
    fields: { date: { raw: { startDate: date } } }, source: sourceRef(V2_SOURCES.countryVisit, country.placeId, [evidenceId]), ...times,
  } satisfies LayerEntry
}

// ---------------------------------------------------------------------------
// Footprint and planned records, want-to-go items
// ---------------------------------------------------------------------------

/** Where a footprint record lives: planned records in the want-to-go layer (source v2:planned), others in travel. */
export function recordPlacement(record: { readonly status?: unknown }): { readonly planned: boolean; readonly layerId: string; readonly sourceId: string } {
  const planned = record.status === 'planned'
  return { planned, layerId: planned ? OFFICIAL.wantToGo : OFFICIAL.travel, sourceId: planned ? V2_SOURCES.planned : V2_SOURCES.travel }
}

/** A footprint or planned record's entry. `hiddenFromHome` (a boolean value only) is view state, returned beside it. */
export function travelRecordEntry(record: V2TravelRecord, entryId: string, times: EntryTimes, leftover: Leftover = plainLeftover): {
  readonly entry: LayerEntry; readonly planned: boolean; readonly hiddenFromHome?: boolean
} {
  const { planned, layerId, sourceId } = recordPlacement(record)
  const { id, placeId, ...rest } = record as unknown as Record<string, JsonValue> & { id: string; placeId: string }
  const raw: Record<string, JsonValue> = {}
  for (const [key, target] of [['start_date', 'startDate'], ['end_date', 'endDate'], ['year', 'year']] as const) {
    if (Object.hasOwn(rest, key)) { raw[target] = rest[key]; delete rest[key] }
  }
  const fields: Record<string, JsonValue> = planned && !Object.keys(raw).length ? {} : { date: { raw } }
  if (typeof rest.notes === 'string') { fields.note = rest.notes; delete rest.notes }
  if (typeof rest.trip_title === 'string') { fields.tripTitle = rest.trip_title; delete rest.trip_title }
  let hiddenFromHome: boolean | undefined
  if (typeof rest.hiddenFromHome === 'boolean') { hiddenFromHome = rest.hiddenFromHome; delete rest.hiddenFromHome }
  if (journeyOf(record as unknown as Record<string, unknown>) !== undefined) delete rest.journeyId
  const entry: LayerEntry = {
    id: entryId, revision: 0, layerId, entityId: placeId, fields,
    source: sourceRef(sourceId, id), ...times, ...leftover(planned ? 'plannedRecord' : 'footprintRecord', rest),
  } satisfies LayerEntry
  return { entry, planned, ...(hiddenFromHome !== undefined ? { hiddenFromHome } : {}) }
}

type V2WantToGoItem = V2Files['wantToGo']['items'][number]

/** A want-to-go item's entry. `hidden` is view state (the wantToGoHidden scope), returned beside it. */
export function wantToGoEntry(item: V2WantToGoItem, entryId: string, times: EntryTimes, leftover: Leftover = plainLeftover): {
  readonly entry: LayerEntry; readonly hidden: boolean
} {
  const { id, placeId, note, addedAt } = item
  const fields: Record<string, JsonValue> = {}
  // `hidden` is view state (wantToGoHidden), not a field.
  const extra = without(item, ['id', 'placeId', 'note', 'addedAt', 'hidden'])
  if (typeof note === 'string') fields.note = note; else if (note !== undefined) extra.note = note
  if (isCalendarDate(addedAt)) fields.addedAt = addedAt; else extra.addedAt = addedAt
  const entry: LayerEntry = {
    id: entryId, revision: 0, layerId: OFFICIAL.wantToGo, entityId: placeId, fields, source: sourceRef(V2_SOURCES.wantToGo, id), ...times,
    ...leftover('wantToGoItem', extra),
  } satisfies LayerEntry
  return { entry, hidden: item.hidden === true }
}

// ---------------------------------------------------------------------------
// Journeys
// ---------------------------------------------------------------------------

export const journeySequenceId = (entityId: string): string => `v2:journey-sequence:${entityId}`

/** The members of one journey in the order routes are derived in (the original adjacency, sorted by date). */
export const orderedJourneyMembers = <T extends { readonly id: string }>(records: readonly T[]): T[] =>
  [...records].sort((a, b) => compareJourneyRecords(a as unknown as { id: string; start_date?: string }, b as unknown as { id: string; start_date?: string }))

/** The `starmap:journey` entity of a V2 journey id. */
export function journeyEntity(journeyId: string, entityId: string): StoreEntity {
  return {
    id: entityId, revision: 0, typeId: OFFICIAL.journey, title: { names: {} }, fields: {}, source: sourceRef(V2_SOURCES.journey, journeyId), visibility: 'private',
  } satisfies StoreEntity
}

/** The sequence of a journey: its member entries in order. */
export function journeySequence(journeyId: string, entityId: string, entryIds: readonly string[], id: string = journeySequenceId(entityId)): EntrySequence {
  return { id, revision: 0, entityId, entryIds: [...entryIds], source: sourceRef(V2_SOURCES.journey, journeyId) } satisfies EntrySequence
}

// ---------------------------------------------------------------------------
// View state
// ---------------------------------------------------------------------------

/** One view item row. */
export const viewItemRow = (scope: string, id: string, target: ViewTarget, position: string, hidden: boolean, layerId?: string): ViewItem => ({
  id, revision: 0, scope, itemTable: target.table, itemId: target.id, ...(layerId !== undefined ? { layerId } : {}), position, hidden,
}) satisfies ViewItem

/** One view setting row: a `value` or a `ref`. */
export const viewSettingRow = (scope: string, id: string, key: string, rest: { value?: JsonValue; ref?: ViewTarget }): ViewSetting => ({
  id, revision: 0, scope, key, ...rest,
}) satisfies ViewSetting

/** The setting that keeps a list element which is no view item (no such row, or a repeated id), at its position. */
export const unresolvedSetting = (scope: string, id: string, position: string, value: unknown): ViewSetting =>
  viewSettingRow(scope, id, UNRESOLVED_KEY_PREFIX + position, { value: { position, id: value as JsonValue } })

/** List elements in order: a view target, or none (unresolved) when the value is no row or repeats an earlier target. */
export function resolveListElements(values: readonly unknown[], resolve: (value: unknown) => ViewTarget | undefined): { readonly value: unknown; readonly target?: ViewTarget }[] {
  const used = new Set<string>()
  return values.map((value) => {
    const target = resolve(value), key = target && JSON.stringify([target.table, target.id])
    if (target && !used.has(key!)) { used.add(key!); return { value, target } }
    return { value }
  })
}

/** `count` increasing sort keys, built by bisection with Core's positionBetween: the
 * length grows with log(count) (9 characters for 100,000 keys), while appending one
 * key after another would exhaust the 64-character limit near 2,000 keys. */
export function listPositions(count: number): readonly string[] {
  const out: string[] = new Array<string>(count)
  const fill = (lo: number, hi: number, before?: string, after?: string): void => {
    if (lo > hi) return
    const mid = (lo + hi) >>> 1, at = positionBetween(before, after)
    out[mid] = at
    fill(lo, mid - 1, before, at)
    fill(mid + 1, hi, at, after)
  }
  fill(0, count - 1)
  return out
}
