/// <reference types="node" />
/**
 * ③ (scope-incremental): the browser tests' comparison of each snapshot moved on by changed rows with the whole
 * computation (./incrementalVerify.ts): quiet while they agree, an error naming the parts when they do not, and only
 * after the save (its own schedule), never for a whole read model.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readModelOf } from '../worldgraph/readModel/build.ts'
import { applyChangeSet, planCommands } from '../worldgraph/store/planner.ts'
import { memoryReader } from '../worldgraph/store/reader.ts'
import { liveReadModelIndex } from '../worldgraph/readModel/liveIndex.ts'
import { computeSnapshot, createAppStore, type AppSnapshot, type SnapshotSource } from './appStoreCore.ts'
import { differingParts, verifyIncrementalSnapshots } from './incrementalVerify.ts'
import { doubleRunStore, stepContext } from './editor/doubleRun.fixture.ts'
import { migratedFiles } from './editor/editor.fixture.ts'
import { NATIVE_WRITES } from './editor/native/routes.ts'
import { OFFICIAL_POLICY } from './store/officialDefinitions.ts'
import { officialReader } from './store/officialReader.ts'

const OPTIONS = { source: 'local', now: '2026-10-22T00:00:00.000Z' } as const

test('a snapshot moved on by changed rows is compared after the save, quietly when it equals the whole computation', () => {
  const state = doubleRunStore(migratedFiles()).state
  const model = readModelOf(state, { origin: 'local' })
  const store = createAppStore(computeSnapshot(model, OPTIONS), OPTIONS)
  const scheduled: (() => void)[] = []
  const stop = verifyIncrementalSnapshots(store, OPTIONS, (work) => scheduled.push(work))
  store.replace(model)
  assert.equal(scheduled.length, 0, 'a whole read model is not compared')
  const countries = store.getSnapshot().canonical.editorState.countryOrder as string[]
  const ctx = stepContext(1)
  const plan = NATIVE_WRITES['POST /__travelatlas/editor/view'].plan(officialReader(liveReadModelIndex(model)), { operations: [{ op: 'order', scope: 'countries', ids: [...countries].reverse(), baseline: countries }] }, ctx)
  const changeSet = planCommands(memoryReader(state), plan.commands, { baseRevision: state.revision, now: ctx.now.toISOString(), policy: OFFICIAL_POLICY })
  assert.equal(applyChangeSet(state, changeSet).revision, changeSet.nextRevision)
  assert.equal(store.apply({ from: changeSet.baseRevision, to: changeSet.nextRevision, upserts: changeSet.upserts, deletes: changeSet.deletes }), true)
  assert.equal(scheduled.length, 1, 'compared once, later (not while applying)')
  scheduled[0]()
  stop()
})

test('a difference throws, naming the parts', () => {
  const model = readModelOf(doubleRunStore(migratedFiles()).state, { origin: 'local' })
  const right = computeSnapshot(model, OPTIONS)
  const wrong: AppSnapshot = Object.freeze({
    ...right, timings: { ...right.timings, deltaMs: 1, officialSections: 'wishes' },
    canonical: { ...right.canonical, wantToGo: { ...right.canonical.wantToGo, items: [] } },
    appData: { ...right.appData, travelAtlas: { ...right.appData.travelAtlas, countries: [] } },
  })
  assert.deepEqual(differingParts(wrong, right), ['official view wantToGo', 'derived data travelAtlas'])
  let current = right
  const listeners = new Set<() => void>()
  const source: SnapshotSource = { getSnapshot: () => current, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) } }
  const scheduled: (() => void)[] = []
  verifyIncrementalSnapshots(source, OPTIONS, (work) => scheduled.push(work))
  current = wrong
  for (const listener of listeners) listener()
  assert.equal(scheduled.length, 1)
  assert.throws(() => scheduled[0](), /incremental refresh: revision \d+ \(sections wishes\) differs from the whole computation in official view wantToGo, derived data travelAtlas/)
})
