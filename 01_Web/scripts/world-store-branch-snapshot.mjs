/** Pure experimental archive validation. Supported v2/v3 histories are replayed;
 * v1 archives preserve a baseline and receipts with unavailable edit bodies. This is not
 * a filesystem lock or an authenticity claim; unknown ancestors are refused. */
import { freezeCopy, opaqueId, shape, validateJson } from '../src/worldgraph/store/schema.ts'
import { RepositoryError, readRepositoryState, transitionRepositoryState } from './world-store-repository.mjs'
import { replayRepositoryV2 } from './world-store-repository-v2.mjs'
import { repositoryStateDigest as digest } from './world-store-repository-v2-contract.mjs'
import { assertBranchSource, readBranchDescriptor, readBranchOperationManifest } from './world-store-branch-contract.mjs'
import { readLegacyRepositoryArchive } from './world-store-legacy-archive.mjs'

const fail = code => { throw new RepositoryError(code) }
export const MAX_BRANCH_ANCESTRY = 8
const actions = new Set(['commands', 'stage-proposal', 'accept-proposal', 'reject-proposal'])
export function branchSourceReference(archive) {
  return { repositoryFormatVersion: archive.formatVersion, identityStatus: archive.formatVersion === 1 ? 'unknown' : 'known',
    identity: archive.formatVersion === 1 ? null : archive.formatVersion === 2 ? archive.identity : archive.descriptor.identity,
    snapshotDigest: digest(archive.state), repositoryRevision: archive.state.revision, archiveDigest: digest(archive) }
}
export function readRepositoryArchive(value, policy = {}, depth = 0) {
  if (depth > MAX_BRANCH_ANCESTRY) fail('E_BRANCH_ANCESTRY_LIMIT')
  validateJson(value)
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('E_BRANCH_VERSION')
  if (value.format === 'starmap.world-repository-legacy' && value.formatVersion === 1) return readLegacyRepositoryArchive(value, policy)
  if (value.format === 'starmap.world-repository-v2' && value.formatVersion === 2) return replayRepositoryV2(value, policy)
  if (value.format !== 'starmap.world-repository-branch' || value.formatVersion !== 3) fail('E_BRANCH_VERSION')
  return readBranchSnapshot(value, policy, depth)
}
function makePreview(archive, policy) {
  const value = { format: archive.formatVersion === 1 ? 'starmap.repository-upgrade-branch-preview' : 'starmap.repository-fork-preview', formatVersion: 1,
    source: branchSourceReference(archive), archive, policyDigest: digest(policy) }
  return freezeCopy({ ...value, previewDigest: digest(value) })
}
export function previewRepositoryArchive(value, policy = {}) {
  return makePreview(readRepositoryArchive(value, policy), policy)
}
export function readCreationContext(value) {
  validateJson(value)
  shape(value, ['kind', 'requestId', 'packageDigest'])
  if (value.kind !== 'backup-restore' || typeof value.packageDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.packageDigest)) fail('E_BRANCH_CONTEXT')
  opaqueId(value.requestId, 'requestId')
  return freezeCopy(value)
}
export function readBranchMetadata(value, policy = {}, depth = 0) {
  validateJson(value)
  shape(value, ['format', 'formatVersion', 'descriptor', 'sourceArchive', 'creation', 'markerDigest'])
  if (value.format !== 'starmap.world-repository-branch' || value.formatVersion !== 3) fail('E_BRANCH_VERSION')
  const descriptor = readBranchDescriptor(value.descriptor)
  if (!['fork', 'upgrade'].includes(descriptor.origin.kind)) fail('E_BRANCH_VERSION')
  const archive = readRepositoryArchive(value.sourceArchive, policy, depth + 1)
  assertBranchSource(descriptor, branchSourceReference(archive))
  shape(value.creation, ['status', 'operationId', 'requestDigest', 'previewDigest', 'policyDigest', 'context'], ['status', 'operationId', 'requestDigest', 'previewDigest', 'policyDigest'])
  const context = value.creation.context === undefined ? undefined : readCreationContext(value.creation.context)
  opaqueId(value.creation.operationId, 'operationId')
  if (value.creation.status !== 'completed') fail('E_BRANCH_INCOMPLETE')
  const expected = makePreview(archive, policy)
  const marker = { format: 'starmap.repository-branch-location', formatVersion: 1, descriptor, creation: value.creation }
  if (value.markerDigest !== digest(marker) || value.creation.previewDigest !== expected.previewDigest || value.creation.policyDigest !== expected.policyDigest
    || value.creation.requestDigest !== digest({ operationId: value.creation.operationId, previewDigest: expected.previewDigest, binding: descriptor.binding, ...(context ? { context } : {}) })) fail('E_BRANCH_CORRUPT')
  return freezeCopy(value)
}
export function readBranchSnapshot(value, policy = {}, depth = 0) {
  if (depth > MAX_BRANCH_ANCESTRY) fail('E_BRANCH_ANCESTRY_LIMIT')
  validateJson(value)
  shape(value, ['format', 'formatVersion', 'descriptor', 'sourceArchive', 'creation', 'markerDigest', 'state', 'history'])
  const { state: inputState, history, ...inputMeta } = value
  const metadata = readBranchMetadata(inputMeta, policy, depth)
  if (!Array.isArray(history)) fail('E_BRANCH_CHAIN')
  let state = metadata.sourceArchive.state
  const seen = new Set()
  for (const row of history) {
    shape(row, ['operationId', 'request', 'requestDigest', 'beforeDigest', 'afterDigest', 'receipt', 'after'])
    opaqueId(row.operationId, 'operationId')
    if (seen.has(row.operationId) || row.operationId !== row.request?.id || !actions.has(row.request?.action?.kind)
      || row.requestDigest !== digest(row.request) || row.beforeDigest !== digest(state)) fail('E_BRANCH_CHAIN')
    seen.add(row.operationId)
    const after = transitionRepositoryState(state, row.request, policy)
    shape(row.receipt, ['status', 'identity', 'operationId', 'repositoryRevision', 'worldRevision'])
    readBranchOperationManifest([{ identity: row.receipt.identity, operationId: row.operationId, requestDigest: row.requestDigest }], metadata.descriptor.identity)
    if (row.receipt.status !== 'committed' || row.receipt.operationId !== row.operationId || row.receipt.repositoryRevision !== after.revision
      || row.receipt.worldRevision !== after.world.revision || row.afterDigest !== digest(after) || digest(row.after) !== digest(after)) fail('E_BRANCH_CHAIN')
    state = after
  }
  if (digest(readRepositoryState(inputState, policy)) !== digest(state)) fail('E_BRANCH_CHAIN')
  return freezeCopy(value)
}
