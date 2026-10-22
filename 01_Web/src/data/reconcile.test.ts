/**
 * Structural sharing (./reconcile.ts, 3C-5 D): equal parts keep the previous objects, changed parts are the new ones,
 * and the result always equals `next`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reconcile } from './reconcile.ts'

test('equal data give back the previous objects, all the way down', () => {
  const prev = { list: [{ id: 'a', n: 1 }, { id: 'b', n: 2 }], map: new Map([['k', { v: 1 }]]), set: new Set(['x']), at: 'now' }
  const next = structuredClone(prev)
  assert.equal(reconcile(prev, next), prev)
})

test('a changed item is new; its unchanged siblings and the unchanged branches stay the previous objects', () => {
  const prev = { list: [{ id: 'a', n: 1 }, { id: 'b', n: 2 }], other: { deep: { v: 1 } } }
  const next = { list: [{ id: 'a', n: 1 }, { id: 'b', n: 3 }], other: { deep: { v: 1 } } }
  const result = reconcile(prev, next)
  assert.deepEqual(result, next)
  assert.notEqual(result, prev)
  assert.notEqual(result.list, prev.list)
  assert.equal(result.list[0], prev.list[0])
  assert.notEqual(result.list[1], prev.list[1])
  assert.equal(result.other, prev.other)
})

test('arrays of records are matched by id, not by position', () => {
  const prev = [{ id: 'a', n: 1 }, { id: 'b', n: 2 }]
  const next = [{ id: 'b', n: 2 }, { id: 'a', n: 1 }, { id: 'c', n: 3 }]
  const result = reconcile(prev, next)
  assert.deepEqual(result, next)
  assert.equal(result[0], prev[1])
  assert.equal(result[1], prev[0])
  assert.equal(result[2], next[2])
})

test('maps by key and sets by members; a removed key or member makes a new one', () => {
  const prev = { map: new Map([['a', { v: 1 }], ['b', { v: 2 }]]), set: new Set(['x', 'y']) }
  const next = { map: new Map([['a', { v: 1 }]]), set: new Set(['x']) }
  const result = reconcile(prev, next)
  assert.deepEqual(result, next)
  assert.notEqual(result.map, prev.map)
  assert.equal(result.map.get('a'), prev.map.get('a'))
  assert.notEqual(result.set, prev.set)
})

test('an object with functions is the previous one when everything else is; otherwise it keeps the new functions', () => {
  const make = (n: number) => ({ items: [{ id: 'a', n }], lookup: (id: string) => id === 'a' ? n : undefined })
  const prev = make(1)
  assert.equal(reconcile(prev, make(1)), prev)
  const next = make(2)
  const changed = reconcile(prev, next)
  assert.notEqual(changed, prev)
  assert.equal(changed.lookup, next.lookup)
  assert.equal(changed.lookup('a'), 2)
})

test('class instances are kept only when they are the same object; frozen objects stay frozen', () => {
  const date = new Date(0)
  const prev = { when: date, frozen: Object.freeze({ v: 1, w: [1] }) }
  const next = { when: new Date(0), frozen: Object.freeze({ v: 2, w: [1] }) }
  const result = reconcile(prev, next)
  assert.equal(result.when, next.when)
  assert.ok(Object.isFrozen(result.frozen))
  assert.equal(result.frozen.w, prev.frozen.w)
})

test('an object shared within next is reconciled once and stays shared', () => {
  const shared = { id: 'a', n: 2 }
  const next = { one: shared, two: shared }
  const result = reconcile({ one: { id: 'a', n: 1 }, two: { id: 'a', n: 1 } }, next)
  assert.equal(result.one, result.two)
})
