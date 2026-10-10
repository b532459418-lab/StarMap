import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, cp, copyFile, rename } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { seed } from './world-store-repository.fixture.mjs'
import { readRepositoryState } from './world-store-repository.mjs'
import { createRepositoryV2 } from './world-store-repository-v2.mjs'
import { repositoryStateDigest as digest } from './world-store-repository-v2-contract.mjs'
import { createRepositoryMergeStoreHost, previewRepositoryMergeStoreCreation, createRepositoryMergeStore,
  openRepositoryMergeStore } from './world-store-branch-merge-store.mjs'
import { createRepositoryMergeStoreOperationRequest as operation, createRepositoryMergeStoreRequest as merge,
  previewRepositoryMergeStore as previewMerge } from './world-store-branch-merge-store-contract.mjs'
import { createRepositoryMergeHostAuthority } from './world-store-branch-merge-host-authority.mjs'
import { createRepositoryMergeBackupHost, previewRepositoryMergeBackup, backupRepositoryMergeStore,
  previewRepositoryMergeBackupRestore, restoreRepositoryMergeBackup } from './world-store-branch-merge-backup.mjs'

const refuses = (action, code) => assert.throws(action, error => code ? error.code === code : typeof error.code === 'string')
async function setup(t, options = {}) {
  const parent = realpathSync(tmpdir()), lab = await mkdtemp(path.join(parent, 'starmap-merge-store-'))
  const stores = [], authorities = [], children = []
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
    }
    for (const authority of authorities) { try { authority.close() } catch { /* Explicitly closed earlier. */ } }
    for (const store of stores.reverse()) { try { store.close() } catch { /* Explicitly closed earlier. */ } }
    assert.equal(path.dirname(path.resolve(lab)), parent)
    assert.ok(path.basename(lab).startsWith('starmap-merge-store-'))
    assert.equal(realpathSync(lab), lab)
    await rm(lab, { recursive: true, force: true })
  })
  const host = createRepositoryMergeStoreHost({ sandboxRoot: lab, hostId: 'synthetic-host', authorize: () => true })
  const source = path.join(lab, 'native'), a = path.join(lab, 'a'), b = path.join(lab, 'b')
  await mkdir(source)
  const state = readRepositoryState({ format: 'starmap.world-repository', formatVersion: 1, revision: 0, world: seed().world,
    identities: { format: 'starmap.v2-store-identities', version: 1, identities: [] }, proposals: [], retired: [] })
  const archive = { format: 'starmap.world-repository-v2', formatVersion: 2,
    identity: { libraryId: 'synthetic-family', branchId: 'native-source', genesisId: 'initial' },
    baseline: { sourceVersion: 1, sourceDigest: digest(state), coverage: 'baselineOnly', state, receipts: [] }, history: [], state }
  createRepositoryV2(path.join(source, 'world.sqlite'), archive).close()
  for (const [root, id] of [[a, 'create-a'], [b, 'create-b']]) {
    const preview = previewRepositoryMergeStoreCreation(source, { host })
    createRepositoryMergeStore(source, root, preview, id, { host })
  }
  const authority = createRepositoryMergeHostAuthority({ sandboxRoot: lab, hostId: 'synthetic-host', ...options })
  authorities.push(authority)
  const session = authority.startSession()
  return { lab, host, a, b, source, authority, session, stores, authorities, children }
}
function external(value, root = value.a) {
  const store = openRepositoryMergeStore(root, { host: value.host }); value.stores.push(store); return store
}
function request(saved, id = 'edit', note = 'authorized') {
  const row = saved.projection.state.world.entries[0]
  return operation({ id, expectedRevision: saved.projection.state.revision, action: { kind: 'commands', commands: [
    { op: 'update', table: 'entries', id: row.id, expectedRevision: row.revision,
      value: { ...row, revision: row.revision + 1, fields: { ...row.fields, note } } },
  ] } }, saved)
}
function select(value, root = value.a) { return value.authority.select(value.session, root) }
function ready(value) {
  const selected = select(value); const saved = value.authority.snapshot(value.session)
  value.authority.enable(value.session, selected.selectionDigest)
  return { selected, saved, edit: request(saved) }
}

