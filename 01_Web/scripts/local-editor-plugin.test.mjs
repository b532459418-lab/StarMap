import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { withLibraryOperation } from './library-operation-lock.mjs'
import { crossSiteRequestGuard } from './local-editor-request-guard.mjs'
import { privateDataState, storeFileOf } from './private-data-source.mjs'
import { servedCanonical, servedModuleOf, servedV2Files } from './private-read-model.fixture.mjs'
import { applyMigration } from './compat/store-migrate.mjs'
import { STORE_WRITE_ROUTES } from './store-session.mjs'
import { sampleV2Files, treeDigest } from './store-mode.fixture.mjs'
import { V2_MEDIA_ROUTES } from './v2-media-store.mjs'
import { canonicalForInputs } from '../src/data/compat/v2/canonicalForInputs.ts'
import { readV2 } from '../src/data/compat/v2/v2Reader.ts'
import { officialViewOf } from '../src/data/store/projectCanonical.ts'
import { applyReadModelDelta } from '../src/worldgraph/readModel/delta.ts'

const editorPrefix = '/__travelatlas/editor/'
const authorizedHeaders = {
  'x-travelatlas-local-editor': '1',
  origin: 'http://127.0.0.1:5173',
  host: '127.0.0.1:5173',
}
/** The request protocol of a store write (3C-4a): a fresh request id and the revision the page saw. */
let requestCounter = 0
const storeProtocol = (revision) => ({
  ...authorizedHeaders,
  'x-starmap-request-id': `01960000-0000-7000-8000-${String(++requestCounter).padStart(12, '0')}`,
  'x-starmap-base-revision': String(revision),
})
const NOW = '2026-10-20T00:00:00.000Z'
const JOB_ID = '018bd504-c600-7000-8000-000000000001'
const FILE_ID = '018bd504-c600-7000-8000-000000000002'
/** Every write route of the local editor (8 editor endpoints, 3 media endpoints, the media tasks) and the task reads. */
const WRITE_ROUTES = [
  ...Object.keys(STORE_WRITE_ROUTES), ...Object.keys(V2_MEDIA_ROUTES),
  'POST /__travelatlas/editor/media/jobs',
  ...['pause', 'preview', 'import', 'close', 'abandon'].map((action) => `POST /__travelatlas/editor/media/jobs/${JOB_ID}/${action}`),
  `POST /__travelatlas/editor/media/jobs/${JOB_ID}/files/${FILE_ID}`,
  'POST /__travelatlas/editor/something-new',
].map((key) => { const [method, url] = key.split(' '); return { method, url } })
const TASK_READS = [
  { method: 'GET', url: '/__travelatlas/editor/media/jobs' },
  { method: 'GET', url: `/__travelatlas/editor/media/jobs/${JOB_ID}` },
]
// The library lease's generation counter (operations/) moves with every leased request.
const outsideOperations = (digest) => Object.fromEntries(Object.entries(digest).filter(([file]) => !file.startsWith('operations/')))

function captureMiddleware(plugin, privateModule) {
  const handlers = []
  const watched = []
  const watcherCallbacks = new Map()
  const reloads = []
  // 3C-5 D: the revision pushes (custom events), apart from the page reloads.
  const pushes = []
  const invalidations = []
  plugin.configureServer({
    middlewares: { use: (handler) => handlers.push(handler) },
    watcher: {
      add: (target) => watched.push(target),
      on: (event, callback) => watcherCallbacks.set(event, callback),
    },
    moduleGraph: {
      getModuleById: (id) => privateModule?.id === id ? privateModule : undefined,
      invalidateModule: (module) => {
        invalidations.push(module)
        module.transformResult = null
      },
    },
    ws: { send: (message) => (message?.type === 'custom' ? pushes : reloads).push(message) },
  })
  return { handlers, watched, watcherCallbacks, reloads, pushes, invalidations }
}

async function requestTo(handler, {
  url,
  method = 'POST',
  headers = authorizedHeaders,
  address = '127.0.0.1',
  content = Buffer.from('{}'),
  onEnd = () => {},
}) {
  let bodyReads = 0
  const request = Readable.from((function* () {
    bodyReads += 1
    yield content
  })())
  Object.assign(request, { url, method, headers, socket: { remoteAddress: address } })
  const responseHeaders = new Map()
  let responseText = ''
  let endings = 0
  let nextCalls = 0
  const response = {
    statusCode: 200,
    setHeader: (key, value) => responseHeaders.set(key, value),
    end: (body = '') => { responseText += body; endings += 1; onEnd() },
  }
  try {
    await handler(request, response, () => { nextCalls += 1 })
    return {
      status: response.statusCode,
      body: responseText ? JSON.parse(responseText) : undefined,
      headers: responseHeaders,
      bodyReads,
      endings,
      nextCalls,
    }
  } finally {
    request.destroy()
  }
}

