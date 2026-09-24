/**
 * 想去（Want to Go）的纯派生（RFC-LOC-1 PR1）。
 *
 * `src/data/derive/` 是 App 的纯派生层，【不是】 StarMap Core（`src/worldgraph/**`）。
 * 这里的逻辑原样搬自 `src/data/wantToGo.ts`：解析、隐藏条目排序、按 EntityId 反查的两张表，
 * 以及「想去 → 足迹」的两个禁用原因。「读哪份数据」（样例 / 私有文件 / 无，FR-PUB-1）
 * 与开发时的 console.warn 仍留在原文件。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`，
 * 不 import JSON、虚拟模块或 import.meta。
 */

import { plannedEntityId } from '../../worldgraph/adapters/plannedRecords.ts'
import { parseWantToGoFile, wantToGoEntityId, type WantToGoItem } from '../../worldgraph/adapters/wantToGo.ts'
import { slugify } from '../../worldgraph/slug.ts'
import type { EntityId } from '../../worldgraph/types.ts'
import type { City, Country, CountryId, TravelMapRecord } from '../../types/travel.ts'

export type WantToGoDataSource = 'local' | 'sample' | 'none'

/** 调用方选好的来源与原始值。`none` 时 value 被忽略。 */
export interface WantToGoSourceInput {
  source: WantToGoDataSource
  value: unknown
}

/** 想去派生要用到的足迹派生结果（见 `./travelAtlas.ts`）。 */
export interface WantToGoTravelInput {
  cities: City[]
  countryById: Record<CountryId, Country>
  plannedRecords: TravelMapRecord[]
}

// ---- 想去 → 足迹（PR9）的前置条件 ----
// 与转换端点（scripts/convert-to-travel.mjs）同一套判断与文案：Collection 与详情卡据此把
// 「标记为去过」显示为禁用并说明原因；端点仍会再校验一次。返回 undefined 表示可以转换。

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/**
 * 足迹城市的比较键：国家代码（足迹国家的 flagCode，大写）+ Core slugify(英文城市名)。
 * 只用来提前禁用按钮，免得用户填完日期才被拒绝；端点按 country_en 的 cityId 规则判断重复，仍是最终权威。
 * 没有国家代码的足迹国家无法比较，跳过（交给端点）。
 */
const footprintCityKey = (countryCode: string, nameEn: string) => `${countryCode.toUpperCase()}:${slugify(nameEn)}`

export const plannedConvertBlockReason = (record: TravelMapRecord): string | undefined =>
  isFiniteNumber(record.lat) && isFiniteNumber(record.lng) ? undefined : '这条旅行计划没有坐标，无法转为足迹。'

/** 来源与原始值 + 足迹派生结果 → `wantToGo.ts` 今天的全部派生导出（`wantToGoDataSource` 由调用方给出）。 */
export const deriveWantToGo = (input: WantToGoSourceInput, travel: WantToGoTravelInput) => {
  const { cities, countryById, plannedRecords } = travel

  // 私有文件不存在是正常状态（还没添加过想去的地方），不该报成 problem。
  const parsed = input.source === 'sample'
    ? parseWantToGoFile(input.value)
    : input.source === 'local'
      ? parseWantToGoFile(input.value)
      : { items: [] as WantToGoItem[], problems: [] as string[] }

  const wantToGoItems: WantToGoItem[] = parsed.items

  /** 被丢弃的坏数据说明。非空不代表出错，只代表有条目没能进入图层。 */
  const wantToGoProblems: string[] = parsed.problems

  /** 图层面板「已隐藏 N 项」列出的条目（FR-WTG-5），最近加入的在前。planned 记录只读，不会出现在这里。 */
  const hiddenWantToGoItems: WantToGoItem[] = wantToGoItems
    .filter((item) => item.hidden)
    .sort((left, right) => right.addedAt.localeCompare(left.addedAt))

  /**
   * EntityId → 想去条目，给详情卡用。键与适配器产出 Entity 的规则相同；
   * 同一 EntityId 出现两次时第一条胜出，与 wantToGoToWorldGraph 的去重一致。
   */
  const wantToGoItemByEntityId = new Map<EntityId, WantToGoItem>()
  for (const item of wantToGoItems) {
    const entityId = wantToGoEntityId(item.place.countryCode, item.place.nameEn)
    if (!wantToGoItemByEntityId.has(entityId)) wantToGoItemByEntityId.set(entityId, item)
  }

  /** EntityId → planned 旅行记录（FR-WTG-7，只读），给详情卡用。去重规则同 plannedRecordsToWorldGraph。 */
  const plannedRecordByEntityId = new Map<EntityId, TravelMapRecord>()
  for (const record of plannedRecords) {
    const entityId = plannedEntityId(record.id)
    if (!plannedRecordByEntityId.has(entityId)) plannedRecordByEntityId.set(entityId, record)
  }

  const footprintCityKeys = new Set(cities.flatMap((city) => {
    const countryCode = city.countryId ? countryById[city.countryId]?.flagCode : undefined
    return countryCode && city.nameEn ? [footprintCityKey(countryCode, city.nameEn)] : []
  }))

  const wantToGoConvertBlockReason = (item: WantToGoItem): string | undefined => {
    if (item.place.kind !== 'city') return '整个国家的想去需要先具体到城市，暂不支持直接转为足迹。'
    if (!isFiniteNumber(item.place.lat) || !isFiniteNumber(item.place.lng)) return '这个地点没有坐标，无法转为足迹。'
    if (footprintCityKeys.has(footprintCityKey(item.place.countryCode, item.place.nameEn))) {
      return '这个城市已经在足迹里了。如果只是想从想去列表移除，请使用隐藏或彻底删除。'
    }
    return undefined
  }

  return {
    wantToGoItems,
    wantToGoProblems,
    hiddenWantToGoItems,
    wantToGoItemByEntityId,
    plannedRecordByEntityId,
    wantToGoConvertBlockReason,
    plannedConvertBlockReason,
  }
}

export type WantToGoDerived = ReturnType<typeof deriveWantToGo>
