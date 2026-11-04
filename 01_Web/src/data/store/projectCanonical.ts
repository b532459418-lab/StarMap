/** Formal store -> CanonicalData (3C-1b, design 3B §4.7 and §10): the compatibility
 * projection. The App keeps its pipeline (Canonical -> derive), and "export as V2"
 * is `serializeV2(canonical, v2Meta)` with the existing serializer.
 *
 * It reads the official definitions (`starmap:*`), their entries, the official view
 * scopes (VIEW_SCOPES), assets and sequences. Rows that Canonical cannot express,
 * such as entries of a layer that is not official, are listed in `skipped` by table
 * and id: never an error, never silently gone. Every row is either used by the
 * projection or listed there.
 *
 * Ids: a row from a `v2:*` source projects to its `source.recordId` (the V2 record
 * id); a `starmap:user` entry, created after the migration, to its entry id; a
 * journey to the ledger identity its entity carries (`v2:journey` source record),
 * or else to the entity id.
 *
 * Order: an entry, place, media item or added country with a position in its
 * original-order scope keeps that order. One without a position (created after the
 * migration) comes after all positioned ones; entries among themselves by
 * `createdAt`, other rows by id (UUIDv7, so creation order), ties by id.
 *
 * Added countries (3C-5 E spec §2.6): a `starmap:travel` entry on a place whose
 * `subtype` is `country` is a country visit, whatever its source; the evidence it
 * cites holds the other values (the region). Before 3C-5 E the evidence of the V2
 * source `v2:country-visit` was the added country, and a visit entry existed only
 * with a date; store format 3 gives every added country its entry (store:upgrade).
 *
 * Pure: the input is never modified, and nothing but the rows themselves is read;
 * the result does not depend on the order of rows within a table.
 *
 * The official view (3C-5B, design 3C-5 §2 option 1): the App reads the read model through this same function, with
 * two options that only drop work, never change the result: `track: false` lists no skipped rows (the App does not
 * need them; export-v2 does), and `freeze: false` returns the result without a deep frozen copy, so it shares row values
 * with its input and its callers must not modify it. `officialViewOf(model, source)` is that call on a read model.
 *
 * ③ (scope-incremental): the projection is a set of sections (places, records, display, want-to-go items, added
 * countries, media, each editor list) computed from shared inputs (the view rows grouped by scope, the place index, the
 * entry roles). `officialView` keeps those inputs with the view; `officialViewAfter` gives the view of the read model a
 * commit moved on, computing only the sections its changed rows can affect (`OFFICIAL_VIEW_INPUTS`, the classification
 * table: whatever it does not list projects the whole store) and keeping every other section's object. Every path runs
 * the same section functions, so its result equals the whole projection.
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative
 * imports with `.ts`, `import type` for types).
 */
import { FORMAL_TABLES, type FormalState, type FormalTable, type ViewItem, type ViewItemTable, type ViewSetting } from '../../worldgraph/store/formal.ts'
import type { AssetReference, Evidence, JsonValue, LayerEntry, StoreEntity } from '../../worldgraph/store/types.ts'
import { freezeCopy } from '../../worldgraph/store/schema.ts'
import type { CanonicalData, CanonicalDisplay, CanonicalEditorState, CanonicalTravelMeta } from '../canonical/types.ts'
import { formalStateOfReadModel } from '../../worldgraph/readModel/build.ts'
import { READ_MODEL_TABLES, compareIds, type ReadModel, type ReadModelTable } from '../../worldgraph/readModel/types.ts'
import { EDITOR_STATE_SCHEMA_VERSION, TRAVEL_SCHEMA_VERSION } from '../canonical/schemaVersions.ts'
import {
  DISPLAY_SETTING_KEYS, OFFICIAL, OFFICIAL_DEFINITIONS, UNRESOLVED_KEY_PREFIX, V2_SOURCES, VIEW_SCOPES, mapListScope,
} from './officialDefinitions.ts'

export interface ProjectionOptions {
  /** Runtime field of the App: which data the caller chose (`travel.source`, `wantToGo.source`). */
  readonly source: 'local' | 'sample'
  /** List the rows Canonical cannot express in `skipped` (default true); false leaves `skipped` empty. */
  readonly track?: boolean
  /** Return a deep frozen copy (default true); false returns the result as built, sharing values with the input. */
  readonly freeze?: boolean
}
export interface SkippedRow { readonly table: FormalTable; readonly id: string }
export interface Projection {
  readonly canonical: CanonicalData
  /** File-level metadata that serializeV2 needs and Canonical does not hold. */
  readonly v2Meta: V2FileMeta
  /** Rows Canonical cannot express, by table (FORMAL_TABLES order) and id. */
  readonly skipped: readonly SkippedRow[]
}

type Json = Record<string, JsonValue>
/**
 * The file-level metadata the projection gives beside Canonical (the `v2:import` source's headers), for an export to V2
 * files (serializeV2, ../compat/v2/v2Serializer.ts): what Canonical does not hold.
 */
export interface V2FileMeta {
  /** The places file's `generated_at` (at a migration: its planning time). */
  placesGeneratedAt: string
  /** The want-to-go file's top-level metadata; only `generated_at` / `privacy_level` / `intended_use`, when present. */
  wantToGo?: Record<string, unknown>
  /** The media file's top-level keys other than `schemaVersion` and `items`, as they were. */
  media?: Record<string, unknown>
}
/** The Canonical record an official entry becomes. */
export type OfficialEntryRole = 'footprint' | 'planned' | 'wish' | 'countryVisit'
/** Without a v2:import header there is no generation time; serializeV2 still needs one. */
const NO_GENERATION_TIME = '1970-01-01T00:00:00.000Z'
const plain = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v)
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const v2Of = (row: { readonly extensions?: Json }): Json => (plain(row.extensions?.v2) ? { ...row.extensions.v2 } : {})
const rawDates = (value: JsonValue | undefined): Json => (plain(value) && plain(value.raw) ? value.raw : {})
const OFFICIAL_ROWS: readonly (readonly [FormalTable, string])[] = [
  ...OFFICIAL_DEFINITIONS.sources.map(r => ['sources', r.id] as const),
  ...Object.values(V2_SOURCES).map(id => ['sources', id] as const),
  ...OFFICIAL_DEFINITIONS.entityTypes.map(r => ['entityTypes', r.id] as const),
  ...OFFICIAL_DEFINITIONS.relationTypes.map(r => ['relationTypes', r.id] as const),
  ...OFFICIAL_DEFINITIONS.layers.map(r => ['layers', r.id] as const),
]

