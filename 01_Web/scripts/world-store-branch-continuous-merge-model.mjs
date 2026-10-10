/** Experimental continuous merge DAG. Pure replay, never a saved repository.
 * Existing v3 readers/writers deliberately reject this independent format.
 * Every source remains complete; hypothetical operations are NOT receipts.
 */
import { freezeCopy, jsonKey, opaqueId, shape } from '../src/worldgraph/store/schema.ts'
import { RepositoryError, transitionRepositoryState } from './world-store-repository.mjs'
import { repositoryStateDigest as digest } from './world-store-repository-v2-contract.mjs'
import { readRepositoryArchive, branchSourceReference } from './world-store-branch-snapshot.mjs'
import { operationIdentityKey, readBranchDescriptor } from './world-store-branch-contract.mjs'
import { checkRepositoryMergeArchiveInputs, inspectRepositoryMergeArchiveInputs } from './world-store-branch-merge-archive-model.mjs'
import { indexValidatedRepositoryBranchHistory, previewValidatedRepositoryBranchHistory } from './world-store-branch-history-preview.mjs'
import { planValidatedRepositoryBranchMerge } from './world-store-branch-merge-plan.mjs'
import { simulateValidatedRepositoryBranchMerge } from './world-store-branch-merge-simulation.mjs'

const FORMAT = 'starmap.repository-continuous-merge-model'
const REQUEST = 'starmap.repository-continuous-merge-request'
const OPERATION_REQUEST = 'starmap.repository-continuous-operation-request'
const FORK_REQUEST = 'starmap.repository-continuous-fork-request'
const FORK_KEYS = ['format', 'formatVersion', 'operationId', 'source', 'policyDigest', 'target', 'resultDigest']
const ordinaryActions = new Set(['commands', 'stage-proposal', 'accept-proposal', 'reject-proposal'])
const OPERATION_KEYS = ['format', 'formatVersion', 'target', 'policyDigest', 'operation', 'resultDigest']
const flags = () => ({ executable: false, persisted: false, commands: [], foreignReceiptsBecomeLocal: false, newLocalApprovalIssued: false })
const MODEL_KEYS = ['format', 'formatVersion', 'nodes', 'headId', 'descriptor', 'state', ...Object.keys(flags()), 'modelDigest']
const REQUEST_KEYS = ['format', 'formatVersion', 'operationId', 'target', 'source', 'policyDigest', 'choices',
  'previewDigest', 'planDigest', 'simulationDigest', 'resultDigest']
const fail = code => { throw new RepositoryError(code) }
const equal = (a, b) => jsonKey(a) === jsonKey(b)
const sorted = map => [...map].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value)
const mergeMaps = (a, b, code) => {
  const result = new Map(a)
  for (const [key, value] of b) {
    if (result.has(key) && !equal(result.get(key), value)) fail(code)
    result.set(key, value)
  }
  return result
}
const nodeId = raw => digest(raw)
function preflight(values, limits) { return checkRepositoryMergeArchiveInputs(values, limits) }

