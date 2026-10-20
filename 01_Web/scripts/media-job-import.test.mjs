/**
 * RD-07 batch-two acceptance. Owned synthetic libraries and generated JPEG bytes only.
 *
 * 3C-4d: media tasks run in the new library only. Each root's synthetic places are migrated into a store, and the
 * handlers get `storeMedia` from a store session as the plugin passes it; operation ids are UUIDv7 (the store's request
 * ids). Cases about what only the V2 import wrote (the catalog, the source index, content ids, the V2 files in a receipt)
 * are removed; the store's import and receipt are covered by store-media-jobs.test.mjs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import sharp from 'sharp'
import { getPrivatePaths } from './private-profile.mjs'
import { atomicJsonWrite, readJson } from './json-file.mjs'
import { safeSegment, reserveDestination } from './local-editor-upload.mjs'
import { withLibraryOperation } from './library-operation-lock.mjs'
import * as service from './media-job-service.mjs'
import { assertMediaJobRecord, largestCompletedMediaJobRecord, mediaJobReceiptSeal } from './media-job-store.mjs'
import { prepareV2Upload } from './v2-media-store.mjs'
import { createStoreSession } from './store-session.mjs'
import { applyMigration } from './store-migrate.mjs'
import { sequentialUuids } from '../src/data/canonical/v2.fixture.ts'
import { uuidv7 } from '../src/data/canonical/uuidv7.ts'
import { placeFolderSuffix } from '../src/data/v2media/editorWrites.ts'

const newId = sequentialUuids(Date.UTC(2026, 9, 4))
const ID = { country: newId(), city: newId(), otherCity: newId() }
const base = '/__travelatlas/editor/media/jobs'
const execute = promisify(execFile)
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const jpeg = (color = { r: 42, g: 92, b: 140 }) => sharp({ create: { width: 64, height: 48, channels: 3, background: color } }).jpeg().toBuffer()
const places = () => ({ schema_version: 1, generated_at: '2026-10-04T00:00:00.000Z', places: [
  { id: ID.country, subtype: 'country', names: { 'zh-Hans': '测试国', en: 'Test Country' }, externalIds: { iso3166Alpha2: 'IS' }, location: { lat: 65, lng: -18 } },
  { id: ID.city, subtype: 'city', names: { 'zh-Hans': '测试城', en: 'Test City' }, partOf: ID.country, location: { lat: 64, lng: -21 } },
  { id: ID.otherCity, subtype: 'city', names: { 'zh-Hans': '另一城', en: 'Other City' }, partOf: ID.country, location: { lat: 63, lng: -19 } },
] })
const dependencies = () => ({ safeSegment, reserveDestination, prepareV2Upload,
  updateDroneSidecar: async (cityRoot, destination, metadata, imageMetadata) => {
    const target = path.join(cityRoot, 'media.json'), sidecar = await readJson(target, {})
    sidecar[`drone/${path.basename(destination)}`] = { ...metadata, resolution: `${imageMetadata.width} × ${imageMetadata.height}` }
    await atomicJsonWrite(target, sidecar)
  },
})
async function withRoot(run, { registry = places() } = {}) {
  const prefix = 'starmap-rd07-import-acceptance-'
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  const paths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: path.join(directory, 'private') })
  await mkdir(paths.v2DataRoot, { recursive: true })
  await writeFile(paths.v2FilePaths.places, `${JSON.stringify(registry, null, 2)}\n`)
  // 3C-4d: the places migrated into a new library; the handlers read and import through a session, as the plugin does.
  await applyMigration(paths, { now: '2026-10-04T00:00:00.000Z' })
  const session = createStoreSession(paths, { log: () => {} })
  try { await run({ paths, deps: dependencies(), session, storeMedia: { mediaStore: await session.mediaStore() } }) } finally {
    await session.close()
    assert.equal(path.dirname(directory), path.resolve(tmpdir()))
    assert.ok(path.basename(directory).startsWith(prefix))
    await rm(directory, { recursive: true, force: true })
  }
}
async function tree(root, { omitCoordination = false } = {}) {
  const records = {}
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name), relative = path.relative(root, full).split(path.sep).join('/')
      if (omitCoordination && /^operations\/library-operation(?:-state\.json|\.lock)/.test(relative)) continue
      if (entry.isDirectory()) await walk(full)
      else { const value = await stat(full); records[relative] = { sha: sha(await readFile(full)), bytes: value.size, mtime: value.mtimeMs } }
    }
  }
  await walk(root)
  return records
}
const route = (action, job) => service.mediaJobRoute('POST', job ? `${base}/${job.jobId}/${action}` : base)
const write = (env, action, job, input, extra = {}) => withLibraryOperation(env.paths, leaseToken => service.handleMediaJobWrite({ privatePaths: env.paths, deps: env.deps, route: route(action, job), input, ...extra, leaseToken, storeMedia: env.storeMedia }))
const get = (env, job) => service.handleMediaJobRead({ privatePaths: env.paths, route: service.mediaJobRoute('GET', `${base}/${job.jobId}`), storeMedia: env.storeMedia })
const catalogOf = async (env) => (await env.storeMedia.mediaStore.view()).files.media
const selection = (job) => job.files.filter(file => file.phase === 'received').map(file => file.fileId)
const identity = (job) => ({ libraryId: job.libraryId, revision: job.revision })
const preview = (env, job, selectedFileIds = selection(job), override = {}) => service.handleMediaJobPreview({ privatePaths: env.paths, route: route('preview', job), input: { ...identity(job), selectedFileIds, ...override }, storeMedia: env.storeMedia })
const importInput = (job, plan, operationId = uuidv7()) => ({ ...identity(job), selectedFileIds: selection(job), operationId, planDigest: plan.digest })
const jobPath = (env, job) => path.join(env.paths.root, 'operations/media-import/v1/jobs', `${job.jobId}.json`)
async function receive(env, job, bytes, fileId = job.files[0].fileId) {
  const request = Readable.from([bytes]); request.headers = { 'content-length': String(bytes.length) }
  const url = new URL(`${base}/${job.jobId}/files/${fileId}?${new URLSearchParams({ ...identity(job), operationId: randomUUID(), sha256: sha(bytes) })}`, 'http://127.0.0.1')
  const result = await withLibraryOperation(env.paths, leaseToken => service.handleMediaJobWrite({ privatePaths: env.paths, deps: env.deps, route: service.mediaJobRoute('POST', url.pathname), request, url, leaseToken, storeMedia: env.storeMedia }))
  assert.equal(result.status, 201, JSON.stringify(result))
  return result.body.job
}
async function create(env, bytes, options = {}) {
  const result = await write(env, 'create', null, { countryId: ID.country, cityId: ID.city, kind: 'photo', files: [{ fileName: 'scene.jpg', bytes: bytes.length }], ...options })
  assert.equal(result.status, 201, JSON.stringify(result))
  return result.body.job
}
async function received(env, bytes, options) { return receive(env, await create(env, bytes, options), bytes) }
async function importReady(env, job) {
  const result = await preview(env, job)
  assert.equal(result.status, 200, JSON.stringify(result))
  assert.deepEqual(result.body.plan.blockers, [])
  assert.match(result.body.plan.digest, /^[a-f0-9]{64}$/)
  assert.ok(result.body.plan.summary)
  const input = importInput(job, result.body.plan)
  const imported = await write(env, 'import', job, input)
  assert.equal(imported.status, 200, JSON.stringify(imported))
  assert.equal(imported.body.job.status, 'completed')
  return { input, result: imported, plan: result.body.plan }
}
const freshRead = async (env, job) => {
  // Another process opens the store read-only (as build:personal does next to the dev server).
  const script = `import {getPrivatePaths} from './scripts/private-profile.mjs';import {handleMediaJobRead,mediaJobRoute} from './scripts/media-job-service.mjs';import {createStoreSession} from './scripts/store-session.mjs';const paths=getPrivatePaths({STARMAP_PRIVATE_ROOT:${JSON.stringify(env.paths.root)}});const session=createStoreSession(paths,{log:()=>{},readOnly:true});const result=await handleMediaJobRead({privatePaths:paths,route:mediaJobRoute('GET',${JSON.stringify(`${base}/${job.jobId}`)}),storeMedia:{mediaStore:await session.mediaStore()}});await session.close();process.stdout.write(JSON.stringify(result));`
  const result = await execute(process.execPath, ['--input-type=module', '-e', script], { cwd: path.resolve(import.meta.dirname, '..'), maxBuffer: 1024 * 1024 })
  return JSON.parse(result.stdout)
}
const freshReplay = async (env, job, input) => {
  const script = `import {getPrivatePaths} from './scripts/private-profile.mjs';import {handleMediaJobWrite,mediaJobRoute} from './scripts/media-job-service.mjs';import {withLibraryOperation} from './scripts/library-operation-lock.mjs';import {createStoreSession} from './scripts/store-session.mjs';const paths=getPrivatePaths({STARMAP_PRIVATE_ROOT:${JSON.stringify(env.paths.root)}});const session=createStoreSession(paths,{log:()=>{},readOnly:true});const storeMedia={mediaStore:await session.mediaStore()};const result=await withLibraryOperation(paths,leaseToken=>handleMediaJobWrite({privatePaths:paths,route:mediaJobRoute('POST',${JSON.stringify(`${base}/${job.jobId}/import`)}),input:${JSON.stringify(input)},deps:{},leaseToken,storeMedia}));await session.close();process.stdout.write(JSON.stringify(result));`
  const result = await execute(process.execPath, ['--input-type=module', '-e', script], { cwd: path.resolve(import.meta.dirname, '..'), maxBuffer: 1024 * 1024 })
  return JSON.parse(result.stdout)
}

test('RD-07 batch2 preview is byte-and-timestamp readonly and its digest is stable', async () => withRoot(async env => {
  const job = await received(env, await jpeg()), before = await tree(env.paths.root)
  const first = await preview(env, job), second = await preview(env, job)
  assert.equal(first.status, 200, JSON.stringify(first)); assert.deepEqual(first.body.plan.blockers, [])
  assert.equal(first.body.plan.digest, second.body.plan.digest)
  assert.deepEqual(await tree(env.paths.root), before)
}))

test('RD-07 batch2 preview is conservative and readonly while the library lease is held', async () => withRoot(async env => {
  const job = await received(env, await jpeg())
  await withLibraryOperation(env.paths, async () => {
    const before = await tree(env.paths.root), result = await preview(env, job)
    assert.ok(result.status >= 400 || result.body.status === 'processing', JSON.stringify(result))
    assert.deepEqual(await tree(env.paths.root), before)
  })
}))

test('RD-07 batch2 empty, duplicate, unknown or incomplete received selections cannot import', async () => withRoot(async env => {
  const bytes = await jpeg(), other = await jpeg({ r: 180, g: 60, b: 80 })
  let job = await create(env, bytes, { files: [{ fileName: 'one.jpg', bytes: bytes.length }, { fileName: 'two.jpg', bytes: other.length }] })
  job = await receive(env, job, bytes, job.files[0].fileId)
  job = await receive(env, job, other, job.files[1].fileId)
  const before = await tree(env.paths.root)
  for (const selected of [[], [job.files[0].fileId], [job.files[0].fileId, job.files[0].fileId], [randomUUID()]]) {
    const result = await preview(env, job, selected)
    assert.ok(result.status >= 400 || result.body.plan.blockers.length > 0, JSON.stringify(result))
  }
  assert.deepEqual(await tree(env.paths.root), before)
}))

test('RD-07 batch2 foreign library and stale revision preview are rejected without any writes', async () => withRoot(async env => {
  const job = await received(env, await jpeg()), before = await tree(env.paths.root)
  for (const override of [{ libraryId: randomUUID() }, { revision: 0 }]) {
    const result = await preview(env, job, selection(job), override)
    assert.ok(result.status >= 400, JSON.stringify(result))
  }
  assert.deepEqual(await tree(env.paths.root), before)
}))

test('RD-07 batch2 sealed import replay consumes the original intent without rewriting bytes or timestamps', async () => withRoot(async env => {
  const job = await received(env, await jpeg()), { input, result } = await importReady(env, job)
  const before = await tree(env.paths.root, { omitCoordination: true })
  const replay = await write(env, 'import', result.body.job, input)
  assert.equal(replay.status, 200, JSON.stringify(replay)); assert.equal(replay.body.job.status, 'completed')
  assert.deepEqual(await tree(env.paths.root, { omitCoordination: true }), before)
  const restartedReplay = await freshReplay(env, result.body.job, input)
  assert.equal(restartedReplay.status, 200, JSON.stringify(restartedReplay)); assert.equal(restartedReplay.body.job.status, 'completed')
  assert.deepEqual(await tree(env.paths.root, { omitCoordination: true }), before)
  for (const changed of [{ ...input, operationId: randomUUID() }, { ...input, planDigest: 'f'.repeat(64) }, { ...input, selectedFileIds: [] }, { ...input, libraryId: randomUUID() }]) {
    const refused = await write(env, 'import', result.body.job, changed)
    assert.ok(refused.status >= 400, JSON.stringify(refused))
    assert.deepEqual(await tree(env.paths.root, { omitCoordination: true }), before)
  }
}))

test('RD-07 batch2 a changed source between preview and import invalidates the plan without generating media', async () => withRoot(async env => {
  const bytes = await jpeg(), job = await received(env, bytes), result = await preview(env, job)
  const persisted = await readJson(jobPath(env, job)), source = path.join(env.paths.inboxRoot, persisted.files[0].sourcePath)
  const replacement = path.join(path.dirname(source), 'replacement.tmp'); await writeFile(replacement, await jpeg({ r: 120, g: 40, b: 40 })); await unlink(source)
  const { rename } = await import('node:fs/promises'); await rename(replacement, source)
  const before = await tree(env.paths.root, { omitCoordination: true }), rejected = await write(env, 'import', job, importInput(job, result.body.plan))
  assert.ok(rejected.status >= 400, JSON.stringify(rejected)); assert.deepEqual(await tree(env.paths.root, { omitCoordination: true }), before)
  assert.equal(Object.keys(before).some(name => name.startsWith('media/user/')), false)
}))

test('RD-07 batch2 stale and foreign import intents do not create stages or media', async () => withRoot(async env => {
  const job = await received(env, await jpeg()), plan = (await preview(env, job)).body.plan, input = importInput(job, plan)
  const before = await tree(env.paths.root, { omitCoordination: true })
  for (const bad of [{ ...input, revision: 0 }, { ...input, libraryId: randomUUID() }, { ...input, planDigest: '0'.repeat(64) }, { ...input, operationId: 'not-a-uuid' }]) {
    const result = await write(env, 'import', job, bad)
    assert.ok(result.status >= 400, JSON.stringify(result)); assert.deepEqual(await tree(env.paths.root, { omitCoordination: true }), before)
  }
}))

test('RD-07 batch2 an unrelated unknown-city Inbox delivery blocks the whole-library plan', async () => withRoot(async env => {
  const bytes = await jpeg(), job = await received(env, bytes)
  const unknown = path.join(env.paths.inboxRoot, 'Test Country', 'Unknown City', 'photos', 'other.jpg')
  await mkdir(path.dirname(unknown), { recursive: true }); await writeFile(unknown, await jpeg({ r: 100, g: 10, b: 80 }))
  const before = await tree(env.paths.root), result = await preview(env, job)
  assert.ok(result.status >= 400 || result.body.plan.blockers.length > 0, JSON.stringify(result))
  assert.deepEqual(await tree(env.paths.root), before)
}))

test('RD-07 batch2 an explicit received subset may finish while unreceived intent remains preserved', async () => withRoot(async env => {
  const bytes = await jpeg()
  let job = await create(env, bytes, { files: [{ fileName: 'received.jpg', bytes: bytes.length }, { fileName: 'unreceived.jpg', bytes: bytes.length }] })
  job = await receive(env, job, bytes, job.files[0].fileId)
  const { result } = await importReady(env, job)
  assert.equal(result.body.job.files[0].status, 'completed'); assert.equal(result.body.job.files[1].status, 'not_received')
  const closed = await write(env, 'close', result.body.job, identity(result.body.job))
  assert.equal(closed.status, 200, JSON.stringify(closed)); assert.equal(closed.body.job.phase, 'closed')
  const persisted = await readJson(jobPath(env, job)); assert.equal(persisted.files[1].phase, 'intended')
  assert.equal(Object.keys(await tree(env.paths.root)).some(name => name.endsWith('/unreceived.jpg')), false)
}))

for (const stage of ['generated', 'pins', 'catalog', 'index', 'editor']) test(`RD-07 batch2 failure after durable ${stage} stage is preserved and never auto-rerun`, async () => withRoot(async env => {
  const job = await received(env, await jpeg()), plan = (await preview(env, job)).body.plan, input = importInput(job, plan)
  let reached = false
  env.deps.onMediaJobImportStage = async current => { if (current === stage) { reached = true; throw new Error('synthetic stage interruption') } }
  const interrupted = await write(env, 'import', job, input)
  assert.equal(reached, true, `must inject after durable ${stage}, not pass on an unrelated early failure`)
  assert.ok(interrupted.status >= 400, JSON.stringify(interrupted))
  const before = await tree(env.paths.root, { omitCoordination: true }), read = await freshRead(env, job)
  assert.equal(read.body.job.status, 'needs_review', JSON.stringify(read)); assert.equal(read.body.job.canImport, false)
  delete env.deps.onMediaJobImportStage
  const retry = await write(env, 'import', job, input)
  assert.ok(retry.status >= 400, JSON.stringify(retry)); assert.deepEqual(await tree(env.paths.root, { omitCoordination: true }), before)
}))

test('RD-07 batch2 committed resources without the final seal do not infer success or rerun', async () => withRoot(async env => {
  const job = await received(env, await jpeg()), { input } = await importReady(env, job)
  const persisted = await readJson(jobPath(env, job))
  persisted.phase = 'open'; persisted.import.phase = 'editor'; delete persisted.import.receipt
  await writeFile(jobPath(env, job), `${JSON.stringify(persisted, null, 2)}\n`)
  const before = await tree(env.paths.root, { omitCoordination: true }), restarted = await freshRead(env, job)
  assert.equal(restarted.body.job.status, 'needs_review', JSON.stringify(restarted)); assert.equal(restarted.body.job.canImport, false)
  const refused = await freshReplay(env, job, input)
  assert.ok(refused.status >= 400, JSON.stringify(refused))
  assert.deepEqual(await tree(env.paths.root, { omitCoordination: true }), before)
}))

test('RD-07 batch2 modified generated bytes during the editor stage cannot be sealed as complete', async () => withRoot(async env => {
  const bytes = await jpeg(), job = await received(env, bytes), plan = (await preview(env, job)).body.plan
  let changed = false
  env.deps.onMediaJobImportStage = async stage => {
    if (stage !== 'editor') return
    const target = path.join(env.paths.userMediaRoot, sha(bytes).slice(0,16), 'thumb.webp')
    await unlink(target); await writeFile(target, 'synthetic corrupt derivative'); changed = true
  }
  const result = await write(env, 'import', job, importInput(job, plan))
  assert.equal(changed, true, 'must reach editor stage before deliberately replacing the synthetic derivative')
  assert.ok(result.status >= 400, JSON.stringify(result))
  const persisted = await readJson(jobPath(env, job)); assert.notEqual(persisted.import.phase, 'sealed')
  const before = await tree(env.paths.root), restarted = await freshRead(env, job)
  assert.equal(restarted.body.job.status, 'needs_review', JSON.stringify(restarted))
  assert.deepEqual(await tree(env.paths.root), before)
}))

test('RD-07 batch2 history stays completed after source removal and derivative removal', async () => withRoot(async env => {
  const bytes = await jpeg(), job = await received(env, bytes), { input, result } = await importReady(env, job)
  const persisted = await readJson(jobPath(env, job))
  await unlink(path.join(env.paths.inboxRoot, persisted.files[0].sourcePath))
  await unlink(path.join(env.paths.userMediaRoot, sha(bytes).slice(0,16), 'thumb.webp'))
  const before = await tree(env.paths.root, { omitCoordination: true }), historical = await freshRead(env, job)
  assert.equal(historical.body.job.status, 'completed', JSON.stringify(historical)); assert.equal(historical.body.job.canImport, false)
  assert.ok(historical.body.job.warnings?.length > 0, JSON.stringify(historical))
  const replay = await write(env, 'import', result.body.job, input)
  assert.equal(replay.status, 200, JSON.stringify(replay)); assert.equal(replay.body.job.status, 'completed')
  assert.deepEqual(await tree(env.paths.root, { omitCoordination: true }), before)
}))

test('RD-07 batch2 close requires completion, preserves sources and history, and permits the next task', async () => withRoot(async env => {
  const bytes = await jpeg(), job = await received(env, bytes), before = await tree(env.paths.root, { omitCoordination: true })
  const early = await write(env, 'close', job, identity(job)); assert.ok(early.status >= 400, JSON.stringify(early))
  assert.deepEqual(await tree(env.paths.root, { omitCoordination: true }), before)
  const { result } = await importReady(env, job), completed = result.body.job
  const beforeClose = await tree(env.paths.root, { omitCoordination: true }), closed = await write(env, 'close', completed, identity(completed))
  assert.equal(closed.status, 200, JSON.stringify(closed)); assert.equal(closed.body.job.phase, 'closed')
  const afterClose = await tree(env.paths.root, { omitCoordination: true })
  for (const [name, value] of Object.entries(beforeClose)) if (name !== path.relative(env.paths.root, jobPath(env, job)).split(path.sep).join('/')) assert.deepEqual(afterClose[name], value, name)
  const repeat = await write(env, 'close', closed.body.job, identity(closed.body.job)); assert.equal(repeat.status, 200, JSON.stringify(repeat))
  assert.deepEqual(await tree(env.paths.root, { omitCoordination: true }), afterClose)
  const fresh = await create(env, bytes, { files: [{ fileName: 'next.jpg', bytes: bytes.length }] }); assert.notEqual(fresh.jobId, job.jobId)
  const saved = await readJson(jobPath(env, job)); assert.equal(saved.phase, 'closed'); assert.ok(saved.import)
}))

test('RD-07 batch2 import entry cannot bypass the verified disk lease', async () => withRoot(async env => {
  const job = await received(env, await jpeg()), plan = (await preview(env, job)).body.plan, before = await tree(env.paths.root)
  const denied = await service.handleMediaJobWrite({ privatePaths: env.paths, deps: env.deps, route: route('import', job), input: importInput(job, plan) })
  assert.ok(denied.status >= 400, JSON.stringify(denied)); assert.deepEqual(await tree(env.paths.root), before)
}))

test('RD-07 batch2 two consecutive closed tasks import different content without altering the first history', async () => withRoot(async env => {
  const firstBytes = await jpeg(), first = await received(env, firstBytes), firstImport = await importReady(env, first)
  const firstClosed = await write(env, 'close', firstImport.result.body.job, identity(firstImport.result.body.job))
  assert.equal(firstClosed.status, 200, JSON.stringify(firstClosed))
  const firstRecordBefore = await readFile(jobPath(env, first)), firstRecordStat = await stat(jobPath(env, first))
  const secondBytes = await jpeg({ r: 170, g: 35, b: 20 })
  const second = await received(env, secondBytes, { files: [{ fileName: 'second.jpg', bytes: secondBytes.length }] })
  const secondImport = await importReady(env, second)
  assert.equal((await catalogOf(env)).items.length, 2)
  const registry = env.storeMedia.mediaStore.mediaRegistry()
  for (const bytes of [firstBytes, secondBytes]) {
    assert.equal(registry.sources.filter(source => source.sha256 === sha(bytes) && source.state === 'present').length, 1)
    for (const filename of ['original.jpg', 'thumb.webp', 'preview.webp']) assert.ok((await stat(path.join(env.paths.userMediaRoot, sha(bytes).slice(0,16), filename))).size > 0)
  }
  const secondClosed = await write(env, 'close', secondImport.result.body.job, identity(secondImport.result.body.job))
  assert.equal(secondClosed.status, 200, JSON.stringify(secondClosed))
  assert.deepEqual(await readFile(jobPath(env, first)), firstRecordBefore)
  assert.equal((await stat(jobPath(env, first))).mtimeMs, firstRecordStat.mtimeMs)
  const oldHistory = await freshRead(env, first)
  assert.equal(oldHistory.body.job.status, 'closed', JSON.stringify(oldHistory))
  assert.equal(oldHistory.body.job.completion.operationId, firstImport.input.operationId)
}))

// ---------------------------------------------------------------------------
// Batch 2 D4 / D6: task-scoped receipts and reads without content hashing
// ---------------------------------------------------------------------------


const generatedPaths = (bytes) => ['original.jpg', 'preview.webp', 'thumb.webp'].map((name) => `media/user/${sha(bytes).slice(0, 16)}/${name}`)

test('D4 a task\'s largest possible completed record fits the record limit, even at the input limits', async () => withRoot(async env => {
  const title = '题'.repeat(500)
  const files = Array.from({ length: 100 }, (_, index) => ({ fileName: `${'名'.repeat(110)}${String(index).padStart(3, '0')}.jpeg`, bytes: 250 * 1024 * 1024,
    metadata: { date: '2026-01-01', lat: 64.123456789, lng: -21.123456789, altitudeMeters: 123.456, relativeAltitudeMeters: 45.678, titleZh: title, titleEn: title } }))
  const created = await write(env, 'create', null, { countryId: ID.country, cityId: ID.city, kind: 'aerialPhoto', files })
  assert.equal(created.status, 201, JSON.stringify(created).slice(0, 300))
  const job = await readJson(jobPath(env, created.body.job))
  const largest = largestCompletedMediaJobRecord(job)
  assertMediaJobRecord(largest)
  assert.ok(Buffer.byteLength(`${JSON.stringify(largest, null, 2)}\n`) < 1024 * 1024)
}))

test('D4 receipts sealed before D4 (whole-library outputs, no times or library digest) stay valid and readable', async () => withRoot(async env => {
  const bytes = await jpeg(), job = await received(env, bytes)
  await importReady(env, job)
  const record = await readJson(jobPath(env, job))
  // Rewrite the receipt the way the earlier code sealed it: every V2 file, the index, every output and every source.
  const oldPaths = [...Object.values(env.paths.v2FilePaths), env.paths.v2MediaSourceIndexPath,
    ...generatedPaths(bytes).map((output) => path.join(env.paths.root, ...output.split('/'))), path.join(env.paths.inboxRoot, ...record.files[0].sourcePath.split('/'))]
  const outputs = []
  for (const target of [...new Set(oldPaths)].sort()) {
    let info
    try { info = await stat(target) } catch { continue }
    outputs.push({ path: path.relative(env.paths.root, target).split(path.sep).join('/'), bytes: info.size, sha256: sha(await readFile(target)) })
  }
  const { libraryDigest: _digest, seal: _seal, ...rest } = record.import.receipt
  void _digest; void _seal
  const receipt = { ...rest, outputs }
  record.import.receipt = { ...receipt, seal: mediaJobReceiptSeal(record, record.import, receipt) }
  await writeFile(jobPath(env, job), `${JSON.stringify(record, null, 2)}\n`)

  const read = await get(env, job)
  assert.equal(read.status, 200, JSON.stringify(read)); assert.equal(read.body.job.status, 'completed')
  assert.deepEqual(read.body.job.warnings, [])
  const closed = await write(env, 'close', read.body.job, identity(read.body.job))
  assert.equal(closed.status, 200, JSON.stringify(closed)); assert.equal(closed.body.job.phase, 'closed')
  // A later rewrite of a generated file is still noticed by size and time.
  const thumb = path.join(env.paths.userMediaRoot, sha(bytes).slice(0, 16), 'thumb.webp')
  await writeFile(thumb, 'synthetic replacement')
  const changed = await get(env, job)
  assert.deepEqual(changed.body.job.warnings, [{ kind: 'changed_resource', path: generatedPaths(bytes)[2] }])
}))

test('D6 reading the task list hashes nothing; only the explicit receipt check does, and it reports a changed file', async (t) => withRoot(async env => {
  const bytes = await jpeg(), job = await received(env, bytes)
  const { result } = await importReady(env, job)
  await write(env, 'close', result.body.job, identity(result.body.job))
  const digests = t.mock.method(service.mediaJobHashing, 'digestFile')
  let streams = 0
  const originalStream = fs.createReadStream
  fs.createReadStream = (...args) => { streams += 1; return originalStream(...args) }
  syncBuiltinESMExports()
  try {
    const list = await service.handleMediaJobRead({ privatePaths: env.paths, route: service.mediaJobRoute('GET', base), storeMedia: env.storeMedia })
    const one = await get(env, job)
    assert.equal(list.status, 200, JSON.stringify(list)); assert.equal(list.body.jobs[0].status, 'closed')
    assert.equal(one.body.job.status, 'closed'); assert.deepEqual(one.body.job.warnings, [])
    assert.equal(digests.mock.callCount(), 0)
    assert.equal(streams, 0)

    const clean = await service.verifyMediaJobReceipts(env.paths)
    assert.equal(clean.checked, 4); assert.deepEqual(clean.findings, [])
    assert.equal(digests.mock.callCount(), 4)
    const preview = path.join(env.paths.userMediaRoot, sha(bytes).slice(0, 16), 'preview.webp')
    const original = await readFile(preview)
    await writeFile(preview, Buffer.from(original).fill(0, 0, 4))
    const tampered = await service.verifyMediaJobReceipts(env.paths)
    assert.deepEqual(tampered.findings, [{ jobId: job.jobId, path: generatedPaths(bytes)[1], kind: 'changed' }])
    const lines = []
    await service.reportMediaJobReceipts(env.paths, (line) => lines.push(line))
    assert.equal(lines.length, 2); assert.match(lines[1], /内容已改变/)
  } finally {
    fs.createReadStream = originalStream
    syncBuiltinESMExports()
  }
}))

// ---------------------------------------------------------------------------
// Batch 2 D9: one Inbox folder-name rule for uploads and tasks
// ---------------------------------------------------------------------------

/** Adds a city of Test Country to the place registry and returns its id. */
/** D9: two cities with names Windows cannot use as folder names, part of the library from the start. */
const D9_CITIES = [['Washington D.C.', newId()], ['CON', newId()]]
const d9Places = () => {
  const registry = places()
  for (const [en, id] of D9_CITIES) registry.places.push({ id, subtype: 'city', names: { en }, partOf: ID.country, location: { lat: 64.5, lng: -20.5 } })
  return registry
}

