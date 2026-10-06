import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createWorldRepository, openWorldRepository, readRepositoryState } from './world-store-repository.mjs'
import { seed, fixture, entry, id, stageRequest, acceptRequest, createRequest } from './world-store-repository.fixture.mjs'
import { bridgeV2 } from '../src/data/canonical/storeBridge.ts'
import { syntheticBridgeFixture, BRIDGE_NOW } from '../src/data/canonical/storeBridge.fixture.ts'
import { sequentialUuids } from '../src/data/canonical/v2.fixture.ts'
import { restoreBridgeV2 } from '../src/data/canonical/storeBridgeProjection.ts'
const errorCode = code => e => e.code === code

test('an old AI review cannot approve a new unrelated fact; ordinary edits retain provenance', async t => {
  const { database } = await temporary(t), repository = createWorldRepository(database, seed())
  try {
    repository.apply(stageRequest()); repository.apply(acceptRequest())
    const before = repository.snapshot()
    assert.throws(() => repository.apply({ id: 'unreviewed-ai', expectedRevision: 2, action: { kind: 'commands', commands: [{ op: 'create', table: 'entries', value: { ...entry(51), source: { sourceId: 'test:ai', recordId: 'never-approved', evidenceIds: ['proof-one'], reviewId: 'synthetic-review' } } }] } }), errorCode('E_UNCONFIRMED'))
    assert.deepEqual(repository.snapshot(), before)
    const approved = before.world.entries.find(row => row.id === id(50))
    const repeated = repository.apply({ id: 'approved-noop', expectedRevision: 2, action: { kind: 'commands', commands: [{ op: 'create', table: 'entries', value: approved }] } })
    assert.equal(repeated.worldRevision, before.world.revision)
    repository.apply({ id: 'manual-edit', expectedRevision: 3, action: { kind: 'commands', commands: [{ op: 'update', table: 'entries', id: approved.id, expectedRevision: approved.revision, value: { ...approved, revision: approved.revision + 1, fields: { ...approved.fields, note: 'Owner edit' } } }] } })
    assert.equal(repository.snapshot().world.entries.find(row => row.id === id(50)).fields.note, 'Owner edit')
  } finally { repository.close() }
})

