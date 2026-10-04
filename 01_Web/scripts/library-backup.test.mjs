import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { createBackup, inspectBackup, restoreBackup, portablePath } from './library-backup.mjs'
import { createBrowserFixture, fixtureIds } from './browser-fixture.mjs'
import { getPrivatePaths, V2_DATA_FILE_NAMES } from './private-profile.mjs'
import { runV2MediaImport } from './v2-media-import.mjs'
import { withLibraryOperation } from './library-operation-lock.mjs'
import { createMediaJobStore } from './media-job-store.mjs'

const writeJson = async (target, value) => {
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(value) + '\n')
}
const readJson = async target => JSON.parse(await readFile(target, 'utf8'))
async function fixture(t, { media = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'starmap-backup-test-'))
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
  assert.ok(path.basename(directory).startsWith('starmap-backup-test-'))
  t.after(async () => {
    const resolved = path.resolve(directory)
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
    assert.ok(path.basename(resolved).startsWith('starmap-backup-test-'))
    await rm(resolved, { recursive: true, force: true })
  })
  const root = path.join(directory, 'private')
  await createBrowserFixture(root)
  const paths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: root })
  if (media) {
    const city = path.join(paths.inboxRoot, 'Iceland', 'Reykjavik')
    await mkdir(path.join(city, 'photos'), { recursive: true })
    await writeJson(path.join(paths.inboxRoot, 'Iceland', 'place.json'), { placeId: fixtureIds.iceland })
    await writeJson(path.join(city, 'place.json'), { placeId: fixtureIds.reykjavik })
    await sharp({ create: { width: 48, height: 32, channels: 3, background: { r: 80, g: 140, b: 190 } } }).png().toFile(path.join(city, 'photos', 'neutral.png'))
    assert.equal(await runV2MediaImport({ privatePaths: paths, apply: true, log: () => {}, logError: () => {} }), 0)
    const catalog = await readJson(paths.v2FilePaths.media)
    const state = await readJson(paths.v2FilePaths.editorState)
    state.coverMediaByCity[fixtureIds.reykjavik] = catalog.items[0].id
    state.mediaOrderByCity[fixtureIds.reykjavik] = [catalog.items[0].id]
    state.hiddenMediaIds = [catalog.items[0].id]
    await writeJson(paths.v2FilePaths.editorState, state)
  }
  return { directory, root, paths, bundle: path.join(directory, 'backup'), restored: path.join(directory, 'restored') }
}

test('full roundtrip preserves V2 bytes, IDs, hidden/cover state, imported originals, derivatives and source index; preview is read-only', async t => {
  const { root, paths, bundle, restored } = await fixture(t, { media: true })
  // Generated sentinel only: never read an actual environment file.
  await writeFile(path.join(root, 'config', '.env.local'), 'SYNTHETIC_EXCLUDED_SENTINEL')
  await mkdir(path.join(root, 'docs'))
  await writeFile(path.join(root, 'docs', 'private-notes.md'), 'Synthetic excluded document')
  const created = await createBackup(root, bundle)
  assert.equal(created.mediaItems, 1)
  const { manifest } = await inspectBackup(bundle)
  assert.ok(manifest.entries.some(entry => entry.path === 'data/v2/media-source-index.local.json'))
  assert.ok(manifest.entries.some(entry => entry.path.endsWith('thumb.webp')))
  assert.ok(manifest.entries.some(entry => entry.path.endsWith('preview.webp')))
  assert.ok(manifest.entries.every(entry => !entry.path.startsWith('config/') && !entry.path.startsWith('docs/') && !entry.path.endsWith('.bak')))
  assert.equal((await restoreBackup(bundle, restored)).status, 'restore-preview')
  await assert.rejects(readdir(restored), { code: 'ENOENT' })
  assert.equal((await restoreBackup(bundle, restored, { apply: true })).status, 'restored-new-directory')
  for (const entry of manifest.entries) assert.deepEqual(await readFile(path.join(root, entry.path)), await readFile(path.join(restored, entry.path)))
  for (const name of Object.values(V2_DATA_FILE_NAMES)) assert.deepEqual(await readFile(path.join(root, 'data', 'v2', name)), await readFile(path.join(restored, 'data', 'v2', name)))
  await assert.rejects(readFile(path.join(restored, 'config', '.env.local')), { code: 'ENOENT' })
  // Real importer can resolve the restored original and retain its existing media identity.
  const before = await readJson(paths.v2FilePaths.media)
  const restoredPaths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: restored })
  assert.equal(await runV2MediaImport({ privatePaths: restoredPaths, apply: true, log: () => {}, logError: () => {} }), 0)
  assert.deepEqual((await readJson(restoredPaths.v2FilePaths.media)).items.map(item => item.id), before.items.map(item => item.id))
})

