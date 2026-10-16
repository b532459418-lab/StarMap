import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { inspectLibraryOperation, withLibraryOperation } from './library-operation-lock.mjs'
import {
  BUSY_TIMEOUT_MS, StoreHostError, classifySqliteError, nodeSupportsStore, openConnection, pragmaValue, rawConnection,
} from './store-sqlite.mjs'
import {
  RETENTION, ROW_TABLES, STORE_APPLICATION_ID, STORE_AUTO_VACUUM, STORE_FORMAT, STORE_FORMAT_VERSION, checkStoreFile, createStore, encodeRow, openStore, settleFailure,
  storePathFor, withoutLibraryLock,
} from './store-host.mjs'
import { FORMAL_TABLES, emptyFormalState, readFormalState, uniqueClaims } from '../src/worldgraph/store/formal.ts'
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
  const db = rawConnection(file)
  try { db.exec(sql) } finally { db.close() }
}
/**
 * Test-only damage: overwrite the b-tree page header of `table`'s root page with 0xff bytes, and
 * advance the file change counter (header offsets 24 and 92) the way any other writer would, so
 * that an open connection drops its page cache and reads the damaged page from the file.
 */
function damagePage(file, table) {
  const db = rawConnection(file, { readOnly: true })
  const pageSize = pragmaValue(db, 'page_size')
  const rootPage = db.prepare('SELECT rootpage FROM sqlite_schema WHERE name = ?').get(table).rootpage
  db.close()
  const fd = openSync(file, 'r+')
  try {
    writeSync(fd, Buffer.alloc(16, 0xff), 0, 16, (rootPage - 1) * pageSize)
    const counter = Buffer.alloc(4)
    readSync(fd, counter, 0, 4, 24)
    counter.writeUInt32BE((counter.readUInt32BE(0) + 1) >>> 0)
    writeSync(fd, counter, 0, 4, 24)
    writeSync(fd, counter, 0, 4, 92)
  } finally { closeSync(fd) }
}
/** store_meta.clean_shutdown, read through a separate read-only connection. */
function cleanShutdown(file) {
  const db = rawConnection(file, { readOnly: true })
  try { return db.prepare('SELECT clean_shutdown FROM store_meta').get().clean_shutdown } finally { db.close() }
}
/** Options that count the host's quick_check runs (the 'quick-check' test hook). */
function countingChecks(options = {}) {
  const counter = { checks: 0 }
  counter.options = { lock: withoutLibraryLock, ...options, unsafeTestPhase: (name) => { if (name === 'quick-check') counter.checks++ } }
  return counter
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
    assert.deepEqual(['journal_mode', 'synchronous', 'foreign_keys', 'trusted_schema'].map((name) => pragmaValue(db, name)), ['truncate', 3, 1, 0])
    assert.equal(pragmaValue(db, 'busy_timeout', 'timeout'), BUSY_TIMEOUT_MS)
  } finally { db.close() }
})

test('create writes the schema, store_meta, application_id and user_version in one exclusive step', async (t) => {
  const { file, handle } = await freshStore(t)
  assert.deepEqual(handle.meta(), { format: STORE_FORMAT, formatVersion: STORE_FORMAT_VERSION, libraryId: LIBRARY_ID, revision: 0, createdAt: NOW })
  assert.equal(handle.readOnly, false)
  await handle.close()
  const db = rawConnection(file, { readOnly: true })
  try {
    assert.equal(pragmaValue(db, 'application_id'), STORE_APPLICATION_ID)
    assert.equal(pragmaValue(db, 'user_version'), STORE_FORMAT_VERSION)
    assert.equal(pragmaValue(db, 'auto_vacuum'), STORE_AUTO_VACUUM, 'INCREMENTAL, set before the first table')
    const tables = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table'").all()
    assert.deepEqual(tables.map((row) => row.name).sort(), [
      ...Object.values(ROW_TABLES).map((spec) => spec.sql), 'store_meta', 'refs', 'tombstones', 'receipts', 'op_log', 'id_map', 'pending_file_ops',
      // 3C-4c (format 2): the media registry.
      'media_files', 'media_asset_files', 'media_sources', 'media_scan_cache',
    ].sort())
    for (const { name, sql } of tables) assert.match(sql, /\) STRICT(, WITHOUT ROWID)?$/, name)
    // Plain-column references are foreign keys checked at COMMIT.
    const entries = tables.find((row) => row.name === 'entries').sql
    for (const target of ['entities', 'layers', 'sources']) assert.match(entries, new RegExp(`REFERENCES ${target} \\(id\\) DEFERRABLE INITIALLY DEFERRED`))
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND sql LIKE 'CREATE UNIQUE INDEX%' ORDER BY name").all().map((row) => row.name),
      ['entries_identity', 'layers_system_key', 'media_files_directory', 'media_sources_present_path', 'reviews_proposal', 'view_items_item', 'view_settings_key'])
  } finally { db.close() }
  const reopened = track(t, openStore(file, { lock: withoutLibraryLock }))
  assert.equal(reopened.diagnostic, undefined)
  assert.equal(reopened.readOnly, false)
  assert.equal(reopened.openTimings.quickCheckMs, undefined, 'closed cleanly: the open ran no quick_check')
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

