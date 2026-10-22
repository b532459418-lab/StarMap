/** The official reader (3C-5 C1, design 3C-5 §3): the questions the store-native editor rules ask about the official
 * data, answered from a read model index (the host's live index) and never by projecting the whole store.
 *
 * Every answer is what the official view (./projectCanonical.ts) would give for the same rows: places, want-to-go
 * items and the editor lists are built by the projection's own functions (placeValueOf, wishValueOf, editorListsOf),
 * and orders follow its rules (the original-order scopes first, by position; then rows without a position).
 * - Places: one place (`place`), its subtype; every country in the official order (`countries`, for the country
 *   resolution); the cities of a country (`citiesOf`, for the city candidates).
 * - Want-to-go items: by their V2 id (`wish`), on a place (`wishesOn`); each with its entry and hidden view row.
 * - The editor state's lists (`editorLists`) and the rows of a view scope (`scope`).
 * - 3C-5 C2: footprint and planned records (`record`, `recordsOn`, `recordById`, `recordsInOrder`, `visitedTitled`), each
 *   with its entry and the official view's value (recordValueOf); the journey the projection assigns a footprint entry to
 *   (`journeyOfEntry`) and a journey's members (`journeyMembers`); the added countries (`addedCountries`).
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types).
 */
import type { ViewItem, ViewSetting } from '../../worldgraph/store/formal.ts'
import type { Ref } from '../../worldgraph/store/reader.ts'
import type { EntrySequence, Evidence, LayerEntry, StoreEntity } from '../../worldgraph/store/types.ts'
import type { ReadModelIndex } from '../../worldgraph/readModel/lookup.ts'
import type { ReadModelTable } from '../../worldgraph/readModel/types.ts'
import type { CanonicalEditorState, CanonicalPlace, CanonicalWantToGoItem } from '../canonical/types.ts'
import { OFFICIAL, V2_SOURCES, VIEW_SCOPES } from './officialDefinitions.ts'
import {
  addedCountryValueOf, editorListsOf, officialEntryRole, placeValueOf, recordIdOf, recordValueOf, wishValueOf, type ViewScopeAccess,
} from './projectCanonical.ts'

/** The index the reader needs: lookups, and reverse references (the host's live index has them). */
export interface OfficialReaderIndex extends ReadModelIndex {
  referencesTo?(table: ReadModelTable, id: string): readonly Ref[]
}

/** A want-to-go item with its rows. */
export interface OfficialWish {
  readonly entry: LayerEntry
  /** The Canonical item (the official view's value). */
  readonly item: CanonicalWantToGoItem
  /** Its row in the hidden scope (the first by id, as the projection reads it), if any. */
  readonly hiddenRow?: ViewItem
}

export type EditorLists = Omit<CanonicalEditorState, 'schemaVersion' | 'addedCountries' | 'updatedAt'>

/** A footprint or planned record with its entry. */
export interface OfficialRecord {
  readonly entry: LayerEntry
  readonly planned: boolean
  /** The Canonical record (the official view's value: V2 id, place, dates, title, journey, coordinates). */
  readonly record: Readonly<Record<string, unknown>> & { readonly id: string; readonly placeId: string }
}
/** A record as the country order reads it. */
export interface OfficialVisit {
  readonly entry: LayerEntry
  readonly placeId: string
  readonly planned: boolean
  readonly start_date?: unknown
  readonly end_date?: unknown
}
/** A journey as the projection reads it: its id, its entity and the entity's sequences (id order). */
export interface OfficialJourney {
  readonly journeyId: string
  readonly entity: StoreEntity
  readonly sequences: readonly EntrySequence[]
}
/** An added country: its evidence, the visit entry, and the Canonical value. */
export interface OfficialAddedCountry {
  readonly placeId: string
  readonly evidence: Evidence
  readonly visit?: LayerEntry
  readonly value: Readonly<Record<string, unknown>>
}

