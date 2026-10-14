import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { withLibraryOperation } from './library-operation-lock.mjs'
import { getPrivatePaths, webRoot } from './private-profile.mjs'
import { privateDataSource, storeFileOf } from './private-data-source.mjs'
import { BACKUP_FILES, backupStore, exportStoreV2, restoreStore, runStoreBackupCli, verifyBackup } from './store-backup.mjs'
import { openStore } from './store-host.mjs'
import { applyMigration } from './store-migrate.mjs'
import { projectToV2Files } from './store-projection.mjs'
import { quietly, sampleV2Files, tempPrivateRoot, treeDigest, writeV2Files } from './store-mode.fixture.mjs'
import { readV2 } from '../src/data/canonical/v2Reader.ts'
import { V2_FILE_KEYS, V2_FILE_NAMES } from '../src/data/canonical/v2Schema.ts'
import { OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'

const NOW = '2026-10-14T00:00:00.000Z'
const backupScript = fileURLToPath(new URL('./store-backup.mjs', import.meta.url))

async function migrated(t, files = sampleV2Files()) {
  const context = await tempPrivateRoot(t, 'starmap-store-backup-')
  await writeV2Files(context.paths, files)
  await applyMigration(context.paths, { now: NOW })
  return { ...context, files, at: (name) => path.join(context.directory, name) }
}
/** Read-only projection of the store under `paths`. */
async function readProjection(paths) {
  const handle = openStore(storeFileOf(paths), { readOnly: true, policy: OFFICIAL_POLICY })
  try { return { ...projectToV2Files(handle.readRowsUnchecked()), meta: handle.meta() } } finally { await handle.close() }
}

test('store:backup writes the snapshot, the manifest and the completion mark last, under the lease', async (t) => {
  const { paths, at, root } = await migrated(t)
  const before = await readProjection(paths)
  const out = at('backup')
  const result = await backupStore(paths, { out, now: NOW, backupId: '01960000-0000-7000-8000-00000000f001' })
  assert.deepEqual((await readdir(out)).sort(), Object.values(BACKUP_FILES).sort())
  const manifest = JSON.parse(await readFile(path.join(out, BACKUP_FILES.manifest), 'utf8'))
  assert.deepEqual(manifest, result.manifest)
  assert.equal(manifest.format, 'starmap.store-backup')
  assert.equal(manifest.store.libraryId, before.meta.libraryId)
  assert.equal(manifest.store.revision, 1)
  assert.ok(manifest.tables.entries > 0 && manifest.tables.receipts === 1 && manifest.tables.id_map > 0)
  assert.deepEqual(await verifyBackup(out), manifest)
  // The snapshot is a store of its own, with the same content.
  const copy = openStore(path.join(out, BACKUP_FILES.store), { readOnly: true, policy: OFFICIAL_POLICY })
  try {
    assert.equal(copy.diagnostic, undefined)
    assert.deepEqual(projectToV2Files(copy.readRowsUnchecked()).files, before.files)
    assert.deepEqual(copy.tableCounts(), manifest.tables)
  } finally { await copy.close() }
  assert.equal(existsSync(path.join(root, 'operations', 'library-operation.lock')), false)
})

test('store:backup refuses an existing directory, a V2 root, a path inside the repository and a held lease', async (t) => {
  const { paths, at, directory } = await migrated(t)
  const existing = at('existing')
  await writeFile(existing, 'keep')
  await assert.rejects(backupStore(paths, { out: existing }), { code: 'E_TARGET_EXISTS' })
  assert.equal(await readFile(existing, 'utf8'), 'keep')
  await assert.rejects(backupStore(paths, { out: path.join(webRoot, 'synthetic-backup-inside-repo') }), { code: 'E_PRIVATE_OUTPUT' })
  assert.equal(existsSync(path.join(webRoot, 'synthetic-backup-inside-repo')), false)
  const v2 = getPrivatePaths({ STARMAP_PRIVATE_ROOT: path.join(directory, 'v2-root') })
  await writeV2Files(v2, sampleV2Files())
  await assert.rejects(backupStore(v2, { out: at('from-v2') }), { code: 'E_NOT_STORE_MODE' })
  await withLibraryOperation(paths, async () => {
    await assert.rejects(backupStore(paths, { out: at('busy') }), { code: 'E_LIBRARY_BUSY' })
  })
  for (const name of ['from-v2', 'busy']) assert.equal(existsSync(at(name)), false, name)
})

test('store:restore checks the backup, creates a new root with the store, records one restore layer and passes the checks', async (t) => {
  const { paths, at } = await migrated(t)
  const before = await readProjection(paths)
  const backup = at('backup')
  await backupStore(paths, { out: backup, now: NOW, backupId: '01960000-0000-7000-8000-00000000f002' })
  const to = at('restored')
  const result = await restoreStore({ from: backup, to, now: '2026-10-15T00:00:00.000Z' })
  const restored = getPrivatePaths({ STARMAP_PRIVATE_ROOT: to })
  assert.equal(privateDataSource(restored), 'store')
  // Only the store (and the zero-length journal TRUNCATE mode keeps between writes).
  const tree = await treeDigest(to)
  assert.deepEqual(Object.keys(tree).filter((file) => file !== 'data/store/world.sqlite-journal'), ['data/store/world.sqlite'])
  if (tree['data/store/world.sqlite-journal']) assert.equal((await readFile(path.join(to, 'data', 'store', 'world.sqlite-journal'))).length, 0)
  const after = await readProjection(restored)
  assert.deepEqual(after.files, before.files)
  assert.equal(after.meta.libraryId, before.meta.libraryId)
  assert.deepEqual(after.meta.restoredFrom, result.restoredFrom)
  assert.equal(after.meta.restoredFrom.backupId, '01960000-0000-7000-8000-00000000f002')
  // The restored store opens cleanly: no quick_check at the next writable open.
  const handle = openStore(storeFileOf(restored), { privatePaths: restored, policy: OFFICIAL_POLICY })
  try { assert.equal(handle.openTimings.quickCheckMs, undefined) } finally { await handle.close() }
  // Never over an existing root.
  await assert.rejects(restoreStore({ from: backup, to }), { code: 'E_TARGET_EXISTS' })
})

test('store:restore refuses an unfinished or changed backup and leaves no new root', async (t) => {
  const { paths, at } = await migrated(t)
  const backup = at('backup')
  await backupStore(paths, { out: backup, now: NOW })
  const snapshot = path.join(backup, BACKUP_FILES.store)
  const original = await readFile(snapshot)
  const damaged = Buffer.from(original)
  damaged[damaged.length - 1] ^= 0xff
  await writeFile(snapshot, damaged)
  await assert.rejects(restoreStore({ from: backup, to: at('r1') }), { code: 'E_BACKUP_HASH' })
  await writeFile(snapshot, original)
  const manifest = path.join(backup, BACKUP_FILES.manifest)
  const manifestText = await readFile(manifest, 'utf8')
  await writeFile(manifest, manifestText.replace('"revision": 1', '"revision": 2'))
  await assert.rejects(restoreStore({ from: backup, to: at('r2') }), { code: 'E_BACKUP_MANIFEST' })
  await writeFile(manifest, manifestText)
  await rm(path.join(backup, BACKUP_FILES.complete))
  await assert.rejects(restoreStore({ from: backup, to: at('r3') }), { code: 'E_BACKUP_INCOMPLETE' })
  for (const name of ['r1', 'r2', 'r3']) assert.equal(existsSync(at(name)), false, name)
})

test('store:export-v2 writes the five V2 files of the projection, lists what V2 cannot express, and never overwrites', async (t) => {
  const { paths, at, files } = await migrated(t)
  const writer = openStore(storeFileOf(paths), { privatePaths: paths, policy: OFFICIAL_POLICY })
  try {
    await writer.commit({
      requestId: '01960000-0000-7000-8000-00000000f003', baseRevision: 1, kind: 'test.custom-source', actor: 'test',
      commands: [{ op: 'create', table: 'sources', value: { id: 'synthetic:source', revision: 0, title: { names: { en: 'Synthetic' } }, origin: 'user' } }],
    })
  } finally { await writer.close() }
  const out = at('export')
  const result = await exportStoreV2(paths, { out, now: '2026-10-16T00:00:00.000Z' })
  assert.deepEqual((await readdir(out)).sort(), Object.values(V2_FILE_NAMES).sort())
  const written = Object.fromEntries(await Promise.all(V2_FILE_KEYS.map(async (key) => [key, JSON.parse(await readFile(path.join(out, V2_FILE_NAMES[key]), 'utf8'))])))
  assert.deepEqual(readV2(written), readV2(files))
  assert.deepEqual(result.skipped, [{ table: 'sources', id: 'synthetic:source' }])
  assert.ok(result.lines.some((line) => line === '  sources synthetic:source'))
  await assert.rejects(exportStoreV2(paths, { out }), { code: 'E_TARGET_EXISTS' })
})

test('store:export-v2 gives a store migrated without a places file the export time as generated_at', async (t) => {
  const context = await tempPrivateRoot(t, 'starmap-store-backup-')
  const files = sampleV2Files()
  delete files.places
  files.travel.records = []
  files.wantToGo.items = []
  files.travel.display = { homeHiddenCountryIds: [], originCountryIds: [], regionCountryIds: [], regionIncludes: [], navigationHiddenCityIds: [] }
  await writeV2Files(context.paths, files)
  await applyMigration(context.paths, { now: NOW })
  const result = await exportStoreV2(context.paths, { out: path.join(context.directory, 'export'), now: '2026-10-16T00:00:00.000Z' })
  assert.equal(result.files.places.generated_at, '2026-10-16T00:00:00.000Z')
})

test('the three command lines: usage errors, and a real backup, restore and export', async (t) => {
  const { paths, at } = await migrated(t)
  const output = quietly()
  assert.equal(await runStoreBackupCli('backup', [], { privatePaths: paths, ...output }), 1)
  assert.equal(await runStoreBackupCli('restore', ['--from', at('x')], { privatePaths: paths, ...output }), 1)
  assert.equal(await runStoreBackupCli('export-v2', ['--out', at('x'), '--force'], { privatePaths: paths, ...output }), 1)
  assert.equal(await runStoreBackupCli('unknown', [], { privatePaths: paths, ...output }), 1)
  const cli = (args) => spawnSync(process.execPath, [backupScript, ...args], {
    env: { ...process.env, STARMAP_PRIVATE_ROOT: paths.root }, encoding: 'utf8', timeout: 120_000, windowsHide: true,
  })
  const backup = cli(['backup', '--out', at('cli-backup')])
  assert.equal(backup.status, 0, backup.stderr)
  assert.match(backup.stdout, /已备份到/)
  const restore = cli(['restore', '--from', at('cli-backup'), '--to', at('cli-restored')])
  assert.equal(restore.status, 0, restore.stderr)
  assert.match(restore.stdout, /integrity_check 与全量校验通过/)
  const again = cli(['restore', '--from', at('cli-backup'), '--to', at('cli-restored')])
  assert.equal(again.status, 1)
  assert.match(again.stderr, /E_TARGET_EXISTS/)
  const exported = cli(['export-v2', '--out', at('cli-export')])
  assert.equal(exported.status, 0, exported.stderr)
  assert.match(exported.stdout, /没有 V2 表达不了的内容/)
})

test('host: restoredFrom keeps one layer and no revision; snapshots never overwrite; integrity_check runs on request', async (t) => {
  const { paths, at } = await migrated(t)
  const phases = []
  const handle = openStore(storeFileOf(paths), { privatePaths: paths, policy: OFFICIAL_POLICY, unsafeTestPhase: (name) => { phases.push(name) } })
  try {
    assert.equal(Object.hasOwn(handle.meta(), 'restoredFrom'), false)
    await handle.setRestoredFrom({ backupId: 'first' })
    await handle.setRestoredFrom({ backupId: 'second' })
    assert.deepEqual(handle.meta().restoredFrom, { backupId: 'second' })
    assert.equal(handle.meta().revision, 1)
    for (const invalid of [null, [], 'text', { big: 'x'.repeat(5000) }]) {
      await assert.rejects(handle.setRestoredFrom(invalid), { code: 'E_STORE_OPTIONS' }, JSON.stringify(invalid)?.slice(0, 20))
    }
    assert.deepEqual(handle.checkIntegrity({ full: true }), { ok: true, problems: [] })
    assert.deepEqual(phases.filter((name) => name.endsWith('check')), ['integrity-check'])
    const existing = at('existing.sqlite')
    await writeFile(existing, '')
    assert.throws(() => handle.snapshotInto(existing), { code: 'E_STORE_EXISTS' })
    assert.equal((await readFile(existing)).length, 0)
    assert.throws(() => handle.snapshotInto('relative.sqlite'), { code: 'E_STORE_PATH' })
  } finally { await handle.close() }
})
