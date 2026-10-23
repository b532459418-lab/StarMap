/// <reference types="node" />
/**
 * The editor scenarios of the double run and of the golden output (3C-5 C1, C2, E): the 3C-4a scenarios that touch the
 * editor lists, the want-to-go list, the footprint, the countries and the conversions, as steps made from the store's
 * V2 view (the export's shape: ids by name), and the random sequences (3 seeds × 240 steps over the eight endpoints).
 * Each scenario may check the run (its saved labels, its refusals).
 *
 * Only tracked neutral fixtures and invented values. Not imported by the App.
 */
import assert from 'node:assert/strict'
import type { V2Files } from '../canonical/v2Schema.ts'
import { indexPlaces, reconstructEditorState } from '../canonical/reconstruct.ts'
import { migratedFiles, placeNamed } from './editor.fixture.ts'
import { edgeCaseFixture } from '../store/v2Store.fixture.ts'
import { editorRoute, sameRequest, viewStep, type DoubleRunStep, type RunReport } from './doubleRun.fixture.ts'
import { hideDelta } from './rules/editorView.ts'

/** A step made from the store's V2 view. */
export type Make = (view: V2Files) => DoubleRunStep
export interface Scenario {
  readonly name: string
  readonly files: () => V2Files
  readonly steps: readonly Make[]
  /** Checks of the run beyond the comparison (its saved labels, its refusals). */
  readonly check?: (report: RunReport) => void
}
/** The random sequences: their seeds, and the steps of each. */
export const SEQUENCE_SEEDS = Object.freeze([3404, 5150, 7777])
export const SEQUENCE_STEPS = 240

const scenarios: Scenario[] = []
function scenario(name: string, files: () => V2Files, steps: readonly Make[], check?: (report: RunReport) => void) {
  scenarios.push({ name, files, steps, check })
}

export const idOf = (files: V2Files, en: string, subtype?: 'country' | 'city') => placeNamed(files, en, subtype).id
export const wishAt = (files: V2Files, en: string) => files.wantToGo.items.find(item => item.placeId === idOf(files, en))!
/** The editor lists of a V2 view (as the page saw them). */
export const lists = (files: V2Files) => reconstructEditorState(files.editorState, indexPlaces(files.places.places))
/** The labels that saved / the codes of the refusals. */
export const saved = (report: RunReport) => [...report.tally].filter(([, [ok]]) => ok > 0).map(([label]) => label)
export const refusedCodes = (report: RunReport) => report.outcomes.flatMap(outcome => (outcome.error ? [outcome.error.code] : []))

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
const deleteCountry = (en: string): Make => (view) => sameRequest(`delete ${en}`, editorRoute('countries/delete'), { ids: [idOf(view, en, 'country')] })
const tokyo: Make = () => sameRequest('Tokyo', editorRoute('records'), {
  country: '日本', country_en: 'Japan', city: '东京', city_en: 'Tokyo', start_date: '2026-05-01', lat: 35.68, lng: 139.69, country_code: 'JP',
})
const addCountry = (code: string, visitedDate: string): Make => () => sameRequest(`country ${code}`, editorRoute('countries'), { countryCode: code, visitedDate })
const wish = (label: string, input: unknown): Make => () => sameRequest(label, editorRoute('wanttogo'), input)
const wishById = (en: string, extra: object = {}): Make => (view) => sameRequest(`wish ${en}`, editorRoute('wanttogo'), { placeId: idOf(view, en), ...extra })
const update = (label: string, en: string, input: object): Make => (view) =>
  sameRequest(label, editorRoute('wanttogo/update'), { id: wishAt(view, en).id, ...input })
const remove = (label: string, ids: (view: V2Files) => string[]): Make => (view) =>
  sameRequest(label, editorRoute('wanttogo/delete'), { ids: ids(view) })

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
  () => sameRequest('unknown id', editorRoute('wanttogo/update'), { id: 'synthetic-missing', hidden: true }),
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
  (view) => sameRequest('Osaka joins', editorRoute('wanttogo/convert'), {
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
  () => sameRequest('the planned record', editorRoute('wanttogo/convert'), { source: 'planned', recordId: 'shared-id', startDate: '2027-03-01' }),
  () => sameRequest('the want-to-go item with that id', editorRoute('wanttogo/update'), { id: 'shared-id', note: 'Synthetic', hidden: true }),
  () => sameRequest('delete it', editorRoute('wanttogo/delete'), { ids: ['shared-id'] }),
])

scenario('view operations refused: a hidden city that is no city (the merged lists are checked as a whole, as PUT /state did)', migratedFiles, [
  (view) => viewStep('a country as a city', [{ op: 'hide', scope: 'cities', add: [idOf(view, 'Iceland', 'country')], remove: [] }]),
  () => viewStep('an unknown place', [{ op: 'order', scope: 'countries', ids: ['synthetic-missing'], baseline: [] }]),
], report => assert.deepEqual(refusedCodes(report), ['E_UNKNOWN_PLACE_REF', 'E_UNKNOWN_PLACE_REF']))

