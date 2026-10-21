/// <reference types="node" />
/** The view operations of 3C-5 C1 (rules/editorView.ts): shape checks, and the merge semantics of the old updaters. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { V2WriteError } from '../../v2write/errors.ts'
import { mergeOrder } from '../../editorStateDelta.ts'
import { applyHide, applyViewOperations, hideDelta, mergeKeyedOrder, parseViewOperations, type ViewLists } from './editorView.ts'

const EMPTY: ViewLists = {
  countryOrder: [], hiddenCountryIds: [], cityOrderByCountry: {}, hiddenCityIds: [], mediaOrderByCity: {}, hiddenMediaIds: [],
  coverMediaByCity: {}, droneOrderByCity: {}, hiddenDroneMediaIds: [],
}
const invalid = (field: string) => (error: unknown) =>
  error instanceof V2WriteError && error.code === 'E_EDITOR_STATE_INVALID' && (error.params as { field: string }).field === field

test('parseViewOperations: the four operations; a malformed one names its field', () => {
  const operations = [
    { op: 'order', scope: 'countries', ids: ['a'], baseline: [] },
    { op: 'order', scope: 'media', key: 'c', ids: ['m'], baseline: ['m'] },
    { op: 'hide', scope: 'drone', add: ['d'], remove: [] },
    { op: 'cover', key: 'c', id: 'm' },
  ]
  assert.deepEqual(parseViewOperations({ operations }), operations)
  assert.throws(() => parseViewOperations({}), invalid('operations'))
  assert.throws(() => parseViewOperations({ operations: [] }), invalid('operations'))
  assert.throws(() => parseViewOperations({ operations: [null] }), invalid('operations[0]'))
  assert.throws(() => parseViewOperations({ operations: [{ op: 'move' }] }), invalid('operations[0].op'))
  assert.throws(() => parseViewOperations({ operations: [operations[0], { op: 'order', scope: 'places', ids: [], baseline: [] }] }), invalid('operations[1].scope'))
  assert.throws(() => parseViewOperations({ operations: [{ op: 'order', scope: 'cities', ids: [], baseline: [] }] }), invalid('operations[0].key'))
  assert.throws(() => parseViewOperations({ operations: [{ op: 'hide', scope: 'cities', add: [1], remove: [] }] }), invalid('operations[0].add'))
  assert.throws(() => parseViewOperations({ operations: [{ op: 'cover', key: 'c', id: '' }] }), invalid('operations[0].id'))
})

test('applyHide and hideDelta: (current − remove) ∪ add, appended in order, never twice; the delta of a draft', () => {
  assert.deepEqual(applyHide(['a', 'b', 'c'], ['d', 'a', 'd'], ['b']), ['a', 'c', 'd'])
  assert.deepEqual(applyHide(['a', 'a'], [], []), ['a', 'a'])
  assert.deepEqual(hideDelta(['a', 'b'], ['b', 'c']), { add: ['c'], remove: ['a'] })
  // Applying the delta of a draft to its own baseline gives the draft's set.
  assert.deepEqual(new Set(applyHide(['a', 'b'], ...Object.values(hideDelta(['a', 'b'], ['b', 'c'])) as [string[], string[]])), new Set(['b', 'c']))
})

test('mergeKeyedOrder: the draft as it is without concurrent changes; ids added elsewhere stay, ids the draft removed leave', () => {
  assert.deepEqual(mergeKeyedOrder(['a', 'b', 'c'], ['c', 'a'], ['a', 'b', 'c']), ['c', 'a'])
  assert.deepEqual(mergeKeyedOrder([], ['x', 'y'], []), ['x', 'y'])
  // Another page added d meanwhile: kept after the draft.
  assert.deepEqual(mergeKeyedOrder(['a', 'b', 'c', 'd'], ['c', 'a'], ['a', 'b', 'c']), ['c', 'a', 'd'])
  // Another page removed a meanwhile: not brought back.
  assert.deepEqual(mergeKeyedOrder(['b', 'c'], ['c', 'a', 'b'], ['a', 'b', 'c']), ['c', 'b'])
  // The countries' updater: mergeOrder keeps the ids the draft left out.
  assert.deepEqual(mergeOrder(['a', 'b', 'c'], ['c', 'a'], ['a', 'b', 'c']), ['c', 'a', 'b'])
})

test('applyViewOperations: in order; unknown media ids an operation brings are ignored when isKnownMedia is given, ids a list holds stay', () => {
  const current: ViewLists = { ...EMPTY, countryOrder: ['p1', 'p2'], mediaOrderByCity: { c: ['m1', 'gone'] }, hiddenMediaIds: ['gone'], coverMediaByCity: { c: 'm1' } }
  const operations = [
    { op: 'order', scope: 'countries', ids: ['p2', 'p1'], baseline: ['p1', 'p2'] },
    { op: 'order', scope: 'media', key: 'c', ids: ['x', 'gone', 'm2', 'm1'], baseline: ['m1', 'gone'] },
    { op: 'hide', scope: 'media', add: ['x', 'm2', 'gone'], remove: [] },
    { op: 'cover', key: 'c', id: 'x' },
    { op: 'hide', scope: 'cities', add: ['c'], remove: [] },
  ] as const
  const known = (id: string) => id.startsWith('m')
  assert.deepEqual(applyViewOperations(current, operations, known), {
    ...current, countryOrder: ['p2', 'p1'], mediaOrderByCity: { c: ['gone', 'm2', 'm1'] }, hiddenMediaIds: ['gone', 'm2'], hiddenCityIds: ['c'],
  })
  // Without isKnownMedia (the page's own merge before 3C-5 C1) every id stays.
  assert.deepEqual(applyViewOperations(current, operations), {
    ...current, countryOrder: ['p2', 'p1'], mediaOrderByCity: { c: ['x', 'gone', 'm2', 'm1'] }, hiddenMediaIds: ['gone', 'x', 'm2'], coverMediaByCity: { c: 'x' }, hiddenCityIds: ['c'],
  })
  // The input is not changed.
  assert.deepEqual(current.mediaOrderByCity, { c: ['m1', 'gone'] })
})
