/**
 * 本地编辑器媒体端点的纯函数（RFC-LOC-1 PR3b-3 规格 §2.4）：
 *
 * - `POST /upload`：上传目标（城市地点与所属国家、收件箱文件夹的显示名）、其余参数的校验、
 *   收件箱文件夹的选择（同名地点不共用文件夹）与 `place.json` 的写入；
 * - `POST /media/delete`：能删哪些媒体、内容寻址的生成目录在哪、从 editor-state 里清掉这些 id。
 *
 * `src/data/v2media/` 是 App 层，【不是】 StarMap Core。3C-4d 起只有新库写入：上传的 IO 在 scripts/v2-media-store.mjs，
 * 导入与删除在新库的媒体服务（scripts/media-service.mjs）；V2 的导入之后恢复（按 V2 源文件索引）与按索引找源文件已删除。
 * `removeMediaFromEditorState` 只留作新库删除语义的对照（src/data/store/mediaRecords.test.ts），3C-5 再定。
 * 写 editor-state 走 PR3b-2 的事务（`runV2Transaction`：入口与出口的完整性检查、按顺序给出写入）。
 *
 * 3C-5 E: the upload target and the deletion rule read the official reader (../store/officialReader.ts: a place by id,
 * the editor lists, a media item by V2 id), never a V2 shape of the library: the store's rows are checked by Core, so
 * there is no whole-file integrity check of the input any more.
 * 错误抛 `V2WriteError`，文案沿用旧模式（码表在 ../v2write/errors.ts）。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import type { CanonicalMediaItem, CanonicalPlace, PlaceId } from '../canonical/types.ts'
import type { OfficialReader } from '../store/officialReader.ts'
import { V2WriteError, fail } from '../v2write/errors.ts'
import {
  runV2Transaction,
  type V2FilesOrEmpty,
  type V2WriteContext,
  type V2WriteOutcome,
} from '../v2write/transaction.ts'
import { generatedDirectoryOfSrc, placeDisplayName, placeIdOfConfig } from './importPlan.ts'

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')

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
 * （沿用旧文案）。收件箱路径为 `MediaInbox/<国家显示名>/<城市显示名>/`。3C-5 E: the places come from the official reader.
 */
