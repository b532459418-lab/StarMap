/** The public sample, written in the new library's own format (3C-5A; D2 as the author decided on 2026-10-20).
 *
 * This file is the source of the public sample: neutral, public demonstration data about a fictional journey through
 * the North Atlantic, with three places someone wants to go to. `npm run sample:build` turns it into
 * `sample.read-model.json` (./sampleBuild.ts): every row below becomes a create command, Core's planner checks them
 * against the official definitions, and the store state is written out as the read model `starmap.read-model` with
 * origin `sample`. Edit the lists below, run `npm run sample:build`, then `npm run privacy:check` and `npm test`; commit
 * the source and the regenerated file together (a test requires them to agree byte for byte).
 *
 * How it is written: as store rows. Each place, record, wish and journey is one line in the lists below; the small
 * functions after them only lay those values out as the rows Core stores (a place is an entity, its location anchor
 * and, for a city, its part-of relation; a record is an entry; a journey is an entity and its sequence; list order is
 * view items). They apply no rule: what you see in a line is what the row holds. Commands are not used because a
 * create-only seed gains nothing from them; ids, times and order are all fixed here, so the output never changes by
 * itself.
 *
 * How the first version was made (2026-10-20): the V2 sample (src/data/v2-sample/, still what the public build reads
 * until 3C-5B) was migrated into a store with a fixed time and a fixed id allocator, and the rows were rewritten here by
 * hand: the entries got their own ids (01a0ed02-3f49-…), every entity was marked public, the creation time became the
 * sample's own date, and the import sources no records use (planned records, added countries, media) were left out.
 * Everything the official view reads was kept as it was, so the derived results are the same byte for byte (the locked
 * hash 9b68b8ad…): the records keep their import source and record ids (`v2:travel`, `sample_reykjavik`, …), the
 * journey keeps its ledger key, and the verbatim values the migration kept (`extensions.v2`: a record's region, type,
 * status and source label, a place's old folder keys, the five files' headers) are kept too.
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types).
 */
import type { ViewItem, ViewSetting } from '../../worldgraph/store/formal.ts'
import type {
  EntrySequence, JsonObject, JsonValue, LayerEntry, SourceDefinition, SourceRef, StoreAnchor, StoreEntity, StoreRelation,
} from '../../worldgraph/store/types.ts'
import { DISPLAY_SETTING_KEYS, OFFICIAL, V2_SOURCES, VIEW_SCOPES, v2SourceDefinition } from '../store/officialDefinitions.ts'
import { listPositions } from '../store/v2RecordRows.ts'

/** When every entry was created and last changed: the day the sample was written. */
export const SAMPLE_TIME = '2026-08-12T00:00:00.000Z'

// ---------------------------------------------------------------------------
// Places: a `starmap:place` entity each, with its location anchor and, for a city, its part-of relation
// ---------------------------------------------------------------------------

const ICELAND = '01a0ed02-3f45-7743-8aec-d757b6c28eba'
const FAROE_ISLANDS = '01a0ed02-3f47-772d-946a-07690eff25e1'
const REYKJAVIK = '01a0ed02-3f48-70a0-9146-47667ddcbf4e'
const VIK = '01a0ed02-3f48-74aa-9bea-237f235aac61'
const AKUREYRI = '01a0ed02-3f48-7cdd-8d8c-70c026b27a4c'
const TORSHAVN = '01a0ed02-3f48-7c35-9d1d-07a1ef8a6859'
const GJOGV = '01a0ed02-3f48-79cd-bd98-8d0e4590fffa'
const GREENLAND = '01a0ed02-3f48-72d6-8d06-2972508952dc'
const NUUK = '01a0ed02-3f48-71aa-b906-9ae1d71822b8'
const NORWAY = '01a0ed02-3f48-7c63-a473-3c1e3c94883d'
const TROMSO = '01a0ed02-3f48-7581-bb37-85d4ee0268e9'

