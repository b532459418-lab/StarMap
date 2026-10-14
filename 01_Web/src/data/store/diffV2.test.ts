/// <reference types="node" />
/**
 * The incremental write path of the new-library mode (3C-4a spec §2.1): a V2 write function runs on the store's V2 view,
 * diffV2ToCommands turns the difference into commands, planCommands and applyChangeSet write them, and the projection
 * must equal readV2 of the files after the write — for each of the eight editor writes, for a random sequence of 240
 * writes (fixed seed) against the same sequence in V2 mode, and when positions run out.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFormalState } from '../../worldgraph/store/formal.ts'
import { positionBetween } from '../../worldgraph/store/position.ts'
import { applyChangeSet, planCommands } from '../../worldgraph/store/planner.ts'
import { memoryReader } from '../../worldgraph/store/reader.ts'
import { readV2 } from '../canonical/v2Reader.ts'
import { serializeV2 } from '../canonical/v2Serializer.ts'
import type { V2Files } from '../canonical/v2Schema.ts'
import { sequentialUuids } from '../canonical/v2.fixture.ts'
import {
  V2WriteError, addCountry, addTravelRecord, addWantToGo, convertToTravel, deleteHiddenCountries, deleteHiddenWantToGo, putEditorState,
  readEditorStateV1, updateWantToGo,
} from '../v2write/index.ts'
import type { V2WriteContext, V2WriteOutcome } from '../v2write/transaction.ts'
import { WRITE_EPOCH_MS, WRITE_NOW, migratedFiles, placeNamed, testContext } from '../v2write/v2write.fixture.ts'
import { OFFICIAL, OFFICIAL_POLICY, VIEW_SCOPES } from './officialDefinitions.ts'
import { projectStoreToCanonical } from './projectCanonical.ts'
import { diffV2ToCommands, longestIncreasing, memoryDiffReader, positionsForRuns } from './diffV2.ts'
import { commitDiff, filesAfter, storeFrom, viewOf, writeThroughStore, type StoreUnderTest } from './diffV2.fixture.ts'
import { edgeCaseFixture } from './v2Store.fixture.ts'
import { listPositions } from './v2RecordRows.ts'

type Run = (files: V2Files, ctx: V2WriteContext) => V2WriteOutcome<unknown>

/** The projection of the store equals readV2 of the files after the write, and serializes back to those files. */
function assertParity(store: StoreUnderTest, after: V2Files, message = '') {
  const projection = projectStoreToCanonical(store.state, { source: 'local' })
  assert.deepEqual(projection.canonical, readV2(after), `projection = readV2(after) ${message}`)
  assert.deepEqual(serializeV2(projection.canonical, projection.v2Meta), after, `serializeV2(projection) = after ${message}`)
  assert.deepEqual(projection.skipped, [], `nothing skipped ${message}`)
  // The store stays valid under the full check.
  readFormalState(JSON.parse(JSON.stringify(store.state)), OFFICIAL_POLICY)
}

const ctxAt = (minute: number, newId = sequentialUuids(WRITE_EPOCH_MS + minute * 1000)): V2WriteContext =>
  testContext({ newId, now: new Date(WRITE_NOW.getTime() + minute * 60_000) })

/** Run `steps` one after the other on a fresh store from `files`, checking parity after each. */
function scenario(name: string, files: () => V2Files, steps: readonly (readonly [string, (view: V2Files) => Run])[]) {
  test(`parity: ${name}`, () => {
    const store = storeFrom(files())
    steps.forEach(([label, make], index) => {
      const { after, diff } = writeThroughStore(store, make(store.view), ctxAt(index + 1))
      assert.ok(diff.commands.length > 0, `${label}: commands`)
      assertParity(store, after, label)
    })
  })
}

const idOf = (files: V2Files, en: string, subtype?: 'country' | 'city') => placeNamed(files, en, subtype).id
const wishAt = (files: V2Files, en: string) => files.wantToGo.items.find(item => item.placeId === idOf(files, en))!
const editorState = (files: V2Files) => readEditorStateV1(files, WRITE_NOW)

