/**
 * `npm run store:upgrade` (3C-4c, design v2 §2): a format-1 store (3C-3 to 3C-4b) is refused at open with
 * E_STORE_UPGRADE_REQUIRED and upgraded in place, in one transaction, with every row, receipt and edit kept.
 * Temporary private roots; the neutral 3C-1b edge fixture; format 1 is made by downgradeStoreToFormat1.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { withLibraryOperation } from './library-operation-lock.mjs'
import { storeFileOf } from './private-data-source.mjs'
import { STORE_FORMAT_VERSION, STORE_UPGRADE_KIND, checkStoreFile, openStore, upgradeStoreFile } from './store-host.mjs'
import { recoverLibrary } from './store-recover.mjs'
import { applyMigration } from './store-migrate.mjs'
import { rawConnection, pragmaValue } from './store-sqlite.mjs'
import { runStoreUpgradeCli, upgradeStore } from './store-upgrade.mjs'
import { downgradeStoreToFormat1, edgeV2Files, quietly, tempPrivateRoot, writeV2Files } from './store-mode.fixture.mjs'
import { OFFICIAL, OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'

const NOW = '2026-10-16T00:00:00.000Z'
const id = (n) => `019a0000-0000-7000-8000-${String(n).padStart(12, '0')}`
const bytesOf = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const sha = (n) => createHash('sha256').update(`synthetic ${n}`).digest('hex')

/** A migrated store with one ordinary edit (a renamed place), closed, then turned into format 1. */
async function format1Store(t) {
  const { root, paths } = await tempPrivateRoot(t, 'starmap-store-upgrade-')
  await writeV2Files(paths, edgeV2Files())
  await applyMigration(paths, { now: NOW })
  const file = storeFileOf(paths)
  const handle = openStore(file, { privatePaths: paths, policy: OFFICIAL_POLICY, now: () => NOW })
  let edit
  try {
    const place = handle.readRowsUnchecked().entities.find((entity) => entity.typeId === OFFICIAL.place)
    edit = { requestId: id(1), baseRevision: handle.meta().revision, kind: 'test.edit', actor: 'test', commands: [
      { op: 'update', table: 'entities', id: place.id, expectedRevision: place.revision, value: { ...place, revision: place.revision + 1, title: { names: { en: 'Edited before the upgrade' } } } },
    ] }
    await handle.commit(edit)
  } finally { await handle.close() }
  const before = openStore(file, { readOnly: true, policy: OFFICIAL_POLICY })
  const state = before.readFormalState()
  await before.close()
  downgradeStoreToFormat1(file)
  return { root, paths, file, edit, state }
}

test('a format-1 store opens with E_STORE_UPGRADE_REQUIRED and is upgraded in place, every row and receipt kept', async (t) => {
  const { paths, file, edit, state } = await format1Store(t)
  const refused = openStore(file, { privatePaths: paths, policy: OFFICIAL_POLICY })
  assert.equal(refused.diagnostic.code, 'E_STORE_UPGRADE_REQUIRED')
  assert.throws(() => refused.meta(), (error) => error.code === 'E_STORE_UPGRADE_REQUIRED', 'not readable: the App shows the error with the command')
  await refused.close()
  const cleanBefore = rawConnection(file, { readOnly: true })
  const clean = cleanBefore.prepare('SELECT clean_shutdown FROM store_meta').get().clean_shutdown
  cleanBefore.close()

  const { result, check, lines } = await upgradeStore(paths, { requestId: id(9), now: () => NOW })
  assert.deepEqual([result.upgraded, result.fromVersion, result.toVersion, result.revision], [true, 1, STORE_FORMAT_VERSION, state.revision])
  assert.equal(check.ok, true)
  assert.match(lines.join('\n'), /从存储格式 1 升级到 2/)
  const db = rawConnection(file, { readOnly: true })
  try {
    assert.equal(pragmaValue(db, 'user_version'), STORE_FORMAT_VERSION)
    assert.equal(db.prepare('SELECT format_version, clean_shutdown FROM store_meta').get().format_version, STORE_FORMAT_VERSION)
    assert.equal(db.prepare('SELECT clean_shutdown FROM store_meta').get().clean_shutdown, clean, 'no writer session: clean_shutdown as it was')
    assert.equal(db.prepare('SELECT kind FROM op_log ORDER BY seq DESC LIMIT 1').get().kind, STORE_UPGRADE_KIND)
  } finally { db.close() }
  const after = openStore(file, { privatePaths: paths, policy: OFFICIAL_POLICY })
  try {
    assert.equal(after.diagnostic, undefined)
    assert.deepEqual(after.readFormalState(), state, 'every row, tombstone and the revision as before the upgrade, the edit included')
    assert.equal(after.lookup(edit.requestId).found, true, 'receipts written before the upgrade still answer retries')
    assert.equal((await after.commit(edit)).status, 'duplicate')
    const registry = after.mediaRegistry()
    assert.deepEqual([registry.files, registry.assetFiles, registry.sources, registry.scanCache], [[], [], [], []])
  } finally { await after.close() }
  // Running it again changes nothing.
  const bytes = bytesOf(file)
  const again = await upgradeStore(paths, { requestId: id(10) })
  assert.equal(again.result.upgraded, false)
  assert.equal(bytesOf(file), bytes)
})

