import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seed, entry, id, candidate, NOW } from './world-store-repository.fixture.mjs'
import { readRepositoryState, transitionRepositoryState } from './world-store-repository.mjs'
import { repositoryStateDigest as digest } from './world-store-repository-v2-contract.mjs'
import { previewRepositoryArchive, branchSourceReference } from './world-store-branch-snapshot.mjs'
import { previewRepositoryBranchHistory as preview } from './world-store-branch-history-preview.mjs'
import { createRepositoryBranchMergePlan as plan } from './world-store-branch-merge-plan.mjs'
import { simulateRepositoryBranchMerge as simulate } from './world-store-branch-merge-simulation.mjs'
import { createRepositoryBranchMergeCommitRequest as create, readRepositoryBranchMergeCommitRequest as read,
  replayRepositoryBranchMergeCommit as replay, assertRepositoryBranchMergeCommitCurrent as current } from './world-store-branch-merge-commit-contract.mjs'

// Neutral in-memory sibling branches only; no paths, database, media or host authority.
function parent(family = 'family') {
  const state = readRepositoryState({ format: 'starmap.world-repository', formatVersion: 1, revision: 0, world: seed().world,
    identities: { format: 'starmap.v2-store-identities', version: 1, identities: [] }, proposals: [], retired: [] })
  return { format: 'starmap.world-repository-v2', formatVersion: 2, identity: { libraryId: family, branchId: 'parent', genesisId: 'initial' },
    baseline: { sourceVersion: 1, sourceDigest: digest(state), coverage: 'baselineOnly', state, receipts: [] }, history: [], state }
}
function branch(source, name) {
  const fork = previewRepositoryArchive(source), binding = { hostId: 'synthetic', locationDigest: 'a'.repeat(64) }
  const descriptor = { format: 'starmap.repository-branch', formatVersion: 1,
    identity: { libraryId: source.identity.libraryId, branchId: name, genesisId: name + '-initial' }, origin: { kind: 'fork', source: fork.source }, binding }
  const creation = { status: 'completed', operationId: 'create-' + name,
    requestDigest: digest({ operationId: 'create-' + name, previewDigest: fork.previewDigest, binding }), previewDigest: fork.previewDigest, policyDigest: digest({}) }
  return { format: 'starmap.world-repository-branch', formatVersion: 3, descriptor, sourceArchive: source, creation,
    markerDigest: digest({ format: 'starmap.repository-branch-location', formatVersion: 1, descriptor, creation }), state: source.state, history: [] }
}
function append(value, name, action, identities) {
  const before = value.state, request = { id: name, expectedRevision: before.revision, action, ...(identities ? { identities } : {}) }
  const after = transitionRepositoryState(before, request)
  value.history.push({ operationId: name, request, requestDigest: digest(request), beforeDigest: digest(before), afterDigest: digest(after), after,
    receipt: { status: 'committed', operationId: name, repositoryRevision: after.revision, worldRevision: after.world.revision,
      ...(value.formatVersion === 3 ? { identity: value.descriptor.identity } : {}) } })
  value.state = after; return value
}
const commands = (value, name, values) => append(value, name, { kind: 'commands', commands: values })
const edit = (value, name, note) => {
  const row = value.state.world.entries[0]
  return commands(value, name, [{ op: 'update', table: 'entries', id: row.id, expectedRevision: row.revision,
    value: { ...row, revision: row.revision + 1, fields: { ...row.fields, note } } }])
}
const historyOnly = (value, name) => append(value, name, { kind: 'stage-proposal', proposal: {
  ...candidate(), id: (value.descriptor?.identity ?? value.identity).branchId + '-' + name + '-candidate', baseRevision: value.state.world.revision,
} })
const siblings = (base = parent()) => [branch(base, 'target'), branch(base, 'source')]
function prepare(target, source, select = row => row.allowedChoices.includes('source') ? 'source' : 'target') {
  const report = preview(target, source), catalogue = plan(report, target, source)
  const selected = plan(report, target, source, catalogue.items.map(row => ({ itemId: row.itemId, choice: select(row) })))
  return { report, plan: selected, simulation: simulate(selected, report, target, source) }
}
const requestFor = (target, source, prepared = prepare(target, source), operationId = 'local-import') =>
  create(operationId, prepared.simulation, prepared.plan, prepared.report, target, source)
const refuses = (action, ...codes) => assert.throws(action, error => codes.includes(error.code))
function incoming() { const [target, source] = siblings(); edit(source, 'foreign-edit', 'Synthetic incoming note'); return { target, source } }

