import { LocalEditorError } from '../i18n/editorErrors.ts'
import { fileSha256 } from './fileSha256.ts'
import { localEditorCoordination, type LocalEditorCoordination, type MediaImportPermit } from './localEditorCoordination.ts'
import { readMediaJobs, createMediaJob, receiveMediaJobFile, previewMediaJob, importMediaJob, pauseMediaJob, closeMediaJob, type LocalMediaUpload } from './localEditorApi.ts'

export type MediaJobFile = {
  fileId: string; fileName: string; bytes: number
  phase: 'intended' | 'receiving' | 'staged' | 'received' | 'needs_review'
  status: 'not_received' | 'pending' | 'needs_review' | 'completed'; canReceive: boolean
}
export type MediaJob = {
  jobId: string; libraryId: string; revision: number
  phase: 'open' | 'paused' | 'completed' | 'closed'
  countryId: string; cityId: string; kind: LocalMediaUpload['kind']; createdAt: string; updatedAt: string
  files: MediaJobFile[]; status: 'not_received' | 'pending' | 'needs_review' | 'completed' | 'closed'
  paused: boolean; canImport: boolean; canUpload: boolean; canPreview?: boolean; canClose?: boolean; importStage?: string
  completion?: {operationId: string; planDigest: string; completedAt: string; mediaIds: string[]; restoredMediaIds: string[]}
  warnings?: {kind: 'changed_resource'; path: string}[]
}
export type MediaJobPreview = {
  jobId: string; revision: number; selectedFileIds: string[]; blockers: {code: string; sourcePath?: string}[]
  plan: {digest: string; summary: {
    addedIds: string[]; updatedIds: string[]; removedIds: string[]
    sources: {id: string; sourcePath: string; sha256: string; bytes: number; kind: string; placeId: string}[]
    pins: {sourcePath: string; placeId: string}[]; outputs: {id: string; path: string; sha256: string}[]
    editorEffects: {restoredMediaIds: string[]; orders: Record<string, Record<string, string[]>>}
  }}
}
export type MediaJobsRead = {libraryId: string | null; jobs: MediaJob[]; status?: 'processing' | 'needs_review'}
export type MediaJobsSnapshot = MediaJobsRead & {loading: boolean; busy: boolean; error?: unknown; preview?: MediaJobPreview}
export type MediaJobIntent = {countryId: string; cityId: string; kind: LocalMediaUpload['kind']; files: {fileName: string; bytes: number; metadata?: Omit<LocalMediaUpload, 'countryId' | 'cityId' | 'kind' | 'file'>}[]}
export type MediaJobVersion = {libraryId: string; revision: number}
export type MediaJobsApi = {
  read: () => Promise<MediaJobsRead>
  create: (intent: MediaJobIntent, permit: MediaImportPermit) => Promise<MediaJob>
  receive: (jobId: string, fileId: string, input: MediaJobVersion & {operationId: string; sha256: string}, file: File, permit: MediaImportPermit) => Promise<MediaJob>
  preview: (jobId: string, input: MediaJobVersion & {selectedFileIds: string[]}) => Promise<MediaJobPreview>
  import: (jobId: string, input: MediaJobVersion & {selectedFileIds: string[]; operationId: string; planDigest: string}, permit: MediaImportPermit) => Promise<MediaJob>
  pause: (jobId: string, input: MediaJobVersion, permit: MediaImportPermit) => Promise<MediaJob>
  close: (jobId: string, input: MediaJobVersion, permit: MediaImportPermit) => Promise<MediaJob>
}

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(item => typeof item === 'string')
const relativePath = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && !v.includes('\\') && !v.includes(':') && v.split('/').every(part => part && part !== '.' && part !== '..')
const invalid = () => new LocalEditorError({code: 'E_EDITOR_RESPONSE_INVALID'})
const fault = (code: string) => new LocalEditorError({code})
const freezePreview = (preview: MediaJobPreview): MediaJobPreview => {
  const freeze = (value: unknown) => {
    if (value !== null && typeof value === 'object') {for (const item of Object.values(value)) freeze(item); Object.freeze(value)}
  }
  freeze(preview)
  return preview
}
export function assertMediaJob(value: unknown): asserts value is MediaJob {
  if (!record(value) || !uuid(value.jobId) || !uuid(value.libraryId) || !uuid(value.countryId) || !uuid(value.cityId)
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
    || !['open', 'paused', 'completed', 'closed'].includes(String(value.phase))
    || !['photo', 'aerialPhoto', 'panorama360'].includes(String(value.kind))
    || !['not_received', 'pending', 'needs_review', 'completed', 'closed'].includes(String(value.status))
    || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string'
    || typeof value.paused !== 'boolean' || typeof value.canImport !== 'boolean' || typeof value.canUpload !== 'boolean'
    || (value.canPreview !== undefined && typeof value.canPreview !== 'boolean') || (value.canClose !== undefined && typeof value.canClose !== 'boolean')
    || (value.importStage !== undefined && typeof value.importStage !== 'string')
    || !Array.isArray(value.files) || value.files.length === 0 || value.files.length > 100) throw invalid()
  const ids = new Set<string>(), names = new Set<string>()
  for (const file of value.files) {
    if (!record(file) || !uuid(file.fileId) || ids.has(file.fileId) || typeof file.fileName !== 'string' || !file.fileName || file.fileName.length > 120 || names.has(file.fileName.toLowerCase())
      || !Number.isSafeInteger(file.bytes) || Number(file.bytes) <= 0 || Number(file.bytes) > 250 * 1024 * 1024
      || !['intended', 'receiving', 'staged', 'received', 'needs_review'].includes(String(file.phase))
      || !['not_received', 'pending', 'needs_review', 'completed'].includes(String(file.status)) || typeof file.canReceive !== 'boolean'
      || (file.canReceive && (file.phase !== 'intended' || file.status !== 'not_received'))) throw invalid()
    ids.add(file.fileId)
    names.add(file.fileName.toLowerCase())
  }
  if (['completed', 'closed'].includes(String(value.phase))) {
    const completion = value.completion
    if (!record(completion) || !uuid(completion.operationId) || !hash(completion.planDigest) || typeof completion.completedAt !== 'string'
      || !strings(completion.mediaIds) || !strings(completion.restoredMediaIds) || value.canImport || value.canUpload
      || value.status !== value.phase || value.paused || value.files.some(file => file.canReceive || (file.status === 'completed' ? file.phase !== 'received' : file.status !== 'not_received' || file.phase !== 'intended'))) throw invalid()
  } else if (value.completion !== undefined || ['completed', 'closed'].includes(String(value.status))) throw invalid()
  if (value.paused !== (value.phase === 'paused') || (value.canImport && (value.status !== 'pending' || !value.canPreview))
    || (value.canPreview && value.status !== 'pending') || (value.canUpload && value.status !== 'not_received')
    || (value.canClose && value.phase !== 'completed') || (value.status === 'needs_review' && value.files.some(file => file.canReceive))) throw invalid()
  if (value.warnings !== undefined && (!Array.isArray(value.warnings) || value.warnings.some(item => !record(item) || item.kind !== 'changed_resource' || !relativePath(item.path)))) throw invalid()
}
export function assertMediaJobsRead(value: unknown): asserts value is MediaJobsRead {
  if (!record(value) || (value.libraryId !== null && !uuid(value.libraryId)) || !Array.isArray(value.jobs)) throw invalid()
  if (value.status !== undefined && !['processing', 'needs_review'].includes(String(value.status))) throw invalid()
  if (value.status !== undefined && (value.libraryId !== null || value.jobs.length !== 0)) throw invalid()
  const ids = new Set<string>()
  for (const job of value.jobs) {
    assertMediaJob(job)
    if (value.libraryId !== job.libraryId || ids.has(job.jobId)) throw invalid()
    ids.add(job.jobId)
  }
  if (value.jobs.filter(job => job.phase !== 'completed' && job.phase !== 'closed').length > 1) throw invalid()
}
export function assertMediaJobPreview(value: unknown): asserts value is MediaJobPreview {
  if (!record(value) || !uuid(value.jobId) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !strings(value.selectedFileIds)
    || !value.selectedFileIds.length || !value.selectedFileIds.every(uuid) || new Set(value.selectedFileIds).size !== value.selectedFileIds.length
    || !Array.isArray(value.blockers) || value.blockers.some(item => !record(item) || typeof item.code !== 'string' || (item.sourcePath !== undefined && !relativePath(item.sourcePath)))
    || !record(value.plan) || !hash(value.plan.digest) || !record(value.plan.summary)) throw invalid()
  const summary = value.plan.summary
  if (!strings(summary.addedIds) || !strings(summary.updatedIds) || !strings(summary.removedIds)
    || !Array.isArray(summary.sources) || summary.sources.some(item => !record(item) || typeof item.id !== 'string' || !relativePath(item.sourcePath) || !hash(item.sha256) || !Number.isSafeInteger(item.bytes) || Number(item.bytes) <= 0 || !['photo', 'aerialPhoto', 'panorama360', 'video'].includes(String(item.kind)) || !uuid(item.placeId))
    || !Array.isArray(summary.pins) || summary.pins.some(item => !record(item) || !relativePath(item.sourcePath) || !uuid(item.placeId))
    || !Array.isArray(summary.outputs) || summary.outputs.some(item => !record(item) || typeof item.id !== 'string' || !relativePath(item.path) || !hash(item.sha256))
    || !record(summary.editorEffects) || !strings(summary.editorEffects.restoredMediaIds) || !record(summary.editorEffects.orders)
    || Object.values(summary.editorEffects.orders).some(table => !record(table) || Object.values(table).some(ids => !strings(ids)))) throw invalid()
}

