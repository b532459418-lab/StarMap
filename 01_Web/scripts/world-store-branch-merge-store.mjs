/** Independent experimental SQLite store, restricted to explicit synthetic
 * lab directories. Host callbacks test an authorization protocol, not OS user
 * permissions. No App/private-root discovery, migrations or automatic retry.
 */
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { freezeCopy, jsonKey, opaqueId, shape } from '../src/worldgraph/store/schema.ts'
import { RepositoryError } from './world-store-repository.mjs'
import { repositoryStateDigest as digest } from './world-store-repository-v2-contract.mjs'
import { openRepositoryV2 } from './world-store-repository-v2.mjs'
import { openRepositoryBranch } from './world-store-branch.mjs'
import { previewRepositoryArchive } from './world-store-branch-snapshot.mjs'
import { checkRepositoryMergeArchiveInputs } from './world-store-branch-merge-archive-model.mjs'
import { createRepositoryMergeSavedArchive, readRepositoryMergeSavedArchive,
  projectRepositoryMergeStoreRequest, appendRepositoryMergeSavedEvent } from './world-store-branch-merge-store-contract.mjs'

export const MERGE_STORE_APP_ID = 0x534d4737
export const MERGE_STORE_SQLITE_VERSION = 1
const MAX_BYTES = 128 * 1024 * 1024, MAX_ROWS = 128
const hosts = new WeakMap()
const fail = code => { throw new RepositoryError(code) }
const equal = (a, b) => jsonKey(a) === jsonKey(b)
const SQL = Object.freeze({
  store_metadata: 'CREATE TABLE store_metadata (singleton INTEGER PRIMARY KEY CHECK(singleton=1), payload TEXT NOT NULL, digest TEXT NOT NULL, recovery_epoch INTEGER NOT NULL CHECK(recovery_epoch>=0)) STRICT',
  store_current: 'CREATE TABLE store_current (singleton INTEGER PRIMARY KEY CHECK(singleton=1), payload TEXT NOT NULL, digest TEXT NOT NULL) STRICT',
  archive_nodes: 'CREATE TABLE archive_nodes (node_id TEXT PRIMARY KEY, payload TEXT NOT NULL, digest TEXT NOT NULL) STRICT',
  source_archives: 'CREATE TABLE source_archives (archive_digest TEXT PRIMARY KEY, payload TEXT NOT NULL, digest TEXT NOT NULL) STRICT',
  store_events: 'CREATE TABLE store_events (operation_id TEXT PRIMARY KEY, repository_revision INTEGER NOT NULL UNIQUE, payload TEXT NOT NULL, digest TEXT NOT NULL) STRICT',
  local_receipts: 'CREATE TABLE local_receipts (operation_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL) STRICT',
})
function translated(error) {
  if (error?.code?.startsWith('E_')) return error
  return new RepositoryError([5, 6, 261].includes(error?.errcode) ? 'E_REPO_BUSY' : 'E_MERGE_STORE_IO')
}
function phase(options, name) {
  const value = options.unsafeTestPhase?.(name)
  if (value && typeof value.then === 'function') fail('E_MERGE_STORE_ASYNC')
}
function regular(file, allowEmpty = false) {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (!allowEmpty && stat.size === 0) || stat.size > MAX_BYTES) fail('E_MERGE_STORE_PATH')
  return stat
}
function fileIdentity(file) {
  const stat = lstatSync(file, { bigint: true })
  return { dev: String(stat.dev), ino: String(stat.ino) }
}
function host(options) {
  const value = hosts.get(options?.host)
  if (!value) fail('E_MERGE_STORE_AUTHORITY')
  return value
}
function rootPath(input, context, exists = true) {
  if (!equal(fileIdentity(context.sandboxRoot), context.labIdentity)) fail('E_MERGE_STORE_BINDING')
  if (typeof input !== 'string' || !path.isAbsolute(input) || path.normalize(input) !== input) fail('E_MERGE_STORE_PATH')
  if (!input.startsWith(context.sandboxRoot + path.sep)) fail('E_MERGE_STORE_PATH')
  const name = path.basename(input)
  if (!name || name === '.' || name === '..' || (process.platform === 'win32' && (/[. :]+$/.test(name) || /:/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)))) fail('E_MERGE_STORE_PATH')
  let checkedParent = context.sandboxRoot
  for (const part of path.relative(context.sandboxRoot, path.dirname(input)).split(path.sep).filter(Boolean)) {
    checkedParent = path.join(checkedParent, part)
    const stat = lstatSync(checkedParent)
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('E_MERGE_STORE_PATH')
  }
  const parent = realpathSync(checkedParent), result = path.join(parent, name)
  if (result !== input || !result.startsWith(context.sandboxRoot + path.sep)) fail('E_MERGE_STORE_PATH')
  if (exists) {
    const stat = lstatSync(result)
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(result) !== result) fail('E_MERGE_STORE_PATH')
  }
  return result
}
function binding(root, context) {
  const file = path.join(root, 'world.sqlite')
  return { hostId: context.hostId, locationDigest: digest(process.platform === 'win32' ? file.toLowerCase() : file) }
}
function authorize(context, input) {
  const result = context.authorize(freezeCopy(input))
  if (result && typeof result.then === 'function') fail('E_MERGE_STORE_ASYNC')
  if (result !== true) fail('E_MERGE_STORE_AUTHORITY')
}
/** Only trusted same-process bootstrap code can register a context. Its
 * laboratory restriction and callback are not a production OS permission. */
