/** Experimental single terminal merge archive MODEL, not a repository format.
 * Complete archives and the request are replayed; consistency is not authority.
 * No IO, locks, ID allocation, local approval or committed receipts are issued.
 */
import { freezeCopy, jsonKey, shape } from '../src/worldgraph/store/schema.ts'
import { types } from 'node:util'
import { RepositoryError } from './world-store-repository.mjs'
import { repositoryStateDigest as digest } from './world-store-repository-v2-contract.mjs'
import { readRepositoryArchive, MAX_BRANCH_ANCESTRY } from './world-store-branch-snapshot.mjs'
import { operationIdentityKey } from './world-store-branch-contract.mjs'
import { replayRepositoryBranchMergeCommit } from './world-store-branch-merge-commit-contract.mjs'

const FORMAT = 'starmap.repository-branch-merge-archive-model'
const MAXIMUM = Object.freeze({ maxDepth: 64, maxNodes: 500000, maxBytes: 128 * 1024 * 1024,
  maxArchives: 128, maxAncestry: MAX_BRANCH_ANCESTRY })
const KEYS = ['format', 'formatVersion', 'baseArchive', 'mergeRequest', 'localOperation', 'beforeArchiveDigest',
  'afterDigest', 'state', 'executable', 'persisted', 'commands', 'foreignReceiptsBecomeLocal', 'newLocalApprovalIssued', 'modelDigest']
const flags = () => ({ executable: false, persisted: false, commands: [], foreignReceiptsBecomeLocal: false, newLocalApprovalIssued: false })
const fail = code => { throw new RepositoryError(code) }
const equal = (a, b) => jsonKey(a) === jsonKey(b)
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0

// Walk data descriptors before calling recursive schema validation/serialization.
// Repeated aliases count repeatedly, as JSON does; only ancestor cycles fail.
// Bytes equal the sum of native JSON UTF8 sizes for each supplied root.
function boundedJson(values, limits) {
  let nodes = values.length, bytes = 0
  if (nodes > limits.maxNodes) fail('E_BRANCH_MERGE_ARCHIVE_NODES')
  const active = new Set(), stack = values.map(value => ({ value, depth: 0 }))
  const addBytes = count => { bytes += count; if (bytes > limits.maxBytes) fail('E_BRANCH_MERGE_ARCHIVE_SIZE') }
  const stringBytes = text => {
    addBytes(2)
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) addBytes(2)
      else if (code < 32) addBytes(6)
      else if (code < 128) addBytes(1)
      else if (code < 2048) addBytes(2)
      else if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { addBytes(4); i++ }
      else if (code >= 0xd800 && code <= 0xdfff) addBytes(6)
      else addBytes(3)
    }
  }
  while (stack.length) {
    const entry = stack.pop(), value = entry.value
    if (entry.exit) { active.delete(value); continue }
    if (entry.depth > limits.maxDepth) fail('E_BRANCH_MERGE_ARCHIVE_DEPTH')
    if (typeof value === 'string') { stringBytes(value); continue }
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) {
      addBytes(Buffer.byteLength(JSON.stringify(value), 'utf8')); continue
    }
    if (!value || typeof value !== 'object') fail('E_BRANCH_MERGE_ARCHIVE_JSON')
    if (types.isProxy(value)) fail('E_BRANCH_MERGE_ARCHIVE_JSON')
    const array = Array.isArray(value), proto = Object.getPrototypeOf(value)
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) fail('E_BRANCH_MERGE_ARCHIVE_JSON')
    if (active.has(value)) fail('E_BRANCH_MERGE_ARCHIVE_CYCLE')
    const keys = Reflect.ownKeys(value), length = array ? Object.getOwnPropertyDescriptor(value, 'length').value : keys.length
    if (array && keys.length !== length + 1) fail('E_BRANCH_MERGE_ARCHIVE_JSON')
    if (length > limits.maxNodes - nodes) fail('E_BRANCH_MERGE_ARCHIVE_NODES')
    nodes += length // Reserve queued children before allocating their work items.
    active.add(value); stack.push({ value, exit: true })
    addBytes(2 + Math.max(0, length - 1))
    for (let i = 0; i < length; i++) {
      const key = array ? String(i) : keys[i], descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor)) fail('E_BRANCH_MERGE_ARCHIVE_JSON')
      if (!array) { stringBytes(key); addBytes(1) }
      stack.push({ value: descriptor.value, depth: entry.depth + 1 })
    }
  }
}
function readLimits(value) {
  boundedJson([value], MAXIMUM)
  shape(value, Object.keys(MAXIMUM), [])
  for (const [key, amount] of Object.entries(value)) {
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAXIMUM[key]) fail('E_BRANCH_MERGE_ARCHIVE_LIMIT')
  }
  return { ...MAXIMUM, ...value }
}

