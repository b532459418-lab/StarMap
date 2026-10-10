import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seed, entry, id, candidate, NOW } from './world-store-repository.fixture.mjs'
import { readRepositoryState, transitionRepositoryState } from './world-store-repository.mjs'
import { repositoryStateDigest as digest } from './world-store-repository-v2-contract.mjs'
import { previewRepositoryArchive, readRepositoryArchive } from './world-store-branch-snapshot.mjs'
import { previewRepositoryBranchHistory } from './world-store-branch-history-preview.mjs'
import { readRepositoryBranchMergeArchiveModel, checkRepositoryMergeArchiveInputs,
  inspectRepositoryMergeArchiveInputs } from './world-store-branch-merge-archive-model.mjs'
import { readRepositoryContinuousMergeModel as read, indexRepositoryContinuousMergeModel as index,
  previewRepositoryContinuousBranchHistory as preview, createRepositoryContinuousBranchMergePlan as plan,
  simulateRepositoryContinuousBranchMerge as simulate, createRepositoryContinuousBranchMergeRequest as request,
  replayRepositoryContinuousBranchMerge as replay, createRepositoryContinuousOperationRequest as ordinaryRequest,
  replayRepositoryContinuousOperation as ordinaryReplay, createRepositoryContinuousBranchForkRequest as forkRequest,
  replayRepositoryContinuousBranchFork as forkReplay } from './world-store-branch-continuous-merge-model.mjs'

function parent(family = 'synthetic-family') {
  const state = readRepositoryState({ format: 'starmap.world-repository', formatVersion: 1, revision: 0, world: seed().world,
    identities: { format: 'starmap.v2-store-identities', version: 1, identities: [] }, proposals: [], retired: [] })
  return { format: 'starmap.world-repository-v2', formatVersion: 2,
    identity: { libraryId: family, branchId: 'root', genesisId: 'initial' },
    baseline: { sourceVersion: 1, sourceDigest: digest(state), coverage: 'baselineOnly', state, receipts: [] }, history: [], state }
}
function branch(source, name) {
  const fork = previewRepositoryArchive(source), binding = { hostId: 'synthetic', locationDigest: 'a'.repeat(64) }
  const descriptor = { format: 'starmap.repository-branch', formatVersion: 1,
    identity: { libraryId: source.identity.libraryId, branchId: name, genesisId: name + '-initial' },
    origin: { kind: 'fork', source: fork.source }, binding }
  const creation = { status: 'completed', operationId: 'create-' + name,
    requestDigest: digest({ operationId: 'create-' + name, previewDigest: fork.previewDigest, binding }),
    previewDigest: fork.previewDigest, policyDigest: digest({}) }
  return { format: 'starmap.world-repository-branch', formatVersion: 3, descriptor, sourceArchive: source, creation,
    markerDigest: digest({ format: 'starmap.repository-branch-location', formatVersion: 1, descriptor, creation }), state: source.state, history: [] }
}
function append(value, name, action) {
  const before = value.state, operation = { id: name, expectedRevision: before.revision, action }
  const after = transitionRepositoryState(before, operation)
  value.history.push({ operationId: name, request: operation, requestDigest: digest(operation), beforeDigest: digest(before),
    afterDigest: digest(after), after, receipt: { status: 'committed', ...(value.descriptor ? { identity: value.descriptor.identity } : {}),
      operationId: name, repositoryRevision: after.revision, worldRevision: after.world.revision } })
  value.state = after
  return value
}
function edit(value, name, note) {
  const row = value.state.world.entries[0]
  return append(value, name, { kind: 'commands', commands: [{ op: 'update', table: 'entries', id: row.id,
    expectedRevision: row.revision, value: { ...row, revision: row.revision + 1, fields: { ...row.fields, note } } }] })
}
function siblings() {
  const root = parent()
  return ['local', 'incoming', 'third', 'fourth'].map(name => branch(root, name))
}
const selectAll = row => row.allowedChoices.includes('source') ? 'source' : 'target'
function prepare(target, source, select = selectAll) {
  const report = preview(target, source), catalogue = plan(report, target, source)
  const selected = plan(report, target, source, catalogue.items.map(row => ({ itemId: row.itemId, choice: select(row) })))
  return { report, plan: selected, simulation: simulate(selected, report, target, source) }
}
function commit(target, source, operationId, select = selectAll) {
  const prepared = prepare(target, source, select)
  return request(operationId, prepared.simulation, prepared.plan, prepared.report, target, source)
}
const merge = (target, source, operationId, select) => replay(commit(target, source, operationId, select), target)
const refuses = (action, code) => assert.throws(action, error => code ? error.code === code : typeof error.code === 'string')
function rehash(value) { const raw = { ...value }; delete raw.modelDigest; return { ...raw, modelDigest: digest(raw) } }
function first() { const [target, source, third, fourth] = siblings(); edit(source, 'foreign', 'first'); return { target, source, third, fourth, model: merge(target, source, 'merge-1') } }
function ordinary(target, name, action, identities) {
  const input = { id: name, expectedRevision: target.state.revision, action, ...(identities ? { identities } : {}) }
  return ordinaryReplay(ordinaryRequest(input, target), target)
}
function modeledEdit(target, name, note) {
  const row = target.state.world.entries[0]
  return ordinary(target, name, { kind: 'commands', commands: [{ op: 'update', table: 'entries', id: row.id,
    expectedRevision: row.revision, value: { ...row, revision: row.revision + 1, fields: { ...row.fields, note } } }] })
}

test('two successive target merges replay complete sources, preserve descriptor and keep hypothetical receipts separate', () => {
  const { target, source, third, model } = first(), before = structuredClone({ target, source, third, model })
  edit(third, 'foreign-third', 'second')
  const second = merge(model, third, 'merge-2'), report = index(second)
  assert.deepEqual(read(second), second)
  assert.equal(second.state.world.entries[0].fields.note, 'second')
  assert.equal(second.state.revision, model.state.revision + 1)
  assert.deepEqual(second.descriptor, target.descriptor)
  assert.equal(report.hypotheticalOperations.length, 2)
  assert.equal(report.archivedOperations.length, 2)
  assert.ok(second.nodes.some(row => row.kind === 'archive' && row.archive.descriptor.identity.branchId === 'incoming'))
  for (const row of report.hypotheticalOperations) { assert.ok(!Object.hasOwn(row, 'receipt')); assert.ok(!Object.hasOwn(row, 'status')) }
  assert.equal(second.executable, false); assert.equal(second.persisted, false); assert.deepEqual(second.commands, [])
  assert.equal(second.foreignReceiptsBecomeLocal, false); assert.equal(second.newLocalApprovalIssued, false)
  const prepared = prepare(model, third)
  for (const output of [prepared.report, prepared.plan, prepared.simulation]) {
    assert.equal(output.executable, false); assert.equal(output.persisted, false); assert.deepEqual(output.commands, [])
    assert.equal(output.foreignReceiptsBecomeLocal, false); assert.equal(output.newLocalApprovalIssued, false)
  }
  assert.ok(Object.isFrozen(second.state.world.entries)); assert.ok(Object.isFrozen(second.nodes))
  assert.deepEqual({ target, source, model }, { target: before.target, source: before.source, model: before.model })
})