test('D9 cities named "Washington D.C." and "CON" complete task uploads into escaped Inbox folders and import', async () => withRoot(async env => {
  const cityOf = Object.fromEntries(D9_CITIES)
  for (const [en, folder, color] of [['Washington D.C.', 'Washington D.C._', { r: 90, g: 30, b: 200 }], ['CON', 'CON_', { r: 200, g: 200, b: 30 }]]) {
    const cityId = cityOf[en], bytes = await jpeg(color)
    const job = await received(env, bytes, { cityId, files: [{ fileName: 'scene.jpg', bytes: bytes.length }] })
    assert.equal(job.files[0].phase, 'received', en)
    assert.equal(job.status, 'pending', en)
    const record = await readJson(jobPath(env, job))
    assert.deepEqual(record.files[0].sourcePath.split('/'), ['Test Country', folder, 'photos', 'scene.jpg'], en)
    assert.deepEqual(await readJson(path.join(env.paths.inboxRoot, 'Test Country', folder, 'place.json')), { placeId: cityId }, en)
    const { result } = await importReady(env, job)
    assert.equal(result.body.job.files[0].status, 'completed', en)
    assert.ok((await catalogOf(env)).items.some((item) => item.placeId === cityId), en)
    await write(env, 'close', result.body.job, identity(result.body.job))
  }
}, { registry: d9Places() }))