/**
 * Which Canonical record an official entry becomes, from its layer, its place and its source (shared with
 * ./officialReader.ts and ./personalBuildReadModel.ts). `subtypeOf` gives a place entity's `subtype` field (undefined
 * for anything else). A travel entry on a country is a country visit, whatever its source (3C-5 E spec §2.6: the
 * place's subtype marks it, no longer the V2 source).
 */
export function officialEntryRole(entry: LayerEntry, subtypeOf: (entityId: string) => unknown): OfficialEntryRole | undefined {
  const sourceId = entry.source.sourceId
  if (entry.layerId === OFFICIAL.travel) {
    if (subtypeOf(entry.entityId) === 'country') return 'countryVisit'
    if (sourceId === V2_SOURCES.travel || sourceId === OFFICIAL.user) return 'footprint'
  } else if (entry.layerId === OFFICIAL.wantToGo) {
    if (sourceId === V2_SOURCES.planned) return 'planned'
    if (sourceId === V2_SOURCES.wantToGo || sourceId === OFFICIAL.user) return 'wish'
  }
  return undefined
}
/** The V2 record id an official entry projects to: its source record, or its own id for a `starmap:user` entry. */
export const recordIdOf = (entry: LayerEntry): string => (entry.source.sourceId === OFFICIAL.user ? entry.id : entry.source.recordId)

/**
 * A place's Canonical value from its entity: the verbatim V2 values, id, subtype, names (the title, unless it is empty
 * and the V2 names were kept), originalLanguage and externalIds. `partOf` and `location` come from the part-of relation
 * and the location anchor (the projection, and ./officialReader.ts, add them).
 */
export function placeValueOf(entity: StoreEntity): Json {
  const { names, originalLanguage, externalIds, ...rest } = v2Of(entity)
  const place: Json = { ...rest, id: entity.id, subtype: entity.fields.subtype }
  // The title wins unless it is empty and the verbatim V2 names were kept instead.
  const title = Object.keys(entity.title.names).length || names === undefined
    ? { names: entity.title.names as Json, originalLanguage: entity.title.originalLanguage }
    : { names, originalLanguage }
  place.names = title.names
  if (title.originalLanguage !== undefined) place.originalLanguage = title.originalLanguage
  const iso = entity.fields.iso3166Alpha2
  if (typeof iso === 'string' || externalIds !== undefined) {
    place.externalIds = { ...(typeof iso === 'string' ? { iso3166Alpha2: iso } : {}), ...(plain(externalIds) ? externalIds : {}) }
  }
  return place
}

/** A want-to-go item's Canonical value from its entry (role 'wish') and its hidden flag. */
export function wishValueOf(entry: LayerEntry, hidden: boolean | undefined): Json {
  const value: Json = { ...v2Of(entry), id: recordIdOf(entry), placeId: entry.entityId }
  const fields = entry.fields
  if (typeof fields.note === 'string') value.note = fields.note
  if (typeof fields.addedAt === 'string') value.addedAt = fields.addedAt
  // An entry created without addedAt was added on the (UTC) day it was created.
  else if (!Object.hasOwn(value, 'addedAt')) value.addedAt = entry.createdAt.slice(0, 10)
  value.hidden = hidden ?? false
  return value
}

/**
 * A footprint or planned record's Canonical value from its entry (role 'footprint' or 'planned'): the verbatim V2 values,
 * id, place, the raw dates, note and trip title, its hidden-from-home flag and journey, and (readV2's rule, v2Reader.ts
 * readRecord) its city's location when it omits both coordinates.
 */
export function recordValueOf(entry: LayerEntry, hidden: boolean | undefined, journeyId: string | undefined, location: unknown): Json {
  const value: Json = { ...v2Of(entry), id: recordIdOf(entry), placeId: entry.entityId }
  const fields = entry.fields
  const raw = rawDates(fields.date)
  for (const [from, to] of [['startDate', 'start_date'], ['endDate', 'end_date'], ['year', 'year']] as const) if (Object.hasOwn(raw, from)) value[to] = raw[from]
  if (typeof fields.note === 'string') value.notes = fields.note
  if (typeof fields.tripTitle === 'string') value.trip_title = fields.tripTitle
  if (hidden !== undefined) value.hiddenFromHome = hidden
  if (journeyId !== undefined) value.journeyId = journeyId
  if (!Object.hasOwn(value, 'lat') && !Object.hasOwn(value, 'lng') && plain(location)) { value.lat = location.lat; value.lng = location.lng }
  return value
}

/**
 * An added country's Canonical value (3C-5 E): the attributes of the evidence its visit entry cites (the region, and V2
 * values such as an empty visitedDate), its place, and the entry's date when it has a start date.
 */
export function addedCountryValueOf(visit: LayerEntry, evidence: readonly Evidence[]): Json {
  const value: Json = {}
  for (const row of evidence) Object.assign(value, row.attributes)
  value.placeId = visit.entityId
  const raw = rawDates(visit.fields.date)
  if (Object.hasOwn(raw, 'startDate')) value.visitedDate = raw.startDate
  return value
}
/**
 * Where an added country without an addedCountryOrder position goes among the others: by the evidence its entry cites
 * (the order before 3C-5 E, when the evidence was the added country), else by the entry.
 */
export const addedCountryTieBreak = (visit: LayerEntry): string => visit.source.evidenceIds[0] ?? visit.id
/** Of two visit entries of one country, the one the official view reads: the later id (UUIDv7: the later one). */
export const laterVisit = (kept: LayerEntry | undefined, entry: LayerEntry): LayerEntry => (kept === undefined || compare(kept.id, entry.id) < 0 ? entry : kept)

/**
 * A media item's Canonical value from its media entity and asset: the asset's metadata, its V2 id (the asset's V2 media
 * record, else the asset id), the entity's place, and its title (the entity's, unless it is empty and the V2 title was
 * kept). The caller checks that the place is a place.
 */