test('merge preflight rejects a conflicting reserved source identity before declaring ready', async t => {
  const { database } = await temporary(t), initial = seed()
  initial.world = structuredClone(initial.world)
  initial.world.sources.push({ id: 'v2:travel', revision: 0, title: { names: { en: 'Legacy source' } }, origin: 'import' })
  initial.identities = { format: 'starmap.v2-store-identities', version: 1, identities: [{ kind: 'entry', sourceId: 'v2:travel', recordId: 'stable', id: id(60) }] }
  const repository = createWorldRepository(database, initial)
  try {
    const incoming = structuredClone(repository.snapshot().world)
    incoming.entries.push({ ...entry(61), source: { sourceId: 'v2:travel', recordId: 'stable', evidenceIds: [] } })
    assert.throws(() => repository.preflightMerge(incoming), errorCode('E_REPO_IDENTITY'))
    incoming.entries.at(-1).id = id(60)
    assert.equal(repository.preflightMerge(incoming).plan.status, 'ready')
    assert.equal(repository.snapshot().revision, 0)
  } finally { repository.close() }
})
async function temporary(t) {
  const base = path.resolve(tmpdir()), root = await mkdtemp(path.join(base, 'starmap-g3-synthetic-'))
  t.after(() => {
    // Resolve and check the final recursive-cleanup target, also on Windows.
    assert.equal(path.dirname(path.resolve(root)), base)
    assert.ok(path.basename(root).startsWith('starmap-g3-synthetic-'))
    return rm(root, { recursive: true, force: true })
  })
  return { root, database: path.join(root, 'world.sqlite') }
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const optionsHook = target => ({ unsafeTestPhase(phase) { if (phase === target) throw new Error('Synthetic interruption, no record contents') } })

test('new repository/reopen retains complete world and immutable snapshots', async t => {
  const { database } = await temporary(t), repository = createWorldRepository(database, seed()), snapshot = repository.snapshot()
  repository.close()
  const reopened = openWorldRepository(database)
  try { assert.deepEqual(reopened.snapshot(), snapshot); assert.ok(Object.isFrozen(snapshot.world.entries[0].fields)); assert.equal(reopened.findOperation('absent'), undefined) }
  finally { reopened.close() }
})
test('G2 identity ledger, opaque preservation metadata and all five reconstructed values persist', async t => {
  const { database } = await temporary(t), files = syntheticBridgeFixture(), bridge = bridgeV2(files, { now: BRIDGE_NOW, allocateId: sequentialUuids() })
  const repository = createWorldRepository(database, { world: bridge.store, identities: bridge.manifest }); repository.close()
  const reopened = openWorldRepository(database)
  try { const state = reopened.snapshot(); assert.deepEqual(state.identities, bridge.manifest); assert.deepEqual(restoreBridgeV2({ ...bridge, store: state.world, manifest: state.identities }), files) }
  finally { reopened.close() }
})
test('facts, appended identities and operation receipt commit once and survive reopen', async t => {
  const { database } = await temporary(t), repository = createWorldRepository(database, seed()), request = createRequest(), result = repository.apply(request)
  const after = repository.snapshot(); assert.equal(after.world.entries.length, 4); assert.equal(after.identities.identities.length, 1); assert.equal(after.revision, 1)
  assert.deepEqual(repository.apply(request), result); assert.deepEqual(repository.snapshot(), after); repository.close()
  const reopened = openWorldRepository(database)
  try { assert.deepEqual(reopened.findOperation(request.id), result); assert.deepEqual(reopened.snapshot(), after); assert.deepEqual(reopened.apply(request), result) }
  finally { reopened.close() }
})
test('operation ID reuse with changed payload or expected version is rejected', async t => {
  const { database } = await temporary(t), repository = createWorldRepository(database, seed())
  try {
    const request = createRequest(); repository.apply(request)
    assert.throws(() => repository.apply({ ...request, expectedRevision: 1 }), errorCode('E_REPO_OPERATION_REUSED'))
    const changed = structuredClone(request); changed.action.commands[0].value.fields.note = 'Changed neutral note'
    assert.throws(() => repository.apply(changed), errorCode('E_REPO_OPERATION_REUSED')); assert.equal(repository.snapshot().revision, 1)
  } finally { repository.close() }
})
test('request fingerprint ignores JSON object property ordering, retaining array order', async t => {
  const { database } = await temporary(t), repository = createWorldRepository(database, seed())
  try { const request = createRequest(), result = repository.apply(request); assert.deepEqual(repository.apply({ identities: request.identities, action: request.action, expectedRevision: 0, id: 'create' }), result) }
  finally { repository.close() }
})
test('two connections reject stale editor versions without overwriting successful facts', async t => {
  const { database } = await temporary(t), a = createWorldRepository(database, seed()), b = openWorldRepository(database)
  try { a.apply(createRequest()); assert.throws(() => b.apply({ id: 'stale-edit', expectedRevision: 0, action: { kind: 'commands', commands: [{ op: 'create', table: 'entries', value: entry(61) }] } }), errorCode('E_REPO_STALE')); assert.equal(b.snapshot().world.entries.length, 4); assert.equal(b.findOperation('stale-edit'), undefined) }
  finally { a.close(); b.close() }
})
test('SQLite write lock fails promptly, preserves state and releases when owner rolls back', async t => {
  const { database } = await temporary(t), repository = createWorldRepository(database, seed()), other = new DatabaseSync(database), before = repository.snapshot()
  try { other.exec('BEGIN IMMEDIATE'); assert.throws(() => repository.apply(createRequest()), errorCode('E_REPO_BUSY')); other.exec('ROLLBACK'); assert.deepEqual(repository.snapshot(), before); assert.equal(repository.findOperation('create'), undefined); assert.equal(repository.apply(createRequest()).repositoryRevision, 1) }
  finally { if (other.isTransaction) other.exec('ROLLBACK'); other.close(); repository.close() }
})
for (const phase of ['before-begin', 'locked', 'state-written', 'receipt-written', 'before-commit']) test(`injected failure at ${phase} rolls back facts/identity/receipt together`, async t => {
  const { database } = await temporary(t), repository = createWorldRepository(database, seed(), optionsHook(phase)), before = repository.snapshot()
  try { assert.throws(() => repository.apply(createRequest()), errorCode('E_REPO_IO')); assert.deepEqual(repository.snapshot(), before); assert.equal(repository.findOperation('create'), undefined) }
  finally { repository.close() }
  const reopened = openWorldRepository(database)
  try { assert.deepEqual(reopened.snapshot(), before) } finally { reopened.close() }
})
test('lost post-commit acknowledgement reports unknown outcome; discovery proves commit and safe replay', async t => {
  const { database } = await temporary(t), repository = createWorldRepository(database, seed(), optionsHook('committed'))
  try { assert.throws(() => repository.apply(createRequest()), errorCode('E_REPO_OUTCOME_UNKNOWN')); assert.equal(repository.snapshot().revision, 1); assert.equal(repository.findOperation('create').status, 'committed'); assert.equal(repository.apply(createRequest()).repositoryRevision, 1) }
  finally { repository.close() }
})
test('staged proposals remain outside facts; acceptance persists fact/review/status atomically and cannot replay', async t => {
  const { database } = await temporary(t), repository = createWorldRepository(database, seed())
  repository.apply(stageRequest()); assert.equal(repository.snapshot().world.entries.length, 3); assert.equal(repository.snapshot().world.revision, 0); assert.equal(repository.snapshot().revision, 1)
  const accepted = repository.apply(acceptRequest()); assert.equal(accepted.worldRevision, 1); repository.close()
  const reopened = openWorldRepository(database)
  try {
    const state = reopened.snapshot(); assert.equal(state.world.entries.length, 4); assert.equal(state.world.reviews.length, 1); assert.equal(state.proposals[0].status, 'accepted')
    const fact = state.world.entries.find(e => e.id === id(50)); assert.equal(fact.source.sourceId, 'test:ai'); assert.equal(fact.source.reviewId, 'synthetic-review'); assert.deepEqual(fact.source.evidenceIds, ['proof-one'])
    assert.deepEqual(reopened.apply(acceptRequest()), accepted)
    assert.throws(() => reopened.apply({ ...acceptRequest(), id: 'accept-again', expectedRevision: 2 }), errorCode('E_PROPOSAL_REPLAY'))
  } finally { reopened.close() }
})
for (const phase of ['state-written', 'receipt-written', 'before-commit']) test(`proposal acceptance failure at ${phase} preserves pending status and no review/fact`, async t => {
  const { database } = await temporary(t), initial = createWorldRepository(database, seed()); initial.apply(stageRequest()); const before = initial.snapshot(); initial.close()
  const repository = openWorldRepository(database, optionsHook(phase))
  try { assert.throws(() => repository.apply(acceptRequest()), errorCode('E_REPO_IO')); assert.deepEqual(repository.snapshot(), before); assert.equal(repository.findOperation('accept'), undefined) }
  finally { repository.close() }
})
test('rejected proposal remains durable without creating facts and cannot later be accepted', async t => {
  const { database } = await temporary(t), repository = createWorldRepository(database, seed())
  try { repository.apply(stageRequest()); repository.apply({ id: 'reject', expectedRevision: 1, action: { kind: 'reject-proposal', proposalId: 'synthetic-proposal' } }); const state = repository.snapshot(); assert.equal(state.proposals[0].status, 'rejected'); assert.equal(state.world.entries.length, 3); assert.throws(() => repository.apply({ ...acceptRequest(), id: 'accept-rejected', expectedRevision: 2 }), errorCode('E_PROPOSAL_REPLAY')) }
  finally { repository.close() }
})
test('intervening facts invalidate old proposal acceptance, requiring fresh explicit review', async t => {
  const { database } = await temporary(t), repository = createWorldRepository(database, seed())
  try { repository.apply(stageRequest()); repository.apply({ ...createRequest(), expectedRevision: 1 }); const before = repository.snapshot(); assert.throws(() => repository.apply({ ...acceptRequest(), expectedRevision: 2 }), errorCode('E_STALE')); assert.deepEqual(repository.snapshot(), before) }
  finally { repository.close() }
})
test('ordinary commands cannot inject unconfirmed AI facts or fabricate review receipts', async t => {
  const { database } = await temporary(t), repository = createWorldRepository(database, seed())
  try { assert.throws(() => repository.apply({ id: 'bypass', expectedRevision: 0, action: { kind: 'commands', commands: stageRequest().action.proposal.commands } }), errorCode('E_UNCONFIRMED')); assert.equal(repository.snapshot().revision, 0) }
  finally { repository.close() }
})
test('merge preflight is read-only, conflicting merge writes nothing, independent additions need explicit commit', async t => {
  const { database } = await temporary(t), repository = createWorldRepository(database, seed()), incoming = structuredClone(fixture())
  try {
    incoming.entries.push(entry(65)); const before = repository.snapshot(); const plan = repository.preflightMerge(incoming); assert.equal(plan.plan.status, 'ready'); assert.deepEqual(repository.snapshot(), before)
    incoming.entities[0].title.names.en = 'Conflicting neutral title'
    assert.equal(repository.preflightMerge(incoming).plan.status, 'conflict')
    assert.throws(() => repository.apply({ id: 'conflicting-merge', expectedRevision: 0, action: { kind: 'merge', incoming } }), errorCode('E_REPO_MERGE_CONFLICT')); assert.deepEqual(repository.snapshot(), before)
    incoming.entities[0] = structuredClone(fixture().entities[0]); repository.apply({ id: 'approved-merge', expectedRevision: 0, action: { kind: 'merge', incoming } }); assert.equal(repository.snapshot().world.entries.length, 4)
  } finally { repository.close() }
})
test('merge planned at old repository revision cannot slip past a concurrent proposal-only save', async t => {
  const { database } = await temporary(t), repository = createWorldRepository(database, seed()), incoming = structuredClone(fixture()); incoming.entries.push(entry(65))
  try { const plan = repository.preflightMerge(incoming); repository.apply(stageRequest()); assert.equal(repository.snapshot().world.revision, 0); assert.throws(() => repository.apply({ id: 'stale-merge', expectedRevision: plan.repositoryRevision, action: { kind: 'merge', incoming } }), errorCode('E_REPO_STALE')) }
  finally { repository.close() }
})
test('historical incoming revisions remain unsupported rather than being reset or partially imported', async t => {
  const { database } = await temporary(t), repository = createWorldRepository(database, seed()), incoming = structuredClone(fixture()); incoming.entries.push({ ...entry(66), revision: 1 })
  try { assert.throws(() => repository.apply({ id: 'history', expectedRevision: 0, action: { kind: 'merge', incoming } }), errorCode('E_IMPORT_POLICY')); assert.equal(repository.snapshot().revision, 0) }
  finally { repository.close() }
})
test('inconsistent identity append, stale object revision and dangling reference cannot commit', async t => {
  const { database } = await temporary(t), repository = createWorldRepository(database, seed())
  try {
    const bad = createRequest(); bad.identities[0].recordId = 'other-source-record'
    assert.throws(() => repository.apply(bad), errorCode('E_REPO_IDENTITY'))
    const update = { id: 'update', expectedRevision: 0, action: { kind: 'commands', commands: [{ op: 'update', table: 'entries', id: id(10), expectedRevision: 8, value: { ...entry(10), revision: 1 } }] } }
    assert.throws(() => repository.apply(update), errorCode('E_STALE'))
    const dangling = createRequest(); dangling.action.commands[0].value.entityId = id(999)
    assert.throws(() => repository.apply(dangling), errorCode('E_REFERENCE')); assert.equal(repository.snapshot().revision, 0)
  } finally { repository.close() }
})
test('invalid seed is rejected before creating a file; existing files are never replaced', async t => {
  const { database } = await temporary(t), bad = seed(); bad.world = structuredClone(bad.world); bad.world.entities[0].typeId = 'missing'
  assert.throws(() => createWorldRepository(database, bad), errorCode('E_REFERENCE')); await assert.rejects(stat(database), { code: 'ENOENT' })
  await writeFile(database, 'Synthetic unrelated file'); const before = await readFile(database)
  assert.throws(() => createWorldRepository(database, seed()), errorCode('E_REPO_EXISTS')); assert.deepEqual(await readFile(database), before)
})
test('missing repository, unknown format version and extra schema reject without initializing a replacement', async t => {
  const { database } = await temporary(t)
  assert.throws(() => openWorldRepository(database), errorCode('E_REPO_NOT_FOUND'))
  const repository = createWorldRepository(database, seed()); repository.close()
  const db = new DatabaseSync(database)
  try { db.exec('PRAGMA user_version = 2'); assert.throws(() => openWorldRepository(database), errorCode('E_REPO_VERSION')); db.exec('PRAGMA user_version = 1; CREATE TABLE unrelated (id INTEGER)'); assert.throws(() => openWorldRepository(database), errorCode('E_REPO_SCHEMA')) }
  finally { db.close() }
})
test('checksums and lost receipt detect corruption instead of reporting success or falling back', async t => {
  const { database } = await temporary(t), repository = createWorldRepository(database, seed()); repository.apply(createRequest()); repository.close()
  const db = new DatabaseSync(database)
  try {
    db.prepare('UPDATE operation_receipts SET payload = ?').run('{}')
    assert.throws(() => openWorldRepository(database), errorCode('E_REPO_CORRUPT'))
    db.exec('DELETE FROM operation_receipts'); assert.throws(() => openWorldRepository(database), errorCode('E_REPO_CORRUPT'))
  } finally { db.close() }
})
test('repository status cannot claim accepted without exactly one matching review receipt', () => {
  const state = { format: 'starmap.world-repository', formatVersion: 1, revision: 0, world: fixture(), identities: { format: 'starmap.v2-store-identities', version: 1, identities: [] }, retired: [], proposals: [{ ...stageRequest().action.proposal, status: 'accepted' }] }
  assert.throws(() => readRepositoryState(state), errorCode('E_REPO_PROPOSALS'))
})
test('non-JSON requests do not execute getters or leak data through error messages', async t => {
  const { database } = await temporary(t), repository = createWorldRepository(database, seed()); let reads = 0
  try { const request = createRequest(); Object.defineProperty(request, 'action', { enumerable: true, get() { reads++; return 'Synthetic sensitive field' } }); assert.throws(() => repository.apply(request), e => e.code === 'E_JSON' && !e.message.includes('Synthetic sensitive')); assert.equal(reads, 0); assert.equal(repository.snapshot().revision, 0) }
  finally { repository.close() }
})

async function killAt(root, database, request, phase) {
  const spec = path.join(root, `worker-${phase}.json`); await writeFile(spec, JSON.stringify({ database, request, phase }))
  const child = spawn(process.execPath, [fileURLToPath(new URL('./world-store-repository.fixture.mjs', import.meta.url)), 'crash-worker', spec], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes })
  const exited = once(child, 'exit'); exited.catch(() => {})
  try {
    await new Promise((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(new Error('Synthetic worker phase timeout')), 7000)
      child.on('error', e => { clearTimeout(timer); reject(e) })
      child.on('exit', () => { clearTimeout(timer); reject(new Error('Synthetic worker exited before phase: ' + stderr)) })
      child.stdout.on('data', bytes => { output += bytes; if (output.includes(`paused:${phase}`)) { clearTimeout(timer); resolve() } })
    })
    if (phase === 'state-written') assert.ok((await stat(database + '-journal')).size > 0)
    if (phase === 'locked') {
      const competing = openWorldRepository(database)
      try { assert.throws(() => competing.apply(createRequest()), errorCode('E_REPO_BUSY')) }
      finally { competing.close() }
    }
    child.kill('SIGKILL'); const [code, signal] = await exited
    assert.ok(signal === 'SIGKILL' || code !== 0)
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited } }
}
for (const phase of ['locked', 'state-written', 'receipt-written', 'before-commit']) test(`actual killed process at ${phase} reopens old facts/identities and releases writer lock`, async t => {
  const { root, database } = await temporary(t), repository = createWorldRepository(database, seed()), before = repository.snapshot(); repository.close()
  const request = createRequest()
  // Force dirty-page spill beyond SQLite's normal cache, making the journal
  // recovery case stronger than a JS exception before any database I/O.
  if (phase === 'state-written') request.action.commands[0].value.fields.note = 'Synthetic '.repeat(350000)
  await killAt(root, database, request, phase)
  const reopened = openWorldRepository(database)
  try { assert.deepEqual(reopened.snapshot(), before); assert.equal(reopened.findOperation(request.id), undefined); assert.equal(reopened.apply(createRequest()).repositoryRevision, 1) }
  finally { reopened.close() }
})
test('actual killed process after committed proposal acceptance preserves fact/review/status and discoverable result', async t => {
  const { root, database } = await temporary(t), repository = createWorldRepository(database, seed()); repository.apply(stageRequest()); repository.close()
  await killAt(root, database, acceptRequest(), 'committed')
  const reopened = openWorldRepository(database)
  try { const state = reopened.snapshot(); assert.equal(state.proposals[0].status, 'accepted'); assert.equal(state.world.reviews.length, 1); assert.equal(state.world.entries.length, 4); const receipt = reopened.findOperation('accept'); assert.equal(receipt.status, 'committed'); assert.deepEqual(reopened.apply(acceptRequest()), receipt); assert.equal(reopened.snapshot().revision, 2) }
  finally { reopened.close() }
})
test('actual killed proposal acceptance before COMMIT keeps pending proposal and no accepted fact/review', async t => {
  const { root, database } = await temporary(t), repository = createWorldRepository(database, seed()); repository.apply(stageRequest()); const before = repository.snapshot(); repository.close()
  await killAt(root, database, acceptRequest(), 'before-commit')
  const reopened = openWorldRepository(database)
  try { assert.deepEqual(reopened.snapshot(), before); assert.equal(reopened.findOperation('accept'), undefined); assert.equal(reopened.snapshot().proposals[0].status, 'pending') }
  finally { reopened.close() }
})
test('permanent removal retires identity across transactions/reopen, preventing revision reset or source reinterpretation', async t => {
  const { database } = await temporary(t), repository = createWorldRepository(database, seed()); repository.apply(createRequest())
  repository.apply({ id: 'remove', expectedRevision: 1, action: { kind: 'commands', commands: [{ op: 'remove', table: 'entries', id: id(60), expectedRevision: 0 }] } })
  const before = repository.snapshot(); assert.equal(before.retired.length, 1); assert.equal(before.identities.identities.length, 1); repository.close()
  const reopened = openWorldRepository(database)
  try {
    assert.throws(() => reopened.apply({ id: 'reuse-retired', expectedRevision: 2, action: createRequest().action }), errorCode('E_REPO_RETIRED_ID'))
    const incoming = structuredClone(before.world); incoming.entries.push(entry(60))
    assert.throws(() => reopened.preflightMerge(incoming), errorCode('E_REPO_RETIRED_ID')); assert.deepEqual(reopened.snapshot(), before)
  } finally { reopened.close() }
})
test('identical merge advances repository audit version while leaving world revision and facts unchanged', async t => {
  const { database } = await temporary(t), repository = createWorldRepository(database, seed())
  try { const receipt = repository.apply({ id: 'identical', expectedRevision: 0, action: { kind: 'merge', incoming: fixture() } }); assert.equal(receipt.repositoryRevision, 1); assert.equal(receipt.worldRevision, 0); assert.deepEqual(repository.snapshot().world, fixture()) }
  finally { repository.close() }
})
test('unknown logical Store version is preserved for review and cannot be silently upgraded', async t => {
  const { database } = await temporary(t), repository = createWorldRepository(database, seed()); repository.close()
  const db = new DatabaseSync(database)
  try {
    const row = db.prepare('SELECT payload FROM repository_state').get(), state = JSON.parse(row.payload); state.world.formatVersion = 2
    const payload = JSON.stringify(state); db.prepare('UPDATE repository_state SET payload = ?, digest = ?').run(payload, digest(payload))
    assert.throws(() => openWorldRepository(database), errorCode('E_REPO_VERSION')); assert.equal(db.prepare('SELECT payload FROM repository_state').get().payload, payload)
  } finally { db.close() }
})
test('valid checksum with invalid logical references still rejects the persisted database', async t => {
  const { database } = await temporary(t), repository = createWorldRepository(database, seed()); repository.close()
  const db = new DatabaseSync(database)
  try { const state = JSON.parse(db.prepare('SELECT payload FROM repository_state').get().payload); state.world.entries[0].entityId = id(999); const payload = JSON.stringify(state); db.prepare('UPDATE repository_state SET payload = ?, digest = ?').run(payload, digest(payload)); assert.throws(() => openWorldRepository(database), errorCode('E_REPO_CORRUPT')) }
  finally { db.close() }
})
test('opening a valid database leaves committed main-file bytes unchanged', async t => {
  const { database } = await temporary(t), repository = createWorldRepository(database, seed()); repository.apply(createRequest()); repository.close()
  const before = digest(await readFile(database)), reopened = openWorldRepository(database)
  reopened.snapshot(); reopened.findOperation('create'); reopened.close()
  assert.equal(digest(await readFile(database)), before)
})

