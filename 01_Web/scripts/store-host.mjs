/**
 * Formal store host (3C-2, design 3B §4–§6 as revised by v1.1 §16): one SQLite file holds the World Graph's formal
 * state, one row per record, with receipts and diagnostics committed in the same transaction.
 *
 * - SQLite access goes through the thin adapter ./store-sqlite.mjs (`node:sqlite`).
 * - Domain rules stay in Core (`src/worldgraph/store/`, loaded by Node 24 directly as `.ts`):
 *   the host plans with `planCommands` inside `BEGIN IMMEDIATE` and executes the change set.
 * - No Vite, no App: the new-library mode (3C-3; the only write path since 3C-4d) wires it through
 *   ./store-session.mjs (the plugin) and the store:* tools.
 *
 * The production location is `<private-root>/data/store/world.sqlite` (STORE_RELATIVE_PATH,
 * ./private-data-source.mjs decides the mode by it). Callers pass the file path.
 */
import { createHash } from 'node:crypto'
import { closeSync, lstatSync, openSync, realpathSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { libraryLockProbe, withLibraryOperation } from './library-operation-lock.mjs'
import {
  MEDIA_SCHEMA, MEDIA_TABLES, applyMediaBlock, checkWrittenAssets, mediaEntitiesOf, mediaRegistryProblems, mediaRegistrySnapshot, settleFileOperations, validMediaBlock,
} from './store-media-registry.mjs'
import {
  StoreHostError, closeQuietly, openConnection, pragmaValue, scratchConnection, sqliteDetail, storeErrorFrom, transactionState,
} from './store-sqlite.mjs'
import { FORMAL_TABLES, readFormalState as readFormalStateCore } from '../src/worldgraph/store/formal.ts'
import { memoryReader, refKey, referencesOf } from '../src/worldgraph/store/reader.ts'
import { planCommands } from '../src/worldgraph/store/planner.ts'
import { readModelOf } from '../src/worldgraph/readModel/build.ts'
import { OFFICIAL_DEFINITIONS_VERSION } from '../src/data/store/officialDefinitions.ts'
import {
  StoreError, freezeCopy, jsonKey, opaqueId, reject, revision, shape, utcTimestamp, uuid, validateJson,
} from '../src/worldgraph/store/primitives.ts'

export { StoreHostError } from './store-sqlite.mjs'

export const STORE_FORMAT = 'starmap.formal-store'
/**
 * Also the SQLite `user_version`. Raise it only together with an entry in MIGRATIONS. 2 since 3C-4c: the media registry
 * (./store-media-registry.mjs, design v2 §2). 3 since 3C-5 E: the same schema; every added country has its visit entry
 * (../src/data/store/storeFormatUpgrades.ts), so the official view reads added countries by the entry. 4 since 3C-5 G:
 * the `store_definitions` table records the version of the store's official definitions (DEFINITIONS_SCHEMA).
 */
export const STORE_FORMAT_VERSION = 4
/** `PRAGMA application_id` of a formal store file ('SMF1'). */
export const STORE_APPLICATION_ID = 0x534d4631
/**
 * `PRAGMA auto_vacuum` of a formal store file: INCREMENTAL (2), part of schema v1 (design 3B
 * v1.1 §16.2-5). SQLite accepts it only before the first table exists, so createStore sets it
 * first; pruning then returns freed pages to the file system with `incremental_vacuum`.
 */
export const STORE_AUTO_VACUUM = 2
/** Production location under the private root (./private-data-source.mjs STORE_FILE_SEGMENTS). */
export const STORE_RELATIVE_PATH = Object.freeze(['data', 'store', 'world.sqlite'])
export const storePathFor = (privateRoot) => path.join(privateRoot, ...STORE_RELATIVE_PATH)

/**
 * Upgrades from an older user_version, keyed by that version: the statements that turn its schema into the next one. A
 * store of such a version opens with E_STORE_UPGRADE_REQUIRED and is upgraded only by upgradeStoreFile (`npm run
 * store:upgrade`), never by an open. Version 1 is the first; 1 → 2 adds the media registry; 2 → 3 changes no table
 * (the rows it needs come with the upgrade's request: upgradeStoreFile `commands`).
 */
/**
 * 3C-5 G: the version of the store's official definitions (../src/data/store/officialDefinitions.ts
 * OFFICIAL_DEFINITIONS_VERSION), one row. A store opens only when it equals the code's: an older one is
 * E_STORE_UPGRADE_REQUIRED (`npm run store:upgrade` brings the rows and the version up), a newer one E_STORE_TOO_NEW.
 */
export const DEFINITIONS_SCHEMA = Object.freeze([
  'CREATE TABLE store_definitions (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL CHECK (version >= 1)) STRICT',
])
const MIGRATIONS = Object.freeze({
  1: Object.freeze({ to: 2, statements: MEDIA_SCHEMA }),
  2: Object.freeze({ to: 3, statements: Object.freeze([]) }),
  // 3C-5 G: every store before format 4 has the official definitions of version 1.
  3: Object.freeze({ to: 4, statements: Object.freeze([...DEFINITIONS_SCHEMA, 'INSERT INTO store_definitions (singleton, version) VALUES (1, 1)']) }),
})

const fail = (code, details) => { throw new StoreHostError(code, details) }
const missing = (error) => error?.code === 'ENOENT'
/** Core validation (StoreError) as a host error with the same code and path. */
function core(callback, outcome) {
  try { return callback() } catch (error) {
    if (error instanceof StoreError) throw new StoreHostError(error.code, { path: error.path, outcome })
    throw error
  }
}

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
    unique: ['proposal_id'],
    // findReviewByProposal
    indexes: ['CREATE UNIQUE INDEX reviews_proposal ON reviews (proposal_id)'],
  },
  entityTypes: { sql: 'entity_types', columns: [], indexes: [] },
  layers: {
    sql: 'layers',
    columns: [lifted('system_key', 'systemKey', 'TEXT')],
    unique: ['system_key'],
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
    unique: ['entity_id', 'layer_id', 'source_id', 'record_id'],
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
    unique: ['scope', 'item_table', 'item_id'],
    // findViewItem
    indexes: ['CREATE UNIQUE INDEX view_items_item ON view_items (scope, item_table, item_id)'],
  },
  viewSettings: {
    sql: 'view_settings',
    columns: [lifted('scope', 'scope'), lifted('setting_key', 'key')],
    unique: ['scope', 'setting_key'],
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
  // clean_shutdown: 0 while a writer session is open, 1 after its close() (design 3B v1.1 §16.2-3).
  // restored_from (3C-3, design 3B §8): the backup this store was last restored from, as JSON; NULL for a store that was
  // never restored. One layer only: a restore replaces it, so no chain of ancestors grows.
  'CREATE TABLE store_meta (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), format TEXT NOT NULL, format_version INTEGER NOT NULL, '
    + 'library_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision >= 0), created_at TEXT NOT NULL, '
    + 'clean_shutdown INTEGER NOT NULL CHECK (clean_shutdown IN (0, 1)), restored_from TEXT) STRICT',
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
  // Media file operations awaiting deletion (design 3B §5.1; 3C-4c: rows come with a commit's media block).
  'CREATE TABLE pending_file_ops (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL, request_id TEXT NOT NULL, at TEXT NOT NULL, detail TEXT NOT NULL) STRICT',
])

/** Every CREATE statement of user_version 2 (3C-4c): version 1 and the media registry (./store-media-registry.mjs). */
export const SCHEMA_V2 = Object.freeze([...SCHEMA_V1, ...MEDIA_SCHEMA])
/** Every CREATE statement of user_version 4 (3C-5 G): version 2's (3 is 2's) and the definitions version. */
export const SCHEMA_V4 = Object.freeze([...SCHEMA_V2, ...DEFINITIONS_SCHEMA])
/** The schema of each format version this host knows (the current one, and the ones it upgrades from). 3 is 2's. */
const SCHEMAS = Object.freeze({ 1: SCHEMA_V1, 2: SCHEMA_V2, 3: SCHEMA_V2, 4: SCHEMA_V4 })

/** The host's own tables besides store_meta (tableCounts). */
const HOST_TABLES = Object.freeze(['refs', 'tombstones', 'receipts', 'op_log', 'id_map', 'pending_file_ops', ...MEDIA_TABLES])

const SCHEMA_QUERY = "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_stat%' ORDER BY type, name"
const expectedSchemaRows = new Map()
/** sqlite_schema rows a correct store of `version` has, derived once by creating its schema in memory. */
function expectedSchema(version = STORE_FORMAT_VERSION) {
  if (!expectedSchemaRows.has(version)) {
    const db = scratchConnection()
    try {
      for (const statement of SCHEMAS[version]) db.exec(statement)
      expectedSchemaRows.set(version, JSON.stringify(db.prepare(SCHEMA_QUERY).all().map((row) => ({ ...row }))))
    } finally { closeQuietly(db) }
  }
  return expectedSchemaRows.get(version)
}

// ---------------------------------------------------------------------------
// Rows and the SQLite StoreReader
// ---------------------------------------------------------------------------

const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/**
 * Column values of one validated row, in table column order: id, revision, the spec's
 * columns, body. Lifted keys leave `body`; derived columns copy a nested value that stays
 * in `body`. Exported for tests and the benchmark loader.
 */
export function encodeRow(table, row) {
  const spec = ROW_TABLES[table]
  const { id, revision, ...body } = row
  const values = [id, revision]
  for (const column of spec.columns) {
    if (!column.lifted) { values.push(column.read(row)); continue }
    values.push(Object.hasOwn(body, column.key) ? body[column.key] : null)
    delete body[column.key]
  }
  values.push(JSON.stringify(body))
  return values
}

