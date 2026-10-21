/// <reference types="node" />
/** The read model (3C-5A): building, reading, full validation, lookups, incremental updates and selection, on Core's
 * neutral formal fixture and on random command sequences with fixed seeds. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOW, entry, id, source, title } from '../store/store.fixture.ts'
import { LAYER_SCOPE, formalFixture } from '../store/formal.fixture.ts'
import type { FormalCommand, FormalRow, FormalState, FormalTable, ViewItem } from '../store/formal.ts'
import { memoryReader, referencesOf } from '../store/reader.ts'
import { type ChangeSet, applyChangeSet, planCommands } from '../store/planner.ts'
import { StoreError } from '../store/schema.ts'
import type { EntrySequence, JsonObject, LayerEntry, StoreEntity } from '../store/types.ts'
import { formalStateOfReadModel, readModelOf } from './build.ts'
import { readReadModel, validateReadModel } from './check.ts'
import { applyReadModelDelta } from './delta.ts'
import { indexReadModel } from './lookup.ts'
import { liveReadModelIndex, type LiveReadModelIndex } from './liveIndex.ts'
import { selectReadModel } from './select.ts'
import { READ_MODEL_TABLES, compareIds, type ReadModel, type ReadModelRow, type ReadModelTable } from './types.ts'

const fails = (fn: () => unknown, code: string, path?: string) =>
  assert.throws(fn, (e: unknown) => e instanceof StoreError && e.code === code && (path === undefined || e.path === path))
const create = (table: FormalTable, value: unknown): FormalCommand => ({ op: 'create', table, value: value as FormalRow })
const update = (table: FormalTable, value: { id: string; revision: number }): FormalCommand =>
  ({ op: 'update', table, id: value.id, expectedRevision: value.revision - 1, value: value as unknown as FormalRow })
const remove = (table: FormalTable, row: { id: string; revision: number }): FormalCommand => ({ op: 'remove', table, id: row.id, expectedRevision: row.revision })
const plan = (state: FormalState, commands: FormalCommand[]): ChangeSet => planCommands(memoryReader(state), commands, { baseRevision: state.revision, now: NOW })
const entity = (n: number, fields: JsonObject = { author: 'Synthetic' }, visibility = 'private'): StoreEntity =>
  ({ id: id(n), revision: 0, typeId: 'custom:book', title: title(`Entity ${n}`), fields, source: source(`entity-${n}`), visibility } as StoreEntity)
const local = (state: FormalState) => readModelOf(state, { origin: 'local' })
const clone = <T>(value: T): T => structuredClone(value) as T
const ids = (model: ReadModel, table: ReadModelTable) => (model[table] as readonly ReadModelRow[]).map((row) => row.id)

// ---------------------------------------------------------------------------
// Building and reading
// ---------------------------------------------------------------------------

test('readModelOf: the header, every read-model table in id order, no tombstones and no review receipts', () => {
  const state = formalFixture()
  const reversed = { ...state, entities: [...state.entities].reverse(), tombstones: [{ table: 'entities', id: 'gone', deletedAt: NOW }],
    reviews: [{ id: 'review-one', revision: 0, proposalId: 'proposal-one', sourceId: 'test:ai', acceptedAt: NOW }] } as unknown as FormalState
  const model = readModelOf(reversed, { origin: 'local' })
  assert.deepEqual(Object.keys(model), ['format', 'formatVersion', 'revision', 'origin', ...READ_MODEL_TABLES])
  assert.equal(model.format, 'starmap.read-model'); assert.equal(model.formatVersion, 1); assert.equal(model.revision, state.revision)
  assert.ok(!('tombstones' in model) && !('reviews' in model))
  assert.deepEqual(ids(model, 'entities'), [...state.entities].map((row) => row.id).sort(compareIds))
  assert.equal(model.entities.find((row) => row.id === id(1)), state.entities.find((row) => row.id === id(1)), 'rows are shared, not copied')
  assert.equal(readModelOf(state, { origin: 'sample', revision: 7 }).revision, 7)
  fails(() => readModelOf(state, { origin: 'remote' as 'local' }), 'E_READ_MODEL_ORIGIN')
  fails(() => readModelOf({ ...state, revision: undefined } as unknown as FormalState, { origin: 'local' }), 'E_REVISION')
  const back = formalStateOfReadModel(model)
  assert.deepEqual(back.tombstones, []); assert.deepEqual(back.reviews, [])
  assert.deepEqual(readModelOf(back, { origin: 'local' }), model)
})

test('compareIds is code-point order: the order SQLite gives UTF-8 text', () => {
  const values = ['b', 'a', 'ab', '\u{e000}', '\u{10000}', '\u{ffff}', 'Z', '0', '\u{1f600}x', '\u{1f600}']
  const byBytes = [...values].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))
  assert.deepEqual([...values].sort(compareIds), byBytes)
  assert.notDeepEqual([...values].sort(), byBytes, 'UTF-16 order differs for these values')
})

test('readReadModel checks the header and the shape only, and refuses a newer format', () => {
  const model = local(formalFixture())
  assert.equal(readReadModel(model), model)
  const value = () => clone(model) as unknown as Record<string, unknown>
  fails(() => readReadModel(null), 'E_SHAPE', '$')
  fails(() => readReadModel({ ...value(), format: 'starmap.world-store' }), 'E_READ_MODEL_FORMAT')
  fails(() => readReadModel({ ...value(), formatVersion: 2 }), 'E_READ_MODEL_TOO_NEW')
  fails(() => readReadModel({ ...value(), formatVersion: 0 }), 'E_READ_MODEL_VERSION')
  fails(() => readReadModel({ ...value(), formatVersion: '1' }), 'E_READ_MODEL_VERSION')
  fails(() => readReadModel({ ...value(), origin: 'remote' }), 'E_READ_MODEL_ORIGIN')
  fails(() => readReadModel({ ...value(), revision: -1 }), 'E_REVISION')
  fails(() => readReadModel({ ...value(), tombstones: [] }), 'E_SHAPE')
  const missing = value(); delete missing.anchors
  fails(() => readReadModel(missing), 'E_SHAPE')
  fails(() => readReadModel({ ...value(), entities: {} }), 'E_SHAPE', 'entities')
  fails(() => readReadModel({ ...value(), entities: [{ revision: 0 }] }), 'E_ID')
  fails(() => readReadModel({ ...value(), assets: [{ id: 'x', revision: 0, extensions: [] }] }), 'E_EXTENSIONS')
  const twice = value(); twice.entities = [...model.entities, model.entities[0]]
  fails(() => readReadModel(twice), 'E_DUPLICATE', 'entities')
  // A dangling reference is not the reader's business: it is a shape-only check.
  const dangling = value(); dangling.entries = [{ ...entry(90), entityId: id(999) }]
  assert.doesNotThrow(() => readReadModel(dangling))
})

test('validateReadModel runs Core\'s own row rules, references and unique keys', () => {
  const model = local(formalFixture())
  assert.doesNotThrow(() => validateReadModel(model))
  fails(() => validateReadModel({ ...model, entries: [...model.entries, { ...entry(90), entityId: id(999) }] }), 'E_REFERENCE', 'entries.entityId')
  fails(() => validateReadModel({ ...model, entities: [...model.entities, { ...entity(5), fields: {} }] }), 'E_REQUIRED')
  const sameIdentity = { ...entry(91), source: model.entries[0].source, entityId: model.entries[0].entityId }
  fails(() => validateReadModel({ ...model, entries: [...model.entries, sameIdentity] }), 'E_SOURCE_COLLISION')
  fails(() => validateReadModel({ ...model, formatVersion: 3 }), 'E_READ_MODEL_TOO_NEW')
})

test('validateReadModel trusts a review id (receipts are never in a read model) but not an unreviewed AI fact', () => {
  const model = local(formalFixture())
  const reviewed = { ...entry(92), source: { ...source('ai-record', 'test:ai'), reviewId: 'review-one' } }
  assert.doesNotThrow(() => validateReadModel({ ...model, entries: [...model.entries, reviewed] }))
  const unreviewed = { ...entry(93), source: source('ai-other', 'test:ai') }
  fails(() => validateReadModel({ ...model, entries: [...model.entries, unreviewed] }), 'E_UNCONFIRMED')
  const otherSource = { ...entity(6), source: { ...source('entity-6', 'test:manual'), reviewId: 'review-one' } }
  fails(() => validateReadModel({ ...model, entries: [...model.entries, reviewed], entities: [...model.entities, otherSource] }), 'E_REVIEW_SOURCE')
})

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

test('indexReadModel answers rows, entries, relations, anchors and view scopes without scanning', () => {
  const index = indexReadModel(local(formalFixture()))
  assert.equal(index.get('entities', id(1))?.id, id(1))
  assert.equal(index.get('entities', 'nothing'), undefined)
  assert.deepEqual(index.entriesOfLayer('user:reading').map((row) => row.id), [id(10), id(11), id(12)])
  assert.deepEqual(index.entriesOfLayer('nothing'), [])
  assert.deepEqual(index.entriesOfEntity(id(2)).map((row) => row.id), [id(11)])
  assert.deepEqual(index.relationsTo(id(2)).map((row) => row.id), ['relation-one'])
  assert.deepEqual(index.relationsTo(id(2), 'custom:related').map((row) => row.id), ['relation-one'])
  assert.deepEqual(index.relationsTo(id(2), 'other:type'), [])
  assert.deepEqual(index.relationsFrom(id(1)).map((row) => row.toEntityId), [id(2)])
  assert.deepEqual(index.anchorsOf(id(1)).map((row) => row.id), ['location-one', 'time-one'])
  // Items by position ('V' < 'k'), whatever their ids.
  assert.deepEqual(index.viewItemsOf(LAYER_SCOPE).map((row) => row.id), ['item-a', 'item-b'])
  assert.deepEqual(index.viewSettingsOf(`entity:${id(1)}`).map((row) => row.key), ['cover'])
  assert.ok(Object.isFrozen(index.entriesOfLayer('user:reading')))
})

// ---------------------------------------------------------------------------
// Incremental updates
// ---------------------------------------------------------------------------

const generator = (seed: number) => { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000 } }

/** One random batch of one to three commands against `state` (some of them invalid: the planner refuses those). */
function randomBatch(state: FormalState, random: () => number, next: () => number): FormalCommand[] {
  const pick = <T>(list: readonly T[]): T | undefined => (list.length ? list[Math.floor(random() * list.length)] : undefined)
  const books = state.entities.filter((row) => row.typeId === 'custom:book')
  const batch: FormalCommand[] = []
  const count = 1 + Math.floor(random() * 3)
  for (let n = 0; n < count; n++) {
    const choice = Math.floor(random() * 16)
    const book = pick(books), other = pick(books), asset = pick(state.assets), anEntry = pick(state.entries)
    const item = pick(state.viewItems), setting = pick(state.viewSettings), relation = pick(state.relations)
    const anchor = pick(state.anchors), sequence = pick(state.sequences)
    const fresh = next()
    switch (choice) {
      case 0: batch.push(create('entities', entity(fresh, { author: `Author ${fresh}`, ...(other ? { related: other.id } : {}), ...(asset ? { cover: asset.id } : {}) }))); break
      case 1: if (book) batch.push(update('entities', { ...book, revision: book.revision + 1, title: title(`Renamed ${fresh}`) } as StoreEntity)); break
      case 2: if (book) batch.push(remove('entities', book)); break
      case 3: if (book) batch.push(create('entries', { ...entry(fresh, random() < 0.5 ? 'user:reading' : 'user:favorites'), entityId: book.id, fields: { rating: fresh % 6 } })); break
      case 4: if (anEntry) batch.push(update('entries', { ...anEntry, revision: anEntry.revision + 1, fields: { rating: fresh % 6 } } as LayerEntry)); break
      case 5: if (anEntry) batch.push(remove('entries', anEntry)); break
      case 6: if (book && other) batch.push(create('relations', { id: `relation-${fresh}`, revision: 0, typeId: 'custom:related', fromEntityId: book.id, toEntityId: other.id, source: source(`relation-${fresh}`), fields: {} })); break
      case 7: if (relation) batch.push(remove('relations', relation)); break
      case 8: if (book) batch.push(create('anchors', { id: `anchor-${fresh}`, revision: 0, entityId: book.id, kind: 'location', lat: fresh % 90, lng: -(fresh % 180), precision: 'city', source: source(`anchor-${fresh}`) })); break
      case 9: if (anchor) batch.push(remove('anchors', anchor)); break
      case 10: batch.push(create('assets', { id: `asset-${fresh}`, revision: 0, source: source(`asset-${fresh}`), attributes: { n: fresh } })); break
      case 11: if (asset) batch.push(remove('assets', asset)); break
      case 12: {
        const target = pick([...state.entries.map((row) => ['entries', row.id] as const), ...state.assets.map((row) => ['assets', row.id] as const)])
        if (target) batch.push(create('viewItems', { id: `item-${fresh}`, revision: 0, scope: `scope:${fresh % 3}`, itemTable: target[0], itemId: target[1], position: `V${fresh % 7 + 1}`, hidden: random() < 0.3 }))
        break
      }
      case 13: if (item) batch.push(random() < 0.5 ? remove('viewItems', item) : update('viewItems', { ...item, revision: item.revision + 1, hidden: !item.hidden } as ViewItem)); break
      case 14: if (random() < 0.5 || !setting) {
        batch.push(create('viewSettings', { id: `setting-${fresh}`, revision: 0, scope: `settings:${fresh % 2}`, key: `key-${fresh}`, ...(asset ? { ref: { table: 'assets', id: asset.id } } : { value: fresh }) }))
      } else batch.push(remove('viewSettings', setting)); break
      case 15: if (sequence) batch.push(update('sequences', { ...sequence, revision: sequence.revision + 1, entryIds: sequence.entryIds.filter(() => random() < 0.7) } as EntrySequence)); break
    }
  }
  return batch
}

