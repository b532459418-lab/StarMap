/**
 * 想去（Want to Go）派生用到的类型与 planned 记录的转换前置条件（RFC-LOC-1 PR1 搬自 `src/data/wantToGo.ts`）。
 *
 * `src/data/derive/` 是 App 的纯派生层，【不是】 StarMap Core（`src/worldgraph/**`）。想去的派生本身在
 * `../canonical/derive.ts`（按地点重建条目）；RFC-LOC-1 PR5b 删除了解析旧格式原始值的旧派生 `deriveWantToGo`。
 *
 * 约束：Node 24 能直接加载——erasable-only TypeScript，相对 import 带 `.ts`，类型用 `import type`，
 * 不 import JSON、虚拟模块或 import.meta。
 */

import { WANT_TO_GO_LAYER_ID } from '../../worldgraph/layers.ts'
import { PLANNED_SOURCE } from '../../worldgraph/adapters/plannedRecords.ts'
import type { EntityId, LayerMembership } from '../../worldgraph/types.ts'
import type { City, TravelMapRecord } from '../../types/travel.ts'

export type WantToGoDataSource = 'local' | 'sample' | 'none'

/**
 * UI 读到的想去条目的地点：由注册表的地点重建（`../canonical/reconstruct.ts`）。
 * RFC-LOC-1 Core-A 之前这是 Core 想去适配器的输入形状；Core 改为只收地点 id 之后，它留在 App 里，只给 UI 与写入用。
 */
export interface WantToGoPlace {
  kind: 'city' | 'country'
  nameZh: string
  nameEn: string
  countryCode: string
  lat?: number
  lng?: number
}

/** UI 读到的想去条目：Canonical 条目 + 由地点重建的内联 `place`。 */
export interface WantToGoItem {
  id: string
  place: WantToGoPlace
  note?: string
  addedAt: string
  hidden: boolean
  source?: string
}

/** 想去派生要用到的足迹派生结果（见 `../canonical/derive.ts`）。 */
export interface WantToGoTravelInput {
  cities: City[]
  plannedRecords: TravelMapRecord[]
}

// ---- 想去 → 足迹（PR9）的前置条件 ----
// 与转换端点（src/data/v2write/convert.ts）同一套判断与文案：Collection 与详情卡据此把
// 「标记为去过」显示为禁用并说明原因；端点仍会再校验一次。返回 undefined 表示可以转换。

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

export const plannedConvertBlockReason = (record: TravelMapRecord): string | undefined =>
  isFiniteNumber(record.lat) && isFiniteNumber(record.lng) ? undefined : '这条旅行计划没有坐标，无法转为足迹。'

// ---- 想去卡片显示哪一条记录（RFC-LOC-1 Core-A §4.3）----

/** 想去卡片要显示的那条记录：想去条目（`item.id`）或 planned 足迹记录（`record.id`）。 */
export interface WantToGoCardRecord {
  source: 'want-to-go' | 'planned'
  recordId: string
}

/**
 * 地图上一个想去标记对应一个地点（实体 id 就是地点 id），这个地点在想去图层可能有几条记录。卡片只显示一条：
 * 该地点在想去图层里【可见】（未隐藏）的记录中，有想去条目就取第一条想去条目，否则取第一条 planned 记录
 * （与 Core-A 之前想去条目先于 planned 的优先顺序相同）。「第一条」按快照里成员关系的顺序。没有可见记录时为 undefined。
 */
export const wantToGoCardRecordOf = (
  memberships: readonly LayerMembership[],
  entityId: EntityId,
): WantToGoCardRecord | undefined => {
  let firstPlanned: WantToGoCardRecord | undefined
  for (const membership of memberships) {
    if (membership.entityId !== entityId || membership.layerId !== WANT_TO_GO_LAYER_ID) continue
    if (membership.metadata?.hidden === true || membership.recordId === undefined) continue
    if (membership.metadata?.source === PLANNED_SOURCE) {
      firstPlanned ??= { source: 'planned', recordId: membership.recordId }
      continue
    }
    return { source: 'want-to-go', recordId: membership.recordId }
  }
  return firstPlanned
}
