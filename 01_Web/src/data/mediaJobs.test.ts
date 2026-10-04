import {test} from 'node:test'
import assert from 'node:assert/strict'
import {LocalEditorError} from '../i18n/editorErrors.ts'
import {createLocalEditorCoordination} from './localEditorCoordination.ts'
import {assertMediaJob, assertMediaJobsRead, assertMediaJobPreview, createMediaJobs, type MediaJob, type MediaJobPreview, type MediaJobsApi} from './mediaJobs.ts'
import {readMediaJobs, previewMediaJob} from './localEditorApi.ts'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const sha = 'a'.repeat(64)
const file = (name = 'photo.jpg', data = 'image') => new File([data], name, {type: 'image/jpeg'})
const jobOf = (): MediaJob => ({jobId: id(1), libraryId: id(2), countryId: id(3), cityId: id(4), revision: 0,
  kind: 'photo', createdAt: '2026-10-04T00:00:00Z', updatedAt: '2026-10-04T00:00:00Z', phase: 'open', status: 'not_received', paused: false, canImport: false, canUpload: true,
  files: [{fileId: id(5), fileName: 'photo.jpg', bytes: 5, phase: 'intended', status: 'not_received', canReceive: true}],
})
const pending = (): MediaJob => {const job = jobOf(); job.revision = 3; job.status = 'pending'; job.canUpload = false; job.canPreview = true; job.files[0] = {...job.files[0], phase: 'received', status: 'pending', canReceive: false}; return job}
const planOf = (job: MediaJob = pending()): MediaJobPreview => ({jobId: job.jobId, revision: job.revision, selectedFileIds: job.files.filter(item => item.phase === 'received').map(item => item.fileId), blockers: [], plan: {digest: sha, summary: {
  addedIds: ['media-a'], updatedIds: [], removedIds: [], sources: [{id: 'media-a', sourcePath: 'Country/City/photos/photo.jpg', sha256: sha, bytes: 5, kind: 'photo', placeId: id(4)}], pins: [], outputs: [], editorEffects: {restoredMediaIds: ['media-a'], orders: {photos: {[id(4)]: ['media-a']}}},
}}})
const completed = (): MediaJob => ({...pending(), phase: 'completed', status: 'completed', canPreview: false, canClose: true, revision: 10,
  files: pending().files.map(item => ({...item, status: 'completed'})), completion: {operationId: id(9), planDigest: sha, completedAt: '2026-10-04T00:00:00Z', mediaIds: ['media-a'], restoredMediaIds: ['media-a']}, warnings: []})
const fixture = () => {
  let jobs: MediaJob[] = []
  const calls: string[] = []
  const api: MediaJobsApi = {
    read: async () => {calls.push('read'); return {libraryId: jobs[0]?.libraryId ?? null, jobs: structuredClone(jobs)}},
    create: async intent => {calls.push('create'); jobs = [{...jobOf(), files: intent.files.map((item, n) => ({...jobOf().files[0], fileId: id(n + 5), fileName: item.fileName, bytes: item.bytes}))}]; return structuredClone(jobs[0])},
    receive: async (_job, fileId, input) => {calls.push(`receive:${fileId}`); assert.equal(input.revision, jobs[0].revision); jobs[0].revision += 1; jobs[0].status = 'pending'; jobs[0].canUpload = false; jobs[0].canPreview = true; jobs[0].files = jobs[0].files.map(item => item.fileId === fileId ? {...item, status: 'pending', phase: 'received', canReceive: false} : item); return structuredClone(jobs[0])},
    preview: async () => {calls.push('preview'); return planOf(jobs[0])},
    import: async () => {calls.push('import'); jobs = [completed()]; return structuredClone(jobs[0])},
    pause: async () => {calls.push('pause'); jobs[0] = {...jobs[0], phase: 'paused', paused: true, revision: jobs[0].revision + 1}; return structuredClone(jobs[0])},
    close: async () => {calls.push('close'); jobs[0] = {...jobs[0], phase: 'closed', status: 'closed', canClose: false, revision: jobs[0].revision + 1}; return structuredClone(jobs[0])},
  }
  const coordination = createLocalEditorCoordination()
  const store = createMediaJobs({api, coordination, hashFile: async () => sha, operationId: () => id(9)})
  return {api, store, calls, coordination, setJobs: (value: MediaJob[]) => {jobs = value}}
}
const code = (expected: string) => (error: unknown) => error instanceof LocalEditorError && error.code === expected
const deferred = <T>() => {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done}); return {promise, resolve}}

