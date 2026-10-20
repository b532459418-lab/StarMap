import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { sequentialUuids } from '../src/data/canonical/v2.fixture.ts'
import { createMediaJobStore } from './media-job-store.mjs'
import { inspectLibraryOperation, withLibraryOperation } from './library-operation-lock.mjs'
import { storeFileOf } from './private-data-source.mjs'
import { getPrivatePaths } from './private-profile.mjs'
import { openStore } from './store-host.mjs'
import { applyMigration } from './store-migrate.mjs'
import { OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'

const execute = promisify(execFile)
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(webRoot, 'scripts', 'import-media.mjs')
const newId = sequentialUuids(Date.UTC(2026, 9, 4))
const countryId = newId()
const cityId = newId()

async function fixture(t, { migrate = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'starmap-cli-coordination-'))
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir())
    assert.ok(path.basename(root).startsWith('starmap-cli-coordination-'))
    await rm(root, { recursive: true, force: true })
  })
  const paths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: root })
  await mkdir(paths.v2DataRoot, { recursive: true })
  await writeFile(paths.v2FilePaths.places, JSON.stringify({
    schema_version: 1, generated_at: '2026-10-04T00:00:00.000Z', places: [
      { id: countryId, subtype: 'country', names: { 'zh-Hans': '测试国家', en: 'Test Country' }, externalIds: { iso3166Alpha2: 'IS' }, location: { lat: 65, lng: -18 } },
      { id: cityId, subtype: 'city', names: { 'zh-Hans': '测试城市', en: 'Test City' }, partOf: countryId, location: { lat: 64, lng: -21 } },
    ],
  }))
  const folder = path.join(paths.inboxRoot, 'Test Country', 'Test City', 'photos')
  await mkdir(folder, { recursive: true })
  const source = path.join(folder, 'synthetic.jpg')
  // Batch 2A: the folders are bound by id (as the editor's uploads do), so the editor importer has no folder binding to confirm.
  await writeFile(path.join(paths.inboxRoot, 'Test Country', 'place.json'), JSON.stringify({ placeId: countryId }))
  await writeFile(path.join(paths.inboxRoot, 'Test Country', 'Test City', 'place.json'), JSON.stringify({ placeId: cityId }))
  await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 20, g: 140, b: 90 } } }).jpeg().toFile(source)
  // 3C-4d: media are imported into the new library only; the synthetic V2 places are migrated first.
  if (migrate) await applyMigration(paths, { now: '2026-10-04T00:00:00.000Z' })
  return { paths, source }
}

/** The registered media files and the revision of the store, through a read-only connection. */
async function storeMedia(paths) {
  const handle = openStore(storeFileOf(paths), { readOnly: true, policy: OFFICIAL_POLICY })
  try { return { revision: handle.readRowsUnchecked().revision, files: handle.mediaRegistry().files } } finally { await handle.close() }
}

async function snapshot(root) {
  const files = {}
  async function walk(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, item.name)
      const relative = path.relative(root, target).split(path.sep).join('/')
      if (item.isDirectory()) await walk(target)
      else if (relative !== 'operations/library-operation-state.json') {
        assert.ok(item.isFile(), 'Synthetic fixtures must contain ordinary files only')
        files[relative] = createHash('sha256').update(await readFile(target)).digest('hex')
      }
    }
  }
  await walk(root)
  return files
}

