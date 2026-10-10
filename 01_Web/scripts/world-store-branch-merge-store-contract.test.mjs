import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seed, entry, id, candidate, NOW } from './world-store-repository.fixture.mjs'
import { readRepositoryState, transitionRepositoryState } from './world-store-repository.mjs'
import { repositoryStateDigest as digest } from './world-store-repository-v2-contract.mjs'
import { previewRepositoryArchive, readRepositoryArchive } from './world-store-branch-snapshot.mjs'
import { inspectRepositoryMergeArchiveInputs } from './world-store-branch-merge-archive-model.mjs'
import { readRepositoryContinuousMergeModel } from './world-store-branch-continuous-merge-model.mjs'
import { createRepositoryMergeSavedArchive as create, readRepositoryMergeSavedArchive as read,
  createRepositoryMergeStoreOperationRequest as operationRequest, createRepositoryMergeStoreRequest as mergeRequest,
  projectRepositoryMergeStoreRequest as project, appendRepositoryMergeSavedEvent as append,
  previewRepositoryMergeStore as preview, readRepositoryMergeStoreSource as readSource,
  repositoryMergeStoreProjection as projection, expectedRepositoryMergeRestoreReceipt as restoreReceipt,
  createRepositoryMergeRestoredSavedArchive as createRestored, withRepositoryMergeSavedValidation as validationScope } from './world-store-branch-merge-store-contract.mjs'

import { previewRepositorySavedBranchFork as forkPreview, createRepositorySavedBranchForkRequest as forkRequest,
  replayRepositorySavedBranchFork as forkReplay } from './world-store-saved-branch-fork-contract.mjs'

function root(family = 'synthetic-store-family') {
  const state = readRepositoryState({ format: 'starmap.world-repository', formatVersion: 1, revision: 0, world: seed().world,
    identities: { format: 'starmap.v2-store-identities', version: 1, identities: [] }, proposals: [], retired: [] })
  return { format: 'starmap.world-repository-v2', formatVersion: 2, identity: { libraryId: family, branchId: 'root', genesisId: 'initial' },
    baseline: { sourceVersion: 1, sourceDigest: digest(state), coverage: 'baselineOnly', state, receipts: [] }, history: [], state }
}
function fork(source, name = 'local') {
  const incoming = previewRepositoryArchive(source), binding = { hostId: 'synthetic', locationDigest: 'a'.repeat(64) }
  const identity = source.formatVersion === 2 ? source.identity : source.descriptor.identity
  const descriptor = { format: 'starmap.repository-branch', formatVersion: 1,
    identity: { libraryId: identity.libraryId, branchId: name, genesisId: name + '-initial' }, origin: { kind: 'fork', source: incoming.source }, binding }
  const creation = { status: 'completed', operationId: 'create-' + name,
    requestDigest: digest({ operationId: 'create-' + name, previewDigest: incoming.previewDigest, binding }),
    previewDigest: incoming.previewDigest, policyDigest: digest({}) }
  return { format: 'starmap.world-repository-branch', formatVersion: 3, descriptor, sourceArchive: source, creation,
    markerDigest: digest({ format: 'starmap.repository-branch-location', formatVersion: 1, descriptor, creation }), state: source.state, history: [] }
}
function local(name = 'local', parent = root()) { return create(fork(parent, name)) }
function edit(saved, id = 'edit', note = 'changed') {
  const state = saved.projection?.state ?? saved.state, row = state.world.entries[0]
  return { id, expectedRevision: state.revision, action: { kind: 'commands', commands: [{ op: 'update', table: 'entries', id: row.id,
    expectedRevision: row.revision, value: { ...row, revision: row.revision + 1, fields: { ...row.fields, note } } }] } }
}
// Synthetic claimed receipts prove consistency only. Actual COMMIT is exercised
// by the separate SQLite writer tests; this pure suite never authenticates one.
function record(saved, request) { return append(saved, request, project(request, saved).expectedReceipt) }
function edited(saved, id, note) { return record(saved, operationRequest(edit(saved, id, note), saved)) }
function selections(saved, source, selector = row => row.allowedChoices.includes('source') ? 'source' : 'target') {
  return preview(saved, source).catalogue.items.map(row => ({ itemId: row.itemId, choice: selector(row) }))
}
function merged(saved, source, id = 'merge', selector) { return record(saved, mergeRequest(id, saved, source, selections(saved, source, selector))) }
function rehash(value) { const raw = { ...value }; delete raw.savedDigest; return { ...raw, savedDigest: digest(raw) } }
const refuses = (action, code) => assert.throws(action, error => code ? error.code === code : typeof error.code === 'string')
function first() {
  const parent = root(), target = local('local', parent), source = edited(local('incoming', parent), 'foreign', 'incoming')
  return { parent, target, source, saved: merged(target, source) }
}

