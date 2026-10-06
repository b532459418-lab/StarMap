import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, writeFile, rm, cp, rename, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { seed, createRequest, stageRequest, acceptRequest, id } from './world-store-repository.fixture.mjs'
import { createWorldRepository } from './world-store-repository.mjs'
import { previewRepositoryUpgrade } from './world-store-upgrade-preview.mjs'
import { createRepositoryV2, openRepositoryV2 } from './world-store-repository-v2.mjs'
import { repositoryStateDigest as digest, readRepositoryV2 } from './world-store-repository-v2-contract.mjs'
import { previewRepositoryFork, forkRepositoryToDirectory, discoverRepositoryFork, openRepositoryBranch } from './world-store-branch.mjs'

const host = { hostId: 'test-host' }
const rejects = (fn, code) => assert.throws(fn, error => error.code === code)
const noop = (revision, name = 'child-save') => ({ id: name, expectedRevision: revision, action: { kind: 'commands', commands: [{ op: 'create', table: 'entries', value: seed().world.entries[0] }] } })
const update = state => {
  const before = state.world.entries[0]
  return { id: 'child-save', expectedRevision: state.revision, action: { kind: 'commands', commands: [{ op: 'update', table: 'entries', id: before.id, expectedRevision: before.revision,
    value: { ...before, revision: before.revision + 1, fields: { ...before.fields, note: 'child-change' } } }] } }
}
async function setup(t) {
  const base = path.resolve(tmpdir()), root = await mkdtemp(path.join(base, 'starmap-branch-test-'))
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), base); assert.ok(path.basename(root).startsWith('starmap-branch-test-')); return rm(root, { recursive: true, force: true }) })
  const oldFile = path.join(root, 'old.sqlite'), source = path.join(root, 'parent.sqlite'), target = path.join(root, 'child')
  const old = createWorldRepository(oldFile, seed())
  try { old.apply(createRequest()) } finally { old.close() }
  const envelope = previewRepositoryUpgrade(oldFile, { libraryId: 'synthetic-family', branchId: 'synthetic-parent', genesisId: 'synthetic-genesis' }).envelope
  const parent = createRepositoryV2(source, envelope)
  try {
    const stage = stageRequest(); stage.expectedRevision = 1; stage.action.proposal.baseRevision = parent.state().world.revision
    parent.apply(stage); parent.apply({ ...acceptRequest(), expectedRevision: 2 })
    parent.apply({ id: 'remove', expectedRevision: 3, action: { kind: 'commands', commands: [{ op: 'remove', table: 'entries', id: id(60), expectedRevision: 0 }] } })
  } finally { parent.close() }
  const preview = previewRepositoryFork(source)
  return { root, source, target, preview }
}
function fork(value, options = {}) { return forkRepositoryToDirectory(value.source, value.target, value.preview, 'fork', { ...host, ...options }) }
test('preview is immutable, preserves full history and leaves original bytes unchanged', async t => {
  const value = await setup(t), before = await readFile(value.source)
  const second = previewRepositoryFork(value.source)
  assert.deepEqual(second, value.preview); assert.ok(Object.isFrozen(second.archive.state.world))
  assert.equal(second.archive.baseline.receipts[0].operationId, 'create')
  assert.equal(second.archive.history.length, 3)
  assert.equal(second.archive.state.proposals[0].status, 'accepted')
  assert.deepEqual(await readFile(value.source), before)
  assert.equal(discoverRepositoryFork(value.target).status, 'absent')
})
test('fork mints durable IDs, preserves facts/ledger/tombstones/revisions and isolates parent receipts', async t => {
  const value = await setup(t), original = await readFile(value.source), result = fork(value)
  assert.equal(result.status, 'completed')
  assert.equal(result.descriptor.identity.libraryId, value.preview.archive.identity.libraryId)
  assert.notEqual(result.descriptor.identity.branchId, value.preview.archive.identity.branchId)
  assert.notEqual(result.descriptor.identity.genesisId, value.preview.archive.identity.genesisId)
  assert.match(result.descriptor.identity.branchId, /^[a-f0-9-]{36}$/)
  const branch = openRepositoryBranch(value.target, host)
  let snapshot
  try {
    snapshot = branch.snapshot()
    assert.equal(snapshot.formatVersion, 3); assert.deepEqual(snapshot.sourceArchive, value.preview.archive)
    assert.deepEqual(snapshot.state, value.preview.archive.state); assert.equal(snapshot.history.length, 0)
    for (const name of ['create', 'stage', 'accept', 'remove']) assert.equal(branch.findOperation(name), undefined)
    const request = noop(snapshot.state.revision, 'create'), receipt = branch.apply(request)
    assert.equal(receipt.repositoryRevision, snapshot.state.revision + 1)
    assert.deepEqual(receipt.identity, result.descriptor.identity)
    assert.deepEqual(branch.apply(request), receipt)
    rejects(() => branch.apply({ ...request, expectedRevision: 99 }), 'E_REPO_OPERATION_CONFLICT')
    assert.equal(branch.snapshot().history.length, 1)
    snapshot = branch.snapshot()
  } finally { branch.close() }
  const reopened = openRepositoryBranch(value.target, host)
  try { assert.deepEqual(reopened.snapshot(), snapshot) } finally { reopened.close() }
  assert.deepEqual(await readFile(value.source), original)
  assert.equal(discoverRepositoryFork(value.target).status, 'completed')
})
test('same creation retry finds original identity after source or child has changed', async t => {
  const value = await setup(t), first = fork(value)
  const parent = openRepositoryV2(value.source)
  try { parent.apply(noop(parent.state().revision)) } finally { parent.close() }
  const branch = openRepositoryBranch(value.target, host)
  try { branch.apply(noop(branch.state().revision)) } finally { branch.close() }
  assert.deepEqual(fork(value), first)
  rejects(() => forkRepositoryToDirectory(value.source, value.target, value.preview, 'other-operation', host), 'E_BRANCH_EXISTS')
  rejects(() => forkRepositoryToDirectory(value.source, value.target, previewRepositoryFork(value.source), 'fork', host), 'E_BRANCH_EXISTS')
})
test('two targets are independent branches and can use the same operation names', async t => {
  const value = await setup(t), first = fork(value)
  const next = { ...value, target: path.join(value.root, 'child-two') }, second = fork(next)
  assert.notEqual(first.descriptor.identity.branchId, second.descriptor.identity.branchId)
  assert.notEqual(first.descriptor.identity.genesisId, second.descriptor.identity.genesisId)
  for (const target of [value.target, next.target]) {
    const branch = openRepositoryBranch(target, host)
    try { assert.equal(branch.apply(noop(branch.state().revision, 'same')).status, 'committed') } finally { branch.close() }
  }
})
test('copy and moved directory allow readonly inspection but refuse writes from wrong binding', async t => {
  const value = await setup(t); fork(value)
  const copy = path.join(value.root, 'copy'); await cp(value.target, copy, { recursive: true })
  const readonly = openRepositoryBranch(copy, { readOnly: true })
  try { assert.deepEqual(readonly.state(), value.preview.archive.state); rejects(() => readonly.apply(noop(4)), 'E_REPO_READONLY') } finally { readonly.close() }
  rejects(() => openRepositoryBranch(copy, host), 'E_BRANCH_BINDING')
  rejects(() => openRepositoryBranch(value.target, { hostId: 'other-host' }), 'E_BRANCH_BINDING')
  const moved = path.join(value.root, 'moved'); await rename(value.target, moved)
  rejects(() => openRepositoryBranch(moved, host), 'E_BRANCH_BINDING')
})
test('changed location marker is not accepted as a completed fork or during an open session', async t => {
  const value = await setup(t); fork(value)
  const branch = openRepositoryBranch(value.target, host)
  const file = path.join(value.target, 'binding.json'), marker = JSON.parse(await readFile(file, 'utf8'))
  marker.creation.operationId = 'tampered'
  await writeFile(file, JSON.stringify(marker))
  try {
    rejects(() => branch.apply(noop(4)), 'E_BRANCH_CORRUPT')
    rejects(() => discoverRepositoryFork(value.target), 'E_BRANCH_CORRUPT')
  } finally { branch.close() }
})
test('path changes do not change logical identity; copied fork cannot masquerade as a retry', async t => {
  const value = await setup(t), first = fork(value), copy = path.join(value.root, 'copy')
  await cp(value.target, copy, { recursive: true })
  assert.deepEqual(discoverRepositoryFork(copy).descriptor.identity, first.descriptor.identity)
  rejects(() => forkRepositoryToDirectory(value.source, copy, value.preview, 'fork', host), 'E_BRANCH_EXISTS')
})
test('changed source rejects before target exists', async t => {
  const value = await setup(t), parent = openRepositoryV2(value.source)
  try { parent.apply(noop(parent.state().revision)) } finally { parent.close() }
  rejects(() => fork(value), 'E_BRANCH_SOURCE_CHANGED')
  assert.equal(discoverRepositoryFork(value.target).status, 'absent')
})
test('child edits facts locally without changing the archived parent or source bytes', async t => {
  const value = await setup(t), before = await readFile(value.source); fork(value)
  const branch = openRepositoryBranch(value.target, host)
  try {
    const receipt = branch.apply(update(branch.state()))
    const snapshot = branch.snapshot()
    assert.equal(receipt.repositoryRevision, 5)
    assert.equal(snapshot.state.world.entries[0].fields.note, 'child-change')
    assert.equal(snapshot.history[0].after.world.entries[0].fields.note, 'child-change')
    assert.deepEqual(snapshot.sourceArchive, value.preview.archive)
  } finally { branch.close() }
  assert.deepEqual(await readFile(value.source), before)
  const reopened = openRepositoryBranch(value.target, host)
  try { assert.equal(reopened.state().world.entries[0].fields.note, 'child-change') } finally { reopened.close() }
})
test('fork preserves deletion and accepted-review protections during new writes', async t => {
  const value = await setup(t); fork(value)
  const branch = openRepositoryBranch(value.target, host)
  try {
    const before = branch.state()
    const resurrection = createRequest(); delete resurrection.identities; resurrection.expectedRevision = 4
    rejects(() => branch.apply(resurrection), 'E_REPO_RETIRED_ID')
    const stage = stageRequest(); stage.expectedRevision = 4; stage.action.proposal.baseRevision = before.world.revision
    rejects(() => branch.apply(stage), 'E_REPO_PROPOSALS')
    assert.deepEqual(branch.state(), before)
    assert.equal(branch.findOperation('create'), undefined)
  } finally { branch.close() }
})
test('tampered preview or changed policy refuses creation', async t => {
  const value = await setup(t), preview = structuredClone(value.preview)
  preview.source.repositoryRevision++
  rejects(() => forkRepositoryToDirectory(value.source, value.target, preview, 'fork', host), 'E_BRANCH_PREVIEW')
  rejects(() => fork(value, { policy: { allowUnknownFields: true } }), 'E_BRANCH_PREVIEW')
  assert.equal(discoverRepositoryFork(value.target).status, 'absent')
})
test('source lock prevents competing parent commit through target seal', async t => {
  const value = await setup(t), parent = openRepositoryV2(value.source), before = await readFile(value.source)
  try {
    fork(value, { unsafeTestPhase(name) {
      if (name !== 'before-seal') return
      rejects(() => parent.apply(noop(parent.state().revision, 'racing')), 'E_REPO_OUTCOME_UNKNOWN')
      assert.equal(parent.findOperation('racing'), undefined)
    } })
    assert.deepEqual(await readFile(value.source), before)
    assert.equal(parent.apply(noop(parent.state().revision, 'after-fork')).status, 'committed')
  } finally { parent.close() }
})
test('WAL source is refused instead of taking an unprotected snapshot', async t => {
  const value = await setup(t), db = new DatabaseSync(value.source)
  try { db.exec('PRAGMA journal_mode=WAL') } finally { db.close() }
  rejects(() => previewRepositoryFork(value.source), 'E_BRANCH_SOURCE_JOURNAL')
})
test('existing target and async hook never overwrite a partially created fork', async t => {
  const value = await setup(t); await mkdir(value.target); await writeFile(path.join(value.target, 'keep.txt'), 'unchanged')
  rejects(() => fork(value), 'E_BRANCH_INCOMPLETE')
  assert.equal(await readFile(path.join(value.target, 'keep.txt'), 'utf8'), 'unchanged')
  const target = path.join(value.root, 'async')
  rejects(() => fork({ ...value, target }, { unsafeTestPhase: () => Promise.resolve() }), 'E_BRANCH_ASYNC_HOOK')
  assert.equal(discoverRepositoryFork(target).status, 'incomplete')
})
for (const phase of ['directory-created', 'metadata-written', 'before-seal', 'completed']) test('creation exception at ' + phase + ' is safely discoverable', async t => {
  const value = await setup(t), before = await readFile(value.source)
  assert.throws(() => fork(value, { unsafeTestPhase(name) { if (name === phase) throw new Error('synthetic failure') } }))
  const result = discoverRepositoryFork(value.target)
  assert.equal(result.status, phase === 'completed' ? 'completed' : 'incomplete')
  if (phase === 'completed') assert.deepEqual(fork(value), result)
  else rejects(() => fork(value), 'E_BRANCH_INCOMPLETE')
  assert.deepEqual(await readFile(value.source), before)
})
for (const phase of ['locked', 'state-written', 'before-commit', 'committed']) test('save exception at ' + phase + ' preserves atomic local history', async t => {
  const value = await setup(t); fork(value)
  const branch = openRepositoryBranch(value.target, { ...host, unsafeTestPhase(name) { if (name === phase) throw new Error('synthetic failure') } })
  assert.throws(() => branch.apply(update(value.preview.archive.state))); branch.close()
  const reopened = openRepositoryBranch(value.target, host)
  try {
    assert.equal(reopened.state().revision, phase === 'committed' ? 5 : 4)
    assert.equal(reopened.snapshot().history.length, phase === 'committed' ? 1 : 0)
    assert.equal(reopened.findOperation('child-save')?.status, phase === 'committed' ? 'committed' : undefined)
    assert.equal(reopened.state().world.entries[0].fields.note, phase === 'committed' ? 'child-change' : undefined)
  } finally { reopened.close() }
})
test('stale connection and nested discovery cannot steal transaction ownership', async t => {
  const value = await setup(t); fork(value)
  let first
  first = openRepositoryBranch(value.target, { ...host, unsafeTestPhase(name) { if (name === 'state-written') rejects(() => first.findOperation('child-save'), 'E_REPO_BUSY') } })
  const other = openRepositoryBranch(value.target, host)
  try {
    first.apply(noop(4)); rejects(() => other.apply(noop(4, 'stale')), 'E_REPO_STALE')
    assert.equal(other.state().revision, 5)
  } finally { first.close(); other.close() }
})
test('archive corruption, current-state tampering and wrong logical/storage version are refused', async t => {
  const value = await setup(t); fork(value)
  const db = new DatabaseSync(path.join(value.target, 'world.sqlite'))
  try {
    const stored = db.prepare('SELECT payload,digest FROM branch_metadata').get(), metadata = JSON.parse(stored.payload)
    metadata.sourceArchive.history[0].request.action.proposal.reason = 'tampered'
    db.prepare('UPDATE branch_metadata SET payload=?,digest=?').run(JSON.stringify(metadata), digest(metadata))
    assert.throws(() => discoverRepositoryFork(value.target))
    db.prepare('UPDATE branch_metadata SET payload=?,digest=?').run(stored.payload, stored.digest)
    const stateRow = db.prepare('SELECT payload,digest FROM branch_current').get(), state = JSON.parse(stateRow.payload)
    state.revision++
    db.prepare('UPDATE branch_current SET payload=?,digest=?').run(JSON.stringify(state), digest(state))
    rejects(() => discoverRepositoryFork(value.target), 'E_BRANCH_CHAIN')
    db.prepare('UPDATE branch_current SET payload=?,digest=?').run(stateRow.payload, stateRow.digest)
    db.exec('PRAGMA user_version=5'); rejects(() => discoverRepositoryFork(value.target), 'E_BRANCH_VERSION')
  } finally { db.close() }
})
test('v3 is an explicit new envelope and cannot be read as old v2', async t => {
  const value = await setup(t); fork(value)
  const branch = openRepositoryBranch(value.target, host)
  try { assert.throws(() => readRepositoryV2(branch.snapshot())) } finally { branch.close() }
})
test('even rehashed local history cannot adopt parent identity as a local receipt', async t => {
  const value = await setup(t); fork(value)
  const branch = openRepositoryBranch(value.target, host)
  try { branch.apply(noop(4)) } finally { branch.close() }
  const db = new DatabaseSync(path.join(value.target, 'world.sqlite'))
  try {
    const row = JSON.parse(db.prepare('SELECT payload FROM branch_history').get().payload)
    row.receipt.identity = value.preview.archive.identity
    db.prepare('UPDATE branch_history SET payload=?,digest=?').run(JSON.stringify(row), digest(row))
  } finally { db.close() }
  rejects(() => discoverRepositoryFork(value.target), 'E_BRANCH_FOREIGN_OPERATION')
})
async function killWorker(value, phase, action = 'fork') {
  const spec = path.join(value.root, 'worker-' + action + '-' + phase + '.json')
  await writeFile(spec, JSON.stringify({ ...value, phase, action, request: update(value.preview.archive.state) }))
  const child = spawn(process.execPath, [fileURLToPath(new URL('./world-store-branch.worker.mjs', import.meta.url)), spec], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const exited = once(child, 'exit'); exited.catch(() => {}); child.stderr.resume()
  try {
    await new Promise((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => reject(new Error('Synthetic branch worker phase timeout')), 7000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Synthetic branch worker exited early')) })
      child.stdout.on('data', bytes => { output += bytes; if (output.includes(`paused:${phase}\n`)) { clearTimeout(timer); resolve() } })
    })
    assert.equal(child.kill('SIGKILL'), true)
    const [code, signal] = await exited
    assert.ok(signal === 'SIGKILL' || (code !== null && code !== 0))
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited } }
}
for (const phase of ['directory-created', 'metadata-written', 'before-seal', 'completed']) test('real process exit while creating at ' + phase, async t => {
  const value = await setup(t), before = await readFile(value.source)
  await killWorker(value, phase)
  assert.deepEqual(await readFile(value.source), before)
  const outcome = discoverRepositoryFork(value.target)
  if (phase === 'completed') { assert.equal(outcome.status, 'completed'); assert.deepEqual(fork(value), outcome) }
  else {
    assert.ok(['incomplete', 'recovery-required'].includes(outcome.status))
    assert.throws(() => fork(value))
  }
})
for (const phase of ['state-written', 'before-commit', 'committed']) test('real process exit while saving at ' + phase, async t => {
  const value = await setup(t); fork(value)
  await killWorker(value, phase, 'save')
  // Explicit writable open allows SQLite's own DELETE journal recovery; readonly
  // discovery never silently performs recovery writes or recreates a branch.
  const branch = openRepositoryBranch(value.target, host)
  try {
    const committed = phase === 'committed'
    assert.equal(branch.state().revision, committed ? 5 : 4)
    assert.equal(branch.snapshot().history.length, committed ? 1 : 0)
    assert.equal(branch.findOperation('child-save')?.status, committed ? 'committed' : undefined)
    assert.equal(branch.state().world.entries[0].fields.note, committed ? 'child-change' : undefined)
  } finally { branch.close() }
  assert.equal(discoverRepositoryFork(value.target).status, 'completed')
})
test('copy with a hot journal is refused before recovery can mutate copied bytes', async t => {
  const value = await setup(t); fork(value)
  await killWorker(value, 'state-written', 'save')
  const copy = path.join(value.root, 'interrupted-copy'); await cp(value.target, copy, { recursive: true })
  const dbFile = path.join(copy, 'world.sqlite'), journal = path.join(copy, 'world.sqlite-journal')
  const before = await readFile(dbFile), beforeJournal = await readFile(journal)
  rejects(() => openRepositoryBranch(copy, host), 'E_BRANCH_BINDING')
  assert.deepEqual(await readFile(dbFile), before)
  assert.deepEqual(await readFile(journal), beforeJournal)
})