test('default approval denies real writes while selected snapshots remain readable', async t => {
  const value = await setup(t), selected = select(value), before = value.authority.snapshot(value.session)
  refuses(() => value.authority.enable(value.session, selected.selectionDigest), 'E_HOST_AUTHORITY')
  refuses(() => value.authority.apply(value.session, request(before)), 'E_HOST_AUTHORITY')
  assert.deepEqual(value.authority.snapshot(value.session), before)
  assert.equal(value.authority.findOperation(value.session, 'edit'), undefined)
})

test('opaque session and frozen selection expose no writable Store capability', async t => {
  const value = await setup(t), selected = select(value)
  assert.deepEqual(Object.keys(value.session), []); assert.ok(Object.isFrozen(value.session))
  assert.ok(Object.isFrozen(selected)); assert.ok(Object.isFrozen(selected.identity)); assert.ok(Object.isFrozen(selected.binding))
  assert.deepEqual(Object.keys(value.authority).sort(), ['apply', 'close', 'enable', 'findOperation', 'revoke', 'select', 'snapshot', 'startSession'])
  assert.equal(selected.root, value.a); assert.equal(selected.policyDigest, digest({}))
  assert.equal(selected.selectionDigest, digest({ root: selected.root, identity: selected.identity, binding: selected.binding,
    savedDigest: selected.savedDigest, policyDigest: selected.policyDigest }))
  refuses(() => value.authority.select({}, value.a), 'E_HOST_SESSION')
  refuses(() => value.authority.select(structuredClone(value.session), value.a), 'E_HOST_SESSION')
})

test('session from a different controller cannot select or grant a write', async t => {
  const value = await setup(t), other = createRepositoryMergeHostAuthority({ sandboxRoot: value.lab, hostId: 'synthetic-host', approve: () => true })
  value.authorities.push(other)
  refuses(() => other.select(value.session, value.a), 'E_HOST_SESSION')
  const otherSession = other.startSession()
  refuses(() => value.authority.select(otherSession, value.a), 'E_HOST_SESSION')
})

test('starting a replacement session revokes the prior selection and grant', async t => {
  const value = await setup(t, { approve: () => true }), { edit } = ready(value), old = value.session
  value.session = value.authority.startSession()
  refuses(() => value.authority.apply(old, edit), 'E_HOST_SESSION')
  refuses(() => value.authority.snapshot(value.session), 'E_HOST_SELECTION')
  select(value); assert.equal(value.authority.findOperation(value.session, 'edit'), undefined)
})

test('explicit revoke removes already approved write authority', async t => {
  const value = await setup(t, { approve: () => true }), { edit } = ready(value)
  value.authority.revoke(value.session)
  refuses(() => value.authority.apply(value.session, edit), 'E_HOST_SESSION')
  refuses(() => value.authority.snapshot(value.session), 'E_HOST_SESSION')
  assert.equal(external(value).findOperation('edit'), undefined)
})

test('expiry is reported once and permanently invalidates the session', async t => {
  let now = 10
  const value = await setup(t, { approve: () => true, clock: () => now })
  value.session = value.authority.startSession({ ttlMs: 100 }); const { edit } = ready(value)
  now = 110
  refuses(() => value.authority.apply(value.session, edit), 'E_HOST_SESSION_EXPIRED')
  now = 109; refuses(() => value.authority.snapshot(value.session), 'E_HOST_SESSION')
  assert.equal(external(value).findOperation('edit'), undefined)
})

test('invalid TTL requests do not replace a valid selected session', async t => {
  const value = await setup(t); select(value); const before = value.authority.snapshot(value.session)
  for (const ttlMs of [0, -1, 900001, 1.5, NaN, Infinity, '100']) {
    refuses(() => value.authority.startSession({ ttlMs }), 'E_HOST_SESSION')
  }
  assert.deepEqual(value.authority.snapshot(value.session), before)
})

