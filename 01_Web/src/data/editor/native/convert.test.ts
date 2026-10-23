/// <reference types="node" />
/**
 * The store-native conversion (3C-5 C2) and D5 (design review, note 5): a planned record that becomes visited keeps its
 * identity. Its planned entry `(v2:planned, id)` goes and a travel entry with the source identity `(v2:travel, id)`
 * replaces it; the planner accepts that in one batch and in two, and the tombstone rule only forbids reusing the planned
 * entry's own row id. The record keeps its V2 id and its place in the records (a page's selection stays). Results and
 * refusals against the old engine are the double run's (../doubleRun.test.ts).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FormalCommand, FormalState, ViewItem } from '../../../worldgraph/store/formal.ts'
import { applyChangeSet, planCommands } from '../../../worldgraph/store/planner.ts'
import { memoryReader } from '../../../worldgraph/store/reader.ts'
import type { LayerEntry } from '../../../worldgraph/store/types.ts'
import { viewOf } from '../../store/v2Store.fixture.ts'
import { OFFICIAL, OFFICIAL_POLICY, V2_SOURCES, VIEW_SCOPES } from '../../store/officialDefinitions.ts'
import { migratedFiles, placeNamed } from '../editor.fixture.ts'
import { doubleRunStore } from '../doubleRun.fixture.ts'
import { canonicalOf, runNative } from './native.fixture.ts'

const NOW = '2026-09-27T09:00:00.000Z'
const NEW_ID = '01990000-0000-7000-8000-00000000c001'
const plan = (state: FormalState, commands: readonly FormalCommand[]) =>
  applyChangeSet(state, planCommands(memoryReader(state), commands, { baseRevision: state.revision, now: NOW, policy: OFFICIAL_POLICY }))
const error = (run: () => unknown) => { try { run(); return undefined } catch (caught) { return (caught as { code?: string }).code } }

/** The migrated fixture's planned record on Bergen, its entry, and its view rows. */
function plannedBergen() {
  const store = doubleRunStore(migratedFiles())
  const files = viewOf(store.state)
  const record = files.travel.records.find((candidate) => candidate.placeId === placeNamed(files, 'Bergen').id && candidate.status === 'planned')!
  const entry = store.state.entries.find((row) => row.source.sourceId === V2_SOURCES.planned && row.source.recordId === record.id)!
  return { store, record, entry }
}

test('D5: the planner accepts the travel entry (v2:travel, id) replacing the planned entry (v2:planned, id), in one batch or two; only the planned entry\'s own id is tombstoned', () => {
  const { store, record, entry } = plannedBergen()
  const travel: LayerEntry = {
    id: NEW_ID, revision: 0, layerId: OFFICIAL.travel, entityId: entry.entityId, fields: { date: { raw: { startDate: '2026-08-01', year: 2026 } } },
    source: { sourceId: V2_SOURCES.travel, recordId: record.id, evidenceIds: [] }, createdAt: NOW, updatedAt: NOW,
  }
  const rows = store.state.viewItems.filter((row) => row.itemTable === 'entries' && row.itemId === entry.id)
  const retarget = rows.map((row): FormalCommand => ({ op: 'update', table: 'viewItems', id: row.id, expectedRevision: row.revision, value: { ...row, revision: row.revision + 1, itemId: NEW_ID } as ViewItem }))
  // One batch: create, retarget the view rows, remove the planned entry.
  const once = plan(store.state, [{ op: 'create', table: 'entries', value: travel }, ...retarget, { op: 'remove', table: 'entries', id: entry.id, expectedRevision: entry.revision }])
  assert.ok(once.entries.some((row) => row.id === NEW_ID))
  assert.equal(once.entries.some((row) => row.id === entry.id), false)
  assert.ok(once.tombstones.some((row) => row.table === 'entries' && row.id === entry.id))
  // Two batches: the planned entry goes first (its view rows follow it), the travel entry comes later with the same source identity.
  const removed = plan(store.state, [{ op: 'remove', table: 'entries', id: entry.id, expectedRevision: entry.revision }])
  assert.ok(plan(removed, [{ op: 'create', table: 'entries', value: travel }]).entries.some((row) => row.id === NEW_ID))
  // The tombstone rule: the planned entry's own id cannot come back, so the travel entry gets a new one.
  assert.equal(error(() => plan(removed, [{ op: 'create', table: 'entries', value: { ...travel, id: entry.id } }])), 'E_RECREATE_ID')
})

test('D5 through the endpoint: the converted record keeps its V2 id, its place in the records and its flag; its source is (v2:travel, id)', () => {
  const { store, record, entry } = plannedBergen()
  const before = canonicalOf(store.state).travel.records
  const at = before.findIndex((candidate) => candidate.id === record.id)
  const hiddenBefore = before[at].hiddenFromHome
  const converted = runNative(store, 'wanttogo/convert', { source: 'planned', recordId: record.id, startDate: '2026-08-01', endDate: '2026-08-03' }, 1)
  assert.ok(converted.state, JSON.stringify(converted.error))
  assert.deepEqual(converted.result, { travelRecordId: record.id, countryId: placeNamed(viewOf(store.state), 'Norway').id, cityId: record.placeId, wantToGoRemoved: false })
  const after = canonicalOf(store.state).travel.records
  assert.equal(after.findIndex((candidate) => candidate.id === record.id), at, 'the same place in the records: a selection by id stays')
  const visited = after[at]
  assert.deepEqual([visited.id, visited.start_date, visited.end_date, visited.year, visited.hiddenFromHome], [record.id, '2026-08-01', '2026-08-03', 2026, hiddenBefore])
  assert.notEqual(visited.status, 'planned')
  const replacement = store.state.entries.find((row) => row.source.sourceId === V2_SOURCES.travel && row.source.recordId === record.id)!
  assert.equal(replacement.layerId, OFFICIAL.travel)
  assert.notEqual(replacement.id, entry.id)
  assert.ok(store.state.tombstones.some((row) => row.table === 'entries' && row.id === entry.id))
  assert.ok(store.state.viewItems.some((row) => row.scope === VIEW_SCOPES.recordOrder && row.itemId === replacement.id))
  assert.equal(store.state.viewItems.some((row) => row.itemId === entry.id), false)
  // It joined a journey (a new one: no other record has its title).
  assert.equal(typeof visited.journeyId, 'string')
})
