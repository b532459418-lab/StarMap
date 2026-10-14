/** V2 -> formal store migration (3C-1b): five V2 files become one batch of
 * commands, in dependency order, that `planCommands` (3C-1a) writes into an
 * empty store in a single pass:
 *
 *   official definitions -> sources -> place entities -> anchors and relations
 *   -> media assets and entities -> evidence -> entries -> journey entities and
 *   sequences -> view rows
 *
 * Nothing is dropped silently. The migration refuses, generating nothing, when
 * `validateV2Files` reports a problem, when `readV2` would skip any record
 * (`problems`), when two records claim the same source identity, or when an id
 * cannot be a store id; the rejection lists every problem found. A V2 value that
 * does not fit its formal field keeps its verbatim JSON in the row's
 * `extensions.v2` under its original key, so projectStoreToCanonical restores it.
 *
 * Pure: no IO, clock or randomness. The caller injects `now` and the UUIDv7
 * allocator; ids of entries, media entities and journeys come from the G2
 * identity ledger (`BridgeManifest`), so a rerun with the previous ledger yields
 * the same commands. Every other id is derived from the V2 ids.
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative
 * imports with `.ts`, `import type` for types).
 */
import type { FormalCommand, FormalTable, ViewItem, ViewItemTable, ViewSetting } from '../../worldgraph/store/formal.ts'
import { FORMAL_TABLES } from '../../worldgraph/store/formal.ts'
import type {
  AssetReference, EntrySequence, Evidence, JsonObject, JsonValue, LayerEntry, ReadonlyTitle, SourceRef, StoreAnchor, StoreEntity, StoreRelation,
} from '../../worldgraph/store/types.ts'
import { StoreError, freezeCopy, utcTimestamp, validateJson } from '../../worldgraph/store/schema.ts'
import { validateRow } from '../../worldgraph/store/rows.ts'
import { positionBetween } from '../../worldgraph/store/position.ts'
import { isCalendarDate } from '../../worldgraph/timeFilter.ts'
import { compareJourneyRecords } from '../canonical/journeyRoutes.ts'
import { bridgeAllocator, readBridgeManifest, type BridgeManifest } from '../canonical/storeBridgeIdentity.ts'
import type { CanonicalData } from '../canonical/types.ts'
import { readV2 } from '../canonical/v2Reader.ts'
import { V2_FILE_KEYS, validateV2Files, type V2FileKey, type V2Files } from '../canonical/v2Schema.ts'
import {
  DISPLAY_SETTING_KEYS, OFFICIAL, UNRESOLVED_KEY_PREFIX, V2_SOURCES, VIEW_SCOPES, mapListScope, officialDefinitionCommands, v2SourceDefinition,
} from './officialDefinitions.ts'

export interface MigrateV2Options {
  /** UTC timestamp for `createdAt` / `updatedAt` of every migrated entry. */
  readonly now: string
  /** Injected UUIDv7 generator (lowercase). Never called when the migration is refused. */
  readonly allocateId: () => string
  /** The ledger of a previous run; its identities are reused and kept. */
  readonly manifest?: BridgeManifest
}
/** One reason to refuse the migration. `message` names the rule, never a record's content. */
export interface MigrationProblem {
  readonly code: string
  readonly file?: V2FileKey
  readonly path: string
  readonly message: string
}
export interface MigrationReport {
  /** Migrated V2 records per kind. */
  readonly counts: {
    readonly places: number
    readonly footprintRecords: number
    readonly plannedRecords: number
    readonly wantToGoItems: number
    readonly addedCountries: number
    readonly countryVisits: number
    readonly media: number
    readonly journeys: number
  }
  /** Created rows per formal table. */
  readonly rows: Readonly<Record<FormalTable, number>>
  /** Where every V2 field goes (static; see V2_FIELD_PLACEMENT). */
  readonly placement: typeof V2_FIELD_PLACEMENT
  /** V2 keys kept verbatim in `extensions.v2`, per record kind, with how many records had them. */
  readonly extensionKeys: Readonly<Record<string, Readonly<Record<string, number>>>>
  /** List elements stored as unresolved view settings (no such row, or a repeated id), per scope. */
  readonly unresolvedViewElements: Readonly<Record<string, number>>
}
export type MigrationResult =
  | { readonly ok: true; readonly commands: readonly FormalCommand[]; readonly manifest: BridgeManifest; readonly report: MigrationReport }
  | { readonly ok: false; readonly commands: readonly []; readonly manifest: null; readonly report: { readonly problems: readonly MigrationProblem[] } }

