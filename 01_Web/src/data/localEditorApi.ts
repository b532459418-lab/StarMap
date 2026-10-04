import type { TravelAtlasEditorState } from './editorState'
import type { WantToGoItem } from './derive/wantToGo.ts'
import { parseLocalEditorResponse as parseResponse } from './localEditorResponse.ts'
import { parseMediaImportResponse, parseMediaUploadResponse } from './localMediaResponse.ts'
import { LocalEditorError } from '../i18n/editorErrors.ts'
import { assertLocalEditorReloadAllowed, withLocalEditorWrite, type MediaImportPermit } from './localEditorCoordination.ts'
import { assertMediaJob, assertMediaJobsRead, assertMediaJobPreview, type MediaJob, type MediaJobsRead, type MediaJobPreview, type MediaJobIntent, type MediaJobVersion } from './mediaJobs.ts'

const editorHeaders = {
  'content-type': 'application/json',
  'x-travelatlas-local-editor': '1',
}

export type CountrySearchOption = {
  id: string
  nameZh: string
  nameEn: string
  countryCode: string
  centerLat: number
  centerLng: number
  region?: string
}

export type CitySearchOption = {
  id: string
  nameZh: string
  nameEn: string
  countryCode: string
  lat: number
  lng: number
  detail: string
  provider: 'cesium' | 'openstreetmap' | 'manual'
}

export const searchLocalCountries = async (query: string, signal?: AbortSignal) => {
  const search = new URLSearchParams({ q: query })
  const response = await fetch(`/__travelatlas/editor/catalog/countries?${search}`, {
    cache: 'no-store',
    signal,
  })
  return (await parseResponse<{ results: CountrySearchOption[] }>(response)).results
}

export const searchLocalCities = async (
  query: string,
  countryCode: string,
  signal?: AbortSignal,
) => {
  const search = new URLSearchParams({ q: query, countryCode })
  const response = await fetch(`/__travelatlas/editor/catalog/cities?${search}`, {
    cache: 'no-store',
    signal,
  })
  return (await parseResponse<{ results: CitySearchOption[] }>(response)).results
}

export const addLocalCountry = (countryCode: string, visitedDate?: string) => withLocalEditorWrite(async () => {
  const response = await fetch('/__travelatlas/editor/countries', {
    method: 'POST',
    headers: editorHeaders,
    body: JSON.stringify({ countryCode, visitedDate }),
  })
  return parseResponse<{ countryId: string }>(response)
})

export const readLocalEditorState = async () => {
  const response = await fetch('/__travelatlas/editor/state', { cache: 'no-store' })
  return (await parseResponse<{ state: TravelAtlasEditorState }>(response)).state
}

export const updateLocalEditorState = (
  update: (current: TravelAtlasEditorState) => TravelAtlasEditorState,
) => withLocalEditorWrite(async () => {
  const current = await readLocalEditorState()
  const response = await fetch('/__travelatlas/editor/state', {
    method: 'PUT',
    headers: editorHeaders,
    body: JSON.stringify(update(current)),
  })
  return (await parseResponse<{ state: TravelAtlasEditorState }>(response)).state
})

export type LocalMediaUpload = {
  countryId: string
  cityId: string
  kind: 'photo' | 'panorama360' | 'aerialPhoto'
  file: File
  date?: string
  lat?: number
  lng?: number
  altitudeMeters?: number
  relativeAltitudeMeters?: number
  titleZh?: string
  titleEn?: string
}

export const uploadLocalMedia = (upload: LocalMediaUpload, permit?: MediaImportPermit) => withLocalEditorWrite(async () => {
  const search = new URLSearchParams({
    countryId: upload.countryId,
    cityId: upload.cityId,
    kind: upload.kind,
    fileName: upload.file.name,
  })
  if (upload.date) search.set('date', upload.date)
  if (upload.lat !== undefined) search.set('lat', String(upload.lat))
  if (upload.lng !== undefined) search.set('lng', String(upload.lng))
  if (upload.altitudeMeters !== undefined) search.set('altitudeMeters', String(upload.altitudeMeters))
  if (upload.relativeAltitudeMeters !== undefined) search.set('relativeAltitudeMeters', String(upload.relativeAltitudeMeters))
  if (upload.titleZh) search.set('titleZh', upload.titleZh)
  if (upload.titleEn) search.set('titleEn', upload.titleEn)

  const response = await fetch(`/__travelatlas/editor/upload?${search}`, {
    method: 'POST',
    headers: {
      'content-type': upload.file.type || 'application/octet-stream',
      'x-travelatlas-local-editor': '1',
    },
    body: upload.file,
  })
  return parseMediaUploadResponse(response)
}, permit)

