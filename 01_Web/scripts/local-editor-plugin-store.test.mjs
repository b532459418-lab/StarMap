/**
 * The local editor plugin in the new-library mode (3C-3, 3C-4a): the virtual module reads the store's projection and
 * its revision, GET /editor/state reads the same model, the editor writes are written to the store (and invalidate the
 * module), media tasks reach the store-mode task service (3C-4c; the media endpoints and task imports are tested in
 * store-media-endpoints.test.mjs and store-media-jobs.test.mjs), and an unopenable store is an error, never a fallback to V2.
 * The harness (store-mode.fixture.mjs) is the one of local-editor-plugin.test.mjs (no real server).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { withLibraryOperation } from './library-operation-lock.mjs'
import { storeFileOf } from './private-data-source.mjs'
import { openStore } from './store-host.mjs'
import { applyMigration } from './store-migrate.mjs'
import { servedCanonical } from './private-read-model.fixture.mjs'
import { rawConnection } from './store-sqlite.mjs'
import {
  authorizedHeaders, captureMiddleware, editorPrefix, moduleOf, requestTo, sampleV2Files, tempPrivateRoot, treeDigest, writeV2Files,
} from './store-mode.fixture.mjs'
import { readV2 } from '../src/data/canonical/v2Reader.ts'
import { OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'
import { filterReadModelForPersonalBuild } from '../src/data/store/personalBuildReadModel.ts'
import { officialViewOf } from '../src/data/store/projectCanonical.ts'

const NOW = '2026-10-14T00:00:00.000Z'
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
/** store_meta.clean_shutdown, read through a separate read-only connection. */
function cleanShutdown(file) {
  const db = rawConnection(file, { readOnly: true })
  try { return db.prepare('SELECT clean_shutdown FROM store_meta').get().clean_shutdown } finally { db.close() }
}

/** The media task actions on a task that does not exist. */
const MEDIA_TASK_ACTIONS = ['preview', 'import', 'pause', 'close', 'abandon'].map((action) => ['POST', `media/jobs/018bd504-c600-7000-8000-000000000001/${action}`])
const outsideOperations = (digest) => Object.fromEntries(Object.entries(digest).filter(([file]) => !file.startsWith('operations/')))