test('a continuous model is a complete source, not just its after-state', () => {
  const { third, model } = first(), adopted = merge(third, model, 'merge-source')
  assert.equal(adopted.state.world.entries[0].fields.note, 'first')
  assert.equal(adopted.descriptor.identity.branchId, 'third')
  assert.equal(index(adopted).hypotheticalOperations.length, 2)
  for (const row of model.nodes) assert.ok(adopted.nodes.some(node => node.nodeId === row.nodeId))
  assert.deepEqual(read(adopted), adopted)
})

test('DAG deduplicates shared nodes deterministically and binds exact complete target history', () => {
  const { source, third, model } = first(), incoming = merge(third, source, 'other-merge')
  const prepared = prepare(model, incoming), value = commit(model, incoming, 'next')
  const combined = replay(value, model)
  assert.equal(new Set(combined.nodes.map(row => row.nodeId)).size, combined.nodes.length)
  assert.equal(combined.nodes.filter(row => row.kind === 'archive' && row.archive.descriptor.identity.branchId === 'incoming').length, 1)
  assert.deepEqual(combined, replay(value, model))
  const differentHistory = merge(model, third, 'history-only', row => row.domain === 'archive' ? 'source' : 'target')
  assert.equal(prepared.simulation.executable, false)
  refuses(() => replay(value, differentHistory), 'E_CONTINUOUS_MERGE_STALE')
})

test('archive-only adoption steps repository clock without fabricating world edits', () => {
  const [target, source, third] = siblings(), model = merge(target, source, 'history-1')
  const second = merge(model, third, 'history-2')
  assert.deepEqual(model.state.world, target.state.world)
  assert.equal(model.state.world.revision, target.state.world.revision)
  assert.equal(second.state.revision, target.state.revision + 2)
})

test('imported history does not automatically adopt previously declined facts on a later comparison', () => {
  const [target, source] = siblings(); edit(source, 'incoming', 'declined')
  const model = merge(target, source, 'retain-local', row => row.domain === 'archive' ? 'source' : 'target')
  assert.notEqual(model.state.world.entries[0].fields.note, 'declined')
  const report = preview(model, source), incomplete = plan(report, model, source)
  assert.ok(incomplete.items.some(row => row.domain === 'record'))
  assert.equal(incomplete.status, 'incomplete')
  const simulation = simulate(incomplete, report, model, source)
  refuses(() => request('not-auto', simulation, incomplete, report, model, source), 'E_CONTINUOUS_MERGE_INCOMPLETE')
})

test('crisscross has two incomparable maximal common checkpoints and remains blocked', () => {
  const [a, b] = siblings(), ab = merge(a, b, 'a-b'), ba = merge(b, a, 'b-a')
  const report = preview(ab, ba), prepared = prepare(ab, ba)
  assert.equal(report.commonBase, null)
  assert.ok(report.conflicts.some(row => row.kind === 'ambiguous-common-history'))
  assert.equal(prepared.plan.status, 'blocked')
  assert.equal(prepared.simulation.status, 'blocked')
  refuses(() => commit(ab, ba, 'ambiguous'), 'E_CONTINUOUS_MERGE_INCOMPLETE')
})

test('missing, deferred, forbidden and duplicate explicit choices refuse; preserving source archive is mandatory', () => {
  const { target, source } = first(), report = preview(target, source), incomplete = plan(report, target, source)
  refuses(() => request('missing', simulate(incomplete, report, target, source), incomplete, report, target, source), 'E_CONTINUOUS_MERGE_INCOMPLETE')
  refuses(() => commit(target, source, 'deferred', () => 'defer'), 'E_CONTINUOUS_MERGE_INCOMPLETE')
  refuses(() => commit(target, source, 'noop', () => 'target'), 'E_CONTINUOUS_MERGE_NOOP')
  const choice = { itemId: incomplete.items[0].itemId, choice: 'source' }
  refuses(() => plan(report, target, source, [choice, choice]), 'E_BRANCH_MERGE_CHOICE_ID')
  const noArchive = prepare(target, source, row => row.domain === 'archive' ? 'target' : selectAll(row))
  assert.equal(noArchive.simulation.status, 'invalid')
  assert.equal(noArchive.simulation.stateValidation.code, 'E_BRANCH_MERGE_ARCHIVE_REQUIRED')
})

test('local modeled and archived operation collisions refuse; foreign namespace names remain independent', () => {
  const { model, third } = first()
  refuses(() => commit(model, third, 'merge-1'), 'E_REPO_OPERATION_CONFLICT')
  const [target, source] = siblings(); edit(target, 'local-op', 'local'); edit(source, 'local-op', 'foreign')
  refuses(() => commit(target, source, 'local-op'), 'E_REPO_OPERATION_CONFLICT')
  const value = merge(target, source, 'new-local')
  assert.equal(index(value).archivedOperations.filter(row => row.operationId === 'local-op').length, 2)
})

test('family, genesis and origin conflicts stay blocked across source graphs', () => {
  const [target] = siblings(), other = branch(parent('other'), 'incoming')
  assert.equal(prepare(target, other).plan.status, 'blocked')
  refuses(() => commit(target, other, 'different'), 'E_CONTINUOUS_MERGE_INCOMPLETE')
  const [a, b] = siblings(), b2 = structuredClone(b)
  b2.descriptor.identity.genesisId = 'other-genesis'
  b2.markerDigest = digest({ format: 'starmap.repository-branch-location', formatVersion: 1, descriptor: b2.descriptor, creation: b2.creation })
  const graph = merge(a, b, 'a-b'), report = preview(graph, b2)
  assert.ok(report.conflicts.some(row => row.kind === 'branch-genesis'))
  assert.equal(prepare(graph, b2).plan.status, 'blocked')
})

test('changed result, source, policy, choices or outer flags reject even after outer digest is recomputed', () => {
  const { model } = first()
  for (const mutate of [v => { v.state.world.entries[0].fields.note = 'forged' }, v => { v.executable = true },
    v => { v.persisted = true }, v => { v.commands = [{}] }, v => { v.newLocalApprovalIssued = true },
    v => { v.foreignReceiptsBecomeLocal = true }, v => { v.descriptor.binding.hostId = 'forged' }]) {
    const value = structuredClone(model); mutate(value); refuses(() => read(rehash(value)))
  }
  const value = structuredClone(model), mergeNode = value.nodes.find(row => row.kind === 'merge')
  mergeNode.request.resultDigest = 'f'.repeat(64)
  const raw = { ...mergeNode }; delete raw.nodeId; mergeNode.nodeId = digest(raw); value.headId = mergeNode.nodeId
  value.nodes.sort((a, b) => a.nodeId.localeCompare(b.nodeId))
  refuses(() => read(rehash(value)), 'E_CONTINUOUS_MERGE_STALE')
  refuses(() => read(model, { forged: true }))
})

