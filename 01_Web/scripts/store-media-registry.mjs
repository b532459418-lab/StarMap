/**
 * The media registry of the formal store host (3C-4c, design v2 §2): four host tables beside the formal rows. They are
 * the local host's business, not Core's: Inbox paths and file-system facts never become a record's identity.
 *
 * - `media_files`: one row per file content (the full SHA-256). Its generated directory stays the existing
 *   content-addressed `media/user/<first 16 hex digits>`; this table is the authority for it.
 * - `media_asset_files`: which file an asset uses. Whether a file is still referenced is decided here (deletions).
 * - `media_sources`: the confirmed Inbox sources. A path (portable, under `MediaInbox/`), the content seen there and the
 *   media entity (`record_id`) it was confirmed for; `state` is present, missing (no longer in the Inbox) or deleted (its
 *   record was deleted: later scans do not import it again). At most one present source per path.
 * - `media_scan_cache`: (size, modification time) → SHA-256 of Inbox paths. Disposable: emptying it only makes the next
 *   scan hash again. Nothing checks or trusts it beyond that shortcut.
 *
 * Changes arrive as the `media` block of a commit request and are written in the same transaction as the request's rows,
 * receipt and op_log entry (applyMediaBlock, called by the host's applyRequest). The block is checked against the state
 * inside that transaction, so a commit can never leave a link to a removed asset, a live source of a removed record, or
 * a file row that is still referenced. `pending_file_ops` rows (the files a deletion still has to remove, design v1 §3)
 * come in the same block.
 *
 * Messages carry codes and paths of the request (`media.sources[2]`), never values.
 */
import { generatedDirectoryOfSrc } from '../src/data/v2media/importPlan.ts'
import { OFFICIAL } from '../src/data/store/officialDefinitions.ts'
import { portablePath } from './library-backup.mjs'
import { StoreHostError } from './store-sqlite.mjs'

/** The four host tables of the registry (table counts, schema). */
export const MEDIA_TABLES = Object.freeze(['media_files', 'media_asset_files', 'media_sources', 'media_scan_cache'])

/** The registry's DDL: added by store format 2 (createStore writes it; store:upgrade adds it to a format-1 store). */
export const MEDIA_SCHEMA = Object.freeze([
  'CREATE TABLE media_files (sha256 TEXT PRIMARY KEY, directory TEXT NOT NULL, extension TEXT NOT NULL, bytes INTEGER NOT NULL CHECK (bytes >= 0), '
    + 'outputs TEXT NOT NULL, created_at TEXT NOT NULL) STRICT, WITHOUT ROWID',
  'CREATE UNIQUE INDEX media_files_directory ON media_files (directory)',
  'CREATE TABLE media_asset_files (asset_id TEXT PRIMARY KEY REFERENCES assets (id) DEFERRABLE INITIALLY DEFERRED, '
    + 'sha256 TEXT NOT NULL REFERENCES media_files (sha256) DEFERRABLE INITIALLY DEFERRED) STRICT, WITHOUT ROWID',
  'CREATE INDEX media_asset_files_sha256 ON media_asset_files (sha256)',
  "CREATE TABLE media_sources (seq INTEGER PRIMARY KEY, path TEXT NOT NULL, path_key TEXT NOT NULL, sha256 TEXT NOT NULL, record_id TEXT NOT NULL, "
    + "state TEXT NOT NULL CHECK (state IN ('present', 'missing', 'deleted')), description_digest TEXT, confirmed_request TEXT NOT NULL, "
    + 'confirmed_at TEXT NOT NULL, state_at TEXT NOT NULL) STRICT',
  "CREATE UNIQUE INDEX media_sources_present_path ON media_sources (path_key) WHERE state = 'present'",
  'CREATE INDEX media_sources_path ON media_sources (path_key, sha256)',
  'CREATE INDEX media_sources_sha256 ON media_sources (sha256)',
  'CREATE INDEX media_sources_record ON media_sources (record_id)',
  'CREATE TABLE media_scan_cache (path_key TEXT PRIMARY KEY, size INTEGER NOT NULL CHECK (size >= 0), mtime_ms REAL NOT NULL, sha256 TEXT NOT NULL) STRICT, WITHOUT ROWID',
])

