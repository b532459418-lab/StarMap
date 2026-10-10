/** Synthetic package IO and crash evidence; never reads a private store. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, cp, readFile, writeFile, rename, symlink, link, unlink } from 'node:fs/promises'
import { realpathSync, existsSync, readFileSync, writeFileSync, renameSync, copyFileSync, truncateSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { seed, candidate, entry, NOW } from './world-store-repository.fixture.mjs'
import { readRepositoryState } from './world-store-repository.mjs'
import { createRepositoryV2 } from './world-store-repository-v2.mjs'
import { repositoryStateDigest as digest } from './world-store-repository-v2-contract.mjs'
import { readRepositoryArchive } from './world-store-branch-snapshot.mjs'
import { createRepositoryMergeStoreHost, previewRepositoryMergeStoreCreation, createRepositoryMergeStore,
  openRepositoryMergeStore, discoverRepositoryMergeStore, recoverRepositoryMergeStore } from './world-store-branch-merge-store.mjs'
import { createRepositoryMergeStoreOperationRequest as operation, createRepositoryMergeStoreRequest as merge,
  previewRepositoryMergeStore as previewMerge } from './world-store-branch-merge-store-contract.mjs'
import { createRepositoryMergeBackupHost, previewRepositoryMergeBackup, backupRepositoryMergeStore,
  verifyRepositoryMergeBackup, discoverRepositoryMergeBackup, openRepositoryMergeBackup,
  previewRepositoryMergeBackupRestore, restoreRepositoryMergeBackup, withVerifiedRepositoryMergeBackup } from './world-store-branch-merge-backup.mjs'

const worker = fileURLToPath(new URL('./world-store-branch-merge-backup.worker.mjs', import.meta.url))
const refuses = (action, code) => assert.throws(action, error => code ? error.code === code : typeof error.code === 'string')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
async function setup(t) {
  const parent = realpathSync(tmpdir()), lab = await mkdtemp(path.join(parent, 'starmap-merge-store-'))
  const stores = [], children = []
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
    }
    for (const store of stores.reverse()) { try { store.close() } catch { /* Explicitly closed already. */ } }
    assert.equal(path.dirname(path.resolve(lab)), parent)
    assert.ok(path.basename(lab).startsWith('starmap-merge-store-'))
    await rm(lab, { recursive: true, force: true })
  })
  const storeHost = createRepositoryMergeStoreHost({ sandboxRoot: lab, hostId: 'synthetic-host', authorize: () => true })
  const host = createRepositoryMergeBackupHost({ sandboxRoot: lab, hostId: 'synthetic-backup', authorize: () => true })
  const native = path.join(lab, 'native'), source = path.join(lab, 'source'), other = path.join(lab, 'other'), target = path.join(lab, 'package')
  await mkdir(native)
  const state = readRepositoryState({ format: 'starmap.world-repository', formatVersion: 1, revision: 0, world: seed().world,
    identities: { format: 'starmap.v2-store-identities', version: 1, identities: [] }, proposals: [], retired: [] })
  const archive = { format: 'starmap.world-repository-v2', formatVersion: 2,
    identity: { libraryId: 'synthetic-family', branchId: 'native-source', genesisId: 'initial' },
    baseline: { sourceVersion: 1, sourceDigest: digest(state), coverage: 'baselineOnly', state, receipts: [] }, history: [], state }
  createRepositoryV2(path.join(native, 'world.sqlite'), archive).close()
  for (const [root, id] of [[source, 'create-source'], [other, 'create-other']]) {
    createRepositoryMergeStore(native, root, previewRepositoryMergeStoreCreation(native, { host: storeHost }), id, { host: storeHost })
  }
  const store = openRepositoryMergeStore(source, { host: storeHost }); stores.push(store)
  return { lab, host, storeHost, source, other, target, store, stores, children }
}
function edit(store, id, note) {
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
function preview(value, options = {}) { return previewRepositoryMergeBackup(value.source, { host: value.host, ...options }) }
function backup(value, captured = preview(value), options = {}) {
  return backupRepositoryMergeStore(value.source, value.target, captured, 'backup-one', { host: value.host, ...options })
}
function checked(value) { return verifyRepositoryMergeBackup(value.target, { host: value.host }) }
async function pausedWorker(value, phase, overrides = {}) {
  const file = path.join(value.lab, 'worker-' + phase + '.json')
  await writeFile(file, JSON.stringify({ sandboxRoot: value.lab, source: value.source, target: value.target,
    preview: preview(value), operationId: 'backup-one', phase, ...overrides }))
  const child = spawn(process.execPath, [worker, file], { cwd: path.dirname(worker), stdio: ['ignore', 'pipe', 'pipe'] })
  value.children.push(child)
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk.toString() }); child.stderr.on('data', chunk => { stderr += chunk.toString() })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Worker phase not reached: ' + stdout + stderr)) }, 25000)
    const inspect = () => { if (stdout.includes('paused:' + phase)) { clearTimeout(timer); resolve() } }
    child.stdout.on('data', inspect)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Worker exited before phase: ' + code + ' ' + stdout + stderr)) })
    inspect()
  })
  return child
}
async function stop(child) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited }

test('backup preserves a complete edit/merge/edit/merge Saved and local versus foreign receipts', async t => {
  const value = await setup(t), foreign = openRepositoryMergeStore(value.other, { host: value.storeHost }); value.stores.push(foreign)
  value.store.apply(edit(value.store, 'local-edit', 'local'))
  foreign.apply(edit(foreign, 'foreign-edit', 'foreign'))
  value.store.apply(mergeRequest(value.store, foreign, 'merge-one'), { source: value.other })
  value.store.apply(edit(value.store, 'local-later', 'later'))
  foreign.apply(edit(foreign, 'foreign-later', 'final'))
  value.store.apply(mergeRequest(value.store, foreign, 'merge-two'), { source: value.other })
  const saved = value.store.snapshot(), identities = saved.projection.state.identities
  const beforeDb = await readFile(path.join(value.source, 'world.sqlite')), result = backup(value), data = checked(value)
  assert.equal(result.status, 'completed'); assert.equal(data.status, 'completed'); assert.deepEqual(data.saved, saved)
  assert.deepEqual(data.saved.projection.state.identities, identities)
  assert.deepEqual(await readFile(path.join(value.source, 'world.sqlite')), beforeDb)
  const reader = openRepositoryMergeBackup(value.target, { host: value.host })
  assert.deepEqual(reader.state(), saved.projection.state); assert.deepEqual(reader.snapshot(), saved)
  assert.deepEqual(reader.findArchivedOperation('local-edit'), { archived: true, receipt: saved.events[0].receipt })
  assert.equal(reader.findArchivedOperation('foreign-edit'), undefined)
  assert.equal(saved.events.length, 4); assert.equal(value.store.findOperation('backup-one'), undefined)
  assert.equal(reader.writableRestoreSupported, false); assert.equal(reader.executable, false)
  assert.equal(typeof reader.apply, 'undefined'); assert.equal(typeof reader.findOperation, 'undefined')
  assert.ok(Object.isFrozen(reader)); assert.ok(Object.isFrozen(reader.snapshot()))
})

