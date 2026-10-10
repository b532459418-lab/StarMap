import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, rm, cp, copyFile, rename, readFile, writeFile, link, unlink, symlink } from 'node:fs/promises'
import { realpathSync, existsSync, renameSync, copyFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn, execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { seed, candidate, NOW } from './world-store-repository.fixture.mjs'
import { readRepositoryState } from './world-store-repository.mjs'
import { createRepositoryV2, openRepositoryV2 } from './world-store-repository-v2.mjs'
import { openRepositoryBranch } from './world-store-branch.mjs'
import { readRepositoryArchive } from './world-store-branch-snapshot.mjs'
import { repositoryStateDigest as digest } from './world-store-repository-v2-contract.mjs'
import { createRepositoryMergeStoreHost, previewRepositoryMergeStoreCreation, createRepositoryMergeStore,
  openRepositoryMergeStore, discoverRepositoryMergeStore, recoverRepositoryMergeStore,
  MERGE_STORE_APP_ID, MERGE_STORE_SQLITE_VERSION } from './world-store-branch-merge-store.mjs'
import { createRepositoryMergeStoreOperationRequest as operation, createRepositoryMergeStoreRequest as merge,
  previewRepositoryMergeStore as previewMerge } from './world-store-branch-merge-store-contract.mjs'

const worker = fileURLToPath(new URL('./world-store-branch-merge-store.worker.mjs', import.meta.url))
const refuses = (action, code) => assert.throws(action, error => code ? error.code === code : typeof error.code === 'string')
async function setup(t, authorize = () => true) {
  const parent = realpathSync(tmpdir()), lab = await mkdtemp(path.join(parent, 'starmap-merge-store-'))
  const stores = [], children = []
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
    }
    for (const store of stores.reverse()) { try { store.close() } catch { /* Already explicitly closed. */ } }
    assert.equal(path.dirname(path.resolve(lab)), parent); assert.ok(path.basename(lab).startsWith('starmap-merge-store-'))
    await rm(lab, { recursive: true, force: true })
  })
  const host = createRepositoryMergeStoreHost({ sandboxRoot: lab, hostId: 'synthetic-host', authorize })
  const source = path.join(lab, 'native'), a = path.join(lab, 'a'), b = path.join(lab, 'b')
  await mkdir(source)
  const state = readRepositoryState({ format: 'starmap.world-repository', formatVersion: 1, revision: 0, world: seed().world,
    identities: { format: 'starmap.v2-store-identities', version: 1, identities: [] }, proposals: [], retired: [] })
  const archive = { format: 'starmap.world-repository-v2', formatVersion: 2,
    identity: { libraryId: 'synthetic-family', branchId: 'native-source', genesisId: 'initial' },
    baseline: { sourceVersion: 1, sourceDigest: digest(state), coverage: 'baselineOnly', state, receipts: [] }, history: [], state }
  createRepositoryV2(path.join(source, 'world.sqlite'), archive).close()
  return { lab, host, source, a, b, stores, children }
}
function create(value, target = value.a, id = 'create-a', options = {}) {
  const config = { host: value.host, ...options }, preview = previewRepositoryMergeStoreCreation(value.source, config)
  return createRepositoryMergeStore(value.source, target, preview, id, config)
}
function open(t, value, target = value.a, options = {}) {
  const store = openRepositoryMergeStore(target, { host: value.host, ...options })
  value.stores.push(store)
  return store
}
function editRequest(store, id, note) {
  const saved = store.snapshot(), row = saved.projection.state.world.entries[0]
  return operation({ id, expectedRevision: saved.projection.state.revision, action: { kind: 'commands', commands: [
    { op: 'update', table: 'entries', id: row.id, expectedRevision: row.revision,
      value: { ...row, revision: row.revision + 1, fields: { ...row.fields, note } } },
  ] } }, saved)
}
function mergeRequest(target, source, id) {
  const saved = target.snapshot(), incoming = source.snapshot(), { catalogue } = previewMerge(saved, incoming)
  const choices = catalogue.items.map(row => ({ itemId: row.itemId, choice: row.allowedChoices.includes('source') ? 'source' : 'target' }))
  return merge(id, saved, incoming, choices)
}
async function pausedWorker(t, value, spec) {
  const file = path.join(value.lab, 'worker-' + Math.random().toString(16).slice(2) + '.json')
  await writeFile(file, JSON.stringify({ sandboxRoot: value.lab, target: value.a, ...spec }))
  const child = spawn(process.execPath, [worker, file], { cwd: path.dirname(worker), stdio: ['ignore', 'pipe', 'pipe'] })
  value.children.push(child)
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk.toString() })
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Worker phase not reached: ' + stdout + stderr)) }, 25000)
    const inspect = () => { if (stdout.includes('paused:' + spec.phase)) { clearTimeout(timer); resolve() } }
    child.stdout.on('data', inspect)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Worker exited before phase: ' + code + ' ' + stdout + stderr)) })
    inspect()
  })
  return child
}
async function stop(child) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited }

test('withSnapshot holds a real read transaction through synchronous callback and expires its verifier', async t => {
  const value = await setup(t); create(value)
  const store = open(t, value, value.a, { readOnly: true }), before = store.snapshot()
  let escaped
  const result = store.withSnapshot((saved, verify) => {
    assert.deepEqual(saved, before); assert.ok(Object.isFrozen(saved)); assert.ok(Object.isFrozen(saved.events))
    verify(); escaped = verify
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      'import {DatabaseSync} from "node:sqlite"; const db=new DatabaseSync(process.argv[1],{timeout:0}); try {db.exec("BEGIN EXCLUSIVE"); process.exitCode=3} catch(e) {console.log(e.errcode); process.exitCode=0} finally {db.close()}',
      path.join(value.a, 'world.sqlite')], { encoding: 'utf8', timeout: 10000 })
    assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /5/)
    refuses(() => store.snapshot(), 'E_REPO_BUSY')
    refuses(() => store.apply(editRequestFromSaved(saved)), 'E_REPO_READONLY')
    return 'complete'
  })
  assert.equal(result, 'complete'); refuses(() => escaped(), 'E_MERGE_STORE_ASYNC')
  assert.deepEqual(store.snapshot(), before)
  const db = new DatabaseSync(path.join(value.a, 'world.sqlite'), { timeout: 0 })
  try { db.exec('BEGIN EXCLUSIVE; ROLLBACK') } finally { db.close() }
})

function editRequestFromSaved(saved) {
  const row = saved.projection.state.world.entries[0]
  return operation({ id: 'readonly-refused', expectedRevision: saved.projection.state.revision,
    action: { kind: 'commands', commands: [{ op: 'update', table: 'entries', id: row.id, expectedRevision: row.revision,
      value: { ...row, revision: row.revision + 1, fields: { ...row.fields, note: 'refused' } } }] } }, saved)
}

test('withSnapshot rejects async/nonfunction callbacks and releases every failed read transaction', async t => {
  const value = await setup(t); create(value)
  const store = open(t, value), before = store.snapshot()
  refuses(() => store.withSnapshot(undefined), 'E_MERGE_STORE_ASYNC')
  refuses(() => store.withSnapshot(async () => before), 'E_MERGE_STORE_ASYNC')
  refuses(() => store.withSnapshot(() => ({ then() {} })), 'E_MERGE_STORE_ASYNC')
  refuses(() => store.withSnapshot(() => { throw new Error('callback failed') }), 'E_MERGE_STORE_IO')
  assert.deepEqual(store.snapshot(), before)
  assert.equal(store.apply(editRequest(store, 'after-failed-read', 'still writable')).status, 'committed')
})