export function mediaValueOf(entity: StoreEntity, asset: AssetReference): Json {
  const kept = v2Of(entity).title
  const title = Object.keys(entity.title.names).length ? entity.title : plain(kept) ? kept : undefined
  const id = asset.source.sourceId === V2_SOURCES.media ? asset.source.recordId : asset.id
  return { ...asset.attributes, id, placeId: entity.fields.place as string, ...(title !== undefined ? { title: title as Json } : {}) }
}

/** The view rows of one scope, as the projection reads them (its own groups, or a read model index). */
export interface ViewScopeAccess {
  /** Items of a scope, in any order. */
  items(scope: string): readonly ViewItem[]
  /** Settings of a scope, in id order. */
  settings(scope: string): readonly ViewSetting[]
}
const noConsume = () => {}

/** A list scope: the items `valueOf` accepts and the unresolved elements, by position, then row id. */
export function viewListOf(access: ViewScopeAccess, scope: string, valueOf: (item: ViewItem) => string | undefined,
  consume: (table: FormalTable, id: string) => void = noConsume): JsonValue[] {
  const elements: { position: string; id: string; table: FormalTable; value: JsonValue }[] = []
  for (const item of access.items(scope)) {
    const value = valueOf(item)
    if (value !== undefined) elements.push({ position: item.position, id: item.id, table: 'viewItems', value })
  }
  for (const setting of access.settings(scope)) {
    const v = setting.value
    if (setting.key.startsWith(UNRESOLVED_KEY_PREFIX) && plain(v) && typeof v.position === 'string' && Object.hasOwn(v, 'id')) {
      elements.push({ position: v.position, id: setting.id, table: 'viewSettings', value: v.id })
    }
  }
  elements.sort((x, y) => compare(x.position, y.position) || compare(x.id, y.id))
  for (const e of elements) consume(e.table, e.id)
  return elements.map(e => e.value)
}

/** The fields of the editor state's lists, in the official view's order. */
export const EDITOR_LIST_FIELDS = Object.freeze([
  'countryOrder', 'hiddenCountryIds', 'cityOrderByCountry', 'hiddenCityIds', 'mediaOrderByCity', 'hiddenMediaIds', 'coverMediaByCity',
  'droneOrderByCity', 'hiddenDroneMediaIds',
] as const)
export type EditorListField = typeof EDITOR_LIST_FIELDS[number]

/**
 * One list of the editor state, as the projection reads it: an editor list scope, one of the three map scopes (one key
 * setting per place, each key's list in its own scope) or the covers. `isPlace` and `isAsset` say which targets exist.
 */
export function editorListOf(field: EditorListField, access: ViewScopeAccess, isPlace: (id: string) => boolean, isAsset: (id: string) => boolean,
  consume: (table: FormalTable, id: string) => void = noConsume): JsonValue {
  const placeItem = (item: ViewItem) => (item.itemTable === 'entities' && isPlace(item.itemId) ? item.itemId : undefined)
  const assetItem = (item: ViewItem) => (item.itemTable === 'assets' && isAsset(item.itemId) ? item.itemId : undefined)
  const list = (scope: string, valueOf: (item: ViewItem) => string | undefined) => viewListOf(access, scope, valueOf, consume)
  /** A map scope: one key setting per key, each key's list in its own scope. */
  const map = (scope: string, valueOf: (item: ViewItem) => string | undefined): Record<string, JsonValue[]> => {
    const result: Record<string, JsonValue[]> = {}
    for (const setting of access.settings(scope)) {
      if (setting.key.startsWith(UNRESOLVED_KEY_PREFIX) || !isPlace(setting.key)) continue
      result[setting.key] = list(mapListScope(scope, setting.key), valueOf)
      consume('viewSettings', setting.id)
    }
    return result
  }
  switch (field) {
    case 'countryOrder': return list(VIEW_SCOPES.countryOrder, placeItem)
    case 'hiddenCountryIds': return list(VIEW_SCOPES.hiddenCountries, placeItem)
    case 'cityOrderByCountry': return map(VIEW_SCOPES.cityOrderByCountry, placeItem)
    case 'hiddenCityIds': return list(VIEW_SCOPES.hiddenCities, placeItem)
    case 'mediaOrderByCity': return map(VIEW_SCOPES.mediaOrderByCity, assetItem)
    case 'hiddenMediaIds': return list(VIEW_SCOPES.hiddenMedia, assetItem)
    case 'coverMediaByCity': {
      const covers: Record<string, string> = {}
      for (const s of access.settings(VIEW_SCOPES.coverMediaByCity)) {
        const cover = s.ref?.table === 'assets' ? s.ref.id : typeof s.value === 'string' ? s.value : undefined
        if (cover === undefined || !isPlace(s.key)) continue
        covers[s.key] = cover; consume('viewSettings', s.id)
      }
      return covers
    }
    case 'droneOrderByCity': return map(VIEW_SCOPES.droneOrderByCity, assetItem)
    case 'hiddenDroneMediaIds': return list(VIEW_SCOPES.hiddenDroneMedia, assetItem)
  }
}

/**
 * The editor state's lists, as the projection reads them (`editorListOf` for each field, in the official view's order).
 */
export function editorListsOf(access: ViewScopeAccess, isPlace: (id: string) => boolean, isAsset: (id: string) => boolean,
  consume: (table: FormalTable, id: string) => void = noConsume): Record<EditorListField, JsonValue> {
  const lists = {} as Record<EditorListField, JsonValue>
  for (const field of EDITOR_LIST_FIELDS) lists[field] = editorListOf(field, access, isPlace, isAsset, consume)
  return lists
}

// ---- The projection's inputs and sections (③: the official view can compute a few sections and keep the rest) ----