test('candidate and review history stays archived without new approval or identity', async t => {
  const value = await setup(t), staged = value.store.snapshot()
  value.store.apply(operation({ id: 'stage', expectedRevision: staged.projection.state.revision,
    action: { kind: 'stage-proposal', proposal: candidate() } }, staged))
  const pending = value.store.snapshot()
  value.store.apply(operation({ id: 'accept', expectedRevision: pending.projection.state.revision,
    action: { kind: 'accept-proposal', proposalId: candidate().id, decision: { reviewId: 'review', acceptedAt: NOW } } }, pending))
  const saved = value.store.snapshot(); backup(value)
  assert.deepEqual(checked(value).saved, saved); assert.equal(checked(value).saved.events.length, 2)
  assert.equal(value.store.findOperation('backup-one'), undefined)
})

test('preview contains full Saved and policy without reserving a target or changing source', async t => {
  const value = await setup(t), before = value.store.snapshot(), captured = preview(value)
  assert.equal(captured.format, 'starmap.repository-merge-backup-preview'); assert.equal(captured.formatVersion, 1)
  assert.deepEqual(captured.saved, before); assert.equal(captured.savedDigest, before.savedDigest)
  assert.equal(captured.policyDigest, digest({})); assert.match(captured.previewDigest, /^[a-f0-9]{64}$/)
  assert.ok(Object.isFrozen(captured)); assert.equal(existsSync(value.target), false); assert.deepEqual(value.store.snapshot(), before)
})

test('a default context allows read preview but denies writing before target reservation', async t => {
  const value = await setup(t), host = createRepositoryMergeBackupHost({ sandboxRoot: value.lab, hostId: 'denied' })
  const captured = previewRepositoryMergeBackup(value.source, { host })
  refuses(() => backup(value, captured, { host }), 'E_MERGE_BACKUP_AUTHORITY'); assert.equal(existsSync(value.target), false)
})

test('plain JSON and a copied opaque context never mint backup authority', async t => {
  const value = await setup(t), captured = preview(value)
  for (const host of [{ hostId: 'synthetic-backup', permission: true }, { ...value.host }, structuredClone(value.host)]) {
    refuses(() => backup(value, captured, { host }), 'E_MERGE_BACKUP_AUTHORITY')
  }
  assert.equal(existsSync(value.target), false)
})

test('asynchronous authorizers fail before reservation', async t => {
  const value = await setup(t), host = createRepositoryMergeBackupHost({ sandboxRoot: value.lab, hostId: 'async', authorize: async () => true })
  refuses(() => backup(value, preview(value), { host }), 'E_MERGE_BACKUP_ASYNC'); assert.equal(existsSync(value.target), false)
})

test('revoked authority rejects the captured operation', async t => {
  const value = await setup(t); let allowed = true
  const host = createRepositoryMergeBackupHost({ sandboxRoot: value.lab, hostId: 'revocable', authorize: () => allowed })
  const captured = previewRepositoryMergeBackup(value.source, { host }); allowed = false
  refuses(() => backup(value, captured, { host }), 'E_MERGE_BACKUP_AUTHORITY'); assert.equal(existsSync(value.target), false)
})

test('source mutation after preview is stale and never reserves target', async t => {
  const value = await setup(t), captured = preview(value)
  value.store.apply(edit(value.store, 'later', 'changed'))
  refuses(() => backup(value, captured), 'E_MERGE_BACKUP_STALE'); assert.equal(existsSync(value.target), false)
})

test('all preview content is bound rather than accepting only its claimed digest', async t => {
  const value = await setup(t), captured = structuredClone(preview(value))
  captured.saved.projection.state.world.entries[0].fields.note = 'forged'
  refuses(() => backup(value, captured)); assert.equal(existsSync(value.target), false)
})

test('changed policy rejects an earlier preview', async t => {
  const value = await setup(t), captured = preview(value)
  refuses(() => backup(value, captured, { policy: { synthetic: true } })); assert.equal(existsSync(value.target), false)
})

test('same request discovers completed package after source changes and disappears', async t => {
  const value = await setup(t), captured = preview(value), original = backup(value, captured)
  const bytes = await readFile(path.join(value.target, 'complete.json'))
  value.store.apply(edit(value.store, 'later', 'new')); value.store.close()
  await rename(value.source, path.join(value.lab, 'source-gone'))
  assert.deepEqual(backup(value, captured), original)
  assert.deepEqual(await readFile(path.join(value.target, 'complete.json')), bytes)
})

test('same target under a different operation ID conflicts without replacing bytes', async t => {
  const value = await setup(t), captured = preview(value); backup(value, captured)
  const bytes = await readFile(path.join(value.target, 'complete.json'))
  refuses(() => backupRepositoryMergeStore(value.source, value.target, captured, 'different', { host: value.host }), 'E_MERGE_BACKUP_EXISTS')
  assert.deepEqual(await readFile(path.join(value.target, 'complete.json')), bytes)
})

test('same ID with different complete preview cannot reuse a sealed package', async t => {
  const value = await setup(t), captured = preview(value); backup(value, captured)
  const bytes = await readFile(path.join(value.target, 'complete.json'))
  value.store.apply(edit(value.store, 'later', 'changed'))
  refuses(() => backup(value, preview(value)), 'E_MERGE_BACKUP_EXISTS')
  assert.deepEqual(await readFile(path.join(value.target, 'complete.json')), bytes)
})

test('unknown and partial existing target directories are never overwritten', async t => {
  const value = await setup(t); await mkdir(value.target); await writeFile(path.join(value.target, 'unknown.txt'), 'preserve')
  refuses(() => backup(value), 'E_MERGE_BACKUP_INCOMPLETE')
  assert.equal(await readFile(path.join(value.target, 'unknown.txt'), 'utf8'), 'preserve')
})

