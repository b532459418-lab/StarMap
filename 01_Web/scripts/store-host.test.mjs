import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { inspectLibraryOperation } from './library-operation-lock.mjs'
import {
  BUSY_TIMEOUT_MS, StoreHostError, classifySqliteError, nodeSupportsStore, openConnection, pragmaValue,
} from './store-sqlite.mjs'
import {
  ROW_TABLES, STORE_APPLICATION_ID, STORE_FORMAT, STORE_FORMAT_VERSION, checkStoreFile, createStore, encodeRow, openStore, storePathFor,
  withoutLibraryLock,
} from './store-host.mjs'
import { FORMAL_TABLES, readFormalState, uniqueClaims } from '../src/worldgraph/store/formal.ts'
import { formalFixture, formalFromWorld, worldFromFormal } from '../src/worldgraph/store/formal.fixture.ts'
import { generator, randomBatch, withFilm } from '../src/worldgraph/store/parity.fixture.ts'
import { applyChangeSet, planCommands } from '../src/worldgraph/store/planner.ts'
import { StoreError, jsonKey } from '../src/worldgraph/store/primitives.ts'
import { memoryReader, refKey, referencesOf } from '../src/worldgraph/store/reader.ts'
import { NOW as FIXTURE_NOW } from '../src/worldgraph/store/store.fixture.ts'

const LIBRARY_ID = '01900000-0000-7000-8000-00000000abcd'
const NOW = '2026-10-13T00:00:00.000Z'
const clock = () => NOW

/** Handles to close before a test's temporary root is removed (after hooks run first-in, first-out). */
const openHandles = new WeakMap()
const track = (t, handle) => { openHandles.get(t).push(handle); return handle }
async function tempRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'starmap-store-host-'))
  if (!openHandles.has(t)) openHandles.set(t, [])
  t.after(async () => {
    for (const handle of openHandles.get(t)) await handle.close()
    assert.equal(path.dirname(root), os.tmpdir())
    assert.ok(path.basename(root).startsWith('starmap-store-host-'))
    await rm(root, { recursive: true, force: true })
  })
  return root
}
/** A new store in a fresh temporary private root, at the planned production path. */
async function freshStore(t, options = {}) {
  const root = await tempRoot(t)
  const file = storePathFor(root)
  await mkdir(path.dirname(file), { recursive: true })
  const handle = track(t, await createStore(file, { libraryId: LIBRARY_ID, now: clock, lock: withoutLibraryLock, ...options }))
  return { root, file, handle }
}
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const rejectsWith = (promiseOrFn, code) => {
  const check = (error) => error instanceof StoreHostError && error.code === code
  return typeof promiseOrFn === 'function' ? assert.throws(promiseOrFn, check) : assert.rejects(promiseOrFn, check)
}
/** Raw access for tests only: changes the file the way a damaged or foreign file would look. */
function rawEdit(file, sql) {
  const db = new DatabaseSync(file)
  try { db.exec(sql) } finally { db.close() }
}

// ---------------------------------------------------------------------------
// Adapter, schema and the open flow
// ---------------------------------------------------------------------------

test('adapter: Node version gate, connection settings read back, SQLite errors classified by result code', async (t) => {
  assert.equal(nodeSupportsStore('24.14.9'), false)
  assert.equal(nodeSupportsStore('24.15.0'), true)
  assert.equal(nodeSupportsStore('25.0.0'), true)
  assert.equal(nodeSupportsStore(process.versions.node), true)
  const sqlite = (errcode) => Object.assign(new Error('x'), { code: 'ERR_SQLITE_ERROR', errcode })
  assert.deepEqual([5, 6, 8, 10 | (3 << 8), 11, 26, 13, 14, 2067, 787, 1].map((code) => classifySqliteError(sqlite(code))), [
    'E_STORE_BUSY', 'E_STORE_BUSY', 'E_STORE_READONLY', 'E_STORE_IO', 'E_STORE_CORRUPT', 'E_STORE_CORRUPT', 'E_STORE_FULL',
    'E_STORE_CANTOPEN', 'E_STORE_CONSTRAINT', 'E_STORE_CONSTRAINT', 'E_STORE_SQLITE',
  ])
  assert.equal(classifySqliteError(new Error('not sqlite')), 'E_STORE_SQLITE')
  const { file, handle } = await freshStore(t)
  await handle.close()
  const db = openConnection(file)
  try {
    assert.deepEqual(['journal_mode', 'synchronous', 'foreign_keys', 'trusted_schema'].map((name) => pragmaValue(db, name)), ['delete', 3, 1, 0])
    assert.equal(pragmaValue(db, 'busy_timeout', 'timeout'), BUSY_TIMEOUT_MS)
  } finally { db.close() }
})

