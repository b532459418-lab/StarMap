/**
 * The local editor plugin in the new-library mode (3C-3): the virtual module reads the store's projection and its
 * revision, GET /editor/state reads the same model, write endpoints the store does not accept are refused with 409
 * E_STORE_MODE_LIMITED before their body is read, and an unopenable store is an error, never a fallback to V2.
 * The harness is the one of local-editor-plugin.test.mjs (no real server).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { storeFileOf } from './private-data-source.mjs'
import { openStore } from './store-host.mjs'
import { applyMigration } from './store-migrate.mjs'
import { sampleV2Files, tempPrivateRoot, treeDigest, writeV2Files } from './store-mode.fixture.mjs'
import { canonicalForInputs } from '../src/data/canonical/canonicalForInputs.ts'
import { readV2 } from '../src/data/canonical/v2Reader.ts'
import { OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'

const editorPrefix = '/__travelatlas/editor/'
const NOW = '2026-10-14T00:00:00.000Z'
const authorizedHeaders = { 'x-travelatlas-local-editor': '1', origin: 'http://127.0.0.1:5173', host: '127.0.0.1:5173' }

function captureMiddleware(plugin, privateModule) {
  const handlers = [], reloads = [], invalidations = []
  plugin.configureServer({
    middlewares: { use: (handler) => handlers.push(handler) },
    watcher: { add: () => {}, on: () => {} },
    moduleGraph: {
      getModuleById: (id) => (privateModule?.id === id ? privateModule : undefined),
      invalidateModule: (module) => { invalidations.push(module); module.transformResult = null },
    },
    ws: { send: (message) => reloads.push(message) },
  })
  return { handlers, reloads, invalidations }
}

async function requestTo(handler, { url, method = 'POST', headers = authorizedHeaders, content = Buffer.from('{}') }) {
  let bodyReads = 0
  const request = Readable.from((function* () { bodyReads += 1; yield content })())
  Object.assign(request, { url, method, headers, socket: { remoteAddress: '127.0.0.1' } })
  let text = ''
  const response = { statusCode: 200, setHeader: () => {}, end: (body = '') => { text += body } }
  try {
    await handler(request, response, () => {})
    return { status: response.statusCode, body: text ? JSON.parse(text) : undefined, bodyReads }
  } finally { request.destroy() }
}

const moduleOf = async (plugin) => import(`data:text/javascript,${encodeURIComponent(await plugin.load(plugin.resolveId('virtual:starmap-private-data')))}`)

/** Every write endpoint of the local editor (the 11 of V2 and the media task actions). */
const WRITE_ENDPOINTS = [
  ['PUT', 'state'], ['POST', 'records'], ['POST', 'countries'], ['POST', 'countries/delete'], ['POST', 'wanttogo'],
  ['POST', 'wanttogo/update'], ['POST', 'wanttogo/delete'], ['POST', 'wanttogo/convert'], ['POST', 'upload'], ['POST', 'import'], ['POST', 'media/delete'],
  ['POST', 'media/jobs'], ...['preview', 'import', 'pause', 'close', 'abandon'].map((action) => ['POST', `media/jobs/018bd504-c600-7000-8000-000000000001/${action}`]),
]

test('Local editor plugin in the new-library mode', async (t) => {
  const { root, paths } = await tempPrivateRoot(t, 'starmap-plugin-store-')
  const files = sampleV2Files()
  await writeV2Files(paths, files)
  const originalEnvironment = process.env
  process.env = { STARMAP_PRIVATE_ROOT: root }
  try {
    const { travelAtlasLocalEditor } = await import('./local-editor-plugin.mjs')

    await t.test('V2 mode: no store revision, the V2 files as before', async () => {
      const plugin = travelAtlasLocalEditor({ profile: 'personal', privateRoot: root })
      const module = await moduleOf(plugin)
      assert.equal(module.privateStoreRevision, undefined)
      assert.deepEqual(module.privateV2Files.wantToGo, files.wantToGo)
    })

    await applyMigration(paths, { now: NOW })
    const plugin = travelAtlasLocalEditor({ profile: 'personal', privateRoot: root })
    const captured = captureMiddleware(plugin)
    const handler = captured.handlers[1]

    await t.test('the virtual module carries the projected V2 files and the store revision', async () => {
      const module = await moduleOf(plugin)
      assert.equal(module.privateStoreRevision, 1)
      assert.equal(module.privateLegacyUnmigrated, false)
      assert.deepEqual(canonicalForInputs({ v2Files: module.privateV2Files }), readV2(files))
    })

    await t.test('GET /editor/state reads the store model', async () => {
      const result = await requestTo(handler, { url: `${editorPrefix}state`, method: 'GET', headers: {} })
      assert.equal(result.status, 200)
      assert.equal(result.body.ok, true)
      assert.deepEqual(result.body.state.hiddenCountryIds, [])
    })

    await t.test('write endpoints the store does not accept are 409 E_STORE_MODE_LIMITED, unread and unwritten', async () => {
      const before = await treeDigest(root)
      for (const [method, route] of WRITE_ENDPOINTS) {
        const result = await requestTo(handler, { url: editorPrefix + route, method, content: Buffer.from('{') })
        assert.equal(result.status, 409, `${method} ${route}`)
        assert.equal(result.body.code, 'E_STORE_MODE_LIMITED', `${method} ${route}`)
        assert.equal(result.body.error, '新库模式（实验性）目前只开放修改想去，其他编辑会在后续接入。本次没有保存。')
        assert.equal(result.bodyReads, 0, `${method} ${route}`)
      }
      const unknown = await requestTo(handler, { url: `${editorPrefix}something-new` })
      assert.equal(unknown.status, 404)
      assert.equal(unknown.body.code, 'E_UNKNOWN_ENDPOINT')
      // Authorization still comes first.
      const forbidden = await requestTo(handler, { url: `${editorPrefix}records`, headers: {} })
      assert.equal(forbidden.status, 403)
      assert.deepEqual(await treeDigest(root), before)
      assert.deepEqual(captured.reloads, [])
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