test('upload creates fixed intent and receives each file once; import requires explicit preview and confirmation', async () => {
  const {store, calls} = fixture()
  await store.uploadBatch([{countryId: id(3), cityId: id(4), kind: 'photo', file: file()}])
  assert.deepEqual(calls, ['read', 'create', `receive:${id(5)}`])
  assert.equal(store.getSnapshot().jobs[0].status, 'pending')
  const plan = await store.preview(id(1))
  assert.ok(Object.isFrozen(plan.plan.summary.sources))
  assert.equal(calls.includes('import'), false)
  await store.importJob(id(1), plan)
  assert.equal(store.getSnapshot().jobs[0].phase, 'completed')
  await store.close(id(1))
  assert.equal(store.getSnapshot().jobs[0].phase, 'closed')
})
test('startup discovery is GET only, including completion and paused tasks', async () => {
  const f = fixture(); f.setJobs([{...pending(), phase: 'paused', paused: true}, {...completed(), jobId: id(20)}])
  await f.store.refresh()
  assert.deepEqual(f.calls, ['read'])
  assert.equal(f.store.getSnapshot().jobs.length, 2)
  assert.equal(f.coordination.getSnapshot().target, undefined)
})
test('lost reception response re-reads confirmed task and stops before later files or import', async () => {
  const f = fixture()
  const receive = f.api.receive
  const lost = new TypeError('response lost')
  f.api.receive = async (...args) => {await receive(...args); throw lost}
  await assert.rejects(f.store.uploadBatch([{countryId: id(3), cityId: id(4), kind: 'photo', file: file()}, {countryId: id(3), cityId: id(4), kind: 'photo', file: file('second.jpg')}]), error => error === lost)
  assert.deepEqual(f.calls, ['read', 'create', `receive:${id(5)}`, 'read'])
  assert.equal(f.store.getSnapshot().jobs[0].files[0].status, 'pending')
  assert.equal(f.store.getSnapshot().jobs[0].files[1].status, 'not_received')
  assert.equal(f.store.getSnapshot().error, lost)
  assert.equal(f.coordination.getSnapshot().target, undefined)
})
test('lost import response discovers sealed completion without replaying import', async () => {
  const f = fixture(); f.setJobs([pending()]); await f.store.refresh()
  const plan = await f.store.preview(id(1)); const original = f.api.import
  f.api.import = async (...args) => {await original(...args); throw new TypeError('response lost')}
  await assert.rejects(f.store.importJob(id(1), plan))
  assert.equal(f.calls.filter(item => item === 'import').length, 1)
  assert.equal(f.store.getSnapshot().jobs[0].phase, 'completed')
  assert.equal(f.coordination.getSnapshot().target, undefined)
})
test('missing files require explicit exact filename and byte count; received or mismatched files are refused', async () => {
  const f = fixture(); f.setJobs([jobOf()]); await f.store.refresh()
  await assert.rejects(f.store.receiveMissing(id(1), [file('wrong.jpg')]), code('E_MEDIA_JOB_CONFLICT'))
  await assert.rejects(f.store.receiveMissing(id(1), [file('photo.jpg', 'wrong-size')]), code('E_MEDIA_JOB_CONFLICT'))
  assert.equal(f.calls.some(item => item.startsWith('receive:')), false)
  await f.store.receiveMissing(id(1), [file()])
  await assert.rejects(f.store.receiveMissing(id(1), [file()]), code('E_MEDIA_JOB_CONFLICT'))
  assert.equal(f.calls.filter(item => item.startsWith('receive:')).length, 1)
})
test('whole library unfinished job prevents a new city batch; pause releases ordinary editing only', async () => {
  const f = fixture(); f.setJobs([pending()]); await f.store.refresh()
  await f.store.pause(id(1))
  await f.coordination.withLocalEditorWrite(async () => undefined)
  await assert.rejects(f.store.uploadBatch([{countryId: id(3), cityId: id(50), kind: 'photo', file: file()}]), code('E_MEDIA_JOB_PENDING'))
  assert.equal(f.calls.includes('create'), false)
  assert.equal(f.store.getSnapshot().jobs[0].paused, true)
})
test('task revision changed in another tab invalidates acknowledged preview', async () => {
  const f = fixture(); f.setJobs([pending()]); await f.store.refresh()
  const plan = await f.store.preview(id(1))
  f.setJobs([{...pending(), revision: 4}]); await f.store.refresh()
  assert.equal(f.store.getSnapshot().preview, undefined)
  await assert.rejects(f.store.importJob(id(1), plan), code('E_MEDIA_JOB_CONFLICT'))
  assert.equal(f.calls.includes('import'), false)
})
test('blocked and fabricated preview cannot execute; all received file selection must be explicit', async () => {
  const f = fixture(); f.setJobs([pending()]); await f.store.refresh()
  await assert.rejects(f.store.importJob(id(1), planOf()), code('E_MEDIA_JOB_CONFLICT'))
  f.api.preview = async () => ({...planOf(), blockers: [{code: 'E_MEDIA_PLAN_SCAN'}]})
  const plan = await f.store.preview(id(1))
  await assert.rejects(f.store.importJob(id(1), plan), code('E_MEDIA_JOB_CONFLICT'))
  assert.equal(f.calls.includes('import'), false)
})
test('processing reads retain task evidence and disable actions rather than clearing pending work', async () => {
  const f = fixture(); f.setJobs([pending()]); await f.store.refresh()
  f.api.read = async () => ({libraryId: null, status: 'processing', jobs: []})
  await f.store.refresh()
  assert.equal(f.store.getSnapshot().jobs[0].status, 'pending')
  assert.equal(f.store.getSnapshot().status, 'processing')
  await assert.rejects(f.store.preview(id(1)), code('E_MEDIA_JOB_REVIEW'))
  assert.equal(f.calls.includes('preview'), false)
})
test('read errors preserve known task records and force review', async () => {
  const f = fixture(); f.setJobs([pending()]); await f.store.refresh()
  const error = new TypeError('offline'); f.api.read = async () => {throw error}
  await assert.rejects(f.store.refresh(), failure => failure === error)
  assert.equal(f.store.getSnapshot().jobs.length, 1)
  assert.equal(f.store.getSnapshot().status, 'needs_review')
  assert.equal(f.store.getSnapshot().error, error)
})
test('out-of-order GET completion cannot roll back a newer discovery', async () => {
  const f = fixture(); const old = deferred<{libraryId: string; jobs: MediaJob[]}>()
  let reads = 0; f.api.read = async () => ++reads === 1 ? old.promise : {libraryId: id(2), jobs: [completed()]}
  const first = f.store.refresh(); await f.store.refresh(); old.resolve({libraryId: id(2), jobs: [pending()]}); await first
  assert.equal(f.store.getSnapshot().jobs[0].phase, 'completed')
})
test('active receive blocks ordinary edits and concurrent media actions, then releases runtime lease', async () => {
  const f = fixture(); f.setJobs([jobOf()]); await f.store.refresh()
  const gate = deferred<MediaJob>(); f.api.receive = async () => gate.promise
  const receiving = f.store.receiveMissing(id(1), [file()])
  await new Promise(done => setTimeout(done, 0))
  await assert.rejects(f.coordination.withLocalEditorWrite(async () => undefined), code('E_MEDIA_IMPORT_BUSY'))
  await assert.rejects(f.store.pause(id(1)), code('E_MEDIA_IMPORT_BUSY'))
  gate.resolve(pending()); await receiving
  assert.equal(f.store.getSnapshot().busy, false)
  await f.coordination.withLocalEditorWrite(async () => undefined)
})
test('invalid mixed intents and duplicate filenames never create a task', async () => {
  const f = fixture(); const upload = {countryId: id(3), cityId: id(4), kind: 'photo' as const, file: file()}
  await assert.rejects(f.store.uploadBatch([upload, {...upload, kind: 'aerialPhoto', file: file('drone.jpg')}]), code('E_MEDIA_JOB_INVALID'))
  await assert.rejects(f.store.uploadBatch([upload, {...upload, file: file('PHOTO.jpg')}]), code('E_MEDIA_JOB_INVALID'))
  assert.equal(f.calls.includes('create'), false)
})
test('malformed completed jobs, actionable received files and mismatched library responses fail closed', () => {
  assert.throws(() => assertMediaJob({...completed(), completion: undefined}), code('E_EDITOR_RESPONSE_INVALID'))
  assert.throws(() => assertMediaJob({...pending(), files: [{...pending().files[0], canReceive: true}]}), code('E_EDITOR_RESPONSE_INVALID'))
  assert.throws(() => assertMediaJobsRead({libraryId: id(22), jobs: [pending()]}), code('E_EDITOR_RESPONSE_INVALID'))
  assert.throws(() => assertMediaJobsRead({libraryId: id(2), status: 'processing', jobs: [pending()]}), code('E_EDITOR_RESPONSE_INVALID'))
  const plan = planOf(); plan.plan.summary.sources[0].sourcePath = 'C:/private/photo.jpg'
  assert.throws(() => assertMediaJobPreview(plan), code('E_EDITOR_RESPONSE_INVALID'))
})
test('centralized GET and preview parsers validate actual response envelopes without accepting guessed task facts', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ok: true, libraryId: null, jobs: []}), {status: 200})
    assert.deepEqual(await readMediaJobs(), {libraryId: null, jobs: []})
    globalThis.fetch = async () => new Response(JSON.stringify({ok: true, libraryId: id(2), jobs: [{jobId: id(1)}]}), {status: 200})
    await assert.rejects(readMediaJobs(), code('E_EDITOR_RESPONSE_INVALID'))
    const plan = planOf()
    globalThis.fetch = async () => new Response(JSON.stringify({ok: true, job: {...pending(), canImport: true}, plan: {...plan.plan, selectedFileIds: plan.selectedFileIds, blockers: []}}), {status: 200})
    assert.deepEqual(await previewMediaJob(id(1), {libraryId: id(2), revision: 3, selectedFileIds: [id(5)]}), plan)
    globalThis.fetch = async () => new Response(JSON.stringify({ok: true, job: {...pending(), canImport: false}, plan: {...plan.plan, selectedFileIds: plan.selectedFileIds, blockers: []}}), {status: 200})
    await assert.rejects(previewMediaJob(id(1), {libraryId: id(2), revision: 3, selectedFileIds: [id(5)]}), code('E_EDITOR_RESPONSE_INVALID'))
  } finally {globalThis.fetch = original}
})

