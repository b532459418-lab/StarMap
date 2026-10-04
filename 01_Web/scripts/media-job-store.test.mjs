import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { cp, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assertMediaJobRecord, assertMediaJobsClear, createMediaJobStore, mediaJobReceiptSeal } from './media-job-store.mjs'

const IDs = { countryId: '018bd504-c600-7000-8000-000000000001', cityId: '018bd504-c600-7000-8000-000000000002' }
const input = () => ({ ...IDs, kind: 'photo', files: [{ fileName: 'neutral.jpg', bytes: 32 }] })
const code = (expected) => (error) => error?.code === expected
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'starmap-job-store-'))
  t.after(async () => {
    assert.equal(path.dirname(root), tmpdir())
    assert.ok(path.basename(root).startsWith('starmap-job-store-'))
    await rm(root, { recursive: true, force: true })
  })
  return { root, store: createMediaJobStore({ root }), controls: path.join(root, 'operations', 'media-import', 'v1') }
}
async function inventory(root, prefix = '') {
  const found = []
  for (const item of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, item.name)
    found.push([relative, item.isDirectory() ? 'directory' : createHash('sha256').update(await readFile(path.join(root, relative))).digest('hex')])
    if (item.isDirectory()) found.push(...await inventory(root, relative))
  }
  return found.sort((a, b) => a[0].localeCompare(b[0]))
}
const jobPath = (fixture, job) => path.join(fixture.controls, 'jobs', `${job.jobId}.json`)

test('construction, empty discovery and legacy checks never initialize a library', async (t) => {
  const f = await fixture(t)
  const before = await inventory(f.root)
  assert.deepEqual(await f.store.discover(), { libraryId: null, jobs: [] })
  await assertMediaJobsClear({ root: f.root })
  assert.deepEqual(await inventory(f.root), before)
  assert.deepEqual(await createMediaJobStore({ root: path.join(f.root, 'absent') }).discover(), { libraryId: null, jobs: [] })
  assert.deepEqual(await inventory(f.root), before)
})

test('task survives recreated store; read discovery and pause preserve unrelated source files', async (t) => {
  const f = await fixture(t)
  const source = path.join(f.root, 'neutral-source.jpg')
  await writeFile(source, 'synthetic original bytes')
  const job = await f.store.create(input())
  const before = await inventory(f.root)
  const restored = createMediaJobStore({ root: f.root })
  assert.deepEqual(await restored.read(job.jobId), job)
  const publicState = await restored.discover()
  assert.equal(publicState.libraryId, job.libraryId)
  assert.equal(publicState.jobs[0].revision, 0)
  assert.ok(!JSON.stringify(publicState).includes(f.root))
  assert.ok(!JSON.stringify(publicState).includes('rootBinding'))
  assert.deepEqual(await inventory(f.root), before)
  await assert.rejects(restored.assertClear(), code('E_MEDIA_JOB_PENDING'))
  await assert.rejects(restored.create(input()), code('E_MEDIA_JOB_PENDING'))
  const paused = await restored.pause(job.jobId, 0)
  assert.equal(paused.phase, 'paused')
  assert.equal(paused.revision, 1)
  assert.deepEqual(paused.files, job.files)
  assert.equal(await readFile(source, 'utf8'), 'synthetic original bytes')
  await assert.rejects(restored.assertClear(), code('E_MEDIA_JOB_PENDING'))
})

test('stale revisions, invalid mutation and changed fixed intent never replace task bytes', async (t) => {
  const f = await fixture(t)
  const job = await f.store.create(input())
  await f.store.pause(job.jobId, 0)
  const before = await readFile(jobPath(f, job), 'utf8')
  await assert.rejects(f.store.pause(job.jobId, 0), code('E_MEDIA_JOB_CONFLICT'))
  for (const mutate of [() => null, (value) => ({ ...value, cityId: randomUUID() }), (value) => ({ ...value, files: null }),
    (value) => ({ ...value, phase: 'complete' }), (value) => ({ ...value, files: value.files.map((file) => ({ ...file, bytes: 33 })) })]) {
    await assert.rejects(f.store.update(job.jobId, 1, mutate), code('E_MEDIA_JOB_INVALID'))
    assert.equal(await readFile(jobPath(f, job), 'utf8'), before)
  }
})

