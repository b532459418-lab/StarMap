/**
 * Seeding the media registry at migration and upgrade (3C-4c, design v2 §5; review §8-5): after store:migrate, and after
 * store:upgrade of a format-1 store, the first scan adds exactly the files V2's own preview would add, and nothing for a
 * library V2 has fully imported. A real V2 import builds each library: synthetic images in a temporary private root,
 * the invented registry of ./media-inbox.fixture.mjs.
 */
import assert from 'node:assert/strict'
import { copyFile, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'
import { sha256File } from '../file-hash.mjs'
import { COLOR, PLACE, inboxFile, makeImage, syntheticPlaces, writeJson, writeSyntheticInbox } from '../media-inbox.fixture.mjs'
import { classifyScan, liveRecordsOf } from '../media-registry.mjs'
import { scanInbox } from '../media-scan.mjs'
import { seedMediaRegistry, mediaRecordsOf } from './media-seed.mjs'
import { storeFileOf } from '../private-data-source.mjs'
import { openStore } from '../store-host.mjs'
import { applyMigration, previewMigration } from './store-migrate.mjs'
import { downgradeStoreToFormat1, tempPrivateRoot } from '../store-mode.fixture.mjs'
import { projectToV2Files } from './store-projection.mjs'
import { upgradeStore } from '../store-upgrade.mjs'
import { scanV2MediaImport } from './v2-media-import.mjs'
import { writeV2MediaImport } from './v2-media-import.fixture.mjs'
import { OFFICIAL, OFFICIAL_POLICY } from '../../src/data/store/officialDefinitions.ts'

// libvips keeps recently read files open (sharp.cache: 20 files by default); Windows then refuses to rewrite an Inbox
// file the V2 import just read. The test rewrites one, so no file stays open.
sharp.cache({ files: 0 })

const NOW = '2026-10-16T00:00:00.000Z'
const EXPLICIT = 'MediaInbox/Second Land/River Town/drone/explicit.jpg'
const HILL_COPY = 'MediaInbox/Synthland/Hill Town/photos/a.jpg'

/**
 * A V2 library fully imported by the V2 importer: the synthetic Inbox, plus the same content as Harbor Town's a.jpg in
 * Hill Town (V2 merges them into one item by content), and a drone file whose sidecar gives an explicit id.
 * `afterImport(paths, files)` changes the Inbox after the import, before anything else.
 */
async function v2Library(t, afterImport) {
  const context = await tempPrivateRoot(t, 'starmap-media-seed-')
  const { paths } = context
  await writeJson(paths.v2FilePaths.places, syntheticPlaces())
  const files = await writeSyntheticInbox(paths)
  await writeJson(path.join(paths.inboxRoot, 'Synthland', 'Hill Town', 'place.json'), { placeId: PLACE.hill })
  await copyFile(inboxFile(paths, files.a), inboxFile(paths, HILL_COPY))
  await makeImage(inboxFile(paths, EXPLICIT), { color: COLOR.purple })
  await writeJson(path.join(paths.inboxRoot, 'Second Land', 'River Town', 'media.json'), {
    'drone/pano-1.jpg': { kind: 'panorama360', titleEn: 'Synthetic panorama', date: '2026-07-03', resolution: '200 × 100' },
    'drone/explicit.jpg': { kind: 'aerialPhoto', id: 'synthetic-explicit', date: '2026-07-04', resolution: '64 × 48' },
  })
  await writeV2MediaImport({ privatePaths: paths, now: () => new Date(NOW) })
  await afterImport?.(paths, files)
  return { ...context, files }
}

/** The Inbox files V2's preview would add now: files whose V2 id the catalog lacks. */
async function v2WouldAdd(paths) {
  const scan = await scanV2MediaImport({ privatePaths: paths })
  const catalog = new Set((scan.files.media?.items ?? []).map((item) => item.id))
  return scan.planned.filter((entry) => !catalog.has(entry.id)).map((entry) => `MediaInbox/${path.relative(paths.inboxRoot, entry.sourcePath).split(path.sep).join('/')}`).sort()
}

/** The first scan of a new library: the classification against its registry, and how many files were hashed. */
async function firstScan(paths) {
  const handle = openStore(storeFileOf(paths), { readOnly: true, policy: OFFICIAL_POLICY })
  let rows, registry, problems
  try { rows = handle.readRowsUnchecked(); registry = handle.mediaRegistry(); problems = handle.check().problems } finally { await handle.close() }
  const { files } = projectToV2Files(rows)
  let hashed = 0
  const scan = await scanInbox({ privatePaths: paths, places: files.places.places, cache: registry.scanCache, hashFile: (file) => { hashed += 1; return sha256File(file) } })
  const classification = classifyScan({ sources: registry.sources, records: liveRecordsOf(rows, registry.assetFiles), facts: scan.facts })
  return { classification, hashed, registry, rows, files, problems }
}
const added = (classification) => classification.newRecords.map((item) => item.fact.path).sort()
const nothingElse = (classification) => ({
  moves: classification.moves.length, confirmations: classification.confirmations.length, gone: classification.gone.length, reappeared: classification.reappeared.length,
})

test('a fully imported library, with content merged across two cities and an explicit sidecar id: the first scan after the migration adds nothing', async (t) => {
  const { paths, files } = await v2Library(t)
  assert.deepEqual(await v2WouldAdd(paths), [], 'V2 itself has nothing to add')
  const preview = await previewMigration(paths, { now: NOW })
  assert.equal(preview.ok, true)
  assert.deepEqual(preview.seed, { files: 5, links: 5, unmanaged: 0, present: 7, missing: 0, unregistered: 0, scanProblems: 0 })
  await applyMigration(paths, { now: NOW })
  const { classification, hashed, registry, rows, problems } = await firstScan(paths)
  assert.deepEqual(problems, [], 'check() passes: every content-addressed asset has its file')
  assert.deepEqual(added(classification), [])
  assert.deepEqual(nothingElse(classification), { moves: 0, confirmations: 0, gone: 0, reappeared: 0 })
  assert.equal(classification.unchanged.length, 7)
  assert.equal(hashed, 0, 'the seeded scan cache spares hashing every registered file')
  // The item V2 merged by content has every file as a source, and V2's duplicate in Harbor Town too.
  const merged = registry.sources.filter((source) => source.sha256 === registry.sources.find((other) => other.path === files.a).sha256)
  assert.deepEqual(merged.map((source) => source.path).sort(), [files.aCopy, files.a, HILL_COPY].sort())
  assert.equal(new Set(merged.map((source) => source.recordId)).size, 1)
  // The explicit id names its own record.
  const explicitSource = registry.sources.find((source) => source.path === EXPLICIT)
  const explicitEntity = rows.entities.find((entity) => entity.id === explicitSource.recordId)
  assert.equal(rows.assets.find((asset) => asset.id === explicitEntity.fields.asset).source.recordId, 'synthetic-explicit')
  // Every media item has its record, its file and its link.
  const mediaEntities = rows.entities.filter((entity) => entity.typeId === OFFICIAL.media)
  assert.equal(mediaEntities.length, 5)
  assert.equal(registry.assetFiles.length, 5)
})

test('a path the old source index lists but the Inbox no longer has: a missing source, no new record; the file coming back elsewhere is a move', async (t) => {
  const { paths, files } = await v2Library(t, async (libraryPaths, inbox) => { await unlink(inboxFile(libraryPaths, inbox.b)) })
  await applyMigration(paths, { now: NOW })
  const first = await firstScan(paths)
  assert.deepEqual(first.problems, [])
  assert.deepEqual(added(first.classification), [])
  assert.deepEqual(nothingElse(first.classification), { moves: 0, confirmations: 0, gone: 0, reappeared: 0 })
  const missing = first.registry.sources.filter((source) => source.state === 'missing')
  assert.deepEqual(missing.map((source) => source.path), [files.b])
  // D1: the record stays (V2 would drop the item at its next import; the new library does not).
  assert.ok(first.rows.entities.some((entity) => entity.id === missing[0].recordId))
  await makeImage(inboxFile(paths, 'MediaInbox/Synthland/Harbor Town/photos/b-back.jpg'), { color: COLOR.green })
  const second = await firstScan(paths)
  assert.deepEqual(second.classification.moves.map((move) => [move.fact.path, move.recordId]), [['MediaInbox/Synthland/Harbor Town/photos/b-back.jpg', missing[0].recordId]])
})

test('files the V2 import has not seen yet: the first scan adds exactly those V2’s preview would add, one record per file', async (t) => {
  const { paths } = await v2Library(t, async (libraryPaths) => {
    await makeImage(inboxFile(libraryPaths, 'MediaInbox/Synthland/Harbor Town/photos/later.jpg'), { color: COLOR.grey })
    await makeImage(inboxFile(libraryPaths, 'MediaInbox/Synthland/Hill Town/photos/later-copy.jpg'), { color: COLOR.grey })
    await makeImage(inboxFile(libraryPaths, 'MediaInbox/Second Land/River Town/drone/later-pano.jpg'), { width: 200, height: 100, color: COLOR.blue })
    await writeJson(path.join(libraryPaths.inboxRoot, 'Second Land', 'River Town', 'media.json'), {
      'drone/pano-1.jpg': { kind: 'panorama360', titleEn: 'Synthetic panorama', date: '2026-07-03', resolution: '200 × 100' },
      'drone/explicit.jpg': { kind: 'aerialPhoto', id: 'synthetic-explicit', date: '2026-07-04', resolution: '64 × 48' },
      'drone/later-pano.jpg': { kind: 'panorama360', date: '2026-07-05', resolution: '200 × 100' },
    })
  })
  const wouldAdd = await v2WouldAdd(paths)
  assert.equal(wouldAdd.length, 3)
  const preview = await previewMigration(paths, { now: NOW })
  assert.equal(preview.seed.unregistered, 3)
  assert.match(preview.lines.join('\n'), /3 个文件 V2 还没有导入/)
  await applyMigration(paths, { now: NOW })
  const { classification, problems } = await firstScan(paths)
  assert.deepEqual(problems, [])
  assert.deepEqual(added(classification), wouldAdd, 'the same files V2 would add; the two of the same content are two records (D2)')
  assert.deepEqual(nothingElse(classification), { moves: 0, confirmations: 0, gone: 0, reappeared: 0 })
})

test('an explicit-id file whose content changed after the V2 import: the first scan asks to confirm a replacement, never adds silently', async (t) => {
  const { paths } = await v2Library(t, async (libraryPaths) => { await writeFile(inboxFile(libraryPaths, EXPLICIT), 'synthetic bytes of another content') })
  await applyMigration(paths, { now: NOW })
  const { classification, problems } = await firstScan(paths)
  assert.deepEqual(problems, [])
  assert.deepEqual(added(classification), [])
  assert.deepEqual(classification.confirmations.map((group) => [group.kinds, group.entries.map((entry) => entry.fact.path)]), [[['replaced'], [EXPLICIT]]])
})

test('the migration refuses a catalog whose generated file is missing or does not match its directory, and creates nothing', async (t) => {
  const { paths } = await v2Library(t)
  const handle = scanV2MediaImport({ privatePaths: paths })
  const directory = (await handle).files.media.items.find((item) => item.kind === 'photo').src.split('/')[3]
  await rm(path.join(paths.userMediaRoot, directory, 'thumb.webp'))
  await assert.rejects(applyMigration(paths, { now: NOW }), (error) => error.code === 'E_MEDIA_SEED' && error.problems.some((line) => line.includes('thumb.webp')))
  const preview = await previewMigration(paths, { now: NOW })
  assert.equal(preview.ok, false)
  assert.equal(openStoreExists(paths), false)
})
const openStoreExists = (paths) => { try { openStore(storeFileOf(paths), { readOnly: true }).close(); return true } catch { return false } }

test('store:upgrade of a format-1 store seeds the same registry as the migration: edits kept, check() passes, the first scan adds nothing', async (t) => {
  const { paths } = await v2Library(t)
  await applyMigration(paths, { now: NOW })
  const migrated = await firstScan(paths)
  // An edit in the new-library mode (a place renamed), then the store as format 1 had it.
  const writer = openStore(storeFileOf(paths), { privatePaths: paths, policy: OFFICIAL_POLICY })
  try {
    const place = writer.readRowsUnchecked().entities.find((entity) => entity.typeId === OFFICIAL.place)
    await writer.commit({ requestId: '019a0000-0000-7000-8000-00000000e001', baseRevision: writer.meta().revision, kind: 'test.edit', actor: 'test', commands: [
      { op: 'update', table: 'entities', id: place.id, expectedRevision: place.revision, value: { ...place, revision: place.revision + 1, title: { names: { en: 'Renamed in the new library' } } } },
    ] })
  } finally { await writer.close() }
  const edited = openStore(storeFileOf(paths), { readOnly: true, policy: OFFICIAL_POLICY })
  const before = edited.readFormalState()
  await edited.close()
  downgradeStoreToFormat1(storeFileOf(paths))
  const { result, check, seed } = await upgradeStore(paths, { requestId: '019a0000-0000-7000-8000-00000000e002' })
  assert.deepEqual([result.upgraded, check.ok], [true, true])
  assert.deepEqual(seed, { files: 5, links: 5, unmanaged: 0, present: 7, missing: 0, unregistered: 0, scanProblems: 0 })
  const after = await firstScan(paths)
  assert.deepEqual(after.problems, [])
  const reader = openStore(storeFileOf(paths), { readOnly: true, policy: OFFICIAL_POLICY })
  try { assert.deepEqual(reader.readFormalState(), before, 'every row and the edit kept') } finally { await reader.close() }
  assert.deepEqual(added(after.classification), [])
  assert.deepEqual(nothingElse(after.classification), { moves: 0, confirmations: 0, gone: 0, reappeared: 0 })
  const shape = (registry) => ({
    files: registry.files.map(({ sha256, directory, extension, bytes, outputs }) => ({ sha256, directory, extension, bytes, outputs })),
    assetFiles: registry.assetFiles,
    sources: registry.sources.map(({ path: pathValue, sha256, recordId, state, descriptionDigest }) => ({ pathValue, sha256, recordId, state, descriptionDigest })),
  })
  assert.deepEqual(shape(after.registry), shape(migrated.registry), 'the upgrade seeds what the migration seeded')
})

test('restoring a backup taken from a format-1 store upgrades the restored store, its registry seeded from the restored media', async (t) => {
  const { paths, directory } = await v2Library(t)
  await applyMigration(paths, { now: NOW })
  const { backupStore, restoreStore, BACKUP_FILES } = await import('../store-backup.mjs')
  const out = path.join(directory, 'backup')
  await backupStore(paths, { out, now: NOW, backupId: '019a0000-0000-7000-8000-00000000e010' })
  // The backup as the 3C-4b program wrote it for a format-1 store: its snapshot at format 1, the hashes to match.
  const snapshot = path.join(out, BACKUP_FILES.store)
  downgradeStoreToFormat1(snapshot)
  const { readFile } = await import('node:fs/promises')
  const { createHash } = await import('node:crypto')
  const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const manifestFile = path.join(out, BACKUP_FILES.manifest)
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  const snapshotBytes = await readFile(snapshot)
  manifest.files[BACKUP_FILES.store] = { bytes: snapshotBytes.length, sha256: sha(snapshotBytes) }
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
  const complete = JSON.parse(await readFile(path.join(out, BACKUP_FILES.complete), 'utf8'))
  await writeFile(path.join(out, BACKUP_FILES.complete), `${JSON.stringify({ ...complete, manifestSha256: sha(await readFile(manifestFile)) }, null, 2)}\n`)
  const to = path.join(directory, 'restored')
  const restored = await restoreStore({ from: out, to, now: '2026-10-17T00:00:00.000Z' })
  assert.match(restored.lines.join('\n'), /integrity_check 与全量校验通过/)
  const { getPrivatePaths } = await import('../private-profile.mjs')
  const restoredPaths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: to })
  const first = await firstScan(restoredPaths)
  assert.deepEqual(first.problems, [])
  assert.equal(first.registry.assetFiles.length, 5)
  assert.deepEqual(added(first.classification), [])
  assert.deepEqual(nothingElse(first.classification), { moves: 0, confirmations: 0, gone: 0, reappeared: 0 })
})

test('seedMediaRegistry without an Inbox: the files and links only, nothing reported as a scan problem', async (t) => {
  const { paths } = await v2Library(t)
  await rm(paths.inboxRoot, { recursive: true, force: true })
  const scan = await scanV2MediaImport({ privatePaths: paths })
  void scan
  const { readV2Inputs, migrationOf } = await import('./store-migrate.mjs')
  const { values } = await readV2Inputs(paths)
  const { createdRowsOf } = await import('./media-seed.mjs')
  const seeded = await seedMediaRegistry({ privatePaths: paths, places: values.places, media: values.media, records: mediaRecordsOf(createdRowsOf(migrationOf(values, { now: NOW }).commands)) })
  assert.deepEqual(seeded.problems, [])
  assert.deepEqual(seeded.report, { files: 5, links: 5, unmanaged: 0, present: 0, missing: 0, unregistered: 0, scanProblems: 0 })
  assert.deepEqual(Object.keys(seeded.media).sort(), ['assetFiles', 'files'])
})
