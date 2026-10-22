/**
 * Travel records, journeys, added countries and the country order in the store-native writes (3C-5 C2, design 3C-5 §3).
 * The decisions are ../rules/ (the same as the V2 write functions'); this module writes their rows:
 *
 * - A new visited record: a `starmap:travel` entry (`date.raw` with startDate, endDate and year; the trip title), its
 *   recordOrder row at the end; no V2-only value (design §9 change 2: no `type`, `status` or `source`).
 * - Journeys: joining one updates the first sequence of its entity (its members in route order, compareJourneyRecords);
 *   a new one is a `starmap:journey` entity and a sequence, both `starmap:user` rows whose journey id is the entity id
 *   (design §9 change 1: no `journey-` prefix).
 * - Added countries: the evidence (`v2:country-visit`, the country as record id, the region) and the visit entry (same
 *   source, the date) — the identity the official view reads added countries by — and the addedCountryOrder row.
 * - The country order by latest visit (../rules/footprint.ts), written with the list algorithm (only rows that move).
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types).
 */
import type { Evidence, EntrySequence, JsonValue, LayerEntry, StoreEntity } from '../../../worldgraph/store/types.ts'
import { compareJourneyRecords } from '../../canonical/journeyRoutes.ts'
import type { CanonicalPlace, PlaceId } from '../../canonical/types.ts'
import { OFFICIAL, V2_SOURCES, VIEW_SCOPES } from '../../store/officialDefinitions.ts'
import type { OfficialReader, OfficialRecord } from '../../store/officialReader.ts'
import { countryEvidence, countryVisitEntry, journeyEntity, journeySequence, type ViewTarget } from '../../store/v2RecordRows.ts'
import { viewListWriter } from '../../store/viewListRows.ts'
import { sameOrder, sortCountryIdsByLatestVisit, type CountryVisit } from '../rules/footprint.ts'
import { findJourneyCandidates, type JourneyCandidate, type JourneyRecord } from '../rules/journeys.ts'
import { viewListAccess, type CommandBatch } from './batch.ts'
import { appendToOriginalOrder } from './originalOrder.ts'
import { referencesOf, rowOf, userSource } from './places.ts'

const S = VIEW_SCOPES

/** Every record entry, for the recordOrder scope (without a row: by creation time and id). */
export const recordKeys = (reader: OfficialReader) => () =>
  [...reader.index.entriesOfLayer(OFFICIAL.travel), ...reader.index.entriesOfLayer(OFFICIAL.wantToGo)].filter(reader.isRecord)
    .map((entry) => ({ id: entry.id, after: [entry.createdAt, entry.id] as const }))

/** The visit dates of a record: `date.raw` with startDate, endDate (when given) and the year. */
export const rawVisitDates = (dates: { readonly start: string; readonly end?: string }): Record<string, JsonValue> =>
  ({ startDate: dates.start, ...(dates.end ? { endDate: dates.end } : {}), year: Number(dates.start.slice(0, 4)) })

/** A new visited record's entry (see the file header). */
export function travelEntry(entryId: string, placeId: PlaceId, dates: { readonly start: string; readonly end?: string }, tripTitle: string, now: string): LayerEntry {
  return {
    id: entryId, revision: 0, layerId: OFFICIAL.travel, entityId: placeId, fields: { date: { raw: rawVisitDates(dates) }, tripTitle },
    source: userSource(entryId), createdAt: now, updatedAt: now,
  } satisfies LayerEntry
}

/** A new record's recordOrder row, at the end. */
export const appendRecord = (reader: OfficialReader, batch: CommandBatch, entryId: string, newId: () => string) =>
  appendToOriginalOrder(reader, batch, newId, { scope: S.recordOrder, table: 'entries', keys: recordKeys(reader), added: [entryId] })

/** The country a record counts for (V2's countryIdOfPlace): a country itself, any other place's part-of. */
export const countryOfPlace = (place: CanonicalPlace | undefined): PlaceId | undefined =>
  (!place ? undefined : place.subtype === 'country' ? place.id : place.partOf)

/** Is a country in the footprint: a visited record counts for it, or it is an added country. */
export function countryInFootprint(reader: OfficialReader, countryId: PlaceId): boolean {
  if (reader.addedCountries().some((country) => country.placeId === countryId)) return true
  const visitedOn = (placeId: PlaceId) => reader.recordsOn(placeId).some((record) => !record.planned)
  if (reader.place(countryId)?.subtype === 'country' && visitedOn(countryId)) return true
  return reader.index.relationsTo(countryId, OFFICIAL.partOf)
    .some((relation) => { const place = reader.place(relation.fromEntityId); return place?.subtype !== 'country' && place?.partOf === countryId && visitedOn(place.id) })
}

