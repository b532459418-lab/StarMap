/** Pure Saved-origin fork/restore contract. Distinct from native v3 and saved
 * repository formats. Caller-supplied identity/binding are not allocations or
 * authority. Package digests are declarations, not verified filesystem input.
 */
import { freezeCopy, jsonKey, opaqueId, shape } from '../src/worldgraph/store/schema.ts'
import { RepositoryError } from './world-store-repository.mjs'
import { repositoryStateDigest as digest } from './world-store-repository-v2-contract.mjs'
import { readBranchDescriptor } from './world-store-branch-contract.mjs'
import { inspectRepositoryMergeArchiveInputs } from './world-store-branch-merge-archive-model.mjs'
import { readRepositoryMergeSavedArchive } from './world-store-branch-merge-store-contract.mjs'

const FORMAT = 'starmap.repository-saved-branch-fork-model'
const PREVIEW = 'starmap.repository-saved-branch-fork-preview'
const REQUEST = 'starmap.repository-saved-branch-fork-request'
const flags = () => ({ executable: false, persisted: false, commands: [], foreignReceiptsBecomeLocal: false,
  newLocalApprovalIssued: false, identityAllocated: false, backupPackageVerified: false, hostValidationRequired: true })
const REQUEST_KEYS = ['format', 'formatVersion', 'operationId', 'source', 'sourceArchiveDigest', 'policyDigest',
  'previewDigest', 'target', 'restoreContext', 'resultDigest']
const MODEL_KEYS = ['format', 'formatVersion', 'descriptor', 'sourceArchive', 'request', 'operationReference',
  'restoreContext', 'state', 'localOperations', ...Object.keys(flags()), 'modelDigest']
