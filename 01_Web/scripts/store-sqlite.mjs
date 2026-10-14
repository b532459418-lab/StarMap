/**
 * Thin adapter over `node:sqlite` for the formal store host (3C-2, design 3B §4.1, §4.3 and v1.1 §16).
 *
 * Everything that depends on the `node:sqlite` API lives here: constructor options, the
 * connection settings and their read-back, transaction state (`isTransaction`) and the
 * classification of SQLite errors into store codes. The host (store-host.mjs) never touches
 * `DatabaseSync` directly, so a later runtime change stays inside this file.
 *
 * Every connection to a store file is opened here, with the store's journal mode (3C-4b): the host's
 * (openConnection: the App, the store:* commands, library:recover, migration and restore all go
 * through store-host.mjs) and the raw ones of tests and the benchmark (rawConnection). On Windows a
 * connection in SQLite's default DELETE mode cannot commit while another connection has the store
 * open in TRUNCATE mode: it fails with "disk I/O error" (SQLITE_IOERR_DELETE) when it removes the
 * journal, and leaves that journal hot. Nothing outside this file calls `new DatabaseSync` on a store.
 *
 * Node version: `node:sqlite` is a release candidate from Node 24.15.0 on (design 3B §4.1,
 * 0.1 #11), which is the minimum this adapter accepts. Developed and tested on Node 24.19.0
 * with its bundled SQLite 3.53.3.
 *
 * Errors carry codes and SQLite result codes only, never record contents.
 */
import { DatabaseSync } from 'node:sqlite'

/** Minimum Node version (major, minor) whose `node:sqlite` the host relies on. */
export const MIN_NODE = Object.freeze([24, 15])
/** The Node version this adapter was developed and tested on. */
export const TESTED_NODE = '24.19.0'
/** Writers never wait long: a competing writer is a conflict to report, not to queue behind. */
export const BUSY_TIMEOUT_MS = 25

/**
 * Connection settings applied to every connection and read back to confirm they took effect.
 * TRUNCATE + EXTRA (design 3B v1.1 §16.2-2): a commit truncates the rollback journal instead of
 * creating and deleting it, which on Windows costs about half as much as DELETE. Between writes
 * the journal is a zero-length file; SQLite never treats a zero-length journal as hot, and a
 * journal with content left by a crashed writer is rolled back by the next writable connection.
 * WAL is not used: its checkpoints add a long tail to commits.
 */
const SETTINGS = Object.freeze([
  // [statement, read-back pragma, read-back column, expected value]
  ['PRAGMA journal_mode = TRUNCATE', 'journal_mode', 'journal_mode', 'truncate'],
  ['PRAGMA synchronous = EXTRA', 'synchronous', 'synchronous', 3],
  ['PRAGMA foreign_keys = ON', 'foreign_keys', 'foreign_keys', 1],
  ['PRAGMA trusted_schema = OFF', 'trusted_schema', 'trusted_schema', 0],
  [undefined, 'busy_timeout', 'timeout', BUSY_TIMEOUT_MS],
])

/** Errors of the store host and its adapter. `outcome` tells a writer what happened to its request:
 * 'not_committed' (confirmed) or 'unknown' (look the request id up, or retry with the same id). */
export class StoreHostError extends Error {
  constructor(code, { path, outcome, sqlite, cause, message } = {}) {
    super(message ?? (path ? `${code}: ${path}` : code), cause === undefined ? undefined : { cause })
    this.name = 'StoreHostError'
    this.code = code
    if (path !== undefined) this.path = path
    if (outcome !== undefined) this.outcome = outcome
    if (sqlite !== undefined) this.sqlite = sqlite
  }
}

/** True when this Node's `node:sqlite` is at least MIN_NODE. */
export function nodeSupportsStore(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number)
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])
}

const isSqliteError = (error) => error?.code === 'ERR_SQLITE_ERROR' && typeof error.errcode === 'number'

