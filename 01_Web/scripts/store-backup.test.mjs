import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { createBrowserFixture, fixtureIds } from './browser-fixture.mjs'
import { withLibraryOperation } from './library-operation-lock.mjs'
import { createMediaJobStore } from './media-job-store.mjs'
import { getPrivatePaths, webRoot } from './private-profile.mjs'
import { privateDataSource, storeFileOf } from './private-data-source.mjs'
import {
  BACKUP_FILES, backupStore, mediaCopyInProgress, restoreStore, runStoreBackupCli, verifyBackup,
} from './store-backup.mjs'
import { exportStoreV2, exportedV2Of, runExportV2Cli } from './compat/store-export-v2.mjs'
import { writeV2MediaImport } from './compat/v2-media-import.fixture.mjs'
import { openStore } from './store-host.mjs'
import { applyMigration } from './compat/store-migrate.mjs'
import { projectToV2Files } from './compat/store-projection.mjs'
import { edgeV2Files, quietly, sampleV2Files, tempPrivateRoot, treeDigest, writeV2Files } from './store-mode.fixture.mjs'
import { readV2 } from '../src/data/compat/v2/v2Reader.ts'
import { V2_FILE_KEYS, V2_FILE_NAMES } from '../src/data/compat/v2/v2Schema.ts'
import { OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'
import { migrateIntoEmptyStore, migrationInputs } from '../src/data/store/v2Store.fixture.ts'
import { readModelOf } from '../src/worldgraph/readModel/build.ts'

const NOW = '2026-10-14T00:00:00.000Z'
const backupScript = fileURLToPath(new URL('./store-backup.mjs', import.meta.url))
const exportScript = fileURLToPath(new URL('./compat/store-export-v2.mjs', import.meta.url))

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
  assert.deepEqual((await readdir(out)).sort(), [...Object.values(V2_FILE_NAMES), 'media-source-index.local.json'].sort())
  const written = Object.fromEntries(await Promise.all(V2_FILE_KEYS.map(async (key) => [key, JSON.parse(await readFile(path.join(out, V2_FILE_NAMES[key]), 'utf8'))])))
  assert.deepEqual(readV2(written), readV2(files))
  // 3C-5B: read model → official view → serializeV2 exports what the projection of the rows exported before, to the byte.
  const reader = openStore(storeFileOf(paths), { readOnly: true, policy: OFFICIAL_POLICY })
  try {
    const before = projectToV2Files(reader.readFormalState()).files
    for (const key of V2_FILE_KEYS) assert.equal(await readFile(path.join(out, V2_FILE_NAMES[key]), 'utf8'), `${JSON.stringify(before[key], null, 2)}\n`, key)
  } finally { await reader.close() }
  assert.deepEqual(result.skipped, [{ table: 'sources', id: 'synthetic:source' }])
  assert.ok(result.lines.some((line) => line === '  sources synthetic:source'))
  await assert.rejects(exportStoreV2(paths, { out }), { code: 'E_TARGET_EXISTS' })
})