test('backup roundtrip excludes RD-07 jobs and staging, preserves original pending bytes, and initializes a new restored-library identity only on explicit create', async t => {
  const { root, paths, bundle, restored } = await fixture(t, { media: true })
  const store = createMediaJobStore(paths)
  const task = await withLibraryOperation(paths, () => store.create({
    countryId: fixtureIds.iceland, cityId: fixtureIds.reykjavik, kind: 'photo',
    files: [{ fileName: 'neutral-pending.png', bytes: 32 }],
  }))
  const staging = path.join(root, 'operations', 'media-import', 'v1', 'staging', task.jobId, 'synthetic.part')
  await mkdir(path.dirname(staging), { recursive: true })
  await writeFile(staging, 'Synthetic incomplete task bytes')
  const taskPath = path.join(root, 'operations', 'media-import', 'v1', 'jobs', `${task.jobId}.json`)
  const taskBytes = await readFile(taskPath)
  const stagingBytes = await readFile(staging)
  async function dataDigests(base) {
    const entries = []
    async function walk(relative) {
      for (const entry of await readdir(path.join(base, relative), { withFileTypes: true })) {
        const name = path.join(relative, entry.name)
        if (entry.isDirectory()) await walk(name)
        else entries.push([name, createHash('sha256').update(await readFile(path.join(base, name))).digest('hex')])
      }
    }
    for (const scope of ['data/v2', 'MediaInbox', 'media/user']) await walk(scope)
    return entries.sort((a, b) => a[0].localeCompare(b[0]))
  }
  const before = await dataDigests(root)
  // The existing backup contract deliberately excludes editor .bak history.
  // Preserve that original history byte-for-byte while comparing restored active data.
  const activeData = before.filter(([name]) => !name.endsWith('.bak'))
  await createBackup(root, bundle)
  const { manifest } = await inspectBackup(bundle)
  assert.ok(manifest.entries.every(entry => !entry.path.startsWith('operations/')))
  assert.ok(manifest.entries.some(entry => entry.path === 'data/v2/media-source-index.local.json'))
  assert.equal((await restoreBackup(bundle, restored, { apply: true })).status, 'restored-new-directory')
  assert.deepEqual(await dataDigests(root), before)
  assert.deepEqual(await dataDigests(restored), activeData)
  assert.deepEqual(await readFile(taskPath), taskBytes)
  assert.deepEqual(await readFile(staging), stagingBytes)
  assert.deepEqual(await store.read(task.jobId), task)

  const restoredPaths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: restored })
  const restoredStore = createMediaJobStore(restoredPaths)
  assert.deepEqual(await restoredStore.discover(), { libraryId: null, jobs: [] })
  await assert.rejects(readdir(path.join(restored, 'operations')), { code: 'ENOENT' })
  const newTask = await withLibraryOperation(restoredPaths, () => restoredStore.create({
    countryId: fixtureIds.iceland, cityId: fixtureIds.reykjavik, kind: 'photo',
    files: [{ fileName: 'new-explicit-intent.png', bytes: 32 }],
  }))
  assert.notEqual(newTask.libraryId, task.libraryId)
  assert.notEqual(newTask.jobId, task.jobId)
  assert.equal((await restoredStore.discover()).jobs[0].jobId, newTask.jobId)
  assert.deepEqual(await dataDigests(root), before)
  assert.deepEqual(await dataDigests(restored), activeData)
  assert.deepEqual(await readFile(taskPath), taskBytes)
  assert.deepEqual(await readFile(staging), stagingBytes)
})

test('existing restore target and existing backup directory are refused without changing original bytes', async t => {
  const { root, paths, bundle } = await fixture(t)
  await createBackup(root, bundle)
  const before = await readFile(paths.v2FilePaths.places)
  await assert.rejects(restoreBackup(bundle, root, { apply: true }), /E_BACKUP_TARGET_EXISTS/)
  await assert.rejects(createBackup(root, bundle), /E_BACKUP_TARGET_EXISTS/)
  assert.deepEqual(await readFile(paths.v2FilePaths.places), before)
})

test('tampered bytes and missing payload are refused before creating a restore directory', async t => {
  const { bundle, root, restored } = await fixture(t)
  await createBackup(root, bundle)
  const file = path.join(bundle, 'payload', 'data', 'v2', V2_DATA_FILE_NAMES.places)
  await writeFile(file, '{}')
  await assert.rejects(restoreBackup(bundle, restored, { apply: true }), /E_BACKUP_CHECKSUM/)
  await assert.rejects(readdir(restored), { code: 'ENOENT' })
  await rm(file)
  await assert.rejects(inspectBackup(bundle), /E_BACKUP_EXTRA_FILE/)
})

