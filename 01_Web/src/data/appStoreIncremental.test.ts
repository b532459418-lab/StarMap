/// <reference types="node" />
/**
 * ③ (scope-incremental design §5): a snapshot moved on by a commit's changed rows equals, byte for byte, the snapshot
 * computed again from the whole read model, and shares the earlier snapshot's objects as it should:
 *
 * - G1: random sequences of the eight editor writes through the store-native planners (as the page's saves);
 * - G2: one step for each kind of save (design §3.1), the media records and an external writer's commits included, with
 *   the parts each kind must keep;
 * - G3: changed rows drawn directly, not through a planner (rows that change scope, layer, type, duplicates, deletions,
 *   and rows that must make the official view start over).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readModelOf } from '../worldgraph/readModel/build.ts'
import { liveReadModelIndex } from '../worldgraph/readModel/liveIndex.ts'
import { readModelChangesBetween } from '../worldgraph/readModel/delta.ts'
import { applyChangeSet, planCommands, type ChangeSet } from '../worldgraph/store/planner.ts'
import { memoryReader } from '../worldgraph/store/reader.ts'
import type { FormalCommand, FormalState } from '../worldgraph/store/formal.ts'
import type { ReadModel } from '../worldgraph/readModel/types.ts'
import { computeSnapshot, createAppStore, type AppSnapshot } from './appStoreCore.ts'
import { doubleRunStore, random, randomStep, stepContext } from './editor/doubleRun.fixture.ts'
import { NATIVE_WRITES } from './editor/native/routes.ts'
import { viewOf } from './store/v2Store.fixture.ts'
import { OFFICIAL, OFFICIAL_POLICY, V2_SOURCES, VIEW_SCOPES, mapListScope } from './store/officialDefinitions.ts'
import { OFFICIAL_VIEW_INPUTS, WHOLE_OFFICIAL_VIEW, rowAffects, scopeAffects } from './store/projectCanonical.ts'
import { officialReader } from './store/officialReader.ts'
import { createMediaRecordCommands, removeMediaRecordCommands, rereadMediaRecordCommands } from './store/mediaRecords.ts'
import { memoryScopeReader } from './store/scopeReader.ts'
import { sequentialUuids } from './canonical/v2.fixture.ts'
import { migratedFiles } from './editor/editor.fixture.ts'
import type { CanonicalMediaItem } from './canonical/types.ts'
import {
  IDENTITY, OPTIONS, askQueries, assertIncrementalStep, changesOf, modelAfter, randomRowChange, sharingViolations, type AskedQueries,
} from './appStoreIncremental.fixture.ts'

const modelOf = (state: FormalState): ReadModel => readModelOf(state, { origin: 'local' })
const snapshotOf = (state: FormalState) => computeSnapshot(modelOf(state), { ...OPTIONS, identity: IDENTITY })
const storeOf = (state: FormalState) => {
  const store = createAppStore(snapshotOf(state), OPTIONS)
  // The first replace fills the store's caches (as the page's first load does).
  store.replace(modelOf(state), IDENTITY)
  return store
}
const changesOfSet = (changeSet: ChangeSet) => ({ ...changesOf(changeSet.baseRevision, changeSet.upserts, changeSet.deletes), to: changeSet.nextRevision })

/** One step on the store: its snapshot before and after, the queries asked before, and the check against the whole computation. */
function step(store: ReturnType<typeof createAppStore>, changes: ReturnType<typeof changesOfSet>, model: ReadModel, label: string) {
  const before = store.getSnapshot()
  const asked = askQueries(before)
  assert.equal(store.apply(changes), true, `${label}: applied`)
  const after = store.getSnapshot()
  assertIncrementalStep(before, after, model, label)
  return { before, after, asked }
}

/** The change set of `commands` on `state`. */
const commitCommands = (state: FormalState, commands: readonly FormalCommand[], n: number): ChangeSet =>
  planCommands(memoryReader(state), commands, { baseRevision: state.revision, now: stepContext(n).now.toISOString(), policy: OFFICIAL_POLICY })