test('withSnapshot verifies marker both before seal and after callback without changing original receipt rules', async t => {
  const value = await setup(t); create(value)
  const store = open(t, value, value.a, { readOnly: true }), before = store.snapshot()
  const marker = path.join(value.a, 'binding.json'), original = await readFile(marker)
  try {
    refuses(() => store.withSnapshot((_saved, verify) => { writeFileSync(marker, '{}'); verify() }), 'E_MERGE_STORE_BINDING')
  } finally { writeFileSync(marker, original) }
  try {
    refuses(() => store.withSnapshot(() => { writeFileSync(marker, '{}'); return 'unverified' }), 'E_MERGE_STORE_BINDING')
  } finally { writeFileSync(marker, original) }
  assert.deepEqual(store.snapshot(), before); assert.equal(store.findOperation('readonly-refused'), undefined)
})

test('initial creation commits a distinct schema and a complete native anchor with fresh identity', async t => {
  const value = await setup(t), before = await readFile(path.join(value.source, 'world.sqlite'))
  const result = create(value), store = open(t, value), saved = store.snapshot()
  assert.equal(result.status, 'created'); assert.equal(saved.events.length, 0)
  assert.notEqual(result.identity.branchId, saved.baseArchive.sourceArchive.identity.branchId)
  assert.match(result.identity.branchId, /^[a-f0-9-]{36}$/)
  assert.deepEqual(store.findOperation('create-a'), undefined)
  assert.deepEqual(await readFile(path.join(value.source, 'world.sqlite')), before)
  const db = new DatabaseSync(path.join(value.a, 'world.sqlite'), { readOnly: true })
  try { assert.equal(db.prepare('PRAGMA application_id').get().application_id, MERGE_STORE_APP_ID); assert.equal(db.prepare('PRAGMA user_version').get().user_version, MERGE_STORE_SQLITE_VERSION) } finally { db.close() }
  refuses(() => openRepositoryBranch(value.a, { hostId: 'synthetic-host' }))
  refuses(() => readRepositoryArchive(saved))
})

test('existing schema one exposes no restore preview and authorized maintenance does not upgrade it', async t => {
  const value = await setup(t); create(value)
  const store = open(t, value), before = store.snapshot()
  assert.equal(store.restorePreview(), undefined)
  recoverRepositoryMergeStore(value.a, { host: value.host })
  assert.deepEqual(store.snapshot(), before); assert.equal(store.restorePreview(), undefined)
  const db = new DatabaseSync(path.join(value.a, 'world.sqlite'), { readOnly: true })
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, MERGE_STORE_SQLITE_VERSION)
    assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name='store_initialization_receipt'").get().count, 0)
  } finally { db.close() }
})

test('creation retry discovers original IDs even after source and target have advanced', async t => {
  const value = await setup(t), preview = previewRepositoryMergeStoreCreation(value.source, { host: value.host })
  const result = createRepositoryMergeStore(value.source, value.a, preview, 'create-a', { host: value.host }), store = open(t, value)
  store.apply(editRequest(store, 'edit', 'child'))
  const native = openRepositoryV2(path.join(value.source, 'world.sqlite'))
  try {
    const row = native.state().world.entries[0]
    native.apply({ id: 'native-edit', expectedRevision: 0, action: { kind: 'commands', commands: [{ op: 'update', table: 'entries', id: row.id,
      expectedRevision: row.revision, value: { ...row, revision: row.revision + 1, fields: { ...row.fields, note: 'parent' } } }] } })
  } finally { native.close() }
  assert.deepEqual(createRepositoryMergeStore(value.source, value.a, preview, 'create-a', { host: value.host }), result)
  refuses(() => createRepositoryMergeStore(value.source, value.a, preview, 'other', { host: value.host }), 'E_MERGE_STORE_EXISTS')
  const forged = structuredClone(preview); forged.archive.state.world.entries[0].fields.note = 'forged'
  refuses(() => createRepositoryMergeStore(value.source, value.a, forged, 'create-a', { host: value.host }), 'E_MERGE_STORE_EXISTS')
})

