/**
 * 编辑器保存的增量合并（第 1 批 D1；3C-5 C1 起改为视图操作）。
 *
 * 草稿来自页面加载时的快照（`travelAtlasEditorState`），保存时服务端的状态可能已经被别处改过：
 * 另一个标签页、媒体导入的恢复（把新导入的 id 移出隐藏列表）。所以保存只发「这次编辑做了什么」——
 * 3C-5 C1 起是视图操作（`POST /__travelatlas/editor/view`，./editor/rules/editorView.ts），由服务端在当前状态上合并，
 * 不再「整份取回 → 改 → 整份写回」。下面的 `*Operations` 把各个编辑卡片的草稿变成操作；合并的语义同原来的 updater：
 *
 * - 国家顺序：`mergeOrder(当前, 草稿, 页面加载时的顺序)`；
 * - 某个国家的城市顺序、某个城市的照片与航拍顺序：没有别处的修改时就是草稿（原来整份替换这个键）；别处新加的 id 保留在后；
 * - 隐藏列表：只应用这次的增减（`applySetDelta` 的两半：`setDelta`）；「恢复隐藏」只移除列出的 id，「先隐藏再删除」只加入；
 * - 封面：有封面时写这一项。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import type { ViewListScope, ViewOperation } from './editor/rules/editorView.ts'

/**
 * 集合的三方合并：这次新增 = `draft − baseline`，这次取消 = `baseline − draft`；
 * 结果 = `(current − 取消) ∪ 新增`。保持 `current` 原有的顺序，新增项按草稿里的顺序追加在后，不重复。
 */
export function applySetDelta<T>(current: readonly T[], baseline: readonly T[], draft: readonly T[]): T[] {
  const baselineSet = new Set(baseline)
  const draftSet = new Set(draft)
  const removed = new Set(baseline.filter((id) => !draftSet.has(id)))
  const result = current.filter((id) => !removed.has(id))
  const present = new Set(result)
  for (const id of draft) {
    if (baselineSet.has(id) || present.has(id)) continue
    result.push(id)
    present.add(id)
  }
  return result
}

/** `applySetDelta` 的两半：草稿相对 baseline 新增的（`add`，按草稿顺序）与取消的（`remove`）。 */
export function setDelta<T>(baseline: readonly T[], draft: readonly T[]): { add: T[]; remove: T[] } {
  const before = new Set(baseline), after = new Set(draft)
  return { add: draft.filter((id) => !before.has(id)), remove: baseline.filter((id) => !after.has(id)) }
}

/**
 * 排序的合并：以草稿的顺序为准，只保留 `current` 中仍然存在的 id；`current` 里有、草稿里没有的 id
 * （别处新加的），按它们在 `current` 中的顺序追加在后。
 *
 * 传入 `baselineOrder`（页面加载时保存的顺序）时，「不在 `current` 里」只对 baseline 里有过的 id 算作「被别处删除」：
 * 保存的顺序可以是不完整的（从没保存过时为空数组，界面按默认顺序显示全部），这时草稿里从没进过保存顺序的 id 照常保留，
 * 否则第一次保存排序会把整份顺序丢掉。
 */
export function mergeOrder<T>(currentOrder: readonly T[], draftOrder: readonly T[], baselineOrder?: readonly T[]): T[] {
  const currentSet = new Set(currentOrder)
  const baselineSet = baselineOrder === undefined ? undefined : new Set(baselineOrder)
  const stillExists = (id: T) => currentSet.has(id) || (baselineSet !== undefined && !baselineSet.has(id))
  const result: T[] = []
  const present = new Set<T>()
  for (const id of draftOrder) {
    if (present.has(id) || !stillExists(id)) continue
    result.push(id)
    present.add(id)
  }
  for (const id of currentOrder) {
    if (present.has(id)) continue
    result.push(id)
    present.add(id)
  }
  return result
}