// --- The eight editor writes (spec §2.1: each one, parity with readV2 after the write).

scenario('POST /records: a new country and city by name, then an existing city joining an existing journey', migratedFiles, [
  ['named Tokyo', () => (files, ctx) => addTravelRecord(files, {
    country: '日本', country_en: 'Japan', city: '东京', city_en: 'Tokyo', start_date: '2026-05-01', end_date: '2026-05-03', lat: 35.68, lng: 139.69, country_code: 'JP',
  }, ctx)],
  ['Nuuk joins the North Atlantic journey', () => (files, ctx) => addTravelRecord(files, {
    placeId: idOf(files, 'Nuuk'), start_date: '2025-06-20', trip_title: '2025 North Atlantic Demo', journeyId: '2025-north-atlantic-demo', lat: 64.18, lng: -51.72,
  }, ctx)],
  ['Kyoto with a new journey of the same title', () => (files, ctx) => addTravelRecord(files, {
    country: '日本', country_en: 'Japan', city: '京都', city_en: 'Kyoto', start_date: '2026-05-04', lat: 35.01, lng: 135.77, country_code: 'JP',
    trip_title: '日本 · 东京', newJourney: true,
  }, ctx)],
])

scenario('POST /countries: a new country, and a country that only a want-to-go item knew', migratedFiles, [
  ['Denmark', () => (files, ctx) => addCountry(files, { countryCode: 'DK', visitedDate: '2024-03-02' }, ctx)],
  ['Greenland', () => (files, ctx) => addCountry(files, { countryCode: 'GL', visitedDate: '2027-01-02' }, ctx)],
])

scenario('PUT /state: orders, hidden lists, covers and drone order', migratedFiles, [
  ['every list', (view) => (files, ctx) => {
    const state = editorState(view)
    const iceland = idOf(view, 'Iceland'), reykjavik = idOf(view, 'Reykjavik'), torshavn = idOf(view, 'Torshavn')
    return putEditorState(files, {
      ...state,
      countryOrder: [...state.countryOrder].reverse(),
      hiddenCountryIds: [idOf(view, 'Norway')],
      cityOrderByCountry: { [iceland]: [idOf(view, 'Akureyri'), reykjavik, idOf(view, 'Vik')] },
      hiddenCityIds: [],
      mediaOrderByCity: { [reykjavik]: ['photo-reykjavik-2', 'photo-reykjavik-1'] },
      hiddenMediaIds: ['photo-reykjavik-1', 'synthetic-missing'],
      coverMediaByCity: { [reykjavik]: 'photo-reykjavik-1', [torshavn]: 'synthetic-missing-cover' },
      droneOrderByCity: { [torshavn]: ['drone-torshavn-1'] },
      hiddenDroneMediaIds: ['drone-torshavn-1'],
    }, ctx)
  }],
  ['back to the first state', () => (files, ctx) => putEditorState(files, { ...editorState(migratedFiles()) }, ctx)],
])

scenario('POST /countries/delete: a hidden country with a planned record; then a whole new country with its journey', migratedFiles, [
  ['hide Norway', (view) => (files, ctx) => putEditorState(files, { ...editorState(view), hiddenCountryIds: [idOf(view, 'Norway')] }, ctx)],
  ['delete Norway', (view) => (files, ctx) => deleteHiddenCountries(files, { ids: [idOf(view, 'Norway')] }, ctx)],
  ['Tokyo', () => (files, ctx) => addTravelRecord(files, {
    country: '日本', country_en: 'Japan', city: '东京', city_en: 'Tokyo', start_date: '2026-05-01', lat: 35.68, lng: 139.69, country_code: 'JP',
  }, ctx)],
  ['hide Japan with a city order', (view) => (files, ctx) => putEditorState(files, {
    ...editorState(view), hiddenCountryIds: [idOf(view, 'Japan')], cityOrderByCountry: { [idOf(view, 'Japan')]: [idOf(view, 'Tokyo')] },
  }, ctx)],
  ['delete Japan', (view) => (files, ctx) => deleteHiddenCountries(files, { ids: [idOf(view, 'Japan')] }, ctx)],
  ['Japan again (new place ids)', () => (files, ctx) => addCountry(files, { countryCode: 'JP', visitedDate: '2027-04-01' }, ctx)],
])

