/**
 * 本地编辑器三个媒体端点在 V2 数据模式下的纯函数（RFC-LOC-1 PR3b-3 规格 §2.4）：
 *
 * - `POST /upload`：上传目标（城市地点与所属国家、收件箱文件夹的显示名）、其余参数的校验、
 *   收件箱文件夹 `place.json` 的写入与冲突；
 * - `POST /import`：导入之后按 V2 源文件索引恢复新导入条目的隐藏状态，并把它们追加进排序表（键为地点 id）；
 * - `POST /media/delete`：能删哪些媒体、内容寻址的生成目录在哪、从 editor-state 里清掉这些 id。
 *
 * `src/data/v2media/` 是 App 层，【不是】 StarMap Core。IO（读写文件、上传的流、运行导入器、删除文件）在
 * scripts/v2-media-store.mjs，插件（scripts/local-editor-plugin.mjs）在 V2 下把三个媒体端点交给它。
 * 写 editor-state 走 PR3b-2 的事务（`runV2Transaction`：入口与出口的完整性检查、按顺序给出写入）。
 * 错误抛 `V2WriteError`，文案沿用旧模式（码表在 ../v2write/errors.ts）。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import type { CanonicalPlace, PlaceId } from '../canonical/types.ts'
import type { V2Files } from '../canonical/v2Schema.ts'
import { V2WriteError, fail } from '../v2write/errors.ts'
import {
  completeForWrite,
  integrityProblems,
  runV2Transaction,
  type V2FilesOrEmpty,
  type V2WriteContext,
  type V2WriteOutcome,
} from '../v2write/transaction.ts'
import { generatedDirectoryOfSrc, placeConfigOf, placeDisplayName, placeIdOfConfig } from './importPlan.ts'

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')

/** 现有的五个 V2 文件（缺的补空）；不合法时抛 `E_INTEGRITY`（不在坏数据上继续）。 */
const checkedFiles = (files: V2FilesOrEmpty | undefined, now: Date): V2Files => {
  const completed = completeForWrite(files, now)
  const problems = integrityProblems(completed)
  if (problems.length > 0) throw new V2WriteError('E_INTEGRITY', { stage: 'input', problems: problems.slice(0, 20), total: problems.length })
  return completed as unknown as V2Files
}

// ---------------------------------------------------------------------------
// 上传
// ---------------------------------------------------------------------------

/** 网页编辑器能上传的三种媒体（同旧模式）。 */
export const UPLOAD_KINDS = ['photo', 'panorama360', 'aerialPhoto'] as const
export type UploadKind = (typeof UPLOAD_KINDS)[number]

/** 读查询参数（`URLSearchParams` 的子集）。 */
export interface QueryLike {
  get(name: string): string | null
}

/** `kind` 参数（默认 photo）；不是三种之一时 `E_MEDIA_KIND_INVALID`。 */
export const uploadKindOf = (query: QueryLike): UploadKind => {
  const kind = query.get('kind') ?? 'photo'
  if (!(UPLOAD_KINDS as readonly string[]).includes(kind)) fail('E_MEDIA_KIND_INVALID', { kind })
  return kind as UploadKind
}

export interface UploadTarget {
  country: CanonicalPlace
  city: CanonicalPlace
  /** 收件箱里国家、城市文件夹的名称（未经 safeSegment）：英文名，没有则中文名。 */
  countryFolderName: string
  cityFolderName: string
}

/**
 * 上传的目标（§2.4）：`cityId` 是城市地点 id，`countryId` 必须等于它的 `partOf`；否则 `E_MEDIA_LOCATION_NOT_FOUND`
 * （沿用旧文案）。收件箱路径为 `MediaInbox/<国家显示名>/<城市显示名>/`。
 */
