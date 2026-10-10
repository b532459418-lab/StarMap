/** Explicit, dev-only, owned neutral repository preview. No personal loader,
 * arbitrary library paths, HTTP writes or writable capabilities are exposed. */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { types } from 'node:util'
import { freezeCopy, utcTimestamp } from '../src/worldgraph/store/schema.ts'
import { bridgeV2, BRIDGE } from '../src/data/canonical/storeBridge.ts'
import { RepositoryError, readRepositoryState } from './world-store-repository.mjs'
import { repositoryStateDigest as digest } from './world-store-repository-v2-contract.mjs'
import { createRepositoryV2 } from './world-store-repository-v2.mjs'
import { createRepositoryMergeStoreHost, previewRepositoryMergeStoreCreation, createRepositoryMergeStore, openRepositoryMergeStore } from './world-store-branch-merge-store.mjs'
import { createRepositoryMergeStoreOperationRequest } from './world-store-branch-merge-store-contract.mjs'
import { createRepositoryMergeHostAuthority } from './world-store-branch-merge-host-authority.mjs'
import { projectRepositoryMergeSavedApp } from './world-store-branch-merge-app-projection.mjs'

export const REPOSITORY_PREVIEW_ID = 'virtual:starmap-repository-preview'
export const PREVIEW_NOTE = 'Synthetic repository preview'
const PRIVATE_ID = 'virtual:starmap-private-data'
const HOST_ID = 'repository-preview-fixture-host'
const fail = code => { throw new RepositoryError(code) }
function optionsOf(value, keys) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('E_PREVIEW_OPTIONS')
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || !keys.includes(key) || !d?.enumerable || !Object.hasOwn(d, 'value')) fail('E_PREVIEW_OPTIONS')
  }
  if (value.unsafeTestPhase !== undefined && typeof value.unsafeTestPhase !== 'function') fail('E_PREVIEW_OPTIONS')
  return value
}
function identity(file) {
  const stat = lstatSync(file, { bigint: true })
  if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n))) fail('E_PREVIEW_OWNERSHIP')
  return [String(stat.dev), String(stat.ino), stat.isDirectory() ? 'directory' : 'file'].join(':')
}

/** The only bootstrap input is a clock value and a trusted unit-test observer.
 * Neutral tracked sample is the only dataset; no environment/path data input.
 * Node-only paths are diagnostic, not browser exports or write capabilities.
 */