test('merge preflight rejects getter-bearing tables before observing retired identities', async t => {
  const { database } = await temporary(t), repository = createWorldRepository(database, seed())
  try {
    repository.apply(createRequest())
    repository.apply({ id: 'retire', expectedRevision: 1, action: { kind: 'commands', commands: [{ op: 'remove', table: 'entries', id: id(60), expectedRevision: 0 }] } })
    const before = repository.snapshot(), incoming = structuredClone(fixture()); let reads = 0
    Object.defineProperty(incoming, 'entries', { enumerable: true, get() { reads++; return [] } })
    assert.throws(() => repository.preflightMerge(incoming), errorCode('E_JSON'))
    assert.equal(reads, 0); assert.deepEqual(repository.snapshot(), before)
  } finally { repository.close() }
})

test('merge preflight never invokes methods on a non-JSON table value', async t => {
  const { database } = await temporary(t), repository = createWorldRepository(database, seed())
  try {
    repository.apply(createRequest())
    repository.apply({ id: 'retire', expectedRevision: 1, action: { kind: 'commands', commands: [{ op: 'remove', table: 'entries', id: id(60), expectedRevision: 0 }] } })
    const before = repository.snapshot(), incoming = structuredClone(fixture()); let calls = 0
    incoming.entries = { some() { calls++; return false } }
    assert.throws(() => repository.preflightMerge(incoming), errorCode('E_JSON'))
    assert.equal(calls, 0); assert.deepEqual(repository.snapshot(), before)
  } finally { repository.close() }
})

