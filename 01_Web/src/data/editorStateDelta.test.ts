import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { TravelAtlasEditorState } from './derive/editorState.ts'
import {
  applySetDelta, cityDraftUpdater, countryDraftUpdater, droneDraftUpdater, mergeOrder, photoDraftUpdater, withoutIds,
} from './editorStateDelta.ts'

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

test('withoutIds: restoring hidden items removes only the listed ids', () => {
  assert.deepEqual(withoutIds(['a', 'b', 'z'], ['a', 'b']), ['z'])
})

test('InfoCard city save: hidden cities hidden or restored elsewhere are not overwritten; the country order is scoped', () => {
  const update = cityDraftUpdater({ countryId: 'country-1', draftCityIds: ['city-2', 'city-1'], baselineHiddenCityIds: ['city-9'], draftHiddenCityIds: ['city-9', 'city-3'] })
  const current = state({ hiddenCityIds: ['city-7'], cityOrderByCountry: { 'country-1': ['city-1', 'city-2'], 'country-2': ['city-5'] } })
  const next = update(current)
  assert.deepEqual(next.hiddenCityIds, ['city-7', 'city-3'], 'city-9 restored elsewhere stays restored; city-7 hidden elsewhere stays hidden')
  assert.deepEqual(next.cityOrderByCountry, { 'country-1': ['city-2', 'city-1'], 'country-2': ['city-5'] })
})

test('InfoCard photo save: photos restored by a media import after page load stay visible', () => {
  const update = photoDraftUpdater({ cityId: 'city-1', draftPhotoIds: ['m2', 'm1'], baselineHiddenPhotoIds: ['m-restored', 'm-old'], draftHiddenPhotoIds: ['m-restored', 'm-old', 'm-new'], draftCoverPhotoId: 'm2' })
  // restoreImportedMedia removed m-restored from the hidden list after this page loaded.
  const current = state({ hiddenMediaIds: ['m-old', 'm-other-tab'], mediaOrderByCity: { 'city-1': ['m1', 'm2', 'm-restored'], 'city-2': ['m9'] }, coverMediaByCity: { 'city-2': 'm9' } })
  const next = update(current)
  assert.deepEqual(next.hiddenMediaIds, ['m-old', 'm-other-tab', 'm-new'])
  assert.deepEqual(next.mediaOrderByCity, { 'city-1': ['m2', 'm1'], 'city-2': ['m9'] })
  assert.deepEqual(next.coverMediaByCity, { 'city-2': 'm9', 'city-1': 'm2' })
  assert.deepEqual(photoDraftUpdater({ cityId: 'city-1', draftPhotoIds: [], baselineHiddenPhotoIds: [], draftHiddenPhotoIds: [] })(current).coverMediaByCity, current.coverMediaByCity)
})

test('CountrySelector save: another tab\'s hidden countries and new countries survive; the draft order wins', () => {
  const update = countryDraftUpdater({ draftCountryIds: ['c3', 'c1', 'c2'], baselineCountryOrder: ['c1', 'c2', 'c3'], baselineHiddenCountryIds: [], draftHiddenCountryIds: ['c4'] })
  // Elsewhere: c2 deleted (gone from the order), c5 added, c6 hidden.
  const current = state({ countryOrder: ['c1', 'c3', 'c5'], hiddenCountryIds: ['c6'] })
  const next = update(current)
  assert.deepEqual(next.countryOrder, ['c3', 'c1', 'c5'])
  assert.deepEqual(next.hiddenCountryIds, ['c6', 'c4'])
  // First save ever: the default order is saved as drafted.
  assert.deepEqual(countryDraftUpdater({ draftCountryIds: ['c2', 'c1'], baselineCountryOrder: [], baselineHiddenCountryIds: [], draftHiddenCountryIds: [] })(state()).countryOrder, ['c2', 'c1'])
})

test('DroneMediaCard save: drone media hidden or restored elsewhere is kept; the city order is scoped', () => {
  const update = droneDraftUpdater({ cityId: 'city-1', draftItemIds: ['d2', 'd1'], baselineHiddenIds: ['d-restored'], draftHiddenIds: ['d-restored', 'd3'] })
  const current = state({ hiddenDroneMediaIds: ['d-other'], droneOrderByCity: { 'city-1': ['d1', 'd2'], 'city-2': ['d8'] } })
  const next = update(current)
  assert.deepEqual(next.hiddenDroneMediaIds, ['d-other', 'd3'])
  assert.deepEqual(next.droneOrderByCity, { 'city-1': ['d2', 'd1'], 'city-2': ['d8'] })
  assert.equal(next.hiddenMediaIds, current.hiddenMediaIds, 'unrelated fields are passed through from current')
})