test('lost source nodes, duplicate nodes, unreachable additions and noncanonical order reject', () => {
  const { model, fourth } = first()
  const missing = structuredClone(model); missing.nodes.splice(missing.nodes.findIndex(row => row.kind === 'archive'), 1)
  refuses(() => read(rehash(missing)), 'E_CONTINUOUS_MERGE_MISSING')
  const duplicate = structuredClone(model); duplicate.nodes.push(duplicate.nodes[0])
  refuses(() => read(rehash(duplicate)), 'E_CONTINUOUS_MERGE_NODE')
  const raw = { kind: 'archive', archive: fourth }, orphan = structuredClone(model)
  orphan.nodes.push({ nodeId: digest(raw), ...raw }); orphan.nodes.sort((a, b) => a.nodeId < b.nodeId ? -1 : 1)
  refuses(() => read(rehash(orphan)), 'E_CONTINUOUS_MERGE_ORPHAN')
  const order = structuredClone(model); order.nodes.reverse()
  refuses(() => read(rehash(order)), 'E_CONTINUOUS_MERGE_STALE')
})

test('whole report, plan, simulation and commit inputs are rebound before acceptance', () => {
  const { target, source, third, model } = first(), prepared = prepare(model, third)
  const modified = structuredClone(prepared.report); modified.commonBase = null
  refuses(() => plan(modified, model, third), 'E_BRANCH_HISTORY_PREVIEW_STALE')
  const modifiedPlan = structuredClone(prepared.plan); modifiedPlan.executable = true
  refuses(() => simulate(modifiedPlan, prepared.report, model, third), 'E_BRANCH_MERGE_PLAN_STALE')
  const modifiedSimulation = structuredClone(prepared.simulation); modifiedSimulation.candidate.revision++
  refuses(() => request('second', modifiedSimulation, prepared.plan, prepared.report, model, third), 'E_BRANCH_MERGE_SIMULATION_STALE')
  const value = commit(target, source, 'next'), changed = structuredClone(value)
  changed.sourceArchive.state.revision++
  refuses(() => replay(changed, target))
})

test('combined reference validation still rejects orphaned adopted entries', () => {
  const [target, source] = siblings(), entity = { ...seed().world.entities[0], id: id(80), source: { ...seed().world.entities[0].source, recordId: 'entity-80' } }
  append(source, 'add', { kind: 'commands', commands: [{ op: 'create', table: 'entities', value: entity },
    { op: 'create', table: 'entries', value: { ...entry(81), entityId: id(80) } }] })
  const prepared = prepare(target, source, row => row.table === 'entries' || row.domain === 'archive' ? 'source' : 'target')
  assert.equal(prepared.simulation.status, 'invalid')
  assert.equal(prepared.simulation.stateValidation.code, 'E_REFERENCE')
})

test('target tombstones and decided proposals stay protected after a merge', () => {
  const root = parent()
  append(root, 'add', { kind: 'commands', commands: [{ op: 'create', table: 'entries', value: entry(60) }] })
  const [target, source, third] = ['local', 'incoming', 'third'].map(name => branch(root, name))
  const row = target.state.world.entries.find(value => value.id === id(60))
  append(target, 'delete', { kind: 'commands', commands: [{ op: 'remove', table: 'entries', id: row.id, expectedRevision: row.revision }] })
  const model = merge(target, source, 'keep-deleted')
  const report = preview(model, third), catalogue = plan(report, model, third)
  const item = catalogue.items.find(value => value.table === 'entries' && value.id === row.id)
  assert.equal(item.sourceBlockedReason, 'target-tombstone-is-permanent')
  refuses(() => plan(report, model, third, [{ itemId: item.itemId, choice: 'source' }]), 'E_BRANCH_MERGE_CHOICE_FORBIDDEN')
  assert.ok(model.state.retired.some(value => value.id === row.id))
  const [a, b, c] = siblings()
  append(a, 'stage', { kind: 'stage-proposal', proposal: { ...candidate(), id: 'decided', baseRevision: a.state.world.revision } })
  append(a, 'reject', { kind: 'reject-proposal', proposalId: 'decided' })
  const rejected = merge(a, b, 'retain-decision')
  append(c, 'staged', { kind: 'stage-proposal', proposal: { ...candidate(), id: 'decided', baseRevision: c.state.world.revision } })
  const r = preview(rejected, c), p = plan(r, rejected, c)
  assert.equal(p.items.find(value => value.domain === 'proposal' && value.id === 'decided').sourceBlockedReason, 'rejected-proposal-is-permanent')
})

test('a merged local accepted review and canonical identity cannot be overwritten by an incoming branch', () => {
  const [target, source, third] = siblings()
  append(target, 'stage', { kind: 'stage-proposal', proposal: candidate() })
  append(target, 'accept', { kind: 'accept-proposal', proposalId: candidate().id, decision: { reviewId: 'local-review', acceptedAt: NOW } })
  const model = merge(target, third, 'retain-accepted')
  append(source, 'incoming-stage', { kind: 'stage-proposal', proposal: { ...candidate(), reason: 'Foreign justification' } })
  append(source, 'incoming-accept', { kind: 'accept-proposal', proposalId: candidate().id, decision: { reviewId: 'foreign-review', acceptedAt: NOW } })
  const r = preview(model, source), p = plan(r, model, source)
  assert.equal(p.items.find(row => row.domain === 'proposal').sourceBlockedReason, 'accepted-proposal-is-permanent')
  const retained = merge(model, source, 'retain-local-review', row => row.domain === 'archive' ? 'source' : 'target')
  assert.ok(retained.state.world.reviews.some(row => row.id === 'local-review'))
  assert.ok(!retained.state.world.reviews.some(row => row.id === 'foreign-review'))
  assert.equal(retained.state.proposals[0].reason, target.state.proposals[0].reason)
  const [a, b, c] = siblings(), entity = { ...seed().world.entities[0], id: id(80), source: { ...seed().world.entities[0].source, recordId: 'left' } }
  append(a, 'left', { kind: 'commands', commands: [{ op: 'create', table: 'entities', value: entity }] })
  append(b, 'right', { kind: 'commands', commands: [{ op: 'create', table: 'entities', value: { ...entity, source: { ...entity.source, recordId: 'right' } } }] })
  const canonical = merge(a, c, 'retain-id'), report = preview(canonical, b), catalogue = plan(report, canonical, b)
  const item = catalogue.items.find(row => row.table === 'entities' && row.id === id(80))
  assert.equal(item.sourceBlockedReason, 'canonical-identity-is-permanent')
  refuses(() => plan(report, canonical, b, [{ itemId: item.itemId, choice: 'source' }]), 'E_BRANCH_MERGE_CHOICE_FORBIDDEN')
})

