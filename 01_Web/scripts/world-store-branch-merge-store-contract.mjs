/** Independent saved archive consistency contract. This reader and its expected
 * receipt data do not establish host authority or prove a SQLite COMMIT.
 * Complete native fork anchors stay immutable; pure models never become sources
 * until their full saved envelope and every supplied local event are replayed.
 */
import { freezeCopy, jsonKey, opaqueId, shape } from '../src/worldgraph/store/schema.ts'
import { RepositoryError } from './world-store-repository.mjs'
import { repositoryStateDigest as digest } from './world-store-repository-v2-contract.mjs'
import { readRepositoryArchive } from './world-store-branch-snapshot.mjs'
import { inspectRepositoryMergeArchiveInputs } from './world-store-branch-merge-archive-model.mjs'
import { previewRepositoryContinuousBranchHistory, createRepositoryContinuousBranchMergePlan,
  simulateRepositoryContinuousBranchMerge, createRepositoryContinuousBranchMergeRequest,
  replayRepositoryContinuousBranchMerge, createRepositoryContinuousOperationRequest,
  replayRepositoryContinuousOperation } from './world-store-branch-continuous-merge-model.mjs'

const FORMAT = 'starmap.repository-merge-saved'
const REQUEST = 'starmap.repository-merge-store-request'
const SAVED_KEYS = ['format', 'formatVersion', 'baseArchive', 'events', 'projection', 'savedDigest']
const REQUEST_KEYS = ['format', 'formatVersion', 'kind', 'operationId', 'targetSavedDigest', 'policyDigest', 'pureRequest']
const RECEIPT_KEYS = ['status', 'identity', 'operationId', 'requestDigest', 'beforeSavedDigest', 'beforeDigest',
  'afterDigest', 'repositoryRevision', 'worldRevision']
const fail = code => { throw new RepositoryError(code) }
const equal = (a, b) => jsonKey(a) === jsonKey(b)
function context(values, limits) {
  const usage = inspectRepositoryMergeArchiveInputs(values, limits)
  return { limits: usage.limits, nodes: 0, bytes: 0, archives: new Set(), steps: 0 }
}
function measure(value, ctx) {
  const usage = inspectRepositoryMergeArchiveInputs([value], ctx.limits)
  ctx.nodes += usage.nodes; ctx.bytes += usage.bytes
  if (ctx.nodes > ctx.limits.maxNodes || ctx.bytes > ctx.limits.maxBytes) fail('E_MERGE_STORE_DERIVED_BUDGET')
  return value
}
function step(ctx) {
  if (++ctx.steps > ctx.limits.maxArchives) fail('E_BRANCH_MERGE_ARCHIVE_COUNT')
}
function native(value, policy, ctx) {
  let current = value, depth = 0
  while (current) {
    if (depth++ > ctx.limits.maxAncestry) fail('E_BRANCH_ANCESTRY_LIMIT')
    ctx.archives.add(digest(current))
    if (ctx.archives.size > ctx.limits.maxArchives) fail('E_BRANCH_MERGE_ARCHIVE_COUNT')
    if (current.format !== 'starmap.world-repository-branch' || current.formatVersion !== 3) break
    current = current.sourceArchive
  }
  return readRepositoryArchive(value, policy)
}
function anchor(value, policy, ctx) {
  const archive = native(value, policy, ctx)
  if (archive.formatVersion !== 3 || archive.descriptor.origin.kind !== 'fork' || archive.history.length !== 0
    || ![2, 3].includes(archive.sourceArchive.formatVersion)) fail('E_MERGE_STORE_ANCHOR')
  return archive
}
function envelope(baseArchive, events, projection, ctx) {
  const raw = { format: FORMAT, formatVersion: 1, baseArchive, events, projection }
  measure(raw, ctx)
  const saved = { ...raw, savedDigest: digest(raw) }
  inspectRepositoryMergeArchiveInputs([saved], ctx.limits)
  return freezeCopy(saved)
}
function source(value, policy, ctx, depth) {
  return value?.format === FORMAT ? readSaved(value, policy, ctx, depth) : native(value, policy, ctx)
}
const projectionOf = value => value.format === FORMAT ? value.projection : value
function localId(saved, id) {
  opaqueId(id, '$.operationId')
  if (id === saved.baseArchive.creation.operationId || saved.events.some(row => row.storeRequest.operationId === id)) fail('E_REPO_OPERATION_CONFLICT')
}
function expectedReceipt(saved, request, projection) {
  return { status: 'committed', identity: saved.baseArchive.descriptor.identity, operationId: request.operationId,
    requestDigest: digest(request), beforeSavedDigest: saved.savedDigest, beforeDigest: digest(saved.projection.state),
    afterDigest: digest(projection.state), repositoryRevision: projection.state.revision, worldRevision: projection.state.world.revision }
}
function project(request, saved, policy, ctx, depth) {
  shape(request, request?.kind === 'merge' ? [...REQUEST_KEYS, 'sourceArchive'] : REQUEST_KEYS)
  if (request.format !== REQUEST || request.formatVersion !== 1 || !['operation', 'merge'].includes(request.kind)) fail('E_MERGE_STORE_REQUEST')
  if (request.targetSavedDigest !== saved.savedDigest || request.policyDigest !== digest(policy)) fail('E_MERGE_STORE_STALE')
  localId(saved, request.operationId)
  let projection
  if (request.kind === 'operation') {
    if (request.pureRequest?.operation?.id !== request.operationId) fail('E_MERGE_STORE_REQUEST')
    projection = replayRepositoryContinuousOperation(request.pureRequest, saved.projection, policy, ctx.limits)
  } else {
    const incoming = source(request.sourceArchive, policy, ctx, depth + 1)
    if (request.pureRequest?.operationId !== request.operationId || !equal(request.pureRequest.sourceArchive, projectionOf(incoming))) fail('E_MERGE_STORE_SOURCE')
    projection = replayRepositoryContinuousBranchMerge(request.pureRequest, saved.projection, policy, ctx.limits)
  }
  measure(projection, ctx)
  return { projection, expectedReceipt: expectedReceipt(saved, request, projection) }
}
function append(saved, request, receipt, policy, ctx, depth) {
  step(ctx)
  const result = project(request, saved, policy, ctx, depth)
  shape(receipt, RECEIPT_KEYS)
  if (!equal(receipt, result.expectedReceipt)) fail('E_MERGE_STORE_RECEIPT')
  return envelope(saved.baseArchive, [...saved.events, { storeRequest: request, receipt }], result.projection, ctx)
}
function readSaved(value, policy, ctx, depth = 0) {
  if (depth > ctx.limits.maxAncestry) fail('E_BRANCH_ANCESTRY_LIMIT')
  step(ctx)
  shape(value, SAVED_KEYS)
  if (value.format !== FORMAT || value.formatVersion !== 1 || !Array.isArray(value.events)) fail('E_MERGE_STORE_VERSION')
  const base = anchor(value.baseArchive, policy, ctx)
  let saved = envelope(base, [], base, ctx)
  for (const row of value.events) {
    shape(row, ['storeRequest', 'receipt'])
    saved = append(saved, row.storeRequest, row.receipt, policy, ctx, depth)
  }
  if (!equal(value, saved)) fail('E_MERGE_STORE_CORRUPT')
  return saved
}