scenario('POST /countries/delete: an added country whose place stays (a want-to-go item), added again', migratedFiles, [
  ['Greenland', () => (files, ctx) => addCountry(files, { countryCode: 'GL', visitedDate: '2027-01-02' }, ctx)],
  ['hide Greenland', (view) => (files, ctx) => putEditorState(files, { ...editorState(view), hiddenCountryIds: [idOf(view, 'Greenland')] }, ctx)],
  ['delete Greenland', (view) => (files, ctx) => deleteHiddenCountries(files, { ids: [idOf(view, 'Greenland')] }, ctx)],
  // The same place id again: its evidence id is tombstoned, so the next id of the chain is used.
  ['Greenland again', () => (files, ctx) => addCountry(files, { countryCode: 'GL', visitedDate: '2027-02-03' }, ctx)],
])

scenario('POST /wanttogo: a new city by name, an existing city by id, and a country', migratedFiles, [
  ['Osaka', () => (files, ctx) => addWantToGo(files, { place: { kind: 'city', nameZh: '大阪', nameEn: 'Osaka', countryCode: 'JP', lat: 34.69, lng: 135.5 }, note: 'Synthetic' }, ctx)],
  ['Bergen', (view) => (files, ctx) => addWantToGo(files, { placeId: idOf(view, 'Bergen'), addedAt: '2026-01-02' }, ctx)],
  ['Greenland gets a location', () => (files, ctx) => addWantToGo(files, { place: { kind: 'country', nameEn: 'Greenland', countryCode: 'GL', lat: 72, lng: -40 } }, ctx)],
])

scenario('POST /wanttogo/update: note, hide, unhide, remove the note', migratedFiles, [
  ['note', (view) => (files, ctx) => updateWantToGo(files, { id: wishAt(view, 'Nuuk').id, note: '  Synthetic note  ' }, ctx)],
  ['hide', (view) => (files, ctx) => updateWantToGo(files, { id: wishAt(view, 'Nuuk').id, hidden: true }, ctx)],
  ['unhide and drop the note', (view) => (files, ctx) => updateWantToGo(files, { id: wishAt(view, 'Nuuk').id, hidden: false, note: '' }, ctx)],
  ['hide again (a new view row)', (view) => (files, ctx) => updateWantToGo(files, { id: wishAt(view, 'Nuuk').id, hidden: true }, ctx)],
])

scenario('POST /wanttogo/delete: a hidden item and the place only it used', migratedFiles, [
  ['Tromsø', (view) => (files, ctx) => deleteHiddenWantToGo(files, { ids: [wishAt(view, 'Tromsø').id] }, ctx)],
])

scenario('POST /wanttogo/convert: a want-to-go item, kept and removed; a planned record', migratedFiles, [
  ['Nuuk kept', (view) => (files, ctx) => convertToTravel(files, { source: 'want-to-go', id: wishAt(view, 'Nuuk').id, startDate: '2026-07-01', keepWantToGo: true }, ctx)],
  ['planned Bergen', (view) => (files, ctx) => convertToTravel(files, {
    source: 'planned', recordId: view.travel.records.find(r => r.placeId === idOf(view, 'Bergen'))!.id, startDate: '2026-08-01', endDate: '2026-08-03',
  }, ctx)],
])

scenario('POST /wanttogo/convert: removed want-to-go item joining an existing journey', migratedFiles, [
  ['Osaka', () => (files, ctx) => addWantToGo(files, { place: { kind: 'city', nameZh: '大阪', nameEn: 'Osaka', countryCode: 'JP', lat: 34.69, lng: 135.5 } }, ctx)],
  ['Osaka joins', (view) => (files, ctx) => convertToTravel(files, {
    source: 'want-to-go', id: wishAt(view, 'Osaka').id, startDate: '2025-06-25', tripTitle: '2025 North Atlantic Demo', journeyId: '2025-north-atlantic-demo',
  }, ctx)],
])

