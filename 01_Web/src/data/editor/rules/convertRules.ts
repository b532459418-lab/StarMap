/**
 * 「标记为去过」的前置条件（审查 C2；3C-5 C2 从 ../../canonical/convertRules.ts 迁来，检查的先后与拒绝码不变）：想去条目或
 * planned 记录能不能转为足迹。规则只有这一份：
 *
 * - 写入端点 `POST /wanttogo/convert`：V2 写入函数（../../v2write/convert.ts）在五个 V2 文件的草稿上求值，存储原生的写入
 *   （../native/convert.ts）在官方读取器上求值；不通过就按码拒绝；
 * - 派生（../../canonical/derive.ts）在 Canonical 上求值，Collection 与想去卡片据此把按钮显示为禁用，并把码映射成端点的同一句文案。
 *
 * 规则只问四件事（`ConvertRuleAccess`）：按 id 的地点、想去条目、记录（同一 id 第一条胜出），以及某个地点有没有任何记录
 * （含 planned 与被隐藏的记录）。`convertRules(data)` 在三份列表上建好索引来回答（V2 文件与 Canonical）。
 * V2 文件与 Canonical 的差别只在记录坐标的写法（V2 文件里与城市坐标相同时省略，V2 Reader 读出 Canonical 时用城市坐标填回），
 * 下面的坐标判断对两种写法给出相同的结论。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`。
 */

import type { V2WriteErrorCode } from '../errors.ts'
import type { CanonicalPlace, PlaceId } from '../../canonical/types.ts'

/** 想去条目不能转为足迹的原因（按检查顺序）。 */
export type WantToGoConvertBlockCode = Extract<
  V2WriteErrorCode,
  'E_WTG_NOT_FOUND' | 'E_CONVERT_COUNTRY_KIND' | 'E_CONVERT_NO_COORDINATES' | 'E_CONVERT_HIDDEN' | 'E_CONVERT_CITY_IN_FOOTPRINT'
>

/** planned 记录不能转为足迹的原因（按检查顺序）。 */
export type PlannedConvertBlockCode = Extract<V2WriteErrorCode, 'E_PLANNED_NOT_FOUND' | 'E_PLANNED_NO_COORDINATES'>

/** 规则要看的记录字段：V2 文件的记录与 Canonical 的记录都满足。 */
export interface ConvertRuleRecord {
  id: string
  placeId: PlaceId
  status?: string
  lat?: number | null
  lng?: number | null
}

/** 规则要看的想去条目字段。 */
export interface ConvertRuleItem {
  id: string
  placeId: PlaceId
  hidden: boolean
}

/** 规则的输入：三份列表（V2 文件或 Canonical）。 */
export interface ConvertRuleData {
  places: readonly CanonicalPlace[]
  records: readonly ConvertRuleRecord[]
  wantToGoItems: readonly ConvertRuleItem[]
}

/** 规则问的四件事。 */
export interface ConvertRuleAccess {
  place(id: PlaceId): CanonicalPlace | undefined
  item(id: string): ConvertRuleItem | undefined
  record(id: string): ConvertRuleRecord | undefined
  /** 有没有任何记录（含 planned、被隐藏的）引用这个地点。 */
  hasRecordsOn(placeId: PlaceId): boolean
}

export interface ConvertRules {
  /**
   * 想去条目 `itemId` → 足迹，依次检查：
   * 1. 条目存在（`E_WTG_NOT_FOUND`）；
   * 2. 地点是城市（`E_CONVERT_COUNTRY_KIND`）；
   * 3. 城市有坐标（`E_CONVERT_NO_COORDINATES`）；
   * 4. 条目没被隐藏（`E_CONVERT_HIDDEN`）；
   * 5. 没有任何足迹记录引用这个城市——包括 planned 记录、不上首页的记录、所在城市或国家被 editor 隐藏的记录
   *    （`E_CONVERT_CITY_IN_FOOTPRINT`）。
   * 可以转换时为 undefined。
   */
  wantToGoConvertBlockCode(itemId: string): WantToGoConvertBlockCode | undefined
  /**
   * planned 记录 `recordId` → 足迹：记录存在且是 planned（`E_PLANNED_NOT_FOUND`）；有坐标（`E_PLANNED_NO_COORDINATES`）——
   * 记录省略了 `lat` 与 `lng` 两个键时看城市的坐标，否则两个都必须是有限数字。可以转换时为 undefined。
   */
  plannedConvertBlockCode(recordId: string): PlannedConvertBlockCode | undefined
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** 同一 id 第一条胜出（与端点按 id 查找的结果相同；V2 校验保证 id 在文件内唯一）。 */
const firstById = <T extends { id: string }>(list: readonly T[]): Map<string, T> => {
  const byId = new Map<string, T>()
  for (const entry of list) if (!byId.has(entry.id)) byId.set(entry.id, entry)
  return byId
}

/** 在一份数据（三份列表）上建好索引，之后按 id 逐条回答。数据在这之后不能再改。 */
export function convertRules(data: ConvertRuleData): ConvertRules {
  const placeById = firstById(data.places)
  const itemById = firstById(data.wantToGoItems)
  const recordById = firstById(data.records)
  const placeIdsWithRecords = new Set(data.records.map((record) => record.placeId))
  return convertRulesOf({
    place: (id) => placeById.get(id),
    item: (id) => itemById.get(id),
    record: (id) => recordById.get(id),
    hasRecordsOn: (placeId) => placeIdsWithRecords.has(placeId),
  })
}

/** 规则本身（见 `ConvertRules`）。 */
export function convertRulesOf(access: ConvertRuleAccess): ConvertRules {
  return {
    wantToGoConvertBlockCode(itemId) {
      const item = access.item(itemId)
      if (!item) return 'E_WTG_NOT_FOUND'
      const city = access.place(item.placeId)
      if (city?.subtype !== 'city') return 'E_CONVERT_COUNTRY_KIND'
      if (!city.location) return 'E_CONVERT_NO_COORDINATES'
      if (item.hidden === true) return 'E_CONVERT_HIDDEN'
      if (access.hasRecordsOn(city.id)) return 'E_CONVERT_CITY_IN_FOOTPRINT'
      return undefined
    },
    plannedConvertBlockCode(recordId) {
      const record = access.record(recordId)
      if (!record || record.status !== 'planned') return 'E_PLANNED_NOT_FOUND'
      const omitted = !Object.hasOwn(record, 'lat') && !Object.hasOwn(record, 'lng')
      const hasCoordinates = omitted
        ? access.place(record.placeId)?.location !== undefined
        : isFiniteNumber(record.lat) && isFiniteNumber(record.lng)
      return hasCoordinates ? undefined : 'E_PLANNED_NO_COORDINATES'
    },
  }
}