test('an independent initial Saved keeps the complete valid native fork anchor', () => {
  const base = fork(root()), before = structuredClone(base), value = create(base)
  assert.deepEqual(read(value), value)
  assert.deepEqual(value.baseArchive, base); assert.deepEqual(value.projection, base); assert.deepEqual(value.events, [])
  assert.deepEqual(base, before); assert.ok(Object.isFrozen(value.baseArchive.sourceArchive.state.world.entries))
  assert.deepEqual(readSource(value), value); assert.deepEqual(projection(value), base)
  assert.deepEqual(readSource(base.sourceArchive), base.sourceArchive)
  assert.equal(Object.hasOwn(value, 'receipt'), false)
})
test('a native v3 parent with full ordinary history remains intact in an empty new anchor', () => {
  const parent = fork(root(), 'parent'), request = edit(parent), after = transitionRepositoryState(parent.state, request)
  parent.history.push({ operationId: request.id, request, requestDigest: digest(request), beforeDigest: digest(parent.state), afterDigest: digest(after), after,
    receipt: { status: 'committed', identity: parent.descriptor.identity, operationId: request.id, repositoryRevision: after.revision, worldRevision: after.world.revision } })
  parent.state = after
  const value = local('child', parent)
  assert.deepEqual(value.baseArchive.sourceArchive, parent); assert.equal(value.events.length, 0)
  assert.deepEqual(read(value), value)
})
test('base cannot be a v2 archive, a nonempty v3 local history, or fabricated merge after-state', () => {
  refuses(() => create(root()), 'E_MERGE_STORE_ANCHOR')
  const { saved } = first()
  refuses(() => create(saved.projection))
  const fabricated = structuredClone(saved.baseArchive); fabricated.state = saved.projection.state
  refuses(() => create(fabricated), 'E_BRANCH_CHAIN')
})
test('ordinary edit and complete saved-source merge replay without turning the anchor into a fake v3', () => {
  const { target, source, saved } = first(), row = saved.events[0], projected = readRepositoryContinuousMergeModel(saved.projection)
  assert.deepEqual(read(saved), saved); assert.deepEqual(saved.baseArchive, target.baseArchive)
  assert.equal(saved.baseArchive.state.revision, 0); assert.equal(saved.projection.state.revision, 1)
  assert.deepEqual(row.storeRequest.sourceArchive, source)
  assert.deepEqual(row.storeRequest.pureRequest.sourceArchive, source.projection)
  assert.equal(projected.state.world.entries[0].fields.note, 'incoming')
  assert.equal(row.receipt.requestDigest, digest(row.storeRequest))
  assert.equal(row.receipt.identity.branchId, 'local'); assert.equal(saved.events.length, 1)
  assert.equal(source.events[0].receipt.identity.branchId, 'incoming')
  assert.equal(saved.projection.persisted, false); assert.equal(saved.projection.executable, false)
  assert.deepEqual(saved.projection.commands, [])
  refuses(() => readRepositoryArchive(saved))
})
test('edit then merge then edit then merge retains exact local events and complete incoming histories', () => {
  const { parent, target, source } = first(), before = edited(target, 'before', 'local'), merge = merged(before, source, 'merge-1')
  const after = edited(merge, 'after', 'local-again'), third = edited(local('third', parent), 'third-edit', 'third')
  const final = merged(after, third, 'merge-2')
  assert.deepEqual(read(final), final); assert.equal(final.events.length, 4)
  assert.deepEqual(final.events.map(row => row.receipt.operationId), ['before', 'merge-1', 'after', 'merge-2'])
  assert.equal(final.projection.state.world.entries[0].fields.note, 'third')
  for (const row of final.events) assert.equal(row.receipt.identity.branchId, 'local')
  assert.deepEqual(final.baseArchive, target.baseArchive)
})
test('validated Saved can be a source for a different target and is kept fully, including actual event claims', () => {
  const { parent, saved } = first(), adopted = merged(local('third', parent), saved, 'adopt')
  assert.deepEqual(read(adopted), adopted)
  assert.deepEqual(adopted.events[0].storeRequest.sourceArchive, saved)
  assert.equal(adopted.events.length, 1); assert.equal(adopted.events[0].receipt.identity.branchId, 'third')
  assert.equal(adopted.projection.state.world.entries[0].fields.note, 'incoming')
})
test('bare continuous and terminal pure models cannot become source evidence', () => {
  const { target, saved } = first()
  for (const action of [() => readSource(saved.projection), () => projection(saved.projection), () => preview(target, saved.projection),
    () => mergeRequest('bad', target, saved.projection, []), () => create(saved.projection)]) refuses(action)
})
test('native v2/v3 comparison still works and unknown legacy identity cannot silently approve merge', () => {
  const parent = root(), target = local('local', parent), source = fork(parent, 'source')
  assert.deepEqual(projection(source), source)
  const value = merged(target, source)
  assert.deepEqual(value.events[0].storeRequest.sourceArchive, source)
  assert.deepEqual(read(value), value)
  const legacy = { format: 'starmap.world-repository-legacy', formatVersion: 1, coverage: 'baselineOnly', editBodies: 'unavailable', state: parent.state, receipts: [] }
  assert.deepEqual(readSource(legacy), legacy)
  refuses(() => mergeRequest('unknown', target, legacy, selections(target, legacy)))
})
test('same-named foreign events stay in their namespace while own repeated IDs are rejected', () => {
  const { target, source } = first(), incoming = edited(source, 'merge', 'same foreign name'), value = merged(target, incoming, 'merge')
  assert.deepEqual(read(value), value)
  refuses(() => operationRequest(edit(value, 'merge'), value), 'E_REPO_OPERATION_CONFLICT')
  refuses(() => mergeRequest('merge', value, source, selections(value, source)), 'E_REPO_OPERATION_CONFLICT')
  refuses(() => operationRequest(edit(target, 'create-local'), target), 'E_REPO_OPERATION_CONFLICT')
})
test('projection returns only expected comparison data, never an actual success envelope', () => {
  const value = local(), request = operationRequest(edit(value), value), result = project(request, value)
  assert.deepEqual(Object.keys(result), ['projection', 'expectedReceipt'])
  assert.equal(Object.hasOwn(result, 'receipt'), false); assert.equal(Object.hasOwn(result, 'committed'), false)
  assert.equal(value.events.length, 0); assert.equal(result.expectedReceipt.beforeSavedDigest, value.savedDigest)
})
test('requests bind complete target Saved bytes and policy, not just the projected state', () => {
  const value = local(), request = operationRequest(edit(value), value), next = edited(value, 'other', 'other')
  refuses(() => project(request, next), 'E_MERGE_STORE_STALE')
  refuses(() => project(request, value, { maxCommands: 50 }))
  const modified = structuredClone(request); modified.targetSavedDigest = 'f'.repeat(64)
  refuses(() => project(modified, value), 'E_MERGE_STORE_STALE')
})
test('modified or deleted source evidence and rehashed outer envelope fail semantic replay', () => {
  const { saved } = first()
  for (const mutate of [value => { value.events[0].storeRequest.sourceArchive.events = [] },
    value => { delete value.events[0].storeRequest.sourceArchive },
    value => { value.events[0].storeRequest.sourceArchive.events[0].receipt.requestDigest = 'f'.repeat(64) },
    value => { value.events[0].storeRequest.pureRequest.sourceArchive = value.baseArchive }]) {
    const value = structuredClone(saved); mutate(value); refuses(() => read(rehash(value)))
  }
})
test('every receipt field and exact shape are checked against replay', () => {
  const { target, source } = first(), request = mergeRequest('merge', target, source, selections(target, source)), receipt = project(request, target).expectedReceipt
  const replacements = { status: 'pending', identity: source.baseArchive.descriptor.identity, operationId: 'other', requestDigest: 'f'.repeat(64),
    beforeSavedDigest: 'f'.repeat(64), beforeDigest: 'f'.repeat(64), afterDigest: 'f'.repeat(64), repositoryRevision: 99, worldRevision: 99 }
  for (const [key, value] of Object.entries(replacements)) refuses(() => append(target, request, { ...receipt, [key]: value }), 'E_MERGE_STORE_RECEIPT')
  refuses(() => append(target, request, { ...receipt, hostId: 'synthetic' }))
})
test('tampered projection, deleted local event, altered body or fork marker are rejected after rehash', () => {
  const { saved } = first()
  for (const mutate of [value => { value.projection.state.world.entries[0].fields.note = 'forged' }, value => { value.events = [] },
    value => { value.events[0].storeRequest.pureRequest.choices[0].choice = 'defer' },
    value => { value.baseArchive.markerDigest = 'f'.repeat(64) }, value => { value.events[0].receipt.afterDigest = 'f'.repeat(64) }]) {
    const value = structuredClone(saved); mutate(value); refuses(() => read(rehash(value)))
  }
})
test('inputs remain immutable and outputs deterministic across replay', () => {
  const { target, source } = first(), choices = selections(target, source), input = structuredClone({ target, source, choices })
  const firstRequest = mergeRequest('merge', target, source, choices), second = mergeRequest('merge', target, source, choices)
  assert.deepEqual(firstRequest, second); assert.deepEqual({ target, source, choices }, input)
  assert.ok(Object.isFrozen(firstRequest.sourceArchive.events)); assert.ok(Object.isFrozen(project(firstRequest, target).expectedReceipt))
})
test('unsafe JSON never invokes accessors or Proxy traps before rejecting', () => {
  let accessed = 0, trapped = 0
  const value = local(), getter = { ...value }
  Object.defineProperty(getter, 'events', { enumerable: true, get() { accessed++; return [] } })
  refuses(() => read(getter)); assert.equal(accessed, 0)
  const proxy = new Proxy(value, { get() { trapped++; throw Error('trap') }, ownKeys() { trapped++; throw Error('trap') } })
  refuses(() => read(proxy)); assert.equal(trapped, 0)
  const revoked = Proxy.revocable(value, {}); revoked.revoke(); refuses(() => readSource(revoked.proxy))
})
test('size, node, depth, event and recursive Saved source quotas can only be tightened', () => {
  const { saved } = first()
  for (const limits of [{ maxBytes: 100 }, { maxNodes: 10 }, { maxDepth: 1 }, { maxArchives: 1 }, { maxAncestry: 0 }, { maxBytes: 129 * 1024 * 1024 }]) {
    refuses(() => read(saved, {}, limits))
  }
  const value = structuredClone(saved); value.events.push(value.events[0]); refuses(() => read(rehash(value)))
})
test('nonexplicit/deferred selections and an archive choice of target cannot issue executable merge data', () => {
  const { target, source } = first(), choices = selections(target, source)
  refuses(() => mergeRequest('missing', target, source, []))
  refuses(() => mergeRequest('defer', target, source, choices.map(row => ({ ...row, choice: 'defer' }))))
  refuses(() => mergeRequest('archive-target', target, source, selections(target, source, () => 'target')))
})
test('permanent tombstones remain protected after saved merge', () => {
  const parent = root()
  parent.state = readRepositoryState({ ...parent.state, world: { ...parent.state.world, entries: [...parent.state.world.entries, entry(60)] } })
  parent.baseline.state = parent.state; parent.baseline.sourceDigest = digest(parent.state)
  const target = local('local', parent), incoming = edited(local('incoming', parent), 'foreign', 'restore-attempt')
  const row = target.projection.state.world.entries.find(item => item.id === id(60))
  const removed = record(target, operationRequest({ id: 'remove', expectedRevision: 0,
    action: { kind: 'commands', commands: [{ op: 'remove', table: 'entries', id: row.id, expectedRevision: row.revision }] } }, target))
  const catalogue = preview(removed, incoming).catalogue
  const protectedItem = catalogue.items.find(item => item.sourceBlockedReason === 'target-tombstone-is-permanent')
  assert.ok(protectedItem); assert.equal(protectedItem.allowedChoices.includes('source'), false)
  const value = merged(removed, incoming)
  assert.deepEqual(read(value), value)
  assert.ok(value.projection.state.retired.some(item => item.id === row.id))
  assert.equal(value.projection.state.world.entries.some(item => item.id === row.id), false)
})
test('ordinary proposal decisions replay as local event claims and cannot be overwritten by incoming pending candidates', () => {
  const parent = root(), target = local('local', parent), incoming = local('incoming', parent)
  function act(saved, id, action) { return record(saved, operationRequest({ id, expectedRevision: saved.projection.state.revision, action }, saved)) }
  const staged = act(target, 'stage', { kind: 'stage-proposal', proposal: candidate() })
  const accepted = act(staged, 'accept', { kind: 'accept-proposal', proposalId: candidate().id, decision: { reviewId: 'local-review', acceptedAt: NOW } })
  const foreign = act(incoming, 'foreign-stage', { kind: 'stage-proposal', proposal: candidate() })
  const value = merged(accepted, foreign)
  assert.deepEqual(read(value), value); assert.equal(value.projection.state.proposals[0].status, 'accepted')
  assert.deepEqual(value.projection.state.world.reviews, accepted.projection.state.world.reviews)
  assert.deepEqual(value.events.map(item => item.receipt.operationId), ['stage', 'accept', 'merge'])
})
test('source family and local namespace collisions are rejected, without remapping identity', () => {
  const target = local(), other = local('other', root('different-family'))
  refuses(() => mergeRequest('bad-family', target, other, selections(target, other)))
  const incoming = edited(target, 'same-namespace', 'foreign-copy')
  const changed = edited(target, 'same-namespace', 'different-copy')
  refuses(() => mergeRequest('collision', changed, incoming, selections(changed, incoming)))
  assert.deepEqual(target.baseArchive.descriptor.identity, { libraryId: 'synthetic-store-family', branchId: 'local', genesisId: 'local-initial' })
})
test('cycles, sparse arrays and data with unexpected properties fail before normal replay', () => {
  const value = local(), cycle = structuredClone(value); cycle.events.push(cycle)
  refuses(() => read(cycle), 'E_BRANCH_MERGE_ARCHIVE_CYCLE')
  const sparse = structuredClone(value); sparse.events = Array(1); refuses(() => read(sparse), 'E_BRANCH_MERGE_ARCHIVE_JSON')
  const extra = structuredClone(value); extra.actualCommitted = true; refuses(() => read(rehash(extra)))
})