const defaultApi: MediaJobsApi = {
  read: () => readMediaJobs(), create: (intent, permit) => createMediaJob(intent, permit),
  receive: (...args) => receiveMediaJobFile(...args), preview: (...args) => previewMediaJob(...args),
  import: (...args) => importMediaJob(...args), pause: (...args) => pauseMediaJob(...args), close: (...args) => closeMediaJob(...args),
}
const version = (job: MediaJob): MediaJobVersion => ({libraryId: job.libraryId, revision: job.revision})
const unfinished = (job: MediaJob) => job.phase !== 'completed' && job.phase !== 'closed'
const selected = (job: MediaJob) => job.files.filter(file => file.phase === 'received' && file.status === 'pending').map(file => file.fileId).sort()
const checkContinuation = (before: MediaJob, after: MediaJob) => {
  assertMediaJob(after)
  if (['jobId', 'libraryId', 'countryId', 'cityId', 'kind'].some(key => before[key as keyof MediaJob] !== after[key as keyof MediaJob])
    || after.revision < before.revision || after.files.length !== before.files.length
    || before.files.some(file => !after.files.some(next => next.fileId === file.fileId && next.fileName === file.fileName && next.bytes === file.bytes))) throw invalid()
}

/** Durable facts come only from the server. A failed write is followed by GET, never a replay. */
export function createMediaJobs({api = defaultApi, coordination = localEditorCoordination,
  hashFile = fileSha256,
  operationId = () => crypto.randomUUID() as string,
}: {api?: MediaJobsApi; coordination?: LocalEditorCoordination; hashFile?: (file: File) => Promise<string>; operationId?: () => string} = {}) {
  let state: MediaJobsSnapshot = Object.freeze({jobs: [], libraryId: null, loading: false, busy: false})
  let readSequence = 0, mutation = false
  let acknowledged: MediaJobPreview | undefined
  const listeners = new Set<() => void>()
  const publish = (next: MediaJobsSnapshot) => {state = Object.freeze(next); for (const listener of listeners) listener()}
  const putJob = (job: MediaJob) => {
    assertMediaJob(job)
    ++readSequence
    publish({...state, loading: false, libraryId: job.libraryId, status: undefined, jobs: [...state.jobs.filter(item => item.jobId !== job.jobId), job], preview: undefined})
    acknowledged = undefined
  }
  const refresh = async () => {
    const sequence = ++readSequence
    publish({...state, loading: true})
    try {
      const result = await api.read()
      assertMediaJobsRead(result)
      if (sequence !== readSequence) return
      const stillValid = !result.status && state.preview && result.jobs.some(job => job.jobId === state.preview?.jobId && job.revision === state.preview.revision && job.libraryId === state.libraryId && job.status === 'pending')
      if (!stillValid) acknowledged = undefined
      // A locked library cannot yield task facts; retain the last known records, disable all actions.
      publish({...state, ...result, jobs: result.status ? state.jobs : result.jobs, preview: stillValid ? state.preview : undefined, loading: false, error: undefined})
    } catch (error) {
      if (sequence === readSequence) {acknowledged = undefined; publish({...state, loading: false, preview: undefined, error, status: 'needs_review'})}
      throw error
    }
  }
  const getJob = (jobId: string) => {
    if (state.status) throw fault('E_MEDIA_JOB_REVIEW')
    const job = state.jobs.find(item => item.jobId === jobId)
    if (!job) throw fault('E_MEDIA_JOB_NOT_FOUND')
    return job
  }
  const run = async <T>(target: string, operation: (permit: MediaImportPermit) => Promise<T>): Promise<T> => {
    if (mutation) throw fault('E_MEDIA_IMPORT_BUSY')
    mutation = true
    let permit: MediaImportPermit | undefined
    try {
      permit = coordination.beginMedia(target)
      ++readSequence
      acknowledged = undefined
      publish({...state, busy: true, loading: false, preview: undefined, error: undefined})
      return await operation(permit)
    } catch (error) {
      // No action is inferred from an unreadable/lost response. Discovery may find sealed success.
      try {await refresh()} catch { /* Preserve the initiating error and last known facts. */ }
      publish({...state, error})
      throw error
    } finally {
      if (permit) coordination.releaseMedia(permit)
      mutation = false
      publish({...state, busy: false})
    }
  }
  const receive = async (job: MediaJob, pairs: {intent: MediaJobFile; file: File}[], permit: MediaImportPermit) => {
    for (const pair of pairs) {
      const sha256 = await hashFile(pair.file)
      if (!hash(sha256)) throw fault('E_MEDIA_JOB_INVALID')
      const current = job.files.find(item => item.fileId === pair.intent.fileId)
      if (!current?.canReceive || current.phase !== 'intended') throw fault('E_MEDIA_JOB_CONFLICT')
      const result = await api.receive(job.jobId, current.fileId, {...version(job), operationId: operationId(), sha256}, pair.file, permit)
      checkContinuation(job, result)
      const received = result.files.find(item => item.fileId === current.fileId)
      if (result.revision <= job.revision || received?.phase !== 'received' || received.status !== 'pending') throw invalid()
      job = result
      putJob(job)
    }
  }
  return Object.freeze({
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {listeners.add(listener); return () => {listeners.delete(listener)}},
    refresh,
    uploadBatch: async (uploads: LocalMediaUpload[]) => run('durable-media', async permit => {
      const first = uploads[0]
      if (!first || uploads.length > 100 || uploads.some(item => item.countryId !== first.countryId || item.cityId !== first.cityId || item.kind !== first.kind
        || !item.file.name || item.file.name.length > 120 || item.file.size <= 0 || item.file.size > 250 * 1024 * 1024)
        || new Set(uploads.map(item => item.file.name.toLowerCase())).size !== uploads.length) throw fault('E_MEDIA_JOB_INVALID')
      await refresh()
      if (state.status || state.jobs.some(unfinished)) throw fault('E_MEDIA_JOB_PENDING')
      const job = await api.create({countryId: first.countryId, cityId: first.cityId, kind: first.kind, files: uploads.map(item => {
        const {file, countryId: _country, cityId: _city, kind: _kind, ...metadata} = item
        void _country; void _city; void _kind
        return {fileName: file.name, bytes: file.size, ...(first.kind === 'photo' ? {} : {metadata})}
      })}, permit)
      assertMediaJob(job)
      if (job.files.length !== uploads.length || job.countryId !== first.countryId || job.cityId !== first.cityId || job.kind !== first.kind) throw invalid()
      const pairs = uploads.map(upload => {
        const intent = job.files.find(item => item.fileName === upload.file.name && item.bytes === upload.file.size)
        if (!intent) throw invalid()
        return {intent, file: upload.file}
      })
      putJob(job)
      await receive(job, pairs, permit)
    }),
    receiveMissing: async (jobId: string, files: File[]) => run(jobId, async permit => {
      await refresh()
      const job = getJob(jobId)
      if (!unfinished(job) || !files.length || new Set(files.map(file => file.name)).size !== files.length) throw fault('E_MEDIA_JOB_INVALID')
      const pairs = files.map(file => {
        const matches = job.files.filter(item => item.fileName === file.name && item.bytes === file.size && item.canReceive && item.phase === 'intended' && item.status === 'not_received')
        if (matches.length !== 1) throw fault('E_MEDIA_JOB_CONFLICT')
        return {intent: matches[0], file}
      })
      await receive(job, pairs, permit)
    }),
    preview: async (jobId: string) => run(jobId, async () => {
      await refresh()
      const job = getJob(jobId)
      if (!job.canPreview || job.status !== 'pending') throw fault('E_MEDIA_JOB_REVIEW')
      const result = await api.preview(jobId, {...version(job), selectedFileIds: selected(job)})
      assertMediaJobPreview(result)
      if (result.jobId !== jobId || result.revision !== job.revision || JSON.stringify([...result.selectedFileIds].sort()) !== JSON.stringify(selected(job))) throw invalid()
      const latest = getJob(jobId)
      if (latest.revision !== job.revision || latest.libraryId !== job.libraryId || latest.status !== 'pending') throw fault('E_MEDIA_JOB_CONFLICT')
      acknowledged = freezePreview(result)
      publish({...state, preview: result})
      return result
    }),
    importJob: async (jobId: string, preview: MediaJobPreview) => {
      assertMediaJobPreview(preview)
      if (preview !== acknowledged || preview.jobId !== jobId || preview.blockers.length > 0) throw fault('E_MEDIA_JOB_CONFLICT')
      const job = getJob(jobId)
      if (job.revision !== preview.revision || job.status !== 'pending') throw fault('E_MEDIA_JOB_CONFLICT')
      await run(jobId, async permit => {
        const result = await api.import(jobId, {...version(job), selectedFileIds: preview.selectedFileIds, operationId: operationId(), planDigest: preview.plan.digest}, permit)
        checkContinuation(job, result)
        if (result.jobId !== jobId || result.phase !== 'completed') throw invalid()
        putJob(result)
      })
    },
    pause: async (jobId: string) => run(jobId, async permit => {
      await refresh()
      const job = getJob(jobId)
      if (!unfinished(job) || job.status === 'needs_review') throw fault('E_MEDIA_JOB_REVIEW')
      const result = await api.pause(jobId, version(job), permit)
      checkContinuation(job, result)
      if (result.phase !== 'paused') throw invalid()
      putJob(result)
    }),
    close: async (jobId: string) => run(jobId, async permit => {
      await refresh()
      const job = getJob(jobId)
      if (!job.canClose && job.phase !== 'closed') throw fault('E_MEDIA_JOB_REVIEW')
      const result = await api.close(jobId, version(job), permit)
      checkContinuation(job, result)
      if (result.phase !== 'closed') throw invalid()
      putJob(result)
    }),
  })
}
export const mediaJobs = createMediaJobs()