/** The Core row object of one SQLite record: exactly the row that was encoded (JSON values). */
function decodeRow(table, record) {
  const spec = ROW_TABLES[table]
  let body
  try { body = JSON.parse(record.body) } catch { fail('E_STORE_CORRUPT', { path: `${table}.body` }) }
  if (body === null || typeof body !== 'object' || Array.isArray(body) || Object.hasOwn(body, 'id') || Object.hasOwn(body, 'revision')) {
    fail('E_STORE_CORRUPT', { path: `${table}.body` })
  }
  const columns = {}
  for (const column of spec.columns) {
    if (!column.lifted) continue
    if (Object.hasOwn(body, column.key)) fail('E_STORE_CORRUPT', { path: `${table}.body` })
    if (record[column.name] !== null) columns[column.key] = record[column.name]
  }
  // Spread defines own properties, so a stored "__proto__" key can never reach a prototype.
  return { id: record.id, revision: record.revision, ...columns, ...body }
}

const columnList = (spec) => ['id', 'revision', ...spec.columns.map((column) => column.name), 'body'].join(', ')
const statementCache = new WeakMap()
/** Prepared statements of one connection. */
function statements(db) {
  let cached = statementCache.get(db)
  if (cached) return cached
  const prepare = (sql) => db.prepare(sql)
  const perTable = (make) => Object.fromEntries(FORMAL_TABLES.map((table) => [table, prepare(make(ROW_TABLES[table]))]))
  cached = {
    get: perTable((spec) => `SELECT ${columnList(spec)} FROM ${spec.sql} WHERE id = ?`),
    all: perTable((spec) => `SELECT ${columnList(spec)} FROM ${spec.sql} ORDER BY id`),
    revision: prepare('SELECT revision FROM store_meta WHERE singleton = 1'),
    dependents: prepare('SELECT from_table, from_id, field, to_table, to_id FROM refs WHERE to_table = ? AND to_id = ?'),
    allRefs: prepare('SELECT from_table, from_id, field, to_table, to_id FROM refs'),
    tombstoned: prepare('SELECT 1 AS found FROM tombstones WHERE table_name = ? AND id = ?'),
    allTombstones: prepare('SELECT table_name, id, deleted_at FROM tombstones ORDER BY table_name, id'),
    entry: prepare('SELECT id FROM entries WHERE entity_id = ? AND layer_id = ? AND source_id = ? AND record_id = ?'),
    systemKey: prepare('SELECT id FROM layers WHERE system_key = ?'),
    proposal: prepare('SELECT id FROM reviews WHERE proposal_id = ?'),
    viewItem: prepare('SELECT id FROM view_items WHERE scope = ? AND item_table = ? AND item_id = ?'),
    viewSetting: prepare('SELECT id FROM view_settings WHERE scope = ? AND setting_key = ?'),
    receipt: prepare('SELECT request_digest, response FROM receipts WHERE request_id = ?'),
    idMap: prepare('SELECT id FROM id_map WHERE kind = ? AND source_id = ? AND record_id = ?'),
    // 3C-4a: every view row of one scope, from the leading column of the unique (scope, …) indexes.
    scopeItems: prepare(`SELECT ${columnList(ROW_TABLES.viewItems)} FROM view_items WHERE scope = ? ORDER BY id`),
    scopeSettings: prepare(`SELECT ${columnList(ROW_TABLES.viewSettings)} FROM view_settings WHERE scope = ? ORDER BY id`),
  }
  statementCache.set(db, cached)
  return cached
}

const toRef = (row) => Object.freeze({ fromTable: row.from_table, fromId: row.from_id, field: row.field, toTable: row.to_table, toId: row.to_id })
const NO_REFS = Object.freeze([])
const strings = (values) => values.every((value) => typeof value === 'string')

/** The store-wide revision inside the current transaction. */
function currentRevision(db) {
  const row = statements(db).revision.get()
  if (!row) fail('E_STORE_SCHEMA', { path: 'store_meta' })
  return row.revision
}

/**
 * SqliteStoreReader: Core's StoreReader over the open transaction of `db`, synchronous, with
 * indexed queries only (no method returns a table). It stops working when the transaction ends
 * or `close` is called. Rows come back exactly as written (deep-frozen JSON values).
 *
 * Two reads beyond Core's interface, for the incremental write path of the new-library mode
 * (3C-4a; diffV2ToCommands, retired in 3C-5 E, and the media records): `viewScope(scope)` returns every view item and setting of one
 * scope (by id, from the scope indexes), and `idMapping(kind, sourceId, recordId)` looks up id_map.
 */
function transactionReader(db) {
  if (transactionState(db) !== true) fail('E_STORE_NO_TRANSACTION')
  const sql = statements(db)
  let open = true
  const live = () => { if (!open || transactionState(db) !== true) fail('E_STORE_READER_CLOSED') }
  const find = (statement, ...values) => {
    live()
    return strings(values) ? statement.get(...values)?.id : undefined
  }
  const reader = Object.freeze({
    revision: currentRevision(db),
    get(table, id) {
      live()
      if (!Object.hasOwn(ROW_TABLES, table) || typeof id !== 'string') return undefined
      const record = sql.get[table].get(id)
      return record ? deepFreeze(decodeRow(table, record)) : undefined
    },
    dependents(table, id) {
      live()
      if (!strings([table, id])) return NO_REFS
      const rows = sql.dependents.all(table, id)
      return rows.length ? Object.freeze(rows.map(toRef)) : NO_REFS
    },
    isTombstoned(table, id) {
      live()
      return strings([table, id]) && sql.tombstoned.get(table, id) !== undefined
    },
    findEntryByIdentity: (entityId, layerId, sourceId, recordId) => find(sql.entry, entityId, layerId, sourceId, recordId),
    findLayerBySystemKey: (systemKey) => find(sql.systemKey, systemKey),
    findReviewByProposal: (proposalId) => find(sql.proposal, proposalId),
    findViewItem: (scope, itemTable, itemId) => find(sql.viewItem, scope, itemTable, itemId),
    findViewSetting: (scope, key) => find(sql.viewSetting, scope, key),
    viewScope(scope) {
      live()
      if (typeof scope !== 'string') return Object.freeze({ items: NO_REFS, settings: NO_REFS })
      return Object.freeze({
        items: Object.freeze(sql.scopeItems.all(scope).map((record) => deepFreeze(decodeRow('viewItems', record)))),
        settings: Object.freeze(sql.scopeSettings.all(scope).map((record) => deepFreeze(decodeRow('viewSettings', record)))),
      })
    },
    idMapping: (kind, sourceId, recordId) => find(sql.idMap, kind, sourceId, recordId),
  })
  return { reader, close: () => { open = false } }
}

/**
 * Every row, tombstone and the revision as a FormalState value: plain, unfrozen objects decoded
 * from SQL (rows ordered by id, tombstones by table and id), not validated. readFormalState
 * validates and freezes it; readRowsUnchecked returns it as it is.
 */
function formalStateValue(db) {
  const sql = statements(db)
  const value = {
    revision: currentRevision(db),
    tombstones: sql.allTombstones.all().map((row) => ({ table: row.table_name, id: row.id, deletedAt: row.deleted_at })),
  }
  for (const table of FORMAL_TABLES) value[table] = sql.all[table].all().map((record) => decodeRow(table, record))
  return value
}

/**
 * `PRAGMA quick_check`: its problem lines, [] when the file is sound. Every run goes through
 * here, announced to the test hook as phase 'quick-check' (tests count the runs).
 */
function quickCheck(db, settings) {
  settings.phase?.('quick-check', { db })
  const lines = db.prepare('PRAGMA quick_check').all().map((row) => row.quick_check)
  return lines.length === 1 && lines[0] === 'ok' ? [] : lines
}
/** `PRAGMA integrity_check` (3C-3: after a restore), announced to the test hook as phase 'integrity-check'. */
function integrityCheck(db, settings) {
  settings.phase?.('integrity-check', { db })
  const lines = db.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check)
  return lines.length === 1 && lines[0] === 'ok' ? [] : lines
}
/** A failed quick_check as a problem: a count only, never the lines (they name pages and indexes). */
const quickCheckProblem = (lines) => `E_STORE_CORRUPT: quick_check (${lines.length})`
const QUICK_CHECK_PROBLEM = /^E_STORE_CORRUPT: quick_check /

/**
 * Full consistency check of one read transaction: quick_check, Core's full validation
 * (readFormalState), the stored index columns against the row bodies, the refs table against
 * referencesOf, foreign keys, and (3C-4c) the media registry against the rows
 * (./store-media-registry.mjs mediaRegistryProblems). Problems carry codes, tables and counts only.
 */
function checkConnection(db, settings, { media = true } = {}) {
  const problems = []
  const quick = quickCheck(db, settings)
  if (quick.length) problems.push(quickCheckProblem(quick))
  let state
  try { state = readFormalStateCore(formalStateValue(db), settings.policy) } catch (error) {
    problems.push(error?.path ? `${error.code}: ${error.path}` : error?.code ?? 'E_STORE_CHECK')
    return problems
  }
  const sql = statements(db)
  for (const table of FORMAL_TABLES) {
    const spec = ROW_TABLES[table]
    let mismatched = 0
    for (const record of sql.all[table].all()) {
      const values = encodeRow(table, decodeRow(table, record))
      const stored = [record.id, record.revision, ...spec.columns.map((column) => record[column.name])]
      if (stored.some((value, i) => value !== values[i])) mismatched++
    }
    if (mismatched) problems.push(`E_STORE_COLUMNS: ${table} (${mismatched})`)
  }
  const memory = memoryReader(state)
  const expected = new Set()
  for (const table of FORMAL_TABLES) for (const row of state[table]) for (const ref of referencesOf(table, row, memory)) expected.add(refKey(ref))
  let unexpected = 0
  for (const row of sql.allRefs.all()) if (!expected.delete(refKey(toRef(row)))) unexpected++
  if (expected.size || unexpected) problems.push(`E_STORE_REFS: ${expected.size} missing, ${unexpected} unexpected`)
  const violations = db.prepare('PRAGMA foreign_key_check').all().length
  if (violations) problems.push(`E_STORE_FOREIGN_KEY: ${violations}`)
  if (media) problems.push(...mediaRegistryProblems(db, state))
  return problems
}

// ---------------------------------------------------------------------------
// Requests, change-set execution and the three outcomes
// ---------------------------------------------------------------------------

