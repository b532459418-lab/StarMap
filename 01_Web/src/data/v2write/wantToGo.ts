/**
 * 想去的 V2 写入（RFC-LOC-1 PR3b-2 规格 §2.3）：新增（`POST /wanttogo`）、改隐藏与备注（`POST /wanttogo/update`）、
 * 彻底删除已隐藏的条目（`POST /wanttogo/delete`）。
 *
 * `src/data/v2write/` 是 App 层，【不是】 StarMap Core。输入与校验、文案照抄旧的 scripts/want-to-go-store.mjs；
 * 条目改为引用地点（`placeId`），FR-WTG-8 查重改为「同一地点已在列表中」（RFC §3.2）。
 * 返回的 `item` 是客户端认识的旧形状（内联 `place`），由地点重建（../canonical/reconstruct.ts）。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import { indexPlaces, reconstructWantToGoItem } from '../canonical/reconstruct.ts'
import type { CanonicalWantToGoItem, PlaceId } from '../canonical/types.ts'
import type { V2FileKey, V2Files } from '../canonical/v2Schema.ts'
import type { WantToGoItem } from '../../worldgraph/adapters/wantToGo.ts'
import { fail } from './errors.ts'
import {
  COUNTRY_CODE_PATTERN,
  DATE_PATTERN,
  bodyOf,
  ensureCityPlace,
  ensureCountryPlace,
  fillMissingLocation,
  isObject,
  localDate,
  numberInRange,
  requireText,
} from './common.ts'
import { removeUnreferencedPlaces, runV2Transaction, type V2FilesOrEmpty, type V2WriteContext, type V2WriteOutcome } from './transaction.ts'

type WriteList = { file: V2FileKey; onFailure?: string }[]

/** 客户端看到的旧形状。 */
const itemV1Of = (files: V2Files, item: CanonicalWantToGoItem): WantToGoItem =>
  reconstructWantToGoItem(item, indexPlaces(files.places.places))

/** 旧 store normalizeNote：trim 后 ≤ 200 字；空串表示「没有备注」。 */
const normalizeNote = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') fail('E_NOTE_NOT_TEXT')
  const note = (value as string).trim()
  if (note.length > 200) fail('E_NOTE_TOO_LONG')
  return note
}

interface PlaceInput {
  kind: 'city' | 'country'
  nameZh: string
  nameEn: string
  countryCode: string
  location?: { lat: number; lng: number }
}

/** 旧 store normalizePlace：类型、英文名、国家代码必填；中文名缺时用英文名；坐标可空但须成对。 */
const normalizePlace = (value: unknown): PlaceInput => {
  const place = isObject(value) ? value : {}
  if (place.kind !== 'city' && place.kind !== 'country') fail('E_WTG_KIND_INVALID')
  const nameEn = requireText(place.nameEn, 'nameEn')
  const nameZh = typeof place.nameZh === 'string' && place.nameZh.trim() ? place.nameZh.trim() : nameEn
  const countryCode = requireText(place.countryCode, 'countryCode').toUpperCase()
  if (!COUNTRY_CODE_PATTERN.test(countryCode)) fail('E_COUNTRY_CODE_INVALID')
  const hasLat = place.lat !== undefined && place.lat !== null && place.lat !== ''
  const hasLng = place.lng !== undefined && place.lng !== null && place.lng !== ''
  if (hasLat !== hasLng) fail('E_COORDINATES_PAIR')
  return {
    kind: place.kind as 'city' | 'country',
    nameZh,
    nameEn,
    countryCode,
    ...(hasLat ? { location: { lat: numberInRange(place.lat, -90, 90, 'lat'), lng: numberInRange(place.lng, -180, 180, 'lng') } } : {}),
  }
}

// ---------------------------------------------------------------------------
// POST /wanttogo
// ---------------------------------------------------------------------------

/**
 * 新增想去：`{ place: { kind, nameZh?, nameEn, countryCode, lat?, lng? }, note?, addedAt? }`。
 * - 国家按 `countryCode` 解析，没有就按目录新建；`kind: 'country'` 的条目就指向这个国家地点。
 * - `kind: 'city'`：城市按名称在该国家下解析——找到就复用（包括已在足迹里的城市，显示上自然合并），
 *   找不到就新建（坐标可空）。复用的地点没有坐标而输入带了时补上。地点名称以注册表为准。
 * - 已有想去条目（含隐藏的）引用同一地点 → `E_WTG_EXISTS`（「这个地方已在想去列表中。」）。
 * - 条目：UUIDv7 `id`、`placeId`、`note?`、`addedAt`（默认本地日期）、`hidden: false`、`source: 'local-editor'`。
 * 写盘：地点注册表（有改动时）→ 想去。
 */
