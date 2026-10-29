/**
 * `npm run store:upgrade` (3C-4c, design v2 §2): a format-1 store (3C-3 to 3C-4b) is refused at open with
 * E_STORE_UPGRADE_REQUIRED and upgraded in place, in one transaction, with every row, receipt and edit kept.
 * 3C-5 E: so is a format-2 store, whose added countries without a visit date get their visit entries (format 3).
 * Temporary private roots; the neutral 3C-1b edge fixture; format 1 is made by downgradeStoreToFormat1, format 2 by
 * format2Store below.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { withLibraryOperation } from './library-operation-lock.mjs'
import { storeFileOf } from './private-data-source.mjs'
import { DEFINITIONS_SCHEMA, STORE_FORMAT_VERSION, STORE_UPGRADE_KIND, checkStoreFile, openStore, upgradeStoreFile } from './store-host.mjs'
import { recoverLibrary } from './store-recover.mjs'
import { applyMigration } from './compat/store-migrate.mjs'
import { rawConnection, pragmaValue } from './store-sqlite.mjs'
import { runStoreUpgradeCli, upgradeStore } from './store-upgrade.mjs'
import { downgradeStoreToFormat1, edgeV2Files, quietly, tempPrivateRoot, writeV2Files } from './store-mode.fixture.mjs'
import { OFFICIAL, OFFICIAL_DEFINITIONS_VERSION, OFFICIAL_POLICY, V2_SOURCES } from '../src/data/store/officialDefinitions.ts'
import { projectStoreToCanonical } from '../src/data/store/projectCanonical.ts'

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
  assert.match(lines.join('\n'), new RegExp(`从存储格式 1 升级到 ${STORE_FORMAT_VERSION}`))
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

// ---------------------------------------------------------------------------
// Format 2 → 3 (3C-5 E spec §2.6): every added country has its visit entry
// ---------------------------------------------------------------------------

const readState = async (file) => {
  const handle = openStore(file, { readOnly: true, policy: OFFICIAL_POLICY })
  try { return handle.readFormalState() } finally { await handle.close() }
}
const canonicalOf = (state) => projectStoreToCanonical(state, { source: 'local' }).canonical
/** Travel entries on countries (the visit entries of added countries, format 3). */
const countryVisitsOf = (state) => {
  const countries = new Set(state.entities.filter((entity) => entity.typeId === OFFICIAL.place && entity.fields.subtype === 'country').map((entity) => entity.id))
  return state.entries.filter((entry) => entry.layerId === OFFICIAL.travel && countries.has(entry.entityId))
}

/**
 * A store with the rows format 2 had for added countries: a country added without a visit date was its evidence alone,
 * with no travel entry (the edge fixture's Faroe Islands: an empty visitedDate). Made by migrating, removing the visit
 * entries that carry no date (a commit), then setting the version to 2 (the schema is 3's). Returns the official view
 * the migration gave (`canonical`), the state of the format-2 rows and the removed entries.
 */
async function format2Store(t) {
  const { root, paths } = await tempPrivateRoot(t, 'starmap-store-upgrade-')
  await writeV2Files(paths, edgeV2Files())
  await applyMigration(paths, { now: NOW })
  const file = storeFileOf(paths)
  const migrated = await readState(file)
  const canonical = canonicalOf(migrated)
  const removed = countryVisitsOf(migrated).filter((entry) => entry.fields.date?.raw?.startDate === undefined)
  assert.equal(removed.length, 1, 'the fixture has one added country without a visit date')
  const handle = openStore(file, { privatePaths: paths, policy: OFFICIAL_POLICY, now: () => NOW })
  try {
    await handle.commit({ requestId: id(50), baseRevision: migrated.revision, kind: 'test.format-2-rows', actor: 'test',
      commands: removed.map((entry) => ({ op: 'remove', table: 'entries', id: entry.id, expectedRevision: entry.revision })) })
  } finally { await handle.close() }
  const state = await readState(file)
  const db = rawConnection(file)
  try { db.exec('DROP TABLE store_definitions'); db.exec('PRAGMA user_version = 2'); db.exec('UPDATE store_meta SET format_version = 2') } finally { db.close() }
  return { root, paths, file, canonical, state, removed }
}