const REQUEST_KEYS = Object.freeze(['requestId', 'baseRevision', 'kind', 'actor', 'commands'])
/** Optional request keys: `media`, the media registry changes of the request (3C-4c, ./store-media-registry.mjs). */
const OPTIONAL_REQUEST_KEYS = Object.freeze(['media'])
/** A receipt lists at most this many affected rows; a larger batch (a migration) keeps its counts only. */
export const RECEIPT_AFFECTED_LIMIT = 1000

/** Opaque, non-empty request metadata (kind, actor) of bounded length. */
function requestText(value, pathName, max) {
  opaqueId(value, pathName)
  if (value.length > max) reject('E_REQUEST', pathName)
}

/**
 * Validated, frozen copy of a request (design 3B §4.4). The commands are validated by the planner; a `media` block
 * (3C-4c) by its shape here and against the state when it is applied.
 */
function validRequest(request) {
  const valid = core(() => {
    validateJson(request, 'request')
    shape(request, [...REQUEST_KEYS, ...OPTIONAL_REQUEST_KEYS], REQUEST_KEYS, 'request')
    uuid(request.requestId, 'request.requestId')
    revision(request.baseRevision, 'request.baseRevision')
    requestText(request.kind, 'request.kind', 128)
    requestText(request.actor, 'request.actor', 256)
    if (!Array.isArray(request.commands)) reject('E_COMMAND', 'request.commands')
    return request
  }, 'not_committed')
  if (valid.media === undefined) return freezeCopy(valid)
  return freezeCopy({ ...valid, media: validMediaBlock(valid.media) })
}

/**
 * SHA-256 of this request only (kind, baseRevision, actor, commands, and the media block when there is one), canonical
 * JSON (Core jsonKey). Never a store hash. A request without a media block has exactly the digest it had before 3C-4c,
 * so receipts written earlier still answer their retries.
 */
export const requestDigest = (request) => createHash('sha256')
  .update(jsonKey({
    kind: request.kind, baseRevision: request.baseRevision, actor: request.actor, commands: request.commands,
    ...(request.media === undefined ? {} : { media: request.media }),
  }))
  .digest('hex')

/** Host timestamps in one canonical form (milliseconds, Z), so stored times order as strings. */
function hostTime(settings) {
  const value = settings.now()
  core(() => utcTimestamp(value, 'now'), 'not_committed')
  return new Date(Date.parse(value)).toISOString()
}

const placeholders = (count) => Array(count).fill('?').join(', ')
const writeCache = new WeakMap()
/** Prepared write statements of one connection. */
function writeStatements(db) {
  let cached = writeCache.get(db)
  if (cached) return cached
  const prepare = (sql) => db.prepare(sql)
  const perTable = (make) => Object.fromEntries(FORMAL_TABLES.map((table) => [table, prepare(make(ROW_TABLES[table]))]))
  cached = {
    insert: perTable((spec) => `INSERT INTO ${spec.sql} (${columnList(spec)}) VALUES (${placeholders(spec.columns.length + 3)})`),
    // Columns unchanged: rewrite only revision and body, so no index entry is touched.
    updateBody: perTable((spec) => `UPDATE ${spec.sql} SET revision = ?, body = ? WHERE id = ?`),
    updateAll: perTable((spec) => `UPDATE ${spec.sql} SET ${['revision', ...spec.columns.map((column) => column.name), 'body'].map((name) => `${name} = ?`).join(', ')} WHERE id = ?`),
    remove: perTable((spec) => `DELETE FROM ${spec.sql} WHERE id = ?`),
    stored: perTable((spec) => `SELECT ${['id', ...spec.columns.map((column) => column.name)].join(', ')} FROM ${spec.sql} WHERE id = ?`),
    refAdd: prepare('INSERT INTO refs (from_table, from_id, field, to_table, to_id) VALUES (?, ?, ?, ?, ?)'),
    refRemove: prepare('DELETE FROM refs WHERE from_table = ? AND from_id = ? AND field = ? AND to_table = ? AND to_id = ?'),
    tombstone: prepare('INSERT INTO tombstones (table_name, id, deleted_at) VALUES (?, ?, ?)'),
    revision: prepare('UPDATE store_meta SET revision = ? WHERE singleton = 1 AND revision = ?'),
    receiptAdd: prepare('INSERT INTO receipts (request_id, request_digest, status, revision_after, response, at) VALUES (?, ?, ?, ?, ?, ?)'),
    idMapAdd: prepare('INSERT INTO id_map (kind, source_id, record_id, id) VALUES (?, ?, ?, ?)'),
    opLogAdd: prepare('INSERT INTO op_log (request_id, at, actor, kind, summary) VALUES (?, ?, ?, ?, ?)'),
  }
  writeCache.set(db, cached)
  return cached
}
const inconsistent = (pathName) => fail('E_STORE_INCONSISTENT', { path: pathName })

/**
 * Execute a planned change set inside the open write transaction: every delete first, then
 * every write (the ChangeSet contract), with foreign keys checked at COMMIT. SQLite checks
 * UNIQUE per statement, so a row whose unique key changes is moved out before the writes:
 * two rows swapping unique keys in one batch never meet a value the batch is about to vacate.
 * An update whose indexed columns are unchanged rewrites only revision and body.
 */
function executeChangeSet(db, changeSet, phase) {
  const sql = writeStatements(db)
  for (const { table, id } of changeSet.deletes) if (sql.remove[table].run(id).changes !== 1) inconsistent(table)
  phase('deleted')
  const writes = changeSet.upserts.map(({ table, row }) => {
    const spec = ROW_TABLES[table], values = encodeRow(table, row)
    const stored = sql.stored[table].get(values[0])
    const changed = (names) => names.some((name) => stored[name] !== values[2 + spec.columns.findIndex((column) => column.name === name)])
    return {
      table, values, stored: stored !== undefined,
      columnsChanged: stored !== undefined && changed(spec.columns.map((column) => column.name)),
      moved: stored !== undefined && spec.unique !== undefined && changed(spec.unique),
    }
  })
  for (const { table, values, moved } of writes) if (moved) sql.remove[table].run(values[0])
  for (const { table, values, stored, columnsChanged, moved } of writes) {
    const [id, revision] = values, body = values.at(-1)
    if (!stored || moved) sql.insert[table].run(...values)
    else if (columnsChanged) sql.updateAll[table].run(...values.slice(1), id)
    else sql.updateBody[table].run(revision, body, id)
  }
  phase('written')
  for (const ref of changeSet.refsRemoved) {
    if (sql.refRemove.run(ref.fromTable, ref.fromId, ref.field, ref.toTable, ref.toId).changes !== 1) inconsistent('refs')
  }
  for (const ref of changeSet.refsAdded) sql.refAdd.run(ref.fromTable, ref.fromId, ref.field, ref.toTable, ref.toId)
  for (const tombstone of changeSet.tombstones) sql.tombstone.run(tombstone.table, tombstone.id, tombstone.deletedAt)
}

/**
 * The original receipt: status committed, the revision after, counts and (bounded) affected rows; with a media block,
 * also its operation counts (`media`).
 */
function receiptFor(request, changeSet, at, mediaCounts) {
  const counts = Object.fromEntries(Object.entries(changeSet.summary.counts)
    .filter(([, count]) => count.created || count.updated || count.removed))
  const affected = [
    ...changeSet.upserts.map(({ table, row }) => ({ table, id: row.id, change: 'written' })),
    ...changeSet.deletes.map(({ table, id }) => ({ table, id, change: 'removed' })),
  ]
  return {
    status: 'committed', requestId: request.requestId, kind: request.kind, baseRevision: request.baseRevision,
    revision: changeSet.nextRevision, at, counts,
    ...(affected.length <= RECEIPT_AFFECTED_LIMIT ? { affected } : { affectedOmitted: affected.length }),
    ...(mediaCounts === undefined ? {} : { media: mediaCounts }),
  }
}

/**
 * Plan and execute one validated request inside an open BEGIN IMMEDIATE transaction: revision
 * check, planCommands over the transaction's reader, the change set, the store revision, the
 * media block (3C-4c: the registry rows, in the same transaction), the receipt and the op_log
 * summary. Returns the receipt. Shared by commit, createStore and upgradeStoreFile.
 *
 * A request without commands changes no row and keeps the revision; with a media block it still
 * writes the registry, the receipt and the op_log entry (a scan that only moved sources).
 */
function applyRequest(db, request, digest, at, settings, phase) {
  if (currentRevision(db) !== request.baseRevision) fail('E_STALE', { path: 'request.baseRevision' })
  let changeSet
  if (request.commands.length === 0 && request.media !== undefined) {
    // Core plans only non-empty batches; a registry-only request changes no row.
    changeSet = { baseRevision: request.baseRevision, nextRevision: request.baseRevision, upserts: [], deletes: [], tombstones: [], refsAdded: [], refsRemoved: [], summary: { counts: {} } }
  } else {
    const { reader, close } = transactionReader(db)
    try {
      changeSet = core(() => planCommands(reader, request.commands, { baseRevision: request.baseRevision, now: at, policy: settings.policy }), 'not_committed')
    } finally { close() }
  }
  executeChangeSet(db, changeSet, phase)
  const sql = writeStatements(db)
  if (changeSet.nextRevision !== request.baseRevision && sql.revision.run(changeSet.nextRevision, request.baseRevision).changes !== 1) inconsistent('store_meta')
  const mediaCounts = request.media === undefined
    ? undefined
    : applyMediaBlock(db, request.media, { requestId: request.requestId, at, deletes: changeSet.deletes })
  checkWrittenAssets(db, changeSet.upserts)
  if (mediaCounts !== undefined) phase('media')
  const receipt = receiptFor(request, changeSet, at, mediaCounts)
  sql.receiptAdd.run(request.requestId, digest, 'committed', changeSet.nextRevision, JSON.stringify(receipt), at)
  sql.opLogAdd.run(request.requestId, at, request.actor, request.kind,
    JSON.stringify({
      baseRevision: request.baseRevision, revision: changeSet.nextRevision, counts: receipt.counts,
      ...(mediaCounts === undefined ? {} : { media: mediaCounts }),
    }))
  // 3C-5B: the rows this request changed (the planner's change set without its tombstones and references), for a
  // caller that keeps a read model up to date (applyReadModelDelta). Never stored: the receipt stays as it was.
  const changes = { baseRevision: changeSet.baseRevision, nextRevision: changeSet.nextRevision, upserts: changeSet.upserts, deletes: changeSet.deletes }
  return { receipt: deepFreeze(receipt), changes: deepFreeze(changes) }
}