test('monotonic clock rollback revokes the session before write', async t => {
  let now = 20
  const value = await setup(t, { approve: () => true, clock: () => now }), { edit } = ready(value)
  now = 19; refuses(() => value.authority.apply(value.session, edit), 'E_HOST_CLOCK')
  now = 21; refuses(() => value.authority.snapshot(value.session), 'E_HOST_SESSION')
  assert.equal(external(value).findOperation('edit'), undefined)
})

test('nonfinite clock cannot renew or use a grant', async t => {
  let now = 20
  const value = await setup(t, { approve: () => true, clock: () => now }), { edit } = ready(value)
  now = NaN; refuses(() => value.authority.apply(value.session, edit), 'E_HOST_CLOCK')
  now = 22; refuses(() => value.authority.snapshot(value.session), 'E_HOST_SESSION')
})

test('one approved attempt commits a real local receipt discoverable read only', async t => {
  const value = await setup(t, { approve: info => { assert.equal(info.syntheticOnly, true); assert.ok(Object.isFrozen(info)); return true } })
  const { selected, saved, edit } = ready(value), receipt = value.authority.apply(value.session, edit)
  assert.equal(receipt.status, 'committed'); assert.deepEqual(receipt.identity, selected.identity)
  assert.deepEqual(value.authority.findOperation(value.session, 'edit'), receipt)
  assert.equal(value.authority.findOperation(value.session, 'create-a'), undefined)
  assert.notEqual(value.authority.snapshot(value.session).savedDigest, saved.savedDigest)
  assert.equal(value.authority.snapshot(value.session).projection.state.world.entries[0].fields.note, 'authorized')
  refuses(() => value.authority.apply(value.session, edit), 'E_HOST_AUTHORITY')
  assert.equal(value.authority.snapshot(value.session).events.length, 1)
})

test('enable is not an automatic retry or refresh after the selected store advances', async t => {
  const value = await setup(t, { approve: () => true }), { selected, edit } = ready(value)
  const receipt = value.authority.apply(value.session, edit)
  refuses(() => value.authority.enable(value.session, selected.selectionDigest), 'E_HOST_STALE')
  assert.deepEqual(value.authority.findOperation(value.session, 'edit'), receipt)
  const refreshed = select(value), saved = value.authority.snapshot(value.session)
  value.authority.enable(value.session, refreshed.selectionDigest)
  const next = request(saved, 'edit-2', 'next')
  assert.equal(value.authority.apply(value.session, next).status, 'committed')
})

test('a refused malformed request still consumes the single explicit grant', async t => {
  const value = await setup(t, { approve: () => true }), { edit } = ready(value)
  const invalid = structuredClone(edit); invalid.kind = 'restore'
  refuses(() => value.authority.apply(value.session, invalid), 'E_HOST_AUTHORITY')
  refuses(() => value.authority.apply(value.session, edit), 'E_HOST_AUTHORITY')
  assert.equal(value.authority.findOperation(value.session, 'edit'), undefined)
})

test('failed selection clears the prior write grant and selected store', async t => {
  const value = await setup(t, { approve: () => true }), { edit } = ready(value)
  refuses(() => value.authority.select(value.session, path.join(value.lab, 'missing')))
  refuses(() => value.authority.apply(value.session, edit), 'E_HOST_AUTHORITY')
  refuses(() => value.authority.snapshot(value.session), 'E_HOST_SELECTION')
  assert.equal(external(value).findOperation('edit'), undefined)
})

test('selecting another library requires a new grant even for a legitimate request', async t => {
  const value = await setup(t, { approve: () => true }); ready(value); select(value, value.b)
  const saved = value.authority.snapshot(value.session)
  refuses(() => value.authority.apply(value.session, request(saved)), 'E_HOST_AUTHORITY')
  assert.equal(external(value, value.b).findOperation('edit'), undefined)
})

