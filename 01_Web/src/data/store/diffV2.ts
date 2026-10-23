/** V2 view before and after one V2 write -> the store commands of the records that changed (3C-4a, design 3B §4.4 and
 * §10 3C-4). The rules are not rewritten: a write in the new-library mode runs the existing V2 write function
 * (../v2write/) on the V2 view projected from the store, and this module turns the difference between the two views
 * into commands, record by record, with the mapping of the migration (./v2RecordRows.ts).
 *
 * What it compares, by record id:
 * - places (entity, location anchor, part-of relation);
 * - footprint and planned records (entries; a record that moves between the two layers, or to another place, is a new
 *   entry replacing the old one); `hiddenFromHome` (scope starmap:hidden/travel-home);
 * - want-to-go items (entries; `hidden` in scope starmap:hidden/want-to-go);
 * - added countries (evidence, which is immutable and so replaced, and the visit entry);
 * - journeys: the sequence of every journey a changed record left or joined, in the order routes are derived in;
 * - view state: the original-order scopes (places, records, want-to-go items, media, added countries), every editor and
 *   display list, the map scopes (city, media and drone order) and the settings (covers, display);
 * - file headers (generated_at, updatedAt, …): `v2:import`'s extensions, merged key by key.
 * Media items are 3C-4c: a difference in them is refused (E_DIFF_UNSUPPORTED).
 *
 * Order of the commands (the planner checks each command against the ones before it):
 *   1. view rows that go away (nothing refers to a view row, and removing them first frees their unique keys);
 *   2. creations and updates in dependency order: sources, place entities, anchors and relations, evidence, entries,
 *      journey entities, sequences, view rows;
 *   3. every other removal in reverse dependency order: sequences, journey entities, entries, evidence, anchors and
 *      relations, place entities (a sequence is updated before an entry it no longer lists is removed).
 *
 * Positions (3C-1b review: appending key after key exhausts the 64-character limit near 2,000 keys):
 * - an original-order scope keeps the position of every record that stays; a new record gets
 *   `positionBetween(neighbour before, neighbour after)` (appending: `positionBetween(last, undefined)`); a record that
 *   became a new entry keeps its row and position (the row is pointed at the new entry);
 * - a list (editor state, display) keeps the positions of the longest run of rows that are still in order and gives
 *   the others positions between their kept neighbours, so a drag updates only the rows whose position changes;
 * - when no key fits (E_POSITION), when a neighbour has no position, or when the records that stay changed their
 *   relative order, the whole scope is renumbered with listPositions in the same batch (`renumbered` lists it), and
 *   only rows whose position changes are written.
 *
 * Identity of the rows of a V2 record: entries by their source identity (findEntryByIdentity; `starmap:user` entries
 * by their id), places by id, anchors and relations through the place's references, evidence through its visit entry
 * or the `v2:country-visit:<place id>` id chain, journeys through the identity ledger (id_map) or a member's sequence.
 * New rows get fresh ids (UUIDv7 for entries, journey entities and view rows; the migration's id, or `#2`, `#3`, … when
 * that id is tombstoned, for anchors, relations, evidence and sequences). The ledger is read, never written: every row
 * keeps its identity in its own `source`.
 *
 * A view that does not match the store (a record without its entry, …) is E_VIEW_MISMATCH: the caller drops its cached
 * view and reads the store again.
 *
 * Pure: the reader is bound by the host to one read transaction; `now` and `allocateId` are injected.
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types).
 */
import type { FormalCommand, FormalRow, FormalTable, ViewItem, ViewItemTable, ViewSetting } from '../../worldgraph/store/formal.ts'
import { positionBetween } from '../../worldgraph/store/position.ts'
import { jsonKey, reject } from '../../worldgraph/store/primitives.ts'
import type { EntrySequence, Evidence, JsonObject, JsonValue, LayerEntry, SourceDefinition, StoreAnchor, StoreEntity, StoreRelation } from '../../worldgraph/store/types.ts'
import type { CanonicalPlace } from '../canonical/types.ts'
import { V2_FILE_KEYS, type V2Files, type V2TravelRecord } from '../canonical/v2Schema.ts'
import { DISPLAY_SETTING_KEYS, OFFICIAL, V2_SOURCES, VIEW_SCOPES, v2SourceDefinition } from './officialDefinitions.ts'
import {
  countryEvidence, countryEvidenceId, countryVisitEntry, journeyEntity, journeyOf, journeySequence, journeySequenceId, listPositions,
  orderedJourneyMembers, placeAnchor, placeAnchorId, placeEntity, placeRelation, placeRelationId, recordPlacement,
  travelRecordEntry, v2HeaderOf, viewItemRow, viewSettingRow, wantToGoEntry, type ViewTarget,
} from './v2RecordRows.ts'
import { positionsForRuns, viewListWriter, writeEditorLists } from './viewListRows.ts'
import { memoryScopeReader, type ScopeReader } from './scopeReader.ts'