/** A failure with what happened to the request: confirmed not committed, or unknown. */
function withOutcome(error, outcome) {
  if (error instanceof StoreError) return new StoreHostError(error.code, { path: error.path, outcome })
  return storeErrorFrom(error, outcome)
}
function outcomeUnknown(error) {
  return new StoreHostError('E_OUTCOME_UNKNOWN', {
    outcome: 'unknown',
    sqlite: sqliteDetail(error),
    cause: error,
    message: 'E_OUTCOME_UNKNOWN: COMMIT failed and whether it took effect cannot be determined. '
      + 'Call lookup(requestId) with the same requestId, or retry with the same requestId; never retry with a new id.',
  })
}

/**
 * The three outcomes (design 3B §4.5) after a failure inside a write transaction:
 * - COMMIT never issued: not committed, whatever the error (an open transaction is rolled back);
 * - COMMIT failed and the transaction is still open (`isTransaction`): SQLite did not commit it
 *   (busy, deferred foreign key, …); roll it back, confirmed not committed with the original code;
 * - COMMIT failed and the transaction is gone, or its state cannot be read: unknown. Disk-full and
 *   I/O errors follow the same rule and are never reported as rolled back by assumption.
 * `discard` closes the connection when a rollback fails: closing discards an open transaction.
 * Exported for tests.
 */
export function settleFailure(db, error, commitIssued, discard = () => {}) {
  const state = transactionState(db)
  if (state === true) {
    let rolledBack = false
    try { db.exec('ROLLBACK'); rolledBack = transactionState(db) === false } catch { /* Handled below. */ }
    if (!rolledBack) discard()
    return withOutcome(error, 'not_committed')
  }
  if (!commitIssued) return withOutcome(error, 'not_committed')
  return outcomeUnknown(error)
}

/** A stored receipt (original response JSON), frozen. */
function parseReceipt(text) {
  try { return deepFreeze(JSON.parse(text)) } catch { return fail('E_STORE_CORRUPT', { path: 'receipts.response' }) }
}

// ---------------------------------------------------------------------------
// Retention and the identity map
// ---------------------------------------------------------------------------

/**
 * Record retention (design 3B §4.6 as revised by v1.1 §16.2-6), `days` and `count` per table:
 * - receipts keep retries safe, so the rule keeping MORE wins: a receipt goes only when it is both
 *   older than 30 days and outside the newest 10,000;
 * - op_log is diagnostics only, so the rule keeping FEWER wins: a row goes when it is older than a
 *   year or outside the newest 50,000.
 */
export const RETENTION = Object.freeze({
  receipts: Object.freeze({ days: 30, count: 10_000 }),
  opLog: Object.freeze({ days: 365, count: 50_000 }),
})
/** Free pages returned to the file system per incremental_vacuum step after pruning (4 MiB at the default 4 KiB page size). */
export const VACUUM_PAGES = 1024
const DAY_MS = 86_400_000
const cutoff = (now, days) => new Date(Date.parse(now) - days * DAY_MS).toISOString()

function validRetention(retention) {
  const limit = (value, name) => {
    if (value === null || typeof value !== 'object' || !Number.isFinite(value.days) || value.days < 0
      || !Number.isSafeInteger(value.count) || value.count < 1) fail('E_STORE_OPTIONS', { path: `retention.${name}` })
    return { days: value.days, count: value.count }
  }
  return { receipts: limit(retention?.receipts, 'receipts'), opLog: limit(retention?.opLog, 'opLog') }
}

const pruneCache = new WeakMap()
function pruneStatements(db) {
  let cached = pruneCache.get(db)
  if (cached) return cached
  cached = {
    // The newest `count`-th receipt (OFFSET count - 1); anything older is outside the newest `count`.
    receiptBoundary: db.prepare('SELECT at, rowid AS position FROM receipts ORDER BY at DESC, rowid DESC LIMIT 1 OFFSET ?'),
    receiptPrune: db.prepare('DELETE FROM receipts WHERE rowid IN (SELECT rowid FROM receipts WHERE at < ? '
      + 'AND (at < ? OR (at = ? AND rowid < ?)) ORDER BY at, rowid LIMIT ?)'),
    opLogBoundary: db.prepare('SELECT seq FROM op_log ORDER BY seq DESC LIMIT 1 OFFSET ?'),
    // Outside the newest `count` (seq below the boundary) OR older than the cutoff.
    opLogPrune: db.prepare('DELETE FROM op_log WHERE seq IN (SELECT seq FROM op_log WHERE seq < ? OR at < ? ORDER BY seq LIMIT ?)'),
  }
  pruneCache.set(db, cached)
  return cached
}

/** One small pruning step inside an open write transaction: at most `batchSize` rows per table. */
function pruneStep(db, cutoffs, limits, batchSize) {
  const sql = pruneStatements(db)
  const receipt = sql.receiptBoundary.get(limits.receipts.count - 1)
  const receipts = receipt ? sql.receiptPrune.run(cutoffs.receipts, receipt.at, receipt.at, receipt.position, batchSize).changes : 0
  // With fewer rows than `count` nothing is outside the newest `count` (seq starts at 1): only the age rule applies.
  const entry = sql.opLogBoundary.get(limits.opLog.count - 1)
  const opLog = sql.opLogPrune.run(entry?.seq ?? 0, cutoffs.opLog, batchSize).changes
  return { receipts, opLog }
}

/**
 * One incremental_vacuum step inside an open write transaction (auto_vacuum = INCREMENTAL): moves
 * at most `pages` free pages to the end of the file and truncates them. Returns the pages freed.
 */
function vacuumStep(db, pages) {
  const before = pragmaValue(db, 'freelist_count')
  if (before === 0) return 0
  // exec runs the pragma to its end (each step of a prepared statement frees only one page).
  db.exec(`PRAGMA incremental_vacuum(${pages})`)
  return before - pragmaValue(db, 'freelist_count')
}

const MAPPING_KEYS = Object.freeze(['kind', 'sourceId', 'recordId', 'id'])
function validMappings(mappings) {
  return core(() => {
    validateJson(mappings, 'mappings')
    if (!Array.isArray(mappings) || mappings.length === 0) reject('E_ID_MAP', 'mappings')
    for (const mapping of mappings) {
      shape(mapping, MAPPING_KEYS, MAPPING_KEYS, 'mappings')
      for (const key of MAPPING_KEYS) opaqueId(mapping[key], `mappings.${key}`)
    }
    return freezeCopy(mappings)
  }, 'not_committed')
}

// ---------------------------------------------------------------------------
// Open checks and handles
// ---------------------------------------------------------------------------

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

/** A SQLite failure met while opening as a diagnostic. A busy store is not damaged: it is thrown for the caller to retry. */
function openFailure(error) {
  const failure = storeErrorFrom(error)
  if (failure.code === 'E_STORE_BUSY') throw failure
  return { code: failure.code === 'E_STORE_SQLITE' ? 'E_STORE_CORRUPT' : failure.code, detail: failure.sqlite }
}

/**
 * The format checks of an open store for `version` (the current one, or the version upgradeStoreFile upgrades from): the
 * schema (the DDL rows and auto_vacuum) and store_meta. A diagnostic or undefined.
 */
function formatDiagnostic(db, version) {
  if (JSON.stringify(db.prepare(SCHEMA_QUERY).all().map((row) => ({ ...row }))) !== expectedSchema(version)) return { code: 'E_STORE_SCHEMA' }
  if (pragmaValue(db, 'auto_vacuum') !== STORE_AUTO_VACUUM) return { code: 'E_STORE_SCHEMA', detail: { pragma: 'auto_vacuum' } }
  const meta = db.prepare('SELECT format, format_version FROM store_meta WHERE singleton = 1').get()
  if (meta?.format !== STORE_FORMAT || meta.format_version !== version) return { code: 'E_STORE_SCHEMA', detail: { table: 'store_meta' } }
  if (version >= 4 && definitionsVersionOf(db) === undefined) return { code: 'E_STORE_SCHEMA', detail: { table: 'store_definitions' } }
  return undefined
}

/**
 * The version of the official definitions a store records (3C-5 G): its `store_definitions` row; 1 for a store of an
 * older format (every store before format 4 has version 1); undefined when a format-4 store lacks the row.
 */
function definitionsVersionOf(db, formatVersion = 4) {
  if (formatVersion < 4) return 1
  const row = db.prepare('SELECT version FROM store_definitions WHERE singleton = 1').get()
  return Number.isSafeInteger(row?.version) && row.version >= 1 ? row.version : undefined
}

/**
 * 3C-5 G: the store's definitions version against the code's (`expected`): older is E_STORE_UPGRADE_REQUIRED, newer
 * E_STORE_TOO_NEW (code that predates them), both with `detail.definitions`. Undefined when they are equal.
 */
function definitionsDiagnostic(db, expected) {
  const definitions = definitionsVersionOf(db)
  if (definitions === undefined) return { code: 'E_STORE_SCHEMA', detail: { table: 'store_definitions' } }
  if (definitions < expected) return { code: 'E_STORE_UPGRADE_REQUIRED', detail: { definitions } }
  if (definitions > expected) return { code: 'E_STORE_TOO_NEW', detail: { definitions } }
  return undefined
}