/** 隐藏列表的增量：草稿相对页面加载时的隐藏列表。 */
const hideDraft = (scope: ViewListScope, baseline: readonly string[], draft: readonly string[]): ViewOperation => ({ op: 'hide', scope, ...setDelta(baseline, draft) })

/** CountrySelector 的「保存国家」：国家顺序按草稿合并，隐藏国家只应用本次增量。 */
export const countryDraftOperations = ({ draftCountryIds, baselineCountryOrder, baselineHiddenCountryIds, draftHiddenCountryIds }: {
  draftCountryIds: readonly string[]; baselineCountryOrder: readonly string[]; baselineHiddenCountryIds: readonly string[]; draftHiddenCountryIds: readonly string[]
}): ViewOperation[] => [
  { op: 'order', scope: 'countries', ids: [...draftCountryIds], baseline: [...baselineCountryOrder] },
  hideDraft('countries', baselineHiddenCountryIds, draftHiddenCountryIds),
]

/** InfoCard 的「保存城市」：本国的城市顺序；隐藏城市只应用本次增量。`baselineCityIds` 是页面加载时本国保存的顺序。 */
export const cityDraftOperations = ({ countryId, draftCityIds, baselineCityIds, baselineHiddenCityIds, draftHiddenCityIds }: {
  countryId: string; draftCityIds: readonly string[]; baselineCityIds: readonly string[]; baselineHiddenCityIds: readonly string[]; draftHiddenCityIds: readonly string[]
}): ViewOperation[] => [
  { op: 'order', scope: 'cities', key: countryId, ids: [...draftCityIds], baseline: [...baselineCityIds] },
  hideDraft('cities', baselineHiddenCityIds, draftHiddenCityIds),
]

/** InfoCard 的「保存照片」：本城市的照片顺序与封面；隐藏照片只应用本次增量。`baselinePhotoIds` 是页面加载时本城市保存的顺序。 */
export const photoDraftOperations = ({ cityId, draftPhotoIds, baselinePhotoIds, baselineHiddenPhotoIds, draftHiddenPhotoIds, draftCoverPhotoId }: {
  cityId: string; draftPhotoIds: readonly string[]; baselinePhotoIds: readonly string[]; baselineHiddenPhotoIds: readonly string[]; draftHiddenPhotoIds: readonly string[]
  draftCoverPhotoId?: string
}): ViewOperation[] => [
  { op: 'order', scope: 'media', key: cityId, ids: [...draftPhotoIds], baseline: [...baselinePhotoIds] },
  hideDraft('media', baselineHiddenPhotoIds, draftHiddenPhotoIds),
  ...(draftCoverPhotoId ? [{ op: 'cover', key: cityId, id: draftCoverPhotoId } as const] : []),
]

/** DroneMediaCard 的保存：本城市的无人机影像顺序；隐藏只应用本次增量。`baselineItemIds` 是页面加载时本城市保存的顺序。 */
export const droneDraftOperations = ({ cityId, draftItemIds, baselineItemIds, baselineHiddenIds, draftHiddenIds }: {
  cityId: string; draftItemIds: readonly string[]; baselineItemIds: readonly string[]; baselineHiddenIds: readonly string[]; draftHiddenIds: readonly string[]
}): ViewOperation[] => [
  { op: 'order', scope: 'drone', key: cityId, ids: [...draftItemIds], baseline: [...baselineItemIds] },
  hideDraft('drone', baselineHiddenIds, draftHiddenIds),
]

/** 「恢复隐藏」：只恢复界面上列出的那些 id，别处后来隐藏的保持隐藏。 */
export const restoreHiddenOperation = (scope: ViewListScope, shown: readonly string[]): ViewOperation => ({ op: 'hide', scope, add: [], remove: [...shown] })

/** 「彻底删除」之前先隐藏：把列出的 id 加入隐藏列表（已在其中的不动）。 */
export const hideIdsOperation = (scope: ViewListScope, ids: readonly string[]): ViewOperation => ({ op: 'hide', scope, add: [...ids], remove: [] })