test('empty replacements and empty copied stores are binding errors rather than incomplete creations', async t => {
  const value = await setup(t); create(value)
  const replacement = path.join(value.lab, 'empty.sqlite'); await writeFile(replacement, '')
  const file = path.join(value.a, 'world.sqlite'); await rename(file, path.join(value.lab, 'old.sqlite')); await rename(replacement, file)
  refuses(() => discoverRepositoryMergeStore(value.a, { host: value.host }), 'E_MERGE_STORE_BINDING')
  refuses(() => recoverRepositoryMergeStore(value.a, { host: value.host }), 'E_MERGE_STORE_BINDING')
  const other = await setup(t); create(other); const copy = path.join(other.lab, 'copy'); await cp(other.a, copy, { recursive: true })
  await writeFile(path.join(copy, 'world.sqlite'), '')
  refuses(() => openRepositoryMergeStore(copy, { host: other.host }), 'E_MERGE_STORE_BINDING')
})

test('path changes during trusted open authorization reject before any writable SQLite open', async t => {
  const value = await setup(t); create(value)
  const originalFile = path.join(value.a, 'world.sqlite'), before = await readFile(originalFile)
  const marker = path.join(value.a, 'binding.json'), replacement = path.join(value.lab, 'replacement.json')
  copyFileSync(marker, replacement)
  const host = createRepositoryMergeStoreHost({ sandboxRoot: value.lab, hostId: 'synthetic-host', authorize(spec) {
    if (spec.kind === 'open') { renameSync(marker, path.join(value.lab, 'old-marker.json')); renameSync(replacement, marker) }
    return true
  } })
  refuses(() => openRepositoryMergeStore(value.a, { host }), 'E_MERGE_STORE_BINDING')
  assert.deepEqual(await readFile(originalFile), before)
})

test('a marker changed at the last pre-COMMIT checkpoint rolls back the entire operation', async t => {
  const value = await setup(t); create(value)
  const file = path.join(value.a, 'binding.json'), original = path.join(value.lab, 'original-marker.json'), replacement = path.join(value.lab, 'replacement-marker.json')
  copyFileSync(file, replacement)
  const store = open(t, value, value.a, { unsafeTestPhase(stage) {
    if (stage === 'before-commit') { renameSync(file, original); renameSync(replacement, file) }
  } })
  const before = store.snapshot(), request = editRequest(store, 'attempt', 'rejected')
  refuses(() => store.apply(request), 'E_MERGE_STORE_BINDING')
  await unlink(file); await rename(original, file)
  assert.deepEqual(store.snapshot(), before); assert.equal(store.findOperation('attempt'), undefined)
})

for (const name of ['world.sqlite', 'binding.json']) {
  test('creation detects ' + name + ' replacement before the first SQLite writable open', async t => {
    const value = await setup(t)
    refuses(() => create(value, value.a, 'create-a', { unsafeTestPhase(stage) {
      if (stage === 'files-created') {
        const file = path.join(value.a, name), copy = path.join(value.lab, 'replacement-' + name)
        copyFileSync(file, copy); renameSync(file, path.join(value.lab, 'old-' + name)); renameSync(copy, file)
      }
    } }), 'E_MERGE_STORE_BINDING')
    assert.equal((await readFile(path.join(value.a, 'world.sqlite'))).length, 0)
    // No metadata was committed. The unchanged empty DB still matches its
    // marker after a marker-only replacement, so discovery is incomplete;
    // database inode replacement remains a binding error. Neither can resume.
    refuses(() => openRepositoryMergeStore(value.a, { host: value.host }),
      name === 'world.sqlite' ? 'E_MERGE_STORE_BINDING' : 'E_MERGE_STORE_INCOMPLETE')
  })
}

test('recovery COMMIT result loss is unknown while logical events and state remain unchanged', async t => {
  const value = await setup(t); create(value); const store = open(t, value), before = store.snapshot(); store.close()
  refuses(() => recoverRepositoryMergeStore(value.a, { host: value.host, unsafeTestPhase(name) {
    if (name === 'recovered') throw new Error('maintenance result lost')
  } }), 'E_REPO_OUTCOME_UNKNOWN')
  const again = open(t, value)
  assert.deepEqual(again.snapshot(), before); assert.equal(again.findOperation('maintenance'), undefined)
})