type Consume = (table: FormalTable, id: string) => void
type Scoped<T> = ReadonlyMap<string, readonly T[]>
/** Rows grouped by key, each group in id order (so "the first" never depends on row order). */
const group = <T extends { readonly id: string }, K>(rows: readonly T[], keyOf: (row: T) => K | undefined): Map<K, T[]> => {
  const groups = new Map<K, T[]>()
  for (const row of rows) {
    const k = keyOf(row)
    if (k === undefined) continue
    const list = groups.get(k)
    if (list) list.push(row); else groups.set(k, [row])
  }
  for (const list of groups.values()) list.sort((a, b) => compare(a.id, b.id))
  return groups
}
const byId = <T extends { readonly id: string }>(rows: readonly T[]) => new Map(rows.map(r => [r.id, r] as const))
const once = <T>(compute: () => T): (() => T) => {
  let value: T | undefined, done = false
  return () => {
    if (!done) { value = compute(); done = true }
    return value as T
  }
}

/** What the sections of a projection read: the state's rows, view rows grouped by scope, the place index, and the rest on first use. */
interface ProjectionInputs {
  readonly state: FormalState
  readonly consume: Consume
  readonly items: Scoped<ViewItem>
  readonly settings: Scoped<ViewSetting>
  /** Place id → its Canonical value (with `partOf` and `location`). */
  readonly places: ReadonlyMap<string, Json>
  readonly entities: () => ReadonlyMap<string, StoreEntity>
  readonly assets: () => ReadonlyMap<string, AssetReference>
  /** Entry id → the role of an official entry on a place. */
  readonly roles: () => ReadonlyMap<string, OfficialEntryRole>
  /** The `v2:import` source's header of one V2 file. */
  readonly headerOf: (file: string) => Json
}

/** Places: entity, title, fields, part-of relation, location anchor. */
function placesOf(state: FormalState, consume: Consume): Map<string, Json> {
  const places = new Map<string, Json>()
  const parents = group(state.relations, r => (r.typeId === OFFICIAL.partOf ? r.fromEntityId : undefined))
  const locations = group(state.anchors, a => (a.kind === 'location' ? a.entityId : undefined))
  for (const entity of state.entities) {
    if (entity.typeId !== OFFICIAL.place) continue
    places.set(entity.id, placeValueOf(entity))
    consume('entities', entity.id)
  }
  for (const [placeId, place] of places) {
    const parent = parents.get(placeId)?.find(r => places.has(r.toEntityId))
    if (parent) { place.partOf = parent.toEntityId; consume('relations', parent.id) }
    const anchor = locations.get(placeId)?.[0]
    if (anchor?.kind === 'location') {
      place.location = { lat: anchor.lat, lng: anchor.lng, ...(anchor.approximate === true ? { approximate: true } : {}) }
      consume('anchors', anchor.id)
    }
  }
  return places
}

function rolesOf(state: FormalState, places: ReadonlyMap<string, Json>): Map<string, OfficialEntryRole> {
  const roles = new Map<string, OfficialEntryRole>()
  const subtypeOf = (id: string) => places.get(id)?.subtype
  for (const entry of state.entries) {
    const role = officialEntryRole(entry, subtypeOf)
    if (role !== undefined && places.has(entry.entityId)) roles.set(entry.id, role)
  }
  return roles
}

function headersOf(state: FormalState): (file: string) => Json {
  const header = state.sources.find(s => s.id === V2_SOURCES.import)
  const headers = plain(header?.extensions?.v2) ? header.extensions.v2 : {}
  return (file: string): Json => (plain(headers[file]) ? headers[file] : {})
}

/** The inputs of a projection of `state` (every group built here). */
function inputsOf(state: FormalState, consume: Consume): ProjectionInputs {
  const places = placesOf(state, consume)
  return {
    state, consume, places, headerOf: headersOf(state),
    items: group(state.viewItems, v => v.scope),
    settings: group(state.viewSettings, v => v.scope),
    entities: once(() => byId(state.entities)),
    assets: once(() => byId(state.assets) as Map<string, AssetReference>),
    roles: once(() => rolesOf(state, places)),
  }
}

/** Rows of an original-order scope first, by position; the rest after them, by `after`. */
function ordered<T>(p: ProjectionInputs, scope: string, itemTable: ViewItemTable, rows: readonly { readonly itemId: string; readonly value: T; readonly after: readonly [string, string] }[]): T[] {
  const positions = new Map<string, { position: string; id: string }>()
  for (const item of p.items.get(scope) ?? []) if (item.itemTable === itemTable && !positions.has(item.itemId)) positions.set(item.itemId, { position: item.position, id: item.id })
  const keyed = rows.map(row => ({ row, at: positions.get(row.itemId) }))
  for (const { at } of keyed) if (at) p.consume('viewItems', at.id)
  keyed.sort((x, y) => {
    if (x.at && y.at) return compare(x.at.position, y.at.position) || compare(x.at.id, y.at.id)
    if (x.at || y.at) return x.at ? -1 : 1
    return compare(x.row.after[0], y.row.after[0]) || compare(x.row.after[1], y.row.after[1])
  })
  return keyed.map(k => k.row.value)
}
/** Flag of a hidden scope for the given item, using that view row. */
function flags(p: ProjectionInputs, scope: string) {
  const byItem = new Map<string, ViewItem>()
  for (const item of p.items.get(scope) ?? []) if (!byItem.has(item.itemId)) byItem.set(item.itemId, item)
  return (itemId: string): boolean | undefined => {
    const item = byItem.get(itemId)
    if (item) p.consume('viewItems', item.id)
    return item?.hidden
  }
}
const accessOf = (p: ProjectionInputs): ViewScopeAccess => ({ items: (scope) => p.items.get(scope) ?? [], settings: (scope) => p.settings.get(scope) ?? [] })

function placesSection(p: ProjectionInputs): JsonValue[] {
  return ordered(p, VIEW_SCOPES.placeOrder, 'entities', [...p.places].map(([id, value]) => ({ itemId: id, value, after: ['', id] as [string, string] })))
}