/** Where each V2 field goes. `extensions.v2.<key>` means: verbatim, on the same row. */
export const V2_FIELD_PLACEMENT = Object.freeze([
  ['places.schema_version / generated_at', `sources[${V2_SOURCES.import}].extensions.v2.places`],
  ['places.places[].id', `entities[${OFFICIAL.place}].id (unchanged); source ${V2_SOURCES.place} / recordId`],
  ['places.places[].subtype', 'entities.fields.subtype'],
  ['places.places[].names, originalLanguage', 'entities.title; extensions.v2.names / originalLanguage when the title is not a valid store title'],
  ['places.places[].externalIds.iso3166Alpha2', 'entities.fields.iso3166Alpha2'],
  ['places.places[].externalIds (other keys)', 'entities.extensions.v2.externalIds'],
  ['places.places[].partOf', `relations[${OFFICIAL.partOf}] city -> country`],
  ['places.places[].location', 'anchors (kind location; precision city / region; approximate)'],
  ['places.places[].legacyKeys', 'entities.extensions.v2.legacyKeys'],
  ['places.places[] order', `viewItems ${VIEW_SCOPES.placeOrder}`],
  ['travel.schema_version / generated_at / privacy_level / intended_use / safety_notes', `sources[${V2_SOURCES.import}].extensions.v2.travel`],
  ['travel.display.homeHiddenCountryIds', `viewItems ${VIEW_SCOPES.homeHiddenCountries} (hidden)`],
  ['travel.display.originCountryIds', `viewItems ${VIEW_SCOPES.originCountries}`],
  ['travel.display.regionCountryIds', `viewItems ${VIEW_SCOPES.regionCountries}`],
  ['travel.display.navigationHiddenCityIds', `viewItems ${VIEW_SCOPES.navigationHiddenCities} (hidden)`],
  ['travel.display.overviewTarget / regionIncludes', `viewSettings ${VIEW_SCOPES.display} (value)`],
  ['travel.records[] (status planned)', `entries[${OFFICIAL.wantToGo}], source ${V2_SOURCES.planned}`],
  ['travel.records[] (other)', `entries[${OFFICIAL.travel}], source ${V2_SOURCES.travel}`],
  ['travel.records[].id', 'entries.source.recordId (entry id from the ledger)'],
  ['travel.records[].placeId', 'entries.entityId'],
  ['travel.records[].start_date / end_date / year', 'entries.fields.date.raw.startDate / endDate / year (verbatim, only keys present)'],
  ['travel.records[].notes', 'entries.fields.note (string) / extensions.v2.notes (other)'],
  ['travel.records[].trip_title', 'entries.fields.tripTitle (string) / extensions.v2.trip_title (other)'],
  ['travel.records[].hiddenFromHome', `viewItems ${VIEW_SCOPES.recordHiddenFromHome} (boolean) / extensions.v2.hiddenFromHome (other)`],
  ['travel.records[].journeyId (not planned, non-blank string)', `entities[${OFFICIAL.journey}] + sequences (source ${V2_SOURCES.journey})`],
  ['travel.records[].journeyId (other)', 'entries.extensions.v2.journeyId'],
  ['travel.records[].lat / lng, status, type, region, source, travelCategory, any other key', 'entries.extensions.v2.<key>'],
  ['travel.records[] order', `viewItems ${VIEW_SCOPES.recordOrder} (both layers)`],
  ['wantToGo.schema_version / generated_at / privacy_level / intended_use', `sources[${V2_SOURCES.import}].extensions.v2.wantToGo`],
  ['wantToGo.items[]', `entries[${OFFICIAL.wantToGo}], source ${V2_SOURCES.wantToGo}`],
  ['wantToGo.items[].id / placeId', 'entries.source.recordId / entityId'],
  ['wantToGo.items[].note', 'entries.fields.note'],
  ['wantToGo.items[].addedAt', 'entries.fields.addedAt (calendar date) / extensions.v2.addedAt (other)'],
  ['wantToGo.items[].hidden', `viewItems ${VIEW_SCOPES.wantToGoHidden} (only true)`],
  ['wantToGo.items[].source', 'entries.extensions.v2.source'],
  ['wantToGo.items[] order', `viewItems ${VIEW_SCOPES.wantToGoOrder}`],
  ['editorState.schemaVersion / updatedAt', `sources[${V2_SOURCES.import}].extensions.v2.editorState`],
  ['editorState.addedCountries[]', `evidence (source ${V2_SOURCES.countryVisit}, recordId placeId, attributes region / other keys)`],
  ['editorState.addedCountries[].visitedDate (non-empty string)', `entries[${OFFICIAL.travel}] fields.date.raw.startDate, source ${V2_SOURCES.countryVisit}, evidenceIds -> the evidence`],
  ['editorState.addedCountries[].visitedDate (other)', 'evidence.attributes.visitedDate'],
  ['editorState.addedCountries[] order', `viewItems ${VIEW_SCOPES.addedCountryOrder}`],
  ['editorState.countryOrder / hiddenCountryIds / hiddenCityIds', `viewItems ${VIEW_SCOPES.countryOrder} / ${VIEW_SCOPES.hiddenCountries} / ${VIEW_SCOPES.hiddenCities}`],
  ['editorState.cityOrderByCountry / mediaOrderByCity / droneOrderByCity', `viewSettings key per map key in ${VIEW_SCOPES.cityOrderByCountry} / ${VIEW_SCOPES.mediaOrderByCity} / ${VIEW_SCOPES.droneOrderByCity}; viewItems in <scope>/<key>`],
  ['editorState.hiddenMediaIds / hiddenDroneMediaIds', `viewItems ${VIEW_SCOPES.hiddenMedia} / ${VIEW_SCOPES.hiddenDroneMedia}`],
  ['editorState.coverMediaByCity', `viewSettings ${VIEW_SCOPES.coverMediaByCity} (ref asset, or the raw media id as value)`],
  ['editor and display list elements that are no row, or repeat an id', `viewSettings <scope> key ${UNRESOLVED_KEY_PREFIX}<position> value { position, id }`],
  ['media.schemaVersion and every other top-level key', `sources[${V2_SOURCES.import}].extensions.v2.media`],
  ['media.items[]', `assets (id = media id, source ${V2_SOURCES.media}) + entities[${OFFICIAL.media}] (ledger id)`],
  ['media.items[].placeId', 'entities.fields.place'],
  ['media.items[].title', 'entities.title; extensions.v2.title when not a valid store title'],
  ['media.items[] every other key', 'assets.attributes'],
  ['media.items[] order', `viewItems ${VIEW_SCOPES.mediaOrder}`],
] as const)

