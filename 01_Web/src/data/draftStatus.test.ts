import { test } from 'node:test'
import assert from 'node:assert/strict'
import { draftStatusOf } from './draftStatus.ts'

const list = (order: string[], hidden: string[] = [], cover: string | null = null) => ({ order, hidden, cover })

test('性能续 P5: the data as they were: editing, whatever the editor did', () => {
  assert.equal(draftStatusOf({ base: list(['a', 'b']), current: list(['a', 'b']) }), 'editing')
  assert.equal(draftStatusOf({ base: list(['a', 'b']), current: list(['a', 'b']), localAtStart: ['a', 'b'], local: ['b', 'a'] }), 'editing')
})

test('性能续 P5: changed elsewhere without local edits follows; with local edits it is a conflict', () => {
  const base = list(['a', 'b'])
  const current = list(['a', 'b', 'c'])
  // No local edits: the editor's values are what they were when the draft started.
  assert.equal(draftStatusOf({ base, current, localAtStart: { order: ['a', 'b'], hidden: [] }, local: { order: ['a', 'b'], hidden: [] } }), 'follow')
  // A row moved and back is no edit.
  const movedBack = ['b', 'a'].reverse()
  assert.equal(draftStatusOf({ base, current, localAtStart: { order: ['a', 'b'] }, local: { order: movedBack } }), 'follow')
  // A row moved, a new cover, a typed note: local edits.
  assert.equal(draftStatusOf({ base, current, localAtStart: { order: ['a', 'b'] }, local: { order: ['b', 'a'] } }), 'changed')
  assert.equal(draftStatusOf({ base, current, localAtStart: { order: ['a', 'b'], cover: 'a' }, local: { order: ['a', 'b'], cover: 'b' } }), 'changed')
  assert.equal(draftStatusOf({ base: { note: 'x' }, current: { note: 'y' }, localAtStart: { note: 'x' }, local: { note: 'x!' } }), 'changed')
})

test('性能续 P5: without local values a change elsewhere is a conflict, as before', () => {
  assert.equal(draftStatusOf({ base: { note: 'x' }, current: { note: 'y' } }), 'changed')
})

test('性能续 P5: a record gone is deleted, also without local edits', () => {
  assert.equal(draftStatusOf({ base: { note: 'x' }, current: undefined, localAtStart: { note: 'x' }, local: { note: 'x' } }), 'deleted')
  assert.equal(draftStatusOf({ base: { note: 'x' }, current: undefined }), 'deleted')
})
