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
 * Pure: the input is never modified, and nothing but the rows themselves is read;
 * the result does not depend on the order of rows within a table.
 *
 * The official view (3C-5B, design 3C-5 §2 option 1): the App reads the read model through this same function, with
 * two options that only drop work, never change the result: `track: false` lists no skipped rows (the App does not
 * need them; export-v2 does), and `freeze: false` returns the result without a deep frozen copy, so it shares row values
 * with its input and its callers must not modify it. `officialViewOf(model, source)` is that call on a read model.
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative
 * imports with `.ts`, `import type` for types).
 */
import { FORMAL_TABLES, type FormalState, type FormalTable, type ViewItem, type ViewItemTable, type ViewSetting } from '../../worldgraph/store/formal.ts'
import type { AssetReference, Evidence, JsonValue, LayerEntry, StoreEntity } from '../../worldgraph/store/types.ts'
import { freezeCopy } from '../../worldgraph/store/schema.ts'
import type { CanonicalData, CanonicalDisplay, CanonicalEditorState, CanonicalTravelMeta } from '../canonical/types.ts'
import type { V2FileMeta } from '../canonical/v2Serializer.ts'
import { formalStateOfReadModel } from '../../worldgraph/readModel/build.ts'
import type { ReadModel } from '../../worldgraph/readModel/types.ts'
import { EDITOR_STATE_SCHEMA_VERSION, TRAVEL_SCHEMA_VERSION } from '../canonical/v2Schema.ts'
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