test('Batch 2A: a hand-made folder matched only by name is listed in the preview and imported only after its binding is confirmed', async () => withRoot(async env => {
  const job = await received(env, await jpeg())
  // Other City has no place.json: it resolves to a place by folder name only, which is a hint, not an identity.
  const manual = path.join(env.paths.inboxRoot, 'Test Country', 'Other City', 'photos', 'manual.jpg')
  await mkdir(path.dirname(manual), { recursive: true }); await writeFile(manual, await jpeg({ r: 200, g: 120, b: 30 }))
  const result = await preview(env, job)
  assert.equal(result.status, 200, JSON.stringify(result)); assert.deepEqual(result.body.plan.blockers, [])
  assert.deepEqual(result.body.plan.summary.pins, [{
    sourcePath: 'Test Country/Other City/place.json', placeId: ID.otherCity, folder: 'Test Country/Other City',
    subtype: 'city', names: { 'zh-Hans': '另一城', en: 'Other City' }, source: 'name',
  }])
  const before = await tree(env.paths.root, { omitCoordination: true })
  for (const extra of [{}, { acceptFolderBindings: false }]) {
    const refused = await write(env, 'import', job, { ...importInput(job, result.body.plan), ...extra })
    assert.equal(refused.status, 409, JSON.stringify(refused)); assert.equal(refused.body.code, 'E_MEDIA_FOLDER_BINDINGS_UNCONFIRMED')
    assert.deepEqual(await tree(env.paths.root, { omitCoordination: true }), before, 'no place.json, catalog, output or task record change')
  }
  const invalid = await write(env, 'import', job, { ...importInput(job, result.body.plan), acceptFolderBindings: 'yes' })
  assert.equal(invalid.status, 400, JSON.stringify(invalid)); assert.equal(invalid.body.code, 'E_MEDIA_JOB_INVALID')
  const imported = await write(env, 'import', job, { ...importInput(job, result.body.plan), acceptFolderBindings: true })
  assert.equal(imported.status, 200, JSON.stringify(imported)); assert.equal(imported.body.job.status, 'completed')
  assert.deepEqual(await readJson(path.join(env.paths.inboxRoot, 'Test Country', 'Other City', 'place.json')), { placeId: ID.otherCity })
  const catalog = await catalogOf(env)
  assert.equal(catalog.items.find(item => item.originalFileName === 'manual.jpg')?.placeId, ID.otherCity)
}))

