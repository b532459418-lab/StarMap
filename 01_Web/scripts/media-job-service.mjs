/** RD-07 durable reception, full-Inbox confirmation and sealed import history.
 *
 * Abandon (batch 1 D2): `POST <prefix>/<id>/abandon` with `{ libraryId, revision }`, authorized and leased exactly like
 * `close`. Only `open`/`paused` tasks can be abandoned; an import stage left in the record is allowed, because the
 * request itself holds the library lease, so that stage belongs to an interrupted process. Abandoning rewrites only
 * the task record (phase `abandoned`): received Inbox files, staging bytes, generated outputs and V2 data all stay
 * as they are. The next import (a new task's import or `npm run media:import`) treats the Inbox as the source of
 * truth and realigns the library with it.
 *
 * Folder bindings (batch 2A): the importer scans the whole Inbox, so a preview can include folders that the user put
 * there by hand and that resolve to a place only by name (or a legacy country.json). The plan lists them in
 * `summary.pins` (folder, place id, names, kind) and its digest covers them. The import request must then carry
 * `acceptFolderBindings: true`, which the recovery center sends only after the user ticks the extra confirmation next
 * to that list; otherwise the request is refused (409 `E_MEDIA_FOLDER_BINDINGS_UNCONFIRMED`) before the task record
 * changes, and nothing is written. Folders with a place.json, including every folder a task upload uses, never appear.
 *
 * Upload folders (batch 2D): reception picks its Inbox folders through `prepareV2Upload`, which uses only a folder whose
 * place.json already names the task's place, or a folder it creates and pins (`<name> (<place id suffix>)`, then
 * `… 2` to `… 9`, when the plain name belongs to another place or to a hand-made folder). A hand-made folder of the
 * same name, one without place.json, is never written to or pinned by a reception; it stays as it is and appears in
 * the preview as a binding to confirm.
 *
 * Completion receipts (batch 2 D4) cover the task, not the library: the selected Inbox sources and the generated files
 * of the media they became, each with size, SHA-256 and modification time; `libraryDigest` summarizes the library
 * instead of listing it, so a receipt does not grow with the library.
 *
 * Reads never hash file contents (D6). The task list and `history()` compare each watched receipt file's size and
 * modification time; receipts sealed before D4 carry no times, so there a file modified after completion counts as
 * changed. Receipts sealed by V2 imports (before 3C-4d) also list V2 files under `data/v2/`: evidence only, never
 * `changed_resource`. Content hashes are compared only by the explicit check `verifyMediaJobReceipts`
 * (`npm run media:check -- --verify`).
 *
 * The new-library mode (3C-4c, design v2 §6): the handlers take `storeMedia` ({ mediaStore }, the plugin's session).
 * Places come from the store's official reader (3C-5 E); `reconcile` asks the media registry whether a received file was imported (a
 * present source at its path) instead of the V2 catalog and index; the preview is ./store-media-jobs.mjs's plan; the
 * import is one store commit by the media service with `requestId = operationId` (UUIDv7; another version is
 * E_STALE: the page predates the store) and the task's files explicit. Its stages: `generated` and `pins` before
 * the commit, `catalog` (committed), `index` and `editor` right after (one commit holds all three). The receipt
 * lists the task's sources and the generated files of their records, `mediaIds` are the new asset ids, and
 * `store: { requestId, revision }` names the commit. Source matches to confirm need `acceptSourceMatches: true`
 * (409 E_MEDIA_SOURCE_MATCHES_UNCONFIRMED otherwise).
 *
 * 3C-4d: media tasks run in the new library only. The V2 paths (the catalog and source index read and written by the
 * V2 importer's task plan) are removed; every handler that reads places or imports needs
 * `storeMedia` and answers E_STORE_MIGRATION_REQUIRED without it (the plugin already refuses media tasks on a private
 * root that is not a store). Records and receipts of tasks done in V2 mode stay readable.
 */
import { mkdir, readFile, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createMediaJobStore, mediaJobReceiptSeal } from './media-job-store.mjs'
import { sha256File } from './file-hash.mjs'
import { inspectLibraryOperation, withLibraryOperation } from './library-operation-lock.mjs'
import { assertUploadPath, stageUpload, publishUpload } from './local-editor-upload.mjs'
import { prepareV2Upload } from './v2-media-store.mjs'
import { atomicJsonWrite, readJson } from './json-file.mjs'
import { droneUploadMetadataOf, uploadTargetOf } from '../src/data/v2media/editorWrites.ts'
import { V2WriteError, errorBody } from '../src/data/editor/errors.ts'
import { isDeepStrictEqual } from 'node:util'
import { pathKeyOf } from './store-media-registry.mjs'
import { isUuidV7 } from '../src/data/canonical/uuidv7.ts'

