/**
 * 本地编辑器的全部请求（`/__travelatlas/editor/*`）。浏览器里只由 ./localEditorClient.ts 在 `localEditorAvailable`
 * 为真时动态加载，构建产物里没有本模块（第 5B 批）。组件不直接导入它（`import type` 除外）；单元测试直接导入。
 */
import type { TravelAtlasEditorState } from './editorState'
import type { WantToGoItem } from './derive/wantToGo.ts'
import { parseLocalEditorResponse as parseResponse } from './localEditorResponse.ts'
import { LocalEditorError } from '../i18n/editorErrors.ts'
import { requireLocalEditorReload, withLocalEditorWrite, type MediaImportPermit } from './localEditorCoordination.ts'
import { sendStoreWrite, type StoreWriteHeaders } from './storeWriteProtocol.ts'
import { assertMediaJob, assertMediaJobsRead, assertMediaJobPreview, type MediaJob, type MediaJobsRead, type MediaJobPreview, type MediaJobIntent, type MediaJobVersion } from './mediaJobs.ts'

/** 第 2A 批：409 `E_PLACE_CHOICE_REQUIRED` 的候选列表交给界面（./placeChoice.ts）。 */
export { placeChoiceCandidatesOf, type PlaceChoiceCandidate } from './placeChoice.ts'
/** 第 2C 批：409 `E_JOURNEY_CHOICE_REQUIRED` 的候选行程交给界面（./journeyChoice.ts）。 */
export { journeyChoiceCandidatesOf, type JourneyChoiceCandidate } from './journeyChoice.ts'

/**
 * 行程选择（第 2C 批）：新记录的行程标题与已有行程相同时，服务端返回 409 `E_JOURNEY_CHOICE_REQUIRED`（什么都不写）；
 * 用户选定后再提交，加入已有行程带 `journeyId`，新建行程带 `newJourney: true`。
 */
export type JourneyChoiceFields = { journeyId?: string; newJourney?: true }

const editorHeaders = {
  'content-type': 'application/json',
  'x-travelatlas-local-editor': '1',
}

// 新库（3C-3 起；3C-4d 起是唯一的写入方式）：页面加载时的全库修订号。./localEditorClient.ts 加载本模块时设一次；不是新库时为 undefined。
// 一次写入提交成功后改为它回答的修订号：同一个操作接着写第二次（例如先隐藏国家、再彻底删除）时不算过期。
let storeBaseRevision: number | undefined
export const setStoreBaseRevision = (revision: number | undefined) => {
  storeBaseRevision = Number.isSafeInteger(revision) ? revision : undefined
}

/**
 * 新库模式的一次写入（3C-3、3C-4a，./storeWriteProtocol.ts）：带上请求编号与修订号；结果不明时用同一个请求编号重试一次，
 * 仍然不明就要求整页刷新。提交成功后，页面的修订号前移到回答里的修订号。
 */
const sendToStore = async <T>(send: (protocol: StoreWriteHeaders) => Promise<T>, baseRevision: number): Promise<T> => {
  const result = await sendStoreWrite(send, { baseRevision, onUnconfirmed: requireLocalEditorReload })
  const revision = (result as { revision?: unknown }).revision
  if (typeof revision === 'number') setStoreBaseRevision(revision)
  return result
}

/**
 * 8 个编辑端点（JSON 请求体）共用的写入：V2 模式与原来完全相同（同样的请求）；新库模式下经 `sendToStore` 带上协议。
 * `parse` 解析响应（parseResponse 或在它之上再校验）。
 */