test('restore preview captures complete package evidence but grants no execution or target authority', async t => {
  const value = await setup(t); backup(value)
  const result = previewRepositoryMergeBackupRestore(value.target, { host: value.host })
  assert.equal(result.format, 'starmap.repository-merge-backup-restore-preview')
  assert.equal(result.executable, false); assert.equal(result.persisted, false); assert.deepEqual(result.commands, [])
  assert.match(result.packageEvidenceDigest, /^[a-f0-9]{64}$/)
  assert.equal(result.savedDigest, checked(value).saved.savedDigest); assert.match(result.packageDigest, /^[a-f0-9]{64}$/)
})

test('actual restore commits a new schema/namespace and a separate local initialization receipt', async t => {
  const value = await setup(t)
  value.store.apply(edit(value.store, 'source-old-id', 'preserved'))
  backup(value)
  const root = path.join(value.lab, 'restored'), captured = previewRepositoryMergeBackupRestore(value.target, { host: value.host })
  const sourceBytes = await readFile(path.join(value.source, 'world.sqlite'))
  const receipt = restoreRepositoryMergeBackup(value.target, root, captured, 'restore-id', { host: value.host, restoreHost: value.storeHost })
  assert.equal(receipt.status, 'committed'); assert.equal(receipt.kind, 'restore')
  assert.equal(receipt.identity.libraryId, 'synthetic-family'); assert.notEqual(receipt.identity.branchId, value.store.snapshot().baseArchive.descriptor.identity.branchId)
  const restored = openRepositoryMergeStore(root, { host: value.storeHost }); value.stores.push(restored)
  const saved = restored.snapshot()
  assert.equal(saved.formatVersion, 2); assert.equal(saved.projection.formatVersion, 3)
  assert.deepEqual(saved.initialization.receipt, receipt); assert.deepEqual(restored.findOperation('restore-id'), receipt)
  assert.equal(restored.findOperation('source-old-id'), undefined)
  assert.deepEqual(restored.state(), value.store.state()); assert.deepEqual(saved.baseArchive.sourceArchive, value.store.snapshot())
  assert.deepEqual(await readFile(path.join(value.source, 'world.sqlite')), sourceBytes)
  restored.apply(edit(restored, 'source-old-id', 'new namespace'))
  refuses(() => edit(restored, 'restore-id', 'reserved'), 'E_REPO_OPERATION_CONFLICT')
  assert.equal(restored.findOperation('source-old-id').identity.branchId, receipt.identity.branchId)
  assert.deepEqual(discoverRepositoryMergeStore(root, { host: value.storeHost, operationId: 'restore-id' }).operation, receipt)
})

test('restore default deny and backup-only contexts cannot reserve a target', async t => {
  const value = await setup(t); backup(value)
  const root = path.join(value.lab, 'restored'), captured = previewRepositoryMergeBackupRestore(value.target, { host: value.host })
  const denied = createRepositoryMergeStoreHost({ sandboxRoot: value.lab, hostId: 'synthetic-host' })
  refuses(() => restoreRepositoryMergeBackup(value.target, root, captured, 'restore-id', { host: value.host, restoreHost: denied }), 'E_MERGE_STORE_AUTHORITY')
  refuses(() => restoreRepositoryMergeBackup(value.target, root, captured, 'restore-id', { host: value.host, restoreHost: value.host }), 'E_MERGE_STORE_AUTHORITY')
  assert.equal(existsSync(root), false)
})

test('restore retry discovers the original identity/receipt after target edits and package deletion', async t => {
  const value = await setup(t); backup(value)
  const root = path.join(value.lab, 'restored'), captured = previewRepositoryMergeBackupRestore(value.target, { host: value.host })
  const options = { host: value.host, restoreHost: value.storeHost }
  const original = restoreRepositoryMergeBackup(value.target, root, captured, 'restore-id', options)
  const target = openRepositoryMergeStore(root, { host: value.storeHost }); value.stores.push(target)
  target.apply(edit(target, 'after-restore', 'edited'))
  await rm(value.target, { recursive: true })
  assert.deepEqual(restoreRepositoryMergeBackup(value.target, root, captured, 'restore-id', options), original)
  assert.equal(target.state().revision, 1)
  refuses(() => restoreRepositoryMergeBackup(value.target, root, captured, 'other-id', options), 'E_MERGE_STORE_EXISTS')
  const changed = structuredClone(captured); changed.packageEvidenceDigest = 'f'.repeat(64)
  refuses(() => restoreRepositoryMergeBackup(value.target, root, changed, 'restore-id', options), 'E_MERGE_STORE_EXISTS')
})

test('restored target can edit, merge an original Saved source, reopen and remain a complete backup source', async t => {
  const value = await setup(t); value.store.apply(edit(value.store, 'old-event', 'source baseline')); backup(value)
  const root = path.join(value.lab, 'restored'), captured = previewRepositoryMergeBackupRestore(value.target, { host: value.host })
  const receipt = restoreRepositoryMergeBackup(value.target, root, captured, 'restore-id', { host: value.host, restoreHost: value.storeHost })
  const target = openRepositoryMergeStore(root, { host: value.storeHost }); value.stores.push(target)
  target.apply(edit(target, 'local-event', 'restored edit'))
  value.store.apply(edit(value.store, 'upstream-event', 'upstream edit'))
  target.apply(mergeRequest(target, value.store, 'merge-original'), { source: value.source })
  target.apply(edit(target, 'last-event', 'after merge'))
  const saved = target.snapshot(); target.close()
  const reopened = openRepositoryMergeStore(root, { host: value.storeHost }); value.stores.push(reopened)
  assert.deepEqual(reopened.snapshot(), saved); assert.deepEqual(reopened.findOperation('restore-id'), receipt)
  assert.equal(reopened.findOperation('upstream-event'), undefined)
  const next = path.join(value.lab, 'restored-package')
  const pkg = backupRepositoryMergeStore(root, next, previewRepositoryMergeBackup(root, { host: value.host }), 'backup-restored', { host: value.host })
  assert.deepEqual(pkg.saved, saved)
  assert.deepEqual(openRepositoryMergeBackup(next, { host: value.host }).findArchivedOperation('restore-id'), { archived: true, receipt })
})

for (const checkpoint of ['authorize', 'before-restore-commit']) {
  test('actual package byte changes at ' + checkpoint + ' cannot complete restore', async t => {
    const value = await setup(t); backup(value)
    const root = path.join(value.lab, 'restored'), captured = previewRepositoryMergeBackupRestore(value.target, { host: value.host })
    const file = path.join(value.target, 'saved.json'), original = await readFile(file)
    const mutate = () => writeFileSync(file, Buffer.from(' '.repeat(original.length)))
    const restoreHost = createRepositoryMergeStoreHost({ sandboxRoot: value.lab, hostId: 'synthetic-host', authorize() {
      if (checkpoint === 'authorize') mutate()
      return true
    } })
    refuses(() => restoreRepositoryMergeBackup(value.target, root, captured, 'restore-id', { host: value.host, restoreHost,
      unsafeTestPhase(name) { if (name === checkpoint) mutate() } }))
    if (checkpoint === 'authorize') assert.equal(existsSync(root), false)
    else assert.equal(discoverRepositoryMergeStore(root, { host: value.storeHost }).status, 'incomplete')
    writeFileSync(file, original)
  })
}