for (const seed of [7, 2026, 90210]) test(`applyReadModelDelta: after every step of a random command sequence it equals the read model read again (seed ${seed})`, () => {
  const random = generator(seed)
  let counter = 1000
  const next = () => ++counter
  let state = formalFixture()
  let model = local(state)
  let applied = 0
  for (let step = 0; step < 200; step++) {
    const batch = randomBatch(state, random, next)
    if (!batch.length) continue
    let changeSet: ChangeSet
    try { changeSet = plan(state, batch) } catch (error) {
      if (error instanceof StoreError) continue
      throw error
    }
    const before = model, frozenBefore = JSON.stringify(before)
    state = applyChangeSet(state, changeSet)
    model = applyReadModelDelta(model, changeSet)
    assert.deepEqual(model, local(state), `step ${step}`)
    assert.equal(JSON.stringify(before), frozenBefore, 'the input is never modified')
    for (const table of READ_MODEL_TABLES) {
      const touched = [...changeSet.upserts, ...changeSet.deletes].some((change) => change.table === table)
      if (!touched) assert.equal(model[table], before[table], 'untouched tables are shared')
    }
    applied++
  }
  assert.ok(applied >= 60, `enough committed steps (${applied})`)
})

test('applyReadModelDelta refuses a change set of another revision, and a deletion of a row it does not have', () => {
  const state = formalFixture(), model = local(state)
  const changeSet = plan(state, [create('entities', entity(70))])
  fails(() => applyReadModelDelta({ ...model, revision: model.revision + 1 }, changeSet), 'E_STALE')
  fails(() => applyReadModelDelta(model, { ...changeSet, nextRevision: model.revision + 2 }), 'E_REVISION')
  fails(() => applyReadModelDelta(model, { ...changeSet, deletes: [{ table: 'entities', id: id(999) }] }), 'E_NOT_FOUND', 'entities')
  // Review receipts are not in a read model: their changes are ignored.
  const withReview = { ...changeSet, upserts: [...changeSet.upserts, { table: 'reviews' as FormalTable, row: { id: 'r', revision: 0 } as FormalRow }] }
  assert.deepEqual(applyReadModelDelta(model, withReview), applyReadModelDelta(model, changeSet))
  // A removal takes the view rows that point at the row along; the delta carries them.
  const target = state.entries.find((row) => row.id === id(12))!
  const cascade = plan(state, [update('sequences', { ...state.sequences[0], revision: 1, entryIds: [id(10), id(11)] } as EntrySequence), remove('entries', target)])
  const after = applyReadModelDelta(model, cascade)
  assert.ok(!after.viewItems.some((row) => row.itemId === id(12)))
  assert.deepEqual(after, local(applyChangeSet(state, cascade)))
})

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** The fixture plus a second, public book with an entry, anchor, relation, sequence, cover and evidence of its own. */
function selectionFixture(): ReadModel {
  const state = formalFixture()
  const extra = [
    create('assets', { id: 'public-cover', revision: 0, source: source('public-cover'), attributes: {} }),
    create('assets', { id: 'view-only-asset', revision: 0, source: source('view-only-asset'), attributes: {} }),
    create('evidence', { id: 'public-proof', revision: 0, sourceId: 'test:saved', recordId: 'public-import', attributes: {} }),
    create('entities', entity(20, { author: 'Public author', cover: 'public-cover' }, 'public')),
    create('entities', entity(21, { author: 'Public friend', related: id(20) }, 'public')),
    // Public, but its field refers to a private book: it cannot be published without that reference, so it goes.
    create('entities', entity(22, { author: 'Public, refers to a private book', related: id(1) }, 'public')),
    create('entries', { ...entry(30), entityId: id(20), source: { ...source('public-entry'), evidenceIds: ['public-proof', 'proof-one'] } }),
    create('entries', { ...entry(31), entityId: id(21), source: source('friend-entry') }),
    create('relations', { id: 'public-relation', revision: 0, typeId: 'custom:related', fromEntityId: id(20), toEntityId: id(21), source: source('public-relation'), fields: {} }),
    create('relations', { id: 'mixed-relation', revision: 0, typeId: 'custom:related', fromEntityId: id(20), toEntityId: id(1), source: source('mixed-relation'), fields: {} }),
    create('anchors', { id: 'public-location', revision: 0, entityId: id(20), kind: 'location', lat: 1, lng: 1, precision: 'city', source: source('public-location') }),
    create('sequences', { id: 'mixed-sequence', revision: 0, entityId: id(20), entryIds: [id(10), id(30), id(31)], source: source('mixed-sequence') }),
    create('viewItems', { id: 'public-item', revision: 0, scope: 'public:order', itemTable: 'entries', itemId: id(30), position: 'V', hidden: false }),
    create('viewItems', { id: 'view-only-item', revision: 0, scope: 'public:order', itemTable: 'assets', itemId: 'view-only-asset', position: 'W', hidden: false }),
    create('viewSettings', { id: 'public-cover-setting', revision: 0, scope: 'public:covers', key: 'cover', ref: { table: 'entities', id: id(20) } }),
    create('viewSettings', { id: 'raw-setting', revision: 0, scope: 'public:raw', key: 'raw', value: 'some-raw-id' }),
  ]
  return local(applyChangeSet(state, plan(state, extra)))
}

