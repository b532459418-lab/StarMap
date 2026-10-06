import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seed } from './world-store-repository.fixture.mjs'
import { transitionRepositoryState } from './world-store-repository.mjs'
import { repositoryStateDigest as digest } from './world-store-repository-v2-contract.mjs'
import { branchSourceReference, readBranchSnapshot, readRepositoryArchive, previewRepositoryArchive, MAX_BRANCH_ANCESTRY } from './world-store-branch-snapshot.mjs'

function parent() {
  const state = { format: 'starmap.world-repository', formatVersion: 1, revision: 0, world: seed().world,
    identities: { format: 'starmap.v2-store-identities', version: 1, identities: [] }, proposals: [], retired: [] }
  return { format: 'starmap.world-repository-v2', formatVersion: 2, identity: { libraryId: 'family', branchId: 'parent', genesisId: 'original' },
    baseline: { sourceVersion: 1, sourceDigest: digest(state), coverage: 'baselineOnly', state, receipts: [] }, history: [], state }
}
function branch(sourceArchive = parent(), name = 'child') {
  const source = branchSourceReference(sourceArchive)
  const raw = { format: 'starmap.repository-fork-preview', formatVersion: 1, source, archive: sourceArchive, policyDigest: digest({}) }
  const previewDigest = digest(raw), binding = { hostId: 'synthetic-host', locationDigest: 'a'.repeat(64) }
  const descriptor = { format: 'starmap.repository-branch', formatVersion: 1, identity: { libraryId: 'family', branchId: name, genesisId: name + '-creation' }, origin: { kind: 'fork', source }, binding }
  const creation = { status: 'completed', operationId: 'fork-' + name, requestDigest: digest({ operationId: 'fork-' + name, previewDigest, binding }), previewDigest, policyDigest: digest({}) }
  return { format: 'starmap.world-repository-branch', formatVersion: 3, descriptor, sourceArchive, creation,
    markerDigest: digest({ format: 'starmap.repository-branch-location', formatVersion: 1, descriptor, creation }), state: structuredClone(sourceArchive.state), history: [] }
}
function append(value, name = 'save') {
  const state = value.state, before = state.world.entries[0]
  const request = { id: name, expectedRevision: state.revision, action: { kind: 'commands', commands: [{ op: 'update', table: 'entries', id: before.id, expectedRevision: before.revision,
    value: { ...before, revision: before.revision + 1, fields: { ...before.fields, note: name } } }] } }
  const after = transitionRepositoryState(state, request)
  value.history.push({ operationId: name, request, requestDigest: digest(request), beforeDigest: digest(state), afterDigest: digest(after), after,
    receipt: { status: 'committed', identity: value.descriptor.identity, operationId: name, repositoryRevision: after.revision, worldRevision: after.world.revision } })
  value.state = structuredClone(after)
  return value
}
test('pure v3 snapshot validates real transitions without mutating input', () => {
  const value = append(branch()), before = structuredClone(value), result = readBranchSnapshot(value)
  assert.deepEqual(result, before); assert.deepEqual(value, before); assert.ok(Object.isFrozen(result.history[0].after))
  assert.equal(result.state.world.entries[0].fields.note, 'save')
})
test('nested branch retains full parent history, separate identities and exact state baseline', () => {
  const original = append(branch()), child = append(branch(original, 'grandchild'), 'child-save')
  const result = readRepositoryArchive(child)
  assert.deepEqual(result.sourceArchive, original)
  assert.equal(result.history.length, 1); assert.equal(result.sourceArchive.history.length, 1)
  const preview = previewRepositoryArchive(result)
  assert.equal(preview.source.repositoryFormatVersion, 3)
  assert.deepEqual(preview.source.identity, child.descriptor.identity)
})
const invalid = [
  ['missing ancestor', value => { value.sourceArchive = null }],
  ['unknown ancestor version', value => { value.sourceArchive.formatVersion = 99 }],
  ['wrong parent state', value => { value.sourceArchive.state.revision++ }],
  ['wrong creation', value => { value.creation.requestDigest = 'b'.repeat(64) }],
  ['unbound marker', value => { value.markerDigest = 'b'.repeat(64) }],
  ['invented parent identity', value => { value.descriptor.origin.source.identity.branchId = 'other' }],
  ['history omitted', value => { value.history = [] }],
  ['request tampering', value => { value.history[0].request.action.commands[0].value.fields.note = 'changed' }],
  ['false after state', value => { value.history[0].after.world.entries[0].fields.note = 'changed' }],
  ['bad receipt namespace', value => { value.history[0].receipt.identity = value.sourceArchive.identity }],
  ['duplicate local operation', value => { value.history.push(structuredClone(value.history[0])) }],
  ['outcome tampering', value => { value.state.revision++ }],
]
for (const [name, mutate] of invalid) test('reject ' + name, () => {
  const value = structuredClone(append(branch())); mutate(value)
  assert.throws(() => readBranchSnapshot(value))
})
test('supported ancestry has an explicit maximum rather than claiming an arbitrary chain', () => {
  let value = parent()
  for (let i = 0; i < MAX_BRANCH_ANCESTRY; i++) value = branch(value, 'generation-' + i)
  assert.equal(readBranchSnapshot(value).formatVersion, 3)
  value = branch(value, 'too-deep')
  assert.throws(() => readBranchSnapshot(value), e => e.code === 'E_BRANCH_ANCESTRY_LIMIT')
})
test('restore package fingerprint and request ID are included in creation proof', () => {
  const value = branch(), context = { kind: 'backup-restore', requestId: 'restore', packageDigest: 'c'.repeat(64) }
  value.creation.context = context
  value.creation.requestDigest = digest({ operationId: value.creation.operationId, previewDigest: value.creation.previewDigest, binding: value.descriptor.binding, context })
  value.markerDigest = digest({ format: 'starmap.repository-branch-location', formatVersion: 1, descriptor: value.descriptor, creation: value.creation })
  assert.deepEqual(readBranchSnapshot(value).creation.context, context)
  value.creation.context.packageDigest = 'd'.repeat(64)
  assert.throws(() => readBranchSnapshot(value))
})
test('accessor/cycle/primitive archives are refused without executing accessor', () => {
  let calls = 0; const value = branch()
  Object.defineProperty(value, 'sourceArchive', { enumerable: true, get() { calls++; return parent() } })
  assert.throws(() => readRepositoryArchive(value)); assert.equal(calls, 0)
  for (const invalid of [null, 'archive', 3, []]) assert.throws(() => readRepositoryArchive(invalid))
})