for (const phase of ['locked', 'state-written', 'receipt-written', 'before-commit']) test(`receipt discovery during ${phase} cannot roll back the caller's save`, async t => {
  const { database } = await temporary(t); let repository, observed, calls = 0
  repository = createWorldRepository(database, seed(), { unsafeTestPhase(current) {
    if (current !== phase) return
    calls++
    try { repository.findOperation('create') } catch (error) { observed = error.code }
  } })
  try {
    const receipt = repository.apply(createRequest())
    assert.equal(observed, 'E_REPO_BUSY'); assert.equal(calls, 1)
    assert.equal(receipt.repositoryRevision, 1); assert.deepEqual(repository.findOperation('create'), receipt)
    assert.equal(repository.snapshot().world.entries.length, 4); assert.equal(repository.snapshot().identities.identities.length, 1)
  } finally { repository.close() }
  const reopened = openWorldRepository(database)
  try { assert.equal(reopened.snapshot().revision, 1); assert.equal(reopened.findOperation('create').status, 'committed'); assert.equal(reopened.snapshot().world.entries.length, 4) }
  finally { reopened.close() }
})

test('receipt discovery before a save begins remains available and does not prevent commit', async t => {
  const { database } = await temporary(t); let repository, result = 'not-called'
  repository = createWorldRepository(database, seed(), { unsafeTestPhase(phase) { if (phase === 'before-begin') result = repository.findOperation('create') } })
  try { const receipt = repository.apply(createRequest()); assert.equal(result, undefined); assert.deepEqual(repository.findOperation('create'), receipt); assert.equal(repository.snapshot().revision, 1) }
  finally { repository.close() }
})