export function createRepositoryPreviewFixture(input = {}) {
  const options = optionsOf(input, ['now', 'unsafeTestPhase'])
  const seededAt = options.now ?? new Date().toISOString()
  utcTimestamp(seededAt, '$.now')
  const parent = realpathSync(tmpdir()), labRoot = mkdtempSync(path.join(parent, 'starmap-merge-store-preview-'))
  const storeRoot = path.join(labRoot, 'store'), nativeRoot = path.join(labRoot, 'native')
  const owned = new Map([[labRoot, identity(labRoot)]])
  let authority, disposed = false, cleaned = false, authorityClosed = false, capturing = false, poisoned = false, creating = true, createdAuthorized = false
  const phase = name => {
    const result = options.unsafeTestPhase?.(name, Object.freeze({ labRoot, storeRoot }))
    if (result && typeof result.then === 'function') fail('E_PREVIEW_ASYNC')
    if (poisoned) fail('E_PREVIEW_BUSY')
  }
  function remember(file) { owned.set(file, identity(file)) }
  function verifyOwned() {
    if (path.dirname(labRoot) !== parent || !path.basename(labRoot).startsWith('starmap-merge-store-preview-') || realpathSync(labRoot) !== labRoot) fail('E_PREVIEW_OWNERSHIP')
    for (const [file, initial] of owned) if (identity(file) !== initial) fail('E_PREVIEW_OWNERSHIP')
    // Never recursively remove an unregistered child/replacement/link.
    for (const [file, initial] of owned) if (initial.endsWith(':directory')) {
      for (const name of readdirSync(file)) if (!owned.has(path.join(file, name))) fail('E_PREVIEW_OWNERSHIP')
    }
  }
  function cleanup() {
    if (authority && !authorityClosed) { authority.close(); authorityClosed = true }
    verifyOwned()
    rmSync(labRoot, { recursive: true })
    cleaned = true
  }
  try {
    phase('lab-created')
    const read = name => JSON.parse(readFileSync(new URL(`../src/data/v2-sample/${name}.json`, import.meta.url), 'utf8'))
    const files = { places: read('places'), travel: read('travel-map'), wantToGo: read('want-to-go'), editorState: read('editor-state'), media: read('user-media') }
    let serial = 0
    const document = bridgeV2(files, { now: seededAt,
      allocateId: () => '01970000-0000-7000-8000-' + (++serial).toString(16).padStart(12, '0') })
    const state = readRepositoryState({ format: 'starmap.world-repository', formatVersion: 1, revision: 0,
      world: document.store, identities: document.manifest, proposals: [], retired: [] })
    const archive = { format: 'starmap.world-repository-v2', formatVersion: 2,
      identity: { libraryId: 'synthetic-repository-preview', branchId: 'neutral-root', genesisId: 'neutral-genesis' },
      baseline: { sourceVersion: 1, sourceDigest: digest(state), coverage: 'baselineOnly', state, receipts: [] }, history: [], state }
    mkdirSync(nativeRoot); remember(nativeRoot)
    createRepositoryV2(path.join(nativeRoot, 'world.sqlite'), archive).close(); remember(path.join(nativeRoot, 'world.sqlite'))
    const bootstrapHost = createRepositoryMergeStoreHost({ sandboxRoot: labRoot, hostId: HOST_ID, authorize(info) {
      if (creating && info.kind === 'create') createdAuthorized = true
      return creating
    } })
    if (existsSync(storeRoot)) fail('E_PREVIEW_OWNERSHIP')
    createRepositoryMergeStore(nativeRoot, storeRoot, previewRepositoryMergeStoreCreation(nativeRoot, { host: bootstrapHost }), 'preview-bootstrap', {
      host: bootstrapHost, unsafeTestPhase(name) {
        if (name === 'directory-created') remember(storeRoot)
        if (name === 'files-created') { remember(path.join(storeRoot, 'world.sqlite')); remember(path.join(storeRoot, 'binding.json')) }
      },
    })
    if (!createdAuthorized) fail('E_PREVIEW_OWNERSHIP')
    remember(storeRoot); remember(path.join(storeRoot, 'world.sqlite')); remember(path.join(storeRoot, 'binding.json'))
    const store = openRepositoryMergeStore(storeRoot, { host: bootstrapHost })
    try {
      const saved = store.snapshot(), row = saved.projection.state.world.entries.find(entry => entry.source.sourceId === BRIDGE.wish)
      if (!row) fail('E_PREVIEW_SAMPLE')
      const request = createRepositoryMergeStoreOperationRequest({ id: 'preview-note', expectedRevision: saved.projection.state.revision,
        action: { kind: 'commands', commands: [{ op: 'update', table: 'entries', id: row.id, expectedRevision: row.revision,
          value: { ...row, revision: row.revision + 1, fields: { ...row.fields, note: PREVIEW_NOTE } } }] } }, saved)
      if (store.apply(request).status !== 'committed') fail('E_PREVIEW_SAMPLE')
    } finally { store.close() }
    creating = false // The bootstrap host is permanently denied from this point.
    authority = createRepositoryMergeHostAuthority({ sandboxRoot: labRoot, hostId: HOST_ID })
    verifyOwned(); phase('seeded')
  } catch (error) {
    creating = false
    try { cleanup() } catch (cleanupError) {
      const reported = new RepositoryError(cleanupError.code ?? 'E_PREVIEW_OWNERSHIP')
      reported.cause = error; throw reported
    }
    throw error
  }
  return Object.freeze({ labRoot, storeRoot,
    capture() {
      if (disposed) fail('E_PREVIEW_CLOSED')
      if (capturing) { poisoned = true; fail('E_PREVIEW_BUSY') }
      capturing = true; poisoned = false
      let session
      try {
        verifyOwned()
        session = authority.startSession()
        const selection = authority.select(session, storeRoot), before = authority.snapshot(session)
        if (before.savedDigest !== selection.savedDigest) fail('E_PREVIEW_CHANGED')
        phase('snapshot-captured')
        const now = new Date().toISOString(), projection = projectRepositoryMergeSavedApp(before, { now })
        phase('projection-computed'); verifyOwned()
        if (authority.snapshot(session).savedDigest !== before.savedDigest) fail('E_PREVIEW_CHANGED')
        phase('before-emit'); verifyOwned()
        if (authority.snapshot(session).savedDigest !== before.savedDigest) fail('E_PREVIEW_CHANGED')
        return freezeCopy({ format: 'starmap.repository-readonly-preview', formatVersion: 1, readOnly: true, synthetic: true,
          canonical: projection.canonical, now, identity: projection.identity, savedDigest: projection.savedDigest,
          stateDigest: projection.stateDigest, projectionEnvelopeDigest: projection.projectionEnvelopeDigest })
      } finally {
        try { if (session) authority.revoke(session) } finally { capturing = false; poisoned = false }
      }
    },
    dispose() {
      if (capturing) { poisoned = true; fail('E_PREVIEW_BUSY') }
      if (cleaned) return
      disposed = true; cleanup()
    },
  })
}