const prefix = '/__travelatlas/editor/media/jobs'
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const uuidPattern = new RegExp(`^${uuid}$`, 'i')
const hashPattern = /^[a-f0-9]{64}$/
const fail = (code) => { throw new V2WriteError(code) }
/** Every content hash this service computes goes through here (tests count the calls). */
export const mediaJobHashing = {
  digestFile(file) {
    return sha256File(file)
  },
}
const digestFile = (file) => mediaJobHashing.digestFile(file)
/** Shared library data: rewritten by ordinary edits after a task completes, so receipts keep it as evidence only. */
const SHARED_DATA_PREFIX = 'data/v2/'
const watchedOutputs = (receipt) => receipt.outputs.filter((output) => !output.path.startsWith(SHARED_DATA_PREFIX))
export function mediaJobRoute(method, pathname) {
  if (pathname === prefix && method === 'GET') return { action: 'list' }
  if (pathname === prefix && method === 'POST') return { action: 'create' }
  const match = new RegExp(`^${prefix}/(${uuid})(?:/(pause|preview|import|close|abandon|files/(${uuid})))?$`, 'i').exec(pathname)
  if (!match) return undefined
  if (!match[2] && method === 'GET') return { action: 'get', jobId: match[1] }
  if (['pause','preview','import','close','abandon'].includes(match[2]) && method === 'POST') return { action: match[2], jobId: match[1] }
  if (match[3] && method === 'POST') return { action: 'receive', jobId: match[1], fileId: match[3] }
}
const responseError = (error) => {
  const known = error instanceof V2WriteError ? error : new V2WriteError(
    ['E_MEDIA_JOB_CONFLICT','E_MEDIA_JOB_REVIEW'].includes(error?.code) ? error.code : 'E_MEDIA_JOB_REVIEW')
  const { details: _details, ...body } = errorBody(known)
  void _details
  return { status: known.code === 'E_MEDIA_JOB_NOT_FOUND' ? 404 : ['E_LIBRARY_BUSY', 'E_LIBRARY_ROOT_MOVED', 'E_MEDIA_JOB_CONFLICT', 'E_MEDIA_JOB_PENDING', 'E_MEDIA_JOB_REVIEW', 'E_MEDIA_FOLDER_BINDINGS_UNCONFIRMED',
    'E_MEDIA_SOURCE_MATCHES_UNCONFIRMED', 'E_STALE', 'E_STORE_READ_ONLY', 'E_STORE_MIGRATION_REQUIRED'].includes(known.code) ? 409 : 400, body }
}
const summary = (job) => ({
  jobId: job.jobId, libraryId: job.libraryId, revision: job.revision, phase: job.phase,
  countryId: job.countryId, cityId: job.cityId, kind: job.kind, createdAt: job.createdAt, updatedAt: job.updatedAt,
  files: job.files.map(({ fileId, fileName, bytes, phase }) => ({ fileId, fileName, bytes, phase })),
})
const exactInput = (input, keys) => input !== null && typeof input === 'object' && !Array.isArray(input)
  && Object.keys(input).every(key => keys.includes(key))