export function createRepositoryMergeStoreHost(input) {
  const tempRoot = realpathSync(tmpdir()), requested = input.sandboxRoot
  if (typeof requested !== 'string' || path.normalize(requested) !== requested || path.dirname(requested) !== tempRoot
    || !path.basename(requested).startsWith('starmap-merge-store-')) fail('E_MERGE_STORE_LAB')
  const stat = lstatSync(requested)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('E_MERGE_STORE_LAB')
  const sandboxRoot = realpathSync(requested)
  if (sandboxRoot !== requested) fail('E_MERGE_STORE_LAB')
  opaqueId(input.hostId, 'hostId')
  if (input.authorize !== undefined && typeof input.authorize !== 'function') fail('E_MERGE_STORE_AUTHORITY')
  const token = Object.freeze({})
  hosts.set(token, { sandboxRoot, labIdentity: fileIdentity(sandboxRoot), hostId: input.hostId, authorize: input.authorize ?? (() => false) })
  return token
}
function exclusive(file, text) {
  const fd = openSync(file, 'wx', 0o600)
  try { writeFileSync(fd, text); fsyncSync(fd) } finally { closeSync(fd) }
}
function readJson(file) {
  const stat = regular(file)
  if (stat.size > 128 * 1024) fail('E_MERGE_STORE_SIZE')
  let value
  try { value = JSON.parse(readFileSync(file, 'utf8')) } catch { fail('E_MERGE_STORE_CORRUPT') }
  checkRepositoryMergeArchiveInputs([value])
  return value
}
function checkFiles(root) {
  const names = readdirSync(root)
  if (names.some(name => !['world.sqlite', 'world.sqlite-journal', 'binding.json'].includes(name))) fail('E_MERGE_STORE_CORRUPT')
  if (names.includes('world.sqlite-journal')) regular(path.join(root, 'world.sqlite-journal'), true)
}
function schema(db) {
  const app = db.prepare('PRAGMA application_id').get().application_id, version = db.prepare('PRAGMA user_version').get().user_version
  const rows = db.prepare("SELECT name,type,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all()
  if (app === 0 && version === 0 && rows.length === 0) fail('E_MERGE_STORE_INCOMPLETE')
  if (app !== MERGE_STORE_APP_ID || version !== MERGE_STORE_SQLITE_VERSION) fail('E_MERGE_STORE_VERSION')
  if (rows.length !== Object.keys(SQL).length || rows.some(row => row.type !== 'table' || SQL[row.name] !== row.sql)) fail('E_MERGE_STORE_SCHEMA')
  if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete') fail('E_MERGE_STORE_JOURNAL')
  if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('E_MERGE_STORE_CORRUPT')
}
function parse(row) {
  if (!row || typeof row.payload !== 'string' || Buffer.byteLength(row.payload) > MAX_BYTES) fail('E_MERGE_STORE_CORRUPT')
  let value
  try { value = JSON.parse(row.payload) } catch { fail('E_MERGE_STORE_CORRUPT') }
  checkRepositoryMergeArchiveInputs([value])
  if (digest(value) !== row.digest) fail('E_MERGE_STORE_CORRUPT')
  return value
}
function rows(db, table, order) {
  if (db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count > MAX_ROWS) fail('E_MERGE_STORE_SIZE')
  return db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()
}
function material(saved) {
  const projection = saved.projection
  const raw = { kind: 'archive', archive: projection }
  const nodes = projection.format === 'starmap.repository-continuous-merge-model'
    ? projection.nodes : [{ nodeId: digest(raw), ...raw }]
  const sources = new Map()
  function visit(value) {
    const key = digest(value)
    if (sources.has(key)) return
    sources.set(key, value)
    if (sources.size > MAX_ROWS) fail('E_MERGE_STORE_SIZE')
    if (value.format === 'starmap.repository-merge-saved') {
      visit(value.baseArchive.sourceArchive)
      for (const event of value.events) if (event.storeRequest.kind === 'merge') visit(event.storeRequest.sourceArchive)
    } else if (value.formatVersion === 3) visit(value.sourceArchive)
  }
  visit(saved.baseArchive.sourceArchive)
  for (const event of saved.events) if (event.storeRequest.kind === 'merge') visit(event.storeRequest.sourceArchive)
  const result = { nodes, sources: [...sources].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0), state: projection.state }
  checkRepositoryMergeArchiveInputs([result])
  return result
}
function readAll(db, marker, policy, markerIdentity) {
  schema(db)
  if (db.prepare('SELECT count(*) AS count FROM store_metadata').get().count !== 1 || db.prepare('SELECT count(*) AS count FROM store_current').get().count !== 1) fail('E_MERGE_STORE_CORRUPT')
  const meta = parse(db.prepare('SELECT * FROM store_metadata WHERE singleton=1').get())
  shape(meta, ['format', 'formatVersion', 'baseArchive', 'markerDigest', 'markerIdentity', 'policyDigest', 'creationId'])
  if (meta.format !== 'starmap.repository-merge-store-metadata' || meta.formatVersion !== 1
    || meta.markerDigest !== digest(marker) || meta.policyDigest !== digest(policy)
    || !equal(meta.baseArchive.descriptor, marker.descriptor) || meta.creationId !== marker.creationId) fail('E_MERGE_STORE_CORRUPT')
  if (markerIdentity && !equal(meta.markerIdentity, markerIdentity)) fail('E_MERGE_STORE_BINDING')
  const eventRows = rows(db, 'store_events', 'repository_revision'), receiptRows = rows(db, 'local_receipts', 'operation_id')
  if (receiptRows.length !== eventRows.length) fail('E_MERGE_STORE_CORRUPT')
  const events = eventRows.map(row => {
    const event = parse(row)
    if (row.operation_id !== event.storeRequest.operationId || row.repository_revision !== event.receipt.repositoryRevision) fail('E_MERGE_STORE_CORRUPT')
    return event
  })
  const initial = createRepositoryMergeSavedArchive(meta.baseArchive, policy)
  let derived = initial
  for (const event of events) derived = appendRepositoryMergeSavedEvent(derived, event.storeRequest, event.receipt, policy)
  const saved = readRepositoryMergeSavedArchive(derived, policy), expected = material(saved)
  const receipts = new Map(receiptRows.map(row => {
    const receipt = parse(row)
    if (row.operation_id !== receipt.operationId || row.request_digest !== receipt.requestDigest) fail('E_MERGE_STORE_CORRUPT')
    return [row.operation_id, receipt]
  }))
  for (const event of saved.events) if (!equal(receipts.get(event.storeRequest.operationId), event.receipt)) fail('E_MERGE_STORE_CORRUPT')
  const actualNodes = rows(db, 'archive_nodes', 'node_id').map(row => {
    const node = parse(row); if (row.node_id !== node.nodeId) fail('E_MERGE_STORE_CORRUPT'); return node
  })
  const expectedNodes = [...expected.nodes].sort((a, b) => a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0)
  const actualSources = rows(db, 'source_archives', 'archive_digest').map(row => {
    const source = parse(row); if (row.archive_digest !== digest(source)) fail('E_MERGE_STORE_CORRUPT'); return [row.archive_digest, source]
  })
  if (!equal(actualNodes, expectedNodes) || !equal(actualSources, expected.sources)
    || !equal(parse(db.prepare('SELECT * FROM store_current WHERE singleton=1').get()), expected.state)) fail('E_MERGE_STORE_CORRUPT')
  return { meta, saved, receipts }
}
function writeMaterial(db, saved, onSources = () => {}) {
  const value = material(saved)
  db.exec('DELETE FROM archive_nodes; DELETE FROM source_archives')
  const putNode = db.prepare('INSERT INTO archive_nodes VALUES (?,?,?)'), putSource = db.prepare('INSERT INTO source_archives VALUES (?,?,?)')
  for (const node of value.nodes) putNode.run(node.nodeId, JSON.stringify(node), digest(node))
  for (const [key, source] of value.sources) putSource.run(key, JSON.stringify(source), digest(source))
  onSources()
  db.prepare('INSERT OR REPLACE INTO store_current VALUES (1,?,?)').run(JSON.stringify(value.state), digest(value.state))
  const bytes = db.prepare('PRAGMA page_count').get().page_count * db.prepare('PRAGMA page_size').get().page_size
  if (bytes > MAX_BYTES) fail('E_MERGE_STORE_SIZE')
}
function withSource(input, options, callback) {
  const context = host(options), root = rootPath(input, context), rootId = fileIdentity(root), file = path.join(root, 'world.sqlite')
  regular(file)
  const fileId = fileIdentity(file), markerFile = path.join(root, 'binding.json')
  let markerDigest = null, markerIdentity, reader, db
  try {
    if (readdirSync(root).includes('binding.json')) { markerDigest = digest(readJson(markerFile)); markerIdentity = fileIdentity(markerFile) }
    if (readdirSync(root).includes('world.sqlite-journal')) regular(path.join(root, 'world.sqlite-journal'), true)
    db = new DatabaseSync(file, { readOnly: true, allowExtension: false, timeout: 0 })
    if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete') fail('E_MERGE_STORE_JOURNAL')
    db.exec('BEGIN'); db.prepare('SELECT count(*) FROM sqlite_schema').get()
    const app = db.prepare('PRAGMA application_id').get().application_id
    const historyTable = app === 0x534d4736 ? 'branch_history' : app === 0x534d4735 ? 'operation_history' : null
    if (historyTable && db.prepare(`SELECT count(*) AS count FROM ${historyTable}`).get().count > MAX_ROWS) fail('E_MERGE_STORE_SIZE')
    reader = app === MERGE_STORE_APP_ID ? openRepositoryMergeStore(root, { ...options, readOnly: true })
      : app === 0x534d4736 ? openRepositoryBranch(root, { readOnly: true, policy: options.policy })
        : openRepositoryV2(file, { readOnly: true, policy: options.policy })
    const archive = reader.snapshot()
    checkRepositoryMergeArchiveInputs([archive, options.policy ?? {}])
    const verify = () => {
      rootPath(root, context)
      regular(file)
      if (!equal(rootId, fileIdentity(root)) || !equal(fileId, fileIdentity(file)) || realpathSync(root) !== root) fail('E_MERGE_STORE_BINDING')
      if (markerDigest !== null && digest(readJson(markerFile)) !== markerDigest) fail('E_MERGE_STORE_BINDING')
      if (markerIdentity && !equal(fileIdentity(markerFile), markerIdentity)) fail('E_MERGE_STORE_BINDING')
    }
    verify(); return callback(archive, verify, root)
  } catch (error) { throw translated(error) }
  finally {
    try { reader?.close() } finally { if (db) { try { if (db.isTransaction) db.exec('ROLLBACK') } finally { db.close() } } }
  }
}
export function previewRepositoryMergeStoreCreation(source, options = {}) {
  return withSource(source, options, archive => {
    if (![2, 3].includes(archive.formatVersion) || archive.format === 'starmap.repository-merge-saved') fail('E_MERGE_STORE_SOURCE_VERSION')
    const value = previewRepositoryArchive(archive, options.policy ?? {})
    return freezeCopy({ ...value, sourceDigest: digest(archive) })
  })
}
export function createRepositoryMergeStore(source, target, preview, operationId, options = {}) {
  checkRepositoryMergeArchiveInputs([preview, operationId, options.policy ?? {}])
  opaqueId(operationId, 'operationId')
  const context = host(options), root = rootPath(target, context, false), policy = freezeCopy(options.policy ?? {})
  let exists = false
  try { lstatSync(root); exists = true } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (exists) {
    const prior = openRepositoryMergeStore(root, { ...options, readOnly: true })
    try {
      const archive = prior.snapshot(), base = archive.baseArchive, actualBinding = binding(root, context)
      if (!equal(base.descriptor.binding, actualBinding)) fail('E_MERGE_STORE_BINDING')
      const expected = previewRepositoryArchive(base.sourceArchive, policy)
      if (base.creation.operationId !== operationId || !equal(preview, { ...expected, sourceDigest: digest(base.sourceArchive) })) fail('E_MERGE_STORE_EXISTS')
      return freezeCopy({ status: 'created', identity: base.descriptor.identity, operationId,
        savedDigest: createRepositoryMergeSavedArchive(base, policy).savedDigest })
    } finally { prior.close() }
  }
  return withSource(source, options, (archive, verify) => {
    const current = previewRepositoryArchive(archive, policy)
    if (!equal(preview, { ...current, sourceDigest: digest(archive) })) fail('E_MERGE_STORE_STALE')
    const actualBinding = binding(root, context)
    authorize(context, { kind: 'create', root, operationId, binding: actualBinding, sourceDigest: digest(archive), policyDigest: digest(policy) })
    rootPath(root, context, false); verify()
    const identity = { libraryId: current.source.identity.libraryId, branchId: randomUUID(), genesisId: randomUUID() }
    const descriptor = { format: 'starmap.repository-branch', formatVersion: 1, identity, origin: { kind: 'fork', source: current.source }, binding: actualBinding }
    const creation = { status: 'completed', operationId, requestDigest: digest({ operationId, previewDigest: current.previewDigest, binding: actualBinding }), previewDigest: current.previewDigest, policyDigest: digest(policy) }
    const baseArchive = { format: 'starmap.world-repository-branch', formatVersion: 3, descriptor, sourceArchive: archive, creation,
      markerDigest: digest({ format: 'starmap.repository-branch-location', formatVersion: 1, descriptor, creation }), state: archive.state, history: [] }
    const saved = createRepositoryMergeSavedArchive(baseArchive, policy)
    let marker, meta, createdRootIdentity, createdFileIdentity, createdMarkerIdentity
    const targetFile = path.join(root, 'world.sqlite'), markerFile = path.join(root, 'binding.json')
    const verifyTarget = () => {
      rootPath(root, context)
      if (!equal(fileIdentity(root), createdRootIdentity)) fail('E_MERGE_STORE_BINDING')
      if (createdFileIdentity) {
        regular(targetFile, true)
        if (!equal(fileIdentity(targetFile), createdFileIdentity)) fail('E_MERGE_STORE_BINDING')
      }
      if (createdMarkerIdentity && (!equal(fileIdentity(markerFile), createdMarkerIdentity) || !equal(readJson(markerFile), marker))) fail('E_MERGE_STORE_BINDING')
      checkFiles(root)
    }
    let db, attempted = false
    try {
      mkdirSync(root, { mode: 0o700 }); createdRootIdentity = fileIdentity(root)
      phase(options, 'directory-created'); verifyTarget()
      exclusive(targetFile, ''); createdFileIdentity = fileIdentity(targetFile)
      marker = { format: 'starmap.repository-merge-store-location', formatVersion: 1, descriptor, creationId: operationId,
        rootIdentity: createdRootIdentity, fileIdentity: createdFileIdentity }
      exclusive(markerFile, JSON.stringify(marker)); createdMarkerIdentity = fileIdentity(markerFile)
      meta = { format: 'starmap.repository-merge-store-metadata', formatVersion: 1, baseArchive, markerDigest: digest(marker),
        markerIdentity: createdMarkerIdentity, policyDigest: digest(policy), creationId: operationId }
      phase(options, 'files-created'); verifyTarget()
      db = new DatabaseSync(targetFile, { allowExtension: false, timeout: 0 }); verifyTarget()
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE')
      for (const sql of Object.values(SQL)) db.exec(sql)
      db.exec(`PRAGMA application_id=${MERGE_STORE_APP_ID}; PRAGMA user_version=${MERGE_STORE_SQLITE_VERSION}`)
      db.prepare('INSERT INTO store_metadata VALUES (1,?,?,0)').run(JSON.stringify(meta), digest(meta))
      writeMaterial(db, saved); verify(); verifyTarget(); phase(options, 'before-create-commit'); verifyTarget(); verify()
      attempted = true; db.exec('COMMIT'); phase(options, 'created')
      return freezeCopy({ status: 'created', identity, operationId, savedDigest: saved.savedDigest })
    } catch (error) {
      try { if (db?.isTransaction) db.exec('ROLLBACK') } catch { /* Read-only discovery is required. */ }
      if (attempted) fail('E_REPO_OUTCOME_UNKNOWN')
      throw translated(error)
    } finally { db?.close() }
  })
}
export function openRepositoryMergeStore(target, options = {}) {
  const context = host(options), root = rootPath(target, context), rootId = fileIdentity(root), file = path.join(root, 'world.sqlite')
  checkFiles(root)
  const fileStat = regular(file, true)
  const fileId = fileIdentity(file)
  const markerFile = path.join(root, 'binding.json'), marker = readJson(markerFile), policy = freezeCopy(options.policy ?? {})
  checkRepositoryMergeArchiveInputs([marker, policy])
  shape(marker, ['format', 'formatVersion', 'descriptor', 'creationId', 'rootIdentity', 'fileIdentity'])
  if (marker.format !== 'starmap.repository-merge-store-location' || marker.formatVersion !== 1) fail('E_MERGE_STORE_VERSION')
  const actualBinding = binding(root, context)
  const sameLocation = marker.descriptor?.binding?.locationDigest === actualBinding.locationDigest
  const markerIdentity = (!options.readOnly || sameLocation) ? fileIdentity(markerFile) : undefined
  if ((!options.readOnly || sameLocation) && (!equal(fileIdentity(root), marker.rootIdentity) || !equal(fileIdentity(file), marker.fileIdentity))) fail('E_MERGE_STORE_BINDING')
  if (!options.readOnly && !equal(marker.descriptor?.binding, actualBinding)) fail('E_MERGE_STORE_BINDING')
  if (fileStat.size === 0) fail('E_MERGE_STORE_INCOMPLETE')
  if (!options.readOnly) {
    if (!equal(marker.descriptor?.binding, actualBinding)) fail('E_MERGE_STORE_BINDING')
    const journal = readdirSync(root).includes('world.sqlite-journal')
    if (journal && !options.recovery) fail('E_MERGE_STORE_RECOVERY_REQUIRED')
    let probe
    try {
      probe = new DatabaseSync(file, { readOnly: true, allowExtension: false, timeout: 0 })
      probe.exec('BEGIN'); readAll(probe, marker, policy, markerIdentity)
    } catch (error) {
      const code = Number(error?.errcode) & 255
      if (!(journal && options.recovery && code === 8)) throw translated(error)
    } finally { if (probe) { try { if (probe.isTransaction) probe.exec('ROLLBACK') } finally { probe.close() } } }
    authorize(context, { kind: options.recovery ? 'recover' : 'open', root, identity: marker.descriptor.identity,
      binding: actualBinding, markerDigest: digest(marker), fileIdentity: marker.fileIdentity })
  }
  let db
  const verifyPath = () => {
    rootPath(root, context)
    regular(file)
    if (!equal(rootId, fileIdentity(root)) || !equal(fileId, fileIdentity(file)) || realpathSync(root) !== root) fail('E_MERGE_STORE_BINDING')
    if (!equal(readJson(path.join(root, 'binding.json')), marker)) fail('E_MERGE_STORE_BINDING')
    if (markerIdentity && !equal(fileIdentity(markerFile), markerIdentity)) fail('E_MERGE_STORE_BINDING')
    checkFiles(root)
    if (!options.readOnly && !equal(marker.descriptor.binding, binding(root, context))) fail('E_MERGE_STORE_BINDING')
  }
  function read(callback) {
    if (db.isTransaction) fail('E_REPO_BUSY')
    try {
      verifyPath(); db.exec('BEGIN')
      const value = readAll(db, marker, policy, markerIdentity); verifyPath()
      const result = callback(value); verifyPath(); return result
    }
    catch (error) {
      if (options.readOnly && readdirSync(root).includes('world.sqlite-journal') && (Number(error?.errcode) & 255) === 8) fail('E_MERGE_STORE_RECOVERY_REQUIRED')
      throw translated(error)
    } finally { if (db.isTransaction) db.exec('ROLLBACK') }
  }
  let recoveryAttempted = false
  try {
    verifyPath()
    db = new DatabaseSync(file, { readOnly: options.readOnly === true, allowExtension: false, timeout: 0 })
    verifyPath()
    if (!options.readOnly) db.exec('PRAGMA synchronous=FULL')
    read(value => value.saved)
    if (options.recovery && !options.readOnly) {
      // SQLite can ignore a cold pre-COMMIT journal on a read. An explicitly
      // authorized maintenance transaction re-seals identical metadata so
      // SQLite owns cleanup; no domain request is replayed or recorded.
      verifyPath(); db.exec('BEGIN IMMEDIATE')
      readAll(db, marker, policy, markerIdentity); verifyPath()
      db.exec('UPDATE store_metadata SET recovery_epoch=recovery_epoch+1 WHERE singleton=1')
      phase(options, 'before-recover-commit'); verifyPath()
      recoveryAttempted = true; db.exec('COMMIT'); phase(options, 'recovered')
      read(value => value.saved)
    }
  } catch (error) {
    if (db) { try { if (db.isTransaction) db.exec('ROLLBACK') } finally { db.close() } }
    if (recoveryAttempted) fail('E_REPO_OUTCOME_UNKNOWN')
    throw translated(error)
  }
  return {
    state() { return read(value => value.saved.projection.state) },
    snapshot() { return read(value => value.saved) },
    withSnapshot(callback) {
      if (typeof callback !== 'function') fail('E_MERGE_STORE_ASYNC')
      return read(value => {
        let active = true
        const verify = () => {
          if (!active) fail('E_MERGE_STORE_ASYNC')
          verifyPath()
        }
        try {
          const result = callback(value.saved, verify)
          if (result && typeof result.then === 'function') fail('E_MERGE_STORE_ASYNC')
          return result
        } finally { active = false }
      })
    },
    findOperation(id) { opaqueId(id, 'operationId'); return read(value => value.receipts.get(id)) },
    apply(input, applyOptions = {}) {
      if (options.readOnly) fail('E_REPO_READONLY')
      checkRepositoryMergeArchiveInputs([input, policy]); opaqueId(input?.operationId, 'operationId')
      shape(input, ['format', 'formatVersion', 'kind', 'operationId', 'targetSavedDigest', 'policyDigest', 'pureRequest', ...(input.kind === 'merge' ? ['sourceArchive'] : [])])
      if (input.format !== 'starmap.repository-merge-store-request' || input.formatVersion !== 1 || !['operation', 'merge'].includes(input.kind)) fail('E_MERGE_STORE_REQUEST')
      const request = freezeCopy(input), requestDigest = digest(request)
      if (db.isTransaction) fail('E_REPO_BUSY')
      let attempted = false
      try {
        verifyPath(); phase(options, 'before-begin'); db.exec('BEGIN IMMEDIATE'); phase(options, 'locked'); verifyPath()
        const current = readAll(db, marker, policy, markerIdentity), prior = current.receipts.get(request.operationId)
        authorize(context, { kind: 'apply', root, identity: marker.descriptor.identity, binding: actualBinding,
          operationId: request.operationId, action: request.kind === 'operation' ? request.pureRequest?.operation?.action?.kind : 'merge',
          requestDigest, targetSavedDigest: current.saved.savedDigest,
          sourceDigest: request.kind === 'merge' ? digest(request.sourceArchive) : null, policyDigest: digest(policy) })
        if (prior) {
          if (prior.requestDigest !== requestDigest) fail('E_REPO_OPERATION_CONFLICT')
          db.exec('ROLLBACK'); return prior
        }
        const commit = (actualSource, verifySource = () => {}) => {
          if (request.kind === 'merge' && !equal(actualSource, request.sourceArchive)) fail('E_MERGE_STORE_SOURCE_CHANGED')
          const projected = projectRepositoryMergeStoreRequest(request, current.saved, policy)
          const next = appendRepositoryMergeSavedEvent(current.saved, request, projected.expectedReceipt, policy)
          verifySource(); verifyPath(); writeMaterial(db, next, () => phase(options, 'sources-written'))
          // current facts/reviews/identities/tombstones are in the same transaction.
          phase(options, 'state-written')
          const event = next.events.at(-1), receipt = event.receipt
          db.prepare('INSERT INTO store_events VALUES (?,?,?,?)').run(request.operationId, receipt.repositoryRevision, JSON.stringify(event), digest(event))
          db.prepare('INSERT INTO local_receipts VALUES (?,?,?,?)').run(request.operationId, requestDigest, JSON.stringify(receipt), digest(receipt))
          phase(options, 'receipt-written'); verifySource(); verifyPath(); phase(options, 'before-commit'); verifySource(); verifyPath()
          attempted = true; db.exec('COMMIT'); phase(options, 'committed')
          return freezeCopy(receipt)
        }
        if (request.kind === 'merge') {
          if (rootPath(applyOptions.source, context) === root) fail('E_MERGE_STORE_SELF_SOURCE')
          return withSource(applyOptions.source, options, commit)
        }
        return commit(null)
      } catch (error) {
        try { if (db.isTransaction) db.exec('ROLLBACK') } catch { /* Do not retry an unknown COMMIT. */ }
        if (attempted) fail('E_REPO_OUTCOME_UNKNOWN')
        throw translated(error)
      }
    },
    close() { db.close() },
  }
}
export function discoverRepositoryMergeStore(target, options = {}) {
  const context = host(options), root = rootPath(target, context, false)
  try { lstatSync(root) } catch (error) { if (error.code === 'ENOENT') return freezeCopy({ status: 'absent' }); throw translated(error) }
  let store
  try {
    store = openRepositoryMergeStore(root, { ...options, readOnly: true })
    const archive = store.snapshot()
    return freezeCopy({ status: 'completed', identity: archive.baseArchive.descriptor.identity, creationId: archive.baseArchive.creation.operationId,
      savedDigest: archive.savedDigest, ...(options.operationId ? { operation: store.findOperation(options.operationId) ?? null } : {}) })
  } catch (error) {
    if (['E_MERGE_STORE_INCOMPLETE', 'ENOENT'].includes(error.code)) return freezeCopy({ status: 'incomplete' })
    if (error.code === 'E_MERGE_STORE_RECOVERY_REQUIRED') return freezeCopy({ status: 'recovery-required' })
    throw translated(error)
  } finally { store?.close() }
}
/** Explicit authorized recovery only. Never resends an operation. */
export function recoverRepositoryMergeStore(target, options = {}) {
  const store = openRepositoryMergeStore(target, { ...options, readOnly: false, recovery: true })
  try { store.snapshot() } finally { store.close() }
  return discoverRepositoryMergeStore(target, options)
}