test('selectReadModel: rows that refer to a row that is gone go too, and the result validates', () => {
  const model = selectionFixture()
  const keep = (table: ReadModelTable, row: ReadModelRow) => table !== 'entities' || (row as StoreEntity).visibility === 'public'
  const selected = selectReadModel(model, keep)
  assert.deepEqual(ids(selected, 'entities'), [id(20), id(21)])
  // Entries follow their entity; relations need both ends; anchors follow their entity.
  assert.deepEqual(ids(selected, 'entries'), [id(30), id(31)])
  assert.deepEqual(ids(selected, 'relations'), ['public-relation'])
  assert.deepEqual(ids(selected, 'anchors'), ['public-location'])
  // A sequence keeps the entries that remain; one with none left goes (the fixture's original-order sequence).
  assert.deepEqual(selected.sequences.map((row) => [row.id, row.entryIds]), [['mixed-sequence', [id(30), id(31)]]])
  // View rows follow their target (assets are all kept here); the setting with a raw value is the caller's to refuse.
  assert.deepEqual(ids(selected, 'viewItems'), ['public-item', 'view-only-item'])
  assert.deepEqual(ids(selected, 'viewSettings'), ['cover-one', 'public-cover-setting', 'raw-setting'])
  assert.equal(selected.revision, model.revision); assert.equal(selected.origin, 'local')
  assert.doesNotThrow(() => validateReadModel(selected))
  assert.equal(selected.entries.find((row) => row.id === id(31)), model.entries.find((row) => row.id === id(31)), 'rows that do not change are shared')
})