const selectionOf = (job, ids) => {
  if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => !uuidPattern.test(id)) || new Set(ids).size !== ids.length) fail('E_MEDIA_JOB_INVALID')
  const selected = [...ids].sort()
  const received = job.files.filter(file => file.phase === 'received').map(file => file.fileId).sort()
  // A whole-Inbox importer cannot silently omit another already received file in this batch.
  if (!isDeepStrictEqual(selected, received)) fail('E_MEDIA_JOB_CONFLICT')
  return selected
}
const assertIntent = (job, input) => {
  if (input?.libraryId !== job.libraryId || !Number.isSafeInteger(input?.revision) || input.revision < 0) fail('E_MEDIA_JOB_CONFLICT')
}
async function history(paths, job, resourceChecks = new Map()) {
  const result = summary(job)
  result.status = job.phase === 'closed' ? 'closed' : 'completed'
  result.completion = {
    operationId: job.import.operationId, planDigest: job.import.planDigest,
    completedAt: job.import.receipt.completedAt, mediaIds: job.import.receipt.mediaIds,
    restoredMediaIds: job.import.receipt.restoredMediaIds,
  }
  result.warnings = []
  // D6: size and modification time only; `verifyMediaJobReceipts` is the explicit content check.
  const completedAt = Date.parse(job.import.receipt.completedAt)
  for (const output of watchedOutputs(job.import.receipt)) {
    const target = path.join(paths.root, ...output.path.split('/'))
    if (!resourceChecks.has(target)) resourceChecks.set(target, (async () => {
      await assertUploadPath(paths.root, target)
      const info = await stat(target)
      if (!info.isFile()) throw new Error('changed')
      return { bytes: info.size, mtimeMs: info.mtimeMs }
    })().catch(() => null))
    const found = await resourceChecks.get(target)
    const unchanged = found !== null && found.bytes === output.bytes
      && (output.mtimeMs !== undefined ? found.mtimeMs === output.mtimeMs : Math.floor(found.mtimeMs) <= completedAt)
    if (!unchanged) result.warnings.push({ kind: 'changed_resource', path: output.path })
  }
  result.files.forEach(file => {
    file.status = job.import.selectedFileIds.includes(file.fileId) ? 'completed' : 'not_received'
    file.canReceive = false
  })
  result.paused = false
  result.canImport = false
  result.canUpload = false
  result.canClose = job.phase === 'completed'
  return result
}
/** 3C-4d: the media store of the plugin's session; none means the private root is not a store. */
const mediaStoreOf = (storeMedia) => storeMedia?.mediaStore ?? fail('E_STORE_MIGRATION_REQUIRED')
/** 3C-5 E: the official reader of the new library (the places of the upload target), read at once by the caller. */
async function officialReaderOf(storeMedia) {
  return (await mediaStoreOf(storeMedia).official()).reader
}
const queryOf = (job, file) => new URLSearchParams(Object.entries({
  countryId: job.countryId, cityId: job.cityId, kind: job.kind, fileName: file.fileName, ...file.metadata,
}).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]))

async function pinsAndMetadataMatch(paths, job, file) {
  const segments = file.sourcePath.split('/')
  if (segments.length !== 4 || segments[2] !== (job.kind === 'photo' ? 'photos' : 'drone')) return false
  const countryRoot = path.join(paths.inboxRoot, segments[0]), cityRoot = path.join(countryRoot, segments[1])
  for (const [directory, id] of [[countryRoot, job.countryId], [cityRoot, job.cityId]]) {
    const pin = path.join(directory, 'place.json')
    await assertUploadPath(paths.root, pin)
    const value = JSON.parse(await readFile(pin, 'utf8'))
    if (!value || value.placeId !== id) return false
  }
  if (job.kind !== 'photo') {
    const sidecar = path.join(cityRoot, 'media.json')
    await assertUploadPath(paths.root, sidecar)
    const item = (await readJson(sidecar, {}))[`drone/${segments[3]}`]
    if (!item || item.kind !== job.kind) return false
    for (const [key, expected] of Object.entries(file.metadata)) {
      const actual = ['lat','lng'].includes(key) ? item.position?.[key] ?? item[key] : item[key]
      if (actual !== expected) return false
    }
  }
  return true
}
/** An abandoned task is inert history: no file is inspected and every action is off. */
function abandonedSummary(job) {
  const result = summary(job)
  result.status = 'abandoned'
  if (job.import) result.importStage = job.import.phase
  result.files.forEach(file => { file.status = file.phase === 'intended' ? 'not_received' : 'needs_review'; file.canReceive = false })
  result.paused = false
  result.canPreview = false
  result.canImport = false
  result.canUpload = false
  result.canAbandon = false
  return result
}

async function reconcile(paths, job, resourceChecks, storeMedia) {
  // A structurally sealed record is historical proof of that operation. Later edits do not
  // rewind it into an import retry, even when the original target or resources were deleted.
  if (['completed', 'closed'].includes(job.phase)) return history(paths, job, resourceChecks)
  if (job.phase === 'abandoned') return abandonedSummary(job)
  const result = summary(job)
  // Reads only reach here while the library lease is idle, so even an unsealed import stage may be abandoned.
  result.canAbandon = ['open', 'paused'].includes(job.phase)
  if (job.import) {
    result.status = 'needs_review'
    result.importStage = job.import.phase
    result.files.forEach(file => { file.status = 'needs_review'; file.canReceive = false })
    result.canImport = false
    result.canUpload = false
    result.paused = job.phase === 'paused'
    return result
  }
  try {
    uploadTargetOf(await officialReaderOf(storeMedia), job)
    const registry = mediaStoreOf(storeMedia).mediaRegistry()
    for (let i = 0; i < job.files.length; i++) {
      const file = job.files[i], item = result.files[i]
      item.status = file.phase === 'intended' ? 'not_received' : 'needs_review'
      if (file.phase !== 'received') continue
      const source = path.join(paths.inboxRoot, file.sourcePath)
      await assertUploadPath(paths.root, source)
      if (!(await stat(source)).isFile() || (await stat(source)).size !== file.bytes || await digestFile(source) !== file.sha256
        || !await pinsAndMetadataMatch(paths, job, file)) continue
      // 3C-4c: a present source with the file's path and content means it was imported (by this task without its
      // receipt, or by another import): review, never an import again. The same content elsewhere does not count (D2),
      // nor does a source the registry still lists at that path with other content (the file there was replaced).
      const key = pathKeyOf(`MediaInbox/${file.sourcePath}`)
      if (!registry.sources.some(source => source.pathKey === key && source.sha256 === file.sha256 && source.state === 'present')) item.status = 'pending'
    }
    result.status = result.files.some(file => file.status === 'needs_review') ? 'needs_review'
      : result.files.some(file => file.status === 'pending') ? 'pending' : 'not_received'
  } catch {
    result.status = 'needs_review'
    result.files.forEach(file => { file.status = 'needs_review' })
  }
  result.paused = job.phase === 'paused'
  result.files.forEach(file=>{ file.canReceive = result.status !== 'needs_review' && file.status === 'not_received' })
  result.canPreview = result.status === 'pending'
  result.canImport = false
  result.canUpload = result.status === 'not_received'
  return result
}