/** Footprint and planned records: the entries, their journeys (the ledger's identity), home-hidden flags, the record order. */
function recordsSection(p: ProjectionInputs): JsonValue[] {
  const roles = p.roles()
  const journeyOf = new Map<string, string>()
  const journeyEntities = new Map([...p.entities().values()].filter(e => e.typeId === OFFICIAL.journey).map(e => [e.id, e] as const))
  for (const sequence of [...p.state.sequences].sort((a, b) => compare(a.id, b.id))) {
    const journey = journeyEntities.get(sequence.entityId)
    if (!journey) continue
    // The ledger's journey identity is the entity's v2:journey source record.
    const journeyId = journey.source.sourceId === V2_SOURCES.journey ? journey.source.recordId : journey.id
    let member = false
    for (const entryId of sequence.entryIds) {
      if (roles.get(entryId) !== 'footprint' || journeyOf.has(entryId)) continue
      journeyOf.set(entryId, journeyId); member = true
    }
    if (member) { p.consume('sequences', sequence.id); p.consume('entities', journey.id) }
  }
  const homeHidden = flags(p, VIEW_SCOPES.recordHiddenFromHome)
  const records: { itemId: string; value: Json; after: [string, string] }[] = []
  for (const entry of p.state.entries) {
    const role = roles.get(entry.id)
    if (role !== 'footprint' && role !== 'planned') continue
    p.consume('entries', entry.id)
    const value = recordValueOf(entry, homeHidden(entry.id), journeyOf.get(entry.id), p.places.get(entry.entityId)!.location)
    records.push({ itemId: entry.id, value, after: [entry.createdAt, entry.id] })
  }
  return ordered(p, VIEW_SCOPES.recordOrder, 'entries', records)
}

/** Want-to-go items: the entries, their hidden flags, the want-to-go order. */
function wishesSection(p: ProjectionInputs): JsonValue[] {
  const roles = p.roles()
  const wishHidden = flags(p, VIEW_SCOPES.wantToGoHidden)
  const wishes: { itemId: string; value: Json; after: [string, string] }[] = []
  for (const entry of p.state.entries) {
    if (roles.get(entry.id) !== 'wish') continue
    p.consume('entries', entry.id)
    wishes.push({ itemId: entry.id, value: wishValueOf(entry, wishHidden(entry.id)), after: [entry.createdAt, entry.id] })
  }
  return ordered(p, VIEW_SCOPES.wantToGoOrder, 'entries', wishes)
}

/** Added countries: the visit entry on each country, with the evidence it cites. */
function addedCountriesSection(p: ProjectionInputs): JsonValue[] {
  const roles = p.roles()
  const visits = new Map<string, LayerEntry>()
  for (const entry of p.state.entries) if (roles.get(entry.id) === 'countryVisit') visits.set(entry.entityId, laterVisit(visits.get(entry.entityId), entry))
  const evidenceById = byId(p.state.evidence as readonly Evidence[])
  const containers: { itemId: string; value: Json; after: [string, string] }[] = []
  for (const [placeId, visit] of visits) {
    const evidence = visit.source.evidenceIds.map(id => evidenceById.get(id)).filter((row): row is Evidence => row !== undefined)
    p.consume('entries', visit.id)
    for (const row of evidence) p.consume('evidence', row.id)
    containers.push({ itemId: placeId, value: addedCountryValueOf(visit, evidence), after: ['', addedCountryTieBreak(visit)] })
  }
  return ordered(p, VIEW_SCOPES.addedCountryOrder, 'entities', containers)
}

/** Media: asset metadata, the entity's place and title. */
function mediaSection(p: ProjectionInputs): JsonValue[] {
  const assets = p.assets()
  const media: { itemId: string; value: Json; after: [string, string] }[] = []
  const mediaAssets = new Set<string>()
  for (const entity of [...p.entities().values()].filter(e => e.typeId === OFFICIAL.media).sort((a, b) => compare(a.id, b.id)) as StoreEntity[]) {
    const asset = typeof entity.fields.asset === 'string' ? assets.get(entity.fields.asset) : undefined
    const placeId = entity.fields.place
    if (!asset || typeof placeId !== 'string' || !p.places.has(placeId) || mediaAssets.has(asset.id)) continue
    mediaAssets.add(asset.id)
    media.push({ itemId: asset.id, value: mediaValueOf(entity, asset), after: ['', entity.id] })
    p.consume('entities', entity.id); p.consume('assets', asset.id)
  }
  return ordered(p, VIEW_SCOPES.mediaOrder, 'assets', media)
}

/** The display rules: the display list scopes and the display settings. */
function displaySection(p: ProjectionInputs): CanonicalDisplay {
  const placeItem = (item: ViewItem) => (item.itemTable === 'entities' && p.places.has(item.itemId) ? item.itemId : undefined)
  const list = (scope: string): JsonValue[] => viewListOf(accessOf(p), scope, placeItem, p.consume)
  const displaySetting = (settingKey: string) => {
    const s = p.settings.get(VIEW_SCOPES.display)?.find(row => row.key === settingKey)
    if (s && Object.hasOwn(s, 'value')) p.consume('viewSettings', s.id)
    return s?.value
  }
  const overviewTarget = displaySetting(DISPLAY_SETTING_KEYS.overviewTarget)
  const regionIncludes = displaySetting(DISPLAY_SETTING_KEYS.regionIncludes)
  return {
    ...(overviewTarget !== undefined ? { overviewTarget } : {}),
    homeHiddenCountryIds: list(VIEW_SCOPES.homeHiddenCountries),
    originCountryIds: list(VIEW_SCOPES.originCountries),
    regionCountryIds: list(VIEW_SCOPES.regionCountries),
    regionIncludes: Array.isArray(regionIncludes) ? regionIncludes : [],
    navigationHiddenCityIds: list(VIEW_SCOPES.navigationHiddenCities),
  } as unknown as CanonicalDisplay
}

function editorListSection(p: ProjectionInputs, field: EditorListField): JsonValue {
  return editorListOf(field, accessOf(p), (id) => p.places.has(id), (id) => p.assets().has(id), p.consume)
}

/** File-level metadata of the travel file (v2:import). */
function metaOf(p: ProjectionInputs): CanonicalTravelMeta {
  const travelHeader = p.headerOf('travel')
  return {
    schemaVersion: travelHeader.schema_version ?? TRAVEL_SCHEMA_VERSION,
    ...(travelHeader.generated_at !== undefined ? { generatedAt: travelHeader.generated_at } : {}),
    ...(travelHeader.privacy_level !== undefined ? { privacyLevel: travelHeader.privacy_level } : {}),
    ...(travelHeader.intended_use !== undefined ? { intendedUse: travelHeader.intended_use } : {}),
    ...(travelHeader.safety_notes !== undefined ? { safetyNotes: travelHeader.safety_notes } : {}),
  } as unknown as CanonicalTravelMeta
}

