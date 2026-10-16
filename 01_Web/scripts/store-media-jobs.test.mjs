/**
 * Media tasks in the new-library mode (3C-4c, design v2 §6; review §8-3), through the plugin on a migrated synthetic
 * library (./store-media.fixture.mjs): a task is created, its files received, previewed and imported.
 *
 * - A task's file is an explicit addition: a new record (UUIDv7 asset id) at the end of its city order, one store commit
 *   whose request id is the task's operation id, named by the sealed receipt; the page's validators accept the preview.
 * - R17 on the task chain: a task's file with the content of a file that went missing is a new record, not a move (the
 *   same bytes put back by hand are a move); right after the import the task's Inbox file can be rewritten (its
 *   reception decoded it: libvips keeps no file open).
 * - An operation id that is not UUIDv7 is E_STALE; a change after the preview is E_MEDIA_JOB_CONFLICT; source matches
 *   need acceptSourceMatches (409 E_MEDIA_SOURCE_MATCHES_UNCONFIRMED); a received file another import took meanwhile
 *   needs review.
 */
import assert from 'node:assert/strict'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import { withLibraryOperation } from './library-operation-lock.mjs'
import { COLOR, PLACE, imageBytes, inboxFile } from './media-inbox.fixture.mjs'
import { createMediaJobStore } from './media-job-store.mjs'
import { createMediaService, handleMediaStore } from './media-service.mjs'
import { storeFileOf } from './private-data-source.mjs'
import { openStore } from './store-host.mjs'
import { UUID_V7, servedLibrary, sha256Of } from './store-media.fixture.mjs'
import { pathKeyOf } from './store-media-registry.mjs'
import { authorizedHeaders, editorPrefix, requestTo } from './store-mode.fixture.mjs'
import { uuidv7 } from '../src/data/canonical/uuidv7.ts'
import { assertMediaJob, assertMediaJobPreview } from '../src/data/mediaJobs.ts'
import { OFFICIAL_POLICY } from '../src/data/store/officialDefinitions.ts'

/** Create a task for `files` ({ fileName, content }) and receive each one; resolves the task as the server returns it. */
async function receivedTask(library, files, { countryId = PLACE.synthland, cityId = PLACE.harbor, kind = 'photo' } = {}) {
  const created = await library.post('media/jobs', { countryId, cityId, kind, files: files.map(({ fileName, content }) => ({ fileName, bytes: content.length })) })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  let job = created.body.job
  for (const { fileName, content } of files) {
    const intent = job.files.find((item) => item.fileName === fileName)
    const query = new URLSearchParams({ libraryId: job.libraryId, revision: String(job.revision), operationId: uuidv7(), sha256: sha256Of(content) })
    const received = await requestTo(library.handler, {
      url: `${editorPrefix}media/jobs/${job.jobId}/files/${intent.fileId}?${query}`, content,
      headers: { ...authorizedHeaders, 'content-length': String(content.length) },
    })
    assert.equal(received.status, 201, JSON.stringify(received.body))
    job = received.body.job
  }
  assertMediaJob(job)
  return job
}
const selection = (job) => job.files.filter((file) => file.phase === 'received').map((file) => file.fileId).sort()
/** The preview as the page reads it (localEditorApi previewMediaJob), checked by the page's validator. */
async function previewOf(library, job) {
  const response = await library.post(`media/jobs/${job.jobId}/preview`, { libraryId: job.libraryId, revision: job.revision, selectedFileIds: selection(job) })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assertMediaJob(response.body.job)
  const { plan } = response.body
  const preview = { jobId: job.jobId, revision: response.body.job.revision, plan: { digest: plan.digest, summary: plan.summary }, selectedFileIds: plan.selectedFileIds, blockers: plan.blockers }
  assertMediaJobPreview(preview)
  assert.equal(response.body.job.canImport, preview.blockers.length === 0)
  return preview
}
const importOf = (library, job, preview, extra = {}) => library.post(`media/jobs/${job.jobId}/import`, {
  libraryId: job.libraryId, revision: job.revision, selectedFileIds: preview.selectedFileIds, operationId: uuidv7(), planDigest: preview.plan.digest, ...extra,
})