test('captured restore preview cannot silently follow a re-encoded or changed valid package', async t => {
  const value = await setup(t); backup(value)
  const captured = previewRepositoryMergeBackupRestore(value.target, { host: value.host }), root = path.join(value.lab, 'restored')
  const manifestFile = path.join(value.target, 'complete.json'), manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2))
  refuses(() => restoreRepositoryMergeBackup(value.target, root, captured, 'restore-id', { host: value.host, restoreHost: value.storeHost }), 'E_MERGE_STORE_STALE')
  assert.equal(existsSync(root), false)
})

test('COMMIT result loss and post-COMMIT package verifier failure are unknown and never resent', async t => {
  const value = await setup(t); backup(value)
  const root = path.join(value.lab, 'restored'), captured = previewRepositoryMergeBackupRestore(value.target, { host: value.host })
  const file = path.join(value.target, 'saved.json'), original = await readFile(file)
  refuses(() => restoreRepositoryMergeBackup(value.target, root, captured, 'restore-id', { host: value.host, restoreHost: value.storeHost,
    unsafeTestPhase(name) { if (name === 'restored') writeFileSync(file, Buffer.from(' '.repeat(original.length))) } }), 'E_REPO_OUTCOME_UNKNOWN')
  const result = discoverRepositoryMergeStore(root, { host: value.storeHost, operationId: 'restore-id' })
  assert.equal(result.status, 'completed'); assert.equal(result.operation.kind, 'restore'); assert.equal(result.operation.status, 'committed')
  assert.deepEqual(restoreRepositoryMergeBackup(value.target, root, captured, 'restore-id', { host: value.host, restoreHost: value.storeHost }), result.operation)
})

for (const checkpoint of ['restore-directory-created', 'restore-files-created', 'restore-schema-written', 'restore-sources-written',
  'restore-state-written', 'restore-receipt-written', 'before-restore-commit', 'restored']) {
  test('real process termination at ' + checkpoint + ' never exposes a partial successful restore', async t => {
    const value = await setup(t); backup(value)
    const root = path.join(value.lab, 'restored'), captured = previewRepositoryMergeBackupRestore(value.target, { host: value.host })
    const child = await pausedWorker(value, checkpoint, { kind: 'restore', source: value.target, target: root, preview: captured, operationId: 'restore-id' })
    await stop(child)
    let found = discoverRepositoryMergeStore(root, { host: value.storeHost, operationId: 'restore-id' })
    if (found.status === 'recovery-required') found = recoverRepositoryMergeStore(root, { host: value.storeHost, operationId: 'restore-id' })
    if (checkpoint === 'restored') {
      assert.equal(found.status, 'completed'); assert.equal(found.operation.status, 'committed'); assert.equal(found.operation.kind, 'restore')
      const target = openRepositoryMergeStore(root, { host: value.storeHost, readOnly: true }); value.stores.push(target)
      assert.deepEqual(target.state(), value.store.state()); assert.equal(target.snapshot().events.length, 0)
    } else assert.equal(found.status, 'incomplete')
  })
}

for (const variant of ['missing receipt', 'rehashed receipt', 'extra schema']) {
  test('new restored schema refuses ' + variant + ' before writes or success discovery', async t => {
    const value = await setup(t); backup(value)
    const root = path.join(value.lab, 'restored'), captured = previewRepositoryMergeBackupRestore(value.target, { host: value.host })
    restoreRepositoryMergeBackup(value.target, root, captured, 'restore-id', { host: value.host, restoreHost: value.storeHost })
    const db = new DatabaseSync(path.join(root, 'world.sqlite'))
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2)
      if (variant === 'missing receipt') db.exec('DELETE FROM store_initialization_receipt')
      else if (variant === 'extra schema') db.exec('CREATE TABLE unexpected(value TEXT) STRICT')
      else {
        const receipt = JSON.parse(db.prepare('SELECT payload FROM store_initialization_receipt').get().payload)
        receipt.packageEvidenceDigest = 'f'.repeat(64)
        db.prepare('UPDATE store_initialization_receipt SET payload=?,digest=?').run(JSON.stringify(receipt), digest(receipt))
      }
    } finally { db.close() }
    refuses(() => openRepositoryMergeStore(root, { host: value.storeHost }))
    refuses(() => discoverRepositoryMergeStore(root, { host: value.storeHost }))
    refuses(() => restoreRepositoryMergeBackup(value.target, root, captured, 'restore-id', { host: value.host, restoreHost: value.storeHost }))
    const old = new DatabaseSync(path.join(value.source, 'world.sqlite'), { readOnly: true })
    try { assert.equal(old.prepare('PRAGMA user_version').get().user_version, 1) } finally { old.close() }
  })
}

test('parent replacement inside restore authorization fails before target creation', async t => {
  const value = await setup(t); backup(value)
  const parent = path.join(value.lab, 'parent'), root = path.join(parent, 'restored'); await mkdir(parent)
  const captured = previewRepositoryMergeBackupRestore(value.target, { host: value.host })
  const restoreHost = createRepositoryMergeStoreHost({ sandboxRoot: value.lab, hostId: 'synthetic-host', authorize() {
    renameSync(parent, path.join(value.lab, 'original-parent')); mkdirSync(parent); return true
  } })
  refuses(() => restoreRepositoryMergeBackup(value.target, root, captured, 'restore-id', { host: value.host, restoreHost }), 'E_MERGE_STORE_BINDING')
  assert.equal(existsSync(root), false)
})

for (const member of ['binding.json', 'world.sqlite']) {
  test('restore files-created hook replacement of ' + member + ' cannot reach a writable commit', async t => {
    const value = await setup(t); backup(value)
    const root = path.join(value.lab, 'restored'), captured = previewRepositoryMergeBackupRestore(value.target, { host: value.host })
    refuses(() => restoreRepositoryMergeBackup(value.target, root, captured, 'restore-id', { host: value.host, restoreHost: value.storeHost,
      unsafeTestPhase(name) {
        if (name === 'restore-files-created') {
          const file = path.join(root, member), moved = path.join(value.lab, 'original-' + member)
          renameSync(file, moved); copyFileSync(moved, file)
        }
      } }), 'E_MERGE_STORE_BINDING')
    assert.equal((await readFile(path.join(root, 'world.sqlite'))).length, 0)
  })
}

