import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readBranchDescriptor, assertBranchSource, assertBranchWriteBinding, operationIdentityKey, readBranchOperationManifest } from './world-store-branch-contract.mjs'
import { readRepositoryV2 } from './world-store-repository-v2-contract.mjs'

const hash = digit => digit.repeat(64)
const parent = () => ({ libraryId: 'family', branchId: 'parent', genesisId: 'parent-creation' })
const child = () => ({ libraryId: 'family', branchId: 'child', genesisId: 'child-creation' })
const source = () => ({ repositoryFormatVersion: 2, identityStatus: 'known', identity: parent(), snapshotDigest: hash('a'), repositoryRevision: 7, archiveDigest: hash('b') })
const fixture = () => ({ format: 'starmap.repository-branch', formatVersion: 1, identity: child(), origin: { kind: 'fork', source: source() }, binding: { hostId: 'host', locationDigest: hash('c') } })
const legacy = () => ({ ...source(), repositoryFormatVersion: 1, identityStatus: 'unknown', identity: null })
const row = (identity = child(), operationId = 'save', requestDigest = hash('d')) => ({ identity, operationId, requestDigest })
const rejects = (fn, code) => assert.throws(fn, error => error.code === code)

test('known fork retains family, exact source revision and separate branch creation', () => {
  const input = fixture(), copy = structuredClone(input)
  const result = readBranchDescriptor(input)
  assert.deepEqual(input, copy); assert.deepEqual(result, copy)
  assert.ok(Object.isFrozen(result.origin.source.identity))
  input.identity.branchId = 'changed'
  assert.equal(result.identity.branchId, 'child')
})
test('new library has no invented parent source', () => {
  const value = fixture(); value.origin = { kind: 'new', source: null }
  assert.deepEqual(readBranchDescriptor(value).origin, value.origin)
})
test('v3 parent is explicit rather than disguised as legacy or v2', () => {
  const value = fixture(); value.origin.source.repositoryFormatVersion = 3
  assert.equal(readBranchDescriptor(value).origin.source.repositoryFormatVersion, 3)
  assertBranchSource(value, value.origin.source)
})
test('legacy upgrade preserves unknown source identity without inventing a family link', () => {
  const value = fixture(); value.origin = { kind: 'upgrade', source: legacy() }
  value.identity.libraryId = 'new-host-family'
  const result = readBranchDescriptor(value)
  assert.equal(result.origin.source.identity, null)
  assert.equal(result.origin.source.repositoryRevision, 7)
  assertBranchSource(value, legacy())
})
const invalid = [
  ['descriptor version', v => { v.formatVersion = 2 }, 'E_BRANCH_VERSION'],
  ['descriptor format', v => { v.format = 'starmap.world-repository-v2' }, 'E_BRANCH_VERSION'],
  ['missing identity', v => { delete v.identity.genesisId }, 'E_SHAPE'],
  ['blank identity', v => { v.identity.branchId = ' ' }, 'E_ID'],
  ['caller name as identity', v => { v.identity.name = 'label' }, 'E_SHAPE'],
  ['path as identity', v => { v.identity.path = 'copy.sqlite' }, 'E_SHAPE'],
  ['missing binding', v => { delete v.binding }, 'E_SHAPE'],
  ['raw binding path', v => { v.binding.path = '/copy' }, 'E_SHAPE'],
  ['unknown source version', v => { v.origin.source.repositoryFormatVersion = 4 }, 'E_BRANCH_SOURCE_VERSION'],
  ['invented legacy identity', v => { v.origin.source.repositoryFormatVersion = 1 }, 'E_BRANCH_SOURCE_IDENTITY'],
  ['unknown v2 identity', v => { v.origin.source.identityStatus = 'unknown'; v.origin.source.identity = null }, 'E_BRANCH_SOURCE_IDENTITY'],
  ['missing known parent', v => { v.origin.source.identity = null }, 'E_SHAPE'],
  ['cross family fork', v => { v.identity.libraryId = 'other' }, 'E_BRANCH_PARENT'],
  ['same parent branch', v => { v.identity.branchId = 'parent' }, 'E_BRANCH_PARENT'],
  ['same parent creation', v => { v.identity.genesisId = 'parent-creation' }, 'E_BRANCH_PARENT'],
  ['source revision negative', v => { v.origin.source.repositoryRevision = -1 }, 'E_REVISION'],
  ['source revision unsafe', v => { v.origin.source.repositoryRevision = Number.MAX_SAFE_INTEGER + 1 }, 'E_REVISION'],
  ['snapshot digest', v => { v.origin.source.snapshotDigest = 'invalid' }, 'E_BRANCH_DIGEST'],
  ['archive digest missing', v => { delete v.origin.source.archiveDigest }, 'E_SHAPE'],
  ['archive digest uppercase', v => { v.origin.source.archiveDigest = hash('A') }, 'E_BRANCH_DIGEST'],
  ['unknown origin', v => { v.origin.kind = 'move' }, 'E_BRANCH_ORIGIN'],
  ['new with parent', v => { v.origin.kind = 'new' }, 'E_BRANCH_ORIGIN'],
  ['fork without parent', v => { v.origin.source = null }, 'E_SHAPE'],
  ['fork unknown identity', v => { v.origin.source = legacy() }, 'E_BRANCH_ORIGIN'],
  ['upgrade known identity', v => { v.origin.kind = 'upgrade' }, 'E_BRANCH_ORIGIN'],
  ['invented ancestry proof', v => { v.origin.verifiedAncestry = true }, 'E_SHAPE'],
]
for (const [name, mutate, code] of invalid) test('reject ' + name, () => {
  const value = fixture(); mutate(value)
  rejects(() => readBranchDescriptor(value), code)
})
for (const [name, mutate] of [
  ['snapshot', v => { v.snapshotDigest = hash('e') }],
  ['revision', v => { v.repositoryRevision++ }],
  ['archive', v => { v.archiveDigest = hash('e') }],
  ['parent branch', v => { v.identity.branchId = 'other' }],
  ['parent creation', v => { v.identity.genesisId = 'other' }],
  ['parent family', v => { v.identity.libraryId = 'other' }],
]) test('source pin refuses changed ' + name, () => {
  const observed = source(); mutate(observed)
  rejects(() => assertBranchSource(fixture(), observed), 'E_BRANCH_SOURCE_CHANGED')
})
test('source comparison is key-order independent and does not mutate either reference', () => {
  const value = fixture(), observed = Object.fromEntries(Object.entries(source()).reverse())
  const before = structuredClone([value, observed])
  assertBranchSource(value, observed)
  assert.deepEqual([value, observed], before)
})
test('new library cannot claim a matching parent', () => {
  const value = fixture(); value.origin = { kind: 'new', source: null }
  rejects(() => assertBranchSource(value, source()), 'E_BRANCH_SOURCE_CHANGED')
})
test('unknown legacy packages only match the exact source reference', () => {
  const value = fixture(); value.origin = { kind: 'upgrade', source: legacy() }
  const changed = legacy(); changed.snapshotDigest = hash('f')
  rejects(() => assertBranchSource(value, changed), 'E_BRANCH_SOURCE_CHANGED')
})
test('copying metadata does not allow a different host or location binding', () => {
  const value = fixture()
  assertBranchWriteBinding(value, structuredClone(value.binding))
  for (const binding of [{ ...value.binding, hostId: 'another' }, { ...value.binding, locationDigest: hash('f') }]) {
    rejects(() => assertBranchWriteBinding(value, binding), 'E_BRANCH_BINDING')
  }
})
test('operation namespace keeps same named operations separate across families and branches', () => {
  const rows = [row(), row(parent()), row({ ...child(), libraryId: 'another' })]
  assert.equal(readBranchOperationManifest(rows).length, 3)
  assert.equal(new Set(rows.map(r => operationIdentityKey(r.identity, r.operationId))).size, 3)
})
test('operation key avoids delimiter collisions and does not trim opaque IDs', () => {
  assert.notEqual(operationIdentityKey({ ...child(), libraryId: 'a:b', branchId: 'c' }, 'd'), operationIdentityKey({ ...child(), libraryId: 'a', branchId: 'b:c' }, 'd'))
  assert.notEqual(operationIdentityKey(child(), ' save'), operationIdentityKey(child(), 'save'))
})
test('same full operation reference is idempotent, preserves first order and freezes a copy', () => {
  const rows = [row(child(), 'second'), row(child(), 'first'), row(child(), 'second')]
  const result = readBranchOperationManifest(rows, child())
  assert.deepEqual(result.map(r => r.operationId), ['second', 'first'])
  assert.equal(rows.length, 3); assert.ok(Object.isFrozen(result[0].identity))
  rows[0].requestDigest = hash('e'); assert.equal(result[0].requestDigest, hash('d'))
})
test('same namespace with different request content or genesis conflicts', () => {
  rejects(() => readBranchOperationManifest([row(), row(child(), 'save', hash('e'))]), 'E_BRANCH_OPERATION_CONFLICT')
  rejects(() => readBranchOperationManifest([row(), row({ ...child(), genesisId: 'different' })]), 'E_BRANCH_OPERATION_CONFLICT')
})
test('parent archive references cannot enter child local operation discovery', () => {
  rejects(() => readBranchOperationManifest([row(parent())], child()), 'E_BRANCH_FOREIGN_OPERATION')
  rejects(() => readBranchOperationManifest([row({ ...child(), genesisId: 'different' })], child()), 'E_BRANCH_FOREIGN_OPERATION')
  assert.deepEqual(readBranchOperationManifest([], child()), [])
})
test('operation manifests are references, not receipts or writes', () => {
  rejects(() => readBranchOperationManifest([{ ...row(), status: 'committed' }]), 'E_SHAPE')
  rejects(() => readBranchOperationManifest({ operations: [] }), 'E_BRANCH_OPERATIONS')
  rejects(() => readBranchOperationManifest([row(child(), ' ', hash('d'))]), 'E_ID')
  rejects(() => readBranchOperationManifest([row(child(), 'save', 'bad')]), 'E_BRANCH_DIGEST')
})
test('unsupported JSON rejected without running getters', () => {
  let calls = 0
  const value = fixture()
  Object.defineProperty(value.origin.source, 'identity', { enumerable: true, get() { calls++; return parent() } })
  rejects(() => readBranchDescriptor(value), 'E_JSON')
  const operation = row()
  Object.defineProperty(operation, 'requestDigest', { enumerable: true, get() { calls++; return hash('d') } })
  rejects(() => readBranchOperationManifest([operation]), 'E_JSON')
  assert.equal(calls, 0)
})
test('cycles, sparse arrays and inherited fields are rejected', () => {
  const cyclic = fixture(); cyclic.origin.source.identity = cyclic
  rejects(() => readBranchDescriptor(cyclic), 'E_JSON_CYCLE')
  rejects(() => readBranchOperationManifest(new Array(1)), 'E_JSON_ARRAY')
  const inherited = Object.create(child()); inherited.genesisId = 'other'
  rejects(() => operationIdentityKey(inherited, 'save'), 'E_JSON')
})
test('safe diagnostics do not expose input values', () => {
  const value = fixture(); value.identity.branchId = 'sensitive-branch'; value.identity.genesisId = ''
  assert.throws(() => readBranchDescriptor(value), error => error.code === 'E_ID' && !error.message.includes('sensitive-branch'))
})
test('branch descriptor is not accepted as the existing v2 repository envelope', () => {
  assert.throws(() => readRepositoryV2(fixture()))
})
