/**
 * 快照合并 —— 把多个 Adapter 的产出拼成一份 WorldGraphSnapshot（PRD §8.1 数据流）。
 *
 * PR3 / PR5 用它把 travel、planned、want-to-go 三份快照合成一份再交给查询层。
 *
 * 约束同其它 Core 文件：纯函数，不读时钟、不改输入、不依赖模块级状态。
 *
 * 去重键：
 * - entities / anchors / relations：`id`
 * - memberships：复合键 `(entityId, layerId)`（D14：membership 没有独立 id）
 *
 * 冲突时【先到先得】：先传入的快照胜出。这不是随意选的——调用方按"权威程度"排列输入，
 * 例如用户手动维护的想去条目应排在从旅行记录推导出来的 planned 条目之前。
 */

import type { WorldGraphSnapshot } from './types.ts'

export const emptyWorldGraphSnapshot = (): WorldGraphSnapshot => ({
  entities: [],
  memberships: [],
  anchors: [],
  relations: [],
})

/**
 * 复合键要能无歧义地还原成两段：entityId 里本来就有冒号（`place:wtg:GL:nuuk`），
 * 直接用分隔符拼接会有碰撞风险，所以用 JSON 数组做键。
 */
const membershipKey = (entityId: string, layerId: string): string =>
  JSON.stringify([entityId, layerId])

export const mergeWorldGraphSnapshots = (
  ...snapshots: readonly WorldGraphSnapshot[]
): WorldGraphSnapshot => {
  const merged = emptyWorldGraphSnapshot()
  const seenEntityIds = new Set<string>()
  const seenMembershipKeys = new Set<string>()
  const seenAnchorIds = new Set<string>()
  const seenRelationIds = new Set<string>()

  for (const snapshot of snapshots) {
    for (const entity of snapshot.entities ?? []) {
      if (seenEntityIds.has(entity.id)) continue
      seenEntityIds.add(entity.id)
      merged.entities.push(entity)
    }
    for (const membership of snapshot.memberships ?? []) {
      const key = membershipKey(membership.entityId, membership.layerId)
      if (seenMembershipKeys.has(key)) continue
      seenMembershipKeys.add(key)
      merged.memberships.push(membership)
    }
    for (const anchor of snapshot.anchors ?? []) {
      if (seenAnchorIds.has(anchor.id)) continue
      seenAnchorIds.add(anchor.id)
      merged.anchors.push(anchor)
    }
    for (const relation of snapshot.relations ?? []) {
      if (seenRelationIds.has(relation.id)) continue
      seenRelationIds.add(relation.id)
      merged.relations.push(relation)
    }
  }

  return merged
}