export const uploadTargetOf = (files: V2FilesOrEmpty | undefined, input: { countryId: unknown; cityId: unknown }, now: Date): UploadTarget => {
  const { places } = checkedFiles(files, now).places
  const countryId = typeof input.countryId === 'string' ? input.countryId.trim() : ''
  const cityId = typeof input.cityId === 'string' ? input.cityId.trim() : ''
  const city = places.find((place) => place.id === cityId && place.subtype === 'city')
  const country = city ? places.find((place) => place.id === city.partOf && place.subtype === 'country') : undefined
  if (!city || !country || country.id !== countryId) return fail('E_MEDIA_LOCATION_NOT_FOUND', { countryId, cityId })
  return { country, city, countryFolderName: placeDisplayName(country), cityFolderName: placeDisplayName(city) }
}

/** 无人机影像的 sidecar 字段（同旧模式）。 */
export interface DroneUploadMetadata {
  kind: Exclude<UploadKind, 'photo'>
  date: string
  lat?: number
  lng?: number
  altitudeMeters?: number
  relativeAltitudeMeters?: number
  titleZh: string
  titleEn: string
}

/** 无人机影像的查询参数（规则与文案照抄旧模式的上传分支；`cityName` 是城市显示名，用于默认标题）。 */
export const droneUploadMetadataOf = (query: QueryLike, kind: Exclude<UploadKind, 'photo'>, cityName: string): DroneUploadMetadata => {
  const date = query.get('date') ?? ''
  const latText = query.get('lat')
  const lngText = query.get('lng')
  const lat = latText === null || latText === '' ? undefined : Number(latText)
  const lng = lngText === null || lngText === '' ? undefined : Number(lngText)
  const altitudeText = query.get('altitudeMeters')
  const altitudeMeters = altitudeText ? Number(altitudeText) : undefined
  const relativeAltitudeText = query.get('relativeAltitudeMeters')
  const relativeAltitudeMeters = relativeAltitudeText ? Number(relativeAltitudeText) : undefined
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('E_MEDIA_DRONE_DATE')
  if ((lat === undefined) !== (lng === undefined)) fail('E_COORDINATES_PAIR')
  if (
    (lat !== undefined && (!Number.isFinite(lat) || lat < -90 || lat > 90))
    || (lng !== undefined && (!Number.isFinite(lng) || lng < -180 || lng > 180))
  ) {
    fail('E_MEDIA_COORDINATES_RANGE')
  }
  return {
    kind,
    date,
    lat,
    lng,
    altitudeMeters: Number.isFinite(altitudeMeters) ? altitudeMeters : undefined,
    relativeAltitudeMeters: Number.isFinite(relativeAltitudeMeters) ? relativeAltitudeMeters : undefined,
    titleZh: query.get('titleZh') || `${cityName}无人机影像`,
    titleEn: query.get('titleEn') || `${cityName} Drone Media`,
  }
}

export interface FolderClaimWrite {
  folder: 'country' | 'city'
  value: { placeId: PlaceId }
}

/**
 * 收件箱国家、城市文件夹的 `place.json`（§2.4）：没有就写入；已有且指向同一个地点，不动；
 * 已有但指向别的地点（或内容不是 `{ placeId }`）→ `E_MEDIA_FOLDER_CONFLICT`，一个文件都不写。
 * `existing` 是两个文件现在的内容（不存在为 undefined），`labels` 是两个文件夹在收件箱里的相对路径（错误信息用）。
 * 返回要写的文件，按 国家 → 城市 的顺序。
 */
export const placeFolderClaims = (
  target: { countryId: PlaceId; cityId: PlaceId },
  existing: { country?: unknown; city?: unknown },
  labels: { country: string; city: string },
): FolderClaimWrite[] => {
  const writes: FolderClaimWrite[] = []
  for (const [folder, placeId] of [['country', target.countryId], ['city', target.cityId]] as const) {
    const current = existing[folder]
    if (current === undefined) {
      writes.push({ folder, value: placeConfigOf(placeId) })
      continue
    }
    const currentId = placeIdOfConfig(current)
    if (currentId !== placeId) {
      throw new V2WriteError('E_MEDIA_FOLDER_CONFLICT', { folder: labels[folder], expected: placeId, actual: currentId ?? null })
    }
  }
  return writes
}

