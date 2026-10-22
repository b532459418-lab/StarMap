import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { TravelAtlasEditorState } from './derive/editorState.ts'
import {
  applySetDelta, cityDraftOperations, countryDraftOperations, droneDraftOperations, hideIdsOperation, mergeOrder, photoDraftOperations, restoreHiddenOperation, setDelta,
} from './editorStateDelta.ts'
import { applyViewOperations, type ViewOperation } from './editor/rules/editorView.ts'

const state = (overrides: Partial<TravelAtlasEditorState> = {}): TravelAtlasEditorState => ({
  schemaVersion: 1,
  addedCountries: [],
  countryOrder: [],
  hiddenCountryIds: [],
  cityOrderByCountry: {},
  hiddenCityIds: [],
  mediaOrderByCity: {},
  hiddenMediaIds: [],
  coverMediaByCity: {},
  droneOrderByCity: {},
  hiddenDroneMediaIds: [],
  ...overrides,
})

test('applySetDelta: only this edit is applied; current keeps its order and gains additions at the end', () => {
  assert.deepEqual(applySetDelta(['a', 'b'], ['a', 'b'], ['a', 'b']), ['a', 'b'], 'no edit, no change')
  assert.deepEqual(applySetDelta(['b', 'a'], ['a', 'b'], ['a', 'b', 'c']), ['b', 'a', 'c'], 'addition appended after current order')
  assert.deepEqual(applySetDelta(['a', 'b'], ['a', 'b'], ['b']), ['b'], 'removal')
  assert.deepEqual(applySetDelta([], [], ['x', 'y', 'x']), ['x', 'y'], 'no duplicates')
})

test('applySetDelta: changes made elsewhere after page load survive the save', () => {
  // Page load: a and b hidden. Elsewhere: media import restored a, another tab hid z. Here: the user hid c.
  const baseline = ['a', 'b']
  const current = ['b', 'z']
  const draft = ['a', 'b', 'c']
  assert.deepEqual(applySetDelta(current, baseline, draft), ['b', 'z', 'c'], 'a stays restored, z stays hidden, c is added')
  // Here the user un-hid b; elsewhere y was hidden and a restored.
  assert.deepEqual(applySetDelta(['y'], ['a', 'b'], ['a']), ['y'])
  // An id hidden here and elsewhere is not duplicated.
  assert.deepEqual(applySetDelta(['c'], [], ['c']), ['c'])
})

test('mergeOrder: draft order wins, ids removed elsewhere are dropped, ids added elsewhere are appended in current order', () => {
  assert.deepEqual(mergeOrder(['a', 'b', 'c'], ['c', 'a', 'b']), ['c', 'a', 'b'])
  assert.deepEqual(mergeOrder(['a', 'b', 'd', 'e'], ['c', 'b', 'a']), ['b', 'a', 'd', 'e'], 'c no longer exists; d and e were added elsewhere')
  assert.deepEqual(mergeOrder(['a', 'b', 'd'], ['c', 'b', 'a'], ['a', 'b', 'c']), ['b', 'a', 'd'], 'with a baseline, c was removed elsewhere')
})

test('mergeOrder: with a baseline, ids that were never in the saved order are not mistaken for removed ones', () => {
  // Never saved before: current and baseline are empty and the draft is the full default order.
  assert.deepEqual(mergeOrder([], ['c', 'a', 'b'], []), ['c', 'a', 'b'])
  // Saved order was partial (x was added later and never ordered); another tab saved [b, a] meanwhile.
  assert.deepEqual(mergeOrder(['b', 'a'], ['x', 'a', 'b'], ['a', 'b']), ['x', 'a', 'b'])
  // Without a baseline the literal rule applies: only ids still in current are kept.
  assert.deepEqual(mergeOrder([], ['c', 'a', 'b']), [])
})

test('setDelta: the two halves of applySetDelta', () => {
  assert.deepEqual(setDelta(['a', 'b'], ['b', 'c', 'd']), { add: ['c', 'd'], remove: ['a'] })
  const current = ['z', 'a', 'b']
  const { add, remove } = setDelta(['a', 'b'], ['b', 'c'])
  assert.deepEqual(applySetDelta(current, remove, add), applySetDelta(current, ['a', 'b'], ['b', 'c']))
})

// 3C-5 C1: the cards send view operations; the server merges them into its current state (rules/editorView.ts).
const merged = (current: TravelAtlasEditorState, operations: readonly ViewOperation[]) => ({ ...current, ...applyViewOperations(current, operations) })

test('restore and hide-before-delete: only the listed ids leave or join the hidden list', () => {
  assert.deepEqual(merged(state({ hiddenCityIds: ['a', 'b', 'z'] }), [restoreHiddenOperation('cities', ['a', 'b'])]).hiddenCityIds, ['z'])
  assert.deepEqual(merged(state({ hiddenMediaIds: ['z', 'a'] }), [hideIdsOperation('media', ['a', 'b'])]).hiddenMediaIds, ['z', 'a', 'b'])
})