/**
 * The open checks (design 3B §4.3, v1.1 §16.2-3), all of them cheap: application_id,
 * user_version (newer is E_STORE_TOO_NEW; an older one with an entry in MIGRATIONS is
 * E_STORE_UPGRADE_REQUIRED, any other E_STORE_VERSION), schema (the DDL rows and auto_vacuum)
 * and store_meta. No quick_check here: it runs only after an unclean shutdown (startSession), and
 * on request (checkIntegrity). Returns undefined when the store is usable, otherwise a diagnostic
 * { code, detail? }. Never repairs or upgrades anything: an older store stays as it is until
 * `npm run store:upgrade` (upgradeStoreFile).
 */
function openDiagnostic(db, settings) {
  try {
    if (pragmaValue(db, 'application_id') !== STORE_APPLICATION_ID) return { code: 'E_STORE_APPLICATION_ID' }
    const version = pragmaValue(db, 'user_version')
    if (version > STORE_FORMAT_VERSION) return { code: 'E_STORE_TOO_NEW', detail: { version } }
    if (version < STORE_FORMAT_VERSION) {
      return Object.hasOwn(MIGRATIONS, version)
        ? { code: 'E_STORE_UPGRADE_REQUIRED', detail: { version } }
        : { code: 'E_STORE_VERSION', detail: { version } }
    }
    return formatDiagnostic(db, STORE_FORMAT_VERSION) ?? definitionsDiagnostic(db, settings.definitionsVersion)
  } catch (error) {
    return openFailure(error)
  }
}

/** Set store_meta.clean_shutdown in its own small write transaction. */
function setCleanShutdown(db, value) {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('UPDATE store_meta SET clean_shutdown = ? WHERE singleton = 1').run(value)
    db.exec('COMMIT')
  } catch (error) {
    if (transactionState(db) === true) { try { db.exec('ROLLBACK') } catch { /* Closing releases it. */ } }
    throw error
  }
}

/**
 * Start a writer session on a store that passed the open checks (design 3B v1.1 §16.2-3).
 * clean_shutdown 0 means its last writer session never reached close() (killed, crashed, or still
 * open in another process): quick_check runs first, and a failure is a diagnostic (read-only,
 * never repaired). Otherwise the flag is set to 0 for this session; close() sets it back to 1.
 * Returns a diagnostic or undefined; a busy store throws E_STORE_BUSY.
 */
function startSession(db, settings, timings) {
  try {
    const clean = db.prepare('SELECT clean_shutdown FROM store_meta WHERE singleton = 1').get().clean_shutdown === 1
    if (clean) {
      setCleanShutdown(db, 0)
      return undefined
    }
    const started = performance.now()
    const problems = quickCheck(db, settings)
    timings.quickCheckMs = performance.now() - started
    return problems.length ? { code: 'E_STORE_CORRUPT', detail: { problems: problems.length } } : undefined
  } catch (error) {
    return openFailure(error)
  }
}

/**
 * How the host coordinates with the library operation lock (design 3B §5.2 as revised by v1.1
 * §16.2-1). The lock (scripts/library-operation-lock.mjs) belongs to operations that span more
 * than the store file: createStore and `npm run library:recover` take it here; migration, backup
 * and restore (3C-3) and media import and deletion (3C-4) will take it too. Ordinary writes
 * (commit, pruneLogs, putIdMappings) take no lease: SQLite's BEGIN IMMEDIATE keeps writers apart,
 * and before it they only check that nobody else holds the lock (libraryLockProbe), passing the
 * caller's `leaseToken` when the caller holds it.
 *
 * - `privatePaths`: `lease` runs a callback under withLibraryOperation; `check(leaseToken)` is the
 *   pre-write probe, resolved on first use (the private root's real path, once per handle).
 * - `lock` (tests and benchmarks: withoutLibraryLock): `lease` is that runner and nothing is probed.
 */
function resolveLibrary({ lock, privatePaths }) {
  if (lock !== undefined) {
    if (typeof lock !== 'function') fail('E_STORE_OPTIONS', { path: 'lock' })
    return Object.freeze({ lease: lock, check: () => {} })
  }
  if (typeof privatePaths?.root !== 'string') fail('E_STORE_LOCK_REQUIRED', { path: 'privatePaths' })
  let probe
  return Object.freeze({
    lease: (callback) => withLibraryOperation(privatePaths, () => callback()),
    check(leaseToken) {
      if (!probe) {
        try { probe = libraryLockProbe(privatePaths) } catch (error) {
          throw new StoreHostError(missing(error) ? 'E_STORE_PATH' : 'E_STORE_LOCK', { path: 'privatePaths.root', outcome: 'not_committed', cause: error })
        }
      }
      try { probe.check(leaseToken) } catch (error) {
        const code = typeof error?.code === 'string' && /^E_[A-Z0-9_]+$/.test(error.code) ? error.code : 'E_STORE_LOCK'
        throw new StoreHostError(code, { outcome: 'not_committed', cause: error })
      }
    },
  })
}

/** For tests and benchmarks only: no library coordination (createStore runs without the lease, writes are not probed). */
export const withoutLibraryLock = (callback) => callback()

/** The options of an ordinary write: `{ leaseToken }` when the caller holds the library lease. */
function writeOptions(options) {
  if (options === undefined) return undefined
  if (options === null || typeof options !== 'object' || Object.keys(options).some((key) => key !== 'leaseToken')
    || (options.leaseToken !== undefined && typeof options.leaseToken !== 'string')) fail('E_STORE_OPTIONS', { path: 'leaseToken', outcome: 'not_committed' })
  return options.leaseToken
}

function hostOptions(options) {
  const now = options.now ?? (() => new Date().toISOString())
  if (typeof now !== 'function') fail('E_STORE_OPTIONS', { path: 'now' })
  // 3C-5 G: the official definitions version the store must have (tests set another one to play older or newer code).
  const definitionsVersion = options.definitionsVersion ?? OFFICIAL_DEFINITIONS_VERSION
  if (!Number.isSafeInteger(definitionsVersion) || definitionsVersion < 1) fail('E_STORE_OPTIONS', { path: 'definitionsVersion' })
  return { now, policy: options.policy ?? {}, phase: options.unsafeTestPhase, definitionsVersion }
}

/**
 * Open an existing store. With failed open checks the store opens read-only and the handle
 * carries `diagnostic` ({ code }): writes are refused with that code and nothing is repaired.
 * A writable open starts a writer session (clean_shutdown, see startSession); `close()` ends it.
 *
 * Options: `privatePaths` (ordinary writes check the library operation lock under it, see
 * resolveLibrary) or `lock: withoutLibraryLock` (tests and benchmarks: no coordination), `now`,
 * `policy` (StorePolicy for planning and full validation), `readOnly`, and `writerSession: false`
 * (3C-4c: a writable open for a command-line tool such as media:import, which may run while a dev
 * server has the store open: it neither reads nor writes clean_shutdown, so the server's flag stays
 * its own; SQLite still rolls back a hot journal).
 */
export function openStore(file, options = {}) {
  const { writerSession = true, ...rest } = options
  if (typeof writerSession !== 'boolean') fail('E_STORE_OPTIONS', { path: 'writerSession' })
  return openHandle(file, rest, { session: writerSession })
}

/**
 * `session: false` opens an inspection (library:recover's check): writable, so that SQLite rolls
 * back a hot journal, but clean_shutdown is neither read nor written and quick_check is left to
 * the caller's full check.
 */
function openHandle(file, options, { session }) {
  const target = absoluteFile(file)
  existingFile(target)
  const settings = hostOptions(options)
  if (options.readOnly === true) return readOnlyHandle(target, settings, undefined)
  const library = resolveLibrary(options)
  const key = writerKey(target)
  if (writers.has(key)) fail('E_STORE_ALREADY_OPEN', { path: 'file' })
  // A writable connection rolls back a hot journal left by a crashed writer (SQLite's own recovery).
  const started = performance.now()
  const db = openConnection(target)
  const timings = { connectMs: performance.now() - started }
  let diagnostic
  try {
    diagnostic = openDiagnostic(db, settings)
    if (!diagnostic && session) diagnostic = startSession(db, settings, timings)
  } catch (error) { closeQuietly(db); throw error }
  timings.openMs = performance.now() - started
  if (diagnostic) {
    closeQuietly(db)
    return readOnlyHandle(target, settings, diagnostic)
  }
  return writableHandle(db, target, key, library, settings, timings, session)
}

/**
 * Read-only handle: explicit read-only opens and stores that failed an open check. An explicit
 * read-only open runs the cheap open checks only, whatever clean_shutdown says (it may belong to a
 * writer that is open right now); callers that need more call checkIntegrity().
 */
function readOnlyHandle(file, settings, diagnostic) {
  let db
  let failure = diagnostic
  try {
    db = openConnection(file, { readOnly: true })
    failure ??= openDiagnostic(db, settings)
  } catch (error) {
    closeQuietly(db)
    db = undefined
    failure ??= { code: storeErrorFrom(error).code }
  }
  // Reading is attempted only where the format is ours and understood.
  const readable = db !== undefined && (failure === undefined || failure.code === 'E_STORE_CORRUPT')
  return makeHandle({ db: readable ? db : (closeQuietly(db), undefined), file, settings, diagnostic: failure, writable: false })
}

function writableHandle(db, file, key, library, settings, timings, session) {
  writers.add(key)
  return makeHandle({ db, file, settings, writable: true, library, timings, session, release: () => writers.delete(key) })
}

/** SQLITE_CORRUPT or SQLITE_NOTADB behind a host error (also inside E_OUTCOME_UNKNOWN). */
const isSqliteCorruption = (error) => [11, 26].includes((error?.sqlite?.errcode ?? 0) & 0xff)

