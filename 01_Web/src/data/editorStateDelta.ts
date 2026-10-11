/**
 * 编辑器保存的增量合并（第 1 批 D1）。
 *
 * 草稿来自页面加载时的快照（`travelAtlasEditorState`），保存时服务端的 `current` 可能已经被别处改过：
 * 另一个标签页、媒体导入的恢复（restoreImportedMedia 把新导入的 id 移出隐藏列表）。所以保存只应用「这次编辑做了什么」，
 * 不把整份草稿盖到 `current` 上。`updateLocalEditorState` 本身不变，变的是传给它的 updater。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import type { TravelAtlasEditorState } from './derive/editorState.ts'

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

type EditorStateUpdater = (current: TravelAtlasEditorState) => TravelAtlasEditorState

/** InfoCard 的「保存城市」：本国的城市顺序按作用域整份写；隐藏城市只应用本次增量。 */
export const cityDraftUpdater = ({ countryId, draftCityIds, baselineHiddenCityIds, draftHiddenCityIds }: {
  countryId: string; draftCityIds: string[]; baselineHiddenCityIds: readonly string[]; draftHiddenCityIds: readonly string[]
}): EditorStateUpdater => (current) => ({
  ...current,
  cityOrderByCountry: { ...current.cityOrderByCountry, [countryId]: draftCityIds },
  hiddenCityIds: applySetDelta(current.hiddenCityIds, baselineHiddenCityIds, draftHiddenCityIds),
})

/** InfoCard 的「保存照片」：本城市的照片顺序与封面按作用域写；隐藏照片只应用本次增量。 */
export const photoDraftUpdater = ({ cityId, draftPhotoIds, baselineHiddenPhotoIds, draftHiddenPhotoIds, draftCoverPhotoId }: {
  cityId: string; draftPhotoIds: string[]; baselineHiddenPhotoIds: readonly string[]; draftHiddenPhotoIds: readonly string[]; draftCoverPhotoId?: string
}): EditorStateUpdater => (current) => ({
  ...current,
  mediaOrderByCity: { ...current.mediaOrderByCity, [cityId]: draftPhotoIds },
  hiddenMediaIds: applySetDelta(current.hiddenMediaIds, baselineHiddenPhotoIds, draftHiddenPhotoIds),
  coverMediaByCity: draftCoverPhotoId
    ? { ...current.coverMediaByCity, [cityId]: draftCoverPhotoId }
    : current.coverMediaByCity,
})

/** CountrySelector 的「保存国家」：国家顺序按草稿合并，隐藏国家只应用本次增量。 */
export const countryDraftUpdater = ({ draftCountryIds, baselineCountryOrder, baselineHiddenCountryIds, draftHiddenCountryIds }: {
  draftCountryIds: readonly string[]; baselineCountryOrder: readonly string[]; baselineHiddenCountryIds: readonly string[]; draftHiddenCountryIds: readonly string[]
}): EditorStateUpdater => (current) => ({
  ...current,
  countryOrder: mergeOrder(current.countryOrder, draftCountryIds, baselineCountryOrder),
  hiddenCountryIds: applySetDelta(current.hiddenCountryIds, baselineHiddenCountryIds, draftHiddenCountryIds),
})

/** DroneMediaCard 的保存：本城市的无人机影像顺序按作用域写；隐藏只应用本次增量。 */
export const droneDraftUpdater = ({ cityId, draftItemIds, baselineHiddenIds, draftHiddenIds }: {
  cityId: string; draftItemIds: string[]; baselineHiddenIds: readonly string[]; draftHiddenIds: readonly string[]
}): EditorStateUpdater => (current) => ({
  ...current,
  droneOrderByCity: { ...current.droneOrderByCity, [cityId]: draftItemIds },
  hiddenDroneMediaIds: applySetDelta(current.hiddenDroneMediaIds, baselineHiddenIds, draftHiddenIds),
})

/** 「恢复隐藏」：只恢复界面上列出的那些 id，别处后来隐藏的保持隐藏。 */
export const withoutIds = <T>(current: readonly T[], shown: readonly T[]): T[] => {
  const restored = new Set(shown)
  return current.filter((id) => !restored.has(id))
}