test('creation takes the library lease; writes need privatePaths (or the test-only lock option); one writable handle per file in a process', async (t) => {
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
  // quick_check runs at open only when the last writer session did not end with close().
  const uncleanDamagedPage = (file) => {
    rawEdit(file, 'UPDATE store_meta SET clean_shutdown = 0')
    damagePage(file, 'entities')
  }
  // [case, damage, expected code, still readable, SQL that undoes the damage]
  const cases = [
    ['foreign SQLite file', 'PRAGMA application_id = 7', 'E_STORE_APPLICATION_ID', false, `PRAGMA application_id = ${STORE_APPLICATION_ID}`],
    ['newer format', 'PRAGMA user_version = 3', 'E_STORE_TOO_NEW', false, 'PRAGMA user_version = 2'],
    // 3C-4c: an older format that store:upgrade knows is not opened, upgraded or read; the App points to store:upgrade.
    ['older format with an upgrade (1)', 'PRAGMA user_version = 1', 'E_STORE_UPGRADE_REQUIRED', false, 'PRAGMA user_version = 2'],
    ['unknown older format', 'PRAGMA user_version = 0', 'E_STORE_VERSION', false, 'PRAGMA user_version = 2'],
    ['unexpected schema', 'CREATE TABLE extra (x TEXT) STRICT', 'E_STORE_SCHEMA', false, 'DROP TABLE extra'],
    ['auto_vacuum other than INCREMENTAL', 'PRAGMA auto_vacuum = FULL', 'E_STORE_SCHEMA', false, 'PRAGMA auto_vacuum = INCREMENTAL'],
    ['missing store_meta row', 'DELETE FROM store_meta', 'E_STORE_SCHEMA', false,
      `INSERT INTO store_meta VALUES (1, '${STORE_FORMAT}', ${STORE_FORMAT_VERSION}, '${LIBRARY_ID}', 0, '${NOW}', 1, NULL)`],
    ['damaged page after an unclean shutdown (test-only byte overwrite)', uncleanDamagedPage, 'E_STORE_CORRUPT', true, undefined],
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
  const db = rawConnection(file)
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
    assert.equal(jsonKey(handle.readRowsUnchecked()), jsonKey(handle.readFormalState()), `sequence ${sequence}: readRowsUnchecked`)
    assert.deepEqual(handle.check(), { ok: true, problems: [] })
    rows += FORMAL_TABLES.reduce((sum, table) => sum + state[table].length, 0)
    tombstones += state.tombstones.length
    await handle.close()
  }
  t.diagnostic(`16 random states, ${rows} rows, ${tombstones} tombstones, ${calls} reader calls compared`)
  assert.ok(tombstones > 0, 'the random states include deletions')
})

