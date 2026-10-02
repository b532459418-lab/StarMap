/// <reference types="node" />
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { officialLayers, TRAVEL_LAYER_ID, WANT_TO_GO_LAYER_ID } from './layers.ts'

test('Official layer labels are namespace keys that Core does not translate', () => {
  assert.deepEqual(officialLayers.map(({ id, labelKey }) => ({ id, labelKey })), [
    { id: TRAVEL_LAYER_ID, labelKey: 'layer:travel' },
    { id: WANT_TO_GO_LAYER_ID, labelKey: 'layer:wantToGo' },
  ])
  for (const layer of officialLayers) {
    assert.equal(Object.hasOwn(layer, 'label'), false)
  }
})

test('Moving layer wording out of Core preserves identity, projection and visual defaults', () => {
  const behavior = officialLayers.map(({ id, icon, accent, defaultVisible, order, mapSubtypes, projection }) => ({
    id, icon, accent, defaultVisible, order, mapSubtypes, projection,
  }))
  assert.deepEqual(behavior, [
    {
      id: 'travel',
      icon: 'Footprints',
      accent: '#38bdf8',
      defaultVisible: true,
      order: 0,
      mapSubtypes: ['city'],
      projection: { default: 'self', editablePerEntity: false },
    },
    {
      id: 'want_to_go',
      icon: 'Heart',
      accent: '#F0647A',
      defaultVisible: true,
      order: 1,
      mapSubtypes: ['city', 'country'],
      projection: { default: 'self', editablePerEntity: false },
    },
  ])
})