test('worker and host reject out-of-laboratory paths before opening requested files', async t => {
  const outside = path.join(realpathSync(tmpdir()), 'outside-does-not-exist', 'worker-private.json')
  await assert.rejects(promisify(execFile)(process.execPath, [worker, outside]), error =>
    error.stderr.includes('Invalid synthetic worker scope') && !error.stderr.includes('ENOENT'))
  refuses(() => createRepositoryMergeStoreHost({ sandboxRoot: path.dirname(outside), hostId: 'synthetic-host' }), 'E_MERGE_STORE_LAB')
  const value = await setup(t)
  refuses(() => discoverRepositoryMergeStore(path.join(realpathSync(tmpdir()), 'not-owned'), { host: value.host }), 'E_MERGE_STORE_PATH')
})

test('ordinary edits merge edit merge survive reopen with full sources and local receipts', async t => {
  const value = await setup(t); create(value); create(value, value.b, 'create-b')
  const a = open(t, value), b = open(t, value, value.b)
  const first = a.apply(editRequest(a, 'edit-a', 'first'))
  const merged = b.apply(mergeRequest(b, a, 'merge-b'), { source: value.a })
  assert.equal(merged.status, 'committed'); assert.equal(b.state().world.entries[0].fields.note, 'first')
  assert.equal(b.findOperation('edit-a'), undefined)
  assert.deepEqual(b.snapshot().events[0].storeRequest.sourceArchive.events[0].receipt, first)
  b.apply(editRequest(b, 'edit-b', 'second'))
  a.apply(mergeRequest(a, b, 'merge-a'), { source: value.b })
  const snapshot = a.snapshot(); a.close()
  const again = open(t, value)
  assert.deepEqual(again.snapshot(), snapshot); assert.equal(again.state().world.entries[0].fields.note, 'second')
  assert.equal(again.snapshot().projection.formatVersion, 2)
  assert.equal(again.findOperation('edit-b'), undefined)
  assert.equal(again.snapshot().projection.persisted, false)
})

test('same local request is idempotent; different request under the same ID conflicts', async t => {
  const value = await setup(t); create(value)
  const store = open(t, value), request = editRequest(store, 'save', 'once'), receipt = store.apply(request)
  assert.deepEqual(store.apply(request), receipt); assert.equal(store.snapshot().events.length, 1)
  refuses(() => store.apply({ ...request, targetSavedDigest: 'f'.repeat(64) }), 'E_REPO_OPERATION_CONFLICT')
  assert.deepEqual(store.findOperation('save'), receipt)
})

test('source namespace receipts never become local discovery while same foreign names are allowed', async t => {
  const value = await setup(t); create(value); create(value, value.b, 'create-b')
  const a = open(t, value), b = open(t, value, value.b), receipt = a.apply(editRequest(a, 'shared', 'incoming'))
  const result = b.apply(mergeRequest(b, a, 'shared'), { source: value.a })
  assert.notEqual(result.identity.branchId, receipt.identity.branchId)
  assert.deepEqual(b.findOperation('shared'), result)
  assert.deepEqual(b.snapshot().events[0].storeRequest.sourceArchive.events[0].receipt, receipt)
})

test('default denial and forged JSON contexts never authorize creation or writes', async t => {
  const value = await setup(t)
  const denied = createRepositoryMergeStoreHost({ sandboxRoot: value.lab, hostId: 'synthetic-host' })
  const preview = previewRepositoryMergeStoreCreation(value.source, { host: denied })
  refuses(() => createRepositoryMergeStore(value.source, value.a, preview, 'create', { host: denied }), 'E_MERGE_STORE_AUTHORITY')
  assert.equal(existsSync(value.a), false)
  refuses(() => createRepositoryMergeStore(value.source, value.a, preview, 'create', { host: { hostId: 'synthetic-host', permission: true } }), 'E_MERGE_STORE_AUTHORITY')
  assert.equal(existsSync(value.a), false)
})

