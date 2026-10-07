import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seed, entry, id, candidate, NOW } from './world-store-repository.fixture.mjs'
import { readRepositoryState, transitionRepositoryState } from './world-store-repository.mjs'
import { repositoryStateDigest as digest } from './world-store-repository-v2-contract.mjs'
import { previewRepositoryArchive } from './world-store-branch-snapshot.mjs'
import { previewRepositoryBranchHistory as preview } from './world-store-branch-history-preview.mjs'
import { createRepositoryBranchMergePlan as plan } from './world-store-branch-merge-plan.mjs'
import { simulateRepositoryBranchMerge as simulate, assertRepositoryBranchMergeSimulationCurrent as current } from './world-store-branch-merge-simulation.mjs'

function parent() {
  const state = readRepositoryState({ format: 'starmap.world-repository', formatVersion: 1, revision: 0, world: seed().world,
    identities: { format: 'starmap.v2-store-identities', version: 1, identities: [] }, proposals: [], retired: [] })
  return { format: 'starmap.world-repository-v2', formatVersion: 2, identity: { libraryId: 'family', branchId: 'parent', genesisId: 'initial' },
    baseline: { sourceVersion: 1, sourceDigest: digest(state), coverage: 'baselineOnly', state, receipts: [] }, history: [], state }
}
function branch(source, name) {
  const fork = previewRepositoryArchive(source), binding = { hostId: 'synthetic', locationDigest: 'a'.repeat(64) }
  const descriptor = { format: 'starmap.repository-branch', formatVersion: 1, identity: { libraryId: 'family', branchId: name, genesisId: name + '-initial' }, origin: { kind: 'fork', source: fork.source }, binding }
  const creation = { status: 'completed', operationId: 'create-' + name, requestDigest: digest({ operationId: 'create-' + name, previewDigest: fork.previewDigest, binding }), previewDigest: fork.previewDigest, policyDigest: digest({}) }
  return { format: 'starmap.world-repository-branch', formatVersion: 3, descriptor, sourceArchive: source, creation, markerDigest: digest({ format: 'starmap.repository-branch-location', formatVersion: 1, descriptor, creation }), state: source.state, history: [] }
}
function append(value, name, action, identities) {
  const before = value.state, request = { id: name, expectedRevision: before.revision, action, ...(identities ? { identities } : {}) }, after = transitionRepositoryState(before, request)
  value.history.push({ operationId: name, request, requestDigest: digest(request), beforeDigest: digest(before), afterDigest: digest(after), after,
    receipt: { status: 'committed', operationId: name, repositoryRevision: after.revision, worldRevision: after.world.revision, ...(value.formatVersion === 3 ? { identity: value.descriptor.identity } : {}) } }); value.state = after; return value
}
const commands = (value, name, values) => append(value, name, { kind: 'commands', commands: values })
const edit = (value, name, note) => { const row = value.state.world.entries[0]; return commands(value, name, [{ op: 'update', table: 'entries', id: row.id, expectedRevision: row.revision, value: { ...row, revision: row.revision + 1, fields: { ...row.fields, note } } }]) }
const siblings = (base = parent()) => [branch(base, 'target'), branch(base, 'source')]
function run(a, b, select = () => 'source') {
  const report = preview(a, b), catalogue = plan(report, a, b)
  const p = plan(report, a, b, catalogue.items.map(row => ({ itemId: row.itemId, choice: select(row) })))
  return simulate(p, report, a, b)
}
const entity = n => ({ ...seed().world.entities[0], id: id(n), source: { ...seed().world.entities[0].source, recordId: 'entity-' + n } })