type Problems = MigrationProblem[]
const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const arrayAt = (value: unknown, key: string): readonly unknown[] => (plain(value) && Array.isArray(value[key]) ? value[key] as unknown[] : [])
const without = (value: object, keys: readonly string[]): Record<string, JsonValue> =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))) as Record<string, JsonValue>
const source = (sourceId: string, recordId: string, evidenceIds: readonly string[] = []): SourceRef => ({ sourceId, recordId, evidenceIds })
const opaque = (id: unknown): id is string => typeof id === 'string' && id.trim() !== '' && id.length <= 512
/** True when Core accepts `title` as a row title (language tags, originalLanguage). */
function fitsStoreTitle(title: unknown): title is ReadonlyTitle {
  try { validateRow('sources', { id: 'title-probe', revision: 0, title, origin: 'user' }, { get: () => undefined }); return true } catch { return false }
}

/** Non-blank string journeyId of a non-planned record: the record belongs to that journey. */
const journeyOf = (record: Record<string, unknown>): string | undefined =>
  record.status !== 'planned' && typeof record.journeyId === 'string' && record.journeyId.trim() ? record.journeyId : undefined

/** Source identities must be unique per namespace and usable as store ids (as G2's
 * sourcePreflight, but every collision is reported). Defensive about shape, so it
 * also runs on files that failed validation. */