test('store:export-v2 through the read model (3C-5B): the same JSON as the projection of the rows, for every migration input', () => {
  for (const [name, files] of migrationInputs()) {
    const { state } = migrateIntoEmptyStore(files())
    const viaReadModel = exportedV2Of(readModelOf(state, { origin: 'local' }))
    const viaRows = projectToV2Files(state)
    assert.equal(JSON.stringify(viaReadModel.files), JSON.stringify(viaRows.files), name)
    assert.deepEqual(viaReadModel.projection.skipped, viaRows.projection.skipped, name)
  }
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
  assert.equal(await runExportV2Cli(['--out', at('x'), '--force'], { privatePaths: paths, ...output }), 1)
  assert.equal(await runStoreBackupCli('export-v2', ['--out', at('x')], { privatePaths: paths, ...output }), 1, '3C-5 E: store:export-v2 is its own command (scripts/compat/)')
  assert.equal(await runStoreBackupCli('unknown', [], { privatePaths: paths, ...output }), 1)
  const cli = (args, script = backupScript) => spawnSync(process.execPath, [script, ...args], {
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
  const exported = cli(['--out', at('cli-export')], exportScript)
  assert.equal(exported.status, 0, exported.stderr)
  assert.match(exported.stdout, /没有 V2 表达不了的内容/)
})

// ---------------------------------------------------------------------------
// Media (3C-4b)
// ---------------------------------------------------------------------------

const writeJson = async (target, value) => {
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, `${JSON.stringify(value)}\n`)
}
const fileSha256 = async (file) => createHash('sha256').update(await readFile(file)).digest('hex')

/**
 * A new-library root with media: the browser fixture, one neutral photo imported by the V2 importer (original in
 * MediaInbox/, derivatives in media/user/, the media source index), then migrated. Only synthetic files.
 */
async function migratedWithMedia(t) {
  const context = await tempPrivateRoot(t, 'starmap-store-backup-media-')
  const { root, paths } = context
  // The V2 files of the fixture (3C-4d: its default is a new library), imported by V2, then migrated below.
  await createBrowserFixture(root, { mode: 'v2' })
  const city = path.join(paths.inboxRoot, 'Iceland', 'Reykjavik')
  await writeJson(path.join(paths.inboxRoot, 'Iceland', 'place.json'), { placeId: fixtureIds.iceland })
  await writeJson(path.join(city, 'place.json'), { placeId: fixtureIds.reykjavik })
  await mkdir(path.join(city, 'photos'), { recursive: true })
  await sharp({ create: { width: 48, height: 32, channels: 3, background: { r: 80, g: 140, b: 190 } } }).png().toFile(path.join(city, 'photos', 'neutral.png'))
  await writeV2MediaImport({ privatePaths: paths })
  await applyMigration(paths, { now: NOW })
  assert.equal(privateDataSource(paths), 'store')
  return { ...context, at: (name) => path.join(context.directory, name) }
}

test('store:backup copies the media with the rules of npm run backup and records each file\'s size and SHA-256; restore puts it back byte for byte', async (t) => {
  const { root, paths, at } = await migratedWithMedia(t)
  // Generated sentinels only: excluded by the rules (config/, and a README in the Inbox, which is skipped).
  await writeFile(path.join(root, 'config', '.env.local'), 'SYNTHETIC_EXCLUDED_SENTINEL')
  await writeFile(path.join(paths.inboxRoot, 'README.md'), 'Synthetic ignored readme')
  const before = await readProjection(paths)
  const out = at('backup')
  let duringCopy
  const result = await backupStore(paths, {
    out, now: NOW, backupId: '01960000-0000-7000-8000-00000000f010',
    onMediaCopy: async () => {
      // The lease is released before the media is copied; queued deletions wait for the mark meanwhile.
      duringCopy = { locked: existsSync(path.join(root, 'operations', 'library-operation.lock')), paused: await mediaCopyInProgress(paths) }
    },
  })
  assert.deepEqual(duringCopy, { locked: false, paused: true })
  assert.equal(await mediaCopyInProgress(paths), false, 'the mark is gone after the backup')
  const { media } = result.manifest
  assert.equal(result.manifest.formatVersion, 2)
  assert.equal(media.count, media.entries.length)
  const listed = media.entries.map((entry) => entry.path)
  assert.equal(listed.includes('data/v2/media-source-index.local.json'), false, 'the V2 media source index stays out (3C-4c): the registry is in the store')
  assert.ok(listed.includes('MediaInbox/Iceland/Reykjavik/photos/neutral.png'))
  assert.ok(listed.includes('MediaInbox/Iceland/Reykjavik/place.json'))
  assert.ok(listed.some((file) => file.startsWith('media/user/') && file.endsWith('thumb.webp')))
  assert.ok(listed.some((file) => file.startsWith('media/user/') && file.endsWith('preview.webp')))
  assert.ok(listed.every((file) => !file.startsWith('config/') && !file.startsWith('operations/') && !file.endsWith('README.md')))
  // Every listed size and SHA-256 is the file's own, and the copy is the same bytes.
  for (const entry of media.entries) {
    const original = path.join(root, ...entry.path.split('/'))
    assert.equal((await stat(original)).size, entry.bytes, entry.path)
    assert.equal(await fileSha256(original), entry.sha256, entry.path)
    assert.deepEqual(await readFile(path.join(out, 'payload', ...entry.path.split('/'))), await readFile(original), entry.path)
  }
  assert.equal(media.bytes, media.entries.reduce((sum, entry) => sum + entry.bytes, 0))
  assert.deepEqual(await verifyBackup(out), result.manifest)

  const to = at('restored')
  const restored = await restoreStore({ from: out, to, now: '2026-10-15T00:00:00.000Z' })
  assert.match(restored.lines.join('\n'), new RegExp(`媒体：${media.count} 个文件`))
  const restoredPaths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: to })
  assert.equal(privateDataSource(restoredPaths), 'store')
  for (const entry of media.entries) {
    assert.deepEqual(await readFile(path.join(to, ...entry.path.split('/'))), await readFile(path.join(root, ...entry.path.split('/'))), entry.path)
  }
  // The new root holds the store and the media, nothing else.
  const tree = Object.keys(await treeDigest(to)).filter((file) => file !== 'data/store/world.sqlite-journal').sort()
  assert.deepEqual(tree, ['data/store/world.sqlite', ...listed].sort())
  const after = await readProjection(restoredPaths)
  assert.deepEqual(after.files, before.files)
  assert.ok(after.files.media.items.length > 0)
  // The media registry and the files correspond (3C-4c): check() passes and every registered generated file is there
  // with the SHA-256 the registry recorded.
  const handle = openStore(storeFileOf(restoredPaths), { readOnly: true, policy: OFFICIAL_POLICY })
  let registry
  try {
    assert.deepEqual(handle.check().problems, [])
    registry = handle.mediaRegistry()
  } finally { await handle.close() }
  assert.ok(registry.files.length > 0)
  assert.ok(registry.sources.some((source) => source.path === 'MediaInbox/Iceland/Reykjavik/photos/neutral.png' && source.state === 'present'))
  for (const file of registry.files) {
    for (const output of file.outputs) assert.equal(await fileSha256(path.join(to, ...file.directory.split('/'), output.name)), output.sha256, output.name)
  }
})