// ---------------------------------------------------------------------------
// 导入之后
// ---------------------------------------------------------------------------

export interface RestoreInput {
  /** 这次上传的源文件（相对收件箱，`/` 分隔）。 */
  sourcePaths: readonly string[]
  /** V2 源文件索引（`data/v2/media-source-index.local.json`）的内容。 */
  sourceIndex: unknown
}

const sourcesByIdOf = (sourceIndex: unknown): Record<string, unknown> =>
  isObject(sourceIndex) && isObject(sourceIndex.sourcesById) ? sourceIndex.sourcesById : {}

const normalizeSourceKey = (value: unknown) => String(value).replaceAll('\\', '/').toLocaleLowerCase('en-US')

/**
 * 导入之后（§2.4，同旧模式 restoreImportedMedia）：按 V2 源文件索引找出这次上传的文件对应的媒体 id；
 * 把它们从两个隐藏表里去掉（重新上传即恢复），并追加到所在城市排序表的末尾（照片 → mediaOrderByCity，
 * 无人机影像 → droneOrderByCity，键为城市地点 id）。没有上传文件时什么都不写。
 * 只写 editor-state，走 PR3b-2 的事务。
 */
export function restoreImportedMedia(
  files: V2FilesOrEmpty | undefined,
  input: RestoreInput,
  ctx: V2WriteContext,
): V2WriteOutcome<{ restoredMediaIds: string[] }> {
  if (input.sourcePaths.length === 0) return { writes: [], result: { restoredMediaIds: [] } }
  const requested = new Set(input.sourcePaths.map(normalizeSourceKey))
  const importedIds = Object.entries(sourcesByIdOf(input.sourceIndex))
    .filter(([, sources]) => Array.isArray(sources) && sources.some((source) => requested.has(normalizeSourceKey(source))))
    .map(([id]) => id)
  if (importedIds.length === 0) fail('E_MEDIA_IMPORT_NO_RECORD')

  return runV2Transaction(files, ctx, (draft) => {
    const itemsById = new Map(draft.files.media.items.map((item) => [item.id, item]))
    const importedItems = importedIds.map((id) => itemsById.get(id))
    if (importedItems.some((item) => item === undefined)) fail('E_MEDIA_INDEX_MISMATCH', { ids: importedIds.filter((id) => !itemsById.has(id)) })

    const state = draft.files.editorState
    const imported = new Set(importedIds)
    state.hiddenMediaIds = state.hiddenMediaIds.filter((id) => !imported.has(id))
    state.hiddenDroneMediaIds = state.hiddenDroneMediaIds.filter((id) => !imported.has(id))
    for (const item of importedItems) {
      if (!item) continue
      const table = item.kind === 'photo' ? state.mediaOrderByCity : state.droneOrderByCity
      table[item.placeId] = [...(table[item.placeId] ?? []).filter((id) => id !== item.id), item.id]
    }
    return { result: { restoredMediaIds: importedIds }, writes: [{ file: 'editorState' }] }
  })
}

// ---------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------

export interface DeletableMedia {
  cityId: PlaceId
  /** 去重后的媒体 id，保持请求里的先后。 */
  ids: string[]
  /** 对应的目录条目（与 `ids` 一一对应）。 */
  items: V2Files['media']['items']
}

/**
 * 能删哪些（§2.4，规则与文案同旧模式）：`cityId` 为城市地点 id；每个 id 都必须是这个城市里已隐藏的照片
 * （`hiddenMediaIds`）或已隐藏的全景 / 航拍照片（`hiddenDroneMediaIds`）。
 */