/** 3C-4c: the store plan of a task (./store-media-jobs.mjs): the media service's plan with the task's files explicit. */
async function storeTaskPlan(paths, job, selectedFileIds, storeMedia) {
  const { createMediaService } = await import('./media-service.mjs')
  const { storeTaskPlanOf, taskPathsOf } = await import('./store-media-jobs.mjs')
  const { mediaStore } = storeMedia
  const service = createMediaService({ privatePaths: paths, store: mediaStore })
  const servicePlan = await service.planImport({ explicitPaths: taskPathsOf(job, selectedFileIds), blockOnWarnings: true })
  return { ...storeTaskPlanOf({ plan: servicePlan, meta: mediaStore.meta(), job, selectedFileIds }), service }
}

async function taskPlan(paths, job, input, storeMedia) {
  mediaStoreOf(storeMedia)
  const keys = ['libraryId','revision','selectedFileIds','operationId','planDigest','acceptFolderBindings','acceptSourceMatches']
  if (!exactInput(input, keys)) fail('E_MEDIA_JOB_INVALID')
  assertIntent(job,input)
  if (job.revision !== input.revision) fail('E_MEDIA_JOB_CONFLICT')
  if (job.import || !['open','paused'].includes(job.phase)) fail('E_MEDIA_JOB_REVIEW')
  const selectedFileIds = selectionOf(job,input.selectedFileIds)
  const known = await reconcile(paths,job,undefined,storeMedia)
  if (known.status !== 'pending' || known.files.some(file => selectedFileIds.includes(file.fileId) && file.status !== 'pending')) fail('E_MEDIA_JOB_REVIEW')
  return { plan: await storeTaskPlan(paths, job, selectedFileIds, storeMedia), selectedFileIds, known }
}

/** POST preview is observational: even coordination records stay byte-for-byte unchanged. */
export async function handleMediaJobPreview({privatePaths,route,input,storeMedia}) {
  try {
    mediaStoreOf(storeMedia)
    if (!exactInput(input,['libraryId','revision','selectedFileIds'])) fail('E_MEDIA_JOB_INVALID')
    const before = await inspectLibraryOperation(privatePaths)
    if (before.state !== 'idle') fail(before.state === 'busy' ? 'E_LIBRARY_BUSY' : 'E_MEDIA_JOB_REVIEW')
    const job = await createMediaJobStore(privatePaths).read(route.jobId)
    const {plan,selectedFileIds,known} = await taskPlan(privatePaths,job,input,storeMedia)
    const after = await inspectLibraryOperation(privatePaths)
    if (after.state !== 'idle' || after.generation !== before.generation) fail('E_MEDIA_JOB_CONFLICT')
    return {status:200,body:{ok:true,job:{...known,canImport:plan.blockers.length === 0},plan:{digest:plan.digest,summary:plan.summary,blockers:plan.blockers,selectedFileIds}}}
  } catch(error) { return responseError(error) }
}

/**
 * 3C-4c: a task's import in the new library (see the file header). The service computes the plan again after the queued
 * deletions, and it must still have the previewed digest; then the task record's stages, the sources and outputs
 * verified, and the sealed receipt.
 */
