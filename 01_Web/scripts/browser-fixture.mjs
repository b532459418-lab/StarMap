/**
 * The synthetic private root of the browser tests (`npm run test:browser`; tests/browser/). Only neutral tracked
 * unit-test data (src/data/editor/fixtures/migrated-files.json); no owner data or environment files.
 *
 * 3C-4d: the new library is the only write path, so the fixture is a store by default. Its five V2 files are written
 * and migrated (`store:migrate --apply`) before the dev server starts. `mode: 'v2'` leaves the V2 files unmigrated (a
 * root that needs migration: the `--migration` group). Cases read the fixture through the store's projection
 * (readFixtureFiles) and change or reset it with store commits (resetFixture, patchFixture): the dev server keeps the
 * store open, so the file is never replaced. 3C-5 D: such a commit is another writer for the dev server, which finds it
 * (its look at the library's files, its poll while a page is connected, or a request for the changes) and pushes the
 * new revision to the open pages, which apply the changes without a reload. resetFixture waits until the dev server
 * has found it (waitForServedRevision asks the changes endpoint, which looks first). The V2 files are no longer
 * rewritten: under `data/v2/` a change would reload the pages.
 *
 * A reset (3C-5 E: store commands, no diffV2ToCommands) migrates the wanted V2 files in memory with store:migrate's own
 * migration and the store's identity ledger (id_map), so the records keep their rows, and commits the rows that differ.
 * Media are store-native (3C-4c): a reset keeps the store's media items as they are (review §7-1) and resets everything
 * else, the media orders, hidden lists and covers included.
 * Cases that need media import real images through the media service (importInboxMedia), as `media:import` does.
 */