test('a task in the new library: its file is a new record at the end of its city order; the receipt names the store commit', async (t) => {
  const library = await servedLibrary(t, 'starmap-store-media-task-')
  const before = await library.reading()
  const content = await imageBytes({ color: COLOR.purple })
  const job = await receivedTask(library, [{ fileName: 'task-photo.jpg', content }])
  assert.equal(job.status, 'pending')
  assert.equal((await library.reading()).revision, 1, 'a reception commits nothing')
  const preview = await previewOf(library, job)
  const { summary } = preview.plan
  assert.deepEqual(preview.blockers, [])
  assert.deepEqual(summary.addedIds, ['new-1'])
  assert.deepEqual([summary.updatedIds, summary.removedIds, summary.sourceMatches, summary.pins, summary.missing], [[], [], [], [], 0])
  assert.deepEqual(summary.editorEffects.restoredMediaIds, ['new-1'])
  assert.equal(summary.editorEffects.orders.photos[PLACE.harbor].at(-1), 'new-1')
  assert.ok(summary.outputs.some((output) => output.sha256 === sha256Of(content) && output.path.endsWith('/original.jpg')))
  assert.ok(summary.outputs.filter((output) => output.sha256 === null).length >= 2, 'derivatives are generated at import')
  assert.equal((await library.reading()).revision, 1, 'a preview writes nothing')

  const operationId = uuidv7()
  const imported = await library.post(`media/jobs/${job.jobId}/import`, {
    libraryId: job.libraryId, revision: job.revision, selectedFileIds: preview.selectedFileIds, operationId, planDigest: preview.plan.digest,
  })
  assert.equal(imported.status, 200, JSON.stringify(imported.body))
  const completed = imported.body.job
  assertMediaJob(completed)
  assert.equal(completed.phase, 'completed')
  const [mediaId] = completed.completion.mediaIds
  assert.match(mediaId, UUID_V7)
  assert.deepEqual(completed.completion.restoredMediaIds, [mediaId])
  const after = await library.reading()
  assert.equal(after.revision, 2)
  assert.equal(after.files.media.items.length, before.files.media.items.length + 1)
  assert.equal(after.files.media.items.find((item) => item.id === mediaId).placeId, PLACE.harbor)
  assert.equal(after.files.editorState.mediaOrderByCity[PLACE.harbor].at(-1), mediaId)

  const record = await createMediaJobStore(library.paths).read(job.jobId)
  assert.equal(record.import.phase, 'sealed')
  assert.deepEqual(record.import.receipt.store, { requestId: operationId, revision: 2 })
  const sourcePath = `MediaInbox/${record.files[0].sourcePath}`
  const outputs = record.import.receipt.outputs.map((output) => output.path)
  assert.ok(outputs.includes(sourcePath))
  assert.ok(outputs.some((output) => output.startsWith('media/user/') && output.endsWith('/original.jpg')))
  assert.ok(outputs.every((output) => !output.startsWith('data/')), 'no V2 file is part of a store receipt')
  assert.equal(await library.assetAt(sourcePath), mediaId)
  const registry = await library.registry()
  assert.deepEqual(registry.problems, [])

  // The task list: completed, nothing changed since.
  const list = await requestTo(library.handler, { url: `${editorPrefix}media/jobs`, method: 'GET' })
  assert.equal(list.status, 200)
  const listed = list.body.jobs.find((item) => item.jobId === job.jobId)
  assert.equal(listed.status, 'completed')
  assert.deepEqual(listed.warnings, [])
  // The same import again: the sealed receipt.
  const replay = await library.post(`media/jobs/${job.jobId}/import`, {
    libraryId: job.libraryId, revision: job.revision, selectedFileIds: preview.selectedFileIds, operationId, planDigest: preview.plan.digest,
  })
  assert.equal(replay.status, 200, JSON.stringify(replay.body))
  assert.equal(replay.body.replayed, true)
  assert.equal((await library.reading()).revision, 2)
})

test('R17 on the task chain: a missing file\'s content received by a task is a new record, not a move; the task\'s Inbox file can be rewritten right after', async (t) => {
  const library = await servedLibrary(t, 'starmap-store-media-task-r17-')
  const { paths, inbox } = library
  const bytes = await readFile(inboxFile(paths, inbox.b))
  const oldAsset = await library.assetAt(inbox.b)
  const oldSource = (await library.registry()).sources.find((source) => source.pathKey === pathKeyOf(inbox.b))
  await unlink(inboxFile(paths, inbox.b))
  const job = await receivedTask(library, [{ fileName: 'b-by-task.jpg', content: bytes }])
  const preview = await previewOf(library, job)
  // Without the task the scan would pair this file with b's source (a move); a task's file is explicit.
  assert.deepEqual(preview.plan.summary.addedIds, ['new-1'])
  assert.deepEqual(preview.plan.summary.updatedIds, [])
  assert.equal(preview.plan.summary.missing, 1, 'b.jpg is marked missing')
  assert.ok(preview.plan.summary.outputs.length === 0, 'the content has its generated files already')
  const imported = await importOf(library, job, preview)
  assert.equal(imported.status, 200, JSON.stringify(imported.body))
  const [mediaId] = imported.body.job.completion.mediaIds
  assert.notEqual(mediaId, oldAsset)
  const record = await createMediaJobStore(paths).read(job.jobId)
  const taskFile = inboxFile(paths, `MediaInbox/${record.files[0].sourcePath}`)
  // The reception decoded this file fully and the import read its header: libvips must have released it.
  await writeFile(taskFile, await imageBytes({ color: COLOR.grey }))
  await writeFile(taskFile, bytes)
  const registry = await library.registry()
  assert.equal(registry.sources.find((source) => source.seq === oldSource.seq).state, 'missing')
  assert.notEqual(registry.sources.find((source) => source.pathKey === pathKeyOf(`MediaInbox/${record.files[0].sourcePath}`)).recordId, oldSource.recordId)

  // Contrast: the same bytes put back by hand are b's record moving (no new record).
  const count = (await library.reading()).files.media.items.length
  const byHand = 'MediaInbox/Synthland/Harbor Town/photos/b-back.jpg'
  await writeFile(inboxFile(paths, byHand), bytes)
  const revision = (await library.reading()).revision
  const moved = await library.write('import', {}, revision)
  assert.equal(moved.status, 200, JSON.stringify(moved.body))
  assert.equal(await library.assetAt(byHand), oldAsset)
  assert.equal((await library.reading()).files.media.items.length, count)
})