function restoreModel(saved, name = 'restored', operationId = 'restore-' + name, packageDigest = 'c'.repeat(64)) {
  const input = { operationId, identity: { libraryId: saved.baseArchive.descriptor.identity.libraryId,
    branchId: name, genesisId: name + '-initial' }, binding: { hostId: 'new-synthetic-host', locationDigest: 'b'.repeat(64) },
  restoreContext: { kind: 'backup-restore', packageDigest } }
  return forkReplay(forkRequest(forkPreview(saved), saved, input), saved)
}
function restored(saved, name = 'restored', operationId) {
  const model = restoreModel(saved, name, operationId)
  return createRestored(model, restoreReceipt(model))
}

test('Saved v2 initializes from the complete Saved fork model and independent continuous fork', () => {
  const source = edited(local(), 'old-event'), model = restoreModel(source), comparison = restoreReceipt(model), value = createRestored(model, comparison)
  assert.equal(value.formatVersion, 2); assert.deepEqual(read(value), value)
  assert.deepEqual(value.baseArchive, model); assert.deepEqual(value.baseArchive.sourceArchive, source)
  assert.deepEqual(value.initialization, { receipt: comparison }); assert.deepEqual(value.events, [])
  assert.equal(value.projection.formatVersion, 3); assert.equal(value.projection.descriptor.identity.branchId, 'restored')
  assert.deepEqual(value.projection.state, source.projection.state)
  assert.deepEqual(readSource(value), value); assert.deepEqual(projection(value), value.projection)
  assert.equal(value.projection.persisted, false); assert.equal(value.projection.executable, false); assert.deepEqual(value.projection.commands, [])
})