export interface OfficialReader {
  readonly index: OfficialReaderIndex
  place(id: string): CanonicalPlace | undefined
  /** True when `id` is a place (an entity of the place type): place(id) is defined. */
  isPlace(id: string): boolean
  subtypeOf(id: string): 'country' | 'city' | undefined
  /** Every country, in the official order. */
  countries(): readonly CanonicalPlace[]
  /** The cities whose country (first part-of relation to a place) is `countryId`, in the official order. */
  citiesOf(countryId: string): readonly CanonicalPlace[]
  /** The want-to-go item with this V2 id, if any. */
  wish(id: string): OfficialWish | undefined
  /** The want-to-go items on a place (hidden ones too). */
  wishesOn(placeId: string): readonly OfficialWish[]
  /** The editor state's lists (the official view's editorState without the added countries and headers). */
  editorLists(): EditorLists
  /** The items and settings of one view scope. */
  scope(scope: string): { readonly items: readonly ViewItem[]; readonly settings: readonly ViewSetting[] }
  /** The view item of `scope` that targets `table`/`id`, if any. */
  viewItem(scope: string, table: 'entities' | 'entries' | 'assets', id: string): ViewItem | undefined
  /** The setting of `scope` with `key`, if any. */
  viewSetting(scope: string, key: string): ViewSetting | undefined
  /** True when `entry` is a footprint or planned record of the official view (its role, on a place). */
  isRecord(entry: LayerEntry): boolean
  /** The record of a footprint or planned entry. */
  record(entry: LayerEntry): OfficialRecord
  /** The footprint and planned records on a place. */
  recordsOn(placeId: string): readonly OfficialRecord[]
  /** The first record, in the official order, whose V2 id is `id`. */
  recordById(id: string): OfficialRecord | undefined
  /** Every footprint and planned record, in the official order (recordOrder positions, then creation time and id). */
  recordsInOrder(): readonly OfficialRecord[]
  /** The visited records (footprint entries) whose trip title is `title`. */
  visitedTitled(title: string): readonly OfficialRecord[]
  /**
   * Every footprint and planned record in the official order, light (no Canonical value): its entry, place, whether
   * planned, and its visit dates as the official view gives them (for the country order).
   */
  visitsInOrder(): readonly OfficialVisit[]
  /** The country a place counts for (V2's countryIdOfPlace: a country itself, any other place's part-of), without building it. */
  countryOf(placeId: string): string | undefined
  /** The journey the projection assigns a footprint entry to, if any. */
  journeyOfEntry(entryId: string): OfficialJourney | undefined
  /** The journey with this id (a journey some footprint entry belongs to), if any. */
  journey(journeyId: string): OfficialJourney | undefined
  /** The footprint entries the projection assigns to a journey. */
  journeyMembers(journeyId: string): readonly OfficialRecord[]
  /** The added countries, in the official order (addedCountryOrder positions, then evidence id). */
  addedCountries(): readonly OfficialAddedCountry[]
}

