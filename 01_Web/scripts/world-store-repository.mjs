/** RD-08 G3 experimental Node host. One SQLite authority for facts, the G2
 * allocation ledger, proposal states and durable operation receipts. Not wired
 * to the App, V2 files, backup CLI, permissions or a network endpoint. */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, openSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { applyStoreCommands } from '../src/worldgraph/store/commands.ts'
import { planStoreMerge } from '../src/worldgraph/store/conflicts.ts'
import { acceptStoreProposal, readStoreProposal, rejectStoreProposal } from '../src/worldgraph/store/proposals.ts'
import { freezeCopy, jsonKey, opaqueId, readWorldStore, revision, shape, StoreError, STORE_TABLES, validateJson } from '../src/worldgraph/store/schema.ts'
import { identityKey, readBridgeManifest } from '../src/data/canonical/storeBridgeIdentity.ts'

const APPLICATION_ID = 0x534d4733
const FORMAT = 'starmap.world-repository'
const STATE_SQL = 'CREATE TABLE repository_state (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL CHECK(revision >= 0), payload TEXT NOT NULL, digest TEXT NOT NULL) STRICT'
const RECEIPT_SQL = 'CREATE TABLE operation_receipts (id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, repository_revision INTEGER NOT NULL, world_revision INTEGER NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL) STRICT'
const hash = value => createHash('sha256').update(value).digest('hex')
const emptyIdentities = () => ({ format: 'starmap.v2-store-identities', version: 1, identities: [] })
export class RepositoryError extends Error {
  constructor(code) { super(code); this.code = code }
}
const fail = code => { throw new RepositoryError(code) }
const translate = error => {
  if (error instanceof RepositoryError || error instanceof StoreError) return error
  return new RepositoryError(error?.errcode === 5 || error?.errcode === 6 ? 'E_REPO_BUSY' : 'E_REPO_IO')
}

/** A G2 manifest is append-only. Absent mappings are tombstones, not recycled
 * identities. It maps legacy allocation, not every native Core entity type. */