test('complete request embeds its source and replays a frozen model without mutating any input', () => {
  const { target, source } = incoming(), prepared = prepare(target, source), before = structuredClone({ target, source, prepared })
  const request = requestFor(target, source, prepared), requestBefore = structuredClone(request), model = replay(request, target)
  assert.equal(request.format, 'starmap.repository-branch-merge-commit-request'); assert.equal(request.formatVersion, 1)
  assert.deepEqual(request.target, branchSourceReference(target)); assert.deepEqual(request.sourceArchive, source)
  assert.deepEqual(request.choices, prepared.plan.decisions.map(({ itemId, choice }) => ({ itemId, choice })))
  assert.equal(request.previewDigest, prepared.report.previewDigest); assert.equal(request.planDigest, prepared.plan.planDigest)
  assert.equal(request.simulationDigest, prepared.simulation.simulationDigest); assert.equal(request.resultDigest, digest(prepared.simulation.candidate))
  assert.equal(request.policyDigest, digest({})); assert.deepEqual(read(request, target), request)
  assert.deepEqual(model.after, prepared.simulation.candidate)
  assert.deepEqual(model.localOperation, { identity: target.descriptor.identity, operationId: 'local-import', requestDigest: digest(request) })
  assert.equal(model.executable, false); assert.equal(model.persisted, false); assert.deepEqual(model.commands, [])
  assert.equal(model.foreignReceiptsBecomeLocal, false); assert.equal(model.newLocalApprovalIssued, false)
  assert.ok(!Object.hasOwn(model, 'receipt')); assert.ok(!Object.hasOwn(model.localOperation, 'receipt'))
  assert.ok(!Object.hasOwn(model.localOperation, 'status')); assert.notEqual(model.status, 'committed')
  assert.deepEqual(current(model, request, target), model)
  assert.ok(Object.isFrozen(request.sourceArchive.history)); assert.ok(Object.isFrozen(model.after.world.entries[0]))
  assert.deepEqual({ target, source, prepared }, before); assert.deepEqual(request, requestBefore)
})

test('missing and explicitly deferred choices cannot become a commit request', () => {
  const { target, source } = incoming(), report = preview(target, source), incomplete = plan(report, target, source)
  refuses(() => requestFor(target, source, { report, plan: incomplete, simulation: simulate(incomplete, report, target, source) }), 'E_BRANCH_MERGE_COMMIT_INCOMPLETE')
  refuses(() => requestFor(target, source, prepare(target, source, () => 'defer')), 'E_BRANCH_MERGE_COMMIT_INCOMPLETE')
})

test('unrelated source families stay blocked even if all choices are explicit', () => {
  const target = branch(parent(), 'target'), source = branch(parent('other-family'), 'source'), prepared = prepare(target, source)
  assert.equal(prepared.simulation.status, 'blocked')
  refuses(() => requestFor(target, source, prepared), 'E_BRANCH_MERGE_COMMIT_INCOMPLETE')
})

test('a dangling-reference combination is rejected rather than issued as a request', () => {
  const [target, source] = siblings(), entity = { ...seed().world.entities[0], id: id(80), source: { ...seed().world.entities[0].source, recordId: 'entity-80' } }
  commands(source, 'add', [{ op: 'create', table: 'entities', value: entity }, { op: 'create', table: 'entries', value: { ...entry(81), entityId: id(80) } }])
  const prepared = prepare(target, source, row => row.table === 'entries' || row.domain === 'archive' ? 'source' : 'target')
  assert.equal(prepared.simulation.status, 'invalid'); assert.equal(prepared.simulation.stateValidation.code, 'E_REFERENCE')
  refuses(() => requestFor(target, source, prepared), 'E_BRANCH_MERGE_COMMIT_INCOMPLETE')
})

test('only a supported writable v3 target can issue the pure request', () => {
  const target = parent(), source = edit(parent(), 'foreign', 'incoming'), prepared = prepare(target, source)
  refuses(() => requestFor(target, source, prepared), 'E_BRANCH_MERGE_COMMIT_TARGET')
})

test('exact archive and explicitly retained source history are no-ops, not local operations', () => {
  const [target, source] = siblings()
  refuses(() => requestFor(target, target), 'E_BRANCH_MERGE_COMMIT_NOOP')
  refuses(() => requestFor(target, source, prepare(target, source, () => 'target')), 'E_BRANCH_MERGE_COMMIT_NOOP')
  assert.equal(target.history.length, 0)
})

