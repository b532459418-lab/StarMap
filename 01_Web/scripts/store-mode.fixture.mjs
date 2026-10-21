/**
 * Test helpers for the new-library mode (3C-3): temporary private roots under the OS temp directory with V2 files
 * written into `data/v2/`. Only tracked neutral data: the public sample (src/data/v2-sample/) and the 3C-1b edge-case
 * fixture (src/data/store/v2Store.fixture.ts). Not a test file itself; not imported by the App.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { sha256File } from './file-hash.mjs'
import { getPrivatePaths, V2_PRIVATE_FILE_KEYS } from './private-profile.mjs'
import { rawConnection } from './store-sqlite.mjs'
import { readV2SampleFiles } from './v2-sample.mjs'
import { edgeCaseFixture } from '../src/data/store/v2Store.fixture.ts'
import { servedModuleOf } from './private-read-model.fixture.mjs'

/**
 * A temporary directory `<tmp>/<prefix>…` holding `private/` (the private root), removed after the test. `closeAfter`
 * registers a store handle or session to close first (Windows cannot delete a file SQLite holds open).
 */
export async function tempPrivateRoot(t, prefix = 'starmap-store-mode-') {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix))
  const closers = []
  t.after(async () => {
    for (const closable of closers.reverse()) await closable.close()
    assert.equal(path.dirname(directory), os.tmpdir())
    assert.ok(path.basename(directory).startsWith(prefix))
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  })
  const root = path.join(directory, 'private')
  await mkdir(root)
  return { directory, root, paths: getPrivatePaths({ STARMAP_PRIVATE_ROOT: root }), closeAfter: (closable) => { closers.push(closable); return closable } }
}

/** Write V2 file values into `data/v2/` (keys that are undefined are left out), as the V2 editor writes them. */
export async function writeV2Files(paths, files) {
  await mkdir(paths.v2DataRoot, { recursive: true })
  for (const key of V2_PRIVATE_FILE_KEYS) {
    if (files[key] !== undefined) await writeFile(paths.v2FilePaths[key], `${JSON.stringify(files[key], null, 2)}\n`)
  }
}

/** The public sample's five V2 files (fresh copy). */
export const sampleV2Files = () => readV2SampleFiles()
/** The 3C-1b edge cases (hidden items, unresolved list elements, kept titles, …) as five V2 files (fresh copy). */
export const edgeV2Files = () => edgeCaseFixture()

/** SHA-256 of every file under `root`, by relative path (directories implied). */
export async function treeDigest(root) {
  const files = {}
  async function walk(directory) {
    let items
    try { items = await readdir(directory, { withFileTypes: true }) } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    for (const item of items) {
      const target = path.join(directory, item.name)
      if (item.isDirectory()) await walk(target)
      else files[path.relative(root, target).split(path.sep).join('/')] = await sha256File(target)
    }
  }
  await walk(root)
  return files
}

/**
 * Turn a store file of format 2 back into format 1 (3C-3 to 3C-4b, before the media registry), exactly as that version
 * created it: the registry's tables and indexes dropped, user_version and store_meta.format_version 1. For the
 * store:upgrade tests; the store must be closed. Raw SQL below the host, tests only.
 */
export function downgradeStoreToFormat1(file) {
  const db = rawConnection(file)
  try {
    db.exec('BEGIN IMMEDIATE')
    for (const table of ['media_scan_cache', 'media_sources', 'media_asset_files', 'media_files']) db.exec(`DROP TABLE ${table}`)
    db.exec('PRAGMA user_version = 1')
    db.exec('UPDATE store_meta SET format_version = 1')
    db.exec('COMMIT')
  } finally { db.close() }
}

/** Lines collected from a tool's `log` / `logError`. */
export const quietly = () => {
  const lines = []
  return { lines, log: (line) => lines.push(String(line)), logError: (line) => lines.push(String(line)) }
}

// ---------------------------------------------------------------------------
// The local editor plugin without a server (the harness of local-editor-plugin.test.mjs)
// ---------------------------------------------------------------------------

export const editorPrefix = '/__travelatlas/editor/'
export const authorizedHeaders = { 'x-travelatlas-local-editor': '1', origin: 'http://127.0.0.1:5173', host: '127.0.0.1:5173' }

export function captureMiddleware(plugin, privateModule) {
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

export async function requestTo(handler, { url, method = 'POST', headers = authorizedHeaders, content = Buffer.from('{}') }) {
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

/** The served private-data module, with the read model its endpoint answers (./private-read-model.fixture.mjs). */
export const moduleOf = (plugin) => servedModuleOf(plugin)