function makeModel(view, policy, limits, budget) {
  const raw = { format: FORMAT, formatVersion: view.modelVersion ?? 1, nodes: sorted(view.graph), headId: view.headId,
    descriptor: view.descriptor, state: view.state, ...flags() }
  const usage = inspectRepositoryMergeArchiveInputs([raw, policy], limits)
  if (budget) {
    budget.nodes += usage.nodes; budget.bytes += usage.bytes
    if (budget.nodes > limits.maxNodes || budget.bytes > limits.maxBytes) fail('E_CONTINUOUS_MERGE_DERIVED_BUDGET')
  }
  const model = { ...raw, modelDigest: digest(raw) }
  preflight([model, policy], limits)
  return freezeCopy(model)
}
function modelReference(model) {
  return { archiveFormat: FORMAT, modelFormatVersion: model.formatVersion, identityStatus: 'known', identity: model.descriptor.identity,
    snapshotDigest: digest(model.state), repositoryRevision: model.state.revision, archiveDigest: digest(model) }
}
function leafView(input, policy, limits) {
  let current = input, height = 0
  const archives = new Set()
  while (current) {
    if (height++ > limits.maxAncestry) fail('E_BRANCH_ANCESTRY_LIMIT')
    archives.add(digest(current))
    if (archives.size > limits.maxArchives) fail('E_BRANCH_MERGE_ARCHIVE_COUNT')
    if (current.formatVersion !== 3) break
    current = current.sourceArchive
  }
  const archive = readRepositoryArchive(input, policy)
  const raw = { kind: 'archive', archive }, id = nodeId(raw), node = { nodeId: id, ...raw }
  const history = indexValidatedRepositoryBranchHistory(archive)
  const checkpoints = new Map(), parents = new Map()
  let previous = null
  for (const checkpoint of history.checkpoints) {
    const edges = parents.get(checkpoint.key) ?? new Set()
    if (previous !== null && previous !== checkpoint.key) edges.add(previous)
    checkpoints.set(checkpoint.key, checkpoint); parents.set(checkpoint.key, edges)
    previous = checkpoint.key
  }
  return { state: archive.state, descriptor: archive.formatVersion === 3 ? archive.descriptor : null,
    reference: branchSourceReference(archive), graph: new Map([[id, node]]), headId: id,
    history: { ...history, checkpoints: [...checkpoints.values()] }, parents, checkpointKey: previous,
    archivedOperations: history.operations, modeledOperations: new Map(), height: height - 1, archives }
}
function maximalCommon(target, source, limits) {
  const shared = target.history.checkpoints.filter(row => source.parents.has(row.key))
  const sharedKeys = new Set(shared.map(row => row.key)), dominated = new Set()
  let work = 0
  for (const row of shared) {
    const seen = new Set(), pending = [...(target.parents.get(row.key) ?? []), ...(source.parents.get(row.key) ?? [])]
    while (pending.length) {
      if (++work > limits.maxNodes) fail('E_CONTINUOUS_MERGE_WORK')
      const key = pending.pop()
      if (seen.has(key)) continue
      seen.add(key)
      if (sharedKeys.has(key)) { dominated.add(key); continue }
      pending.push(...(target.parents.get(key) ?? []), ...(source.parents.get(key) ?? []))
    }
  }
  const maximal = shared.filter(row => !dominated.has(row.key))
  return { common: maximal.length === 1 ? maximal[0] : null, ambiguous: maximal.length > 1 }
}
function checkedOutput(value, policy, limits) { preflight([value, policy], limits); return value }
function tagged(value, format, digestKey) {
  const raw = { ...value, ...flags(), format }; delete raw[digestKey]
  return freezeCopy({ ...raw, [digestKey]: digest(raw) })
}
function previewViews(target, source, policy, limits) {
  const known = target.reference.identityStatus === 'known' && source.reference.identityStatus === 'known'
  const sameFamily = known && target.reference.identity.libraryId === source.reference.identity.libraryId
  const { common, ambiguous } = sameFamily ? maximalCommon(target, source, limits) : { common: null, ambiguous: false }
  const conflicts = ambiguous ? [{ kind: 'ambiguous-common-history' }] : []
  const report = previewValidatedRepositoryBranchHistory({ state: target.state }, { state: source.state }, policy,
    target.history, source.history, common, conflicts, { target: target.reference, source: source.reference })
  checkedOutput(report, policy, limits)
  return checkedOutput(tagged(report, 'starmap.repository-continuous-history-preview', 'previewDigest'), policy, limits)
}
function prepareViews(target, source, choices, policy, limits) {
  const report = previewViews(target, source, policy, limits)
  const computedPlan = checkedOutput(planValidatedRepositoryBranchMerge(report, target.state, source.state, choices), policy, limits)
  const plan = checkedOutput(tagged(computedPlan, 'starmap.repository-continuous-merge-plan', 'planDigest'), policy, limits)
  const computedSimulation = checkedOutput(simulateValidatedRepositoryBranchMerge(plan, target.state, source.state, policy), policy, limits)
  const simulation = checkedOutput(tagged(computedSimulation, 'starmap.repository-continuous-merge-simulation', 'simulationDigest'), policy, limits)
  return { report, plan, simulation }
}
function requestViews(operationId, target, source, choices, policy, limits) {
  opaqueId(operationId, '$.operationId')
  if (!target.descriptor) fail('E_CONTINUOUS_MERGE_TARGET')
  const key = operationIdentityKey(target.descriptor.identity, operationId)
  if (target.history.operations.has(key) || source.history.operations.has(key)) fail('E_REPO_OPERATION_CONFLICT')
  const { report, plan, simulation } = prepareViews(target, source, choices, policy, limits)
  if (simulation.status !== 'validated' || !simulation.combinedStateValidated || !simulation.decisionsComplete) fail('E_CONTINUOUS_MERGE_INCOMPLETE')
  if (simulation.archiveSelection !== 'source') fail('E_CONTINUOUS_MERGE_NOOP')
  return { request: { format: REQUEST, formatVersion: 1, operationId, target: target.reference, source: source.reference,
    policyDigest: digest(policy), choices: plan.decisions.map(({ itemId, choice }) => ({ itemId, choice })),
    previewDigest: report.previewDigest, planDigest: plan.planDigest, simulationDigest: simulation.simulationDigest,
    resultDigest: simulation.candidateDigest }, simulation }
}
function graphBudget(target, source, limits, reserve = 0) {
  const archives = new Set([...target.archives, ...source.archives])
  const eventIds = new Set([...target.graph, ...source.graph].filter(([, row]) => row.kind !== 'archive').map(([id]) => id))
  if (archives.size + eventIds.size + reserve > limits.maxArchives) fail('E_BRANCH_MERGE_ARCHIVE_COUNT')
  return archives
}
function appendView(target, source, operationId, choices, policy, limits, budget) {
  const height = Math.max(target.height, source.height) + 1
  if (height > limits.maxAncestry) fail('E_BRANCH_ANCESTRY_LIMIT')
  const archives = graphBudget(target, source, limits, 1)
  const graph = mergeMaps(target.graph, source.graph, 'E_CONTINUOUS_MERGE_NODE')
  const { request, simulation } = requestViews(operationId, target, source, choices, policy, limits)
  const raw = { kind: 'merge', targetId: target.headId, sourceId: source.headId, request }, id = nodeId(raw)
  const node = { nodeId: id, ...raw }
  preflight([node, simulation.candidate, policy], limits)
  graph.set(id, node)
  const operation = { identity: target.descriptor.identity, operationId, requestDigest: digest(request),
    beforeDigest: target.reference.snapshotDigest, afterDigest: simulation.candidateDigest }
  const operations = mergeMaps(target.history.operations, source.history.operations, 'E_BRANCH_HISTORY_NAMESPACE')
  const branches = mergeMaps(target.history.branches, source.history.branches, 'E_BRANCH_HISTORY_NAMESPACE')
  operations.set(operationIdentityKey(operation.identity, operationId), operation)
  const modeledOperations = mergeMaps(target.modeledOperations, source.modeledOperations, 'E_BRANCH_HISTORY_NAMESPACE')
  modeledOperations.set(operationIdentityKey(operation.identity, operationId), operation)
  const checkpoint = { identity: target.descriptor.identity, repositoryRevision: simulation.candidate.revision,
    stateDigest: digest(simulation.candidate), historyDigest: digest({ nodeId: id }), state: simulation.candidate }
  checkpoint.key = jsonKey([checkpoint.identity, checkpoint.repositoryRevision, checkpoint.stateDigest, checkpoint.historyDigest])
  const parents = new Map([...target.parents].map(([key, values]) => [key, new Set(values)]))
  for (const [key, values] of source.parents) parents.set(key, new Set([...(parents.get(key) ?? []), ...values]))
  parents.set(checkpoint.key, new Set([target.checkpointKey, source.checkpointKey].filter(key => key !== null)))
  const checkpoints = new Map([...target.history.checkpoints, ...source.history.checkpoints].map(row => [row.key, row]))
  checkpoints.set(checkpoint.key, checkpoint)
  const view = { state: simulation.candidate, descriptor: target.descriptor, graph, headId: id, height, archives,
    modelVersion: Math.max(target.modelVersion ?? 1, source.modelVersion ?? 1),
    history: { operations, branches, checkpoints: [...checkpoints.values()], legacy: mergeMaps(target.history.legacy, source.history.legacy, 'E_BRANCH_HISTORY_NAMESPACE') },
    parents, checkpointKey: checkpoint.key, modeledOperations,
    archivedOperations: mergeMaps(target.archivedOperations, source.archivedOperations, 'E_BRANCH_HISTORY_NAMESPACE') }
  view.archive = makeModel(view, policy, limits, budget)
  view.reference = modelReference(view.archive)
  return view
}