/** Which Canonical record an official entry becomes, from its layer and source (shared with ./personalBuildReadModel.ts). */
export function officialEntryRole(entry: LayerEntry): OfficialEntryRole | undefined {
  const sourceId = entry.source.sourceId
  if (entry.layerId === OFFICIAL.travel) {
    if (sourceId === V2_SOURCES.travel || sourceId === OFFICIAL.user) return 'footprint'
    if (sourceId === V2_SOURCES.countryVisit) return 'countryVisit'
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

/** An added country's Canonical value: its evidence's attributes and place, and the visit entry's date. */
export function addedCountryValueOf(evidence: Evidence, visit: LayerEntry | undefined): Json {
  const value: Json = { ...evidence.attributes, placeId: evidence.recordId }
  if (visit) {
    const raw = rawDates(visit.fields.date)
    if (Object.hasOwn(raw, 'startDate')) value.visitedDate = raw.startDate
  }
  return value
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

/**
 * The editor state's lists, as the projection reads them: the editor list scopes, the three map scopes (one key setting
 * per place, each key's list in its own scope) and the covers. `isPlace` and `isAsset` say which targets exist.
 */
export function editorListsOf(access: ViewScopeAccess, isPlace: (id: string) => boolean, isAsset: (id: string) => boolean,
  consume: (table: FormalTable, id: string) => void = noConsume) {
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
  const covers: Record<string, string> = {}
  for (const s of access.settings(VIEW_SCOPES.coverMediaByCity)) {
    const cover = s.ref?.table === 'assets' ? s.ref.id : typeof s.value === 'string' ? s.value : undefined
    if (cover === undefined || !isPlace(s.key)) continue
    covers[s.key] = cover; consume('viewSettings', s.id)
  }
  return {
    countryOrder: list(VIEW_SCOPES.countryOrder, placeItem),
    hiddenCountryIds: list(VIEW_SCOPES.hiddenCountries, placeItem),
    cityOrderByCountry: map(VIEW_SCOPES.cityOrderByCountry, placeItem),
    hiddenCityIds: list(VIEW_SCOPES.hiddenCities, placeItem),
    mediaOrderByCity: map(VIEW_SCOPES.mediaOrderByCity, assetItem),
    hiddenMediaIds: list(VIEW_SCOPES.hiddenMedia, assetItem),
    coverMediaByCity: covers,
    droneOrderByCity: map(VIEW_SCOPES.droneOrderByCity, assetItem),
    hiddenDroneMediaIds: list(VIEW_SCOPES.hiddenDroneMedia, assetItem),
  }
}

/** Formal store -> the CanonicalData readV2 would produce, plus serializeV2's file metadata. */
export function projectStoreToCanonical(state: FormalState, options: ProjectionOptions): Projection {
  const track = options.track !== false
  const used = new Set<string>()
  const key = (table: FormalTable, id: string) => JSON.stringify([table, id])
  const consume = track ? (table: FormalTable, id: string) => { used.add(key(table, id)) } : () => {}
  const byId = <T extends { readonly id: string }>(rows: readonly T[]) => new Map(rows.map(r => [r.id, r] as const))
  const group = <T, K>(rows: readonly T[], keyOf: (row: T) => K | undefined) => {
    const groups = new Map<K, T[]>()
    for (const row of rows) {
      const k = keyOf(row)
      if (k === undefined) continue
      const list = groups.get(k)
      if (list) list.push(row); else groups.set(k, [row])
    }
    // First by id, so "the first" never depends on row order.
    for (const list of groups.values()) list.sort((a, b) => compare((a as { id: string }).id, (b as { id: string }).id))
    return groups
  }
  if (track) for (const [table, id] of OFFICIAL_ROWS) if (state[table].some(r => r.id === id)) consume(table, id)

  const header = state.sources.find(s => s.id === V2_SOURCES.import)
  const headers = plain(header?.extensions?.v2) ? header.extensions.v2 : {}
  const headerOf = (file: string): Json => (plain(headers[file]) ? headers[file] : {})
  const items = group(state.viewItems, v => v.scope)
  const settings = group(state.viewSettings, v => v.scope)
  const entities = byId(state.entities), assets = byId(state.assets)

  // --- Places: entity, title, fields, part-of relation, location anchor.
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
  const isPlace = (id: string) => places.has(id)

  /** Rows of an original-order scope first, by position; the rest after them, by `after`. */
  function ordered<T>(scope: string, itemTable: ViewItemTable, rows: readonly { readonly itemId: string; readonly value: T; readonly after: readonly [string, string] }[]): T[] {
    const positions = new Map<string, { position: string; id: string }>()
    for (const item of items.get(scope) ?? []) if (item.itemTable === itemTable && !positions.has(item.itemId)) positions.set(item.itemId, { position: item.position, id: item.id })
    const keyed = rows.map(row => ({ row, at: positions.get(row.itemId) }))
    for (const { at } of keyed) if (at) consume('viewItems', at.id)
    keyed.sort((x, y) => {
      if (x.at && y.at) return compare(x.at.position, y.at.position) || compare(x.at.id, y.at.id)
      if (x.at || y.at) return x.at ? -1 : 1
      return compare(x.row.after[0], y.row.after[0]) || compare(x.row.after[1], y.row.after[1])
    })
    return keyed.map(k => k.row.value)
  }
  /** Flag of a hidden scope for the given item, using that view row. */
  const flags = (scope: string) => {
    const byItem = new Map<string, ViewItem>()
    for (const item of items.get(scope) ?? []) if (!byItem.has(item.itemId)) byItem.set(item.itemId, item)
    return (itemId: string): boolean | undefined => {
      const item = byItem.get(itemId)
      if (item) consume('viewItems', item.id)
      return item?.hidden
    }
  }

  // --- Entries.
  const roles = new Map<string, OfficialEntryRole>()
  for (const entry of state.entries) {
    const role = officialEntryRole(entry)
    if (role !== undefined && isPlace(entry.entityId)) roles.set(entry.id, role)
  }
  const journeyOf = new Map<string, string>()
  const journeyEntities = new Map([...entities.values()].filter(e => e.typeId === OFFICIAL.journey).map(e => [e.id, e] as const))
  for (const sequence of [...state.sequences].sort((a, b) => compare(a.id, b.id))) {
    const journey = journeyEntities.get(sequence.entityId)
    if (!journey) continue
    // The ledger's journey identity is the entity's v2:journey source record.
    const journeyId = journey.source.sourceId === V2_SOURCES.journey ? journey.source.recordId : journey.id
    let member = false
    for (const entryId of sequence.entryIds) {
      if (roles.get(entryId) !== 'footprint' || journeyOf.has(entryId)) continue
      journeyOf.set(entryId, journeyId); member = true
    }
    if (member) { consume('sequences', sequence.id); consume('entities', journey.id) }
  }
  const homeHidden = flags(VIEW_SCOPES.recordHiddenFromHome)
  const wishHidden = flags(VIEW_SCOPES.wantToGoHidden)
  const records: { itemId: string; value: Json; after: [string, string] }[] = []
  const wishes: { itemId: string; value: Json; after: [string, string] }[] = []
  const visits = new Map<string, LayerEntry>()
  for (const entry of state.entries) {
    const role = roles.get(entry.id)
    if (role === undefined) continue
    if (role === 'countryVisit') { if (entry.entityId === entry.source.recordId) visits.set(entry.source.recordId, entry); continue }
    consume('entries', entry.id)
    if (role === 'wish') {
      wishes.push({ itemId: entry.id, value: wishValueOf(entry, wishHidden(entry.id)), after: [entry.createdAt, entry.id] })
      continue
    }
    const value = recordValueOf(entry, homeHidden(entry.id), journeyOf.get(entry.id), places.get(entry.entityId)!.location)
    records.push({ itemId: entry.id, value, after: [entry.createdAt, entry.id] })
  }

  // --- Added countries: the evidence container, with the visit entry's date.
  const containers: { itemId: string; value: Json; after: [string, string] }[] = []
  for (const evidence of state.evidence as readonly Evidence[]) {
    if (evidence.sourceId !== V2_SOURCES.countryVisit || !isPlace(evidence.recordId)) continue
    const visit = visits.get(evidence.recordId)
    const value = addedCountryValueOf(evidence, visit)
    if (visit) consume('entries', visit.id)
    consume('evidence', evidence.id)
    containers.push({ itemId: evidence.recordId, value, after: ['', evidence.id] })
  }

  // --- Media: asset metadata, the entity's place and title.
  const media: { itemId: string; value: Json; after: [string, string] }[] = []
  const mediaAssets = new Set<string>()
  for (const entity of [...entities.values()].filter(e => e.typeId === OFFICIAL.media).sort((a, b) => compare(a.id, b.id)) as StoreEntity[]) {
    const asset = typeof entity.fields.asset === 'string' ? assets.get(entity.fields.asset) as AssetReference | undefined : undefined
    const placeId = entity.fields.place
    if (!asset || typeof placeId !== 'string' || !isPlace(placeId) || mediaAssets.has(asset.id)) continue
    mediaAssets.add(asset.id)
    const kept = v2Of(entity).title
    const title = Object.keys(entity.title.names).length ? entity.title : plain(kept) ? kept : undefined
    const id = asset.source.sourceId === V2_SOURCES.media ? asset.source.recordId : asset.id
    media.push({ itemId: asset.id, value: { ...asset.attributes, id, placeId, ...(title !== undefined ? { title: title as Json } : {}) }, after: ['', entity.id] })
    consume('entities', entity.id); consume('assets', asset.id)
  }

  // --- Lists of the editor state and the display.
  const access: ViewScopeAccess = { items: (scope) => items.get(scope) ?? [], settings: (scope) => settings.get(scope) ?? [] }
  const placeItem = (item: ViewItem) => (item.itemTable === 'entities' && isPlace(item.itemId) ? item.itemId : undefined)
  const list = (scope: string, valueOf: (item: ViewItem) => string | undefined): JsonValue[] => viewListOf(access, scope, valueOf, consume)
  const setting = (scope: string, settingKey: string): ViewSetting | undefined => settings.get(scope)?.find(s => s.key === settingKey)
  const displaySetting = (settingKey: string) => {
    const s = setting(VIEW_SCOPES.display, settingKey)
    if (s && Object.hasOwn(s, 'value')) consume('viewSettings', s.id)
    return s?.value
  }
  const overviewTarget = displaySetting(DISPLAY_SETTING_KEYS.overviewTarget)
  const regionIncludes = displaySetting(DISPLAY_SETTING_KEYS.regionIncludes)
  const display = {
    ...(overviewTarget !== undefined ? { overviewTarget } : {}),
    homeHiddenCountryIds: list(VIEW_SCOPES.homeHiddenCountries, placeItem),
    originCountryIds: list(VIEW_SCOPES.originCountries, placeItem),
    regionCountryIds: list(VIEW_SCOPES.regionCountries, placeItem),
    regionIncludes: Array.isArray(regionIncludes) ? regionIncludes : [],
    navigationHiddenCityIds: list(VIEW_SCOPES.navigationHiddenCities, placeItem),
  } as unknown as CanonicalDisplay
  const editorState = {
    schemaVersion: EDITOR_STATE_SCHEMA_VERSION,
    ...headerOf('editorState'),
    addedCountries: ordered(VIEW_SCOPES.addedCountryOrder, 'entities', containers),
    ...editorListsOf(access, isPlace, (id) => assets.has(id), consume),
  } as unknown as CanonicalEditorState

  // --- File-level metadata (v2:import).
  const travelHeader = headerOf('travel'), placesHeader = headerOf('places')
  const meta = {
    schemaVersion: travelHeader.schema_version ?? TRAVEL_SCHEMA_VERSION,
    ...(travelHeader.generated_at !== undefined ? { generatedAt: travelHeader.generated_at } : {}),
    ...(travelHeader.privacy_level !== undefined ? { privacyLevel: travelHeader.privacy_level } : {}),
    ...(travelHeader.intended_use !== undefined ? { intendedUse: travelHeader.intended_use } : {}),
    ...(travelHeader.safety_notes !== undefined ? { safetyNotes: travelHeader.safety_notes } : {}),
  } as unknown as CanonicalTravelMeta
  const v2Meta: V2FileMeta = {
    placesGeneratedAt: typeof placesHeader.generated_at === 'string' ? placesHeader.generated_at : NO_GENERATION_TIME,
    wantToGo: headerOf('wantToGo'),
    media: headerOf('media'),
  }

  const canonical = {
    places: ordered(VIEW_SCOPES.placeOrder, 'entities', [...places].map(([id, value]) => ({ itemId: id, value, after: ['', id] as [string, string] }))),
    travel: { source: options.source, meta, display, records: ordered(VIEW_SCOPES.recordOrder, 'entries', records) },
    wantToGo: { source: options.source, items: ordered(VIEW_SCOPES.wantToGoOrder, 'entries', wishes), problems: [] },
    editorState,
    media: { items: ordered(VIEW_SCOPES.mediaOrder, 'assets', media), problems: [] },
  } as unknown as CanonicalData

  const skipped: SkippedRow[] = []
  if (track) {
    for (const table of FORMAL_TABLES) {
      for (const row of [...state[table]].sort((a, b) => compare(a.id, b.id))) if (!used.has(key(table, row.id))) skipped.push({ table, id: row.id })
    }
  }
  const projection = { canonical, v2Meta, skipped }
  return options.freeze === false ? projection : freezeCopy(projection)
}

/** The official view of a read model (3C-5B): Canonical for the App's derivation, without skipped rows or a frozen copy. */
export function officialViewOf(model: ReadModel, source: 'local' | 'sample'): CanonicalData {
  return projectStoreToCanonical(formalStateOfReadModel(model), { source, track: false, freeze: false }).canonical
}