test('Local editor plugin in the new-library mode', async (t) => {
  const { directory, root, paths } = await tempPrivateRoot(t, 'starmap-plugin-store-')
  const files = sampleV2Files()
  await writeV2Files(paths, files)
  const originalEnvironment = process.env
  process.env = { STARMAP_PRIVATE_ROOT: root }
  try {
    const { travelAtlasLocalEditor } = await import('./local-editor-plugin.mjs')

    await t.test('migration required: no store revision, the V2 files migrated in memory into the read model (3C-5B)', async () => {
      const plugin = travelAtlasLocalEditor({ profile: 'personal', privateRoot: root })
      const module = await moduleOf(plugin)
      assert.equal(module.privateStoreRevision, undefined)
      assert.equal(module.privateStoreMigrationRequired, true)
      assert.deepEqual(servedCanonical(module), readV2(files))
    })

    await applyMigration(paths, { now: NOW })
    const plugin = travelAtlasLocalEditor({ profile: 'personal', privateRoot: root })
    const privateModule = { id: plugin.resolveId('virtual:starmap-private-data'), transformResult: { code: 'cached' } }
    const captured = captureMiddleware(plugin, privateModule)
    const handler = captured.handlers[1]

    await t.test('the virtual module carries the store\'s read model and revision (3C-5B)', async () => {
      const module = await moduleOf(plugin)
      assert.equal(module.privateStoreRevision, 1)
      assert.equal(module.privateLegacyUnmigrated, false)
      const reader = openStore(storeFileOf(paths), { privatePaths: paths, readOnly: true, policy: OFFICIAL_POLICY })
      try { assert.deepEqual(module.privateReadModel, reader.readModel()) } finally { await reader.close() }
      assert.deepEqual(servedCanonical(module), readV2(files))
    })

    await t.test('GET /editor/state reads the store model', async () => {
      const result = await requestTo(handler, { url: `${editorPrefix}state`, method: 'GET', headers: {} })
      assert.equal(result.status, 200)
      assert.equal(result.body.ok, true)
      assert.deepEqual(result.body.state.hiddenCountryIds, [])
    })

    await t.test('the want-to-go update is written to the store with the request protocol and invalidates the module', async () => {
      const wish = files.wantToGo.items[0]
      const protocol = { 'x-starmap-request-id': '01960000-0000-7000-8000-00000000e001', 'x-starmap-base-revision': '1' }
      const update = (extra, input) => requestTo(handler, {
        url: `${editorPrefix}wanttogo/update`, headers: { ...authorizedHeaders, ...extra }, content: Buffer.from(JSON.stringify(input)),
      })
      const stale = await update({}, { id: wish.id, note: 'Synthetic' })
      assert.equal(stale.status, 409)
      assert.equal(stale.body.code, 'E_STALE')
      const saved = await update(protocol, { id: wish.id, note: 'Synthetic plugin note' })
      assert.equal(saved.status, 200, JSON.stringify(saved.body))
      assert.equal(saved.body.item.note, 'Synthetic plugin note')
      assert.equal(privateModule.transformResult, null, 'the module is invalidated')
      const module = await moduleOf(plugin)
      assert.equal(module.privateStoreRevision, 2)
      assert.equal(servedCanonical(module).wantToGo.items.find((item) => item.id === wish.id).note, 'Synthetic plugin note')
      const replay = await update(protocol, { id: wish.id, note: 'Synthetic plugin note' })
      assert.equal(replay.body.duplicate, true)
      assert.equal((await moduleOf(plugin)).privateStoreRevision, 2)
      assert.deepEqual(captured.reloads, [])
    })

    await t.test('the other editor writes go to the store too, with the plugin country catalog (3C-4a)', async () => {
      const country = await requestTo(handler, {
        url: `${editorPrefix}countries`, content: Buffer.from(JSON.stringify({ countryCode: 'JP', visitedDate: '2026-04-01' })),
        headers: { ...authorizedHeaders, 'x-starmap-request-id': '01960000-0000-7000-8000-00000000e002', 'x-starmap-base-revision': '2' },
      })
      assert.equal(country.status, 201, JSON.stringify(country.body))
      assert.equal(country.body.revision, 3)
      const module = await moduleOf(plugin)
      assert.equal(module.privateStoreRevision, 3)
      const canonical = servedCanonical(module)
      const added = canonical.editorState.addedCountries.find((entry) => entry.placeId === country.body.countryId)
      assert.deepEqual(added, { placeId: country.body.countryId, region: 'Asia', visitedDate: '2026-04-01' })
      assert.equal(canonical.places.find((place) => place.id === country.body.countryId).externalIds.iso3166Alpha2, 'JP')
    })

    await t.test('media tasks reach the store-mode task service (3C-4c): the list reads, an unknown task is 404, nothing written', async () => {
      // The library lease's generation counter (operations/) moves with every leased request.
      const before = outsideOperations(await treeDigest(root))
      const list = await requestTo(handler, { url: `${editorPrefix}media/jobs`, method: 'GET' })
      assert.equal(list.status, 200, JSON.stringify(list.body))
      assert.deepEqual(list.body.jobs, [])
      for (const [method, route] of MEDIA_TASK_ACTIONS) {
        const result = await requestTo(handler, { url: editorPrefix + route, method, content: Buffer.from(JSON.stringify({ libraryId: '018bd504-c600-7000-8000-000000000002', revision: 0 })) })
        assert.equal(result.status, 404, `${method} ${route}: ${JSON.stringify(result.body)}`)
        assert.equal(result.body.code, 'E_MEDIA_JOB_NOT_FOUND', `${method} ${route}`)
      }
      const unknown = await requestTo(handler, { url: `${editorPrefix}something-new` })
      assert.equal(unknown.status, 404)
      assert.equal(unknown.body.code, 'E_UNKNOWN_ENDPOINT')
      // Authorization still comes first.
      const forbidden = await requestTo(handler, { url: `${editorPrefix}records`, headers: {} })
      assert.equal(forbidden.status, 403)
      assert.deepEqual(outsideOperations(await treeDigest(root)), before)
      assert.deepEqual(captured.reloads, [])
    })

    await t.test('build:personal reads the store read-only while the dev server has it open: no busy store, the clean-shutdown mark untouched (3C-4b)', async () => {
      const file = storeFileOf(paths)
      const served = await moduleOf(plugin)
      assert.equal(cleanShutdown(file), 0, 'the dev server\'s writer session is open')
      const storeBytes = sha256(file)
      const build = travelAtlasLocalEditor({ profile: 'personal', privateRoot: root })
      build.configResolved({ command: 'build', root: directory, build: { outDir: 'dist' } })
      // Another connection holds SQLite's write lock (as the dev server does while it commits), and the library lock is held.
      const holder = rawConnection(file)
      holder.exec('BEGIN IMMEDIATE')
      try {
        await withLibraryOperation(paths, async () => {
          const built = await moduleOf(build)
          assert.equal(built.privateStoreRevision, served.privateStoreRevision)
          assert.equal(built.privateLegacyUnmigrated, false)
          // 3C-5B: the build names its data file instead of inlining the read model; nothing is hidden here, so it
          // reads as what the dev server serves.
          assert.equal(built.privateReadModel, undefined)
          await build.closeBundle()
          const data = JSON.parse(await readFile(path.join(directory, 'dist', ...built.privateReadModelUrl.split('/')), 'utf8'))
          assert.deepEqual(officialViewOf(data, 'local'), servedCanonical(served))
        })
      } finally { holder.exec('ROLLBACK'); holder.close() }
      await build.buildEnd()
      assert.equal(cleanShutdown(file), 0, 'the build neither wrote nor cleared the mark')
      assert.equal(sha256(file), storeBytes, 'the build wrote nothing')
      // The dev server keeps writing.
      const saved = await requestTo(handler, {
        url: `${editorPrefix}wanttogo/update`, content: Buffer.from(JSON.stringify({ id: files.wantToGo.items[0].id, note: 'Synthetic after a build' })),
        headers: { ...authorizedHeaders, 'x-starmap-request-id': '01960000-0000-7000-8000-00000000e003', 'x-starmap-base-revision': String(served.privateStoreRevision) },
      })
      assert.equal(saved.status, 200, JSON.stringify(saved.body))
    })

    await t.test('closing the dev server closes the store cleanly', async () => {
      await plugin.buildEnd()
      const handle = openStore(storeFileOf(paths), { privatePaths: paths, policy: OFFICIAL_POLICY })
      try { assert.equal(handle.openTimings.quickCheckMs, undefined) } finally { await handle.close() }
    })

    await t.test('a store that cannot be opened is an error the App shows; the V2 files are never used instead', async () => {
      await writeFile(storeFileOf(paths), 'not a store')
      const broken = travelAtlasLocalEditor({ profile: 'personal', privateRoot: root })
      await assert.rejects(moduleOf(broken), (error) => {
        assert.equal(error.code, 'E_STORE_CORRUPT')
        assert.match(error.message, /新库模式不会回落到 data\/v2\/ 的文件/)
        return true
      })
      const state = await requestTo(captureMiddleware(broken).handlers[1], { url: `${editorPrefix}state`, method: 'GET', headers: {} })
      assert.equal(state.status, 500)
      assert.deepEqual(state.body.params, { code: 'E_STORE_CORRUPT' })
      await broken.buildEnd()
    })
  } finally {
    process.env = originalEnvironment
  }
})