test('one-sided adoption is a frozen temporary state, not a committed operation or receipt', () => {
  const [a, b] = siblings(); edit(b, 'edit', 'foreign'); const before = structuredClone([a, b]), result = run(a, b)
  assert.equal(result.status, 'validated'); assert.equal(result.combinedStateValidated, true)
  assert.equal(result.candidate.world.entries[0].fields.note, 'foreign'); assert.equal(result.candidate.world.entries[0].revision, 1)
  assert.equal(result.candidate.revision, 1); assert.equal(result.candidate.world.revision, 1)
  assert.equal(result.executable, false); assert.equal(result.persisted, false); assert.deepEqual(result.commands, [])
  assert.equal(result.foreignReceiptsBecomeLocal, false); assert.equal(result.newLocalApprovalIssued, false)
  assert.deepEqual([a, b], before); assert.ok(Object.isFrozen(result.candidate.world.entries[0]))
})
test('competing edits respect explicit target or source selection and advance local clocks only', () => {
  const [a, b] = siblings(); edit(a, 'first', 'local'); edit(a, 'second', 'local-two'); edit(b, 'foreign', 'foreign')
  const adopted = run(a, b); assert.equal(adopted.candidate.world.entries[0].revision, 3)
  assert.equal(adopted.candidate.world.revision, 3); assert.equal(b.state.world.entries[0].revision, 1)
  const kept = run(a, b, () => 'target'); assert.deepEqual(kept.candidate, a.state); assert.deepEqual(kept.adopted, [])
})
test('missing or explicitly deferred choices do not claim complete combined validation', () => {
  const [a, b] = siblings(); edit(b, 'foreign', 'foreign'); const report = preview(a, b), p = plan(report, a, b)
  const result = simulate(p, report, a, b)
  assert.equal(result.status, 'incomplete'); assert.equal(result.stateValidation.valid, true)
  assert.equal(result.combinedStateValidated, false); assert.deepEqual(result.candidate, a.state)
  assert.equal(run(a, b, () => 'defer').decisionsComplete, false)
})
test('identity/history namespace blockers persist even if candidate facts validate', () => {
  const a = edit(parent(), 'same', 'a'), b = edit(parent(), 'same', 'b'), result = run(a, b, () => 'target')
  assert.equal(result.status, 'blocked'); assert.equal(result.stateValidation.valid, true)
  assert.equal(result.combinedStateValidated, false)
})
test('both individually valid archives can form a dangling-reference combination', () => {
  const [a, b] = siblings(); commands(b, 'add', [{ op: 'create', table: 'entities', value: entity(80) }, { op: 'create', table: 'entries', value: { ...entry(81), entityId: id(80) } }])
  const invalid = run(a, b, row => row.table === 'entries' || row.domain === 'archive' ? 'source' : 'target')
  assert.equal(invalid.status, 'invalid'); assert.equal(invalid.stateValidation.code, 'E_REFERENCE')
  assert.equal(invalid.candidate, null); assert.equal(invalid.combinedStateValidated, false)
  const valid = run(a, b); assert.equal(valid.status, 'validated'); assert.equal(valid.candidate.world.entities.at(-1).id, id(80))
})
test('source tombstones require companion sequence and view-state decisions', () => {
  const [a, b] = siblings(); const sequence = b.state.world.sequences[0], view = b.state.world.viewStates[0]
  commands(b, 'remove', [{ op: 'remove', table: 'entries', id: id(10), expectedRevision: 0 },
    { op: 'update', table: 'sequences', id: sequence.id, expectedRevision: 0, value: { ...sequence, revision: 1, entryIds: sequence.entryIds.filter(value => value !== id(10)) } },
    { op: 'update', table: 'viewStates', id: view.id, expectedRevision: 0, value: { ...view, revision: 1, orderedEntryIds: view.orderedEntryIds.filter(value => value !== id(10)) } }])
  assert.equal(run(a, b, row => row.table === 'entries' || row.domain === 'archive' ? 'source' : 'target').stateValidation.code, 'E_REFERENCE')
  const result = run(a, b); assert.equal(result.status, 'validated')
  assert.ok(result.candidate.retired.some(row => row.table === 'entries' && row.id === id(10)))
})
test('target tombstones and permanent allocations survive explicit keep choices', () => {
  const base = commands(parent(), 'add', [{ op: 'create', table: 'entries', value: entry(60) }])
  const [a, b] = siblings(base); commands(a, 'remove', [{ op: 'remove', table: 'entries', id: id(60), expectedRevision: 0 }])
  const result = run(a, b, () => 'target'); assert.deepEqual(result.candidate, a.state)
  assert.ok(result.candidate.retired.some(row => row.id === id(60)))
})
test('pending foreign proposals stay candidates and never execute their fact commands', () => {
  const [a, b] = siblings(); append(b, 'stage', { kind: 'stage-proposal', proposal: candidate() })
  const result = run(a, b); assert.equal(result.status, 'validated')
  assert.equal(result.candidate.proposals[0].status, 'pending'); assert.equal(result.candidate.world.revision, 0)
  assert.ok(!result.candidate.world.entries.some(row => row.id === id(50)))
})
test('accepted foreign proposal/review/facts must be selected as a consistent full set', () => {
  const [a, b] = siblings(); append(b, 'stage', { kind: 'stage-proposal', proposal: candidate() })
  append(b, 'accept', { kind: 'accept-proposal', proposalId: candidate().id, decision: { reviewId: 'foreign-review', acceptedAt: NOW } })
  const partial = run(a, b, row => row.domain === 'proposal' || row.domain === 'archive' ? 'source' : 'target')
  assert.equal(partial.stateValidation.code, 'E_REPO_PROPOSALS')
  const result = run(a, b); assert.equal(result.status, 'validated')
  assert.equal(result.candidate.world.reviews[0].id, 'foreign-review'); assert.equal(result.newLocalApprovalIssued, false)
  assert.equal(result.candidate.proposals[0].status, 'accepted')
})
test('a local accepted review is never demoted or removed by retaining current decisions', () => {
  const [a, b] = siblings(); for (const value of [a, b]) append(value, 'stage', { kind: 'stage-proposal', proposal: candidate() })
  append(a, 'accept', { kind: 'accept-proposal', proposalId: candidate().id, decision: { reviewId: 'local-review', acceptedAt: NOW } })
  const result = run(a, b, () => 'target'); assert.equal(result.status, 'validated')
  assert.equal(result.candidate.proposals[0].status, 'accepted'); assert.equal(result.candidate.world.reviews[0].id, 'local-review')
})
test('new allocation must match adopted canonical rows; unrelated dead ledger remains intact', () => {
  const [a, b] = siblings(); const mapped = { ...entry(60), source: { sourceId: 'v2:want-to-go', recordId: 'foreign-record', evidenceIds: [] } }
  const v2source = { id: 'v2:want-to-go', revision: 0, title: { names: { en: 'Synthetic source' } }, origin: 'import' }
  append(b, 'add', { kind: 'commands', commands: [{ op: 'create', table: 'sources', value: v2source }, { op: 'create', table: 'entries', value: mapped }] }, [{ kind: 'entry', sourceId: 'v2:want-to-go', recordId: 'foreign-record', id: id(60) }])
  const invalid = run(a, b, row => row.domain === 'identity' ? 'target' : 'source')
  assert.equal(invalid.stateValidation.code, 'E_REPO_IDENTITY')
  const valid = run(a, b); assert.equal(valid.status, 'validated'); assert.equal(valid.candidate.identities.identities[0].id, id(60))
})
test('canonical source identity and existing definitions cannot be reassigned via record choices', () => {
  const [a, b] = siblings(); const left = { ...entity(80), source: { sourceId: 'test:manual', recordId: 'left', evidenceIds: [] } }
  const right = { ...left, source: { ...left.source, recordId: 'right' } }
  commands(a, 'a', [{ op: 'create', table: 'entities', value: left }]); commands(b, 'b', [{ op: 'create', table: 'entities', value: right }])
  const report = preview(a, b), p = plan(report, a, b)
  assert.equal(p.items.find(row => row.id === id(80)).sourceBlockedReason, 'canonical-identity-is-permanent')
  assert.throws(() => run(a, b), error => error.code === 'E_BRANCH_MERGE_CHOICE_FORBIDDEN')
})
test('logical Entry duplicates are caught in the combined world even with different stable IDs', () => {
  const [a, b] = siblings(); commands(a, 'left', [{ op: 'create', table: 'entries', value: entry(60) }])
  commands(b, 'right', [{ op: 'create', table: 'entries', value: { ...entry(61), source: entry(60).source } }])
  const result = run(a, b, row => row.id === id(61) || row.domain === 'archive' ? 'source' : 'target')
  assert.equal(result.stateValidation.valid, false); assert.equal(result.status, 'invalid')
})
test('whole-plan tampering and source changes are refused before constructing a candidate', () => {
  const [a, b] = siblings(); edit(b, 'foreign', 'foreign'); const report = preview(a, b), p = plan(report, a, b)
  const tampered = structuredClone(p); tampered.items[0].source.rowDigest = '0'.repeat(64)
  assert.throws(() => simulate(tampered, report, a, b), error => error.code === 'E_BRANCH_MERGE_PLAN_STALE')
  const changed = edit(structuredClone(b), 'later', 'later')
  assert.throws(() => simulate(p, report, a, changed), error => error.code === 'E_BRANCH_HISTORY_PREVIEW_STALE')
})
test('exact archives yield no-op candidates and no new local revision or IDs', () => {
  const value = parent(), result = run(value, value)
  assert.equal(result.status, 'validated'); assert.deepEqual(result.candidate, value.state)
  assert.equal(result.candidate.revision, 0); assert.equal(result.candidate.world.revision, 0)
  assert.deepEqual(result.adopted, [])
})