function appendOrdinaryView(target, input, policy, limits, budget) {
  if (!target.descriptor) fail('E_CONTINUOUS_MERGE_TARGET')
  if (target.height > limits.maxAncestry) fail('E_BRANCH_ANCESTRY_LIMIT')
  graphBudget(target, target, limits, 1)
  if (!ordinaryActions.has(input?.action?.kind)) fail('E_CONTINUOUS_OPERATION_KIND')
  // No bare repository merge action: source DAG and explicit choices must use
  // the continuous merge request. Ordinary acceptance remains hypothetical.
  opaqueId(input.id, '$.operation.id')
  const key = operationIdentityKey(target.descriptor.identity, input.id)
  if (target.history.operations.has(key)) fail('E_REPO_OPERATION_CONFLICT')
  const after = transitionRepositoryState(target.state, input, policy)
  checkedOutput(after, policy, limits)
  const request = { format: OPERATION_REQUEST, formatVersion: 1, target: target.reference,
    policyDigest: digest(policy), operation: freezeCopy(input), resultDigest: digest(after) }
  preflight([request, after, policy], limits)
  const raw = { kind: 'operation', targetId: target.headId, request }, id = nodeId(raw)
  const graph = new Map(target.graph); graph.set(id, { nodeId: id, ...raw })
  const operation = { identity: target.descriptor.identity, operationId: input.id,
    requestDigest: digest(request), beforeDigest: target.reference.snapshotDigest, afterDigest: request.resultDigest }
  const operations = new Map(target.history.operations), modeledOperations = new Map(target.modeledOperations)
  operations.set(key, operation); modeledOperations.set(key, operation)
  const checkpoint = { identity: target.descriptor.identity, repositoryRevision: after.revision,
    stateDigest: digest(after), historyDigest: digest({ nodeId: id }), state: after }
  checkpoint.key = jsonKey([checkpoint.identity, checkpoint.repositoryRevision, checkpoint.stateDigest, checkpoint.historyDigest])
  const parents = new Map(target.parents)
  parents.set(checkpoint.key, new Set([target.checkpointKey].filter(key => key !== null)))
  // Ordinary local events do not add a fork/merge ancestry generation. Their
  // chain length is bounded independently by the whole graph/event quota.
  const view = { state: after, descriptor: target.descriptor, graph, headId: id, height: target.height,
    archives: target.archives, modelVersion: Math.max(target.modelVersion ?? 1, 2),
    history: { ...target.history, operations, checkpoints: [...target.history.checkpoints, checkpoint] },
    parents, checkpointKey: checkpoint.key, modeledOperations, archivedOperations: target.archivedOperations }
  view.archive = makeModel(view, policy, limits, budget)
  view.reference = modelReference(view.archive)
  return view
}
function appendForkView(source, operationId, inputTarget, policy, limits, budget) {
  opaqueId(operationId, '$.operationId')
  shape(inputTarget, ['identity', 'binding'])
  // Reuse only identity/binding syntax. This independent descriptor never
  // masquerades as a native v3 fork, and caller IDs are not allocations.
  const syntax = readBranchDescriptor({ format: 'starmap.repository-branch', formatVersion: 1,
    identity: inputTarget.identity, binding: inputTarget.binding, origin: { kind: 'new', source: null } })
  if (source.reference.identityStatus !== 'known' || syntax.identity.libraryId !== source.reference.identity.libraryId) fail('E_CONTINUOUS_FORK_TARGET')
  for (const identity of [source.reference.identity, ...[...source.history.branches.values()].map(row => row.identity)]) {
    if (syntax.identity.branchId === identity.branchId || syntax.identity.genesisId === identity.genesisId) fail('E_CONTINUOUS_FORK_TARGET')
  }
  const height = source.height + 1
  if (height > limits.maxAncestry) fail('E_BRANCH_ANCESTRY_LIMIT')
  graphBudget(source, source, limits, 1)
  const target = { identity: syntax.identity, binding: syntax.binding }
  const request = { format: FORK_REQUEST, formatVersion: 1, operationId, source: source.reference,
    policyDigest: digest(policy), target, resultDigest: digest(source.state) }
  const raw = { kind: 'fork', sourceId: source.headId, request }, id = nodeId(raw)
  preflight([raw, source.state, policy], limits)
  const graph = new Map(source.graph); graph.set(id, { nodeId: id, ...raw })
  const descriptor = { format: 'starmap.repository-continuous-fork-branch', formatVersion: 1,
    ...target, origin: { kind: 'saved-fork', source: source.reference } }
  const operation = { identity: target.identity, operationId, requestDigest: digest(request),
    beforeDigest: request.resultDigest, afterDigest: request.resultDigest }
  const key = operationIdentityKey(target.identity, operationId), operations = new Map(source.history.operations)
  if (operations.has(key)) fail('E_REPO_OPERATION_CONFLICT')
  operations.set(key, operation)
  const modeledOperations = new Map(source.modeledOperations); modeledOperations.set(key, operation)
  const branches = new Map(source.history.branches)
  branches.set(jsonKey([target.identity.libraryId, target.identity.branchId]), { identity: target.identity, originDigest: digest({ nodeId: id }) })
  const checkpoint = { identity: target.identity, repositoryRevision: source.state.revision,
    stateDigest: request.resultDigest, historyDigest: digest({ nodeId: id }), state: source.state }
  checkpoint.key = jsonKey([checkpoint.identity, checkpoint.repositoryRevision, checkpoint.stateDigest, checkpoint.historyDigest])
  const parents = new Map(source.parents)
  parents.set(checkpoint.key, new Set([source.checkpointKey].filter(value => value !== null)))
  const view = { state: source.state, descriptor, graph, headId: id, height, archives: source.archives, modelVersion: 3,
    history: { ...source.history, operations, branches, checkpoints: [...source.history.checkpoints, checkpoint] },
    parents, checkpointKey: checkpoint.key, modeledOperations, archivedOperations: source.archivedOperations }
  view.archive = makeModel(view, policy, limits, budget)
  view.reference = modelReference(view.archive)
  return view
}
function readView(input, policy, limits, budget = { nodes: 0, bytes: 0 }) {
  if (input?.format !== FORMAT) return leafView(input, policy, limits)
  shape(input, MODEL_KEYS)
  if (![1, 2, 3].includes(input.formatVersion) || !Array.isArray(input.nodes) || input.nodes.length > limits.maxArchives) fail('E_CONTINUOUS_MERGE_VERSION')
  const nodes = new Map()
  for (const node of input.nodes) {
    if (node.kind === 'archive') shape(node, ['nodeId', 'kind', 'archive'])
    else if (node.kind === 'merge') shape(node, ['nodeId', 'kind', 'targetId', 'sourceId', 'request'])
    else if (node.kind === 'operation') {
      if (input.formatVersion < 2) fail('E_CONTINUOUS_MERGE_VERSION')
      shape(node, ['nodeId', 'kind', 'targetId', 'request'])
    }
    else if (node.kind === 'fork') {
      if (input.formatVersion !== 3) fail('E_CONTINUOUS_MERGE_VERSION')
      shape(node, ['nodeId', 'kind', 'sourceId', 'request'])
    }
    else fail('E_CONTINUOUS_MERGE_NODE')
    const { nodeId: id, ...raw } = node
    if (id !== nodeId(raw) || nodes.has(id)) fail('E_CONTINUOUS_MERGE_NODE')
    nodes.set(id, node)
  }
  const cache = new Map(), active = new Set()
  function visit(id, depth) {
    const depthLimit = input.formatVersion === 1 ? limits.maxAncestry : limits.maxArchives
    if (depth > depthLimit) fail('E_BRANCH_ANCESTRY_LIMIT')
    if (active.has(id)) fail('E_CONTINUOUS_MERGE_CYCLE')
    if (cache.has(id)) return cache.get(id)
    const node = nodes.get(id)
    if (!node) fail('E_CONTINUOUS_MERGE_MISSING')
    active.add(id)
    let view
    if (node.kind === 'archive') view = leafView(node.archive, policy, limits)
    else if (node.kind === 'operation') {
      shape(node.request, OPERATION_KEYS)
      view = appendOrdinaryView(visit(node.targetId, depth + 1), node.request.operation, policy, limits, budget)
    } else if (node.kind === 'fork') {
      shape(node.request, FORK_KEYS)
      view = appendForkView(visit(node.sourceId, depth + 1), node.request.operationId, node.request.target, policy, limits, budget)
    } else {
      shape(node.request, REQUEST_KEYS)
      const target = visit(node.targetId, depth + 1), source = visit(node.sourceId, depth + 1)
      view = appendView(target, source, node.request.operationId, node.request.choices, policy, limits, budget)
    }
    if (!equal(node, view.graph.get(view.headId))) fail('E_CONTINUOUS_MERGE_STALE')
    active.delete(id); cache.set(id, view)
    return view
  }
  const view = visit(input.headId, 0)
  if (cache.size !== nodes.size || !['merge', 'operation', 'fork'].includes(nodes.get(input.headId)?.kind)) fail('E_CONTINUOUS_MERGE_ORPHAN')
  if (!equal(input, view.archive)) fail('E_CONTINUOUS_MERGE_STALE')
  return view
}
function context(target, source, policy, inputLimits, extras = []) {
  const limits = preflight([target, source, policy, ...extras], inputLimits)
  const budget = { nodes: 0, bytes: 0 }
  const checked = { target: readView(target, policy, limits, budget), source: readView(source, policy, limits, budget), limits, budget }
  graphBudget(checked.target, checked.source, limits)
  return checked
}

