/// <reference types="node" />
/** The formal store after the migration: content Canonical cannot express is skipped
 * and listed, content created later projects after the migrated records, and the
 * whole path is timed at the 3C-1b scale (recorded, never asserted). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { FORMAL_TABLES, type FormalCommand, type FormalRow, type FormalState, type FormalTable, emptyFormalState } from '../../worldgraph/store/formal.ts'
import { memoryReader } from '../../worldgraph/store/reader.ts'
import { applyChangeSet, planCommands } from '../../worldgraph/store/planner.ts'
import { publicBridgeFixture } from '../canonical/storeBridge.fixture.ts'
import { sequentialUuids } from '../canonical/v2.fixture.ts'
import { readV2 } from '../canonical/v2Reader.ts'
import { serializeV2 } from '../canonical/v2Serializer.ts'
import { validateV2Files, type V2Files } from '../canonical/v2Schema.ts'
import { OFFICIAL, OFFICIAL_POLICY } from './officialDefinitions.ts'
import { migrateV2 } from './migrateV2.ts'
import { projectStoreToCanonical } from './projectCanonical.ts'
import { NOW, allocatorFrom, migrateIntoEmptyStore } from './v2Store.fixture.ts'

const LATER = '2026-10-20T00:00:00.000Z'
const create = (table: FormalTable, value: object): FormalCommand => ({ op: 'create', table, value: value as FormalRow })
const run = (state: FormalState, commands: readonly FormalCommand[]) =>
  applyChangeSet(state, planCommands(memoryReader(state), commands, { baseRevision: state.revision, now: LATER, policy: OFFICIAL_POLICY }))
const project = (state: FormalState) => projectStoreToCanonical(state, { source: 'local' })
const generator = (seed: number) => { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000 } }

for (const seed of [7, 2026]) test(`a randomly named custom layer is skipped and listed, the projection is unchanged (seed ${seed})`, () => {
  const random = generator(seed)
  const word = () => Array.from({ length: 8 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(random() * 36)]).join('')
  const sourceId = `${word()}:${word()}`, typeId = `${word()}:${word()}`, layerId = `${word()}/${word()}`, fieldKey = word(), scope = `${word()}:${word()}`
  const uuid = sequentialUuids(Date.UTC(2035, 0, 1 + Math.floor(random() * 300)))
  const entityId = uuid(), ownEntry = uuid(), placeEntry = uuid()
  const { state } = migrateIntoEmptyStore(publicBridgeFixture())
  const before = project(state)
  const place = state.entities.find(e => e.typeId === OFFICIAL.place)!
  const source = (recordId: string) => ({ sourceId, recordId, evidenceIds: [] })
  const entry = (id: string, entity: string) => ({ id, revision: 0, layerId, entityId: entity, fields: { [fieldKey]: 'x' }, source: source(id), createdAt: LATER, updatedAt: LATER })
  const after = run(state, [
    create('sources', { id: sourceId, revision: 0, title: { names: { und: word() } }, origin: 'user' }),
    create('entityTypes', { id: typeId, revision: 0, title: { names: { und: word() } }, schemaVersion: 1, fields: [] }),
    // An empty type list accepts every type, places included.
    create('layers', { id: layerId, revision: 0, title: { names: { und: word() } }, schemaVersion: 1, acceptedEntityTypes: [], entryFields: [{ key: fieldKey, kind: 'text' }] }),
    create('entities', { id: entityId, revision: 0, typeId, title: { names: { und: word() } }, fields: {}, source: source(entityId), visibility: 'private' }),
    create('entries', entry(ownEntry, entityId)),
    create('entries', entry(placeEntry, place.id)),
    create('viewItems', { id: `${scope}#0`, revision: 0, scope, itemTable: 'entries', itemId: placeEntry, layerId, position: 'V', hidden: true }),
  ])
  const projection = project(after)
  assert.deepEqual(projection.canonical, before.canonical)
  assert.deepEqual(projection.v2Meta, before.v2Meta)
  const order = ['sources', 'entityTypes', 'layers', 'entities', 'entries', 'viewItems']
  const expected = [
    { table: 'sources', id: sourceId }, { table: 'entityTypes', id: typeId }, { table: 'layers', id: layerId }, { table: 'entities', id: entityId },
    ...[ownEntry, placeEntry].sort().map(id => ({ table: 'entries', id })), { table: 'viewItems', id: `${scope}#0` },
  ].sort((a, b) => order.indexOf(a.table) - order.indexOf(b.table))
  assert.deepEqual(projection.skipped, expected)
})

test('entries created after the migration (starmap:user) follow the migrated ones by createdAt and keep their entry id', () => {
  const files = publicBridgeFixture(), { state } = migrateIntoEmptyStore(files)
  const cities = state.entities.filter(e => e.typeId === OFFICIAL.place && e.fields.subtype === 'city')
  const uuid = sequentialUuids(Date.UTC(2036, 0, 1))
  // Ids grow with creation of the ids, not with createdAt: the order must follow createdAt.
  const [early, late, undated, footprint] = [uuid(), uuid(), uuid(), uuid()]
  const user = (id: string) => ({ sourceId: OFFICIAL.user, recordId: id, evidenceIds: [] })
  const wish = (id: string, entityId: string, createdAt: string, fields: object) =>
    create('entries', { id, revision: 0, layerId: OFFICIAL.wantToGo, entityId, fields, source: user(id), createdAt, updatedAt: createdAt })
  const after = run(state, [
    wish(late, cities[0].id, '2026-10-19T00:00:00.000Z', { addedAt: '2026-10-19', note: 'Synthetic later' }),
    wish(early, cities[1].id, '2026-10-15T00:00:00.000Z', { addedAt: '2026-10-15' }),
    wish(undated, cities[2].id, '2026-10-17T08:00:00.000Z', {}),
    create('entries', { id: footprint, revision: 0, layerId: OFFICIAL.travel, entityId: cities[3].id, fields: { date: { raw: { startDate: '2026-10-16' } }, tripTitle: 'Synthetic trip' }, source: user(footprint), createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z' }),
  ])
  const { canonical, v2Meta, skipped } = project(after), original = readV2(files)
  assert.deepEqual(skipped, [])
  const items = canonical.wantToGo.items
  assert.deepEqual(items.slice(0, original.wantToGo.items.length), original.wantToGo.items)
  assert.deepEqual(items.slice(original.wantToGo.items.length), [
    { id: early, placeId: cities[1].id, addedAt: '2026-10-15', hidden: false },
    // Without addedAt, an entry was added on the UTC day it was created.
    { id: undated, placeId: cities[2].id, addedAt: '2026-10-17', hidden: false },
    { id: late, placeId: cities[0].id, addedAt: '2026-10-19', note: 'Synthetic later', hidden: false },
  ])
  const records = canonical.travel.records
  assert.deepEqual(records.slice(0, -1), original.travel.records)
  const city = files.places.places.find(p => p.id === cities[3].id)!
  assert.deepEqual(records.at(-1), { id: footprint, placeId: cities[3].id, start_date: '2026-10-16', trip_title: 'Synthetic trip', lat: city.location!.lat, lng: city.location!.lng })
  // "Export as V2" still produces valid files that read back as the projection.
  const exported = serializeV2(canonical, v2Meta)
  assert.deepEqual(validateV2Files(exported), [])
  assert.deepEqual(readV2(exported), canonical)
})

/** 2,000 places (200 countries, 1,800 cities), 6,000 footprint records (every tenth planned,
 * journeys of five), 2,000 want-to-go items and 5,000 media items, all invented. */