test('authority is checked again under the write lock and may deny candidate acceptance', async t => {
  let allowed = true, seen = []
  const value = await setup(t, spec => { seen.push(spec); return allowed && spec.action !== 'accept-proposal' })
  create(value); const store = open(t, value)
  const saved = store.snapshot(), staged = operation({ id: 'stage', expectedRevision: saved.projection.state.revision,
    action: { kind: 'stage-proposal', proposal: candidate() } }, saved)
  store.apply(staged)
  const next = store.snapshot(), accepted = operation({ id: 'accept', expectedRevision: next.projection.state.revision,
    action: { kind: 'accept-proposal', proposalId: candidate().id, decision: { reviewId: 'review', acceptedAt: NOW } } }, next)
  refuses(() => store.apply(accepted), 'E_MERGE_STORE_AUTHORITY')
  assert.equal(store.state().proposals[0].status, 'pending'); assert.equal(store.findOperation('accept'), undefined)
  allowed = false
  refuses(() => store.apply(editRequest(store, 'revoked', 'bad')), 'E_MERGE_STORE_AUTHORITY')
  assert.ok(seen.some(spec => spec.kind === 'apply' && spec.action === 'accept-proposal'))
  assert.equal(store.snapshot().events.length, 1)
})

test('extra authorization fields, async authorizers and unsupported source models are refused', async t => {
  const value = await setup(t); create(value); const store = open(t, value)
  const request = editRequest(store, 'save', 'next')
  refuses(() => store.apply({ ...request, authority: true }))
  const asynchronous = createRepositoryMergeStoreHost({ sandboxRoot: value.lab, hostId: 'synthetic-host', authorize: async () => true })
  refuses(() => openRepositoryMergeStore(value.a, { host: asynchronous }), 'E_MERGE_STORE_ASYNC')
  assert.equal(store.snapshot().events.length, 0)
})

test('target and source freshness are both rechecked after the target lock', async t => {
  const value = await setup(t); create(value); create(value, value.b, 'create-b')
  const a = open(t, value), b = open(t, value, value.b), stale = editRequest(a, 'stale', 'old')
  a.apply(editRequest(a, 'other', 'new'))
  refuses(() => a.apply(stale), 'E_MERGE_STORE_STALE')
  const request = mergeRequest(b, a, 'merge')
  a.apply(editRequest(a, 'source-later', 'changed-source'))
  refuses(() => b.apply(request, { source: value.a }), 'E_MERGE_STORE_SOURCE_CHANGED')
  assert.equal(b.snapshot().events.length, 0)
})

test('copied stores remain readable but cannot open writable or recover', async t => {
  const value = await setup(t); create(value); const store = open(t, value)
  store.apply(editRequest(store, 'one', 'value')); const saved = store.snapshot(); store.close()
  const copy = path.join(value.lab, 'copy'); await cp(value.a, copy, { recursive: true })
  const reader = open(t, value, copy, { readOnly: true }); assert.deepEqual(reader.snapshot(), saved)
  const before = await readFile(path.join(copy, 'world.sqlite'))
  refuses(() => openRepositoryMergeStore(copy, { host: value.host }), 'E_MERGE_STORE_BINDING')
  refuses(() => recoverRepositoryMergeStore(copy, { host: value.host }), 'E_MERGE_STORE_BINDING')
  assert.deepEqual(await readFile(path.join(copy, 'world.sqlite')), before)
})

test('same-path database and marker inode replacements are refused across reopen', async t => {
  for (const name of ['world.sqlite', 'binding.json']) {
    const value = await setup(t); create(value)
    const file = path.join(value.a, name), replacement = path.join(value.lab, 'replacement-' + name)
    await copyFile(file, replacement); await rename(file, path.join(value.lab, 'original-' + name)); await rename(replacement, file)
    refuses(() => openRepositoryMergeStore(value.a, { host: value.host }), 'E_MERGE_STORE_BINDING')
  }
})