export function readRepositoryContinuousMergeModel(value, policy = {}, inputLimits = {}) {
  const limits = preflight([value, policy], inputLimits)
  if (value?.format !== FORMAT) fail('E_CONTINUOUS_MERGE_VERSION')
  return readView(value, policy, limits).archive
}
export function previewRepositoryContinuousBranchHistory(target, source, policy = {}, inputLimits = {}) {
  const checked = context(target, source, policy, inputLimits)
  return previewViews(checked.target, checked.source, policy, checked.limits)
}
export function createRepositoryContinuousBranchMergePlan(report, target, source, choices = [], policy = {}, inputLimits = {}) {
  const checked = context(target, source, policy, inputLimits, [report, choices])
  const prepared = prepareViews(checked.target, checked.source, choices, policy, checked.limits)
  if (!equal(report, prepared.report)) fail('E_BRANCH_HISTORY_PREVIEW_STALE')
  return prepared.plan
}
function checkedSimulation(plan, report, target, source, policy, inputLimits, extras = []) {
  const checked = context(target, source, policy, inputLimits, [plan, report, ...extras])
  if (!Array.isArray(plan?.decisions)) fail('E_BRANCH_MERGE_PLAN_STALE')
  for (const row of plan.decisions) shape(row, ['itemId', 'choice', 'explicit'])
  const choices = plan.decisions.filter(row => row.explicit).map(({ itemId, choice }) => ({ itemId, choice }))
  const prepared = prepareViews(checked.target, checked.source, choices, policy, checked.limits)
  if (!equal(report, prepared.report)) fail('E_BRANCH_HISTORY_PREVIEW_STALE')
  if (!equal(plan, prepared.plan)) fail('E_BRANCH_MERGE_PLAN_STALE')
  return { ...checked, ...prepared, choices }
}
export function simulateRepositoryContinuousBranchMerge(plan, report, target, source, policy = {}, inputLimits = {}) {
  return checkedSimulation(plan, report, target, source, policy, inputLimits).simulation
}
export function createRepositoryContinuousBranchMergeRequest(operationId, simulation, plan, report, target, source, policy = {}, inputLimits = {}) {
  const checked = checkedSimulation(plan, report, target, source, policy, inputLimits, [operationId, simulation])
  if (!equal(simulation, checked.simulation)) fail('E_BRANCH_MERGE_SIMULATION_STALE')
  // Prove the same complete replay fits graph height and cumulative budgets
  // before issuing a request; this is still a hypothetical operation only.
  const view = appendView(checked.target, checked.source, operationId, checked.choices, policy, checked.limits, checked.budget)
  const request = view.graph.get(view.headId).request
  const result = { ...request, sourceArchive: source }
  preflight([result, policy], checked.limits)
  return freezeCopy(result)
}
export function replayRepositoryContinuousBranchMerge(request, target, policy = {}, inputLimits = {}) {
  const limits = preflight([request, target, policy], inputLimits)
  shape(request, [...REQUEST_KEYS, 'sourceArchive'])
  const budget = { nodes: 0, bytes: 0 }
  const before = readView(target, policy, limits, budget), source = readView(request.sourceArchive, policy, limits, budget)
  if (!equal(request.target, before.reference) || request.policyDigest !== digest(policy)) fail('E_CONTINUOUS_MERGE_STALE')
  const view = appendView(before, source, request.operationId, request.choices, policy, limits, budget)
  const expected = { ...view.graph.get(view.headId).request, sourceArchive: request.sourceArchive }
  if (!equal(request, expected)) fail('E_CONTINUOUS_MERGE_STALE')
  return view.archive
}