import { existsSync } from 'node:fs'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { withLibraryOperation } from './library-operation-lock.mjs'
import { createMediaService, handleMediaStore } from './media-service.mjs'
import { privateDataSource, storeFileOf } from './private-data-source.mjs'
import { getPrivatePaths } from './private-profile.mjs'
import { openStore } from './store-host.mjs'
import { applyMigration } from './store-migrate.mjs'
import { projectToV2Files } from './store-projection.mjs'
import { rawConnection } from './store-sqlite.mjs'
import { uuidv7 } from '../src/data/canonical/uuidv7.ts'
import { commandBatch } from '../src/data/editor/native/batch.ts'
import { migrateV2 } from '../src/data/store/migrateV2.ts'
import { OFFICIAL, OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'
import { emptyFormalState } from '../src/worldgraph/store/formal.ts'
import { applyChangeSet, planCommands } from '../src/worldgraph/store/planner.ts'
import { memoryReader } from '../src/worldgraph/store/reader.ts'
import { integrityProblems } from '../src/data/canonical/v2Integrity.ts'

export const fixtureIds = Object.freeze({
  iceland: '019b76da-a801-7000-8000-000000000001',
  reykjavik: '019b76da-a804-7000-8000-000000000004',
  faroe: '019b76da-a802-7000-8000-000000000002',
  torshavn: '019b76da-a807-7000-8000-000000000007',
  nuuk: '019b76da-a80c-7000-8000-00000000000c',
})
export const fixtureFileNames = Object.freeze({ places: 'places.local.json', travel: 'travel-map.local.json', wantToGo: 'want-to-go.local.json', editorState: 'editor-state.local.json', media: 'user-media.local.json' })
/** Data modes of the fixture: 'store' (the default since 3C-4d) and 'v2' (V2 files that still need migrating). */
export const FIXTURE_MODES = Object.freeze(['store', 'v2'])
/** The dev server's private data module, as the page loads it. */
export const PRIVATE_MODULE_PATH = '/@id/__x00__virtual:starmap-private-data'
const DEV_SERVER = { host: '127.0.0.1', port: 5173 }

/** The fixture's five V2 files. */
export async function fixtureFiles({ large = false } = {}) {
  const files = JSON.parse(await readFile(new URL('../src/data/editor/fixtures/migrated-files.json', import.meta.url), 'utf8'))
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
  for (const [key, name] of Object.entries(fixtureFileNames)) {
    if (files[key] !== undefined) await writeFile(path.join(root, 'data', 'v2', name), JSON.stringify(files[key], null, 2) + '\n')
  }
}

const pathsOf = (root) => getPrivatePaths({ STARMAP_PRIVATE_ROOT: root })

/**
 * Write the fixture into `root`. By default it is migrated into the new library, so the dev server starts on a store;
 * `mode: 'v2'` leaves it as V2 files that need migrating. When `root` already holds a store (a case resetting the
 * shared fixture), the store is reset to the fixture's content by a commit (resetFixture) instead.
 */
export async function createBrowserFixture(root, { large = false, mode = 'store' } = {}) {
  if (!FIXTURE_MODES.includes(mode)) throw new Error(`Unknown browser fixture mode: ${mode}`)
  const files = await fixtureFiles({ large })
  if (privateDataSource(pathsOf(root)) === 'store') {
    await resetFixture(root, files)
    return files
  }
  await writeFixtureFiles(root, files)
  await mkdir(path.join(root, 'config'), { recursive: true })
  if (mode === 'store') await applyMigration(pathsOf(root))
  return files
}

/** The fixture as the App reads it: the store's projection (read-only connection), or the V2 files of a 'v2' root. */
export async function readFixtureFiles(root) {
  const paths = pathsOf(root)
  if (privateDataSource(paths) === 'store') {
    const handle = openStore(storeFileOf(paths), { readOnly: true, policy: OFFICIAL_POLICY })
    try { return projectToV2Files(handle.readRowsUnchecked()).files } finally { await handle.close() }
  }
  const files = {}
  for (const [key, name] of Object.entries(fixtureFileNames)) {
    const file = path.join(root, 'data', 'v2', name)
    if (existsSync(file)) files[key] = JSON.parse(await readFile(file, 'utf8'))
  }
  return files
}

/** The store's revision (read-only connection); undefined for a root without a store. */
export async function storeRevisionOf(root) {
  const paths = pathsOf(root)
  if (privateDataSource(paths) !== 'store') return undefined
  const handle = openStore(storeFileOf(paths), { readOnly: true, policy: OFFICIAL_POLICY })
  try { return handle.meta().revision } finally { await handle.close() }
}

/** A SHA-256 of each of the fixture's five values as the App reads them, and the store's revision: equal means unchanged. */
export async function fixtureHashes(root) {
  const files = await readFixtureFiles(root)
  const hashes = Object.fromEntries(Object.keys(fixtureFileNames).map((key) => [key, createHash('sha256').update(JSON.stringify(files[key] ?? null)).digest('hex')]))
  return { ...hashes, revision: await storeRevisionOf(root) }
}

/** The dev server's module text, or undefined when no server answers on 127.0.0.1:5173. Never through a proxy. */
function servedModule() {
  return new Promise((resolve, reject) => {
    const request = http.get({ ...DEV_SERVER, path: PRIVATE_MODULE_PATH, agent: false }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { text += chunk })
      response.on('end', () => resolve(response.statusCode === 200 ? text : ''))
    })
    request.on('error', (error) => (error?.code === 'ECONNREFUSED' ? resolve(undefined) : reject(error)))
    request.setTimeout(15000, () => request.destroy(new Error('The dev server did not answer within 15 s')))
  })
}

/** The library revision the dev server has (its changes endpoint looks for other writers first), or undefined. */
function servedChangesRevision() {
  return new Promise((resolve, reject) => {
    const request = http.get({ ...DEV_SERVER, path: '/__travelatlas/editor/read-model/changes?since=0', agent: false, headers: { host: '127.0.0.1:5173' } }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { text += chunk })
      response.on('end', () => { try { resolve(JSON.parse(text).revision) } catch { resolve(undefined) } })
    })
    request.on('error', (error) => (error?.code === 'ECONNREFUSED' ? resolve(undefined) : reject(error)))
    request.setTimeout(15000, () => request.destroy(new Error('The dev server did not answer within 15 s')))
  })
}

/**
 * Wait until the dev server (when one runs) has `revision`: the revision of the library its pages follow (3C-5 D: asked
 * through the changes endpoint, which first looks for another writer's commits), and the one its private data module
 * names. `undefined` waits for a module without a library (a root set aside, a damaged store). No file is touched.
 */
export async function waitForServedRevision(revision, { timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (revision !== undefined && String(revision) !== 'undefined') await servedChangesRevision()
    const text = await servedModule()
    if (text === undefined) return
    const current = /privateStoreRevision = (\w+)/.exec(text)?.[1]
    if (current === String(revision)) return
    // What the server last answered, for the failure message: a revision, or a response without one (an error page).
    const served = current !== undefined ? `revision ${current}` : text === '' ? 'an error response' : 'a module without a revision'
    if (Date.now() > deadline) throw new Error(`The dev server did not serve revision ${revision} within ${timeoutMs} ms (it last served ${served})`)
    await delay(200)
  }
}