function sourceProblems(files: Record<string, unknown>, problems: Problems) {
  const seen = new Map<string, string>()
  const claim = (file: V2FileKey, path: string, namespace: string, id: unknown) => {
    if (!opaque(id)) { problems.push({ code: 'E_ID', file, path, message: 'not usable as a store id (blank or longer than 512)' }); return }
    const key = JSON.stringify([namespace, id]), first = seen.get(key)
    if (first !== undefined) problems.push({ code: 'E_SOURCE_COLLISION', file, path, message: `same ${namespace} record as ${first}` })
    else seen.set(key, path)
  }
  arrayAt(files.travel, 'records').forEach((r, i) => {
    if (!plain(r)) return
    claim('travel', `$.records[${i}].id`, r.status === 'planned' ? V2_SOURCES.planned : V2_SOURCES.travel, r.id)
    const journey = journeyOf(r)
    if (journey !== undefined && !opaque(journey)) problems.push({ code: 'E_ID', file: 'travel', path: `$.records[${i}].journeyId`, message: 'not usable as a store id (longer than 512)' })
  })
  arrayAt(files.wantToGo, 'items').forEach((r, i) => { if (plain(r)) claim('wantToGo', `$.items[${i}].id`, V2_SOURCES.wantToGo, r.id) })
  arrayAt(files.media, 'items').forEach((r, i) => { if (plain(r)) claim('media', `$.items[${i}].id`, V2_SOURCES.media, r.id) })
  arrayAt(files.editorState, 'addedCountries').forEach((r, i) => { if (plain(r)) claim('editorState', `$.addedCountries[${i}].placeId`, V2_SOURCES.countryVisit, r.placeId) })
}

/** Every reason to refuse, in file order. Empty: the files can be migrated losslessly.
 * `read` is the V2 Reader; it is a parameter only so tests can make it skip records. */
