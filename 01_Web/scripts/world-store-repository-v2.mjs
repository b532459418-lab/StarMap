/** Experimental writable v2 host, separate from immutable upgrade artifacts.
 * Full snapshot history is deliberately simple; no large-library cost claim. */
import { DatabaseSync } from 'node:sqlite'
import { closeSync, fsyncSync, lstatSync, openSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { freezeCopy, opaqueId, validateJson } from '../src/worldgraph/store/schema.ts'
import { RepositoryError, transitionRepositoryState } from './world-store-repository.mjs'
import { readRepositoryV2, repositoryStateDigest as digest } from './world-store-repository-v2-contract.mjs'

const APP = 0x534d4735
const SQL = 'CREATE TABLE repository_v2 (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), payload TEXT NOT NULL, digest TEXT NOT NULL) STRICT'
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
/** Verify request semantics in addition to structural chain integrity. */
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
function read(db, policy) {
  const rows = db.prepare('SELECT payload,digest FROM repository_v2').all()
  if (rows.length !== 1) fail('E_REPO_CORRUPT')
  const value = replayRepositoryV2(JSON.parse(rows[0].payload), policy)
  if (digest(value) !== rows[0].digest) fail('E_REPO_CORRUPT')
  return value
}
function handle(db, options) {
  const phase = name => {
    const result = options.unsafeTestPhase?.(name)
    if (result && typeof result.then === 'function') fail('E_REPO_ASYNC_HOOK')
  }
  const transactionRead = callback => {
    if (db.isTransaction) fail('E_REPO_BUSY')
    try { db.exec('BEGIN'); return callback(read(db, options.policy)) }
    catch (error) { throw translated(error) }
    finally { if (db.isTransaction) db.exec('ROLLBACK') }
  }
  return {
    snapshot() { return transactionRead(value => value) },
    findOperation(id) {
      opaqueId(id, 'operationId')
      return transactionRead(value => value.history.find(row => row.operationId === id)?.receipt)
    },
    apply(input) {
      validateJson(input); opaqueId(input?.id, 'operationId')
      const request = freezeCopy(input), requestDigest = digest(request)
      if (options.readOnly) fail('E_REPO_READONLY')
      if (db.isTransaction) fail('E_REPO_BUSY')
      let attempted = false
      try {
        db.exec('BEGIN IMMEDIATE'); phase('locked')
        const current = read(db, options.policy)
        const previous = current.history.find(row => row.operationId === request.id)
        if (previous) {
          if (previous.requestDigest !== requestDigest) fail('E_REPO_OPERATION_CONFLICT')
          db.exec('ROLLBACK'); return previous.receipt
        }
        const after = transitionRepositoryState(current.state, request, options.policy)
        const receipt = { status: 'committed', operationId: request.id, repositoryRevision: after.revision, worldRevision: after.world.revision }
        const row = { operationId: request.id, request, requestDigest, beforeDigest: digest(current.state), afterDigest: digest(after), after, receipt }
        const next = readRepositoryV2({ ...current, state: after, history: [...current.history, row] }, options.policy)
        db.prepare('UPDATE repository_v2 SET payload=?,digest=? WHERE singleton=1').run(JSON.stringify(next), digest(next))
        phase('state-written'); phase('before-commit'); attempted = true
        db.exec('COMMIT'); phase('committed')
        return freezeCopy(receipt)
      } catch (error) {
        try { if (db.isTransaction) db.exec('ROLLBACK') } catch { /* Discover outcome on reopen. */ }
        if (attempted) fail('E_REPO_OUTCOME_UNKNOWN')
        throw translated(error)
      }
    },
    close() { db.close() },
  }
}
export function createRepositoryV2(file, input, options = {}) {
  const value = replayRepositoryV2(input, options.policy)
  const target = location(file, true)
  let db
  try {
    const fd = openSync(target, 'wx', 0o600)
    try { fsyncSync(fd) } finally { closeSync(fd) }
    db = new DatabaseSync(target, { allowExtension: false, timeout: 0 })
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE')
    db.exec(SQL); db.exec(`PRAGMA application_id=${APP}; PRAGMA user_version=2;`)
    db.prepare('INSERT INTO repository_v2 VALUES (1,?,?)').run(JSON.stringify(value), digest(value))
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
    if (db.prepare('PRAGMA application_id').get().application_id !== APP || db.prepare('PRAGMA user_version').get().user_version !== 2) fail('E_REPO_VERSION')
    const schema = db.prepare("SELECT name,type,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all()
    if (schema.length !== 1 || schema[0].name !== 'repository_v2' || schema[0].type !== 'table' || schema[0].sql !== SQL || db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('E_REPO_CORRUPT')
    if (!options.readOnly) db.exec('PRAGMA synchronous=FULL')
    read(db, options.policy); return handle(db, options)
  } catch (error) { if (db) db.close(); throw translated(error) }
}