test('selection digest cannot be forged into an enable capability', async t => {
  const value = await setup(t, { approve: () => true }), selected = select(value)
  refuses(() => value.authority.enable(value.session, '0'.repeat(64)), 'E_HOST_SELECTION')
  refuses(() => value.authority.apply(value.session, request(value.authority.snapshot(value.session))), 'E_HOST_AUTHORITY')
  assert.equal(value.authority.enable(value.session, selected.selectionDigest).enabled, true)
})

test('external edit after enable invalidates freshness and leaves no attempted receipt', async t => {
  const value = await setup(t, { approve: () => true }), { edit } = ready(value), store = external(value)
  store.apply(request(store.snapshot(), 'external-edit', 'outside'))
  refuses(() => value.authority.apply(value.session, edit), 'E_HOST_STALE')
  assert.equal(store.findOperation('edit'), undefined); assert.equal(store.snapshot().events.length, 1)
  refuses(() => value.authority.apply(value.session, edit), 'E_HOST_AUTHORITY')
})

test('approval callback cannot authorize a selection it changed through another host', async t => {
  let value
  value = await setup(t, { approve: () => { const store = external(value); store.apply(request(store.snapshot(), 'approval-edit')); return true } })
  const selected = select(value)
  refuses(() => value.authority.enable(value.session, selected.selectionDigest), 'E_HOST_STALE')
  assert.equal(value.authority.findOperation(value.session, 'approval-edit').status, 'committed')
  refuses(() => value.authority.apply(value.session, request(value.authority.snapshot(value.session), 'broker-edit')), 'E_HOST_AUTHORITY')
})

test('physical database replacement with identical bytes breaks an existing grant', async t => {
  const value = await setup(t, { approve: () => true }), { edit } = ready(value)
  const file = path.join(value.a, 'world.sqlite'), replacement = path.join(value.lab, 'replacement.sqlite')
  await copyFile(file, replacement); await rename(file, path.join(value.lab, 'old.sqlite')); await rename(replacement, file)
  refuses(() => value.authority.apply(value.session, edit), 'E_HOST_SELECTION')
  refuses(() => external(value), 'E_MERGE_STORE_BINDING')
  await rename(file, path.join(value.lab, 'rejected.sqlite')); await rename(path.join(value.lab, 'old.sqlite'), file)
  assert.equal(external(value).findOperation('edit'), undefined)
})

test('physical marker replacement with identical bytes breaks read and write selection', async t => {
  const value = await setup(t, { approve: () => true }), { edit } = ready(value)
  const file = path.join(value.a, 'binding.json'), replacement = path.join(value.lab, 'replacement.json')
  await copyFile(file, replacement); await rename(file, path.join(value.lab, 'old.json')); await rename(replacement, file)
  refuses(() => value.authority.snapshot(value.session), 'E_HOST_SELECTION')
  refuses(() => value.authority.apply(value.session, edit), 'E_HOST_SELECTION')
})

test('copied relocation is readable by Store but not selectable for host writes', async t => {
  const value = await setup(t, { approve: () => true }), copy = path.join(value.lab, 'copy')
  await cp(value.a, copy, { recursive: true })
  const readonly = openRepositoryMergeStore(copy, { host: value.host, readOnly: true }); value.stores.push(readonly)
  assert.equal(readonly.snapshot().events.length, 0)
  refuses(() => value.authority.select(value.session, copy), 'E_HOST_SELECTION')
})

test('asynchronous approval is rejected without issuing a write grant', async t => {
  const value = await setup(t, { approve: async () => true }), selected = select(value)
  refuses(() => value.authority.enable(value.session, selected.selectionDigest), 'E_HOST_ASYNC')
  refuses(() => value.authority.apply(value.session, request(value.authority.snapshot(value.session))), 'E_HOST_AUTHORITY')
})