interface PlaceLine {
  readonly id: string
  readonly subtype: 'country' | 'city'
  readonly names: { readonly 'zh-Hans': string; readonly en: string }
  /** ISO 3166-1 alpha-2 of a country. */
  readonly iso?: string
  /** The country a city is part of. */
  readonly partOf?: string
  /** [latitude, longitude]; a place without one has no anchor. */
  readonly at?: readonly [number, number]
  /** Old folder keys the media importer recognises (kept verbatim from the V2 sample). */
  readonly legacyKeys?: readonly string[]
}

/** In the sample's place order. */
const PLACES: readonly PlaceLine[] = [
  { id: ICELAND, subtype: 'country', names: { 'zh-Hans': '冰岛', en: 'Iceland' }, iso: 'IS', at: [64.4179, -19.691599999999998], legacyKeys: ['country:iceland'] },
  { id: FAROE_ISLANDS, subtype: 'country', names: { 'zh-Hans': '法罗群岛', en: 'Faroe Islands' }, iso: 'FO', at: [62.16645, -6.865], legacyKeys: ['country:faroe-islands'] },
  { id: REYKJAVIK, subtype: 'city', names: { 'zh-Hans': '雷克雅未克', en: 'Reykjavik' }, partOf: ICELAND, at: [64.1466, -21.9426], legacyKeys: ['city:iceland__reykjavik'] },
  { id: VIK, subtype: 'city', names: { 'zh-Hans': '维克', en: 'Vik' }, partOf: ICELAND, at: [63.4186, -19.006], legacyKeys: ['city:iceland__vik'] },
  { id: AKUREYRI, subtype: 'city', names: { 'zh-Hans': '阿克雷里', en: 'Akureyri' }, partOf: ICELAND, at: [65.6885, -18.1262], legacyKeys: ['city:iceland__akureyri'] },
  { id: TORSHAVN, subtype: 'city', names: { 'zh-Hans': '托尔斯港', en: 'Torshavn' }, partOf: FAROE_ISLANDS, at: [62.0079, -6.79], legacyKeys: ['city:faroe-islands__torshavn'] },
  { id: GJOGV, subtype: 'city', names: { 'zh-Hans': '杰格夫', en: 'Gjogv' }, partOf: FAROE_ISLANDS, at: [62.325, -6.94], legacyKeys: ['city:faroe-islands__gjogv'] },
  { id: GREENLAND, subtype: 'country', names: { 'zh-Hans': '格陵兰', en: 'Greenland' }, iso: 'GL' },
  { id: NUUK, subtype: 'city', names: { 'zh-Hans': '努克', en: 'Nuuk' }, partOf: GREENLAND, at: [64.1814, -51.6941] },
  { id: NORWAY, subtype: 'country', names: { 'zh-Hans': '挪威', en: 'Norway' }, iso: 'NO' },
  { id: TROMSO, subtype: 'city', names: { 'zh-Hans': '特罗姆瑟', en: 'Tromsø' }, partOf: NORWAY, at: [69.6492, 18.9553] },
]

// ---------------------------------------------------------------------------
// Footprint records: entries of `starmap:travel`; the journey that links them
// ---------------------------------------------------------------------------

const entryId = (n: number) => `01a0ed02-3f49-7000-8000-${String(n).padStart(12, '0')}`
const JOURNEY_ENTITY = '01a0ed02-3f49-7000-8000-000000000100'
const JOURNEY_KEY = '2025-north-atlantic-demo'
const TRIP_TITLE = '2025 North Atlantic Demo'

interface RecordLine {
  readonly entry: string
  /** The record id the App shows (the import source's record id). */
  readonly record: string
  readonly place: string
  readonly start: string
  readonly end: string
  readonly note: string
  /** `city` or `daytrip` (a day trip is drawn as one). */
  readonly type: 'city' | 'daytrip'
}