const editorWrite = <T>(path: string, method: 'POST' | 'PUT', body: unknown, parse: (response: Response) => Promise<T>) => {
  const send = (protocol: StoreWriteHeaders = {}) => withLocalEditorWrite(async () => {
    const response = await fetch(path, { method, headers: { ...editorHeaders, ...protocol }, body: JSON.stringify(body) })
    return parse(response)
  })
  const baseRevision = storeBaseRevision
  return baseRevision === undefined ? send() : sendToStore(send, baseRevision)
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

export const addLocalCountry = (countryCode: string, visitedDate?: string) =>
  editorWrite('/__travelatlas/editor/countries', 'POST', { countryCode, visitedDate }, parseResponse<{ countryId: string }>)

export const readLocalEditorState = async () => {
  const response = await fetch('/__travelatlas/editor/state', { cache: 'no-store' })
  return (await parseResponse<{ state: TravelAtlasEditorState }>(response)).state
}

const parseEditorState = async (response: Response) => (await parseResponse<{ state: TravelAtlasEditorState; revision?: number }>(response))

/**
 * 整份取回 → 改 → 整份写回。新库模式下请求体只算一次：结果不明而重试时发送同一份（同一个请求编号对应同一个意图）。
 */
export const updateLocalEditorState = (
  update: (current: TravelAtlasEditorState) => TravelAtlasEditorState,
) => {
  const baseRevision = storeBaseRevision
  if (baseRevision === undefined) {
    return withLocalEditorWrite(async () => {
      const current = await readLocalEditorState()
      const response = await fetch('/__travelatlas/editor/state', {
        method: 'PUT',
        headers: editorHeaders,
        body: JSON.stringify(update(current)),
      })
      return (await parseResponse<{ state: TravelAtlasEditorState }>(response)).state
    })
  }
  return withLocalEditorWrite(async () => {
    const next = update(await readLocalEditorState())
    return (await editorWrite('/__travelatlas/editor/state', 'PUT', next, parseEditorState)).state
  })
}

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
  // 3C-4c: the page's own mode decides which preview it accepts; a V2 page never takes a new-library one.
  assertMediaJobPreview(result, {mode: storeBaseRevision === undefined ? 'v2' : 'store'})
  if (body.job.canImport !== (result.blockers.length === 0)) throw responseInvalid()
  return result
}
const mutateMediaJob = (action: 'import' | 'pause' | 'close' | 'abandon', jobId: string, input: MediaJobVersion, permit: MediaImportPermit) => withLocalEditorWrite(async () => {
  const response = await fetch(`${mediaJobsPath}/${encodeURIComponent(jobId)}/${action}`, {method: 'POST', headers: editorHeaders, body: JSON.stringify(input)})
  const job = await jobResponse(response, jobId)
  if (job.libraryId !== input.libraryId || job.revision < input.revision) throw responseInvalid()
  return job
}, permit)
/** Batch 2A: `acceptFolderBindings` confirms the preview's folder bindings found by name; required when it lists any. */
export const importMediaJob = (jobId: string, input: MediaJobVersion & {selectedFileIds: string[]; operationId: string; planDigest: string; acceptFolderBindings?: boolean; acceptSourceMatches?: boolean}, permit: MediaImportPermit) => mutateMediaJob('import', jobId, input, permit)
export const pauseMediaJob = (jobId: string, input: MediaJobVersion, permit: MediaImportPermit) => mutateMediaJob('pause', jobId, input, permit)
export const closeMediaJob = (jobId: string, input: MediaJobVersion, permit: MediaImportPermit) => mutateMediaJob('close', jobId, input, permit)
/** Batch 1 D2: end an open/paused task without touching any file; the next import realigns with the Inbox. */
export const abandonMediaJob = (jobId: string, input: MediaJobVersion, permit: MediaImportPermit) => mutateMediaJob('abandon', jobId, input, permit)

/** 彻底删除隐藏媒体。V2 模式的请求不变；新库模式（3C-4c）经 `editorWrite` 带上请求编号与修订号。 */
export const deleteHiddenLocalMedia = (cityId: string, ids: string[]) => editorWrite('/__travelatlas/editor/media/delete', 'POST', { cityId, ids },
  parseResponse<{ deletedIds: string[]; deletedSourceFiles: number; output: string }>)

export const deleteHiddenLocalCountries = (ids: string[]) => editorWrite('/__travelatlas/editor/countries/delete', 'POST', { ids }, parseResponse<{
  deletedCountryIds: string[]
  deletedRecordCount: number
}>)

/**
 * 按名称新增足迹城市。服务端在同一国家找到同名的已有地点时返回 409 `E_PLACE_CHOICE_REQUIRED`（什么都不写），
 * 候选列表用 `placeChoiceCandidatesOf` 取出；用户选「新建独立地点」时带 `createNew: true` 再提交（第 2A 批）。
 */