test('store:backup refuses a generated file whose content is not the one the media registry recorded (3C-4c)', async (t) => {
  const { root, paths, at } = await migratedWithMedia(t)
  const handle = openStore(storeFileOf(paths), { readOnly: true, policy: OFFICIAL_POLICY })
  let registry
  try { registry = handle.mediaRegistry() } finally { await handle.close() }
  const [file] = registry.files
  const thumb = file.outputs.find((output) => output.name.endsWith('thumb.webp'))
  const target = path.join(root, ...file.directory.split('/'), thumb.name)
  await writeFile(target, await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } }).webp().toBuffer())
  await assert.rejects(backupStore(paths, { out: at('backup'), now: NOW }), { code: 'E_BACKUP_MEDIA_REGISTRY' })
  assert.equal(existsSync(at('backup')), false)
  assert.equal(await mediaCopyInProgress(paths), false)
})

test('store:restore fails on a damaged, missing or extra media file, or a media path outside the allowlist, and removes the new root', async (t) => {
  const { paths, at } = await migratedWithMedia(t)
  const out = at('backup')
  const { manifest } = await backupStore(paths, { out, now: NOW })
  const original = manifest.media.entries.find((entry) => entry.path.endsWith('neutral.png'))
  const copy = path.join(out, 'payload', ...original.path.split('/'))
  const bytes = await readFile(copy)
  // Same size, one bit flipped.
  const damaged = Buffer.from(bytes)
  damaged[damaged.length >> 1] ^= 0x01
  await writeFile(copy, damaged)
  await assert.rejects(restoreStore({ from: out, to: at('r1') }), { code: 'E_BACKUP_HASH' })
  assert.equal(existsSync(at('r1')), false, 'the new root is removed')
  // Missing and extra files are found before anything is created.
  await rm(copy)
  await assert.rejects(restoreStore({ from: out, to: at('r2') }), { code: 'E_BACKUP_MEDIA_FILES' })
  await writeFile(copy, bytes)
  await writeFile(path.join(out, 'payload', 'MediaInbox', 'extra.png'), 'Synthetic extra')
  await assert.rejects(restoreStore({ from: out, to: at('r3') }), { code: 'E_BACKUP_MEDIA_FILES' })
  await rm(path.join(out, 'payload', 'MediaInbox', 'extra.png'))
  // A manifest that names a file outside the media folders is refused even with a matching completion mark.
  const manifestFile = path.join(out, BACKUP_FILES.manifest)
  const completeFile = path.join(out, BACKUP_FILES.complete)
  const manifestText = await readFile(manifestFile, 'utf8')
  const completeText = await readFile(completeFile, 'utf8')
  for (const bad of ['config/.env.local', 'data/store/world.sqlite', 'MediaInbox/../escape.png', 'media/user/notes.txt']) {
    const crafted = JSON.parse(manifestText)
    crafted.media.entries[0].path = bad
    const text = `${JSON.stringify(crafted, null, 2)}\n`
    await writeFile(manifestFile, text)
    await writeFile(completeFile, JSON.stringify({ ...JSON.parse(completeText), manifestSha256: createHash('sha256').update(text).digest('hex') }))
    await assert.rejects(restoreStore({ from: out, to: at('r4') }), { code: 'E_BACKUP_MANIFEST' }, bad)
  }
  await writeFile(manifestFile, manifestText)
  await writeFile(completeFile, completeText)
  for (const name of ['r2', 'r3', 'r4']) assert.equal(existsSync(at(name)), false, name)
  // Untouched again: the backup restores.
  await restoreStore({ from: out, to: at('r5') })
})

