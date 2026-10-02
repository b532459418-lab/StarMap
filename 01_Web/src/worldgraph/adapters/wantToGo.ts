/**
 * Want to Go Adapter —— 把想去条目投影成 World Graph 快照里的想去层成员关系。
 *
 * 【待《World Graph Core Model RFC》定稿】映射规则来自 StarMap V0.4 Layer Engine PRD v0.1
 * §6 FR-WTG-1 / FR-WTG-2 与 §8.1；RFC-LOC-1 Core 方案 C1–C3 起按地点 id 引用地点实体。
 *
 * 设计约束（与 travel.ts 同源，改之前先读完）：
 *
 * 1. 本模块是 StarMap Core：不读文件、不 import src/data/**、不碰 import.meta。
 *    条目由 App 读好、校验好之后传进来（今天是 V2 Reader 读出的 Canonical 想去条目，形状与 `WantToGoInput` 相同）。
 *
 * 2. 纯函数：不修改输入、不读时钟。成员关系的时间就是条目自己的 addedAt。
 *
 * 3. 只产出成员关系：地点实体、位置锚点由 ./places.ts 从注册表构造（C2），实体 id 就是条目的 placeId（C1）。
 *    同一地点的多条想去记录各自产出一条成员关系，`recordId` 是条目 id（C3）。
 *
 * 4. 隐藏条目仍然产出成员关系，只在 membership.metadata.hidden 上打标记
 *    （FR-WTG-5 的「已隐藏 N 项」需要它们还在快照里）。本适配器自己不做任何过滤。
 *
 * 5. 不产出 Relation：V0.4 的「想去」是 Entity + LayerMembership，没有 want_to_go 关系边
 *    （FR-WTG-1 / D14）。
 */

import type { EntityId, LayerMembership, WorldGraphSnapshot } from '../types.ts'
import { WANT_TO_GO_LAYER_ID } from '../layers.ts'

/** membership.metadata.source 的取值，用来区分条目来源（planned 记录是 PLANNED_SOURCE）。 */
export const WANT_TO_GO_SOURCE = 'want-to-go'

/** 一条想去记录。 */
export interface WantToGoInput {
  id: string
  /** 注册表地点 id，即实体 id（Core 方案 C1）。 */
  placeId: EntityId
  addedAt: string
  hidden: boolean
  note?: string
  /** 条目自己的来源标记（例如写入它的编辑器）。不进快照：成员关系的 `source` 恒为 `WANT_TO_GO_SOURCE`。 */
  source?: string
}

/**
 * 把想去条目投影成一个 World Graph 快照。
 *
 * - Membership：`want_to_go`，`entityId` 取条目的 placeId，`recordId` 取条目的 id，`addedBy: 'user'`（用户手动添加），
 *   `addedAt` 用条目的加入日期，`metadata = { hidden, source: 'want-to-go', note? }`
 * - Entity / Anchor / Relation：不产出（文件头第 3、5 条）
 *
 * 同一个条目 id 出现两次（文件被手改成两条同 id 记录）时第一条胜出，后续跳过；
 * 不修改输入，相同输入永远产出相同快照。
 */
export const wantToGoToWorldGraph = (items: readonly WantToGoInput[]): WorldGraphSnapshot => {
  const memberships: LayerMembership[] = []
  const seenItemIds = new Set<string>()

  for (const item of items) {
    if (seenItemIds.has(item.id)) continue
    seenItemIds.add(item.id)

    const metadata: Record<string, unknown> = {
      hidden: item.hidden,
      source: WANT_TO_GO_SOURCE,
    }
    if (item.note) metadata.note = item.note
    memberships.push({
      entityId: item.placeId,
      layerId: WANT_TO_GO_LAYER_ID,
      recordId: item.id,
      addedBy: 'user',
      addedAt: item.addedAt,
      metadata,
    })
  }

  return { entities: [], memberships, anchors: [], relations: [] }
}