/** The change set of one native editor write (`route` without the method and prefix), or undefined when it changes nothing. */
function commitWrite(state: FormalState, route: string, input: unknown, n: number): ChangeSet | undefined {
  const write = NATIVE_WRITES[`POST /__travelatlas/editor/${route}`]
  assert.ok(write, route)
  const plan = write.plan(officialReader(liveReadModelIndex(modelOf(state))), structuredClone(input), stepContext(n))
  return plan.commands.length ? commitCommands(state, plan.commands, n) : undefined
}

// ---- G1: random sequences of the editor writes ----

for (const seed of [3404, 5150, 7777]) {
  test(`G1: random editor writes, each step equal to the whole computation and sharing as today (seed ${seed}, 80 steps)`, () => {
    const rng = random(seed)
    let state = doubleRunStore(migratedFiles()).state
    const store = storeOf(state)
    let commits = 0
    for (let n = 1; n <= 80; n++) {
      const randomInput = randomStep(rng, viewOf(state))
      const write = NATIVE_WRITES[randomInput.route]
      assert.ok(write, randomInput.route)
      let changeSet: ChangeSet | undefined
      try {
        const plan = write.plan(officialReader(liveReadModelIndex(modelOf(state))), structuredClone(randomInput.input), stepContext(n))
        if (plan.commands.length) changeSet = commitCommands(state, plan.commands, n)
      } catch { /* refused: no commit */ }
      if (!changeSet) continue
      state = applyChangeSet(state, changeSet)
      const label = `seed ${seed} step ${n} (${randomInput.label})`
      const { before, after, asked } = step(store, changesOfSet(changeSet), modelOf(state), label)
      assert.deepEqual(sharingViolations(before, after, asked), [], `${label}: the parts whose inputs it kept`)
      commits++
    }
    assert.ok(commits >= 20, `commits: ${commits}`)
  })
}

// ---- G2: one step for each kind of save ----

interface Kind {
  readonly label: string
  /** The change set of the save on `state` (`n`: its step number, for its ids and time). */
  readonly commit: (state: FormalState, n: number) => ChangeSet
  /** The parts of the derived data and the queries this save must keep (design §5.1 group 3). */
  readonly keeps: readonly string[]
}

const placeIdsOf = (state: FormalState, subtype: 'country' | 'city') => viewOf(state).places.places.filter((place) => place.subtype === subtype).map((place) => place.id)
const canonicalOf = (state: FormalState) => snapshotOf(state).canonical
const swap = <T,>(list: readonly T[]): T[] => (list.length >= 2 ? [list[1], list[0], ...list.slice(2)] : [...list])
const write = (route: string, input: (state: FormalState) => unknown) => (state: FormalState, n: number) => {
  const changeSet = commitWrite(state, route, input(state), n)
  assert.ok(changeSet, `${route}: the save changes something`)
  return changeSet
}
const view = (operations: (state: FormalState) => unknown[]) => write('view', (state) => ({ operations: operations(state) }))
const MEDIA_KEEPS = ['travelAtlas', 'wantToGo', 'worldGraph', 'context', 'visible', 'visibleFiltered', 'browse', 'browseFiltered', 'collection']
const WISH_KEEPS = ['travelAtlas', 'editorState', 'mediaCatalog', 'droneMedia']
const photosOf = (state: FormalState) => canonicalOf(state).media.items.filter((item) => item.kind === 'photo')
const recordedCityIds = (state: FormalState) => new Set(viewOf(state).travel.records.map((record) => record.placeId))
const newPhoto = (placeId: string, name: string): CanonicalMediaItem => ({
  id: 'ignored', kind: 'photo', scope: 'city', placeId, src: `/media/user/${name}/original.jpg`, originalFileName: `${name}.jpg`,
  variants: { original: { src: `/media/user/${name}/original.jpg`, width: 4, height: 3 } }, width: 4, height: 3, isCover: false, status: 'ready',
} as unknown as CanonicalMediaItem)

