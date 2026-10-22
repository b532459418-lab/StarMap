/**
 * Migrating to the new library end to end (3C-4d, decision D-a A), on a temporary private root with a real V2 library
 * with media (./media-inbox.fixture.mjs: invented places, plain-colour images imported by the V2 importer, which writes
 * the media catalog, the source index and the generated files), through the plugin itself (its virtual module, its
 * middleware and its file events, without a server) and the command lines' own functions:
 *
 *   1. the root needs migrating: the module shows the V2 files with the notice flag; every write, media and task route
 *      answers 409 E_STORE_MIGRATION_REQUIRED, media:import refuses (exit 2); not a byte of the root changes;
 *   2. `npm run store:migrate` previews, `-- --apply` migrates (the media registry seeded from the V2 index);
 *   3. the dev server's file event switches the module to the store, which reads like the V2 files;
 *   4. writes work: an editor write and a media upload and import through the plugin;
 *   5. the first media scan of the migrated Inbox adds nothing (media:check and media:import);
 *   6. `npm run store:export-v2` writes the store back as V2 files: the V2 media keep their content ids, and the edits
 *      and the new photo are there.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { COLOR, PLACE, imageBytes, importedV2Library } from './media-inbox.fixture.mjs'
import { privateDataState, storeFileOf } from './private-data-source.mjs'
import { exportStoreV2 } from './store-backup.mjs'
import { openStore } from './store-host.mjs'
import { runStoreMediaCli } from './store-media-cli.mjs'
import { runMigrateCli } from './store-migrate.mjs'
import { STORE_BASE_REVISION_HEADER, STORE_REQUEST_ID_HEADER } from './store-session.mjs'
import { servedCanonical, servedModuleOf } from './private-read-model.fixture.mjs'
import { authorizedHeaders, editorPrefix, quietly, requestTo, tempPrivateRoot, treeDigest } from './store-mode.fixture.mjs'
import { canonicalForInputs } from '../src/data/canonical/canonicalForInputs.ts'

import { V2_FILE_KEYS, V2_FILE_NAMES } from '../src/data/canonical/v2Schema.ts'
import { OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'

const NOW = '2026-10-20T00:00:00.000Z'
const requestIdOf = (n) => `01960000-0000-7000-8000-0000000e2e${n.toString(16).padStart(2, '0')}`
const JOB_ID = '018bd504-c600-7000-8000-000000000001'

/** The plugin without a server, its module cache and file events captured (local-editor-plugin.test.mjs's harness). */
function served(plugin) {
  const handlers = [], reloads = [], invalidations = [], events = new Map()
  const privateModule = { id: plugin.resolveId('virtual:starmap-private-data'), transformResult: { code: 'cached' } }
  plugin.configureServer({
    middlewares: { use: (handler) => handlers.push(handler) },
    watcher: { add: () => {}, on: (event, callback) => events.set(event, callback) },
    moduleGraph: {
      getModuleById: (id) => (id === privateModule.id ? privateModule : undefined),
      invalidateModule: (module) => { invalidations.push(module); module.transformResult = null },
    },
    ws: { send: (message) => reloads.push(message) },
  })
  return { handler: handlers[1], reloads, invalidations, events, privateModule }
}
const moduleOf = (plugin) => servedModuleOf(plugin)