test('InfoCard city save: hidden cities hidden or restored elsewhere are not overwritten; the country order is scoped', () => {
  const operations = cityDraftOperations({
    countryId: 'country-1', draftCityIds: ['city-2', 'city-1'], baselineCityIds: ['city-1', 'city-2'], baselineHiddenCityIds: ['city-9'], draftHiddenCityIds: ['city-9', 'city-3'],
  })
  const current = state({ hiddenCityIds: ['city-7'], cityOrderByCountry: { 'country-1': ['city-1', 'city-2'], 'country-2': ['city-5'] } })
  const next = merged(current, operations)
  assert.deepEqual(next.hiddenCityIds, ['city-7', 'city-3'], 'city-9 restored elsewhere stays restored; city-7 hidden elsewhere stays hidden')
  assert.deepEqual(next.cityOrderByCountry, { 'country-1': ['city-2', 'city-1'], 'country-2': ['city-5'] })
})

test('InfoCard photo save: photos restored by a media import after page load stay visible, and stay in the order', () => {
  const operations = photoDraftOperations({
    cityId: 'city-1', draftPhotoIds: ['m2', 'm1'], baselinePhotoIds: ['m1', 'm2'], baselineHiddenPhotoIds: ['m-restored', 'm-old'],
    draftHiddenPhotoIds: ['m-restored', 'm-old', 'm-new'], draftCoverPhotoId: 'm2',
  })
  // A media import removed m-restored from the hidden list and added it to the order after this page loaded.
  const current = state({ hiddenMediaIds: ['m-old', 'm-other-tab'], mediaOrderByCity: { 'city-1': ['m1', 'm2', 'm-restored'], 'city-2': ['m9'] }, coverMediaByCity: { 'city-2': 'm9' } })
  const next = merged(current, operations)
  assert.deepEqual(next.hiddenMediaIds, ['m-old', 'm-other-tab', 'm-new'])
  // Before 3C-5 C1 the page replaced the city's order with its draft and dropped m-restored; the merge keeps it after the draft.
  assert.deepEqual(next.mediaOrderByCity, { 'city-1': ['m2', 'm1', 'm-restored'], 'city-2': ['m9'] })
  assert.deepEqual(next.coverMediaByCity, { 'city-2': 'm9', 'city-1': 'm2' })
  // No cover in the draft: no cover operation.
  const none = photoDraftOperations({ cityId: 'city-1', draftPhotoIds: [], baselinePhotoIds: [], baselineHiddenPhotoIds: [], draftHiddenPhotoIds: [] })
  assert.equal(none.some(operation => operation.op === 'cover'), false)
  // Without changes elsewhere the order is the draft, as before.
  assert.deepEqual(merged(state({ mediaOrderByCity: { 'city-1': ['m1', 'm2'] } }), operations).mediaOrderByCity['city-1'], ['m2', 'm1'])
})

test('CountrySelector save: another tab\'s hidden countries and new countries survive; the draft order wins', () => {
  const operations = countryDraftOperations({ draftCountryIds: ['c3', 'c1', 'c2'], baselineCountryOrder: ['c1', 'c2', 'c3'], baselineHiddenCountryIds: [], draftHiddenCountryIds: ['c4'] })
  // Elsewhere: c2 deleted (gone from the order), c5 added, c6 hidden.
  const next = merged(state({ countryOrder: ['c1', 'c3', 'c5'], hiddenCountryIds: ['c6'] }), operations)
  assert.deepEqual(next.countryOrder, ['c3', 'c1', 'c5'])
  assert.deepEqual(next.hiddenCountryIds, ['c6', 'c4'])
  // First save ever: the default order is saved as drafted.
  const first = countryDraftOperations({ draftCountryIds: ['c2', 'c1'], baselineCountryOrder: [], baselineHiddenCountryIds: [], draftHiddenCountryIds: [] })
  assert.deepEqual(merged(state(), first).countryOrder, ['c2', 'c1'])
})

test('DroneMediaCard save: drone media hidden or restored elsewhere is kept; the city order is scoped', () => {
  const operations = droneDraftOperations({ cityId: 'city-1', draftItemIds: ['d2', 'd1'], baselineItemIds: ['d1', 'd2'], baselineHiddenIds: ['d-restored'], draftHiddenIds: ['d-restored', 'd3'] })
  const current = state({ hiddenDroneMediaIds: ['d-other'], droneOrderByCity: { 'city-1': ['d1', 'd2'], 'city-2': ['d8'] } })
  const next = merged(current, operations)
  assert.deepEqual(next.hiddenDroneMediaIds, ['d-other', 'd3'])
  assert.deepEqual(next.droneOrderByCity, { 'city-1': ['d2', 'd1'], 'city-2': ['d8'] })
  assert.equal(next.hiddenMediaIds, current.hiddenMediaIds, 'unrelated fields are passed through from current')
})