scenario('3C-1b edge cases: unresolved and repeated list elements, kept titles, a planned record converted', edgeCaseFixture, [
  ['editor lists with unresolved elements', (view) => (files, ctx) => {
    const state = editorState(view)
    const [a] = Object.keys(state.mediaOrderByCity)
    return putEditorState(files, {
      ...state,
      hiddenMediaIds: ['synthetic-missing', ...state.hiddenMediaIds, 'synthetic-missing'],
      mediaOrderByCity: { ...state.mediaOrderByCity, [a]: ['synthetic-missing', 'synthetic-photo'] },
      countryOrder: [...state.countryOrder].reverse(),
    }, ctx)
  }],
  ['the planned record that shares its id with a want-to-go item', () => (files, ctx) => convertToTravel(files, { source: 'planned', recordId: 'shared-id', startDate: '2027-03-01' }, ctx)],
  ['the want-to-go item with that id', () => (files, ctx) => updateWantToGo(files, { id: 'shared-id', note: 'Synthetic', hidden: true }, ctx)],
])

test('entries created as starmap:user (no position in the original order): updated by id, and an append renumbers the scope', () => {
  const store = storeFrom(migratedFiles())
  const city = idOf(store.view, 'Bergen')
  const userId = '01960000-0000-7000-8000-00000000c002', now = '2026-09-27T07:00:00.000Z'
  const changeSet = planCommands(memoryReader(store.state), [{ op: 'create', table: 'entries', value: {
    id: userId, revision: 0, layerId: OFFICIAL.wantToGo, entityId: city, fields: { addedAt: '2026-09-20' },
    source: { sourceId: OFFICIAL.user, recordId: userId, evidenceIds: [] }, createdAt: now, updatedAt: now,
  } }], { baseRevision: store.state.revision, now, policy: OFFICIAL_POLICY })
  store.state = applyChangeSet(store.state, changeSet)
  store.view = viewOf(store.state)
  assert.equal(store.view.wantToGo.items.at(-1)!.id, userId, 'projected after the positioned items, with its entry id')
  const note = writeThroughStore(store, (files, ctx) => updateWantToGo(files, { id: userId, note: 'Synthetic later', hidden: true }, ctx), ctxAt(1))
  assertParity(store, note.after)
  const added = writeThroughStore(store, (files, ctx) => addWantToGo(files, { placeId: idOf(files, 'Reykjavik') }, ctx), ctxAt(2))
  assert.deepEqual(added.diff.renumbered, [VIEW_SCOPES.wantToGoOrder], 'the neighbour has no position')
  assertParity(store, added.after)
  const removed = writeThroughStore(store, (files, ctx) => deleteHiddenWantToGo(files, { ids: [userId] }, ctx), ctxAt(3))
  assertParity(store, removed.after)
})

// --- Only the rows that change are written.

test('a want-to-go note is one entry update and the file header; a drag in a list updates the one row that moved', () => {
  const store = storeFrom(migratedFiles())
  const wish = wishAt(store.view, 'Nuuk')
  const note = writeThroughStore(store, (files, ctx) => updateWantToGo(files, { id: wish.id, note: 'Synthetic' }, ctx), ctxAt(1))
  assert.deepEqual(note.diff.commands.map(c => [c.op, c.table]), [['update', 'sources'], ['update', 'entries']])
  assertParity(store, note.after)

  const state = editorState(store.view)
  const order = [...state.countryOrder]
  assert.equal(order.length, 2)
  const drag = writeThroughStore(store, (files, ctx) => putEditorState(files, { ...state, countryOrder: [order[1], order[0]] }, ctx), ctxAt(2))
  assert.deepEqual(drag.diff.commands.map(c => [c.op, c.table]), [['update', 'sources'], ['update', 'viewItems']])
  assert.deepEqual(drag.diff.renumbered, [])
  assertParity(store, drag.after)

  // A save without any change writes the header only.
  const same = writeThroughStore(store, (files, ctx) => putEditorState(files, editorState(files), ctx), ctxAt(3))
  assert.deepEqual(same.diff.commands.map(c => [c.op, c.table]), [['update', 'sources']])
})

