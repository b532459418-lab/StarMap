/**
 * 想去（Want to Go）派生用到的类型与 planned 记录的转换前置条件（RFC-LOC-1 PR1 搬自 `src/data/wantToGo.ts`）。
 *
 * `src/data/derive/` 是 App 的纯派生层，【不是】 StarMap Core（`src/worldgraph/**`）。想去的派生本身在
 * `../canonical/derive.ts`（按地点重建条目）；RFC-LOC-1 PR5b 删除了解析旧格式原始值的旧派生 `deriveWantToGo`。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`，
 * 不 import JSON、虚拟模块或 import.meta。
 */

import type { City, Country, CountryId, TravelMapRecord } from '../../types/travel.ts'

export type WantToGoDataSource = 'local' | 'sample' | 'none'

/** 想去派生要用到的足迹派生结果（见 `../canonical/derive.ts`）。 */
export interface WantToGoTravelInput {
  cities: City[]
  countryById: Record<CountryId, Country>
  plannedRecords: TravelMapRecord[]
}

// ---- 想去 → 足迹（PR9）的前置条件 ----
// 与转换端点（src/data/v2write/convert.ts）同一套判断与文案：Collection 与详情卡据此把
// 「标记为去过」显示为禁用并说明原因；端点仍会再校验一次。返回 undefined 表示可以转换。

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

export const plannedConvertBlockReason = (record: TravelMapRecord): string | undefined =>
  isFiniteNumber(record.lat) && isFiniteNumber(record.lng) ? undefined : '这条旅行计划没有坐标，无法转为足迹。'