test('truthy approval values do not substitute for explicit true', async t => {
  const value = await setup(t, { approve: () => ({ approved: true }) }), selected = select(value)
  refuses(() => value.authority.enable(value.session, selected.selectionDigest), 'E_HOST_AUTHORITY')
})

test('caught nested approval calls poison the outer grant and preserve data', async t => {
  let value
  value = await setup(t, { approve: () => {
    refuses(() => value.authority.snapshot(value.session), 'E_HOST_BUSY')
    return true
  } })
  const selected = select(value), before = value.authority.snapshot(value.session)
  refuses(() => value.authority.enable(value.session, selected.selectionDigest), 'E_HOST_BUSY')
  refuses(() => value.authority.apply(value.session, request(before)), 'E_HOST_AUTHORITY')
  assert.deepEqual(value.authority.snapshot(value.session), before)
})

test('nested close and revoke cannot be caught to keep outer approval effective', async t => {
  let value
  value = await setup(t, { approve: () => {
    refuses(() => value.authority.close(), 'E_HOST_BUSY')
    refuses(() => value.authority.revoke(value.session), 'E_HOST_BUSY')
    return true
  } })
  const selected = select(value)
  refuses(() => value.authority.enable(value.session, selected.selectionDigest), 'E_HOST_BUSY')
  assert.equal(value.authority.snapshot(value.session).events.length, 0)
})

test('expiry during approval revokes the grant before writable Store open', async t => {
  let now = 0
  const value = await setup(t, { clock: () => now, approve: () => { now = 300000; return true } }), selected = select(value)
  refuses(() => value.authority.enable(value.session, selected.selectionDigest), 'E_HOST_SESSION_EXPIRED')
  assert.equal(external(value).snapshot().events.length, 0)
})

test('request policy and target digest are bound to the approved selection', async t => {
  const value = await setup(t, { approve: () => true })
  for (const key of ['policyDigest', 'targetSavedDigest']) {
    const { edit } = ready(value), altered = structuredClone(edit); altered[key] = '0'.repeat(64)
    refuses(() => value.authority.apply(value.session, altered), 'E_HOST_STALE')
    assert.equal(value.authority.findOperation(value.session, 'edit'), undefined)
  }
})

test('request operation ID tampering cannot commit or acquire a local receipt', async t => {
  const value = await setup(t, { approve: () => true }), { edit } = ready(value), altered = structuredClone(edit)
  altered.operationId = 'different'
  refuses(() => value.authority.apply(value.session, altered))
  assert.equal(value.authority.findOperation(value.session, 'edit'), undefined)
  assert.equal(value.authority.findOperation(value.session, 'different'), undefined)
})

test('ordinary operation refuses undeclared source and unsafe apply options', async t => {
  const value = await setup(t, { approve: () => true })
  let current = ready(value)
  refuses(() => value.authority.apply(value.session, current.edit, { source: value.b }), 'E_HOST_SELECTION')
  current = ready(value)
  refuses(() => value.authority.apply(value.session, current.edit, { host: value.host }), 'E_HOST_AUTHORITY')
  assert.equal(value.authority.findOperation(value.session, 'edit'), undefined)
})

function merging(value, id = 'merge') {
  const incoming = external(value, value.b).snapshot(), target = value.authority.snapshot(value.session)
  const { catalogue } = previewMerge(target, incoming)
  const choices = catalogue.items.map(row => ({ itemId: row.itemId, choice: row.allowedChoices.includes('source') ? 'source' : 'target' }))
  return merge(id, target, incoming, choices)
}

test('explicit source-bound merge commits its real target receipt while retaining foreign provenance', async t => {
  const value = await setup(t, { approve: () => true }), source = external(value, value.b)
  source.apply(request(source.snapshot(), 'source-edit', 'incoming'))
  const sourceBefore = source.snapshot(); ready(value); const incoming = merging(value)
  const receipt = value.authority.apply(value.session, incoming, { source: value.b })
  assert.equal(receipt.status, 'committed'); assert.equal(value.authority.findOperation(value.session, 'source-edit'), undefined)
  assert.deepEqual(value.authority.findOperation(value.session, 'merge'), receipt)
  assert.equal(value.authority.snapshot(value.session).projection.state.world.entries[0].fields.note, 'incoming')
  assert.deepEqual(source.snapshot(), sourceBefore)
})