test('selectReadModel: pruned tables keep only what a kept fact refers to; view rows never keep a row alive', () => {
  const model = selectionFixture()
  const keep = (table: ReadModelTable, row: ReadModelRow) =>
    (table !== 'entities' || (row as StoreEntity).visibility === 'public') && (table !== 'viewSettings' || 'ref' in row)
    && (table !== 'evidence' || row.id !== 'proof-one')
  const selected = selectReadModel(model, keep, { prune:['sources', 'entityTypes', 'layers', 'relationTypes', 'evidence', 'assets'] })
  // The cover the public book refers to stays; the asset only a view item names goes, and so does that item.
  assert.deepEqual(ids(selected, 'assets'), ['public-cover'])
  assert.deepEqual(ids(selected, 'viewItems'), ['public-item'])
  assert.deepEqual(ids(selected, 'viewSettings'), ['public-cover-setting'])
  // Evidence a kept entry names stays; its other evidence was refused, so the entry's list keeps the one that remains.
  assert.deepEqual(ids(selected, 'evidence'), ['public-proof'])
  assert.deepEqual(selected.entries.find((row) => row.id === id(30))?.source.evidenceIds, ['public-proof'])
  // Definitions: only what the kept rows use (the favorites layer and the unused sources go).
  assert.deepEqual(ids(selected, 'layers'), ['user:reading'])
  assert.deepEqual(ids(selected, 'entityTypes'), ['custom:book'])
  assert.deepEqual(ids(selected, 'relationTypes'), ['custom:related'])
  assert.deepEqual(ids(selected, 'sources'), ['test:manual', 'test:saved'])
  assert.doesNotThrow(() => validateReadModel(selected))
  // Keeping everything changes nothing.
  assert.deepEqual(selectReadModel(model, () => true), model)
})