test('copied restored databases remain readonly and cannot be rebound by restore retries', async t => {
  const value = await setup(t); backup(value)
  const root = path.join(value.lab, 'restored'), copy = path.join(value.lab, 'copied'), captured = previewRepositoryMergeBackupRestore(value.target, { host: value.host })
  restoreRepositoryMergeBackup(value.target, root, captured, 'restore-id', { host: value.host, restoreHost: value.storeHost })
  await cp(root, copy, { recursive: true })
  const reader = openRepositoryMergeStore(copy, { host: value.storeHost, readOnly: true }); value.stores.push(reader)
  assert.equal(reader.snapshot().formatVersion, 2)
  refuses(() => openRepositoryMergeStore(copy, { host: value.storeHost }), 'E_MERGE_STORE_BINDING')
  refuses(() => restoreRepositoryMergeBackup(value.target, copy, captured, 'restore-id', { host: value.host, restoreHost: value.storeHost }), 'E_MERGE_STORE_BINDING')
})

test('a restore target inside its package or source store refuses without corrupting existing members', async t => {
  const value = await setup(t); backup(value)
  const captured = previewRepositoryMergeBackupRestore(value.target, { host: value.host })
  for (const parent of [value.target, value.source]) {
    const root = path.join(parent, 'restored')
    refuses(() => restoreRepositoryMergeBackup(value.target, root, captured, 'restore-id', { host: value.host, restoreHost: value.storeHost }), 'E_MERGE_STORE_PATH')
    assert.equal(existsSync(root), false)
  }
  assert.equal(checked(value).status, 'completed'); assert.equal(value.store.snapshot().formatVersion, 1)
})

test('a complete restored Saved v2 can be backed up and restored again without collapsing provenance', async t => {
  const value = await setup(t); backup(value)
  const firstRoot = path.join(value.lab, 'first-restored'), firstPreview = previewRepositoryMergeBackupRestore(value.target, { host: value.host })
  const firstReceipt = restoreRepositoryMergeBackup(value.target, firstRoot, firstPreview, 'restore-id', { host: value.host, restoreHost: value.storeHost })
  const first = openRepositoryMergeStore(firstRoot, { host: value.storeHost }); value.stores.push(first)
  first.apply(edit(first, 'first-edit', 'new first branch'))
  const firstSaved = first.snapshot(), secondPackage = path.join(value.lab, 'second-package')
  backupRepositoryMergeStore(firstRoot, secondPackage, previewRepositoryMergeBackup(firstRoot, { host: value.host }), 'backup-second', { host: value.host })
  const secondRoot = path.join(value.lab, 'second-restored'), secondPreview = previewRepositoryMergeBackupRestore(secondPackage, { host: value.host })
  const secondReceipt = restoreRepositoryMergeBackup(secondPackage, secondRoot, secondPreview, 'restore-id', { host: value.host, restoreHost: value.storeHost })
  const second = openRepositoryMergeStore(secondRoot, { host: value.storeHost }); value.stores.push(second)
  assert.notEqual(secondReceipt.identity.branchId, firstReceipt.identity.branchId)
  assert.deepEqual(second.snapshot().baseArchive.sourceArchive, firstSaved)
  assert.deepEqual(second.findOperation('restore-id'), secondReceipt); assert.equal(second.findOperation('first-edit'), undefined)
  assert.deepEqual(second.state(), first.state())
  second.apply(edit(second, 'first-edit', 'same ID distinct current namespace'))
  assert.equal(second.findOperation('first-edit').identity.branchId, secondReceipt.identity.branchId)
  assert.deepEqual(second.snapshot().baseArchive.sourceArchive.initialization.receipt, firstReceipt)
})

test('pinned package verifier cannot escape its synchronous scope and callback failure closes source handles', async t => {
  const value = await setup(t); backup(value)
  let escaped
  const result = withVerifiedRepositoryMergeBackup(value.target, { host: value.host }, (pkg, verify) => {
    verify(); escaped = verify; assert.ok(Object.isFrozen(pkg.saved)); return pkg.saved.savedDigest
  })
  assert.equal(result, checked(value).saved.savedDigest)
  refuses(() => escaped(), 'E_MERGE_BACKUP_ASYNC')
  refuses(() => withVerifiedRepositoryMergeBackup(value.target, { host: value.host }, async () => 'async'), 'E_MERGE_BACKUP_ASYNC')
  refuses(() => withVerifiedRepositoryMergeBackup(value.target, { host: value.host }, () => { throw new Error('failed callback') }), 'E_MERGE_BACKUP_IO')
  const moved = path.join(value.lab, 'moved-package'); await rename(value.target, moved)
  assert.equal(verifyRepositoryMergeBackup(moved, { host: value.host }).status, 'completed')
})

test('restore authorization cannot replace the caller preview selected before authorization', async t => {
  const value = await setup(t); backup(value)
  const root = path.join(value.lab, 'restored'), captured = previewRepositoryMergeBackupRestore(value.target, { host: value.host })
  const input = structuredClone(captured)
  const restoreHost = createRepositoryMergeStoreHost({ sandboxRoot: value.lab, hostId: 'synthetic-host', authorize() {
    input.forkPreview = { mutated: true }; input.packageEvidenceDigest = 'f'.repeat(64); return true
  } })
  const receipt = restoreRepositoryMergeBackup(value.target, root, input, 'restore-id', { host: value.host, restoreHost })
  assert.equal(receipt.packageEvidenceDigest, captured.packageEvidenceDigest)
  const target = openRepositoryMergeStore(root, { host: value.storeHost, readOnly: true }); value.stores.push(target)
  assert.deepEqual(target.restorePreview(), captured)
})

test('pinned package callbacks preserve falsy thrown failures rather than reporting an empty success', async t => {
  const value = await setup(t); backup(value)
  for (const failure of [undefined, null, 0, false, '']) {
    refuses(() => withVerifiedRepositoryMergeBackup(value.target, { host: value.host }, () => { throw failure }), 'E_MERGE_BACKUP_IO')
  }
  assert.equal(checked(value).status, 'completed')
})

test('copied package opens only as an unchanged read-only archived Saved', async t => {
  const value = await setup(t); value.store.apply(edit(value.store, 'one', 'saved')); backup(value)
  const copy = path.join(value.lab, 'copied'); await cp(value.target, copy, { recursive: true })
  const before = await readFile(path.join(copy, 'saved.json')), reader = openRepositoryMergeBackup(copy, { host: value.host })
  assert.deepEqual(reader.snapshot(), value.store.snapshot()); assert.equal(typeof reader.apply, 'undefined')
  assert.deepEqual(await readFile(path.join(copy, 'saved.json')), before)
  refuses(() => readRepositoryArchive(reader.snapshot()))
})

