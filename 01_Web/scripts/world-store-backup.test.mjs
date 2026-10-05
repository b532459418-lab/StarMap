import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { createWorldRepository, openWorldRepository } from './world-store-repository.mjs'
import { seed, stageRequest, acceptRequest, createRequest, id } from './world-store-repository.fixture.mjs'
import { backupWorldRepository, restoreWorldRepository, verifyWorldRepositoryBackup, verifyWorldRepositoryRestore } from './world-store-backup.mjs'
import { bridgeV2 } from '../src/data/canonical/storeBridge.ts'
import { syntheticBridgeFixture, BRIDGE_NOW } from '../src/data/canonical/storeBridge.fixture.ts'
import { sequentialUuids } from '../src/data/canonical/v2.fixture.ts'
import { restoreBridgeV2 } from '../src/data/canonical/storeBridgeProjection.ts'

const code = wanted => error => error.code === wanted
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function temporary(t) {
  const base = path.resolve(tmpdir()), root = mkdtempSync(path.join(base, 'starmap-g3b-synthetic-'))
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), base)
    assert.ok(path.basename(root).startsWith('starmap-g3b-synthetic-'))
    rmSync(root, { recursive: true, force: true })
  })
  return { root, database: path.join(root, 'source.sqlite'), backup: path.join(root, 'backup'), restore: path.join(root, 'restore') }
}
const hook = name => ({ unsafeTestPhase(phase) { if (phase === name) throw new Error('Synthetic failure') } })
const modifyManifest = (root, change) => {
  const file = path.join(root, 'complete.json'), value = JSON.parse(readFileSync(file, 'utf8'))
  change(value); writeFileSync(file, JSON.stringify(value))
}

