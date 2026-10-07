import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seed } from './world-store-repository.fixture.mjs'
import { readLegacyRepositoryArchive } from './world-store-legacy-archive.mjs'
import { branchSourceReference, previewRepositoryArchive, readRepositoryArchive } from './world-store-branch-snapshot.mjs'
function fixture() {
  return { format: 'starmap.world-repository-legacy', formatVersion: 1, coverage: 'baselineOnly', editBodies: 'unavailable',
    state: { format: 'starmap.world-repository', formatVersion: 1, revision: 0, world: structuredClone(seed().world), identities: { format: 'starmap.v2-store-identities', version: 1, identities: [] }, proposals: [], retired: [] }, receipts: [] }
}
function withReceipts() {
  const value = fixture(); value.state.revision = 2; value.state.world.revision = 1
  value.receipts = ['old-a', 'old-b'].map((operationId, i) => ({ status: 'committed', operationId, requestDigest: 'a'.repeat(64), repositoryRevision: i + 1, worldRevision: 1 }))
  return value
}
test('legacy archive preserves state and receipts as immutable unknown-identity evidence', () => {
  const value = withReceipts(), before = structuredClone(value), result = readLegacyRepositoryArchive(value)
  assert.deepEqual(result, before); assert.deepEqual(value, before); assert.ok(Object.isFrozen(result.receipts[0]))
  assert.deepEqual(readRepositoryArchive(value), result)
  assert.equal(branchSourceReference(result).identityStatus, 'unknown')
  assert.equal(branchSourceReference(result).identity, null)
  assert.equal(previewRepositoryArchive(value).format, 'starmap.repository-upgrade-branch-preview')
})
test('empty receipts are valid for an untouched repository with pre-existing world revision', () => {
  const value = fixture(); value.state.world.revision = 3
  assert.equal(readLegacyRepositoryArchive(value).state.world.revision, 3)
})
const invalid = [
  ['future version', v => { v.formatVersion = 2 }],
  ['pretended full history', v => { v.coverage = 'complete' }],
  ['invented edit bodies', v => { v.editBodies = 'available' }],
  ['invented permanent identity', v => { v.identity = { libraryId: 'label' } }],
  ['missing receipt', v => { v.receipts.pop() }],
  ['duplicate operation', v => { v.receipts[1].operationId = v.receipts[0].operationId }],
  ['revision gap', v => { v.receipts[1].repositoryRevision = 3 }],
  ['bad request fingerprint', v => { v.receipts[0].requestDigest = 'bad' }],
  ['uncommitted receipt', v => { v.receipts[0].status = 'pending' }],
  ['unsafe revision', v => { v.receipts[0].worldRevision = Number.MAX_SAFE_INTEGER + 1 }],
  ['decreasing world revision', v => { v.receipts[1].worldRevision = 0 }],
  ['terminal world mismatch', v => { v.state.world.revision = 2 }],
  ['extra old body', v => { v.receipts[0].request = {} }],
]
for (const [name, mutate] of invalid) test('reject ' + name, () => {
  const value = withReceipts(); mutate(value); assert.throws(() => readLegacyRepositoryArchive(value))
})
test('getter and sparse receipt arrays are rejected without execution', () => {
  const value = fixture(); let calls = 0
  Object.defineProperty(value, 'state', { enumerable: true, get() { calls++; return {} } })
  assert.throws(() => readLegacyRepositoryArchive(value)); assert.equal(calls, 0)
  const sparse = fixture(); sparse.receipts = new Array(1)
  assert.throws(() => readLegacyRepositoryArchive(sparse))
})