/**
 * 3C-4c: the migration seeds the media registry and hashes the generated files the catalog names (design v2 §5); it
 * refuses files that are not there. The fixture names directories without files, so each content-addressed item gets a
 * distinct synthetic original (and variants) and points at its real hash. Ids and everything else stay as they were.
 */
async function withGeneratedFiles(paths, files) {
  const result = structuredClone(files)
  for (const [index, item] of result.media.items.entries()) {
    const old = /^\/media\/user\/([0-9a-f]{16})\//.exec(item.src)?.[1]
    if (!old) continue
    const original = Buffer.from(`synthetic original ${index}`)
    const directory = createHash('sha256').update(original).digest('hex').slice(0, 16)
    const moved = JSON.parse(JSON.stringify(item).split(`/media/user/${old}/`).join(`/media/user/${directory}/`))
    result.media.items[index] = moved
    for (const src of new Set([moved.src, ...Object.values(moved.variants ?? {}).map((variant) => variant.src)])) {
      const file = path.join(paths.userMediaRoot, directory, src.slice(src.lastIndexOf('/') + 1))
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, src === moved.src ? original : `synthetic variant ${index}`)
    }
  }
  return result
}

test('a personal build in the new-library mode writes the store read model, filtered for the build, as its data file, not inlined (batch 7, S3; 3C-5B)', async (t) => {
  const { root, paths } = await tempPrivateRoot(t, 'starmap-plugin-store-build-')
  const { hiddenContentFixture, REMOVED } = await import('./personal-build-filter.fixture.mjs')
  const files = await withGeneratedFiles(paths, hiddenContentFixture())
  await writeV2Files(paths, files)
  await applyMigration(paths, { now: NOW })
  const originalEnvironment = process.env
  process.env = { STARMAP_PRIVATE_ROOT: root }
  try {
    const { travelAtlasLocalEditor } = await import('./local-editor-plugin.mjs')
    const plugin = travelAtlasLocalEditor({ profile: 'personal', privateRoot: root })
    plugin.configResolved({ command: 'build', root, build: { outDir: 'dist' } })
    try {
      const code = await plugin.load(plugin.resolveId('virtual:starmap-private-data'))
      const module = await import(`data:text/javascript,${encodeURIComponent(code)}`)
      assert.equal(module.privateStoreRevision, 1)
      assert.equal(module.privateReadModel, undefined, 'the read model is not inlined')
      assert.match(module.privateReadModelUrl, /^data\/read-model\.[0-9a-f]{16}\.json$/)
      await plugin.closeBundle()
      const text = await readFile(path.join(root, 'dist', ...module.privateReadModelUrl.split('/')), 'utf8')
      assert.equal(module.privateReadModelUrl, `data/read-model.${createHash('sha256').update(text).digest('hex').slice(0, 16)}.json`, 'named by its content')
      for (const id of [...REMOVED.records, ...REMOVED.wantToGo, ...REMOVED.media, ...REMOVED.places]) assert.ok(!text.includes(id) && !code.includes(id), id)
      const reader = openStore(storeFileOf(paths), { privatePaths: paths, readOnly: true, policy: OFFICIAL_POLICY })
      try { assert.deepEqual(JSON.parse(text), filterReadModelForPersonalBuild(reader.readModel()).model) } finally { await reader.close() }
    } finally {
      await plugin.buildEnd()
    }
  } finally {
    process.env = originalEnvironment
  }
})