/** The sections of a Canonical, each computed or given. */
interface Sections {
  readonly places: JsonValue[]
  readonly meta: CanonicalTravelMeta
  readonly display: CanonicalDisplay
  readonly records: JsonValue[]
  readonly wishes: JsonValue[]
  readonly addedCountries: JsonValue[]
  readonly lists: Record<EditorListField, JsonValue>
  readonly media: JsonValue[]
}
/** Every section of a projection of `p`. */
const sectionsOf = (p: ProjectionInputs): Sections => ({
  places: placesSection(p), records: recordsSection(p), wishes: wishesSection(p), addedCountries: addedCountriesSection(p), media: mediaSection(p),
  display: displaySection(p), lists: Object.fromEntries(EDITOR_LIST_FIELDS.map(field => [field, editorListSection(p, field)])) as Record<EditorListField, JsonValue>,
  meta: metaOf(p),
})
const editorStateOf = (p: ProjectionInputs, s: Sections) => ({
  schemaVersion: EDITOR_STATE_SCHEMA_VERSION,
  ...p.headerOf('editorState'),
  addedCountries: s.addedCountries,
  ...s.lists,
} as unknown as CanonicalEditorState)
/** The Canonical of the sections (the shape and the key order every projection gives). */
const canonicalOf = (p: ProjectionInputs, source: 'local' | 'sample', s: Sections): CanonicalData => ({
  places: s.places,
  travel: { source, meta: s.meta, display: s.display, records: s.records },
  wantToGo: { source, items: s.wishes, problems: [] },
  editorState: editorStateOf(p, s),
  media: { items: s.media, problems: [] },
} as unknown as CanonicalData)

/** Formal store -> the CanonicalData readV2 would produce, plus serializeV2's file metadata. */
export function projectStoreToCanonical(state: FormalState, options: ProjectionOptions): Projection {
  const track = options.track !== false
  const used = new Set<string>()
  const key = (table: FormalTable, id: string) => JSON.stringify([table, id])
  const consume = track ? (table: FormalTable, id: string) => { used.add(key(table, id)) } : noConsume
  if (track) for (const [table, id] of OFFICIAL_ROWS) if (state[table].some(r => r.id === id)) consume(table, id)

  const inputs = inputsOf(state, consume)
  const canonical = canonicalOf(inputs, options.source, sectionsOf(inputs))

  // --- File-level metadata (v2:import).
  const placesHeader = inputs.headerOf('places')
  const v2Meta: V2FileMeta = {
    placesGeneratedAt: typeof placesHeader.generated_at === 'string' ? placesHeader.generated_at : NO_GENERATION_TIME,
    wantToGo: inputs.headerOf('wantToGo'),
    media: inputs.headerOf('media'),
  }

  const skipped: SkippedRow[] = []
  if (track) {
    for (const table of FORMAL_TABLES) {
      for (const row of [...state[table]].sort((a, b) => compare(a.id, b.id))) if (!used.has(key(table, row.id))) skipped.push({ table, id: row.id })
    }
  }
  const projection = { canonical, v2Meta, skipped }
  return options.freeze === false ? projection : freezeCopy(projection)
}

// ---- ③ (scope-incremental): which sections of the official view a changed row can affect ----

/** A section of the official view that a projection can compute alone, keeping the others. */
export type OfficialViewSection = 'places' | 'records' | 'display' | 'wishes' | 'addedCountries' | 'media' | `editor:${EditorListField}`
/** The projection of the whole store: what a row the table below does not list, or lists as such, needs. */
export const WHOLE_OFFICIAL_VIEW = 'whole'
type Affects = readonly OfficialViewSection[] | typeof WHOLE_OFFICIAL_VIEW
const MEDIA_LISTS: readonly OfficialViewSection[] = ['editor:mediaOrderByCity', 'editor:hiddenMediaIds', 'editor:coverMediaByCity', 'editor:droneOrderByCity', 'editor:hiddenDroneMediaIds']

/**
 * The classification table of the official view's inputs (scope-incremental design §4.1, review §7 item 2): which sections a
 * changed row can affect, by its table and its scope, layer, type or kind. Whatever this table does not list projects the
 * whole store: a scope, layer, entity type, relation type, anchor kind or table it does not know. It stays next to the
 * projection on purpose: a section that reads another scope or type must be listed here, and appStoreIncremental.test.ts
 * checks that every scope, layer and type the projection names is.
 *
 * - View items and settings by scope; a `map` scope also holds each key's list in `<scope>/<key>`.
 * - Entries by layer: on the travel layer the role (footprint or country visit) depends on the place's subtype, so both
 *   sections; on the want-to-go layer it depends on the source only (`wantToGoSources`: planned records or wishes).
 * - Entities by type: a place changes which ids are places, their subtypes and locations, which every section reads.
 * - Relations and anchors: part-of and locations belong to the places (any other is not known: the whole store too).
 */