test('store:backup refuses an unfinished media task, a file outside the allowlist and an output inside the media folders', async (t) => {
  const { root, paths, at } = await migratedWithMedia(t)
  const task = await withLibraryOperation(paths, () => createMediaJobStore(paths).create({
    countryId: fixtureIds.iceland, cityId: fixtureIds.reykjavik, kind: 'photo', files: [{ fileName: 'neutral-pending.png', bytes: 32 }],
  }))
  await assert.rejects(backupStore(paths, { out: at('pending') }), { code: 'E_MEDIA_JOB_PENDING' })
  assert.equal(existsSync(at('pending')), false)
  assert.equal(await mediaCopyInProgress(paths), false)
  await withLibraryOperation(paths, () => createMediaJobStore(paths).abandon(task.jobId, task.revision))
  const notes = path.join(paths.inboxRoot, 'Iceland', 'notes.txt')
  await writeFile(notes, 'Synthetic unsupported file')
  await assert.rejects(backupStore(paths, { out: at('unsupported') }), { code: 'E_BACKUP_UNSUPPORTED_FILE' })
  assert.equal(existsSync(at('unsupported')), false)
  assert.equal(await mediaCopyInProgress(paths), false)
  await rm(notes)
  await assert.rejects(backupStore(paths, { out: path.join(paths.inboxRoot, 'backup') }), { code: 'E_TARGET_OVERLAP' })
  await assert.rejects(backupStore(paths, { out: path.join(root, 'media', 'user', 'backup') }), { code: 'E_TARGET_OVERLAP' })
  // A name that merely begins with `..` is inside the folder all the same (batch 7: refusals count it as inside).
  for (const name of ['..x', '...']) {
    await assert.rejects(backupStore(paths, { out: path.join(paths.inboxRoot, name) }), { code: 'E_TARGET_OVERLAP' })
  }
  // Inside the private root but outside its media and data folders is fine.
  const inside = await backupStore(paths, { out: path.join(root, 'backups', 'one') })
  assert.ok(inside.manifest.media.entries.every((entry) => !entry.path.includes('backups')))
})

