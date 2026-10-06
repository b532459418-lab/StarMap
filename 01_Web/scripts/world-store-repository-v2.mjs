/** Experimental host: logical envelope v2, SQLite storage v3.
 * Current state and compact logs commit together. Full history is materialized
 * only for explicit snapshots; ordinary state reads do not replay history. */
import { DatabaseSync } from 'node:sqlite'
import { closeSync, fsyncSync, lstatSync, openSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { freezeCopy, opaqueId, shape, validateJson } from '../src/worldgraph/store/schema.ts'
import { RepositoryError, readRepositoryState, transitionRepositoryState } from './world-store-repository.mjs'
import { readRepositoryV2, repositoryStateDigest as digest } from './world-store-repository-v2-contract.mjs'
const APP = 0x534d4735
const LEGACY_SQL = 'CREATE TABLE repository_v2 (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), payload TEXT NOT NULL, digest TEXT NOT NULL) STRICT'
const BASE_SQL = 'CREATE TABLE repository_baseline (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), payload TEXT NOT NULL, digest TEXT NOT NULL) STRICT'
const STATE_SQL = 'CREATE TABLE repository_current (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), payload TEXT NOT NULL, digest TEXT NOT NULL) STRICT'
const HISTORY_SQL = 'CREATE TABLE operation_history (operation_id TEXT PRIMARY KEY, repository_revision INTEGER NOT NULL UNIQUE, payload TEXT NOT NULL, digest TEXT NOT NULL) STRICT'
const supported = new Set(['commands', 'stage-proposal', 'accept-proposal', 'reject-proposal'])
const fail = code => { throw new RepositoryError(code) }
function location(file, create = false) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) fail('E_REPO_PATH')
  const result = path.join(realpathSync(path.dirname(file)), path.basename(file))
  if (!create) { const stat = lstatSync(result); if (!stat.isFile() || stat.isSymbolicLink()) fail('E_REPO_PATH') }
  return result
}
function translated(error) {
  if (error?.code?.startsWith('E_')) return error
  return new RepositoryError([5, 6].includes(error?.errcode) ? 'E_REPO_BUSY' : 'E_REPO_IO')
}
export function replayRepositoryV2(input, policy = {}) {
  const value = readRepositoryV2(input, policy)
  let state = value.baseline.state
  for (const row of value.history) {
    const after = transitionRepositoryState(state, row.request, policy)
    if (digest(after) !== digest(row.after)) fail('E_REPO_V2_REPLAY')
    state = after
  }
  return value
}
function parsed(row) {
  if (!row) fail('E_REPO_CORRUPT')
  const value = JSON.parse(row.payload)
  validateJson(value)
  if (digest(value) !== row.digest) fail('E_REPO_CORRUPT')
  return value
}
const compact = full => { const row = { ...full }; delete row.after; return row }
function replayDatabase(db, policy, collect = false) {
  const metadata = parsed(db.prepare('SELECT payload,digest FROM repository_baseline WHERE singleton=1').get())
  shape(metadata, ['format', 'formatVersion', 'identity', 'baseline'])
  const base = readRepositoryV2({ ...metadata, history: [], state: metadata.baseline.state }, policy)
  let state = base.state
  const history = []
  for (const stored of db.prepare('SELECT * FROM operation_history ORDER BY repository_revision').iterate()) {
    const row = parsed(stored)
    shape(row, ['operationId', 'request', 'requestDigest', 'beforeDigest', 'afterDigest', 'receipt'])
    if (row.operationId !== stored.operation_id || row.operationId !== row.request?.id
      || !supported.has(row.request?.action?.kind) || row.requestDigest !== digest(row.request)
      || row.beforeDigest !== digest(state)) fail('E_REPO_V2_CHAIN')
    const after = transitionRepositoryState(state, row.request, policy)
    shape(row.receipt, ['status', 'operationId', 'repositoryRevision', 'worldRevision'])
    if (stored.repository_revision !== after.revision || row.afterDigest !== digest(after)
      || row.receipt.status !== 'committed' || row.receipt.operationId !== row.operationId
      || row.receipt.repositoryRevision !== after.revision || row.receipt.worldRevision !== after.world.revision) fail('E_REPO_V2_REPLAY')
    if (collect) history.push(Object.freeze({ ...freezeCopy(row), after }))
    state = after
  }
  const current = readRepositoryState(parsed(db.prepare('SELECT payload,digest FROM repository_current WHERE singleton=1').get()), policy)
  if (digest(current) !== digest(state)) fail('E_REPO_V2_CHAIN')
  return { base, state: current, ...(collect ? { full: Object.freeze({ ...base, state: current, history: Object.freeze(history) }) } : {}) }
}
function handle(db, options, legacy = false) {
  const policy = freezeCopy(options.policy ?? {})
  let verified, observedVersion, fullSnapshot
  const phase = name => {
    const result = options.unsafeTestPhase?.(name)
    if (result && typeof result.then === 'function') fail('E_REPO_ASYNC_HOOK')
  }
  function current() {
    const version = db.prepare('PRAGMA data_version').get().data_version
    if (!verified || version !== observedVersion) {
      if (legacy) {
        const full = replayRepositoryV2(parsed(db.prepare('SELECT payload,digest FROM repository_v2 WHERE singleton=1').get()), policy)
        verified = { base: full, state: full.state }; fullSnapshot = full
      } else { verified = replayDatabase(db, policy); fullSnapshot = undefined }
      observedVersion = version
    }
    return verified
  }
  const transactionRead = callback => {
    if (db.isTransaction) fail('E_REPO_BUSY')
    try { db.exec('BEGIN'); return callback(current()) }
    catch (error) { throw translated(error) }
    finally { if (db.isTransaction) db.exec('ROLLBACK') }
  }
  const result = {
    state() { return transactionRead(value => value.state) },
    snapshot() {
      return transactionRead(() => {
        if (!fullSnapshot) fullSnapshot = replayDatabase(db, policy, true).full
        return fullSnapshot
      })
    },
    findOperation(id) {
      opaqueId(id, 'operationId')
      return transactionRead(() => {
        if (legacy) return fullSnapshot.history.find(row => row.operationId === id)?.receipt
        const row = db.prepare('SELECT payload,digest FROM operation_history WHERE operation_id=?').get(id)
        return row ? freezeCopy(parsed(row).receipt) : undefined
      })
    },
    apply(input) {
      validateJson(input); opaqueId(input?.id, 'operationId')
      if (!supported.has(input.action?.kind)) fail('E_REPO_V2_REQUEST')
      const request = freezeCopy(input), requestDigest = digest(request)
      if (legacy) fail('E_REPO_UPGRADE_REQUIRED')
      if (options.readOnly) fail('E_REPO_READONLY')
      if (db.isTransaction) fail('E_REPO_BUSY')
      let attempted = false
      try {
        db.exec('BEGIN IMMEDIATE'); phase('locked')
        const value = current(), previousRow = db.prepare('SELECT payload,digest FROM operation_history WHERE operation_id=?').get(request.id)
        if (previousRow) {
          const previous = parsed(previousRow)
          if (previous.requestDigest !== requestDigest) fail('E_REPO_OPERATION_CONFLICT')
          db.exec('ROLLBACK'); return freezeCopy(previous.receipt)
        }
        const after = transitionRepositoryState(value.state, request, policy)
        const receipt = freezeCopy({ status: 'committed', operationId: request.id, repositoryRevision: after.revision, worldRevision: after.world.revision })
        const row = Object.freeze({ operationId: request.id, request, requestDigest, beforeDigest: digest(value.state), afterDigest: digest(after), receipt })
        db.prepare('UPDATE repository_current SET payload=?,digest=? WHERE singleton=1').run(JSON.stringify(after), digest(after))
        db.prepare('INSERT INTO operation_history VALUES (?,?,?,?)').run(request.id, after.revision, JSON.stringify(row), digest(row))
        phase('state-written'); phase('before-commit'); attempted = true
        db.exec('COMMIT')
        verified = { base: value.base, state: after }
        if (fullSnapshot) fullSnapshot = Object.freeze({ ...fullSnapshot, state: after, history: Object.freeze([...fullSnapshot.history, Object.freeze({ ...row, after })]) })
        phase('committed'); return receipt
      } catch (error) {
        try { if (db.isTransaction) db.exec('ROLLBACK') } catch { /* Discover outcome on reopen. */ }
        verified = undefined; fullSnapshot = undefined
        if (attempted) fail('E_REPO_OUTCOME_UNKNOWN')
        throw translated(error)
      }
    },
    close() { db.close() },
  }
  transactionRead(() => undefined)
  return result
}
export function createRepositoryV2(file, input, options = {}) {
  const value = replayRepositoryV2(input, options.policy), target = location(file, true)
  let db
  try {
    const fd = openSync(target, 'wx', 0o600)
    try { fsyncSync(fd) } finally { closeSync(fd) }
    db = new DatabaseSync(target, { allowExtension: false, timeout: 0 })
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE')
    db.exec(BASE_SQL); db.exec(STATE_SQL); db.exec(HISTORY_SQL)
    db.exec('PRAGMA application_id=' + APP + '; PRAGMA user_version=3;')
    const { state, history, ...base } = value
    db.prepare('INSERT INTO repository_baseline VALUES (1,?,?)').run(JSON.stringify(base), digest(base))
    db.prepare('INSERT INTO repository_current VALUES (1,?,?)').run(JSON.stringify(state), digest(state))
    for (const full of history) {
      const row = compact(full)
      db.prepare('INSERT INTO operation_history VALUES (?,?,?,?)').run(row.operationId, row.receipt.repositoryRevision, JSON.stringify(row), digest(row))
    }
    db.exec('COMMIT'); return handle(db, options)
  } catch (error) {
    if (db) { try { if (db.isTransaction) db.exec('ROLLBACK'); db.close() } catch { /* Preserve partial file. */ } }
    if (error.code === 'EEXIST') fail('E_REPO_EXISTS')
    throw translated(error)
  }
}
export function openRepositoryV2(file, options = {}) {
  let db
  try {
    db = new DatabaseSync(location(file), { readOnly: options.readOnly === true, allowExtension: false, timeout: 0 })
    const version = db.prepare('PRAGMA user_version').get().user_version
    if (db.prepare('PRAGMA application_id').get().application_id !== APP || ![2, 3].includes(version)) fail('E_REPO_VERSION')
    const expected = version === 2 ? new Map([['repository_v2', LEGACY_SQL]]) : new Map([['repository_baseline', BASE_SQL], ['repository_current', STATE_SQL], ['operation_history', HISTORY_SQL]])
    const schema = db.prepare("SELECT name,type,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all()
    if (schema.length !== expected.size || schema.some(row => row.type !== 'table' || expected.get(row.name) !== row.sql)
      || db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('E_REPO_CORRUPT')
    if (version === 2 && !options.readOnly) fail('E_REPO_UPGRADE_REQUIRED')
    if (!options.readOnly) db.exec('PRAGMA synchronous=FULL')
    return handle(db, options, version === 2)
  } catch (error) { if (db) db.close(); throw translated(error) }
}