test('a new record is appended with positionBetween(last position, undefined)', () => {
  const store = storeFrom(migratedFiles())
  const lastPosition = (scope: string) => store.state.viewItems.filter(item => item.scope === scope).map(item => item.position).sort().at(-1)!
  const before = lastPosition(VIEW_SCOPES.wantToGoOrder)
  const { after } = writeThroughStore(store, (files, ctx) => addWantToGo(files, { placeId: idOf(files, 'Bergen') }, ctx), ctxAt(1))
  const added = store.state.entries.find(entry => entry.source.recordId === after.wantToGo.items.at(-1)!.id)!
  const row = store.state.viewItems.find(item => item.scope === VIEW_SCOPES.wantToGoOrder && item.itemId === added.id)!
  assert.equal(row.position, positionBetween(before, undefined))
  assert.equal(row.layerId, OFFICIAL.wantToGo)
})

// --- Positions that run out: the scope is renumbered in the same batch.

/** Put a 64-character key on the last row of `scope` (the longest a key may be; nothing fits after it). */
function exhaust(store: StoreUnderTest, scope: string) {
  const rows = store.state.viewItems.filter(item => item.scope === scope).sort((a, b) => (a.position < b.position ? -1 : 1))
  const last = rows.at(-1)!
  const now = '2026-09-27T07:00:00.000Z'
  const changeSet = planCommands(memoryReader(store.state), [
    { op: 'update', table: 'viewItems', id: last.id, expectedRevision: last.revision, value: { ...last, revision: last.revision + 1, position: 'z'.repeat(64) } },
  ], { baseRevision: store.state.revision, now, policy: OFFICIAL_POLICY })
  store.state = applyChangeSet(store.state, changeSet)
  assert.deepEqual(viewOf(store.state), store.view, 'the order is unchanged')
  assert.throws(() => positionBetween('z'.repeat(64)), { code: 'E_POSITION' })
  return rows.length
}

test('an original-order scope whose positions ran out is renumbered with listPositions in the same batch', () => {
  const store = storeFrom(migratedFiles())
  const count = exhaust(store, VIEW_SCOPES.wantToGoOrder)
  const { after, diff } = writeThroughStore(store, (files, ctx) => addWantToGo(files, { placeId: idOf(files, 'Bergen') }, ctx), ctxAt(1))
  assert.deepEqual(diff.renumbered, [VIEW_SCOPES.wantToGoOrder])
  const rows = store.state.viewItems.filter(item => item.scope === VIEW_SCOPES.wantToGoOrder)
  assert.equal(rows.length, count + 1)
  assert.ok(rows.every(row => row.position.length <= 2), 'short keys again')
  assertParity(store, after)
})

test('a list whose positions ran out is renumbered; only rows whose position changes are written', () => {
  const store = storeFrom(migratedFiles())
  exhaust(store, VIEW_SCOPES.countryOrder)
  const state = editorState(store.view)
  const greenland = idOf(store.view, 'Greenland')
  const { after, diff } = writeThroughStore(store, (files, ctx) => putEditorState(files, { ...state, countryOrder: [...state.countryOrder, greenland] }, ctx), ctxAt(1))
  assert.deepEqual(diff.renumbered, [VIEW_SCOPES.countryOrder])
  // Both rows take keys of listPositions(3) and one row is new; nothing else of the store is written.
  assert.deepEqual(diff.commands.map(c => [c.op, c.table]), [['update', 'sources'], ['update', 'viewItems'], ['update', 'viewItems'], ['create', 'viewItems']])
  const positions = store.state.viewItems.filter(item => item.scope === VIEW_SCOPES.countryOrder).map(item => item.position).sort()
  assert.deepEqual(positions, [...listPositions(3)])
  assertParity(store, after)
})