test('merge refuses missing source and changed source contents without a target receipt', async t => {
  const value = await setup(t, { approve: () => true }); ready(value)
  let incoming = merging(value)
  refuses(() => value.authority.apply(value.session, incoming), 'E_HOST_SELECTION')
  ready(value); incoming = merging(value)
  const source = external(value, value.b); source.apply(request(source.snapshot(), 'late-source', 'late'))
  refuses(() => value.authority.apply(value.session, incoming, { source: value.b }))
  assert.equal(value.authority.findOperation(value.session, 'merge'), undefined)
  assert.equal(value.authority.snapshot(value.session).events.length, 0)
})

test('a clock callback cannot perform nested controller operations at a locked write boundary', async t => {
  let value, armed = false, ticks = 0, nested = 0
  value = await setup(t, { approve: () => true, clock: () => {
    ticks++
    if (armed) { nested++; refuses(() => value.authority.findOperation(value.session, 'edit'), 'E_HOST_BUSY') }
    return ticks
  } })
  const { edit } = ready(value); armed = true
  refuses(() => value.authority.apply(value.session, edit), 'E_HOST_BUSY')
  armed = false; assert.ok(nested > 0)
  assert.equal(value.authority.findOperation(value.session, 'edit'), undefined)
})

test('an external SQLite exclusive lock is rejected without consuming a successful receipt', async t => {
  const value = await setup(t, { approve: () => true }), { edit } = ready(value)
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    'import {DatabaseSync} from "node:sqlite";const db=new DatabaseSync(process.argv[1],{timeout:0});db.exec("BEGIN EXCLUSIVE");console.log("locked");process.stdin.once("data",()=>{db.exec("ROLLBACK");db.close();process.exit(0)});',
    path.join(value.a, 'world.sqlite')], { stdio: ['pipe', 'pipe', 'pipe'] })
  value.children.push(child)
  await new Promise((resolve, reject) => {
    let output = '', errors = ''
    const timer = setTimeout(() => reject(new Error('External lock not acquired: ' + errors)), 10000)
    child.stdout.on('data', data => { output += data; if (output.includes('locked')) { clearTimeout(timer); resolve() } })
    child.stderr.on('data', data => { errors += data })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { if (!output.includes('locked')) { clearTimeout(timer); reject(new Error('Lock exited: ' + code + errors)) } })
  })
  refuses(() => value.authority.apply(value.session, edit))
  const exited = once(child, 'exit'); child.stdin.write('release'); await exited
  assert.equal(value.authority.findOperation(value.session, 'edit'), undefined)
  refuses(() => value.authority.apply(value.session, edit), 'E_HOST_AUTHORITY')
  ready(value); assert.equal(value.authority.apply(value.session, edit).status, 'committed')
})

test('closed authority revokes sessions and cannot be silently reopened', async t => {
  const value = await setup(t, { approve: () => true }), { edit } = ready(value)
  value.authority.close()
  refuses(() => value.authority.apply(value.session, edit), 'E_HOST_CLOSED')
  refuses(() => value.authority.startSession(), 'E_HOST_CLOSED')
  assert.equal(external(value).findOperation('edit'), undefined)
})