/** In the sample's record order, which is also the journey's order. */
const RECORDS: readonly RecordLine[] = [
  { entry: entryId(1), record: 'sample_reykjavik', place: REYKJAVIK, start: '2025-06-01', end: '2025-06-02', note: 'Sample city record.', type: 'city' },
  { entry: entryId(2), record: 'sample_vik', place: VIK, start: '2025-06-03', end: '2025-06-03', note: 'Sample landscape stop.', type: 'daytrip' },
  { entry: entryId(3), record: 'sample_akureyri', place: AKUREYRI, start: '2025-06-04', end: '2025-06-05', note: 'Sample northern city record.', type: 'city' },
  { entry: entryId(4), record: 'sample_torshavn', place: TORSHAVN, start: '2025-06-06', end: '2025-06-07', note: 'Sample island capital record.', type: 'city' },
  { entry: entryId(5), record: 'sample_gjogv', place: GJOGV, start: '2025-06-08', end: '2025-06-08', note: 'Sample coastal village record.', type: 'daytrip' },
]

// ---------------------------------------------------------------------------
// Want to Go: entries of `starmap:want-to-go`
// ---------------------------------------------------------------------------

interface WishLine { readonly entry: string; readonly record: string; readonly place: string; readonly addedAt: string; readonly note: string }

const WISHES: readonly WishLine[] = [
  { entry: entryId(11), record: 'wtg_2026-08-12_nuuk', place: NUUK, addedAt: '2026-08-12', note: '格陵兰的首府，坐落在峡湾入海口，是世界上最北的首府之一。' },
  { entry: entryId(12), record: 'wtg_2026-08-12_tromso', place: TROMSO, addedAt: '2026-08-12', note: '北极圈以北的城市，冬季可以看极光，夏季有午夜阳光。' },
  { entry: entryId(13), record: 'wtg_2026-08-12_akureyri', place: AKUREYRI, addedAt: '2026-08-12', note: '冰岛北部最大的城镇，位于埃亚峡湾的深处。' },
]

// ---------------------------------------------------------------------------
// The map's overview and the import's file headers
// ---------------------------------------------------------------------------

const OVERVIEW_TARGET = { lat: 64, lng: -13 }
const SAMPLE_PURPOSE = 'Neutral open-source StarMap demonstration data.'
/** The headers of the five V2 sample files, kept verbatim (the official view reads the travel file's). */
const FILE_HEADERS: JsonObject = {
  places: { schema_version: 1, generated_at: '2026-08-12T00:00:00.000Z' },
  travel: {
    schema_version: 2, generated_at: '2026-08-12', privacy_level: 'public-sample', intended_use: SAMPLE_PURPOSE,
    safety_notes: ['Fictional itinerary assembled from public geographic facts.', 'Replace this sample with generated/travel-map.local.json for personal use.'],
  },
  wantToGo: { schema_version: 2, generated_at: '2026-08-12T00:00:00.000Z', privacy_level: 'public-sample', intended_use: SAMPLE_PURPOSE },
  editorState: { schemaVersion: 2 },
  media: { schemaVersion: 3 },
}

// ---------------------------------------------------------------------------
// Laying the lines out as rows (no rules here)
// ---------------------------------------------------------------------------

const from = (sourceId: string, recordId: string): SourceRef => ({ sourceId, recordId, evidenceIds: [] })
const verbatim = (values: Record<string, JsonValue>): { extensions?: JsonObject } => (Object.keys(values).length ? { extensions: { v2: values } } : {})

const placeRows = (place: PlaceLine) => {
  const entity: StoreEntity = {
    id: place.id, revision: 0, typeId: OFFICIAL.place, title: { names: place.names },
    fields: { subtype: place.subtype, ...(place.iso ? { iso3166Alpha2: place.iso } : {}) },
    source: from(V2_SOURCES.place, place.id), visibility: 'public',
    ...verbatim(place.legacyKeys ? { legacyKeys: [...place.legacyKeys] } : {}),
  }
  const anchor: StoreAnchor | undefined = place.at && {
    id: `v2:place-location:${place.id}`, revision: 0, entityId: place.id, source: from(V2_SOURCES.place, place.id),
    kind: 'location', lat: place.at[0], lng: place.at[1], precision: place.subtype === 'city' ? 'city' : 'region',
  }
  const relation: StoreRelation | undefined = place.partOf === undefined ? undefined : {
    id: `v2:part-of:${place.id}`, revision: 0, typeId: OFFICIAL.partOf, fromEntityId: place.id, toEntityId: place.partOf, fields: {},
    source: from(V2_SOURCES.place, place.id),
  }
  return { entity, anchor, relation }
}