function validateIdentityBindings(world, identities) {
  for (const mapping of identities.identities) {
    const entity = world.entities.find(row => row.id === mapping.id), entry = world.entries.find(row => row.id === mapping.id)
    if (mapping.kind === 'entry') {
      if (entity || (entry && (entry.source.sourceId !== mapping.sourceId || entry.source.recordId !== mapping.recordId))) fail('E_REPO_IDENTITY')
    } else {
      if (entry || (entity && (entity.source.sourceId !== mapping.sourceId || entity.source.recordId !== mapping.recordId || entity.typeId !== `bridge:${mapping.kind}`))) fail('E_REPO_IDENTITY')
    }
  }
  for (const row of [...world.entries, ...world.entities.filter(e => ['bridge:media', 'bridge:journey'].includes(e.typeId))]) {
    if (!row.source.sourceId.startsWith('v2:')) continue
    const kind = 'layerId' in row ? 'entry' : row.typeId.slice('bridge:'.length)
    if (!identities.identities.some(m => identityKey(m) === identityKey({ kind, ...row.source }) && m.id === row.id)) fail('E_REPO_IDENTITY')
  }
}
export function readRepositoryState(value, policy = {}) {
  validateJson(value); shape(value, ['format', 'formatVersion', 'revision', 'world', 'identities', 'proposals', 'retired'])
  if (value.format !== FORMAT || value.formatVersion !== 1) fail('E_REPO_VERSION')
  revision(value.revision, 'repository.revision')
  if (value.world?.formatVersion !== 1 || value.identities?.version !== 1) fail('E_REPO_VERSION')
  const world = readWorldStore(value.world, policy), identities = readBridgeManifest(value.identities)
  validateIdentityBindings(world, identities)
  if (!Array.isArray(value.retired)) fail('E_REPO_HISTORY')
  const retiredKeys = new Set()
  for (const row of value.retired) {
    shape(row, ['table', 'id']); opaqueId(row.id, 'retired.id')
    const key = jsonKey(row)
    if (!STORE_TABLES.includes(row.table) || retiredKeys.has(key)) fail('E_REPO_HISTORY')
    if (world[row.table].some(current => current.id === row.id)) fail('E_REPO_RETIRED_ID')
    retiredKeys.add(key)
  }
  if (!Array.isArray(value.proposals)) fail('E_REPO_PROPOSALS')
  const proposals = value.proposals.map(p => readStoreProposal(p, world, policy)), seen = new Set()
  for (const p of proposals) {
    if (seen.has(p.id) || p.baseRevision > world.revision) fail('E_REPO_PROPOSALS')
    seen.add(p.id)
    const reviews = world.reviews.filter(r => r.proposalId === p.id)
    if (p.status === 'accepted' ? reviews.length !== 1 || reviews[0].sourceId !== p.sourceId : reviews.length !== 0) fail('E_REPO_PROPOSALS')
  }
  if (world.reviews.some(r => !proposals.some(p => p.id === r.proposalId && p.status === 'accepted'))) fail('E_REPO_PROPOSALS')
  return freezeCopy({ ...value, world, identities, proposals })
}
function appendIdentities(previous, additions = []) {
  if (!Array.isArray(additions)) fail('E_REPO_IDENTITY')
  return readBridgeManifest({ ...previous, identities: [...previous.identities, ...additions] })
}
function readRequest(input) {
  validateJson(input); shape(input, ['id', 'expectedRevision', 'action', 'identities'], ['id', 'expectedRevision', 'action'])
  opaqueId(input.id, 'request.id'); revision(input.expectedRevision, 'request.expectedRevision')
  const action = input.action
  if (action?.kind === 'commands') shape(action, ['kind', 'commands'])
  else if (action?.kind === 'stage-proposal') shape(action, ['kind', 'proposal'])
  else if (action?.kind === 'accept-proposal') shape(action, ['kind', 'proposalId', 'decision'])
  else if (action?.kind === 'reject-proposal') shape(action, ['kind', 'proposalId'])
  else if (action?.kind === 'merge') shape(action, ['kind', 'incoming'])
  else fail('E_REPO_REQUEST')
  return freezeCopy(input)
}
function nextState(current, request, policy) {
  let world = current.world, proposals = [...current.proposals]
  const a = request.action
  if (a.kind === 'commands') world = applyStoreCommands(world, a.commands, world.revision, { policy })
  else if (a.kind === 'stage-proposal') {
    const p = readStoreProposal(a.proposal, world, policy)
    if (p.status !== 'pending' || p.baseRevision !== world.revision || proposals.some(row => row.id === p.id)) fail('E_REPO_PROPOSALS')
    proposals.push(p)
  } else if (a.kind === 'merge') {
    // An explicit host request, never automatic conflict resolution. Recheck
    // under the write lock, including the immutable history/import boundary.
    const plan = planStoreMerge(world, a.incoming, policy)
    if (plan.status === 'conflict') fail('E_REPO_MERGE_CONFLICT')
    if (plan.commands.length) world = applyStoreCommands(world, plan.commands, world.revision, { policy })
  } else {
    opaqueId(a.proposalId, 'request.proposalId')
    const index = proposals.findIndex(p => p.id === a.proposalId)
    if (index < 0) fail('E_REPO_PROPOSAL_NOT_FOUND')
    if (a.kind === 'accept-proposal') {
      const accepted = acceptStoreProposal(world, proposals[index], a.decision, policy)
      world = accepted.world; proposals[index] = accepted.proposal
    } else proposals[index] = rejectStoreProposal(world, proposals[index], policy)
  }
  const retired = [...current.retired]
  for (const table of STORE_TABLES) for (const row of current.world[table]) if (!world[table].some(after => after.id === row.id)) retired.push({ table, id: row.id })
  return readRepositoryState({ ...current, revision: current.revision + 1, world, proposals, retired, identities: appendIdentities(current.identities, request.identities) }, policy)
}
function location(file, create) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) fail('E_REPO_PATH')
  const parent = realpathSync(path.dirname(file)), resolved = path.join(parent, path.basename(file))
  if (!lstatSync(parent).isDirectory()) fail('E_REPO_PATH')
  if (!create) {
    const stat = lstatSync(resolved)
    if (!stat.isFile() || stat.isSymbolicLink()) fail('E_REPO_PATH')
  }
  return resolved
}
function settings(db, fresh = false) {
  db.exec('PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 0; PRAGMA synchronous = EXTRA;')
  if (fresh) db.exec('PRAGMA journal_mode = DELETE;')
  if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete' || db.prepare('PRAGMA synchronous').get().synchronous !== 3) fail('E_REPO_SETTINGS')
}
function parseStored(payload, digest) {
  if (typeof payload !== 'string' || hash(payload) !== digest) fail('E_REPO_CORRUPT')
  try { return JSON.parse(payload) } catch { fail('E_REPO_CORRUPT') }
}
function stateFromDb(db, policy) {
  const rows = db.prepare('SELECT revision, payload, digest FROM repository_state').all()
  if (rows.length !== 1) fail('E_REPO_CORRUPT')
  let state
  try { state = readRepositoryState(parseStored(rows[0].payload, rows[0].digest), policy) }
  catch (error) { if (error?.code === 'E_REPO_VERSION') throw error; fail('E_REPO_CORRUPT') }
  if (state.revision !== rows[0].revision) fail('E_REPO_CORRUPT')
  const receipts = db.prepare('SELECT id, repository_revision, world_revision FROM operation_receipts ORDER BY repository_revision').all()
  if (receipts.length !== state.revision) fail('E_REPO_CORRUPT')
  for (const [index, row] of receipts.entries()) {
    if (row.repository_revision !== index + 1 || row.world_revision > state.world.revision) fail('E_REPO_CORRUPT')
    receiptFromDb(db, row.id)
  }
  return state
}
function snapshotFromDb(db, policy) {
  const ownTransaction = !db.isTransaction
  try { if (ownTransaction) db.exec('BEGIN'); return stateFromDb(db, policy) }
  finally { if (ownTransaction && db.isTransaction) db.exec('ROLLBACK') }
}
function receiptFromDb(db, id) {
  const row = db.prepare('SELECT * FROM operation_receipts WHERE id = ?').get(id)
  if (!row) return undefined
  try {
    const value = parseStored(row.payload, row.digest)
    validateJson(value); shape(value, ['status', 'operationId', 'repositoryRevision', 'worldRevision'])
    if (value.status !== 'committed' || value.operationId !== id || value.repositoryRevision !== row.repository_revision || value.worldRevision !== row.world_revision || !/^[a-f0-9]{64}$/.test(row.request_digest)) fail('E_REPO_CORRUPT')
    revision(value.repositoryRevision, 'receipt.repositoryRevision'); revision(value.worldRevision, 'receipt.worldRevision')
    return { receipt: freezeCopy(value), requestDigest: row.request_digest }
  } catch { fail('E_REPO_CORRUPT') }
}
function handle(db, options) {
  const policy = freezeCopy(options.policy ?? {})
  const phase = name => {
    const result = options.unsafeTestPhase?.(name)
    if (result && typeof result.then === 'function') fail('E_REPO_ASYNC_HOOK')
  }
  return {
    snapshot() { try { return snapshotFromDb(db, policy) } catch (e) { throw translate(e) } },
    findOperation(id) {
      opaqueId(id, 'operation.id')
      try { db.exec('BEGIN'); stateFromDb(db, policy); return receiptFromDb(db, id)?.receipt }
      catch (e) { throw translate(e) }
      finally { if (db.isTransaction) db.exec('ROLLBACK') }
    },
    preflightMerge(incoming) {
      const state = this.snapshot()
      if (state.retired.some(row => incoming[row.table]?.some(value => value.id === row.id))) fail('E_REPO_RETIRED_ID')
      return freezeCopy({ repositoryRevision: state.revision, plan: planStoreMerge(state.world, incoming, policy) })
    },
    /** Snapshot export only: never replace an existing destination or copy a
     * live main file. The host must validate/seal the resulting package. */
    exportSnapshot(file) {
      if (db.isTransaction) fail('E_REPO_BUSY')
      try {
        snapshotFromDb(db, policy)
        const target = location(file, true), fd = openSync(target, 'wx', 0o600)
        closeSync(fd)
        db.prepare('VACUUM main INTO ?').run(target)
        const completed = openSync(target, 'r+')
        try { fsyncSync(completed) } finally { closeSync(completed) }
      } catch (error) {
        if (error?.code === 'EEXIST') fail('E_REPO_EXISTS')
        throw translate(error)
      }
    },
    apply(input) {
      if (options.readOnly) fail('E_REPO_READ_ONLY')
      const request = readRequest(input), requestDigest = hash(jsonKey(request))
      if (db.isTransaction) fail('E_REPO_BUSY')
      let commitAttempted = false
      try {
        phase('before-begin'); db.exec('BEGIN IMMEDIATE'); phase('locked')
        const current = stateFromDb(db, policy)
        const previous = receiptFromDb(db, request.id)
        if (previous) {
          if (previous.requestDigest !== requestDigest) fail('E_REPO_OPERATION_REUSED')
          db.exec('ROLLBACK'); return previous.receipt
        }
        if (current.revision !== request.expectedRevision) fail('E_REPO_STALE')
        const next = nextState(current, request, policy), payload = JSON.stringify(next)
        db.prepare('UPDATE repository_state SET revision = ?, payload = ?, digest = ? WHERE singleton = 1').run(next.revision, payload, hash(payload))
        phase('state-written')
        const receipt = { status: 'committed', operationId: request.id, repositoryRevision: next.revision, worldRevision: next.world.revision }, receiptPayload = JSON.stringify(receipt)
        db.prepare('INSERT INTO operation_receipts VALUES (?, ?, ?, ?, ?, ?)').run(request.id, requestDigest, next.revision, next.world.revision, receiptPayload, hash(receiptPayload))
        phase('receipt-written'); phase('before-commit')
        commitAttempted = true; db.exec('COMMIT'); phase('committed')
        return freezeCopy(receipt)
      } catch (error) {
        try { if (db.isTransaction) db.exec('ROLLBACK') } catch { /* Outcome discovery is required, never retry here. */ }
        if (commitAttempted) fail('E_REPO_OUTCOME_UNKNOWN')
        throw translate(error)
      }
    },
    close() { db.close() },
  }
}