const KINDS: readonly Kind[] = [
  { label: 'country order', commit: view((s) => { const order = canonicalOf(s).editorState.countryOrder as string[]; return [{ op: 'order', scope: 'countries', ids: swap(order), baseline: order }] }), keeps: ['mediaCatalog', 'droneMedia', 'wantToGo', 'context', 'browse', 'browseFiltered'] },
  {
    label: 'city order', keeps: ['mediaCatalog', 'droneMedia', 'wantToGo', 'context', 'browse', 'browseFiltered'],
    commit: view((s) => {
      const places = viewOf(s).places.places
      const country = places.find((place) => place.subtype === 'country' && places.filter((city) => city.partOf === place.id).length >= 2)!
      const own = places.filter((city) => city.partOf === country.id).map((city) => city.id)
      return [{ op: 'order', scope: 'cities', key: country.id, ids: swap(own), baseline: (canonicalOf(s).editorState.cityOrderByCountry as Record<string, string[]>)[country.id] ?? [] }]
    }),
  },
  { label: 'hide a country', commit: view((s) => [{ op: 'hide', scope: 'countries', add: [placeIdsOf(s, 'country')[0]], remove: [] }]), keeps: ['mediaCatalog', 'droneMedia', 'wantToGo'] },
  { label: 'show the hidden cities', commit: view((s) => [{ op: 'hide', scope: 'cities', add: [], remove: canonicalOf(s).editorState.hiddenCityIds }]), keeps: ['mediaCatalog', 'droneMedia', 'wantToGo'] },
  { label: 'hide a city', commit: view((s) => [{ op: 'hide', scope: 'cities', add: [placeIdsOf(s, 'city')[0]], remove: [] }]), keeps: ['mediaCatalog', 'droneMedia', 'wantToGo'] },
  {
    label: 'cover', keeps: MEDIA_KEEPS,
    commit: view((s) => {
      const covers = canonicalOf(s).editorState.coverMediaByCity as Record<string, string>
      const photo = photosOf(s).find((candidate) => covers[candidate.placeId] !== candidate.id)!
      return [{ op: 'cover', key: photo.placeId, id: photo.id }]
    }),
  },
  {
    label: 'photo order', keeps: MEDIA_KEEPS,
    commit: view((s) => {
      const photos = photosOf(s), city = photos[0].placeId, own = photos.filter((photo) => photo.placeId === city).map((photo) => photo.id)
      return [{ op: 'order', scope: 'media', key: city, ids: own.length >= 2 ? swap(own) : [...own, photos.find((photo) => photo.placeId !== city)?.id ?? own[0]], baseline: (canonicalOf(s).editorState.mediaOrderByCity as Record<string, string[]>)[city] ?? [] }]
    }),
  },
  { label: 'hide a photo', commit: view((s) => [{ op: 'hide', scope: 'media', add: [photosOf(s)[0].id], remove: [] }]), keeps: MEDIA_KEEPS },
  {
    label: 'drone order and hide', keeps: MEDIA_KEEPS,
    commit: view((s) => {
      const aerial = canonicalOf(s).media.items.find((item) => item.kind !== 'photo')!
      return [{ op: 'order', scope: 'drone', key: aerial.placeId, ids: [aerial.id], baseline: [] }, { op: 'hide', scope: 'drone', add: [aerial.id], remove: [] }]
    }),
  },
  { label: 'want-to-go note', commit: write('wanttogo/update', (s) => ({ id: canonicalOf(s).wantToGo.items[0].id, note: 'G2 note' })), keeps: [...WISH_KEEPS, 'context', 'browse', 'browseFiltered'] },
  { label: 'want-to-go hide (hide, maphide)', commit: write('wanttogo/update', (s) => ({ id: canonicalOf(s).wantToGo.items.find((item) => !item.hidden)!.id, hidden: true })), keeps: WISH_KEEPS },
  { label: 'want-to-go show', commit: write('wanttogo/update', (s) => ({ id: canonicalOf(s).wantToGo.items.find((item) => item.hidden)!.id, hidden: false })), keeps: WISH_KEEPS },
  {
    label: 'want-to-go added on an existing place', keeps: WISH_KEEPS,
    commit: write('wanttogo', (s) => { const wished = new Set(canonicalOf(s).wantToGo.items.map((item) => item.placeId)); return { placeId: placeIdsOf(s, 'city').find((id) => !wished.has(id)) } }),
  },
  { label: 'want-to-go added on a new city', commit: write('wanttogo', () => ({ place: { kind: 'city', nameEn: 'G2 Wishville', countryCode: 'IS', lat: 64.5, lng: -20.5 }, createNew: true })), keeps: [] },
  { label: 'want-to-go deleted (hidden)', commit: write('wanttogo/delete', (s) => ({ ids: [canonicalOf(s).wantToGo.items.find((item) => item.hidden)!.id] })), keeps: [] },
  {
    label: 'footprint on an existing city', keeps: ['mediaCatalog', 'droneMedia'],
    commit: write('records', (s) => ({ placeId: placeIdsOf(s, 'city').find((id) => !recordedCityIds(s).has(id)), start_date: '2025-06-11', lat: 10, lng: 20 })),
  },
  { label: 'footprint on a new city', commit: write('records', () => ({ country: 'IS', country_en: 'IS', city: '新城', city_en: 'G2 Newtown', start_date: '2025-07-12', lat: 63.9, lng: -21.9, country_code: 'IS', createNew: true })), keeps: [] },
  { label: 'planned record marked visited', commit: write('wanttogo/convert', (s) => ({ source: 'planned', recordId: viewOf(s).travel.records.find((record) => record.status === 'planned')!.id, startDate: '2026-04-01' })), keeps: ['mediaCatalog', 'droneMedia'] },
  {
    label: 'want-to-go marked visited', keeps: ['mediaCatalog', 'droneMedia'],
    commit: write('wanttogo/convert', (s) => {
      const recorded = recordedCityIds(s)
      const places = new Map(viewOf(s).places.places.map((place) => [place.id, place]))
      const item = canonicalOf(s).wantToGo.items.find((wish) => places.get(wish.placeId)?.subtype === 'city' && !recorded.has(wish.placeId))!
      return { source: 'want-to-go', id: item.id, startDate: '2026-03-01', tripTitle: 'G2 trip' }
    }),
  },
  // A new place: every step that reads the place index runs again (its results may be equal).
  { label: 'country added', commit: write('countries', () => ({ countryCode: 'JP', visitedDate: '2024-02-12' })), keeps: [] },
  {
    label: 'media record imported', keeps: MEDIA_KEEPS,
    commit: (s, n) => {
      const allocateId = sequentialUuids(Date.UTC(2033, 0, 1 + n))
      const city = photosOf(s)[0].placeId
      const { commands } = createMediaRecordCommands([{ assetId: allocateId(), entityId: allocateId(), item: newPhoto(city, `g2-${n}`), appendToCityOrder: true }], { reader: memoryScopeReader(s), allocateId })
      return commitCommands(s, commands, n)
    },
  },
  {
    label: 'media record re-read', keeps: ['travelAtlas', 'wantToGo', 'worldGraph', 'context', 'visible', 'visibleFiltered', 'browse', 'browseFiltered', 'collection'],
    commit: (s, n) => {
      const asset = modelOf(s).assets[0]
      const item = { ...canonicalOf(s).media.items.find((media) => s.entities.some((entity) => entity.fields.asset === asset.id && entity.fields.place === media.placeId))!, date: '2022-02-22', title: { names: { en: 'G2 re-read' } } }
      const { commands } = rereadMediaRecordCommands([{ assetId: asset.id, item: item as CanonicalMediaItem }], { reader: memoryScopeReader(s) })
      return commitCommands(s, commands, n)
    },
  },
  {
    label: 'media record deleted', keeps: MEDIA_KEEPS,
    commit: (s, n) => commitCommands(s, removeMediaRecordCommands([modelOf(s).assets.at(-1)!.id], { reader: memoryScopeReader(s) }).commands, n),
  },
]