test('position helpers: runs between kept neighbours, and the longest increasing run', () => {
  const run = [...longestIncreasing([3, undefined, 0, 1, 4, 2]).keys()].sort()
  assert.equal(run.length, 3)
  assert.deepEqual(run.slice(0, 2), [2, 3], 'values 0, 1 and then 4 or 2')
  assert.deepEqual([...longestIncreasing([]).keys()], [])
  const kept = new Map([[1, 'V'], [3, 'X']])
  const positions = positionsForRuns(5, (i) => kept.has(i), (i) => kept.get(i)!)!
  assert.ok(positions.get(0)! < 'V' && 'V' < positions.get(2)! && positions.get(2)! < 'X' && 'X' < positions.get(4)!)
  assert.equal(positionsForRuns(2, (i) => i === 0, () => null), undefined, 'a neighbour without a position: renumber')
  assert.equal(positionsForRuns(2, (i) => i === 0, () => 'z'.repeat(64)), undefined, 'no room: renumber')
})

// --- The diff refuses what it cannot express, and a view that does not match the store.

test('media changes are refused (3C-4c); a view that does not match the store is E_VIEW_MISMATCH', () => {
  const store = storeFrom(migratedFiles())
  const context = { reader: memoryDiffReader(store.state), now: '2026-09-27T08:00:00.000Z', allocateId: store.allocateId }
  const media = structuredClone(store.view)
  media.media.items.pop()
  assert.throws(() => diffV2ToCommands(store.view, media, context), { code: 'E_DIFF_UNSUPPORTED' })
  const ghost = structuredClone(store.view)
  ghost.wantToGo.items.push({ ...ghost.wantToGo.items[0], id: 'synthetic-ghost' })
  const changed = structuredClone(ghost)
  changed.wantToGo.items.at(-1)!.note = 'Synthetic'
  assert.throws(() => diffV2ToCommands(ghost, changed, context), { code: 'E_VIEW_MISMATCH' })
})

// --- Random sequence (fixed seed): the store after every step equals V2 mode after the same steps.

/** Mulberry32: a small deterministic generator. */
function random(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (n: number) => Math.floor(next() * n)
  const pick = <T,>(values: readonly T[]): T | undefined => (values.length ? values[int(values.length)] : undefined)
  const shuffle = <T,>(values: readonly T[]): T[] => {
    const out = [...values]
    for (let i = out.length - 1; i > 0; i--) { const j = int(i + 1); [out[i], out[j]] = [out[j], out[i]] }
    return out
  }
  return { next, int, pick, shuffle, chance: (p: number) => next() < p }
}

const COUNTRY_CODES = ['IS', 'FO', 'NO', 'GL', 'JP', 'DK', 'CN']
const CITY_NAMES = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta']
const TITLES = ['Synthetic trip A', 'Synthetic trip B', undefined]
const dateOf = (rng: ReturnType<typeof random>) => `20${20 + rng.int(8)}-0${1 + rng.int(9)}-1${rng.int(9)}`