async function cli(paths, args = [], leaseToken) {
  const env = { ...process.env, STARMAP_PRIVATE_ROOT: paths.root }
  delete env.STARMAP_LIBRARY_LEASE
  if (leaseToken) env.STARMAP_LIBRARY_LEASE = leaseToken
  try {
    const result = await execute(process.execPath, [script, ...args], { cwd: webRoot, env, timeout: 20000 })
    return { code: 0, ...result }
  } catch (error) {
    if (typeof error.code !== 'number') throw error
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

test('3C-4d (review §8-2): on a root that is not a store, media:import refuses (exit 2) and media:check stays read-only, in every state', { timeout: 60000 }, async (t) => {
  const { paths } = await fixture(t, { migrate: false })
  const cases = [
    ['migration-required', async () => {}, /还没有迁移到新库/],
    ['needs-recovery', async () => {
      await mkdir(path.dirname(storeFileOf(paths)), { recursive: true })
      await writeFile(`${storeFileOf(paths)}-journal`, 'synthetic leftover')
      await rm(paths.v2DataRoot, { recursive: true })
      await rm(paths.inboxRoot, { recursive: true })
      await mkdir(paths.inboxRoot)
    }, /library:recover/],
    ['empty', async () => rm(path.dirname(storeFileOf(paths)), { recursive: true }), /还没有新库/],
  ]
  for (const [state, arrange, message] of cases) {
    await arrange()
    const before = await snapshot(paths.root)
    const applied = await cli(paths, ['--apply'])
    assert.equal(applied.code, 2, `${state}: ${applied.stderr}`)
    assert.match(applied.stderr, message, state)
    const checked = await cli(paths)
    assert.equal(checked.code, 0, `${state}: ${checked.stderr}`)
    assert.match(checked.stdout, message, state)
    assert.deepEqual(await snapshot(paths.root), before, `${state}: nothing written`)
    assert.equal(existsSync(path.join(paths.root, 'operations')), false, `${state}: no lease taken`)
    assert.equal(existsSync(storeFileOf(paths)), false, `${state}: no library created`)
  }
})

test('actual CLI apply refuses unclosed media jobs; preflight stays read only and remains available', { timeout: 30000 }, async (t) => {
  const { paths } = await fixture(t)
  await withLibraryOperation(paths, () => createMediaJobStore(paths).create({ countryId, cityId, kind: 'photo', files: [{ fileName: 'waiting.jpg', bytes: 128 }] }))
  const before = await snapshot(paths.root)
  const applied = await cli(paths, ['--apply'])
  assert.equal(applied.code, 1)
  assert.match(applied.stderr, /E_MEDIA_JOB_PENDING/)
  assert.deepEqual(await snapshot(paths.root), before)
  const checked = await cli(paths)
  assert.equal(checked.code, 0, checked.stderr)
  assert.deepEqual(await snapshot(paths.root), before)
  assert.equal((await inspectLibraryOperation(paths)).state, 'idle')
})

test('actual external CLI cannot import inside an editor-held lease and preserves all fixture bytes; the read-only check runs next to it', { timeout: 30000 }, async (t) => {
  const { paths } = await fixture(t)
  await withLibraryOperation(paths, async () => {
    const before = await snapshot(paths.root)
    const applied = await cli(paths, ['--apply'])
    assert.equal(applied.code, 1)
    assert.match(applied.stderr, /E_LIBRARY_BUSY/)
    assert.deepEqual(await snapshot(paths.root), before)
    // The new library's media:check takes no lease (3C-4c): it runs and writes nothing.
    const checked = await cli(paths)
    assert.equal(checked.code, 0, checked.stderr)
    assert.deepEqual(await snapshot(paths.root), before)
  })
  assert.equal((await inspectLibraryOperation(paths)).state, 'idle')
})

test('actual CLI preflight and apply join the explicitly injected parent lease (STARMAP_LIBRARY_LEASE) without deadlock', { timeout: 30000 }, async (t) => {
  const { paths, source } = await fixture(t)
  const original = await readFile(source)
  const v2Catalog = await readFile(paths.v2FilePaths.media).catch(() => undefined)
  await withLibraryOperation(paths, async (leaseToken) => {
    const lock = path.join(paths.root, 'operations', 'library-operation.lock')
    const before = await readFile(lock, 'utf8')
    for (const args of [[], ['--apply']]) {
      const result = await cli(paths, args, leaseToken)
      assert.equal(result.code, 0, result.stderr)
    }
    assert.equal(await readFile(lock, 'utf8'), before)
    assert.equal((await inspectLibraryOperation(paths)).state, 'busy')
  })
  assert.deepEqual(await readFile(source), original)
  const { revision, files } = await storeMedia(paths)
  assert.equal(revision, 2)
  assert.equal(files.length, 1)
  assert.deepEqual(await readFile(paths.v2FilePaths.media).catch(() => undefined), v2Catalog, 'the V2 files are not written')
  const generated = await snapshot(paths.userMediaRoot)
  assert.ok(Object.keys(generated).some((name) => name.endsWith('/thumb.webp')))
  assert.ok(Object.keys(generated).some((name) => name.endsWith('/preview.webp')))
  assert.ok(Object.keys(generated).some((name) => name.includes('/original.')))
  assert.equal((await inspectLibraryOperation(paths)).state, 'idle')
})