test('tampered decisions, policy and source references refuse despite new node and model hashes', () => {
  const { model } = first()
  for (const mutate of [r => { r.choices[0].choice = 'defer' }, r => { r.policyDigest = 'f'.repeat(64) },
    r => { r.source.archiveDigest = 'e'.repeat(64) }, r => { r.previewDigest = 'd'.repeat(64) }]) {
    const value = structuredClone(model), node = value.nodes.find(row => row.kind === 'merge')
    mutate(node.request)
    const raw = { ...node }; delete raw.nodeId
    node.nodeId = digest(raw); value.headId = node.nodeId
    value.nodes.sort((a, b) => a.nodeId < b.nodeId ? -1 : 1)
    refuses(() => read(rehash(value)))
  }
})

test('unproven legacy ancestry does not become approval or an invented local descriptor', () => {
  const root = parent(), legacy = { format: 'starmap.world-repository-legacy', formatVersion: 1,
    coverage: 'baselineOnly', editBodies: 'unavailable', state: root.state, receipts: [] }
  const [target] = siblings(), prepared = prepare(target, legacy)
  assert.equal(prepared.plan.status, 'blocked')
  refuses(() => commit(target, legacy, 'unknown'), 'E_CONTINUOUS_MERGE_INCOMPLETE')
  refuses(() => commit(root, target, 'v2-target'), 'E_CONTINUOUS_MERGE_TARGET')
})

test('old v3 and single-terminal readers do not silently accept the continuous format', () => {
  const { target, source, model } = first()
  assert.deepEqual(readRepositoryArchive(target), target)
  assert.ok(previewRepositoryBranchHistory(target, source).commonBase)
  refuses(() => readRepositoryArchive(model), 'E_BRANCH_VERSION')
  refuses(() => previewRepositoryBranchHistory(model, source), 'E_BRANCH_VERSION')
  refuses(() => readRepositoryBranchMergeArchiveModel(model))
})

test('all new entry points reject getter and Proxy input before any trap executes', () => {
  const { target, source, model } = first(), prepared = prepare(target, source), value = commit(target, source, 'new')
  let calls = 0
  const trap = () => { calls++; throw new Error('must not execute') }
  const proxy = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap })
  const getter = { get any() { return trap() } }
  const revoked = Proxy.revocable([], {}); revoked.revoke()
  for (const bad of [proxy, getter, revoked.proxy]) {
    for (const action of [() => read(bad), () => index(bad), () => preview(bad, source), () => preview(target, bad),
      () => plan(prepared.report, target, source, bad), () => simulate(bad, prepared.report, target, source),
      () => request('id', bad, prepared.plan, prepared.report, target, source), () => replay(bad, target),
      () => read(model, bad), () => read(model, {}, bad), () => replay(value, bad)]) refuses(action, 'E_BRANCH_MERGE_ARCHIVE_JSON')
  }
  assert.equal(calls, 0)
})

test('cycles, sparse arrays, custom prototypes and unsupported shapes are bounded rejections', () => {
  const { model } = first(), cycle = {}; cycle.self = cycle
  for (const input of [cycle, new Array(2), Object.create({}), new Date(), { value: undefined }, { value: Infinity }]) refuses(() => read(input))
  const forged = structuredClone(model); forged.receipt = { status: 'committed' }
  refuses(() => read(rehash(forged)))
})

test('node, byte, archive and ancestry limits can only tighten and apply to the whole graph', () => {
  const { model, third } = first()
  for (const limits of [{ maxNodes: 2 }, { maxBytes: 16 }, { maxDepth: 1 }, { maxArchives: 1 }, { maxAncestry: 0 }]) {
    refuses(() => read(model, {}, limits)); refuses(() => index(model, {}, limits)); refuses(() => preview(model, third, {}, limits))
  }
  refuses(() => read(model, {}, { maxAncestry: 9 }), 'E_BRANCH_MERGE_ARCHIVE_LIMIT')
  refuses(() => read(model, {}, { maxNodes: -1 }), 'E_BRANCH_MERGE_ARCHIVE_LIMIT')
})

test('combined target/source quota and new-node reservation are enforced before issuing a request', () => {
  const { model, third } = first(), prepared = prepare(model, third)
  refuses(() => preview(model, third, {}, { maxArchives: 4 }), 'E_BRANCH_MERGE_ARCHIVE_COUNT')
  assert.ok(preview(model, third, {}, { maxArchives: 5 }).commonBase)
  refuses(() => request('second', prepared.simulation, prepared.plan, prepared.report, model, third, {}, { maxArchives: 5 }), 'E_BRANCH_MERGE_ARCHIVE_COUNT')
  const value = request('second', prepared.simulation, prepared.plan, prepared.report, model, third, {}, { maxArchives: 6 })
  assert.ok(replay(value, model, {}, { maxArchives: 6 }))
  refuses(() => request('too-deep', prepared.simulation, prepared.plan, prepared.report, model, third, {}, { maxAncestry: 2 }), 'E_BRANCH_ANCESTRY_LIMIT')
})

test('cumulative intermediate model budget refuses before cloning an oversized replay cache', () => {
  const { model, source, third, fourth } = first()
  const two = merge(model, third, 'two'), three = merge(two, fourth, 'three'), four = merge(three, source, 'four')
  const usage = inspectRepositoryMergeArchiveInputs([four, {}])
  refuses(() => read(four, {}, { maxNodes: usage.nodes + 100 }), 'E_CONTINUOUS_MERGE_DERIVED_BUDGET')
  assert.deepEqual(read(four), four)
})

test('shared preflight rejects malicious exported root containers before reading length or map', () => {
  let calls = 0
  const trap = () => { calls++; throw new Error('must not execute') }
  const proxy = new Proxy([], { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap })
  const getter = []; Object.defineProperty(getter, 'map', { get: trap })
  for (const input of [proxy, getter]) {
    refuses(() => checkRepositoryMergeArchiveInputs(input), 'E_BRANCH_MERGE_ARCHIVE_JSON')
    refuses(() => inspectRepositoryMergeArchiveInputs(input), 'E_BRANCH_MERGE_ARCHIVE_JSON')
  }
  assert.equal(calls, 0)
})

test('tight node preflight rejects arrays before payload keys enumeration', () => {
  const payload = ['', '', ''], ownKeys = Reflect.ownKeys
  let enumerations = 0
  Reflect.ownKeys = value => { if (value === payload) enumerations++; return ownKeys(value) }
  try {
    refuses(() => inspectRepositoryMergeArchiveInputs([payload], { maxNodes: 3 }), 'E_BRANCH_MERGE_ARCHIVE_NODES')
  } finally { Reflect.ownKeys = ownKeys }
  assert.equal(enumerations, 0)
})