/** SQLite primary result code → store code. Unknown or non-SQLite errors → E_STORE_SQLITE. */
export function classifySqliteError(error) {
  if (!isSqliteError(error)) return 'E_STORE_SQLITE'
  switch (error.errcode & 0xff) {
    case 5: case 6: return 'E_STORE_BUSY' // SQLITE_BUSY, SQLITE_LOCKED
    case 8: return 'E_STORE_READONLY' // SQLITE_READONLY
    case 10: return 'E_STORE_IO' // SQLITE_IOERR
    case 11: case 26: return 'E_STORE_CORRUPT' // SQLITE_CORRUPT, SQLITE_NOTADB
    case 13: return 'E_STORE_FULL' // SQLITE_FULL
    case 14: return 'E_STORE_CANTOPEN' // SQLITE_CANTOPEN
    case 19: return 'E_STORE_CONSTRAINT' // SQLITE_CONSTRAINT
    default: return 'E_STORE_SQLITE'
  }
}

/** The SQLite result code and its generic text (no statement text, no values). */
export const sqliteDetail = (error) => (isSqliteError(error) ? { errcode: error.errcode, errstr: error.errstr } : undefined)

/** A StoreHostError for a SQLite (or unexpected) failure. */
export function storeErrorFrom(error, outcome) {
  if (error instanceof StoreHostError) {
    if (outcome !== undefined && error.outcome === undefined) error.outcome = outcome
    return error
  }
  return new StoreHostError(classifySqliteError(error), { outcome, sqlite: sqliteDetail(error), cause: error })
}

/**
 * Whether the connection has an open transaction: true / false, or undefined when even that
 * cannot be determined (closed or failing connection). Callers treat undefined as unknown.
 */
export function transactionState(db) {
  try {
    const value = db.isTransaction
    return typeof value === 'boolean' ? value : undefined
  } catch {
    return undefined
  }
}

/** One pragma value (the first column of its first row). */
export function pragmaValue(db, name, column = name) {
  const row = db.prepare(`PRAGMA ${name}`).get()
  return row === undefined ? undefined : row[column]
}

/**
 * Open a connection with the store's settings and confirm each setting by reading it back.
 * Never creates a file: callers create it exclusively first (createStore) or check it exists.
 * Extension loading is disabled; defensive mode blocks schema-corrupting SQL.
 */
export function openConnection(file, { readOnly = false } = {}) {
  if (!nodeSupportsStore()) throw new StoreHostError('E_STORE_NODE_VERSION', { message: `E_STORE_NODE_VERSION: node:sqlite needs Node ${MIN_NODE.join('.')} or newer` })
  let db
  try {
    db = new DatabaseSync(file, {
      readOnly,
      allowExtension: false,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      timeout: BUSY_TIMEOUT_MS,
      defensive: true,
    })
    for (const [statement, name, column, expected] of SETTINGS) {
      if (statement) db.exec(statement)
      if (pragmaValue(db, name, column) !== expected) throw new StoreHostError('E_STORE_SETTINGS', { path: name })
    }
    return db
  } catch (error) {
    try { db?.close() } catch { /* The open failure is what matters. */ }
    throw storeErrorFrom(error)
  }
}

/**
 * A connection below the host, for tests and the benchmark only: set-up, damage and bulk history written straight into
 * the file, a second connection that holds a lock, a read-back. It has the store's journal mode (TRUNCATE, read back)
 * and busy timeout, so it can write while a host connection has the store open (see the file header); everything else
 * is node:sqlite's default, so a test can still write what the host would refuse. Never used by the App or the tools.
 */
export function rawConnection(file, { readOnly = false } = {}) {
  const db = new DatabaseSync(file, { readOnly, allowExtension: false, timeout: BUSY_TIMEOUT_MS })
  try {
    db.exec('PRAGMA journal_mode = TRUNCATE')
    if (pragmaValue(db, 'journal_mode') !== 'truncate') throw new StoreHostError('E_STORE_SETTINGS', { path: 'journal_mode' })
    return db
  } catch (error) {
    closeQuietly(db)
    throw error
  }
}

/** A private in-memory connection, used only to derive the expected schema rows from the DDL. */
export function scratchConnection() {
  return new DatabaseSync(':memory:', { allowExtension: false, enableDoubleQuotedStringLiterals: false, defensive: true })
}

/** Close, ignoring a connection that is already closed or failing. */
export function closeQuietly(db) {
  try { if (db?.isOpen) db.close() } catch { /* Nothing more to release. */ }
}