test('create writes the schema, store_meta, application_id and user_version in one exclusive step', async (t) => {
  const { file, handle } = await freshStore(t)
  assert.deepEqual(handle.meta(), { format: STORE_FORMAT, formatVersion: 1, libraryId: LIBRARY_ID, revision: 0, createdAt: NOW })
  assert.equal(handle.readOnly, false)
  await handle.close()
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    assert.equal(pragmaValue(db, 'application_id'), STORE_APPLICATION_ID)
    assert.equal(pragmaValue(db, 'user_version'), STORE_FORMAT_VERSION)
    const tables = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table'").all()
    assert.deepEqual(tables.map((row) => row.name).sort(), [
      ...Object.values(ROW_TABLES).map((spec) => spec.sql), 'store_meta', 'refs', 'tombstones', 'receipts', 'op_log', 'id_map', 'pending_file_ops',
    ].sort())
    for (const { name, sql } of tables) assert.match(sql, /\) STRICT(, WITHOUT ROWID)?$/, name)
    // Plain-column references are foreign keys checked at COMMIT.
    const entries = tables.find((row) => row.name === 'entries').sql
    for (const target of ['entities', 'layers', 'sources']) assert.match(entries, new RegExp(`REFERENCES ${target} \\(id\\) DEFERRABLE INITIALLY DEFERRED`))
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND sql LIKE 'CREATE UNIQUE INDEX%' ORDER BY name").all().map((row) => row.name),
      ['entries_identity', 'layers_system_key', 'reviews_proposal', 'view_items_item', 'view_settings_key'])
  } finally { db.close() }
  const reopened = track(t, openStore(file, { lock: withoutLibraryLock }))
  assert.equal(reopened.diagnostic, undefined)
  assert.equal(reopened.readOnly, false)
  assert.equal(typeof reopened.openTimings.quickCheckMs, 'number')
})

test('create is exclusive, needs an absolute path and a UUIDv7 library id; open needs an existing file', async (t) => {
  const root = await tempRoot(t)
  const file = path.join(root, 'world.sqlite')
  await writeFile(file, 'not a store')
  const before = sha256(file)
  await rejectsWith(createStore(file, { libraryId: LIBRARY_ID, now: clock, lock: withoutLibraryLock }), 'E_STORE_EXISTS')
  assert.equal(sha256(file), before)
  await rejectsWith(createStore('relative.sqlite', { libraryId: LIBRARY_ID, lock: withoutLibraryLock }), 'E_STORE_PATH')
  await rejectsWith(createStore(path.join(root, 'other.sqlite'), { libraryId: 'not-a-uuid', lock: withoutLibraryLock }), 'E_UUID7')
  await rejectsWith(createStore(path.join(root, 'missing-dir', 'world.sqlite'), { libraryId: LIBRARY_ID, now: clock, lock: withoutLibraryLock }), 'E_STORE_PATH')
  rejectsWith(() => openStore(path.join(root, 'absent.sqlite'), { lock: withoutLibraryLock }), 'E_STORE_NOT_FOUND')
})