test('format 2 → 3: the upgrade gives an added country without a visit date its entry; the official view is the migration\'s again', async (t) => {
  const { paths, file, canonical, state, removed } = await format2Store(t)
  const refused = openStore(file, { privatePaths: paths, policy: OFFICIAL_POLICY })
  assert.equal(refused.diagnostic.code, 'E_STORE_UPGRADE_REQUIRED')
  await refused.close()
  // The format-2 rows read with the format-3 rules would lose that country: why no code may read them before the upgrade.
  const [faroe] = removed
  assert.equal(canonicalOf(state).editorState.addedCountries.some((country) => country.placeId === faroe.entityId), false)
  let n = 60
  const { result, check, lines } = await upgradeStore(paths, { requestId: id(59), now: () => NOW, newId: () => id(n++) })
  assert.deepEqual([result.upgraded, result.fromVersion, result.toVersion, result.fromRevision, result.revision], [true, 2, STORE_FORMAT_VERSION, state.revision, state.revision + 1])
  assert.equal(check.ok, true)
  assert.match(lines.join('\n'), /1 个没有访问日期的国家补上了访问条目/)
  assert.doesNotMatch(lines.join('\n'), /媒体登记/, 'format 2 has its media registry: nothing seeded')
  const after = await readState(file)
  assert.deepEqual(canonicalOf(after), canonical, 'the added countries, their values and order as the migration gave them')
  const created = after.entries.filter((entry) => !state.entries.some((before) => before.id === entry.id))
  const evidence = state.evidence.find((row) => row.sourceId === V2_SOURCES.countryVisit && row.recordId === faroe.entityId)
  assert.deepEqual(created, [{
    id: id(60), revision: 0, layerId: OFFICIAL.travel, entityId: faroe.entityId, fields: { date: { raw: {} } },
    source: { sourceId: V2_SOURCES.countryVisit, recordId: faroe.entityId, evidenceIds: [evidence.id] }, createdAt: NOW, updatedAt: NOW,
  }])
  for (const table of ['entities', 'evidence', 'viewItems', 'viewSettings', 'sources', 'assets', 'relations', 'anchors', 'sequences']) {
    assert.deepEqual(after[table], state[table], `${table}: as before`)
  }
  assert.deepEqual(after.entries.filter((entry) => entry.id !== id(60)), state.entries, 'the other entries as before')
  // Running it again changes nothing.
  const bytes = bytesOf(file)
  assert.equal((await upgradeStore(paths, { requestId: id(70) })).result.upgraded, false)
  assert.equal(bytesOf(file), bytes)
})

test('format 1 → current in one transaction: the media registry seeded and the visit entries written by one request', async (t) => {
  const { paths, file, canonical, state } = await format2Store(t)
  downgradeStoreToFormat1(file)
  const { result, check } = await upgradeStore(paths, { requestId: id(80), now: () => NOW })
  assert.deepEqual([result.fromVersion, result.toVersion, result.revision], [1, STORE_FORMAT_VERSION, state.revision + 1])
  assert.equal(check.ok, true)
  assert.equal(result.receipt.revision, state.revision + 1)
  assert.deepEqual(canonicalOf(await readState(file)), canonical)
  const db = rawConnection(file, { readOnly: true })
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM op_log WHERE kind = ?').get(STORE_UPGRADE_KIND).n, 1, 'one request')
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'media_files'").get().n, 1, 'the media registry')
  } finally { db.close() }
})

test('restoring a backup of a format-2 store upgrades it: the revision moves on by one from the backup\'s', async (t) => {
  const { paths, root, canonical, state } = await format2Store(t)
  // Back up the store at format 3 rows-wise identical, then turn the snapshot into format 2 with matching hashes.
  const db = rawConnection(storeFileOf(paths))
  try {
    db.exec(`PRAGMA user_version = ${STORE_FORMAT_VERSION}`); db.exec(`UPDATE store_meta SET format_version = ${STORE_FORMAT_VERSION}`)
    for (const statement of DEFINITIONS_SCHEMA) db.exec(statement)
    db.prepare('INSERT INTO store_definitions (singleton, version) VALUES (1, ?)').run(OFFICIAL_DEFINITIONS_VERSION)
  } finally { db.close() }
  const { BACKUP_FILES, backupStore, restoreStore } = await import('./store-backup.mjs')
  const out = path.join(path.dirname(root), 'backup')
  await backupStore(paths, { out, now: NOW, backupId: '019a0000-0000-7000-8000-00000000e020' })
  const snapshot = path.join(out, BACKUP_FILES.store)
  const raw2 = rawConnection(snapshot)
  try { raw2.exec('DROP TABLE store_definitions'); raw2.exec('PRAGMA user_version = 2'); raw2.exec('UPDATE store_meta SET format_version = 2') } finally { raw2.close() }
  const { readFile } = await import('node:fs/promises')
  const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const manifestFile = path.join(out, BACKUP_FILES.manifest)
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  const snapshotBytes = await readFile(snapshot)
  manifest.files[BACKUP_FILES.store] = { bytes: snapshotBytes.length, sha256: sha256(snapshotBytes) }
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
  const complete = JSON.parse(await readFile(path.join(out, BACKUP_FILES.complete), 'utf8'))
  await writeFile(path.join(out, BACKUP_FILES.complete), `${JSON.stringify({ ...complete, manifestSha256: sha256(await readFile(manifestFile)) }, null, 2)}\n`)
  const to = path.join(path.dirname(root), 'restored')
  const restored = await restoreStore({ from: out, to, now: '2026-10-17T00:00:00.000Z' })
  assert.match(restored.lines.join('\n'), /integrity_check 与全量校验通过/)
  const after = await readState(path.join(to, 'data', 'store', 'world.sqlite'))
  assert.equal(after.revision, state.revision + 1)
  assert.deepEqual(canonicalOf(after), canonical)
})
