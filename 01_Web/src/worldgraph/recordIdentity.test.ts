/// <reference types="node" />
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { plannedRecordsToWorldGraph, PLANNED_SOURCE } from './adapters/plannedRecords.ts'
import { wantToGoToWorldGraph, WANT_TO_GO_SOURCE } from './adapters/wantToGo.ts'
import { placesToWorldGraph } from './adapters/places.ts'
import { collectionEntryKey, filterCollection, queryCollection } from './collection.ts'
import { mergeWorldGraphSnapshots } from './snapshot.ts'
import { membershipIdentityKey, membershipRecordRef, recordRefKey, recordSourceKindOf } from './recordIdentity.ts'
import { wantToGoCardRecordOf } from '../data/derive/wantToGo.ts'
import type { LayerMembership } from './types.ts'

const now = '2026-10-03T00:00:00.000Z'
const collision = () => mergeWorldGraphSnapshots(
  placesToWorldGraph([{ id: 'city', subtype: 'city', title: { names: { en: 'City' } } }], { now }),
  wantToGoToWorldGraph([{ id: 'opaque:id', placeId: 'city', addedAt: '2020-01-01', hidden: true, source: PLANNED_SOURCE }]),
  plannedRecordsToWorldGraph([{ id: 'opaque:id', placeId: 'city', start_date: '2026-01-01' }]),
)

test('Same opaque ID in WTG and planned survives snapshot and full management collection', () => {
  const snapshot = collision()
  assert.equal(snapshot.memberships.length, 2)
  const entries = queryCollection(snapshot, 'want_to_go', 'en')
  assert.deepEqual(entries.map(entry => entry.recordId), ['opaque:id', 'opaque:id'])
  assert.deepEqual(new Set(entries.map(entry => entry.source)), new Set([PLANNED_SOURCE, WANT_TO_GO_SOURCE]))
  assert.equal(new Set(entries.map(collectionEntryKey)).size, 2)
  assert.equal(entries.find(entry => entry.source === WANT_TO_GO_SOURCE)?.hidden, true)
  assert.equal(entries.find(entry => entry.source === PLANNED_SOURCE)?.readOnly, true)
})

test('Collection source tie-break is deterministic regardless of membership order', () => {
  const snapshot = collision()
  snapshot.memberships.forEach(member => { member.addedAt = now })
  const normal = queryCollection(snapshot, 'want_to_go', 'en')
  const reversed = queryCollection({ ...snapshot, memberships: [...snapshot.memberships].reverse() }, 'want_to_go', 'en')
  for (const sort of ['recent', 'name', 'country'] as const) {
    assert.deepEqual(filterCollection(normal, { sort }, 'en'), filterCollection(reversed, { sort }, 'en'))
  }
})

test('Only fixed adapter metadata establishes a recognized source', () => {
  assert.equal(recordSourceKindOf('want_to_go', 'travel-map:planned'), 'planned')
  assert.equal(recordSourceKindOf('want_to_go', 'want-to-go'), 'want-to-go')
  assert.equal(recordSourceKindOf('want_to_go', 'my-editor'), undefined)
  assert.equal(recordSourceKindOf('travel', 'my-editor'), 'travel')
  assert.equal(recordSourceKindOf('travel', 'want-to-go'), 'travel')
  assert.equal(membershipRecordRef({ entityId: 'city', layerId: 'travel', addedBy: 'rule', addedAt: now }), undefined)
})

test('Unknown sources keep first-wins deduplication and separator-containing IDs stay distinct', () => {
  const member: LayerMembership = { entityId: 'a:b', layerId: 'want_to_go', recordId: 'c', addedBy: 'user', addedAt: now }
  const snapshot = mergeWorldGraphSnapshots({ entities: [], anchors: [], relations: [], memberships: [member, { ...member, metadata: { source: 'custom' } }] })
  assert.equal(snapshot.memberships.length, 1)
  assert.notEqual(membershipIdentityKey(member), membershipIdentityKey({ ...member, entityId: 'a', recordId: 'b:c' }))
  assert.notEqual(recordRefKey({ sourceKind: 'planned', recordId: 'same' }), recordRefKey({ sourceKind: 'want-to-go', recordId: 'same' }))
})

test('Matched card selection uses source identity and never falls back from an empty match', () => {
  const snapshot = collision()
  snapshot.memberships.forEach(member => { if (member.metadata) member.metadata.hidden = false })
  assert.deepEqual(wantToGoCardRecordOf(snapshot.memberships, 'city'), { source: 'want-to-go', recordId: 'opaque:id' })
  assert.deepEqual(wantToGoCardRecordOf(snapshot.memberships, 'city', [{ sourceKind: 'planned', recordId: 'opaque:id' }]), { source: 'planned', recordId: 'opaque:id' })
  assert.equal(wantToGoCardRecordOf(snapshot.memberships, 'city', []), undefined)
  assert.equal(wantToGoCardRecordOf(snapshot.memberships, 'city', [{ sourceKind: 'travel', recordId: 'opaque:id' }]), undefined)
})
