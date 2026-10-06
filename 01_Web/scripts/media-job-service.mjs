/** RD-07 durable reception, full-Inbox confirmation and sealed import history. */
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { assertMediaJobRecord, createMediaJobStore, mediaJobReceiptSeal } from './media-job-store.mjs'
import { inspectLibraryOperation, withLibraryOperation } from './library-operation-lock.mjs'
import { assertUploadPath, stageUpload, publishUpload } from './local-editor-upload.mjs'
import { applyV2Writes, createV2WriteContext, readV2Files } from './v2-editor-store.mjs'
import { prepareV2Upload } from './v2-media-store.mjs'
import { atomicJsonWrite, readJson } from './json-file.mjs'
import { droneUploadMetadataOf, restoreImportedMedia, uploadTargetOf } from '../src/data/v2media/editorWrites.ts'
import { V2WriteError, errorBody } from '../src/data/v2write/errors.ts'
import { createMediaImportPlan, applyMediaImportPlan, verifyMediaImportPlanInputs } from './media-import-plan.mjs'
import { isDeepStrictEqual } from 'node:util'

const prefix = '/__travelatlas/editor/media/jobs'
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const uuidPattern = new RegExp(`^${uuid}$`, 'i')
const hashPattern = /^[a-f0-9]{64}$/
const fail = (code) => { throw new V2WriteError(code) }
const digestFile = async (file) => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
export function mediaJobRoute(method, pathname) {
  if (pathname === prefix && method === 'GET') return { action: 'list' }
  if (pathname === prefix && method === 'POST') return { action: 'create' }
  const match = new RegExp(`^${prefix}/(${uuid})(?:/(pause|preview|import|close|files/(${uuid})))?$`, 'i').exec(pathname)
  if (!match) return undefined
  if (!match[2] && method === 'GET') return { action: 'get', jobId: match[1] }
  if (['pause','preview','import','close'].includes(match[2]) && method === 'POST') return { action: match[2], jobId: match[1] }
  if (match[3] && method === 'POST') return { action: 'receive', jobId: match[1], fileId: match[3] }
}
const responseError = (error) => {
  const known = error instanceof V2WriteError ? error : new V2WriteError(
    ['E_MEDIA_JOB_CONFLICT','E_MEDIA_JOB_REVIEW'].includes(error?.code) ? error.code : 'E_MEDIA_JOB_REVIEW')
  const { details: _details, ...body } = errorBody(known)
  void _details
  return { status: known.code === 'E_MEDIA_JOB_NOT_FOUND' ? 404 : ['E_LIBRARY_BUSY', 'E_MEDIA_JOB_CONFLICT', 'E_MEDIA_JOB_PENDING', 'E_MEDIA_JOB_REVIEW'].includes(known.code) ? 409 : 400, body }
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
  for (const output of job.import.receipt.outputs) {
    const target = path.join(paths.root, ...output.path.split('/'))
    if (!resourceChecks.has(target)) resourceChecks.set(target, (async () => {
      await assertUploadPath(paths.root, target)
      const info = await stat(target)
      if (!info.isFile()) throw new Error('changed')
      return { bytes: info.size, sha256: await digestFile(target) }
    })().catch(() => null))
    try {
      const found = await resourceChecks.get(target)
      if (!found || found.bytes !== output.bytes || found.sha256 !== output.sha256) throw new Error('changed')
    } catch { result.warnings.push({ kind: 'changed_resource', path: output.path }) }
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
async function checkedFiles(paths) {
  for (const file of Object.values(paths.v2FilePaths)) await assertUploadPath(paths.root, file)
  return readV2Files(paths)
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
async function reconcile(paths, job, resourceChecks) {
  // A structurally sealed record is historical proof of that operation. Later edits do not
  // rewind it into an import retry, even when the original target or resources were deleted.
  if (['completed', 'closed'].includes(job.phase)) return history(paths, job, resourceChecks)
  const result = summary(job)
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
    const files = await checkedFiles(paths)
    uploadTargetOf(files, job, new Date())
    await assertUploadPath(paths.root, paths.v2MediaSourceIndexPath)
    const index = await readJson(paths.v2MediaSourceIndexPath, { schemaVersion: 1, sourcesById: {} })
    if (!index || index.schemaVersion !== 1 || typeof index.sourcesById !== 'object' || index.sourcesById === null || Array.isArray(index.sourcesById)
      || Object.values(index.sourcesById).some(rows => !Array.isArray(rows) || rows.some(value => typeof value !== 'string'))) fail('E_MEDIA_JOB_REVIEW')
    for (let i = 0; i < job.files.length; i++) {
      const file = job.files[i], item = result.files[i]
      item.status = file.phase === 'intended' ? 'not_received' : 'needs_review'
      if (file.phase !== 'received') continue
      const source = path.join(paths.inboxRoot, file.sourcePath)
      await assertUploadPath(paths.root, source)
      if (!(await stat(source)).isFile() || (await stat(source)).size !== file.bytes || await digestFile(source) !== file.sha256
        || !await pinsAndMetadataMatch(paths, job, file)) continue
      const contentId = `media-${file.sha256.slice(0,16)}`
      // A catalog hit without the task's sealed receipt never proves this import completed.
      if (Object.values(index.sourcesById).some(rows => rows.includes(file.sourcePath))) continue
      const existing = (files.media?.items ?? []).filter(media => media.id === contentId
        || [media.src,media.originalSrc].some(src => typeof src === 'string' && src.includes(file.sha256.slice(0,16))))
      let existingContentValid = true
      for (const media of existing) {
        // A new, not-yet-indexed receipt may explicitly preview deduplication against
        // existing bytes in the same target. It still has not completed this task.
        const match = typeof media.src === 'string' && /^\/media\/user\/([a-f0-9]{16})\/(original\.(?:jpg|jpeg|png|webp|avif))$/.exec(media.src)
        if (media.placeId !== job.cityId || media.kind !== job.kind || !match || !index.sourcesById[media.id]?.length) {
          existingContentValid = false
          break
        }
        const original = path.join(paths.userMediaRoot,match[1],match[2])
        await assertUploadPath(paths.root,original)
        if (await digestFile(original) !== file.sha256) {existingContentValid=false;break}
      }
      if (!existingContentValid || (!existing.length && Object.hasOwn(index.sourcesById,contentId))) continue
      item.status = 'pending'
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

async function taskPlan(paths, job, input) {
  if (!exactInput(input, ['libraryId','revision','selectedFileIds','operationId','planDigest'])) fail('E_MEDIA_JOB_INVALID')
  assertIntent(job,input)
  if (job.revision !== input.revision) fail('E_MEDIA_JOB_CONFLICT')
  if (job.import || !['open','paused'].includes(job.phase)) fail('E_MEDIA_JOB_REVIEW')
  const selectedFileIds = selectionOf(job,input.selectedFileIds)
  const known = await reconcile(paths,job)
  if (known.status !== 'pending' || known.files.some(file => selectedFileIds.includes(file.fileId) && file.status !== 'pending')) fail('E_MEDIA_JOB_REVIEW')
  const plan = await createMediaImportPlan({privatePaths:paths})
  const sourcePaths = job.files.filter(file => selectedFileIds.includes(file.fileId)).map(file => file.sourcePath)
  // Confirm the scanner resolves the fixed task intent; an explicit sidecar id cannot replace it.
  for (const file of job.files.filter(file => selectedFileIds.includes(file.fileId))) {
    const entry = plan.entries.find(entry => entry.sourcePath === file.sourcePath)
    if (!entry || entry.sha256 !== file.sha256 || entry.bytes !== file.bytes || entry.placeId !== job.cityId || entry.kind !== job.kind) fail('E_MEDIA_JOB_REVIEW')
  }
  let editorOutcome
  if (plan.blockers.length === 0) {
    const files = await checkedFiles(paths)
    editorOutcome = restoreImportedMedia({...files,media:plan.catalog}, {sourcePaths,sourceIndex:plan.index},createV2WriteContext({now:new Date()}))
    // Check the completed record's schema and conservative size before any import side effects.
    const hypothetical = structuredClone(job)
    hypothetical.phase = 'completed'
    hypothetical.revision += 7
    hypothetical.import = {operationId:'018bd504-c600-7000-8000-000000000001',planDigest:plan.digest,
      sourceRevision:job.revision,selectedFileIds,phase:'sealed'}
    const outputPaths = [...new Set([...Object.values(paths.v2FilePaths),paths.v2MediaSourceIndexPath,
      ...plan.summary.outputs.map(output => path.join(paths.root,...output.path.split('/'))),
      ...plan.entries.map(entry => path.join(paths.inboxRoot,...entry.sourcePath.split('/')))])]
      .map(target => path.relative(paths.root,target).split(path.sep).join('/')).sort()
    const receipt = {completedAt:new Date().toISOString(),mediaIds:plan.catalog.items.map(item => item.id),
      restoredMediaIds:editorOutcome.result.restoredMediaIds,
      outputs:outputPaths.map(value => ({path:value,sha256:'f'.repeat(64),bytes:Number.MAX_SAFE_INTEGER}))}
    receipt.seal = mediaJobReceiptSeal(hypothetical,hypothetical.import,receipt)
    hypothetical.import.receipt = receipt
    try {assertMediaJobRecord(hypothetical)} catch {plan.blockers.push({code:'E_MEDIA_PLAN_RECEIPT_LIMIT'})}
  }
  return {plan,selectedFileIds,editorOutcome,known}
}

/** POST preview is observational: even coordination records stay byte-for-byte unchanged. */
export async function handleMediaJobPreview({privatePaths,route,input}) {
  try {
    if (!exactInput(input,['libraryId','revision','selectedFileIds'])) fail('E_MEDIA_JOB_INVALID')
    const before = await inspectLibraryOperation(privatePaths)
    if (before.state !== 'idle') fail(before.state === 'busy' ? 'E_LIBRARY_BUSY' : 'E_MEDIA_JOB_REVIEW')
    const job = await createMediaJobStore(privatePaths).read(route.jobId)
    const {plan,selectedFileIds,editorOutcome,known} = await taskPlan(privatePaths,job,input)
    const after = await inspectLibraryOperation(privatePaths)
    if (after.state !== 'idle' || after.generation !== before.generation) fail('E_MEDIA_JOB_CONFLICT')
    const restoredMediaIds = editorOutcome?.result.restoredMediaIds ?? []
    const state = editorOutcome?.writes.find(write => write.file === 'editorState')?.value
    const orders = state ? Object.fromEntries([['photos',state.mediaOrderByCity],['drone',state.droneOrderByCity]]
      .map(([kind,table]) => [kind,Object.fromEntries(Object.entries(table).filter(([,ids]) => ids.some(id => restoredMediaIds.includes(id))))])) : {}
    return {status:200,body:{ok:true,job:{...known,canImport:plan.blockers.length === 0},plan:{digest:plan.digest,summary:{...plan.summary,
      editorEffects:{restoredMediaIds,orders}},blockers:plan.blockers,selectedFileIds}}}
  } catch(error) { return responseError(error) }
}

async function importTask(paths,store,job,input,deps) {
  if (!exactInput(input,['libraryId','revision','selectedFileIds','operationId','planDigest'])
    || !uuidPattern.test(input?.operationId) || !hashPattern.test(input?.planDigest ?? '')) fail('E_MEDIA_JOB_INVALID')
  assertIntent(job,input)
  const selectedFileIds = selectionOf(job,input.selectedFileIds)
  if (job.import) {
    if (job.import.operationId !== input.operationId || job.import.planDigest !== input.planDigest
      || job.import.sourceRevision !== input.revision || !isDeepStrictEqual(job.import.selectedFileIds,selectedFileIds)) fail('E_MEDIA_JOB_CONFLICT')
    if (job.import.phase !== 'sealed' || !['completed','closed'].includes(job.phase)) fail('E_MEDIA_JOB_REVIEW')
    return {status:200,body:{ok:true,replayed:true,job:await history(paths,job)}}
  }
  const {plan,editorOutcome} = await taskPlan(paths,job,input)
  if (plan.digest !== input.planDigest) fail('E_MEDIA_JOB_CONFLICT')
  if (plan.blockers.length) fail('E_MEDIA_IMPORT_BLOCKED')
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
    const applied = await applyMediaImportPlan({privatePaths:paths,plan,onStage:stage})
    const files = await checkedFiles(paths)
    const index = await readJson(paths.v2MediaSourceIndexPath)
    if (!isDeepStrictEqual(files.media,applied.catalog) || !isDeepStrictEqual(index,applied.index)) fail('E_MEDIA_JOB_REVIEW')
    // Calculate before starting, then confirm the same pure result before writing editor effects.
    const sourcePaths = job.files.filter(file => selectedFileIds.includes(file.fileId)).map(file => file.sourcePath)
    const currentOutcome = restoreImportedMedia(files,{sourcePaths,sourceIndex:index},createV2WriteContext({now:new Date()}))
    const expectedState = editorOutcome.writes.find(write => write.file === 'editorState')?.value
    const currentState = currentOutcome.writes.find(write => write.file === 'editorState')?.value
    // Transaction generated_at is a clock stamp, not an additional user-facing effect.
    const withoutStamp = value => value && {...value,updatedAt:undefined,generated_at:undefined}
    if (!isDeepStrictEqual(withoutStamp(expectedState),withoutStamp(currentState))) fail('E_MEDIA_JOB_CONFLICT')
    await verifyMediaImportPlanInputs({privatePaths:paths,plan})
    for (const write of currentOutcome.writes) await assertUploadPath(paths.root,paths.v2FilePaths[write.file])
    const failure = await applyV2Writes({privatePaths:paths,writes:currentOutcome.writes})
    if (failure) fail('E_MEDIA_JOB_REVIEW')
    await stage('editor')
    const finalFiles = await checkedFiles(paths)
    if (!isDeepStrictEqual(finalFiles.media,applied.catalog)
      || !isDeepStrictEqual(await readJson(paths.v2MediaSourceIndexPath),applied.index)) fail('E_MEDIA_JOB_REVIEW')
    const actualState = finalFiles.editorState
    if (!isDeepStrictEqual(actualState,currentState)) fail('E_MEDIA_JOB_REVIEW')
    await verifyMediaImportPlanInputs({privatePaths:paths,plan,editorWritten:true})
    for (const entry of plan.entries) {
      const source = path.join(paths.inboxRoot,...entry.sourcePath.split('/'))
      await assertUploadPath(paths.root,source)
      if ((await stat(source)).size !== entry.bytes || await digestFile(source) !== entry.sha256) fail('E_MEDIA_JOB_REVIEW')
    }
    for (const file of job.files.filter(file => selectedFileIds.includes(file.fileId))) {
      if (!await pinsAndMetadataMatch(paths,job,file)) fail('E_MEDIA_JOB_REVIEW')
    }
    for (const output of plan.summary.outputs) {
      const target = path.join(paths.root,...output.path.split('/'))
      await assertUploadPath(paths.root,target)
      if (await digestFile(target) !== output.sha256) fail('E_MEDIA_JOB_REVIEW')
    }
    const targets = [...Object.values(paths.v2FilePaths),paths.v2MediaSourceIndexPath,
      ...plan.summary.outputs.map(output => path.join(paths.root,...output.path.split('/'))),
      ...plan.entries.map(entry => path.join(paths.inboxRoot,...entry.sourcePath.split('/')))]
    const outputs = []
    for (const target of [...new Set(targets)].sort()) {
      await assertUploadPath(paths.root,target)
      let info
      try { info = await stat(target) } catch(error) { if (error.code === 'ENOENT' && ![paths.v2FilePaths.media,paths.v2FilePaths.editorState,paths.v2MediaSourceIndexPath].includes(target)) continue; throw error }
      if (!info.isFile()) fail('E_MEDIA_JOB_REVIEW')
      outputs.push({path:path.relative(paths.root,target).split(path.sep).join('/'),bytes:info.size,sha256:await digestFile(target)})
    }
    const receipt = {completedAt:new Date().toISOString(),mediaIds:applied.mediaIds,
      restoredMediaIds:currentOutcome.result.restoredMediaIds,outputs}
    receipt.seal = mediaJobReceiptSeal(job,job.import,receipt)
    job = await store.update(job.jobId,job.revision,next => {next.import.phase='sealed'; next.import.receipt=receipt; next.phase='completed'; return next})
    return {status:200,body:{ok:true,job:await history(paths,job)}}
  } catch(error) {
    try {await store.update(job.jobId,job.revision,next => {next.import.phase='needs_review';return next})} catch { /* Retain the last known stage if even recording the failure is impossible. */ }
    throw error
  }
}

/** Zero-write read: generation detects an operation starting and ending during the snapshot. */
export async function handleMediaJobRead({ privatePaths, route }) {
  try {
    const before = await inspectLibraryOperation(privatePaths)
    if (before.state !== 'idle') return { status: 200, body: { ok: true, libraryId: null, status: before.state === 'busy' ? 'processing' : 'needs_review', ...(route.action === 'get' ? {job:null} : {jobs:[]}) } }
    const store = createMediaJobStore(privatePaths)
    const discovered = await store.readSnapshot()
    const selected = route.action === 'get' ? discovered.jobs.find(job => job.jobId === route.jobId) : undefined
    if (route.action === 'get' && !selected) fail('E_MEDIA_JOB_NOT_FOUND')
    const jobs = route.action === 'get' ? [selected] : discovered.jobs
    const resourceChecks = new Map()
    const summaries = await Promise.all(jobs.map(job=>reconcile(privatePaths,job,resourceChecks)))
    const after = await inspectLibraryOperation(privatePaths)
    if (after.state !== 'idle' || after.generation !== before.generation) fail('E_MEDIA_JOB_CONFLICT')
    return { status:200, body: {ok:true,libraryId:discovered.libraryId,...(route.action === 'get' ? {job:summaries[0]} : {jobs:summaries})} }
  } catch (error) { return responseError(error) }
}

/** Internal entry: verifies caller's disk lease. HTTP authorization lives in the plugin. */
export async function handleMediaJobWrite({ privatePaths, route, input, request, url, deps, leaseToken }) {
  try {
    if (typeof leaseToken !== 'string') fail('E_LIBRARY_BUSY')
    return await withLibraryOperation(privatePaths, async () => {
      const store = createMediaJobStore(privatePaths)
      if (route.action === 'create') {
        const files = await checkedFiles(privatePaths)
        const target = uploadTargetOf(files, input ?? {}, new Date())
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
        return {status:201,body:{ok:true,job:await reconcile(privatePaths,job)}}
      }
      let job = await store.read(route.jobId)
      const params = route.action === 'receive' ? Object.fromEntries(url.searchParams) : input
      const revision = route.action === 'receive' && /^\d+$/.test(params?.revision ?? '') ? Number(params.revision) : params?.revision
      if (params?.libraryId !== job.libraryId || !Number.isSafeInteger(revision) || revision < 0) fail('E_MEDIA_JOB_CONFLICT')
      if (route.action === 'import') return importTask(privatePaths,store,job,input,deps)
      if (route.action === 'close') {
        if (!exactInput(input,['libraryId','revision'])) fail('E_MEDIA_JOB_INVALID')
        if (job.phase === 'closed') {
          if (revision > job.revision) fail('E_MEDIA_JOB_CONFLICT')
          return {status:200,body:{ok:true,replayed:true,job:await history(privatePaths,job)}}
        }
        job = await store.close(job.jobId,revision)
        return {status:200,body:{ok:true,job:await history(privatePaths,job)}}
      }
      if (route.action === 'pause') {
        if (!exactInput(input,['libraryId','revision'])) fail('E_MEDIA_JOB_INVALID')
        if (job.import || !['open','paused'].includes(job.phase)) fail('E_MEDIA_JOB_REVIEW')
        job = await store.pause(job.jobId,revision)
        return {status:200,body:{ok:true,job:await reconcile(privatePaths,job)}}
      }
      if (route.action !== 'receive') fail('E_UNKNOWN_ENDPOINT')
      if (job.import) fail('E_MEDIA_JOB_REVIEW')
      const file = job.files.find(file=>file.fileId === route.fileId)
      if (!file || !uuidPattern.test(params.operationId) || !hashPattern.test(params.sha256 ?? '')) fail('E_MEDIA_JOB_INVALID')
      if (Object.keys(params).some(key=>!['libraryId','revision','operationId','sha256'].includes(key))) fail('E_MEDIA_JOB_INVALID')
      if (file.operationId && (file.operationId !== params.operationId || file.expectedSha256 !== params.sha256)) fail('E_MEDIA_JOB_CONFLICT')
      if (Number(request.headers['content-length']) !== file.bytes) fail('E_MEDIA_JOB_CONFLICT')
      if (file.phase === 'received' && file.operationId === params.operationId) {
        if (revision > job.revision) fail('E_MEDIA_JOB_CONFLICT')
        const known = await reconcile(privatePaths,job)
        if (known.files.find(item=>item.fileId === file.fileId)?.status !== 'pending') fail('E_MEDIA_JOB_REVIEW')
        return {status:200,body:{ok:true,replayed:true,job:known}}
      }
      if (job.revision !== revision || file.phase !== 'intended') fail('E_MEDIA_JOB_CONFLICT')
      const before = await reconcile(privatePaths,job)
      if (before.status === 'needs_review') fail('E_MEDIA_JOB_REVIEW')
      const prepare = deps.prepareV2Upload ?? prepareV2Upload
      const plan = await prepare({ privatePaths, query:queryOf(job,file), deps })
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
        return {status:201,body:{ok:true,job:await reconcile(privatePaths,job)}}
      } catch (error) {
        // Preserve staging and published bytes. No automatic retransmission, cleanup or importer call.
        try { await store.update(job.jobId,job.revision,next=>{Object.assign(next.files.find(item=>item.fileId===file.fileId),{phase:'needs_review',errorCode:'E_MEDIA_JOB_REVIEW'});return next}) } catch { /* Leave the original stage for review. */ }
        throw error
      }
    },{leaseToken})
  } catch (error) { return responseError(error) }
}