export function createWorldRepository(file, seed, options = {}) {
  validateJson(seed); shape(seed, ['world', 'identities', 'proposals'], ['world'])
  const state = readRepositoryState({ format: FORMAT, formatVersion: 1, revision: 0, world: seed.world, identities: seed.identities ?? emptyIdentities(), proposals: seed.proposals ?? [], retired: [] }, options.policy)
  let db
  try {
    const target = location(file, true)
    // Never replace an existing file, even an incomplete initialization.
    const fd = openSync(target, 'wx', 0o600)
    try { fsyncSync(fd) } finally { closeSync(fd) }
    db = new DatabaseSync(target, { timeout: 0, allowExtension: false })
    settings(db, true); db.exec('BEGIN IMMEDIATE')
    db.exec(STATE_SQL); db.exec(RECEIPT_SQL)
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 1;`)
    const payload = JSON.stringify(state)
    db.prepare('INSERT INTO repository_state VALUES (1, ?, ?, ?)').run(state.revision, payload, hash(payload))
    db.exec('COMMIT')
    return handle(db, options)
  } catch (error) {
    if (db) { try { if (db.isTransaction) db.exec('ROLLBACK'); db.close() } catch { /* Preserve file for explicit review. */ } }
    if (error?.code === 'EEXIST') fail('E_REPO_EXISTS')
    throw translate(error)
  }
}
export function openWorldRepository(file, options = {}) {
  let db
  try {
    db = new DatabaseSync(location(file, false), { timeout: 0, allowExtension: false, readOnly: options.readOnly === true })
    if (db.prepare('PRAGMA application_id').get().application_id !== APPLICATION_ID || db.prepare('PRAGMA user_version').get().user_version !== 1) fail('E_REPO_VERSION')
    const schema = db.prepare("SELECT name, type, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()
    if (schema.length !== 2 || schema[0].name !== 'operation_receipts' || schema[0].type !== 'table' || schema[0].sql !== RECEIPT_SQL || schema[1].name !== 'repository_state' || schema[1].type !== 'table' || schema[1].sql !== STATE_SQL) fail('E_REPO_SCHEMA')
    settings(db)
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('E_REPO_CORRUPT')
    snapshotFromDb(db, options.policy)
    return handle(db, options)
  } catch (error) {
    if (db) { try { db.close() } catch { /* No automatic replacement/repair. */ } }
    if (error?.code === 'ENOENT') fail('E_REPO_NOT_FOUND')
    throw translate(error)
  }
}
