/** Only owned neutral labs. No personal data or service is opened by these tests. */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync, lstatSync, realpathSync, writeFileSync, unlinkSync, renameSync, linkSync,
  mkdirSync, rmdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { repositoryStateDigest as digest } from './world-store-repository-v2-contract.mjs'
import { createRepositoryMergeSavedArchive, appendRepositoryMergeSavedEvent } from './world-store-branch-merge-store-contract.mjs'
import { projectRepositoryMergeSavedApp } from './world-store-branch-merge-app-projection.mjs'
import { createRepositoryPreviewFixture, repositoryPreviewPlugin, REPOSITORY_PREVIEW_ID, PREVIEW_NOTE } from './repository-preview-plugin.mjs'

const previewId = '\0' + REPOSITORY_PREVIEW_ID, privateId = '\0virtual:starmap-private-data'
let fixture, observer
before(() => { fixture = createRepositoryPreviewFixture({ now: '2026-10-05T00:00:00.000Z', unsafeTestPhase: (name, roots) => observer?.(name, roots) }) })
after(() => { observer = undefined; fixture?.dispose() })
const labs = () => readdirSync(realpathSync(tmpdir())).filter(name => name.startsWith('starmap-merge-store-preview-')).sort()
const bytes = () => readFileSync(path.join(fixture.storeRoot, 'world.sqlite'))
const rejects = action => assert.throws(action, error => typeof error.code === 'string' && error.code.startsWith('E_'))
function payload(source) {
  assert.match(source, /^export const repositoryPreview = /)
  return JSON.parse(source.slice('export const repositoryPreview = '.length, -1))
}