test('invalid schema versions and dangling place IDs refuse backup before publishing', async t => {
  const { root, paths, bundle } = await fixture(t, { media: true })
  const original = await readJson(paths.v2FilePaths.wantToGo)
  original.items[0].placeId = '019b76da-ffff-7000-8000-000000000999'
  await writeJson(paths.v2FilePaths.wantToGo, original)
  await assert.rejects(createBackup(root, bundle), /E_BACKUP_INTEGRITY/)
  await createBrowserFixture(root)
  const places = await readJson(paths.v2FilePaths.places)
  places.schema_version = 999
  await writeJson(paths.v2FilePaths.places, places)
  await assert.rejects(createBackup(root, bundle), /E_BACKUP_INTEGRITY/)
})

test('missing original/derivative, missing indexed source or invalid folder pin blocks a full-media backup', async t => {
  const { root, paths, bundle } = await fixture(t, { media: true })
  const catalog = await readJson(paths.v2FilePaths.media)
  const preview = path.join(root, catalog.items[0].variants.preview.src.slice(1))
  const bytes = await readFile(preview)
  await rm(preview)
  await assert.rejects(createBackup(root, bundle), /E_BACKUP_MEDIA_MISSING/)
  await writeFile(preview, bytes)
  const index = await readJson(paths.v2MediaSourceIndexPath)
  index.sourcesById[catalog.items[0].id] = ['Iceland/Reykjavik/photos/missing.png']
  await writeJson(paths.v2MediaSourceIndexPath, index)
  await assert.rejects(createBackup(root, bundle), /E_BACKUP_MEDIA_MISSING/)
  index.sourcesById[catalog.items[0].id] = ['Iceland/Reykjavik/photos/neutral.png']
  await writeJson(paths.v2MediaSourceIndexPath, index)
  await writeJson(path.join(paths.inboxRoot, 'Iceland', 'place.json'), { placeId: 'missing' })
  await assert.rejects(createBackup(root, bundle), /E_BACKUP_PIN/)
})

test('manifest traversal, credentials, case collisions and unexpected payload cannot reach restoration', async t => {
  const { root, bundle, restored } = await fixture(t)
  await createBackup(root, bundle)
  const manifestFile = path.join(bundle, 'manifest.json')
  const original = await readJson(manifestFile)
  for (const bad of ['../escape.json', 'config/.env.local', 'C:/escape.json', 'MediaInbox/a\\b.png']) {
    const manifest = structuredClone(original)
    manifest.entries[0].path = bad
    await writeJson(manifestFile, manifest)
    await assert.rejects(restoreBackup(bundle, restored, { apply: true }), /E_BACKUP_(PATH|MANIFEST)/)
  }
  const duplicate = structuredClone(original)
  duplicate.entries.push(duplicate.entries[0])
  await writeJson(manifestFile, duplicate)
  await assert.rejects(inspectBackup(bundle), /E_BACKUP_COLLISION/)
  const collision = structuredClone(original)
  collision.entries.push({ path: 'MediaInbox/Iceland/Reykjavik/photos/Neutral.png', bytes: 1, sha256: 'a'.repeat(64) }, { path: 'MediaInbox/iceland/reykjavik/photos/neutral.png', bytes: 1, sha256: 'a'.repeat(64) })
  await writeJson(manifestFile, collision)
  await assert.rejects(inspectBackup(bundle), /E_BACKUP_COLLISION/)
  await writeJson(manifestFile, original)
  await mkdir(path.join(bundle, 'payload', 'config'))
  await writeFile(path.join(bundle, 'payload', 'config', '.env.local'), 'SYNTHETIC_EXCLUDED_SENTINEL')
  await assert.rejects(inspectBackup(bundle), /E_BACKUP_EXTRA_FILE/)
  await assert.rejects(readdir(restored), { code: 'ENOENT' })
})

test('portable path policy rejects device names, ADS, trailing dots, traversal and control characters', () => {
  for (const value of ['MediaInbox/CON/a.png', 'media/user/a.png:secret', 'MediaInbox/a./x.png', 'media/user/../x.png', 'media/user//x.png', 'media/user/\0.png']) assert.throws(() => portablePath(value), /E_BACKUP_PATH/)
  assert.equal(portablePath('MediaInbox/冰岛/雷克雅未克/photos/neutral.png'), 'MediaInbox/冰岛/雷克雅未克/photos/neutral.png')
})