test('restore receipt is exact deterministic comparison data without a Saved digest cycle or authority claim', () => {
  const source = local(), model = restoreModel(source), value = restoreReceipt(model)
  assert.deepEqual(Object.keys(value), ['status', 'kind', 'identity', 'operationId', 'requestDigest', 'sourceArchiveDigest',
    'forkModelDigest', 'packageDigest', 'repositoryRevision', 'worldRevision'])
  assert.equal(value.requestDigest, digest(model.request)); assert.equal(value.sourceArchiveDigest, digest(source))
  assert.equal(value.forkModelDigest, model.modelDigest); assert.equal(value.packageDigest, model.restoreContext.packageDigest)
  assert.equal(Object.hasOwn(value, 'savedDigest'), false); assert.equal(Object.hasOwn(value, 'authorized'), false)
  assert.equal(source.events.length, 0); assert.equal(model.persisted, false)
  assert.ok(Object.isFrozen(value)); assert.deepEqual(value, restoreReceipt(model))
})

test('every initialization receipt field is bound to full replay and extra success claims fail', () => {
  const model = restoreModel(edited(local(), 'old-edit')), receipt = restoreReceipt(model)
  for (const [key, changed] of Object.entries({ status: 'pending', kind: 'fork', identity: model.sourceArchive.baseArchive.descriptor.identity,
    operationId: 'other', requestDigest: 'f'.repeat(64), sourceArchiveDigest: 'f'.repeat(64), forkModelDigest: 'f'.repeat(64),
    packageDigest: 'f'.repeat(64), repositoryRevision: 99, worldRevision: 99 }))
    refuses(() => createRestored(model, { ...receipt, [key]: changed }), 'E_MERGE_STORE_RESTORE_RECEIPT')
  refuses(() => createRestored(model, { ...receipt, savedDigest: 'f'.repeat(64) }))
  refuses(() => createRestored(model, { ...receipt, actualAuthorized: true }))
})

