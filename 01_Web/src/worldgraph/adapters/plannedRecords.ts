/**
 * Planned Records Adapter —— 把 `status === 'planned'` 的足迹记录投影成 want_to_go 图层里的只读成员关系
 * （PRD FR-WTG-7；RFC-LOC-1 Core 方案 C1–C3 起按地点 id 引用地点实体）。
 *
 * 输入只是 planned 记录的最小形状：App 在派生层挑出 planned 记录（FR-TA-5：它们不进足迹），
 * 只把这里用得到的字段传进来。记录上的名称、国家代码、坐标都不再需要——它们属于地点，
 * 由 ./places.ts 从注册表构造；记录自带的坐标是记录级数据，地图不使用（RFC §3.2）。
 *
 * 设计约束同 travel.ts / wantToGo.ts：Core、纯函数、不读时钟、不改输入。
 *
 * 这些条目在 V0.4 是【只读】的：membership 上带 `readOnly: true` 与 `addedBy: 'rule'`，
 * UI 据此隐藏「隐藏 / 删除」操作。
 */

import type { EntityId, LayerMembership, WorldGraphSnapshot } from '../types.ts'
// 与 wantToGo.ts 同一个图层，只是来源不同；图层 id 只在 Layer Registry 里声明一次。
import { WANT_TO_GO_LAYER_ID } from '../layers.ts'

/** membership.metadata.source 的取值（FR-WTG-7）。 */
export const PLANNED_SOURCE = 'travel-map:planned'

/** 一条 planned 足迹记录。 */
export interface PlannedRecordInput {
  id: string
  /** 记录所在城市的注册表地点 id，即实体 id（Core 方案 C1）。 */
  placeId: EntityId
  start_date: string
  notes?: string
}

/**
 * 把 planned 记录投影成一个 World Graph 快照。
 *
 * - Membership：`want_to_go`，`entityId` 取记录的 placeId，`recordId` 取记录的 id，`addedBy: 'rule'`，
 *   `addedAt` 用记录的 start_date，`metadata = { source: PLANNED_SOURCE, readOnly: true, note? }`
 * - Entity / Anchor / Relation：不产出（地点实体与锚点由 ./places.ts 构造）
 *
 * 同一个 record id 出现两次时第一条胜出；不修改输入。
 */
export const plannedRecordsToWorldGraph = (records: readonly PlannedRecordInput[]): WorldGraphSnapshot => {
  const memberships: LayerMembership[] = []
  const seenRecordIds = new Set<string>()

  for (const record of records) {
    if (seenRecordIds.has(record.id)) continue
    seenRecordIds.add(record.id)

    const metadata: Record<string, unknown> = {
      source: PLANNED_SOURCE,
      readOnly: true,
    }
    if (record.notes) metadata.note = record.notes
    memberships.push({
      entityId: record.placeId,
      layerId: WANT_TO_GO_LAYER_ID,
      recordId: record.id,
      addedBy: 'rule',
      addedAt: record.start_date,
      metadata,
    })
  }

  return { entities: [], memberships, anchors: [], relations: [] }
}