test('directory symlinks/junctions are refused without copying the outside file', async t => {
  const { root, paths, directory, bundle } = await fixture(t)
  const outside = path.join(directory, 'outside')
  await mkdir(outside)
  await writeFile(path.join(outside, 'neutral.png'), 'Synthetic outside sentinel')
  await mkdir(paths.inboxRoot)
  await symlink(outside, path.join(paths.inboxRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(createBackup(root, bundle), /E_BACKUP_LINK/)
  await assert.rejects(readdir(bundle), { code: 'ENOENT' })
})

test('unsafe output overlap and non-migrated legacy data are refused', async t => {
  const { root, directory, bundle } = await fixture(t)
  await assert.rejects(createBackup(root, path.join(root, 'backups')), /E_BACKUP_OVERLAP/)
  const legacy = path.join(directory, 'legacy')
  await writeJson(path.join(legacy, 'data', 'travel-map.local.json'), { schema_version: 1, records: [] })
  await assert.rejects(createBackup(legacy, bundle), /E_BACKUP_LEGACY/)
})

test('inspection rechecks V2 semantics even after an attacker replaces a checksum in the manifest', async t => {
  const { root, bundle } = await fixture(t)
  await createBackup(root, bundle)
  const manifest = await readJson(path.join(bundle, 'manifest.json'))
  const entry = manifest.entries.find(item => item.path.endsWith(V2_DATA_FILE_NAMES.wantToGo))
  const file = path.join(bundle, 'payload', entry.path)
  const value = await readJson(file)
  value.schema_version = 999
  const bytes = Buffer.from(JSON.stringify(value))
  await writeFile(file, bytes)
  entry.bytes = bytes.length
  entry.sha256 = createHash('sha256').update(bytes).digest('hex')
  await writeJson(path.join(bundle, 'manifest.json'), manifest)
  await assert.rejects(inspectBackup(bundle), /E_BACKUP_INTEGRITY/)
  manifest.version = 999
  await writeJson(path.join(bundle, 'manifest.json'), manifest)
  await assert.rejects(inspectBackup(bundle), /E_BACKUP_FORMAT/)
})

test('CLI requires explicit paths; restore defaults to a preview and does not write', async t => {
  const { root, bundle, restored } = await fixture(t)
  await createBackup(root, bundle)
  const cli = new URL('./backup.mjs', import.meta.url)
  const result = execFileSync(process.execPath, [fileURLToPath(cli), 'restore', '--from', bundle, '--to', restored], { encoding: 'utf8' })
  assert.equal(JSON.parse(result).status, 'restore-preview')
  await assert.rejects(readdir(restored), { code: 'ENOENT' })
  assert.throws(() => execFileSync(process.execPath, [fileURLToPath(cli), 'create'], { stdio: 'pipe' }))
})

test('empty new library roundtrips without manufacturing V2 files or falling back to the sample', async t => {
  const { root, directory, bundle, restored } = await fixture(t)
  assert.equal(path.resolve(root), path.join(directory, 'private'))
  await rm(root, { recursive: true })
  await mkdir(root)
  assert.equal((await createBackup(root, bundle)).places, 0)
  assert.equal((await restoreBackup(bundle, restored, { apply: true })).mediaItems, 0)
  assert.deepEqual(await readdir(restored), ['restore-receipt.json'])
  await assert.rejects(restoreBackup(bundle, path.join(directory, 'missing-parent', 'root')), /E_BACKUP_TARGET_PARENT/)
})

test('absent source index is an explicit warning; malformed or unsupported index is blocking', async t => {
  const { root, paths, bundle } = await fixture(t, { media: true })
  const index = await readFile(paths.v2MediaSourceIndexPath)
  await rm(paths.v2MediaSourceIndexPath)
  assert.match((await createBackup(root, bundle)).warnings[0], /^SOURCE_INDEX_ABSENT/)
  assert.match((await inspectBackup(bundle)).summary.warnings[0], /^SOURCE_INDEX_ABSENT/)
  await writeFile(paths.v2MediaSourceIndexPath, index)
  const changed = JSON.parse(index)
  changed.schemaVersion = 999
  await writeJson(paths.v2MediaSourceIndexPath, changed)
  await assert.rejects(createBackup(root, path.join(path.dirname(bundle), 'other')), /E_BACKUP_SOURCE_INDEX/)
})

test('incomplete snapshots, payload junctions and unrecognized files cannot become a restored library', async t => {
  const { root, paths, directory, bundle, restored } = await fixture(t)
  const incomplete = path.join(directory, 'incomplete')
  await mkdir(path.join(incomplete, 'payload'), { recursive: true })
  await assert.rejects(restoreBackup(incomplete, restored, { apply: true }), /E_BACKUP_JSON/)
  await createBackup(root, bundle)
  const payload = path.join(bundle, 'payload')
  assert.equal(path.resolve(payload), path.join(directory, 'backup', 'payload'))
  await rm(payload, { recursive: true })
  await symlink(root, payload, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(restoreBackup(bundle, restored, { apply: true }), /E_BACKUP_LINK/)
  await assert.rejects(readdir(restored), { code: 'ENOENT' })
  await mkdir(paths.inboxRoot)
  await writeFile(path.join(paths.inboxRoot, 'unexpected.txt'), 'Synthetic unknown file')
  await assert.rejects(createBackup(root, path.join(directory, 'other')), /E_BACKUP_UNSUPPORTED_FILE/)
})