// ---------------------------------------------------------------------------
// The live index (3C-5 C1)
// ---------------------------------------------------------------------------

/** Every lookup of `live` answers as the index of `model` built from scratch. */
function assertSameLookups(live: LiveReadModelIndex, model: ReadModel, label: string) {
  const fresh = indexReadModel(model)
  const rowIds = (rows: readonly { readonly id: string }[]) => rows.map((row) => row.id)
  for (const table of READ_MODEL_TABLES) for (const row of model[table] as readonly ReadModelRow[]) assert.deepEqual(live.get(table, row.id), fresh.get(table, row.id), `${label} ${table}`)
  for (const layerId of new Set(model.entries.map((row) => row.layerId))) assert.deepEqual(rowIds(live.entriesOfLayer(layerId)), rowIds(fresh.entriesOfLayer(layerId)), label)
  for (const typeId of new Set(model.entities.map((row) => row.typeId))) assert.deepEqual(rowIds(live.entitiesOfType(typeId)), rowIds(fresh.entitiesOfType(typeId)), label)
  for (const entityId of new Set([...model.entities.map((row) => row.id), ...model.entries.map((row) => row.entityId)])) {
    assert.deepEqual(rowIds(live.entriesOfEntity(entityId)), rowIds(fresh.entriesOfEntity(entityId)), label)
    assert.deepEqual(rowIds(live.relationsTo(entityId)), rowIds(fresh.relationsTo(entityId)), label)
    assert.deepEqual(rowIds(live.relationsFrom(entityId, 'custom:related')), rowIds(fresh.relationsFrom(entityId, 'custom:related')), label)
    assert.deepEqual(rowIds(live.anchorsOf(entityId)), rowIds(fresh.anchorsOf(entityId)), label)
  }
  for (const scope of new Set(model.viewItems.map((row) => row.scope))) assert.deepEqual(rowIds(live.viewItemsOf(scope)), rowIds(fresh.viewItemsOf(scope)), label)
  for (const scope of new Set(model.viewSettings.map((row) => row.scope))) assert.deepEqual(rowIds(live.viewSettingsOf(scope)), rowIds(fresh.viewSettingsOf(scope)), label)
  // Reverse references: every reference Core sees in the model, and no other.
  const lookup = { get: (table: string, rowId: string) => fresh.get(table as ReadModelTable, rowId) as FormalRow | undefined }
  const expected = new Map<string, string[]>()
  for (const table of READ_MODEL_TABLES) for (const row of model[table] as readonly ReadModelRow[]) {
    for (const ref of referencesOf(table, row as FormalRow, lookup)) {
      const key = `${ref.toTable}/${ref.toId}`
      expected.set(key, [...(expected.get(key) ?? []), `${ref.fromTable}/${ref.fromId}/${ref.field}`])
    }
  }
  for (const table of READ_MODEL_TABLES) for (const row of model[table] as readonly ReadModelRow[]) {
    const actual = live.referencesTo(table, row.id).map((ref) => `${ref.fromTable}/${ref.fromId}/${ref.field}`).sort()
    assert.deepEqual(actual, (expected.get(`${table}/${row.id}`) ?? []).sort(), `${label} references to ${table}/${row.id}`)
  }
}