/** Core's reader plus the one scan the diff needs: every view row of one scope (the host answers it from its scope index). */
export type DiffReader = ScopeReader
export interface DiffContext {
  /** The store at the revision the V2 view was projected from. */
  readonly reader: DiffReader
  /** The identity ledger (id_map): the formal id of a V2 record, or undefined. */
  readonly identity?: (kind: string, sourceId: string, recordId: string) => string | undefined
  /** UTC timestamp of the write: createdAt / updatedAt of new and changed entries. */
  readonly now: string
  /** Fresh lowercase UUIDv7 for new entries, journey entities and view rows. */
  readonly allocateId: () => string
}
export interface StoreDiff {
  readonly commands: readonly FormalCommand[]
  /** Scopes whose positions were renumbered in this batch. */
  readonly renumbered: readonly string[]
}

type Json = Record<string, JsonValue>
type V2WantToGoItem = V2Files['wantToGo']['items'][number]
type Phase = 'sources' | 'places' | 'placeParts' | 'evidence' | 'entries' | 'journeys' | 'sequences' | 'views'
const UPSERT_PHASES: readonly Phase[] = ['sources', 'places', 'placeParts', 'evidence', 'entries', 'journeys', 'sequences', 'views']
const REMOVAL_PHASES: readonly Phase[] = ['sequences', 'journeys', 'entries', 'evidence', 'placeParts', 'places']
/** Ids tried for a row that replaces a tombstoned one: the migration's id, then `#2`, `#3`, … */
const ID_CHAIN_LIMIT = 10_000

const mismatch = (path: string): never => reject('E_VIEW_MISMATCH', path)
const plain = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v)
const text = (value: unknown): string => JSON.stringify(value)
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const later = (a: string, b: string): string => (Date.parse(a) >= Date.parse(b) ? a : b)
const withoutRevision = (row: object): string => jsonKey({ ...row, revision: 0 })
const byId = <T extends { readonly id: string }>(rows: readonly T[]) => new Map(rows.map(row => [row.id, row] as const))
/** The journey id a journey entity projects to (projectStoreToCanonical). */
const projectedJourneyId = (entity: StoreEntity) => (entity.source.sourceId === V2_SOURCES.journey ? entity.source.recordId : entity.id)

/** The scope reader of a formal state (./scopeReader.ts). */
export const memoryDiffReader = memoryScopeReader