test('archive-only adoption has one hypothetical local revision and preserves current world clocks', () => {
  const [target, source] = siblings(), model = replay(requestFor(target, source), target)
  assert.deepEqual(model.after.world, target.state.world); assert.equal(model.after.revision, target.state.revision + 1)
  assert.equal(model.after.world.revision, target.state.world.revision); assert.equal(target.history.length, 0)
})

test('target local operation collisions refuse while ancestor and foreign names remain separate', () => {
  const base = historyOnly(parent(), 'local-import'), [target, source] = siblings(base)
  edit(source, 'local-import', 'Foreign same-name operation')
  const request = requestFor(target, source), model = replay(request, target)
  assert.equal(model.localOperation.identity.branchId, 'target'); assert.equal(model.localOperation.operationId, 'local-import')
  assert.equal(source.history[0].receipt.identity.branchId, 'source'); assert.equal(target.history.length, 0)
  historyOnly(target, 'local-import')
  refuses(() => requestFor(target, source), 'E_REPO_OPERATION_CONFLICT')
})

test('source-ahead history from the same permanent branch cannot collide with the new local operation', () => {
  const [target] = siblings(), source = structuredClone(target)
  edit(source, 'local-import', 'Synthetic same-branch history ahead of target')
  const prepared = prepare(target, source)
  assert.equal(prepared.simulation.status, 'validated')
  assert.equal(prepared.report.operations.incomingOnly[0].identity.branchId, target.descriptor.identity.branchId)
  refuses(() => requestFor(target, source, prepared), 'E_REPO_OPERATION_CONFLICT')
  assert.equal(target.history.length, 0)
})

test('whole request shape and every derived digest are checked rather than trusted', () => {
  const { target, source } = incoming(), request = requestFor(target, source)
  for (const field of ['policyDigest', 'previewDigest', 'planDigest', 'simulationDigest', 'resultDigest']) {
    const tampered = structuredClone(request); tampered[field] = '0'.repeat(64)
    refuses(() => read(tampered, target), 'E_BRANCH_MERGE_COMMIT_STALE')
  }
  const extra = { ...request, executable: true }; refuses(() => read(extra, target), 'E_SHAPE')
  const missing = structuredClone(request); delete missing.choices; refuses(() => read(missing, target), 'E_SHAPE')
  const wrongFormat = { ...request, formatVersion: 2 }; refuses(() => read(wrongFormat, target), 'E_BRANCH_MERGE_COMMIT_REQUEST')
  const wrongTarget = structuredClone(request); wrongTarget.target.archiveDigest = '0'.repeat(64)
  refuses(() => read(wrongTarget, target), 'E_BRANCH_MERGE_COMMIT_STALE')
})

test('valid source changes and reordered or duplicate choices cannot bypass bound consent', () => {
  const { target, source } = incoming(), request = requestFor(target, source)
  const changed = structuredClone(request); historyOnly(changed.sourceArchive, 'later-history')
  refuses(() => read(changed, target), 'E_BRANCH_MERGE_COMMIT_STALE', 'E_BRANCH_MERGE_CHOICE_ID')
  const reordered = structuredClone(request); reordered.choices.reverse()
  refuses(() => read(reordered, target), 'E_BRANCH_MERGE_COMMIT_STALE')
  const duplicated = structuredClone(request); duplicated.choices.push(duplicated.choices[0])
  refuses(() => read(duplicated, target), 'E_BRANCH_MERGE_CHOICE_ID')
})

test('a history-only target save expires a request even when all current world facts are unchanged', () => {
  const { target, source } = incoming(), request = requestFor(target, source), changed = structuredClone(target)
  historyOnly(changed, 'local-noop-history')
  assert.deepEqual(changed.state.world, target.state.world)
  refuses(() => read(request, changed), 'E_BRANCH_MERGE_COMMIT_STALE')
  refuses(() => replay(request, changed), 'E_BRANCH_MERGE_COMMIT_STALE')
})

test('policy changes and stale input plans or simulations cannot issue consent', () => {
  const { target, source } = incoming(), prepared = prepare(target, source), request = requestFor(target, source, prepared)
  refuses(() => read(request, target, { allowDefinitionWrites: true }), 'E_BRANCH_CORRUPT', 'E_BRANCH_MERGE_COMMIT_STALE')
  const changedPlan = structuredClone(prepared.plan); changedPlan.executable = true
  refuses(() => requestFor(target, source, { ...prepared, plan: changedPlan }), 'E_BRANCH_MERGE_PLAN_STALE')
  const changedSimulation = structuredClone(prepared.simulation); changedSimulation.newLocalApprovalIssued = true
  refuses(() => requestFor(target, source, { ...prepared, simulation: changedSimulation }), 'E_BRANCH_MERGE_SIMULATION_STALE')
})

