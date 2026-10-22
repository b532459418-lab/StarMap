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
import { computeSnapshot, createAppStore, type AppSnapshot, type ReadModelChanges } from './appStoreCore.ts'
import { buildBaseline, stableStringify } from './derive/baseline.ts'
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
