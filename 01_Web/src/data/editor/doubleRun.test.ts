/// <reference types="node" />
/**
 * The double run of 3C-5 C1 (spec §2.4): the store-native writes against the old engine (V2 function + diffV2ToCommands),
 * from the same state, on the 3C-4a scenarios that touch the editor lists and the want-to-go list, and on random sequences
 * (3 seeds × 240 steps) mixing the native endpoints and the endpoints that still run the V2 functions. Endpoints without a
 * native planner run against the stand-in (the old engine again), which also checks the comparison itself.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateV2Files } from '../canonical/v2Schema.ts'
import { readV2 } from '../canonical/v2Reader.ts'
import { serializeV2 } from '../canonical/v2Serializer.ts'
import { projectStoreToCanonical } from '../store/projectCanonical.ts'
import { migratedFiles } from './editor.fixture.ts'
import {
  OLD_WRITES, VIEW_ROUTE, doubleRunStore, editorRoute, enginesFor, normalizedBaseline, oldEngine, runRandomSequence, runSteps, sameRequest,
  standInEngine, stepContext, viewStep, compareOutcomes, type RunReport,
} from './doubleRun.fixture.ts'
import { NATIVE_WRITES } from './native/routes.ts'
import { SCENARIOS, SEQUENCE_SEEDS, SEQUENCE_STEPS, idOf, lists } from './editorScenarios.fixture.ts'

const ENGINES = enginesFor(NATIVE_WRITES)
/** The store-native endpoints (3C-5 C1, C2; the native planners land commit by commit; until then they run against the stand-in). */
const NATIVE_ROUTES = [
  VIEW_ROUTE, editorRoute('wanttogo'), editorRoute('wanttogo/update'), editorRoute('wanttogo/delete'), editorRoute('records'), editorRoute('countries'),
  editorRoute('countries/delete'), editorRoute('wanttogo/convert'),
]



function assertSame(report: RunReport, message = '') {
  assert.deepEqual(report.differences, [], message)
}


// --- The framework itself.

test('the framework: the old engine against its stand-in finds no difference; a changed state, error, candidate order or response is one', () => {
  const files = migratedFiles()
  const store = doubleRunStore(files)
  const step = sameRequest('wish', editorRoute('wanttogo'), OLD_WRITES.wantToGo, { place: { kind: 'city', nameEn: 'Synthetic Town', countryCode: 'IS' } })
  const old = oldEngine(store, step, stepContext(1))
  const standIn = standInEngine(store, step, stepContext(1))
  assert.ok(old.state && standIn.state)
  // New store rows got other ids in the stand-in, and the comparison does not see them.
  const ids = (state: object) => Object.values(state).filter(Array.isArray).flatMap((rows: { id: string }[]) => rows.map(row => row.id)).sort()
  assert.notDeepEqual(ids(old.state), ids(standIn.state))
  assert.deepEqual(compareOutcomes(store.state, old, standIn), [])
  // A different write is a difference (of the response and of the derived baseline).
  const other = oldEngine(store, sameRequest('wish', editorRoute('wanttogo'), OLD_WRITES.wantToGo, { place: { kind: 'city', nameEn: 'Other Town', countryCode: 'IS' } }), stepContext(1))
  const found = compareOutcomes(store.state, old, other)
  assert.equal(found.length, 2)
  assert.match(found[0], /^result differs/)
  assert.match(found[1], /^derived baseline differs/)
  assert.deepEqual(compareOutcomes(store.state, old, other, { result: false }).length, 1)
  // Errors: one side only, another code, other parameters, the same candidates in another order.
  const error = (code: string, params?: unknown) => ({ error: { code, ...(params !== undefined ? { params } : {}) } })
  assert.match(compareOutcomes(store.state, old, error('E_WTG_EXISTS'))[0], /one engine refused/)
  assert.match(compareOutcomes(store.state, error('E_WTG_EXISTS'), error('E_WTG_NOT_FOUND'))[0], /^code/)
  const a = '01890000-0000-7000-8000-00000000000a', b = '01890000-0000-7000-8000-00000000000b'
  const candidates = (...ids: string[]) => ({ subtype: 'city', candidates: ids.map(placeId => ({ placeId, strong: placeId === a })) })
  assert.deepEqual(compareOutcomes(store.state, error('E_PLACE_CHOICE_REQUIRED', candidates(a, b)), error('E_PLACE_CHOICE_REQUIRED', candidates(a, b))), [])
  assert.match(compareOutcomes(store.state, error('E_PLACE_CHOICE_REQUIRED', candidates(a, b)), error('E_PLACE_CHOICE_REQUIRED', candidates(b, a)))[0], /^params/)
})