function scaleFixture(): V2Files {
  const files = publicBridgeFixture(), placeId = sequentialUuids(Date.UTC(2027, 0, 1))
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const countries = Array.from({ length: 200 }, (_, n) => ({
    id: placeId(), subtype: 'country' as const, names: { en: `Country ${n}` }, externalIds: { iso3166Alpha2: letters[Math.floor(n / 26) % 26] + letters[n % 26] },
    location: { lat: (n % 170) - 85, lng: (n % 350) - 175 },
  }))
  const cities = Array.from({ length: 1800 }, (_, n) => ({
    id: placeId(), subtype: 'city' as const, names: { en: `City ${n}`, 'zh-Hans': `城市 ${n}` }, partOf: countries[n % 200].id,
    location: { lat: ((n * 7) % 170) - 85, lng: ((n * 11) % 350) - 175 },
  }))
  files.places.places = [...countries, ...cities]
  files.travel.records = Array.from({ length: 6000 }, (_, n) => ({
    id: `record-${n}`, placeId: cities[(n * 13) % 1800].id, start_date: `20${10 + (n % 15)}-0${1 + (n % 9)}-1${n % 10}`, year: 2010 + (n % 15),
    trip_title: `Trip ${Math.floor(n / 5)}`, type: 'visit', status: n % 10 === 9 ? 'planned' : 'visited', notes: `Note ${n}`,
    ...(n % 10 === 9 ? {} : { journeyId: `journey-${Math.floor(n / 5)}` }), ...(n % 50 === 0 ? { hiddenFromHome: true } : {}),
  }))
  files.wantToGo.items = Array.from({ length: 2000 }, (_, n) => ({
    id: `wtg_${n}`, placeId: (n % 2 ? cities[n % 1800] : countries[n % 200]).id, addedAt: '2026-01-0' + (1 + (n % 9)), hidden: n % 10 === 0, source: 'synthetic',
  }))
  files.media = { schemaVersion: 3, items: Array.from({ length: 5000 }, (_, n) => ({
    id: `media-${n}`, kind: 'photo', scope: 'city', placeId: cities[n % 1800].id, src: `/synthetic/${n}.webp`, status: 'ready', isCover: false,
  })) } as V2Files['media']
  const e = files.editorState
  e.addedCountries = countries.slice(0, 50).map((c, n) => ({ placeId: c.id, ...(n % 2 ? { visitedDate: '2020-01-01' } : {}) }))
  e.countryOrder = countries.map(c => c.id)
  e.hiddenMediaIds = Array.from({ length: 100 }, (_, n) => `media-${n * 50}`)
  e.mediaOrderByCity = Object.fromEntries(cities.slice(0, 100).map((c, n) => [c.id, [`media-${n}`, `media-${n + 1800}`]]))
  e.coverMediaByCity = Object.fromEntries(cities.slice(0, 100).map((c, n) => [c.id, `media-${n + 1800}`]))
  return files
}