test('restored Saved v2 initialization is discovered locally and permits one newly approved edit', async t => {
  const value = await setup(t, { approve: () => true }), original = external(value)
  original.apply(request(original.snapshot(), 'ancestor-edit', 'archived'))
  const backupHost = createRepositoryMergeBackupHost({ sandboxRoot: value.lab, hostId: 'synthetic-backup', authorize: () => true })
  const backup = path.join(value.lab, 'backup'), restored = path.join(value.lab, 'restored')
  backupRepositoryMergeStore(value.a, backup, previewRepositoryMergeBackup(value.a, { host: backupHost }), 'backup', { host: backupHost })
  const restoreReceipt = restoreRepositoryMergeBackup(backup, restored,
    previewRepositoryMergeBackupRestore(backup, { host: backupHost }), 'restore', { host: backupHost, restoreHost: value.host })
  const selected = select(value, restored), saved = value.authority.snapshot(value.session)
  assert.equal(saved.formatVersion, 2); assert.deepEqual(value.authority.findOperation(value.session, 'restore'), restoreReceipt)
  assert.equal(value.authority.findOperation(value.session, 'ancestor-edit'), undefined)
  value.authority.enable(value.session, selected.selectionDigest)
  const receipt = value.authority.apply(value.session, request(saved, 'post-restore-edit', 'new local'))
  assert.equal(receipt.status, 'committed'); assert.deepEqual(receipt.identity, restoreReceipt.identity)
  assert.deepEqual(value.authority.findOperation(value.session, 'restore'), restoreReceipt)
  assert.deepEqual(value.authority.findOperation(value.session, 'post-restore-edit'), receipt)
  assert.equal(value.authority.snapshot(value.session).projection.state.world.entries[0].fields.note, 'new local')
})

test('session expires at the locked apply authorization boundary without committing', async t => {
  let armed = false, calls = 0
  const value = await setup(t, { approve: () => true, clock: () => armed && ++calls >= 3 ? 300000 : 0 })
  const { edit } = ready(value); armed = true
  refuses(() => value.authority.apply(value.session, edit), 'E_HOST_SESSION_EXPIRED')
  assert.equal(calls, 3); armed = false
  assert.equal(external(value).findOperation('edit'), undefined)
  assert.equal(external(value).snapshot().events.length, 0)
})

test('invalid session configuration rejects getters and cannot replace the active session', async t => {
  const value = await setup(t); select(value); const before = value.authority.snapshot(value.session)
  let reads = 0
  const getter = { get ttlMs() { reads++; return 100 } }
  for (const config of [null, [], { ttlMs: 100, extra: true }, Object.create({ ttlMs: 100 }), getter]) {
    refuses(() => value.authority.startSession(config), 'E_HOST_AUTHORITY')
  }
  assert.equal(reads, 0); assert.deepEqual(value.authority.snapshot(value.session), before)
})

test('invalid bootstrap dependencies reject getter and unknown request-like configuration', async t => {
  const value = await setup(t); let reads = 0
  const config = { sandboxRoot: value.lab, hostId: 'synthetic-host' }
  refuses(() => createRepositoryMergeHostAuthority({ ...config, get approve() { reads++; return () => true } }), 'E_HOST_AUTHORITY')
  refuses(() => createRepositoryMergeHostAuthority({ ...config, request: {} }), 'E_HOST_AUTHORITY')
  assert.equal(reads, 0)
})

test('request content is frozen before trusted clock code executes at the locked boundary', async t => {
  let armed = false, calls = 0, mutable
  const value = await setup(t, { approve: () => true, clock: () => {
    if (armed && ++calls === 3) mutable.pureRequest.operation.action.commands[0].value.fields.note = 'mutated after capture'
    return 0
  } })
  const { edit } = ready(value); mutable = structuredClone(edit); armed = true
  const receipt = value.authority.apply(value.session, mutable); armed = false
  assert.equal(receipt.status, 'committed'); assert.equal(calls, 3)
  assert.equal(mutable.pureRequest.operation.action.commands[0].value.fields.note, 'mutated after capture')
  assert.equal(value.authority.snapshot(value.session).projection.state.world.entries[0].fields.note, 'authorized')
  assert.equal(receipt.requestDigest, digest(edit))
})