test('the framework: media ids a view operation brings that are no media are left out of the old side only (design §9 change 4)', () => {
  const files = migratedFiles()
  const store = doubleRunStore(files)
  const state = lists(files)
  const reykjavik = idOf(files, 'Reykjavik')
  const step = viewStep('unknown media', [
    { op: 'hide', scope: 'media', add: ['synthetic-missing', 'photo-reykjavik-1'], remove: [] },
    { op: 'order', scope: 'media', key: reykjavik, ids: ['synthetic-missing', 'photo-reykjavik-2', 'photo-reykjavik-1'], baseline: state.mediaOrderByCity[reykjavik] ?? [] },
    { op: 'cover', key: reykjavik, id: 'synthetic-missing-cover' },
  ])
  const old = oldEngine(store, step, stepContext(1))
  const standIn = standInEngine(store, step, stepContext(1))
  // The two states differ: the old engine kept the unknown ids.
  assert.notEqual(JSON.stringify(normalizedBaseline(old.state!)), JSON.stringify(normalizedBaseline(standIn.state!)))
  assert.deepEqual(compareOutcomes(store.state, old, standIn, { viewOperation: true, result: false }), [])
  // Without the view-operation rule the comparison sees them.
  assert.equal(compareOutcomes(store.state, old, standIn, { result: false }).length, 1)
})

// --- The scenarios (./editorScenarios.fixture.ts: 3C-4a's editor lists, want-to-go list, footprint, countries, conversions).

for (const { name, files, steps, check } of SCENARIOS) {
  test(`double run: ${name}`, () => {
    const report = runSteps(files(), steps, ENGINES)
    assertSame(report)
    check?.(report)
  })
}

// --- Random sequences.

for (const seed of SEQUENCE_SEEDS) {
  test(`double run: random sequence of 240 steps (seed ${seed}) over the eight editor endpoints`, () => {
    const report = runRandomSequence(seed, SEQUENCE_STEPS, migratedFiles(), ENGINES)
    assertSame(report)
    // Every kind of step happened, and both engines saved and refused along the way.
    const labels = [...report.tally.keys()].sort()
    for (const label of ['countries', 'countries/delete', 'records/named', 'records/placeId', 'view/lists', 'wanttogo/named', 'wanttogo/placeId', 'wanttogo/update',
      'wanttogo/delete', 'convert/want-to-go', 'convert/planned']) assert.ok(labels.includes(label), label)
    // Design 3C-5 §3, condition 5: what the native writes wrote exports to V2 (store:export-v2's path), valid, and reads back.
    const { canonical, v2Meta } = projectStoreToCanonical(report.state, { source: 'local', track: false, freeze: false })
    const exported = serializeV2(canonical, v2Meta)
    assert.deepEqual(validateV2Files(exported), [])
    assert.deepEqual(readV2(exported), canonical)
    const totals = [...report.tally.values()].reduce(([a, b], [c, d]) => [a + c, b + d], [0, 0])
    assert.ok(totals[0] > 60 && totals[1] > 20, JSON.stringify(totals))
  })
}

test('the native endpoints are listed', () => {
  assert.deepEqual([...ENGINES.native].sort(), [...NATIVE_ROUTES].sort())
})
