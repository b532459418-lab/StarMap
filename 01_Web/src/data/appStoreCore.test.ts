/// <reference types="node" />
/**
 * The App's data store (3C-5 D, design §1): a snapshot moved on by the changed rows of each commit equals the snapshot
 * computed again from the store's read model (read model, official view, derived baseline, time query context), over
 * random sequences of the eight editor writes; and changes that do not follow the snapshot are not applied.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readModelOf } from '../worldgraph/readModel/build.ts'
import { liveReadModelIndex } from '../worldgraph/readModel/liveIndex.ts'
import { applyChangeSet, planCommands, type ChangeSet } from '../worldgraph/store/planner.ts'
import { memoryReader } from '../worldgraph/store/reader.ts'
import type { FormalState } from '../worldgraph/store/formal.ts'
import { computeSnapshot, createAppStore, createHeldSource, type AppSnapshot, type ReadModelChanges } from './appStoreCore.ts'
import { buildBaseline, stableStringify } from './derive/baseline.ts'
import { buildBrowseTimeProjection } from './derive/browseTimeProjection.ts'
import { queryVisiblePlaces } from '../worldgraph/query.ts'
import { queryCollection } from '../worldgraph/collection.ts'
import { TRAVEL_LAYER_ID, WANT_TO_GO_LAYER_ID } from '../worldgraph/layers.ts'
import { doubleRunStore, random, randomStep, stepContext } from './editor/doubleRun.fixture.ts'
import { NATIVE_WRITES } from './editor/native/routes.ts'
import { viewOf } from './store/diffV2.fixture.ts'
import { OFFICIAL_POLICY } from './store/officialDefinitions.ts'
import { officialReader } from './store/officialReader.ts'
import { migratedFiles } from './v2write/v2write.fixture.ts'

const OPTIONS = { source: 'local', now: '2026-10-22T00:00:00.000Z' } as const
const IDENTITY = { libraryId: '01990000-0000-7000-8000-00000000d001', restoreMark: null }
const snapshotOf = (state: FormalState) => computeSnapshot(readModelOf(state, { origin: 'local' }), { ...OPTIONS, identity: IDENTITY })
const changesOf = (changeSet: ChangeSet): ReadModelChanges => ({
  libraryId: IDENTITY.libraryId, restoreMark: null, from: changeSet.baseRevision, to: changeSet.nextRevision, upserts: changeSet.upserts, deletes: changeSet.deletes,
})
const baselineOf = (snapshot: AppSnapshot) => stableStringify(buildBaseline(snapshot.appData as never, { now: OPTIONS.now }))

function assertSameSnapshot(actual: AppSnapshot, expected: AppSnapshot, label: string) {
  assert.equal(actual.revision, expected.revision, `${label}: revision`)
  assert.deepEqual(actual.model, expected.model, `${label}: read model`)
  assert.deepEqual(actual.canonical, expected.canonical, `${label}: official view`)
  assert.equal(baselineOf(actual), baselineOf(expected), `${label}: derived baseline`)
  assert.deepEqual(actual.timeQueryContext(), expected.timeQueryContext(), `${label}: time query context`)
}

/** One native write of a random step on `state`: its change set, or undefined when it is refused or changes nothing. */
function commitOf(state: FormalState, n: number, rng: ReturnType<typeof random>): ChangeSet | undefined {
  const step = randomStep(rng, viewOf(state))
  const write = NATIVE_WRITES[step.route]
  assert.ok(write, step.route)
  const ctx = stepContext(n)
  let plan
  try {
    plan = write.plan(officialReader(liveReadModelIndex(readModelOf(state, { origin: 'local' }))), structuredClone(step.input), ctx)
  } catch { return undefined }
  if (plan.commands.length === 0) return undefined
  return planCommands(memoryReader(state), plan.commands, { baseRevision: state.revision, now: ctx.now.toISOString(), policy: OFFICIAL_POLICY })
}