test('an absent package is discoverable without creating files', async t => {
  const value = await setup(t)
  assert.equal(discoverRepositoryMergeBackup(value.target, { host: value.host }).status, 'absent')
  assert.equal(existsSync(value.target), false)
})

for (const missing of ['saved.json', 'complete.json']) {
  test('missing ' + missing + ' cannot be reported as completed', async t => {
    const value = await setup(t); backup(value); await unlink(path.join(value.target, missing))
    refuses(() => checked(value))
    if (missing === 'saved.json') refuses(() => discoverRepositoryMergeBackup(value.target, { host: value.host }), 'E_MERGE_BACKUP_INCOMPLETE')
    else assert.equal(discoverRepositoryMergeBackup(value.target, { host: value.host }).status, 'incomplete')
  })
}

for (const member of ['saved.json', 'complete.json']) {
  test('truncated ' + member + ' is refused', async t => {
    const value = await setup(t); backup(value); truncateSync(path.join(value.target, member), 9)
    refuses(() => checked(value))
  })
}

test('changed bytes fail even when valid JSON remains', async t => {
  const value = await setup(t); backup(value); const file = path.join(value.target, 'saved.json')
  await writeFile(file, await readFile(file, 'utf8') + ' ')
  refuses(() => checked(value), 'E_MERGE_BACKUP_CORRUPT')
})

test('additional member names are refused instead of silently ignored', async t => {
  const value = await setup(t); backup(value); await writeFile(path.join(value.target, 'extra.json'), '{}')
  refuses(() => checked(value))
})

test('a claimed saved member path cannot redirect reads outside the fixed package files', async t => {
  const value = await setup(t); backup(value); const file = path.join(value.target, 'complete.json')
  const manifest = JSON.parse(await readFile(file, 'utf8')); manifest.snapshot.file = '../native/world.sqlite'
  await writeFile(file, JSON.stringify(manifest)); refuses(() => checked(value))
})

test('unsupported manifest version is rejected', async t => {
  const value = await setup(t); backup(value); const file = path.join(value.target, 'complete.json')
  const manifest = JSON.parse(await readFile(file, 'utf8')); manifest.formatVersion = 999
  await writeFile(file, JSON.stringify(manifest)); refuses(() => checked(value))
})

test('oversize sparse saved member is refused before parsing allocation', async t => {
  const value = await setup(t); backup(value); truncateSync(path.join(value.target, 'saved.json'), 128 * 1024 * 1024 + 1)
  refuses(() => checked(value), 'E_MERGE_BACKUP_SIZE')
})

test('relative and parent aliases are refused before accessing supplied paths', async t => {
  const value = await setup(t), captured = preview(value)
  refuses(() => backupRepositoryMergeStore(value.source, 'package', captured, 'backup-one', { host: value.host }), 'E_MERGE_BACKUP_PATH')
  refuses(() => backupRepositoryMergeStore(value.source, value.lab + path.sep + 'x' + path.sep + '..' + path.sep + 'package', captured, 'backup-one', { host: value.host }), 'E_MERGE_BACKUP_PATH')
  refuses(() => previewRepositoryMergeBackup(path.join(value.lab, '..', 'not-a-store'), { host: value.host }))
})

test('symbolic package roots and hardlinked members are rejected', async t => {
  const value = await setup(t); backup(value)
  const symbolic = path.join(value.lab, 'symbolic'); await symlink(value.target, symbolic, process.platform === 'win32' ? 'junction' : 'dir')
  refuses(() => verifyRepositoryMergeBackup(symbolic, { host: value.host }), 'E_MERGE_BACKUP_PATH')
  const hard = path.join(value.lab, 'hard.json'); await link(path.join(value.target, 'saved.json'), hard)
  refuses(() => checked(value), 'E_MERGE_BACKUP_PATH'); await unlink(hard)
})

test('symbolic saved member is not followed', async t => {
  const value = await setup(t); backup(value)
  const file = path.join(value.target, 'saved.json'), original = path.join(value.lab, 'saved-original.json')
  await rename(file, original)
  // Windows file symlinks require an OS privilege; a junction is a real
  // symbolic member available to the ordinary user and must also be refused.
  await symlink(process.platform === 'win32' ? value.lab : original, file, process.platform === 'win32' ? 'junction' : 'file')
  refuses(() => checked(value), 'E_MERGE_BACKUP_PATH')
})

test('target directory replacement during reservation is rejected before sealing', async t => {
  const value = await setup(t), captured = preview(value), moved = path.join(value.lab, 'original-package')
  refuses(() => backup(value, captured, { unsafeTestPhase(phase) {
    if (phase === 'reserved') { renameSync(value.target, moved); writeFileSync(value.target, '') }
  } }))
  assert.equal(existsSync(path.join(moved, 'complete.json')), false)
})

test('saved file inode replacement before seal is rejected even with identical bytes', async t => {
  const value = await setup(t), captured = preview(value)
  refuses(() => backup(value, captured, { unsafeTestPhase(phase) {
    if (phase === 'before-seal') {
      const file = path.join(value.target, 'saved.json'), replacement = path.join(value.lab, 'replacement.json')
      copyFileSync(file, replacement); renameSync(file, path.join(value.lab, 'original.json')); renameSync(replacement, file)
    }
  } }))
  assert.equal(existsSync(path.join(value.target, 'complete.json')), false)
})

test('source marker replacement at seal checkpoint prevents complete package publication', async t => {
  const value = await setup(t), captured = preview(value), marker = path.join(value.source, 'binding.json')
  const replacement = path.join(value.lab, 'marker-copy.json'), original = path.join(value.lab, 'marker-original.json')
  copyFileSync(marker, replacement)
  refuses(() => backup(value, captured, { unsafeTestPhase(phase) {
    if (phase === 'before-seal') { renameSync(marker, original); renameSync(replacement, marker) }
  } }), 'E_MERGE_STORE_BINDING')
  assert.equal(existsSync(path.join(value.target, 'complete.json')), false)
})