test('readRowsUnchecked: the same rows as readFormalState, decoded straight from SQL, neither validated nor frozen', async (t) => {
  const root = await tempRoot(t)
  let rows = 0
  for (let sequence = 0; sequence < 12; sequence++) {
    const state = randomState(100 + sequence, 8)
    const { handle } = await storeWithState(t, root, `unchecked-${sequence}`, state)
    const unchecked = handle.readRowsUnchecked()
    assert.deepEqual(Object.keys(unchecked).sort(), ['revision', 'tombstones', ...FORMAL_TABLES].sort(), 'shaped like FormalState')
    assert.equal(jsonKey(unchecked), jsonKey(handle.readFormalState()), `sequence ${sequence}`)
    assert.equal(normalized(unchecked), normalized(state), `sequence ${sequence}: the state that was loaded`)
    rows += FORMAL_TABLES.reduce((sum, table) => sum + unchecked[table].length, 0)
    await handle.close()
  }
  t.diagnostic(`12 random states, ${rows} rows read both ways`)
  // Not frozen, and not validated: a row that breaks a Core rule is returned as stored, while readFormalState refuses.
  const state = startState()
  const { file, handle } = await storeWithState(t, root, 'unvalidated', state)
  await handle.close()
  rawEdit(file, `UPDATE entities SET body = json_set(body, '$.fields.related', 'missing-entity') WHERE id = '${state.entities[0].id}'`)
  const opened = track(t, openStore(file, { lock: withoutLibraryLock }))
  const unchecked = opened.readRowsUnchecked()
  assert.equal(Object.isFrozen(unchecked) || Object.isFrozen(unchecked.entities) || Object.isFrozen(unchecked.entities[0]), false)
  assert.equal(unchecked.entities.find((row) => row.id === state.entities[0].id).fields.related, 'missing-entity')
  rejectsWith(() => opened.readFormalState(), 'E_REFERENCE')
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

// ---------------------------------------------------------------------------
// Commit, receipts, the three outcomes, lookup, pruning and the identity map
// ---------------------------------------------------------------------------

let requestCounter = 0
const nextRequestId = () => `01900000-0000-7000-8000-${(++requestCounter).toString(16).padStart(12, '0')}`
const request = (baseRevision, commands, extra = {}) => ({ requestId: nextRequestId(), baseRevision, kind: 'test.edit', actor: 'test', commands, ...extra })
/** Creates for every row of a valid state, in FORMAL_TABLES (dependency) order. */
const createCommands = (state) => FORMAL_TABLES.flatMap((table) => state[table].map((row) => ({ op: 'create', table, value: row })))
/** A store seeded through its initial request with the 3C-1a start state (revision 1). */
async function seededStore(t, options = {}) {
  const seed = startState()
  const created = await freshStore(t, { initial: { requestId: nextRequestId(), actor: 'test', commands: createCommands(seed) }, ...options })
  return { ...created, seed }
}
/** The memory reference for one request on `state`: { state } after it, or { code }. */
function reference(state, commands, baseRevision = state.revision, now = NOW) {
  try { return { state: applyChangeSet(state, planCommands(memoryReader(state), commands, { baseRevision, now })) } } catch (error) {
    if (error instanceof StoreError) return { code: error.code }
    throw error
  }
}
/** Row count of a bookkeeping table, from a separate read-only connection. */
function countRows(file, table) {
  const db = rawConnection(file, { readOnly: true })
  try { return db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n } finally { db.close() }
}
const attemptCommit = async (handle, value, options) => {
  try { return await handle.commit(value, options) } catch (error) {
    if (error instanceof StoreHostError) return { code: error.code, outcome: error.outcome, error }
    throw error
  }
}
const bump = (row, patch) => ({ ...row, ...patch, revision: row.revision + 1 })
const update = (table, row, patch) => ({ op: 'update', table, id: row.id, expectedRevision: row.revision, value: bump(row, patch) })

test('a new store can be seeded by the caller\'s initial request in the creating transaction', async (t) => {
  const { file, handle, seed } = await seededStore(t)
  assert.equal(handle.meta().revision, 1)
  assert.equal(normalized(handle.readFormalState()), normalized(reference(emptyFormalState(), createCommands(seed), 0).state))
  assert.deepEqual(handle.check(), { ok: true, problems: [] })
  assert.equal(countRows(file, 'receipts'), 1)
  // A rejected initial request rolls the creation back and leaves no file behind.
  const root = await tempRoot(t)
  const rejected = path.join(root, 'rejected.sqlite')
  await rejectsWith(createStore(rejected, { libraryId: LIBRARY_ID, now: clock, lock: withoutLibraryLock,
    initial: { requestId: nextRequestId(), actor: 'test', commands: [{ op: 'create', table: 'entries', value: { ...seed.entries[0], id: 'not-a-uuid' } }] } }), 'E_UUID7')
  assert.equal(existsSync(rejected), false)
  assert.equal(existsSync(`${rejected}-journal`), false, 'nor the zero-length journal of its rolled-back transaction')
})

test('commit executes change sets exactly like the reference applyChangeSet on random 3C-1a batches', async (t) => {
  const root = await tempRoot(t)
  const outcomes = new Map()
  let commits = 0
  for (let sequence = 0; sequence < 8; sequence++) {
    let state = startState()
    let committed = 1
    const file = path.join(root, `random-${sequence}.sqlite`)
    const handle = track(t, await createStore(file, { libraryId: LIBRARY_ID, now: clock, lock: withoutLibraryLock,
      initial: { requestId: nextRequestId(), actor: 'test', commands: createCommands(state) } }))
    const random = generator(0xc3c2 + sequence), counter = { n: 400000 + sequence * 1000 }
    for (let step = 0; step < 6; step++) {
      const { commands, options } = randomBatch(worldFromFormal(state), random, counter)
      if (!commands.length) continue
      const baseRevision = options.expected ?? state.revision
      const expected = reference(state, commands, baseRevision)
      const actual = await attemptCommit(handle, request(baseRevision, commands))
      const label = `sequence ${sequence} step ${step}`
      if (expected.code) {
        assert.equal(actual.code, expected.code, label)
        assert.equal(actual.outcome, 'not_committed', label)
      } else {
        assert.equal(actual.status, 'committed', `${label}: ${actual.code}`)
        assert.equal(actual.revision, expected.state.revision, label)
        state = expected.state
        committed++
        commits++
      }
      assert.equal(normalized(handle.readFormalState()), normalized(state), label)
      assert.equal(jsonKey(handle.readRowsUnchecked()), jsonKey(handle.readFormalState()), `${label}: readRowsUnchecked`)
      const key = expected.code ?? 'committed'
      outcomes.set(key, (outcomes.get(key) ?? 0) + 1)
    }
    assert.deepEqual(handle.check(), { ok: true, problems: [] })
    await handle.close()
    assert.deepEqual([countRows(file, 'receipts'), countRows(file, 'op_log')], [committed, committed], 'rejected requests write nothing')
  }
  t.diagnostic(`8 sequences, ${commits} committed batches, outcomes ${JSON.stringify(Object.fromEntries([...outcomes].sort()))}`)
  assert.ok(commits >= 15, `committed: ${commits}`)
})

test('receipts make a request idempotent; a different request under the same id, or a stale revision, is refused', async (t) => {
  const { file, handle, seed } = await seededStore(t)
  const entry = seed.entries[0]
  const first = request(1, [update('entries', entry, { fields: { rating: 4 }, updatedAt: '2026-10-06T00:00:00.000Z' })])
  const committed = await handle.commit(first)
  assert.equal(committed.status, 'committed')
  assert.equal(committed.revision, 2)
  assert.deepEqual(committed.receipt, {
    status: 'committed', requestId: first.requestId, kind: 'test.edit', baseRevision: 1, revision: 2, at: NOW,
    counts: { entries: { created: 0, updated: 1, removed: 0 } }, affected: [{ table: 'entries', id: entry.id, change: 'written' }],
  })
  // Same request again (e.g. the response was lost): the original receipt, nothing written twice.
  const replay = await handle.commit(structuredClone(first))
  assert.equal(replay.status, 'duplicate')
  assert.deepEqual(replay.receipt, committed.receipt)
  assert.equal(handle.meta().revision, 2)
  assert.deepEqual([countRows(file, 'receipts'), countRows(file, 'op_log')], [2, 2])
  assert.deepEqual(handle.lookup(first.requestId), { found: true, receipt: committed.receipt })
  // Same id, different content: refused even though the content alone would be valid.
  const changed = { ...first, commands: [update('entries', entry, { fields: { rating: 3 }, updatedAt: '2026-10-06T00:00:00.000Z' })] }
  const conflict = await attemptCommit(handle, changed)
  assert.deepEqual([conflict.code, conflict.outcome], ['E_OPERATION_CONFLICT', 'not_committed'])
  // A stale base revision is refused and leaves no receipt: the same id is judged again later.
  const stale = request(1, [update('entries', seed.entries[1], { fields: { rating: 2 } })])
  const refused = await attemptCommit(handle, stale)
  assert.deepEqual([refused.code, refused.outcome], ['E_STALE', 'not_committed'])
  assert.deepEqual(handle.lookup(stale.requestId), { found: false })
  assert.equal((await attemptCommit(handle, stale)).code, 'E_STALE', 'judged again, same answer')
  assert.equal((await handle.commit({ ...stale, baseRevision: 2 })).status, 'committed', 'nothing was stored for the refused request')
  // A planner rejection is a confirmed non-commit with the planner's code and path.
  const invalid = await attemptCommit(handle, request(3, [{ op: 'create', table: 'entries', value: { ...entry, id: seed.entries[1].id } }]))
  assert.deepEqual([invalid.code, invalid.outcome], ['E_CONFLICT', 'not_committed'])
  // Request shape: UUIDv7 request ids, known keys, bounded kind and actor.
  for (const [value, code] of [
    [{ ...request(3, []), requestId: '01900000-0000-4000-8000-000000000001' }, 'E_UUID7'],
    [{ ...request(3, []), extra: true }, 'E_SHAPE'],
    [Object.fromEntries(Object.entries(request(3, [])).filter(([key]) => key !== 'actor')), 'E_SHAPE'],
    [request(3, [], { kind: 'k'.repeat(129) }), 'E_REQUEST'],
    [request(3, [], { actor: ' ' }), 'E_ID'],
    [request(3, []), 'E_COMMAND'],
  ]) await rejectsWith(handle.commit(value), code)
  assert.equal(handle.meta().revision, 3)
  assert.deepEqual(handle.check(), { ok: true, problems: [] })
})

test('a batch may swap unique keys between rows and reuse a deleted row\'s key', async (t) => {
  const { handle, seed } = await seededStore(t)
  let state = seed
  const run = async (commands) => {
    const expected = reference(state, commands)
    assert.equal(expected.code, undefined, 'the reference accepts the batch')
    assert.equal((await handle.commit(request(state.revision, commands))).status, 'committed')
    state = expected.state
    assert.equal(normalized(handle.readFormalState()), normalized(state))
  }
  const [a, b] = seed.viewItems
  const [first, second, third] = seed.entries
  assert.deepEqual([a.itemId, b.itemId], [third.id, first.id])
  // View items: A → spare, B → A's item, A → B's item. Executed in change-set order, A's final
  // key collides with B's old key unless the moved rows leave first.
  await run([
    update('viewItems', a, { itemId: second.id }),
    update('viewItems', b, { itemId: third.id }),
    update('viewItems', bump(a, { itemId: second.id }), { itemId: first.id }),
  ])
  // View settings: the same swap on (scope, key).
  const cover = seed.viewSettings[0]
  const banner = { ...cover, id: 'banner-one', key: 'banner' }
  await run([{ op: 'create', table: 'viewSettings', value: banner }])
  await run([
    update('viewSettings', cover, { key: 'spare' }),
    update('viewSettings', banner, { key: 'cover' }),
    update('viewSettings', bump(cover, { key: 'spare' }), { key: 'banner' }),
  ])
  // A deleted row's unique key is taken by a new row in the same batch.
  const itemB = state.viewItems.find((row) => row.id === b.id)
  await run([
    { op: 'remove', table: 'viewItems', id: itemB.id, expectedRevision: itemB.revision },
    { op: 'create', table: 'viewItems', value: { ...itemB, id: 'item-c', revision: 0 } },
  ])
  assert.deepEqual(handle.check(), { ok: true, problems: [] })
})

test('COMMIT failures settle into confirmed non-commits or an unknown outcome, never an assumed rollback', async (t) => {
  let inject
  const { file, handle, seed } = await seededStore(t, { unsafeTestPhase: (name, { db }) => { if (inject?.phase === name) inject.run(db) } })
  const current = (table, id) => handle.read((reader) => reader.get(table, id))
  const editRating = (rating) => {
    const entry = current('entries', seed.entries[0].id)
    return request(handle.meta().revision, [update('entries', entry, { fields: { rating } })])
  }
  const unchanged = (revision) => {
    assert.equal(handle.meta().revision, revision)
    assert.deepEqual(handle.check(), { ok: true, problems: [] })
  }
  // COMMIT fails with the transaction still open (deferred foreign key): rolled back, confirmed.
  inject = { phase: 'before-commit', run: (db) => db.exec("INSERT INTO anchors (id, revision, entity_id, body) VALUES ('dangling', 0, 'missing-entity', '{}')") }
  let edit = editRating(1)
  let failure = await attemptCommit(handle, edit)
  assert.deepEqual([failure.code, failure.outcome], ['E_STORE_CONSTRAINT', 'not_committed'])
  assert.deepEqual(handle.lookup(edit.requestId), { found: false })
  unchanged(1)
  // COMMIT is busy (another connection is reading): the transaction stays open, so it is rolled back, confirmed.
  let other
  inject = { phase: 'before-commit', run: () => {
    other = rawConnection(file)
    other.exec('BEGIN')
    other.prepare('SELECT revision FROM store_meta').get()
  } }
  failure = await attemptCommit(handle, editRating(2))
  other.exec('ROLLBACK')
  other.close()
  assert.deepEqual([failure.code, failure.outcome], ['E_STORE_BUSY', 'not_committed'])
  unchanged(1)
  // COMMIT fails after the transaction already ended: unknown, even though it did commit here.
  inject = { phase: 'before-commit', run: (db) => db.exec('COMMIT') }
  edit = editRating(3)
  failure = await attemptCommit(handle, edit)
  assert.deepEqual([failure.code, failure.outcome], ['E_OUTCOME_UNKNOWN', 'unknown'])
  assert.match(failure.error.message, /lookup\(requestId\).*same requestId/)
  inject = undefined
  const found = handle.lookup(edit.requestId)
  assert.equal(found.found, true)
  const retried = await handle.commit(edit)
  assert.deepEqual([retried.status, retried.revision], ['duplicate', 2])
  assert.deepEqual(retried.receipt, found.receipt)
  // ...and when it had been rolled back instead, the same request id commits on retry.
  inject = { phase: 'before-commit', run: (db) => db.exec('ROLLBACK') }
  edit = editRating(4)
  failure = await attemptCommit(handle, edit)
  assert.deepEqual([failure.code, failure.outcome], ['E_OUTCOME_UNKNOWN', 'unknown'])
  inject = undefined
  assert.deepEqual(handle.lookup(edit.requestId), { found: false })
  assert.deepEqual([(await handle.commit(edit)).status, handle.meta().revision], ['committed', 3])
  // A full disk during the writes (SQLITE_FULL via max_page_count): COMMIT never issued, confirmed.
  inject = { phase: 'begun', run: (db) => db.exec(`PRAGMA max_page_count = ${pragmaValue(db, 'page_count')}`) }
  const big = { ...seed.entities[0], id: '01900000-0000-7000-8000-0000000fff01', source: { ...seed.entities[0].source, recordId: 'big' },
    fields: { author: 'x'.repeat(200_000) } }
  failure = await attemptCommit(handle, request(3, [{ op: 'create', table: 'entities', value: big }]))
  assert.deepEqual([failure.code, failure.outcome], ['E_STORE_FULL', 'not_committed'])
  inject = undefined
  unchanged(3)
})

test('the outcome rule depends on isTransaction, not on the error code', () => {
  const sqliteError = (errcode) => Object.assign(new Error('x'), { code: 'ERR_SQLITE_ERROR', errcode, errstr: 'synthetic' })
  const connection = (state, { rollbackFails = false } = {}) => ({
    get isTransaction() { if (state === 'closed') throw new Error('closed'); return state },
    exec(sql) { if (sql === 'ROLLBACK') { if (rollbackFails) throw sqliteError(10); state = false } },
  })
  const full = sqliteError(13), io = sqliteError(10 + 4 * 256)
  const settled = (...args) => { const error = settleFailure(...args); return [error.code, error.outcome] }
  assert.deepEqual(settled(connection(true), full, true), ['E_STORE_FULL', 'not_committed'])
  assert.deepEqual(settled(connection(false), full, true), ['E_OUTCOME_UNKNOWN', 'unknown'])
  assert.deepEqual(settled(connection(false), io, true), ['E_OUTCOME_UNKNOWN', 'unknown'])
  assert.deepEqual(settled(connection('closed'), io, true), ['E_OUTCOME_UNKNOWN', 'unknown'])
  assert.deepEqual(settled(connection(false), full, false), ['E_STORE_FULL', 'not_committed'])
  assert.deepEqual(settled(connection('closed'), io, false), ['E_STORE_IO', 'not_committed'])
  let discarded = false
  assert.deepEqual(settled(connection(true, { rollbackFails: true }), io, true, () => { discarded = true }), ['E_STORE_IO', 'not_committed'])
  assert.equal(discarded, true, 'a transaction that cannot be rolled back is discarded by closing the connection')
})

test('ordinary writes take no lease and queue in the process; a lock held elsewhere refuses them, its holder\'s leaseToken lets them through', async (t) => {
  const root = await tempRoot(t)
  const file = storePathFor(root)
  await mkdir(path.dirname(file), { recursive: true })
  const seed = startState()
  const handle = track(t, await createStore(file, { libraryId: LIBRARY_ID, now: clock, privatePaths: { root },
    initial: { requestId: nextRequestId(), actor: 'test', commands: createCommands(seed) } }))
  const generation = (await inspectLibraryOperation({ root })).generation
  assert.equal(typeof generation, 'string', 'creation took the lease')
  const entryEdit = (revision, index, rating) => request(revision, [update('entries', handle.read((reader) => reader.get('entries', seed.entries[index].id)), { fields: { rating } })])
  const results = await Promise.all([handle.commit(entryEdit(1, 0, 1)), handle.commit(entryEdit(2, 1, 2))])
  assert.deepEqual(results.map((result) => [result.status, result.revision]), [['committed', 2], ['committed', 3]])
  assert.deepEqual(await inspectLibraryOperation({ root }), { state: 'idle', generation }, 'no lease was taken: the generation did not move')
  await handle.pruneLogs({ now: NOW })
  await handle.putIdMappings([{ kind: 'place', sourceId: 'v2', recordId: 'a', id: 'id-a' }])
  assert.equal((await inspectLibraryOperation({ root })).generation, generation)
  let held
  await withLibraryOperation({ root }, async (leaseToken) => {
    held = leaseToken
    const before = sha256(file)
    // Somebody else's lock (no token, or a token that is not this lock's holder): refused before BEGIN, nothing written.
    const pending = entryEdit(3, 2, 3)
    const foreign = Buffer.from(JSON.stringify({ schemaVersion: 1, owner: '00000000-0000-4000-8000-000000000000', rootBinding: 'f'.repeat(64) })).toString('base64url')
    for (const options of [undefined, { leaseToken: foreign }, { leaseToken: 'not a token' }]) {
      const refused = await attemptCommit(handle, pending, options)
      assert.deepEqual([refused.code, refused.outcome], ['E_LIBRARY_BUSY', 'not_committed'])
    }
    for (const write of [() => handle.pruneLogs({ now: NOW }), () => handle.putIdMappings([{ kind: 'place', sourceId: 'v2', recordId: 'b', id: 'id-b' }])]) {
      await assert.rejects(write(), (error) => error.code === 'E_LIBRARY_BUSY' && error.outcome === 'not_committed')
    }
    assert.equal(sha256(file), before)
    // The holder (a media operation, a migration) commits with its own lease.
    assert.deepEqual(await handle.commit(pending, { leaseToken }).then((result) => [result.status, result.revision]), ['committed', 4])
    assert.deepEqual(await handle.putIdMappings([{ kind: 'place', sourceId: 'v2', recordId: 'b', id: 'id-b' }], { leaseToken }), { added: 1 })
    assert.equal((await handle.pruneLogs({ now: NOW, leaseToken })).done, true)
  })
  // A token of a lease that has ended is refused too; without a lock, ordinary writes go on.
  const after = entryEdit(4, 0, 4)
  await rejectsWith(handle.commit(after, { leaseToken: held }), 'E_LIBRARY_BUSY')
  await rejectsWith(handle.commit(after, { leaseToken: 7 }), 'E_STORE_OPTIONS')
  assert.deepEqual(await handle.commit(after).then((result) => [result.status, result.revision]), ['committed', 5])
})

test('a read-only store refuses every write with its diagnostic code and stays byte-identical', async (t) => {
  const { file, handle } = await seededStore(t)
  await handle.close()
  rawEdit(file, `PRAGMA user_version = ${STORE_FORMAT_VERSION + 1}`)
  const before = sha256(file)
  const opened = track(t, openStore(file, { lock: withoutLibraryLock }))
  for (const write of [
    () => opened.commit(request(1, [])),
    () => opened.pruneLogs({ now: NOW }),
    () => opened.putIdMappings([{ kind: 'k', sourceId: 's', recordId: 'r', id: 'i' }]),
  ]) await assert.rejects(write(), (error) => error.code === 'E_STORE_TOO_NEW' && error.outcome === 'not_committed')
  await opened.close()
  assert.equal(sha256(file), before)
})

/** The record counts of a pruneLogs result (the vacuum fields depend on page layout). */
const pruned = ({ receipts, opLog, steps, done }) => ({ receipts, opLog, steps, done })

test('pruneLogs keeps receipts by age or by count, whichever keeps more, and op_log by both, whichever keeps fewer, in small write steps', async (t) => {
  let now = '2026-01-01T00:00:00.000Z'
  const { handle, seed } = await seededStore(t, { now: () => now })
  const ids = []
  for (let day = 2; day <= 10; day++) {
    now = `2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`
    const entity = handle.read((reader) => reader.get('entities', seed.entities[0].id))
    const edit = request(handle.meta().revision, [update('entities', entity, { title: { names: { en: `Day ${day}` } } })])
    await handle.commit(edit)
    ids.push(edit.requestId)
  }
  const state = normalized(handle.readFormalState())
  assert.deepEqual(pruned(await handle.pruneLogs({ now: '2026-01-10T12:00:00.000Z' })), { receipts: 0, opLog: 0, steps: 1, done: true }, 'defaults: 30 days or 10,000 / a year and 50,000')
  // op_log by age alone: Jan 1-5 are older than 4.5 days although they are among the newest 50.
  assert.deepEqual(pruned(await handle.pruneLogs({ now: '2026-01-10T12:00:00.000Z', retention: { receipts: RETENTION.receipts, opLog: { days: 4.5, count: 50 } } })),
    { receipts: 0, opLog: 5, steps: 1, done: true })
  assert.equal(countRows(handle.file, 'op_log'), 5)
  // Receipts: age keeps Jan 8-10, count keeps the newest four (Jan 7-10): the four stay. op_log: age keeps Jan 6-10,
  // count keeps the newest two (Jan 9-10): only those two stay.
  const retention = { receipts: { days: 2.5, count: 4 }, opLog: { days: 4.5, count: 2 } }
  assert.deepEqual(pruned(await handle.pruneLogs({ now: '2026-01-10T12:00:00.000Z', batchSize: 2, retention })), { receipts: 6, opLog: 3, steps: 4, done: true })
  assert.deepEqual(ids.map((id) => handle.lookup(id).found), [false, false, false, false, false, true, true, true, true])
  assert.equal(countRows(handle.file, 'op_log'), 2)
  assert.equal(normalized(handle.readFormalState()), state, 'pruning never touches the data')
  assert.deepEqual(handle.check(), { ok: true, problems: [] })
  const entity = handle.read((reader) => reader.get('entities', seed.entities[0].id))
  assert.equal((await handle.commit(request(10, [update('entities', entity, { title: { names: { en: 'After' } } })]))).revision, 11)
  // The newer request pushes Jan 7's receipt out of the newest four and Jan 9's op_log row out of the newest two.
  assert.deepEqual(pruned(await handle.pruneLogs({ now: '2026-01-10T12:00:00.000Z', retention })), { receipts: 1, opLog: 1, steps: 1, done: true })
  await rejectsWith(handle.pruneLogs({ now: '2026-01-10T12:00:00.000Z', retention: { receipts: { days: 1, count: 0 }, opLog: retention.opLog } }), 'E_STORE_OPTIONS')
  await rejectsWith(handle.pruneLogs({ now: '2026-01-10T12:00:00.000Z', vacuumPages: 0 }), 'E_STORE_OPTIONS')
})

test('pruneLogs gives the pages of pruned records back to the file system (auto_vacuum INCREMENTAL), in bounded steps', async (t) => {
  const { file, handle } = await seededStore(t)
  const state = normalized(handle.readFormalState())
  await handle.close()
  // Test-only bulk history written straight into the file: 20,000 old receipts and op_log rows of about 1 KB each.
  const pad = "replace(hex(zeroblob(500)), '0', 'x')"
  rawEdit(file, `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000)
    INSERT INTO receipts (request_id, request_digest, status, revision_after, response, at)
      SELECT printf('old-%05d', i), 'digest', 'committed', 1, ${pad}, '2020-01-01T00:00:00.000Z' FROM n;
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000)
    INSERT INTO op_log (request_id, at, actor, kind, summary) SELECT printf('old-%05d', i), '2020-01-01T00:00:00.000Z', 'test', 'old', ${pad} FROM n`)
  const before = statSync(file).size
  const opened = track(t, openStore(file, { lock: withoutLibraryLock }))
  const pageSize = (() => {
    const db = rawConnection(file, { readOnly: true })
    try { return pragmaValue(db, 'page_size') } finally { db.close() }
  })()
  // Bounded: three pruning steps of 5,000 rows per table, then three vacuum steps of 1,024 pages; the rest in later calls.
  const options = { now: NOW, batchSize: 5_000, maxSteps: 3 }
  let result = await opened.pruneLogs(options)
  assert.deepEqual([result.steps, result.vacuumSteps, result.done], [3, 3, false])
  const total = { receipts: 0, opLog: 0, freedPages: 0, calls: 0 }
  for (;;) {
    for (const key of ['receipts', 'opLog', 'freedPages']) total[key] += result[key]
    total.calls++
    if (result.done) break
    result = await opened.pruneLogs(options)
  }
  // Receipts beyond the newest 10,000 that are older than 30 days; every op_log row older than a year.
  assert.deepEqual([total.receipts, total.opLog], [10_001, 20_000])
  assert.equal(countRows(file, 'receipts'), 10_000)
  const after = statSync(file).size
  t.diagnostic(`${(before / 1048576).toFixed(1)} MB → ${(after / 1048576).toFixed(1)} MB, ${total.freedPages} pages freed in ${total.calls} calls`)
  assert.ok(total.freedPages * pageSize > 20 * 1048576, 'more than 20 MB of pages went back')
  assert.ok(after <= before - total.freedPages * pageSize + pageSize * 16, `the file shrank by the freed pages: ${before} → ${after}`)
  assert.equal(normalized(opened.readFormalState()), state, 'pruning and vacuum never touch the data')
  assert.deepEqual(opened.check(), { ok: true, problems: [] })
  assert.deepEqual(await opened.pruneLogs({ now: NOW }), { receipts: 0, opLog: 0, steps: 1, vacuumSteps: 0, freedPages: 0, done: true })
})

test('id_map stores identity mappings for 3C-1b; a conflicting remap rejects the whole batch', async (t) => {
  const { handle } = await freshStore(t)
  const a = { kind: 'place', sourceId: 'v2', recordId: 'a', id: 'id-a' }
  assert.equal(handle.getIdMapping('place', 'v2', 'a'), undefined)
  assert.deepEqual(await handle.putIdMappings([a, { ...a, recordId: 'b', id: 'id-b' }]), { added: 2 })
  assert.deepEqual(await handle.putIdMappings([a]), { added: 0 })
  await rejectsWith(handle.putIdMappings([{ ...a, recordId: 'c', id: 'id-c' }, { ...a, id: 'other' }]), 'E_ID_MAP_CONFLICT')
  assert.equal(handle.getIdMapping('place', 'v2', 'c'), undefined, 'the whole batch was rolled back')
  assert.equal(handle.getIdMapping('place', 'v2', 'b'), 'id-b')
  await rejectsWith(handle.putIdMappings([]), 'E_ID_MAP')
  await rejectsWith(handle.putIdMappings([{ kind: 'place' }]), 'E_SHAPE')
})

// ---------------------------------------------------------------------------
// Open flow, clean shutdown and integrity (design 3B v1.1 §16.2-3)
// ---------------------------------------------------------------------------

test('open runs quick_check only after an unclean shutdown; clean_shutdown is 0 during a writer session and 1 after close', async (t) => {
  const counter = countingChecks()
  const { file, handle } = await freshStore(t, counter.options)
  assert.equal(cleanShutdown(file), 0, 'the creating handle is a writer session')
  await handle.close()
  assert.equal(cleanShutdown(file), 1)
  // Closed cleanly: the open checks the header, schema and store_meta only.
  let opened = openStore(file, counter.options)
  assert.deepEqual([counter.checks, opened.openTimings.quickCheckMs, cleanShutdown(file)], [0, undefined, 0])
  await opened.close()
  assert.equal(cleanShutdown(file), 1)
  // A session that never reached close() (simulated here; real killed writers are in store-recover.test.mjs).
  rawEdit(file, 'UPDATE store_meta SET clean_shutdown = 0')
  opened = openStore(file, counter.options)
  assert.equal(counter.checks, 1, 'unclean: the open ran quick_check')
  assert.equal(typeof opened.openTimings.quickCheckMs, 'number')
  assert.deepEqual([opened.readOnly, opened.diagnostic], [false, undefined])
  await opened.close()
  assert.equal(cleanShutdown(file), 1, 'the checked session closed normally')
  // An explicit read-only open never runs quick_check and never writes (the flag may belong to an open writer).
  rawEdit(file, 'UPDATE store_meta SET clean_shutdown = 0')
  let before = sha256(file)
  const reader = openStore(file, { ...counter.options, readOnly: true })
  assert.deepEqual([counter.checks, reader.readOnly, reader.diagnostic], [1, true, undefined])
  await reader.close()
  assert.equal(sha256(file), before)
  // library:recover's check is an inspection: it rolls back a hot journal but starts no writer session.
  rawEdit(file, 'UPDATE store_meta SET clean_shutdown = 1')
  before = sha256(file)
  assert.deepEqual(await checkStoreFile(file), { ok: true, problems: [] })
  assert.equal(sha256(file), before, 'a clean store is not written by the check')
})

test('checkIntegrity runs quick_check on request; a failure turns the handle read-only and nothing is repaired', async (t) => {
  const counter = countingChecks()
  const { file, handle, seed } = await seededStore(t, counter.options)
  assert.deepEqual(handle.checkIntegrity(), { ok: true, problems: [] })
  assert.deepEqual([counter.checks, handle.readOnly], [1, false])
  const entry = seed.entries[0]
  assert.equal((await handle.commit(request(1, [update('entries', entry, { fields: { rating: 2 } })]))).status, 'committed')
  damagePage(file, 'anchors')
  const result = handle.checkIntegrity()
  assert.equal(result.ok, false)
  assert.match(result.problems[0], /^E_STORE_CORRUPT: quick_check \(\d+\)$/)
  assert.deepEqual([counter.checks, handle.readOnly, handle.diagnostic.code], [2, true, 'E_STORE_CORRUPT'])
  const refused = await attemptCommit(handle, request(2, [update('entries', bump(entry, { fields: { rating: 2 } }), { fields: { rating: 3 } })]))
  assert.deepEqual([refused.code, refused.outcome], ['E_STORE_CORRUPT', 'not_committed'])
  const before = sha256(file)
  await handle.close()
  assert.equal(sha256(file), before, 'the corrupt session is not marked clean, and nothing is repaired')
  assert.equal(cleanShutdown(file), 0)
})

test('a damaged page met at run time turns the handle read-only with E_STORE_CORRUPT; the next open checks and stays read-only', async (t) => {
  const { file, handle, seed } = await seededStore(t)
  await handle.close()
  const counter = countingChecks()
  const opened = track(t, openStore(file, counter.options))
  assert.deepEqual([counter.checks, opened.readOnly], [0, false], 'closed cleanly: opened without quick_check')
  damagePage(file, 'entities')
  rejectsWith(() => opened.read((reader) => reader.get('entities', seed.entities[0].id)), 'E_STORE_CORRUPT')
  assert.deepEqual([opened.readOnly, opened.diagnostic.code], [true, 'E_STORE_CORRUPT'])
  const refused = await attemptCommit(opened, request(1, [update('entries', seed.entries[0], { fields: { rating: 1 } })]))
  assert.deepEqual([refused.code, refused.outcome], ['E_STORE_CORRUPT', 'not_committed'])
  assert.equal(opened.meta().revision, 1, 'undamaged pages stay readable for rescue')
  const before = sha256(file)
  await opened.close()
  assert.equal(sha256(file), before, 'nothing repaired, and the session is not marked clean')
  const again = track(t, openStore(file, counter.options))
  assert.equal(counter.checks, 1, 'the next open runs quick_check')
  assert.deepEqual([again.readOnly, again.diagnostic.code], [true, 'E_STORE_CORRUPT'])
})
