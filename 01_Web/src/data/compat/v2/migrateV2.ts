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
 * The mapping of one V2 record to its rows lives in ../../store/v2RecordRows.ts (3C-4a), shared with the incremental write path
 * (./diffV2.ts); this module keeps the order of the batch, the identity ledger, the list positions and the report.
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative
 * imports with `.ts`, `import type` for types).
 *
 * Compat (3C-5 E spec §2.4; moved here from ../store/): the migration of V2 files into the store.
 * V2 files are read and written only to migrate a library, to show a root that awaits migration (read-only), and to
 * export a library to V2 (store:export-v2). Ordinary read and write code does not import this directory
 * (scripts/compat-boundary.test.mjs).
 */
import type { FormalCommand, FormalTable } from '../../../worldgraph/store/formal.ts'
import { FORMAL_TABLES } from '../../../worldgraph/store/formal.ts'
import type { JsonObject, JsonValue } from '../../../worldgraph/store/types.ts'
import { StoreError, freezeCopy, utcTimestamp, validateJson } from '../../../worldgraph/store/schema.ts'
import { bridgeAllocator, readBridgeManifest, type BridgeManifest } from './storeBridgeIdentity.ts'
import type { CanonicalData } from '../../canonical/types.ts'
import { readV2 } from './v2Reader.ts'
import { V2_FILE_KEYS, validateV2Files, type V2FileKey, type V2Files } from './v2Schema.ts'
import {
  DISPLAY_SETTING_KEYS, OFFICIAL, UNRESOLVED_KEY_PREFIX, V2_SOURCES, VIEW_SCOPES, mapListScope, officialDefinitionCommands, v2SourceDefinition,
} from '../../store/officialDefinitions.ts'
import {
  countryEvidence, countryEvidenceId, countryVisitDate, countryVisitEntry, journeyEntity, journeyOf, journeySequence, listPositions, mediaAsset,
  mediaEntity, orderedJourneyMembers, placeAnchor, placeEntity, placeRelation, recordPlacement, resolveListElements, travelRecordEntry,
  unresolvedSetting, viewItemRow, viewSettingRow, wantToGoEntry, without, type ViewTarget,
} from '../../store/v2RecordRows.ts'

/** The file headers (3C-5 E: moved here from ../../store/v2RecordRows.ts; only the migration reads V2 files). */
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

export { listPositions } from '../../store/v2RecordRows.ts'

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
const opaque = (id: unknown): id is string => typeof id === 'string' && id.trim() !== '' && id.length <= 512

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
  const headers = v2Headers(files)
  for (const id of Object.values(V2_SOURCES)) create('sources', v2SourceDefinition(id, id === V2_SOURCES.import ? { v2: headers } : undefined))

  // 3. Place entities (ids unchanged).
  for (const place of files.places.places) create('entities', placeEntity(place, leftover))
  // 4. Location anchors and part-of relations.
  for (const place of files.places.places) {
    const anchor = placeAnchor(place)
    if (anchor) create('anchors', anchor)
  }
  for (const place of files.places.places) {
    const relation = placeRelation(place)
    if (relation) create('relations', relation)
  }

  // 5. Media: the asset keeps the V2 media id and the metadata; the entity links place and asset.
  for (const item of files.media.items) {
    create('assets', mediaAsset(item))
    create('entities', mediaEntity(item, allocator.get('media', V2_SOURCES.media, item.id), leftover))
  }

  // 6. Evidence: one per added country, even an empty container.
  for (const country of files.editorState.addedCountries) create('evidence', countryEvidence(country))

  // 7. Entries: footprint and planned records, want-to-go items, country visits.
  const entryOfRecord = new Map<string, string>()
  const hiddenFromHome: { entryId: string; hidden: boolean }[] = []
  let footprintRecords = 0, plannedRecords = 0
  const timestamps = { createdAt: now, updatedAt: now }
  for (const record of files.travel.records) {
    const entryId = allocator.get('entry', recordPlacement(record).sourceId, record.id)
    entryOfRecord.set(record.id, entryId)
    const mapped = travelRecordEntry(record, entryId, timestamps, leftover)
    if (mapped.hiddenFromHome !== undefined) hiddenFromHome.push({ entryId, hidden: mapped.hiddenFromHome })
    if (mapped.planned) plannedRecords++; else footprintRecords++
    create('entries', mapped.entry)
  }
  const entryOfWish = new Map<string, string>()
  for (const item of files.wantToGo.items) {
    const entryId = allocator.get('entry', V2_SOURCES.wantToGo, item.id)
    entryOfWish.set(item.id, entryId)
    create('entries', wantToGoEntry(item, entryId, timestamps, leftover).entry)
  }
  let countryVisits = 0
  for (const country of files.editorState.addedCountries) {
    if (countryVisitDate(country) === undefined) continue
    countryVisits++
    create('entries', countryVisitEntry(country, allocator.get('entry', V2_SOURCES.countryVisit, country.placeId), countryEvidenceId(country.placeId), timestamps)!)
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
    create('entities', journeyEntity(journeyId, entityId))
    create('sequences', journeySequence(journeyId, entityId, orderedJourneyMembers(records).map(r => entryOfRecord.get(r.id)!)))
  }

  // 9. View rows: one scope per semantic.
  const placeTarget = (id: unknown): ViewTarget | undefined => (typeof id === 'string' && placeIds.has(id) ? { table: 'entities', id } : undefined)
  const mediaTarget = (id: unknown): ViewTarget | undefined => (typeof id === 'string' && mediaIds.has(id) ? { table: 'assets', id } : undefined)
  const item = (scope: string, index: number, target: ViewTarget, position: string, hidden: boolean, layerId?: string) =>
    create('viewItems', viewItemRow(scope, `${scope}#${index}`, target, position, hidden, layerId))
  const setting = (scope: string, key: string, rest: { value?: JsonValue; ref?: ViewTarget }) => create('viewSettings', viewSettingRow(scope, `${scope}#${key}`, key, rest))
  /** An ordered list; elements that are no row (or repeat one) become unresolved settings. */
  const list = (scope: string, values: readonly unknown[], resolve: (value: unknown) => ViewTarget | undefined, hidden: boolean, layerId?: string) => {
    const positions = listPositions(values.length)
    resolveListElements(values, resolve).forEach(({ value, target }, index) => {
      if (target) { item(scope, index, target, positions[index], hidden, layerId); return }
      unresolved[scope] = (unresolved[scope] ?? 0) + 1
      const position = positions[index]
      create('viewSettings', unresolvedSetting(scope, `${scope}#${UNRESOLVED_KEY_PREFIX}${position}`, position, value))
    })
  }
  /** A map of lists keyed by place id: a key setting per key, its list in mapListScope. */
  const map = (scope: string, value: Readonly<Record<string, readonly unknown[]>>, resolve: (value: unknown) => ViewTarget | undefined, hidden: boolean) => {
    for (const [key, values] of Object.entries(value)) {
      setting(scope, key, { ref: { table: 'entities', id: key } })
      list(mapListScope(scope, key), values, resolve, hidden)
    }
  }
  const entry = (table: Map<string, string>) => (id: unknown): ViewTarget | undefined => {
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
