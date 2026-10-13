/**
 * Formal store host (3C-2, design 3B §4–§6): one SQLite file holds the World Graph's formal
 * state, one row per record, with receipts and diagnostics committed in the same transaction.
 *
 * - SQLite access goes through the thin adapter ./store-sqlite.mjs (`node:sqlite`).
 * - Domain rules stay in Core (`src/worldgraph/store/`, loaded by Node 24 directly as `.ts`):
 *   the host plans with `planCommands` inside `BEGIN IMMEDIATE` and executes the change set.
 * - No Vite, no App: the App is wired in 3C-3/3C-4.
 *
 * The production location is planned as `<private-root>/data/store/world.sqlite`
 * (STORE_RELATIVE_PATH). 3C-2 does not wire the private root: callers pass the file path.
 */
import { closeSync, lstatSync, openSync, realpathSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { withLibraryOperation } from './library-operation-lock.mjs'
import {
  StoreHostError, closeQuietly, openConnection, pragmaValue, scratchConnection, storeErrorFrom, transactionState,
} from './store-sqlite.mjs'
import { FORMAL_TABLES } from '../src/worldgraph/store/formal.ts'
import { StoreError, utcTimestamp, uuid } from '../src/worldgraph/store/primitives.ts'

export { StoreHostError } from './store-sqlite.mjs'

export const STORE_FORMAT = 'starmap.formal-store'
/** Also the SQLite `user_version`. Raise it only together with an entry in MIGRATIONS. */
export const STORE_FORMAT_VERSION = 1
/** `PRAGMA application_id` of a formal store file ('SMF1'). */
export const STORE_APPLICATION_ID = 0x534d4631
/** Planned production location under the private root (not wired in 3C-2). */
export const STORE_RELATIVE_PATH = Object.freeze(['data', 'store', 'world.sqlite'])
export const storePathFor = (privateRoot) => path.join(privateRoot, ...STORE_RELATIVE_PATH)

/** Upgrades from an older user_version, keyed by that version. Version 1 is the first. */
const MIGRATIONS = Object.freeze({})

// ---------------------------------------------------------------------------
// Schema (user_version 1)
// ---------------------------------------------------------------------------

const deferredRef = (table) => `REFERENCES ${table} (id) DEFERRABLE INITIALLY DEFERRED`
/** A top-level row key stored as its own column instead of in `body`. */
const lifted = (name, key, type = 'TEXT NOT NULL', references) => Object.freeze({ name, key, type, references, lifted: true })
/** A column copied from inside the row (the value also stays in `body`), for an index. */
const derived = (name, read, references) => Object.freeze({ name, read, type: 'TEXT NOT NULL', references, lifted: false })

/**
 * Fact and definition tables: one STRICT table per FORMAL_TABLES entry with `id`, `revision`,
 * the indexed reference columns and `body` (the rest of the row as JSON text). Every unique
 * index answers one StoreReader.find* method. Foreign keys back up the planner's checks where
 * a reference is a plain column; they are checked at COMMIT (deferred).
 */
export const ROW_TABLES = Object.freeze({
  sources: { sql: 'sources', columns: [], indexes: [] },
  evidence: { sql: 'evidence', columns: [], indexes: [] },
  reviews: {
    sql: 'reviews',
    columns: [lifted('proposal_id', 'proposalId')],
    // findReviewByProposal
    indexes: ['CREATE UNIQUE INDEX reviews_proposal ON reviews (proposal_id)'],
  },
  entityTypes: { sql: 'entity_types', columns: [], indexes: [] },
  layers: {
    sql: 'layers',
    columns: [lifted('system_key', 'systemKey', 'TEXT')],
    // findLayerBySystemKey (NULLs are distinct: layers without a system key never collide)
    indexes: ['CREATE UNIQUE INDEX layers_system_key ON layers (system_key)'],
  },
  entities: { sql: 'entities', columns: [], indexes: [] },
  entries: {
    sql: 'entries',
    columns: [
      lifted('entity_id', 'entityId', 'TEXT NOT NULL', 'entities'),
      lifted('layer_id', 'layerId', 'TEXT NOT NULL', 'layers'),
      derived('source_id', (row) => row.source.sourceId, 'sources'),
      derived('record_id', (row) => row.source.recordId),
    ],
    indexes: [
      // findEntryByIdentity: the G1 entry identity key (entity, layer, source, record)
      'CREATE UNIQUE INDEX entries_identity ON entries (entity_id, layer_id, source_id, record_id)',
      'CREATE INDEX entries_layer ON entries (layer_id)',
      'CREATE INDEX entries_source ON entries (source_id, record_id)',
    ],
  },
  relationTypes: { sql: 'relation_types', columns: [], indexes: [] },
  relations: {
    sql: 'relations',
    columns: [
      lifted('from_entity_id', 'fromEntityId', 'TEXT NOT NULL', 'entities'),
      lifted('to_entity_id', 'toEntityId', 'TEXT NOT NULL', 'entities'),
    ],
    indexes: ['CREATE INDEX relations_from ON relations (from_entity_id)', 'CREATE INDEX relations_to ON relations (to_entity_id)'],
  },
  anchors: {
    sql: 'anchors',
    columns: [lifted('entity_id', 'entityId', 'TEXT NOT NULL', 'entities')],
    indexes: ['CREATE INDEX anchors_entity ON anchors (entity_id)'],
  },
  assets: { sql: 'assets', columns: [], indexes: [] },
  sequences: {
    sql: 'sequences',
    columns: [lifted('entity_id', 'entityId', 'TEXT NOT NULL', 'entities')],
    indexes: ['CREATE INDEX sequences_entity ON sequences (entity_id)'],
  },
  viewItems: {
    sql: 'view_items',
    columns: [lifted('scope', 'scope'), lifted('item_table', 'itemTable'), lifted('item_id', 'itemId')],
    // findViewItem
    indexes: ['CREATE UNIQUE INDEX view_items_item ON view_items (scope, item_table, item_id)'],
  },
  viewSettings: {
    sql: 'view_settings',
    columns: [lifted('scope', 'scope'), lifted('setting_key', 'key')],
    // findViewSetting
    indexes: ['CREATE UNIQUE INDEX view_settings_key ON view_settings (scope, setting_key)'],
  },
})

function rowTableDdl(spec) {
  const columns = spec.columns.map((column) => `${column.name} ${column.type}${column.references ? ` ${deferredRef(ROW_TABLES[column.references].sql)}` : ''}`)
  return [
    `CREATE TABLE ${spec.sql} (id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK (revision >= 0), ${[...columns, 'body TEXT NOT NULL'].join(', ')}) STRICT`,
    ...spec.indexes,
  ]
}

/** Every CREATE statement of user_version 1, in creation order. */
export const SCHEMA_V1 = Object.freeze([
  'CREATE TABLE store_meta (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), format TEXT NOT NULL, format_version INTEGER NOT NULL, '
    + 'library_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision >= 0), created_at TEXT NOT NULL) STRICT',
  ...FORMAL_TABLES.flatMap((table) => rowTableDdl(ROW_TABLES[table])),
  // Reverse references for StoreReader.dependents. Table names are Core names (e.g. viewItems).
  'CREATE TABLE refs (from_table TEXT NOT NULL, from_id TEXT NOT NULL, field TEXT NOT NULL, to_table TEXT NOT NULL, to_id TEXT NOT NULL, '
    + 'PRIMARY KEY (from_table, from_id, field, to_table, to_id)) STRICT, WITHOUT ROWID',
  'CREATE INDEX refs_target ON refs (to_table, to_id)',
  // Permanent tombstones: a deleted (table, id) can never be created again.
  'CREATE TABLE tombstones (table_name TEXT NOT NULL, id TEXT NOT NULL, deleted_at TEXT NOT NULL, PRIMARY KEY (table_name, id)) STRICT, WITHOUT ROWID',
  // Committed requests only (design 3B §4.5): a rejected request writes nothing.
  'CREATE TABLE receipts (request_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, status TEXT NOT NULL, revision_after INTEGER NOT NULL, '
    + 'response TEXT NOT NULL, at TEXT NOT NULL) STRICT',
  'CREATE INDEX receipts_at ON receipts (at)',
  // Diagnostic summaries; no undo data (design 3B §4.6).
  'CREATE TABLE op_log (seq INTEGER PRIMARY KEY, request_id TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL) STRICT',
  // Identity manifest for 3C-1b: (kind, source, record) → formal id.
  'CREATE TABLE id_map (kind TEXT NOT NULL, source_id TEXT NOT NULL, record_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (kind, source_id, record_id)) STRICT, WITHOUT ROWID',
  // Media file operations awaiting confirmation or deletion (design 3B §5.1). Logic arrives in 3C-4.
  'CREATE TABLE pending_file_ops (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL, request_id TEXT NOT NULL, at TEXT NOT NULL, detail TEXT NOT NULL) STRICT',
])

const SCHEMA_QUERY = "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_stat%' ORDER BY type, name"
let expectedSchemaRows
/** sqlite_schema rows a correct store has, derived once by creating SCHEMA_V1 in memory. */
function expectedSchema() {
  if (!expectedSchemaRows) {
    const db = scratchConnection()
    try {
      for (const statement of SCHEMA_V1) db.exec(statement)
      expectedSchemaRows = JSON.stringify(db.prepare(SCHEMA_QUERY).all().map((row) => ({ ...row })))
    } finally { closeQuietly(db) }
  }
  return expectedSchemaRows
}

// ---------------------------------------------------------------------------
// Open checks and handles
// ---------------------------------------------------------------------------

const fail = (code, details) => { throw new StoreHostError(code, details) }
const missing = (error) => error?.code === 'ENOENT'
/** Core validation (StoreError) as a host error with the same code and path. */
function core(callback, outcome = 'not_committed') {
  try { return callback() } catch (error) {
    if (error instanceof StoreError) throw new StoreHostError(error.code, { path: error.path, outcome })
    throw error
  }
}
/** Handle internals shared by the sections below. */
const internal = Symbol('store-host-internal')

function absoluteFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) fail('E_STORE_PATH', { path: 'file' })
  return path.resolve(file)
}