test('PR61 version1 merge-only model and whole archive digests remain byte-for-byte compatible', () => {
  // Oracle computed from the exact merged PR61 source, not this implementation.
  const { model } = first()
  assert.equal(model.formatVersion, 1)
  assert.equal(model.modelDigest, '78a9f8dab91224b3474da4b0057efda2b50b7b5d97d9aa6d7f0bc65f55c966b1')
  assert.equal(digest(model), 'a21212ac7901445f84853653364de08c3c55afb7585c78a01f4a5a669ba3389a')
  assert.deepEqual(read(model), model)
})

test('edit merge edit merge replays a complete mixed DAG without mutating its inputs', () => {
  const [target, source, third] = siblings(), original = structuredClone(target)
  const edited = modeledEdit(target, 'before-merge', 'local before')
  edit(source, 'foreign', 'source before')
  const merged = merge(edited, source, 'merge-first'), afterEdit = modeledEdit(merged, 'after-merge', 'local after')
  edit(third, 'third-edit', 'source after')
  const final = merge(afterEdit, third, 'merge-second')
  assert.equal(final.formatVersion, 2); assert.equal(final.state.world.entries[0].fields.note, 'source after')
  assert.equal(final.state.revision, target.state.revision + 4)
  assert.deepEqual(read(final), final); assert.deepEqual(target, original)
  assert.equal(final.nodes.filter(row => row.kind === 'operation').length, 2)
  assert.equal(final.nodes.filter(row => row.kind === 'merge').length, 2)
  assert.equal(index(final).hypotheticalOperations.length, 4)
  assert.equal(index(final).archivedOperations.length, 2)
  assert.deepEqual(final.descriptor, target.descriptor)
  assert.ok(Object.isFrozen(final.nodes)); assert.ok(Object.isFrozen(final.state.world.entries[0]))
})

test('mixed history can become an incoming source with all ordinary and merge nodes intact', () => {
  const { model, third } = first(), edited = modeledEdit(model, 'incoming-ordinary', 'mixed source')
  const final = merge(third, edited, 'adopt-mixed')
  assert.equal(final.formatVersion, 2); assert.equal(final.state.world.entries[0].fields.note, 'mixed source')
  for (const node of edited.nodes) assert.ok(final.nodes.some(row => row.nodeId === node.nodeId))
  assert.equal(index(final).hypotheticalOperations.length, 3)
  assert.deepEqual(read(final), final)
})

test('ordinary stage merge accept/reject uses genuine pure candidate rules and remains hypothetical', () => {
  for (const action of ['accept-proposal', 'reject-proposal']) {
    const [target, source, third] = siblings()
    const staged = ordinary(target, 'stage', { kind: 'stage-proposal', proposal: candidate() })
    const merged = merge(staged, source, 'between')
    const operation = { id: 'decide', expectedRevision: merged.state.revision, action: { kind: action,
      proposalId: candidate().id, ...(action === 'accept-proposal' ? { decision: { reviewId: 'modeled-review', acceptedAt: NOW } } : {}) } }
    const expected = transitionRepositoryState(merged.state, operation)
    const decided = ordinaryReplay(ordinaryRequest(operation, merged), merged)
    assert.deepEqual(decided.state, expected)
    assert.equal(decided.state.proposals[0].status, action === 'accept-proposal' ? 'accepted' : 'rejected')
    assert.equal(decided.newLocalApprovalIssued, false); assert.equal(decided.persisted, false)
    const retained = merge(decided, third, 'after-decision')
    assert.equal(retained.state.proposals[0].status, decided.state.proposals[0].status)
    if (action === 'accept-proposal') assert.deepEqual(retained.state.world.reviews, decided.state.world.reviews)
    for (const row of index(retained).hypotheticalOperations) { assert.ok(!Object.hasOwn(row, 'receipt')); assert.ok(!Object.hasOwn(row, 'status')) }
  }
})

test('ordinary requests bind full history even when two target states are identical', () => {
  const [target] = siblings(), action = { kind: 'commands', commands: [{ op: 'create', table: 'entries', value: target.state.world.entries[0] }] }
  const a = ordinary(target, 'history-a', action), b = ordinary(target, 'history-b', action)
  assert.deepEqual(a.state, b.state); assert.notEqual(a.modelDigest, b.modelDigest)
  const value = ordinaryRequest({ id: 'next', expectedRevision: a.state.revision, action }, a)
  refuses(() => ordinaryReplay(value, b), 'E_CONTINUOUS_OPERATION_STALE')
  const stale = { id: 'old-revision', expectedRevision: 0, action }
  refuses(() => ordinaryRequest(stale, a), 'E_REPO_STALE')
})

test('ordinary and merge operations share the same local namespace collision boundary', () => {
  const { model, third } = first(), row = model.state.world.entries[0]
  const action = { kind: 'commands', commands: [{ op: 'create', table: 'entries', value: row }] }
  refuses(() => ordinary(model, 'merge-1', action), 'E_REPO_OPERATION_CONFLICT')
  const withOperation = ordinary(model, 'ordinary-id', action)
  refuses(() => commit(withOperation, third, 'ordinary-id'), 'E_REPO_OPERATION_CONFLICT')
  refuses(() => ordinary(withOperation, 'ordinary-id', action), 'E_REPO_OPERATION_CONFLICT')
  const distinctForeign = ordinary(model, 'foreign', action)
  assert.equal(index(distinctForeign).archivedOperations.filter(row => row.operationId === 'foreign').length, 1)
  assert.equal(index(distinctForeign).hypotheticalOperations.filter(row => row.operationId === 'foreign').length, 1)
})

test('ordinary accepts only four supported actions, never the bare merge shortcut or forged receipt fields', () => {
  const { model } = first()
  for (const kind of ['merge', 'authorize', 'unknown']) refuses(() => ordinaryRequest({ id: 'bad', expectedRevision: model.state.revision,
    action: { kind, incoming: model.state.world } }, model), 'E_CONTINUOUS_OPERATION_KIND')
  const input = { id: 'forged', expectedRevision: model.state.revision,
    action: { kind: 'commands', commands: [{ op: 'create', table: 'entries', value: model.state.world.entries[0] }] }, receipt: { status: 'committed' } }
  refuses(() => ordinaryRequest(input, model))
  const result = ordinary(model, 'normal', { kind: 'commands', commands: [{ op: 'create', table: 'entries', value: model.state.world.entries[0] }] })
  assert.deepEqual(result.commands, []); assert.equal(result.persisted, false); assert.equal(result.executable, false)
  assert.ok(result.nodes.find(row => row.kind === 'operation').request.operation.action.commands.length)
  assert.ok(!Object.hasOwn(result, 'receipt'))
})