test('whole model tampering is rejected even after recomputing claimed state or model digests', () => {
  const { target, source } = incoming(), request = requestFor(target, source), model = replay(request, target)
  for (const change of [value => { value.after.world.entries[0].fields.note = 'Tampered but well-formed' },
    value => { value.localOperation.identity = source.descriptor.identity }, value => { value.localOperation.requestDigest = '0'.repeat(64) },
    value => { value.executable = true }, value => { value.persisted = true }, value => { value.foreignReceiptsBecomeLocal = true },
    value => { value.newLocalApprovalIssued = true }, value => { value.commands = [{ op: 'pretend-write' }] },
    value => { value.receipt = { status: 'committed', operationId: request.operationId } }]) {
    const tampered = structuredClone(model); change(tampered)
    for (const field of ['resultDigest', 'afterDigest']) if (Object.hasOwn(tampered, field)) tampered[field] = digest(tampered.after)
    if (Object.hasOwn(tampered, 'modelDigest')) { const raw = { ...tampered }; delete raw.modelDigest; tampered.modelDigest = digest(raw) }
    refuses(() => current(tampered, request, target), 'E_BRANCH_MERGE_COMMIT_STALE')
  }
})

test('foreign accepted facts and review remain source history without issuing local approval or receipt', () => {
  const [target, source] = siblings()
  append(source, 'stage', { kind: 'stage-proposal', proposal: candidate() })
  append(source, 'accept', { kind: 'accept-proposal', proposalId: candidate().id, decision: { reviewId: 'foreign-review', acceptedAt: NOW } })
  const request = requestFor(target, source), model = replay(request, target)
  assert.equal(model.after.proposals[0].status, 'accepted'); assert.equal(model.after.world.reviews[0].id, 'foreign-review')
  assert.deepEqual(request.sourceArchive.history.map(row => row.receipt.identity), [source.descriptor.identity, source.descriptor.identity])
  assert.equal(model.localOperation.identity.branchId, 'target'); assert.equal(model.newLocalApprovalIssued, false)
  assert.equal(model.foreignReceiptsBecomeLocal, false); assert.equal(target.history.length, 0)
})

test('target tombstones and allocated dead identities remain protected in the modeled result', () => {
  const base = commands(parent(), 'add', [{ op: 'create', table: 'entries', value: entry(60) }]), [target, source] = siblings(base)
  commands(target, 'remove', [{ op: 'remove', table: 'entries', id: id(60), expectedRevision: 0 }])
  append(target, 'ledger', { kind: 'stage-proposal', proposal: { ...candidate(), baseRevision: target.state.world.revision } }, [{ kind: 'entry', sourceId: 'test:manual', recordId: 'dead', id: id(80) }])
  edit(source, 'foreign-edit', 'Incoming independent note')
  const prepared = prepare(target, source), request = requestFor(target, source, prepared), model = replay(request, target)
  assert.ok(model.after.retired.some(row => row.table === 'entries' && row.id === id(60)))
  assert.ok(!model.after.world.entries.some(row => row.id === id(60)))
  assert.deepEqual(model.after.identities, target.state.identities)
  const tombstone = prepared.plan.items.find(row => row.id === id(60)), illegal = structuredClone(request)
  illegal.choices.find(row => row.itemId === tombstone.itemId).choice = 'source'
  refuses(() => read(illegal, target), 'E_BRANCH_MERGE_CHOICE_FORBIDDEN')
})

test('JSON accessors and cycles are rejected without executing caller code', () => {
  const { target, source } = incoming(), prepared = prepare(target, source), request = requestFor(target, source, prepared), model = replay(request, target)
  let calls = 0
  const trapped = structuredClone(request)
  Object.defineProperty(trapped, 'sourceArchive', { enumerable: true, get() { calls++; return source } })
  refuses(() => read(trapped, target), 'E_JSON')
  const trappedModel = structuredClone(model)
  Object.defineProperty(trappedModel, 'after', { enumerable: true, get() { calls++; return model.after } })
  refuses(() => current(trappedModel, request, target), 'E_JSON')
  const policy = { get allowDefinitionWrites() { calls++; return true } }
  refuses(() => create('local-import', prepared.simulation, prepared.plan, prepared.report, target, source, policy), 'E_JSON')
  const cycle = structuredClone(request); cycle.sourceArchive.loop = cycle
  refuses(() => read(cycle, target), 'E_JSON_CYCLE'); assert.equal(calls, 0)
})