/** The caller supplies an already-created complete native v3 fork anchor.
 * Creating this value alone neither creates a library nor persists anything. */
export function createRepositoryMergeSavedArchive(baseArchive, policy = {}, limits = {}) {
  const ctx = context([baseArchive, policy], limits), base = anchor(baseArchive, policy, ctx)
  return envelope(base, [], base, ctx)
}
export function readRepositoryMergeSavedArchive(value, policy = {}, limits = {}) {
  return readSaved(value, policy, context([value, policy], limits))
}
export function readRepositoryMergeStoreSource(value, policy = {}, limits = {}) {
  return source(value, policy, context([value, policy], limits), 0)
}
export function repositoryMergeStoreProjection(value, policy = {}, limits = {}) {
  return projectionOf(readRepositoryMergeStoreSource(value, policy, limits))
}
export function previewRepositoryMergeStore(targetSaved, incoming, policy = {}, limits = {}) {
  const ctx = context([targetSaved, incoming, policy], limits)
  const target = readSaved(targetSaved, policy, ctx), checkedSource = source(incoming, policy, ctx, 0)
  const report = previewRepositoryContinuousBranchHistory(target.projection, projectionOf(checkedSource), policy, ctx.limits)
  const catalogue = createRepositoryContinuousBranchMergePlan(report, target.projection, projectionOf(checkedSource), [], policy, ctx.limits)
  return freezeCopy(measure({ report, catalogue }, ctx))
}
export function createRepositoryMergeStoreOperationRequest(operation, targetSaved, policy = {}, limits = {}) {
  const ctx = context([operation, targetSaved, policy], limits), target = readSaved(targetSaved, policy, ctx)
  localId(target, operation?.id)
  const pureRequest = createRepositoryContinuousOperationRequest(operation, target.projection, policy, ctx.limits)
  return freezeCopy(measure({ format: REQUEST, formatVersion: 1, kind: 'operation', operationId: operation.id,
    targetSavedDigest: target.savedDigest, policyDigest: digest(policy), pureRequest }, ctx))
}
export function createRepositoryMergeStoreRequest(operationId, targetSaved, incoming, choices = [], policy = {}, limits = {}) {
  const ctx = context([operationId, targetSaved, incoming, choices, policy], limits)
  const target = readSaved(targetSaved, policy, ctx), checkedSource = source(incoming, policy, ctx, 0)
  localId(target, operationId)
  const projection = projectionOf(checkedSource)
  const report = previewRepositoryContinuousBranchHistory(target.projection, projection, policy, ctx.limits)
  const plan = createRepositoryContinuousBranchMergePlan(report, target.projection, projection, choices, policy, ctx.limits)
  const simulation = simulateRepositoryContinuousBranchMerge(plan, report, target.projection, projection, policy, ctx.limits)
  const pureRequest = createRepositoryContinuousBranchMergeRequest(operationId, simulation, plan, report, target.projection, projection, policy, ctx.limits)
  return freezeCopy(measure({ format: REQUEST, formatVersion: 1, kind: 'merge', operationId,
    targetSavedDigest: target.savedDigest, policyDigest: digest(policy), pureRequest, sourceArchive: checkedSource }, ctx))
}
/** expectedReceipt is deterministic comparison data, never a commit receipt. */
export function projectRepositoryMergeStoreRequest(request, targetSaved, policy = {}, limits = {}) {
  const ctx = context([request, targetSaved, policy], limits), target = readSaved(targetSaved, policy, ctx)
  return freezeCopy(project(request, target, policy, ctx, 0))
}
/** A supplied receipt is replay-checked, not authenticated. Only the IO host can
 * establish an actual atomic COMMIT and return its real local receipt. */
export function appendRepositoryMergeSavedEvent(saved, request, receipt, policy = {}, limits = {}) {
  const ctx = context([saved, request, receipt, policy], limits), target = readSaved(saved, policy, ctx)
  return append(target, request, receipt, policy, ctx, 0)
}