function makeHandle({ db, file, settings, diagnostic, writable, library, timings, session = false, release }) {
  let closed = false
  let lost = false
  let tail = Promise.resolve()
  /**
   * Corruption found while running (design 3B v1.1 §16.2-3): the handle turns read-only with
   * E_STORE_CORRUPT and stays that way until it is closed. Nothing is repaired, and the writer
   * session is not marked clean, so the next open runs quick_check.
   */
  const becomeCorrupt = (detail) => {
    writable = false
    diagnostic ??= Object.freeze({ code: 'E_STORE_CORRUPT', ...(detail === undefined ? {} : { detail }) })
  }
  const corruptionSeen = (error) => {
    if (isSqliteCorruption(error)) becomeCorrupt(error.sqlite)
    return error
  }
  /** After a failed rollback the connection is closed (which discards its transaction): reopen. */
  const discard = () => { lost = true; closeQuietly(db) }
  const usable = () => {
    if (closed) fail('E_STORE_CLOSED')
    if (lost) fail('E_STORE_REOPEN_REQUIRED')
    if (!db) fail(diagnostic?.code ?? 'E_STORE_CLOSED')
    return db
  }
  /** Writes refuse on a read-only handle with the open diagnostic's code. */
  const writer = () => {
    if (closed) fail('E_STORE_CLOSED', { outcome: 'not_committed' })
    if (!writable) fail(diagnostic?.code ?? 'E_STORE_READONLY', { outcome: 'not_committed' })
    if (lost) fail('E_STORE_REOPEN_REQUIRED', { outcome: 'not_committed' })
    return db
  }
  /** Writes in this process run one at a time. Other processes are kept apart by BEGIN IMMEDIATE. */
  const enqueue = (work) => {
    const run = tail.then(work, work)
    tail = run.catch(() => {})
    return run
  }
  /**
   * Test-only fault injection: `unsafeTestPhase(name, { db })` runs synchronously at each write
   * phase (and, outside this function, before every quick_check as 'quick-check').
   */
  const phase = (name, connection) => {
    const result = settings.phase?.(name, { db: connection })
    if (result && typeof result.then === 'function') fail('E_STORE_ASYNC_HOOK')
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
      throw corruptionSeen(storeErrorFrom(error))
    } finally {
      if (transactionState(connection) === true) {
        try { connection.exec('ROLLBACK') } catch { /* Released on close. */ }
      }
    }
  }
  /**
   * Design 3B §4.4 with v1.1 §16.2-1: the library lock check (no lease), BEGIN IMMEDIATE (a
   * writer in another process makes it E_STORE_BUSY after the short busy timeout, never a queue),
   * receipt check, revision check, plan and execute, COMMIT; failures settled into the three outcomes.
   */
  const runCommit = (request, digest, leaseToken) => {
    const connection = writer()
    const hook = (name) => phase(name, connection)
    let commitIssued = false
    let result
    try {
      library.check(leaseToken)
      hook('probed')
      if (transactionState(connection) !== false) fail('E_STORE_BUSY')
      connection.exec('BEGIN IMMEDIATE')
      hook('begun')
      const previous = statements(connection).receipt.get(request.requestId)
      if (previous) {
        if (previous.request_digest !== digest) fail('E_OPERATION_CONFLICT', { path: 'request.requestId' })
        const receipt = parseReceipt(previous.response)
        connection.exec('ROLLBACK')
        return Object.freeze({ status: 'duplicate', revision: receipt.revision, receipt })
      }
      const { receipt, changes } = applyRequest(connection, request, digest, hostTime(settings), settings, hook)
      hook('before-commit')
      commitIssued = true
      connection.exec('COMMIT')
      result = Object.freeze({ status: 'committed', revision: receipt.revision, receipt, changes })
    } catch (error) {
      throw corruptionSeen(settleFailure(connection, error, commitIssued, discard))
    }
    hook('committed')
    return result
  }
  /** One small write transaction outside commit (pruning steps, identity map), after the same library lock check. */
  const smallWrite = (work, leaseToken) => {
    const connection = writer()
    let commitIssued = false
    try {
      library.check(leaseToken)
      if (transactionState(connection) !== false) fail('E_STORE_BUSY')
      connection.exec('BEGIN IMMEDIATE')
      const result = work(connection)
      commitIssued = true
      connection.exec('COMMIT')
      return result
    } catch (error) {
      throw corruptionSeen(settleFailure(connection, error, commitIssued, discard))
    }
  }
  const handle = {
    file,
    get readOnly() { return !writable },
    get diagnostic() { return diagnostic },
    /** Open timings in milliseconds (connectMs, openMs, and quickCheckMs when the open ran quick_check), for benchmarks. */
    get openTimings() { return timings },
    /**
     * store_meta as an object: format, formatVersion, definitionsVersion (3C-5 G, store_definitions), libraryId, revision,
     * createdAt, and restoredFrom (the JSON value setRestoredFrom wrote) when the store was restored from a backup.
     */
    meta() {
      return readTransaction((connection) => {
        const row = connection.prepare('SELECT format, format_version, library_id, revision, created_at, restored_from FROM store_meta WHERE singleton = 1').get()
        if (!row) fail('E_STORE_SCHEMA', { path: 'store_meta' })
        let restoredFrom
        if (row.restored_from !== null) {
          try { restoredFrom = deepFreeze(JSON.parse(row.restored_from)) } catch { fail('E_STORE_CORRUPT', { path: 'store_meta.restored_from' }) }
        }
        return Object.freeze({
          format: row.format, formatVersion: row.format_version, definitionsVersion: definitionsVersionOf(connection, row.format_version),
          libraryId: row.library_id, revision: row.revision, createdAt: row.created_at, ...(restoredFrom === undefined ? {} : { restoredFrom }),
        })
      })
    },
    /**
     * Row counts of every table (formal tables by Core name, host tables by SQL name), in one read transaction: the
     * backup manifest records them.
     */
    tableCounts() {
      return readTransaction((connection) => {
        const counts = {}
        for (const table of FORMAL_TABLES) counts[table] = connection.prepare(`SELECT count(*) AS count FROM ${ROW_TABLES[table].sql}`).get().count
        for (const table of HOST_TABLES) counts[table] = connection.prepare(`SELECT count(*) AS count FROM ${table}`).get().count
        return Object.freeze(counts)
      })
    },
    /**
     * A consistent copy of the whole store at `target` with `VACUUM INTO` (design 3B §5.2, backups): compacted, with the
     * same header (application_id, user_version, auto_vacuum). `target` must be an absolute path that does not exist.
     * Read-only handles can do it too. Callers hold the library lease, so no other writer starts meanwhile.
     */
    snapshotInto(target) {
      const file = absoluteFile(target)
      const connection = usable()
      if (transactionState(connection) !== false) fail('E_STORE_BUSY')
      try { lstatSync(file); fail('E_STORE_EXISTS', { path: 'target' }) } catch (error) { if (!missing(error)) throw error }
      try { connection.prepare('VACUUM INTO ?').run(file) } catch (error) { throw corruptionSeen(storeErrorFrom(error)) }
    },
    /** Run `callback(reader)` with a SqliteStoreReader bound to one read transaction (synchronous). */
    read(callback) {
      return readTransaction((connection) => {
        const { reader, close } = transactionReader(connection)
        try { return callback(reader) } finally { close() }
      })
    },
    /**
     * The media registry (3C-4c) and the store revision from one read transaction: `{ revision, files, assetFiles,
     * sources, scanCache, pendingFileOps }`, plain objects (./store-media-registry.mjs mediaRegistrySnapshot).
     */
    mediaRegistry() {
      return readTransaction((connection) => ({ revision: currentRevision(connection), ...mediaRegistrySnapshot(connection) }))
    },
    /** The `starmap:media` entities `{ id, typeId, fields }` (3C-4c: the records the scan is compared with), one read transaction. */
    mediaEntities() {
      return readTransaction((connection) => mediaEntitiesOf(connection))
    },
    /**
     * Settle pending file operations (3C-4c, ./media-file-ops.mjs): remove the rows `seqs` and the media_files rows of
     * `files` that nothing links any more, in one small write (no revision change). The caller holds the library lease
     * and passes `{ leaseToken }`. Resolves { settled, filesRemoved }.
     */
    async settleFileOps(work, options) {
      writer()
      const leaseToken = writeOptions(options)
      return enqueue(() => smallWrite((connection) => settleFileOperations(connection, work), leaseToken))
    },
    /**
     * Every row as a FormalState, through Core's full validation (readFormalState) and deep
     * frozen. For migration, restore, export, the check command and tests; neither the write path
     * nor the start-up read model calls it.
     */
    readFormalState() {
      return readTransaction((connection) => core(() => readFormalStateCore(formalStateValue(connection), settings.policy)))
    },
    /**
     * Every row, tombstone and the revision in one read transaction, as a plain object shaped like
     * FormalState, WITHOUT any validation (design 3B v1.1 §16.2-4): each row was checked by the
     * planner before it was committed, so the start-up read model decodes the rows straight from
     * SQL. No readFormalState, validateJson or freezeCopy, and nothing is frozen: callers (the
     * projections) must not modify the result. Same rows and order as readFormalState().
     */
    readRowsUnchecked() {
      return readTransaction((connection) => formalStateValue(connection))
    },
    /**
     * The read model `starmap.read-model` (3C-5A; Core ../src/worldgraph/readModel/): the rows of readRowsUnchecked and
     * their revision in one read transaction, with the header (`origin` 'local' unless given). Unvalidated like
     * readRowsUnchecked: callers must not modify it. Tombstones, review receipts and the host's own tables (receipts,
     * op_log, id_map, pending_file_ops, the media registry with its Inbox paths and hashes) are never in it.
     */
    readModel({ origin = 'local' } = {}) {
      return readTransaction((connection) => readModelOf(formalStateValue(connection), { origin }))
    },
    /**
     * Full consistency check (recovery, the check command, tests): quick_check plus Core's full
     * validation and the host's own tables. { ok, problems }, codes and counts only. A failed
     * quick_check turns the handle read-only, like checkIntegrity.
     */
    check() {
      const problems = readTransaction((connection) => checkConnection(connection, settings))
      if (problems.some((problem) => QUICK_CHECK_PROBLEM.test(problem))) becomeCorrupt()
      return Object.freeze({ ok: problems.length === 0, problems: Object.freeze(problems) })
    },
    /**
     * `PRAGMA quick_check` on request (design 3B v1.1 §16.2-3): before a backup, after a restore,
     * and for the check command; opening runs it only after an unclean shutdown. With `{ full: true }`
     * it runs the slower `PRAGMA integrity_check` instead (3C-3: a restored store). Returns
     * { ok, problems } (counts only); a failure turns the handle read-only with E_STORE_CORRUPT.
     */
    checkIntegrity({ full = false } = {}) {
      let lines
      try { lines = readTransaction((connection) => (full ? integrityCheck : quickCheck)(connection, settings)) } catch (error) {
        if (!isSqliteCorruption(error)) throw error
        lines = ['unreadable']
      }
      if (lines.length) becomeCorrupt()
      const problem = full ? `E_STORE_CORRUPT: integrity_check (${lines.length})` : quickCheckProblem(lines)
      return Object.freeze({ ok: lines.length === 0, problems: Object.freeze(lines.length ? [problem] : []) })
    },
    /**
     * Commit one request `{ requestId, baseRevision, kind, actor, commands }` (design 3B §4.4).
     * Resolves `{ status: 'committed', revision, receipt, changes }`, or `{ status: 'duplicate', … }` with
     * the original receipt (and no changes) when the same request was already committed. `changes` (3C-5B) are the
     * rows the commit changed: `{ baseRevision, nextRevision, upserts: [{ table, row }], deletes: [{ table, id }] }`,
     * the planner's change set as applyReadModelDelta takes it. Rejects with a
     * StoreHostError whose `outcome` is 'not_committed', or 'unknown' (E_OUTCOME_UNKNOWN: look
     * the request up with lookup(requestId), or retry with the same requestId).
     *
     * No library lease is taken (design 3B v1.1 §16.2-1). While somebody else holds the library
     * operation lock the commit is refused with E_LIBRARY_BUSY; a caller that holds the lease
     * itself (a media operation, a migration) passes `{ leaseToken }` from withLibraryOperation.
     * Another process writing at the same moment makes it E_STORE_BUSY (or E_STALE once that
     * write has committed); neither waits in a queue.
     */
    async commit(request, options) {
      writer()
      const leaseToken = writeOptions(options)
      const valid = validRequest(request)
      const digest = requestDigest(valid)
      return enqueue(() => runCommit(valid, digest, leaseToken))
    },
    /** The original receipt of a committed request: { found: true, receipt } or { found: false }. */
    lookup(requestId) {
      core(() => uuid(requestId, 'requestId'))
      return readTransaction((connection) => {
        const row = statements(connection).receipt.get(requestId)
        return Object.freeze(row ? { found: true, receipt: parseReceipt(row.response) } : { found: false })
      })
    },
    /**
     * Retention (RETENTION: receipts by the rule that keeps more, op_log by the rule that keeps
     * fewer). Each step deletes at most `batchSize` rows per table in its own ordinary write
     * transaction; then the freed pages go back to the file system with `incremental_vacuum`, at
     * most `vacuumPages` per write transaction (design 3B v1.1 §16.2-5). At most `maxSteps`
     * pruning steps and `maxSteps` vacuum steps per call; `done` is false while either has work
     * left. Like commit it takes no lease and checks the library lock before each step
     * (`leaseToken` when the caller holds it). `retention` overrides the defaults (tests).
     * Resolves { receipts, opLog, steps, vacuumSteps, freedPages, done }.
     */
    async pruneLogs({ now, batchSize = 500, maxSteps = 100, vacuumPages = VACUUM_PAGES, retention = RETENTION, leaseToken } = {}) {
      writer()
      writeOptions({ leaseToken })
      core(() => utcTimestamp(now, 'now'))
      const limits = validRetention(retention)
      for (const [name, value] of Object.entries({ batchSize, maxSteps, vacuumPages })) {
        if (!Number.isSafeInteger(value) || value < 1) fail('E_STORE_OPTIONS', { path: name })
      }
      const cutoffs = { receipts: cutoff(now, limits.receipts.days), opLog: cutoff(now, limits.opLog.days) }
      return enqueue(() => {
        let receipts = 0, opLog = 0, steps = 0, pruned = false
        while (!pruned && steps < maxSteps) {
          steps++
          const removed = smallWrite((connection) => pruneStep(connection, cutoffs, limits, batchSize), leaseToken)
          receipts += removed.receipts
          opLog += removed.opLog
          pruned = removed.receipts < batchSize && removed.opLog < batchSize
        }
        let vacuumSteps = 0, freedPages = 0, vacuumed = false
        while (!vacuumed && vacuumSteps < maxSteps) {
          const freed = smallWrite((connection) => vacuumStep(connection, vacuumPages), leaseToken)
          if (freed > 0) { vacuumSteps++; freedPages += freed }
          vacuumed = freed < vacuumPages
        }
        return Object.freeze({ receipts, opLog, steps, vacuumSteps, freedPages, done: pruned && vacuumed })
      })
    },
    /** id_map lookup for 3C-1b's identity manifest: the formal id, or undefined. */
    getIdMapping(kind, sourceId, recordId) {
      return readTransaction((connection) => (strings([kind, sourceId, recordId]) ? statements(connection).idMap.get(kind, sourceId, recordId)?.id : undefined))
    },
    /**
     * Add identity mappings `{ kind, sourceId, recordId, id }` in one write transaction. An
     * identical mapping is a no-op; a different id for a mapped key rejects the whole batch
     * with E_ID_MAP_CONFLICT. Resolves { added }. An ordinary write: no lease, the library lock
     * check first (`{ leaseToken }` when the caller holds the lease, as a migration will).
     */
    async putIdMappings(mappings, options) {
      writer()
      const leaseToken = writeOptions(options)
      const list = validMappings(mappings)
      return enqueue(() => smallWrite((connection) => {
        const sql = statements(connection)
        let added = 0
        for (const mapping of list) {
          const existing = sql.idMap.get(mapping.kind, mapping.sourceId, mapping.recordId)?.id
          if (existing === mapping.id) continue
          if (existing !== undefined) fail('E_ID_MAP_CONFLICT', { path: 'mappings' })
          writeStatements(connection).idMapAdd.run(mapping.kind, mapping.sourceId, mapping.recordId, mapping.id)
          added++
        }
        return Object.freeze({ added })
      }, leaseToken))
    },
    /**
     * Record the backup this store was restored from (3C-3, design 3B §8): `restoredFrom` (a JSON object of at most 4 KiB)
     * replaces whatever was recorded before, so store_meta keeps one layer and never a chain. Not a data change: the
     * revision stays. An ordinary small write (the library lock check first, `{ leaseToken }` when the caller holds the
     * lease). Resolves undefined.
     */
    async setRestoredFrom(restoredFrom, options) {
      writer()
      const leaseToken = writeOptions(options)
      const text = core(() => {
        validateJson(restoredFrom, 'restoredFrom')
        if (restoredFrom === null || typeof restoredFrom !== 'object' || Array.isArray(restoredFrom)) reject('E_STORE_OPTIONS', 'restoredFrom')
        const encoded = JSON.stringify(restoredFrom)
        if (encoded.length > 4096) reject('E_STORE_OPTIONS', 'restoredFrom')
        return encoded
      }, 'not_committed')
      return enqueue(() => smallWrite((connection) => {
        if (connection.prepare('UPDATE store_meta SET restored_from = ? WHERE singleton = 1').run(text).changes !== 1) inconsistent('store_meta')
      }, leaseToken))
    },
    /**
     * Wait for queued writes, then close the connection. A writer session that is still writable
     * ends with clean_shutdown = 1. When that write fails (busy, I/O), or the handle turned
     * read-only or lost its connection, the flag stays 0 and the next open runs quick_check.
     */
    async close() {
      if (closed) return
      closed = true
      await tail
      if (session && writable && !lost) {
        try { setCleanShutdown(db, 1) } catch { /* Left at 0: the next open checks the file. */ }
      }
      closeQuietly(db)
      release?.()
    },
  }
  return handle
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/** Remove `<file>-journal` when it is a zero-length regular file (a journal with content is never touched). */
function removeEmptyJournal(file) {
  const journal = `${file}-journal`
  try {
    const metadata = lstatSync(journal)
    if (metadata.isFile() && !metadata.isSymbolicLink() && metadata.size === 0) unlinkSync(journal)
  } catch { /* Absent, or left for review. */ }
}

