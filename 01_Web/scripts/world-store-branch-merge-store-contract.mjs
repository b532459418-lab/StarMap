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
  replayRepositoryContinuousOperation, createRepositoryContinuousBranchForkRequest, replayRepositoryContinuousBranchFork } from './world-store-branch-continuous-merge-model.mjs'

import { readRepositorySavedBranchForkModel } from './world-store-saved-branch-fork-contract.mjs'

const FORMAT = 'starmap.repository-merge-saved'
const REQUEST = 'starmap.repository-merge-store-request'
const SAVED_KEYS = ['format', 'formatVersion', 'baseArchive', 'events', 'projection', 'savedDigest']
const RESTORE_RECEIPT_KEYS = ['status', 'kind', 'identity', 'operationId', 'requestDigest', 'sourceArchiveDigest',
  'forkModelDigest', 'packageDigest', 'repositoryRevision', 'worldRevision']
const REQUEST_KEYS = ['format', 'formatVersion', 'kind', 'operationId', 'targetSavedDigest', 'policyDigest', 'pureRequest']
const RECEIPT_KEYS = ['status', 'identity', 'operationId', 'requestDigest', 'beforeSavedDigest', 'beforeDigest',
  'afterDigest', 'repositoryRevision', 'worldRevision']
const fail = code => { throw new RepositoryError(code) }
const equal = (a, b) => jsonKey(a) === jsonKey(b)
// Only active synchronous tokens from this module share a validation budget.
// No caller JSON flag or escaped token can authenticate or reset a nested read.
const validationContexts = new WeakMap()
export function withRepositoryMergeSavedValidation(values, limits, token, run) {
  if (token !== undefined) {
    const state = validationContexts.get(token)
    if (!state) fail('E_MERGE_STORE_VALIDATION_CONTEXT')
    const usage = inspectRepositoryMergeArchiveInputs(values, limits)
    if (!equal(usage.limits, token.limits)) fail('E_BRANCH_MERGE_ARCHIVE_LIMIT')
    return run(token)
  }
  const usage = inspectRepositoryMergeArchiveInputs(values, limits)
  let ctx
  const current = () => {
    const state = validationContexts.get(ctx)
    if (!state) fail('E_MERGE_STORE_VALIDATION_CONTEXT')
    return state
  }
  ctx = Object.freeze({ limits: freezeCopy(usage.limits),
    measure(value, code = 'E_MERGE_STORE_DERIVED_BUDGET') {
      const state = current(), amount = inspectRepositoryMergeArchiveInputs([value], ctx.limits)
      state.nodes += amount.nodes; state.bytes += amount.bytes
      if (state.nodes > ctx.limits.maxNodes || state.bytes > ctx.limits.maxBytes) fail(code)
      return value
    },
    step() { if (++current().steps > ctx.limits.maxArchives) fail('E_BRANCH_MERGE_ARCHIVE_COUNT') },
    archive(value) {
      const state = current(); state.archives.add(digest(value))
      if (state.archives.size > ctx.limits.maxArchives) fail('E_BRANCH_MERGE_ARCHIVE_COUNT')
    },
    restore(run) {
      const state = current()
      if (++state.restoreDepth > ctx.limits.maxAncestry) fail('E_BRANCH_ANCESTRY_LIMIT')
      try { return run() } finally { state.restoreDepth-- }
    } })
  validationContexts.set(ctx, { nodes: 0, bytes: 0, archives: new Set(), steps: 0, restoreDepth: 0 })
  try { return run(ctx) } finally { validationContexts.delete(ctx) }
}
const measure = (value, ctx) => ctx.measure(value)
const step = ctx => ctx.step()
function native(value, policy, ctx) {
  let current = value, depth = 0
  while (current) {
    if (depth++ > ctx.limits.maxAncestry) fail('E_BRANCH_ANCESTRY_LIMIT')
    ctx.archive(current)
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
function envelope(baseArchive, events, projection, ctx, initialization) {
  const raw = { format: FORMAT, formatVersion: initialization ? 2 : 1, baseArchive, events, projection,
    ...(initialization ? { initialization } : {}) }
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
  const creationId = saved.formatVersion === 2 ? saved.baseArchive.operationReference.operationId : saved.baseArchive.creation.operationId
  if (id === creationId || saved.events.some(row => row.storeRequest.operationId === id)) fail('E_REPO_OPERATION_CONFLICT')
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
  return envelope(saved.baseArchive, [...saved.events, { storeRequest: request, receipt }], result.projection, ctx, saved.initialization)
}
function restoreReceipt(model) {
  if (model.restoreContext?.kind !== 'backup-restore') fail('E_MERGE_STORE_RESTORE_CONTEXT')
  return { status: 'committed', kind: 'restore', identity: model.descriptor.identity,
    operationId: model.operationReference.operationId, requestDigest: digest(model.request),
    sourceArchiveDigest: digest(model.sourceArchive), forkModelDigest: model.modelDigest,
    packageDigest: model.restoreContext.packageDigest,
    ...(Object.hasOwn(model.restoreContext, 'packageEvidenceDigest') ? { packageEvidenceDigest: model.restoreContext.packageEvidenceDigest } : {}),
    repositoryRevision: model.state.revision, worldRevision: model.state.world.revision }
}
function restored(model, receipt, policy, ctx) {
  const expected = restoreReceipt(model)
  shape(receipt, Object.hasOwn(expected, 'packageEvidenceDigest') ? [...RESTORE_RECEIPT_KEYS, 'packageEvidenceDigest'] : RESTORE_RECEIPT_KEYS)
  if (!equal(receipt, expected)) fail('E_MERGE_STORE_RESTORE_RECEIPT')
  const request = createRepositoryContinuousBranchForkRequest(model.operationReference.operationId,
    model.sourceArchive.projection, { identity: model.descriptor.identity, binding: model.descriptor.binding }, policy, ctx.limits)
  const projection = replayRepositoryContinuousBranchFork(request, model.sourceArchive.projection, policy, ctx.limits)
  measure(projection, ctx)
  return envelope(model, [], projection, ctx, { receipt })
}
function readSaved(value, policy, ctx, depth = 0) {
  if (depth > ctx.limits.maxAncestry) fail('E_BRANCH_ANCESTRY_LIMIT')
  step(ctx)
  shape(value, value.formatVersion === 2 ? [...SAVED_KEYS, 'initialization'] : SAVED_KEYS)
  if (value.format !== FORMAT || ![1, 2].includes(value.formatVersion) || !Array.isArray(value.events)) fail('E_MERGE_STORE_VERSION')
  let saved
  if (value.formatVersion === 1) {
    const base = anchor(value.baseArchive, policy, ctx)
    saved = envelope(base, [], base, ctx)
  } else {
    shape(value.initialization, ['receipt'])
    saved = ctx.restore(() => restored(readRepositorySavedBranchForkModel(value.baseArchive, policy, ctx.limits, ctx),
      value.initialization.receipt, policy, ctx))
  }
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
  return withRepositoryMergeSavedValidation([baseArchive, policy], limits, undefined, ctx => {
    const base = anchor(baseArchive, policy, ctx)
    return envelope(base, [], base, ctx)
  })
}
export function readRepositoryMergeSavedArchive(value, policy = {}, limits = {}, validationContext) {
  return withRepositoryMergeSavedValidation([value, policy], limits, validationContext, ctx => readSaved(value, policy, ctx))
}
export function readRepositoryMergeStoreSource(value, policy = {}, limits = {}) {
  return withRepositoryMergeSavedValidation([value, policy], limits, undefined, ctx => source(value, policy, ctx, 0))
}
export function repositoryMergeStoreProjection(value, policy = {}, limits = {}) {
  return projectionOf(readRepositoryMergeStoreSource(value, policy, limits))
}
export function previewRepositoryMergeStore(targetSaved, incoming, policy = {}, limits = {}) {
  return withRepositoryMergeSavedValidation([targetSaved, incoming, policy], limits, undefined, ctx => {
    const target = readSaved(targetSaved, policy, ctx), checkedSource = source(incoming, policy, ctx, 0)
    const report = previewRepositoryContinuousBranchHistory(target.projection, projectionOf(checkedSource), policy, ctx.limits)
    const catalogue = createRepositoryContinuousBranchMergePlan(report, target.projection, projectionOf(checkedSource), [], policy, ctx.limits)
    return freezeCopy(measure({ report, catalogue }, ctx))
  })
}
export function createRepositoryMergeStoreOperationRequest(operation, targetSaved, policy = {}, limits = {}) {
  return withRepositoryMergeSavedValidation([operation, targetSaved, policy], limits, undefined, ctx => {
    const target = readSaved(targetSaved, policy, ctx)
    localId(target, operation?.id)
    const pureRequest = createRepositoryContinuousOperationRequest(operation, target.projection, policy, ctx.limits)
    return freezeCopy(measure({ format: REQUEST, formatVersion: 1, kind: 'operation', operationId: operation.id,
      targetSavedDigest: target.savedDigest, policyDigest: digest(policy), pureRequest }, ctx))
  })
}
export function createRepositoryMergeStoreRequest(operationId, targetSaved, incoming, choices = [], policy = {}, limits = {}) {
  return withRepositoryMergeSavedValidation([operationId, targetSaved, incoming, choices, policy], limits, undefined, ctx => {
    const target = readSaved(targetSaved, policy, ctx), checkedSource = source(incoming, policy, ctx, 0)
    localId(target, operationId)
    const projection = projectionOf(checkedSource)
    const report = previewRepositoryContinuousBranchHistory(target.projection, projection, policy, ctx.limits)
    const plan = createRepositoryContinuousBranchMergePlan(report, target.projection, projection, choices, policy, ctx.limits)
    const simulation = simulateRepositoryContinuousBranchMerge(plan, report, target.projection, projection, policy, ctx.limits)
    const pureRequest = createRepositoryContinuousBranchMergeRequest(operationId, simulation, plan, report, target.projection, projection, policy, ctx.limits)
    return freezeCopy(measure({ format: REQUEST, formatVersion: 1, kind: 'merge', operationId,
      targetSavedDigest: target.savedDigest, policyDigest: digest(policy), pureRequest, sourceArchive: checkedSource }, ctx))
  })
}
/** expectedReceipt is deterministic comparison data, never a commit receipt. */
export function projectRepositoryMergeStoreRequest(request, targetSaved, policy = {}, limits = {}) {
  return withRepositoryMergeSavedValidation([request, targetSaved, policy], limits, undefined, ctx => {
    const target = readSaved(targetSaved, policy, ctx)
    return freezeCopy(project(request, target, policy, ctx, 0))
  })
}
/** A supplied receipt is replay-checked, not authenticated. Only the IO host can
 * establish an actual atomic COMMIT and return its real local receipt. */
export function appendRepositoryMergeSavedEvent(saved, request, receipt, policy = {}, limits = {}) {
  return withRepositoryMergeSavedValidation([saved, request, receipt, policy], limits, undefined, ctx => {
    const target = readSaved(saved, policy, ctx)
    return append(target, request, receipt, policy, ctx, 0)
  })
}
/** Comparison data only: it does not prove package verification, host authority,
 * identity allocation or a successful SQLite COMMIT. No savedDigest cycle. */
export function expectedRepositoryMergeRestoreReceipt(forkModel, policy = {}, limits = {}) {
  return withRepositoryMergeSavedValidation([forkModel, policy], limits, undefined, ctx => {
    const model = readRepositorySavedBranchForkModel(forkModel, policy, ctx.limits, ctx)
    return freezeCopy(measure(restoreReceipt(model), ctx))
  })
}
/** Replay-checks a supplied initialization claim. The caller is responsible for
 * obtaining an actual COMMIT receipt from the separate IO host. */
export function createRepositoryMergeRestoredSavedArchive(forkModel, receipt, policy = {}, limits = {}) {
  return withRepositoryMergeSavedValidation([forkModel, receipt, policy], limits, undefined, ctx =>
    ctx.restore(() => restored(readRepositorySavedBranchForkModel(forkModel, policy, ctx.limits, ctx), receipt, policy, ctx)))
}