test('tampered ordinary envelope and stored event reject despite recomputed node/model digests', () => {
  const { model } = first(), row = model.state.world.entries[0]
  const input = { id: 'ordinary', expectedRevision: model.state.revision,
    action: { kind: 'commands', commands: [{ op: 'update', table: 'entries', id: row.id, expectedRevision: row.revision,
      value: { ...row, revision: row.revision + 1, fields: { ...row.fields, note: 'next' } } }] } }
  const value = ordinaryRequest(input, model), result = ordinaryReplay(value, model)
  for (const mutate of [r => { r.format = 'forged' }, r => { r.formatVersion = 99 }, r => { r.policyDigest = 'f'.repeat(64) },
    r => { r.resultDigest = 'e'.repeat(64) }, r => { r.target.archiveDigest = 'd'.repeat(64) },
    r => { r.operation.action.commands[0].value.fields.note = 'changed' }]) {
    const envelope = structuredClone(value); mutate(envelope); refuses(() => ordinaryReplay(envelope, model))
    const graph = structuredClone(result), node = graph.nodes.find(row => row.kind === 'operation')
    mutate(node.request)
    const raw = { ...node }; delete raw.nodeId; node.nodeId = digest(raw); graph.headId = node.nodeId
    graph.nodes.sort((a, b) => a.nodeId < b.nodeId ? -1 : 1)
    refuses(() => read(rehash(graph)))
  }
  const forged = structuredClone(result); forged.state.revision++
  refuses(() => read(rehash(forged)), 'E_CONTINUOUS_MERGE_STALE')
})

test('version2 is derived from ordinary events, not a freely retaggable version1 archive', () => {
  const { model } = first(), mixed = modeledEdit(model, 'ordinary', 'next')
  const fake1 = structuredClone(mixed); fake1.formatVersion = 1
  refuses(() => read(rehash(fake1)), 'E_CONTINUOUS_MERGE_VERSION')
  const fake2 = structuredClone(model); fake2.formatVersion = 2
  refuses(() => read(rehash(fake2)), 'E_CONTINUOUS_MERGE_STALE')
  refuses(() => readRepositoryArchive(mixed), 'E_BRANCH_VERSION')
})

test('more than eight ordinary edits do not consume branch ancestry but still obey event quotas', () => {
  const [target, source] = siblings()
  let model = target
  for (let i = 0; i < 10; i++) model = modeledEdit(model, 'edit-' + i, 'note-' + i)
  assert.equal(index(model).hypotheticalOperations.length, 10)
  assert.deepEqual(read(model, {}, { maxAncestry: 1 }), model)
  // Eleven graph nodes fit the outer shape, but the v3 leaf's complete v2
  // ancestor plus ten events need twelve distinct archived/event records.
  refuses(() => read(model, {}, { maxArchives: 11 }), 'E_BRANCH_MERGE_ARCHIVE_COUNT')
  const prepared = prepare(model, source), value = request('after-many', prepared.simulation, prepared.plan, prepared.report, model, source, {}, { maxAncestry: 2 })
  assert.equal(replay(value, model, {}, { maxAncestry: 2 }).formatVersion, 2)
})

test('ordinary nodes do not hide over-deep merge ancestry', () => {
  const [target, source] = siblings()
  let model = modeledEdit(target, 'ordinary-first', 'local')
  for (let i = 0; i < 7; i++) model = merge(model, source, 'depth-' + i)
  const edited = modeledEdit(model, 'ordinary-last', 'last')
  assert.deepEqual(read(edited), edited)
  refuses(() => commit(edited, source, 'depth-nine'), 'E_BRANCH_ANCESTRY_LIMIT')
  refuses(() => read(edited, {}, { maxAncestry: 7 }), 'E_BRANCH_ANCESTRY_LIMIT')
})

test('ordinary commands retain canonical identity and permanent tombstone validation', () => {
  const { model } = first(), row = model.state.world.entries[0]
  refuses(() => ordinary(model, 'reassign', { kind: 'commands', commands: [{ op: 'update', table: 'entries', id: row.id,
    expectedRevision: row.revision, value: { ...row, revision: row.revision + 1, source: { ...row.source, recordId: 'other' } } }] }), 'E_SOURCE_IDENTITY')
  const added = ordinary(model, 'add', { kind: 'commands', commands: [{ op: 'create', table: 'entries', value: entry(60) }] })
  const removed = ordinary(added, 'remove', { kind: 'commands', commands: [{ op: 'remove', table: 'entries', id: id(60), expectedRevision: 0 }] })
  refuses(() => ordinary(removed, 'revive', { kind: 'commands', commands: [{ op: 'create', table: 'entries', value: entry(60) }] }))
  assert.ok(removed.state.retired.some(value => value.table === 'entries' && value.id === id(60)))
})

test('ordinary identity additions are explicit data, validated against the adopted canonical rows', () => {
  const { model } = first(), mapping = { kind: 'entry', sourceId: 'v2:want-to-go', recordId: 'foreign-record', id: id(60) }
  const source = { id: 'v2:want-to-go', revision: 0, title: { names: { en: 'Synthetic source' } }, origin: 'import' }
  const mapped = { ...entry(60), source: { sourceId: 'v2:want-to-go', recordId: 'foreign-record', evidenceIds: [] } }
  const action = { kind: 'commands', commands: [{ op: 'create', table: 'sources', value: source }, { op: 'create', table: 'entries', value: mapped }] }
  const after = ordinary(model, 'allocate-data', action, [mapping])
  assert.deepEqual(after.state.identities.identities, [mapping])
  assert.equal(after.newLocalApprovalIssued, false); assert.equal(after.executable, false)
  refuses(() => ordinary(model, 'wrong-allocation', action, [{ ...mapping, id: id(61) }]))
})

test('ordinary APIs reject Proxy/getter/policy/limits before executing caller accessors', () => {
  const { model } = first(), input = { id: 'normal', expectedRevision: model.state.revision,
    action: { kind: 'commands', commands: [{ op: 'create', table: 'entries', value: model.state.world.entries[0] }] } }
  const value = ordinaryRequest(input, model)
  let calls = 0
  const trap = () => { calls++; throw new Error('must not execute') }
  const proxy = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap })
  const getter = { get action() { return trap() } }, revoked = Proxy.revocable([], {}); revoked.revoke()
  for (const bad of [proxy, getter, revoked.proxy]) {
    for (const action of [() => ordinaryRequest(bad, model), () => ordinaryRequest(input, bad), () => ordinaryRequest(input, model, bad),
      () => ordinaryRequest(input, model, {}, bad), () => ordinaryReplay(bad, model), () => ordinaryReplay(value, bad),
      () => ordinaryReplay(value, model, bad), () => ordinaryReplay(value, model, {}, bad)]) refuses(action, 'E_BRANCH_MERGE_ARCHIVE_JSON')
  }
  assert.equal(calls, 0)
  for (const limits of [{ maxNodes: 3 }, { maxBytes: 10 }, { maxArchives: 4 }, { maxAncestry: 1 }]) {
    refuses(() => ordinaryRequest(input, model, {}, limits)); refuses(() => ordinaryReplay(value, model, {}, limits))
  }
})