/**
 * Create a new store file, exclusively: an existing target is E_STORE_EXISTS and is never
 * touched. `auto_vacuum` is set before the first table; schema, `application_id`, `user_version`
 * and `store_meta` are written in one transaction under the library lease, together with the optional `initial` request
 * `{ requestId, kind?, actor, commands, media? }` (base revision 0; `media` seeds the registry, 3C-4c). Until 3C-1b's official definitions
 * exist, the initial commands always come from the caller. `libraryId` (UUIDv7) is injected.
 * On any failure the new file is removed: nothing half-created is left behind.
 */
export async function createStore(file, options = {}) {
  const target = absoluteFile(file)
  const settings = hostOptions(options)
  core(() => uuid(options.libraryId, 'libraryId'), 'not_committed')
  const initial = options.initial === undefined ? undefined : validRequest({ kind: 'store.create', ...options.initial, baseRevision: 0 })
  const library = resolveLibrary(options)
  // Creation takes the library lease (it makes a new file under the private root).
  return library.lease(() => {
    const createdAt = hostTime(settings)
    try { closeSync(openSync(target, 'wx', 0o600)) } catch (error) {
      if (error?.code === 'EEXIST') fail('E_STORE_EXISTS', { path: 'file' })
      if (missing(error)) fail('E_STORE_PATH', { path: 'file' })
      throw error
    }
    let db
    try {
      db = openConnection(target)
      // Before any table exists (SQLite ignores it afterwards); confirmed by reading it back.
      db.exec(`PRAGMA auto_vacuum = ${STORE_AUTO_VACUUM}`)
      if (pragmaValue(db, 'auto_vacuum') !== STORE_AUTO_VACUUM) fail('E_STORE_SETTINGS', { path: 'auto_vacuum' })
      db.exec('BEGIN IMMEDIATE')
      db.exec(`PRAGMA application_id = ${STORE_APPLICATION_ID}`)
      db.exec(`PRAGMA user_version = ${STORE_FORMAT_VERSION}`)
      for (const statement of SCHEMAS[STORE_FORMAT_VERSION]) db.exec(statement)
      // The creating handle is the store's first writer session: clean_shutdown 0 until its close().
      db.prepare('INSERT INTO store_meta (singleton, format, format_version, library_id, revision, created_at, clean_shutdown) VALUES (1, ?, ?, ?, 0, ?, 0)')
        .run(STORE_FORMAT, STORE_FORMAT_VERSION, options.libraryId, createdAt)
      db.prepare('INSERT INTO store_definitions (singleton, version) VALUES (1, ?)').run(settings.definitionsVersion)
      if (initial) applyRequest(db, initial, requestDigest(initial), createdAt, settings, () => {})
      db.exec('COMMIT')
    } catch (error) {
      if (db && transactionState(db) === true) { try { db.exec('ROLLBACK') } catch { /* Closing releases it. */ } }
      closeQuietly(db)
      // The file was created exclusively by this call and never committed: remove it, and the
      // zero-length journal its rolled-back transaction leaves in TRUNCATE mode.
      try { unlinkSync(target) } catch { /* Left for review. */ }
      removeEmptyJournal(target)
      throw withOutcome(error, 'not_committed')
    }
    const key = writerKey(target)
    if (writers.has(key)) { closeQuietly(db); fail('E_STORE_ALREADY_OPEN', { path: 'file' }) }
    return writableHandle(db, target, key, library, settings, undefined, true)
  })
}