test('task imports in the new library: a v4 operation id is E_STALE; a change after the preview is E_MEDIA_JOB_CONFLICT; source matches need confirming', async (t) => {
  const library = await servedLibrary(t, 'starmap-store-media-task-checks-')
  const { paths, inbox } = library
  const job = await receivedTask(library, [{ fileName: 'checks.jpg', content: await imageBytes({ color: COLOR.yellow }) }])
  let preview = await previewOf(library, job)

  const stale = await importOf(library, job, preview, { operationId: '018bd504-c600-4000-8000-000000000001' })
  assert.equal(stale.status, 409, JSON.stringify(stale.body))
  assert.equal(stale.body.code, 'E_STALE')
  assert.equal((await createMediaJobStore(paths).read(job.jobId)).import, undefined, 'the task record is unchanged')

  // A file moved by hand after the preview: the plan is not the one previewed.
  await rename(inboxFile(paths, inbox.c), inboxFile(paths, 'MediaInbox/Synthland/Hill Town/photos/c-renamed.jpg'))
  const conflict = await importOf(library, job, preview)
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body))
  assert.equal(conflict.body.code, 'E_MEDIA_JOB_CONFLICT')
  assert.equal((await library.reading()).revision, 1)

  // A file replaced at its path: a source match to confirm.
  await writeFile(inboxFile(paths, inbox.a), await imageBytes({ color: COLOR.green, width: 80 }))
  preview = await previewOf(library, job)
  assert.deepEqual(preview.plan.summary.sourceMatches, [{ sourcePath: 'Synthland/Harbor Town/photos/a.jpg', kind: 'replaced', proposal: 'new' }])
  assert.deepEqual(preview.plan.summary.updatedIds.length, 1, 'c.jpg moved')
  const unconfirmed = await importOf(library, job, preview)
  assert.equal(unconfirmed.status, 409, JSON.stringify(unconfirmed.body))
  assert.equal(unconfirmed.body.code, 'E_MEDIA_SOURCE_MATCHES_UNCONFIRMED')
  assert.equal((await createMediaJobStore(paths).read(job.jobId)).import, undefined)
  const confirmed = await importOf(library, job, preview, { acceptSourceMatches: true })
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body))
  assert.equal(confirmed.body.job.phase, 'completed')
  assert.deepEqual((await library.registry()).problems, [])
})

test('a received file another import took meanwhile needs review: no preview, no import', async (t) => {
  const library = await servedLibrary(t, 'starmap-store-media-task-review-')
  const { paths } = library
  const job = await receivedTask(library, [{ fileName: 'taken.jpg', content: await imageBytes({ color: COLOR.red, width: 70 }) }])
  // Every import path refuses while a task is open, so this stands for an import that committed while its task record
  // could not follow: the media service run directly, under the lease, with the dev server's store closed.
  const open = await library.post('import', {})
  assert.equal(open.body.code, 'E_MEDIA_JOB_PENDING')
  await library.plugin.buildEnd()
  const handle = openStore(storeFileOf(paths), { privatePaths: paths, policy: OFFICIAL_POLICY })
  try {
    await withLibraryOperation(paths, async (leaseToken) => {
      const result = await createMediaService({ privatePaths: paths, store: handleMediaStore(handle) }).importInbox({ requestId: uuidv7(), leaseToken })
      assert.equal(result.committed, true)
    })
  } finally { await handle.close() }
  const list = await requestTo(library.handler, { url: `${editorPrefix}media/jobs`, method: 'GET' })
  const listed = list.body.jobs.find((item) => item.jobId === job.jobId)
  assert.equal(listed.status, 'needs_review')
  assert.equal(listed.canPreview, false)
  const refused = await library.post(`media/jobs/${job.jobId}/preview`, { libraryId: job.libraryId, revision: job.revision, selectedFileIds: selection(job) })
  assert.equal(refused.status, 409, JSON.stringify(refused.body))
  assert.equal(refused.body.code, 'E_MEDIA_JOB_REVIEW')
})
