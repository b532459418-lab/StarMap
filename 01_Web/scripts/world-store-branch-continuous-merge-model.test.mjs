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
  replayRepositoryContinuousBranchMerge as replay } from './world-store-branch-continuous-merge-model.mjs'

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