/** A kind's change set, its label on a failure. */
function commitKind(kind: Kind, state: FormalState, n: number): ChangeSet {
  try { return kind.commit(state, n) } catch (error) { throw new Error(`${kind.label}: ${(error as Error).message}`, { cause: error }) }
}

/** The sections of the official view each kind of save computes (③-1: 'whole' when it projects the whole store). */
const MEDIA_SECTIONS = 'media,editor:mediaOrderByCity,editor:hiddenMediaIds,editor:coverMediaByCity,editor:droneOrderByCity,editor:hiddenDroneMediaIds'
const SECTIONS: Readonly<Record<string, string>> = {
  'country order': 'editor:countryOrder', 'city order': 'editor:cityOrderByCountry', 'hide a country': 'editor:hiddenCountryIds',
  'show the hidden cities': 'editor:hiddenCityIds', 'hide a city': 'editor:hiddenCityIds', cover: 'editor:coverMediaByCity', 'photo order': 'editor:mediaOrderByCity',
  'hide a photo': 'editor:hiddenMediaIds', 'drone order and hide': 'editor:droneOrderByCity,editor:hiddenDroneMediaIds',
  'want-to-go note': 'wishes', 'want-to-go hide (hide, maphide)': 'wishes', 'want-to-go show': 'wishes', 'want-to-go added on an existing place': 'wishes',
  // A new city, a want-to-go item whose place goes with it, a new country: place rows, the whole store.
  'want-to-go added on a new city': 'whole', 'want-to-go deleted (hidden)': 'whole', 'footprint on a new city': 'whole', 'country added': 'whole',
  'footprint on an existing city': 'records,addedCountries,editor:countryOrder', 'planned record marked visited': 'records,addedCountries,editor:countryOrder',
  'want-to-go marked visited': 'records,addedCountries,wishes',
  'media record imported': MEDIA_SECTIONS, 'media record re-read': MEDIA_SECTIONS, 'media record deleted': MEDIA_SECTIONS,
  'hide the added country': 'editor:hiddenCountryIds', 'country deleted': 'whole', 'an external writer (two commits)': 'editor:hiddenCountryIds,editor:hiddenCityIds',
}
const sorted = (sections: string | undefined) => (sections ?? '').split(',').sort().join(',')
const assertSections = (after: AppSnapshot, label: string) => assert.equal(sorted(after.timings.officialSections), sorted(SECTIONS[label]), `${label}: the sections computed`)