test('the seed of prepare is written in the same transaction; a refused or failing seed leaves format 1 untouched', async (t) => {
  const { paths, file, state } = await format1Store(t)
  const media = state.entities.find((entity) => entity.typeId === OFFICIAL.media)
  const before = bytesOf(file)
  // A seed the registry refuses (a source of an entity that is not media): nothing changes.
  const place = state.entities.find((entity) => entity.typeId === OFFICIAL.place)
  await assert.rejects(upgradeStoreFile(file, { privatePaths: paths, policy: OFFICIAL_POLICY, requestId: id(20), prepare: async () => ({
    sources: [{ op: 'add', path: 'MediaInbox/a/b/photos/x.jpg', sha256: sha(1), recordId: place.id, state: 'missing' }],
  }) }), (error) => error.code === 'E_MEDIA_REGISTRY' && error.outcome === 'not_committed')
  // A prepare that fails (IO) changes nothing either.
  await assert.rejects(upgradeStoreFile(file, { privatePaths: paths, policy: OFFICIAL_POLICY, requestId: id(21), prepare: async () => { throw new Error('scan failed') } }), /scan failed/)
  assert.equal(bytesOf(file), before)
  // The seed arrives with the upgrade, in its receipt.
  const seeded = await upgradeStoreFile(file, { privatePaths: paths, policy: OFFICIAL_POLICY, requestId: id(22), prepare: async ({ revision }) => {
    assert.equal(revision, state.revision)
    return { sources: [{ op: 'add', path: 'MediaInbox/a/b/photos/x.jpg', sha256: sha(1), recordId: media.id, state: 'missing' }] }
  } })
  assert.deepEqual(seeded.receipt.media, { sources: 1 })
  const after = openStore(file, { readOnly: true, policy: OFFICIAL_POLICY })
  try { assert.deepEqual(after.mediaRegistry().sources.map(({ recordId, state: sourceState }) => [recordId, sourceState]), [[media.id, 'missing']]) } finally { await after.close() }
})

test('the upgrade refuses an altered format-1 schema, a newer store and a lease held elsewhere, writing nothing', async (t) => {
  const { paths, file } = await format1Store(t)
  const db = rawConnection(file)
  try { db.exec('CREATE TABLE extra (x TEXT) STRICT') } finally { db.close() }
  const altered = bytesOf(file)
  await assert.rejects(upgradeStoreFile(file, { privatePaths: paths, requestId: id(30) }), (error) => error.code === 'E_STORE_SCHEMA')
  assert.equal(bytesOf(file), altered)
  const undo = rawConnection(file)
  try { undo.exec('DROP TABLE extra') } finally { undo.close() }
  await withLibraryOperation(paths, async () => {
    await assert.rejects(upgradeStoreFile(file, { privatePaths: paths, requestId: id(31) }), (error) => error.code === 'E_LIBRARY_BUSY')
  })
  const newer = rawConnection(file)
  try { newer.exec(`PRAGMA user_version = ${STORE_FORMAT_VERSION + 1}`) } finally { newer.close() }
  await assert.rejects(upgradeStoreFile(file, { privatePaths: paths, requestId: id(32) }), (error) => error.code === 'E_STORE_TOO_NEW')
})

test('a lock left on a format-1 store: library:recover checks it as format 1 and clears the lock, then store:upgrade runs', async (t) => {
  const { paths, file } = await format1Store(t)
  const sound = await checkStoreFile(file, { policy: OFFICIAL_POLICY })
  assert.deepEqual([sound.ok, sound.upgradeRequired, sound.problems], [true, true, []])
  // A lock whose holder is gone (written the way a crashed holder leaves it).
  await mkdir(path.join(paths.root, 'operations'), { recursive: true })
  const { libraryRootBinding } = await import('./library-operation-lock.mjs')
  await writeFile(path.join(paths.root, 'operations', 'library-operation.lock'),
    JSON.stringify({ schemaVersion: 1, owner: '00000000-0000-4000-8000-000000000001', rootBinding: libraryRootBinding(await realpath(paths.root)) }))
  await assert.rejects(upgradeStore(paths, { requestId: id(40) }), (error) => error.code === 'E_LIBRARY_BUSY')
  const out = quietly()
  assert.equal(await recoverLibrary(paths, { confirm: true, policy: OFFICIAL_POLICY, ...out }), 0)
  assert.match(out.lines.join('\n'), /store:upgrade/)
  assert.equal((await upgradeStore(paths, { requestId: id(41) })).result.upgraded, true)
  // A damaged format-1 store is not reported as sound.
  const db = rawConnection(file)
  try { db.exec("UPDATE entities SET body = '{}' WHERE rowid = (SELECT min(rowid) FROM entities)") } finally { db.close() }
  downgradeStoreToFormat1(file)
  const damaged = await checkStoreFile(file, { policy: OFFICIAL_POLICY })
  assert.equal(damaged.ok, false)
  assert.equal(damaged.upgradeRequired, true)
})

test('npm run store:upgrade: exit codes, a root without a store, no arguments', async (t) => {
  const { paths } = await format1Store(t)
  const out = quietly()
  assert.equal(await runStoreUpgradeCli([], { privatePaths: paths, ...out }), 0)
  assert.match(out.lines.join('\n'), /全量检查通过/)
  assert.equal(await runStoreUpgradeCli([], { privatePaths: paths, ...quietly() }), 0, 'already current: nothing to do')
  assert.equal(await runStoreUpgradeCli(['--force'], { privatePaths: paths, ...quietly() }), 1)
  const empty = await tempPrivateRoot(t, 'starmap-store-upgrade-')
  const refused = quietly()
  assert.equal(await runStoreUpgradeCli([], { privatePaths: empty.paths, ...refused }), 1)
  assert.match(refused.lines.join('\n'), /E_NOT_STORE_MODE/)
})