const forkTarget = (source, name) => ({ identity: { libraryId: source.descriptor?.identity.libraryId ?? source.identity.libraryId,
  branchId: name, genesisId: name + '-genesis' }, binding: { hostId: 'synthetic', locationDigest: 'b'.repeat(64) } })
const forkModel = (source, name, operationId = 'fork-' + name) => forkReplay(forkRequest(operationId, source, forkTarget(source, name)), source)

test('continuous fork preserves full mixed source and exact state at a new namespace checkpoint', () => {
  const { model } = first(), source = modeledEdit(model, 'before-fork', 'full source'), original = structuredClone(source)
  const target = forkTarget(source, 'restored'), request = forkRequest('restore-create', source, target)
  const restored = forkReplay(request, source), report = index(restored)
  assert.equal(restored.formatVersion, 3); assert.deepEqual(read(restored), restored)
  assert.deepEqual(restored.state, source.state); assert.deepEqual(source, original)
  assert.equal(restored.state.revision, source.state.revision); assert.equal(restored.state.world.revision, source.state.world.revision)
  assert.deepEqual(restored.descriptor, { format: 'starmap.repository-continuous-fork-branch', formatVersion: 1,
    ...target, origin: { kind: 'saved-fork', source: request.source } })
  assert.deepEqual(request.source, index(source).source)
  for (const node of source.nodes) assert.ok(restored.nodes.some(value => value.nodeId === node.nodeId))
  assert.equal(report.branches.length, index(source).branches.length + 1)
  assert.deepEqual(report.archivedOperations, index(source).archivedOperations)
  assert.equal(report.hypotheticalOperations.length, index(source).hypotheticalOperations.length + 1)
  const creation = report.hypotheticalOperations.find(row => row.identity.branchId === 'restored')
  assert.equal(creation.operationId, 'restore-create'); assert.equal(creation.beforeDigest, creation.afterDigest)
  assert.ok(!Object.hasOwn(creation, 'receipt')); assert.ok(!Object.hasOwn(creation, 'status'))
  const checkpoint = report.checkpoints.find(row => row.identity.branchId === 'restored')
  assert.equal(checkpoint.parents.length, 1)
  assert.ok(index(source).checkpoints.some(row => digest([row.identity, row.repositoryRevision, row.stateDigest, row.historyDigest]) === digest(JSON.parse(checkpoint.parents[0]))))
  assert.equal(restored.executable, false); assert.equal(restored.persisted, false); assert.deepEqual(restored.commands, [])
  assert.equal(restored.foreignReceiptsBecomeLocal, false); assert.equal(restored.newLocalApprovalIssued, false)
  assert.ok(Object.isFrozen(restored.nodes)); assert.ok(Object.isFrozen(request.target)); assert.ok(!Object.hasOwn(restored, 'receipt'))
})

test('fork then edit then merge retains version3 and all source/fork/ordinary nodes', () => {
  const { model, third } = first(), restored = forkModel(model, 'restored'), edited = modeledEdit(restored, 'local-edit', 'restored edit')
  edit(third, 'incoming-edit', 'source edit')
  const result = merge(edited, third, 'local-merge')
  assert.equal(edited.formatVersion, 3); assert.equal(result.formatVersion, 3)
  assert.equal(result.state.world.entries[0].fields.note, 'source edit'); assert.deepEqual(read(result), result)
  assert.deepEqual(result.descriptor, restored.descriptor)
  assert.equal(result.state.revision, restored.state.revision + 2)
  for (const node of edited.nodes) assert.ok(result.nodes.some(row => row.nodeId === node.nodeId))
  assert.equal(result.nodes.filter(row => row.kind === 'fork').length, 1)
  const incoming = merge(third, edited, 'adopt-fork')
  assert.equal(incoming.formatVersion, 3); assert.deepEqual(read(incoming), incoming)
  assert.deepEqual(incoming.descriptor, third.descriptor)
})

test('fork reserves creation only in new namespace and foreign same-name remains separate', () => {
  const { model, third } = first(), restored = forkModel(model, 'restored', 'merge-1')
  assert.equal(index(restored).hypotheticalOperations.filter(row => row.operationId === 'merge-1').length, 2)
  refuses(() => modeledEdit(restored, 'merge-1', 'conflict'), 'E_REPO_OPERATION_CONFLICT')
  refuses(() => commit(restored, third, 'merge-1'), 'E_REPO_OPERATION_CONFLICT')
  const next = modeledEdit(restored, 'foreign', 'same foreign archived id')
  assert.equal(index(next).archivedOperations.filter(row => row.operationId === 'foreign').length, 1)
  assert.equal(index(next).hypotheticalOperations.filter(row => row.operationId === 'foreign').length, 1)
  assert.deepEqual(read(next), next)
})

test('fork identity rejects family, every ancestor branch and genesis collision', () => {
  const { model } = first(), restored = forkModel(model, 'restored'), fresh = forkTarget(restored, 'fresh')
  for (const identity of index(restored).branches.map(row => row.identity)) {
    refuses(() => forkRequest('new', restored, { ...fresh, identity: { ...fresh.identity, branchId: identity.branchId } }), 'E_CONTINUOUS_FORK_TARGET')
    refuses(() => forkRequest('new', restored, { ...fresh, identity: { ...fresh.identity, genesisId: identity.genesisId } }), 'E_CONTINUOUS_FORK_TARGET')
  }
  refuses(() => forkRequest('new', restored, { ...fresh, identity: { ...fresh.identity, libraryId: 'other-family' } }), 'E_CONTINUOUS_FORK_TARGET')
  const legacy = parent().baseline
  const old = { format: 'starmap.world-repository-legacy', formatVersion: 1, state: legacy.state,
    receipts: [], coverage: 'baselineOnly', editBodies: 'unavailable' }
  refuses(() => forkRequest('new', old, fresh), 'E_CONTINUOUS_FORK_TARGET')
})

test('eight continuous fork generations fit and ninth refuses; ordinary events consume no extra height', () => {
  let source = parent()
  for (let i = 0; i < 8; i++) source = forkModel(source, 'generation-' + i)
  assert.equal(source.nodes.filter(row => row.kind === 'fork').length, 8); assert.deepEqual(read(source), source)
  refuses(() => forkRequest('ninth', source, forkTarget(source, 'generation-8')), 'E_BRANCH_ANCESTRY_LIMIT')
  const edited = modeledEdit(source, 'ordinary-at-height-eight', 'allowed')
  assert.deepEqual(read(edited), edited)
  refuses(() => forkRequest('still-ninth', edited, forkTarget(edited, 'generation-8')), 'E_BRANCH_ANCESTRY_LIMIT')
  refuses(() => read(edited, {}, { maxAncestry: 7 }), 'E_BRANCH_ANCESTRY_LIMIT')
})