test('writes take the library lease by default; one writable handle per file in a process', async (t) => {
  const root = await tempRoot(t)
  const file = storePathFor(root)
  await mkdir(path.dirname(file), { recursive: true })
  await rejectsWith(createStore(file, { libraryId: LIBRARY_ID, now: clock }), 'E_STORE_LOCK_REQUIRED')
  const handle = await createStore(file, { libraryId: LIBRARY_ID, now: clock, privatePaths: { root } })
  const inspected = await inspectLibraryOperation({ root })
  assert.equal(inspected.state, 'idle')
  assert.equal(typeof inspected.generation, 'string', 'creation ran under a lease, which advanced the generation')
  rejectsWith(() => openStore(file, { privatePaths: { root } }), 'E_STORE_ALREADY_OPEN')
  await handle.close()
  const again = openStore(file, { privatePaths: { root } })
  await again.close()
  rejectsWith(() => openStore(file), 'E_STORE_LOCK_REQUIRED')
})

test('failed open checks open read-only with a diagnostic and never change the file', async (t) => {
  const damagePage = (file) => {
    const db = new DatabaseSync(file, { readOnly: true })
    const pageSize = pragmaValue(db, 'page_size')
    const rootPage = db.prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'entities'").get().rootpage
    db.close()
    const fd = openSync(file, 'r+')
    try { writeSync(fd, Buffer.alloc(16, 0xff), 0, 16, (rootPage - 1) * pageSize) } finally { closeSync(fd) }
  }
  // [case, damage, expected code, still readable, SQL that undoes the damage]
  const cases = [
    ['foreign SQLite file', 'PRAGMA application_id = 7', 'E_STORE_APPLICATION_ID', false, `PRAGMA application_id = ${STORE_APPLICATION_ID}`],
    ['newer format', 'PRAGMA user_version = 2', 'E_STORE_TOO_NEW', false, 'PRAGMA user_version = 1'],
    ['unknown older format', 'PRAGMA user_version = 0', 'E_STORE_VERSION', false, 'PRAGMA user_version = 1'],
    ['unexpected schema', 'CREATE TABLE extra (x TEXT) STRICT', 'E_STORE_SCHEMA', false, 'DROP TABLE extra'],
    ['missing store_meta row', 'DELETE FROM store_meta', 'E_STORE_SCHEMA', false,
      `INSERT INTO store_meta VALUES (1, '${STORE_FORMAT}', 1, '${LIBRARY_ID}', 0, '${NOW}')`],
    ['damaged page (test-only byte overwrite)', damagePage, 'E_STORE_CORRUPT', true, undefined],
  ]
  for (const [name, damage, code, readable, undo] of cases) {
    const { file, handle } = await freshStore(t)
    await handle.close()
    if (typeof damage === 'function') damage(file); else rawEdit(file, damage)
    const before = sha256(file)
    const opened = openStore(file, { lock: withoutLibraryLock })
    assert.equal(opened.readOnly, true, name)
    assert.equal(opened.diagnostic.code, code, name)
    if (readable) assert.equal(opened.meta().libraryId, LIBRARY_ID, `${name}: still readable for rescue`)
    else rejectsWith(() => opened.meta(), code)
    await opened.close()
    assert.equal(sha256(file), before, `${name}: nothing repaired or rewritten`)
    if (!undo) continue
    // Diagnostics are not sticky, and the read-only open did not keep the writer slot.
    rawEdit(file, undo)
    const restored = openStore(file, { lock: withoutLibraryLock })
    assert.equal(restored.diagnostic, undefined, `${name}: undone by hand, the store opens normally`)
    await restored.close()
  }
})

test('an explicit read-only open runs the same checks and never takes the writer slot', async (t) => {
  const { file, handle } = await freshStore(t)
  const reader = track(t, openStore(file, { readOnly: true }))
  assert.equal(reader.readOnly, true)
  assert.equal(reader.diagnostic, undefined)
  assert.equal(reader.meta().revision, 0)
  await reader.close()
  assert.equal(handle.meta().revision, 0)
})

// ---------------------------------------------------------------------------
// SqliteStoreReader against memoryReader
// ---------------------------------------------------------------------------