export const SOURCE_STATES = Object.freeze(['present', 'missing', 'deleted'])
/** Kinds of `pending_file_ops` rows (design v1 §3): an Inbox source file, a generated directory. */
export const FILE_OP_KINDS = Object.freeze(['delete-source', 'delete-generated'])
export const INBOX_PREFIX = 'MediaInbox/'
export const USER_MEDIA_PREFIX = 'media/user/'
const SHA256 = /^[0-9a-f]{64}$/
const EXTENSION = /^\.[a-z0-9]{1,10}$/
const DIGEST = /^[0-9a-f]{64}$/
const OUTPUT_NAME = /^[A-Za-z0-9._-]{1,64}$/
/** Every block list has at most this many operations (a whole-library migration seeds one row per file and source). */
export const MEDIA_BLOCK_LIMIT = 200_000
const DETAIL_LIMIT = 4096

/** The generated directory of a content: `media/user/<first 16 hex digits of its SHA-256>` (the existing layout). */
export const directoryOf = (sha256) => `${USER_MEDIA_PREFIX}${sha256.slice(0, 16)}`
/** The lookup key of a portable path: NFC and lower case (the rule of the backup's uniquePaths, so Windows and the backup agree). */
export const pathKeyOf = (value) => value.normalize('NFC').toLowerCase()

const fail = (code, at) => { throw new StoreHostError(code, { path: at, outcome: 'not_committed' }) }
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, keys, required = keys) => plain(value) && Object.keys(value).every((key) => keys.includes(key))
  && required.every((key) => Object.hasOwn(value, key))
const portableUnder = (value, prefix) => {
  try { portablePath(value) } catch { return false }
  return value.startsWith(prefix) && value.length > prefix.length
}
const text = (value, max = 512) => typeof value === 'string' && value.length > 0 && value.length <= max
const count = (value) => Number.isSafeInteger(value) && value >= 0

const validOutputs = (outputs) => Array.isArray(outputs) && outputs.length > 0 && outputs.length <= 16
  && outputs.every((output) => exact(output, ['name', 'sha256', 'bytes']) && OUTPUT_NAME.test(output.name) && output.name !== '.' && output.name !== '..'
    && SHA256.test(output.sha256) && count(output.bytes))
  && new Set(outputs.map((output) => output.name.toLowerCase())).size === outputs.length

/**
 * A `media` block, checked and copied: `{ files?, assetFiles?, sources?, scanCache?, fileOps? }`, each a list of
 * operations. Shapes only; the state is checked when the block is applied.
 * - files: `{ op: 'put', sha256, extension, bytes, outputs: [{ name, sha256, bytes }] }` | `{ op: 'remove', sha256 }`
 * - assetFiles: `{ op: 'put', assetId, sha256 }` | `{ op: 'remove', assetId }`
 * - sources: `{ op: 'add', path, sha256, recordId, state, descriptionDigest? }` |
 *   `{ op: 'update', seq, path?, state?, descriptionDigest? }` (a source's content and record never change)
 * - scanCache: `{ op: 'put', path, size, mtimeMs, sha256 }` | `{ op: 'remove', path }`
 * - fileOps: `{ kind: 'delete-source' | 'delete-generated', target, detail }`
 */