test('source read transaction prevents an independent SQLite writer from committing through seal', async t => {
  const value = await setup(t), before = value.store.snapshot(); let observed = false
  const script = "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec('PRAGMA busy_timeout=100'); try {db.exec('BEGIN IMMEDIATE'); db.exec('UPDATE store_metadata SET recovery_epoch=recovery_epoch+1'); db.exec('COMMIT'); console.log(JSON.stringify({committed:true}));} catch(error) {console.log(JSON.stringify({busy:error.errcode===5 || /locked/.test(error.message)})); try{db.exec('ROLLBACK')}catch{}} finally{db.close()}"
  backup(value, preview(value), { unsafeTestPhase(phase) {
    if (phase === 'before-seal') {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, path.join(value.source, 'world.sqlite')], { timeout: 15000, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout.trim()), { busy: true }); observed = true
    }
  } })
  assert.equal(observed, true); assert.deepEqual(value.store.snapshot(), before); assert.deepEqual(checked(value).saved, before)
})

test('asynchronous stage hooks cannot silently release a source snapshot lock', async t => {
  const value = await setup(t)
  refuses(() => backup(value, preview(value), { unsafeTestPhase: async () => true }), 'E_MERGE_BACKUP_ASYNC')
  assert.equal(existsSync(path.join(value.target, 'complete.json')), false)
  value.store.apply(edit(value.store, 'after-refusal', 'unlocked')); assert.ok(value.store.findOperation('after-refusal'))
})

test('seal result loss reports outcome unknown while discovery proves complete immutable package', async t => {
  const value = await setup(t), captured = preview(value)
  refuses(() => backup(value, captured, { unsafeTestPhase(phase) { if (phase === 'sealed') throw new Error('Synthetic result loss') } }), 'E_MERGE_BACKUP_OUTCOME_UNKNOWN')
  const found = discoverRepositoryMergeBackup(value.target, { host: value.host }); assert.equal(found.status, 'completed')
  assert.deepEqual(found.saved, captured.saved); assert.equal(value.store.findOperation('backup-one'), undefined)
})

for (const phase of ['reserved', 'snapshot-written', 'before-seal', 'sealed']) {
  test('real worker termination at ' + phase + ' never advertises a partial package as completed', async t => {
    const value = await setup(t), before = value.store.snapshot(), child = await pausedWorker(value, phase); await stop(child)
    const found = discoverRepositoryMergeBackup(value.target, { host: value.host })
    assert.equal(found.status, phase === 'sealed' ? 'completed' : 'incomplete')
    if (phase === 'sealed') assert.deepEqual(found.saved, before)
    else refuses(() => checked(value))
    assert.deepEqual(value.store.snapshot(), before); assert.equal(value.store.findOperation('backup-one'), undefined)
  })
}

test('worker input rejects out-of-laboratory paths before reading arbitrary JSON', () => {
  const result = spawnSync(process.execPath, [worker, path.join(realpathSync(tmpdir()), 'worker-not-owned.json')], { timeout: 10000, encoding: 'utf8' })
  assert.notEqual(result.status, 0); assert.match(result.stderr, /scope|synthetic/i); assert.doesNotMatch(result.stderr, /ENOENT/)
})

test('two real backup processes competing for one target seal at most one distinct request', async t => {
  const value = await setup(t), captured = preview(value), module = new URL('./world-store-branch-merge-backup.mjs', import.meta.url).href
  const script = "import{readFileSync}from'node:fs';const api=await import(process.argv[1]);const s=JSON.parse(readFileSync(process.argv[2],'utf8'));const host=api.createRepositoryMergeBackupHost({sandboxRoot:s.lab,hostId:'synthetic-race',authorize:()=>true});try{const r=api.backupRepositoryMergeStore(s.source,s.target,s.preview,s.id,{host});console.log(JSON.stringify({status:r.status,id:r.manifest.operationId}));}catch(e){console.log(JSON.stringify({code:e.code}));}"
  const launch = id => {
    const specFile = path.join(value.lab, 'worker-' + id + '.json')
    writeFileSync(specFile, JSON.stringify({ lab: value.lab, source: value.source, target: value.target, preview: captured, id }))
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, module, specFile], { stdio: ['ignore', 'pipe', 'pipe'] })
    value.children.push(child)
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString() }); child.stderr.on('data', chunk => { stderr += chunk.toString() })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Competing worker deadline: ' + stderr)) }, 25000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error('Competing worker failed: ' + stderr)); else resolve(JSON.parse(stdout.trim())) })
    })
  }
  const results = await Promise.all([launch('race-one'), launch('race-two')])
  assert.equal(results.filter(row => row.status === 'completed').length, 1, JSON.stringify(results))
  assert.ok(results.some(row => ['E_MERGE_BACKUP_EXISTS', 'E_MERGE_BACKUP_INCOMPLETE'].includes(row.code)), JSON.stringify(results))
  const found = checked(value); assert.equal(found.manifest.operationId, results.find(row => row.status === 'completed').id)
  assert.deepEqual(found.saved, captured.saved); assert.equal(value.store.findOperation('race-one'), undefined)
})

test('registered lab identity detects replacement rather than trusting the same path string', async t => {
  const value = await setup(t); backup(value); value.store.close()
  const moved = value.lab + '-original'; await rename(value.lab, moved); await mkdir(value.lab)
  t.after(async () => {
    assert.equal(path.dirname(moved), realpathSync(tmpdir())); assert.ok(path.basename(moved).startsWith('starmap-merge-store-'))
    await rm(moved, { recursive: true, force: true })
  })
  refuses(() => checked(value), 'E_MERGE_BACKUP_PATH')
})

test('source marker replacement inside authorization is rejected before target reservation', async t => {
  const value = await setup(t), captured = preview(value), marker = path.join(value.source, 'binding.json')
  const replacement = path.join(value.lab, 'auth-copy.json'); copyFileSync(marker, replacement)
  const host = createRepositoryMergeBackupHost({ sandboxRoot: value.lab, hostId: 'synthetic-replace', authorize() {
    renameSync(marker, path.join(value.lab, 'auth-original.json')); renameSync(replacement, marker); return true
  } })
  refuses(() => backup(value, captured, { host }), 'E_MERGE_STORE_BINDING'); assert.equal(existsSync(value.target), false)
})

test('deletion history and permanent tombstones survive full package replay', async t => {
  const value = await setup(t), initial = value.store.snapshot(), row = entry(60)
  value.store.apply(operation({ id: 'create-for-delete', expectedRevision: initial.projection.state.revision,
    action: { kind: 'commands', commands: [{ op: 'create', table: 'entries', value: row }] } }, initial))
  const saved = value.store.snapshot()
  value.store.apply(operation({ id: 'delete', expectedRevision: saved.projection.state.revision,
    action: { kind: 'commands', commands: [{ op: 'remove', table: 'entries', id: row.id, expectedRevision: row.revision }] } }, saved))
  const after = value.store.snapshot(); assert.ok(after.projection.state.retired.some(item => item.id === row.id))
  backup(value); assert.deepEqual(checked(value).saved.projection.state.retired, after.projection.state.retired)
  assert.deepEqual(openRepositoryMergeBackup(value.target, { host: value.host }).findArchivedOperation('delete'), { archived: true, receipt: after.events[1].receipt })
})