test('backup/restore preserves candidate acceptance, facts, reviews and replay receipts without advancing revisions', t => {
  const p = temporary(t), repository = createWorldRepository(p.database, seed())
  try {
    repository.apply(stageRequest()); const receipt = repository.apply(acceptRequest()), before = repository.snapshot(), originalHash = hash(readFileSync(p.database))
    const result = backupWorldRepository(p.database, p.backup)
    assert.deepEqual(result.state, before); assert.deepEqual(verifyWorldRepositoryBackup(p.backup), result)
    assert.equal(hash(readFileSync(p.database)), originalHash)
    const restored = restoreWorldRepository(p.backup, p.restore)
    assert.deepEqual(restored.state, before); assert.deepEqual(verifyWorldRepositoryRestore(p.restore), restored)
    const target = openWorldRepository(path.join(p.restore, 'world.sqlite'))
    try { assert.deepEqual(target.findOperation('accept'), receipt); assert.deepEqual(target.apply(acceptRequest()), receipt); assert.deepEqual(target.snapshot(), before) }
    finally { target.close() }
  } finally { repository.close() }
})
test('ledger tombstones and permanent deletion history survive backup/restore', t => {
  const p = temporary(t), repository = createWorldRepository(p.database, seed())
  try {
    repository.apply(createRequest())
    repository.apply({ id: 'delete', expectedRevision: 1, action: { kind: 'commands', commands: [{ op: 'remove', table: 'entries', id: id(60), expectedRevision: 0 }] } })
    const before = repository.snapshot(); backupWorldRepository(p.database, p.backup); restoreWorldRepository(p.backup, p.restore)
    const target = openWorldRepository(path.join(p.restore, 'world.sqlite'))
    try {
      assert.deepEqual(target.snapshot(), before); assert.equal(before.identities.identities.length, 1); assert.ok(before.retired.some(row => row.id === id(60)))
      const request = createRequest(); delete request.identities
      assert.throws(() => target.apply({ ...request, id: 'reuse', expectedRevision: 2 }), code('E_REPO_RETIRED_ID'))
    } finally { target.close() }
  } finally { repository.close() }
})
test('G2 metadata and all five V2 values reconstruct identically from restored database', t => {
  const p = temporary(t), files = syntheticBridgeFixture(), bridge = bridgeV2(files, { now: BRIDGE_NOW, allocateId: sequentialUuids() })
  createWorldRepository(p.database, { world: bridge.store, identities: bridge.manifest }).close()
  backupWorldRepository(p.database, p.backup); const { state } = restoreWorldRepository(p.backup, p.restore)
  assert.deepEqual(restoreBridgeV2({ ...bridge, store: state.world, manifest: state.identities }), files)
})
test('backup includes committed snapshot and excludes another connection uncommitted transaction', t => {
  const p = temporary(t); createWorldRepository(p.database, seed()).close()
  const db = new DatabaseSync(p.database)
  try {
    db.exec('BEGIN IMMEDIATE'); db.exec("UPDATE repository_state SET digest = 'uncommitted'")
    assert.equal(backupWorldRepository(p.database, p.backup).state.revision, 0)
    db.exec('ROLLBACK')
    assert.equal(verifyWorldRepositoryBackup(p.backup).state.revision, 0)
  } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close() }
})
test('verified backup does not change when the live source receives another commit', t => {
  const p = temporary(t), repository = createWorldRepository(p.database, seed())
  try {
    const initial = backupWorldRepository(p.database, p.backup), bytes = readFileSync(path.join(p.backup, 'world.sqlite'))
    repository.apply(createRequest())
    assert.deepEqual(verifyWorldRepositoryBackup(p.backup), initial); assert.deepEqual(readFileSync(path.join(p.backup, 'world.sqlite')), bytes)
    assert.equal(restoreWorldRepository(p.backup, p.restore).state.revision, 0)
  } finally { repository.close() }
})
test('existing backup, existing restore and source directory are never overwritten', t => {
  const p = temporary(t); createWorldRepository(p.database, seed()).close()
  backupWorldRepository(p.database, p.backup); restoreWorldRepository(p.backup, p.restore)
  const db = readFileSync(p.database), backup = readFileSync(path.join(p.backup, 'world.sqlite')), restored = readFileSync(path.join(p.restore, 'world.sqlite'))
  for (const destination of [p.backup, p.restore, p.root]) assert.throws(() => backupWorldRepository(p.database, destination), code('E_BACKUP_EXISTS'))
  for (const destination of [p.backup, p.restore, p.root]) assert.throws(() => restoreWorldRepository(p.backup, destination), code('E_BACKUP_EXISTS'))
  assert.deepEqual(readFileSync(p.database), db); assert.deepEqual(readFileSync(path.join(p.backup, 'world.sqlite')), backup); assert.deepEqual(readFileSync(path.join(p.restore, 'world.sqlite')), restored)
})
test('read-only repository denies writes and export refuses even an empty existing file', t => {
  const p = temporary(t); createWorldRepository(p.database, seed()).close()
  const source = openWorldRepository(p.database, { readOnly: true }), empty = path.join(p.root, 'empty.sqlite'); writeFileSync(empty, '')
  try { assert.throws(() => source.apply(createRequest()), code('E_REPO_READ_ONLY')); assert.throws(() => source.exportSnapshot(empty), code('E_REPO_EXISTS')); assert.equal(readFileSync(empty).length, 0) }
  finally { source.close() }
})
for (const operation of ['backup', 'restore']) for (const phase of ['reserved', 'database-written', 'validated']) test(`${operation} failure at ${phase} has no completion and cannot silently resume`, t => {
  const p = temporary(t); createWorldRepository(p.database, seed()).close()
  if (operation === 'restore') backupWorldRepository(p.database, p.backup)
  const destination = operation === 'backup' ? p.backup : p.restore
  const run = options => operation === 'backup' ? backupWorldRepository(p.database, destination, options) : restoreWorldRepository(p.backup, destination, options)
  assert.throws(() => run(hook(phase)), code('E_BACKUP_IO')); assert.ok(!readdirSync(destination).includes('complete.json'))
  const verify = operation === 'backup' ? verifyWorldRepositoryBackup : verifyWorldRepositoryRestore
  assert.throws(() => verify(destination), code('E_BACKUP_INCOMPLETE')); assert.throws(() => run({}), code('E_BACKUP_EXISTS'))
  assert.equal(openAndRead(p.database).revision, 0)
})
function openAndRead(file) { const repository = openWorldRepository(file); try { return repository.snapshot() } finally { repository.close() } }
for (const operation of ['backup', 'restore']) test(`${operation} lost acknowledgement reports unknown; explicit verification discovers completed package`, t => {
  const p = temporary(t); createWorldRepository(p.database, seed()).close()
  if (operation === 'restore') backupWorldRepository(p.database, p.backup)
  const run = operation === 'backup' ? () => backupWorldRepository(p.database, p.backup, hook('sealed')) : () => restoreWorldRepository(p.backup, p.restore, hook('sealed'))
  assert.throws(run, code('E_BACKUP_OUTCOME_UNKNOWN'))
  const verified = operation === 'backup' ? verifyWorldRepositoryBackup(p.backup) : verifyWorldRepositoryRestore(p.restore)
  assert.equal(verified.state.revision, 0)
})
for (const change of [m => { m.database.sha256 = '0'.repeat(64) }, m => { m.database.bytes++ }, m => { m.repositoryRevision++ }, m => { m.stateSha256 = '0'.repeat(64) }, m => { m.database.file = '../source.sqlite' }]) test('corrupt or redirected manifest rejects restore before creating destination', t => {
  const p = temporary(t); createWorldRepository(p.database, seed()).close(); backupWorldRepository(p.database, p.backup)
  modifyManifest(p.backup, change)
  assert.throws(() => restoreWorldRepository(p.backup, p.restore), e => ['E_BACKUP_CORRUPT', 'E_BACKUP_MANIFEST'].includes(e.code))
  assert.ok(!readdirSync(p.root).includes('restore'))
})
test('unknown package version and missing receipt are refused without clearing revisions', t => {
  const p = temporary(t), repository = createWorldRepository(p.database, seed()); repository.apply(createRequest()); repository.close()
  backupWorldRepository(p.database, p.backup); modifyManifest(p.backup, m => { m.formatVersion = 2 })
  assert.throws(() => restoreWorldRepository(p.backup, p.restore), code('E_BACKUP_VERSION'))
  modifyManifest(p.backup, m => { m.formatVersion = 1 })
  const db = new DatabaseSync(path.join(p.backup, 'world.sqlite')); db.exec('DELETE FROM operation_receipts'); db.close()
  const altered = readFileSync(path.join(p.backup, 'world.sqlite'))
  modifyManifest(p.backup, m => { m.database.bytes = altered.length; m.database.sha256 = hash(altered) })
  assert.throws(() => restoreWorldRepository(p.backup, p.restore), code('E_REPO_CORRUPT'))
})
test('unknown database schema version is rejected before any backup destination reservation', t => {
  const p = temporary(t); createWorldRepository(p.database, seed()).close()
  const db = new DatabaseSync(p.database); db.exec('PRAGMA user_version = 2'); db.close()
  assert.throws(() => backupWorldRepository(p.database, p.backup), code('E_REPO_VERSION')); assert.ok(!readdirSync(p.root).includes('backup'))
})
test('unrelated files are excluded; adding one to a package makes it incomplete', t => {
  const p = temporary(t); createWorldRepository(p.database, seed()).close()
  writeFileSync(path.join(p.root, 'neutral-media-placeholder'), 'Not part of the database package')
  backupWorldRepository(p.database, p.backup)
  assert.deepEqual(readdirSync(p.backup).sort(), ['complete.json', 'world.sqlite'])
  writeFileSync(path.join(p.backup, 'extra'), 'extra'); assert.throws(() => verifyWorldRepositoryBackup(p.backup), code('E_BACKUP_INCOMPLETE'))
})
test('invalid source, incomplete source package and relative target cannot create successful output', t => {
  const p = temporary(t); mkdirSync(p.backup)
  assert.throws(() => restoreWorldRepository(p.backup, p.restore), code('E_BACKUP_INCOMPLETE'))
  createWorldRepository(p.database, seed()).close()
  assert.throws(() => backupWorldRepository(p.database, 'relative'), code('E_BACKUP_PATH'))
  assert.ok(!readdirSync(p.root).includes('restore'))
})
test('pending and rejected candidates stay outside facts after restoring their separate snapshots', t => {
  const p = temporary(t), repository = createWorldRepository(p.database, seed())
  try {
    repository.apply(stageRequest()); backupWorldRepository(p.database, p.backup)
    assert.equal(restoreWorldRepository(p.backup, p.restore).state.proposals[0].status, 'pending')
    repository.apply({ id: 'reject', expectedRevision: 1, action: { kind: 'reject-proposal', proposalId: 'synthetic-proposal' } })
    const result = backupWorldRepository(p.database, path.join(p.root, 'rejected-backup'))
    const restored = restoreWorldRepository(path.join(p.root, 'rejected-backup'), path.join(p.root, 'rejected-restore'))
    assert.deepEqual(restored.state, result.state); assert.equal(restored.state.proposals[0].status, 'rejected'); assert.equal(restored.state.world.reviews.length, 0); assert.equal(restored.state.world.entries.length, 3)
  } finally { repository.close() }
})
test('partial completion marker is refused; exported database corruption is never sealed', t => {
  const p = temporary(t); createWorldRepository(p.database, seed()).close()
  backupWorldRepository(p.database, p.backup); writeFileSync(path.join(p.backup, 'complete.json'), '{')
  assert.throws(() => restoreWorldRepository(p.backup, p.restore), code('E_BACKUP_MANIFEST'))
  const other = path.join(p.root, 'broken-export')
  assert.throws(() => backupWorldRepository(p.database, other, { unsafeTestPhase(phase) {
    if (phase === 'database-written') {
      const db = new DatabaseSync(path.join(other, 'world.sqlite')); db.exec("UPDATE repository_state SET digest = 'broken'"); db.close()
    }
  } }), code('E_REPO_CORRUPT'))
  assert.ok(!readdirSync(other).includes('complete.json'))
})
for (const operation of ['backup', 'restore']) for (const phase of ['validated', 'sealed']) test(`real process exit during ${operation} at ${phase} requires completion discovery`, async t => {
  const p = temporary(t); createWorldRepository(p.database, seed()).close()
  if (operation === 'restore') backupWorldRepository(p.database, p.backup)
  const spec = path.join(p.root, 'worker.json'); writeFileSync(spec, JSON.stringify({ ...p, operation, phase }))
  const child = spawn(process.execPath, [fileURLToPath(new URL('./world-store-backup.fixture.mjs', import.meta.url)), spec], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = once(child, 'exit'); exited.catch(() => {}); let output = ''
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Synthetic worker timeout')), 7000)
      child.stdout.on('data', data => { output += data; if (output.includes(`paused:${phase}`)) { clearTimeout(timer); resolve() } })
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', () => { clearTimeout(timer); if (!output.includes(`paused:${phase}`)) reject(new Error('Worker exited before phase')) })
    })
    child.kill('SIGKILL'); await exited
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited } }
  const verify = operation === 'backup' ? verifyWorldRepositoryBackup : verifyWorldRepositoryRestore
  const destination = operation === 'backup' ? p.backup : p.restore
  if (phase === 'sealed') assert.equal(verify(destination).state.revision, 0)
  else assert.throws(() => verify(destination), code('E_BACKUP_INCOMPLETE'))
  assert.equal(openAndRead(p.database).revision, 0)
})