export const deletableMediaOf = (files: V2FilesOrEmpty | undefined, input: unknown, now: Date): DeletableMedia => {
  const body = isObject(input) ? input : {}
  const cityId = typeof body.cityId === 'string' ? body.cityId.trim() : ''
  const ids = isStringArray(body.ids) ? [...new Set(body.ids)] : []
  if (!cityId || ids.length === 0) fail('E_MEDIA_DELETE_EMPTY')

  const checked = checkedFiles(files, now)
  const hiddenPhotoIds = new Set(checked.editorState.hiddenMediaIds)
  const hiddenDroneIds = new Set(checked.editorState.hiddenDroneMediaIds)
  const itemsById = new Map(checked.media.items.map((item) => [item.id, item]))
  const items = ids.map((id) => {
    const item = itemsById.get(id)
    const isHiddenPhoto = item?.kind === 'photo' && hiddenPhotoIds.has(id)
    const isHiddenDroneMedia = (item?.kind === 'panorama360' || item?.kind === 'aerialPhoto') && hiddenDroneIds.has(id)
    if (!item || item.placeId !== cityId || (!isHiddenPhoto && !isHiddenDroneMedia)) fail('E_MEDIA_DELETE_NOT_HIDDEN', { id })
    return item as V2Files['media']['items'][number]
  })
  return { cityId, ids, items }
}

/** 源文件索引里还没有这些 id 的条目（旧模式在这种情况下先重新导入一次）。 */
export const idsMissingFromSourceIndex = (sourceIndex: unknown, ids: readonly string[]): string[] => {
  const sources = sourcesByIdOf(sourceIndex)
  return ids.filter((id) => !Array.isArray(sources[id]))
}

/** 每个 id 的源文件（相对收件箱）；缺了或为空 → `E_MEDIA_SOURCE_MISSING`。 */
export const mediaSourcesOf = (sourceIndex: unknown, ids: readonly string[]): string[] => {
  const sources = sourcesByIdOf(sourceIndex)
  const result: string[] = []
  for (const id of ids) {
    const list = sources[id]
    if (!Array.isArray(list) || list.length === 0) fail('E_MEDIA_SOURCE_MISSING', { id })
    for (const source of list as unknown[]) result.push(String(source))
  }
  return result
}

/**
 * 要删的生成目录（相对 `media/user/`）：内容寻址的 `<16 位哈希>`，由条目的 `src` 得到，去重。
 * 任一条目的 `src` 不是 `/media/user/<哈希>/<文件名>` 的形状 → `E_MEDIA_PATH_INVALID`，一个都不删。
 */
export const generatedDirectoriesOf = (items: DeletableMedia['items']): string[] => {
  const directories: string[] = []
  for (const item of items) {
    const directory = generatedDirectoryOfSrc(item.src)
    if (directory === undefined) fail('E_MEDIA_PATH_INVALID', { id: item.id })
    if (!directories.includes(directory as string)) directories.push(directory as string)
  }
  return directories
}

/**
 * 从 editor-state 里清掉这些媒体 id（§2.4）：两个隐藏表、两个排序表的值，以及指向它们的封面。
 * 只写 editor-state，走 PR3b-2 的事务。
 */
export function removeMediaFromEditorState(
  files: V2FilesOrEmpty | undefined,
  ids: readonly string[],
  ctx: V2WriteContext,
): V2WriteOutcome<{ deletedIds: string[] }> {
  const removed = new Set(ids)
  const keep = (list: readonly string[]) => list.filter((id) => !removed.has(id))
  return runV2Transaction(files, ctx, (draft) => {
    const state = draft.files.editorState
    state.hiddenMediaIds = keep(state.hiddenMediaIds)
    state.hiddenDroneMediaIds = keep(state.hiddenDroneMediaIds)
    state.mediaOrderByCity = Object.fromEntries(Object.entries(state.mediaOrderByCity).map(([cityId, list]) => [cityId, keep(list)]))
    state.droneOrderByCity = Object.fromEntries(Object.entries(state.droneOrderByCity).map(([cityId, list]) => [cityId, keep(list)]))
    state.coverMediaByCity = Object.fromEntries(Object.entries(state.coverMediaByCity).filter(([, id]) => !removed.has(id)))
    return { result: { deletedIds: [...ids] }, writes: [{ file: 'editorState' }] }
  })
}