test('corrupt, future and malformed known-schema jobs block discovery and creation without repair', async (t) => {
  const f = await fixture(t)
  const job = await f.store.create(input())
  for (const raw of ['{broken', JSON.stringify({ ...job, schemaVersion: 2 }), JSON.stringify({ ...job, files: null }), JSON.stringify({ ...job, libraryId: randomUUID() })]) {
    await writeFile(jobPath(f, job), raw)
    await assert.rejects(f.store.discover(), code('E_MEDIA_JOB_REVIEW'))
    await assert.rejects(f.store.create(input()), code('E_MEDIA_JOB_REVIEW'))
    await assert.rejects(f.store.update(job.jobId, 0, (value) => value), code('E_MEDIA_JOB_REVIEW'))
    assert.equal(await readFile(jobPath(f, job), 'utf8'), raw)
  }
})

test('copied library root retains records but refuses old root-bound identity', async (t) => {
  const a = await fixture(t)
  const b = await fixture(t)
  await a.store.create(input())
  await cp(path.join(a.root, 'operations'), path.join(b.root, 'operations'), { recursive: true })
  const before = await inventory(b.root)
  await assert.rejects(b.store.discover(), code('E_MEDIA_JOB_REVIEW'))
  await assert.rejects(b.store.create(input()), code('E_MEDIA_JOB_REVIEW'))
  assert.deepEqual(await inventory(b.root), before)
})

test('damaged and future identity files are never reset', async (t) => {
  const f = await fixture(t)
  await f.store.create(input())
  const identityPath = path.join(f.controls, 'library.json')
  const original = JSON.parse(await readFile(identityPath, 'utf8'))
  for (const raw of ['null', '{invalid', JSON.stringify({ ...original, schemaVersion: 5 }), JSON.stringify({ ...original, rootBinding: '0'.repeat(64) })]) {
    await writeFile(identityPath, raw)
    await assert.rejects(f.store.discover(), code('E_MEDIA_JOB_REVIEW'))
    await assert.rejects(f.store.create(input()), code('E_MEDIA_JOB_REVIEW'))
    assert.equal(await readFile(identityPath, 'utf8'), raw)
  }
})