test('ordinary edit merge then edit remains Saved v2 in the restored local namespace', () => {
  const parent = root(), source = edited(local('old-local', parent), 'old-edit', 'old note'), value = restored(source)
  const before = edited(value, 'before', 'restored note'), incoming = edited(local('incoming', parent), 'foreign', 'incoming')
  const combined = merged(before, incoming, 'merge-restored'), after = edited(combined, 'after', 'after restored merge')
  assert.deepEqual(read(after), after); assert.equal(after.formatVersion, 2)
  assert.deepEqual(after.baseArchive, value.baseArchive); assert.deepEqual(after.initialization, value.initialization)
  assert.deepEqual(after.events.map(row => row.receipt.operationId), ['before', 'merge-restored', 'after'])
  assert.ok(after.events.every(row => row.receipt.identity.branchId === 'restored'))
  assert.equal(after.projection.formatVersion, 3); assert.equal(after.projection.state.world.entries[0].fields.note, 'after restored merge')
})

test('a restored Saved is a complete source while its pure model or projection remains inadmissible', () => {
  const parent = root(), source = restored(edited(local('old-local', parent), 'old-edit', 'incoming note'))
  const combined = merged(local('target', parent), source, 'import-restored')
  assert.deepEqual(read(combined), combined); assert.deepEqual(combined.events[0].storeRequest.sourceArchive, source)
  assert.equal(combined.events[0].receipt.identity.branchId, 'target')
  assert.equal(combined.events[0].storeRequest.sourceArchive.initialization.receipt.identity.branchId, 'restored')
  for (const bare of [source.baseArchive, source.projection, source.projection.state]) {
    refuses(() => readSource(bare)); refuses(() => create(bare)); refuses(() => mergeRequest('bad-source', local('other', parent), bare, []))
  }
})