for (const seed of [3404, 5150, 7777]) {
  test(`the snapshot moved on by each commit's changed rows equals the snapshot computed again (seed ${seed}, 80 steps)`, () => {
    const rng = random(seed)
    let state = doubleRunStore(migratedFiles()).state
    const store = createAppStore(snapshotOf(state), OPTIONS)
    let commits = 0
    for (let n = 1; n <= 80; n++) {
      const changeSet = commitOf(state, n, rng)
      if (!changeSet) continue
      state = applyChangeSet(state, changeSet)
      assert.equal(store.apply(changesOf(changeSet)), true, `step ${n}: applied`)
      assertSameSnapshot(store.getSnapshot(), snapshotOf(state), `step ${n}`)
      commits++
    }
    assert.ok(commits >= 20, `commits: ${commits}`)
  })
}

test('changes that do not follow the snapshot are not applied: another library or restore mark, another base, already applied', () => {
  let state = doubleRunStore(migratedFiles()).state
  const store = createAppStore(snapshotOf(state), OPTIONS)
  const rng = random(1)
  let changeSet: ChangeSet | undefined
  for (let n = 1; !changeSet; n++) changeSet = commitOf(state, n, rng)
  const changes = changesOf(changeSet)
  const before = store.getSnapshot()
  let notified = 0
  store.subscribe(() => { notified++ })
  assert.equal(store.apply({ ...changes, libraryId: '01990000-0000-7000-8000-00000000d002' }), false)
  assert.equal(store.apply({ ...changes, restoreMark: '2026-10-01T00:00:00.000Z' }), false)
  assert.equal(store.apply({ ...changes, from: changes.from + 1, to: changes.to + 1 }), false)
  assert.equal(store.getSnapshot(), before)
  assert.equal(notified, 0)
  assert.equal(store.apply(changes), true)
  assert.equal(notified, 1)
  state = applyChangeSet(state, changeSet)
  // The same changes again (a push after the response): not this snapshot's next changes.
  assert.equal(store.apply(changes), false)
  // A write that changed nothing answers with the same revision: nothing to do, nobody notified.
  assert.equal(store.apply({ ...changes, from: state.revision, to: state.revision, upserts: [], deletes: [] }), true)
  assert.equal(notified, 1)
  assertSameSnapshot(store.getSnapshot(), snapshotOf(state), 'after')
})

test('a changed row without the shape every row shares is refused, and the snapshot stays', () => {
  const state = doubleRunStore(migratedFiles()).state
  const store = createAppStore(snapshotOf(state), OPTIONS)
  const before = store.getSnapshot()
  assert.throws(() => store.apply({ from: state.revision, to: state.revision + 1, upserts: [{ table: 'entries', row: { id: 7 } }], deletes: [] }))
  assert.equal(store.getSnapshot(), before)
})

test('the time query context is computed when first asked for, once', () => {
  const snapshot = snapshotOf(doubleRunStore(migratedFiles()).state)
  assert.equal(snapshot.timeQueryContext(), snapshot.timeQueryContext())
})

test('the same data again keep every section of the derived data and the time query context (structural sharing)', () => {
  const state = doubleRunStore(migratedFiles()).state
  const store = createAppStore(snapshotOf(state), OPTIONS)
  // The first replace fills the store's derivation cache; from then on equal data give the same objects.
  store.replace(readModelOf(state, { origin: 'local' }), IDENTITY)
  const before = store.getSnapshot()
  const after = store.replace(readModelOf(state, { origin: 'local' }), IDENTITY)
  assert.notEqual(after, before)
  for (const key of Object.keys(before.canonical) as (keyof AppSnapshot['canonical'])[]) assert.equal(after.canonical[key], before.canonical[key], `official view: ${key}`)
  for (const key of Object.keys(before.appData) as (keyof AppSnapshot['appData'])[]) assert.equal(after.appData[key], before.appData[key], `derived data: ${key}`)
  assert.equal(after.timeQueryContext(), before.timeQueryContext())
})

