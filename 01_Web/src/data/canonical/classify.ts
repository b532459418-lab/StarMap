/**
 * 按地点执行的显示规则（RFC-LOC-1 PR2）。
 *
 * `src/data/canonical/` 是 App 层，【不是】 StarMap Core。PR1 的旧派生 `classifyRecord`（PR5b 删除）按记录上的
 * `country_en` 字符串匹配 `hiddenCountries` / `originCountries` / `regionMatchers`；这里是同一套判断，只是
 * 「国家是否命中」改为按国家地点 id 判断（Canonical 的显示规则见 `./types.ts` 的 `CanonicalDisplay`）。判断顺序不变：
 * 记录自带的 travelCategory → region → hidden（origin / transit）→ daytrip → destination。
 *
 * 由 `./derive.ts` 使用（PR2 到 PR5a 还被 Legacy Adapter 共用，PR5b 删除）。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import { homeVisibleCategories } from '../derive/travelAtlas.ts'
import type { TravelMapRecord, TravelRecordCategory } from '../../types/travel.ts'
import type { CanonicalDisplay, PlaceId } from './types.ts'

export interface CanonicalDisplaySets {
  homeHidden: ReadonlySet<PlaceId>
  origin: ReadonlySet<PlaceId>
  regionCountries: ReadonlySet<PlaceId>
  regionIncludes: readonly string[]
  navigationHiddenCities: ReadonlySet<PlaceId>
}

export const displaySets = (display: CanonicalDisplay): CanonicalDisplaySets => ({
  homeHidden: new Set(display.homeHiddenCountryIds),
  origin: new Set(display.originCountryIds),
  regionCountries: new Set(display.regionCountryIds),
  regionIncludes: display.regionIncludes,
  navigationHiddenCities: new Set(display.navigationHiddenCityIds),
})

/** 与原 `classifyRecord` 同一顺序；国家是否命中按国家地点 id 判断。 */
export const classifyByPlace = (
  record: Pick<TravelMapRecord, 'travelCategory' | 'region' | 'type'>,
  countryId: PlaceId | undefined,
  sets: CanonicalDisplaySets,
): TravelRecordCategory => {
  if (record.travelCategory) return record.travelCategory
  const inCountry = (set: ReadonlySet<PlaceId>) => countryId !== undefined && set.has(countryId)
  if (inCountry(sets.regionCountries) || sets.regionIncludes.some((matcher) => record.region?.includes(matcher))) return 'region'
  if (inCountry(sets.homeHidden)) {
    return inCountry(sets.origin) ? 'origin' : 'transit'
  }
  if (record.type === 'daytrip') return 'dayTrip'
  return 'destination'
}

/** 与原 `withDisplayCategory` 同一规则：记录自带布尔值的 `hiddenFromHome` 优先，否则按分类。 */
export const hiddenFromHomeFor = (record: Pick<TravelMapRecord, 'hiddenFromHome'>, travelCategory: TravelRecordCategory) =>
  typeof record.hiddenFromHome === 'boolean'
    ? record.hiddenFromHome
    : !homeVisibleCategories.has(travelCategory)
