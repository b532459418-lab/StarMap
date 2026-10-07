import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seed, entry, id, candidate, NOW } from './world-store-repository.fixture.mjs'
import { readRepositoryState, transitionRepositoryState } from './world-store-repository.mjs'
import { repositoryStateDigest as digest } from './world-store-repository-v2-contract.mjs'
import { previewRepositoryArchive } from './world-store-branch-snapshot.mjs'
import { previewRepositoryBranchHistory as preview } from './world-store-branch-history-preview.mjs'
import { createRepositoryBranchMergePlan as plan, assertRepositoryBranchMergePlanCurrent as current } from './world-store-branch-merge-plan.mjs'

function parent(name = 'parent', family = 'family') {
  const state = readRepositoryState({ format: 'starmap.world-repository', formatVersion: 1, revision: 0, world: seed().world,
    identities: { format: 'starmap.v2-store-identities', version: 1, identities: [] }, proposals: [], retired: [] })
  return { format: 'starmap.world-repository-v2', formatVersion: 2, identity: { libraryId: family, branchId: name, genesisId: name + '-initial' },
    baseline: { sourceVersion: 1, sourceDigest: digest(state), coverage: 'baselineOnly', state, receipts: [] }, history: [], state }
}
function branch(source, name) {
  const fork = previewRepositoryArchive(source), binding = { hostId: 'synthetic', locationDigest: 'a'.repeat(64) }
  const descriptor = { format: 'starmap.repository-branch', formatVersion: 1, identity: { libraryId: source.identity.libraryId, branchId: name, genesisId: name + '-initial' }, origin: { kind: 'fork', source: fork.source }, binding }
  const creation = { status: 'completed', operationId: 'create-' + name, requestDigest: digest({ operationId: 'create-' + name, previewDigest: fork.previewDigest, binding }), previewDigest: fork.previewDigest, policyDigest: digest({}) }
  return { format: 'starmap.world-repository-branch', formatVersion: 3, descriptor, sourceArchive: source, creation, markerDigest: digest({ format: 'starmap.repository-branch-location', formatVersion: 1, descriptor, creation }), state: source.state, history: [] }
}
function append(value, name, action, identities) {
  const before = value.state, request = { id: name, expectedRevision: before.revision, action, ...(identities ? { identities } : {}) }
  const after = transitionRepositoryState(before, request)
  value.history.push({ operationId: name, request, requestDigest: digest(request), beforeDigest: digest(before), afterDigest: digest(after), after,
    receipt: { status: 'committed', operationId: name, repositoryRevision: after.revision, worldRevision: after.world.revision, ...(value.formatVersion === 3 ? { identity: value.descriptor.identity } : {}) } })
  value.state = after; return value
}
const edit = (value, note) => { const row = value.state.world.entries[0]; return append(value, 'edit', { kind: 'commands', commands: [{ op: 'update', table: 'entries', id: row.id, expectedRevision: row.revision, value: { ...row, revision: row.revision + 1, fields: { ...row.fields, note } } }] }) }
const siblings = () => { const base = parent(); return [branch(base, 'target'), branch(base, 'source')] }
const choice = (value, item, selected = 'source') => ({ itemId: value.items.find(item).itemId, choice: selected })
const refuses = (fn, code) => assert.throws(fn, error => error.code === code)