test('npm run backup on a new-library root delegates to store:backup and says so; its inspect and restore point store backups to store:restore', async (t) => {
  const { root, at } = await migratedWithMedia(t)
  const cli = (args) => spawnSync(process.execPath, [fileURLToPath(new URL('./backup.mjs', import.meta.url)), ...args], {
    env: { ...process.env, STARMAP_PRIVATE_ROOT: root }, encoding: 'utf8', timeout: 120_000, windowsHide: true,
  })
  const out = at('delegated')
  const created = cli(['create', '--root', root, '--out', out])
  assert.equal(created.status, 0, created.stderr)
  const report = JSON.parse(created.stdout)
  assert.equal(report.mode, 'store')
  assert.equal(report.delegatedTo, 'store:backup')
  assert.match(report.note, /npm run store:backup/)
  assert.ok(report.mediaFiles > 0)
  const manifest = await verifyBackup(out)
  assert.equal(manifest.media.count, report.mediaFiles)
  // A refusal of store:backup is printed with its code.
  const again = cli(['create', '--root', root, '--out', out])
  assert.equal(again.status, 1)
  assert.match(again.stderr, /E_TARGET_EXISTS/)
  for (const args of [['inspect', '--from', out], ['restore', '--from', out, '--to', at('v2-restore'), '--apply']]) {
    const refused = cli(args)
    assert.equal(refused.status, 1, args[0])
    assert.match(refused.stderr, /E_BACKUP_STORE_FORMAT[\s\S]*npm run store:restore/, args[0])
  }
  assert.equal(existsSync(at('v2-restore')), false)
})

test('media paths outside /media/user/ are not files of the private root: counted in a warning, not a refusal', async (t) => {
  const { paths, at } = await migrated(t, edgeV2Files())
  const { manifest, lines } = await backupStore(paths, { out: at('backup'), now: NOW })
  assert.equal(manifest.media.count, 0)
  assert.deepEqual(manifest.media.warnings, [
    'MEDIA_OUTSIDE_USER_MEDIA: 4 media paths are outside /media/user/ and are not files of the private root.',
  ])
  assert.ok(lines.some((line) => line.startsWith('提醒：MEDIA_OUTSIDE_USER_MEDIA')))
  await restoreStore({ from: at('backup'), to: at('restored') })
})

test('store:restore still restores a 3C-3 backup (format version 1, the database only)', async (t) => {
  const { paths, at } = await migrated(t)
  const out = at('backup')
  await backupStore(paths, { out, now: NOW })
  const manifestFile = path.join(out, BACKUP_FILES.manifest)
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  manifest.formatVersion = 1
  delete manifest.media
  manifest.excludes = ['media', 'MediaInbox', 'config', 'data/v2', 'operations']
  const text = `${JSON.stringify(manifest, null, 2)}\n`
  await writeFile(manifestFile, text)
  const complete = JSON.parse(await readFile(path.join(out, BACKUP_FILES.complete), 'utf8'))
  await writeFile(path.join(out, BACKUP_FILES.complete), JSON.stringify({ ...complete, manifestSha256: createHash('sha256').update(text).digest('hex') }))
  await rm(path.join(out, BACKUP_FILES.media), { recursive: true })
  const result = await restoreStore({ from: out, to: at('restored') })
  assert.match(result.lines.join('\n'), /旧格式备份（3C-3），没有媒体/)
  assert.deepEqual((await readProjection(getPrivatePaths({ STARMAP_PRIVATE_ROOT: at('restored') }))).files, (await readProjection(paths)).files)
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