test('another controller cannot start a nested write on the same selected physical store', async t => {
  let armed = false, calls = 0, other, otherSession, otherRequest, refused = false
  const value = await setup(t, { approve: () => true, clock: () => {
    if (armed && ++calls === 2) {
      refuses(() => other.apply(otherSession, otherRequest), 'E_HOST_BUSY'); refused = true
    }
    return 0
  } })
  other = createRepositoryMergeHostAuthority({ sandboxRoot: value.lab, hostId: 'synthetic-host', approve: () => true })
  value.authorities.push(other); otherSession = other.startSession()
  const selected = other.select(otherSession, value.a), saved = other.snapshot(otherSession)
  other.enable(otherSession, selected.selectionDigest); otherRequest = request(saved, 'nested-other', 'nested')
  const { edit } = ready(value); armed = true
  assert.equal(value.authority.apply(value.session, edit).status, 'committed'); armed = false
  assert.equal(refused, true); assert.equal(value.authority.findOperation(value.session, 'nested-other'), undefined)
  assert.equal(value.authority.snapshot(value.session).events.length, 1)
  refuses(() => other.apply(otherSession, otherRequest), 'E_HOST_AUTHORITY')
})

test('a clock callback that catches nested control rejection cannot mint a session', async t => {
  const value = await setup(t); let other, nested = 0
  other = createRepositoryMergeHostAuthority({ sandboxRoot: value.lab, hostId: 'synthetic-host', clock: () => {
    nested++; refuses(() => other.close(), 'E_HOST_BUSY'); return 0
  } })
  value.authorities.push(other)
  refuses(() => other.startSession(), 'E_HOST_BUSY'); assert.equal(nested, 1)
  refuses(() => other.select({}, value.a), 'E_HOST_SESSION')
})

test('failed clock remains terminal even after trusted time recovers', async t => {
  const value = await setup(t)
  for (const failure of [() => NaN, () => { throw new Error('clock failure') }]) {
    let broken = true
    const other = createRepositoryMergeHostAuthority({ sandboxRoot: value.lab, hostId: 'synthetic-host', clock: () => broken ? failure() : 100 })
    value.authorities.push(other)
    refuses(() => other.startSession(), 'E_HOST_CLOCK')
    broken = false; refuses(() => other.startSession(), 'E_HOST_CLOCK')
  }
})

test('mutating the trusted bootstrap object cannot change captured host binding', async t => {
  const value = await setup(t), config = { sandboxRoot: value.lab, hostId: 'synthetic-host', approve: () => true }
  const other = createRepositoryMergeHostAuthority(config); value.authorities.push(other)
  config.hostId = 'other-host'; config.approve = () => false
  const session = other.startSession(), selected = other.select(session, value.a)
  assert.equal(selected.binding.hostId, 'synthetic-host')
  other.enable(session, selected.selectionDigest)
  const receipt = other.apply(session, request(other.snapshot(session), 'captured-host'))
  assert.equal(receipt.status, 'committed')
})

test('source option accessors are rejected without invoking request-controlled code', async t => {
  const value = await setup(t, { approve: () => true }), { edit } = ready(value); let reads = 0
  refuses(() => value.authority.apply(value.session, edit, { get source() { reads++; return value.b } }), 'E_HOST_AUTHORITY')
  assert.equal(reads, 0); assert.equal(value.authority.findOperation(value.session, 'edit'), undefined)
  refuses(() => value.authority.apply(value.session, edit), 'E_HOST_AUTHORITY')
})

test('null apply request gives a stable refusal and consumes the grant without a receipt', async t => {
  const value = await setup(t, { approve: () => true }), { edit } = ready(value)
  refuses(() => value.authority.apply(value.session, null), 'E_HOST_AUTHORITY')
  refuses(() => value.authority.apply(value.session, edit), 'E_HOST_AUTHORITY')
  assert.equal(value.authority.findOperation(value.session, 'edit'), undefined)
  assert.equal(value.authority.snapshot(value.session).events.length, 0)
})