/** Bind an ordinary request to the complete target history. Pure projection
 * only: caller-supplied IDs and review decisions are neither reserved nor
 * approved, and no actual operation receipt is issued.
 */
export function createRepositoryContinuousOperationRequest(operation, target, policy = {}, inputLimits = {}) {
  const limits = preflight([operation, target, policy], inputLimits), budget = { nodes: 0, bytes: 0 }
  const view = appendOrdinaryView(readView(target, policy, limits, budget), operation, policy, limits, budget)
  return freezeCopy(view.graph.get(view.headId).request)
}
export function replayRepositoryContinuousOperation(request, target, policy = {}, inputLimits = {}) {
  const limits = preflight([request, target, policy], inputLimits), budget = { nodes: 0, bytes: 0 }
  shape(request, OPERATION_KEYS)
  const before = readView(target, policy, limits, budget)
  if (!equal(request.target, before.reference) || request.policyDigest !== digest(policy)) fail('E_CONTINUOUS_OPERATION_STALE')
  const view = appendOrdinaryView(before, request.operation, policy, limits, budget)
  if (!equal(request, view.graph.get(view.headId).request)) fail('E_CONTINUOUS_OPERATION_STALE')
  return view.archive
}
/** Pure new-namespace checkpoint on a complete validated source graph. No
 * saved reader is imported here; a storage layer must bind its complete Saved
 * anchor separately, allocate IDs and issue receipts only after real COMMIT.
 */
