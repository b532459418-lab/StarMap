/** Experimental pure merge event contract, NOT a v3 writer operation.
 * Recomputes an exact archived-source selection; no IO, locks, authorization,
 * ID allocation or committed receipts. Digests prove consistency, not consent.
 */
import { freezeCopy, jsonKey, opaqueId, shape, validateJson } from '../src/worldgraph/store/schema.ts'
import { RepositoryError } from './world-store-repository.mjs'
import { repositoryStateDigest as digest } from './world-store-repository-v2-contract.mjs'
import { branchSourceReference, readRepositoryArchive } from './world-store-branch-snapshot.mjs'
import { operationIdentityKey } from './world-store-branch-contract.mjs'
import { previewRepositoryBranchHistory } from './world-store-branch-history-preview.mjs'
import { createRepositoryBranchMergePlan } from './world-store-branch-merge-plan.mjs'
import { simulateRepositoryBranchMerge, assertRepositoryBranchMergeSimulationCurrent } from './world-store-branch-merge-simulation.mjs'

const FORMAT = 'starmap.repository-branch-merge-commit-request'
const equal = (a, b) => jsonKey(a) === jsonKey(b)
const fail = code => { throw new RepositoryError(code) }
const REQUEST_KEYS = ['format', 'formatVersion', 'operationId', 'target', 'sourceArchive', 'policyDigest',
  'choices', 'previewDigest', 'planDigest', 'simulationDigest', 'resultDigest']

function reconstruct(operationId, targetInput, sourceInput, choices, policy) {
  opaqueId(operationId, '$.operationId')
  const target = readRepositoryArchive(targetInput, policy), source = readRepositoryArchive(sourceInput, policy)
  // An experimental local merge must name an existing host-bound branch, never
  // infer a new local identity from a legacy/v2 source label.
  if (target.formatVersion !== 3) fail('E_BRANCH_MERGE_COMMIT_TARGET')
  if (target.history.some(row => row.operationId === operationId)) fail('E_REPO_OPERATION_CONFLICT')
  const report = previewRepositoryBranchHistory(target, source, policy)
  const localKey = operationIdentityKey(target.descriptor.identity, operationId)
  if (report.operations.incomingOnly.some(row => operationIdentityKey(row.identity, row.operationId) === localKey)) {
    fail('E_REPO_OPERATION_CONFLICT')
  }
  const plan = createRepositoryBranchMergePlan(report, target, source, choices, policy)
  const simulation = simulateRepositoryBranchMerge(plan, report, target, source, policy)
  if (simulation.status !== 'validated' || !simulation.combinedStateValidated || !simulation.decisionsComplete) {
    fail('E_BRANCH_MERGE_COMMIT_INCOMPLETE')
  }
  // Declining the archive or comparing an identical archive does not model a
  // new local commit. Archive-only adoption still models one repository step.
  if (simulation.archiveSelection !== 'source') fail('E_BRANCH_MERGE_COMMIT_NOOP')
  const request = freezeCopy({ format: FORMAT, formatVersion: 1, operationId,
    target: branchSourceReference(target), sourceArchive: source, policyDigest: digest(policy),
    choices: plan.decisions.map(row => ({ itemId: row.itemId, choice: row.choice })),
    previewDigest: report.previewDigest, planDigest: plan.planDigest,
    simulationDigest: simulation.simulationDigest, resultDigest: simulation.candidateDigest })
  return { request, target, simulation }
}

/** The caller provides an operation ID; this function does not reserve it.
 * Whole preview/plan/simulation inputs are verified before reducing them to a
 * deterministic request. Neither a valid request nor a model grants authority.
 */
export function createRepositoryBranchMergeCommitRequest(operationId, simulation, plan, report, target, source, policy = {}) {
  validateJson(operationId)
  assertRepositoryBranchMergeSimulationCurrent(simulation, plan, report, target, source, policy)
  return reconstruct(operationId, target, source,
    plan.decisions.filter(row => row.explicit).map(row => ({ itemId: row.itemId, choice: row.choice })), policy).request
}

/** Bind to the complete target archive, not only its revision or facts.
 * The source is the embedded, validated archive snapshot; no latest-file lookup
 * or authenticity assertion is performed. A future host must recheck in a lock.
 */
function checkedRequest(value, target, policy) {
  validateJson(value); validateJson(target); validateJson(policy)
  shape(value, REQUEST_KEYS)
  if (value.format !== FORMAT || value.formatVersion !== 1) fail('E_BRANCH_MERGE_COMMIT_REQUEST')
  const observed = branchSourceReference(readRepositoryArchive(target, policy))
  // Report-scoped choice IDs change when any target history changes. Identify
  // that as stale confirmation before trying to resolve the previous choices.
  if (!equal(value.target, observed) || value.policyDigest !== digest(policy)) fail('E_BRANCH_MERGE_COMMIT_STALE')
  const current = reconstruct(value.operationId, target, value.sourceArchive, value.choices, policy)
  if (!equal(value, current.request)) fail('E_BRANCH_MERGE_COMMIT_STALE')
  return current
}

export function readRepositoryBranchMergeCommitRequest(value, target, policy = {}) {
  return checkedRequest(value, target, policy).request
}

/** Model deterministic replay against the exact pre-state. This returns an
 * operation reference and hypothetical after-state, never a success receipt.
 * Existing v3 readers/writers remain unchanged and do not accept this model.
 */
export function replayRepositoryBranchMergeCommit(value, targetInput, policy = {}) {
  const { request, target, simulation } = checkedRequest(value, targetInput, policy)
  const raw = { format: 'starmap.repository-branch-merge-commit-model', formatVersion: 1,
    request, localOperation: { identity: target.descriptor.identity, operationId: request.operationId, requestDigest: digest(request) },
    beforeDigest: request.target.snapshotDigest, afterDigest: request.resultDigest,
    sourceReference: branchSourceReference(request.sourceArchive), after: simulation.candidate,
    archiveSelection: simulation.archiveSelection, sourceMode: 'exact-archived-snapshot',
    executable: false, persisted: false, commands: [], foreignReceiptsBecomeLocal: false,
    newLocalApprovalIssued: false, confirmationRequirements: simulation.confirmationRequirements }
  return freezeCopy({ ...raw, modelDigest: digest(raw) })
}

/** Compare the entire recomputed model; a recomputed hash alone is insufficient. */
export function assertRepositoryBranchMergeCommitCurrent(value, request, target, policy = {}) {
  validateJson(value)
  const current = replayRepositoryBranchMergeCommit(request, target, policy)
  if (!equal(value, current)) fail('E_BRANCH_MERGE_COMMIT_STALE')
  return current
}