async function importTask(paths,store,job,input,deps,storeMedia,leaseToken) {
  if (!exactInput(input,['libraryId','revision','selectedFileIds','operationId','planDigest','acceptFolderBindings','acceptSourceMatches'])
    || !uuidPattern.test(input?.operationId) || !hashPattern.test(input?.planDigest ?? '')
    || (input.acceptFolderBindings !== undefined && typeof input.acceptFolderBindings !== 'boolean')
    || (input.acceptSourceMatches !== undefined && typeof input.acceptSourceMatches !== 'boolean')) fail('E_MEDIA_JOB_INVALID')
  assertIntent(job,input)
  // The store's request ids are lowercase UUIDv7; a page from before the new library generates v4 ids.
  if (!isUuidV7(input.operationId)) fail('E_STALE')
  const selectedFileIds = selectionOf(job,input.selectedFileIds)
  if (job.import) {
    if (job.import.operationId !== input.operationId || job.import.planDigest !== input.planDigest
      || job.import.sourceRevision !== input.revision || !isDeepStrictEqual(job.import.selectedFileIds,selectedFileIds)) fail('E_MEDIA_JOB_CONFLICT')
    if (job.import.phase !== 'sealed' || !['completed','closed'].includes(job.phase)) fail('E_MEDIA_JOB_REVIEW')
    return {status:200,body:{ok:true,replayed:true,job:await history(paths,job)}}
  }
  const {plan} = await taskPlan(paths,job,input,storeMedia)
  if (plan.digest !== input.planDigest) fail('E_MEDIA_JOB_CONFLICT')
  if (plan.blockers.length) fail('E_MEDIA_IMPORT_BLOCKED')
  if (plan.summary.pins.length > 0 && input.acceptFolderBindings !== true) fail('E_MEDIA_FOLDER_BINDINGS_UNCONFIRMED')
  if (plan.summary.sourceMatches.length > 0 && input.acceptSourceMatches !== true) fail('E_MEDIA_SOURCE_MATCHES_UNCONFIRMED')
  const { MEDIA_KINDS, assetsOfPaths } = await import('./media-service.mjs')
  const { storeLibraryDigestOf, storeTaskPlanOf, taskPathsOf } = await import('./store-media-jobs.mjs')
  const mediaStore = mediaStoreOf(storeMedia)
  job = await store.update(job.jobId,job.revision,next => {
    next.phase = 'open'
    next.import = {operationId:input.operationId,planDigest:plan.digest,sourceRevision:input.revision,selectedFileIds,phase:'started'}
    return next
  })
  const stage = async phase => {
    job = await store.update(job.jobId,job.revision,next => {next.import.phase = phase; return next})
    await deps?.onMediaJobImportStage?.(phase)
  }
  try {
    const explicitPaths = taskPathsOf(job,selectedFileIds)
    const result = await plan.service.importInbox({
      requestId: input.operationId, actor: 'local-editor', leaseToken, explicitPaths, blockOnWarnings: true,
      kind: `${MEDIA_KINDS.task}@${createHash('sha256').update(JSON.stringify([job.jobId, plan.digest, selectedFileIds])).digest('hex')}`,
      acceptSourceMatches: input.acceptSourceMatches === true, acceptFolderBindings: input.acceptFolderBindings === true,
      onStage: stage,
      expect: (current) => {
        if (storeTaskPlanOf({ plan: current, meta: mediaStore.meta(), job, selectedFileIds }).digest !== input.planDigest) fail('E_MEDIA_JOB_CONFLICT')
      },
    })
    if (!result.committed) fail('E_MEDIA_JOB_REVIEW')
    // One commit held the records, their city order and the registry: the three later stages follow it.
    for (const phase of ['catalog','index','editor']) await stage(phase)
    const selected = job.files.filter(file => selectedFileIds.includes(file.fileId))
    const mediaIds = assetsOfPaths(mediaStore, explicitPaths.map(value => pathKeyOf(value)), result.created)
    if (mediaIds.length !== selected.length) fail('E_MEDIA_JOB_REVIEW')
    for (const file of selected) {
      const source = path.join(paths.inboxRoot,...file.sourcePath.split('/'))
      await assertUploadPath(paths.root,source)
      if ((await stat(source)).size !== file.bytes || await digestFile(source) !== file.sha256 || !await pinsAndMetadataMatch(paths,job,file)) fail('E_MEDIA_JOB_REVIEW')
    }
    // D4 in the store: the task's sources and the generated files of their records, each as on disk now.
    const registry = mediaStore.mediaRegistry()
    const contents = new Map(registry.files.map(file => [file.sha256, file]))
    const targets = new Map()
    for (const file of selected) {
      targets.set(`MediaInbox/${file.sourcePath}`.toLocaleLowerCase('en-US'), {path:`MediaInbox/${file.sourcePath}`})
      const content = contents.get(file.sha256)
      if (!content) fail('E_MEDIA_JOB_REVIEW')
      for (const output of content.outputs) targets.set(`${content.directory}/${output.name}`.toLocaleLowerCase('en-US'), {path:`${content.directory}/${output.name}`,sha256:output.sha256})
    }
    const outputs = []
    for (const target of [...targets.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
      const absolute = path.join(paths.root,...target.path.split('/'))
      await assertUploadPath(paths.root,absolute)
      const info = await stat(absolute)
      if (!info.isFile()) fail('E_MEDIA_JOB_REVIEW')
      const sha256 = await digestFile(absolute)
      if (target.sha256 !== undefined && sha256 !== target.sha256) fail('E_MEDIA_JOB_REVIEW')
      outputs.push({path:target.path,bytes:info.size,sha256,mtimeMs:info.mtimeMs})
    }
    const receipt = {completedAt:new Date().toISOString(),mediaIds,restoredMediaIds:mediaIds,outputs,
      libraryDigest:storeLibraryDigestOf({libraryId:mediaStore.meta().libraryId,revision:result.revision,registry}),
      store:{requestId:input.operationId,revision:result.revision}}
    receipt.seal = mediaJobReceiptSeal(job,job.import,receipt)
    job = await store.update(job.jobId,job.revision,next => {next.import.phase='sealed'; next.import.receipt=receipt; next.phase='completed'; return next})
    return {status:200,body:{ok:true,job:await history(paths,job)}}
  } catch(error) {
    try {await store.update(job.jobId,job.revision,next => {next.import.phase='needs_review';return next})} catch { /* Retain the last known stage if even recording the failure is impossible. */ }
    throw error
  }
}


/**
 * Explicit content check of completion receipts (D6; `npm run media:check -- --verify`): hashes every file a completed or
 * closed task's receipt watches (its Inbox sources and generated files; for receipts sealed before D4, every listed file
 * outside `data/v2/`) and reports the missing or different ones. Writes nothing; each file is hashed once.
 */
export async function verifyMediaJobReceipts(privatePaths) {
  const { jobs } = await createMediaJobStore(privatePaths).readSnapshot()
  const digests = new Map()
  const findings = []
  let checked = 0
  for (const job of jobs) {
    if (!['completed', 'closed'].includes(job.phase)) continue
    for (const output of watchedOutputs(job.import.receipt)) {
      const target = path.join(privatePaths.root, ...output.path.split('/'))
      if (!digests.has(target)) digests.set(target, (async () => {
        await assertUploadPath(privatePaths.root, target)
        const info = await stat(target)
        if (!info.isFile()) return null
        return { bytes: info.size, sha256: await digestFile(target) }
      })().catch(() => null))
      const found = await digests.get(target)
      checked += 1
      if (!found) findings.push({ jobId: job.jobId, path: output.path, kind: 'missing' })
      else if (found.bytes !== output.bytes || found.sha256 !== output.sha256) findings.push({ jobId: job.jobId, path: output.path, kind: 'changed' })
    }
  }
  return { checked, findings }
}

/** `npm run media:check -- --verify` (D6): prints the receipt check as reminders; it never changes the exit code. */
export async function reportMediaJobReceipts(privatePaths, log = console.log) {
  try {
    const { checked, findings } = await verifyMediaJobReceipts(privatePaths)
    log(`校验：核对了媒体任务完成凭据记录的 ${checked} 个文件。`)
    for (const finding of findings) {
      log(`提醒：媒体任务 ${finding.jobId} 完成后，${finding.path} ${finding.kind === 'missing' ? '已不存在或无法读取' : '内容已改变'}。已完成的导入不受影响；需要时重新上传或导入。`)
    }
  } catch (error) {
    log(`提醒：无法核对媒体任务的完成凭据（${error?.code ?? error?.message ?? error}）。`)
  }
}

/** Zero-write read: generation detects an operation starting and ending during the snapshot. */
export async function handleMediaJobRead({ privatePaths, route, storeMedia }) {
  try {
    mediaStoreOf(storeMedia)
    const before = await inspectLibraryOperation(privatePaths)
    if (before.state !== 'idle') return { status: 200, body: { ok: true, libraryId: null, status: before.state === 'busy' ? 'processing' : 'needs_review', ...(route.action === 'get' ? {job:null} : {jobs:[]}) } }
    const store = createMediaJobStore(privatePaths)
    const discovered = await store.readSnapshot()
    const selected = route.action === 'get' ? discovered.jobs.find(job => job.jobId === route.jobId) : undefined
    if (route.action === 'get' && !selected) fail('E_MEDIA_JOB_NOT_FOUND')
    const jobs = route.action === 'get' ? [selected] : discovered.jobs
    const resourceChecks = new Map()
    const summaries = await Promise.all(jobs.map(job=>reconcile(privatePaths,job,resourceChecks,storeMedia)))
    const after = await inspectLibraryOperation(privatePaths)
    if (after.state !== 'idle' || after.generation !== before.generation) fail('E_MEDIA_JOB_CONFLICT')
    return { status:200, body: {ok:true,libraryId:discovered.libraryId,...(route.action === 'get' ? {job:summaries[0]} : {jobs:summaries})} }
  } catch (error) { return responseError(error) }
}

/** Internal entry: verifies caller's disk lease. HTTP authorization lives in the plugin. */
export async function handleMediaJobWrite({ privatePaths, route, input, request, url, deps, leaseToken, storeMedia }) {
  try {
    if (typeof leaseToken !== 'string') fail('E_LIBRARY_BUSY')
    mediaStoreOf(storeMedia)
    return await withLibraryOperation(privatePaths, async () => {
      const store = createMediaJobStore(privatePaths)
      if (route.action === 'create') {
        const target = uploadTargetOf(await officialReaderOf(storeMedia), input ?? {})
        if (!Array.isArray(input?.files)) fail('E_MEDIA_JOB_INVALID')
        // Reject fields instead of silently accepting a new target, path or metadata at reception time.
        const normalized = structuredClone(input)
        for (const file of normalized.files) {
          // The existing destination normalizer caps whole names at 120 characters;
          // refuse an intent whose extension would be lost before it can be received.
          if (typeof file?.fileName === 'string' && file.fileName.length > 120) fail('E_MEDIA_JOB_INVALID')
          if (!file || typeof file.fileName !== 'string' || !['.jpg','.jpeg','.png','.webp','.avif'].includes(path.extname(file.fileName).toLowerCase())) fail('E_MEDIA_EXTENSION')
          if (input.kind !== 'photo') {
            if (!file.metadata || typeof file.metadata !== 'object' || Array.isArray(file.metadata)
              || Object.keys(file.metadata).some(key=>!['date','lat','lng','altitudeMeters','relativeAltitudeMeters','titleZh','titleEn'].includes(key))) fail('E_MEDIA_JOB_INVALID')
            const query = queryOf(input, file)
            const metadata = droneUploadMetadataOf(query, input.kind, target.cityFolderName)
            delete metadata.kind
            file.metadata = metadata
          }
        }
        const job = await store.create(normalized)
        return {status:201,body:{ok:true,job:await reconcile(privatePaths,job,undefined,storeMedia)}}
      }
      let job = await store.read(route.jobId)
      const params = route.action === 'receive' ? Object.fromEntries(url.searchParams) : input
      const revision = route.action === 'receive' && /^\d+$/.test(params?.revision ?? '') ? Number(params.revision) : params?.revision
      if (params?.libraryId !== job.libraryId || !Number.isSafeInteger(revision) || revision < 0) fail('E_MEDIA_JOB_CONFLICT')
      if (route.action === 'import') return importTask(privatePaths,store,job,input,deps,storeMedia,leaseToken)
      if (route.action === 'close') {
        if (!exactInput(input,['libraryId','revision'])) fail('E_MEDIA_JOB_INVALID')
        if (job.phase === 'closed') {
          if (revision > job.revision) fail('E_MEDIA_JOB_CONFLICT')
          return {status:200,body:{ok:true,replayed:true,job:await history(privatePaths,job)}}
        }
        job = await store.close(job.jobId,revision)
        return {status:200,body:{ok:true,job:await history(privatePaths,job)}}
      }
      if (route.action === 'abandon') {
        if (!exactInput(input,['libraryId','revision'])) fail('E_MEDIA_JOB_INVALID')
        if (job.phase === 'abandoned') {
          if (revision > job.revision) fail('E_MEDIA_JOB_CONFLICT')
          return {status:200,body:{ok:true,replayed:true,job:abandonedSummary(job)}}
        }
        job = await store.abandon(job.jobId,revision)
        return {status:200,body:{ok:true,job:abandonedSummary(job)}}
      }
      if (route.action === 'pause') {
        if (!exactInput(input,['libraryId','revision'])) fail('E_MEDIA_JOB_INVALID')
        if (job.import || !['open','paused'].includes(job.phase)) fail('E_MEDIA_JOB_REVIEW')
        job = await store.pause(job.jobId,revision)
        return {status:200,body:{ok:true,job:await reconcile(privatePaths,job,undefined,storeMedia)}}
      }
      if (route.action !== 'receive') fail('E_UNKNOWN_ENDPOINT')
      if (job.import || !['open','paused'].includes(job.phase)) fail('E_MEDIA_JOB_REVIEW')
      const file = job.files.find(file=>file.fileId === route.fileId)
      if (!file || !uuidPattern.test(params.operationId) || !hashPattern.test(params.sha256 ?? '')) fail('E_MEDIA_JOB_INVALID')
      if (Object.keys(params).some(key=>!['libraryId','revision','operationId','sha256'].includes(key))) fail('E_MEDIA_JOB_INVALID')
      if (file.operationId && (file.operationId !== params.operationId || file.expectedSha256 !== params.sha256)) fail('E_MEDIA_JOB_CONFLICT')
      if (Number(request.headers['content-length']) !== file.bytes) fail('E_MEDIA_JOB_CONFLICT')
      if (file.phase === 'received' && file.operationId === params.operationId) {
        if (revision > job.revision) fail('E_MEDIA_JOB_CONFLICT')
        const known = await reconcile(privatePaths,job,undefined,storeMedia)
        if (known.files.find(item=>item.fileId === file.fileId)?.status !== 'pending') fail('E_MEDIA_JOB_REVIEW')
        return {status:200,body:{ok:true,replayed:true,job:known}}
      }
      if (job.revision !== revision || file.phase !== 'intended') fail('E_MEDIA_JOB_CONFLICT')
      const before = await reconcile(privatePaths,job,undefined,storeMedia)
      if (before.status === 'needs_review') fail('E_MEDIA_JOB_REVIEW')
      const prepare = deps.prepareV2Upload ?? prepareV2Upload
      const plan = await prepare({ privatePaths, query:queryOf(job,file), deps, reader: await officialReaderOf(storeMedia) })
      await assertUploadPath(privatePaths.root,plan.destination)
      for (const claim of plan.claims) await assertUploadPath(privatePaths.root,claim.file)
      const sourcePath = path.relative(privatePaths.inboxRoot,plan.destination).split(path.sep).join('/')
      job = await store.update(job.jobId,job.revision,next=>{
        next.phase = 'open'
        Object.assign(next.files.find(item=>item.fileId === file.fileId),{phase:'receiving',operationId:params.operationId,expectedSha256:params.sha256,sourcePath})
        return next
      })
      const directory = path.join(privatePaths.root,'operations','media-import','v1','staging',job.jobId)
      const staged = path.join(directory,`${file.fileId}-${params.operationId}.part`)
      try {
        await assertUploadPath(privatePaths.root,staged)
        await mkdir(directory,{recursive:true})
        const received = await stageUpload(request,staged,job.kind,file.bytes)
        if (received.sha256 !== params.sha256) fail('E_MEDIA_JOB_CONFLICT')
        const {width,height,format,orientation} = received.imageMetadata
        const image = {width,height,format,...(orientation === undefined ? {} : {orientation})}
        job = await store.update(job.jobId,job.revision,next=>{
          Object.assign(next.files.find(item=>item.fileId === file.fileId),{phase:'staged',sha256:received.sha256,receivedBytes:received.bytes,image})
          return next
        })
        await assertUploadPath(privatePaths.root,plan.destination)
        await publishUpload(staged,plan.destination)
        for (const claim of plan.claims) await atomicJsonWrite(claim.file,claim.value)
        if (plan.droneMetadata) {
          await assertUploadPath(privatePaths.root,path.join(plan.cityRoot,'media.json'))
          await deps.updateDroneSidecar(plan.cityRoot,plan.destination,plan.droneMetadata,received.imageMetadata)
        }
        const finalFile = job.files.find(item=>item.fileId === file.fileId)
        if (!await pinsAndMetadataMatch(privatePaths,job,finalFile)) fail('E_MEDIA_JOB_REVIEW')
        job = await store.update(job.jobId,job.revision,next=>{next.files.find(item=>item.fileId === file.fileId).phase='received';return next})
        await unlink(staged).catch(()=>undefined)
        return {status:201,body:{ok:true,job:await reconcile(privatePaths,job,undefined,storeMedia)}}
      } catch (error) {
        // Preserve staging and published bytes. No automatic retransmission, cleanup or importer call.
        try { await store.update(job.jobId,job.revision,next=>{Object.assign(next.files.find(item=>item.fileId===file.fileId),{phase:'needs_review',errorCode:'E_MEDIA_JOB_REVIEW'});return next}) } catch { /* Leave the original stage for review. */ }
        throw error
      }
    },{leaseToken})
  } catch (error) { return responseError(error) }
}
