/** RD-07 batch-two acceptance. Owned synthetic libraries and generated JPEG bytes only. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import sharp from 'sharp'
import { getPrivatePaths } from './private-profile.mjs'
import { atomicJsonWrite, readJson } from './json-file.mjs'
import { safeSegment, reserveDestination } from './local-editor-upload.mjs'
import { withLibraryOperation } from './library-operation-lock.mjs'
import * as service from './media-job-service.mjs'
import { prepareV2Upload } from './v2-media-store.mjs'
import { sequentialUuids } from '../src/data/canonical/v2.fixture.ts'

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
async function withRoot(run) {
  const prefix = 'starmap-rd07-import-acceptance-'
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  const paths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: path.join(directory, 'private') })
  await mkdir(paths.v2DataRoot, { recursive: true })
  await writeFile(paths.v2FilePaths.places, `${JSON.stringify(places(), null, 2)}\n`)
  try { await run({ paths, deps: dependencies() }) } finally {
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
const write = (env, action, job, input, extra = {}) => withLibraryOperation(env.paths, leaseToken => service.handleMediaJobWrite({ privatePaths: env.paths, deps: env.deps, route: route(action, job), input, ...extra, leaseToken }))
const get = (env, job) => service.handleMediaJobRead({ privatePaths: env.paths, route: service.mediaJobRoute('GET', `${base}/${job.jobId}`) })
const selection = (job) => job.files.filter(file => file.phase === 'received').map(file => file.fileId)
const identity = (job) => ({ libraryId: job.libraryId, revision: job.revision })
const preview = (env, job, selectedFileIds = selection(job), override = {}) => service.handleMediaJobPreview({ privatePaths: env.paths, route: route('preview', job), input: { ...identity(job), selectedFileIds, ...override } })
const importInput = (job, plan, operationId = randomUUID()) => ({ ...identity(job), selectedFileIds: selection(job), operationId, planDigest: plan.digest })
const jobPath = (env, job) => path.join(env.paths.root, 'operations/media-import/v1/jobs', `${job.jobId}.json`)
async function receive(env, job, bytes, fileId = job.files[0].fileId) {
  const request = Readable.from([bytes]); request.headers = { 'content-length': String(bytes.length) }
  const url = new URL(`${base}/${job.jobId}/files/${fileId}?${new URLSearchParams({ ...identity(job), operationId: randomUUID(), sha256: sha(bytes) })}`, 'http://127.0.0.1')
  const result = await withLibraryOperation(env.paths, leaseToken => service.handleMediaJobWrite({ privatePaths: env.paths, deps: env.deps, route: service.mediaJobRoute('POST', url.pathname), request, url, leaseToken }))
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
  const script = `import {getPrivatePaths} from './scripts/private-profile.mjs';import {handleMediaJobRead,mediaJobRoute} from './scripts/media-job-service.mjs';const paths=getPrivatePaths({STARMAP_PRIVATE_ROOT:${JSON.stringify(env.paths.root)}}); const result=await handleMediaJobRead({privatePaths:paths,route:mediaJobRoute('GET',${JSON.stringify(`${base}/${job.jobId}`)})});process.stdout.write(JSON.stringify(result));`
  const result = await execute(process.execPath, ['--input-type=module', '-e', script], { cwd: path.resolve(import.meta.dirname, '..'), maxBuffer: 1024 * 1024 })
  return JSON.parse(result.stdout)
}
const freshReplay = async (env, job, input) => {
  const script = `import {getPrivatePaths} from './scripts/private-profile.mjs';import {handleMediaJobWrite,mediaJobRoute} from './scripts/media-job-service.mjs';import {withLibraryOperation} from './scripts/library-operation-lock.mjs';const paths=getPrivatePaths({STARMAP_PRIVATE_ROOT:${JSON.stringify(env.paths.root)}});const result=await withLibraryOperation(paths,leaseToken=>handleMediaJobWrite({privatePaths:paths,route:mediaJobRoute('POST',${JSON.stringify(`${base}/${job.jobId}/import`)}),input:${JSON.stringify(input)},deps:{},leaseToken}));process.stdout.write(JSON.stringify(result));`
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

test('RD-07 batch2 import creates a catalog, source index, three tiers and sealed historical completion', async () => withRoot(async env => {
  const bytes = await jpeg(), job = await received(env, bytes), receipt = await readJson(jobPath(env, job))
  const { result } = await importReady(env, job), contentId = `media-${sha(bytes).slice(0, 16)}`
  assert.equal(result.body.job.files[0].status, 'completed')
  const catalog = await readJson(env.paths.v2FilePaths.media), index = await readJson(env.paths.v2MediaSourceIndexPath)
  assert.equal(catalog.items.length, 1); assert.equal(catalog.items[0].id, contentId); assert.equal(catalog.items[0].placeId, ID.city)
  assert.ok(index.sourcesById[contentId].includes(receipt.files[0].sourcePath))
  for (const filename of ['original.jpg', 'thumb.webp', 'preview.webp']) assert.ok((await stat(path.join(env.paths.userMediaRoot, sha(bytes).slice(0,16), filename))).size > 0)
  assert.deepEqual(await readFile(path.join(env.paths.inboxRoot, receipt.files[0].sourcePath)), bytes)
  const saved = await readJson(jobPath(env, job)); assert.equal(saved.phase, 'completed'); assert.ok(saved.import)
  const before = await tree(env.paths.root), restarted = await freshRead(env, job)
  assert.equal(restarted.body.job.status, 'completed', JSON.stringify(restarted))
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

test('RD-07 batch2 an edited library after preview invalidates the confirmed digest without any apply', async () => withRoot(async env => {
  const job = await received(env, await jpeg()), plan = (await preview(env, job)).body.plan
  const changed = await readJson(env.paths.v2FilePaths.places)
  changed.places.find(place => place.id === ID.city).names.en = 'Renamed Test City'
  await atomicJsonWrite(env.paths.v2FilePaths.places, changed)
  const before = await tree(env.paths.root, { omitCoordination: true }), result = await write(env, 'import', job, importInput(job, plan))
  assert.ok(result.status >= 400, JSON.stringify(result)); assert.deepEqual(await tree(env.paths.root, { omitCoordination: true }), before)
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

test('RD-07 batch2 same content in a different city never silently changes ownership', async () => withRoot(async env => {
  const bytes = await jpeg(), job = await received(env, bytes)
  const cityRoot = path.join(env.paths.inboxRoot, 'Test Country', 'Other City')
  await mkdir(path.join(cityRoot, 'photos'), { recursive: true }); await writeFile(path.join(cityRoot, 'place.json'), JSON.stringify({ placeId: ID.otherCity }))
  await writeFile(path.join(cityRoot, 'photos', 'same.jpg'), bytes)
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

for (const resource of ['catalog', 'index']) test(`RD-07 batch2 externally changed ${resource} after editor write cannot receive a completion seal`, async () => withRoot(async env => {
  const job = await received(env, await jpeg()), plan = (await preview(env, job)).body.plan
  let changed = false
  env.deps.onMediaJobImportStage = async stage => {
    if (stage !== 'editor') return
    const target = resource === 'catalog' ? env.paths.v2FilePaths.media : env.paths.v2MediaSourceIndexPath
    const contents = await readJson(target)
    if (resource === 'catalog') contents.items = []
    else contents.sourcesById = {}
    await writeFile(target, `${JSON.stringify(contents, null, 2)}\n`); changed = true
  }
  const result = await write(env, 'import', job, importInput(job, plan))
  assert.equal(changed, true); assert.ok(result.status >= 400, JSON.stringify(result))
  const saved = await readJson(jobPath(env, job)); assert.notEqual(saved.import.phase, 'sealed')
  const before = await tree(env.paths.root), restarted = await freshRead(env, job)
  assert.equal(restarted.body.job.status, 'needs_review', JSON.stringify(restarted)); assert.deepEqual(await tree(env.paths.root), before)
}))

test('RD-07 batch2 history stays completed after hiding, sorting, source removal and derivative removal', async () => withRoot(async env => {
  const bytes = await jpeg(), job = await received(env, bytes), { input, result } = await importReady(env, job)
  const persisted = await readJson(jobPath(env, job)), id = `media-${sha(bytes).slice(0, 16)}`
  const state = await readJson(env.paths.v2FilePaths.editorState)
  state.hiddenMediaIds = [id]; state.mediaOrderByCity = { [ID.city]: [id] }; state.coverMediaByCity = { [ID.city]: id }
  await atomicJsonWrite(env.paths.v2FilePaths.editorState, state)
  const hidden = await get(env, job); assert.equal(hidden.body.job.status, 'completed', JSON.stringify(hidden))
  await unlink(path.join(env.paths.inboxRoot, persisted.files[0].sourcePath))
  await unlink(path.join(env.paths.userMediaRoot, sha(bytes).slice(0,16), 'thumb.webp'))
  const catalog = await readJson(env.paths.v2FilePaths.media), index = await readJson(env.paths.v2MediaSourceIndexPath)
  catalog.items = []; index.sourcesById = {}
  await atomicJsonWrite(env.paths.v2FilePaths.media, catalog); await atomicJsonWrite(env.paths.v2MediaSourceIndexPath, index)
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
  const catalog = await readJson(env.paths.v2FilePaths.media), index = await readJson(env.paths.v2MediaSourceIndexPath)
  assert.equal(catalog.items.length, 2)
  for (const bytes of [firstBytes, secondBytes]) {
    const id = `media-${sha(bytes).slice(0,16)}`
    assert.ok(catalog.items.some(item => item.id === id))
    assert.equal(index.sourcesById[id].length, 1)
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

test('RD-07 batch2 a new same-city same-content intent needs explicit import and deduplicates only after confirmation', async () => withRoot(async env => {
  const bytes = await jpeg(), first = await received(env, bytes), firstImport = await importReady(env, first)
  const firstClosed = await write(env, 'close', firstImport.result.body.job, identity(firstImport.result.body.job))
  assert.equal(firstClosed.status, 200, JSON.stringify(firstClosed))
  const firstRecordBefore = await readFile(jobPath(env, first))
  const second = await received(env, bytes, { files: [{ fileName: 'same-content-new-delivery.jpg', bytes: bytes.length }] })
  const persisted = await readJson(jobPath(env, second)), contentId = `media-${sha(bytes).slice(0,16)}`
  const indexBefore = await readJson(env.paths.v2MediaSourceIndexPath)
  assert.equal(indexBefore.sourcesById[contentId].includes(persisted.files[0].sourcePath), false)
  const beforePreview = await tree(env.paths.root), current = await get(env, second)
  assert.notEqual(current.body.job.status, 'completed', JSON.stringify(current))
  assert.equal(current.body.job.status, 'pending', JSON.stringify(current))
  const planned = await preview(env, second)
  assert.equal(planned.status, 200, JSON.stringify(planned)); assert.deepEqual(planned.body.plan.blockers, [])
  assert.deepEqual(await tree(env.paths.root), beforePreview)
  const secondImport = await importReady(env, second)
  const catalog = await readJson(env.paths.v2FilePaths.media), indexAfter = await readJson(env.paths.v2MediaSourceIndexPath)
  assert.equal(catalog.items.length, 1)
  assert.equal(catalog.items[0].id, contentId)
  assert.equal(indexAfter.sourcesById[contentId].length, 2)
  assert.ok(indexAfter.sourcesById[contentId].includes(persisted.files[0].sourcePath))
  assert.notEqual(secondImport.input.operationId, firstImport.input.operationId)
  assert.deepEqual(await readFile(jobPath(env, first)), firstRecordBefore)
  const beforeReplay = await tree(env.paths.root, { omitCoordination: true })
  assert.equal((await freshReplay(env, second, secondImport.input)).status, 200)
  assert.deepEqual(await tree(env.paths.root, { omitCoordination: true }), beforeReplay)
}))
