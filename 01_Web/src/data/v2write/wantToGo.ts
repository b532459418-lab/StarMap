/**
 * 想去的 V2 写入（RFC-LOC-1 PR3b-2 规格 §2.3）：新增（`POST /wanttogo`）、改隐藏与备注（`POST /wanttogo/update`）、
 * 彻底删除已隐藏的条目（`POST /wanttogo/delete`）。
 *
 * `src/data/v2write/` 是 App 层，【不是】 StarMap Core。输入与校验、文案照抄旧的 scripts/want-to-go-store.mjs
 * （RFC-LOC-1 PR5a 删除，见 PR5；今天以本文件为准）；
 * 条目改为引用地点（`placeId`），FR-WTG-8 查重改为「同一地点已在列表中」（RFC §3.2）。
 * 返回的 `item` 是客户端认识的旧形状（内联 `place`），由地点重建（../canonical/reconstruct.ts）。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import { indexPlaces, reconstructWantToGoItem } from '../canonical/reconstruct.ts'
import type { CanonicalWantToGoItem, PlaceId } from '../canonical/types.ts'
import type { V2FileKey, V2Files } from '../canonical/v2Schema.ts'
import type { WantToGoItem } from '../derive/wantToGo.ts'
import { ensureCountryPlace, fillMissingLocation, newOrChosenCityPlace } from './common.ts'
import {
  parseAddWantToGo, parseDeleteWantToGo, parseUpdateWantToGo, requireAllHidden, requireNotListed, wishNotFound,
} from '../editor/rules/wantToGo.ts'
import { fail } from '../editor/errors.ts'

/** 判定在 ../editor/rules/wantToGo.ts（3C-5 C1），这里沿用原来的导出名。 */
export { normalizeNote } from '../editor/rules/wantToGo.ts'
import { removeUnreferencedPlaces, runV2Transaction, type V2FilesOrEmpty, type V2WriteContext, type V2WriteOutcome } from './transaction.ts'

type WriteList = { file: V2FileKey; onFailure?: string }[]

/** 客户端看到的旧形状。 */
const itemV1Of = (files: V2Files, item: CanonicalWantToGoItem): WantToGoItem =>
  reconstructWantToGoItem(item, indexPlaces(files.places.places))


// ---------------------------------------------------------------------------
// POST /wanttogo
// ---------------------------------------------------------------------------

/**
 * 新增想去：`{ place: { kind, nameZh?, nameEn, countryCode, lat?, lng? }, createNew?, note?, addedAt? }`
 * 或 `{ placeId, note?, addedAt? }`。已有地点按 id 精确引用；两种输入不能混用，`placeId` 也不能带 `createNew`。
 * - 国家按 `countryCode` 解析，没有就按目录新建；`kind: 'country'` 的条目就指向这个国家地点（`createNew` 对国家不起作用）。
 * - `kind: 'city'`（第 2A 批，RFC ID-6「匹配提示 ≠ 身份」）：带 `createNew: true` 一定新建独立的城市地点；否则在该国家下
 *   按名字找候选——没有候选就新建（坐标可空），有任何候选（包括已在足迹里的城市）→ `E_PLACE_CHOICE_REQUIRED`
 *   （`params.candidates`），不写。用户选定后用 `{ placeId }` 引用。从不按名字静默复用。
 * - 已有想去条目（含隐藏的）引用同一地点 → `E_WTG_EXISTS`（「这个地方已在想去列表中。」）。
 * - 条目：UUIDv7 `id`、`placeId`、`note?`、`addedAt`（默认本地日期）、`hidden: false`、`source: 'local-editor'`。
 * 写盘：地点注册表（有改动时）→ 想去。
 */
export function addWantToGo(files: V2FilesOrEmpty | undefined, input: unknown, ctx: V2WriteContext): V2WriteOutcome<{ id: string; item: WantToGoItem }> {
  const request = parseAddWantToGo(input, ctx.now)
  const referencesPlace = request.placeId !== undefined
  const { place, createNew, note, addedAt } = request

  return runV2Transaction(files, ctx, (draft) => {
    let target = referencesPlace ? draft.placeById(request.placeId as string) : undefined
    let placesChanged = false
    if (referencesPlace && !target) fail('E_UNKNOWN_PLACE_REF')
    if (place) {
      const country = ensureCountryPlace(draft, place.countryCode)
      target = country.place
      placesChanged = country.changed
      if (place.kind === 'city') {
        const city = newOrChosenCityPlace(draft, country.place.id, {
          names: { zh: place.nameZh, en: place.nameEn },
          matchNames: { zh: place.givenZh, en: place.nameEn },
          location: place.location,
          createNew,
        })
        target = city.place
        placesChanged ||= city.changed
      } else {
        placesChanged = fillMissingLocation(country.place, place.location) || placesChanged
      }
    }
    const targetId = target?.id ?? fail('E_UNKNOWN_PLACE_REF')
    requireNotListed(draft.files.wantToGo.items.some((item) => item.placeId === targetId), targetId)

    const item: CanonicalWantToGoItem = {
      id: ctx.newId(),
      placeId: targetId,
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
  const request = parseUpdateWantToGo(input)
  const { id } = request

  return runV2Transaction(files, ctx, (draft) => {
    const items = draft.files.wantToGo.items
    const index = items.findIndex((item) => item.id === id)
    if (index < 0) wishNotFound(id)
    const next: CanonicalWantToGoItem = { ...items[index] }
    if (request.hidden !== undefined) next.hidden = request.hidden
    if (request.note) {
      if (request.note.value) next.note = request.note.value
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
  const ids = parseDeleteWantToGo(input)

  return runV2Transaction(files, ctx, (draft) => {
    const items = draft.files.wantToGo.items
    const itemsById = new Map(items.map((item) => [item.id, item]))
    requireAllHidden(ids, (id) => itemsById.get(id)?.hidden === true)

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
