/// <reference types="node" />
/** The want-to-go update of the new-library mode: V2's input rules, the entry it resolves, and the commands it plans. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FormalState } from '../../worldgraph/store/formal.ts'
import { memoryReader } from '../../worldgraph/store/reader.ts'
import { applyChangeSet, planCommands } from '../../worldgraph/store/planner.ts'
import { publicBridgeFixture } from '../canonical/storeBridge.fixture.ts'
import { V2WriteError, updateWantToGo } from '../v2write/index.ts'
import { OFFICIAL, OFFICIAL_POLICY, V2_SOURCES, VIEW_SCOPES } from './officialDefinitions.ts'
import { projectStoreToCanonical } from './projectCanonical.ts'
import { NOW, edgeCaseFixture, migrateIntoEmptyStore } from './v2Store.fixture.ts'
import { readWantToGoUpdate, wantToGoUpdateCommands, wantToGoUpdateKey } from './wantToGoUpdate.ts'

const LATER = '2026-10-20T00:00:00.000Z'
const VIEW_ID = `${VIEW_SCOPES.wantToGoHidden}#01960000-0000-7000-8000-00000000c001`
const codeOf = (run: () => unknown): string | undefined => {
  try { run(); return undefined } catch (error) { return error instanceof V2WriteError ? error.code : String(error) }
}
const apply = (state: FormalState, commands: ReturnType<typeof wantToGoUpdateCommands>) =>
  applyChangeSet(state, planCommands(memoryReader(state), commands, { baseRevision: state.revision, now: LATER, policy: OFFICIAL_POLICY }))
const project = (state: FormalState) => projectStoreToCanonical(state, { source: 'local' }).canonical

test('input rules and codes are exactly the V2 ones', () => {
  const files = publicBridgeFixture()
  const id = files.wantToGo.items[0].id
  const ctx = { countryCatalog: new Map(), now: new Date(NOW), newId: () => '01960000-0000-7000-8000-00000000c009' }
  for (const input of [
    undefined, null, [], {}, { id: ' ' }, { id }, { id, hidden: 'yes' }, { id, note: 3 }, { id, note: 'x'.repeat(201) },
    { id, note: `  ${'x'.repeat(200)}  ` }, { id, hidden: true }, { id, note: '' }, { id, note: null, hidden: false },
  ]) {
    const v2 = codeOf(() => updateWantToGo(files, input, ctx))
    const store = codeOf(() => readWantToGoUpdate(input))
    // V2 also looks the item up; the store does that against the store (E_WTG_NOT_FOUND below).
    assert.equal(store, v2, JSON.stringify(input))
  }
  assert.deepEqual(readWantToGoUpdate({ id: ` ${id} `, note: '  Synthetic  ', hidden: false, extra: 1 }), { id, hidden: false, note: 'Synthetic' })
  assert.deepEqual(readWantToGoUpdate({ id, note: null }), { id, note: '' })
  assert.equal(wantToGoUpdateKey({ id, note: 'a', hidden: true }), wantToGoUpdateKey({ hidden: true, note: 'a', id }))
})

test('a migrated item: the note is its field, hiding is a view row that is created, kept and removed', () => {
  const files = publicBridgeFixture()
  const { state, result } = migrateIntoEmptyStore(files)
  const wish = files.wantToGo.items[0]
  const entryId = result.manifest.identities.find((row) => row.kind === 'entry' && row.sourceId === V2_SOURCES.wantToGo && row.recordId === wish.id)!.id
  const context = { now: LATER, newViewItemId: VIEW_ID }

  let next = apply(state, wantToGoUpdateCommands(memoryReader(state), entryId, { id: wish.id, note: 'Synthetic note' }, context))
  assert.equal(next.revision, state.revision + 1)
  let item = project(next).wantToGo.items.find((candidate) => candidate.id === wish.id)!
  assert.equal(item.note, 'Synthetic note')
  const entry = next.entries.find((candidate) => candidate.id === entryId)!
  assert.equal(entry.updatedAt, LATER)
  assert.equal(entry.revision, 1)

  next = apply(next, wantToGoUpdateCommands(memoryReader(next), entryId, { id: wish.id, hidden: true }, context))
  item = project(next).wantToGo.items.find((candidate) => candidate.id === wish.id)!
  assert.equal(item.hidden, true)
  assert.ok(next.viewItems.some((view) => view.id === VIEW_ID && view.itemId === entryId && view.hidden))
  // Hiding a hidden item keeps it: nothing to do.
  assert.deepEqual(wantToGoUpdateCommands(memoryReader(next), entryId, { id: wish.id, hidden: true }, context), [])
  // The same note again: nothing to do.
  assert.deepEqual(wantToGoUpdateCommands(memoryReader(next), entryId, { id: wish.id, note: 'Synthetic note' }, context), [])

  next = apply(next, wantToGoUpdateCommands(memoryReader(next), entryId, { id: wish.id, hidden: false, note: '' }, context))
  item = project(next).wantToGo.items.find((candidate) => candidate.id === wish.id)!
  assert.equal(item.hidden, false)
  assert.equal(Object.hasOwn(item, 'note'), false)
  assert.ok(next.tombstones.some((tombstone) => tombstone.table === 'viewItems' && tombstone.id === VIEW_ID))
  // Showing a shown item: nothing to do. Hiding again needs a new view row id (the old one is tombstoned).
  assert.deepEqual(wantToGoUpdateCommands(memoryReader(next), entryId, { id: wish.id, hidden: false }, context), [])
  assert.throws(() => apply(next, wantToGoUpdateCommands(memoryReader(next), entryId, { id: wish.id, hidden: true }, context)), { code: 'E_RECREATE_ID' })
  next = apply(next, wantToGoUpdateCommands(memoryReader(next), entryId, { id: wish.id, hidden: true }, { now: LATER, newViewItemId: `${VIEW_ID}2` }))
  assert.equal(project(next).wantToGo.items.find((candidate) => candidate.id === wish.id)!.hidden, true)
  // Everything else in the projection is untouched.
  const before = project(state), after = project(next)
  assert.deepEqual({ ...after, wantToGo: before.wantToGo }, before)
})

test('the item is found only as V2 names it: a starmap:user entry by its id; footprint records and other ids are E_WTG_NOT_FOUND', () => {
  const files = publicBridgeFixture()
  const { state, result } = migrateIntoEmptyStore(files)
  const context = { now: LATER, newViewItemId: VIEW_ID }
  const city = state.entities.find((entity) => entity.typeId === OFFICIAL.place && entity.fields.subtype === 'city')!
  const userId = '01960000-0000-7000-8000-00000000c002'
  const created = apply(state, [{ op: 'create', table: 'entries', value: {
    id: userId, revision: 0, layerId: OFFICIAL.wantToGo, entityId: city.id, fields: { addedAt: '2026-10-20' },
    source: { sourceId: OFFICIAL.user, recordId: userId, evidenceIds: [] }, createdAt: LATER, updatedAt: LATER,
  } }])
  const next = apply(created, wantToGoUpdateCommands(memoryReader(created), userId, { id: userId, note: 'Synthetic later' }, context))
  assert.equal(project(next).wantToGo.items.find((item) => item.id === userId)?.note, 'Synthetic later')

  const wish = files.wantToGo.items[0]
  const wishEntry = result.manifest.identities.find((row) => row.sourceId === V2_SOURCES.wantToGo && row.recordId === wish.id)!.id
  const footprint = result.manifest.identities.find((row) => row.sourceId === V2_SOURCES.travel)!
  for (const [entryId, id] of [
    [wishEntry, 'another-id'], // the entry of another item
    [wishEntry, wishEntry], // a migrated item named by its entry id, not its V2 id
    [footprint.id, footprint.recordId], // a footprint record
    ['missing', 'missing'],
  ]) {
    assert.throws(() => wantToGoUpdateCommands(memoryReader(created), entryId, { id, note: 'x' }, context), { code: 'E_WTG_NOT_FOUND' }, `${entryId} ${id}`)
  }
})

test('a planned record and a want-to-go item with the same V2 id: only the item is updated, the planned record is E_WTG_NOT_FOUND', () => {
  const files = edgeCaseFixture()
  const { state, result } = migrateIntoEmptyStore(files)
  const identity = (sourceId: string) => result.manifest.identities.find((row) => row.sourceId === sourceId && row.recordId === 'shared-id')!.id
  const context = { now: LATER, newViewItemId: VIEW_ID }
  const next = apply(state, wantToGoUpdateCommands(memoryReader(state), identity(V2_SOURCES.wantToGo), { id: 'shared-id', note: 'Synthetic shared' }, context))
  const canonical = project(next)
  assert.equal(canonical.wantToGo.items.find((item) => item.id === 'shared-id')?.note, 'Synthetic shared')
  assert.deepEqual(canonical.travel, project(state).travel)
  assert.throws(() => wantToGoUpdateCommands(memoryReader(state), identity(V2_SOURCES.planned), { id: 'shared-id', note: 'x' }, context), { code: 'E_WTG_NOT_FOUND' })
})