// ---------------------------------------------------------------------------
// Journeys
// ---------------------------------------------------------------------------

/** The V2 record value, as the journey rules read it. */
const journeyRecord = (record: OfficialRecord): JourneyRecord => record.record as unknown as JourneyRecord

/**
 * The candidates of a trip title (../rules/journeys.ts): the titled visited records and every member of their journeys.
 * A journey id that is no sequence's (a blank id kept as a V2 value) has its members found among all the records.
 */
export function journeyCandidates(reader: OfficialReader, tripTitle: string | undefined): JourneyCandidate[] {
  if (!tripTitle) return []
  const titled = reader.visitedTitled(tripTitle)
  const journeyIds = [...new Set(titled.map((record) => record.record.journeyId).filter((id): id is string => typeof id === 'string' && id !== ''))]
  const members = journeyIds.flatMap((journeyId) => (reader.journey(journeyId)
    ? reader.journeyMembers(journeyId)
    : reader.recordsInOrder().filter((record) => !record.planned && record.record.journeyId === journeyId)))
  return findJourneyCandidates([...titled, ...members].map(journeyRecord), tripTitle, (placeId) => reader.place(placeId)?.names)
}

/** A record joining a journey: its entry, V2 id and start date (route order). */
export interface JourneyMember { readonly entryId: string; readonly id: string; readonly start_date?: unknown }

const routeOrder = (members: readonly JourneyMember[]) =>
  [...members].sort((a, b) => compareJourneyRecords(a as { id: string; start_date?: string }, b as { id: string; start_date?: string })).map((member) => member.entryId)

/**
 * The journey rows of a record that becomes visited:
 * - `{ join }`: the journey's first sequence lists its members and the record in route order (a new sequence when it has none);
 * - `{ new: true }`: a new journey entity and sequence (`starmap:user`);
 * - `{ prescribed }`: a journey id the record already has (a planned record's V2 value): that journey when it exists,
 *   otherwise a journey entity and sequence with that id as their `v2:journey` record (as the old path wrote them).
 */
export function writeJourney(reader: OfficialReader, batch: CommandBatch, decided: { readonly join: string } | { readonly new: true } | { readonly prescribed: string },
  member: JourneyMember, newId: () => string): void {
  const existing = 'join' in decided ? reader.journey(decided.join) : 'prescribed' in decided ? reader.journey(decided.prescribed) : undefined
  if (existing) {
    const members = reader.journeyMembers(existing.journeyId).map((record) => ({ entryId: record.entry.id, id: record.record.id, start_date: record.record.start_date }))
    const entryIds = routeOrder([...members, member])
    const [sequence] = existing.sequences
    if (sequence) batch.update('sequences', sequence, { ...sequence, entryIds } satisfies EntrySequence)
    else {
      const id = newId()
      batch.create('sequences', { ...journeySequence(existing.journeyId, existing.entity.id, entryIds, id), source: userSource(id) } satisfies EntrySequence)
    }
    return
  }
  if ('prescribed' in decided) {
    const entityId = newId()
    batch.create('entities', journeyEntity(decided.prescribed, entityId))
    batch.create('sequences', journeySequence(decided.prescribed, entityId, [member.entryId], newId()))
    return
  }
  const entityId = newId(), sequenceId = newId()
  batch.create('entities', { ...journeyEntity(entityId, entityId), source: userSource(entityId) } satisfies StoreEntity)
  batch.create('sequences', { ...journeySequence(entityId, entityId, [member.entryId], sequenceId), source: userSource(sequenceId) } satisfies EntrySequence)
}

// ---------------------------------------------------------------------------
// Added countries
// ---------------------------------------------------------------------------

/** An added country's rows: its evidence (region), the visit entry (date) and its addedCountryOrder row at the end. */
export function addCountryVisit(reader: OfficialReader, batch: CommandBatch, country: { placeId: PlaceId; region?: string; visitedDate: string }, now: string, newId: () => string): void {
  const value = { placeId: country.placeId, ...(country.region ? { region: country.region } : {}), visitedDate: country.visitedDate }
  const evidence = countryEvidence(value, newId())
  batch.create('evidence', evidence satisfies Evidence)
  batch.create('entries', countryVisitEntry(value, newId(), evidence.id, { createdAt: now, updatedAt: now })!)
  appendToOriginalOrder(reader, batch, newId, {
    scope: S.addedCountryOrder, table: 'entities', added: [country.placeId],
    keys: () => reader.addedCountries().map((added) => ({ id: added.placeId, after: ['', added.evidence.id] as const })),
  })
}