function assertError(result, status, code, params) {
  assert.equal(result.status, status)
  assert.equal(result.body.ok, false)
  assert.equal(result.body.code, code)
  assert.equal(typeof result.body.error, 'string')
  assert.ok(result.body.error.length > 0)
  if (params) assert.deepEqual(result.body.params, params)
  assert.equal(result.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(result.headers.get('cache-control'), 'no-store')
  assert.equal(result.endings, 1)
  assert.equal(result.nextCalls, 0)
}

const moduleOf = async (plugin) => {
  const code = await plugin.load(plugin.resolveId('virtual:starmap-private-data'))
  return { code, exports: await servedModuleOf(plugin, code) }
}

// The plugin keeps paths/cache at module scope: each plugin is used right after it is created, before the next one.
// One isolated fixture and awaited subtests deliberately avoid concurrent plugin factories and any real server. Every
// plugin that opened a store is closed (buildEnd) before the directory is removed.
test('Local editor middleware preserves authorization, error codes and private files', async (t) => {
  const temporaryBase = path.resolve(tmpdir())
  const base = await mkdtemp(path.join(temporaryBase, 'starmap-local-editor-http-'))
  const root = path.join(base, 'main')
  await mkdir(root)
  const originalEnvironment = process.env
  const opened = []
  // Import-time path/proxy initialization sees only our synthetic environment.
  // Preserve the environment object itself without reading any real values.
  process.env = { STARMAP_PRIVATE_ROOT: root }
  try {
    const { travelAtlasLocalEditor } = await import('./local-editor-plugin.mjs')
    const { getPrivatePaths } = await import('./private-profile.mjs')
    const personal = (privateRoot, extra = {}) => {
      const plugin = travelAtlasLocalEditor({ profile: 'personal', privateRoot, ...extra })
      opened.push(plugin)
      return plugin
    }

    await t.test('Public profile registers no editor middleware or private watcher and creates no library', async () => {
      const plugin = travelAtlasLocalEditor({ profile: 'public', privateRoot: root })
      const captured = captureMiddleware(plugin)
      assert.deepEqual(captured.handlers, [])
      assert.deepEqual(captured.watched, [])
      assert.equal(captured.watcherCallbacks.size, 0)
      // No read-model address and no endpoint (3C-5B review): the public page reads the tracked sample.
      assert.equal((await moduleOf(plugin)).exports.privateReadModelUrl, undefined)
      assert.deepEqual(await readdir(root), [])
    })
    await t.test('Forced sample profile registers only the cross-site guard: no private task endpoints, no watcher, no library', async () => {
      const plugin = personal(root, { forceSample: true })
      const captured = captureMiddleware(plugin)
      assert.deepEqual(captured.handlers, [crossSiteRequestGuard])
      assert.deepEqual(captured.watched, [])
      await moduleOf(plugin)
      assert.deepEqual(await readdir(root), [])
    })
    await t.test('A personal build of an empty private root creates no library (3C-4d, review §8-1)', async () => {
      const plugin = personal(root)
      plugin.configResolved({ command: 'build', root: base, build: { outDir: 'dist' } })
      const { exports } = await moduleOf(plugin)
      assert.equal(exports.privateStoreRevision, undefined)
      assert.equal(exports.privateStoreMigrationRequired, false)
      assert.equal(exports.privateStoreRecoveryRequired, false)
      await plugin.buildEnd()
      assert.deepEqual(await readdir(root), [])
    })

    // 3C-4d (decision D-b A): the dev server of an empty private root starts with an empty new library.
    const plugin = personal(root)
    const privateModule = { id: plugin.resolveId('virtual:starmap-private-data'), transformResult: { code: 'cached' } }
    const captured = captureMiddleware(plugin, privateModule)
    // The guard is registered first, so it also runs ahead of Vite's own middlewares.
    assert.equal(captured.handlers.length, 2)
    assert.equal(captured.handlers[0], crossSiteRequestGuard)
    assert.deepEqual(captured.watched, [path.join(root, 'data')])
    const handler = captured.handlers[1]
    const paths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: root })

    await t.test('An empty private root gets an empty new library when the dev server starts; the module reads it (3C-4d, D-b A)', async () => {
      const { exports } = await moduleOf(plugin)
      assert.equal(privateDataState(paths).state, 'store')
      assert.equal(exports.privateStoreRevision, 1)
      assert.equal(exports.privateStoreMigrationRequired, false)
      assert.equal(exports.privateStoreRecoveryRequired, false)
      assert.deepEqual(servedCanonical(exports).places, [])
      assert.deepEqual(servedCanonical(exports).media.items, [])
      assert.equal(existsSync(paths.v2DataRoot), false, 'no V2 file is made up')
      assert.deepEqual(captured.invalidations, [])
    })
    // Taken once the session is open (opening marks the store as in use).
    await requestTo(handler, { url: editorPrefix + 'read-model', method: 'GET', headers: {} })
    const unchanged = async () => assert.deepEqual(outsideOperations(await treeDigest(root)), snapshot)
    const snapshot = outsideOperations(await treeDigest(root))

    await t.test('Task discovery requires loopback, editor header, allowed origin and non-sample page', async () => {
      for (const overrides of [
        {address:'203.0.113.10'}, {headers:{}},
        {headers:{...authorizedHeaders,origin:'https://example.com'}},
        {headers:{...authorizedHeaders,origin:'http://127.0.0.1:9999'}},
        {headers:{...authorizedHeaders,origin:'http://localhost:5173'}},
        {headers:{...authorizedHeaders,referer:'http://127.0.0.1:5173/?data=sample'}},
      ]) {
        const result = await requestTo(handler,{url:editorPrefix+'media/jobs',method:'GET',...overrides})
        assertError(result,403,'E_EDITOR_READ_FORBIDDEN')
        assert.equal(result.bodyReads,0)
      }
      const result = await requestTo(handler,{url:editorPrefix+'media/jobs',method:'GET'})
      assert.equal(result.status,200)
      assert.deepEqual(result.body,{ok:true,libraryId:null,jobs:[]})
      assert.equal(result.bodyReads,0)
      await unchanged()
    })

    await t.test('Task preview/import/close keep authorization ahead of body parsing', async () => {
      for (const action of ['preview','import','close']) {
        for (const overrides of [{address:'203.0.113.10'},{headers:{}},
          {headers:{...authorizedHeaders,origin:'https://example.com'}},
          {headers:{...authorizedHeaders,origin:'http://localhost:9999'}},
          {headers:{...authorizedHeaders,referer:'http://127.0.0.1:5173/?data=sample'}}]) {
          const result = await requestTo(handler,{url:`${editorPrefix}media/jobs/${JOB_ID}/${action}`,content:Buffer.from('{'),...overrides})
          assertError(result,403,'E_EDITOR_WRITE_FORBIDDEN')
          assert.equal(result.bodyReads,0)
        }
      }
      await unchanged()
    })

    await t.test('Task preview never creates a coordination lease or invalidates editor data', async () => {
      const result = await requestTo(handler,{url:`${editorPrefix}media/jobs/${JOB_ID}/preview`,
        content:Buffer.from(JSON.stringify({libraryId:JOB_ID,revision:0,selectedFileIds:[JOB_ID]}))})
      assertError(result,404,'E_MEDIA_JOB_NOT_FOUND')
      await unchanged()
      assert.deepEqual(captured.invalidations,[])
      assert.deepEqual(captured.reloads,[])
    })

    await t.test('Three read endpoints (the read model, the two catalogs) reject remote reads before handling input', async () => {
      for (const route of ['read-model', 'catalog/countries', 'catalog/cities']) {
        const result = await requestTo(handler, {
          url: editorPrefix + route,
          method: 'GET',
          address: '203.0.113.10',
          content: Buffer.from('{'),
        })
        assertError(result, 403, 'E_EDITOR_READ_FORBIDDEN')
        assert.equal(result.bodyReads, 0)
      }
    })

    await t.test('Read endpoints also refuse another origin and cross-site or same-site browser reads', async () => {
      for (const route of ['read-model', 'catalog/countries', 'catalog/cities']) {
        for (const headers of [
          { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:9999' },
          { host: '127.0.0.1:5173', origin: 'http://localhost:5999', 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' },
          { host: '127.0.0.1:5173', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' },
          { host: '127.0.0.1:5173', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' },
        ]) {
          const result = await requestTo(handler, { url: editorPrefix + route, method: 'GET', headers, content: Buffer.from('{') })
          assertError(result, 403, 'E_EDITOR_READ_FORBIDDEN')
          assert.equal(result.bodyReads, 0)
        }
      }
      for (const headers of [
        { host: '127.0.0.1:5173', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' },
        { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'same-origin' },
        { host: '127.0.0.1:5173', 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' },
      ]) {
        const result = await requestTo(handler, { url: editorPrefix + 'read-model', method: 'GET', headers })
        assert.equal(result.status, 200, JSON.stringify(headers))
        assert.equal(result.body.format, 'starmap.read-model')
      }
    })

    await t.test('The read-model endpoint (3C-5B review): a same-origin read gets the store read model, uncached and with its revision; another origin or site is refused, by the endpoint and by the global guard', async () => {
      const { exports } = await moduleOf(plugin)
      assert.equal(exports.privateReadModelUrl, `__travelatlas/editor/read-model?revision=${exports.privateStoreRevision}`)
      for (const headers of [{}, { host: '127.0.0.1:5173', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }, { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173' }]) {
        const result = await requestTo(handler, { url: `/${exports.privateReadModelUrl}`, method: 'GET', headers })
        assert.equal(result.status, 200, JSON.stringify(headers))
        assert.equal(result.headers.get('content-type'), 'application/json; charset=utf-8')
        assert.equal(result.headers.get('cache-control'), 'no-store')
        assert.equal(result.headers.get('x-starmap-revision'), String(exports.privateStoreRevision))
        assert.equal(result.body.format, 'starmap.read-model')
        assert.equal(result.body.revision, exports.privateStoreRevision)
        assert.deepEqual(result.body, exports.privateReadModel)
        assert.equal(result.bodyReads, 0)
      }
      const crossSite = [
        { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:9999' },
        { host: '127.0.0.1:5173', origin: 'http://localhost:5999', 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' },
        { host: '127.0.0.1:5173', origin: 'https://example.com', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' },
        { host: '127.0.0.1:5173', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' },
      ]
      for (const headers of crossSite) {
        const result = await requestTo(handler, { url: `/${exports.privateReadModelUrl}`, method: 'GET', headers })
        assertError(result, 403, 'E_EDITOR_READ_FORBIDDEN')
      }
      // The guard registered ahead of every Vite middleware stops a page of another site or port before the endpoint.
      for (const headers of crossSite.slice(1)) {
        let status = 200, text = '', passed = false
        crossSiteRequestGuard({ url: `/${exports.privateReadModelUrl}`, method: 'GET', headers, socket: { remoteAddress: '127.0.0.1' } },
          { set statusCode(value) { status = value }, get statusCode() { return status }, setHeader: () => {}, end: (body) => { text = body } }, () => { passed = true })
        assert.deepEqual([status, text, passed], [403, 'Forbidden', false], JSON.stringify(headers))
      }
      // A read endpoint: not answered to another address.
      assertError(await requestTo(handler, { url: `/${exports.privateReadModelUrl}`, method: 'GET', headers: {}, address: '203.0.113.10' }), 403, 'E_EDITOR_READ_FORBIDDEN')
    })

    await t.test('Writes reject address, missing header and disallowed Origin before malformed JSON', async () => {
      for (const overrides of [
        { address: '203.0.113.10' },
        { headers: { origin: authorizedHeaders.origin } },
        { headers: { ...authorizedHeaders, origin: 'https://127.0.0.1:5173' } },
        { headers: { ...authorizedHeaders, origin: 'http://example.com' } },
        { headers: { ...authorizedHeaders, origin: 'http://127.0.0.1:9999' } },
        { headers: { ...authorizedHeaders, origin: 'not a URL' } },
      ]) {
        const result = await requestTo(handler, {
          url: editorPrefix + 'records', content: Buffer.from('{'), ...overrides,
        })
        assertError(result, 403, 'E_EDITOR_WRITE_FORBIDDEN')
        assert.equal(result.bodyReads, 0)
      }
    })

    await t.test('The read model of the empty library is read without writing; GET and PUT /state are gone (3C-5 E)', async () => {
      const result = await requestTo(handler, { url: editorPrefix + 'read-model', method: 'GET', headers: {} })
      assert.equal(result.status, 200)
      assert.equal(result.body.format, 'starmap.read-model')
      for (const method of ['GET', 'PUT']) {
        const gone = await requestTo(handler, { url: editorPrefix + 'state', method, headers: storeProtocol(1), content: Buffer.from('{}') })
        assertError(gone, 404, 'E_UNKNOWN_ENDPOINT')
      }
      assert.equal(result.bodyReads, 0)
      await unchanged()
    })

    await t.test('Catalog validation returns structured errors before any provider search', async () => {
      const cases = [
        ['?countryCode=JP', 'E_REQUIRED', { field: 'search_query' }],
        ['?q=Tokyo', 'E_REQUIRED', { field: 'country_code' }],
        ['?q=Tokyo&countryCode=JPN', 'E_NUMBER_INVALID', { field: 'country_code' }],
        ['?q=Tokyo&countryCode=ZZ', 'E_SEARCH_COUNTRY_NOT_FOUND', undefined],
      ]
      for (const [query, code, params] of cases) {
        const result = await requestTo(handler, {
          url: editorPrefix + 'catalog/cities' + query, method: 'GET', headers: {},
        })
        assertError(result, 400, code, params)
        assert.equal(result.bodyReads, 0)
      }
    })

    await t.test('Unknown write endpoint returns 404 without parsing its body', async () => {
      const result = await requestTo(handler, { url: editorPrefix + 'unknown', content: Buffer.from('{') })
      assertError(result, 404, 'E_UNKNOWN_ENDPOINT')
      assert.equal(result.bodyReads, 0)
    })

    await t.test('JSON routes return distinct malformed/oversize errors without writes', async () => {
      for (const route of ['records', 'import', 'media/delete',
        ...['preview','import','close'].map(action => `media/jobs/${JOB_ID}/${action}`)]) {
        const malformed = await requestTo(handler, { url: editorPrefix + route, content: Buffer.from('{') })
        assertError(malformed, 400, 'E_REQUEST_INVALID')
        assert.equal(typeof malformed.body.params.reason, 'string')
        assert.equal(malformed.body.error, malformed.body.params.reason)
        assert.equal(malformed.bodyReads, 1)
        const oversized = await requestTo(handler, {
          url: editorPrefix + route, content: Buffer.alloc(1024 * 1024 + 1, 0x20),
        })
        assertError(oversized, 400, 'E_REQUEST_TOO_LARGE', { limitBytes: 1024 * 1024 })
        assert.equal(oversized.bodyReads, 1)
      }
      await unchanged()
    })

    assert.deepEqual(captured.reloads, [])
    assert.deepEqual(captured.invalidations, [])

    await t.test('First writes go to the empty library and invalidate the cached module without watcher events or page reloads', async () => {
      const cachedFiles = async () => {
        privateModule.transformResult ??= { code: await plugin.load(privateModule.id) }
        return servedV2Files(await servedModuleOf(plugin, privateModule.transformResult.code))
      }
      privateModule.transformResult = null
      assert.deepEqual((await cachedFiles()).places.places, [])
      const before = privateModule.transformResult
      await requestTo(handler, { url: editorPrefix + 'read-model', method: 'GET', headers: {} })
      await requestTo(handler, { url: editorPrefix + 'countries', headers: {} })
      assert.equal(privateModule.transformResult, before, 'Read/forbidden requests preserve the cached module')
      assert.deepEqual(captured.invalidations, [])

      let revision = 1
      const post = async (route, input) => {
        let invalidAtResponseEnd = false
        const result = await requestTo(handler, {
          url: editorPrefix + route,
          headers: storeProtocol(revision),
          content: Buffer.from(JSON.stringify(input)),
          onEnd: () => { invalidAtResponseEnd = privateModule.transformResult === null },
        })
        assert.equal(result.status, 201, JSON.stringify(result.body))
        assert.equal(invalidAtResponseEnd, true, 'Invalidate before sending the write response')
        revision = result.body.revision
        return cachedFiles()
      }
      let files = await post('countries', { countryCode: 'JP', visitedDate: '2026-05-01' })
      assert.deepEqual(files.places.places.map((place) => place.names.en), ['Japan'])
      files = await post('records', {
        country: '日本', country_en: 'Japan', country_code: 'JP', city: '东京', city_en: 'Tokyo',
        start_date: '2026-05-02', lat: 35.6762, lng: 139.6503,
      })
      assert.deepEqual(files.places.places.map((place) => place.names.en).sort(), ['Japan', 'Tokyo'])
      files = await post('records', {
        country: '日本', country_en: 'Japan', country_code: 'JP', city: '京都', city_en: 'Kyoto',
        start_date: '2026-05-03', lat: 35.0116, lng: 135.7681,
      })
      assert.deepEqual(files.places.places.map((place) => place.names.en).sort(), ['Japan', 'Kyoto', 'Tokyo'])
      assert.equal(files.travel.records.length, 2, 'Both city records are reloaded')
      assert.equal(revision, 4)
      assert.equal(captured.invalidations.length, 3)
      assert.ok(captured.invalidations.every((module) => module === privateModule))
      assert.deepEqual(captured.reloads, [], 'Explicit cache invalidation does not trigger another page reload')
    })

    await t.test('Converting a first Iceland city preserves the catalog continent in editor state', async () => {
      const revision = (await moduleOf(plugin)).exports.privateStoreRevision
      const added = await requestTo(handler, {
        url: editorPrefix + 'wanttogo',
        headers: storeProtocol(revision),
        content: Buffer.from(JSON.stringify({
          place: { kind: 'city', nameZh: '示例南城', nameEn: 'SampleSouth', countryCode: 'IS', lat: 64, lng: -22 },
          note: '保留备注',
        })),
      })
      assert.equal(added.status, 201, JSON.stringify(added.body))
      assert.equal(added.body.item.note, '保留备注')
      const converted = await requestTo(handler, {
        url: editorPrefix + 'wanttogo/convert',
        headers: storeProtocol(added.body.revision),
        content: Buffer.from(JSON.stringify({
          source: 'want-to-go', id: added.body.id,
          startDate: '2026-10-03', endDate: '2026-10-04', keepWantToGo: false,
        })),
      })
      assert.equal(converted.status, 200, JSON.stringify(converted.body))
      assert.equal(converted.body.wantToGoRemoved, true)
      const canonical = servedCanonical((await moduleOf(plugin)).exports)
      assert.deepEqual(canonical.editorState.addedCountries
        .filter(({ placeId }) => placeId === converted.body.countryId)
        .map(({ placeId, region, visitedDate }) => ({ placeId, region, visitedDate })), [{
        placeId: converted.body.countryId, region: 'Europe', visitedDate: '2026-10-03',
      }])
      assert.deepEqual(canonical.wantToGo.items, [])
      assert.deepEqual(canonical.travel.records
        .filter(({ start_date }) => start_date === '2026-10-03')
        .map(({ start_date, end_date }) => ({ start_date, end_date })), [{
        start_date: '2026-10-03', end_date: '2026-10-04',
      }])
      assert.deepEqual(captured.reloads, [])
    })

    await t.test('The changes endpoint and the revision pushes (3C-5 D): a write answers with its changed rows and is pushed; the endpoint gives the same rows by revision, 410 when the page has to read everything again; reads only', async () => {
      // Every commit so far was pushed once, in order, with the library and its revision.
      const served = await requestTo(handler, { url: '/__travelatlas/editor/read-model', method: 'GET', headers: {} })
      const libraryId = served.headers.get('x-starmap-library-id')
      assert.match(libraryId, /^[0-9a-f-]{36}$/)
      assert.equal(served.headers.get('x-starmap-restore-mark'), '')
      const revision = served.body.revision
      assert.ok(captured.pushes.length >= 3 && captured.pushes.every((push) => push.type === 'custom' && push.event === 'starmap:revision' && push.data.libraryId === libraryId && push.data.restoreMark === null))
      assert.deepEqual(captured.pushes.map((push) => push.data.revision), [...captured.pushes.keys()].map((n) => revision - captured.pushes.length + 1 + n))
      const changes = (query, headers = {}, overrides = {}) => requestTo(handler, { url: `/__travelatlas/editor/read-model/changes?${query}`, method: 'GET', headers, ...overrides })
      // Current: nothing to apply.
      const current = await changes(`since=${revision}&libraryId=${libraryId}&restoreMark=`)
      assert.equal(current.status, 200, JSON.stringify(current.body))
      assert.equal(current.headers.get('cache-control'), 'no-store')
      assert.deepEqual(current.body, { ok: true, libraryId, restoreMark: null, revision, deltas: [] })
      // A write: its answer carries the changed rows, a push follows, and the endpoint gives the same rows.
      const pushed = captured.pushes.length
      const written = await requestTo(handler, { url: editorPrefix + 'countries', headers: storeProtocol(revision), content: Buffer.from(JSON.stringify({ countryCode: 'NO', visitedDate: '2026-06-01' })) })
      assert.equal(written.status, 201, JSON.stringify(written.body))
      assert.deepEqual([written.body.delta.libraryId, written.body.delta.from, written.body.delta.to], [libraryId, revision, revision + 1])
      assert.deepEqual(captured.pushes.slice(pushed), [{ type: 'custom', event: 'starmap:revision', data: { libraryId, restoreMark: null, revision: revision + 1 } }])
      const after = await changes(`since=${revision}&libraryId=${libraryId}&restoreMark=`)
      assert.equal(after.status, 200)
      assert.deepEqual(after.body.deltas, [written.body.delta])
      const now = await requestTo(handler, { url: '/__travelatlas/editor/read-model', method: 'GET', headers: {} })
      assert.deepEqual(applyReadModelDelta(served.body, { baseRevision: revision, nextRevision: revision + 1, ...written.body.delta }), now.body)
      // Several commits behind: every entry from there, in order.
      const behind = await changes(`since=${revision - 1}`)
      assert.deepEqual(behind.body.deltas.map((delta) => [delta.from, delta.to]), [[revision - 1, revision], [revision, revision + 1]])
      // 410: older than the first change kept, ahead of the library, another library, a restored library.
      for (const [query, reason] of [['since=0', 'too-old'], [`since=${revision + 9}`, 'ahead'],
        [`since=${revision}&libraryId=01900000-0000-7000-8000-000000000999`, 'library'], [`since=${revision}&libraryId=${libraryId}&restoreMark=2026-01-01T00:00:00.000Z`, 'restored']]) {
        const gone = await changes(query)
        assert.equal(gone.status, 410, query)
        assert.deepEqual([gone.body.code, gone.body.reason, gone.body.revision], ['E_CHANGES_GONE', reason, revision + 1], query)
      }
      // A request without a revision, or with a revision that is no revision.
      for (const query of ['', 'since=', 'since=-1', 'since=1.5', 'since=x']) assertError(await changes(query), 400, 'E_REQUEST_INVALID')
      // A read endpoint: refused to another origin or site, and to another address, before anything else.
      for (const headers of [
        { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:9999' },
        { host: '127.0.0.1:5173', origin: 'http://localhost:5999', 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' },
        { host: '127.0.0.1:5173', origin: 'https://example.com', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' },
        { host: '127.0.0.1:5173', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' },
      ]) assertError(await changes(`since=${revision}`, headers), 403, 'E_EDITOR_READ_FORBIDDEN')
      assertError(await changes(`since=${revision}`, {}, { address: '203.0.113.10' }), 403, 'E_EDITOR_READ_FORBIDDEN')
      // The guard ahead of every Vite middleware stops a page of another site before the endpoint.
      for (const headers of [{ host: '127.0.0.1:5173', origin: 'https://example.com', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' }, { host: '127.0.0.1:5173', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' }]) {
        let status = 200, passed = false
        crossSiteRequestGuard({ url: `/__travelatlas/editor/read-model/changes?since=${revision}`, method: 'GET', headers, socket: { remoteAddress: '127.0.0.1' } },
          { set statusCode(value) { status = value }, get statusCode() { return status }, setHeader: () => {}, end: () => {} }, () => { passed = true })
        assert.deepEqual([status, passed], [403, false], JSON.stringify(headers))
      }
      assert.deepEqual(captured.reloads, [])
    })

    await t.test('File events: add, change and unlink share one filter; the store file counts when it appears or goes, not when it is written', async () => {
      const fire = (event, target) => captured.watcherCallbacks.get(event)(target)
      assert.deepEqual([...captured.watcherCallbacks.keys()].sort(), ['add', 'change', 'unlink'])
      const invalidations = captured.invalidations.length
      fire('change', path.join(paths.dataRoot, 'travel-map.local.json'))
      fire('change', path.join(root, 'MediaInbox', 'a.jpg'))
      fire('add', path.join(paths.dataRoot, 'v2-backup', 'places.local.json'))
      fire('change', storeFileOf(paths))
      fire('add', `${storeFileOf(paths)}-journal`)
      assert.equal(captured.invalidations.length, invalidations, 'the editor\'s own store writes are not file events')
      assert.deepEqual(captured.reloads, [])

      fire('change', paths.v2FilePaths.places)
      fire('add', path.join(paths.dataRoot, 'travel-map.local.json'))
      fire('unlink', paths.v2FilePaths.media)
      fire('add', storeFileOf(paths))
      fire('unlink', storeFileOf(paths))
      assert.equal(captured.invalidations.length, invalidations + 5)
      assert.deepEqual(captured.reloads, Array.from({ length: 5 }, () => ({ type: 'full-reload' })))
    })
    await plugin.buildEnd()

    // Other private roots, each with its own plugin (module-scope paths follow the plugin created last).
    const v2Fixture = JSON.parse(await readFile(new URL('./fixtures/editor-store-v2.json', import.meta.url), 'utf8'))
    const legacySentinel = 'Synthetic legacy sentinel 7f3c, deliberately not JSON.\n'
    const privateRootWith = async (name, { v2 = false, v2Files = v2Fixture, legacy = false, residue = false } = {}) => {
      const privateRoot = path.join(base, name)
      const rootPaths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: privateRoot })
      await mkdir(rootPaths.v2DataRoot, { recursive: true })
      if (v2) for (const [key, file] of Object.entries(rootPaths.v2FilePaths)) if (v2Files[key] !== undefined) await writeFile(file, `${JSON.stringify(v2Files[key], null, 2)}\n`)
      if (legacy) await writeFile(rootPaths.localTravelMapPath, legacySentinel)
      if (residue) {
        await mkdir(path.dirname(storeFileOf(rootPaths)), { recursive: true })
        await writeFile(`${storeFileOf(rootPaths)}-journal`, 'synthetic leftover journal')
      }
      return { privateRoot, paths: rootPaths }
    }

    await t.test('A V2 root whose files cannot be migrated (3C-5B review): the module still loads, the read-model endpoint answers 422 with the migration problems and no value, nothing is written', async () => {
      const broken = structuredClone(v2Fixture)
      const secret = broken.places.places[0].names.en
      broken.places.places[0].names = { en: secret, '': 'x' }
      const { privateRoot } = await privateRootWith('migration-refused', { v2: true, v2Files: broken })
      const before = await treeDigest(privateRoot)
      const refusedPlugin = personal(privateRoot)
      const refusedHandler = captureMiddleware(refusedPlugin, { id: refusedPlugin.resolveId('virtual:starmap-private-data'), transformResult: null }).handlers[1]
      const { exports } = await moduleOf(refusedPlugin)
      assert.equal(exports.privateStoreMigrationRequired, true)
      assert.equal(exports.privateReadModel, undefined)
      const result = await requestTo(refusedHandler, { url: `/${exports.privateReadModelUrl}`, method: 'GET', headers: {} })
      assert.equal(result.status, 422)
      assert.equal(result.body.code, 'E_MIGRATION_REFUSED')
      assert.ok(result.body.problems.some((problem) => /places\.local\.json \$\.places\[0\]\.names/.test(problem)), result.body.problems.join('\n'))
      assert.ok(!JSON.stringify(result.body).includes(secret))
      assert.deepEqual(await treeDigest(privateRoot), before)
      await refusedPlugin.buildEnd()
    })

    await t.test('A V2 root needs migration (3C-4d, review §8-2): every write, media and task route answers 409 E_STORE_MIGRATION_REQUIRED before reading its body; reads still answer; nothing is written', async () => {
      const { privateRoot, paths: rootPaths } = await privateRootWith('migration-required', { v2: true })
      const before = await treeDigest(privateRoot)
      const v2Plugin = personal(privateRoot)
      const v2Module = { id: v2Plugin.resolveId('virtual:starmap-private-data'), transformResult: { code: 'cached' } }
      const v2Captured = captureMiddleware(v2Plugin, v2Module)
      const v2Handler = v2Captured.handlers[1]
      const { exports } = await moduleOf(v2Plugin)
      assert.deepEqual(servedCanonical(exports), canonicalForInputs({ v2Files: v2Fixture }), 'the V2 files, migrated in memory (3C-5B)')
      assert.equal(exports.privateStoreMigrationRequired, true)
      assert.equal(exports.privateStoreRecoveryRequired, false)
      assert.equal(exports.privateStoreRevision, undefined)
      const forbidden = await requestTo(v2Handler, { url: editorPrefix + 'records', content: Buffer.from('{'), headers: {} })
      assertError(forbidden, 403, 'E_EDITOR_WRITE_FORBIDDEN')
      for (const { method, url } of [...WRITE_ROUTES, ...TASK_READS]) {
        const result = await requestTo(v2Handler, { url, method, content: Buffer.from('{') })
        assertError(result, 409, 'E_STORE_MIGRATION_REQUIRED')
        assert.match(result.body.error, /store:migrate/, `${method} ${url}`)
        assert.equal(result.bodyReads, 0, `${method} ${url}`)
      }
      // 3C-5B: the read-model endpoint answers with the V2 files migrated in memory; the address names their digest.
      assert.match(exports.privateReadModelUrl, /^__travelatlas\/editor\/read-model\?v2=[0-9a-f]{16}$/)
      const served = await requestTo(v2Handler, { url: `/${exports.privateReadModelUrl}`, method: 'GET', headers: {} })
      assert.equal(served.status, 200)
      assert.equal(served.headers.get('x-starmap-revision'), undefined)
      assert.deepEqual(officialViewOf(served.body, 'local'), canonicalForInputs({ v2Files: v2Fixture }))
      // 3C-5 D: a root that is not a library has no changes: the page reads the whole read model (410).
      const changes = await requestTo(v2Handler, { url: '/__travelatlas/editor/read-model/changes?since=0', method: 'GET', headers: {} })
      assert.deepEqual([changes.status, changes.body.code, changes.body.reason], [410, 'E_CHANGES_GONE', 'not-a-library'])
      const countries = await requestTo(v2Handler, { url: editorPrefix + 'catalog/countries?q=Iceland', method: 'GET', headers: {} })
      assert.equal(countries.status, 200)
      assert.deepEqual(await treeDigest(privateRoot), before, 'no file written, no library, no lease')
      assert.equal(privateDataState(rootPaths).state, 'migration-required')
      assert.deepEqual(v2Captured.invalidations, [])
      assert.deepEqual(v2Captured.reloads, [])
      assert.equal(v2Module.transformResult.code, 'cached')
    })

    await t.test('Migrating while the dev server runs switches it to the store without a restart (3C-4d, review §7-4)', async () => {
      const files = sampleV2Files()
      const { privateRoot, paths: rootPaths } = await privateRootWith('migrate-live', { v2: true, v2Files: files })
      const livePlugin = personal(privateRoot)
      const liveModule = { id: livePlugin.resolveId('virtual:starmap-private-data'), transformResult: { code: 'cached' } }
      const live = captureMiddleware(livePlugin, liveModule)
      const liveHandler = live.handlers[1]
      assert.equal((await moduleOf(livePlugin)).exports.privateStoreMigrationRequired, true)
      const refused = await requestTo(liveHandler, { url: editorPrefix + 'countries', headers: storeProtocol(1), content: Buffer.from(JSON.stringify({ countryCode: 'JP', visitedDate: '2026-05-01' })) })
      assertError(refused, 409, 'E_STORE_MIGRATION_REQUIRED')

      // `npm run store:migrate -- --apply` in another terminal: the watcher sees the new store file.
      await applyMigration(rootPaths, { now: NOW })
      live.watcherCallbacks.get('add')(storeFileOf(rootPaths))
      assert.deepEqual(live.invalidations, [liveModule])
      assert.deepEqual(live.reloads, [{ type: 'full-reload' }])
      const { exports } = await moduleOf(livePlugin)
      assert.equal(exports.privateStoreRevision, 1)
      assert.equal(exports.privateStoreMigrationRequired, false)
      assert.deepEqual(servedCanonical(exports), readV2(files))
      const jobs = await requestTo(liveHandler, { url: editorPrefix + 'media/jobs', method: 'GET' })
      assert.equal(jobs.status, 200, JSON.stringify(jobs.body))
      const written = await requestTo(liveHandler, { url: editorPrefix + 'countries', headers: storeProtocol(1), content: Buffer.from(JSON.stringify({ countryCode: 'JP', visitedDate: '2026-05-01' })) })
      assert.equal(written.status, 201, JSON.stringify(written.body))
      assert.equal(written.body.revision, 2)
      await livePlugin.buildEnd()
    })

    await t.test('After the automatic empty library is created, its file event switches the page to the store (review §7-4)', async () => {
      const { privateRoot, paths: rootPaths } = await privateRootWith('auto-library')
      const autoPlugin = personal(privateRoot)
      const autoModule = { id: autoPlugin.resolveId('virtual:starmap-private-data'), transformResult: { code: 'cached' } }
      const auto = captureMiddleware(autoPlugin, autoModule)
      const { exports } = await moduleOf(autoPlugin)
      assert.equal(exports.privateStoreRevision, 1)
      auto.watcherCallbacks.get('add')(storeFileOf(rootPaths))
      assert.deepEqual(auto.invalidations, [autoModule])
      assert.deepEqual(auto.reloads, [{ type: 'full-reload' }])
      assert.equal((await moduleOf(autoPlugin)).exports.privateStoreRevision, 1)
      const written = await requestTo(auto.handlers[1], { url: editorPrefix + 'countries', headers: storeProtocol(1), content: Buffer.from(JSON.stringify({ countryCode: 'IS', visitedDate: '2026-05-01' })) })
      assert.equal(written.status, 201, JSON.stringify(written.body))
      await autoPlugin.buildEnd()
    })

    await t.test('Leftovers under data/store/ without a library: no library is created; every write answers 409 E_STORE_RECOVERY_REQUIRED (review §8-1)', async () => {
      const { privateRoot, paths: rootPaths } = await privateRootWith('residue', { residue: true })
      const before = await treeDigest(privateRoot)
      const residuePlugin = personal(privateRoot)
      const residue = captureMiddleware(residuePlugin)
      const { exports } = await moduleOf(residuePlugin)
      assert.equal(exports.privateStoreRecoveryRequired, true)
      assert.equal(exports.privateStoreMigrationRequired, false)
      assert.equal(exports.privateStoreRevision, undefined)
      for (const { method, url } of [...WRITE_ROUTES, ...TASK_READS]) {
        const result = await requestTo(residue.handlers[1], { url, method, content: Buffer.from('{') })
        assertError(result, 409, 'E_STORE_RECOVERY_REQUIRED')
        assert.match(result.body.error, /library:recover/)
        assert.equal(result.bodyReads, 0, `${method} ${url}`)
      }
      assert.equal(existsSync(storeFileOf(rootPaths)), false)
      assert.deepEqual(await treeDigest(privateRoot), before)
    })

    await t.test('An empty library that cannot be created (the library lease is held): the root needs recovery, writes refuse', async () => {
      const { privateRoot, paths: rootPaths } = await privateRootWith('busy-empty')
      await withLibraryOperation(rootPaths, async () => {
        const busyPlugin = personal(privateRoot)
        const busy = captureMiddleware(busyPlugin)
        const { exports } = await moduleOf(busyPlugin)
        assert.equal(exports.privateStoreRecoveryRequired, true)
        const result = await requestTo(busy.handlers[1], { url: editorPrefix + 'countries', content: Buffer.from('{') })
        assertError(result, 409, 'E_STORE_RECOVERY_REQUIRED')
        assert.equal(result.bodyReads, 0)
      })
      assert.equal(existsSync(storeFileOf(rootPaths)), false)
      assert.equal(privateDataState(rootPaths).state, 'empty')
    })

    await t.test('Authorization precedes legacy refusal; legacy refusal precedes JSON and writes', async () => {
      const { privateRoot, paths: rootPaths } = await privateRootWith('legacy-refusal', { legacy: true })
      const legacyHandler = captureMiddleware(personal(privateRoot)).handlers[1]
      const forbidden = await requestTo(legacyHandler, {
        url: editorPrefix + 'records', content: Buffer.from('{'), headers: {},
      })
      assertError(forbidden, 403, 'E_EDITOR_WRITE_FORBIDDEN')
      assert.equal(forbidden.bodyReads, 0)
      for (const { method, url } of [...WRITE_ROUTES, ...TASK_READS]) {
        const result = await requestTo(legacyHandler, { url, method, content: Buffer.from('{') })
        assertError(result, 409, 'E_LEGACY_UNMIGRATED', { legacyFiles: ['travel-map.local.json'] })
        assert.equal(result.bodyReads, 0)
      }
      assert.deepEqual(await readdir(privateRoot), ['data'])
      assert.deepEqual((await readdir(rootPaths.dataRoot)).sort(), ['travel-map.local.json', 'v2'])
      assert.equal(await readFile(rootPaths.localTravelMapPath, 'utf8'), legacySentinel)
    })

    await t.test('Private media is served only to same-origin reads, with CORP and nosniff on every response', async () => {
      const mediaRoot = path.join(base, 'media-serving')
      await mkdir(path.join(mediaRoot, 'media', 'user', 'abc123'), { recursive: true })
      await writeFile(path.join(mediaRoot, 'media', 'user', 'abc123', 'thumb.webp'), Buffer.from('not really webp'))
      const fresh = captureMiddleware(personal(mediaRoot))
      const mediaHandler = fresh.handlers[1]
      const serve = async (headers, method = 'HEAD', address = '127.0.0.1') => {
        const responseHeaders = new Map()
        const response = { statusCode: 200, headersSent: false, text: '', setHeader: (key, value) => responseHeaders.set(key, value), end(body = '') { this.text += body } }
        let nextCalls = 0
        await mediaHandler({ url: '/media/user/abc123/thumb.webp', method, headers: { host: '127.0.0.1:5173', ...headers }, socket: { remoteAddress: address } }, response, () => { nextCalls += 1 })
        assert.equal(nextCalls, 0)
        assert.equal(responseHeaders.get('cross-origin-resource-policy'), 'same-origin')
        assert.equal(responseHeaders.get('x-content-type-options'), 'nosniff')
        assert.equal(responseHeaders.has('access-control-allow-origin'), false)
        return { status: response.statusCode, headers: responseHeaders, text: response.text }
      }
      for (const headers of [{}, { 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'image' }, { origin: 'http://127.0.0.1:5173' }]) {
        const result = await serve(headers)
        assert.equal(result.status, 200, JSON.stringify(headers))
        assert.equal(result.headers.get('content-type'), 'image/webp')
        assert.equal(result.headers.get('cache-control'), 'no-store')
      }
      for (const [headers, address] of [
        [{ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }],
        [{ 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }],
        [{ origin: 'http://localhost:5999' }],
        [{}, '203.0.113.10'],
      ]) {
        const result = await serve(headers, 'GET', address)
        assert.equal(result.status, 403, JSON.stringify(headers))
        assert.equal(result.text, 'Forbidden')
        assert.equal(result.headers.has('content-type'), false)
      }
    })

    await t.test('Private media refuses a link or junction anywhere on the way to the file (batch 7, review S5)', async () => {
      const mediaRoot = path.join(base, 'media-links')
      const outside = path.join(base, 'media-links-outside')
      const userMedia = path.join(mediaRoot, 'media', 'user')
      await mkdir(path.join(userMedia, 'plain'), { recursive: true })
      await mkdir(outside, { recursive: true })
      await writeFile(path.join(userMedia, 'plain', 'thumb.webp'), Buffer.from('inside'))
      await writeFile(path.join(outside, 'thumb.webp'), Buffer.from('outside'))
      const linkType = process.platform === 'win32' ? 'junction' : 'dir'
      await symlink(outside, path.join(userMedia, 'linked'), linkType)
      const fresh = captureMiddleware(personal(mediaRoot))
      const get = async (url, privateHandler = fresh.handlers[1]) => {
        const response = { statusCode: 200, headersSent: false, text: '', setHeader: () => {}, end(body = '') { this.text += body } }
        await privateHandler({ url, method: 'HEAD', headers: { host: '127.0.0.1:5173' }, socket: { remoteAddress: '127.0.0.1' } }, response, () => {})
        return { status: response.statusCode, text: response.text }
      }
      assert.equal((await get('/media/user/plain/thumb.webp')).status, 200)
      assert.deepEqual(await get('/media/user/linked/thumb.webp'), { status: 403, text: 'Forbidden' })
      assert.deepEqual(await get('/media/user/plain/thumb.webp/below'), { status: 403, text: 'Forbidden' }, 'a file used as a directory')
      assert.deepEqual(await get('/media/user/plain/missing.webp'), { status: 404, text: 'Not Found' })

      // The media directory itself as a junction to another place: refused as well.
      const linkedRoot = path.join(base, 'media-linked-root')
      await mkdir(path.join(linkedRoot, 'media'), { recursive: true })
      await symlink(userMedia, path.join(linkedRoot, 'media', 'user'), linkType)
      const linked = captureMiddleware(personal(linkedRoot))
      assert.deepEqual(await get('/media/user/plain/thumb.webp', linked.handlers[1]), { status: 403, text: 'Forbidden' })
    })

    await t.test('The private data module: personal reads only the five V2 files (migrated in memory, 3C-5B) plus the state flags; public reads nothing', async () => {
      const both = await privateRootWith('module-v2-and-legacy', { v2: true, legacy: true })
      const personalModule = await moduleOf(personal(both.privateRoot))
      assert.deepEqual(servedCanonical(personalModule.exports), canonicalForInputs({ v2Files: v2Fixture }))
      assert.equal(personalModule.exports.privateLegacyUnmigrated, false, 'V2 files present: the legacy file is a leftover')
      assert.equal(personalModule.exports.privateStoreMigrationRequired, true)
      assert.ok(!personalModule.code.includes('7f3c'), 'the legacy file is never read')

      const legacyOnly = await privateRootWith('module-legacy-only', { legacy: true })
      const unmigrated = await moduleOf(personal(legacyOnly.privateRoot))
      assert.deepEqual(servedCanonical(unmigrated.exports), canonicalForInputs({ v2Files: undefined }), 'no V2 file: the read model of empty files')
      assert.equal(unmigrated.exports.privateLegacyUnmigrated, true)
      assert.equal(unmigrated.exports.privateStoreMigrationRequired, false, 'the legacy notice comes first')
      assert.ok(!unmigrated.code.includes('7f3c'))

      const publicModule = await moduleOf(travelAtlasLocalEditor({ profile: 'public', privateRoot: both.privateRoot }))
      assert.equal(publicModule.exports.privateReadModelUrl, undefined)
      assert.equal(publicModule.exports.privateLegacyUnmigrated, false)
      assert.equal(publicModule.exports.privateStoreMigrationRequired, false)
      assert.ok(!publicModule.code.includes(v2Fixture.places.places[0].id), 'no private file is read for the public profile')
    })

    await t.test('Read endpoints answer while legacy data is unmigrated; the read model comes from the V2 files', async () => {
      const legacyOnly = await privateRootWith('reads-legacy-only', { legacy: true })
      const unmigratedHandler = captureMiddleware(personal(legacyOnly.privateRoot)).handlers[1]
      const state = await requestTo(unmigratedHandler, { url: editorPrefix + 'read-model', method: 'GET', headers: {} })
      assert.equal(state.status, 200, JSON.stringify(state.body))
      assert.deepEqual(officialViewOf(state.body, 'local').editorState.countryOrder, [])
      const countries = await requestTo(unmigratedHandler, { url: editorPrefix + 'catalog/countries?q=Iceland', method: 'GET', headers: {} })
      assert.equal(countries.status, 200, JSON.stringify(countries.body))
      assert.ok(countries.body.results.length > 0)
      const write = await requestTo(unmigratedHandler, { url: editorPrefix + 'countries', content: Buffer.from('{') })
      assertError(write, 409, 'E_LEGACY_UNMIGRATED')
      assert.equal(await readFile(legacyOnly.paths.localTravelMapPath, 'utf8'), legacySentinel)

      const migrated = await privateRootWith('reads-v2', { v2: true, legacy: true })
      const migratedHandler = captureMiddleware(personal(migrated.privateRoot)).handlers[1]
      const v2State = await requestTo(migratedHandler, { url: editorPrefix + 'read-model', method: 'GET', headers: {} })
      assert.equal(v2State.status, 200, JSON.stringify(v2State.body))
      assert.deepEqual(officialViewOf(v2State.body, 'local').editorState.countryOrder, v2Fixture.editorState.countryOrder)
    })
  } finally {
    process.env = originalEnvironment
    for (const plugin of opened) await plugin.buildEnd().catch(() => {})
    const resolvedBase = path.resolve(base)
    assert.ok(resolvedBase.startsWith(`${temporaryBase}${path.sep}`), 'Cleanup must remain inside OS temp')
    assert.ok(path.basename(resolvedBase).startsWith('starmap-local-editor-http-'))
    await rm(resolvedBase, { recursive: true, force: true, maxRetries: 3 })
  }
})


test('closing the plugin cancels a queued store check and refuses late watcher work', async (t) => {
  const { tempPrivateRoot } = await import('./store-mode.fixture.mjs')
  const { root, paths, closeAfter } = await tempPrivateRoot(t, 'starmap-editor-shutdown-')
  const environment = process.env
  const nativeSetTimeout = globalThis.setTimeout
  const nativeClearTimeout = globalThis.clearTimeout
  let plugin, queued, timer, canceled = false, scheduled = 0
  closeAfter({ close: () => plugin?.buildEnd() })
  process.env = { STARMAP_PRIVATE_ROOT: root }
  try {
    const { createEmptyLibrary } = await import('./store-init.mjs')
    const { openStore } = await import('./store-host.mjs')
    const { OFFICIAL_POLICY } = await import('../src/data/store/officialDefinitions.ts')
    const { travelAtlasLocalEditor } = await import('./local-editor-plugin.mjs')
    await createEmptyLibrary(paths)
    plugin = travelAtlasLocalEditor({ profile: 'personal', privateRoot: root })
    const privateModule = { id: plugin.resolveId('virtual:starmap-private-data'), transformResult: { code: 'cached' } }
    const captured = captureMiddleware(plugin, privateModule)
    await moduleOf(plugin)
    // Keep the real handle for clearTimeout, but control delivery of the already-queued callback.
    globalThis.setTimeout = (callback, delay, ...args) => {
      if (delay !== 100) return nativeSetTimeout(callback, delay, ...args)
      scheduled++
      queued = () => callback(...args)
      timer = nativeSetTimeout(callback, 10000, ...args)
      timer.unref()
      return timer
    }
    globalThis.clearTimeout = (value) => {
      if (timer && value === timer) canceled = true
      return nativeClearTimeout(value)
    }
    captured.watcherCallbacks.get('change')(storeFileOf(paths))
    assert.equal(scheduled, 1)
    await plugin.buildEnd()
    assert.equal(canceled, true, 'shutdown cancels its pending debounce')
    queued() // Even a callback whose delivery won the cancellation race must not reopen the store.
    captured.watcherCallbacks.get('change')(storeFileOf(paths))
    await new Promise(setImmediate)
    assert.equal(scheduled, 1, 'a stopped plugin schedules no new checks')
    const handle = openStore(storeFileOf(paths), { privatePaths: paths, policy: OFFICIAL_POLICY, writerSession: false })
    try { assert.equal(handle.meta().revision, 1) } finally { await handle.close() }
  } finally {
    globalThis.setTimeout = nativeSetTimeout
    globalThis.clearTimeout = nativeClearTimeout
    if (timer) nativeClearTimeout(timer)
    await plugin?.buildEnd()
    process.env = environment
  }
})