test('normal modes expose a null preview without creating a lab or private module', () => {
  const original = labs()
  for (const mode of ['public', 'personal', 'development']) {
    for (const command of ['serve', 'build']) {
      const plugin = repositoryPreviewPlugin({ mode, command })
      assert.equal(plugin.resolveId(REPOSITORY_PREVIEW_ID), previewId)
      assert.equal(payload(plugin.load(previewId)), null)
      assert.equal(plugin.resolveId('virtual:starmap-private-data'), undefined)
      assert.equal(plugin.load(privateId), null)
      plugin.configureServer({ middlewares: { use() { assert.fail('Disabled preview installed middleware') } } })
      plugin.closeBundle()
    }
  }
  assert.deepEqual(labs(), original)
})
test('preview builds are rejected before allocating a fixture', () => {
  const original = labs()
  assert.throws(() => repositoryPreviewPlugin({ mode: 'repository-preview', command: 'build' }), { code: 'E_PREVIEW_BUILD' })
  assert.deepEqual(labs(), original)
})
test('configuration disagreement is rejected rather than enabling another profile', () => {
  const plugin = repositoryPreviewPlugin({ mode: 'public', command: 'serve' })
  assert.throws(() => plugin.configResolved({ mode: 'repository-preview', command: 'serve' }), { code: 'E_PREVIEW_MODE' })
  assert.throws(() => plugin.configResolved({ mode: 'public', command: 'build' }), { code: 'E_PREVIEW_MODE' })
  plugin.configResolved({ mode: 'public', command: 'serve' })
})
test('arbitrary fixture paths and datasets are not accepted', () => {
  for (const value of [{ sandboxRoot: tmpdir() }, { storeRoot: fixture.storeRoot }, { files: {} }, { data: {} }, { unsafeTestPhase: true }]) rejects(() => createRepositoryPreviewFixture(value))
})
test('accessors, prototypes, proxies and symbol option keys cannot supply a path or observer', () => {
  let invoked = false
  for (const value of [Object.create({ now: '2026-10-05T00:00:00.000Z' }), new Proxy({}, {}),
    { get now() { invoked = true; return '2026-10-05T00:00:00.000Z' } }, { [Symbol('path')]: tmpdir() }]) rejects(() => createRepositoryPreviewFixture(value))
  assert.equal(invoked, false)
})
test('invalid seed clocks fail before allocating any lab', () => {
  const original = labs()
  for (const now of ['', 'invalid', '2026-10-05', '2026-10-05T00:00:00+00:00']) rejects(() => createRepositoryPreviewFixture({ now }))
  assert.deepEqual(labs(), original)
})
test('fixture is an owned canonical tmpdir child with an actual initialized SQLite Store', () => {
  assert.equal(path.dirname(fixture.labRoot), realpathSync(tmpdir()))
  assert.match(path.basename(fixture.labRoot), /^starmap-merge-store-preview-/)
  assert.equal(realpathSync(fixture.storeRoot), fixture.storeRoot)
  assert.equal(lstatSync(fixture.labRoot).isSymbolicLink(), false)
  const db = new DatabaseSync(path.join(fixture.storeRoot, 'world.sqlite'), { readOnly: true })
  try {
    assert.equal(db.prepare('PRAGMA application_id').get().application_id, 0x534d4737)
    assert.equal(db.prepare('SELECT count(*) n FROM local_receipts').get().n, 1)
    assert.equal(db.prepare('SELECT operation_id FROM local_receipts').get().operation_id, 'preview-note')
  } finally { db.close() }
})
test('capture emits Canonical and complete consistency provenance', () => {
  const value = fixture.capture()
  assert.equal(value.format, 'starmap.repository-readonly-preview')
  assert.equal(value.formatVersion, 1)
  assert.equal(value.readOnly, true); assert.equal(value.synthetic, true)
  for (const key of ['savedDigest', 'stateDigest', 'projectionEnvelopeDigest']) assert.match(value[key], /^[a-f0-9]{64}$/)
  assert.equal(value.canonical.travel.records.length, 5)
  assert.equal(value.canonical.wantToGo.items.length, 3)
  assert.equal(value.canonical.wantToGo.items.filter(item => item.note === PREVIEW_NOTE).length, 1)
})
test('capture matches the actual physical Saved and recomputed projector', () => {
  const value = fixture.capture()
  const db = new DatabaseSync(path.join(fixture.storeRoot, 'world.sqlite'), { readOnly: true })
  try {
    const metadata = JSON.parse(db.prepare('SELECT payload FROM store_metadata').get().payload)
    const events = db.prepare('SELECT payload FROM store_events ORDER BY repository_revision').all().map(row => JSON.parse(row.payload))
    let saved = createRepositoryMergeSavedArchive(metadata.baseArchive)
    for (const event of events) saved = appendRepositoryMergeSavedEvent(saved, event.storeRequest, event.receipt)
    assert.equal(saved.savedDigest, value.savedDigest)
    const projected = projectRepositoryMergeSavedApp(saved, { now: value.now })
    assert.deepEqual(value.canonical, projected.canonical)
    assert.equal(value.stateDigest, digest(saved.projection.state))
    assert.equal(value.projectionEnvelopeDigest, projected.projectionEnvelopeDigest)
  } finally { db.close() }
})
test('readonly recapture leaves physical bytes, receipts and facts unchanged', () => {
  const original = bytes(), first = fixture.capture(), second = fixture.capture()
  assert.deepEqual(bytes(), original)
  assert.equal(first.savedDigest, second.savedDigest)
  assert.equal(first.stateDigest, second.stateDigest)
  assert.deepEqual(first.identity, second.identity)
  assert.deepEqual(first.canonical, second.canonical)
})
test('payload is deeply frozen and exposes no writable handle, path or host', () => {
  const value = fixture.capture()
  assert.equal(Object.isFrozen(value), true); assert.equal(Object.isFrozen(value.canonical.wantToGo.items), true)
  assert.throws(() => { value.canonical.wantToGo.items[0].note = 'write' }, TypeError)
  assert.deepEqual(Object.keys(fixture).sort(), ['capture', 'dispose', 'labRoot', 'storeRoot'])
  assert.doesNotMatch(JSON.stringify(value), /starmap-merge-store-|sqlite|labRoot|storeRoot|authorize|sessionId/)
})
test('unsupported virtual module requests do not bootstrap another fixture', () => {
  const original = labs(), plugin = repositoryPreviewPlugin({ mode: 'repository-preview', command: 'serve' })
  assert.equal(plugin.resolveId('/tmp/arbitrary.sqlite'), undefined)
  assert.equal(plugin.load('/tmp/arbitrary.sqlite'), null)
  assert.equal(plugin.load(previewId + '?path=' + fixture.storeRoot), null)
  assert.deepEqual(labs(), original); plugin.closeBundle()
})
test('private virtual data is a constant empty stub and never triggers fixture bootstrap', () => {
  const original = labs(), plugin = repositoryPreviewPlugin({ mode: 'repository-preview', command: 'serve' })
  assert.equal(plugin.resolveId('virtual:starmap-private-data'), privateId)
  assert.equal(plugin.load(privateId), 'export const privateV2Files = undefined; export const privateLegacyUnmigrated = false;')
  assert.deepEqual(labs(), original); plugin.closeBundle()
})
test('physical database replacement is refused without sample fallback', () => {
  const database = path.join(fixture.storeRoot, 'world.sqlite'), parked = path.join(fixture.labRoot, 'parked.sqlite')
  renameSync(database, parked); writeFileSync(database, readFileSync(parked))
  try { assert.throws(() => fixture.capture(), { code: 'E_PREVIEW_OWNERSHIP' }) }
  finally { unlinkSync(database); renameSync(parked, database) }
})
test('corrupt binding bytes on the original inode refuse capture', () => {
  const target = path.join(fixture.storeRoot, 'binding.json'), original = readFileSync(target)
  writeFileSync(target, '{}')
  try { rejects(() => fixture.capture()) } finally { writeFileSync(target, original) }
})
test('unregistered store members refuse capture and are never recursively deleted', () => {
  const target = path.join(fixture.storeRoot, 'unexpected.txt')
  writeFileSync(target, 'owned unit probe')
  try { assert.throws(() => fixture.capture(), { code: 'E_PREVIEW_OWNERSHIP' }); assert.equal(readFileSync(target, 'utf8'), 'owned unit probe') }
  finally { unlinkSync(target) }
})
test('hard-linked database cannot satisfy physical capture ownership', () => {
  const target = path.join(fixture.labRoot, 'database-link.sqlite')
  linkSync(path.join(fixture.storeRoot, 'world.sqlite'), target)
  try { assert.throws(() => fixture.capture(), { code: 'E_PREVIEW_OWNERSHIP' }) } finally { unlinkSync(target) }
})
test('in-capture file changes fail at the second physical boundary', () => {
  const target = path.join(fixture.storeRoot, 'binding.json'), original = readFileSync(target)
  observer = name => { if (name === 'snapshot-captured') writeFileSync(target, '{}') }
  try { rejects(() => fixture.capture()) } finally { observer = undefined; writeFileSync(target, original) }
})
test('a swallowed recursive capture still poisons the outer capture', () => {
  observer = name => { if (name === 'snapshot-captured') assert.throws(() => fixture.capture(), { code: 'E_PREVIEW_BUSY' }) }
  try { assert.throws(() => fixture.capture(), { code: 'E_PREVIEW_BUSY' }) } finally { observer = undefined }
  assert.equal(fixture.capture().readOnly, true)
})
test('a swallowed in-capture disposal cannot close or emit the outer capture', () => {
  observer = name => { if (name === 'projection-computed') assert.throws(() => fixture.dispose(), { code: 'E_PREVIEW_BUSY' }) }
  try { assert.throws(() => fixture.capture(), { code: 'E_PREVIEW_BUSY' }) } finally { observer = undefined }
  assert.equal(fixture.capture().readOnly, true)
})
test('asynchronous test observers are rejected instead of racing snapshot validation', () => {
  observer = name => name === 'snapshot-captured' ? Promise.resolve() : undefined
  try { assert.throws(() => fixture.capture(), { code: 'E_PREVIEW_ASYNC' }) } finally { observer = undefined }
})
test('trusted observer errors preserve failure instead of returning sample data', () => {
  const failure = new Error('neutral capture failure')
  observer = name => { if (name === 'before-emit') throw failure }
  try { assert.throws(() => fixture.capture(), error => error === failure) } finally { observer = undefined }
})
test('plugin GET middleware refreshes only the readonly virtual module; POST mounts no write route', () => {
  const plugin = repositoryPreviewPlugin({ mode: 'repository-preview', command: 'serve' }), handlers = [], invalidations = [], httpServer = new EventEmitter()
  const module = { id: previewId }, server = { httpServer, middlewares: { use(handler) { handlers.push(handler) } }, moduleGraph: {
    getModuleById(id) { return id === previewId ? module : undefined }, invalidateModule(value) { invalidations.push(value) },
  } }
  try {
    plugin.configureServer(server); assert.equal(handlers.length, 1)
    let calls = 0; const headers = {}
    for (const method of ['POST', 'DELETE', 'PUT']) handlers[0]({ method, url: '/__travelatlas/editor/wanttogo' }, { setHeader() { assert.fail('Write request handled') } }, () => calls++)
    assert.equal(calls, 3); assert.equal(invalidations.length, 0)
    handlers[0]({ method: 'GET', url: '/@id/__x00__' + REPOSITORY_PREVIEW_ID }, { setHeader(key, value) { headers[key] = value } }, () => calls++)
    assert.deepEqual(headers, { 'Cache-Control': 'no-store' }); assert.deepEqual(invalidations, [module])
    assert.equal(payload(plugin.load(previewId)).readOnly, true)
  } finally { httpServer.emit('close'); plugin.closeBundle() }
})
test('successful disposal removes only the owned lab and permanently rejects capture', () => {
  const owned = createRepositoryPreviewFixture(), location = owned.labRoot
  assert.equal(existsSync(location), true)
  owned.dispose(); owned.dispose()
  assert.equal(existsSync(location), false)
  assert.throws(() => owned.capture(), { code: 'E_PREVIEW_CLOSED' })
  assert.equal(existsSync(fixture.labRoot), true)
})
test('plugin capture failure stays terminal and cannot create a replacement library on later GET', () => {
  const original = labs(), failure = new Error('synthetic terminal preview failure')
  let calls = 0
  const plugin = repositoryPreviewPlugin({ mode: 'repository-preview', command: 'serve', unsafeTestPhase(name) {
    if (name === 'lab-created') calls++
    if (name === 'before-emit') throw failure
  } })
  try {
    assert.throws(() => plugin.load(previewId), error => error === failure)
    rejects(() => plugin.load(previewId))
    assert.equal(calls, 1)
    assert.deepEqual(labs(), original)
  } finally { plugin.closeBundle() }
})
test('cleanup refuses a replaced lab root and preserves outsider bytes until the original is restored', () => {
  const owned = createRepositoryPreviewFixture(), location = owned.labRoot, parked = location + '-parked'
  renameSync(location, parked); mkdirSync(location)
  const outside = path.join(location, 'outside.txt'); writeFileSync(outside, 'keep outsider')
  try {
    assert.throws(() => owned.dispose(), { code: 'E_PREVIEW_OWNERSHIP' })
    assert.equal(readFileSync(outside, 'utf8'), 'keep outsider')
    assert.equal(existsSync(path.join(parked, 'store', 'world.sqlite')), true)
  } finally {
    unlinkSync(outside); rmdirSync(location); renameSync(parked, location); owned.dispose()
  }
  assert.equal(existsSync(location), false)
})
test('cleanup refuses a directory junction and never deletes its outside target', () => {
  const owned = createRepositoryPreviewFixture(), parked = path.join(owned.labRoot, 'parked-store')
  const outsider = mkdtempSync(path.join(realpathSync(tmpdir()), 'starmap-preview-outsider-'))
  const outside = path.join(outsider, 'keep.txt'); writeFileSync(outside, 'outside target')
  const original = lstatSync(outsider, { bigint: true })
  renameSync(owned.storeRoot, parked); symlinkSync(outsider, owned.storeRoot, process.platform === 'win32' ? 'junction' : 'dir')
  try {
    assert.throws(() => owned.dispose(), { code: 'E_PREVIEW_OWNERSHIP' })
    assert.equal(readFileSync(outside, 'utf8'), 'outside target')
  } finally {
    unlinkSync(owned.storeRoot); renameSync(parked, owned.storeRoot); owned.dispose()
    const current = lstatSync(outsider, { bigint: true })
    assert.equal(current.isSymbolicLink(), false)
    assert.equal(current.ino, original.ino); assert.equal(current.dev, original.dev)
    assert.equal(path.dirname(realpathSync(outsider)), realpathSync(tmpdir()))
    unlinkSync(outside); rmdirSync(outsider)
  }
})
test('source boundaries contain no private path discovery or old editor plugin import', () => {
  const source = readFileSync(new URL('./repository-preview-plugin.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /getPrivatePaths|configurePrivatePaths|local-editor-plugin|STARMAP_PRIVATE_ROOT|process\.env/)
  const config = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8')
  assert.match(config, /envDir:\s*false/); assert.match(config, /envPrefix:\s*\[\]/)
})