// Enforce both chains before readRepositoryArchive recursively copies them.
// v2 baselines are legacy evidence, not an extra fabricated archive format.
function boundArchives(roots, limits) {
  const seen = new Set()
  for (const root of roots) {
    let archive = root, depth = 0
    while (archive) {
      if (depth++ > limits.maxAncestry) fail('E_BRANCH_ANCESTRY_LIMIT')
      const key = digest(archive)
      seen.add(key)
      if (seen.size > limits.maxArchives) fail('E_BRANCH_MERGE_ARCHIVE_COUNT')
      if (archive.format !== 'starmap.world-repository-branch' || archive.formatVersion !== 3) break
      archive = archive.sourceArchive
    }
  }
}
function reconstruct(baseInput, request, policy, limits) {
  boundArchives([baseInput, request?.sourceArchive], limits)
  const baseArchive = readRepositoryArchive(baseInput, policy)
  const commit = replayRepositoryBranchMergeCommit(request, baseArchive, policy)
  const raw = { format: FORMAT, formatVersion: 1, baseArchive, mergeRequest: commit.request,
    localOperation: commit.localOperation, beforeArchiveDigest: digest(baseArchive), afterDigest: commit.afterDigest,
    state: commit.after, ...flags() }
  boundedJson([raw, policy], limits) // Check derived expansion before canonical hashing.
  const model = { ...raw, modelDigest: digest(raw) }
  boundedJson([model, policy], limits)
  return freezeCopy(model)
}

/** Capture one terminal event, retaining both complete source chains. */
export function createRepositoryBranchMergeArchiveModel(baseArchive, mergeRequest, policy = {}) {
  boundedJson([baseArchive, mergeRequest, policy], MAXIMUM)
  return reconstruct(baseArchive, mergeRequest, policy, MAXIMUM)
}

/** A recomputed outer digest never replaces exact semantic replay. */
export function readRepositoryBranchMergeArchiveModel(value, policy = {}, inputLimits = {}) {
  const limits = readLimits(inputLimits)
  boundedJson([value, policy], limits)
  shape(value, KEYS)
  if (value.format !== FORMAT || value.formatVersion !== 1) fail('E_BRANCH_MERGE_ARCHIVE_VERSION')
  const expected = reconstruct(value.baseArchive, value.mergeRequest, policy, limits)
  if (!equal(value, expected)) fail('E_BRANCH_MERGE_ARCHIVE_STALE')
  return expected
}

/** References and checkpoint evidence only, never local success discovery.
 * Multiple shared checkpoints are not ordered into a latest common history.
 */
export function indexRepositoryBranchMergeArchiveModel(value, policy = {}, inputLimits = {}) {
  const model = readRepositoryBranchMergeArchiveModel(value, policy, inputLimits)
  const archives = new Map(), branches = new Map(), operations = new Map(), checkpoints = new Map(), legacy = new Map()
  const checkpoint = (identity, state, historyDigest) => {
    const row = { identity, repositoryRevision: state.revision, stateDigest: digest(state), historyDigest }
    checkpoints.set(jsonKey(row), row)
  }
  const legacyEvidence = archive => {
    const row = { archiveDigest: digest(archive), stateDigest: digest(archive.state), receiptCount: archive.receipts.length,
      identityStatus: 'unknown', editBodies: 'unavailable' }
    legacy.set(row.archiveDigest, row)
  }
  function visit(archive) {
    const archiveDigest = digest(archive)
    if (archives.has(archiveDigest)) return
    archives.set(archiveDigest, { archiveDigest, formatVersion: archive.formatVersion })
    if (archive.formatVersion === 1) { legacyEvidence(archive); return }
    if (archive.formatVersion === 3) visit(archive.sourceArchive)
    else legacyEvidence(archive.baseline)
    const identity = archive.formatVersion === 2 ? archive.identity : archive.descriptor.identity
    let prefix = digest(archive.formatVersion === 2 ? { identity, baseline: archive.baseline }
      : { descriptor: archive.descriptor, creation: archive.creation, markerDigest: archive.markerDigest })
    const branchKey = jsonKey([identity.libraryId, identity.branchId]), origin = { identity, originDigest: prefix }
    const previous = branches.get(branchKey)
    if (previous && !equal(previous, origin)) fail('E_BRANCH_HISTORY_NAMESPACE')
    branches.set(branchKey, origin)
    checkpoint(identity, archive.formatVersion === 2 ? archive.baseline.state : archive.sourceArchive.state, prefix)
    for (const row of archive.history) {
      const operation = { identity, operationId: row.operationId, requestDigest: row.requestDigest,
        beforeDigest: row.beforeDigest, afterDigest: row.afterDigest }
      const key = operationIdentityKey(identity, row.operationId), prior = operations.get(key)
      if (prior && !equal(prior, operation)) fail('E_BRANCH_HISTORY_NAMESPACE')
      operations.set(key, operation)
      prefix = digest({ prefix, operation })
      checkpoint(identity, row.after, prefix)
    }
  }
  visit(model.baseArchive); visit(model.mergeRequest.sourceArchive)
  const ordered = map => [...map].sort(([a], [b]) => compare(a, b)).map(([, item]) => item)
  const raw = { format: 'starmap.repository-branch-merge-archive-index', formatVersion: 1, modelDigest: model.modelDigest,
    archives: ordered(archives), branches: ordered(branches), archivedOperations: ordered(operations),
    checkpoints: ordered(checkpoints), legacy: ordered(legacy), localOperation: model.localOperation,
    hypotheticalCheckpoint: { identity: model.localOperation.identity, repositoryRevision: model.state.revision,
      stateDigest: model.afterDigest, historyDigest: digest({ beforeArchiveDigest: model.beforeArchiveDigest, localOperation: model.localOperation }),
      origin: 'uncommitted-merge-model' }, ...flags() }
  return freezeCopy(raw)
}