test('equal facts with a different known history require explicit whole-archive consent', () => {
  const [a, b] = siblings(), report = preview(a, b), p = plan(report, a, b)
  assert.equal(p.items.length, 1); assert.equal(p.items[0].domain, 'archive'); assert.equal(p.status, 'incomplete')
  assert.equal(simulate(p, report, a, b).combinedStateValidated, false)
  const adopted = run(a, b); assert.equal(adopted.status, 'validated'); assert.equal(adopted.archiveSelection, 'source')
  assert.deepEqual(adopted.candidate.world, a.state.world); assert.equal(adopted.candidate.revision, a.state.revision + 1)
  const declined = run(a, b, () => 'target'); assert.equal(declined.archiveSelection, 'target'); assert.deepEqual(declined.candidate, a.state)
})
test('foreign facts cannot be adopted while explicitly declining their complete source archive', () => {
  const [a, b] = siblings(); edit(b, 'edit', 'incoming')
  const invalid = run(a, b, row => row.domain === 'archive' ? 'target' : 'source')
  assert.equal(invalid.stateValidation.code, 'E_BRANCH_MERGE_ARCHIVE_REQUIRED')
  assert.equal(invalid.status, 'invalid'); assert.equal(invalid.candidate, null)
  const pending = run(a, b, row => row.domain === 'archive' ? 'defer' : 'source')
  assert.equal(pending.status, 'incomplete'); assert.equal(pending.combinedStateValidated, false)
})
test('existing source definitions cannot be overridden by concurrent creations of the same ID', () => {
  const [a, b] = siblings(); const definition = { ...a.state.world.sources[0], id: 'concurrent:source', title: { names: { en: 'A' } } }
  commands(a, 'a', [{ op: 'create', table: 'sources', value: definition }])
  commands(b, 'b', [{ op: 'create', table: 'sources', value: { ...definition, title: { names: { en: 'B' } } } }])
  const p = plan(preview(a, b), a, b)
  assert.equal(p.items.find(row => row.table === 'sources').sourceBlockedReason, 'existing-definition-is-immutable')
  assert.throws(() => run(a, b), error => error.code === 'E_BRANCH_MERGE_CHOICE_FORBIDDEN')
})
test('foreign revision-only differences do not alter local row or world clocks', () => {
  const [a, b] = siblings(); edit(a, 'local', 'same'); edit(b, 'foreign', 'same'); edit(b, 'foreign-two', 'same')
  const result = run(a, b)
  assert.equal(result.candidate.world.entries[0].revision, a.state.world.entries[0].revision)
  assert.equal(result.candidate.world.revision, a.state.world.revision)
  assert.equal(result.candidate.revision, a.state.revision + 1)
  assert.equal(b.state.world.entries[0].revision, 2)
})
test('new identities append beside retained dead allocations without reusing their IDs', () => {
  const [a, b] = siblings(); append(a, 'ledger', { kind: 'stage-proposal', proposal: candidate() }, [{ kind: 'entry', sourceId: 'test:manual', recordId: 'dead', id: id(80) }])
  append(b, 'create', { kind: 'commands', commands: [{ op: 'create', table: 'entries', value: entry(60) }] }, [{ kind: 'entry', sourceId: 'test:manual', recordId: 'record-60', id: id(60) }])
  const result = run(a, b, row => row.allowedChoices.includes('source') ? 'source' : 'target')
  assert.equal(result.status, 'validated')
  assert.deepEqual(result.candidate.identities.identities.map(row => row.id), [id(80), id(60)])
  assert.ok(!result.candidate.world.entries.some(row => row.id === id(80)))
})
test('nested asset references are validated across independently selected tables', () => {
  const [a, b] = siblings(); const asset = { ...b.state.world.assets[0], id: 'incoming-asset', source: { ...b.state.world.assets[0].source, recordId: 'incoming-asset' } }
  commands(b, 'create', [{ op: 'create', table: 'assets', value: asset }, { op: 'create', table: 'entities', value: { ...entity(80), fields: { author: 'Synthetic author', cover: asset.id } } }])
  const invalid = run(a, b, row => row.table === 'assets' ? 'target' : 'source')
  assert.equal(invalid.stateValidation.code, 'E_REFERENCE'); assert.equal(run(a, b).status, 'validated')
})
test('the whole simulation is bound, not only the candidate digest or claimed valid flag', () => {
  const [a, b] = siblings(); edit(b, 'foreign', 'foreign'); const report = preview(a, b), catalogue = plan(report, a, b)
  const p = plan(report, a, b, catalogue.items.map(row => ({ itemId: row.itemId, choice: 'source' }))), result = simulate(p, report, a, b)
  assert.deepEqual(current(result, p, report, a, b), result)
  for (const mutate of [r => { r.executable = true }, r => { r.candidate.world.entries[0].fields.note = 'altered' }, r => { r.confirmationRequirements = [] }]) {
    const tampered = structuredClone(result); mutate(tampered)
    assert.throws(() => current(tampered, p, report, a, b), error => error.code === 'E_BRANCH_MERGE_SIMULATION_STALE')
  }
})
test('simulation never executes input accessors and rejects malformed plan rows', () => {
  const [a, b] = siblings(), report = preview(a, b), p = plan(report, a, b); let calls = 0
  const trap = { get candidate() { calls++; return null } }
  assert.throws(() => current(trap, p, report, a, b), error => error.code === 'E_JSON')
  const malformed = structuredClone(p); malformed.decisions[0] = null
  assert.throws(() => simulate(malformed, report, a, b), error => error.code === 'E_SHAPE')
  assert.equal(calls, 0)
})