export const OFFICIAL_VIEW_INPUTS = Object.freeze({
  scopes: Object.freeze([
    { scope: VIEW_SCOPES.placeOrder, affects: ['places'] },
    { scope: VIEW_SCOPES.recordOrder, affects: ['records'] },
    { scope: VIEW_SCOPES.recordHiddenFromHome, affects: ['records'] },
    { scope: VIEW_SCOPES.wantToGoOrder, affects: ['wishes'] },
    { scope: VIEW_SCOPES.wantToGoHidden, affects: ['wishes'] },
    { scope: VIEW_SCOPES.mediaOrder, affects: ['media'] },
    { scope: VIEW_SCOPES.addedCountryOrder, affects: ['addedCountries'] },
    { scope: VIEW_SCOPES.countryOrder, affects: ['editor:countryOrder'] },
    { scope: VIEW_SCOPES.hiddenCountries, affects: ['editor:hiddenCountryIds'] },
    { scope: VIEW_SCOPES.cityOrderByCountry, map: true, affects: ['editor:cityOrderByCountry'] },
    { scope: VIEW_SCOPES.hiddenCities, affects: ['editor:hiddenCityIds'] },
    { scope: VIEW_SCOPES.mediaOrderByCity, map: true, affects: ['editor:mediaOrderByCity'] },
    { scope: VIEW_SCOPES.hiddenMedia, affects: ['editor:hiddenMediaIds'] },
    { scope: VIEW_SCOPES.coverMediaByCity, affects: ['editor:coverMediaByCity'] },
    { scope: VIEW_SCOPES.droneOrderByCity, map: true, affects: ['editor:droneOrderByCity'] },
    { scope: VIEW_SCOPES.hiddenDroneMedia, affects: ['editor:hiddenDroneMediaIds'] },
    { scope: VIEW_SCOPES.homeHiddenCountries, affects: ['display'] },
    { scope: VIEW_SCOPES.originCountries, affects: ['display'] },
    { scope: VIEW_SCOPES.regionCountries, affects: ['display'] },
    { scope: VIEW_SCOPES.navigationHiddenCities, affects: ['display'] },
    { scope: VIEW_SCOPES.display, affects: ['display'] },
  ] as readonly { readonly scope: string; readonly map?: true; readonly affects: Affects }[]),
  layers: Object.freeze({ [OFFICIAL.travel]: ['records', 'addedCountries'], [OFFICIAL.wantToGo]: 'bySource' } as Readonly<Record<string, Affects | 'bySource'>>),
  /** Entries of the want-to-go layer, by source (officialEntryRole). */
  wantToGoSources: Object.freeze({ [V2_SOURCES.planned]: ['records'], [V2_SOURCES.wantToGo]: ['wishes'], [OFFICIAL.user]: ['wishes'] } as Readonly<Record<string, Affects>>),
  entityTypes: Object.freeze({ [OFFICIAL.place]: WHOLE_OFFICIAL_VIEW, [OFFICIAL.journey]: ['records'], [OFFICIAL.media]: ['media'] } as Readonly<Record<string, Affects>>),
  relationTypes: Object.freeze({ [OFFICIAL.partOf]: WHOLE_OFFICIAL_VIEW } as Readonly<Record<string, Affects>>),
  anchorKinds: Object.freeze({ location: WHOLE_OFFICIAL_VIEW } as Readonly<Record<string, Affects>>),
  /** Tables whose every row affects the same sections. */
  tables: Object.freeze({
    evidence: ['addedCountries'], sequences: ['records'], assets: ['media', ...MEDIA_LISTS],
    sources: WHOLE_OFFICIAL_VIEW, entityTypes: WHOLE_OFFICIAL_VIEW, layers: WHOLE_OFFICIAL_VIEW, relationTypes: WHOLE_OFFICIAL_VIEW,
  } as Readonly<Record<string, Affects>>),
})

const listed = (table: Readonly<Record<string, Affects>>, key: unknown): Affects => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : WHOLE_OFFICIAL_VIEW)
/** The sections a view row of `scope` can affect. */
export function scopeAffects(scope: string): Affects {
  for (const entry of OFFICIAL_VIEW_INPUTS.scopes) if (entry.scope === scope || (entry.map && scope.startsWith(`${entry.scope}/`))) return entry.affects
  return WHOLE_OFFICIAL_VIEW
}
/** The sections a row of `table` can affect (see OFFICIAL_VIEW_INPUTS). */
export function rowAffects(table: string, row: unknown): Affects {
  if (!plain(row)) return WHOLE_OFFICIAL_VIEW
  switch (table) {
    case 'viewItems': case 'viewSettings': return typeof row.scope === 'string' ? scopeAffects(row.scope) : WHOLE_OFFICIAL_VIEW
    case 'entries': {
      const layer = typeof row.layerId === 'string' && Object.hasOwn(OFFICIAL_VIEW_INPUTS.layers, row.layerId) ? OFFICIAL_VIEW_INPUTS.layers[row.layerId] : WHOLE_OFFICIAL_VIEW
      return layer === 'bySource' ? listed(OFFICIAL_VIEW_INPUTS.wantToGoSources, plain(row.source) ? row.source.sourceId : undefined) : layer
    }
    case 'entities': return listed(OFFICIAL_VIEW_INPUTS.entityTypes, row.typeId)
    case 'relations': return listed(OFFICIAL_VIEW_INPUTS.relationTypes, row.typeId)
    case 'anchors': return listed(OFFICIAL_VIEW_INPUTS.anchorKinds, row.kind)
    default: return listed(OFFICIAL_VIEW_INPUTS.tables, table)
  }
}

const isReadModelTable = (table: string): table is ReadModelTable => (READ_MODEL_TABLES as readonly string[]).includes(table)
/** The row `id` of a table of `model` (tables are in id order: a binary search). */
function rowOf(model: ReadModel, table: ReadModelTable, id: string): unknown {
  const rows = model[table] as readonly { readonly id: string }[]
  let low = 0, high = rows.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const order = compareIds(rows[middle].id, id)
    if (order === 0) return rows[middle]
    if (order < 0) low = middle + 1; else high = middle - 1
  }
  return undefined
}

/** The changed rows of one or more commits, as the page receives them. */
export interface OfficialViewChanges {
  readonly upserts: readonly { readonly table: string; readonly row: unknown }[]
  readonly deletes: readonly { readonly table: string; readonly id: string }[]
}

/**
 * The sections of the official view that `changes` (after `model`) can affect, or 'whole'. Each row counts with its new
 * value and with the row of the same id in `model` (a row that moves to another scope, layer or type affects both).
 */
export function officialViewChanges(model: ReadModel, changes: OfficialViewChanges): ReadonlySet<OfficialViewSection> | typeof WHOLE_OFFICIAL_VIEW {
  const sections = new Set<OfficialViewSection>()
  const add = (table: string, row: unknown): boolean => {
    const affects = rowAffects(table, row)
    if (affects === WHOLE_OFFICIAL_VIEW) return false
    for (const section of affects) sections.add(section)
    return true
  }
  for (const { table, row } of changes.upserts) {
    if (!isReadModelTable(table) || !plain(row) || typeof row.id !== 'string' || !add(table, row)) return WHOLE_OFFICIAL_VIEW
    const old = rowOf(model, table, row.id)
    if (old !== undefined && !add(table, old)) return WHOLE_OFFICIAL_VIEW
  }
  for (const { table, id } of changes.deletes) {
    if (!isReadModelTable(table)) return WHOLE_OFFICIAL_VIEW
    const old = rowOf(model, table, id)
    if (old === undefined || !add(table, old)) return WHOLE_OFFICIAL_VIEW
  }
  return sections
}

