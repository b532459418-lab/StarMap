import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seed } from './world-store-repository.fixture.mjs'
import { readRepositoryV2, repositoryStateDigest as hash } from './world-store-repository-v2-contract.mjs'

function fixture() {
  const initial = seed()
  const state = { format: 'starmap.world-repository', formatVersion: 1, revision: 0,
    world: initial.world, identities: initial.identities ?? { format: 'starmap.v2-store-identities', version: 1, identities: [] }, proposals: [], retired: [] }
  return { format: 'starmap.world-repository-v2', formatVersion: 2,
    identity: { libraryId: 'library', branchId: 'branch', genesisId: 'genesis' },
    baseline: { sourceVersion: 1, sourceDigest: hash(state), coverage: 'baselineOnly', state: structuredClone(state), receipts: [] }, history: [], state }
}
function append(value, id = 'save-1') {
  const before = value.state, after = { ...structuredClone(before), revision: before.revision + 1 }
  const request = { id, expectedRevision: before.revision, action: { kind: 'commands', commands: [] } }
  value.history.push({ operationId: id, request, requestDigest: hash(request), beforeDigest: hash(before), afterDigest: hash(after), after,
    receipt: { status: 'committed', operationId: id, repositoryRevision: after.revision, worldRevision: after.world.revision } })
  value.state = structuredClone(after)
  return value
}
test('baseline and complete snapshot chain validate without mutating input', () => {
  const value = append(append(fixture()), 'save-2'), original = structuredClone(value)
  const result = readRepositoryV2(value)
  assert.deepEqual(result, original); assert.deepEqual(value, original)
  assert.ok(Object.isFrozen(result.history[0].after.world))
  value.identity.branchId = 'changed'; assert.equal(result.identity.branchId, 'branch')
})
test('empty new history keeps explicit legacy coverage', () => {
  assert.equal(readRepositoryV2(fixture()).baseline.coverage, 'baselineOnly')
})
const cases = [
  ['unknown version', v => { v.formatVersion = 3 }],
  ['missing permanent identity', v => { delete v.identity.branchId }],
  ['unknown identity field', v => { v.identity.path = 'path' }],
  ['invented legacy coverage', v => { v.baseline.coverage = 'complete' }],
  ['invalid source digest', v => { v.baseline.sourceDigest = 'x' }],
  ['wrong source snapshot', v => { v.baseline.sourceDigest = '0'.repeat(64) }],
  ['missing legacy receipts', v => { v.baseline.state.revision = 1; v.baseline.sourceDigest = hash(v.baseline.state) }],
  ['request mismatch', v => { v.history[0].request.id = 'other' }],
  ['stale request', v => { v.history[0].request.expectedRevision = 4 }],
  ['unsupported action', v => { v.history[0].request.action.kind = 'unknown' }],
  ['request tampering', v => { v.history[0].request.action.commands.push({ x: 1 }) }],
  ['broken parent', v => { v.history[0].beforeDigest = '0'.repeat(64) }],
  ['broken after', v => { v.history[0].afterDigest = '0'.repeat(64) }],
  ['revision gap', v => { v.history[0].after.revision = 3; v.history[0].afterDigest = hash(v.history[0].after) }],
  ['receipt mismatch', v => { v.history[0].receipt.repositoryRevision = 3 }],
  ['duplicate operation', v => { append(v) }],
  ['missing history', v => { v.history = [] }],
  ['reordered history', v => { append(v, 'save-2'); v.history.reverse() }],
  ['terminal snapshot mismatch', v => { v.state.revision = 0 }],
]
for (const [name, change] of cases) test(`reject ${name}`, () => {
  const value = append(fixture()); change(value)
  assert.throws(() => readRepositoryV2(value))
})
test('accessor rejected without execution', () => {
  const value = fixture(); let calls = 0
  Object.defineProperty(value, 'identity', { enumerable: true, get() { calls++; return {} } })
  assert.throws(() => readRepositoryV2(value), e => e.code === 'E_JSON')
  assert.equal(calls, 0)
})
