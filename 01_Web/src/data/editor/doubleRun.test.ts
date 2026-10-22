/// <reference types="node" />
/**
 * The double run of 3C-5 C1 (spec §2.4): the store-native writes against the old engine (V2 function + diffV2ToCommands),
 * from the same state, on the 3C-4a scenarios that touch the editor lists and the want-to-go list, and on random sequences
 * (3 seeds × 240 steps) mixing the native endpoints and the endpoints that still run the V2 functions. Endpoints without a
 * native planner run against the stand-in (the old engine again), which also checks the comparison itself.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { V2Files } from '../canonical/v2Schema.ts'
import { readEditorStateV1 } from '../v2write/index.ts'
import { WRITE_NOW, migratedFiles, placeNamed } from '../v2write/v2write.fixture.ts'
import { edgeCaseFixture } from '../store/v2Store.fixture.ts'
import {
  OLD_WRITES, VIEW_ROUTE, doubleRunStore, editorRoute, enginesFor, normalizedBaseline, oldEngine, runRandomSequence, runSteps, sameRequest,
  standInEngine, stepContext, viewStep, compareOutcomes, type DoubleRunStep, type Engines, type RunReport,
} from './doubleRun.fixture.ts'
import { NATIVE_WRITES } from './native/routes.ts'
import { hideDelta } from './rules/editorView.ts'

const ENGINES = enginesFor(NATIVE_WRITES)
/** The store-native endpoints (3C-5 C1, C2; the native planners land commit by commit; until then they run against the stand-in). */
const NATIVE_ROUTES = [
  VIEW_ROUTE, editorRoute('wanttogo'), editorRoute('wanttogo/update'), editorRoute('wanttogo/delete'), editorRoute('records'), editorRoute('countries'),
  editorRoute('countries/delete'),
]

type Make = (view: V2Files) => DoubleRunStep
const idOf = (files: V2Files, en: string, subtype?: 'country' | 'city') => placeNamed(files, en, subtype).id
const wishAt = (files: V2Files, en: string) => files.wantToGo.items.find(item => item.placeId === idOf(files, en))!
const lists = (files: V2Files) => readEditorStateV1(files, WRITE_NOW)

function assertSame(report: RunReport, message = '') {
  assert.deepEqual(report.differences, [], message)
}
/** The labels that saved / were refused in both engines. */
const saved = (report: RunReport) => [...report.tally].filter(([, [ok]]) => ok > 0).map(([label]) => label)
const refusedCodes = (report: RunReport) => report.outcomes.flatMap(outcome => (outcome.error ? [outcome.error.code] : []))

