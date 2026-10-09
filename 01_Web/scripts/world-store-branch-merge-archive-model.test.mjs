import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seed, entry, id, candidate, NOW } from './world-store-repository.fixture.mjs'
import { readRepositoryState, transitionRepositoryState } from './world-store-repository.mjs'
import { repositoryStateDigest as digest } from './world-store-repository-v2-contract.mjs'
import { previewRepositoryArchive, readRepositoryArchive } from './world-store-branch-snapshot.mjs'
import { operationIdentityKey } from './world-store-branch-contract.mjs'
import { previewRepositoryBranchHistory as preview } from './world-store-branch-history-preview.mjs'
import { createRepositoryBranchMergePlan as plan } from './world-store-branch-merge-plan.mjs'
import { simulateRepositoryBranchMerge as simulate } from './world-store-branch-merge-simulation.mjs'
import { createRepositoryBranchMergeCommitRequest as commit, replayRepositoryBranchMergeCommit as replay } from './world-store-branch-merge-commit-contract.mjs'
import { createRepositoryBranchMergeArchiveModel as create, readRepositoryBranchMergeArchiveModel as read,
  indexRepositoryBranchMergeArchiveModel as index } from './world-store-branch-merge-archive-model.mjs'

// Neutral in-memory siblings, adapted from the independently tested PR58 contract.
// No database, filesystem, private input, browser or host authority is involved.
function parent(family = 'family') {
  const state = readRepositoryState({ format: 'starmap.world-repository', formatVersion: 1, revision: 0, world: seed().world,
    identities: { format: 'starmap.v2-store-identities', version: 1, identities: [] }, proposals: [], retired: [] })
  return { format: 'starmap.world-repository-v2', formatVersion: 2, identity: { libraryId: family, branchId: 'parent', genesisId: 'initial' },
    baseline: { sourceVersion: 1, sourceDigest: digest(state), coverage: 'baselineOnly', state, receipts: [] }, history: [], state }
}
function branch(source, name, origin = 'fork') {
  const fork = previewRepositoryArchive(source), binding = { hostId: 'synthetic', locationDigest: 'a'.repeat(64) }
  const sourceIdentity = source.identity ?? source.descriptor?.identity
  const descriptor = { format: 'starmap.repository-branch', formatVersion: 1,
    identity: { libraryId: sourceIdentity?.libraryId ?? 'family', branchId: name, genesisId: name + '-initial' },
    origin: { kind: origin, source: fork.source }, binding }
  const creation = { status: 'completed', operationId: 'create-' + name,
    requestDigest: digest({ operationId: 'create-' + name, previewDigest: fork.previewDigest, binding }),
    previewDigest: fork.previewDigest, policyDigest: digest({}) }
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
function requestFor(target, source, operationId = 'local-import', select = row => row.allowedChoices.includes('source') ? 'source' : 'target') {
  const report = preview(target, source), catalogue = plan(report, target, source)
  const selected = plan(report, target, source, catalogue.items.map(row => ({ itemId: row.itemId, choice: select(row) })))
  return commit(operationId, simulate(selected, report, target, source), selected, report, target, source)
}
function incoming() {
  const [target, source] = siblings(); edit(source, 'foreign-edit', 'Synthetic incoming note')
  const request = requestFor(target, source)
  return { target, source, request, model: create(target, request) }
}
const refuses = action => assert.throws(action, error => typeof error.code === 'string' && !(error instanceof RangeError))
function rehash(value) { const raw = { ...value }; delete raw.modelDigest; value.modelDigest = digest(raw); return value }
const key = row => operationIdentityKey(row.identity, row.operationId)

test('object, array, nested and revoked Proxies are refused before any caller trap executes', () => {
  const { target, request, model } = incoming()
  let calls = 0
  const trap = () => { calls++; throw new Error('Proxy trap must never run') }
  const handler = { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap }
  const object = new Proxy(model, handler), array = new Proxy([], handler)
  const revokedObject = Proxy.revocable({}, handler), revokedArray = Proxy.revocable([], handler)
  revokedObject.revoke(); revokedArray.revoke()
  const refused = action => assert.throws(action, error => error.code === 'E_BRANCH_MERGE_ARCHIVE_JSON')
  for (const value of [object, array, revokedObject.proxy, revokedArray.proxy]) {
    refused(() => read(value)); refused(() => index(value))
    refused(() => create(value, request)); refused(() => create(target, value))
    refused(() => read(model, value)); refused(() => index(model, value))
    refused(() => read(model, {}, value)); refused(() => index(model, {}, value))
    refused(() => read({ ...model, state: value }))
  }
  assert.equal(calls, 0)
  assert.deepEqual(read(model), model)
})

test('the complete model replays PR58 exactly, freezes its output and preserves inputs without persistence or authority', () => {
  const { target, source, request } = incoming(), before = structuredClone({ target, source, request })
  const model = create(target, request), expected = replay(request, target)
  assert.equal(model.format, 'starmap.repository-branch-merge-archive-model'); assert.equal(model.formatVersion, 1)
  assert.deepEqual(model.baseArchive, target); assert.deepEqual(model.mergeRequest, request)
  assert.equal(model.beforeArchiveDigest, digest(target)); assert.equal(model.afterDigest, expected.afterDigest)
  assert.deepEqual(model.state, expected.after); assert.deepEqual(model.localOperation, expected.localOperation)
  for (const property of ['executable', 'persisted', 'foreignReceiptsBecomeLocal', 'newLocalApprovalIssued']) assert.equal(model[property], false)
  assert.deepEqual(model.commands, []); assert.equal(Object.hasOwn(model, 'receipt'), false)
  assert.equal(Object.hasOwn(model.localOperation, 'receipt'), false); assert.equal(Object.hasOwn(model.localOperation, 'status'), false)
  const raw = { ...model }; delete raw.modelDigest; assert.equal(model.modelDigest, digest(raw))
  assert.deepEqual(read(model), model); assert.deepEqual(create(target, request), model)
  assert.ok(Object.isFrozen(model)); assert.ok(Object.isFrozen(model.mergeRequest.sourceArchive.history))
  assert.ok(Object.isFrozen(model.state.world.entries[0])); assert.deepEqual({ target, source, request }, before)
})

test('archive-only adoption keeps all world clocks and makes exactly the existing hypothetical repository step', () => {
  const [target, source] = siblings(), model = create(target, requestFor(target, source))
  assert.deepEqual(model.state.world, target.state.world)
  assert.equal(model.state.revision, target.state.revision + 1)
  assert.equal(model.state.world.revision, target.state.world.revision)
  assert.deepEqual(model.baseArchive.history, []); assert.equal(model.mergeRequest.sourceArchive.history.length, 0)
})

test('valid outer hashes cannot conceal altered facts, operation identity or authority flags', () => {
  const { model, source } = incoming()
  const changes = [
    value => { value.state.world.entries[0].fields.note = 'Tampered and rehashed'; value.afterDigest = digest(value.state) },
    value => { value.localOperation.identity = source.descriptor.identity },
    value => { value.localOperation.requestDigest = '0'.repeat(64) },
    value => { value.beforeArchiveDigest = digest(value.state) },
    ...['executable', 'persisted', 'foreignReceiptsBecomeLocal', 'newLocalApprovalIssued'].map(field => value => { value[field] = true }),
    value => { value.commands = [{ op: 'pretend-write' }] },
    value => { value.receipt = { status: 'committed', operationId: 'local-import' } },
    value => { value.approved = true },
    value => { value.localOperation.status = 'committed' },
  ]
  for (const change of changes) {
    const value = structuredClone(model); change(value); rehash(value)
    refuses(() => read(value)); refuses(() => index(value))
  }
})

test('history-only target changes expire the request even if the complete world is unchanged', () => {
  const { target, request, model } = incoming(), changed = structuredClone(target)
  historyOnly(changed, 'new-local-history')
  assert.deepEqual(changed.state.world, target.state.world)
  refuses(() => create(changed, request))
  const forged = structuredClone(model); forged.baseArchive = changed; forged.beforeArchiveDigest = digest(changed)
  refuses(() => read(rehash(forged)))
})

test('source history, choice catalogue, policy and derived request fingerprints are bound', () => {
  const { model } = incoming()
  for (const change of [value => historyOnly(value.mergeRequest.sourceArchive, 'source-later'),
    value => { value.mergeRequest.choices.reverse() }, value => { value.mergeRequest.choices.push(value.mergeRequest.choices[0]) },
    value => { value.mergeRequest.policyDigest = '0'.repeat(64) }, value => { value.mergeRequest.resultDigest = digest(value.baseArchive.state) }]) {
    const forged = structuredClone(model); change(forged); refuses(() => read(rehash(forged)))
  }
  refuses(() => read(model, { allowDefinitionWrites: true }))
})

test('unknown format, logical v4 disguises, missing fields and injected extra event lists are rejected', () => {
  const { model, request } = incoming()
  for (const change of [value => { value.formatVersion = 2 }, value => { value.format = 'starmap.world-repository-branch' },
    value => { value.baseArchive.formatVersion = 4 }, value => { delete value.mergeRequest }, value => { value.events = [request, request] }]) {
    const forged = structuredClone(model); change(forged); refuses(() => read(rehash(forged)))
  }
})

test('the single terminal model is rejected by old readers and cannot become a second target or source', () => {
  const { target, request, model } = incoming()
  refuses(() => readRepositoryArchive(model)); refuses(() => previewRepositoryArchive(model))
  refuses(() => preview(model, target)); refuses(() => preview(target, model))
  refuses(() => create(model, request))
  const forged = structuredClone(model); forged.mergeRequest.sourceArchive = model
  refuses(() => read(rehash(forged)))
})

test('index preserves every full ancestor once and returns evidence rather than a latest shared point', () => {
  const base = historyOnly(parent(), 'parent-history'), [target, source] = siblings(base)
  historyOnly(target, 'local-history'); edit(source, 'source-history', 'Incoming')
  const model = create(target, requestFor(target, source)), before = structuredClone(model), result = index(model)
  assert.equal(result.format, 'starmap.repository-branch-merge-archive-index'); assert.equal(result.formatVersion, 1)
  assert.equal(result.modelDigest, model.modelDigest)
  assert.deepEqual(new Set(result.archives.map(row => row.archiveDigest)), new Set([digest(base), digest(target), digest(source)]))
  assert.equal(result.archives.length, 3); assert.equal(result.branches.length, 3)
  assert.deepEqual(new Set(result.archivedOperations.map(key)), new Set([
    operationIdentityKey(base.identity, 'parent-history'), operationIdentityKey(target.descriptor.identity, 'local-history'),
    operationIdentityKey(source.descriptor.identity, 'source-history'),
  ]))
  assert.equal(result.archivedOperations.length, 3); assert.deepEqual(result.localOperation, model.localOperation)
  assert.equal(result.archivedOperations.some(row => key(row) === key(result.localOperation)), false)
  for (const property of ['executable', 'persisted', 'foreignReceiptsBecomeLocal', 'newLocalApprovalIssued']) assert.equal(result[property], false)
  assert.deepEqual(result.commands, [])
  for (const row of result.archivedOperations) {
    assert.equal(Object.hasOwn(row, 'receipt'), false); assert.equal(Object.hasOwn(row, 'status'), false)
    assert.match(row.requestDigest, /^[a-f0-9]{64}$/); assert.match(row.beforeDigest, /^[a-f0-9]{64}$/); assert.match(row.afterDigest, /^[a-f0-9]{64}$/)
  }
  for (const archive of [base, target, source]) {
    const identity = archive.identity ?? archive.descriptor.identity
    for (const state of [archive.formatVersion === 2 ? archive.baseline.state : archive.sourceArchive.state, ...archive.history.map(row => row.after)]) {
      assert.ok(result.checkpoints.some(row => row.identity.branchId === identity.branchId && row.repositoryRevision === state.revision && row.stateDigest === digest(state)))
    }
  }
  assert.equal(new Set(result.checkpoints.map(row => JSON.stringify(row))).size, result.checkpoints.length)
  assert.deepEqual(result.hypotheticalCheckpoint.identity, target.descriptor.identity)
  assert.equal(result.hypotheticalCheckpoint.repositoryRevision, model.state.revision)
  assert.equal(result.hypotheticalCheckpoint.stateDigest, digest(model.state))
  assert.equal(result.checkpoints.some(row => row.identity.branchId === target.descriptor.identity.branchId && row.stateDigest === digest(model.state)), false)
  assert.equal(Object.hasOwn(result, 'latestCommonCheckpoint'), false); assert.equal(Object.hasOwn(result, 'commonCheckpoint'), false)
  assert.ok(Object.isFrozen(result.checkpoints)); assert.deepEqual(model, before); assert.deepEqual(index(model), result)
})

test('same operation names in parent, foreign and new local namespaces remain separate', () => {
  const base = historyOnly(parent(), 'local-import'), [target, source] = siblings(base)
  edit(source, 'local-import', 'Foreign operation with the same opaque name')
  const result = index(create(target, requestFor(target, source)))
  assert.deepEqual(result.archivedOperations.map(row => row.identity.branchId).sort(), ['parent', 'source'])
  assert.equal(result.localOperation.identity.branchId, 'target')
  assert.equal(new Set([...result.archivedOperations, result.localOperation].map(key)).size, 3)
})

test('namespace conflicts cannot be hidden by retaining facts or rehashing the envelope', () => {
  const { target, source, model } = incoming()
  const namespaceChanged = structuredClone(source); namespaceChanged.descriptor.identity = { ...target.descriptor.identity, genesisId: 'different-genesis' }
  namespaceChanged.markerDigest = digest({ format: 'starmap.repository-branch-location', formatVersion: 1,
    descriptor: namespaceChanged.descriptor, creation: namespaceChanged.creation })
  namespaceChanged.history.forEach(row => { row.receipt.identity = namespaceChanged.descriptor.identity })
  assert.deepEqual(readRepositoryArchive(namespaceChanged), namespaceChanged)
  refuses(() => requestFor(target, namespaceChanged))
  const divergent = structuredClone(target); edit(divergent, 'colliding', 'One body')
  const divergentSource = structuredClone(target); edit(divergentSource, 'colliding', 'Another body')
  assert.deepEqual(readRepositoryArchive(divergent), divergent); assert.deepEqual(readRepositoryArchive(divergentSource), divergentSource)
  refuses(() => requestFor(divergent, divergentSource, 'another-import'))
  const common = parent(), advanced = historyOnly(structuredClone(common), 'ancestor-later')
  const originChanged = branch(advanced, 'target')
  assert.deepEqual(originChanged.descriptor.identity, target.descriptor.identity)
  assert.deepEqual(readRepositoryArchive(originChanged), originChanged)
  refuses(() => requestFor(target, originChanged))
  const forged = structuredClone(model); forged.mergeRequest.sourceArchive = namespaceChanged
  refuses(() => index(rehash(forged)))
})

test('historical references contain the complete original chain summaries rather than adopted foreign receipts', () => {
  const [target, source] = siblings()
  append(source, 'stage', { kind: 'stage-proposal', proposal: candidate() })
  append(source, 'accept', { kind: 'accept-proposal', proposalId: candidate().id, decision: { reviewId: 'foreign-review', acceptedAt: NOW } })
  const model = create(target, requestFor(target, source)), result = index(model)
  assert.equal(model.state.proposals[0].status, 'accepted'); assert.equal(model.state.world.reviews[0].id, 'foreign-review')
  assert.deepEqual(model.mergeRequest.sourceArchive.history.map(row => row.receipt.identity), [source.descriptor.identity, source.descriptor.identity])
  for (const row of source.history) {
    assert.deepEqual(result.archivedOperations.find(value => value.operationId === row.operationId), {
      identity: source.descriptor.identity, operationId: row.operationId, requestDigest: row.requestDigest,
      beforeDigest: row.beforeDigest, afterDigest: row.afterDigest,
    })
  }
  assert.equal(result.localOperation.identity.branchId, 'target'); assert.equal(model.foreignReceiptsBecomeLocal, false)
  assert.equal(model.newLocalApprovalIssued, false); assert.equal(target.history.length, 0)
})

test('legacy baselines retain unavailable edit-body status and do not acquire permanent identity', () => {
  const { model } = incoming(), result = index(model)
  assert.equal(result.legacy.length, 1)
  assert.equal(result.legacy[0].identityStatus, 'unknown'); assert.equal(result.legacy[0].editBodies, 'unavailable')
  assert.equal(result.legacy[0].receiptCount, 0); assert.equal(result.legacy[0].stateDigest, digest(model.baseArchive.sourceArchive.baseline.state))
  assert.equal(Object.hasOwn(result.legacy[0], 'identity'), false)
  const state = parent().state, legacy = { format: 'starmap.world-repository-legacy', formatVersion: 1,
    coverage: 'baselineOnly', editBodies: 'unavailable', state, receipts: [] }
  const upgraded = branch(legacy, 'upgraded', 'upgrade'), [target, source] = siblings(upgraded)
  edit(source, 'foreign-edit', 'Incoming after a known upgrade checkpoint')
  const archive = create(target, requestFor(target, source)), indexed = index(archive)
  assert.ok(indexed.archives.some(row => row.formatVersion === 1 && row.archiveDigest === digest(legacy)))
  assert.ok(indexed.legacy.some(row => row.archiveDigest === digest(legacy) && row.identityStatus === 'unknown'))
  refuses(() => requestFor(target, legacy))
})

test('permanent target tombstones, allocation identities and local decisions survive archival replay', () => {
  const base = commands(parent(), 'add', [{ op: 'create', table: 'entries', value: entry(60) }]), [target, source] = siblings(base)
  commands(target, 'remove', [{ op: 'remove', table: 'entries', id: id(60), expectedRevision: 0 }])
  append(target, 'ledger', { kind: 'stage-proposal', proposal: { ...candidate(), baseRevision: target.state.world.revision } },
    [{ kind: 'entry', sourceId: 'test:manual', recordId: 'dead', id: id(80) }])
  edit(source, 'foreign-edit', 'Incoming independent note')
  const model = create(target, requestFor(target, source))
  assert.ok(model.state.retired.some(row => row.table === 'entries' && row.id === id(60)))
  assert.equal(model.state.world.entries.some(row => row.id === id(60)), false)
  assert.deepEqual(model.state.identities, target.state.identities); assert.deepEqual(read(model), model)
})

test('getters in input, policy and limits are rejected without executing caller code', () => {
  const { target, request, model } = incoming(); let calls = 0
  const trapped = structuredClone(model)
  Object.defineProperty(trapped, 'baseArchive', { enumerable: true, get() { calls++; return target } })
  const policy = { get allowDefinitionWrites() { calls++; return true } }
  const limits = { get maxDepth() { calls++; return 64 } }
  refuses(() => read(trapped)); refuses(() => index(trapped)); refuses(() => create(target, request, policy))
  refuses(() => read(model, policy)); refuses(() => index(model, {}, limits)); assert.equal(calls, 0)
})

test('an inherited array map getter is never invoked by preflight or copying', () => {
  const { model } = incoming(); let calls = 0
  const forged = structuredClone(model), prototype = Object.create(Array.prototype)
  Object.defineProperty(prototype, 'map', { get() { calls++; return Array.prototype.map } })
  Object.setPrototypeOf(forged.commands, prototype)
  refuses(() => read(forged)); refuses(() => index(forged)); assert.equal(calls, 0)
})

test('cyclic and non-JSON values fail before recursive semantic replay', () => {
  const { target, request, model } = incoming(), cyclic = structuredClone(model); cyclic.baseArchive.loop = cyclic
  refuses(() => read(cyclic)); refuses(() => index(cyclic))
  const policy = {}; policy.self = policy; refuses(() => create(target, request, policy))
  for (const value of [undefined, BigInt(1), NaN, Infinity, () => {}, new Date(), Symbol('invalid')]) {
    const invalid = structuredClone(model); invalid.injected = value; refuses(() => read(invalid))
  }
  const hidden = structuredClone(model); Object.defineProperty(hidden, 'hidden', { value: true })
  refuses(() => read(hidden))
})

test('deep caller JSON is bounded before validation or freeze can overflow the stack', () => {
  const { model } = incoming(), deep = {}; let cursor = deep
  for (let n = 0; n < 2000; n++) { cursor.next = {}; cursor = cursor.next }
  const forged = structuredClone(model); forged.injected = deep
  refuses(() => read(forged)); refuses(() => read(model, deep)); refuses(() => index(forged))
})

test('JSON depth, node and byte limits apply to input and policy together and can only tighten', () => {
  const { model } = incoming()
  for (const limits of [{ maxDepth: 1 }, { maxNodes: 1 }, { maxBytes: 1 }]) {
    refuses(() => read(model, {}, limits)); refuses(() => index(model, {}, limits))
  }
  for (const limits of [{ maxDepth: 65 }, { maxNodes: 500001 }, { maxBytes: 128 * 1024 * 1024 + 1 },
    { maxArchives: 129 }, { maxAncestry: 9 }, { maxDepth: Infinity }, { maxNodes: -1 }, { maxBytes: 1.5 }, { unexpected: 1 }]) {
    refuses(() => read(model, {}, limits)); refuses(() => index(model, {}, limits))
  }
  const policy = { diagnosticPadding: 'Synthetic policy padding'.repeat(200) }
  const modelBytes = Buffer.byteLength(JSON.stringify(model), 'utf8')
  refuses(() => read(model, policy, { maxBytes: modelBytes + 1 }))
  assert.deepEqual(read(model, {}, { maxDepth: 64, maxNodes: 500000, maxBytes: 128 * 1024 * 1024, maxArchives: 128, maxAncestry: 8 }), model)
})

test('the combined UTF8 byte ceiling includes policy bytes and permits the exact boundary', () => {
  const [target, source] = siblings(); edit(source, 'unicode', 'Synthetic 中文 🧭 note')
  const model = create(target, requestFor(target, source))
  const bytes = Buffer.byteLength(JSON.stringify(model), 'utf8') + Buffer.byteLength(JSON.stringify({}), 'utf8')
  assert.deepEqual(read(model, {}, { maxBytes: bytes }), model)
  assert.equal(index(model, {}, { maxBytes: bytes }).modelDigest, model.modelDigest)
  refuses(() => read(model, {}, { maxBytes: bytes - 1 })); refuses(() => index(model, {}, { maxBytes: bytes - 1 }))
})

test('exact JSON value node and depth boundaries count aliases by serialized occurrence', () => {
  const { model } = incoming(), policy = {}, stack = [[model, 0], [policy, 0]]
  let nodes = 0, depth = 0
  // Each JSON value occurrence is charged, including containers, primitives and
  // both roots; sharing an in-memory ancestor is not a serialization discount.
  while (stack.length) {
    const [value, level] = stack.pop(); nodes++; depth = Math.max(depth, level)
    if (value !== null && typeof value === 'object') {
      for (const child of Object.values(value)) stack.push([child, level + 1])
    }
  }
  assert.deepEqual(read(model, policy, { maxNodes: nodes, maxDepth: depth }), model)
  assert.equal(index(model, policy, { maxNodes: nodes, maxDepth: depth }).modelDigest, model.modelDigest)
  refuses(() => read(model, policy, { maxNodes: nodes - 1 })); refuses(() => index(model, policy, { maxNodes: nodes - 1 }))
  refuses(() => read(model, policy, { maxDepth: depth - 1 })); refuses(() => index(model, policy, { maxDepth: depth - 1 }))
})

test('pending child values consume the node quota before deeper descriptors are inspected', () => {
  const value = Array(20).fill(0), nested = {}; let calls = 0
  for (let n = 0; n < 19; n++) nested['synthetic-' + n] = 0
  Object.defineProperty(nested, 'trapped', { enumerable: true, get() { calls++; return 0 } })
  value[19] = nested
  // Two roots plus the twenty scheduled array values use 22 nodes. Scheduling
  // the nested twenty exceeds 25 before its accessor descriptor is processed.
  assert.throws(() => read(value, {}, { maxNodes: 25 }), error => error.code === 'E_BRANCH_MERGE_ARCHIVE_NODES')
  assert.equal(calls, 0)
})

test('archive budget counts distinct complete archives while shared ancestors fold deterministically', () => {
  const { model } = incoming()
  assert.equal(index(model, {}, { maxArchives: 3 }).archives.length, 3)
  assert.deepEqual(read(model, {}, { maxArchives: 3 }), model)
  refuses(() => read(model, {}, { maxArchives: 2 })); refuses(() => index(model, {}, { maxArchives: 2 }))
})

test('ancestry limits cover both target and incoming chains, not just the outer envelope', () => {
  let base = parent()
  for (let n = 0; n < 2; n++) base = branch(base, 'ancestor-' + n)
  const [target, source] = siblings(base); edit(source, 'incoming', 'Synthetic nested incoming')
  const model = create(target, requestFor(target, source))
  assert.deepEqual(read(model, {}, { maxAncestry: 3 }), model)
  refuses(() => read(model, {}, { maxAncestry: 2 })); refuses(() => index(model, {}, { maxAncestry: 2 }))
  const common = parent(), shallow = branch(common, 'shallow')
  const nested = branch(branch(branch(common, 'source-ancestor-0'), 'source-ancestor-1'), 'nested-source')
  edit(nested, 'foreign', 'Only the incoming ancestry is deep')
  const incomingDeep = create(shallow, requestFor(shallow, nested))
  assert.deepEqual(read(incomingDeep, {}, { maxAncestry: 3 }), incomingDeep)
  refuses(() => read(incomingDeep, {}, { maxAncestry: 2 }))
})