test('restored creation IDs are reserved locally while identically named inherited foreign events remain foreign', () => {
  const source = edited(local(), 'same-name', 'old note'), value = restored(source, 'restored', 'same-name')
  assert.equal(value.initialization.receipt.operationId, 'same-name')
  assert.equal(value.baseArchive.sourceArchive.events[0].receipt.operationId, 'same-name')
  assert.notDeepEqual(value.initialization.receipt.identity, value.baseArchive.sourceArchive.events[0].receipt.identity)
  refuses(() => operationRequest(edit(value, 'same-name'), value), 'E_REPO_OPERATION_CONFLICT')
  refuses(() => mergeRequest('same-name', value, source, []), 'E_REPO_OPERATION_CONFLICT')
  const changed = edited(value, 'later')
  refuses(() => operationRequest(edit(changed, 'later'), changed), 'E_REPO_OPERATION_CONFLICT')
})

test('Saved v1 cannot carry restored initialization and Saved v2 cannot omit it or fabricate a native anchor', () => {
  const original = local(), value = restored(original)
  refuses(() => read(rehash({ ...original, initialization: value.initialization })))
  const omitted = structuredClone(value); delete omitted.initialization; refuses(() => read(rehash(omitted)))
  refuses(() => read(rehash({ ...value, baseArchive: original.baseArchive })))
  refuses(() => read(rehash({ ...value, formatVersion: 1 })))
  refuses(() => read(rehash({ ...value, initialization: { ...value.initialization, committed: true } })))
})