const recordEntry = (record: RecordLine): LayerEntry => ({
  id: record.entry, revision: 0, layerId: OFFICIAL.travel, entityId: record.place,
  fields: { date: { raw: { startDate: record.start, endDate: record.end, year: Number(record.start.slice(0, 4)) } }, note: record.note, tripTitle: TRIP_TITLE },
  source: from(V2_SOURCES.travel, record.record), createdAt: SAMPLE_TIME, updatedAt: SAMPLE_TIME,
  ...verbatim({ region: 'North Atlantic', type: record.type, status: 'visited', source: 'StarMap public sample' }),
})

const wishEntry = (wish: WishLine): LayerEntry => ({
  id: wish.entry, revision: 0, layerId: OFFICIAL.wantToGo, entityId: wish.place, fields: { note: wish.note, addedAt: wish.addedAt },
  source: from(V2_SOURCES.wantToGo, wish.record), createdAt: SAMPLE_TIME, updatedAt: SAMPLE_TIME,
  ...verbatim({ source: 'sample' }),
})

/** One view item per id, in list order. */
const listItems = (scope: string, itemTable: ViewItem['itemTable'], ids: readonly string[], layerId?: string): ViewItem[] => {
  const positions = listPositions(ids.length)
  return ids.map((itemId, index) => ({
    id: `${scope}#${index}`, revision: 0, scope, itemTable, itemId, ...(layerId ? { layerId } : {}), position: positions[index], hidden: false,
  }))
}

/** Every row of the sample except the official definitions (sampleBuild adds those), by table. */
export function sampleRows() {
  const places = PLACES.map(placeRows)
  const sources: SourceDefinition[] = [
    v2SourceDefinition(V2_SOURCES.place), v2SourceDefinition(V2_SOURCES.travel), v2SourceDefinition(V2_SOURCES.wantToGo),
    v2SourceDefinition(V2_SOURCES.journey), v2SourceDefinition(V2_SOURCES.import, { v2: FILE_HEADERS }),
  ]
  const journey: StoreEntity = {
    id: JOURNEY_ENTITY, revision: 0, typeId: OFFICIAL.journey, title: { names: {} }, fields: {}, source: from(V2_SOURCES.journey, JOURNEY_KEY), visibility: 'public',
  }
  const sequence: EntrySequence = {
    id: `v2:journey-sequence:${JOURNEY_ENTITY}`, revision: 0, entityId: JOURNEY_ENTITY, entryIds: RECORDS.map((record) => record.entry),
    source: from(V2_SOURCES.journey, JOURNEY_KEY),
  }
  const settings: ViewSetting[] = [
    { id: `${VIEW_SCOPES.display}#${DISPLAY_SETTING_KEYS.overviewTarget}`, revision: 0, scope: VIEW_SCOPES.display, key: DISPLAY_SETTING_KEYS.overviewTarget, value: { ...OVERVIEW_TARGET } },
    { id: `${VIEW_SCOPES.display}#${DISPLAY_SETTING_KEYS.regionIncludes}`, revision: 0, scope: VIEW_SCOPES.display, key: DISPLAY_SETTING_KEYS.regionIncludes, value: [] },
  ]
  return {
    sources,
    entities: [...places.map((place) => place.entity), journey],
    entries: [...RECORDS.map(recordEntry), ...WISHES.map(wishEntry)],
    relations: places.flatMap((place) => (place.relation ? [place.relation] : [])),
    anchors: places.flatMap((place) => (place.anchor ? [place.anchor] : [])),
    sequences: [sequence],
    viewItems: [
      ...listItems(VIEW_SCOPES.placeOrder, 'entities', PLACES.map((place) => place.id)),
      ...listItems(VIEW_SCOPES.recordOrder, 'entries', RECORDS.map((record) => record.entry)),
      ...listItems(VIEW_SCOPES.wantToGoOrder, 'entries', WISHES.map((wish) => wish.entry), OFFICIAL.wantToGo),
    ],
    viewSettings: settings,
  }
}