// ---------------------------------------------------------------------------
// Batch 2D: task reception never claims a hand-made folder
// ---------------------------------------------------------------------------

/** A city folder the user made by hand: one photo, no place.json. */
async function handMadeCity(cityRoot) {
  await mkdir(path.join(cityRoot, 'photos'), { recursive: true }); await writeFile(path.join(cityRoot, 'photos', 'manual.jpg'), await jpeg({ r: 200, g: 120, b: 30 }))
}
/** Every file under a folder (SHA-256, size, modification time) and the folder's own modification time. */
const folderState = async (directory) => ({ files: await tree(directory), mtimeMs: (await stat(directory)).mtimeMs })
const handMadeBinding = (folder, placeId, subtype, names) => ({ sourcePath: `${folder}/place.json`, placeId, folder, subtype, names, source: 'name' })

test('Batch 2D: task reception never claims a hand-made city folder; it creates "<name> (<suffix>)", reuses it, and leaves the hand-made folder unchanged and listed as a binding to confirm', async () => withRoot(async env => {
  const countryRoot = path.join(env.paths.inboxRoot, 'Test Country'), handMade = path.join(countryRoot, 'Test City')
  await handMadeCity(handMade)
  const countryPin = JSON.stringify({ placeId: ID.country })
  await writeFile(path.join(countryRoot, 'place.json'), countryPin)
  const before = await folderState(handMade)

  const first = await jpeg({ r: 10, g: 140, b: 90 }), second = await jpeg({ r: 150, g: 40, b: 120 })
  let job = await create(env, first, { files: [{ fileName: 'scene.jpg', bytes: first.length }, { fileName: 'second.jpg', bytes: second.length }] })
  job = await receive(env, job, first, job.files[0].fileId)
  job = await receive(env, job, second, job.files[1].fileId)
  const folder = `Test City (${placeFolderSuffix(ID.city)})`
  assert.deepEqual((await readJson(jobPath(env, job))).files.map(file => file.sourcePath), [`Test Country/${folder}/photos/scene.jpg`, `Test Country/${folder}/photos/second.jpg`])
  assert.deepEqual(await readJson(path.join(countryRoot, folder, 'place.json')), { placeId: ID.city })
  assert.equal(await readFile(path.join(countryRoot, 'place.json'), 'utf8'), countryPin, 'the country folder already pinned to the place is reused as it is')
  assert.equal(fs.existsSync(path.join(handMade, 'place.json')), false)
  assert.deepEqual(await folderState(handMade), before, 'not one byte, file or folder entry of the hand-made folder changes')

  const result = await preview(env, job)
  assert.equal(result.status, 200, JSON.stringify(result)); assert.deepEqual(result.body.plan.blockers, [])
  assert.deepEqual(result.body.plan.summary.pins, [handMadeBinding('Test Country/Test City', ID.city, 'city', { 'zh-Hans': '测试城', en: 'Test City' })])
  assert.deepEqual(await folderState(handMade), before)
}))