export function validMediaBlock(media) {
  if (!exact(media, ['files', 'assetFiles', 'sources', 'scanCache', 'fileOps'], [])) fail('E_MEDIA_BLOCK', 'media')
  const list = (name, check) => {
    const items = media[name] ?? []
    if (!Array.isArray(items) || items.length > MEDIA_BLOCK_LIMIT) fail('E_MEDIA_BLOCK', `media.${name}`)
    items.forEach((item, index) => { if (!check(item)) fail('E_MEDIA_BLOCK', `media.${name}[${index}]`) })
    return items.map((item) => structuredClone(item))
  }
  const block = {
    files: list('files', (item) => (item?.op === 'remove'
      ? exact(item, ['op', 'sha256']) && SHA256.test(item.sha256)
      : exact(item, ['op', 'sha256', 'extension', 'bytes', 'outputs']) && item.op === 'put' && SHA256.test(item.sha256)
        && EXTENSION.test(item.extension) && count(item.bytes) && validOutputs(item.outputs))),
    assetFiles: list('assetFiles', (item) => (item?.op === 'remove'
      ? exact(item, ['op', 'assetId']) && text(item.assetId)
      : exact(item, ['op', 'assetId', 'sha256']) && item.op === 'put' && text(item.assetId) && SHA256.test(item.sha256))),
    sources: list('sources', (item) => (item?.op === 'update'
      ? exact(item, ['op', 'seq', 'path', 'state', 'descriptionDigest'], ['op', 'seq']) && Number.isSafeInteger(item.seq) && item.seq > 0
        && (item.path === undefined || portableUnder(item.path, INBOX_PREFIX))
        && (item.state === undefined || SOURCE_STATES.includes(item.state))
        && (item.descriptionDigest === undefined || item.descriptionDigest === null || DIGEST.test(item.descriptionDigest))
        && Object.keys(item).length > 2
      : exact(item, ['op', 'path', 'sha256', 'recordId', 'state', 'descriptionDigest'], ['op', 'path', 'sha256', 'recordId', 'state'])
        && item.op === 'add' && portableUnder(item.path, INBOX_PREFIX) && SHA256.test(item.sha256) && text(item.recordId)
        && SOURCE_STATES.includes(item.state) && (item.descriptionDigest === undefined || DIGEST.test(item.descriptionDigest)))),
    scanCache: list('scanCache', (item) => (item?.op === 'remove'
      ? exact(item, ['op', 'path']) && portableUnder(item.path, INBOX_PREFIX)
      : exact(item, ['op', 'path', 'size', 'mtimeMs', 'sha256']) && item.op === 'put' && portableUnder(item.path, INBOX_PREFIX)
        && count(item.size) && typeof item.mtimeMs === 'number' && Number.isFinite(item.mtimeMs) && item.mtimeMs >= 0 && SHA256.test(item.sha256))),
    fileOps: list('fileOps', (item) => exact(item, ['kind', 'target', 'detail']) && FILE_OP_KINDS.includes(item.kind)
      && portableUnder(item.target, item.kind === 'delete-source' ? INBOX_PREFIX : USER_MEDIA_PREFIX)
      && plain(item.detail) && JSON.stringify(item.detail).length <= DETAIL_LIMIT),
  }
  // A path, asset, content or source is touched by at most one operation of its list.
  const once = (name, keyOf) => {
    const seen = new Set()
    block[name].forEach((item, index) => {
      const key = keyOf(item)
      if (key === undefined) return
      if (seen.has(key)) fail('E_MEDIA_BLOCK', `media.${name}[${index}]`)
      seen.add(key)
    })
  }
  once('files', (item) => item.sha256)
  once('assetFiles', (item) => item.assetId)
  once('sources', (item) => (item.op === 'update' ? `#${item.seq}` : undefined))
  once('scanCache', (item) => pathKeyOf(item.path))
  return block
}

/** The receipt's summary of a block: how many operations of each kind. */
export const mediaBlockCounts = (block) => Object.fromEntries(['files', 'assetFiles', 'sources', 'scanCache', 'fileOps']
  .map((name) => [name, block[name].length]).filter(([, value]) => value > 0))

