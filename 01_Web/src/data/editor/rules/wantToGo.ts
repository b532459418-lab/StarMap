/**
 * 想去三个端点的判定（3C-5 C1 从 v2write/wantToGo.ts（3C-5 E 删除）迁来，规则、错误码、参数与检查顺序不变；RFC-LOC-1 PR3b-2 规格 §2.3）：
 * 新增（`POST /wanttogo`）、改隐藏与备注（`/wanttogo/update`）、彻底删除已隐藏的条目（`/wanttogo/delete`）。
 *
 * 输入与校验、文案照抄旧的 want-to-go-store.mjs（RFC-LOC-1 PR5a 删除）；条目引用地点（`placeId`），FR-WTG-8 查重是
 * 「同一地点已在列表中」（RFC §3.2）。这里只做判定：V2 写入函数与存储原生的写入（../native/wantToGo.ts）共用。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import { fail } from '../errors.ts'
import { COUNTRY_CODE_PATTERN, DATE_PATTERN, bodyOf, createNewOf, isObject, localDate, numberInRange, requireText } from './input.ts'

/** 旧 store normalizeNote：trim 后 ≤ 200 字；空串表示「没有备注」。 */
export const normalizeNote = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') fail('E_NOTE_NOT_TEXT')
  const note = (value as string).trim()
  if (note.length > 200) fail('E_NOTE_TOO_LONG')
  return note
}

export interface PlaceInput {
  kind: 'city' | 'country'
  nameZh: string
  nameEn: string
  /** 用户实际给出的中文名（找候选只比实际给出的名字；`nameZh` 缺时用英文名补齐，只用于新建）。 */
  givenZh?: string
  countryCode: string
  location?: { lat: number; lng: number }
}

/** 旧 store normalizePlace：类型、英文名、国家代码必填；中文名缺时用英文名；坐标可空但须成对。 */
export const normalizePlace = (value: unknown): PlaceInput => {
  const place = isObject(value) ? value : {}
  if (place.kind !== 'city' && place.kind !== 'country') fail('E_WTG_KIND_INVALID')
  const nameEn = requireText(place.nameEn, 'nameEn')
  const givenZh = typeof place.nameZh === 'string' && place.nameZh.trim() ? place.nameZh.trim() : undefined
  const nameZh = givenZh ?? nameEn
  const countryCode = requireText(place.countryCode, 'countryCode').toUpperCase()
  if (!COUNTRY_CODE_PATTERN.test(countryCode)) fail('E_COUNTRY_CODE_INVALID')
  const hasLat = place.lat !== undefined && place.lat !== null && place.lat !== ''
  const hasLng = place.lng !== undefined && place.lng !== null && place.lng !== ''
  if (hasLat !== hasLng) fail('E_COORDINATES_PAIR')
  return {
    kind: place.kind as 'city' | 'country',
    nameZh,
    nameEn,
    ...(givenZh !== undefined ? { givenZh } : {}),
    countryCode,
    ...(hasLat ? { location: { lat: numberInRange(place.lat, -90, 90, 'lat'), lng: numberInRange(place.lng, -180, 180, 'lng') } } : {}),
  }
}

/** `POST /wanttogo` 的请求：引用已有地点（`placeId`），或按名字给出地点（`place`、`createNew`）；备注与加入日期。 */
export interface AddWantToGoRequest {
  readonly placeId?: string
  readonly place?: PlaceInput
  readonly createNew: boolean
  readonly note?: string
  readonly addedAt: string
}

/**
 * `{ place: { kind, nameZh?, nameEn, countryCode, lat?, lng? }, createNew?, note?, addedAt? }` 或
 * `{ placeId, note?, addedAt? }`。两种输入不能混用，`placeId` 也不能带 `createNew`（`E_UNKNOWN_PLACE_REF`）。
 * 加入日期默认本地日期（`now`）。检查的先后同旧 store。
 */