test('a valid foreign reception response is rejected before it replaces the selected job', async () => {
  const f = fixture(); f.setJobs([jobOf()]); await f.store.refresh()
  f.api.receive = async () => ({...pending(), cityId: id(88)})
  await assert.rejects(f.store.receiveMissing(id(1), [file()]), code('E_EDITOR_RESPONSE_INVALID'))
  assert.equal(f.store.getSnapshot().jobs[0].cityId, id(4))
  assert.equal(f.store.getSnapshot().jobs[0].files[0].status, 'not_received')
})
test('foreign task creation is not published or received and discovery follows the failed response', async () => {
  const f = fixture(); f.api.create = async () => ({...jobOf(), cityId: id(88)})
  const observed: MediaJob[][] = []; f.store.subscribe(() => observed.push(f.store.getSnapshot().jobs))
  await assert.rejects(f.store.uploadBatch([{countryId: id(3), cityId: id(4), kind: 'photo', file: file()}]), code('E_EDITOR_RESPONSE_INVALID'))
  assert.equal(observed.some(jobs => jobs.some(job => job.cityId === id(88))), false)
  assert.equal(f.calls.some(item => item.startsWith('receive:')), false)
})
test('GET launched during reception cannot overwrite a later confirmed response', async () => {
  const f = fixture(); f.setJobs([jobOf()]); await f.store.refresh()
  const receive = deferred<MediaJob>(); f.api.receive = async () => receive.promise
  const receiving = f.store.receiveMissing(id(1), [file()]); await new Promise(done => setTimeout(done, 0))
  const old = deferred<{libraryId: string; jobs: MediaJob[]}>(); f.api.read = async () => old.promise
  const reading = f.store.refresh(); receive.resolve(pending()); await receiving
  old.resolve({libraryId: id(2), jobs: [jobOf()]}); await reading
  assert.equal(f.store.getSnapshot().jobs[0].status, 'pending')
  assert.equal(f.store.getSnapshot().loading, false)
})
test('malformed JSON and HTTP success with no job never become accepted task success', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response('<html>invalid response</html>', {status: 200})
    await assert.rejects(readMediaJobs(), code('E_EDITOR_RESPONSE_INVALID'))
    globalThis.fetch = async () => new Response(JSON.stringify({ok: true}), {status: 200})
    await assert.rejects(previewMediaJob(id(1), {libraryId: id(2), revision: 3, selectedFileIds: [id(5)]}), code('E_EDITOR_RESPONSE_INVALID'))
    const plan = planOf()
    globalThis.fetch = async () => new Response(JSON.stringify({ok: true, job: {...pending(), jobId: id(99), canImport: true}, plan: {...plan.plan, selectedFileIds: plan.selectedFileIds, blockers: []}}), {status: 200})
    await assert.rejects(previewMediaJob(id(1), {libraryId: id(2), revision: 3, selectedFileIds: [id(5)]}), code('E_EDITOR_RESPONSE_INVALID'))
  } finally {globalThis.fetch = original}
})