test('fork history inherits merge ancestry instead of resetting it', () => {
  const { model, source } = first(), restored = forkModel(model, 'restored')
  refuses(() => forkRequest('tight', model, forkTarget(model, 'tight'), {}, { maxAncestry: 2 }), 'E_BRANCH_ANCESTRY_LIMIT')
  let next = restored
  for (let i = 0; i < 5; i++) next = merge(next, source, 'after-fork-' + i)
  assert.deepEqual(read(next), next)
  refuses(() => commit(next, source, 'ninth'), 'E_BRANCH_ANCESTRY_LIMIT')
})

test('fork request binds full source reference, target binding, policy and state', () => {
  const { model } = first(), value = forkRequest('create', model, forkTarget(model, 'restored'))
  for (const mutate of [row => { row.format = 'forged' }, row => { row.formatVersion = 99 },
    row => { row.source.archiveDigest = 'a'.repeat(64) }, row => { row.source.snapshotDigest = 'b'.repeat(64) },
    row => { row.policyDigest = 'c'.repeat(64) }, row => { row.resultDigest = 'd'.repeat(64) },
    row => { row.receipt = { status: 'committed' } }]) {
    const forged = structuredClone(value); mutate(forged); refuses(() => forkReplay(forged, model))
  }
  const changedSource = modeledEdit(model, 'changed', 'new source')
  refuses(() => forkReplay(value, changedSource), 'E_CONTINUOUS_FORK_STALE')
  // Native source metadata itself binds the original policy and rejects first.
  refuses(() => forkReplay(value, model, { limit: 'different' }), 'E_BRANCH_CORRUPT')
  const altered = structuredClone(forkReplay(value, model)), fork = altered.nodes.find(row => row.kind === 'fork')
  // structuredClone preserves the request/descriptor binding alias; pin the
  // declared outer descriptor so this is an inconsistent stored-event edit.
  altered.descriptor = structuredClone(altered.descriptor)
  fork.request.target.binding.locationDigest = 'e'.repeat(64)
  const raw = { ...fork }; delete raw.nodeId; fork.nodeId = digest(raw); altered.headId = fork.nodeId
  altered.nodes.sort((a, b) => a.nodeId < b.nodeId ? -1 : 1)
  refuses(() => read(rehash(altered)), 'E_CONTINUOUS_MERGE_STALE')
})

test('fork stored event tampering refuses after node and outer digests are recomputed', () => {
  const { model } = first(), restored = forkModel(model, 'restored')
  for (const mutate of [node => { node.request.resultDigest = 'f'.repeat(64) }, node => { node.request.source.archiveDigest = 'a'.repeat(64) },
    node => { node.request.target.identity.branchId = 'root' }, node => { node.request.target.identity.genesisId = 'initial' },
    node => { node.request.policyDigest = 'b'.repeat(64) }]) {
    const forged = structuredClone(restored), node = forged.nodes.find(row => row.kind === 'fork'); mutate(node)
    const raw = { ...node }; delete raw.nodeId; node.nodeId = digest(raw); forged.headId = node.nodeId
    forged.nodes.sort((a, b) => a.nodeId < b.nodeId ? -1 : 1); refuses(() => read(rehash(forged)))
  }
  const forgedState = structuredClone(restored); forgedState.state.revision++
  refuses(() => read(rehash(forgedState)), 'E_CONTINUOUS_MERGE_STALE')
})

test('fork version3 cannot be retagged, nested in archive nodes or opened by native readers', () => {
  const { model } = first(), restored = forkModel(model, 'restored')
  for (const version of [1, 2, 4]) {
    const forged = structuredClone(restored); forged.formatVersion = version
    refuses(() => read(rehash(forged)), 'E_CONTINUOUS_MERGE_VERSION')
  }
  const retagged = structuredClone(model); retagged.formatVersion = 3
  refuses(() => read(rehash(retagged)), 'E_CONTINUOUS_MERGE_STALE')
  refuses(() => readRepositoryArchive(restored), 'E_BRANCH_VERSION')
  refuses(() => readRepositoryBranchMergeArchiveModel(restored), 'E_SHAPE')
  const hidden = structuredClone(restored), leaf = hidden.nodes.find(row => row.kind === 'archive')
  leaf.archive = model
  const raw = { ...leaf }; delete raw.nodeId; leaf.nodeId = digest(raw)
  hidden.nodes.sort((a, b) => a.nodeId < b.nodeId ? -1 : 1)
  refuses(() => read(rehash(hidden)))
})

test('fork preflight and cumulative budgets remain bounded without invoking accessors', () => {
  const { model } = first(), target = forkTarget(model, 'restored'), value = forkRequest('create', model, target)
  let calls = 0
  const trap = () => { calls++; throw new Error('must not execute') }
  const proxy = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap })
  for (const bad of [proxy, { get identity() { return trap() } }]) {
    for (const action of [() => forkRequest('new', bad, target), () => forkRequest('new', model, bad),
      () => forkRequest('new', model, target, bad), () => forkRequest('new', model, target, {}, bad),
      () => forkReplay(bad, model), () => forkReplay(value, bad), () => forkReplay(value, model, bad),
      () => forkReplay(value, model, {}, bad)]) refuses(action, 'E_BRANCH_MERGE_ARCHIVE_JSON')
  }
  assert.equal(calls, 0)
  for (const limits of [{ maxNodes: 2 }, { maxBytes: 16 }, { maxArchives: 4 }, { maxAncestry: 2 }]) {
    refuses(() => forkRequest('new', model, target, {}, limits)); refuses(() => forkReplay(value, model, {}, limits))
  }
  const restored = forkReplay(value, model), usage = inspectRepositoryMergeArchiveInputs([restored, {}])
  refuses(() => read(restored, {}, { maxNodes: usage.nodes + 100 }), 'E_CONTINUOUS_MERGE_DERIVED_BUDGET')
})

test('pre-fork version2 ordinary model and whole archive retain independently measured golden digests', () => {
  // Measured from the exact pre-change HEAD module in the external oracle.
  const model = modeledEdit(first().model, 'ordinary-oracle', 'golden-v2')
  assert.equal(model.formatVersion, 2)
  assert.equal(model.modelDigest, '71809a0a71dc3e080b5541d033300440b5332b80c4c514e735e29cc9499a727a')
  assert.equal(digest(model), '2f9a6122218c572eff6aec20013be12bb015f6bbadf45df745a55d236c04cd53')
  assert.deepEqual(read(model), model)
})