export const uploadTargetOf = (reader: Pick<OfficialReader, 'place'>, input: { countryId: unknown; cityId: unknown }): UploadTarget => {
  const countryId = typeof input.countryId === 'string' ? input.countryId.trim() : ''
  const cityId = typeof input.cityId === 'string' ? input.cityId.trim() : ''
  const found = cityId ? reader.place(cityId) : undefined
  const city = found?.subtype === 'city' ? found : undefined
  const parent = city?.partOf !== undefined ? reader.place(city.partOf) : undefined
  const country = parent?.subtype === 'country' ? parent : undefined
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

/**
 * 收件箱里一个文件夹现在的样子：不存在；或存在，`placeConfig` 是它的 `place.json` 内容
 * （没有 place.json 为 undefined，读不出为 null）。
 */
export type InboxFolderState = { exists: false } | { exists: true; placeConfig: unknown }

/**
 * 这个文件夹能不能给地点 `placeId` 用（§2.4；第 2D 批）：
 * - `'claim'`：不存在——新建，并写入 place.json；
 * - `'mine'`：place.json 已经指向这个地点——直接用，不写；
 * - `'skip'`：存在但没有 place.json（用户手放的文件夹）——上传不认领它，看下一个候选。它属于哪个地点，
 *   由导入时的「按名字绑定需要确认」决定（第 2A 批），上传不替用户做这个决定；
 * - `'taken'`：place.json 指向别的地点，或内容不是 `{ placeId }`——不能用。
 */
export type InboxFolderDecision = 'claim' | 'mine' | 'skip' | 'taken'

export const inboxFolderDecision = (placeId: PlaceId, state: InboxFolderState): InboxFolderDecision => {
  if (!state.exists) return 'claim'
  if (state.placeConfig === undefined) return 'skip'
  return placeIdOfConfig(state.placeConfig) === placeId ? 'mine' : 'taken'
}

/**
 * 同名地点的文件夹名后缀：地点 id 去掉连字符后的【最后】 8 位十六进制。只用于让文件夹名不同，
 * 不参与任何匹配（导入器靠 place.json 解析这类文件夹）。
 * 不取前 8 位：地点 id 是 UUIDv7，前 8 位是毫秒时间戳的高 32 位，约每 65 秒才变一次——同一次迁移、
 * 或一分钟内先后添加的两个同名城市，前 8 位几乎总是相同；最后 8 位是随机位。
 */
export const placeFolderSuffix = (placeId: PlaceId): string => placeId.replaceAll('-', '').slice(-8)

/** 收件箱文件夹名候选的个数：显示名、`<显示名> (<后缀>)`，以及 `<显示名> (<后缀>) 2` 到 `<显示名> (<后缀>) 9`。 */
export const INBOX_FOLDER_CANDIDATE_COUNT = 10

/**
 * 收件箱文件夹名的候选（未经 safeSegment），按先后顺序：先用显示名；它不能用时（被别的地点占用，Windows 上包括只差大小写的
 * 同名文件夹；或是手放的文件夹）用 `<显示名> (<后缀>)`；这个也不能用时（第 2D 批），依次用 `<显示名> (<后缀>) 2`、`… 3`
 * 直到 `… 9`。名字只由显示名与地点 id 决定，所以同一个地点每次得到同一串候选。
 */
export const inboxFolderCandidates = (displayName: string, placeId: PlaceId): string[] => {
  const suffixed = `${displayName} (${placeFolderSuffix(placeId)})`
  const numbered = Array.from({ length: INBOX_FOLDER_CANDIDATE_COUNT - 2 }, (_, index) => `${suffixed} ${index + 2}`)
  return [displayName, suffixed, ...numbered]
}

export interface InboxFolderCandidate {
  /** 文件夹名（已经过 safeSegment）。 */
  name: string
  /** 在收件箱里的相对路径（错误信息用）。 */
  label: string
  state: InboxFolderState
}

/**
 * 为 `placeId` 选候选文件夹（第 2D 批）。上传只用两种文件夹：place.json 已经指向这个地点的，以及这次新建的。
 * 1. 有 `'mine'` 的候选 → 用其中最靠前的一个，不写 place.json。即使它前面有不存在的候选也一样，
 *    这样同一个地点的照片一直进同一个文件夹，不会因为别的文件夹被删掉或改名而另开一个；
 * 2. 否则用最靠前的 `'claim'`（不存在的）候选，`claim` 为 true，调用方新建它并写入 place.json；
 * 3. `'skip'`（手放的）与 `'taken'`（别的地点的）永远不用，也不写。
 * 候选全都不能用 → `E_MEDIA_FOLDER_CONFLICT`，一个文件都不写。
 */
export const pickInboxFolder = (placeId: PlaceId, candidates: readonly InboxFolderCandidate[]): { name: string; claim: boolean } => {
  const decided = candidates.map((candidate) => ({ name: candidate.name, decision: inboxFolderDecision(placeId, candidate.state) }))
  const mine = decided.find((entry) => entry.decision === 'mine')
  if (mine) return { name: mine.name, claim: false }
  const fresh = decided.find((entry) => entry.decision === 'claim')
  if (fresh) return { name: fresh.name, claim: true }
  throw new V2WriteError('E_MEDIA_FOLDER_CONFLICT', { folders: [...new Set(candidates.map((candidate) => candidate.label))], expected: placeId })
}

// ---------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------

export interface DeletableMedia {
  cityId: PlaceId
  /** 去重后的媒体 id，保持请求里的先后。 */
  ids: string[]
  /** 对应的目录条目（与 `ids` 一一对应）。 */
  items: CanonicalMediaItem[]
}

/**
 * 能删哪些（§2.4，规则与文案同旧模式）：`cityId` 为城市地点 id；每个 id 都必须是这个城市里已隐藏的照片
 * （`hiddenMediaIds`）或已隐藏的全景 / 航拍照片（`hiddenDroneMediaIds`）。3C-5 E: the editor lists and the media items
 * come from the official reader.
 */
export const deletableMediaOf = (reader: Pick<OfficialReader, 'editorLists' | 'mediaItem'>, input: unknown): DeletableMedia => {
  const body = isObject(input) ? input : {}
  const cityId = typeof body.cityId === 'string' ? body.cityId.trim() : ''
  const ids = isStringArray(body.ids) ? [...new Set(body.ids)] : []
  if (!cityId || ids.length === 0) fail('E_MEDIA_DELETE_EMPTY')

  const lists = reader.editorLists()
  const hiddenPhotoIds = new Set(lists.hiddenMediaIds)
  const hiddenDroneIds = new Set(lists.hiddenDroneMediaIds)
  const items = ids.map((id) => {
    const item = reader.mediaItem(id)
    const isHiddenPhoto = item?.kind === 'photo' && hiddenPhotoIds.has(id)
    const isHiddenDroneMedia = (item?.kind === 'panorama360' || item?.kind === 'aerialPhoto') && hiddenDroneIds.has(id)
    if (!item || item.placeId !== cityId || (!isHiddenPhoto && !isHiddenDroneMedia)) fail('E_MEDIA_DELETE_NOT_HIDDEN', { id })
    return item as CanonicalMediaItem
  })
  return { cityId, ids, items }
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