const byPositionThenId = (a: { position: string; id: string }, b: { position: string; id: string }) =>
  (a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** The official reader of `index` (see the file header). Answers are cached for the reader's lifetime (one write). */
export function officialReader(index: OfficialReaderIndex): OfficialReader {
  const places = new Map<string, CanonicalPlace | undefined>()
  const isPlaceEntity = (id: string) => (index.get('entities', id) as StoreEntity | undefined)?.typeId === OFFICIAL.place
  const place = (id: string): CanonicalPlace | undefined => {
    if (places.has(id)) return places.get(id)
    const entity = index.get('entities', id) as StoreEntity | undefined
    let value: CanonicalPlace | undefined
    if (entity?.typeId === OFFICIAL.place) {
      const built = placeValueOf(entity) as Record<string, unknown>
      // The projection's part-of: the first part-of relation (by id) to a place; its location: the first location anchor.
      const parent = index.relationsFrom(id, OFFICIAL.partOf).find((relation) => isPlaceEntity(relation.toEntityId))
      if (parent) built.partOf = parent.toEntityId
      const anchor = index.anchorsOf(id).find((row) => row.kind === 'location')
      if (anchor?.kind === 'location') built.location = { lat: anchor.lat, lng: anchor.lng, ...(anchor.approximate === true ? { approximate: true } : {}) }
      value = built as unknown as CanonicalPlace
    }
    places.set(id, value)
    return value
  }
  /** Places in the official order: positioned in placeOrder first (position, then row id), then by entity id. */
  const inOfficialOrder = (ids: readonly string[]): CanonicalPlace[] => {
    const at = new Map<string, ViewItem>()
    for (const item of index.viewItemsOf(VIEW_SCOPES.placeOrder)) if (item.itemTable === 'entities' && !at.has(item.itemId)) at.set(item.itemId, item)
    return [...ids].sort((a, b) => {
      const x = at.get(a), y = at.get(b)
      if (x && y) return byPositionThenId(x, y)
      if (x || y) return x ? -1 : 1
      return a < b ? -1 : a > b ? 1 : 0
    }).map((id) => place(id)!)
  }
  let countryList: readonly CanonicalPlace[] | undefined
  const scopeAccess: ViewScopeAccess = { items: (scope) => index.viewItemsOf(scope), settings: (scope) => index.viewSettingsOf(scope) }
  let lists: EditorLists | undefined
  let wishes: { byId: Map<string, OfficialWish>; byPlace: Map<string, OfficialWish[]> } | undefined
  const wishIndex = () => {
    if (wishes) return wishes
    const hidden = new Map<string, ViewItem>()
    for (const item of [...index.viewItemsOf(VIEW_SCOPES.wantToGoHidden)].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      if (item.itemTable === 'entries' && !hidden.has(item.itemId)) hidden.set(item.itemId, item)
    }
    const byId = new Map<string, OfficialWish>(), byPlace = new Map<string, OfficialWish[]>()
    for (const entry of index.entriesOfLayer(OFFICIAL.wantToGo)) {
      if (officialEntryRole(entry) !== 'wish' || !isPlaceEntity(entry.entityId)) continue
      const hiddenRow = hidden.get(entry.id)
      const wish: OfficialWish = { entry, item: wishValueOf(entry, hiddenRow?.hidden) as unknown as CanonicalWantToGoItem, ...(hiddenRow ? { hiddenRow } : {}) }
      // The projection keeps every entry; two with one V2 id would both show. The first by entry id answers here.
      if (!byId.has(recordIdOf(entry))) byId.set(recordIdOf(entry), wish)
      const list = byPlace.get(entry.entityId) ?? []
      list.push(wish)
      byPlace.set(entry.entityId, list)
    }
    return (wishes = { byId, byPlace })
  }

  // --- Records (3C-5 C2): the projection's roles, flags, journeys and orders.
  const isRecord = (entry: LayerEntry): boolean => {
    const role = officialEntryRole(entry)
    return (role === 'footprint' || role === 'planned') && isPlaceEntity(entry.entityId)
  }
  let homeHidden: Map<string, ViewItem> | undefined
  const hiddenFromHome = (entryId: string) => {
    if (!homeHidden) {
      homeHidden = new Map()
      for (const item of [...index.viewItemsOf(VIEW_SCOPES.recordHiddenFromHome)].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
        if (!homeHidden.has(item.itemId)) homeHidden.set(item.itemId, item)
      }
    }
    return homeHidden.get(entryId)?.hidden
  }
  /** The projection's journeys: sequences of journey entities by id; an entry belongs to the first that lists it. */
  let journeys: { byEntry: Map<string, OfficialJourney>; byId: Map<string, OfficialJourney>; members: Map<string, LayerEntry[]> } | undefined
  const journeyIndex = () => {
    if (journeys) return journeys
    const byEntry = new Map<string, OfficialJourney>(), byId = new Map<string, OfficialJourney>(), members = new Map<string, LayerEntry[]>()
    const sequences: { sequence: EntrySequence; entity: StoreEntity }[] = []
    for (const entity of index.entitiesOfType(OFFICIAL.journey)) for (const sequence of index.sequencesOfEntity(entity.id)) sequences.push({ sequence, entity })
    sequences.sort((a, b) => (a.sequence.id < b.sequence.id ? -1 : a.sequence.id > b.sequence.id ? 1 : 0))
    for (const { sequence, entity } of sequences) {
      const journeyId = entity.source.sourceId === V2_SOURCES.journey ? entity.source.recordId : entity.id
      for (const entryId of sequence.entryIds) {
        const entry = index.get('entries', entryId) as LayerEntry | undefined
        if (!entry || !isRecord(entry) || officialEntryRole(entry) !== 'footprint' || byEntry.has(entryId)) continue
        let journey = byId.get(journeyId)
        if (!journey) byId.set(journeyId, journey = { journeyId, entity, sequences: index.sequencesOfEntity(entity.id) })
        byEntry.set(entryId, journey)
        const list = members.get(journeyId) ?? []
        list.push(entry)
        members.set(journeyId, list)
      }
    }
    return (journeys = { byEntry, byId, members })
  }
  const records = new Map<string, OfficialRecord>()
  const recordOf = (entry: LayerEntry): OfficialRecord => {
    let found = records.get(entry.id)
    if (!found) {
      const value = recordValueOf(entry, hiddenFromHome(entry.id), journeyIndex().byEntry.get(entry.id)?.journeyId, place(entry.entityId)?.location)
      found = { entry, planned: officialEntryRole(entry) === 'planned', record: value as OfficialRecord['record'] }
      records.set(entry.id, found)
    }
    return found
  }
  /** The record entries in the official order: recordOrder positions, then creation time and id. */
  let orderedEntries: readonly LayerEntry[] | undefined
  const entriesInOrder = (): readonly LayerEntry[] => {
    if (orderedEntries) return orderedEntries
    const all = [...index.entriesOfLayer(OFFICIAL.travel), ...index.entriesOfLayer(OFFICIAL.wantToGo)].filter(isRecord)
    const positioned = new Set<string>(), result: LayerEntry[] = []
    const isListed = new Set(all.map((entry) => entry.id))
    for (const item of index.viewItemsOf(VIEW_SCOPES.recordOrder)) {
      if (item.itemTable !== 'entries' || !isListed.has(item.itemId) || positioned.has(item.itemId)) continue
      positioned.add(item.itemId)
      result.push(index.get('entries', item.itemId) as LayerEntry)
    }
    const rest = all.filter((entry) => !positioned.has(entry.id))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    return (orderedEntries = Object.freeze([...result, ...rest]))
  }
  /** A record's visit dates as recordValueOf gives them (the raw dates, else its verbatim V2 values). */
  const visitOf = (entry: LayerEntry): OfficialVisit => {
    const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
    const date = entry.fields.date
    const raw = plain(date) && plain(date.raw) ? date.raw : {}
    const v2 = plain(entry.extensions?.v2) ? entry.extensions.v2 : {}
    const value = (from: string, to: string) => (Object.hasOwn(raw, from) ? raw[from] : v2[to])
    return { entry, placeId: entry.entityId, planned: officialEntryRole(entry) === 'planned', start_date: value('startDate', 'start_date'), end_date: value('endDate', 'end_date') }
  }
  let visits: readonly OfficialVisit[] | undefined
  /** The first part-of relation (by id) to a place: the projection's partOf. */
  const parentOf = (id: string) => index.relationsFrom(id, OFFICIAL.partOf).find((relation) => isPlaceEntity(relation.toEntityId))?.toEntityId
  let ordered: readonly OfficialRecord[] | undefined
  const recordsInOrder = (): readonly OfficialRecord[] => {
    if (ordered) return ordered
    return (ordered = Object.freeze(entriesInOrder().map(recordOf)))
  }
  let added: readonly OfficialAddedCountry[] | undefined
  const addedCountriesOf = (): OfficialAddedCountry[] => {
    const containers: OfficialAddedCountry[] = []
    for (const evidence of index.evidenceOfSource(V2_SOURCES.countryVisit)) {
      if (!isPlaceEntity(evidence.recordId)) continue
      const visits = index.entriesOfEntity(evidence.recordId).filter((entry) => officialEntryRole(entry) === 'countryVisit' && entry.source.recordId === evidence.recordId)
      const visit = visits.at(-1)
      containers.push({ placeId: evidence.recordId, evidence, ...(visit ? { visit } : {}), value: addedCountryValueOf(evidence, visit) })
    }
    const at = new Map<string, ViewItem>()
    for (const item of index.viewItemsOf(VIEW_SCOPES.addedCountryOrder)) if (item.itemTable === 'entities' && !at.has(item.itemId)) at.set(item.itemId, item)
    return containers.sort((a, b) => {
      const x = at.get(a.placeId), y = at.get(b.placeId)
      if (x && y) return byPositionThenId(x, y)
      if (x || y) return x ? -1 : 1
      return a.evidence.id < b.evidence.id ? -1 : a.evidence.id > b.evidence.id ? 1 : 0
    })
  }

  return {
    index,
    place,
    isPlace: isPlaceEntity,
    // The place's subtype field (what place(id).subtype is), without building the place.
    subtypeOf: (id) => {
      const entity = index.get('entities', id) as StoreEntity | undefined
      const subtype = entity?.typeId === OFFICIAL.place ? entity.fields.subtype : undefined
      return subtype === 'country' || subtype === 'city' ? subtype : undefined
    },
    countries() {
      countryList ??= Object.freeze(inOfficialOrder(index.entitiesOfType(OFFICIAL.place)
        .filter((entity) => entity.fields.subtype === 'country').map((entity) => entity.id)))
      return countryList
    },
    citiesOf(countryId) {
      const ids = index.relationsTo(countryId, OFFICIAL.partOf).map((relation) => relation.fromEntityId)
        .filter((id) => place(id)?.subtype === 'city' && place(id)?.partOf === countryId)
      return Object.freeze(inOfficialOrder([...new Set(ids)]))
    },
    wish: (id) => wishIndex().byId.get(id),
    wishesOn: (placeId) => wishIndex().byPlace.get(placeId) ?? [],
    editorLists() {
      lists ??= editorListsOf(scopeAccess, isPlaceEntity, (id) => index.get('assets', id) !== undefined) as unknown as EditorLists
      return lists
    },
    scope: (scope) => ({ items: index.viewItemsOf(scope), settings: index.viewSettingsOf(scope) }),
    viewItem: (scope, table, id) => index.viewItemsOf(scope).filter((item) => item.itemTable === table && item.itemId === id)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0],
    viewSetting: (scope, key) => index.viewSettingsOf(scope).find((setting) => setting.key === key),
    isRecord,
    record: recordOf,
    recordsOn: (placeId) => index.entriesOfEntity(placeId).filter(isRecord).map(recordOf),
    recordById(id) {
      const found = [...index.entriesOfLayer(OFFICIAL.travel), ...index.entriesOfLayer(OFFICIAL.wantToGo)]
        .filter((entry) => isRecord(entry) && recordIdOf(entry) === id)
      if (found.length <= 1) return found.length ? recordOf(found[0]) : undefined
      const order = new Map(recordsInOrder().map((record, index_) => [record.entry.id, index_] as const))
      return recordOf(found.sort((a, b) => order.get(a.id)! - order.get(b.id)!)[0])
    },
    recordsInOrder,
    visitedTitled: (title) => index.entriesOfLayer(OFFICIAL.travel)
      .filter((entry) => entry.fields.tripTitle === title && isRecord(entry) && officialEntryRole(entry) === 'footprint').map(recordOf),
    visitsInOrder() {
      visits ??= Object.freeze(entriesInOrder().map(visitOf))
      return visits
    },
    countryOf(placeId) {
      const entity = index.get('entities', placeId) as StoreEntity | undefined
      if (entity?.typeId !== OFFICIAL.place) return undefined
      return entity.fields.subtype === 'country' ? placeId : parentOf(placeId)
    },
    journeyOfEntry: (entryId) => journeyIndex().byEntry.get(entryId),
    journey: (journeyId) => journeyIndex().byId.get(journeyId),
    journeyMembers: (journeyId) => (journeyIndex().members.get(journeyId) ?? []).map(recordOf),
    addedCountries() {
      added ??= Object.freeze(addedCountriesOf())
      return added
    },
  }
}