function scenario(name: string, files: () => V2Files, steps: readonly Make[], check?: (report: RunReport) => void, engines: Engines = ENGINES) {
  test(`double run: ${name}`, () => {
    const report = runSteps(files(), steps, engines)
    assertSame(report)
    check?.(report)
  })
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

// --- The 3C-4a scenarios that touch the editor lists and the want-to-go list (with the old-path endpoints between them).

const everyList: Make = (view) => {
  const s = lists(view)
  const iceland = idOf(view, 'Iceland'), reykjavik = idOf(view, 'Reykjavik'), torshavn = idOf(view, 'Torshavn')
  return viewStep('every list', [
    { op: 'order', scope: 'countries', ids: [...s.countryOrder].reverse(), baseline: s.countryOrder },
    { op: 'hide', scope: 'countries', ...hideDelta(s.hiddenCountryIds, [idOf(view, 'Norway')]) },
    { op: 'order', scope: 'cities', key: iceland, ids: [idOf(view, 'Akureyri'), reykjavik, idOf(view, 'Vik')], baseline: s.cityOrderByCountry[iceland] ?? [] },
    { op: 'hide', scope: 'cities', ...hideDelta(s.hiddenCityIds, []) },
    { op: 'order', scope: 'media', key: reykjavik, ids: ['photo-reykjavik-2', 'photo-reykjavik-1'], baseline: s.mediaOrderByCity[reykjavik] ?? [] },
    { op: 'hide', scope: 'media', ...hideDelta(s.hiddenMediaIds, ['photo-reykjavik-1', 'synthetic-missing']) },
    { op: 'cover', key: reykjavik, id: 'photo-reykjavik-1' },
    { op: 'cover', key: torshavn, id: 'synthetic-missing-cover' },
    { op: 'order', scope: 'drone', key: torshavn, ids: ['drone-torshavn-1'], baseline: s.droneOrderByCity[torshavn] ?? [] },
    { op: 'hide', scope: 'drone', ...hideDelta(s.hiddenDroneMediaIds, ['drone-torshavn-1']) },
  ])
}
const backToFirst: Make = (view) => {
  const s = lists(view), first = lists(migratedFiles())
  const keyed = (scope: 'cities' | 'media' | 'drone', now: Record<string, string[]>, was: Record<string, string[]>) =>
    Object.keys(now).map(key => ({ op: 'order' as const, scope, key, ids: was[key] ?? [], baseline: now[key] }))
  return viewStep('back to the first state', [
    { op: 'order', scope: 'countries', ids: first.countryOrder, baseline: s.countryOrder },
    { op: 'hide', scope: 'countries', ...hideDelta(s.hiddenCountryIds, first.hiddenCountryIds) },
    ...keyed('cities', s.cityOrderByCountry, first.cityOrderByCountry),
    { op: 'hide', scope: 'cities', ...hideDelta(s.hiddenCityIds, first.hiddenCityIds) },
    ...keyed('media', s.mediaOrderByCity, first.mediaOrderByCity),
    { op: 'hide', scope: 'media', ...hideDelta(s.hiddenMediaIds, first.hiddenMediaIds) },
    ...keyed('drone', s.droneOrderByCity, first.droneOrderByCity),
    { op: 'hide', scope: 'drone', ...hideDelta(s.hiddenDroneMediaIds, first.hiddenDroneMediaIds) },
  ])
}
const hideCountry = (en: string): Make => (view) => viewStep(`hide ${en}`, [{ op: 'hide', scope: 'countries', add: [idOf(view, en, 'country')], remove: [] }])
const deleteCountry = (en: string): Make => (view) => sameRequest(`delete ${en}`, editorRoute('countries/delete'), OLD_WRITES.countriesDelete, { ids: [idOf(view, en, 'country')] })
const tokyo: Make = () => sameRequest('Tokyo', editorRoute('records'), OLD_WRITES.records, {
  country: '日本', country_en: 'Japan', city: '东京', city_en: 'Tokyo', start_date: '2026-05-01', lat: 35.68, lng: 139.69, country_code: 'JP',
})
const addCountry = (code: string, visitedDate: string): Make => () => sameRequest(`country ${code}`, editorRoute('countries'), OLD_WRITES.countries, { countryCode: code, visitedDate })
const wish = (label: string, input: unknown): Make => () => sameRequest(label, editorRoute('wanttogo'), OLD_WRITES.wantToGo, input)
const wishById = (en: string, extra: object = {}): Make => (view) => sameRequest(`wish ${en}`, editorRoute('wanttogo'), OLD_WRITES.wantToGo, { placeId: idOf(view, en), ...extra })
const update = (label: string, en: string, input: object): Make => (view) =>
  sameRequest(label, editorRoute('wanttogo/update'), OLD_WRITES.wantToGoUpdate, { id: wishAt(view, en).id, ...input })
const remove = (label: string, ids: (view: V2Files) => string[]): Make => (view) =>
  sameRequest(label, editorRoute('wanttogo/delete'), OLD_WRITES.wantToGoDelete, { ids: ids(view) })

scenario('PUT /state as view operations: orders, hidden lists, covers and drone order; back to the first state', migratedFiles, [everyList, backToFirst],
  report => assert.deepEqual(saved(report), ['every list', 'back to the first state']))

scenario('POST /countries/delete: hide (view operation) and delete a country with a planned record; a new country, hidden with a city order', migratedFiles, [
  hideCountry('Norway'), deleteCountry('Norway'), tokyo,
  (view) => viewStep('hide Japan with a city order', [
    { op: 'hide', scope: 'countries', add: [idOf(view, 'Japan', 'country')], remove: [] },
    { op: 'order', scope: 'cities', key: idOf(view, 'Japan', 'country'), ids: [idOf(view, 'Tokyo')], baseline: [] },
  ]),
  deleteCountry('Japan'), addCountry('JP', '2027-04-01'),
], report => assert.equal(report.tally.size, 6))

scenario('POST /countries/delete: an added country whose place a want-to-go item keeps, added again', migratedFiles, [
  addCountry('GL', '2027-01-02'), hideCountry('Greenland'), deleteCountry('Greenland'), addCountry('GL', '2027-02-03'),
])

scenario('POST /wanttogo: a new city by name, an existing city by id, and a country', migratedFiles, [
  wish('Osaka', { place: { kind: 'city', nameZh: '大阪', nameEn: 'Osaka', countryCode: 'JP', lat: 34.69, lng: 135.5 }, note: 'Synthetic' }),
  wishById('Bergen', { addedAt: '2026-01-02' }),
  wish('Greenland gets a location', { place: { kind: 'country', nameEn: 'Greenland', countryCode: 'GL', lat: 72, lng: -40 } }),
], report => assert.deepEqual(refusedCodes(report), []))

scenario('POST /wanttogo refused: choice required (candidates in order), already listed, unknown place, bad input; createNew then succeeds', migratedFiles, [
  (view) => wish('Reykjavik by name', { place: { kind: 'city', nameEn: 'Reykjavik', countryCode: 'IS' } })(view),
  wishById('Nuuk'),
  wish('unknown place', { placeId: 'synthetic-missing' }),
  wish('no name', { place: { kind: 'city', countryCode: 'IS' } }),
  wish('Reykjavik again, new', { place: { kind: 'city', nameEn: 'Reykjavik', countryCode: 'IS', lat: 64.1, lng: -21.9 }, createNew: true }),
  wish('a second Reykjavik by name', { place: { kind: 'city', nameEn: 'Reykjavik', countryCode: 'IS' } }),
], report => {
  assert.deepEqual(refusedCodes(report), ['E_PLACE_CHOICE_REQUIRED', 'E_WTG_EXISTS', 'E_UNKNOWN_PLACE_REF', 'E_REQUIRED', 'E_PLACE_CHOICE_REQUIRED'])
  const last = report.outcomes[5].error!.params as { candidates: unknown[] }
  assert.equal(last.candidates.length, 2)
})

scenario('POST /wanttogo/update: note, hide, unhide and drop the note, hide again; refusals', migratedFiles, [
  update('note', 'Nuuk', { note: '  Synthetic note  ' }),
  update('hide', 'Nuuk', { hidden: true }),
  update('unhide and drop the note', 'Nuuk', { hidden: false, note: '' }),
  update('hide again (a new view row)', 'Nuuk', { hidden: true }),
  () => sameRequest('unknown id', editorRoute('wanttogo/update'), OLD_WRITES.wantToGoUpdate, { id: 'synthetic-missing', hidden: true }),
  update('nothing to change', 'Nuuk', {}),
  update('hidden not a boolean', 'Nuuk', { hidden: 'yes' }),
  update('note too long', 'Nuuk', { note: 'x'.repeat(201) }),
], report => assert.deepEqual(refusedCodes(report), ['E_WTG_NOT_FOUND', 'E_WTG_UPDATE_EMPTY', 'E_HIDDEN_NOT_BOOLEAN', 'E_NOTE_TOO_LONG']))

scenario('POST /wanttogo/delete: a hidden item and the place only it used; refusals of a shown item and of no ids', migratedFiles, [
  remove('Tromsø', view => [wishAt(view, 'Tromsø').id]),
  remove('a shown item', view => [wishAt(view, 'Nuuk').id]),
  remove('no ids', () => []),
  update('hide Nuuk', 'Nuuk', { hidden: true }),
  remove('Nuuk and a missing id', view => [wishAt(view, 'Nuuk').id, 'synthetic-missing']),
  remove('Nuuk', view => [wishAt(view, 'Nuuk').id]),
], report => assert.deepEqual(refusedCodes(report), ['E_WTG_DELETE_NOT_HIDDEN', 'E_WTG_DELETE_EMPTY', 'E_WTG_DELETE_NOT_HIDDEN']))

scenario('POST /wanttogo/convert between native writes: a new item converted, kept; a planned record', migratedFiles, [
  wish('Osaka', { place: { kind: 'city', nameZh: '大阪', nameEn: 'Osaka', countryCode: 'JP', lat: 34.69, lng: 135.5 } }),
  (view) => sameRequest('Osaka joins', editorRoute('wanttogo/convert'), OLD_WRITES.convert, {
    source: 'want-to-go', id: wishAt(view, 'Osaka').id, startDate: '2025-06-25', tripTitle: '2025 North Atlantic Demo', journeyId: '2025-north-atlantic-demo', keepWantToGo: true,
  }),
  update('Osaka note', 'Osaka', { note: 'Synthetic' }),
  update('hide Osaka', 'Osaka', { hidden: true }),
  remove('Osaka', view => [wishAt(view, 'Osaka').id]),
])

scenario('3C-1b edge cases: unresolved and repeated list elements, a planned record and a want-to-go item that share an id', edgeCaseFixture, [
  (view) => {
    const s = lists(view)
    const [a] = Object.keys(s.mediaOrderByCity)
    return viewStep('editor lists with unresolved elements', [
      { op: 'hide', scope: 'media', add: ['synthetic-missing'], remove: [] },
      { op: 'order', scope: 'media', key: a, ids: ['synthetic-missing', 'synthetic-photo'], baseline: s.mediaOrderByCity[a] },
      { op: 'order', scope: 'countries', ids: [...s.countryOrder].reverse(), baseline: s.countryOrder },
    ])
  },
  () => sameRequest('the planned record', editorRoute('wanttogo/convert'), OLD_WRITES.convert, { source: 'planned', recordId: 'shared-id', startDate: '2027-03-01' }),
  () => sameRequest('the want-to-go item with that id', editorRoute('wanttogo/update'), OLD_WRITES.wantToGoUpdate, { id: 'shared-id', note: 'Synthetic', hidden: true }),
  () => sameRequest('delete it', editorRoute('wanttogo/delete'), OLD_WRITES.wantToGoDelete, { ids: ['shared-id'] }),
])

scenario('view operations refused: a hidden city that is no city (the merged lists are checked as a whole, as PUT /state did)', migratedFiles, [
  (view) => viewStep('a country as a city', [{ op: 'hide', scope: 'cities', add: [idOf(view, 'Iceland', 'country')], remove: [] }]),
  () => viewStep('an unknown place', [{ op: 'order', scope: 'countries', ids: ['synthetic-missing'], baseline: [] }]),
], report => assert.deepEqual(refusedCodes(report), ['E_UNKNOWN_PLACE_REF', 'E_UNKNOWN_PLACE_REF']))

// --- Random sequences.

for (const seed of [3404, 5150, 7777]) {
  test(`double run: random sequence of 240 steps (seed ${seed}), native and old-path endpoints mixed`, () => {
    const report = runRandomSequence(seed, 240, migratedFiles(), ENGINES)
    assertSame(report)
    // Every kind of step happened, and both engines saved and refused along the way.
    const labels = [...report.tally.keys()].sort()
    for (const label of ['countries', 'records/named', 'view/lists', 'wanttogo/named', 'wanttogo/placeId', 'wanttogo/update', 'wanttogo/delete']) assert.ok(labels.includes(label), label)
    const totals = [...report.tally.values()].reduce(([a, b], [c, d]) => [a + c, b + d], [0, 0])
    assert.ok(totals[0] > 60 && totals[1] > 20, JSON.stringify(totals))
  })
}

test('the native endpoints are listed', () => {
  assert.deepEqual([...ENGINES.native].sort(), [...NATIVE_ROUTES].sort())
})