export function addWantToGo(files: V2FilesOrEmpty | undefined, input: unknown, ctx: V2WriteContext): V2WriteOutcome<{ id: string; item: WantToGoItem }> {
  const body = bodyOf(input)
  const place = normalizePlace(body.place)
  const note = normalizeNote(body.note)
  const addedAt = body.addedAt === undefined || body.addedAt === null || body.addedAt === ''
    ? localDate(ctx.now)
    : requireText(body.addedAt, 'addedAt')
  if (!DATE_PATTERN.test(addedAt)) fail('E_DATE_FORMAT', { field: 'addedAt' })

  return runV2Transaction(files, ctx, (draft) => {
    const country = ensureCountryPlace(draft, place.countryCode)
    let target = country.place
    let placesChanged = country.changed
    if (place.kind === 'city') {
      const city = ensureCityPlace(draft, country.place.id, { zh: place.nameZh, en: place.nameEn }, place.location)
      target = city.place
      placesChanged ||= city.changed
    } else {
      placesChanged = fillMissingLocation(country.place, place.location) || placesChanged
    }
    if (draft.files.wantToGo.items.some((item) => item.placeId === target.id)) fail('E_WTG_EXISTS', { placeId: target.id })

    const item: CanonicalWantToGoItem = {
      id: ctx.newId(),
      placeId: target.id,
      ...(note ? { note } : {}),
      addedAt,
      hidden: false,
      source: 'local-editor',
    }
    draft.files.wantToGo.items.push(item)

    const writes: WriteList = []
    if (placesChanged) writes.push({ file: 'places' })
    writes.push({ file: 'wantToGo' })
    return { result: { id: item.id, item: itemV1Of(draft.files, item) }, writes }
  })
}

// ---------------------------------------------------------------------------
// POST /wanttogo/update
// ---------------------------------------------------------------------------

/** 按条目 id 改 `hidden` / `note`（传空串删除备注）。校验与文案同旧 store。写盘：想去。 */
export function updateWantToGo(files: V2FilesOrEmpty | undefined, input: unknown, ctx: V2WriteContext): V2WriteOutcome<{ item: WantToGoItem }> {
  const body = bodyOf(input)
  const id = requireText(body.id, 'id')
  const hasHidden = body.hidden !== undefined
  const hasNote = body.note !== undefined
  if (!hasHidden && !hasNote) fail('E_WTG_UPDATE_EMPTY')
  if (hasHidden && typeof body.hidden !== 'boolean') fail('E_HIDDEN_NOT_BOOLEAN')
  const note = hasNote ? normalizeNote(body.note) : undefined

  return runV2Transaction(files, ctx, (draft) => {
    const items = draft.files.wantToGo.items
    const index = items.findIndex((item) => item.id === id)
    if (index < 0) fail('E_WTG_NOT_FOUND', { id })
    const next: CanonicalWantToGoItem = { ...items[index] }
    if (hasHidden) next.hidden = body.hidden as boolean
    if (hasNote) {
      if (note) next.note = note
      else delete next.note
    }
    items[index] = next
    return { result: { item: itemV1Of(draft.files, next) }, writes: [{ file: 'wantToGo' }] }
  })
}

// ---------------------------------------------------------------------------
// POST /wanttogo/delete
// ---------------------------------------------------------------------------

/** 删除之后的地点清理没写成：只剩没人引用的地点。 */
export const WTG_DELETE_PLACES_FAILURE = '想去记录已删除，但地点注册表没有清理（{reason}）。这不影响显示。'

/**
 * 彻底删除已隐藏的想去条目：`{ ids }`。与旧 store 相同的整批原子规则：只要有一个 id 不存在或没被隐藏，
 * 一条也不删（`E_WTG_DELETE_NOT_HIDDEN`，列出不符合的 id）。
 * 删除后，只被这些条目引用的城市或国家地点一并删除（城市删掉后，只被它引用的国家也删）；
 * 仍被足迹、其他想去条目、媒体、显示规则或 editor-state 引用的保留。
 * 写盘：想去 → 地点注册表（有地点可删时）。
 */
export function deleteHiddenWantToGo(files: V2FilesOrEmpty | undefined, input: unknown, ctx: V2WriteContext): V2WriteOutcome<{ deletedIds: string[] }> {
  const body = bodyOf(input)
  const ids = Array.isArray(body.ids)
    ? [...new Set(body.ids.filter((id): id is string => typeof id === 'string' && id.trim() !== '').map((id) => id.trim()))]
    : []
  if (ids.length === 0) fail('E_WTG_DELETE_EMPTY')

  return runV2Transaction(files, ctx, (draft) => {
    const items = draft.files.wantToGo.items
    const itemsById = new Map(items.map((item) => [item.id, item]))
    const invalid = ids.filter((id) => itemsById.get(id)?.hidden !== true)
    if (invalid.length > 0) fail('E_WTG_DELETE_NOT_HIDDEN', { ids: invalid })

    const removed = new Set(ids)
    const candidates: PlaceId[] = []
    for (const id of ids) {
      const placeId = itemsById.get(id)!.placeId
      candidates.push(placeId)
      const parent = draft.placeById(placeId)?.partOf
      if (parent !== undefined) candidates.push(parent)
    }
    draft.files.wantToGo.items = items.filter((item) => !removed.has(item.id))
    const removedPlaces = removeUnreferencedPlaces(draft.files, candidates)

    const writes: WriteList = [{ file: 'wantToGo' }]
    if (removedPlaces.length > 0) writes.push({ file: 'places', onFailure: WTG_DELETE_PLACES_FAILURE })
    return { result: { deletedIds: ids }, writes }
  })
}