test('path aliases, symbolic roots and hardlinked databases refuse before writable recovery', async t => {
  const value = await setup(t); create(value)
  const alias = value.a + path.sep + '..' + path.sep + 'a'
  refuses(() => openRepositoryMergeStore(alias, { host: value.host }), 'E_MERGE_STORE_PATH')
  const symbolic = path.join(value.lab, 'symbolic')
  await symlink(value.a, symbolic, process.platform === 'win32' ? 'junction' : 'dir')
  refuses(() => openRepositoryMergeStore(symbolic, { host: value.host }), 'E_MERGE_STORE_PATH')
  const hard = path.join(value.lab, 'hard.sqlite'); await link(path.join(value.a, 'world.sqlite'), hard)
  refuses(() => openRepositoryMergeStore(value.a, { host: value.host }), 'E_MERGE_STORE_PATH')
  await unlink(hard)
})

test('a live handle detects inode replacement and a registered host detects laboratory replacement', async t => {
  const value = await setup(t); create(value); const store = open(t, value), request = editRequest(store, 'save', 'value')
  const file = path.join(value.a, 'world.sqlite'), replacement = path.join(value.lab, 'replacement.sqlite')
  await copyFile(file, replacement)
  if (process.platform === 'win32') {
    await assert.rejects(rename(file, path.join(value.lab, 'original.sqlite')), error => error.code === 'EBUSY')
    assert.ok(store.snapshot().savedDigest)
  } else {
    await rename(file, path.join(value.lab, 'original.sqlite')); await rename(replacement, file)
    refuses(() => store.apply(request), 'E_MERGE_STORE_BINDING')
  }
  store.close()
  const moved = value.lab + '-moved'; await rename(value.lab, moved); await mkdir(value.lab)
  t.after(async () => { assert.equal(path.dirname(moved), realpathSync(tmpdir())); assert.ok(path.basename(moved).startsWith('starmap-merge-store-')); await rm(moved, { recursive: true, force: true }) })
  refuses(() => discoverRepositoryMergeStore(value.a, { host: value.host }), 'E_MERGE_STORE_BINDING')
})

for (const table of ['source_archives', 'archive_nodes', 'store_current', 'store_events', 'local_receipts', 'store_metadata']) {
  test('missing ' + table + ' payload is rejected by full snapshot/discovery', async t => {
    const value = await setup(t); create(value); const store = open(t, value)
    store.apply(editRequest(store, 'one', 'changed')); store.close()
    const db = new DatabaseSync(path.join(value.a, 'world.sqlite'))
    try { db.exec('DELETE FROM ' + table) } finally { db.close() }
    refuses(() => discoverRepositoryMergeStore(value.a, { host: value.host }))
    refuses(() => openRepositoryMergeStore(value.a, { host: value.host }))
  })
}

test('a rehashed false receipt is still rejected and an additional SQL schema object is refused', async t => {
  const value = await setup(t); create(value); const store = open(t, value)
  store.apply(editRequest(store, 'one', 'changed')); store.close()
  const db = new DatabaseSync(path.join(value.a, 'world.sqlite'))
  try {
    const row = db.prepare('SELECT payload FROM local_receipts').get(), receipt = JSON.parse(row.payload)
    receipt.repositoryRevision++
    db.prepare('UPDATE local_receipts SET payload=?,digest=?').run(JSON.stringify(receipt), digest(receipt))
  } finally { db.close() }
  refuses(() => discoverRepositoryMergeStore(value.a, { host: value.host }))
  const other = await setup(t); create(other)
  const altered = new DatabaseSync(path.join(other.a, 'world.sqlite'))
  try { altered.exec('CREATE TABLE unexpected(x)') } finally { altered.close() }
  refuses(() => openRepositoryMergeStore(other.a, { host: other.host }), 'E_MERGE_STORE_SCHEMA')
})