export const importLocalMedia = (sourcePaths: string[] = [], permit?: MediaImportPermit) => withLocalEditorWrite(async () => {
  const response = await fetch('/__travelatlas/editor/import', {
    method: 'POST',
    headers: editorHeaders,
    body: JSON.stringify({ sourcePaths }),
  })
  return parseMediaImportResponse(response, sourcePaths)
}, permit)

const mediaJobsPath = '/__travelatlas/editor/media/jobs'
const responseInvalid = () => new LocalEditorError({ code: 'E_EDITOR_RESPONSE_INVALID' })
const jobResponse = async (response: Response, expectedJobId?: string): Promise<MediaJob> => {
  const body = await parseResponse<{job: unknown}>(response)
  assertMediaJob(body.job)
  if (expectedJobId && body.job.jobId !== expectedJobId) throw responseInvalid()
  return body.job
}
export const readMediaJobs = async (): Promise<MediaJobsRead> => {
  const response = await fetch(mediaJobsPath, {cache: 'no-store', headers: {'x-travelatlas-local-editor': '1'}})
  const body = await parseResponse<MediaJobsRead>(response)
  assertMediaJobsRead(body)
  return {libraryId: body.libraryId, jobs: body.jobs, ...(body.status ? {status: body.status} : {})}
}
export const createMediaJob = (intent: MediaJobIntent, permit: MediaImportPermit) => withLocalEditorWrite(async () => {
  const response = await fetch(mediaJobsPath, {method: 'POST', headers: editorHeaders, body: JSON.stringify(intent)})
  return jobResponse(response)
}, permit)
export const receiveMediaJobFile = (jobId: string, fileId: string,
  input: MediaJobVersion & {operationId: string; sha256: string}, file: File, permit: MediaImportPermit) => withLocalEditorWrite(async () => {
  const query = new URLSearchParams({...input, revision: String(input.revision)})
  const response = await fetch(`${mediaJobsPath}/${encodeURIComponent(jobId)}/files/${encodeURIComponent(fileId)}?${query}`, {
    method: 'POST', headers: {'content-type': file.type || 'application/octet-stream', 'x-travelatlas-local-editor': '1'}, body: file,
  })
  return jobResponse(response, jobId)
}, permit)
export const previewMediaJob = async (jobId: string, input: MediaJobVersion & {selectedFileIds: string[]}): Promise<MediaJobPreview> => {
  const response = await fetch(`${mediaJobsPath}/${encodeURIComponent(jobId)}/preview`, {method: 'POST', headers: editorHeaders, body: JSON.stringify(input)})
  const body = await parseResponse<{job: unknown; plan: unknown}>(response)
  assertMediaJob(body.job)
  if (body.job.jobId !== jobId || body.job.libraryId !== input.libraryId || body.job.revision !== input.revision || body.plan === null || typeof body.plan !== 'object') throw responseInvalid()
  const plan = body.plan as Record<string, unknown>
  const result = {jobId, revision: body.job.revision, plan: {digest: plan.digest, summary: plan.summary}, selectedFileIds: plan.selectedFileIds, blockers: plan.blockers}
  assertMediaJobPreview(result)
  if (body.job.canImport !== (result.blockers.length === 0)) throw responseInvalid()
  return result
}
const mutateMediaJob = (action: 'import' | 'pause' | 'close', jobId: string, input: MediaJobVersion, permit: MediaImportPermit) => withLocalEditorWrite(async () => {
  const response = await fetch(`${mediaJobsPath}/${encodeURIComponent(jobId)}/${action}`, {method: 'POST', headers: editorHeaders, body: JSON.stringify(input)})
  const job = await jobResponse(response, jobId)
  if (job.libraryId !== input.libraryId || job.revision < input.revision) throw responseInvalid()
  return job
}, permit)
export const importMediaJob = (jobId: string, input: MediaJobVersion & {selectedFileIds: string[]; operationId: string; planDigest: string}, permit: MediaImportPermit) => mutateMediaJob('import', jobId, input, permit)
export const pauseMediaJob = (jobId: string, input: MediaJobVersion, permit: MediaImportPermit) => mutateMediaJob('pause', jobId, input, permit)
export const closeMediaJob = (jobId: string, input: MediaJobVersion, permit: MediaImportPermit) => mutateMediaJob('close', jobId, input, permit)

