/**
 * The shared indexes of a snapshot (./graphIndex.ts): the first entity per id, the first finite location per entity,
 * built once per array.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { entityIndexOf, locationIndexOf } from './graphIndex.ts'
import type { Anchor, Entity } from './types.ts'

const entity = (id: string, name: string) => ({ id, type: 'place', subtype: 'city', title: { names: { en: name } }, metadata: {} }) as unknown as Entity
const anchor = (entityId: string, lat: unknown, kind = 'location') => ({ entityId, kind, lat, lng: 10, precision: 'city' }) as unknown as Anchor

test('the first entity per id; the same index for the same array, another for another array', () => {
  const entities = [entity('a', 'First'), entity('b', 'B'), entity('a', 'Second')]
  const index = entityIndexOf(entities)
  assert.equal(index.get('a'), entities[0])
  assert.equal(index.size, 2)
  assert.equal(entityIndexOf(entities), index)
  assert.notEqual(entityIndexOf([...entities]), index)
})

test('the first location anchor with finite coordinates per entity', () => {
  const anchors = [anchor('a', Number.NaN), anchor('a', 5, 'area'), anchor('a', 6), anchor('a', 7), anchor('b', null)]
  const index = locationIndexOf(anchors)
  assert.equal(index.get('a'), anchors[2])
  assert.equal(index.has('b'), false)
  assert.equal(locationIndexOf(anchors), index)
})
