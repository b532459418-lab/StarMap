import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

const editorPrefix = '/__travelatlas/editor/'
const authorizedHeaders = {
  'x-travelatlas-local-editor': '1',
  origin: 'http://127.0.0.1:5173',
}

function captureMiddleware(plugin) {
  const handlers = []
  const watched = []
  const watcherCallbacks = new Map()
  const reloads = []
  const invalidations = []
  plugin.configureServer({
    middlewares: { use: (handler) => handlers.push(handler) },
    watcher: {
      add: (target) => watched.push(target),
      on: (event, callback) => watcherCallbacks.set(event, callback),
    },
    moduleGraph: {
      getModuleById: () => undefined,
      invalidateModule: (module) => invalidations.push(module),
    },
    ws: { send: (message) => reloads.push(message) },
  })
  return { handlers, watched, watcherCallbacks, reloads, invalidations }
}

async function requestTo(handler, {
  url,
  method = 'POST',
  headers = authorizedHeaders,
  address = '127.0.0.1',
  content = Buffer.from('{}'),
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
    end: (body = '') => { responseText += body; endings += 1 },
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

// The plugin keeps paths/cache at module scope. One isolated fixture and awaited
// subtests deliberately avoid concurrent plugin factories and any real server.
test('Local editor middleware preserves authorization, error codes and private files', async (t) => {
  const temporaryBase = path.resolve(tmpdir())
  const root = await mkdtemp(path.join(temporaryBase, 'starmap-local-editor-http-'))
  const originalEnvironment = process.env
  // Import-time path/proxy initialization sees only our synthetic environment.
  // Preserve the environment object itself without reading any real values.
  process.env = { STARMAP_PRIVATE_ROOT: root }
  try {
    const { travelAtlasLocalEditor } = await import('./local-editor-plugin.mjs')

    await t.test('Public profile registers no editor middleware or private watcher', () => {
      const captured = captureMiddleware(travelAtlasLocalEditor({ profile: 'public', privateRoot: root }))
      assert.deepEqual(captured.handlers, [])
      assert.deepEqual(captured.watched, [])
      assert.equal(captured.watcherCallbacks.size, 0)
    })

    const captured = captureMiddleware(travelAtlasLocalEditor({ profile: 'personal', privateRoot: root }))
    assert.equal(captured.handlers.length, 1)
    assert.deepEqual(captured.watched, [path.join(root, 'data')])
    const handler = captured.handlers[0]

    await t.test('Three catalog/state GET endpoints reject remote reads before handling input', async () => {
      for (const route of ['state', 'catalog/countries', 'catalog/cities']) {
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

    await t.test('Writes reject address, missing header and disallowed Origin before malformed JSON', async () => {
      for (const overrides of [
        { address: '203.0.113.10' },
        { headers: { origin: authorizedHeaders.origin } },
        { headers: { ...authorizedHeaders, origin: 'https://127.0.0.1:5173' } },
        { headers: { ...authorizedHeaders, origin: 'http://example.com' } },
        { headers: { ...authorizedHeaders, origin: 'not a URL' } },
      ]) {
        const result = await requestTo(handler, {
          url: editorPrefix + 'records', content: Buffer.from('{'), ...overrides,
        })
        assertError(result, 403, 'E_EDITOR_WRITE_FORBIDDEN')
        assert.equal(result.bodyReads, 0)
      }
    })

    await t.test('Empty state GET succeeds without creating private data', async () => {
      const result = await requestTo(handler, { url: editorPrefix + 'state', method: 'GET', headers: {} })
      assert.equal(result.status, 200)
      assert.equal(result.body.ok, true)
      assert.equal(typeof result.body.state, 'object')
      assert.equal(result.bodyReads, 0)
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
      for (const route of ['records', 'import', 'media/delete']) {
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
      assert.deepEqual(await readdir(root), [])
    })

    await t.test('Authorization precedes legacy refusal; legacy refusal precedes JSON and writes', async () => {
      const dataRoot = path.join(root, 'data')
      const legacyPath = path.join(dataRoot, 'travel-map.local.json')
      const sentinel = 'Synthetic legacy sentinel, deliberately not JSON.\n'
      await mkdir(dataRoot)
      await writeFile(legacyPath, sentinel)
      const forbidden = await requestTo(handler, {
        url: editorPrefix + 'records', content: Buffer.from('{'), headers: {},
      })
      assertError(forbidden, 403, 'E_EDITOR_WRITE_FORBIDDEN')
      assert.equal(forbidden.bodyReads, 0)
      for (const route of ['records', 'import', 'media/delete', 'unknown']) {
        const result = await requestTo(handler, { url: editorPrefix + route, content: Buffer.from('{') })
        assertError(result, 409, 'E_LEGACY_UNMIGRATED', { legacyFiles: ['travel-map.local.json'] })
        assert.equal(result.bodyReads, 0)
      }
      assert.deepEqual(await readdir(root), ['data'])
      assert.deepEqual(await readdir(dataRoot), ['travel-map.local.json'])
      assert.equal(await readFile(legacyPath, 'utf8'), sentinel)
    })

    assert.deepEqual(captured.reloads, [])
    assert.deepEqual(captured.invalidations, [])
  } finally {
    process.env = originalEnvironment
    const resolvedRoot = path.resolve(root)
    assert.ok(resolvedRoot.startsWith(`${temporaryBase}${path.sep}`), 'Cleanup must remain inside OS temp')
    assert.ok(path.basename(resolvedRoot).startsWith('starmap-local-editor-http-'))
    await rm(resolvedRoot, { recursive: true, force: true })
  }
})