// --- 3C-5 C2: the remaining 3C-4a scenarios (records, countries, conversion), now that every endpoint is native.

const record = (label: string, input: (view: V2Files) => object): Make => (view) => sameRequest(label, editorRoute('records'), input(view))
const convert = (label: string, input: (view: V2Files) => object): Make => (view) => sameRequest(label, editorRoute('wanttogo/convert'), input(view))

scenario('POST /records: a new country and city by name, an existing city joining an existing journey, a new journey of the same title', migratedFiles, [
  record('named Tokyo', () => ({
    country: '日本', country_en: 'Japan', city: '东京', city_en: 'Tokyo', start_date: '2026-05-01', end_date: '2026-05-03', lat: 35.68, lng: 139.69, country_code: 'JP',
  })),
  record('Nuuk joins the North Atlantic journey', (view) => ({
    placeId: idOf(view, 'Nuuk'), start_date: '2025-06-20', trip_title: '2025 North Atlantic Demo', journeyId: '2025-north-atlantic-demo', lat: 64.18, lng: -51.72,
  })),
  record('Kyoto with a new journey of the same title', () => ({
    country: '日本', country_en: 'Japan', city: '京都', city_en: 'Kyoto', start_date: '2026-05-04', lat: 35.01, lng: 135.77, country_code: 'JP', trip_title: '日本 · 东京', newJourney: true,
  })),
  record('Kyoto again: the journey choice (candidates in order)', () => ({
    country: '日本', country_en: 'Japan', city: '大阪', city_en: 'Osaka', start_date: '2026-05-06', lat: 34.69, lng: 135.5, country_code: 'JP', trip_title: '日本 · 东京',
  })),
  record('Tokyo by name again: the place choice', () => ({
    country: '日本', country_en: 'Japan', city: '东京', city_en: 'Tokyo', start_date: '2026-06-01', lat: 35.68, lng: 139.69, country_code: 'JP',
  })),
  record('Tokyo by id: E_CITY_EXISTS', (view) => ({ placeId: idOf(view, 'Tokyo'), start_date: '2026-06-01' })),
], report => assert.deepEqual(refusedCodes(report), ['E_JOURNEY_CHOICE_REQUIRED', 'E_PLACE_CHOICE_REQUIRED', 'E_CITY_EXISTS']))

scenario('POST /countries: a new country, a country that only a want-to-go item knew, and one already in the footprint', migratedFiles, [
  addCountry('DK', '2024-03-02'), addCountry('GL', '2027-01-02'), addCountry('IS', '2024-01-01'),
], report => assert.deepEqual(refusedCodes(report), ['E_COUNTRY_EXISTS']))

scenario('POST /wanttogo/convert: a want-to-go item, kept; a planned record (D5); refusals', migratedFiles, [
  convert('Nuuk kept', (view) => ({ source: 'want-to-go', id: wishAt(view, 'Nuuk').id, startDate: '2026-07-01', keepWantToGo: true })),
  convert('planned Bergen', (view) => ({
    source: 'planned', recordId: view.travel.records.find((r) => r.placeId === idOf(view, 'Bergen'))!.id, startDate: '2026-08-01', endDate: '2026-08-03',
  })),
  convert('Nuuk again: in the footprint now', (view) => ({ source: 'want-to-go', id: wishAt(view, 'Nuuk').id, startDate: '2026-07-01' })),
  convert('a missing item', () => ({ source: 'want-to-go', id: 'synthetic-missing', startDate: '2026-07-01' })),
  convert('a missing planned record', () => ({ source: 'planned', recordId: 'synthetic-missing', startDate: '2026-07-01' })),
], report => assert.deepEqual(refusedCodes(report), ['E_CONVERT_CITY_IN_FOOTPRINT', 'E_WTG_NOT_FOUND', 'E_PLANNED_NOT_FOUND']))

scenario('POST /wanttogo/convert: a removed want-to-go item joining an existing journey', migratedFiles, [
  wish('Osaka', { place: { kind: 'city', nameZh: '大阪', nameEn: 'Osaka', countryCode: 'JP', lat: 34.69, lng: 135.5 } }),
  convert('Osaka joins', (view) => ({
    source: 'want-to-go', id: wishAt(view, 'Osaka').id, startDate: '2025-06-25', tripTitle: '2025 North Atlantic Demo', journeyId: '2025-north-atlantic-demo',
  })),
])

/** Every scenario, in the order above. */
export const SCENARIOS: readonly Scenario[] = Object.freeze(scenarios)
