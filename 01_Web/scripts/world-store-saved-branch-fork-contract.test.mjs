import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seed, entry, id, candidate, NOW } from './world-store-repository.fixture.mjs'
import { readRepositoryState, transitionRepositoryState } from './world-store-repository.mjs'
import { repositoryStateDigest as digest } from './world-store-repository-v2-contract.mjs'
import { previewRepositoryArchive, readRepositoryArchive } from './world-store-branch-snapshot.mjs'
import { readRepositoryContinuousMergeModel } from './world-store-branch-continuous-merge-model.mjs'
import { inspectRepositoryMergeArchiveInputs } from './world-store-branch-merge-archive-model.mjs'
import { createRepositoryMergeSavedArchive as createSaved, readRepositoryMergeSavedArchive as readSaved,
  createRepositoryMergeStoreOperationRequest as ordinaryRequest, createRepositoryMergeStoreRequest as mergeRequest,
  projectRepositoryMergeStoreRequest as project, appendRepositoryMergeSavedEvent as append,
  previewRepositoryMergeStore as mergePreview } from './world-store-branch-merge-store-contract.mjs'
import { previewRepositorySavedBranchFork as preview, createRepositorySavedBranchForkRequest as request,
  replayRepositorySavedBranchFork as replay, readRepositorySavedBranchForkModel as read } from './world-store-saved-branch-fork-contract.mjs'

function root(family = 'synthetic-saved-fork-family') {
  const state = readRepositoryState({ format: 'starmap.world-repository', formatVersion: 1, revision: 0, world: seed().world,
    identities: { format: 'starmap.v2-store-identities', version: 1, identities: [] }, proposals: [], retired: [] })
  return { format: 'starmap.world-repository-v2', formatVersion: 2,
    identity: { libraryId: family, branchId: 'root', genesisId: 'root-genesis' },
    baseline: { sourceVersion: 1, sourceDigest: digest(state), coverage: 'baselineOnly', state, receipts: [] }, history: [], state }
}
function nativeFork(source, name = 'source', policy = {}) {
  const checked = previewRepositoryArchive(source, policy), binding = { hostId: 'synthetic-old-host', locationDigest: 'a'.repeat(64) }
  const sourceIdentity = source.identity ?? source.descriptor.identity
  const descriptor = { format: 'starmap.repository-branch', formatVersion: 1,
    identity: { libraryId: sourceIdentity.libraryId, branchId: name, genesisId: name + '-genesis' },
    origin: { kind: 'fork', source: checked.source }, binding }
  const creation = { status: 'completed', operationId: 'create-' + name,
    requestDigest: digest({ operationId: 'create-' + name, previewDigest: checked.previewDigest, binding }),
    previewDigest: checked.previewDigest, policyDigest: digest(policy) }
  return { format: 'starmap.world-repository-branch', formatVersion: 3, descriptor, sourceArchive: source, creation,
    markerDigest: digest({ format: 'starmap.repository-branch-location', formatVersion: 1, descriptor, creation }), state: source.state, history: [] }
}
function saved(name = 'source', parent = root(), policy = {}) { return createSaved(nativeFork(parent, name, policy), policy) }
// These fixture receipts are pure replay comparison data. No SQLite, host
// authorization, actual COMMIT, private source, or backup package is accessed.
function record(value, input) { return append(value, input, project(input, value).expectedReceipt) }
function act(value, operationId, action, identities) {
  const operation = { id: operationId, expectedRevision: value.projection.state.revision, action, ...(identities ? { identities } : {}) }
  return record(value, ordinaryRequest(operation, value))
}
function edit(value, operationId = 'old-edit', note = 'source note') {
  const row = value.projection.state.world.entries[0]
  return act(value, operationId, { kind: 'commands', commands: [{ op: 'update', table: 'entries', id: row.id,
    expectedRevision: row.revision, value: { ...row, revision: row.revision + 1, fields: { ...row.fields, note } } }] })
}
function merged(value, incoming, operationId = 'old-merge') {
  const choices = mergePreview(value, incoming).catalogue.items.map(row => ({ itemId: row.itemId,
    choice: row.allowedChoices.includes('source') ? 'source' : 'target' }))
  return record(value, mergeRequest(operationId, value, incoming, choices))
}
function mixed() {
  const parent = root(), local = edit(saved('source', parent), 'before', 'local'), incoming = edit(saved('incoming', parent), 'foreign', 'incoming')
  return edit(merged(local, incoming), 'after', 'after merge')
}
function parameters(value = saved(), extra = {}) {
  return { operationId: 'pure-new-fork', identity: { libraryId: value.baseArchive.descriptor.identity.libraryId,
    branchId: 'new-branch', genesisId: 'new-genesis' }, binding: { hostId: 'synthetic-new-host', locationDigest: 'b'.repeat(64) }, ...extra }
}
function prepare(value = saved(), input = parameters(value), policy = {}, limits = {}) {
  const planned = preview(value, policy, limits), requested = request(planned, value, input, policy, limits)
  return { value, input, planned, requested, model: replay(requested, value, policy, limits) }
}
function rehash(value, field = 'modelDigest') { const raw = { ...value }; delete raw[field]; return { ...raw, [field]: digest(raw) } }
const refuses = (action, code) => assert.throws(action, error => code ? error.code === code : typeof error.code === 'string')
function allFrozen(value) {
  if (value === null || typeof value !== 'object') return
  assert.ok(Object.isFrozen(value))
  for (const item of Object.values(value)) allFrozen(item)
}

