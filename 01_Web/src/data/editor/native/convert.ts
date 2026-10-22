/**
 * `POST /wanttogo/convert` as a store-native write (3C-5 C2, design 3C-5 §3). The decisions are ../rules/ (the same as the
 * V2 write function of ../../v2write/convert.ts) in its order: the source, the conversion rules (convertRules), the dates,
 * then the journey.
 *
 * - A want-to-go item → a new visited record on its city (a `starmap:user` travel entry, its journey); the item goes unless
 *   `keepWantToGo` (its place stays: the record uses it). When the country first enters the footprint: an added country
 *   with the catalog's region (when there is no country information yet) and the country order.
 * - A planned record → the same record, visited (D5): its planned entry goes and a travel entry replaces it with the source
 *   identity `(v2:travel, the record's id)`, so the record keeps its V2 id (a page's selection stays) and its verbatim V2
 *   values; its recordOrder and hidden-from-home rows point at the new entry. The new entry has a new id (the planned
 *   entry's id is tombstoned). A journey id the planned record already has is kept (a journey with that id, or a new one
 *   under it, as the old path wrote it); otherwise the journey is chosen as for a new record.
 * The response is the V2 function's.
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types).
 */
import type { ViewItem } from '../../../worldgraph/store/formal.ts'
import type { JsonValue, LayerEntry } from '../../../worldgraph/store/types.ts'
import type { PlaceId } from '../../canonical/types.ts'
import type { V2TravelRecord } from '../../canonical/v2Schema.ts'
import { VIEW_SCOPES } from '../../store/officialDefinitions.ts'
import type { OfficialReader } from '../../store/officialReader.ts'
import { recordValueOf } from '../../store/projectCanonical.ts'
import { travelRecordEntry, viewItemRow } from '../../store/v2RecordRows.ts'
import { fail } from '../../v2write/errors.ts'
import { convertRulesOf, type ConvertRuleRecord } from '../rules/convertRules.ts'
import { convertDates, convertTripTitle, defaultTripTitle, firstVisitRegion, parseConvertRequest, type ConvertRequest } from '../rules/footprint.ts'
import { decideJourney } from '../rules/journeys.ts'
import { commandBatch, type CommandBatch } from './batch.ts'
import { referencesOf, rowOf } from './places.ts'
import { addCountryVisit, appendRecord, countryInFootprint, countryOfPlace, journeyCandidates, reorderCountries, travelEntry, writeJourney } from './records.ts'
import type { NativeWrite, NativeWriteContext } from './routes.ts'

const S = VIEW_SCOPES

/** The conversion rules over the official reader (the four questions of ../rules/convertRules.ts). */
const rulesOf = (reader: OfficialReader) => convertRulesOf({
  place: (id) => reader.place(id),
  item: (id) => {
    const wish = reader.wish(id)
    return wish ? { id, placeId: wish.item.placeId, hidden: wish.item.hidden } : undefined
  },
  record: (id) => reader.recordById(id)?.record as ConvertRuleRecord | undefined,
  hasRecordsOn: (placeId) => reader.recordsOn(placeId).length > 0,
})

/** Is a country in the footprint (a country id the city may lack: V2's rule for an undefined country). */
const inFootprint = (reader: OfficialReader, countryId: PlaceId | undefined) => (countryId !== undefined
  ? countryInFootprint(reader, countryId)
  : reader.recordsInOrder().some((record) => !record.planned && countryOfPlace(reader.place(record.record.placeId)) === undefined))

/** Remove an entry with every view row that points at it. */
function removeWithViewRows(reader: OfficialReader, batch: CommandBatch, entry: LayerEntry): void {
  for (const ref of referencesOf(reader)('entries', entry.id)) {
    if (ref.fromTable === 'viewItems' || ref.fromTable === 'viewSettings') batch.remove(ref.fromTable, rowOf(reader, ref.fromTable, ref.fromId))
  }
  batch.remove('entries', entry)
}

function convertWish(reader: OfficialReader, request: Extract<ConvertRequest, { source: 'want-to-go' }>, ctx: NativeWriteContext) {
  const { id, body, journeyChoice } = request
  const blocked = rulesOf(reader).wantToGoConvertBlockCode(id)
  if (blocked === 'E_WTG_NOT_FOUND') return fail(blocked, { id })
  const wish = reader.wish(id)!
  if (blocked === 'E_CONVERT_CITY_IN_FOOTPRINT') return fail(blocked, { cityId: wish.item.placeId })
  if (blocked !== undefined) return fail(blocked)
  const city = reader.place(wish.item.placeId)!
  const dates = convertDates(body)

  const countryId = city.partOf as PlaceId
  const wasInFootprint = inFootprint(reader, countryId)
  const tripTitle = convertTripTitle(body) ?? defaultTripTitle(reader.place(countryId), city)
  const entryId = ctx.newId()
  const decided = decideJourney(journeyChoice, () => journeyCandidates(reader, tripTitle), tripTitle)

  const batch = commandBatch()
  const now = ctx.now.toISOString()
  batch.create('entries', travelEntry(entryId, city.id, dates, tripTitle, now))
  appendRecord(reader, batch, entryId, ctx.newId)
  writeJourney(reader, batch, decided, { entryId, id: entryId, start_date: dates.start }, ctx.newId)
  const wantToGoRemoved = !request.keepWantToGo
  if (wantToGoRemoved) removeWithViewRows(reader, batch, wish.entry)
  const countryCode = reader.place(countryId)?.externalIds?.iso3166Alpha2
  const hasCountryInfo = reader.addedCountries().some((country) => country.placeId === countryId)
  const region = firstVisitRegion(wasInFootprint, hasCountryInfo, countryCode, ctx.countryCatalog)
  if (region) addCountryVisit(reader, batch, { placeId: countryId, region, visitedDate: dates.start }, now, ctx.newId)
  if (!wasInFootprint) {
    reorderCountries(reader, batch, ctx.newId, {
      visits: [{ countryId, start_date: dates.start, end_date: dates.end }],
      ...(region ? { added: [{ placeId: countryId, visitedDate: dates.start }] } : {}),
    })
  }
  return { commands: batch.commands(), result: { travelRecordId: entryId, countryId, cityId: city.id, wantToGoRemoved } }
}