test('all differing rows require explicit choices; immutable decisions never authorize writing', () => {
  const [a, b] = siblings(); edit(a, 'a'); edit(b, 'b')
  const report = preview(a, b), before = structuredClone([a, b, report]), p = plan(report, a, b)
  assert.equal(p.status, 'incomplete'); assert.equal(p.pending.length, 2); assert.equal(p.decisions[0].explicit, false)
  assert.equal(p.executable, false); assert.equal(p.combinedStateValidated, false); assert.deepEqual(p.commands, [])
  assert.ok(Object.isFrozen(p.items[0])); assert.deepEqual([a, b, report], before)
  const selected = plan(report, a, b, [choice(p, item => item.domain === 'record'), choice(p, item => item.domain === 'archive')])
  assert.equal(selected.status, 'decided'); assert.equal(selected.decisionsComplete, true)
  assert.deepEqual(current(selected, report, a, b), selected)
})
test('explicit deferral remains pending; choices normalize by catalogue rather than submitted order', () => {
  const [a, b] = siblings(); append(b, 'add', { kind: 'commands', commands: [60, 61].map(n => ({ op: 'create', table: 'entries', value: entry(n) })) })
  const report = preview(a, b), p = plan(report, a, b), choices = p.items.map(item => ({ itemId: item.itemId, choice: 'target' }))
  assert.deepEqual(plan(report, a, b, choices), plan(report, a, b, [...choices].reverse()))
  const deferred = plan(report, a, b, [{ ...choices[0], choice: 'defer' }])
  assert.equal(deferred.status, 'incomplete'); assert.equal(deferred.pending.length, 3); assert.equal(deferred.decisions[0].explicit, true)
})
test('unknown, duplicate, extra-field and illegal choices are refused', () => {
  const [a, b] = siblings(); edit(b, 'b'); const report = preview(a, b), p = plan(report, a, b), c = choice(p, () => true)
  refuses(() => plan(report, a, b, [{ itemId: 'unknown', choice: 'target' }]), 'E_BRANCH_MERGE_CHOICE_ID')
  refuses(() => plan(report, a, b, [c, c]), 'E_BRANCH_MERGE_CHOICE_ID')
  refuses(() => plan(report, a, b, [{ ...c, choice: 'overwrite' }]), 'E_BRANCH_MERGE_CHOICE_FORBIDDEN')
  refuses(() => plan(report, a, b, [{ ...c, value: {} }]), 'E_SHAPE')
})
test('foreign absence alone cannot delete a retained local record', () => {
  const [a, b] = siblings(); append(a, 'add', { kind: 'commands', commands: [{ op: 'create', table: 'entries', value: entry(60) }] })
  const report = preview(a, b), p = plan(report, a, b), item = p.items.find(row => row.id === id(60))
  assert.equal(item.sourceBlockedReason, 'source-absence-is-not-deletion')
  refuses(() => plan(report, a, b, [{ itemId: item.itemId, choice: 'source' }]), 'E_BRANCH_MERGE_CHOICE_FORBIDDEN')
})
test('an explicit source tombstone permits a deletion decision without applying it', () => {
  const base = append(parent(), 'add', { kind: 'commands', commands: [{ op: 'create', table: 'entries', value: entry(60) }] })
  const a = branch(base, 'a'), b = branch(base, 'b'); append(b, 'remove', { kind: 'commands', commands: [{ op: 'remove', table: 'entries', id: id(60), expectedRevision: 0 }] })
  const report = preview(a, b), p = plan(report, a, b), selected = plan(report, a, b, [choice(p, item => item.id === id(60)), choice(p, item => item.domain === 'archive')])
  assert.equal(selected.status, 'decided'); assert.equal(selected.items[0].source.retired, true)
  assert.ok(a.state.world.entries.some(row => row.id === id(60)))
})
test('target tombstones remain permanent and cannot be explicitly resurrected', () => {
  const base = append(parent(), 'add', { kind: 'commands', commands: [{ op: 'create', table: 'entries', value: entry(60) }] })
  const a = branch(base, 'a'), b = branch(base, 'b'); append(a, 'remove', { kind: 'commands', commands: [{ op: 'remove', table: 'entries', id: id(60), expectedRevision: 0 }] })
  const report = preview(a, b), p = plan(report, a, b)
  assert.equal(p.items[0].sourceBlockedReason, 'target-tombstone-is-permanent')
  refuses(() => plan(report, a, b, [choice(p, () => true)]), 'E_BRANCH_MERGE_CHOICE_FORBIDDEN')
})
test('absent identity allocations are preserved and cannot be removed/reused', () => {
  const [a, b] = siblings(); append(a, 'ledger', { kind: 'stage-proposal', proposal: candidate() }, [{ kind: 'entry', sourceId: 'test:manual', recordId: 'dead', id: id(60) }])
  append(b, 'ledger', { kind: 'stage-proposal', proposal: candidate() }, [{ kind: 'entry', sourceId: 'test:manual', recordId: 'different', id: id(60) }])
  const report = preview(a, b), p = plan(report, a, b), items = p.items.filter(row => row.domain === 'identity')
  assert.equal(items.length, 2)
  assert.equal(p.status, 'blocked'); assert.ok(p.blockingConflicts.some(row => row.kind === 'identity-id'))
  for (const item of items) { assert.equal(item.sourceBlockedReason, 'allocated-identity-is-permanent'); refuses(() => plan(report, a, b, [{ itemId: item.itemId, choice: 'source' }]), 'E_BRANCH_MERGE_CHOICE_FORBIDDEN') }
})
test('accepted local proposal status and local review receipts cannot be replaced', () => {
  const [a, b] = siblings()
  for (const value of [a, b]) append(value, 'stage', { kind: 'stage-proposal', proposal: candidate() })
  append(a, 'accept', { kind: 'accept-proposal', proposalId: candidate().id, decision: { reviewId: 'review', acceptedAt: NOW } })
  const report = preview(a, b), p = plan(report, a, b)
  assert.equal(p.items.find(row => row.domain === 'proposal').sourceBlockedReason, 'accepted-proposal-is-permanent')
  refuses(() => plan(report, a, b, [choice(p, row => row.domain === 'proposal')]), 'E_BRANCH_MERGE_CHOICE_FORBIDDEN')
  append(b, 'accept', { kind: 'accept-proposal', proposalId: candidate().id, decision: { reviewId: 'review', acceptedAt: '2026-10-05T00:00:01.000Z' } })
  const changedReport = preview(a, b), changed = plan(changedReport, a, b)
  assert.equal(changed.items.find(row => row.table === 'reviews').sourceBlockedReason, 'local-review-is-immutable')
})
test('branch/operation namespace conflicts cannot be erased by keeping all target rows', () => {
  const a = edit(parent(), 'a'), b = edit(parent(), 'b'), report = preview(a, b), p = plan(report, a, b)
  const selected = plan(report, a, b, p.items.map(row => ({ itemId: row.itemId, choice: 'target' })))
  assert.equal(selected.status, 'blocked'); assert.ok(selected.blockingConflicts.some(row => row.kind === 'operation-identity'))
})
test('unrelated families or unknown history remain blocked; exact legacy no-op remains allowed', () => {
  const a = parent('a'), b = parent('b'), p = plan(preview(a, b), a, b)
  assert.equal(p.status, 'blocked'); assert.deepEqual(p.blockingReasons, ['unproven-common-history'])
  const foreign = parent('b', 'other'); assert.equal(plan(preview(a, foreign), a, foreign).status, 'blocked')
  const legacy = { format: 'starmap.world-repository-legacy', formatVersion: 1, coverage: 'baselineOnly', editBodies: 'unavailable', state: a.state, receipts: [] }
  assert.equal(plan(preview(legacy, legacy), legacy, legacy).status, 'decided')
  assert.equal(plan(preview(a, legacy), a, legacy).status, 'blocked')
  assert.equal(plan(preview(a, a), a, a).status, 'decided')
})
test('whole plans, snapshots, policies and previews are bound, including source-only historical changes', () => {
  const [a, b] = siblings(); edit(b, 'b'); const report = preview(a, b), p = plan(report, a, b, [])
  const changed = structuredClone(p); changed.executable = true
  refuses(() => current(changed, report, a, b), 'E_BRANCH_MERGE_PLAN_STALE')
  const tampered = structuredClone(p); tampered.decisions[0].explicit = true
  refuses(() => current(tampered, report, a, b), 'E_BRANCH_MERGE_PLAN_STALE')
  const changedSource = structuredClone(b); edit(changedSource, 'second')
  // A second operation needs a distinct operation ID.
  changedSource.history.at(-1).operationId = 'edit-two'; changedSource.history.at(-1).request.id = 'edit-two'
  changedSource.history.at(-1).requestDigest = digest(changedSource.history.at(-1).request); changedSource.history.at(-1).receipt.operationId = 'edit-two'
  refuses(() => current(p, report, a, changedSource), 'E_BRANCH_HISTORY_PREVIEW_STALE')
  refuses(() => current(p, report, a, b, { allowDefinitionWrites: true }), 'E_BRANCH_CORRUPT')
  const v2a = parent(), v2b = edit(parent(), 'b'), v2report = preview(v2a, v2b), v2plan = plan(v2report, v2a, v2b)
  refuses(() => current(v2plan, v2report, v2a, v2b, { allowDefinitionWrites: true }), 'E_BRANCH_HISTORY_PREVIEW_STALE')
})
test('JSON getters/cycles/malformed rows cannot execute code or bypass decisions', () => {
  const [a, b] = siblings(); edit(b, 'b'); const report = preview(a, b); let calls = 0
  const trap = { get choice() { calls++; return 'source' } }
  refuses(() => plan(report, a, b, [trap]), 'E_JSON')
  const cycle = []; cycle.push(cycle); refuses(() => plan(report, a, b, cycle), 'E_JSON_CYCLE')
  const policy = { get allowDefinitionWrites() { calls++; return true } }; refuses(() => plan(report, a, b, [], policy), 'E_JSON')
  assert.equal(calls, 0)
})