/** One random write of the eight, chosen from the current V2 files (the same input runs in both modes). */
function randomWrite(rng: ReturnType<typeof random>, files: V2Files): [string, Run] {
  const places = files.places.places
  const cities = places.filter(p => p.subtype === 'city'), countries = places.filter(p => p.subtype === 'country')
  const state = editorState(files)
  // The input is drawn here, once: both modes run the same request.
  const write = (label: string, run: (files: V2Files, input: unknown, ctx: V2WriteContext) => V2WriteOutcome<unknown>, input: unknown): [string, Run] =>
    [label, (f, ctx) => run(f, structuredClone(input), ctx)]
  switch (rng.int(10)) {
    case 0: {
      const title = rng.pick(TITLES)
      // Join an existing journey of the same title (when there is one), start a new one, or let the write ask.
      const journeys = [...new Set(files.travel.records.filter(r => r.status !== 'planned' && r.trip_title === title && r.journeyId).map(r => r.journeyId as string))]
      const choice = journeys.length && rng.chance(0.5) ? { journeyId: rng.pick(journeys)! } : rng.chance(0.3) ? { newJourney: true } : {}
      const city = rng.pick(cities)
      if (city && rng.chance(0.4)) return write('records/placeId', addTravelRecord, { placeId: city.id, start_date: dateOf(rng), lat: 10, lng: 20, trip_title: title, ...choice })
      const code = rng.pick(COUNTRY_CODES)!
      return write('records/named', addTravelRecord, {
        country: code, country_en: code, city: rng.pick(CITY_NAMES)!, city_en: `${rng.pick(CITY_NAMES)} ${rng.int(1000)}`, start_date: dateOf(rng),
        lat: rng.int(80), lng: rng.int(170), country_code: code, trip_title: title, ...(rng.chance(0.3) ? { createNew: true } : {}), ...choice,
      })
    }
    case 1: return write('countries', addCountry, { countryCode: rng.pick(COUNTRY_CODES), visitedDate: dateOf(rng) })
    case 2: {
      const hidden = state.hiddenCountryIds
      if (hidden.length && rng.chance(0.7)) return write('countries/delete', deleteHiddenCountries, { ids: [rng.pick(hidden)!] })
      const country = rng.pick(countries)
      return write('state/hide-country', putEditorState, { ...state, hiddenCountryIds: country ? [...new Set([...state.hiddenCountryIds, country.id])] : [] })
    }
    case 3: {
      const next = { ...state }
      next.countryOrder = rng.shuffle(state.countryOrder)
      const country = rng.pick(countries)
      if (country) {
        const own = cities.filter(c => c.partOf === country.id).map(c => c.id)
        next.cityOrderByCountry = { ...state.cityOrderByCountry, [country.id]: rng.shuffle(own).slice(0, rng.int(own.length + 1)) }
      }
      next.hiddenCityIds = rng.shuffle(cities.map(c => c.id)).slice(0, rng.int(3))
      const mediaIds = [...files.media.items.map(m => m.id), 'synthetic-missing']
      next.hiddenMediaIds = rng.shuffle(mediaIds).slice(0, rng.int(3))
      const city = rng.pick(cities)
      if (city && rng.chance(0.5)) next.coverMediaByCity = { ...state.coverMediaByCity, [city.id]: rng.pick(mediaIds)! }
      if (city && rng.chance(0.3)) next.mediaOrderByCity = { ...state.mediaOrderByCity, [city.id]: rng.shuffle(mediaIds).slice(0, 2) }
      if (rng.chance(0.2)) next.droneOrderByCity = {}
      return write('state/lists', putEditorState, next)
    }
    case 4: case 5: {
      const place = rng.pick(places)
      if (place && rng.chance(0.5)) return write('wanttogo/placeId', addWantToGo, { placeId: place.id, ...(rng.chance(0.5) ? { note: 'Synthetic' } : {}) })
      const kind = rng.chance(0.7) ? 'city' : 'country'
      return write('wanttogo/named', addWantToGo, {
        place: { kind, nameEn: `${rng.pick(CITY_NAMES)} ${rng.int(1000)}`, countryCode: rng.pick(COUNTRY_CODES), ...(rng.chance(0.5) ? { lat: rng.int(80), lng: rng.int(170) } : {}) },
        ...(rng.chance(0.4) ? { createNew: true } : {}),
      })
    }
    case 6: {
      const item = rng.pick(files.wantToGo.items)
      return write('wanttogo/update', updateWantToGo, {
        id: item?.id ?? 'synthetic-missing', ...(rng.chance(0.6) ? { hidden: rng.chance(0.5) } : { note: rng.chance(0.7) ? `Synthetic ${rng.int(100)}` : '' }),
      })
    }
    case 7: {
      const hidden = files.wantToGo.items.filter(item => item.hidden)
      return write('wanttogo/delete', deleteHiddenWantToGo, { ids: hidden.length ? [rng.pick(hidden)!.id] : ['synthetic-missing'] })
    }
    default: {
      const planned = files.travel.records.filter(r => r.status === 'planned')
      if (planned.length && rng.chance(0.3)) return write('convert/planned', convertToTravel, { source: 'planned', recordId: rng.pick(planned)!.id, startDate: dateOf(rng) })
      // Mostly items that can be converted (a visible city with coordinates and no record yet), sometimes any item.
      const placeOf = new Map(places.map(p => [p.id, p]))
      const convertible = files.wantToGo.items.filter(i => !i.hidden && placeOf.get(i.placeId)?.subtype === 'city' && placeOf.get(i.placeId)?.location
        && !files.travel.records.some(r => r.placeId === i.placeId))
      const item = rng.pick(convertible.length && rng.chance(0.8) ? convertible : files.wantToGo.items)
      return write('convert/want-to-go', convertToTravel, {
        source: 'want-to-go', id: item?.id ?? 'synthetic-missing', startDate: dateOf(rng), tripTitle: rng.pick(TITLES), keepWantToGo: rng.chance(0.3),
        ...(rng.chance(0.4) ? { newJourney: true } : {}),
      })
    }
  }
}