function convertPlanned(reader: OfficialReader, request: Extract<ConvertRequest, { source: 'planned' }>, ctx: NativeWriteContext) {
  const { recordId, body, journeyChoice } = request
  const blocked = rulesOf(reader).plannedConvertBlockCode(recordId)
  if (blocked !== undefined) fail(blocked, { recordId })
  const planned = reader.recordById(recordId)!
  const city = reader.place(planned.record.placeId)
  const dates = convertDates(body)

  const countryId = city?.partOf as PlaceId
  const wasInFootprint = inFootprint(reader, countryId)
  // The record as stored (its verbatim V2 values, no coordinates filled in), visited with the new dates.
  const next: Record<string, JsonValue> = {
    ...recordValueOf(planned.entry, undefined, undefined, undefined) as Record<string, JsonValue>,
    status: 'visited', start_date: dates.start, end_date: dates.end ?? null, year: Number(dates.start.slice(0, 4)),
  }
  if (!dates.end) delete next.end_date
  let decided: { readonly join: string } | { readonly new: true } | { readonly prescribed: string } | undefined
  if (typeof next.journeyId !== 'string' || next.journeyId === '') {
    decided = decideJourney(journeyChoice, () => journeyCandidates(reader, typeof next.trip_title === 'string' ? next.trip_title : undefined),
      typeof next.trip_title === 'string' ? next.trip_title : undefined)
  } else if (journeyChoice.kind !== 'ask') fail('E_UNKNOWN_JOURNEY')
  else if (next.journeyId.trim()) decided = { prescribed: next.journeyId }

  const batch = commandBatch()
  const now = ctx.now.toISOString()
  const entryId = ctx.newId()
  // The entry the old path writes for the same record (../../store/v2RecordRows.ts), without the V2-only status (design §9
  // change 2); a journey chosen now is a sequence, never a value.
  if (decided && !('prescribed' in decided)) delete next.journeyId
  const { entry } = travelRecordEntry(next as unknown as V2TravelRecord, entryId, { createdAt: now, updatedAt: now })
  const extensions = entry.extensions?.v2 && typeof entry.extensions.v2 === 'object' && !Array.isArray(entry.extensions.v2)
    ? Object.fromEntries(Object.entries(entry.extensions.v2).filter(([key]) => key !== 'status')) : {}
  const { extensions: _dropped, ...rest } = entry
  void _dropped
  batch.create('entries', { ...rest, ...(Object.keys(extensions).length ? { extensions: { ...entry.extensions, v2: extensions } } : {}) } satisfies LayerEntry)
  // Its view rows follow it: the record order keeps its position, hidden-from-home its flag (as the old path's retarget
  // and flag); any other view row of the planned entry goes with it.
  for (const ref of referencesOf(reader)('entries', planned.entry.id)) {
    if (ref.fromTable !== 'viewItems' && ref.fromTable !== 'viewSettings') continue
    const row = rowOf(reader, ref.fromTable, ref.fromId) as ViewItem
    const target = { table: 'entries' as const, id: entryId }
    if (ref.fromTable === 'viewItems' && row.scope === S.recordOrder) batch.update('viewItems', row, viewItemRow(row.scope, row.id, target, row.position, row.hidden, row.layerId))
    else if (ref.fromTable === 'viewItems' && row.scope === S.recordHiddenFromHome) batch.update('viewItems', row, viewItemRow(row.scope, row.id, target, row.position, row.hidden))
    else batch.remove(ref.fromTable, row)
  }
  if (decided) writeJourney(reader, batch, decided, { entryId, id: recordId, start_date: dates.start }, ctx.newId)
  batch.remove('entries', planned.entry)
  if (!wasInFootprint) {
    reorderCountries(reader, batch, ctx.newId, {
      visitedAt: { entryId: planned.entry.id, visit: { countryId: countryOfPlace(city), start_date: dates.start, end_date: dates.end } },
    })
  }
  return { commands: batch.commands(), result: { travelRecordId: recordId, countryId, cityId: planned.record.placeId, wantToGoRemoved: false } }
}

export const convertWrite = Object.freeze<NativeWrite>({
  status: 200,
  plan(reader, input, ctx) {
    const request = parseConvertRequest(input)
    return request.source === 'want-to-go' ? convertWish(reader, request, ctx) : convertPlanned(reader, request, ctx)
  },
})