test('a held source keeps its snapshot without notices; let go, it follows the store again and tells once', () => {
  const state = doubleRunStore(migratedFiles()).state
  const store = createAppStore(snapshotOf(state), OPTIONS)
  const source = createHeldSource(store)
  let told = 0
  const stop = source.subscribe(() => { told++ })
  store.replace(readModelOf(state, { origin: 'local' }), IDENTITY)
  assert.equal(told, 1, 'not held: every notice of the store')
  assert.equal(source.getSnapshot(), store.getSnapshot())
  source.hold(true)
  const held = source.getSnapshot()
  store.replace(readModelOf(state, { origin: 'local' }), IDENTITY)
  store.replace(readModelOf(state, { origin: 'local' }), IDENTITY)
  assert.equal(told, 1, 'held: no notices')
  assert.equal(source.getSnapshot(), held)
  assert.notEqual(store.getSnapshot(), held)
  source.hold(false)
  assert.equal(told, 2, 'let go after the store moved on: one notice')
  assert.equal(source.getSnapshot(), store.getSnapshot())
  source.hold(true)
  source.hold(false)
  assert.equal(told, 2, 'nothing moved meanwhile: no notice')
  stop()
  store.replace(readModelOf(state, { origin: 'local' }), IDENTITY)
  assert.equal(told, 2, 'no listener: detached from the store')
})

test('the page queries: one result per snapshot and arguments, equal to the direct query, kept while their inputs are', () => {
  const state = doubleRunStore(migratedFiles()).state
  const store = createAppStore(snapshotOf(state), OPTIONS)
  store.replace(readModelOf(state, { origin: 'local' }), IDENTITY)
  const snapshot = store.getSnapshot()
  const graph = snapshot.appData.worldGraph.worldGraphSnapshot
  const layers = [TRAVEL_LAYER_ID, WANT_TO_GO_LAYER_ID]
  const places = snapshot.queries.visiblePlaces(layers)
  assert.equal(snapshot.queries.visiblePlaces([...layers]), places, 'equal arguments: the same object')
  assert.deepEqual(places, queryVisiblePlaces(graph, layers))
  // Filters that are not active: the same result, and the time query context is not computed for it.
  assert.equal(snapshot.queries.visiblePlaces(layers, { travel: { includeUncertain: false } }), places)
  assert.equal(snapshot.timings.timeContextMs, undefined)
  const filters = { travel: { from: '2025-01-01', to: '2025-12-31', includeUncertain: false } }
  const filtered = snapshot.queries.visiblePlaces(layers, filters)
  assert.deepEqual(filtered, queryVisiblePlaces(graph, layers, { context: snapshot.timeQueryContext(), filters }))
  assert.equal(snapshot.queries.visiblePlaces(layers, { ...filters }), filtered)
  const projection = snapshot.queries.browseProjection(filters)
  assert.equal(snapshot.queries.browseProjection({ ...filters }), projection)
  assert.deepEqual(projection, buildBrowseTimeProjection(snapshot.timeQueryContext(), filters))
  const entries = snapshot.queries.collection('en')
  assert.equal(snapshot.queries.collection('en'), entries)
  assert.deepEqual(entries, queryCollection(graph, WANT_TO_GO_LAYER_ID, 'en'))
  // The same data again (another snapshot): the kept results.
  const again = store.replace(readModelOf(state, { origin: 'local' }), IDENTITY)
  assert.notEqual(again, snapshot)
  assert.equal(again.queries.visiblePlaces(layers), places)
  assert.equal(again.queries.visiblePlaces(layers, filters), filtered)
  assert.equal(again.queries.browseProjection(filters), projection)
  assert.equal(again.queries.collection('en'), entries)
  // A snapshot computed without a store (the sample's) keeps its own results: the same arguments, the same object.
  const alone = snapshotOf(state)
  assert.equal(alone.queries.visiblePlaces(layers), alone.queries.visiblePlaces([...layers]))
  assert.equal(alone.queries.browseProjection(filters), alone.queries.browseProjection({ ...filters }))
  assert.equal(alone.queries.collection('en'), alone.queries.collection('en'))
})
