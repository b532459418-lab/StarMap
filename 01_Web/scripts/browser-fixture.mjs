import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { privateDataSource } from './private-data-source.mjs'
import { getPrivatePaths } from './private-profile.mjs'
import { applyMigration } from './store-migrate.mjs'
import { rawConnection } from './store-sqlite.mjs'
import { integrityProblems } from '../src/data/v2write/transaction.ts'

export const fixtureIds = Object.freeze({
  iceland: '019b76da-a801-7000-8000-000000000001',
  reykjavik: '019b76da-a804-7000-8000-000000000004',
  torshavn: '019b76da-a807-7000-8000-000000000007',
  nuuk: '019b76da-a80c-7000-8000-00000000000c',
})
export const fixtureFileNames = Object.freeze({ places: 'places.local.json', travel: 'travel-map.local.json', wantToGo: 'want-to-go.local.json', editorState: 'editor-state.local.json', media: 'user-media.local.json' })
/** Data modes of the fixture: 'v2' (the default) and 'store', the experimental new-library mode (3C-3). */
export const FIXTURE_MODES = Object.freeze(['v2', 'store'])

/** The fixture's five V2 files. Only neutral tracked unit-test data; no owner data or environment files. */
async function fixtureFiles({ large }) {
  const files = JSON.parse(await readFile(new URL('../src/data/v2write/fixtures/migrated-files.json', import.meta.url), 'utf8'))
  files.media.items = []
  files.editorState.coverMediaByCity = {}
  files.editorState.hiddenCityIds = []
  files.wantToGo.privacy_level = 'local-only'
  if (large) {
    for (let index = 0; index < 1000; index++) {
      const id = `019b76da-b000-7000-8000-${(index + 1).toString(16).padStart(12, '0')}`
      files.places.places.push({ id, subtype: 'city', names: { en: `Benchmark place ${index.toString().padStart(4, '0')}`, 'zh-Hans': `基准地点 ${index}` }, partOf: fixtureIds.iceland, location: { lat: 63.5 + index / 10000, lng: -19.5 + index / 10000 } })
      files.wantToGo.items.push({ id: `benchmark-${index}`, placeId: id, hidden: false, addedAt: '2026-01-01', note: 'Synthetic performance fixture' })
    }
  }
  const problems = integrityProblems(files)
  if (problems.length) throw new Error(`Invalid browser fixture: ${problems.join('; ')}`)
  return files
}

async function writeFixtureFiles(root, files) {
  await mkdir(path.join(root, 'data', 'v2'), { recursive: true })
  for (const [key, name] of Object.entries(fixtureFileNames)) await writeFile(path.join(root, 'data', 'v2', name), JSON.stringify(files[key], null, 2) + '\n')
}

/**
 * Write the fixture into `root`. `mode: 'store'` also migrates it into the new library (`store:migrate --apply`), so the
 * dev server starts in the new-library mode; the default stays 'v2'.
 */
export async function createBrowserFixture(root, { large = false, mode = 'v2' } = {}) {
  if (!FIXTURE_MODES.includes(mode)) throw new Error(`Unknown browser fixture mode: ${mode}`)
  const files = await fixtureFiles({ large })
  await writeFixtureFiles(root, files)
  await mkdir(path.join(root, 'config'), { recursive: true })
  if (mode === 'store') await applyMigration(getPrivatePaths({ STARMAP_PRIVATE_ROOT: root }))
  return files
}

/**
 * Switch a running case's shared fixture into the new-library mode (3C-3): the V2 files are set back to the fixture's own
 * content (earlier cases may have edited them) and migrated into `data/store/world.sqlite`; the dev server picks the mode
 * up per request and reloads the page. Returns `leave()`, which removes the store and puts back the V2 files exactly as
 * they were, so later cases see what they would have seen without the switch.
 *
 * The dev server keeps the store open. Linux (CI) removes an open file; Windows refuses, so on Windows `leave()` keeps the
 * store, says so and the rest of that run stays in the new-library mode (run the new-library cases on their own there).
 * Entering again while a store is left over (a new worker after a failed case on Windows) keeps that store.
 */
/**
 * Switch a running case's shared fixture into the new-library mode with a damaged store (3C-4b): the fixture's own V2
 * files are migrated in a staging root under `operations/`, the store is damaged there (the b-tree page header of
 * op_log's root page overwritten, a page the projection never reads) and its last writer session left unclosed, and only
 * then is it moved into `data/store/world.sqlite` in one rename, so the dev server never sees a healthy store. The next
 * open runs quick_check, fails it with E_STORE_CORRUPT and keeps the store read-only. The root's own V2 files are not
 * touched. Returns `leave()`, which removes the store (on Windows the dev server keeps it open: see enterStoreMode).
 *
 * The dev server must not hold an earlier store open (it would keep serving that one): load the virtual module in V2
 * mode first, which closes it.
 */
export async function enterDamagedStoreMode(root) {
  const staging = path.join(root, 'operations', 'store-staging')
  const stagingPaths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: path.join(staging, 'private') })
  await rm(staging, { recursive: true, force: true, maxRetries: 3 })
  await writeFixtureFiles(stagingPaths.root, await fixtureFiles({ large: false }))
  await applyMigration(stagingPaths)
  const staged = path.join(stagingPaths.root, 'data', 'store', 'world.sqlite')
  const db = rawConnection(staged)
  let rootPage, pageSize
  try {
    db.exec('UPDATE store_meta SET clean_shutdown = 0')
    pageSize = db.prepare('PRAGMA page_size').get().page_size
    rootPage = db.prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'op_log'").get().rootpage
  } finally { db.close() }
  const handle = await open(staged, 'r+')
  try { await handle.write(Buffer.alloc(16, 0xff), 0, 16, (rootPage - 1) * pageSize) } finally { await handle.close() }
  await mkdir(path.join(root, 'data', 'store'), { recursive: true })
  await rename(staged, path.join(root, 'data', 'store', 'world.sqlite'))
  await rm(staging, { recursive: true, force: true, maxRetries: 3 })
  return async function leave() {
    try { await rm(path.join(root, 'data', 'store'), { recursive: true, force: true, maxRetries: 3 }) } catch (error) {
      if (process.platform !== 'win32' || !['EBUSY', 'EPERM'].includes(error?.code)) throw error
      console.warn(`The dev server keeps the damaged new library open (${error.code}); on Windows this run stays in the new-library mode.`)
    }
  }
}

export async function enterStoreMode(root) {
  const paths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: root })
  const removeStore = async () => {
    try { await rm(path.join(root, 'data', 'store'), { recursive: true, force: true, maxRetries: 3 }) } catch (error) {
      if (process.platform !== 'win32' || !['EBUSY', 'EPERM'].includes(error?.code)) throw error
      console.warn(`The dev server keeps the new library open (${error.code}); on Windows this run stays in the new-library mode.`)
    }
  }
  if (privateDataSource(paths) === 'store') return removeStore
  const saved = {}
  for (const name of Object.values(fixtureFileNames)) saved[name] = await readFile(path.join(root, 'data', 'v2', name))
  await writeFixtureFiles(root, await fixtureFiles({ large: false }))
  await applyMigration(paths)
  return async function leave() {
    await removeStore()
    for (const [name, bytes] of Object.entries(saved)) await writeFile(path.join(root, 'data', 'v2', name), bytes)
  }
}
