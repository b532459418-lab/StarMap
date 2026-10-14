/// <reference types="node" />
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type FormalState, FORMAL_TABLES } from '../../worldgraph/store/formal.ts'
import { memoryReader } from '../../worldgraph/store/reader.ts'
import { applyChangeSet, planCommands } from '../../worldgraph/store/planner.ts'
import type { LayerEntry } from '../../worldgraph/store/types.ts'
import { buildBaseline, stableStringify } from '../derive/baseline.ts'
import { deriveAppDataFromCanonical } from '../canonical/derive.ts'
import { readV2 } from '../canonical/v2Reader.ts'
import { serializeV2 } from '../canonical/v2Serializer.ts'
import { validateV2Files } from '../canonical/v2Schema.ts'
import { OFFICIAL_POLICY, V2_SOURCES } from './officialDefinitions.ts'
import { projectStoreToCanonical } from './projectCanonical.ts'
import { NOW, edgeCaseFixture, migrateIntoEmptyStore, migrationInputs } from './v2Store.fixture.ts'

const project = (state: FormalState) => projectStoreToCanonical(state, { source: 'local' })
/** Derived App data holds closures created per call; compare them by name, and their
 * behaviour through the baseline, which evaluates them. */
const comparable = (value: unknown): unknown => {
  if (typeof value === 'function') return `[function ${value.name}]`
  if (Array.isArray(value)) return value.map(comparable)
  if (value instanceof Map) return new Map([...value].map(([k, v]) => [k, comparable(v)]))
  if (value instanceof Set) return new Set([...value].map(comparable))
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, comparable(v)]))
  return value
}

for (const [name, input] of migrationInputs()) {
  test(`${name}: V2 -> migrateV2 -> planCommands -> applyChangeSet -> projection equals readV2`, () => {
    const files = input(), { state } = migrateIntoEmptyStore(files)
    const before = JSON.stringify(state)
    const projection = project(state)
    assert.deepEqual(projection.canonical, readV2(files))
    assert.deepEqual(projection.skipped, [])
    assert.equal(JSON.stringify(state), before, 'the projection never modifies its input')
  })
  test(`${name}: derived App data and the byte baseline equal the V2 derivation`, () => {
    const files = input(), canonical = project(migrateIntoEmptyStore(files).state).canonical
    const expected = deriveAppDataFromCanonical(readV2(files), { now: NOW }), actual = deriveAppDataFromCanonical(canonical, { now: NOW })
    assert.deepEqual(comparable(actual), comparable(expected))
    assert.equal(stableStringify(buildBaseline(actual, { now: NOW })), stableStringify(buildBaseline(expected, { now: NOW })))
  })
  test(`${name}: serializeV2(projection, v2Meta) is valid V2 and reads back as the original`, () => {
    const files = input(), { canonical, v2Meta } = project(migrateIntoEmptyStore(files).state)
    const exported = serializeV2(canonical, v2Meta)
    assert.deepEqual(validateV2Files(exported), [])
    assert.deepEqual(readV2(exported), readV2(files))
  })
}

test('the projection does not depend on the order of rows within a table', () => {
  const files = edgeCaseFixture(), { state } = migrateIntoEmptyStore(files)
  const reversed = { ...state } as Record<string, unknown>
  for (const table of FORMAL_TABLES) reversed[table] = [...state[table]].reverse()
  const projection = project(reversed as unknown as FormalState)
  assert.deepEqual(projection.canonical, readV2(files))
  assert.deepEqual(projection, project(state))
})

test('the projection reads the current rows: an edit made through the planner shows up', () => {
  const files = edgeCaseFixture(), { state } = migrateIntoEmptyStore(files)
  const wish = state.entries.find(e => e.source.sourceId === V2_SOURCES.wantToGo && e.source.recordId === 'collision')!
  const middle = state.entries.find(e => e.source.sourceId === V2_SOURCES.travel && e.source.recordId === 'middle')!
  const later = '2026-10-14T00:00:00.000Z'
  const edits: LayerEntry[] = [
    { ...wish, revision: 1, fields: { ...wish.fields, note: 'Edited synthetic note' }, updatedAt: later },
    { ...middle, revision: 1, fields: { ...middle.fields, date: { raw: { startDate: '2025-01-05' } } }, updatedAt: later },
  ]
  const next = applyChangeSet(state, planCommands(memoryReader(state), edits.map(value => ({ op: 'update', table: 'entries', id: value.id, expectedRevision: 0, value })), { baseRevision: state.revision, now: later, policy: OFFICIAL_POLICY }))
  const canonical = project(next).canonical
  assert.equal(canonical.wantToGo.items.find(i => i.id === 'collision')!.note, 'Edited synthetic note')
  assert.equal(canonical.travel.records.find(r => r.id === 'middle')!.start_date, '2025-01-05')
  assert.deepEqual(canonical.travel.records.map(r => r.id), readV2(files).travel.records.map(r => r.id))
})
