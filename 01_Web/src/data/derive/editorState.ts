/**
 * editor-state 的类型与排序（RFC-LOC-1 PR1 搬自 `src/data/editorState.ts`）。
 *
 * `src/data/derive/` 是 App 的纯派生层，【不是】 StarMap Core（`src/worldgraph/**`）。
 * `orderBySavedIds` 给派生排序。RFC-LOC-1 PR5b 删除了只给旧派生用的 `deriveEditorState` 与 `emptyEditorState`；
 * 第 7 批删除了只剩测试在用的 `parseEditorState`（V2 的 editor-state 由 ../compat/v2/v2Schema.ts 校验）。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`，
 * 不 import JSON、虚拟模块或 import.meta。
 */

import type { CityId, CountryId } from '../../types/travel.ts'

export type LocalEditorCountry = {
  id: CountryId
  nameZh: string
  nameEn: string
  countryCode: string
  centerLat: number
  centerLng: number
  region?: string
  visitedDate?: string
}

export type TravelAtlasEditorState = {
  schemaVersion: 1
  addedCountries: LocalEditorCountry[]
  countryOrder: CountryId[]
  hiddenCountryIds: CountryId[]
  cityOrderByCountry: Record<CountryId, CityId[]>
  hiddenCityIds: CityId[]
  mediaOrderByCity: Record<CityId, string[]>
  hiddenMediaIds: string[]
  coverMediaByCity: Record<CityId, string>
  droneOrderByCity: Record<CityId, string[]>
  hiddenDroneMediaIds: string[]
  updatedAt?: string
}

export const orderBySavedIds = <T extends { id: string }>(items: T[], savedOrder?: string[]) => {
  if (!savedOrder?.length) return items
  const rank = new Map(savedOrder.map((id, index) => [id, index]))

  return [...items].sort((left, right) => {
    const leftRank = rank.get(left.id)
    const rightRank = rank.get(right.id)
    if (leftRank === undefined && rightRank === undefined) return 0
    if (leftRank === undefined) return 1
    if (rightRank === undefined) return -1
    return leftRank - rightRank
  })
}