test('scale: 2,000 places, 6,000 records, 2,000 want-to-go items, 5,000 media (timings recorded, not asserted)', (t) => {
  const files = scaleFixture()
  assert.deepEqual(validateV2Files(files), [])
  const clock = () => performance.now()
  let at = clock()
  const result = migrateV2(files, { now: NOW, allocateId: allocatorFrom() })
  const migrateMs = clock() - at
  if (!result.ok) throw new Error('migration refused')
  at = clock()
  const empty = emptyFormalState(), changeSet = planCommands(memoryReader(empty), result.commands, { baseRevision: 0, now: NOW, policy: OFFICIAL_POLICY })
  const planMs = clock() - at
  // applyChangeSet is the reference executor and looks every upserted id up in its table
  // (quadratic at this size). Into an empty store, with creates only, its result is the
  // upserts grouped by table, which is what a host would write.
  assert.deepEqual(changeSet.deletes, [])
  const tables = Object.fromEntries(FORMAL_TABLES.map(table => [table, [] as FormalRow[]])) as Record<FormalTable, FormalRow[]>
  for (const { table, row } of changeSet.upserts) tables[table].push(row)
  const state = { ...empty, ...tables, revision: changeSet.nextRevision } as FormalState
  at = clock()
  const projection = project(state)
  const projectMs = clock() - at
  t.diagnostic(`scale: ${result.commands.length} commands; migrateV2 ${migrateMs.toFixed(0)} ms, planCommands ${planMs.toFixed(0)} ms, projectStoreToCanonical ${projectMs.toFixed(0)} ms`)
  assert.deepEqual(projection.canonical, readV2(files))
  assert.deepEqual(projection.skipped, [])
})