for (const seed of [11, 4242]) test(`liveReadModelIndex: applied commit by commit, its lookups, references and model equal a fresh index of the read model read again (seed ${seed})`, () => {
  const random = generator(seed)
  let counter = 5000
  const next = () => ++counter
  let state = formalFixture()
  const live = liveReadModelIndex(local(state))
  assert.equal(live.referencesTo('entities', id(2)).length > 0, true, 'references built on first use')
  let applied = 0
  for (let step = 0; step < 160; step++) {
    const batch = randomBatch(state, random, next)
    if (!batch.length) continue
    let changeSet: ChangeSet
    try { changeSet = plan(state, batch) } catch (error) {
      if (error instanceof StoreError) continue
      throw error
    }
    state = applyChangeSet(state, changeSet)
    live.apply({ baseRevision: changeSet.baseRevision, nextRevision: changeSet.nextRevision, upserts: changeSet.upserts, deletes: changeSet.deletes })
    assert.equal(live.revision, state.revision)
    if (step % 7 === 0) assert.deepEqual(live.model, local(state), `step ${step}: the model`)
    assertSameLookups(live, local(state), `step ${step}`)
    applied++
  }
  assert.deepEqual(live.model, local(state))
  assert.ok(applied >= 50, `enough committed steps (${applied})`)
  fails(() => live.apply({ baseRevision: live.revision + 1, nextRevision: live.revision + 2, upserts: [], deletes: [] }), 'E_STALE')
})