/** An existing, regular, non-symlink file. */
function existingFile(file) {
  let metadata
  try { metadata = lstatSync(file) } catch (error) {
    if (missing(error)) fail('E_STORE_NOT_FOUND', { path: 'file' })
    throw error
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail('E_STORE_PATH', { path: 'file' })
}

/** One writable connection per store file in this process. */
const writers = new Set()
const writerKey = (file) => {
  const real = realpathSync(file)
  return process.platform === 'win32' ? real.toLowerCase() : real
}

/**
 * The open checks (design 3B §4.3): application_id, user_version (newer is E_STORE_TOO_NEW,
 * older migrates), schema, store_meta and quick_check. Returns undefined when the store is
 * usable, otherwise a diagnostic { code, detail? }. Never repairs anything.
 */
function openDiagnostic(db, timings = {}) {
  try {
    if (pragmaValue(db, 'application_id') !== STORE_APPLICATION_ID) return { code: 'E_STORE_APPLICATION_ID' }
    const version = pragmaValue(db, 'user_version')
    if (version > STORE_FORMAT_VERSION) return { code: 'E_STORE_TOO_NEW', detail: { version } }
    if (version < STORE_FORMAT_VERSION) {
      // No older version exists yet; a future migration runs MIGRATIONS[version] here.
      if (!Object.hasOwn(MIGRATIONS, version)) return { code: 'E_STORE_VERSION', detail: { version } }
    }
    if (JSON.stringify(db.prepare(SCHEMA_QUERY).all().map((row) => ({ ...row }))) !== expectedSchema()) return { code: 'E_STORE_SCHEMA' }
    const meta = db.prepare('SELECT format, format_version FROM store_meta WHERE singleton = 1').get()
    if (meta?.format !== STORE_FORMAT || meta.format_version !== STORE_FORMAT_VERSION) return { code: 'E_STORE_SCHEMA', detail: { table: 'store_meta' } }
    const started = performance.now()
    const check = db.prepare('PRAGMA quick_check').all().map((row) => row.quick_check)
    timings.quickCheckMs = performance.now() - started
    if (check.length !== 1 || check[0] !== 'ok') return { code: 'E_STORE_CORRUPT', detail: { problems: check.length } }
    return undefined
  } catch (error) {
    const failure = storeErrorFrom(error)
    // A busy store is not damaged: let the caller retry later.
    if (failure.code === 'E_STORE_BUSY') throw failure
    return { code: failure.code === 'E_STORE_SQLITE' ? 'E_STORE_CORRUPT' : failure.code, detail: failure.sqlite }
  }
}

function resolveLock({ lock, privatePaths }) {
  if (lock !== undefined) {
    if (typeof lock !== 'function') fail('E_STORE_OPTIONS', { path: 'lock' })
    return lock
  }
  if (typeof privatePaths?.root !== 'string') fail('E_STORE_LOCK_REQUIRED', { path: 'privatePaths' })
  // One lease per write, released when the write ends (design 3B §5.2).
  return (callback) => withLibraryOperation(privatePaths, () => callback())
}

/** For tests and benchmarks only: run writes without the library operation lease. */
export const withoutLibraryLock = (callback) => callback()

function hostOptions(options) {
  const now = options.now ?? (() => new Date().toISOString())
  if (typeof now !== 'function') fail('E_STORE_OPTIONS', { path: 'now' })
  return { now, policy: options.policy ?? {}, phase: options.unsafeTestPhase }
}

/**
 * Open an existing store. With failed open checks the store opens read-only and the handle
 * carries `diagnostic` ({ code }): writes are refused with that code and nothing is repaired.
 *
 * Options: `privatePaths` (writes take the library operation lease under it) or `lock`
 * (a callback runner; tests and benchmarks may pass withoutLibraryLock), `now`, `policy`
 * (StorePolicy for planning and full validation), `readOnly`.
 */
export function openStore(file, options = {}) {
  const target = absoluteFile(file)
  existingFile(target)
  const settings = hostOptions(options)
  if (options.readOnly === true) return readOnlyHandle(target, settings, undefined)
  const lock = resolveLock(options)
  const key = writerKey(target)
  if (writers.has(key)) fail('E_STORE_ALREADY_OPEN', { path: 'file' })
  // A writable connection rolls back a hot journal left by a crashed writer (SQLite's own recovery).
  const started = performance.now()
  const db = openConnection(target)
  const timings = { connectMs: performance.now() - started }
  let diagnostic
  try { diagnostic = openDiagnostic(db, timings) } catch (error) { closeQuietly(db); throw error }
  timings.openMs = performance.now() - started
  if (diagnostic) {
    closeQuietly(db)
    return readOnlyHandle(target, settings, diagnostic)
  }
  return writableHandle(db, target, key, lock, settings, timings)
}

/** Read-only handle: explicit read-only opens and stores that failed an open check. */
function readOnlyHandle(file, settings, diagnostic) {
  let db
  let failure = diagnostic
  try {
    db = openConnection(file, { readOnly: true })
    failure ??= openDiagnostic(db)
  } catch (error) {
    closeQuietly(db)
    db = undefined
    failure ??= { code: storeErrorFrom(error).code }
  }
  // Reading is attempted only where the format is ours and understood.
  const readable = db !== undefined && (failure === undefined || failure.code === 'E_STORE_CORRUPT')
  return makeHandle({ db: readable ? db : (closeQuietly(db), undefined), file, settings, diagnostic: failure, writable: false })
}

function writableHandle(db, file, key, lock, settings, timings) {
  writers.add(key)
  return makeHandle({ db, file, settings, writable: true, lock, timings, release: () => writers.delete(key) })
}

function makeHandle({ db, file, settings, diagnostic, writable, lock, timings, release }) {
  let closed = false
  let tail = Promise.resolve()
  const usable = () => {
    if (closed) fail('E_STORE_CLOSED')
    if (!db) fail(diagnostic?.code ?? 'E_STORE_CLOSED', { outcome: 'not_committed' })
    return db
  }
  /** Writes refuse on a read-only handle with the open diagnostic's code. */
  const writer = () => {
    if (closed) fail('E_STORE_CLOSED', { outcome: 'not_committed' })
    if (!writable) fail(diagnostic?.code ?? 'E_STORE_READONLY', { outcome: 'not_committed' })
    return db
  }
  /** Writes in this process run one at a time, each under its own lease. */
  const enqueue = (work) => {
    const run = tail.then(work, work)
    tail = run.catch(() => {})
    return run
  }
  /** A short read transaction; SQLite's file lock keeps it consistent. */
  const readTransaction = (callback) => {
    const connection = usable()
    if (transactionState(connection) !== false) fail('E_STORE_BUSY')
    try {
      connection.exec('BEGIN')
      const result = callback(connection)
      if (result && typeof result.then === 'function') fail('E_STORE_ASYNC_READ')
      return result
    } catch (error) {
      throw storeErrorFrom(error)
    } finally {
      if (transactionState(connection) === true) {
        try { connection.exec('ROLLBACK') } catch { /* Released on close. */ }
      }
    }
  }
  const handle = {
    file,
    get readOnly() { return !writable },
    get diagnostic() { return diagnostic },
    /** Open timings in milliseconds (connectMs, quickCheckMs, openMs), for benchmarks. */
    get openTimings() { return timings },
    /** store_meta as an object: format, formatVersion, libraryId, revision, createdAt. */
    meta() {
      return readTransaction((connection) => {
        const row = connection.prepare('SELECT format, format_version, library_id, revision, created_at FROM store_meta WHERE singleton = 1').get()
        if (!row) fail('E_STORE_SCHEMA', { path: 'store_meta' })
        return Object.freeze({ format: row.format, formatVersion: row.format_version, libraryId: row.library_id, revision: row.revision, createdAt: row.created_at })
      })
    },
    /** Wait for queued writes, then close the connection. */
    async close() {
      if (closed) return
      closed = true
      await tail
      closeQuietly(db)
      release?.()
    },
  }
  // Internal hooks for later sections of this module.
  Object.defineProperty(handle, internal, { value: { readTransaction, writer, enqueue, lock, settings } })
  return handle
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/**
 * Create a new store file, exclusively: an existing target is E_STORE_EXISTS and is never
 * touched. Schema, `application_id`, `user_version` and `store_meta` are written in one
 * transaction under the library lease. `libraryId` (UUIDv7) is injected by the caller.
 */
export async function createStore(file, options = {}) {
  const target = absoluteFile(file)
  const settings = hostOptions(options)
  core(() => uuid(options.libraryId, 'libraryId'))
  const lock = resolveLock(options)
  return lock(() => {
    const createdAt = settings.now()
    core(() => utcTimestamp(createdAt, 'now'))
    try { closeSync(openSync(target, 'wx', 0o600)) } catch (error) {
      if (error?.code === 'EEXIST') fail('E_STORE_EXISTS', { path: 'file' })
      if (missing(error)) fail('E_STORE_PATH', { path: 'file' })
      throw error
    }
    let db
    try {
      db = openConnection(target)
      db.exec('BEGIN IMMEDIATE')
      db.exec(`PRAGMA application_id = ${STORE_APPLICATION_ID}`)
      db.exec(`PRAGMA user_version = ${STORE_FORMAT_VERSION}`)
      for (const statement of SCHEMA_V1) db.exec(statement)
      db.prepare('INSERT INTO store_meta (singleton, format, format_version, library_id, revision, created_at) VALUES (1, ?, ?, ?, 0, ?)')
        .run(STORE_FORMAT, STORE_FORMAT_VERSION, options.libraryId, createdAt)
      db.exec('COMMIT')
    } catch (error) {
      if (db && transactionState(db) === true) { try { db.exec('ROLLBACK') } catch { /* Closing releases it. */ } }
      closeQuietly(db)
      // The file was created exclusively by this call and never committed: remove it.
      try { unlinkSync(target) } catch { /* Left for review. */ }
      throw error instanceof StoreError ? new StoreHostError(error.code, { path: error.path, outcome: 'not_committed' }) : storeErrorFrom(error, 'not_committed')
    }
    const key = writerKey(target)
    if (writers.has(key)) { closeQuietly(db); fail('E_STORE_ALREADY_OPEN', { path: 'file' }) }
    return writableHandle(db, target, key, lock, settings)
  })
}