/** The rows of an added country that goes: the visit entry and the evidence (the addedCountryOrder row follows them). */
export function removeCountryVisit(reader: OfficialReader, batch: CommandBatch, placeId: PlaceId): void {
  for (const added of reader.addedCountries()) {
    if (added.placeId !== placeId) continue
    for (const item of reader.index.viewItemsOf(S.addedCountryOrder)) if (item.itemTable === 'entities' && item.itemId === placeId) batch.remove('viewItems', item)
    if (added.visit) batch.remove('entries', added.visit)
    batch.remove('evidence', added.evidence)
  }
}

/** True when an evidence row is an added country's (the source the official view reads them by). */
export const isCountryVisitEvidence = (evidence: Evidence) => evidence.sourceId === V2_SOURCES.countryVisit

// ---------------------------------------------------------------------------
// The country order
// ---------------------------------------------------------------------------

/**
 * The countryOrder list after a write, by latest visit (../rules/footprint.ts), written with the list algorithm. `change`
 * says what the write did: visited records added (at the end of the records) or removed, added countries added (at the end)
 * or removed. `isPlace` and `placeOf` see the places the write creates.
 */
export function reorderCountries(reader: OfficialReader, batch: CommandBatch, newId: () => string, change: {
  readonly visits?: readonly CountryVisit[]
  readonly removedEntries?: ReadonlySet<string>
  readonly added?: readonly { readonly placeId: PlaceId; readonly visitedDate?: string }[]
  readonly removedAdded?: ReadonlySet<PlaceId>
  readonly countryOrder?: readonly string[]
  readonly placeOf?: (placeId: PlaceId) => CanonicalPlace | undefined
  readonly isPlace?: (placeId: PlaceId) => boolean
}): void {
  const placeOf = change.placeOf ?? ((placeId: PlaceId) => reader.place(placeId))
  const before = reader.editorLists().countryOrder as string[]
  const order = change.countryOrder ?? before
  const visits: CountryVisit[] = reader.recordsInOrder()
    .filter((record) => !record.planned && !change.removedEntries?.has(record.entry.id))
    .map((record) => ({ countryId: countryOfPlace(placeOf(record.record.placeId)), start_date: record.record.start_date, end_date: record.record.end_date }))
  visits.push(...(change.visits ?? []))
  const added = [
    ...reader.addedCountries().filter((country) => !change.removedAdded?.has(country.placeId)).map((country) => country.value as { placeId: PlaceId; visitedDate?: unknown }),
    ...(change.added ?? []),
  ]
  const after = sortCountryIdsByLatestVisit({ countryOrder: order, visits, added })
  if (sameOrder(after, before)) return
  const isPlace = change.isPlace ?? ((placeId: PlaceId) => reader.isPlace(placeId))
  const place = (id: unknown): ViewTarget | undefined => (typeof id === 'string' && isPlace(id) ? { table: 'entities', id } : undefined)
  const { rows, sink } = viewListAccess(reader, batch, newId)
  viewListWriter(rows, sink).listScope(S.countryOrder, before, after, place, place, false)
}

/**
 * Records that go (a country deleted, a planned record converted): their journeys first — the first sequence of a journey
 * keeps its other members in route order; a journey left without members goes with its sequences — then each record's view
 * rows and entry.
 */
export function removeRecords(reader: OfficialReader, batch: CommandBatch, records: readonly OfficialRecord[], newId: () => string): void {
  const removed = new Set(records.map((record) => record.entry.id))
  const touched = new Set<string>()
  for (const record of records) {
    const journey = reader.journeyOfEntry(record.entry.id)
    if (journey) touched.add(journey.journeyId)
  }
  for (const journeyId of [...touched].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const journey = reader.journey(journeyId)!
    const left = reader.journeyMembers(journeyId).filter((member) => !removed.has(member.entry.id))
    if (!left.length) {
      for (const sequence of journey.sequences) batch.remove('sequences', sequence)
      batch.remove('entities', journey.entity)
      continue
    }
    const entryIds = routeOrder(left.map((member) => ({ entryId: member.entry.id, id: member.record.id, start_date: member.record.start_date })))
    const [sequence] = journey.sequences
    if (sequence) batch.update('sequences', sequence, { ...sequence, entryIds } satisfies EntrySequence)
    else {
      const id = newId()
      batch.create('sequences', { ...journeySequence(journeyId, journey.entity.id, entryIds, id), source: userSource(id) } satisfies EntrySequence)
    }
  }
  const references = referencesOf(reader)
  for (const record of records) {
    for (const ref of references('entries', record.entry.id)) {
      if (ref.fromTable === 'viewItems' || ref.fromTable === 'viewSettings') batch.remove(ref.fromTable, rowOf(reader, ref.fromTable, ref.fromId))
    }
    batch.remove('entries', record.entry)
  }
}