export type NamedTravelRecordInput = {
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
  createNew?: true
} & JourneyChoiceFields

/** 引用用户选定的已有城市（第 2A 批）：记录坐标就是地点坐标；`lat` / `lng` 只在地点没有坐标时补上。 */
export type ExistingPlaceTravelRecordInput = {
  placeId: string
  start_date: string
  end_date?: string
  lat?: number
  lng?: number
  trip_title?: string
} & JourneyChoiceFields

export type LocalTravelRecordInput = NamedTravelRecordInput | ExistingPlaceTravelRecordInput

export const addLocalTravelRecord = (input: LocalTravelRecordInput) =>
  editorWrite('/__travelatlas/editor/records', 'POST', input, parseResponse<{ id: string; countryId: string; cityId: string }>)

// ---- Want to Go（FR-WTG-6 / D26）----
// 写入路径的唯一出口就是本文件：组件里不得出现任何 fetch。

/** 按名称新增想去；城市有同名候选时同样返回 409 `E_PLACE_CHOICE_REQUIRED`，选「新建」时带 `createNew: true`（第 2A 批）。 */
export type LocalWantToGoInput = {
  place: {
    kind: 'city' | 'country'
    nameZh?: string
    nameEn: string
    countryCode: string
    lat?: number
    lng?: number
  }
  createNew?: true
  note?: string
  addedAt?: string
}

export type ExistingPlaceWantToGoInput = { placeId: string; note?: string; addedAt?: string }

export const addLocalWantToGo = (input: LocalWantToGoInput | ExistingPlaceWantToGoInput) =>
  editorWrite('/__travelatlas/editor/wanttogo', 'POST', input, async (response) => {
    const result = await parseResponse<{ id: string; item: WantToGoItem; duplicate?: boolean }>(response)
    // 新库模式：开发服务器重启之后重放的请求只带回执（已经提交，页面随即刷新），没有条目可校验。V2 模式没有这个字段。
    if (result.duplicate === true) return result
    if (typeof result.id !== 'string' || !result.id || result.item?.id !== result.id || !result.item?.place) {
      throw new LocalEditorError({ code: 'E_EDITOR_RESPONSE_INVALID', params: { status: response.status } })
    }
    return result
  })

/** 修改想去（V2 模式与原来完全相同；新库模式见 `editorWrite`）。 */
export const updateLocalWantToGo = (id: string, patch: { hidden?: boolean; note?: string }) =>
  editorWrite('/__travelatlas/editor/wanttogo/update', 'POST', { id, ...patch }, parseResponse<{ item: WantToGoItem }>)

export const deleteHiddenLocalWantToGo = (ids: string[]) =>
  editorWrite('/__travelatlas/editor/wanttogo/delete', 'POST', { ids }, parseResponse<{ deletedIds: string[] }>)

// ---- 想去 → 足迹（PR9，PRD S5 / R13）----
// 一个端点完成整件事：新增足迹城市（或把 planned 改为已去过）、按需更新国家排序、默认移除想去条目。
// 日期一律由用户填写，这里原样转发，不补默认值。

export type LocalConvertToTravelInput =
  | ({
      source: 'want-to-go'
      id: string
      startDate: string
      endDate?: string
      tripTitle?: string
      keepWantToGo?: boolean
    } & JourneyChoiceFields)
  | ({ source: 'planned'; recordId: string; startDate: string; endDate?: string } & JourneyChoiceFields)

export type LocalConvertToTravelResult = {
  travelRecordId: string
  countryId: string
  cityId: string
  wantToGoRemoved: boolean
}

export const convertLocalWantToGoToTravel = (input: LocalConvertToTravelInput) =>
  editorWrite('/__travelatlas/editor/wanttogo/convert', 'POST', input, parseResponse<LocalConvertToTravelResult>)

/** 定义在 ./localEditorCoordination.ts（第 5B 批）：组件经 ./localEditorClient.ts 同步调用它，不必先加载本模块。 */
export { reloadAfterLocalSave } from './localEditorCoordination.ts'