const statementCache = new WeakMap()
function statements(db) {
  let cached = statementCache.get(db)
  if (cached) return cached
  const prepare = (sql) => db.prepare(sql)
  cached = {
    file: prepare('SELECT sha256, directory, extension, bytes, outputs FROM media_files WHERE sha256 = ?'),
    fileByDirectory: prepare('SELECT sha256 FROM media_files WHERE directory = ?'),
    fileInsert: prepare('INSERT INTO media_files (sha256, directory, extension, bytes, outputs, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    fileRemove: prepare('DELETE FROM media_files WHERE sha256 = ?'),
    link: prepare('SELECT sha256 FROM media_asset_files WHERE asset_id = ?'),
    linksOf: prepare('SELECT count(*) AS count FROM media_asset_files WHERE sha256 = ?'),
    linkInsert: prepare('INSERT INTO media_asset_files (asset_id, sha256) VALUES (?, ?)'),
    linkRemove: prepare('DELETE FROM media_asset_files WHERE asset_id = ?'),
    asset: prepare('SELECT id FROM assets WHERE id = ?'),
    entity: prepare('SELECT body FROM entities WHERE id = ?'),
    source: prepare('SELECT seq, path, path_key, sha256, record_id, state, description_digest, state_at FROM media_sources WHERE seq = ?'),
    presentAt: prepare("SELECT seq FROM media_sources WHERE path_key = ? AND state = 'present'"),
    liveSourcesOf: prepare("SELECT count(*) AS count FROM media_sources WHERE record_id = ? AND state != 'deleted'"),
    sourceInsert: prepare('INSERT INTO media_sources (path, path_key, sha256, record_id, state, description_digest, confirmed_request, confirmed_at, state_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    sourceUpdate: prepare('UPDATE media_sources SET path = ?, path_key = ?, state = ?, description_digest = ?, state_at = ? WHERE seq = ?'),
    cachePut: prepare('INSERT INTO media_scan_cache (path_key, size, mtime_ms, sha256) VALUES (?, ?, ?, ?) '
      + 'ON CONFLICT (path_key) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, sha256 = excluded.sha256'),
    cacheRemove: prepare('DELETE FROM media_scan_cache WHERE path_key = ?'),
    fileOpInsert: prepare('INSERT INTO pending_file_ops (kind, target, request_id, at, detail) VALUES (?, ?, ?, ?, ?)'),
  }
  statementCache.set(db, cached)
  return cached
}

/** The type id of an entity row's body, or undefined. */
function entityTypeOf(sql, id) {
  const row = sql.entity.get(id)
  if (!row) return undefined
  try { return JSON.parse(row.body).typeId } catch { return undefined }
}

/**
 * Apply a checked block inside the open write transaction of `requestId`, after the request's change set (`deletes`:
 * its removed rows). Operations run in an order where every step meets the state the previous ones left: links that go,
 * files that come, links that come, files that go; then sources, the scan cache and the pending file operations.
 * Afterwards the touched rows are checked against the state: a link names an existing asset; a source that is not
 * deleted names an existing `starmap:media` entity; no removed asset keeps a link; no removed media entity keeps a
 * source that is not deleted; no removed file is still linked. A failure is E_MEDIA_REGISTRY (confirmed not committed:
 * the caller rolls the transaction back). Returns the block's counts.
 */
export function applyMediaBlock(db, block, { requestId, at, deletes = [] }) {
  const sql = statements(db)
  block.assetFiles.forEach((item, index) => {
    if (item.op !== 'remove') return
    if (sql.linkRemove.run(item.assetId).changes !== 1) fail('E_MEDIA_REGISTRY', `media.assetFiles[${index}]`)
  })
  block.files.forEach((item, index) => {
    if (item.op !== 'put') return
    const stored = sql.file.get(item.sha256)
    const outputs = JSON.stringify(item.outputs)
    if (stored) {
      if (stored.extension !== item.extension || stored.bytes !== item.bytes || stored.outputs !== outputs) fail('E_MEDIA_REGISTRY', `media.files[${index}]`)
      return
    }
    const directory = directoryOf(item.sha256)
    // Two contents with the same 64-bit prefix would share a directory: refused.
    if (sql.fileByDirectory.get(directory)) fail('E_MEDIA_REGISTRY', `media.files[${index}]`)
    sql.fileInsert.run(item.sha256, directory, item.extension, item.bytes, outputs, at)
  })
  block.assetFiles.forEach((item, index) => {
    if (item.op !== 'put') return
    const linked = sql.link.get(item.assetId)
    if (linked) {
      if (linked.sha256 !== item.sha256) fail('E_MEDIA_REGISTRY', `media.assetFiles[${index}]`)
      return
    }
    if (!sql.asset.get(item.assetId) || !sql.file.get(item.sha256)) fail('E_MEDIA_REGISTRY', `media.assetFiles[${index}]`)
    sql.linkInsert.run(item.assetId, item.sha256)
  })
  block.files.forEach((item, index) => {
    if (item.op !== 'remove') return
    if (sql.linksOf.get(item.sha256).count !== 0 || sql.fileRemove.run(item.sha256).changes !== 1) fail('E_MEDIA_REGISTRY', `media.files[${index}]`)
  })
  const liveRecord = (recordId, at) => { if (entityTypeOf(sql, recordId) !== OFFICIAL.media) fail('E_MEDIA_REGISTRY', at) }
  const presentPath = (key, seq, at) => {
    const other = sql.presentAt.get(key)
    if (other && other.seq !== seq) fail('E_MEDIA_REGISTRY', at)
  }
  block.sources.forEach((item, index) => {
    const where = `media.sources[${index}]`
    if (item.op === 'add') {
      const key = pathKeyOf(item.path)
      if (item.state !== 'deleted') liveRecord(item.recordId, where)
      if (item.state === 'present') presentPath(key, undefined, where)
      sql.sourceInsert.run(item.path, key, item.sha256, item.recordId, item.state, item.descriptionDigest ?? null, requestId, at, at)
      return
    }
    const stored = sql.source.get(item.seq)
    if (!stored) fail('E_MEDIA_REGISTRY', where)
    const pathValue = item.path ?? stored.path
    const key = pathKeyOf(pathValue)
    const state = item.state ?? stored.state
    if (state !== 'deleted') liveRecord(stored.record_id, where)
    if (state === 'present') presentPath(key, stored.seq, where)
    const digest = item.descriptionDigest === undefined ? stored.description_digest : item.descriptionDigest
    sql.sourceUpdate.run(pathValue, key, state, digest, state === stored.state ? stored.state_at : at, stored.seq)
  })
  for (const item of block.scanCache) {
    if (item.op === 'put') sql.cachePut.run(pathKeyOf(item.path), item.size, item.mtimeMs, item.sha256)
    else sql.cacheRemove.run(pathKeyOf(item.path))
  }
  for (const item of block.fileOps) sql.fileOpInsert.run(item.kind, item.target, requestId, at, JSON.stringify(item.detail))
  // Removed rows of the request's change set leave nothing behind in the registry.
  for (const { table, id } of deletes) {
    if (table === 'assets' && sql.link.get(id)) fail('E_MEDIA_REGISTRY', 'media.assetFiles')
    if (table === 'entities' && sql.liveSourcesOf.get(id).count !== 0) fail('E_MEDIA_REGISTRY', 'media.sources')
  }
  return mediaBlockCounts(block)
}

/** Every registry row (and every pending file operation), as plain objects, from one read transaction. */
export function mediaRegistrySnapshot(db) {
  const all = (sqlText) => db.prepare(sqlText).all().map((row) => ({ ...row }))
  return {
    files: all('SELECT sha256, directory, extension, bytes, outputs, created_at FROM media_files ORDER BY sha256')
      .map((row) => ({ sha256: row.sha256, directory: row.directory, extension: row.extension, bytes: row.bytes, outputs: JSON.parse(row.outputs), createdAt: row.created_at })),
    assetFiles: all('SELECT asset_id, sha256 FROM media_asset_files ORDER BY asset_id').map((row) => ({ assetId: row.asset_id, sha256: row.sha256 })),
    sources: all('SELECT seq, path, path_key, sha256, record_id, state, description_digest, confirmed_request, confirmed_at, state_at FROM media_sources ORDER BY seq')
      .map((row) => ({
        seq: row.seq, path: row.path, pathKey: row.path_key, sha256: row.sha256, recordId: row.record_id, state: row.state,
        descriptionDigest: row.description_digest ?? undefined, confirmedRequest: row.confirmed_request, confirmedAt: row.confirmed_at, stateAt: row.state_at,
      })),
    scanCache: all('SELECT path_key, size, mtime_ms, sha256 FROM media_scan_cache ORDER BY path_key')
      .map((row) => ({ pathKey: row.path_key, size: row.size, mtimeMs: row.mtime_ms, sha256: row.sha256 })),
    pendingFileOps: all('SELECT seq, kind, target, request_id, at, detail FROM pending_file_ops ORDER BY seq')
      .map((row) => ({ seq: row.seq, kind: row.kind, target: row.target, requestId: row.request_id, at: row.at, detail: JSON.parse(row.detail) })),
  }
}

/** The `/media/user/...` sources of an asset's attributes: `src` and the `src` of every variant. */
export function assetSourcesOf(attributes) {
  const sources = []
  if (typeof attributes?.src === 'string') sources.push(attributes.src)
  if (plain(attributes?.variants)) {
    for (const variant of Object.values(attributes.variants)) if (typeof variant?.src === 'string') sources.push(variant.src)
  }
  return sources
}

/**
 * The registry part of the store's full check, against the formal `state` read in the same transaction. Problems are
 * codes with counts:
 * - rows that break the registry's own rules (shapes, the directory of a content, a path's key, unknown states or kinds);
 * - E_MEDIA_ASSET_DIRECTORY: a linked asset's `src` or a variant's lies in another directory than the file its link names
 *   (design v2 review §8-4);
 * - E_MEDIA_SOURCE_RECORD: a source that is not deleted names no existing `starmap:media` entity (§8-4);
 * - E_MEDIA_LINK: a link names an asset or a file that does not exist.
 */
export function mediaRegistryProblems(db, state) {
  const problems = []
  const report = (code, found) => { if (found) problems.push(`${code}: ${found}`) }
  const registry = mediaRegistrySnapshot(db)
  const files = new Map(registry.files.map((file) => [file.sha256, file]))
  report('E_MEDIA_FILE_ROW', registry.files.filter((file) => !SHA256.test(file.sha256) || file.directory !== directoryOf(file.sha256)
    || !EXTENSION.test(file.extension) || !validOutputs(file.outputs)).length)
  const assets = new Map(state.assets.map((asset) => [asset.id, asset]))
  const links = new Map(registry.assetFiles.map((link) => [link.assetId, link.sha256]))
  report('E_MEDIA_LINK', registry.assetFiles.filter((link) => !assets.has(link.assetId) || !files.has(link.sha256)).length)
  let misplaced = 0
  for (const asset of state.assets) {
    const sha256 = links.get(asset.id)
    if (sha256 === undefined) continue
    const directory = files.get(sha256)?.directory
    const all = assetSourcesOf(asset.attributes)
    if (all.length === 0 || all.some((src) => `${USER_MEDIA_PREFIX}${generatedDirectoryOfSrc(src) ?? '?'}` !== directory)) misplaced++
  }
  report('E_MEDIA_ASSET_DIRECTORY', misplaced)
  const mediaEntities = new Set(state.entities.filter((entity) => entity.typeId === OFFICIAL.media).map((entity) => entity.id))
  report('E_MEDIA_SOURCE_ROW', registry.sources.filter((source) => !portableUnder(source.path, INBOX_PREFIX) || source.pathKey !== pathKeyOf(source.path)
    || !SHA256.test(source.sha256) || !SOURCE_STATES.includes(source.state)).length)
  report('E_MEDIA_SOURCE_RECORD', registry.sources.filter((source) => source.state !== 'deleted' && !mediaEntities.has(source.recordId)).length)
  report('E_MEDIA_FILE_OP', registry.pendingFileOps.filter((op) => !FILE_OP_KINDS.includes(op.kind)
    || !portableUnder(op.target, op.kind === 'delete-source' ? INBOX_PREFIX : USER_MEDIA_PREFIX) || !plain(op.detail)).length)
  return problems
}