/**
 * The official view of a read model with what a projection of a later read model can keep (③): the view rows grouped by
 * scope, the place index, the header, and the entities, assets and entry roles once they were needed.
 */
export interface OfficialView {
  readonly model: ReadModel
  readonly canonical: CanonicalData
  /** Internal to this module (officialViewAfter). */
  readonly kept: unknown
}

/** The official view of a read model (3C-5B): Canonical for the App's derivation, without skipped rows or a frozen copy. */
export function officialView(model: ReadModel, source: 'local' | 'sample'): OfficialView {
  const inputs = inputsOf(formalStateOfReadModel(model), noConsume)
  return { model, canonical: canonicalOf(inputs, source, sectionsOf(inputs)), kept: inputs }
}
export function officialViewOf(model: ReadModel, source: 'local' | 'sample'): CanonicalData {
  return officialView(model, source).canonical
}

/**
 * ③ (scope-incremental design §4.2): the official view of `model`, the read model `previous.model` moved on by `changes`.
 * Only the sections the changes can affect (officialViewChanges) are computed, with the projection's own section
 * functions; every other one is the object `canonical` (the page's official view of `previous.model`, which may share
 * objects with even earlier ones) has, and so is every container whose sections are all kept. What the sections read is
 * kept from `previous` where its rows did not change: the place index (no place row changed), the view rows grouped by
 * scope (only the scopes of changed view rows are grouped again), the entities, assets and entry roles (when their tables
 * are the same arrays). When the changes affect the whole view, the whole store is projected (`sections: 'whole'`).
 */
export function officialViewAfter(previous: OfficialView, canonical: CanonicalData, model: ReadModel, changes: OfficialViewChanges, source: 'local' | 'sample'):
  { readonly view: OfficialView; readonly sections: ReadonlySet<OfficialViewSection> | typeof WHOLE_OFFICIAL_VIEW } {
  const sections = officialViewChanges(previous.model, changes)
  if (sections === WHOLE_OFFICIAL_VIEW) return { view: officialView(model, source), sections }
  const kept = previous.kept as ProjectionInputs
  const before = previous.model
  const state = formalStateOfReadModel(model)
  /** The groups of a view table: kept, with the scopes of its changed rows grouped again from `model`. */
  const regroup = <T extends { readonly id: string; readonly scope: string }>(table: 'viewItems' | 'viewSettings', groups: Scoped<T>): Scoped<T> => {
    if (model[table] === before[table]) return groups
    const scopes = new Set<string>()
    for (const { table: changed, row } of changes.upserts) if (changed === table && plain(row) && typeof row.scope === 'string') scopes.add(row.scope)
    const rowsOf = (id: string) => rowOf(before, table, id) as T | undefined
    for (const { table: changed, row } of changes.upserts) if (changed === table && plain(row) && typeof row.id === 'string') { const old = rowsOf(row.id); if (old) scopes.add(old.scope) }
    for (const { table: changed, id } of changes.deletes) if (changed === table) { const old = rowsOf(id); if (old) scopes.add(old.scope) }
    const next = new Map(groups)
    for (const scope of scopes) next.delete(scope)
    for (const [scope, rows] of group((model[table] as unknown as readonly T[]).filter(row => scopes.has(row.scope)), row => row.scope)) next.set(scope, rows)
    return next
  }
  const inputs: ProjectionInputs = {
    state, consume: noConsume, places: kept.places, headerOf: kept.headerOf,
    items: regroup('viewItems', kept.items),
    settings: regroup('viewSettings', kept.settings),
    entities: model.entities === before.entities ? kept.entities : once(() => byId(state.entities)),
    assets: model.assets === before.assets ? kept.assets : once(() => byId(state.assets) as Map<string, AssetReference>),
    roles: model.entries === before.entries ? kept.roles : once(() => rolesOf(state, kept.places)),
  }
  const c = canonical as unknown as {
    places: JsonValue[]; travel: { meta: CanonicalTravelMeta; display: CanonicalDisplay; records: JsonValue[] }; wantToGo: { items: JsonValue[] }
    editorState: Record<string, JsonValue>; media: { items: JsonValue[] }
  }
  const want = (section: OfficialViewSection) => sections.has(section)
  const s: Sections = {
    places: want('places') ? placesSection(inputs) : c.places,
    meta: c.travel.meta,
    display: want('display') ? displaySection(inputs) : c.travel.display,
    records: want('records') ? recordsSection(inputs) : c.travel.records,
    wishes: want('wishes') ? wishesSection(inputs) : c.wantToGo.items,
    addedCountries: want('addedCountries') ? addedCountriesSection(inputs) : c.editorState.addedCountries as JsonValue[],
    lists: Object.fromEntries(EDITOR_LIST_FIELDS.map(field => [field, want(`editor:${field}`) ? editorListSection(inputs, field) : c.editorState[field]])) as Record<EditorListField, JsonValue>,
    media: want('media') ? mediaSection(inputs) : c.media.items,
  }
  // The containers whose sections are all kept are kept too (and the whole view when every one is).
  const travel = s.display === c.travel.display && s.records === c.travel.records ? c.travel : { source, meta: s.meta, display: s.display, records: s.records }
  const wantToGo = s.wishes === c.wantToGo.items ? c.wantToGo : { source, items: s.wishes, problems: [] }
  const editorState = s.addedCountries === c.editorState.addedCountries && EDITOR_LIST_FIELDS.every(field => s.lists[field] === c.editorState[field]) ? c.editorState : editorStateOf(inputs, s)
  const media = s.media === c.media.items ? c.media : { items: s.media, problems: [] }
  const same = s.places === c.places && travel === c.travel && wantToGo === c.wantToGo && editorState === c.editorState && media === c.media
  const next = same ? canonical : { places: s.places, travel, wantToGo, editorState, media } as unknown as CanonicalData
  return { view: { model, canonical: next, kept: inputs }, sections }
}