const fail = code => { throw new RepositoryError(code) }
const equal = (a, b) => jsonKey(a) === jsonKey(b)
function context(values, limits) {
  const usage = inspectRepositoryMergeArchiveInputs(values, limits)
  return { limits: usage.limits, nodes: 0, bytes: 0 }
}
function measured(value, ctx) {
  const usage = inspectRepositoryMergeArchiveInputs([value], ctx.limits)
  ctx.nodes += usage.nodes; ctx.bytes += usage.bytes
  if (ctx.nodes > ctx.limits.maxNodes || ctx.bytes > ctx.limits.maxBytes) fail('E_SAVED_FORK_DERIVED_BUDGET')
  return value
}
function source(value, policy, ctx) {
  return readRepositoryMergeSavedArchive(value, policy, ctx.limits)
}
function reference(saved) {
  const state = saved.projection.state
  return { archiveFormat: saved.format, formatVersion: saved.formatVersion, identity: saved.baseArchive.descriptor.identity,
    archiveDigest: digest(saved), savedDigest: saved.savedDigest, snapshotDigest: digest(state),
    repositoryRevision: state.revision, worldRevision: state.world.revision }
}
function preview(saved, policy, ctx) {
  const raw = { format: PREVIEW, formatVersion: 1, source: reference(saved), policyDigest: digest(policy), ...flags() }
  measured(raw, ctx)
  return freezeCopy(measured({ ...raw, previewDigest: digest(raw) }, ctx))
}
function identities(saved, ctx) {
  const known = new Map(), seen = new Set(), pending = [saved]
  while (pending.length) {
    const value = pending.pop(), key = digest(value)
    if (seen.has(key)) continue
    seen.add(key)
    if (seen.size > ctx.limits.maxArchives) fail('E_BRANCH_MERGE_ARCHIVE_COUNT')
    if (value.format === 'starmap.repository-merge-saved') {
      pending.push(value.baseArchive)
      for (const event of value.events) if (event.storeRequest.kind === 'merge') pending.push(event.storeRequest.sourceArchive)
      if (value.projection.format === 'starmap.repository-continuous-merge-model') {
        for (const node of value.projection.nodes) if (node.kind === 'archive') pending.push(node.archive)
      }
    } else {
      const identity = value.descriptor?.identity ?? value.identity
      if (identity) known.set(jsonKey(identity), identity)
      if (value.format === 'starmap.world-repository-branch' && value.formatVersion === 3) pending.push(value.sourceArchive)
    }
  }
  return [...known.values()]
}
function parameters(input, saved, ctx) {
  shape(input, ['operationId', 'identity', 'binding', 'restoreContext'], ['operationId', 'identity', 'binding'])
  opaqueId(input.operationId, '$.operationId')
  // Reuse only identity and binding syntax; no native archive is constructed.
  const checked = readBranchDescriptor({ format: 'starmap.repository-branch', formatVersion: 1,
    identity: input.identity, origin: { kind: 'new', source: null }, binding: input.binding })
  const parent = saved.baseArchive.descriptor.identity
  if (checked.identity.libraryId !== parent.libraryId) fail('E_SAVED_FORK_IDENTITY')
  for (const existing of identities(saved, ctx)) {
    if (checked.identity.branchId === existing.branchId || checked.identity.genesisId === existing.genesisId) fail('E_SAVED_FORK_COLLISION')
  }
  const restoreContext = input.restoreContext ?? null
  if (restoreContext !== null) {
    shape(restoreContext, ['kind', 'packageDigest'])
    if (restoreContext.kind !== 'backup-restore' || typeof restoreContext.packageDigest !== 'string'
      || !/^[a-f0-9]{64}$/.test(restoreContext.packageDigest)) fail('E_SAVED_FORK_CONTEXT')
  }
  return { operationId: input.operationId, identity: checked.identity, binding: checked.binding, restoreContext }
}
function candidate(saved, args, ctx) {
  return measured({ descriptor: { format: 'starmap.repository-saved-branch', formatVersion: 1,
    identity: args.identity, origin: { kind: 'saved-fork', source: reference(saved) }, binding: args.binding },
  sourceArchiveDigest: digest(saved), state: saved.projection.state, localOperations: [], restoreContext: args.restoreContext,
  operationReference: { identity: args.identity, operationId: args.operationId }, ...flags() }, ctx)
}
function createRequest(saved, args, policy, ctx) {
  const expectedPreview = preview(saved, policy, ctx), result = candidate(saved, args, ctx)
  return freezeCopy(measured({ format: REQUEST, formatVersion: 1, operationId: args.operationId,
    source: reference(saved), sourceArchiveDigest: digest(saved), policyDigest: digest(policy), previewDigest: expectedPreview.previewDigest,
    target: { identity: args.identity, binding: args.binding }, restoreContext: args.restoreContext, resultDigest: digest(result) }, ctx))
}
function replay(request, saved, policy, ctx) {
  shape(request, REQUEST_KEYS)
  if (request.format !== REQUEST || request.formatVersion !== 1) fail('E_SAVED_FORK_VERSION')
  if (!equal(request.source, reference(saved)) || request.sourceArchiveDigest !== digest(saved) || request.policyDigest !== digest(policy)) fail('E_SAVED_FORK_STALE')
  shape(request.target, ['identity', 'binding'])
  const args = parameters({ operationId: request.operationId, ...request.target, restoreContext: request.restoreContext }, saved, ctx)
  const expected = createRequest(saved, args, policy, ctx)
  if (!equal(request, expected)) fail('E_SAVED_FORK_REQUEST')
  const result = candidate(saved, args, ctx)
  const raw = { format: FORMAT, formatVersion: 1, descriptor: result.descriptor, sourceArchive: saved, request,
    operationReference: { ...result.operationReference, requestDigest: digest(request) }, restoreContext: args.restoreContext,
    state: result.state, localOperations: [], ...flags() }
  measured(raw, ctx)
  return freezeCopy(measured({ ...raw, modelDigest: digest(raw) }, ctx))
}
export function previewRepositorySavedBranchFork(sourceSaved, policy = {}, limits = {}) {
  const ctx = context([sourceSaved, policy], limits)
  return preview(source(sourceSaved, policy, ctx), policy, ctx)
}
export function createRepositorySavedBranchForkRequest(inputPreview, sourceSaved, input, policy = {}, limits = {}) {
  const ctx = context([inputPreview, sourceSaved, input, policy], limits), saved = source(sourceSaved, policy, ctx)
  if (!equal(inputPreview, preview(saved, policy, ctx))) fail('E_SAVED_FORK_PREVIEW')
  return createRequest(saved, parameters(input, saved, ctx), policy, ctx)
}
export function replayRepositorySavedBranchFork(request, sourceSaved, policy = {}, limits = {}) {
  const ctx = context([request, sourceSaved, policy], limits), saved = source(sourceSaved, policy, ctx)
  return replay(request, saved, policy, ctx)
}
export function readRepositorySavedBranchForkModel(value, policy = {}, limits = {}) {
  const ctx = context([value, policy], limits)
  shape(value, MODEL_KEYS)
  if (value.format !== FORMAT || value.formatVersion !== 1) fail('E_SAVED_FORK_VERSION')
  const saved = source(value.sourceArchive, policy, ctx), expected = replay(value.request, saved, policy, ctx)
  if (!equal(value, expected)) fail('E_SAVED_FORK_CORRUPT')
  return expected
}