/** `kind` and default `actor` of the request an upgrade writes (its receipt and op_log entry). */
export const STORE_UPGRADE_KIND = 'store.upgrade'
export const STORE_UPGRADE_ACTOR = 'store:upgrade'

/**
 * Upgrade a store of an older format version in place to the current one (3C-4c: 1 → 2; 3C-5 E: 2 → 3; `npm run
 * store:upgrade`), under the library lease:
 * 1. a writable connection (it rolls back a hot journal), application_id and the version: a version with an entry in
 *    MIGRATIONS is upgraded through every later one; the current one is left alone ({ upgraded: false }); a newer one is
 *    E_STORE_TOO_NEW, any other E_STORE_VERSION. Then the old version's exact schema and store_meta, and quick_check
 *    (E_STORE_CORRUPT);
 * 2. every row, read in one transaction (as readRowsUnchecked), goes to `prepare({ state, revision, fromVersion })`. It
 *    may do IO (the media registry is seeded from the Inbox and the media files) and returns the media block to write,
 *    or undefined; and to `commands({ state, fromVersion })`, which returns the formal commands the upgrade writes (none
 *    by default);
 * 3. one write transaction: the revision must not have moved (E_STALE); the statements of every step; one request
 *    (`kind` store.upgrade, the commands and the media block, its receipt and op_log entry; the revision stays when there
 *    are no commands, and moves on by one with them); then user_version and store_meta.format_version; the new
 *    version's open checks must pass inside it;
 * 4. COMMIT, settled into the three outcomes like a commit.
 * Any failure before COMMIT rolls back: the file keeps its old version, nothing else changed. No writer session is
 * started (clean_shutdown is left as it was). `requestId` (UUIDv7) is injected; options as openStore (`privatePaths` or
 * `lock`, `now`, `policy`). Resolves { upgraded, fromVersion, toVersion, fromRevision, revision, receipt? }.
 */
export async function upgradeStoreFile(file, options = {}) {
  const target = absoluteFile(file)
  existingFile(target)
  const settings = hostOptions(options)
  core(() => uuid(options.requestId, 'requestId'), 'not_committed')
  const library = resolveLibrary(options)
  return library.lease(async () => {
    const key = writerKey(target)
    if (writers.has(key)) fail('E_STORE_ALREADY_OPEN', { path: 'file' })
    const db = openConnection(target)
    writers.add(key)
    try {
      if (pragmaValue(db, 'application_id') !== STORE_APPLICATION_ID) fail('E_STORE_APPLICATION_ID', { outcome: 'not_committed' })
      const version = pragmaValue(db, 'user_version')
      if (version > STORE_FORMAT_VERSION) fail('E_STORE_TOO_NEW', { outcome: 'not_committed' })
      const old = version <= STORE_FORMAT_VERSION && Object.hasOwn(SCHEMAS, version) ? formatDiagnostic(db, version) : undefined
      if (old) fail(old.code, { outcome: 'not_committed' })
      // 3C-5 G: the definitions version goes up with the format, in the same transaction (every older format has 1).
      const fromDefinitions = Object.hasOwn(SCHEMAS, version) ? definitionsVersionOf(db, version) : undefined
      const toDefinitions = settings.definitionsVersion
      if (fromDefinitions > toDefinitions) fail('E_STORE_TOO_NEW', { path: 'definitions', outcome: 'not_committed' })
      if (version === STORE_FORMAT_VERSION && fromDefinitions === toDefinitions) {
        return Object.freeze({ upgraded: false, fromVersion: version, toVersion: version, fromDefinitions, toDefinitions, revision: currentRevision(db) })
      }
      const steps = []
      for (let from = version; from < STORE_FORMAT_VERSION; from = MIGRATIONS[from].to) {
        if (!MIGRATIONS[from]) fail('E_STORE_VERSION', { outcome: 'not_committed' })
        steps.push(MIGRATIONS[from])
      }
      const target = steps.at(-1)?.to ?? version
      if (quickCheck(db, settings).length) fail('E_STORE_CORRUPT', { outcome: 'not_committed' })
      let state
      db.exec('BEGIN')
      try { state = formalStateValue(db) } finally { if (transactionState(db) === true) db.exec('ROLLBACK') }
      const media = await options.prepare?.({ state, revision: state.revision, fromVersion: version })
      const commands = options.commands?.({ state, fromVersion: version, fromDefinitions, toDefinitions }) ?? []
      const request = validRequest({
        requestId: options.requestId, baseRevision: state.revision, kind: STORE_UPGRADE_KIND, actor: options.actor ?? STORE_UPGRADE_ACTOR, commands,
        media: media ?? {},
      })
      const at = hostTime(settings)
      let commitIssued = false
      try {
        db.exec('BEGIN IMMEDIATE')
        if (currentRevision(db) !== state.revision) fail('E_STALE', { path: 'revision' })
        for (const step of steps) for (const statement of step.statements) db.exec(statement)
        const { receipt } = applyRequest(db, request, requestDigest(request), at, settings, () => {})
        db.exec(`PRAGMA user_version = ${target}`)
        if (db.prepare('UPDATE store_meta SET format_version = ? WHERE singleton = 1').run(target).changes !== 1) inconsistent('store_meta')
        if (db.prepare('UPDATE store_definitions SET version = ? WHERE singleton = 1').run(toDefinitions).changes !== 1) inconsistent('store_definitions')
        const upgraded = formatDiagnostic(db, target) ?? definitionsDiagnostic(db, toDefinitions)
        if (upgraded) fail(upgraded.code, { path: 'schema' })
        commitIssued = true
        db.exec('COMMIT')
        return Object.freeze({
          upgraded: true, fromVersion: version, toVersion: target, fromDefinitions, toDefinitions, fromRevision: state.revision, revision: receipt.revision, receipt,
        })
      } catch (error) {
        throw settleFailure(db, error, commitIssued)
      }
    } finally {
      writers.delete(key)
      closeQuietly(db)
    }
  })
}

/**
 * checkStoreFile for a store of an older format that store:upgrade knows (3C-4c): its exact old schema, then the same
 * full check without the parts that version does not have (the media registry). Writes nothing. A sound store is
 * { ok: true, upgradeRequired: true }: library:recover can clear a lock left on it, after which store:upgrade (which
 * needs the lease) can run. Without this the two would wait on each other.
 */
function checkOlderStoreFile(file, policy, definitionsVersion) {
  const settings = hostOptions({ policy, ...(definitionsVersion === undefined ? {} : { definitionsVersion }) })
  let db
  try {
    db = openConnection(absoluteFile(file))
    const version = pragmaValue(db, 'user_version')
    const old = formatDiagnostic(db, version)
    if (old) return Object.freeze({ ok: false, upgradeRequired: true, problems: Object.freeze([old.code]) })
    db.exec('BEGIN')
    try {
      const problems = checkConnection(db, settings, { media: version >= 2 })
      return Object.freeze({ ok: problems.length === 0, upgradeRequired: true, problems: Object.freeze(problems) })
    } finally { if (transactionState(db) === true) db.exec('ROLLBACK') }
  } catch (error) {
    return Object.freeze({ ok: false, upgradeRequired: true, problems: Object.freeze([storeErrorFrom(error).code]) })
  } finally { closeQuietly(db) }
}

/**
 * Open `file`, run the full check (quick_check included) and close: library:recover's store
 * check. A store of an older format that store:upgrade knows is checked as that format
 * ({ upgradeRequired: true }). The open is an inspection: it rolls back a hot journal like any writable connection,
 * but starts no writer session, so clean_shutdown is left as it was and a clean store is not
 * written at all. Any open diagnostic or check problem is reported; nothing is repaired.
 */
export async function checkStoreFile(file, { policy, definitionsVersion } = {}) {
  let handle
  try { handle = openHandle(file, { lock: withoutLibraryLock, policy, ...(definitionsVersion === undefined ? {} : { definitionsVersion }) }, { session: false }) } catch (error) {
    return Object.freeze({ ok: false, problems: Object.freeze([error?.code ?? 'E_STORE_OPEN']) })
  }
  try {
    if (handle.diagnostic?.code === 'E_STORE_UPGRADE_REQUIRED') return checkOlderStoreFile(file, policy, definitionsVersion)
    if (handle.diagnostic) return Object.freeze({ ok: false, problems: Object.freeze([handle.diagnostic.code]) })
    return handle.check()
  } catch (error) {
    return Object.freeze({ ok: false, problems: Object.freeze([error?.code ?? 'E_STORE_CHECK']) })
  } finally {
    await handle.close()
  }
}