test('Batch 2D: task reception never claims a hand-made country folder either; it creates "<country> (<suffix>)/<city>", and both hand-made folders are bound only after confirmation', async () => withRoot(async env => {
  const handMade = path.join(env.paths.inboxRoot, 'Test Country')
  await handMadeCity(path.join(handMade, 'Test City'))
  const before = await folderState(handMade)

  const job = await received(env, await jpeg({ r: 30, g: 30, b: 200 }))
  const countryFolder = `Test Country (${placeFolderSuffix(ID.country)})`
  assert.deepEqual((await readJson(jobPath(env, job))).files[0].sourcePath.split('/'), [countryFolder, 'Test City', 'photos', 'scene.jpg'])
  assert.deepEqual(await readJson(path.join(env.paths.inboxRoot, countryFolder, 'place.json')), { placeId: ID.country })
  assert.deepEqual(await readJson(path.join(env.paths.inboxRoot, countryFolder, 'Test City', 'place.json')), { placeId: ID.city })
  assert.equal(fs.existsSync(path.join(handMade, 'place.json')), false)
  assert.equal(fs.existsSync(path.join(handMade, 'Test City', 'place.json')), false)
  assert.deepEqual(await folderState(handMade), before)

  const result = await preview(env, job)
  assert.equal(result.status, 200, JSON.stringify(result)); assert.deepEqual(result.body.plan.blockers, [])
  assert.deepEqual(result.body.plan.summary.pins, [
    handMadeBinding('Test Country', ID.country, 'country', { 'zh-Hans': '测试国', en: 'Test Country' }),
    handMadeBinding('Test Country/Test City', ID.city, 'city', { 'zh-Hans': '测试城', en: 'Test City' }),
  ])
  const refused = await write(env, 'import', job, importInput(job, result.body.plan))
  assert.equal(refused.status, 409, JSON.stringify(refused)); assert.equal(refused.body.code, 'E_MEDIA_FOLDER_BINDINGS_UNCONFIRMED')
  assert.deepEqual(await folderState(handMade), before)

  // Once confirmed, both country folders refer to the same place (spec §3 accepts this) and both photos import to the city.
  const imported = await write(env, 'import', job, { ...importInput(job, result.body.plan), acceptFolderBindings: true })
  assert.equal(imported.status, 200, JSON.stringify(imported)); assert.equal(imported.body.job.status, 'completed')
  assert.deepEqual(await readJson(path.join(handMade, 'place.json')), { placeId: ID.country })
  assert.deepEqual(await readJson(path.join(handMade, 'Test City', 'place.json')), { placeId: ID.city })
  const owners = Object.fromEntries((await catalogOf(env)).items.map(item => [item.originalFileName, item.placeId]))
  assert.deepEqual(owners, { 'manual.jpg': ID.city, 'scene.jpg': ID.city })
}))