export function createRepositoryContinuousBranchForkRequest(operationId, sourceProjection, target, policy = {}, inputLimits = {}) {
  const limits = preflight([operationId, sourceProjection, target, policy], inputLimits), budget = { nodes: 0, bytes: 0 }
  const view = appendForkView(readView(sourceProjection, policy, limits, budget), operationId, target, policy, limits, budget)
  return freezeCopy(view.graph.get(view.headId).request)
}
export function replayRepositoryContinuousBranchFork(request, sourceProjection, policy = {}, inputLimits = {}) {
  const limits = preflight([request, sourceProjection, policy], inputLimits), budget = { nodes: 0, bytes: 0 }
  shape(request, FORK_KEYS)
  const source = readView(sourceProjection, policy, limits, budget)
  if (!equal(request.source, source.reference) || request.policyDigest !== digest(policy)) fail('E_CONTINUOUS_FORK_STALE')
  const view = appendForkView(source, request.operationId, request.target, policy, limits, budget)
  if (!equal(request, view.graph.get(view.headId).request)) fail('E_CONTINUOUS_FORK_STALE')
  return view.archive
}
export function indexRepositoryContinuousMergeModel(value, policy = {}, inputLimits = {}) {
  const limits = preflight([value, policy], inputLimits)
  if (value?.format !== FORMAT) fail('E_CONTINUOUS_MERGE_VERSION')
  const view = readView(value, policy, limits)
  const raw = { format: 'starmap.repository-continuous-merge-index', formatVersion: 1,
    modelDigest: view.archive.modelDigest, source: view.reference, nodeIds: [...view.graph.keys()].sort(),
    branches: sorted(view.history.branches), archivedOperations: sorted(view.archivedOperations),
    hypotheticalOperations: sorted(view.modeledOperations), legacy: sorted(view.history.legacy),
    checkpoints: view.history.checkpoints.map(checkpoint => {
      const row = { ...checkpoint }; delete row.key; delete row.state
      return { ...row, parents: [...view.parents.get(checkpoint.key)].sort() }
    })
      .sort((a, b) => jsonKey(a) < jsonKey(b) ? -1 : jsonKey(a) > jsonKey(b) ? 1 : 0), ...flags() }
  preflight([raw, policy], limits)
  return freezeCopy(raw)
}
