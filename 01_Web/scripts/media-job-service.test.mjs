/** RD-07 IO acceptance: real JPEG streams and synthetic places in an owned temporary root.
 * No configured/private user root, browser storage, or actual owner media is accessed.
 *
 * 3C-4d: media tasks run in the new library only. Each root's synthetic places are migrated into a store, and the
 * handlers get `storeMedia` from a store session as the plugin passes it. The cases that only concerned the V2 catalog
 * and source index (an import by the old importer without a receipt, a malformed source index) are removed; the store's
 * counterpart of the first is store-media-jobs.test.mjs ("a received file another import took meanwhile needs review").
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import sharp from 'sharp'
import { getPrivatePaths } from './private-profile.mjs'
import { atomicJsonWrite, readJson } from './json-file.mjs'
import { safeSegment, reserveDestination } from './local-editor-upload.mjs'
import { withLibraryOperation } from './library-operation-lock.mjs'
import { mediaJobRoute, handleMediaJobPreview, handleMediaJobRead, handleMediaJobWrite } from './media-job-service.mjs'
import { prepareV2Upload } from './v2-media-store.mjs'
import { createMediaService } from './media-service.mjs'
import { createStoreSession } from './store-session.mjs'
import { applyMigration } from './compat/store-migrate.mjs'
import { sequentialUuids } from '../src/data/canonical/v2.fixture.ts'
import { uuidv7 } from '../src/data/canonical/uuidv7.ts'

const newId = sequentialUuids(Date.UTC(2026, 9, 4))
const ID = { country: newId(), city: newId(), otherCity: newId() }
const base = '/__travelatlas/editor/media/jobs'
const places = () => ({ schema_version: 1, generated_at: '2026-10-04T00:00:00.000Z', places: [
  { id: ID.country, subtype: 'country', names: { 'zh-Hans': '测试国', en: 'Test Country' }, externalIds: { iso3166Alpha2: 'IS' }, location: { lat: 65, lng: -18 } },
  { id: ID.city, subtype: 'city', names: { 'zh-Hans': '测试城', en: 'Test City' }, partOf: ID.country, location: { lat: 64, lng: -21 } },
  { id: ID.otherCity, subtype: 'city', names: { 'zh-Hans': '另一城', en: 'Other City' }, partOf: ID.country, location: { lat: 63, lng: -19 } },
] })
const jpeg = (width = 64, height = 48) => sharp({ create: { width, height, channels: 3, background: { r: 42, g: 92, b: 140 } } }).jpeg().toBuffer()
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const execute = promisify(execFile)
async function tree(root, { omitCoordination = false } = {}) {
  const records = {}
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      const relative = path.relative(root, full).split(path.sep).join('/')
      if (omitCoordination && /^operations\/library-operation(?:-state\.json|\.lock)/.test(relative)) continue
      if (entry.isDirectory()) await walk(full)
      else records[relative] = digest(await readFile(full))
    }
  }
  await walk(root)
  return records
}
const depsFor = () => ({
  safeSegment, reserveDestination, prepareV2Upload,
  updateDroneSidecar: async (cityRoot, destination, metadata, imageMetadata) => {
    const sidecarPath = path.join(cityRoot, 'media.json')
    const sidecar = await readJson(sidecarPath, {})
    sidecar[`drone/${path.basename(destination)}`] = {
      ...metadata, resolution: `${imageMetadata.width} × ${imageMetadata.height}`,
    }
    await atomicJsonWrite(sidecarPath, sidecar)
  },
})
async function withRoot(run) {
  const prefix = 'starmap-rd07-service-test-'
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  const paths = getPrivatePaths({ STARMAP_PRIVATE_ROOT: path.join(directory, 'private') })
  await mkdir(paths.v2DataRoot, { recursive: true })
  await writeFile(paths.v2FilePaths.places, `${JSON.stringify(places(), null, 2)}\n`)
  // 3C-4d: the places migrated into a new library; the handlers read it through a session, as the plugin does.
  await applyMigration(paths, { now: '2026-10-04T00:00:00.000Z' })
  const session = createStoreSession(paths, { log: () => {} })
  try { await run({ paths, deps: depsFor(), session, storeMedia: { mediaStore: await session.mediaStore() } }) } finally {
    await session.close()
    assert.equal(path.dirname(directory), path.resolve(tmpdir()))
    assert.ok(path.basename(directory).startsWith(prefix))
    await rm(directory, { recursive: true, force: true })
  }
}
const write = (env, route, options) => withLibraryOperation(env.paths, (leaseToken) => handleMediaJobWrite({ privatePaths: env.paths, deps: env.deps, route, ...options, leaseToken, storeMedia: env.storeMedia }))
const create = (env, bytes, options = {}) => write(env, mediaJobRoute('POST', base), { input: {
  countryId: ID.country, cityId: ID.city, kind: 'photo', files: [{ fileName: 'scene.jpg', bytes: bytes.length }], ...options,
} })
const get = (env, jobId) => handleMediaJobRead({ privatePaths: env.paths, route: mediaJobRoute('GET', jobId ? `${base}/${jobId}` : base), storeMedia: env.storeMedia })
const requestOf = (bytes) => {
  const request = Readable.from([bytes])
  request.headers = { 'content-length': String(bytes.length) }
  return request
}
const receive = (env, job, bytes, { operationId = randomUUID(), revision = job.revision, libraryId = job.libraryId, request = requestOf(bytes), fileId = job.files[0].fileId, sha256 = digest(bytes) } = {}) => write(env,
  mediaJobRoute('POST', `${base}/${job.jobId}/files/${fileId}`), {
    request, url: new URL(`${base}/${job.jobId}/files/${fileId}?${new URLSearchParams({ libraryId, revision: String(revision), operationId, sha256 })}`, 'http://127.0.0.1'),
  })
const jobPath = (env, id) => path.join(env.paths.root, 'operations', 'media-import', 'v1', 'jobs', `${id}.json`)
async function newJob(env, bytes, options) {
  const result = await create(env, bytes, options)
  assert.equal(result.status, 201, JSON.stringify(result))
  assert.equal(result.body.ok, true)
  return result.body.job
}
async function receivedJob(env, bytes, options) {
  const job = await newJob(env, bytes, options)
  const result = await receive(env, job, bytes)
  assert.equal(result.status, 201, JSON.stringify(result))
  assert.equal(result.body.ok, true)
  return result.body.job
}

test('RD-07 route recognition is bounded to exact task endpoints', () => {
  assert.deepEqual(mediaJobRoute('GET', base), { action: 'list' })
  assert.deepEqual(mediaJobRoute('POST', base), { action: 'create' })
  assert.equal(mediaJobRoute('POST', `${base}/../upload`), undefined)
  assert.equal(mediaJobRoute('DELETE', `${base}/${randomUUID()}`), undefined)
  assert.equal(mediaJobRoute('GET', `${base}/not-a-uuid`), undefined)
})

test('RD-07 discovering a never-used library creates no controls or media', async () => {
  await withRoot(async (env) => {
    const before = await tree(env.paths.root)
    const result = await get(env)
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.deepEqual(result.body.jobs, [])
    assert.deepEqual(await tree(env.paths.root), before)
  })
})

test('RD-07 invalid target/file intent cannot become a persistent task', async () => {
  for (const options of [
    { cityId: randomUUID() },
    { files: [{ fileName: '../outside.jpg', bytes: 14 }] },
    { files: [{ fileName: 'CON.jpg', bytes: 14 }] },
    { files: [{ fileName: 'x'.repeat(150)+'.jpg', bytes: 14 }] },
    { files: [{ fileName: 'safe.jpg', bytes: 0 }] },
    { kind: 'unknown' },
  ]) {
    await withRoot(async (env) => {
      const before = await tree(env.paths.root, { omitCoordination: true })
      const result = await create(env, Buffer.alloc(14), options)
      assert.equal(result.body.ok, false, JSON.stringify(options))
      assert.ok(result.status >= 400, JSON.stringify(result))
      assert.deepEqual(await tree(env.paths.root, { omitCoordination: true }), before)
    })
  }
})

test('RD-07 a held library operation makes GET conservative without any writes', async () => {
  await withRoot(async (env) => {
    await withLibraryOperation(env.paths, async () => {
      const before = await tree(env.paths.root)
      const result = await get(env)
      assert.equal(result.status, 200)
      assert.equal(result.body.status, 'processing')
      assert.deepEqual(await tree(env.paths.root), before)
    })
  })
})

test('RD-07 persisted intent survives service recreation; readonly lookup never uploads', async () => {
  await withRoot(async (env) => {
    const bytes = await jpeg()
    const job = await newJob(env, bytes)
    assert.equal(job.revision, 0)
    const before = await tree(env.paths.root)
    const result = await get({ paths: { ...env.paths }, storeMedia: env.storeMedia }, job.jobId)
    assert.equal(result.status, 200)
    assert.equal(result.body.job.jobId, job.jobId)
    assert.equal(result.body.job.files[0].status, 'not_received')
    assert.deepEqual(await tree(env.paths.root), before)
    assert.ok(!Object.keys(before).some((name) => name.startsWith('MediaInbox/')))
  })
})

test('RD-07 complete source receipt survives a lost HTTP response and readonly restart', async () => {
  await withRoot(async (env) => {
    const bytes = await jpeg()
    const job = await receivedJob(env, bytes)
    const persisted = await readJson(jobPath(env, job.jobId))
    const file = persisted.files[0]
    assert.equal(file.phase, 'received')
    assert.equal(file.sha256, digest(bytes))
    assert.equal(file.receivedBytes, bytes.length)
    const source = path.join(env.paths.inboxRoot, ...file.sourcePath.split('/'))
    assert.deepEqual(await readFile(source), bytes)
    assert.equal((await stat(source)).nlink, 1, 'successful publication must release the staging link')
    assert.ok(!Object.keys(await tree(env.paths.root)).some(name => name.endsWith('.part')), 'successful upload must release staging bytes')
    assert.equal((await readJson(path.join(env.paths.inboxRoot, 'Test Country', 'place.json'))).placeId, ID.country)
    assert.equal((await readJson(path.join(env.paths.inboxRoot, 'Test Country', 'Test City', 'place.json'))).placeId, ID.city)
    const before = await tree(env.paths.root)
    const result = await get({ paths: { ...env.paths }, storeMedia: env.storeMedia }, job.jobId)
    assert.equal(result.body.job.files[0].status, 'pending')
    assert.deepEqual(await tree(env.paths.root), before)
  })
})

test('RD-07 duplicate acknowledged operation replays receipt without consuming bytes or making another source', async () => {
  await withRoot(async (env) => {
    const bytes = await jpeg()
    const initial = await newJob(env, bytes)
    const operationId = randomUUID()
    const first = await receive(env, initial, bytes, { operationId })
    assert.equal(first.status, 201, JSON.stringify(first))
    const before = await tree(env.paths.root, { omitCoordination: true })
    let consumed = false
    const stream = Readable.from((async function * () { consumed = true; yield bytes })())
    stream.headers = { 'content-length': String(bytes.length) }
    const replay = await receive(env, first.body.job, bytes, { operationId, request: stream, revision: initial.revision })
    assert.equal(replay.status, 200, JSON.stringify(replay))
    assert.equal(replay.body.job.revision, first.body.job.revision)
    assert.equal(consumed, false)
    stream.destroy()
    assert.deepEqual(await tree(env.paths.root, { omitCoordination: true }), before)
  })
})

test('RD-07 stale revision, foreign library and mismatching replay hash never rewrite media or receipt', async () => {
  for (const change of ['stale', 'library', 'hash']) await withRoot(async (env) => {
    const bytes = await jpeg()
    const initial = await newJob(env, bytes)
    const operationId = randomUUID()
    const first = await receive(env, initial, bytes, { operationId })
    assert.equal(first.status, 201, JSON.stringify(first))
    const before = await tree(env.paths.root, { omitCoordination: true })
    const bad = change === 'stale' ? { revision: 0 } : change === 'library' ? { libraryId: randomUUID() } : { sha256: '1'.repeat(64), operationId }
    const result = await receive(env, first.body.job, bytes, bad)
    assert.ok(result.status >= 400, `${change}: ${JSON.stringify(result)}`)
    assert.equal(result.body.ok, false)
    assert.deepEqual(await tree(env.paths.root, { omitCoordination: true }), before)
  })
})

test('RD-07 a premature upload cannot expose partial Inbox bytes or auto retry', async () => {
  await withRoot(async (env) => {
    const bytes = await jpeg()
    const job = await newJob(env, bytes)
    const request = Readable.from([bytes.subarray(0, 20)])
    request.headers = { 'content-length': String(bytes.length) }
    const result = await receive(env, job, bytes, { request })
    assert.ok(result.status >= 400, JSON.stringify(result))
    const snapshot = await tree(env.paths.root)
    assert.ok(!Object.keys(snapshot).some((name) => name.startsWith('MediaInbox/') && /\.jpg$/.test(name)))
    const reread = await get(env, job.jobId)
    assert.equal(reread.body.job.files[0].status, 'needs_review')
    assert.deepEqual(await tree(env.paths.root), snapshot)
  })
})

test('RD-07 complete non-image bytes remain outside Inbox and require review', async () => {
  await withRoot(async (env) => {
    const bytes = Buffer.from('Synthetic protocol content, not an image.')
    const job = await newJob(env, bytes)
    const result = await receive(env, job, bytes)
    assert.ok(result.status >= 400, JSON.stringify(result))
    assert.ok(!Object.keys(await tree(env.paths.root)).some((name) => name.startsWith('MediaInbox/') && /\.jpg$/.test(name)))
    const before = await tree(env.paths.root)
    assert.equal((await get(env, job.jobId)).body.job.files[0].status, 'needs_review')
    assert.deepEqual(await tree(env.paths.root), before)
  })
})

test('RD-07 a wrong full content hash cannot publish a valid image', async () => {
  await withRoot(async (env) => {
    const bytes = await jpeg()
    const job = await newJob(env, bytes)
    const result = await receive(env, job, bytes, { sha256: '0'.repeat(64) })
    assert.ok(result.status >= 400, JSON.stringify(result))
    assert.ok(!Object.keys(await tree(env.paths.root)).some((name) => name.startsWith('MediaInbox/') && /\.jpg$/.test(name)))
  })
})

test('RD-07 received-file modifications and deleted targets are never accepted as pending', async () => {
  for (const change of ['bytes', 'target', 'pin']) await withRoot(async (env) => {
    const job = await receivedJob(env, await jpeg())
    const stored = await readJson(jobPath(env, job.jobId))
    if (change === 'bytes') {
      const source = path.join(env.paths.inboxRoot, ...stored.files[0].sourcePath.split('/'))
      const replacement = path.join(env.paths.root, 'synthetic-replacement')
      await writeFile(replacement, 'changed synthetic source')
      await rename(replacement, source)
    }
    if (change === 'target') {
      // The task's city is gone from the library: the store's official reader without it (3C-5 E: a reader, not a V2 view).
      const real = env.storeMedia.mediaStore
      env.storeMedia = { mediaStore: { ...real, async official() {
        const { revision, reader } = await real.official()
        return { revision, reader: { ...reader, place: (id) => (id === ID.city ? undefined : reader.place(id)) } }
      } } }
    }
    if (change === 'pin') await writeFile(path.join(env.paths.inboxRoot, 'Test Country', 'Test City', 'place.json'), JSON.stringify({ placeId: ID.otherCity }))
    const before = await tree(env.paths.root)
    const result = await get(env, job.jobId)
    assert.equal(result.body.job.files[0].status, 'needs_review', `${change}: ${JSON.stringify(result)}`)
    assert.deepEqual(await tree(env.paths.root), before)
  })
})

test('RD-07 pausing keeps source/task evidence and never releases the pending media hold', async () => {
  await withRoot(async (env) => {
    const bytes = await jpeg()
    const job = await receivedJob(env, bytes)
    const stored = await readJson(jobPath(env, job.jobId))
    const source = path.join(env.paths.inboxRoot, ...stored.files[0].sourcePath.split('/'))
    const result = await write(env, mediaJobRoute('POST', `${base}/${job.jobId}/pause`), { input: { libraryId: job.libraryId, revision: job.revision } })
    assert.equal(result.status, 200, JSON.stringify(result))
    assert.deepEqual(await readFile(source), bytes)
    const second = await create(env, bytes)
    assert.equal(second.body.ok, false)
    assert.equal(second.body.code, 'E_MEDIA_JOB_PENDING')
    assert.equal((await readJson(jobPath(env, job.jobId))).phase, 'paused')
  })
})

test('RD-07 damaged persistent records are never repaired or erased by a read', async () => {
  await withRoot(async (env) => {
    const job = await newJob(env, await jpeg())
    await writeFile(jobPath(env, job.jobId), '{broken')
    const before = await tree(env.paths.root)
    const result = await get(env, job.jobId)
    assert.ok(result.body.ok === false || result.body.status === 'needs_review', JSON.stringify(result))
    assert.deepEqual(await tree(env.paths.root), before)
  })
})

test('RD-07 a stream interrupted mid-file leaves review evidence outside Inbox', async () => {
  await withRoot(async (env) => {
    const bytes = await jpeg()
    const job = await newJob(env, bytes)
    const request = Readable.from((async function * () { yield bytes.subarray(0, 20); throw new Error('Synthetic transport interruption') })())
    request.headers = { 'content-length': String(bytes.length) }
    const result = await receive(env, job, bytes, { request })
    assert.ok(result.status >= 400)
    const before = await tree(env.paths.root)
    assert.ok(!Object.keys(before).some((name) => name.startsWith('MediaInbox/') && /\.jpg$/.test(name)))
    assert.equal((await get(env, job.jobId)).body.job.files[0].status, 'needs_review')
    assert.deepEqual(await tree(env.paths.root), before)
  })
})

test('RD-07 claimed complete JPEG headers still require a successful full pixel decode', async () => {
  await withRoot(async (env) => {
    const complete = await jpeg(1200, 900)
    const bytes = complete.subarray(0, Math.floor(complete.length / 2))
    // The intentional fixture has parsable dimensions but missing pixel payload.
    assert.equal((await sharp(bytes).metadata()).width, 1200)
    const job = await newJob(env, bytes)
    const result = await receive(env, job, bytes)
    assert.ok(result.status >= 400, JSON.stringify(result))
    assert.equal(result.body.code, 'E_MEDIA_IMAGE_INVALID')
    assert.ok(!Object.keys(await tree(env.paths.root)).some((name) => name.startsWith('MediaInbox/') && /\.jpg$/.test(name)))
  })
})

test('RD-07 publication never overwrites a file that appears after destination planning', async () => {
  await withRoot(async (env) => {
    const bytes = await jpeg()
    const job = await newJob(env, bytes)
    const old = Buffer.from('Synthetic competing original; must stay immutable.')
    let racedDestination
    env.deps.prepareV2Upload = async (options) => {
      const plan = await prepareV2Upload(options)
      racedDestination = plan.destination
      await mkdir(path.dirname(racedDestination), { recursive: true })
      await writeFile(racedDestination, old, { flag: 'wx' })
      return plan
    }
    const result = await receive(env, job, bytes)
    assert.ok(result.status >= 400, JSON.stringify(result))
    assert.deepEqual(await readFile(racedDestination), old)
    const before = await tree(env.paths.root)
    assert.equal((await get(env, job.jobId)).body.job.files[0].status, 'needs_review')
    assert.deepEqual(await tree(env.paths.root), before)
  })
})

test('RD-07 drone receipt fixes submitted metadata and detects later sidecar conflicts', async () => {
  await withRoot(async (env) => {
    const bytes = await jpeg(200, 100)
    const metadata = { date: '2026-10-01', lat: 64, lng: -21, altitudeMeters: 60, titleZh: '合成海湾', titleEn: 'Synthetic Bay' }
    const job = await receivedJob(env, bytes, { kind: 'panorama360', files: [{ fileName: 'scene.jpg', bytes: bytes.length, metadata }] })
    assert.equal(job.files[0].status, 'pending', JSON.stringify(job))
    const sidecarPath = path.join(env.paths.inboxRoot, 'Test Country', 'Test City', 'media.json')
    const sidecar = await readJson(sidecarPath)
    assert.equal(sidecar['drone/scene.jpg'].date, metadata.date)
    sidecar['drone/scene.jpg'].date = '2026-10-02'
    await writeFile(sidecarPath, JSON.stringify(sidecar))
    const before = await tree(env.paths.root)
    const result = await get(env, job.jobId)
    assert.equal(result.body.job.files[0].status, 'needs_review')
    assert.deepEqual(await tree(env.paths.root), before)
  })
})


test('RD-07 a separate Node process discovers the received receipt without writes', async () => {
  await withRoot(async (env) => {
    const job = await receivedJob(env, await jpeg())
    const before = await tree(env.paths.root)
    // The other process opens the store read-only (as build:personal does next to the dev server).
    const code = `import {getPrivatePaths} from './scripts/private-profile.mjs';import {mediaJobRoute,handleMediaJobRead} from './scripts/media-job-service.mjs';import {createStoreSession} from './scripts/store-session.mjs';const privatePaths=getPrivatePaths({STARMAP_PRIVATE_ROOT:process.argv[1]});const session=createStoreSession(privatePaths,{log:()=>{},readOnly:true});const result=await handleMediaJobRead({privatePaths,route:mediaJobRoute('GET','${base}/'+process.argv[2]),storeMedia:{mediaStore:await session.mediaStore()}});await session.close();console.log(JSON.stringify(result));`
    const result = await execute(process.execPath, ['--input-type=module', '-e', code, env.paths.root, job.jobId], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
      env: { SystemRoot: process.env.SystemRoot, TEMP: tmpdir() },
      timeout: 15000,
    })
    const response = JSON.parse(result.stdout)
    assert.equal(response.status, 200)
    assert.equal(response.body.job.jobId, job.jobId)
    assert.equal(response.body.job.files[0].status, 'pending')
    assert.deepEqual(await tree(env.paths.root), before)
  })
})

test('RD-07 a published source can be explicitly removed on Windows and then requires review', async () => {
  await withRoot(async (env) => {
    const job = await receivedJob(env, await jpeg())
    const stored = await readJson(jobPath(env, job.jobId))
    await unlink(path.join(env.paths.inboxRoot, ...stored.files[0].sourcePath.split('/')))
    const before = await tree(env.paths.root)
    const result = await get(env, job.jobId)
    assert.equal(result.body.job.files[0].status, 'needs_review')
    assert.deepEqual(await tree(env.paths.root), before)
  })
})

test('RD-07 same-content media owned by another city cannot imply this task completed (3C-4c D2: it is this task\'s own record)', async () => {
  await withRoot(async (env) => {
    const bytes = await jpeg()
    const otherCity = path.join(env.paths.inboxRoot, 'Test Country', 'Other City')
    const otherSource = path.join(otherCity, 'photos', 'existing.jpg')
    await mkdir(path.dirname(otherSource), { recursive: true })
    await writeFile(otherSource, bytes)
    await writeFile(path.join(env.paths.inboxRoot, 'Test Country', 'place.json'), JSON.stringify({ placeId: ID.country }))
    await writeFile(path.join(otherCity, 'place.json'), JSON.stringify({ placeId: ID.otherCity }))
    await withLibraryOperation(env.paths, async (leaseToken) => {
      const imported = await createMediaService({ privatePaths: env.paths, store: env.storeMedia.mediaStore }).importInbox({ requestId: uuidv7(), leaseToken })
      assert.equal(imported.committed, true)
    })
    const registryBefore = env.storeMedia.mediaStore.mediaRegistry()
    const job = await receivedJob(env, bytes)
    // The same content under another city's path is not this task's source: the received file still awaits its import.
    assert.equal(job.files[0].status, 'pending')
    assert.equal(job.canPreview, true)
    assert.deepEqual(await readFile(otherSource), bytes)
    assert.deepEqual(env.storeMedia.mediaStore.mediaRegistry(), registryBefore)
  })
})

test('RD-07 a partially received batch offers only its remaining intended file', async () => {
  await withRoot(async (env) => {
    const first = await jpeg(), second = await jpeg(65, 48)
    const initial = await newJob(env, first, { files: [{ fileName: 'first.jpg', bytes: first.length }, { fileName: 'second.jpg', bytes: second.length }] })
    const received = await receive(env, initial, first)
    assert.equal(received.status, 201, JSON.stringify(received))
    const job = received.body.job
    assert.equal(job.canUpload, false)
    assert.equal(job.files[0].canReceive, false)
    assert.equal(job.files[1].canReceive, true)
    const result = await receive(env, job, second, { fileId: job.files[1].fileId })
    assert.equal(result.status, 201, JSON.stringify(result))
    assert.deepEqual(result.body.job.files.map(file => file.status), ['pending', 'pending'])
  })
})

test('RD-07 explicitly receiving a paused intended file reopens the task without creating another one', async () => {
  await withRoot(async (env) => {
    const bytes = await jpeg()
    const initial = await newJob(env, bytes)
    const paused = await write(env, mediaJobRoute('POST', `${base}/${initial.jobId}/pause`), { input: { libraryId: initial.libraryId, revision: initial.revision } })
    assert.equal(paused.status, 200)
    assert.equal(paused.body.job.paused, true)
    const result = await receive(env, paused.body.job, bytes)
    assert.equal(result.status, 201, JSON.stringify(result))
    assert.equal(result.body.job.jobId, initial.jobId)
    assert.equal(result.body.job.paused, false)
  })
})

test('3C-4d: without the new library (no storeMedia) every task handler answers E_STORE_MIGRATION_REQUIRED and writes nothing', async () => {
  await withRoot(async (env) => {
    const job = await receivedJob(env, await jpeg())
    const before = await tree(env.paths.root, { omitCoordination: true })
    const bare = { paths: env.paths, deps: env.deps }
    const results = [
      await get(bare),
      await get(bare, job.jobId),
      await create(bare, Buffer.alloc(14)),
      await write(bare, mediaJobRoute('POST', `${base}/${job.jobId}/import`), { input: { libraryId: job.libraryId, revision: job.revision, selectedFileIds: [job.files[0].fileId], operationId: uuidv7(), planDigest: 'a'.repeat(64) } }),
      await handleMediaJobPreview({ privatePaths: env.paths, route: mediaJobRoute('POST', `${base}/${job.jobId}/preview`), input: { libraryId: job.libraryId, revision: job.revision, selectedFileIds: [job.files[0].fileId] } }),
    ]
    for (const result of results) {
      assert.equal(result.status, 409, JSON.stringify(result))
      assert.equal(result.body.code, 'E_STORE_MIGRATION_REQUIRED')
    }
    assert.deepEqual(await tree(env.paths.root, { omitCoordination: true }), before)
  })
})

// ---------------------------------------------------------------------------
// 第 1 批 D2：放弃路由
// ---------------------------------------------------------------------------

const abandon = (env, job, input = { libraryId: job.libraryId, revision: job.revision }) => write(env, mediaJobRoute('POST', `${base}/${job.jobId}/abandon`), { input })

test('D2 abandon route is recognized like close and only for POST on a task id', () => {
  const id = randomUUID()
  assert.deepEqual(mediaJobRoute('POST', `${base}/${id}/abandon`), { action: 'abandon', jobId: id })
  assert.equal(mediaJobRoute('GET', `${base}/${id}/abandon`), undefined)
  assert.equal(mediaJobRoute('POST', `${base}/not-a-uuid/abandon`), undefined)
})

test('D2 a task stuck in needs_review can be abandoned; evidence stays and a new task can start', async () => {
  await withRoot(async (env) => {
    const bytes = await jpeg()
    const job = await newJob(env, bytes)
    const request = Readable.from((async function * () { yield bytes.subarray(0, 20); throw new Error('Synthetic transport interruption') })())
    request.headers = { 'content-length': String(bytes.length) }
    assert.ok((await receive(env, job, bytes, { request })).status >= 400)
    const stuck = (await get(env, job.jobId)).body.job
    assert.equal(stuck.files[0].status, 'needs_review')
    assert.equal(stuck.canAbandon, true, 'the recovery center may offer abandon')
    const blocked = await create(env, bytes)
    assert.equal(blocked.body.code, 'E_MEDIA_JOB_PENDING')

    const before = await tree(env.paths.root, { omitCoordination: true })
    const result = await abandon(env, stuck)
    assert.equal(result.status, 200, JSON.stringify(result))
    assert.equal(result.body.job.phase, 'abandoned')
    assert.equal(result.body.job.status, 'abandoned')
    assert.equal(result.body.job.canAbandon, false)
    const after = await tree(env.paths.root, { omitCoordination: true })
    const record = `operations/media-import/v1/jobs/${job.jobId}.json`
    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), 'no file is created or removed')
    for (const name of Object.keys(before)) if (name !== record) assert.equal(after[name], before[name], name)
    assert.notEqual(after[record], before[record])

    const replay = await abandon(env, stuck)
    assert.equal(replay.status, 200)
    assert.equal(replay.body.replayed, true)
    const read = (await get(env)).body
    assert.equal(read.jobs.find((item) => item.jobId === job.jobId).status, 'abandoned')
    const next = await create(env, bytes)
    assert.equal(next.status, 201, JSON.stringify(next))
  })
})

test('D2 abandon checks library identity, revision, body shape and lease; a paused task can be abandoned and receives nothing afterwards', async () => {
  await withRoot(async (env) => {
    const job = await newJob(env, await jpeg())
    const recordBefore = await readFile(jobPath(env, job.jobId))
    for (const [input, code] of [
      [{ libraryId: randomUUID(), revision: job.revision }, 'E_MEDIA_JOB_CONFLICT'],
      [{ libraryId: job.libraryId, revision: job.revision + 1 }, 'E_MEDIA_JOB_CONFLICT'],
      [{ libraryId: job.libraryId, revision: job.revision, extra: true }, 'E_MEDIA_JOB_INVALID'],
    ]) {
      const result = await abandon(env, job, input)
      assert.equal(result.body.ok, false)
      assert.equal(result.body.code, code, JSON.stringify(input))
    }
    assert.deepEqual(await readFile(jobPath(env, job.jobId)), recordBefore)
    const leaseless = await handleMediaJobWrite({ privatePaths: env.paths, deps: env.deps, route: mediaJobRoute('POST', `${base}/${job.jobId}/abandon`), input: { libraryId: job.libraryId, revision: job.revision } })
    assert.equal(leaseless.body.code, 'E_LIBRARY_BUSY', 'like close, abandon requires the caller to hold the library lease')
    assert.deepEqual(await readFile(jobPath(env, job.jobId)), recordBefore)

    const pausedResult = await write(env, mediaJobRoute('POST', `${base}/${job.jobId}/pause`), { input: { libraryId: job.libraryId, revision: job.revision } })
    assert.equal(pausedResult.status, 200, JSON.stringify(pausedResult))
    const paused = (await get(env, job.jobId)).body.job
    assert.equal(paused.canAbandon, true)
    assert.equal((await abandon(env, paused)).body.job.phase, 'abandoned')
    const receiveAfter = await receive(env, paused, await jpeg(), { revision: paused.revision + 1 })
    assert.equal(receiveAfter.body.code, 'E_MEDIA_JOB_REVIEW', 'nothing is received into an abandoned task')
  })
})