for (const ancestor of ['source', 'other', 'package']) {
  test('a backup nested inside an existing ' + ancestor + ' root is refused without polluting its members', async t => {
    const value = await setup(t); if (ancestor === 'package') backup(value)
    const root = value[ancestor === 'package' ? 'target' : ancestor], target = path.join(root, 'nested-backup')
    const member = path.join(root, ancestor === 'package' ? 'saved.json' : 'world.sqlite'), before = await readFile(member)
    refuses(() => backupRepositoryMergeStore(value.source, target, preview(value), 'nested', { host: value.host }), 'E_MERGE_BACKUP_PATH')
    assert.equal(existsSync(target), false); assert.deepEqual(await readFile(member), before)
    assert.ok(value.store.snapshot().savedDigest)
  })
}

test('sealed complete file inode replacement reports unknown despite identical content', async t => {
  const value = await setup(t), captured = preview(value)
  refuses(() => backup(value, captured, { unsafeTestPhase(phase) {
    if (phase === 'sealed') {
      const seal = path.join(value.target, 'complete.json'), replacement = path.join(value.lab, 'seal-copy.json')
      copyFileSync(seal, replacement); renameSync(seal, path.join(value.lab, 'seal-original.json')); renameSync(replacement, seal)
    }
  } }), 'E_MERGE_BACKUP_OUTCOME_UNKNOWN')
  assert.equal(checked(value).status, 'completed'); assert.deepEqual(checked(value).saved, captured.saved)
})

test('invalid UTF8 is rejected even when replacement characters could form valid JSON', async t => {
  const value = await setup(t); backup(value)
  const file = path.join(value.target, 'saved.json'), original = await readFile(file)
  const malformed = Buffer.concat([original.subarray(0, original.length - 1), Buffer.from(',"extra":"'), Buffer.from([0xff]), Buffer.from('"}')])
  await writeFile(file, malformed)
  refuses(() => checked(value), 'E_MERGE_BACKUP_CORRUPT')
})

test('authorization cannot turn a generic target parent into a package before reservation', async t => {
  const value = await setup(t), parent = path.join(value.lab, 'generic-parent'); await mkdir(parent)
  value.target = path.join(parent, 'child'); const captured = preview(value), before = value.store.snapshot()
  const host = createRepositoryMergeBackupHost({ sandboxRoot: value.lab, hostId: 'synthetic-parent', authorize() {
    writeFileSync(path.join(parent, 'complete.json'), '{}'); return true
  } })
  refuses(() => backup(value, captured, { host }), 'E_MERGE_BACKUP_PATH')
  assert.equal(existsSync(value.target), false); assert.deepEqual(value.store.snapshot(), before)
  assert.equal(await readFile(path.join(parent, 'complete.json'), 'utf8'), '{}')
})

for (const checkpoint of ['reserved', 'snapshot-written', 'before-seal']) {
  test('a parent acquiring package membership at ' + checkpoint + ' prevents sealing', async t => {
    const value = await setup(t), parent = path.join(value.lab, 'generic-parent'); await mkdir(parent)
    value.target = path.join(parent, 'child'); const before = value.store.snapshot()
    refuses(() => backup(value, preview(value), { unsafeTestPhase(phase) {
      if (phase === checkpoint) writeFileSync(path.join(parent, 'saved.json'), '{}')
    } }), 'E_MERGE_BACKUP_PATH')
    assert.equal(existsSync(path.join(value.target, 'complete.json')), false)
    assert.equal(await readFile(path.join(parent, 'saved.json'), 'utf8'), '{}'); assert.deepEqual(value.store.snapshot(), before)
  })
}

for (const kind of ['getter', 'Proxy', 'cycle', 'function']) {
  test('preview input refuses ' + kind + ' without executing attacker accessors', async t => {
    const value = await setup(t), captured = structuredClone(preview(value)); let touched = false
    if (kind === 'getter') Object.defineProperty(captured, 'saved', { enumerable: true, get() { touched = true; throw new Error('must not execute') } })
    if (kind === 'Proxy') captured.saved = new Proxy(captured.saved, { get() { touched = true; throw new Error('must not execute') } })
    if (kind === 'cycle') captured.saved.loop = captured.saved
    if (kind === 'function') captured.saved.extra = () => true
    refuses(() => backup(value, captured)); assert.equal(touched, false); assert.equal(existsSync(value.target), false)
  })
}

/** Rehash every outer claim so Saved replay, rather than a stale envelope hash,
 * is what rejects the forged request/projection/receipt. */
function rehashPackage(value, mutate) {
  const savedFile = path.join(value.target, 'saved.json'), manifestFile = path.join(value.target, 'complete.json')
  const original = readFileSync(savedFile), saved = JSON.parse(original), manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  mutate(saved); const bytes = Buffer.from(JSON.stringify(saved)); writeFileSync(savedFile, bytes)
  manifest.savedDigest = saved.savedDigest
  manifest.snapshot = { file: 'saved.json', bytes: bytes.length, sha256: sha(bytes), digest: digest(saved) }
  manifest.previewDigest = digest({ format: 'starmap.repository-merge-backup-preview', formatVersion: 1,
    saved, savedDigest: saved.savedDigest, policyDigest: manifest.policyDigest })
  manifest.requestDigest = digest({ operationId: manifest.operationId, previewDigest: manifest.previewDigest })
  writeFileSync(manifestFile, JSON.stringify(manifest))
}

for (const section of ['projection', 'receipt', 'source']) {
  test('outer rehash does not hide forged ' + section + ' semantics', async t => {
    const value = await setup(t), foreign = openRepositoryMergeStore(value.other, { host: value.storeHost }); value.stores.push(foreign)
    foreign.apply(edit(foreign, 'foreign', 'incoming')); value.store.apply(mergeRequest(value.store, foreign, 'merge'), { source: value.other })
    backup(value)
    rehashPackage(value, saved => {
      if (section === 'projection') saved.projection.state.world.entries[0].fields.note = 'forged'
      if (section === 'receipt') saved.events[0].receipt.afterDigest = 'f'.repeat(64)
      if (section === 'source') saved.events[0].storeRequest.sourceArchive.events[0].receipt.afterDigest = 'f'.repeat(64)
      const raw = { ...saved }; delete raw.savedDigest; saved.savedDigest = digest(raw)
    })
    assert.throws(() => checked(value), error => error.code.startsWith('E_MERGE_STORE_'))
  })
}