const normalized = (state) => jsonKey({
  ...Object.fromEntries(FORMAL_TABLES.map((table) => [table, [...state[table]].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))])),
  revision: state.revision,
  tombstones: [...state.tombstones].sort((a, b) => jsonKey([a.table, a.id]) < jsonKey([b.table, b.id]) ? -1 : 1),
})
const sortedRefs = (refs) => refs.map(refKey).sort()

/** Test-only bulk load: write a whole valid FormalState with the host's row encoding, bypassing the planner. */
function loadState(file, state) {
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE')
    const memory = memoryReader(state)
    for (const table of FORMAL_TABLES) {
      const spec = ROW_TABLES[table]
      const insert = db.prepare(`INSERT INTO ${spec.sql} VALUES (${Array(spec.columns.length + 3).fill('?').join(', ')})`)
      for (const row of state[table]) {
        insert.run(...encodeRow(table, row))
        for (const ref of referencesOf(table, row, memory)) db.prepare('INSERT INTO refs VALUES (?, ?, ?, ?, ?)').run(ref.fromTable, ref.fromId, ref.field, ref.toTable, ref.toId)
      }
    }
    for (const t of state.tombstones) db.prepare('INSERT INTO tombstones VALUES (?, ?, ?)').run(t.table, t.id, t.deletedAt)
    db.prepare('UPDATE store_meta SET revision = ?').run(state.revision)
    db.exec('COMMIT')
  } finally { db.close() }
}

/** Every StoreReader method answers the same on both readers: each row, reference, tombstone and unique key, and misses. */
function assertSameReader(sqlite, memory, state, label) {
  assert.equal(sqlite.revision, memory.revision, label)
  let calls = 0
  const same = (method, ...args) => {
    calls++
    const a = sqlite[method](...args), b = memory[method](...args)
    if (method === 'dependents') assert.deepEqual(sortedRefs(a), sortedRefs(b), `${label}: ${method}(${args.join(', ')})`)
    else if (method === 'get') assert.equal(a === undefined ? 'undefined' : jsonKey(a), b === undefined ? 'undefined' : jsonKey(b), `${label}: get(${args.join(', ')})`)
    else assert.equal(a, b, `${label}: ${method}(${args.join(', ')})`)
  }
  for (const table of FORMAL_TABLES) {
    same('get', table, 'absent-id'); same('dependents', table, 'absent-id'); same('isTombstoned', table, 'absent-id')
    for (const row of state[table]) {
      same('get', table, row.id); same('dependents', table, row.id); same('isTombstoned', table, row.id)
      for (const claim of uniqueClaims(table, row)) {
        const [a, b, c, d] = claim.parts
        if (claim.kind === 'entry') { same('findEntryByIdentity', a, b, c, d); same('findEntryByIdentity', a, b, c, d + '-other') }
        if (claim.kind === 'systemKey') { same('findLayerBySystemKey', a); same('findLayerBySystemKey', a + '-other') }
        if (claim.kind === 'proposal') { same('findReviewByProposal', a); same('findReviewByProposal', a + '-other') }
        if (claim.kind === 'viewItem') { same('findViewItem', a, b, c); same('findViewItem', a, b, c + '-other') }
        if (claim.kind === 'viewSetting') { same('findViewSetting', a, b); same('findViewSetting', a + '-other', b) }
      }
    }
  }
  for (const t of state.tombstones) { same('isTombstoned', t.table, t.id); same('get', t.table, t.id); same('dependents', t.table, t.id) }
  return calls
}