test('a V2 library with media: migration required, store:migrate --apply, writes work, the first scan adds nothing, export-v2 writes it back', async (t) => {
  const { directory, root, paths } = await tempPrivateRoot(t, 'starmap-store-migration-e2e-')
  await importedV2Library(paths, { now: NOW })
  // The V2 importer writes the places and the media catalog; the other V2 files do not exist (empty data).
  const v2Files = Object.fromEntries((await Promise.all(V2_FILE_KEYS.map(async (key) => [key, await readFile(paths.v2FilePaths[key], 'utf8').then(JSON.parse, () => undefined)]))).filter(([, value]) => value !== undefined))
  assert.ok(v2Files.media.items.length > 0)
  const originalEnvironment = process.env
  process.env = { STARMAP_PRIVATE_ROOT: root }
  let plugin
  try {
    const { travelAtlasLocalEditor } = await import('./local-editor-plugin.mjs')
    plugin = travelAtlasLocalEditor({ profile: 'personal', privateRoot: root })
    const server = served(plugin)

    await t.test('1. the root needs migrating: read-only, every write refused, not a byte changed', async () => {
      const before = await treeDigest(root)
      assert.equal(privateDataState(paths).state, 'migration-required')
      const module = await moduleOf(plugin)
      assert.equal(module.privateStoreMigrationRequired, true)
      assert.equal(module.privateStoreRevision, undefined)
      assert.deepEqual(servedCanonical(module), canonicalForInputs({ v2Files }), 'the V2 files, migrated in memory (3C-5B)')
      for (const [method, route] of [['POST', 'countries'], ['PUT', 'state'], ['POST', 'view'], ['POST', 'import'], ['POST', 'media/delete'], ['POST', 'upload'], ['GET', 'media/jobs'], ['POST', `media/jobs/${JOB_ID}/import`]]) {
        const result = await requestTo(server.handler, { url: editorPrefix + route, method, content: Buffer.from('{') })
        assert.equal(result.status, 409, `${method} ${route}`)
        assert.equal(result.body.code, 'E_STORE_MIGRATION_REQUIRED', `${method} ${route}`)
        assert.equal(result.bodyReads, 0, `${method} ${route}`)
      }
      const state = await requestTo(server.handler, { url: `${editorPrefix}state`, method: 'GET', headers: {} })
      assert.equal(state.status, 200)
      // `npm run media:import` (the real entry, in its own process) refuses with exit code 2.
      const imported = spawnSync(process.execPath, [fileURLToPath(new URL('./import-media.mjs', import.meta.url)), '--apply'], {
        env: { ...originalEnvironment, STARMAP_PRIVATE_ROOT: root }, encoding: 'utf8', timeout: 60_000, windowsHide: true,
      })
      assert.equal(imported.status, 2, imported.stderr)
      assert.match(imported.stderr, /还没有迁移到新库/)
      assert.deepEqual(await treeDigest(root), before)
      assert.deepEqual(server.invalidations, [])
    })

    await t.test('2. store:migrate previews, then --apply migrates and seeds the media registry', async () => {
      const preview = quietly()
      assert.equal(await runMigrateCli([], { privatePaths: paths, ...preview }), 0, preview.lines.join('\n'))
      assert.match(preview.lines.join('\n'), /预演通过，没有写入任何文件/)
      assert.equal(privateDataState(paths).state, 'migration-required')
      const applied = quietly()
      assert.equal(await runMigrateCli(['--apply'], { privatePaths: paths, ...applied }), 0, applied.lines.join('\n'))
      assert.match(applied.lines.join('\n'), /页面会自动切换/)
      assert.equal(privateDataState(paths).state, 'store')
      const handle = openStore(storeFileOf(paths), { readOnly: true, policy: OFFICIAL_POLICY })
      try {
        assert.equal(handle.meta().revision, 1)
        assert.equal(handle.mediaRegistry().sources.filter((source) => source.state === 'present').length, 5)
      } finally { await handle.close() }
    })

    await t.test('3. the file event switches the dev server to the store without a restart; it reads like the V2 files', async () => {
      server.events.get('add')(storeFileOf(paths))
      assert.deepEqual(server.invalidations, [server.privateModule])
      assert.deepEqual(server.reloads, [{ type: 'full-reload' }])
      const module = await moduleOf(plugin)
      assert.equal(module.privateStoreRevision, 1)
      assert.equal(module.privateStoreMigrationRequired, false)
      assert.deepEqual(servedCanonical(module), canonicalForInputs({ v2Files }))
    })

    await t.test('4. writes work: an editor write, a photo uploaded and imported', async () => {
      const country = await requestTo(server.handler, {
        url: `${editorPrefix}countries`, content: Buffer.from(JSON.stringify({ countryCode: 'IS', visitedDate: '2026-10-01' })),
        headers: { ...authorizedHeaders, [STORE_REQUEST_ID_HEADER]: requestIdOf(1), [STORE_BASE_REVISION_HEADER]: '1' },
      })
      assert.equal(country.status, 201, JSON.stringify(country.body))
      assert.equal(country.body.revision, 2)
      const bytes = await imageBytes({ color: COLOR.purple, width: 70 })
      const uploaded = await requestTo(server.handler, {
        url: `${editorPrefix}upload?${new URLSearchParams({ countryId: PLACE.synthland, cityId: PLACE.harbor, fileName: 'after-migration.jpg' })}`,
        content: bytes, headers: { ...authorizedHeaders, 'content-length': String(bytes.length) },
      })
      assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body))
      const imported = await requestTo(server.handler, {
        url: `${editorPrefix}import`, content: Buffer.from(JSON.stringify({ sourcePaths: [uploaded.body.sourcePath] })),
        headers: { ...authorizedHeaders, [STORE_REQUEST_ID_HEADER]: requestIdOf(2), [STORE_BASE_REVISION_HEADER]: '2' },
      })
      assert.equal(imported.status, 200, JSON.stringify(imported.body))
      assert.equal(imported.body.revision, 3)
      const module = await moduleOf(plugin)
      assert.equal(module.privateStoreRevision, 3)
      assert.equal(servedCanonical(module).media.items.length, v2Files.media.items.length + 1)
    })

    await t.test('5. the first scan of the migrated Inbox adds nothing', async () => {
      // The command lines run in their own process next to the dev server; in this one process the plugin's connection
      // is closed first (one process opens a store once).
      await plugin.buildEnd()
      const checked = quietly()
      assert.equal(await runStoreMediaCli({ privatePaths: paths, argv: [], ...checked }), 0, checked.lines.join('\n'))
      assert.match(checked.lines.join('\n'), /新资料 0/)
      const applied = quietly()
      assert.equal(await runStoreMediaCli({ privatePaths: paths, argv: ['--apply'], ...applied }), 0, applied.lines.join('\n'))
      assert.match(applied.lines.join('\n'), /没有需要导入的变化/)
      const handle = openStore(storeFileOf(paths), { readOnly: true, policy: OFFICIAL_POLICY })
      try { assert.equal(handle.meta().revision, 3, 'nothing committed') } finally { await handle.close() }
    })

    await t.test('6. store:export-v2 writes the store back as V2 files: content ids kept, the edits and the new photo there', async () => {
      const out = path.join(directory, 'export')
      await exportStoreV2(paths, { out, now: NOW })
      const exported = Object.fromEntries(await Promise.all(V2_FILE_KEYS.map(async (key) => [key, JSON.parse(await readFile(path.join(out, V2_FILE_NAMES[key]), 'utf8'))])))
      const exportedIds = exported.media.items.map((item) => item.id)
      for (const item of v2Files.media.items) assert.ok(exportedIds.includes(item.id), item.id)
      assert.equal(exported.media.items.length, v2Files.media.items.length + 1)
      assert.ok(exported.media.items.some((item) => item.originalFileName === 'after-migration.jpg' && /^media-[0-9a-f]{16}$/.test(item.id)))
      assert.ok(exported.editorState.addedCountries.some((entry) => entry.visitedDate === '2026-10-01'))
    })
  } finally {
    process.env = originalEnvironment
    await plugin?.buildEnd()
  }
})