export const deleteHiddenLocalMedia = (cityId: string, ids: string[]) => withLocalEditorWrite(async () => {
  const response = await fetch('/__travelatlas/editor/media/delete', {
    method: 'POST',
    headers: editorHeaders,
    body: JSON.stringify({ cityId, ids }),
  })
  return parseResponse<{ deletedIds: string[]; deletedSourceFiles: number; output: string }>(response)
})

export const deleteHiddenLocalCountries = (ids: string[]) => withLocalEditorWrite(async () => {
  const response = await fetch('/__travelatlas/editor/countries/delete', {
    method: 'POST',
    headers: editorHeaders,
    body: JSON.stringify({ ids }),
  })
  return parseResponse<{
    deletedCountryIds: string[]
    deletedRecordCount: number
  }>(response)
})

export type LocalTravelRecordInput = {
  country: string
  country_en: string
  country_code?: string
  city: string
  city_en: string
  start_date: string
  end_date?: string
  lat: number
  lng: number
  trip_title?: string
}

export const addLocalTravelRecord = (input: LocalTravelRecordInput) => withLocalEditorWrite(async () => {
  const response = await fetch('/__travelatlas/editor/records', {
    method: 'POST',
    headers: editorHeaders,
    body: JSON.stringify(input),
  })
  return parseResponse<{ id: string; countryId: string; cityId: string }>(response)
})

// ---- Want to Go（FR-WTG-6 / D26）----
// 写入路径的唯一出口就是本文件：组件里不得出现任何 fetch。

export type LocalWantToGoInput = {
  place: {
    kind: 'city' | 'country'
    nameZh?: string
    nameEn: string
    countryCode: string
    lat?: number
    lng?: number
  }
  note?: string
  addedAt?: string
}

export type ExistingPlaceWantToGoInput = { placeId: string; note?: string; addedAt?: string }

export const addLocalWantToGo = (input: LocalWantToGoInput | ExistingPlaceWantToGoInput) => withLocalEditorWrite(async () => {
  const response = await fetch('/__travelatlas/editor/wanttogo', {
    method: 'POST',
    headers: editorHeaders,
    body: JSON.stringify(input),
  })
  const result = await parseResponse<{ id: string; item: WantToGoItem }>(response)
  if (typeof result.id !== 'string' || !result.id || result.item?.id !== result.id || !result.item?.place) {
    throw new LocalEditorError({ code: 'E_EDITOR_RESPONSE_INVALID', params: { status: response.status } })
  }
  return result
})

export const updateLocalWantToGo = (
  id: string,
  patch: { hidden?: boolean; note?: string },
) => withLocalEditorWrite(async () => {
  const response = await fetch('/__travelatlas/editor/wanttogo/update', {
    method: 'POST',
    headers: editorHeaders,
    body: JSON.stringify({ id, ...patch }),
  })
  return parseResponse<{ item: WantToGoItem }>(response)
})

export const deleteHiddenLocalWantToGo = (ids: string[]) => withLocalEditorWrite(async () => {
  const response = await fetch('/__travelatlas/editor/wanttogo/delete', {
    method: 'POST',
    headers: editorHeaders,
    body: JSON.stringify({ ids }),
  })
  return parseResponse<{ deletedIds: string[] }>(response)
})

// ---- 想去 → 足迹（PR9，PRD S5 / R13）----
// 一个端点完成整件事：新增足迹城市（或把 planned 改为已去过）、按需更新国家排序、默认移除想去条目。
// 日期一律由用户填写，这里原样转发，不补默认值。

export type LocalConvertToTravelInput =
  | {
      source: 'want-to-go'
      id: string
      startDate: string
      endDate?: string
      tripTitle?: string
      keepWantToGo?: boolean
    }
  | { source: 'planned'; recordId: string; startDate: string; endDate?: string }

export type LocalConvertToTravelResult = {
  travelRecordId: string
  countryId: string
  cityId: string
  wantToGoRemoved: boolean
}

export const convertLocalWantToGoToTravel = (input: LocalConvertToTravelInput) => withLocalEditorWrite(async () => {
  const response = await fetch('/__travelatlas/editor/wanttogo/convert', {
    method: 'POST',
    headers: editorHeaders,
    body: JSON.stringify(input),
  })
  return parseResponse<LocalConvertToTravelResult>(response)
})

export const reloadAfterLocalSave = () => {
  assertLocalEditorReloadAllowed()
  window.location.reload()
}