/** The commands that turn the store (whose V2 view is `before`) into the store whose V2 view is `after`. */
export function diffV2ToCommands(before: V2Files, after: V2Files, context: DiffContext): StoreDiff {
  const { reader, now, allocateId } = context
  const upserts = new Map<Phase, FormalCommand[]>(UPSERT_PHASES.map(phase => [phase, []]))
  const removals = new Map<Phase, FormalCommand[]>(REMOVAL_PHASES.map(phase => [phase, []]))
  const viewRemovals: FormalCommand[] = []
  const created = new Set<string>()
  const removedRows = new Set<string>()
  const renumbered: string[] = []
  const rowKey = (table: FormalTable, id: string) => `${table}\u0000${id}`

  const create = (phase: Phase, table: FormalTable, row: FormalRow) => {
    created.add(rowKey(table, row.id))
    upserts.get(phase)!.push({ op: 'create', table, value: row })
  }
  /** Update `current` to `desired` (revision ignored) when they differ. */
  const update = (phase: Phase, table: FormalTable, current: FormalRow, desired: FormalRow) => {
    if (withoutRevision(current) === withoutRevision(desired)) return
    upserts.get(phase)!.push({ op: 'update', table, id: current.id, expectedRevision: current.revision, value: { ...desired, id: current.id, revision: current.revision + 1 } as FormalRow })
  }
  const remove = (phase: Phase | 'view', table: FormalTable, row: FormalRow) => {
    const key = rowKey(table, row.id)
    if (removedRows.has(key)) return
    removedRows.add(key)
    const command: FormalCommand = { op: 'remove', table, id: row.id, expectedRevision: row.revision }
    if (phase === 'view') viewRemovals.push(command); else removals.get(phase)!.push(command)
  }
  const get = <T extends FormalRow>(table: FormalTable, id: string) => reader.get(table, id) as T | undefined
  /** The first id of the chain `base`, `base#2`, … that no row uses and no tombstone reserves. */
  const freshId = (table: FormalTable, base: string): string => {
    for (let n = 1; n <= ID_CHAIN_LIMIT; n++) {
      const id = n === 1 ? base : `${base}#${n}`
      if (!created.has(rowKey(table, id)) && !reader.get(table, id) && !reader.isTombstoned(table, id)) return id
    }
    return reject('E_ID_CHAIN', `${table}.id`)
  }
  /** The live row of the chain `base`, `base#2`, … that `matches`, or undefined (the chain ends at the first unused id). */
  const chainRow = <T extends FormalRow>(table: FormalTable, base: string, matches: (row: T) => boolean): T | undefined => {
    for (let n = 1; n <= ID_CHAIN_LIMIT; n++) {
      const id = n === 1 ? base : `${base}#${n}`
      const row = reader.get(table, id) as T | undefined
      if (row && matches(row)) return row
      if (!row && !reader.isTombstoned(table, id)) return undefined
    }
    return undefined
  }
  const newViewId = (scope: string) => `${scope}#${allocateId()}`
  const times = (): { createdAt: string; updatedAt: string } => ({ createdAt: now, updatedAt: now })
  /** An updated entry keeps createdAt; updatedAt never goes back (the planner's E_TIME). */
  const updateEntry = (current: LayerEntry, desired: LayerEntry) => {
    if (withoutRevision(current) === withoutRevision(desired)) return
    update('entries', 'entries', current, { ...desired, updatedAt: later(now, current.updatedAt) })
  }

  // --- Media is 3C-4c.
  if (before.media !== after.media && text(before.media.items) !== text(after.media.items)) reject('E_DIFF_UNSUPPORTED', 'media.items')

  // --- File headers: v2:import's extensions, merged key by key.
  const changedHeaders = V2_FILE_KEYS.filter(key => before[key] !== after[key] && text(v2HeaderOf(key, before[key])) !== text(v2HeaderOf(key, after[key])))
  if (changedHeaders.length) {
    const source = get<SourceDefinition>('sources', V2_SOURCES.import)
    const stored: Json = plain(source?.extensions?.v2) ? { ...source.extensions.v2 } : {}
    for (const key of changedHeaders) {
      const old = v2HeaderOf(key, before[key]), next = v2HeaderOf(key, after[key])
      const merged: Json = plain(stored[key]) ? { ...stored[key] } : {}
      for (const name of Object.keys(old)) if (!Object.hasOwn(next, name)) delete merged[name]
      Object.assign(merged, next)
      stored[key] = merged
    }
    if (source) update('sources', 'sources', source, { ...source, extensions: { ...source.extensions, v2: stored } as JsonObject })
    else create('sources', 'sources', v2SourceDefinition(V2_SOURCES.import, { v2: stored }))
  }

  // --- Places.
  const beforePlaces = byId(before.places.places), afterPlaces = byId(after.places.places)
  if (before.places !== after.places) {
    /** The location anchors and part-of relations of a place, first by id (as the projection picks them). */
    const partsOf = (placeId: string) => {
      const anchors: StoreAnchor[] = [], relations: StoreRelation[] = []
      for (const ref of reader.dependents('entities', placeId)) {
        if (ref.fromTable === 'anchors' && ref.field === 'entityId') {
          const anchor = get<StoreAnchor>('anchors', ref.fromId)
          if (anchor?.kind === 'location') anchors.push(anchor)
        } else if (ref.fromTable === 'relations' && ref.field === 'fromEntityId') {
          const relation = get<StoreRelation>('relations', ref.fromId)
          if (relation?.typeId === OFFICIAL.partOf) relations.push(relation)
        }
      }
      anchors.sort((a, b) => compare(a.id, b.id)); relations.sort((a, b) => compare(a.id, b.id))
      return { anchor: anchors[0], relation: relations[0] }
    }
    for (const id of beforePlaces.keys()) {
      if (afterPlaces.has(id)) continue
      const entity = get<StoreEntity>('entities', id) ?? mismatch('places')
      const { anchor, relation } = partsOf(id)
      if (anchor) remove('placeParts', 'anchors', anchor)
      if (relation) remove('placeParts', 'relations', relation)
      remove('places', 'entities', entity)
    }
    for (const [id, place] of afterPlaces) {
      const old = beforePlaces.get(id)
      if (!old) {
        create('places', 'entities', placeEntity(place))
        const anchor = placeAnchor(place, freshId('anchors', placeAnchorId(id)))
        if (anchor) create('placeParts', 'anchors', anchor)
        const relation = placeRelation(place, freshId('relations', placeRelationId(id)))
        if (relation) create('placeParts', 'relations', relation)
        continue
      }
      if (text(old) === text(place)) continue
      const entity = get<StoreEntity>('entities', id) ?? mismatch('places')
      // The source is the row's identity: a place the store-native writes created (starmap:user, 3C-5 C1) keeps its own.
      update('places', 'entities', entity, { ...placeEntity(place), source: entity.source })
      const parts = partsOf(id)
      placePart('anchors', parts.anchor, (rowId) => placeAnchor(place, rowId), placeAnchorId(id))
      placePart('relations', parts.relation, (rowId) => placeRelation(place, rowId), placeRelationId(id))
    }
  }
  function placePart<T extends StoreAnchor | StoreRelation>(table: 'anchors' | 'relations', current: T | undefined, desiredOf: (id: string) => T | undefined, base: string) {
    const desired = desiredOf(current?.id ?? freshId(table, base))
    if (current && desired) update('placeParts', table, current, { ...desired, source: current.source })
    else if (current) remove('placeParts', table, current)
    else if (desired) create('placeParts', table, desired)
  }

  // --- Entries of records and want-to-go items.
  /** The entry of a record or item in the store: its source identity, or (created as starmap:user) its id. */
  const findEntry = (placeId: string, layerId: string, sourceId: string, recordId: string, userFallback: boolean): LayerEntry | undefined => {
    const id = reader.findEntryByIdentity(placeId, layerId, sourceId, recordId)
    if (id !== undefined) return get<LayerEntry>('entries', id)
    if (!userFallback) return undefined
    const user = get<LayerEntry>('entries', recordId)
    return user && user.layerId === layerId && user.entityId === placeId && user.source.sourceId === OFFICIAL.user ? user : undefined
  }
  const recordEntryCache = new Map<string, LayerEntry>()
  const recordEntry = (record: V2TravelRecord): LayerEntry => {
    let entry = recordEntryCache.get(record.id)
    if (!entry) {
      const { planned, layerId, sourceId } = recordPlacement(record)
      entry = findEntry(record.placeId, layerId, sourceId, record.id, !planned) ?? mismatch('travel.records')
      recordEntryCache.set(record.id, entry)
    }
    return entry
  }
  /** Entry ids after the write, for records that got a new entry. */
  const newRecordEntry = new Map<string, string>()
  const afterRecordEntryId = (record: V2TravelRecord) => newRecordEntry.get(record.id) ?? recordEntry(beforeRecords.get(record.id) ?? record).id
  /** A flag scope (hidden from home, hidden want-to-go): the row of `oldEntryId` follows `newEntryId` with `flag`, or goes. */
  const flag = (scope: string, oldEntryId: string | undefined, newEntryId: string | undefined, value: boolean | undefined, layerId?: string) => {
    const rowId = oldEntryId === undefined ? undefined : reader.findViewItem(scope, 'entries', oldEntryId)
    const row = rowId === undefined ? undefined : get<ViewItem>('viewItems', rowId)
    if (row && (value === undefined || newEntryId === undefined)) { remove('view', 'viewItems', row); return }
    if (value === undefined || newEntryId === undefined) return
    const target = { table: 'entries' as const, id: newEntryId }
    if (row) update('views', 'viewItems', row, viewItemRow(scope, row.id, target, row.position, value, layerId))
    else create('views', 'viewItems', viewItemRow(scope, newViewId(scope), target, positionBetween(), value, layerId))
  }

  const beforeRecords = byId(before.travel.records), afterRecords = byId(after.travel.records)
  const touchedJourneys = new Set<string>()
  const touchJourney = (record: V2TravelRecord | undefined) => {
    const journeyId = record && journeyOf(record as unknown as Record<string, unknown>)
    if (journeyId !== undefined) touchedJourneys.add(journeyId)
  }
  if (before.travel !== after.travel && text(before.travel.records) !== text(after.travel.records)) {
    for (const [id, record] of beforeRecords) {
      if (afterRecords.has(id)) continue
      const entry = recordEntry(record)
      flag(VIEW_SCOPES.recordHiddenFromHome, entry.id, undefined, undefined)
      remove('entries', 'entries', entry)
      touchJourney(record)
    }
    for (const [id, record] of afterRecords) {
      const old = beforeRecords.get(id)
      if (old && text(old) === text(record)) continue
      touchJourney(old); touchJourney(record)
      if (!old) {
        const mapped = travelRecordEntry(record, allocateId(), times())
        newRecordEntry.set(id, mapped.entry.id)
        create('entries', 'entries', mapped.entry)
        flag(VIEW_SCOPES.recordHiddenFromHome, undefined, mapped.entry.id, mapped.hiddenFromHome)
        continue
      }
      const entry = recordEntry(old)
      const was = recordPlacement(old), is = recordPlacement(record)
      if (was.layerId !== is.layerId || was.sourceId !== is.sourceId || old.placeId !== record.placeId) {
        // Layer, source and place are the entry's identity: a new entry replaces it.
        const mapped = travelRecordEntry(record, allocateId(), times())
        newRecordEntry.set(id, mapped.entry.id)
        create('entries', 'entries', mapped.entry)
        flag(VIEW_SCOPES.recordHiddenFromHome, entry.id, mapped.entry.id, mapped.hiddenFromHome)
        remove('entries', 'entries', entry)
        continue
      }
      const mapped = travelRecordEntry(record, entry.id, { createdAt: entry.createdAt, updatedAt: entry.updatedAt })
      // The source is the entry's identity (a starmap:user entry keeps its own).
      updateEntry(entry, { ...mapped.entry, source: entry.source })
      flag(VIEW_SCOPES.recordHiddenFromHome, entry.id, entry.id, mapped.hiddenFromHome)
    }
  }

  const beforeWishes = byId(before.wantToGo.items), afterWishes = byId(after.wantToGo.items)
  const wishEntryCache = new Map<string, LayerEntry>()
  const wishEntry = (item: V2WantToGoItem): LayerEntry => {
    let entry = wishEntryCache.get(item.id)
    if (!entry) {
      entry = findEntry(item.placeId, OFFICIAL.wantToGo, V2_SOURCES.wantToGo, item.id, true) ?? mismatch('wantToGo.items')
      wishEntryCache.set(item.id, entry)
    }
    return entry
  }
  const newWishEntry = new Map<string, string>()
  if (before.wantToGo !== after.wantToGo && text(before.wantToGo.items) !== text(after.wantToGo.items)) {
    for (const [id, item] of beforeWishes) {
      if (afterWishes.has(id)) continue
      const entry = wishEntry(item)
      flag(VIEW_SCOPES.wantToGoHidden, entry.id, undefined, undefined)
      remove('entries', 'entries', entry)
    }
    for (const [id, item] of afterWishes) {
      const old = beforeWishes.get(id)
      if (old && text(old) === text(item)) continue
      const hiddenFlag = (mapped: { hidden: boolean }) => (mapped.hidden ? true : undefined)
      if (!old || old.placeId !== item.placeId) {
        const mapped = wantToGoEntry(item, allocateId(), times())
        newWishEntry.set(id, mapped.entry.id)
        create('entries', 'entries', mapped.entry)
        const previous = old ? wishEntry(old) : undefined
        if (previous) remove('entries', 'entries', previous)
        flag(VIEW_SCOPES.wantToGoHidden, previous?.id, mapped.entry.id, hiddenFlag(mapped), OFFICIAL.wantToGo)
        continue
      }
      const entry = wishEntry(old)
      const mapped = wantToGoEntry(item, entry.id, { createdAt: entry.createdAt, updatedAt: entry.updatedAt })
      updateEntry(entry, { ...mapped.entry, source: entry.source })
      flag(VIEW_SCOPES.wantToGoHidden, entry.id, entry.id, hiddenFlag(mapped), OFFICIAL.wantToGo)
    }
  }

  // --- Added countries: evidence (immutable: replaced when it changes) and the visit entry.
  const beforeCountries = new Map(before.editorState.addedCountries.map(c => [c.placeId, c] as const))
  const afterCountries = new Map(after.editorState.addedCountries.map(c => [c.placeId, c] as const))
  if (before.editorState !== after.editorState && text(before.editorState.addedCountries) !== text(after.editorState.addedCountries)) {
    const visitOf = (placeId: string) => findEntry(placeId, OFFICIAL.travel, V2_SOURCES.countryVisit, placeId, false)
    const evidenceOf = (placeId: string, visit: LayerEntry | undefined): Evidence => {
      const matches = (row: Evidence) => row.sourceId === V2_SOURCES.countryVisit && row.recordId === placeId
      for (const id of visit?.source.evidenceIds ?? []) {
        const row = get<Evidence>('evidence', id)
        if (row && matches(row)) return row
      }
      return chainRow<Evidence>('evidence', countryEvidenceId(placeId), matches) ?? mismatch('editorState.addedCountries')
    }
    for (const placeId of beforeCountries.keys()) {
      if (afterCountries.has(placeId)) continue
      const visit = visitOf(placeId)
      const evidence = evidenceOf(placeId, visit)
      if (visit) remove('entries', 'entries', visit)
      remove('evidence', 'evidence', evidence)
    }
    for (const [placeId, country] of afterCountries) {
      const old = beforeCountries.get(placeId)
      if (old && text(old) === text(country)) continue
      const visit = old ? visitOf(placeId) : undefined
      const current = old ? evidenceOf(placeId, visit) : undefined
      let evidenceId = current?.id
      if (!current || withoutRevision(current) !== withoutRevision(countryEvidence(country, current.id))) {
        evidenceId = freshId('evidence', countryEvidenceId(placeId))
        create('evidence', 'evidence', countryEvidence(country, evidenceId))
        if (current) remove('evidence', 'evidence', current)
      }
      const desired = countryVisitEntry(country, visit?.id ?? allocateId(), evidenceId!, visit ? { createdAt: visit.createdAt, updatedAt: visit.updatedAt } : times())
      if (visit && desired) updateEntry(visit, desired)
      else if (visit) remove('entries', 'entries', visit)
      else if (desired) create('entries', 'entries', desired)
    }
  }

  // --- Journeys a changed record left or joined.
  for (const journeyId of [...touchedJourneys].sort(compare)) {
    const members = (records: readonly V2TravelRecord[]) => records.filter(r => journeyOf(r as unknown as Record<string, unknown>) === journeyId)
    const beforeMembers = members(before.travel.records), afterMembers = members(after.travel.records)
    const current = beforeMembers.length ? findJourney(journeyId, beforeMembers) : undefined
    if (!afterMembers.length) {
      if (current) {
        for (const sequence of current.sequences) remove('sequences', 'sequences', sequence)
        remove('journeys', 'entities', current.entity)
      }
      continue
    }
    const entryIds = orderedJourneyMembers(afterMembers).map(afterRecordEntryId)
    if (!current) {
      const entityId = allocateId()
      create('journeys', 'entities', journeyEntity(journeyId, entityId))
      create('sequences', 'sequences', journeySequence(journeyId, entityId, entryIds, freshId('sequences', journeySequenceId(entityId))))
      continue
    }
    const [sequence] = current.sequences
    if (sequence) update('sequences', 'sequences', sequence, { ...sequence, entryIds: [...entryIds] })
    else create('sequences', 'sequences', journeySequence(journeyId, current.entity.id, entryIds, freshId('sequences', journeySequenceId(current.entity.id))))
  }
  function findJourney(journeyId: string, beforeMembers: readonly V2TravelRecord[]): { entity: StoreEntity; sequences: EntrySequence[] } {
    const isJourney = (entity: StoreEntity | undefined): entity is StoreEntity => entity?.typeId === OFFICIAL.journey && projectedJourneyId(entity) === journeyId
    const ledger = context.identity?.('journey', V2_SOURCES.journey, journeyId)
    let entity = ledger === undefined ? undefined : get<StoreEntity>('entities', ledger)
    if (!isJourney(entity)) {
      entity = undefined
      search: for (const record of beforeMembers) {
        for (const ref of reader.dependents('entries', recordEntry(record).id)) {
          if (ref.fromTable !== 'sequences') continue
          const owner = get<StoreEntity>('entities', get<EntrySequence>('sequences', ref.fromId)?.entityId ?? '')
          if (isJourney(owner)) { entity = owner; break search }
        }
      }
    }
    if (!entity) {
      const own = get<StoreEntity>('entities', journeyId)
      if (isJourney(own)) entity = own
    }
    if (!entity) return mismatch('travel.records.journeyId')
    const sequences = reader.dependents('entities', entity.id).filter(ref => ref.fromTable === 'sequences' && ref.field === 'entityId')
      .map(ref => get<EntrySequence>('sequences', ref.fromId)!).filter(Boolean).sort((a, b) => compare(a.id, b.id))
    return { entity, sequences }
  }

  // --- View state.
  const placeIn = (places: ReadonlyMap<string, CanonicalPlace>) => (id: unknown): ViewTarget | undefined =>
    (typeof id === 'string' && places.has(id) ? { table: 'entities', id } : undefined)
  const mediaIds = new Set(after.media.items.map(m => m.id))
  const mediaTarget = (id: unknown): ViewTarget | undefined => (typeof id === 'string' && mediaIds.has(id) ? { table: 'assets', id } : undefined)
  const beforePlace = placeIn(beforePlaces), afterPlace = placeIn(afterPlaces)
  // The lists' rows (./viewListRows.ts, shared with the store-native view operations).
  const lists = viewListWriter({
    viewScope: (scope) => reader.viewScope(scope),
    setting: (scope, key) => {
      const id = reader.findViewSetting(scope, key)
      return id === undefined ? undefined : get<ViewSetting>('viewSettings', id)
    },
  }, {
    create: (table, row) => create('views', table, row),
    update: (table, current, desired) => update('views', table, current, desired),
    remove: (table, row) => remove('view', table, row),
    removes: (table, id) => removedRows.has(rowKey(table, id)),
    newRowId: newViewId,
    settingId: (scope, key) => freshId('viewSettings', `${scope}#${key}`),
    renumbered: (scope) => { renumbered.push(scope) },
  })
  const { listScope } = lists

  /**
   * An original-order scope: one row per record, keyed by the record's V2 id. Records that stay keep their rows and
   * positions (a replaced entry's row is pointed at the new entry); new ones get positions between their neighbours.
   */
  function orderScope(scope: string, beforeKeys: readonly string[], afterKeys: readonly string[], targets: {
    readonly table: ViewItemTable
    readonly before: (key: string) => string
    readonly after: (key: string) => string
    /** Keys that stay but point at a new row (a replaced entry). Every other key keeps its target. */
    readonly retargeted?: ReadonlySet<string>
  }, layerId?: string) {
    const beforeSet = new Set(beforeKeys), afterSet = new Set(afterKeys)
    const retargeted = (key: string) => targets.retargeted?.has(key) === true
    const sameKeys = beforeKeys.length === afterKeys.length && beforeKeys.every((key, i) => key === afterKeys[i])
    if (sameKeys && !afterKeys.some(key => retargeted(key))) return
    const itemOf = (key: string): ViewItem | undefined => {
      const id = reader.findViewItem(scope, targets.table, targets.before(key))
      return id === undefined ? undefined : get<ViewItem>('viewItems', id)
    }
    const desiredRow = (row: ViewItem, key: string, position: string) => viewItemRow(scope, row.id, { table: targets.table, id: targets.after(key) }, position, row.hidden, layerId ?? row.layerId)
    // Rows of records that went away (when their target stays, as for an added country, the cascade would not).
    for (const key of beforeKeys) {
      if (afterSet.has(key)) continue
      const row = itemOf(key)
      if (row) remove('view', 'viewItems', row)
    }
    const retainedBefore = beforeKeys.filter(key => afterSet.has(key)), retainedAfter = afterKeys.filter(key => beforeSet.has(key))
    let positions: Map<number, string> | undefined
    const keptRows = new Map<number, ViewItem>()
    if (retainedBefore.every((key, i) => key === retainedAfter[i])) {
      const kept = (i: number) => beforeSet.has(afterKeys[i])
      positions = positionsForRuns(afterKeys.length, kept, (i) => {
        const row = keptRows.get(i) ?? itemOf(afterKeys[i])
        if (row) keptRows.set(i, row)
        return row?.position ?? null
      })
      // A retargeted record keeps its row: it must exist.
      if (positions) for (let i = 0; i < afterKeys.length; i++) {
        if (!retargeted(afterKeys[i])) continue
        const row = keptRows.get(i) ?? itemOf(afterKeys[i])
        if (!row) { positions = undefined; break }
        keptRows.set(i, row)
      }
    }
    if (!positions) {
      // Renumber: every row of the scope, in the new order.
      renumbered.push(scope)
      const rows = new Map(reader.viewScope(scope).items.filter(row => row.itemTable === targets.table).map(row => [row.itemId, row] as const))
      const numbers = listPositions(afterKeys.length), seen = new Set<string>()
      afterKeys.forEach((key, i) => {
        const row = beforeSet.has(key) ? rows.get(targets.before(key)) : undefined
        if (row) { seen.add(row.id); update('views', 'viewItems', row, desiredRow(row, key, numbers[i])) }
        else create('views', 'viewItems', viewItemRow(scope, newViewId(scope), { table: targets.table, id: targets.after(key) }, numbers[i], false, layerId))
      })
      for (const row of rows.values()) if (!seen.has(row.id) && !removedRows.has(rowKey('viewItems', row.id))) remove('view', 'viewItems', row)
      return
    }
    afterKeys.forEach((key, i) => {
      const position = positions!.get(i)
      if (position !== undefined) { create('views', 'viewItems', viewItemRow(scope, newViewId(scope), { table: targets.table, id: targets.after(key) }, position, false, layerId)); return }
      const row = keptRows.get(i)
      if (row && retargeted(key)) update('views', 'viewItems', row, desiredRow(row, key, row.position))
    })
  }

  /** One display setting with a value (overviewTarget, regionIncludes). */
  function valueSetting(key: string, beforeValue: unknown, afterValue: unknown) {
    if (text(beforeValue) === text(afterValue)) return
    const scope = VIEW_SCOPES.display
    const id = reader.findViewSetting(scope, key)
    const existing = id === undefined ? undefined : get<ViewSetting>('viewSettings', id)
    if (afterValue === undefined) { if (existing) remove('view', 'viewSettings', existing); return }
    const desired = viewSettingRow(scope, existing?.id ?? freshId('viewSettings', `${scope}#${key}`), key, { value: afterValue as JsonValue })
    if (existing) update('views', 'viewSettings', existing, desired); else create('views', 'viewSettings', desired)
  }

  const S = VIEW_SCOPES
  const identityTargets = (table: ViewItemTable) => ({ table, before: (key: string) => key, after: (key: string) => key })
  if (before.places !== after.places) orderScope(S.placeOrder, before.places.places.map(p => p.id), after.places.places.map(p => p.id), identityTargets('entities'))
  if (before.travel !== after.travel) {
    orderScope(S.recordOrder, before.travel.records.map(r => r.id), after.travel.records.map(r => r.id), {
      table: 'entries',
      before: (key) => recordEntry(beforeRecords.get(key)!).id,
      after: (key) => newRecordEntry.get(key) ?? recordEntry(beforeRecords.get(key)!).id,
      retargeted: new Set([...newRecordEntry.keys()].filter(key => beforeRecords.has(key))),
    })
    const d0 = before.travel.display, d1 = after.travel.display
    listScope(S.homeHiddenCountries, d0.homeHiddenCountryIds, d1.homeHiddenCountryIds, beforePlace, afterPlace, true)
    listScope(S.originCountries, d0.originCountryIds, d1.originCountryIds, beforePlace, afterPlace, false)
    listScope(S.regionCountries, d0.regionCountryIds, d1.regionCountryIds, beforePlace, afterPlace, false)
    listScope(S.navigationHiddenCities, d0.navigationHiddenCityIds, d1.navigationHiddenCityIds, beforePlace, afterPlace, true)
    valueSetting(DISPLAY_SETTING_KEYS.overviewTarget, d0.overviewTarget, d1.overviewTarget)
    valueSetting(DISPLAY_SETTING_KEYS.regionIncludes, d0.regionIncludes, d1.regionIncludes)
  }
  if (before.wantToGo !== after.wantToGo) {
    orderScope(S.wantToGoOrder, before.wantToGo.items.map(i => i.id), after.wantToGo.items.map(i => i.id), {
      table: 'entries',
      before: (key) => wishEntry(beforeWishes.get(key)!).id,
      after: (key) => newWishEntry.get(key) ?? wishEntry(beforeWishes.get(key)!).id,
      retargeted: new Set([...newWishEntry.keys()].filter(key => beforeWishes.has(key))),
    }, OFFICIAL.wantToGo)
  }
  if (before.editorState !== after.editorState) {
    const e0 = before.editorState, e1 = after.editorState
    orderScope(S.addedCountryOrder, e0.addedCountries.map(c => c.placeId), e1.addedCountries.map(c => c.placeId), identityTargets('entities'))
    writeEditorLists(lists, e0, e1, { before: beforePlace, after: afterPlace }, mediaTarget)
  }

  const commands = [
    ...viewRemovals,
    ...UPSERT_PHASES.flatMap(phase => upserts.get(phase)!),
    ...REMOVAL_PHASES.flatMap(phase => removals.get(phase)!),
  ]
  return Object.freeze({ commands: Object.freeze(commands), renumbered: Object.freeze(renumbered) })
}

/** Moved to ./viewListRows.ts (3C-5 C1); re-exported for the 3C-4a tests. */
export { longestIncreasing, positionsForRuns } from './viewListRows.ts'