test('random sequence of 240 writes (seed 3404): after every step the store equals V2 mode after the same steps', (t) => {
  const rng = random(3404)
  const store = storeFrom(migratedFiles())
  let v2 = migratedFiles()
  const tally = new Map<string, { ok: number; refused: number }>()
  let renumbers = 0
  for (let step = 1; step <= 240; step++) {
    const [label, run] = randomWrite(rng, v2)
    const minute = step
    // Both modes get the same id sequence and time.
    const v2Ctx = ctxAt(minute), storeCtx = ctxAt(minute)
    let v2Outcome: V2WriteOutcome<unknown> | undefined, v2Error: unknown
    try { v2Outcome = run(v2, v2Ctx) } catch (error) { v2Error = error }
    let storeOutcome: V2WriteOutcome<unknown> | undefined, storeError: unknown
    const before = store.view
    try { storeOutcome = run(before, storeCtx) } catch (error) { storeError = error }
    const count = tally.get(label) ?? { ok: 0, refused: 0 }
    tally.set(label, count)
    if (v2Error !== undefined || storeError !== undefined) {
      assert.ok(v2Error instanceof V2WriteError && storeError instanceof V2WriteError, `step ${step} ${label}: ${String(v2Error)} / ${String(storeError)}`)
      assert.equal(storeError.code, v2Error.code, `step ${step} ${label}`)
      count.refused++
      continue
    }
    count.ok++
    assert.deepEqual(storeOutcome!.result, v2Outcome!.result, `step ${step} ${label}: result`)
    v2 = filesAfter(v2, v2Outcome!.writes)
    const after = filesAfter(before, storeOutcome!.writes)
    // Every other step diffs deep copies (no file shared by reference) to exercise the slow path too.
    const diff = step % 2 ? commitDiff(store, before, after, storeCtx.now.toISOString()) : commitDiff(store, structuredClone(before), structuredClone(after), storeCtx.now.toISOString())
    renumbers += diff.renumbered.length
    store.view = after
    const projection = projectStoreToCanonical(store.state, { source: 'local' })
    assert.deepEqual(projection.canonical, readV2(v2), `step ${step} ${label}: store = V2 mode`)
    assert.deepEqual(projection.canonical, readV2(after), `step ${step} ${label}: store = its view`)
  }
  readFormalState(JSON.parse(JSON.stringify(store.state)), OFFICIAL_POLICY)
  // Every write kind ran and was saved at least once.
  for (const label of ['records/named', 'countries', 'countries/delete', 'state/lists', 'wanttogo/named', 'wanttogo/update', 'wanttogo/delete', 'convert/want-to-go']) {
    assert.ok((tally.get(label)?.ok ?? 0) > 0, `${label} saved at least once: ${JSON.stringify([...tally])}`)
  }
  assert.equal(renumbers, 0, 'no renumbering in 240 steps')
  t.diagnostic(`saved / refused per write: ${[...tally].sort().map(([label, n]) => `${label} ${n.ok}/${n.refused}`).join(', ')}`)
})