test('post-COMMIT result loss reports unknown and readonly discovery finds the real receipt', async t => {
  const value = await setup(t); create(value)
  const store = open(t, value, value.a, { unsafeTestPhase(name) { if (name === 'committed') throw new Error('lost result') } })
  const request = editRequest(store, 'lost', 'committed')
  refuses(() => store.apply(request), 'E_REPO_OUTCOME_UNKNOWN'); store.close()
  const result = discoverRepositoryMergeStore(value.a, { host: value.host, operationId: 'lost' })
  assert.equal(result.operation.status, 'committed')
  const reopened = open(t, value); assert.deepEqual(reopened.apply(request), result.operation); assert.equal(reopened.snapshot().events.length, 1)
})

test('two processes competing on one target cannot both create a local commit', async t => {
  const value = await setup(t); create(value); const store = open(t, value)
  const first = editRequest(store, 'first', 'first'), second = editRequest(store, 'second', 'second')
  const child = await pausedWorker(t, value, { phase: 'locked', request: first })
  refuses(() => store.apply(second), 'E_REPO_BUSY')
  await stop(child)
  recoverRepositoryMergeStore(value.a, { host: value.host })
  store.close(); const again = open(t, value)
  const receipt = again.apply(second); assert.equal(receipt.status, 'committed'); assert.equal(again.findOperation('first'), undefined)
  assert.equal(again.snapshot().events.length, 1)
})

test('a real source read lock remains held until target COMMIT', async t => {
  const value = await setup(t); create(value); create(value, value.b, 'create-b')
  const a = open(t, value), b = open(t, value, value.b)
  a.apply(editRequest(a, 'a', 'source')); const request = mergeRequest(b, a, 'b'), sourceWrite = editRequest(a, 'late', 'late')
  const child = await pausedWorker(t, value, { target: value.b, phase: 'sources-written', request, source: value.a })
  try { refuses(() => a.apply(sourceWrite), 'E_REPO_OUTCOME_UNKNOWN') } finally { await stop(child) }
  // Both attempts were rolled back/terminated. Recovery never resends either.
  a.close(); b.close(); recoverRepositoryMergeStore(value.a, { host: value.host }); recoverRepositoryMergeStore(value.b, { host: value.host })
  const again = open(t, value); assert.equal(again.findOperation('late'), undefined)
})

for (const stage of ['locked', 'sources-written', 'state-written', 'receipt-written', 'before-commit', 'committed']) {
  test('process termination at ' + stage + ' leaves an entire old or new merged transaction', async t => {
    const value = await setup(t); create(value); create(value, value.b, 'create-b')
    const a = open(t, value), b = open(t, value, value.b)
    b.apply(editRequest(b, 'foreign', 'imported')); const before = a.snapshot(), request = mergeRequest(a, b, 'merge')
    a.close(); b.close()
    const child = await pausedWorker(t, value, { phase: stage, request, source: value.b })
    await stop(child)
    const observed = discoverRepositoryMergeStore(value.a, { host: value.host, operationId: 'merge' })
    assert.ok(['completed', 'recovery-required'].includes(observed.status))
    recoverRepositoryMergeStore(value.a, { host: value.host })
    const again = open(t, value), after = again.snapshot()
    if (stage === 'committed') {
      assert.equal(after.events.length, 1); assert.equal(again.findOperation('merge').status, 'committed')
      assert.equal(after.projection.state.world.entries[0].fields.note, 'imported')
    } else { assert.deepEqual(after, before); assert.equal(again.findOperation('merge'), undefined) }
    assert.equal(again.findOperation('foreign'), undefined)
  })
}

for (const stage of ['directory-created', 'files-created', 'before-create-commit']) {
  test('creation termination at ' + stage + ' stays incomplete without overwriting or automatic retry', async t => {
    const value = await setup(t), preview = previewRepositoryMergeStoreCreation(value.source, { host: value.host })
    const child = await pausedWorker(t, value, { kind: 'create', source: value.source, preview, operationId: 'create-a', phase: stage })
    await stop(child)
    assert.ok(['incomplete', 'recovery-required'].includes(discoverRepositoryMergeStore(value.a, { host: value.host }).status))
    refuses(() => createRepositoryMergeStore(value.source, value.a, preview, 'create-a', { host: value.host }))
  })
}