test('G2: each kind of save, equal to the whole computation and sharing as today, computing only its sections', () => {
  let state = doubleRunStore(migratedFiles()).state
  const store = storeOf(state)
  KINDS.forEach((kind, index) => {
    const changeSet = commitKind(kind, state, 100 + index)
    state = applyChangeSet(state, changeSet)
    assertSections(step(store, changesOfSet(changeSet), modelOf(state), kind.label).after, kind.label)
  })
  // A country deleted (hidden first, as the page does), and an external writer's commits in one change (several revisions).
  const country = viewOf(state).places.places.find((place) => place.subtype === 'country' && place.externalIds?.iso3166Alpha2 === 'JP')!
  for (const [label, route, input] of [['hide the added country', 'view', { operations: [{ op: 'hide', scope: 'countries', add: [country.id], remove: [] }] }], ['country deleted', 'countries/delete', { ids: [country.id] }]] as const) {
    const changeSet = commitWrite(state, route, input, 200)!
    state = applyChangeSet(state, changeSet)
    assertSections(step(store, changesOfSet(changeSet), modelOf(state), label).after, label)
  }
  const from = state.revision, model = modelOf(state)
  for (const [n, operations] of [[201, [{ op: 'hide', scope: 'countries', add: [placeIdsOf(state, 'country')[1]], remove: [] }]], [202, [{ op: 'hide', scope: 'cities', add: [placeIdsOf(state, 'city')[1]], remove: [] }]]] as const) {
    state = applyChangeSet(state, commitWrite(state, 'view', { operations }, n)!)
  }
  const external = readModelChangesBetween(model, modelOf(state))
  const label = 'an external writer (two commits)'
  assertSections(step(store, { ...changesOf(from, external.upserts, external.deletes), to: state.revision }, modelOf(state), label).after, label)
})