/** The tables a reset compares, in the order their rows refer to each other (definitions and media rows stay). */
const RESET_TABLES = Object.freeze(['sources', 'evidence', 'entities', 'relations', 'anchors', 'entries', 'sequences', 'viewItems', 'viewSettings'])
const isMediaRow = (table, row) => table === 'entities' && row.typeId === OFFICIAL.media

/**
 * The commands that make the store's rows those of `files` migrated (3C-5 E). `current` is the store's formal state,
 * `identities` its identity ledger (id_map rows), `isTombstoned(table, id)` its tombstones. The migration reuses the
 * ledger's ids, so a record keeps its row; a row whose id a tombstone holds (a record the case deleted) gets a fresh id
 * and every reference to it follows (a place cannot: its id is its V2 id). Rows that differ (their revision and times
 * aside) are updated, missing ones created, others removed; definitions and media rows stay as they are.
 */
export function resetCommandsOf(current, identities, files, { isTombstoned, now = new Date().toISOString(), allocateId = () => uuidv7() } = {}) {
  const manifest = { format: 'starmap.v2-store-identities', version: 1, identities }
  const migrated = migrateV2(files, { now, allocateId, manifest })
  if (!migrated.ok) throw new Error(`The browser fixture's files do not migrate: ${JSON.stringify(migrated.report.problems.slice(0, 3))}`)
  const empty = emptyFormalState()
  let target = applyChangeSet(empty, planCommands(memoryReader(empty), migrated.commands, { baseRevision: 0, now, policy: OFFICIAL_POLICY }))
  // Ids a tombstone holds: fresh ones, and every reference follows (exact string values).
  const remap = new Map()
  for (const table of RESET_TABLES) {
    const live = new Set(current[table].map((row) => row.id))
    for (const row of target[table]) {
      if (live.has(row.id) || !isTombstoned(table, row.id)) continue
      if (table === 'entities' && row.typeId === OFFICIAL.place) throw new Error(`The browser fixture cannot bring back the place ${row.id}: a case deleted it (E_RECREATE_ID)`)
      remap.set(row.id, table === 'viewItems' || table === 'viewSettings' ? `${row.scope}#${allocateId()}` : allocateId())
    }
  }
  if (remap.size) {
    const swapIds = (value) => (typeof value === 'string' ? remap.get(value) ?? value : Array.isArray(value) ? value.map(swapIds)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, swapIds(child)])) : value)
    target = Object.fromEntries(Object.entries(target).map(([table, rows]) => [table, Array.isArray(rows) ? rows.map(swapIds) : rows]))
  }
  const batch = commandBatch()
  const timesOf = (row) => Object.fromEntries(['createdAt', 'updatedAt'].filter((key) => Object.hasOwn(row, key)).map((key) => [key, row[key]]))
  for (const table of RESET_TABLES) {
    const have = new Map(current[table].filter((row) => !isMediaRow(table, row)).map((row) => [row.id, row]))
    for (const row of target[table]) {
      if (isMediaRow(table, row)) continue
      const existing = have.get(row.id)
      // A row that stays keeps its times: they are not what the files say.
      if (existing) batch.update(table, existing, { ...row, ...timesOf(existing) })
      else batch.create(table, row)
    }
  }
  for (const table of [...RESET_TABLES].reverse()) {
    if (table === 'sources') continue
    const wanted = new Set(target[table].map((row) => row.id))
    for (const row of current[table]) if (!isMediaRow(table, row) && !wanted.has(row.id)) batch.remove(table, row)
  }
  return batch.commands()
}

/**
 * Make the store hold `files` (the V2 shape) with one commit through a separate connection, under the library lease,
 * as the editor writes do (3C-5 E: store commands from resetCommandsOf). Media items are kept as the store has them
 * (review §7-1); everything else follows `files`. When a dev server runs, this waits until it has found the commit (3C-5
 * D: its open pages then apply it without a reload). Resolves the revision.
 */