test('full Saved source history and copied restore state cannot be forged through outer rehash', () => {
  const value = restored(edited(local(), 'old-event'))
  for (const change of [item => { item.baseArchive.sourceArchive.events = [] },
    item => { item.baseArchive.sourceArchive.events[0].receipt.requestDigest = 'f'.repeat(64) },
    item => { item.projection.state.world.entries[0].fields.note = 'forged' },
    item => { item.initialization.receipt.packageDigest = 'f'.repeat(64) }]) {
    const modified = structuredClone(value); change(modified); refuses(() => read(rehash(modified)))
  }
})

test('restore constructor binds backup-restore context without authenticating a filesystem package', () => {
  const value = local(), input = { operationId: 'pure-fork', identity: { libraryId: value.baseArchive.descriptor.identity.libraryId,
    branchId: 'fresh', genesisId: 'fresh-initial' }, binding: { hostId: 'synthetic', locationDigest: 'b'.repeat(64) } }
  const model = forkReplay(forkRequest(forkPreview(value), value, input), value)
  refuses(() => restoreReceipt(model), 'E_MERGE_STORE_RESTORE_CONTEXT')
  refuses(() => createRestored(model, {}), 'E_MERGE_STORE_RESTORE_CONTEXT')
  assert.equal(restoreModel(value).backupPackageVerified, false)
})