/** The 3C-1a parity start state (G1 fixture plus a film type) with the formal fixture's view rows. */
const startState = () => readFormalState({ ...formalFromWorld(withFilm()), viewItems: formalFixture().viewItems, viewSettings: formalFixture().viewSettings })
/** Run seeded random 3C-1a batches through the memory path (planCommands + applyChangeSet). */
function randomState(sequence, steps = 4) {
  let state = startState()
  const random = generator(0x5713 + sequence), counter = { n: 300000 + sequence * 1000 }
  for (let step = 0; step < steps; step++) {
    const { commands, options } = randomBatch(worldFromFormal(state), random, counter)
    if (!commands.length) continue
    try {
      state = applyChangeSet(state, planCommands(memoryReader(state), commands, { baseRevision: options.expected ?? state.revision, now: FIXTURE_NOW }))
    } catch (error) { if (!(error instanceof StoreError)) throw error }
  }
  return state
}
async function storeWithState(t, root, name, state) {
  const file = path.join(root, `${name}.sqlite`)
  await (await createStore(file, { libraryId: LIBRARY_ID, now: clock, lock: withoutLibraryLock })).close()
  loadState(file, state)
  return { file, handle: track(t, openStore(file, { lock: withoutLibraryLock })) }
}

test('SqliteStoreReader answers every StoreReader method like memoryReader on random 3C-1a states', async (t) => {
  const root = await tempRoot(t)
  let calls = 0, rows = 0, tombstones = 0
  for (let sequence = 0; sequence < 16; sequence++) {
    const state = randomState(sequence, 6)
    const { handle } = await storeWithState(t, root, `state-${sequence}`, state)
    calls += handle.read((reader) => assertSameReader(reader, memoryReader(state), state, `sequence ${sequence}`))
    assert.equal(normalized(handle.readFormalState()), normalized(state), `sequence ${sequence}: readFormalState`)
    assert.deepEqual(handle.check(), { ok: true, problems: [] })
    rows += FORMAL_TABLES.reduce((sum, table) => sum + state[table].length, 0)
    tombstones += state.tombstones.length
    await handle.close()
  }
  t.diagnostic(`16 random states, ${rows} rows, ${tombstones} tombstones, ${calls} reader calls compared`)
  assert.ok(tombstones > 0, 'the random states include deletions')
})

test('the reader lives only inside its read transaction; reads stay synchronous', async (t) => {
  const root = await tempRoot(t)
  const { handle } = await storeWithState(t, root, 'fixture', startState())
  const kept = handle.read((reader) => reader)
  rejectsWith(() => kept.get('entities', 'anything'), 'E_STORE_READER_CLOSED')
  rejectsWith(() => handle.read(async () => 1), 'E_STORE_ASYNC_READ')
  assert.equal(handle.read((reader) => reader.revision), startState().revision, 'a refused read leaves no transaction behind')
})

test('readFormalState and check find damage that quick_check cannot see', async (t) => {
  const root = await tempRoot(t)
  const state = startState()
  const entity = state.entities[0]
  const damages = [
    ['unreadable body', `UPDATE entities SET body = '{' WHERE id = '${entity.id}'`, 'E_STORE_CORRUPT: entities.body'],
    ['body breaks a Core rule', `UPDATE entities SET body = json_set(body, '$.fields.related', 'missing-entity') WHERE id = '${entity.id}'`, 'E_REFERENCE: entities.fields'],
    ['index column disagrees with the body', `UPDATE entries SET record_id = 'moved' WHERE id = '${state.entries[0].id}'`, 'E_STORE_COLUMNS: entries (1)'],
    ['missing reverse reference', `DELETE FROM refs WHERE from_table = 'entries' AND from_id = '${state.entries[0].id}' AND field = 'entityId'`, 'E_STORE_REFS: 1 missing, 0 unexpected'],
    ['dangling plain-column reference', `PRAGMA foreign_keys = OFF; UPDATE anchors SET entity_id = 'missing-entity' WHERE id = '${state.anchors[0].id}'`, 'E_REFERENCE: anchors.entityId'],
  ]
  for (const [name, sql, problem] of damages) {
    const { file, handle } = await storeWithState(t, root, name.replaceAll(' ', '-'), state)
    await handle.close()
    rawEdit(file, sql)
    const result = await checkStoreFile(file)
    assert.equal(result.ok, false, name)
    assert.ok(result.problems.includes(problem), `${name}: ${result.problems.join('; ')}`)
  }
})