export const parseAddWantToGo = (input: unknown, now: Date): AddWantToGoRequest => {
  const body = bodyOf(input)
  const referencesPlace = Object.hasOwn(body, 'placeId')
  if (referencesPlace && (typeof body.placeId !== 'string' || !body.placeId.trim() || Object.hasOwn(body, 'place') || Object.hasOwn(body, 'createNew'))) {
    fail('E_UNKNOWN_PLACE_REF')
  }
  const place = referencesPlace ? undefined : normalizePlace(body.place)
  const createNew = referencesPlace ? false : createNewOf(body)
  const note = normalizeNote(body.note)
  const addedAt = body.addedAt === undefined || body.addedAt === null || body.addedAt === ''
    ? localDate(now)
    : requireText(body.addedAt, 'addedAt')
  if (!DATE_PATTERN.test(addedAt)) fail('E_DATE_FORMAT', { field: 'addedAt' })
  return {
    ...(referencesPlace ? { placeId: body.placeId as string } : {}),
    ...(place ? { place } : {}),
    createNew,
    ...(note !== undefined ? { note } : {}),
    addedAt,
  }
}

/** 已有想去条目（含隐藏的）引用同一地点 → `E_WTG_EXISTS`（「这个地方已在想去列表中。」）。 */
export const requireNotListed = (listed: boolean, placeId: string): void => {
  if (listed) fail('E_WTG_EXISTS', { placeId })
}

/** `POST /wanttogo/update` 的请求：按条目 id 改 `hidden` 与（或）`note`（传空串删除备注）。 */
export interface UpdateWantToGoRequest {
  readonly id: string
  readonly hidden?: boolean
  /** 有 `note` 时：undefined 表示删除备注（空串），否则是新的备注。 */
  readonly note?: { readonly value: string | undefined }
}

/** 校验与文案同旧 store：`id` 必填，`hidden` 与 `note` 至少一个，`hidden` 必须是布尔值。 */
export const parseUpdateWantToGo = (input: unknown): UpdateWantToGoRequest => {
  const body = bodyOf(input)
  const id = requireText(body.id, 'id')
  const hasHidden = body.hidden !== undefined
  const hasNote = body.note !== undefined
  if (!hasHidden && !hasNote) fail('E_WTG_UPDATE_EMPTY')
  if (hasHidden && typeof body.hidden !== 'boolean') fail('E_HIDDEN_NOT_BOOLEAN')
  const note = hasNote ? normalizeNote(body.note) : undefined
  return {
    id,
    ...(hasHidden ? { hidden: body.hidden as boolean } : {}),
    ...(hasNote ? { note: { value: note || undefined } } : {}),
  }
}

/** 条目不存在 → `E_WTG_NOT_FOUND`（`params.id`）。 */
export const wishNotFound = (id: string): never => fail('E_WTG_NOT_FOUND', { id })

/** `POST /wanttogo/delete` 的 `{ ids }`：去重、去空白；没有任何 id → `E_WTG_DELETE_EMPTY`。 */
export const parseDeleteWantToGo = (input: unknown): string[] => {
  const body = bodyOf(input)
  const ids = Array.isArray(body.ids)
    ? [...new Set(body.ids.filter((id): id is string => typeof id === 'string' && id.trim() !== '').map((id) => id.trim()))]
    : []
  if (ids.length === 0) fail('E_WTG_DELETE_EMPTY')
  return ids
}

/** 整批原子规则（同旧 store）：只要有一个 id 不存在或没被隐藏，一条也不删（`E_WTG_DELETE_NOT_HIDDEN`，列出不符合的 id）。 */
export const requireAllHidden = (ids: readonly string[], isHidden: (id: string) => boolean): void => {
  const invalid = ids.filter((id) => !isHidden(id))
  if (invalid.length > 0) fail('E_WTG_DELETE_NOT_HIDDEN', { ids: invalid })
}