export async function resetFixture(root, files) {
  const paths = pathsOf(root)
  if (privateDataSource(paths) !== 'store') {
    await writeFixtureFiles(root, files)
    return undefined
  }
  const revision = await withLibraryOperation(paths, async (leaseToken) => {
    const handle = openStore(storeFileOf(paths), { privatePaths: paths, policy: OFFICIAL_POLICY, writerSession: false })
    try {
      const rows = handle.readRowsUnchecked()
      const before = projectToV2Files(rows).files
      // A JSON round trip, as when the values were V2 files: undefined fields are left out.
      const after = { ...JSON.parse(JSON.stringify(files)), media: before.media }
      const ledger = rawConnection(storeFileOf(paths))
      let identities
      try { identities = ledger.prepare('SELECT kind, source_id AS sourceId, record_id AS recordId, id FROM id_map ORDER BY kind, source_id, record_id').all().map((row) => ({ ...row })) } finally { ledger.close() }
      const state = handle.readFormalState()
      const tombstones = new Set(state.tombstones.map((row) => JSON.stringify([row.table, row.id])))
      const commands = resetCommandsOf(state, identities, after, { isTombstoned: (table, id) => tombstones.has(JSON.stringify([table, id])) })
      if (commands.length === 0) return rows.revision
      const result = await handle.commit({
        requestId: uuidv7(), baseRevision: rows.revision, kind: 'browser-fixture.reset', actor: 'browser-fixture', commands,
      }, { leaseToken })
      return result.revision
    } finally { await handle.close() }
  })
  await waitForServedRevision(revision)
  return revision
}
/** Change one of the fixture's values as the App reads it (`change` edits it in place) and commit it (resetFixture). */
export async function patchFixture(root, key, change) {
  const files = await readFixtureFiles(root)
  change(files[key])
  return resetFixture(root, files)
}

/**
 * Import what the Inbox holds into the store through the media service (as `npm run media:import -- --apply
 * --accept-folder-bindings` does) — another writer for the dev server, as a command-line import is — and wait until the
 * dev server has found it (3C-5 D: its open pages then show the media without a reload). The folders should carry
 * place.json. Resolves the revision.
 */
export async function importInboxMedia(root) {
  const paths = pathsOf(root)
  const revision = await withLibraryOperation(paths, async (leaseToken) => {
    const handle = openStore(storeFileOf(paths), { privatePaths: paths, policy: OFFICIAL_POLICY, writerSession: false })
    try {
      const service = createMediaService({ privatePaths: paths, store: handleMediaStore(handle) })
      const result = await service.importInbox({ requestId: uuidv7(), kind: 'starmap.media.cli-import', actor: 'browser-fixture', leaseToken, acceptFolderBindings: true, blockOnWarnings: false })
      // Files imported before are no change (nothing to write); a blocked plan is an error.
      if (result.blocked) throw new Error(`The browser fixture's media import was blocked: ${JSON.stringify(result.plan?.blockers ?? result.plan)}`)
      return result.revision
    } finally { await handle.close() }
  })
  await waitForServedRevision(revision)
  return revision
}

/**
 * A damaged new library for one case (3C-4b): the fixture's own V2 files are migrated in a staging root under
 * `operations/`, the store is damaged there (the b-tree page header of op_log's root page overwritten, a page the
 * projection never reads) and its last writer session left unclosed, and only then is it moved into
 * `data/store/world.sqlite` in one rename, so the dev server never sees a healthy store. The next open runs quick_check,
 * fails it with E_STORE_CORRUPT and keeps the store read-only. The root's own V2 files are not touched.
 *
 * Since 3C-4d the root already holds the fixture's store, which the dev server keeps open: setStoreAside moves it away
 * first (Linux renames an open file; Windows refuses, so there the case skips itself), and the dev server must load its
 * module once without a store (which closes the old connection) before this is called. Returns `leave()`, which removes
 * the damaged store (the dev server must then load its module without a store again, closing it) for the caller to put
 * the original store back (setStoreAside's `restore`).
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
    await rm(storeFileOf(pathsOf(root)), { force: true, maxRetries: 3 })
  }
}

/**
 * Move the root's store aside (to `operations/store-aside/world.sqlite`) so that a case can see the root without it.
 * Refused on Windows while the dev server holds the store open (EBUSY or EPERM): resolves undefined then. Otherwise
 * resolves `restore()`, which moves it back (the dev server must have closed any store it opened meanwhile).
 */
export async function setStoreAside(root) {
  const file = storeFileOf(pathsOf(root))
  const aside = path.join(root, 'operations', 'store-aside', 'world.sqlite')
  await mkdir(path.dirname(aside), { recursive: true })
  try { await rename(file, aside) } catch (error) {
    if (process.platform === 'win32' && ['EBUSY', 'EPERM'].includes(error?.code)) return undefined
    throw error
  }
  return async function restore() {
    await rename(aside, file)
    await rm(path.dirname(aside), { recursive: true, force: true, maxRetries: 3 })
  }
}