/** One dev server owns one fixture. Other modes only expose a null preview;
 * they never bootstrap/read a lab. The only middleware invalidates readonly
 * virtual GET transforms; no mutation API is mounted.
 */
export function repositoryPreviewPlugin(input) {
  const options = optionsOf(input, ['mode', 'command', 'unsafeTestPhase'])
  if (typeof options.mode !== 'string' || !['serve', 'build'].includes(options.command)) fail('E_PREVIEW_MODE')
  const enabled = options.mode === 'repository-preview'
  if (enabled && options.command !== 'serve') fail('E_PREVIEW_BUILD')
  let fixture, failed = false, closed = false
  const start = () => {
    if (failed || closed) fail('E_PREVIEW_FAILED')
    return fixture ??= createRepositoryPreviewFixture({ ...(options.unsafeTestPhase ? { unsafeTestPhase: options.unsafeTestPhase } : {}) })
  }
  const dispose = () => { if (fixture) { fixture.dispose(); fixture = undefined } }
  const close = () => { closed = true; dispose() }
  const reject = error => {
    failed = true
    try { dispose() } catch (cleanupError) { cleanupError.cause = error; throw cleanupError }
    throw error
  }
  const source = value => 'export const repositoryPreview = ' + JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') + ';'
  return {
    name: 'starmap-repository-readonly-preview',
    configResolved(config) { if (config.mode !== options.mode || config.command !== options.command) fail('E_PREVIEW_MODE') },
    resolveId(id) { if (id === REPOSITORY_PREVIEW_ID || enabled && id === PRIVATE_ID) return '\0' + id },
    load(id) {
      if (enabled && id === '\0' + PRIVATE_ID) return 'export const privateV2Files = undefined; export const privateLegacyUnmigrated = false;'
      if (id !== '\0' + REPOSITORY_PREVIEW_ID) return null
      if (!enabled) return source(null)
      try { return source(start().capture()) } catch (error) { return reject(error) }
    },
    configureServer(server) {
      if (!enabled) return
      try { start() } catch (error) { reject(error) }
      server.middlewares.use((request, response, next) => {
        let pathname
        try { pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname) } catch { next(); return }
        if (request.method === 'GET' && pathname === '/@id/__x00__' + REPOSITORY_PREVIEW_ID) {
          const module = server.moduleGraph.getModuleById('\0' + REPOSITORY_PREVIEW_ID)
          if (module) server.moduleGraph.invalidateModule(module)
          response.setHeader('Cache-Control', 'no-store')
        }
        next()
      })
      server.httpServer?.once('close', close)
    },
    buildEnd(error) { if (error) { failed = true; dispose() } },
    closeBundle: close,
  }
}