test('empty Saved creates an independent pure fork without changing the old projection descriptor', () => {
  const { value, input, requested, model } = prepare()
  assert.deepEqual(read(model), model); assert.deepEqual(model.sourceArchive, value)
  assert.deepEqual(model.descriptor.identity, input.identity); assert.deepEqual(model.descriptor.binding, input.binding)
  assert.equal(model.descriptor.format, 'starmap.repository-saved-branch'); assert.equal(model.descriptor.formatVersion, 1)
  assert.equal(model.descriptor.origin.kind, 'saved-fork'); assert.deepEqual(model.descriptor.origin.source, requested.source)
  assert.deepEqual(model.state, value.projection.state); assert.deepEqual(model.localOperations, [])
  assert.equal(model.sourceArchive.projection.descriptor.identity.branchId, 'source')
  assert.equal(model.descriptor.identity.branchId, 'new-branch'); assert.deepEqual(model.request, requested)
})
test('preview binds complete Saved history and the old namespace, revisions and snapshot', () => {
  const value = mixed(), planned = preview(value), requested = request(planned, value, parameters(value))
  assert.equal(requested.source.savedDigest, value.savedDigest); assert.equal(requested.source.repositoryRevision, value.projection.state.revision)
  assert.equal(requested.source.worldRevision, value.projection.state.world.revision)
  assert.deepEqual(requested.source.identity, value.projection.descriptor.identity)
  assert.equal(requested.source.archiveFormat, value.format); assert.equal(requested.source.formatVersion, value.formatVersion)
  assert.equal(requested.sourceArchiveDigest, digest(value)); assert.equal(requested.previewDigest, planned.previewDigest)
  assert.equal(requested.policyDigest, digest({})); assert.match(requested.source.snapshotDigest, /^[a-f0-9]{64}$/)
})
test('mixed ordinary and merge source history survives intact with foreign receipt namespaces', () => {
  const { value, model } = prepare(mixed())
  assert.deepEqual(model.sourceArchive, value); assert.deepEqual(model.state, value.projection.state)
  assert.deepEqual(model.sourceArchive.events.map(row => row.receipt.operationId), ['before', 'old-merge', 'after'])
  assert.equal(model.sourceArchive.events[1].storeRequest.sourceArchive.events[0].receipt.identity.branchId, 'incoming')
  assert.deepEqual(model.localOperations, []); assert.equal(model.state.world.entries[0].fields.note, 'after merge')
  assert.equal(model.state.revision, value.projection.state.revision); assert.equal(model.state.world.revision, value.projection.state.world.revision)
})
test('native ancestor ordinary events are retained below the Saved anchor', () => {
  const parent = nativeFork(root(), 'ancestor'), row = parent.state.world.entries[0]
  const operation = { id: 'ancestor-edit', expectedRevision: parent.state.revision, action: { kind: 'commands', commands: [{ op: 'update',
    table: 'entries', id: row.id, expectedRevision: row.revision, value: { ...row, revision: row.revision + 1, fields: { ...row.fields, note: 'ancestor' } } }] } }
  const before = parent.state, after = transitionRepositoryState(before, operation)
  parent.history.push({ operationId: operation.id, request: operation, requestDigest: digest(operation), beforeDigest: digest(before), afterDigest: digest(after), after,
    receipt: { status: 'committed', identity: parent.descriptor.identity, operationId: operation.id, repositoryRevision: after.revision, worldRevision: after.world.revision } })
  parent.state = after
  const value = saved('source', parent), model = prepare(value).model
  assert.deepEqual(model.sourceArchive.baseArchive.sourceArchive, parent); assert.equal(model.state.world.entries[0].fields.note, 'ancestor')
  refuses(() => prepare(value, parameters(value, { identity: { libraryId: parent.descriptor.identity.libraryId, branchId: 'ancestor', genesisId: 'fresh' } })), 'E_SAVED_FORK_COLLISION')
})
test('pure operation reference has no real receipt, success state, new approval or executable commands', () => {
  const { requested, model, input } = prepare()
  assert.deepEqual(model.operationReference, { identity: input.identity, operationId: input.operationId, requestDigest: digest(requested) })
  for (const field of ['receipt', 'creation', 'committed', 'success', 'markerDigest']) assert.equal(Object.hasOwn(model, field), false)
  for (const field of ['executable', 'persisted', 'foreignReceiptsBecomeLocal', 'newLocalApprovalIssued', 'identityAllocated', 'backupPackageVerified']) assert.equal(model[field], false)
  assert.equal(model.hostValidationRequired, true); assert.deepEqual(model.commands, [])
})
test('restore context binds the declared package digest without verifying any actual backup package', () => {
  const value = mixed(), input = parameters(value, { restoreContext: { kind: 'backup-restore', packageDigest: 'c'.repeat(64) } })
  const { requested, model } = prepare(value, input)
  assert.deepEqual(requested.restoreContext, input.restoreContext); assert.deepEqual(model.restoreContext, input.restoreContext)
  assert.equal(model.backupPackageVerified, false); assert.equal(model.executable, false); assert.deepEqual(read(model), model)
  const other = prepare(value, { ...input, restoreContext: { ...input.restoreContext, packageDigest: 'd'.repeat(64) } })
  assert.notEqual(other.requested.resultDigest, requested.resultDigest); assert.notEqual(other.model.modelDigest, model.modelDigest)
})
test('same old operation name is allowed because the new local namespace is distinct', () => {
  const value = edit(saved(), 'same-name'), { model } = prepare(value, parameters(value, { operationId: 'same-name' }))
  assert.equal(model.operationReference.operationId, 'same-name')
  assert.equal(model.sourceArchive.events[0].receipt.operationId, 'same-name')
  assert.notDeepEqual(model.operationReference.identity, model.sourceArchive.events[0].receipt.identity)
  assert.deepEqual(model.localOperations, [])
})
test('source top-level branch ID and genesis ID collisions are rejected independently', () => {
  const value = mixed(), base = parameters(value)
  for (const identity of [{ ...base.identity, branchId: 'source' }, { ...base.identity, genesisId: 'source-genesis' }])
    refuses(() => prepare(value, { ...base, identity }), 'E_SAVED_FORK_COLLISION')
})
test('root ancestor namespace collisions are rejected even when the current source namespace differs', () => {
  const value = mixed(), base = parameters(value)
  for (const identity of [{ ...base.identity, branchId: 'root' }, { ...base.identity, genesisId: 'root-genesis' }])
    refuses(() => prepare(value, { ...base, identity }), 'E_SAVED_FORK_COLLISION')
})
test('complete incoming Saved namespaces cannot be reused by the new branch', () => {
  const value = mixed(), base = parameters(value)
  for (const identity of [{ ...base.identity, branchId: 'incoming' }, { ...base.identity, genesisId: 'incoming-genesis' }])
    refuses(() => prepare(value, { ...base, identity }), 'E_SAVED_FORK_COLLISION')
})
test('native source leaves embedded by a merge also reserve their namespaces', () => {
  const parent = root(), value = merged(saved('source', parent), nativeFork(parent, 'native-leaf'))
  for (const identity of [{ ...parameters(value).identity, branchId: 'native-leaf' }, { ...parameters(value).identity, genesisId: 'native-leaf-genesis' }])
    refuses(() => prepare(value, { ...parameters(value), identity }), 'E_SAVED_FORK_COLLISION')
})
test('a nested incoming Saved retains namespaces from its own incoming history', () => {
  const parent = root(), deep = merged(saved('deep', parent), edit(saved('deep-incoming', parent), 'deep-edit'))
  const value = merged(saved('source', parent), deep)
  for (const identity of [{ ...parameters(value).identity, branchId: 'deep-incoming' }, { ...parameters(value).identity, genesisId: 'deep-incoming-genesis' }])
    refuses(() => prepare(value, { ...parameters(value), identity }), 'E_SAVED_FORK_COLLISION')
})
test('new branch family must equal the validated Saved source family', () => {
  const value = saved(), input = parameters(value)
  refuses(() => prepare(value, { ...input, identity: { ...input.identity, libraryId: 'other-family' } }), 'E_SAVED_FORK_IDENTITY')
})
test('Canonical allocation identity is carried unchanged into the new fork state', () => {
  const value = act(saved(), 'allocate', { kind: 'commands', commands: [{ op: 'create', table: 'entries', value: entry(60) }] },
    [{ kind: 'entry', sourceId: 'test:manual', recordId: 'record-60', id: id(60) }])
  const model = prepare(value).model
  assert.deepEqual(model.state.identities, value.projection.state.identities)
  assert.equal(model.state.identities.identities[0].id, id(60)); assert.deepEqual(model.state.world.entries, value.projection.state.world.entries)
})
test('permanent tombstones are retained without resurrecting the removed entity', () => {
  let value = act(saved(), 'allocate', { kind: 'commands', commands: [{ op: 'create', table: 'entries', value: entry(60) }] },
    [{ kind: 'entry', sourceId: 'test:manual', recordId: 'record-60', id: id(60) }])
  const row = value.projection.state.world.entries.find(item => item.id === id(60))
  value = act(value, 'remove', { kind: 'commands', commands: [{ op: 'remove', table: 'entries', id: row.id, expectedRevision: row.revision }] })
  const model = prepare(value).model
  assert.deepEqual(model.state.retired, value.projection.state.retired); assert.ok(model.state.retired.some(item => item.id === row.id))
  assert.equal(model.state.world.entries.some(item => item.id === row.id), false); assert.deepEqual(model.state.identities, value.projection.state.identities)
})
test('accepted candidates and local review facts are preserved rather than re-approved', () => {
  let value = act(saved(), 'stage', { kind: 'stage-proposal', proposal: candidate() })
  value = act(value, 'accept', { kind: 'accept-proposal', proposalId: candidate().id, decision: { reviewId: 'old-review', acceptedAt: NOW } })
  const model = prepare(value).model
  assert.equal(model.state.proposals[0].status, 'accepted'); assert.deepEqual(model.state.proposals, value.projection.state.proposals)
  assert.deepEqual(model.state.world.reviews, value.projection.state.world.reviews); assert.equal(model.newLocalApprovalIssued, false)
})
test('pending candidates remain pending and do not acquire local approval facts', () => {
  const value = act(saved(), 'stage', { kind: 'stage-proposal', proposal: candidate() }), model = prepare(value).model
  assert.equal(model.state.proposals[0].status, 'pending'); assert.deepEqual(model.state.world.reviews, value.projection.state.world.reviews)
  assert.deepEqual(model.localOperations, []); assert.equal(model.newLocalApprovalIssued, false)
})
test('native archive, bare projection and ordinary state cannot stand in for a complete Saved source', () => {
  const value = mixed()
  for (const source of [value.baseArchive, value.projection, value.projection.state, root()]) {
    refuses(() => preview(source)); refuses(() => request(preview(value), source, parameters(value))); refuses(() => replay(prepare(value).requested, source))
  }
})
test('preview and request become stale when an ordinary source event changes the Saved history', () => {
  const value = saved(), { planned, requested } = prepare(value), changed = edit(value)
  refuses(() => request(planned, changed, parameters(value)), 'E_SAVED_FORK_PREVIEW')
  refuses(() => replay(requested, changed), 'E_SAVED_FORK_STALE')
  const base = structuredClone(value.baseArchive)
  base.creation.operationId = 'different-creation-history'
  base.creation.requestDigest = digest({ operationId: base.creation.operationId, previewDigest: base.creation.previewDigest, binding: base.descriptor.binding })
  base.markerDigest = digest({ format: 'starmap.repository-branch-location', formatVersion: 1, descriptor: base.descriptor, creation: base.creation })
  const historyOnly = createSaved(base)
  assert.deepEqual(historyOnly.projection.state, value.projection.state)
  assert.notEqual(historyOnly.savedDigest, value.savedDigest)
  refuses(() => request(planned, historyOnly, parameters(value)), 'E_SAVED_FORK_PREVIEW')
  refuses(() => replay(requested, historyOnly), 'E_SAVED_FORK_STALE')
})
test('source receipt tampering or deletion is rejected even with recomputed Saved envelope digest', () => {
  const value = edit(saved())
  for (const mutate of [item => { item.events[0].receipt.afterDigest = 'f'.repeat(64) }, item => { item.events = [] },
    item => { item.events[0].storeRequest.pureRequest.operation.action.commands[0].value.fields.note = 'forged' }]) {
    const modified = structuredClone(value); mutate(modified); refuses(() => preview(rehash(modified, 'savedDigest')))
  }
})
test('outer model rehash cannot hide a modified source state or missing source history', () => {
  const { model } = prepare(mixed())
  for (const mutate of [item => { item.sourceArchive.projection.state.world.entries[0].fields.note = 'forged' },
    item => { item.sourceArchive.events = [] }, item => { item.sourceArchive.events[1].storeRequest.sourceArchive.events = [] }]) {
    const changed = structuredClone(model); mutate(changed); refuses(() => read(rehash(changed)))
  }
})
test('outer model rehash cannot hide altered copied state, identity allocation or review facts', () => {
  const { model } = prepare(mixed())
  for (const mutate of [item => { item.state.world.entries[0].fields.note = 'forged' }, item => { item.state.revision++ },
    item => { item.state.identities.identities.push({ kind: 'entry', sourceId: 'forged', recordId: 'forged', id: id(99) }) },
    item => { item.state.world.reviews.push({ id: 'forged-review' }) }, item => { item.state.retired.push({ kind: 'entry', id: id(99) }) }]) {
    const changed = structuredClone(model); mutate(changed); refuses(() => read(rehash(changed)))
  }
})
test('request source references and derived result digest are recomputed during replay', () => {
  const { value, requested } = prepare(mixed())
  const mutations = [item => { item.sourceArchiveDigest = 'f'.repeat(64) }, item => { item.source.savedDigest = 'f'.repeat(64) },
    item => { item.source.archiveDigest = 'f'.repeat(64) }, item => { item.source.snapshotDigest = 'f'.repeat(64) },
    item => { item.source.repositoryRevision++ }, item => { item.source.worldRevision++ }, item => { item.resultDigest = 'f'.repeat(64) }]
  for (const mutate of mutations) { const changed = structuredClone(requested); mutate(changed); refuses(() => replay(changed, value)) }
})
test('model operation reference and descriptor remain bound to the recomputed request', () => {
  const { model } = prepare()
  for (const mutate of [item => { item.operationReference.operationId = 'forged' }, item => { item.operationReference.requestDigest = 'f'.repeat(64) },
    item => { item.operationReference.identity.branchId = 'forged' }, item => { item.descriptor.binding.hostId = 'forged' },
    item => { item.descriptor.origin.source.savedDigest = 'f'.repeat(64) }, item => { item.localOperations = [item.operationReference] }]) {
    const changed = structuredClone(model); mutate(changed); refuses(() => read(rehash(changed)))
  }
})
test('every authority flag and command field is checked despite recomputed outer digest', () => {
  const { model } = prepare()
  for (const field of ['executable', 'persisted', 'foreignReceiptsBecomeLocal', 'newLocalApprovalIssued', 'identityAllocated', 'backupPackageVerified', 'hostValidationRequired']) {
    const changed = structuredClone(model); changed[field] = !changed[field]; refuses(() => read(rehash(changed)))
  }
  const changed = structuredClone(model); changed.commands = [{ op: 'restore', path: 'forged' }]; refuses(() => read(rehash(changed)))
})
test('policy is bound through preview, request and model and cannot be swapped on replay', () => {
  const policy = { maxCommands: 50 }, value = saved('source', root(), policy), { planned, requested, model } = prepare(value, parameters(value), policy)
  assert.deepEqual(read(model, policy), model); assert.equal(requested.policyDigest, digest(policy))
  refuses(() => request(planned, value, parameters(value), {})); refuses(() => replay(requested, value, {})); refuses(() => read(model, {}))
})
test('invalid parameters, unknown authority claims and malformed restore contexts are refused', () => {
  const value = saved(), base = parameters(value), planned = preview(value)
  for (const input of [{ ...base, operationId: '' }, { ...base, identity: { ...base.identity, branchId: '' } },
    { ...base, binding: { ...base.binding, locationDigest: 'not-a-digest' } }, { ...base, authorized: true },
    { ...base, binding: { ...base.binding, authorized: true } }, { ...base, identity: { ...base.identity, trusted: true } }])
    refuses(() => request(planned, value, input))
  for (const restoreContext of [{ kind: 'backup-restore', packageDigest: 'bad' }, { kind: 'other', packageDigest: 'c'.repeat(64) },
    { kind: 'backup-restore', packageDigest: 'c'.repeat(64), verified: true }, true, []])
    refuses(() => request(planned, value, { ...base, restoreContext }))
})
test('unknown format, version and extra fields cannot be converted into fork evidence', () => {
  const { value, planned, requested, model } = prepare()
  for (const changed of [{ ...model, formatVersion: 2 }, { ...model, format: 'starmap.world-repository-branch' }, { ...model, receipt: {} }]) refuses(() => read(rehash(changed)))
  refuses(() => replay({ ...requested, formatVersion: 2 }, value))
  refuses(() => request({ ...planned, actualAuthorized: true }, value, parameters(value)))
  refuses(() => replay({ ...requested, actualAuthorized: true }, value))
})
test('all inputs remain untouched and all derived outputs are deeply frozen and deterministic', () => {
  const value = mixed(), input = parameters(value, { restoreContext: { kind: 'backup-restore', packageDigest: 'c'.repeat(64) } })
  const before = structuredClone({ value, input }), first = prepare(value, input), second = prepare(value, input)
  assert.deepEqual(first, second); assert.deepEqual({ value, input }, before)
  allFrozen(first.planned); allFrozen(first.requested); allFrozen(first.model); allFrozen(read(first.model))
})
test('Proxy, revoked Proxy and getters are rejected without invoking caller code at any API boundary', () => {
  const { value, planned, requested, model, input } = prepare(); let trapped = 0, accessed = 0
  const proxy = object => new Proxy(object, { get() { trapped++; throw Error('get trap') }, ownKeys() { trapped++; throw Error('keys trap') },
    getOwnPropertyDescriptor() { trapped++; throw Error('descriptor trap') } })
  for (const call of [() => preview(proxy(value)), () => request(proxy(planned), value, input), () => request(planned, proxy(value), input),
    () => request(planned, value, proxy(input)), () => replay(proxy(requested), value), () => replay(requested, proxy(value)),
    () => read(proxy(model)), () => preview(value, proxy({})), () => preview(value, {}, proxy({}))]) refuses(call)
  assert.equal(trapped, 0)
  const accessor = { ...input }; Object.defineProperty(accessor, 'operationId', { enumerable: true, get() { accessed++; return 'forged' } })
  refuses(() => request(planned, value, accessor)); assert.equal(accessed, 0)
  const revoked = Proxy.revocable(model, {}); revoked.revoke(); refuses(() => read(revoked.proxy)); assert.equal(trapped, 0)
})
test('sparse arrays, cycles, symbols and non-finite JSON values fail before semantic reconstruction', () => {
  const value = saved(), cyclic = structuredClone(value); cyclic.events.push(cyclic)
  const sparse = structuredClone(value); sparse.events = Array(1)
  const symbol = { ...value, [Symbol('authority')]: true }
  for (const source of [cyclic, sparse, symbol, { ...value, extra: Infinity }, { ...value, extra: undefined }]) refuses(() => preview(source))
})
test('depth, node, byte, archive and ancestry limits apply and cannot be relaxed above existing bounds', () => {
  const { value, planned, requested, model, input } = prepare(mixed())
  for (const limits of [{ maxDepth: 1 }, { maxNodes: 2 }, { maxBytes: 16 }, { maxArchives: 1 }, { maxAncestry: 0 }]) {
    refuses(() => preview(value, {}, limits)); refuses(() => request(planned, value, input, {}, limits))
    refuses(() => replay(requested, value, {}, limits)); refuses(() => read(model, {}, limits))
  }
  for (const limits of [{ maxAncestry: 9 }, { maxNodes: 500001 }, { maxBytes: 128 * 1024 * 1024 + 1 }, { maxDepth: 65 }, { maxArchives: 129 }, { maxNodes: -1 }])
    refuses(() => preview(value, {}, limits), 'E_BRANCH_MERGE_ARCHIVE_LIMIT')
})
test('old native, continuous and Saved readers reject the new pure model instead of granting writer access', () => {
  const { model } = prepare(mixed())
  refuses(() => readRepositoryArchive(model)); refuses(() => readRepositoryContinuousMergeModel(model)); refuses(() => readSaved(model))
  refuses(() => createSaved(model)); assert.equal(model.executable, false); assert.equal(model.persisted, false)
})
test('explicit null restore context equals omission while legitimate fresh identity parameters create a new pure request', () => {
  const value = saved(), first = prepare(value), explicit = prepare(value, { ...first.input, restoreContext: null })
  assert.deepEqual(first.requested, explicit.requested); assert.deepEqual(first.model, explicit.model)
  const changed = prepare(value, { ...first.input, identity: { ...first.input.identity, branchId: 'another-new-branch' } })
  assert.deepEqual(read(changed.model), changed.model); assert.notEqual(changed.model.modelDigest, first.model.modelDigest)
  assert.equal(changed.model.hostValidationRequired, true); assert.equal(changed.model.identityAllocated, false)
})
test('replay accounts for derived output expansion beyond input JSON node and byte size', () => {
  const { value, requested, model } = prepare(), input = inspectRepositoryMergeArchiveInputs([requested, value, {}])
  const output = inspectRepositoryMergeArchiveInputs([model])
  assert.ok(output.nodes > input.nodes); assert.ok(output.bytes > input.bytes)
  refuses(() => replay(requested, value, {}, { maxNodes: output.nodes + 100 }), 'E_SAVED_FORK_DERIVED_BUDGET')
  refuses(() => replay(requested, value, {}, { maxBytes: output.bytes + 1000 }), 'E_SAVED_FORK_DERIVED_BUDGET')
})