export function migrationProblems(files: unknown, manifest?: BridgeManifest, read: (files: V2Files) => CanonicalData = readV2): readonly MigrationProblem[] {
  const problems: Problems = []
  try { validateJson(files, '$.files') } catch (e) {
    return [{ code: e instanceof StoreError ? e.code : 'E_JSON', path: e instanceof StoreError ? e.path : '$.files', message: 'input is not plain JSON' }]
  }
  if (!plain(files)) return [{ code: 'E_V2_SHAPE', path: '$.files', message: 'expected the five V2 files' }]
  for (const key of Object.keys(files)) if (!(V2_FILE_KEYS as readonly string[]).includes(key)) problems.push({ code: 'E_V2_SHAPE', path: `$.files.${key}`, message: 'not a V2 file' })
  const invalid = validateV2Files(files as Record<V2FileKey, unknown>)
  for (const p of invalid) problems.push({ code: p.code === 'DUPLICATE_LEGACY_KEY' ? 'E_DUPLICATE_LEGACY_KEY' : 'E_V2_INVALID', file: p.file, path: p.path, message: p.message })
  if (!invalid.length) {
    // readV2 assumes validated input. Any record it skips would be lost.
    const canonical = read(files as unknown as V2Files)
    canonical.wantToGo.problems.forEach((message, i) => problems.push({ code: 'E_V2_SKIPPED', file: 'wantToGo', path: `$.problems[${i}]`, message }))
    canonical.media.problems.forEach((message, i) => problems.push({ code: 'E_V2_SKIPPED', file: 'media', path: `$.problems[${i}]`, message }))
  }
  sourceProblems(files, problems)
  if (manifest !== undefined) {
    try {
      const placeIds = arrayAt(files.places, 'places').map(p => (plain(p) ? p.id : undefined)).filter((id): id is string => typeof id === 'string')
      bridgeAllocator(readBridgeManifest(manifest), placeIds, () => { throw new StoreError('E_ALLOCATE', '$.manifest') })
    } catch (e) {
      problems.push({ code: e instanceof StoreError ? e.code : 'E_MANIFEST', path: '$.manifest', message: 'previous identity ledger is not usable' })
    }
  }
  return freezeCopy(problems)
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

/** V2 files -> one dependency-ordered command batch for an empty store. */
export function migrateV2(files: V2Files, options: MigrateV2Options): MigrationResult {
  utcTimestamp(options.now, '$.now')
  if (typeof options.allocateId !== 'function') throw new StoreError('E_ALLOCATE', '$.allocateId')
  const problems = migrationProblems(files, options.manifest)
  if (problems.length) return freezeCopy({ ok: false as const, commands: [] as [], manifest: null, report: { problems } })
  return build(structuredClone(files), options)
}

function build(files: V2Files, { now, allocateId, manifest }: MigrateV2Options): MigrationResult {
  const commands: FormalCommand[] = []
  const rows = Object.fromEntries(FORMAL_TABLES.map(t => [t, 0])) as Record<FormalTable, number>
  const create = (table: FormalTable, value: object) => { commands.push({ op: 'create', table, value: value as never }); rows[table]++ }
  const extensionKeys: Record<string, Record<string, number>> = {}
  const unresolved: Record<string, number> = {}
  /** `extensions: { v2 }` when anything is left, counting the kept keys. */
  const leftover = (kind: string, rest: Record<string, JsonValue>): { extensions?: JsonObject } => {
    const keys = Object.keys(rest)
    if (!keys.length) return {}
    const counts = extensionKeys[kind] ??= {}
    for (const key of keys) counts[key] = (counts[key] ?? 0) + 1
    return { extensions: { v2: rest } }
  }
  const placeIds = new Set(files.places.places.map(p => p.id))
  const mediaIds = new Set(files.media.items.map(m => m.id))
  const allocator = bridgeAllocator(manifest, [...placeIds], allocateId)

  // 1-2. Official definitions, then the import sources with the file-level metadata.
  for (const c of officialDefinitionCommands()) if (c.op === 'create') create(c.table, c.value)
  const headers = {
    places: without(files.places, ['places']),
    travel: without(files.travel, ['records', 'display']),
    wantToGo: without(files.wantToGo, ['items']),
    editorState: without(files.editorState, [
      'addedCountries', 'countryOrder', 'hiddenCountryIds', 'cityOrderByCountry', 'hiddenCityIds',
      'mediaOrderByCity', 'hiddenMediaIds', 'coverMediaByCity', 'droneOrderByCity', 'hiddenDroneMediaIds',
    ]),
    media: without(files.media, ['items']),
  }
  for (const id of Object.values(V2_SOURCES)) create('sources', v2SourceDefinition(id, id === V2_SOURCES.import ? { v2: headers } : undefined))

  // 3. Place entities (ids unchanged).
  for (const place of files.places.places) {
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
    const entity: StoreEntity = {
      id, revision: 0, typeId: OFFICIAL.place, title: fits ? title : { names: {} }, fields, source: source(V2_SOURCES.place, id), visibility: 'private',
      ...leftover('place', extra),
    }
    create('entities', entity)
  }
  // 4. Location anchors and part-of relations.
  for (const place of files.places.places) {
    const anchor = place.location
    if (anchor) create('anchors', {
      id: `v2:place-location:${place.id}`, revision: 0, entityId: place.id, source: source(V2_SOURCES.place, place.id), kind: 'location',
      lat: anchor.lat, lng: anchor.lng, ...(anchor.approximate !== undefined ? { approximate: anchor.approximate } : {}),
      precision: place.subtype === 'city' ? 'city' : 'region',
    } satisfies StoreAnchor)
  }
  for (const place of files.places.places) {
    if (place.partOf !== undefined) create('relations', {
      id: `v2:part-of:${place.id}`, revision: 0, typeId: OFFICIAL.partOf, fromEntityId: place.id, toEntityId: place.partOf, fields: {},
      source: source(V2_SOURCES.place, place.id),
    } satisfies StoreRelation)
  }

  // 5. Media: the asset keeps the V2 media id and the metadata; the entity links place and asset.
  for (const item of files.media.items) {
    const { id, placeId, title, ...attributes } = item
    create('assets', { id, revision: 0, source: source(V2_SOURCES.media, id), attributes: attributes as JsonObject } satisfies AssetReference)
    const fits = title !== undefined && fitsStoreTitle(title)
    create('entities', {
      id: allocator.get('media', V2_SOURCES.media, id), revision: 0, typeId: OFFICIAL.media, title: fits ? title : { names: {} },
      fields: { place: placeId, asset: id }, source: source(V2_SOURCES.media, id), visibility: 'private',
      ...leftover('media', title !== undefined && !fits ? { title: title as unknown as JsonValue } : {}),
    } satisfies StoreEntity)
  }

  // 6. Evidence: one per added country, even an empty container.
  const visitDate = (c: { visitedDate?: unknown }) => (typeof c.visitedDate === 'string' && c.visitedDate !== '' ? c.visitedDate : undefined)
  const evidenceId = (placeId: string) => `v2:country-visit:${placeId}`
  for (const country of files.editorState.addedCountries) {
    const attributes = without(country, visitDate(country) !== undefined ? ['placeId', 'visitedDate'] : ['placeId'])
    create('evidence', { id: evidenceId(country.placeId), revision: 0, sourceId: V2_SOURCES.countryVisit, recordId: country.placeId, attributes } satisfies Evidence)
  }

  // 7. Entries: footprint and planned records, want-to-go items, country visits.
  const entryOfRecord = new Map<string, string>()
  const hiddenFromHome: { entryId: string; hidden: boolean }[] = []
  let footprintRecords = 0, plannedRecords = 0
  const timestamps = { createdAt: now, updatedAt: now }
  for (const record of files.travel.records) {
    const planned = record.status === 'planned'
    const sourceId = planned ? V2_SOURCES.planned : V2_SOURCES.travel
    const { id, placeId, ...rest } = record as unknown as Record<string, JsonValue> & { id: string; placeId: string }
    const entryId = allocator.get('entry', sourceId, id)
    entryOfRecord.set(id, entryId)
    const raw: Record<string, JsonValue> = {}
    for (const [key, target] of [['start_date', 'startDate'], ['end_date', 'endDate'], ['year', 'year']] as const) {
      if (Object.hasOwn(rest, key)) { raw[target] = rest[key]; delete rest[key] }
    }
    const fields: Record<string, JsonValue> = planned && !Object.keys(raw).length ? {} : { date: { raw } }
    if (typeof rest.notes === 'string') { fields.note = rest.notes; delete rest.notes }
    if (typeof rest.trip_title === 'string') { fields.tripTitle = rest.trip_title; delete rest.trip_title }
    if (typeof rest.hiddenFromHome === 'boolean') { hiddenFromHome.push({ entryId, hidden: rest.hiddenFromHome }); delete rest.hiddenFromHome }
    if (journeyOf(record as unknown as Record<string, unknown>) !== undefined) delete rest.journeyId
    if (planned) plannedRecords++; else footprintRecords++
    create('entries', {
      id: entryId, revision: 0, layerId: planned ? OFFICIAL.wantToGo : OFFICIAL.travel, entityId: placeId, fields,
      source: source(sourceId, id), ...timestamps, ...leftover(planned ? 'plannedRecord' : 'footprintRecord', rest),
    } satisfies LayerEntry)
  }
  const entryOfWish = new Map<string, string>()
  for (const item of files.wantToGo.items) {
    const { id, placeId, note, addedAt } = item
    const entryId = allocator.get('entry', V2_SOURCES.wantToGo, id)
    entryOfWish.set(id, entryId)
    const fields: Record<string, JsonValue> = {}
    // `hidden` is view state (wantToGoHidden), not a field.
    const extra = without(item, ['id', 'placeId', 'note', 'addedAt', 'hidden'])
    if (typeof note === 'string') fields.note = note; else if (note !== undefined) extra.note = note
    if (isCalendarDate(addedAt)) fields.addedAt = addedAt; else extra.addedAt = addedAt
    create('entries', {
      id: entryId, revision: 0, layerId: OFFICIAL.wantToGo, entityId: placeId, fields, source: source(V2_SOURCES.wantToGo, id), ...timestamps,
      ...leftover('wantToGoItem', extra),
    } satisfies LayerEntry)
  }
  let countryVisits = 0
  for (const country of files.editorState.addedCountries) {
    const date = visitDate(country)
    if (date === undefined) continue
    countryVisits++
    create('entries', {
      id: allocator.get('entry', V2_SOURCES.countryVisit, country.placeId), revision: 0, layerId: OFFICIAL.travel, entityId: country.placeId,
      fields: { date: { raw: { startDate: date } } }, source: source(V2_SOURCES.countryVisit, country.placeId, [evidenceId(country.placeId)]), ...timestamps,
    } satisfies LayerEntry)
  }

  // 8. Journeys: entity plus the original adjacency (the same order routes are derived in).
  const journeys = new Map<string, typeof files.travel.records>()
  for (const record of files.travel.records) {
    const journeyId = journeyOf(record as unknown as Record<string, unknown>)
    if (journeyId === undefined) continue
    const group = journeys.get(journeyId) ?? []
    group.push(record); journeys.set(journeyId, group)
  }
  for (const [journeyId, records] of journeys) {
    const entityId = allocator.get('journey', V2_SOURCES.journey, journeyId)
    create('entities', {
      id: entityId, revision: 0, typeId: OFFICIAL.journey, title: { names: {} }, fields: {}, source: source(V2_SOURCES.journey, journeyId), visibility: 'private',
    } satisfies StoreEntity)
    const ordered = [...records].sort((a, b) => compareJourneyRecords(a as { id: string; start_date?: string }, b as { id: string; start_date?: string }))
    create('sequences', {
      id: `v2:journey-sequence:${entityId}`, revision: 0, entityId, entryIds: ordered.map(r => entryOfRecord.get(r.id)!), source: source(V2_SOURCES.journey, journeyId),
    } satisfies EntrySequence)
  }

  // 9. View rows: one scope per semantic.
  type Target = { readonly table: ViewItemTable; readonly id: string }
  const placeTarget = (id: unknown): Target | undefined => (typeof id === 'string' && placeIds.has(id) ? { table: 'entities', id } : undefined)
  const mediaTarget = (id: unknown): Target | undefined => (typeof id === 'string' && mediaIds.has(id) ? { table: 'assets', id } : undefined)
  const item = (scope: string, index: number, target: Target, position: string, hidden: boolean, layerId?: string) => create('viewItems', {
    id: `${scope}#${index}`, revision: 0, scope, itemTable: target.table, itemId: target.id, ...(layerId !== undefined ? { layerId } : {}), position, hidden,
  } satisfies ViewItem)
  const setting = (scope: string, key: string, rest: { value?: JsonValue; ref?: Target }) =>
    create('viewSettings', { id: `${scope}#${key}`, revision: 0, scope, key, ...rest } satisfies ViewSetting)
  /** An ordered list; elements that are no row (or repeat one) become unresolved settings. */
  const list = (scope: string, values: readonly unknown[], resolve: (value: unknown) => Target | undefined, hidden: boolean, layerId?: string) => {
    const positions = listPositions(values.length), used = new Set<string>()
    values.forEach((value, index) => {
      const target = resolve(value), key = target && JSON.stringify([target.table, target.id])
      if (target && !used.has(key!)) { used.add(key!); item(scope, index, target, positions[index], hidden, layerId); return }
      unresolved[scope] = (unresolved[scope] ?? 0) + 1
      setting(scope, UNRESOLVED_KEY_PREFIX + positions[index], { value: { position: positions[index], id: value as JsonValue } })
    })
  }
  /** A map of lists keyed by place id: a key setting per key, its list in mapListScope. */
  const map = (scope: string, value: Readonly<Record<string, readonly unknown[]>>, resolve: (value: unknown) => Target | undefined, hidden: boolean) => {
    for (const [key, values] of Object.entries(value)) {
      setting(scope, key, { ref: { table: 'entities', id: key } })
      list(mapListScope(scope, key), values, resolve, hidden)
    }
  }
  const entry = (table: Map<string, string>) => (id: unknown): Target | undefined => {
    const entryId = typeof id === 'string' ? table.get(id) : undefined
    return entryId === undefined ? undefined : { table: 'entries', id: entryId }
  }
  const S = VIEW_SCOPES, editor = files.editorState, display = files.travel.display
  list(S.placeOrder, files.places.places.map(p => p.id), placeTarget, false)
  list(S.recordOrder, files.travel.records.map(r => r.id), entry(entryOfRecord), false)
  list(S.wantToGoOrder, files.wantToGo.items.map(i => i.id), entry(entryOfWish), false, OFFICIAL.wantToGo)
  list(S.mediaOrder, files.media.items.map(m => m.id), mediaTarget, false)
  list(S.addedCountryOrder, editor.addedCountries.map(c => c.placeId), placeTarget, false)
  const homePositions = listPositions(hiddenFromHome.length)
  hiddenFromHome.forEach((h, index) => item(S.recordHiddenFromHome, index, { table: 'entries', id: h.entryId }, homePositions[index], h.hidden))
  list(S.wantToGoHidden, files.wantToGo.items.filter(i => i.hidden === true).map(i => i.id), entry(entryOfWish), true, OFFICIAL.wantToGo)
  list(S.countryOrder, editor.countryOrder, placeTarget, false)
  list(S.hiddenCountries, editor.hiddenCountryIds, placeTarget, true)
  map(S.cityOrderByCountry, editor.cityOrderByCountry, placeTarget, false)
  list(S.hiddenCities, editor.hiddenCityIds, placeTarget, true)
  map(S.mediaOrderByCity, editor.mediaOrderByCity, mediaTarget, false)
  list(S.hiddenMedia, editor.hiddenMediaIds, mediaTarget, true)
  for (const [key, mediaId] of Object.entries(editor.coverMediaByCity)) {
    const target = mediaTarget(mediaId)
    setting(S.coverMediaByCity, key, target ? { ref: target } : { value: mediaId })
  }
  map(S.droneOrderByCity, editor.droneOrderByCity, mediaTarget, false)
  list(S.hiddenDroneMedia, editor.hiddenDroneMediaIds, mediaTarget, true)
  list(S.homeHiddenCountries, display.homeHiddenCountryIds, placeTarget, true)
  list(S.originCountries, display.originCountryIds, placeTarget, false)
  list(S.regionCountries, display.regionCountryIds, placeTarget, false)
  list(S.navigationHiddenCities, display.navigationHiddenCityIds, placeTarget, true)
  if (display.overviewTarget !== undefined) setting(S.display, DISPLAY_SETTING_KEYS.overviewTarget, { value: display.overviewTarget as unknown as JsonValue })
  setting(S.display, DISPLAY_SETTING_KEYS.regionIncludes, { value: display.regionIncludes })

  const report: MigrationReport = {
    counts: {
      places: files.places.places.length, footprintRecords, plannedRecords, wantToGoItems: files.wantToGo.items.length,
      addedCountries: editor.addedCountries.length, countryVisits, media: files.media.items.length, journeys: journeys.size,
    },
    rows, placement: V2_FIELD_PLACEMENT, extensionKeys, unresolvedViewElements: unresolved,
  }
  return freezeCopy({ ok: true as const, commands, manifest: allocator.finish(), report })
}
