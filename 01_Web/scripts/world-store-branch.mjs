/** Experimental standalone writable fork: logical format 3, SQLite storage 4.
 * V2 source snapshots are archived intact; local operations never adopt parent
 * receipts. Caller-owned explicit paths only; no App/private-root discovery.
 * Fingerprints/bindings detect mistakes or corruption, not same-user forgery.
 */
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { freezeCopy, opaqueId, shape, validateJson } from '../src/worldgraph/store/schema.ts'
import { RepositoryError, readRepositoryState, transitionRepositoryState } from './world-store-repository.mjs'
import { openRepositoryV2, replayRepositoryV2 } from './world-store-repository-v2.mjs'
import { repositoryStateDigest as digest } from './world-store-repository-v2-contract.mjs'
import { assertBranchSource, assertBranchWriteBinding, readBranchDescriptor, readBranchOperationManifest } from './world-store-branch-contract.mjs'

const APP = 0x534d4736
const META_SQL = 'CREATE TABLE branch_metadata (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), payload TEXT NOT NULL, digest TEXT NOT NULL) STRICT'
const STATE_SQL = 'CREATE TABLE branch_current (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), payload TEXT NOT NULL, digest TEXT NOT NULL) STRICT'
const HISTORY_SQL = 'CREATE TABLE branch_history (operation_id TEXT PRIMARY KEY, repository_revision INTEGER NOT NULL UNIQUE, payload TEXT NOT NULL, digest TEXT NOT NULL) STRICT'
const supported = new Set(['commands', 'stage-proposal', 'accept-proposal', 'reject-proposal'])
const fail = code => { throw new RepositoryError(code) }
function translated(error) {
  if (error?.code?.startsWith('E_')) return error
  return new RepositoryError([5, 6].includes(error?.errcode) ? 'E_REPO_BUSY' : 'E_REPO_IO')
}
function phase(options, name) {
  const result = options.unsafeTestPhase?.(name)
  if (result && typeof result.then === 'function') fail('E_BRANCH_ASYNC_HOOK')
}
function targetPath(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) fail('E_BRANCH_PATH')
  const name = path.basename(input)
  if (!name || name === '.' || name === '..' || (process.platform === 'win32' && (/[. :]+$/.test(name) || /:/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)))) fail('E_BRANCH_PATH')
  return path.join(realpathSync(path.dirname(input)), name)
}
function regularFile(file) {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('E_BRANCH_PATH')
  return stat
}
function observedBinding(root, hostId) {
  opaqueId(hostId, 'hostId')
  const file = path.join(root, 'world.sqlite')
  // realpath resolves parent aliases; Windows location matching is insensitive
  // to case. Logical identity does not incorporate the location fingerprint.
  return { hostId, locationDigest: digest(process.platform === 'win32' ? file.toLowerCase() : file) }
}
function readLocationMarker(root) {
  const file = path.join(root, 'binding.json')
  regularFile(file)
  let value
  try { value = JSON.parse(readFileSync(file, 'utf8')) } catch { fail('E_BRANCH_CORRUPT') }
  validateJson(value)
  shape(value, ['format', 'formatVersion', 'descriptor', 'creation'])
  if (value.format !== 'starmap.repository-branch-location' || value.formatVersion !== 1) fail('E_BRANCH_VERSION')
  readBranchDescriptor(value.descriptor)
  return freezeCopy(value)
}
function sourceReference(archive) {
  return { repositoryFormatVersion: 2, identityStatus: 'known', identity: archive.identity,
    snapshotDigest: digest(archive.state), repositoryRevision: archive.state.revision, archiveDigest: digest(archive) }
}
function preview(archive, policy) {
  const checked = replayRepositoryV2(archive, policy)
  const value = { format: 'starmap.repository-fork-preview', formatVersion: 1, source: sourceReference(checked), archive: checked, policyDigest: digest(policy) }
  return freezeCopy({ ...value, previewDigest: digest(value) })
}
function withSource(sourceFile, options, callback) {
  let guard, source
  try {
    if (typeof sourceFile !== 'string' || !path.isAbsolute(sourceFile)) fail('E_BRANCH_PATH')
    regularFile(sourceFile)
    const file = realpathSync(sourceFile)
    guard = new DatabaseSync(file, { readOnly: true, allowExtension: false, timeout: 0 })
    if (guard.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete') fail('E_BRANCH_SOURCE_JOURNAL')
    guard.exec('BEGIN')
    guard.prepare('SELECT count(*) AS tables FROM sqlite_schema').get() // Hold DELETE-mode source read lock through sealing.
    source = openRepositoryV2(file, { readOnly: true, policy: options.policy })
    const value = preview(source.snapshot(), options.policy ?? {})
    return callback(value)
  } catch (error) { throw translated(error) }
  finally {
    try { source?.close() } finally {
      if (guard) { try { if (guard.isTransaction) guard.exec('ROLLBACK') } finally { guard.close() } }
    }
  }
}
/** No target creation or persistent ID allocation during preview. */
export function previewRepositoryFork(sourceFile, options = {}) {
  return withSource(sourceFile, options, value => value)
}
function parse(row) {
  if (!row) fail('E_BRANCH_CORRUPT')
  let value
  try { value = JSON.parse(row.payload) } catch { fail('E_BRANCH_CORRUPT') }
  validateJson(value)
  if (digest(value) !== row.digest) fail('E_BRANCH_CORRUPT')
  return value
}
function readMetadata(db, policy, marker) {
  const value = parse(db.prepare('SELECT payload,digest FROM branch_metadata WHERE singleton=1').get())
  shape(value, ['format', 'formatVersion', 'descriptor', 'sourceArchive', 'creation', 'markerDigest'])
  if (value.format !== 'starmap.world-repository-branch' || value.formatVersion !== 3) fail('E_BRANCH_VERSION')
  const descriptor = readBranchDescriptor(value.descriptor)
  if (value.markerDigest !== digest(marker) || digest(marker.descriptor) !== digest(descriptor) || digest(marker.creation) !== digest(value.creation)) fail('E_BRANCH_CORRUPT')
  if (descriptor.origin.kind !== 'fork') fail('E_BRANCH_VERSION')
  const archive = replayRepositoryV2(value.sourceArchive, policy)
  assertBranchSource(descriptor, sourceReference(archive))
  shape(value.creation, ['status', 'operationId', 'requestDigest', 'previewDigest', 'policyDigest'])
  if (value.creation.status !== 'completed') fail('E_BRANCH_INCOMPLETE')
  opaqueId(value.creation.operationId, 'operationId')
  const expected = preview(archive, policy)
  if (value.creation.previewDigest !== expected.previewDigest || value.creation.policyDigest !== expected.policyDigest
    || value.creation.requestDigest !== digest({ operationId: value.creation.operationId, previewDigest: expected.previewDigest, binding: descriptor.binding })) fail('E_BRANCH_CORRUPT')
  return freezeCopy(value)
}
function replay(db, metadata, policy, collect = false) {
  let state = metadata.sourceArchive.state
  const history = []
  for (const stored of db.prepare('SELECT * FROM branch_history ORDER BY repository_revision').iterate()) {
    const row = parse(stored)
    shape(row, ['operationId', 'request', 'requestDigest', 'beforeDigest', 'afterDigest', 'receipt'])
    if (row.operationId !== stored.operation_id || row.operationId !== row.request?.id || !supported.has(row.request?.action?.kind)
      || row.requestDigest !== digest(row.request) || row.beforeDigest !== digest(state)) fail('E_BRANCH_CHAIN')
    const after = transitionRepositoryState(state, row.request, policy)
    shape(row.receipt, ['status', 'identity', 'operationId', 'repositoryRevision', 'worldRevision'])
    readBranchOperationManifest([{ identity: row.receipt.identity, operationId: row.operationId, requestDigest: row.requestDigest }], metadata.descriptor.identity)
    if (row.receipt.status !== 'committed' || row.receipt.operationId !== row.operationId || row.receipt.repositoryRevision !== after.revision
      || row.receipt.worldRevision !== after.world.revision || stored.repository_revision !== after.revision || row.afterDigest !== digest(after)) fail('E_BRANCH_CHAIN')
    if (collect) history.push({ ...row, after })
    state = after
  }
  const current = readRepositoryState(parse(db.prepare('SELECT payload,digest FROM branch_current WHERE singleton=1').get()), policy)
  if (digest(current) !== digest(state)) fail('E_BRANCH_CHAIN')
  return { state: current, ...(collect ? { history } : {}) }
}
function openDatabase(root, options) {
  let db
  try {
    const stat = lstatSync(root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('E_BRANCH_PATH')
    const file = path.join(root, 'world.sqlite')
    regularFile(file)
    db = new DatabaseSync(file, { readOnly: options.readOnly === true, allowExtension: false, timeout: 0 })
    if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete') fail('E_BRANCH_JOURNAL')
    const app = db.prepare('PRAGMA application_id').get().application_id, version = db.prepare('PRAGMA user_version').get().user_version
    const schema = db.prepare("SELECT name,type,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all()
    if (app === 0 && version === 0 && schema.length === 0) fail('E_BRANCH_INCOMPLETE')
    if (app !== APP || version !== 4) fail('E_BRANCH_VERSION')
    const expected = new Map([['branch_metadata', META_SQL], ['branch_current', STATE_SQL], ['branch_history', HISTORY_SQL]])
    if (schema.length !== 3 || schema.some(row => row.type !== 'table' || expected.get(row.name) !== row.sql) || db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('E_BRANCH_CORRUPT')
    if (!options.readOnly) db.exec('PRAGMA synchronous=FULL')
    return db
  } catch (error) { db?.close(); throw translated(error) }
}
export function openRepositoryBranch(target, options = {}) {
  const root = targetPath(target), policy = freezeCopy(options.policy ?? {})
  const rootStat = lstatSync(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('E_BRANCH_PATH')
  const marker = readLocationMarker(root)
  // Refuse copies before a writable SQLite open can perform journal recovery.
  // Marker alone is not completion proof: the committed DB authenticates its
  // digest, descriptor and creation reference during metadata validation below.
  if (!options.readOnly) assertBranchWriteBinding(marker.descriptor, observedBinding(realpathSync(root), options.hostId))
  const file = path.join(root, 'world.sqlite'), openedFile = regularFile(file)
  const db = openDatabase(root, options)
  let metadata, cached, version
  try {
    db.exec('BEGIN')
    metadata = readMetadata(db, policy, marker)
    if (!options.readOnly) assertBranchWriteBinding(metadata.descriptor, observedBinding(root, options.hostId))
    cached = replay(db, metadata, policy)
    version = db.prepare('PRAGMA data_version').get().data_version
    db.exec('ROLLBACK')
  } catch (error) { try { if (db.isTransaction) db.exec('ROLLBACK') } finally { db.close() }; throw translated(error) }
  function current() {
    const next = db.prepare('PRAGMA data_version').get().data_version
    if (!cached || version !== next) {
      const checked = readMetadata(db, policy, marker)
      if (digest(checked) !== digest(metadata)) fail('E_BRANCH_CORRUPT')
      cached = replay(db, metadata, policy); version = next
    }
    return cached
  }
  function read(callback) {
    if (db.isTransaction) fail('E_REPO_BUSY')
    try { db.exec('BEGIN'); return callback(current()) }
    catch (error) { throw translated(error) }
    finally { if (db.isTransaction) db.exec('ROLLBACK') }
  }
  return {
    descriptor() { return metadata.descriptor },
    creation() { return metadata.creation },
    state() { return read(value => value.state) },
    snapshot() { return read(() => freezeCopy({ ...metadata, ...replay(db, metadata, policy, true) })) },
    findOperation(id) {
      opaqueId(id, 'operationId')
      return read(() => { const row = db.prepare('SELECT payload,digest FROM branch_history WHERE operation_id=?').get(id); return row ? freezeCopy(parse(row).receipt) : undefined })
    },
    apply(input) {
      if (options.readOnly) fail('E_REPO_READONLY')
      validateJson(input); opaqueId(input?.id, 'operationId')
      if (!supported.has(input.action?.kind)) fail('E_BRANCH_REQUEST')
      const request = freezeCopy(input), requestDigest = digest(request)
      if (db.isTransaction) fail('E_REPO_BUSY')
      let attempted = false
      try {
        if (digest(readLocationMarker(root)) !== digest(marker)) fail('E_BRANCH_CORRUPT')
        db.exec('BEGIN IMMEDIATE'); phase(options, 'locked')
        const actualFile = regularFile(file)
        if (actualFile.dev !== openedFile.dev || actualFile.ino !== openedFile.ino) fail('E_BRANCH_BINDING')
        assertBranchWriteBinding(metadata.descriptor, observedBinding(realpathSync(root), options.hostId))
        const value = current(), prior = db.prepare('SELECT payload,digest FROM branch_history WHERE operation_id=?').get(request.id)
        if (prior) { const row = parse(prior); if (row.requestDigest !== requestDigest) fail('E_REPO_OPERATION_CONFLICT'); db.exec('ROLLBACK'); return freezeCopy(row.receipt) }
        const after = transitionRepositoryState(value.state, request, policy)
        const receipt = freezeCopy({ status: 'committed', identity: metadata.descriptor.identity, operationId: request.id, repositoryRevision: after.revision, worldRevision: after.world.revision })
        const row = { operationId: request.id, request, requestDigest, beforeDigest: digest(value.state), afterDigest: digest(after), receipt }
        db.prepare('UPDATE branch_current SET payload=?,digest=? WHERE singleton=1').run(JSON.stringify(after), digest(after))
        db.prepare('INSERT INTO branch_history VALUES (?,?,?,?)').run(request.id, after.revision, JSON.stringify(row), digest(row))
        phase(options, 'state-written'); phase(options, 'before-commit'); attempted = true
        db.exec('COMMIT'); cached = { state: after }; phase(options, 'committed'); return receipt
      } catch (error) {
        try { if (db.isTransaction) db.exec('ROLLBACK') } catch { /* Reopen/discover outcome. */ }
        cached = undefined
        if (attempted) fail('E_REPO_OUTCOME_UNKNOWN')
        throw translated(error)
      }
    },
    close() { db.close() },
  }
}
/** Read-only discovery validates creation, source archive and current replay.
 * A completed fork remains discoverable after later legitimate local edits. */
export function discoverRepositoryFork(target, options = {}) {
  const root = targetPath(target)
  let stat
  try { stat = lstatSync(root) } catch (error) { if (error.code === 'ENOENT') return freezeCopy({ status: 'absent' }); throw translated(error) }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('E_BRANCH_PATH')
  const files = readdirSync(root)
  if (!files.includes('world.sqlite')) return freezeCopy({ status: 'incomplete' })
  if (files.some(name => !['world.sqlite', 'world.sqlite-journal', 'binding.json'].includes(name))) fail('E_BRANCH_CORRUPT')
  if (!files.includes('binding.json')) fail('E_BRANCH_CORRUPT')
  let branch
  try {
    branch = openRepositoryBranch(root, { readOnly: true, policy: options.policy })
    return freezeCopy({ status: 'completed', descriptor: branch.descriptor(), creation: branch.creation() })
  } catch (error) {
    if (error.code === 'E_BRANCH_INCOMPLETE') return freezeCopy({ status: 'incomplete' })
    if (error.code === 'E_REPO_IO' && files.includes('world.sqlite-journal')) return freezeCopy({ status: 'recovery-required' })
    throw error
  } finally { branch?.close() }
}
/** Exclusive target creation; transaction seals metadata, full parent archive,
 * baseline facts and empty local log. Incomplete targets are never overwritten. */
export function forkRepositoryToDirectory(sourceFile, target, input, operationId, options = {}) {
  opaqueId(operationId, 'operationId'); validateJson(input)
  shape(input, ['format', 'formatVersion', 'source', 'archive', 'policyDigest', 'previewDigest'])
  const policy = freezeCopy(options.policy ?? {}), expected = preview(input.archive, policy)
  if (digest(input) !== digest(expected)) fail('E_BRANCH_PREVIEW')
  const root = targetPath(target), binding = observedBinding(root, options.hostId)
  const requestDigest = digest({ operationId, previewDigest: input.previewDigest, binding })
  const existing = discoverRepositoryFork(root, { policy })
  if (existing.status === 'completed') {
    if (existing.creation.operationId !== operationId || existing.creation.requestDigest !== requestDigest) fail('E_BRANCH_EXISTS')
    // Historical completed result; a later source edit does not undo creation.
    return existing
  }
  if (existing.status !== 'absent') fail(existing.status === 'recovery-required' ? 'E_BRANCH_RECOVERY_REQUIRED' : 'E_BRANCH_INCOMPLETE')
  return withSource(sourceFile, { policy }, current => {
    if (digest(current) !== digest(input)) fail('E_BRANCH_SOURCE_CHANGED')
    let db, attempted = false
    try {
      mkdirSync(root, { mode: 0o700 }); phase(options, 'directory-created')
      const file = path.join(root, 'world.sqlite'), fd = openSync(file, 'wx', 0o600)
      try { fsyncSync(fd) } finally { closeSync(fd) }
      const descriptor = readBranchDescriptor({ format: 'starmap.repository-branch', formatVersion: 1,
        identity: { libraryId: current.archive.identity.libraryId, branchId: randomUUID(), genesisId: randomUUID() }, origin: { kind: 'fork', source: current.source }, binding })
      const creation = { status: 'completed', operationId, requestDigest, previewDigest: input.previewDigest, policyDigest: input.policyDigest }
      const marker = { format: 'starmap.repository-branch-location', formatVersion: 1, descriptor, creation }
      const markerFd = openSync(path.join(root, 'binding.json'), 'wx', 0o600)
      try { writeFileSync(markerFd, JSON.stringify(marker)); fsyncSync(markerFd) } finally { closeSync(markerFd) }
      const metadata = { format: 'starmap.world-repository-branch', formatVersion: 3, descriptor, sourceArchive: current.archive, creation, markerDigest: digest(marker) }
      db = new DatabaseSync(file, { allowExtension: false, timeout: 0 })
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE')
      db.exec(META_SQL); db.exec(STATE_SQL); db.exec(HISTORY_SQL)
      db.exec(`PRAGMA application_id=${APP}; PRAGMA user_version=4`)
      db.prepare('INSERT INTO branch_metadata VALUES (1,?,?)').run(JSON.stringify(metadata), digest(metadata))
      db.prepare('INSERT INTO branch_current VALUES (1,?,?)').run(JSON.stringify(current.archive.state), digest(current.archive.state))
      phase(options, 'metadata-written'); phase(options, 'before-seal'); attempted = true
      db.exec('COMMIT'); db.close(); db = undefined
      phase(options, 'completed')
      return discoverRepositoryFork(root, { policy })
    } catch (error) {
      if (db) { try { if (db.isTransaction) db.exec('ROLLBACK') } finally { db.close() } }
      if (attempted) fail('E_BRANCH_OUTCOME_UNKNOWN')
      if (error.code === 'EEXIST') fail('E_BRANCH_EXISTS')
      throw translated(error)
    }
  })
}