test('nested validation contexts are branded synchronous opaque tokens and JSON cannot bypass quota', () => {
  const value = local()
  for (const token of [{}, { validated: true }, { limits: {} }]) refuses(() => read(value, {}, {}, token), 'E_MERGE_STORE_VALIDATION_CONTEXT')
  let escaped
  validationScope([value], {}, undefined, ctx => {
    escaped = ctx
    assert.ok(Object.isFrozen(ctx)); assert.ok(Object.isFrozen(ctx.limits))
    assert.deepEqual(read(value, {}, ctx.limits, ctx), value)
    assert.throws(() => { ctx.limits.maxNodes = 500001 }, TypeError)
    refuses(() => read(value, {}, { maxNodes: 499999 }, ctx), 'E_BRANCH_MERGE_ARCHIVE_LIMIT')
  })
  refuses(() => read(value, {}, escaped.limits, escaped), 'E_MERGE_STORE_VALIDATION_CONTEXT')
  refuses(() => escaped.measure(value), 'E_MERGE_STORE_VALIDATION_CONTEXT')
})

test('restored envelopes remain immutable and reject accessor Proxy or forged completion data without executing it', () => {
  const model = restoreModel(local()), receipt = restoreReceipt(model), before = structuredClone({ model, receipt })
  const value = createRestored(model, receipt)
  assert.deepEqual({ model, receipt }, before); assert.ok(Object.isFrozen(value.initialization.receipt)); assert.ok(Object.isFrozen(value.baseArchive.sourceArchive))
  let traps = 0
  const proxy = new Proxy(model, { get() { traps++; throw Error('trap') }, ownKeys() { traps++; throw Error('trap') } })
  refuses(() => restoreReceipt(proxy)); refuses(() => createRestored(proxy, receipt)); assert.equal(traps, 0)
  const badReceipt = { ...receipt }; Object.defineProperty(badReceipt, 'packageDigest', { enumerable: true, get() { traps++; return receipt.packageDigest } })
  refuses(() => createRestored(model, badReceipt)); assert.equal(traps, 0)
})

test('Shared derived node budget is accumulated across nested Saved and fork readers rather than reset per module', () => {
  const source = local(), model = restoreModel(source), value = createRestored(model, restoreReceipt(model))
  const inputUsage = inspectRepositoryMergeArchiveInputs([value, {}])
  // Raw input fits, but cumulative derivation across both modules must not reset.
  inspectRepositoryMergeArchiveInputs([value, {}], { maxNodes: inputUsage.nodes * 2 })
  refuses(() => read(value, {}, { maxNodes: inputUsage.nodes * 2 }), 'E_SAVED_FORK_DERIVED_BUDGET')
  let actual
  validationScope([value], {}, undefined, ctx => {
    const original = ctx.measure
    assert.equal(typeof original, 'function')
    actual = read(value, {}, ctx.limits, ctx)
  })
  assert.deepEqual(actual, value)
  for (const limits of [{ maxNodes: 1000 }, { maxBytes: 1000 }, { maxArchives: 1 }, { maxAncestry: 0 }, { maxDepth: 1 }]) refuses(() => read(value, {}, limits))
})


test('new restored local edits may reuse an old foreign event name without relabeling the inherited receipt', () => {
  const source = edited(local(), 'old-name', 'foreign original'), value = restored(source)
  const changed = edited(value, 'old-name', 'new local edit')
  assert.deepEqual(read(changed), changed)
  assert.equal(changed.events[0].receipt.operationId, source.events[0].receipt.operationId)
  assert.equal(changed.events[0].receipt.identity.branchId, 'restored')
  assert.equal(changed.baseArchive.sourceArchive.events[0].receipt.identity.branchId, 'local')
  assert.deepEqual(changed.baseArchive.sourceArchive.events[0].receipt, source.events[0].receipt)
  assert.equal(changed.projection.state.world.entries[0].fields.note, 'new local edit')
})