test('a foreign accepted proposal cannot rewrite the reason or commands of an accepted local proposal', () => {
  const [a, b] = siblings()
  append(a, 'stage', { kind: 'stage-proposal', proposal: candidate() })
  append(b, 'stage', { kind: 'stage-proposal', proposal: { ...candidate(), reason: 'Different foreign justification' } })
  for (const value of [a, b]) append(value, 'accept', { kind: 'accept-proposal', proposalId: candidate().id, decision: { reviewId: 'review', acceptedAt: NOW } })
  const p = plan(preview(a, b), a, b)
  assert.equal(p.items.find(row => row.domain === 'proposal').sourceBlockedReason, 'accepted-proposal-is-permanent')
  assert.throws(() => run(a, b), error => error.code === 'E_BRANCH_MERGE_CHOICE_FORBIDDEN')
})
test('a rejected local candidate cannot silently become pending again', () => {
  const [a, b] = siblings(); for (const value of [a, b]) append(value, 'stage', { kind: 'stage-proposal', proposal: candidate() })
  append(a, 'reject', { kind: 'reject-proposal', proposalId: candidate().id })
  const p = plan(preview(a, b), a, b)
  assert.equal(p.items.find(row => row.domain === 'proposal').sourceBlockedReason, 'rejected-proposal-is-permanent')
  assert.throws(() => run(a, b), error => error.code === 'E_BRANCH_MERGE_CHOICE_FORBIDDEN')
  assert.equal(run(a, b, row => row.allowedChoices.includes('source') ? 'source' : 'target').candidate.proposals[0].status, 'rejected')
})