test('G2: each kind of save keeps the parts whose inputs it did not change', () => {
  let state = doubleRunStore(migratedFiles()).state
  const store = storeOf(state)
  const missing: string[] = []
  KINDS.forEach((kind, index) => {
    const changeSet = commitKind(kind, state, 100 + index)
    state = applyChangeSet(state, changeSet)
    const { before, after, asked } = step(store, changesOfSet(changeSet), modelOf(state), kind.label)
    const now = askQueries(after)
    for (const name of kind.keeps) {
      const kept = name in after.appData
        ? after.appData[name as keyof AppSnapshot['appData']] === before.appData[name as keyof AppSnapshot['appData']]
        : now[name as keyof AskedQueries] === asked[name as keyof AskedQueries]
      if (!kept) missing.push(`${kind.label}: ${name}`)
    }
    for (const violation of sharingViolations(before, after, asked)) missing.push(`${kind.label}: ${violation}`)
  })
  assert.deepEqual(missing, [])
})

// ---- G3: changed rows drawn directly ----

for (const seed of [11, 4242]) {
  test(`G3: rows changed directly (scope, layer, type, duplicates, deletions, rows that start over), seed ${seed}`, () => {
    const rng = random(seed)
    let model = modelOf(doubleRunStore(migratedFiles()).state)
    const store = createAppStore(computeSnapshot(model, { ...OPTIONS, identity: IDENTITY }), OPTIONS)
    store.replace(model, IDENTITY)
    let applied = 0, unusable = 0, sectioned = 0
    for (let n = 1; applied < 150 && n < 600; n++) {
      const changes = randomRowChange(rng, model, n)
      if (!changes) continue
      const next = modelAfter(model, changes)
      // Some drawn rows are data the App cannot derive at all (the whole computation throws too): not a step.
      try { computeSnapshot(next, { ...OPTIONS, identity: IDENTITY }) } catch { unusable++; continue }
      const before = store.getSnapshot()
      const asked = askQueries(before)
      assert.equal(store.apply(changes), true, `step ${n}: applied`)
      const label = `seed ${seed} step ${n} (${changes.upserts[0]?.table ?? changes.deletes[0]?.table})`
      const after = store.getSnapshot()
      assertIncrementalStep(before, after, next, label)
      assert.deepEqual(sharingViolations(before, after, asked), [], `${label}: the parts whose inputs it kept`)
      // Rows the classification does not know, and rows of places, start over; every other change computes its sections.
      const rows = [...changes.upserts.map(({ table, row }) => ({ table, row })), ...changes.deletes.map(({ table, id }) => ({ table, row: before.model[table as 'viewItems']?.find((candidate) => candidate.id === id) }))]
      const startsOver = rows.some(({ table, row }) => ['anchors', 'relations', 'sources', 'test:unknown-table'].includes(table) || JSON.stringify(row ?? {}).includes('test:unknown')
        || (table === 'entities' && (row as { typeId?: string })?.typeId === 'starmap:place'))
      if (startsOver) assert.equal(after.timings.officialSections, 'whole', `${label}: starts over`)
      if (after.timings.officialSections !== 'whole') sectioned++
      model = next
      applied++
    }
    assert.equal(applied, 150, `applied ${applied}, unusable ${unusable}`)
    assert.ok(sectioned >= 75, `computed by sections: ${sectioned} of ${applied}`)
  })
}

// ---- The classification table covers what the projection reads (review §7 item 2) ----

