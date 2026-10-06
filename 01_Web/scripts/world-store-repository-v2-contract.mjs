/** Experimental envelope validation only; no disk writes or App integration.
 * Full snapshots make history integrity independently checkable. Request
 * execution semantics remain the responsibility of the future writer. */
import { createHash } from 'node:crypto'
import { freezeCopy, jsonKey, opaqueId, revision, shape, validateJson } from '../src/worldgraph/store/schema.ts'
import { readRepositoryState, RepositoryError } from './world-store-repository.mjs'

const fail = code => { throw new RepositoryError(code) }
export const repositoryStateDigest = state => createHash('sha256').update(jsonKey(state)).digest('hex')
function digest(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('E_REPO_V2_DIGEST')
}
function identity(value) {
  shape(value, ['libraryId', 'branchId', 'genesisId'])
  for (const key of ['libraryId', 'branchId', 'genesisId']) opaqueId(value[key], key)
}

/** Nested state retains the v1 payload schema, not the v1 database format.
 * This contract checks snapshots/chains, not whether a request caused a change. */
export function readRepositoryV2(value, policy = {}) {
  validateJson(value)
  shape(value, ['format', 'formatVersion', 'identity', 'baseline', 'history', 'state'])
  if (value.format !== 'starmap.world-repository-v2' || value.formatVersion !== 2) fail('E_REPO_V2_VERSION')
  identity(value.identity)
  const baseline = value.baseline
  shape(baseline, ['sourceVersion', 'sourceDigest', 'coverage', 'state', 'receipts'])
  if (baseline.sourceVersion !== 1 || baseline.coverage !== 'baselineOnly') fail('E_REPO_V2_COVERAGE')
  digest(baseline.sourceDigest)
  let previous = readRepositoryState(baseline.state, policy)
  if (repositoryStateDigest(previous) !== baseline.sourceDigest) fail('E_REPO_V2_DIGEST')
  if (!Array.isArray(baseline.receipts) || baseline.receipts.length !== previous.revision) fail('E_REPO_V2_RECEIPTS')
  const operations = new Set()
  for (const [index, row] of baseline.receipts.entries()) {
    shape(row, ['operationId', 'requestDigest', 'repositoryRevision', 'worldRevision'])
    opaqueId(row.operationId, 'operationId'); digest(row.requestDigest)
    revision(row.repositoryRevision, 'repositoryRevision'); revision(row.worldRevision, 'worldRevision')
    if (operations.has(row.operationId) || row.repositoryRevision !== index + 1 || row.worldRevision > previous.world.revision) fail('E_REPO_V2_RECEIPTS')
    operations.add(row.operationId)
  }
  // Legacy receipts lack permanent operation namespaces. Preserve them as
  // archives; they must not participate in new-branch operation discovery.
  operations.clear()
  if (!Array.isArray(value.history)) fail('E_REPO_V2_HISTORY')
  for (const row of value.history) {
    shape(row, ['operationId', 'request', 'requestDigest', 'beforeDigest', 'afterDigest', 'after', 'receipt'])
    opaqueId(row.operationId, 'operationId')
    if (operations.has(row.operationId)) fail('E_REPO_V2_DUPLICATE')
    operations.add(row.operationId)
    shape(row.request, ['id', 'expectedRevision', 'action', 'identities'], ['id', 'expectedRevision', 'action'])
    if (row.request.id !== row.operationId || row.request.expectedRevision !== previous.revision) fail('E_REPO_V2_REQUEST')
    // Keep supported action vocabulary narrow without claiming execution.
    if (!['commands', 'stage-proposal', 'accept-proposal', 'reject-proposal'].includes(row.request.action?.kind)) fail('E_REPO_V2_REQUEST')
    const action = row.request.action
    if (action.kind === 'commands') {
      shape(action, ['kind', 'commands'])
      if (!Array.isArray(action.commands)) fail('E_REPO_V2_REQUEST')
    } else if (action.kind === 'stage-proposal') shape(action, ['kind', 'proposal'])
    else if (action.kind === 'accept-proposal') {
      shape(action, ['kind', 'proposalId', 'decision']); opaqueId(action.proposalId, 'proposalId')
    } else {
      shape(action, ['kind', 'proposalId']); opaqueId(action.proposalId, 'proposalId')
    }
    for (const key of ['requestDigest', 'beforeDigest', 'afterDigest']) digest(row[key])
    if (row.requestDigest !== repositoryStateDigest(row.request) || row.beforeDigest !== repositoryStateDigest(previous)) fail('E_REPO_V2_CHAIN')
    const after = readRepositoryState(row.after, policy)
    if (after.revision !== previous.revision + 1 || after.world.revision < previous.world.revision || row.afterDigest !== repositoryStateDigest(after)) fail('E_REPO_V2_CHAIN')
    shape(row.receipt, ['status', 'operationId', 'repositoryRevision', 'worldRevision'])
    if (row.receipt.status !== 'committed' || row.receipt.operationId !== row.operationId || row.receipt.repositoryRevision !== after.revision || row.receipt.worldRevision !== after.world.revision) fail('E_REPO_V2_RECEIPTS')
    previous = after
  }
  const state = readRepositoryState(value.state, policy)
  if (repositoryStateDigest(state) !== repositoryStateDigest(previous)) fail('E_REPO_V2_CHAIN')
  return freezeCopy(value)
}