test('client paths, reserved device names, duplicates and invalid lengths cannot initialize controls', async (t) => {
  const f = await fixture(t)
  for (const name of ['../x.jpg', '/x.jpg', 'C:\\x.jpg', 'x.jpg:stream', 'nul.jpg', 'COM1', 'COM¹.jpg', 'CONOUT$.jpg', 'x.', 'x ', 'x\0.jpg', 'a/b.jpg', 'a\\b.jpg']) {
    await assert.rejects(f.store.create({ ...input(), files: [{ fileName: name, bytes: 1 }] }), code('E_MEDIA_JOB_INVALID'))
  }
  for (const bytes of [0, -1, 1.1, 250 * 1024 * 1024 + 1, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(f.store.create({ ...input(), files: [{ fileName: 'ok.jpg', bytes }] }), code('E_MEDIA_JOB_INVALID'))
  }
  await assert.rejects(f.store.create({ ...input(), sourcePaths: ['/private/source.jpg'] }), code('E_MEDIA_JOB_INVALID'))
  await assert.rejects(f.store.create({ ...input(), files: [{ fileName: 'A.jpg', bytes: 1 }, { fileName: 'a.jpg', bytes: 1 }] }), code('E_MEDIA_JOB_INVALID'))
  await assert.rejects(f.store.create({ ...input(), files: Array.from({ length: 101 }, (_, index) => ({ fileName: `${index}.jpg`, bytes: 1 })) }), code('E_MEDIA_JOB_INVALID'))
  assert.deepEqual(await inventory(f.root), [])
})

test('control junction refuses writes into outside directory', async (t) => {
  const f = await fixture(t)
  const outside = await fixture(t)
  await symlink(outside.root, path.join(f.root, 'operations'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(f.store.discover(), code('E_MEDIA_JOB_REVIEW'))
  await assert.rejects(f.store.create(input()), code('E_MEDIA_JOB_REVIEW'))
  assert.deepEqual(await inventory(outside.root), [])
})

test('linked task JSON and unrecognized records preserve poison and block writes', async (t) => {
  const f = await fixture(t)
  const job = await f.store.create(input())
  const linked = path.join(f.root, 'copy.json')
  await link(jobPath(f, job), linked)
  await assert.rejects(f.store.read(job.jobId), code('E_MEDIA_JOB_REVIEW'))
  assert.equal(await readFile(linked, 'utf8'), await readFile(jobPath(f, job), 'utf8'))
  await rm(linked)
  await writeFile(path.join(f.controls, 'jobs', 'foreign.json'), '{}')
  await assert.rejects(f.store.discover(), code('E_MEDIA_JOB_REVIEW'))
  await assert.rejects(f.store.create(input()), code('E_MEDIA_JOB_REVIEW'))
})

test('missing identity beside preexisting job data is not silently regenerated', async (t) => {
  const f = await fixture(t)
  await mkdir(path.join(f.controls, 'jobs'), { recursive: true })
  const before = await inventory(f.root)
  await assert.rejects(f.store.create(input()), code('E_MEDIA_JOB_REVIEW'))
  assert.deepEqual(await inventory(f.root), before)
})

test('task and file IDs remain fixed across validated receive stages with immutable metadata', async (t) => {
  const f = await fixture(t)
  const metadata = { date: '2026-10-04', titleZh: '合成影像', titleEn: 'Synthetic still', lat: 1, lng: 2 }
  const job = await f.store.create({ ...input(), kind: 'aerialPhoto', files: [{ fileName: 'neutral.jpg', bytes: 32, metadata }] })
  const operationId = randomUUID()
  const hash = createHash('sha256').update('synthetic content').digest('hex')
  const receiving = await f.store.update(job.jobId, 0, (value) => ({ ...value, files: value.files.map((file) => ({ ...file, phase: 'receiving', operationId, sourcePath: 'Country/City/drone/neutral.jpg', expectedSha256: hash })) }))
  const staged = await f.store.update(job.jobId, 1, (value) => ({ ...value, files: value.files.map((file) => ({ ...file, phase: 'staged', sha256: hash, receivedBytes: 32, image: { width: 64, height: 32, format: 'jpeg' } })) }))
  const received = await f.store.update(job.jobId, 2, (value) => ({ ...value, files: value.files.map((file) => ({ ...file, phase: 'received' })) }))
  assert.equal(receiving.files[0].operationId, operationId)
  assert.equal(staged.files[0].fileId, job.files[0].fileId)
  assert.equal(received.files[0].sha256, hash)
  assert.deepEqual(received.files[0].metadata, metadata)
  const raw = await readFile(jobPath(f, job), 'utf8')
  await assert.rejects(f.store.update(job.jobId, 3, (value) => ({ ...value, files: value.files.map((file) => ({ ...file, metadata: { ...file.metadata, titleEn: 'changed' } })) })), code('E_MEDIA_JOB_INVALID'))
  await assert.rejects(f.store.update(job.jobId, 3, (value) => ({ ...value, files: value.files.map((file) => ({ ...file, sourcePath: '../outside.jpg' })) })), code('E_MEDIA_JOB_INVALID'))
  await assert.rejects(f.store.update(job.jobId, 3, (value) => ({ ...value, files: value.files.map((file) => ({ ...file, expectedSha256: '0'.repeat(64) })) })), code('E_MEDIA_JOB_INVALID'))
  await assert.rejects(f.store.update(job.jobId, 3, (value) => ({ ...value, files: value.files.map((file) => ({ ...file, operationId: randomUUID() })) })), code('E_MEDIA_JOB_INVALID'))
  await assert.rejects(f.store.update(job.jobId, 3, (value) => ({ ...value, files: value.files.map((file) => ({ ...file, phase: 'receiving' })) })), code('E_MEDIA_JOB_INVALID'))
  assert.equal(await readFile(jobPath(f, job), 'utf8'), raw)
  assert.ok(!JSON.stringify(await f.store.discover()).includes('sourcePath'))
})

test('malformed drone date cannot throw or initialize task controls', async (t) => {
  const f = await fixture(t)
  for (const date of ['2026-99-01', '2026-02-31', '', null]) {
    await assert.rejects(f.store.create({ ...input(), kind: 'panorama360', files: [{ fileName: 'neutral.jpg', bytes: 32, metadata: { date, titleZh: '', titleEn: '' } }] }), code('E_MEDIA_JOB_INVALID'))
  }
  assert.deepEqual(await inventory(f.root), [])
})

test('derived staging directory is allowed without reading or modifying payload bytes', async (t) => {
  const f = await fixture(t)
  const job = await f.store.create(input())
  const staging = path.join(f.controls, 'staging', job.jobId)
  await mkdir(staging, { recursive: true })
  await writeFile(path.join(staging, 'synthetic.bin'), 'temporary synthetic payload')
  const before = await inventory(f.root)
  assert.equal((await f.store.discover()).jobs[0].jobId, job.jobId)
  await f.store.pause(job.jobId, 0)
  assert.equal(await readFile(path.join(staging, 'synthetic.bin'), 'utf8'), 'temporary synthetic payload')
  const after = await inventory(f.root)
  assert.deepEqual(after.filter(([name]) => name !== path.relative(f.root, jobPath(f, job))), before.filter(([name]) => name !== path.relative(f.root, jobPath(f, job))))
})

async function receivedJob(f, count = 1) {
  let job = await f.store.create({ ...input(), files: Array.from({ length: count }, (_, index) => ({ fileName: `neutral-${index}.jpg`, bytes: 32 })) })
  job = await f.store.update(job.jobId, job.revision, (value) => ({ ...value, files: value.files.map((file) => ({ ...file,
    phase: 'receiving', operationId: randomUUID(), sourcePath: `Country/City/photos/${file.fileName}`, expectedSha256: '1'.repeat(64) })) }))
  job = await f.store.update(job.jobId, job.revision, (value) => ({ ...value, files: value.files.map((file) => ({ ...file,
    phase: 'staged', sha256: file.expectedSha256, receivedBytes: file.bytes, image: { width: 64, height: 32, format: 'jpeg' } })) }))
  return f.store.update(job.jobId, job.revision, (value) => ({ ...value, files: value.files.map((file) => ({ ...file, phase: 'received' })) }))
}
async function startImport(f, job, selectedFileIds = job.files.map((file) => file.fileId)) {
  return f.store.update(job.jobId, job.revision, (value) => ({ ...value, phase: 'open', import: {
    operationId: randomUUID(), planDigest: '2'.repeat(64), sourceRevision: value.revision, selectedFileIds, phase: 'started',
  } }))
}
const nextImport = (f, job, phase) => f.store.update(job.jobId, job.revision, (value) => ({ ...value, import: { ...value.import, phase } }))
function receiptFor(job, extras = {}) {
  const receipt = { completedAt: new Date().toISOString(), mediaIds: ['media-neutral'], restoredMediaIds: [],
    outputs: [{ path: 'data/v2/media.local.json', sha256: '3'.repeat(64), bytes: 64 }], ...extras }
  return { ...receipt, seal: mediaJobReceiptSeal(job, job.import, receipt) }
}
async function beforeSeal(f, job) {
  for (const phase of ['generated', 'pins', 'catalog', 'index', 'editor']) job = await nextImport(f, job, phase)
  return job
}
const finishImport = (f, job, receipt = receiptFor(job)) => f.store.update(job.jobId, job.revision,
  (value) => ({ ...value, phase: 'completed', import: { ...value.import, phase: 'sealed', receipt } }))

test('sealed completion and close persist while allowing a new task without rewriting history', async (t) => {
  const f = await fixture(t)
  let job = await receivedJob(f)
  job = await startImport(f, job)
  assert.equal(job.import.sourceRevision, 3)
  job = await beforeSeal(f, job)
  job = await finishImport(f, job, receiptFor(job, { restoredMediaIds: ['media-neutral'] }))
  assert.equal(job.phase, 'completed')
  const completedBytes = await readFile(jobPath(f, job))
  await f.store.assertClear()
  const recovered = createMediaJobStore({ root: f.root })
  assert.deepEqual(await recovered.read(job.jobId), job)
  const discoveryBefore = await inventory(f.root)
  const summary = (await recovered.discover()).jobs[0]
  assert.equal(summary.import.phase, 'sealed')
  assert.deepEqual(summary.import.mediaIds, ['media-neutral'])
  assert.equal(summary.import.completedAt, job.import.receipt.completedAt)
  assert.ok(!JSON.stringify(summary).includes('data/v2/media.local.json'))
  assert.ok(!JSON.stringify(summary).includes('planDigest'))
  assert.deepEqual(await inventory(f.root), discoveryBefore)
  const second = await recovered.create(input())
  assert.equal(second.libraryId, job.libraryId)
  assert.deepEqual(await readFile(jobPath(f, job)), completedBytes)
  await assert.rejects(recovered.assertClear(), code('E_MEDIA_JOB_PENDING'))
  const closed = await recovered.close(job.jobId, job.revision)
  assert.equal(closed.phase, 'closed')
  assert.deepEqual(closed.import.receipt, job.import.receipt)
  const beforeDuplicate = await inventory(f.root)
  assert.deepEqual(await recovered.close(job.jobId, job.revision), closed)
  assert.deepEqual(await inventory(f.root), beforeDuplicate)
})

test('import selection and initial revision cannot be guessed, duplicated or bypass receiving', async (t) => {
  const f = await fixture(t)
  const job = await receivedJob(f, 2)
  const valid = { operationId: randomUUID(), planDigest: '2'.repeat(64), sourceRevision: job.revision,
    selectedFileIds: [job.files[0].fileId], phase: 'started' }
  const before = await readFile(jobPath(f, job))
  for (const record of [{ ...valid, selectedFileIds: [] }, { ...valid, selectedFileIds: [randomUUID()] },
    { ...valid, selectedFileIds: [job.files[0].fileId, job.files[0].fileId] }, { ...valid, sourceRevision: job.revision - 1 },
    { ...valid, operationId: 'not-an-id' }, { ...valid, phase: 'generated' }, { ...valid, receipt: {} }, { ...valid, unknown: true }]) {
    await assert.rejects(f.store.update(job.jobId, job.revision, (value) => ({ ...value, import: record })), code('E_MEDIA_JOB_INVALID'))
    assert.deepEqual(await readFile(jobPath(f, job)), before)
  }
  const started = await startImport(f, job, [job.files[1].fileId])
  assert.deepEqual(started.import.selectedFileIds, [job.files[1].fileId])
  const g = await fixture(t)
  const intended = await g.store.create(input())
  await assert.rejects(startImport(g, intended), code('E_MEDIA_JOB_INVALID'))
})

test('started import freezes received-file state and operation identity and prevents pause or close', async (t) => {
  const f = await fixture(t)
  let job = await startImport(f, await receivedJob(f, 2))
  const before = await readFile(jobPath(f, job))
  for (const mutate of [(value) => ({ ...value, import: undefined }), (value) => ({ ...value, phase: 'paused' }),
    (value) => ({ ...value, import: { ...value.import, operationId: randomUUID() } }),
    (value) => ({ ...value, import: { ...value.import, planDigest: '4'.repeat(64) } }),
    (value) => ({ ...value, import: { ...value.import, sourceRevision: 0 } }),
    (value) => ({ ...value, import: { ...value.import, selectedFileIds: value.import.selectedFileIds.toReversed() } }),
    (value) => ({ ...value, files: value.files.map((file) => ({ ...file, phase: 'needs_review' })) })]) {
    await assert.rejects(f.store.update(job.jobId, job.revision, mutate), code('E_MEDIA_JOB_INVALID'))
    assert.deepEqual(await readFile(jobPath(f, job)), before)
  }
  await assert.rejects(f.store.pause(job.jobId, job.revision), code('E_MEDIA_JOB_INVALID'))
  await assert.rejects(f.store.close(job.jobId, job.revision), code('E_MEDIA_JOB_INVALID'))
  await assert.rejects(nextImport(f, job, 'index'), code('E_MEDIA_JOB_INVALID'))
  job = await nextImport(f, job, 'generated')
  await assert.rejects(nextImport(f, job, 'started'), code('E_MEDIA_JOB_INVALID'))
  await assert.rejects(nextImport(f, job, 'catalog'), code('E_MEDIA_JOB_INVALID'))
  await assert.rejects(f.store.create(input()), code('E_MEDIA_JOB_PENDING'))
})

test('failed import remains uncertain across restart and cannot become retryable or completed', async (t) => {
  const f = await fixture(t)
  let job = await startImport(f, await receivedJob(f))
  job = await nextImport(f, job, 'generated')
  job = await nextImport(f, job, 'needs_review')
  assert.deepEqual(await createMediaJobStore({ root: f.root }).read(job.jobId), job)
  const before = await readFile(jobPath(f, job))
  for (const phase of ['started', 'generated', 'pins', 'sealed']) await assert.rejects(nextImport(f, job, phase), code('E_MEDIA_JOB_INVALID'))
  await assert.rejects(finishImport(f, job), code('E_MEDIA_JOB_INVALID'))
  await assert.rejects(f.store.create(input()), code('E_MEDIA_JOB_PENDING'))
  await assert.rejects(f.store.assertClear(), code('E_MEDIA_JOB_PENDING'))
  await assert.rejects(f.store.close(job.jobId, job.revision), code('E_MEDIA_JOB_INVALID'))
  assert.deepEqual(await readFile(jobPath(f, job)), before)
})

test('completion receipt rejects malformed identities, duplicate outputs and unsafe paths without writes', async (t) => {
  const f = await fixture(t)
  const job = await beforeSeal(f, await startImport(f, await receivedJob(f)))
  const before = await readFile(jobPath(f, job))
  const output = { path: 'media/user/neutral/original.jpg', sha256: '3'.repeat(64), bytes: 32 }
  for (const extras of [{ mediaIds: [] }, { mediaIds: ['same', 'same'] }, { mediaIds: ['../outside'] },
    { restoredMediaIds: ['missing'] }, { restoredMediaIds: ['media-neutral', 'media-neutral'] },
    { outputs: [] }, { outputs: [output, output] }, { outputs: [output, { ...output, path: output.path.toUpperCase() }] },
    { outputs: [{ ...output, path: '../source.jpg' }] }, { outputs: [{ ...output, path: 'C:/source.jpg' }] },
    { outputs: [{ ...output, path: 'media/user/nul.jpg' }] }, { outputs: [{ ...output, sha256: 'invalid' }] },
    { outputs: [{ ...output, bytes: -1 }] }, { outputs: [{ ...output, unknown: true }] },
    { completedAt: 'bad-date' }, { unexpected: true }]) {
    await assert.rejects(finishImport(f, job, receiptFor(job, extras)), code('E_MEDIA_JOB_INVALID'))
    assert.deepEqual(await readFile(jobPath(f, job)), before)
  }
  const receipt = receiptFor(job)
  await assert.rejects(finishImport(f, job, { ...receipt, seal: '0'.repeat(64) }), code('E_MEDIA_JOB_INVALID'))
  await assert.rejects(f.store.update(job.jobId, job.revision, (value) => ({ ...value, import: { ...value.import, phase: 'sealed', receipt } })), code('E_MEDIA_JOB_INVALID'))
  await assert.rejects(f.store.update(job.jobId, job.revision, (value) => ({ ...value, phase: 'completed' })), code('E_MEDIA_JOB_INVALID'))
  assert.deepEqual(await readFile(jobPath(f, job)), before)
})

test('seal is canonical and binds operation, source identity and output content evidence', async (t) => {
  const f = await fixture(t)
  const job = await beforeSeal(f, await startImport(f, await receivedJob(f)))
  const receipt = receiptFor(job)
  const reordered = Object.fromEntries(Object.entries(receipt).reverse())
  reordered.outputs = receipt.outputs.map((output) => Object.fromEntries(Object.entries(output).reverse()))
  assert.equal(mediaJobReceiptSeal(job, job.import, reordered), receipt.seal)
  for (const [source, record, body] of [
    [{ ...job, jobId: randomUUID() }, job.import, receipt],
    [job, { ...job.import, operationId: randomUUID() }, receipt],
    [{ ...job, files: job.files.map((file) => ({ ...file, sha256: '4'.repeat(64) })) }, job.import, receipt],
    [job, job.import, { ...receipt, outputs: receipt.outputs.map((output) => ({ ...output, sha256: '4'.repeat(64) })) }],
  ]) assert.notEqual(mediaJobReceiptSeal(source, record, body), receipt.seal)
})

test('sealed receipt corruption is preserved and blocks reads, new tasks and bypass writes', async (t) => {
  const f = await fixture(t)
  const job = await finishImport(f, await beforeSeal(f, await startImport(f, await receivedJob(f))))
  const original = await readFile(jobPath(f, job))
  const variants = [{ ...job, import: undefined }, { ...job, import: { ...job.import, receipt: undefined } },
    { ...job, import: { ...job.import, phase: 'editor' } }, { ...job, phase: 'open' },
    { ...job, import: { ...job.import, receipt: { ...job.import.receipt, seal: '0'.repeat(64) } } },
    { ...job, import: { ...job.import, sourceRevision: job.revision + 1 } },
    { ...job, import: { ...job.import, futureField: true } }]
  for (const value of variants) {
    const raw = JSON.stringify(value)
    await writeFile(jobPath(f, job), raw)
    await assert.rejects(f.store.discover(), code('E_MEDIA_JOB_REVIEW'))
    await assert.rejects(f.store.assertClear(), code('E_MEDIA_JOB_REVIEW'))
    await assert.rejects(f.store.create(input()), code('E_MEDIA_JOB_REVIEW'))
    await assert.rejects(f.store.close(job.jobId, job.revision), code('E_MEDIA_JOB_REVIEW'))
    assert.equal(await readFile(jobPath(f, job), 'utf8'), raw)
  }
  await writeFile(jobPath(f, job), original)
  assert.deepEqual(await f.store.read(job.jobId), job)
})

test('completed and closed receipt and files cannot be changed or reopened through the mutator', async (t) => {
  const f = await fixture(t)
  let job = await finishImport(f, await beforeSeal(f, await startImport(f, await receivedJob(f))))
  for (const phase of ['completed', 'closed']) {
    if (phase === 'closed') job = await f.store.close(job.jobId, job.revision)
    const before = await readFile(jobPath(f, job))
    for (const mutate of [(value) => ({ ...value, phase: 'open' }), (value) => ({ ...value, phase: 'paused' }),
      (value) => ({ ...value, files: value.files.map((file) => ({ ...file, phase: 'needs_review' })) }),
      (value) => ({ ...value, import: undefined }),
      (value) => { const receipt = receiptFor(value, { mediaIds: ['different'] }); return { ...value, import: { ...value.import, receipt } } },
    ]) {
      await assert.rejects(f.store.update(job.jobId, job.revision, mutate), code('E_MEDIA_JOB_INVALID'))
      assert.deepEqual(await readFile(jobPath(f, job)), before)
    }
    await f.store.assertClear()
  }
})

test('whole-Inbox receipt permits more than task file cap without rewriting previous history', async (t) => {
  const f = await fixture(t)
  const job = await beforeSeal(f, await startImport(f, await receivedJob(f)))
  const mediaIds = Array.from({ length: 101 }, (_, index) => `synthetic-media-${index}`)
  const outputs = Array.from({ length: 2001 }, (_, index) => ({ path: `media/user/synthetic-${index}/original.jpg`, sha256: '3'.repeat(64), bytes: 32 }))
  const completed = await finishImport(f, job, receiptFor(job, { mediaIds, outputs }))
  assert.equal(completed.import.receipt.outputs.length, 2001)
  assert.equal(completed.import.receipt.mediaIds.length, 101)
  assert.deepEqual(await createMediaJobStore({ root: f.root }).read(job.jobId), completed)
})

test('oversized UTF-8 sealed receipt is refused before temporary file creation preserving complete old record', async (t) => {
  const f = await fixture(t)
  const job = await beforeSeal(f, await startImport(f, await receivedJob(f)))
  const outputs = Array.from({ length: 1100 }, (_, index) => ({
    path: `media/user/${'合'.repeat(190)}/${'成'.repeat(190)}/synthetic-${index}.jpg`, sha256: '3'.repeat(64), bytes: 32,
  }))
  const receipt = receiptFor(job, { outputs })
  assert.ok(Buffer.byteLength(JSON.stringify(receipt, null, 2), 'utf8') > 1024 * 1024)
  const before = await inventory(f.root)
  assert.throws(() => assertMediaJobRecord({ ...job, phase: 'completed', import: { ...job.import, phase: 'sealed', receipt } }), code('E_MEDIA_JOB_INVALID'))
  assertMediaJobRecord(job)
  assert.deepEqual(await inventory(f.root), before)
  await assert.rejects(finishImport(f, job, receipt), code('E_MEDIA_JOB_INVALID'))
  assert.deepEqual(await inventory(f.root), before)
  assert.deepEqual(await f.store.read(job.jobId), job)
  assert.equal((await readdir(path.dirname(jobPath(f, job)))).filter((name) => name.endsWith('.tmp')).length, 0)
})