test('the classification table lists every scope, layer, source, type and kind the projection reads', () => {
  const source = readFileSync(new URL('./store/projectCanonical.ts', import.meta.url), 'utf8')
  const marker = source.indexOf('// ---- ③ (scope-incremental): which sections')
  assert.ok(marker > 0, 'the table follows the projection')
  const projection = source.slice(0, marker)
  const names = (prefix: string) => [...new Set([...projection.matchAll(new RegExp(`\\b${prefix}\\.(\\w+)`, 'g'))].map((match) => match[1]))]
  // Scopes: only through VIEW_SCOPES (no scope written as a literal), and every one of them listed.
  assert.deepEqual([...projection.matchAll(/'starmap:[^']*'/g)].map((match) => match[0]), [], 'no scope literal in the projection')
  const scopes = names('VIEW_SCOPES')
  assert.ok(scopes.length >= 20, `scopes read: ${scopes.length}`)
  for (const name of scopes) {
    const scope = VIEW_SCOPES[name as keyof typeof VIEW_SCOPES]
    assert.notEqual(scopeAffects(scope), WHOLE_OFFICIAL_VIEW, `VIEW_SCOPES.${name} is listed`)
  }
  for (const name of ['cityOrderByCountry', 'mediaOrderByCity', 'droneOrderByCity'] as const) {
    assert.notEqual(scopeAffects(mapListScope(VIEW_SCOPES[name], 'some-key')), WHOLE_OFFICIAL_VIEW, `the key lists of VIEW_SCOPES.${name} are listed`)
  }
  // Layers, entity types, relation types and the want-to-go sources the roles read.
  const known = new Set([...Object.keys(OFFICIAL_VIEW_INPUTS.layers), ...Object.keys(OFFICIAL_VIEW_INPUTS.entityTypes), ...Object.keys(OFFICIAL_VIEW_INPUTS.relationTypes), ...Object.keys(OFFICIAL_VIEW_INPUTS.wantToGoSources)])
  for (const name of names('OFFICIAL')) assert.ok(known.has(OFFICIAL[name as keyof typeof OFFICIAL]), `OFFICIAL.${name} is listed`)
  // V2 sources the projection names for other rows than entries: their rows are classified by their own tables.
  const byTable: Readonly<Record<string, string>> = {
    import: 'sources (the whole store)', journey: 'entities of the journey type (records)', media: 'assets (media)', travel: 'entries of the travel layer (every source)',
  }
  for (const name of names('V2_SOURCES')) {
    const id = V2_SOURCES[name as keyof typeof V2_SOURCES]
    assert.ok(Object.hasOwn(OFFICIAL_VIEW_INPUTS.wantToGoSources, id) || Object.hasOwn(byTable, name), `V2_SOURCES.${name} is listed`)
  }
  for (const [, kind] of projection.matchAll(/kind === '(\w+)'/g)) assert.ok(Object.hasOwn(OFFICIAL_VIEW_INPUTS.anchorKinds, kind), `anchor kind ${kind} is listed`)
  // Every view row of a migrated library is in a listed scope: no save of today projects the whole store for its scope.
  const model = modelOf(doubleRunStore(migratedFiles()).state)
  for (const row of [...model.viewItems, ...model.viewSettings]) assert.notEqual(scopeAffects(row.scope), WHOLE_OFFICIAL_VIEW, row.scope)
  // What the table does not know projects the whole store.
  for (const [table, row] of [
    ['viewItems', { scope: 'test:other' }], ['entries', { layerId: 'test:layer' }], ['entries', { layerId: OFFICIAL.wantToGo, source: { sourceId: 'test:source' } }],
    ['entities', { typeId: 'test:type' }], ['relations', { typeId: 'test:relation' }], ['anchors', { kind: 'test:kind' }], ['test:table', {}],
  ] as const) assert.equal(rowAffects(table, row), WHOLE_OFFICIAL_VIEW, `${table} ${JSON.stringify(row)}`)
})