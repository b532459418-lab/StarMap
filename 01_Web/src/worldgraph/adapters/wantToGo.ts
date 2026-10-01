/**
 * Want to Go Adapter —— 把想去条目投影成 World Graph 快照。
 *
 * 【待《World Graph Core Model RFC》定稿】映射规则来自 StarMap V0.4 Layer Engine PRD v0.1
 * §6 FR-WTG-1 / FR-WTG-2 与 §8.1 / §8.2。
 *
 * 设计约束（与 travel.ts 同源，改之前先读完）：
 *
 * 1. 本模块是 StarMap Core：不读文件、不 import src/data/**、不碰 import.meta。
 *    条目由 App 读好、校验好之后传进来（今天是 V2 Reader 读出的 Canonical 想去条目，
 *    经 src/data/canonical/reconstruct.ts 重建成 WantToGoItem）。
 *
 * 2. 纯函数：不修改输入、不读时钟。时间戳唯一来源是 options.now，【必填】，没有缺省值。
 *
 * 3. 隐藏条目仍然产出 Entity 与 membership，只在 membership.metadata.hidden 上打标记
 *    （FR-WTG-5 的「已隐藏 N 项」需要它们还在快照里）。本适配器自己不做任何过滤。
 *
 * 4. 不产出 Relation：V0.4 的「想去」是 Entity + LayerMembership，没有 want_to_go 关系边
 *    （FR-WTG-1 / D14）。
 */

import type {
  Anchor,
  Entity,
  EntityId,
  LayerMembership,
  WorldGraphSnapshot,
} from '../types.ts'
import { WANT_TO_GO_LAYER_ID } from '../layers.ts'
import { slugify } from '../slug.ts'
import { anchorId } from './travel.ts'

/** membership.metadata.source 与 entity.metadata.source 的取值，用来区分条目来源。 */
export const WANT_TO_GO_SOURCE = 'want-to-go'

export interface WantToGoPlace {
  kind: 'city' | 'country'
  nameZh: string
  nameEn: string
  countryCode: string
  lat?: number
  lng?: number
}

export interface WantToGoItem {
  id: string
  place: WantToGoPlace
  note?: string
  addedAt: string
  hidden: boolean
  source?: string
}

export interface WantToGoWorldGraphOptions {
  /**
   * 注入 Entity.updatedAt 的时间戳（ISO 8601）。【必填】，理由同 travel.ts：
   * 纯函数不能自己读时钟，否则同样的输入会产出不同的快照。
   * createdAt 用条目自己的 addedAt，不用这个值。
   */
  now: string
}

// ---- ID 规则（PRD §8.2）----

/**
 * `place:wtg:<countryCode>:<slug(nameEn)>`，例 `place:wtg:GL:nuuk`。
 *
 * 与 plannedRecords 的 `place:planned:<recordId>` 【刻意】不同：PRD §8.2 允许同一真实
 * 地点从两个来源各产出一个 Entity，Entity 级去重是 0.5 的迁移工作。
 */
export const wantToGoEntityId = (countryCode: string, nameEn: string): EntityId =>
  `place:wtg:${countryCode.toUpperCase()}:${slugify(nameEn)}`

// ---- 投影 ----

/**
 * 把想去条目投影成一个 World Graph 快照。
 *
 * - Entity：`place:wtg:<CC>:<slug>`，`type: 'place'`，`subtype` 取 place.kind
 * - Anchor：只在 lat / lng 都是有限数时产出（D06：无坐标 Entity 合法）；
 *           city → precision 'exact'，country → 'region'（国家坐标是一个代表点，不是精确位置）
 * - Membership：`want_to_go`，`recordId` 取条目的 id，`addedBy: 'user'`（用户手动添加），`addedAt` 用条目的加入日期
 * - Relation：不产出（FR-WTG-1）
 *
 * 同一个 entityId 出现两次（文件被手改成两条同地点记录）时第一条胜出，后续跳过；
 * 不修改输入，相同输入永远产出相同快照。
 */
export const wantToGoToWorldGraph = (
  items: readonly WantToGoItem[],
  options: WantToGoWorldGraphOptions,
): WorldGraphSnapshot => {
  const now = options.now
  const entities: Entity[] = []
  const memberships: LayerMembership[] = []
  const anchors: Anchor[] = []
  const seenEntityIds = new Set<EntityId>()

  for (const item of items) {
    const place = item.place
    const entityId = wantToGoEntityId(place.countryCode, place.nameEn)
    if (seenEntityIds.has(entityId)) continue
    seenEntityIds.add(entityId)

    const entity: Entity = {
      id: entityId,
      type: 'place',
      subtype: place.kind,
      title: { zh: place.nameZh, en: place.nameEn },
      metadata: {
        countryCode: place.countryCode,
        source: WANT_TO_GO_SOURCE,
        wantToGoId: item.id,
      },
      visibility: 'private',
      createdAt: item.addedAt,
      updatedAt: now,
    }
    entities.push(entity)

    if (typeof place.lat === 'number' && Number.isFinite(place.lat)
      && typeof place.lng === 'number' && Number.isFinite(place.lng)) {
      anchors.push({
        id: anchorId('location', entityId),
        entityId,
        kind: 'location',
        lat: place.lat,
        lng: place.lng,
        precision: place.kind === 'city' ? 'exact' : 'region',
      })
    }

    const metadata: Record<string, unknown> = {
      hidden: item.hidden,
      source: WANT_TO_GO_SOURCE,
    }
    if (item.note) metadata.note = item.note
    memberships.push({
      entityId,
      layerId: WANT_TO_GO_LAYER_ID,
      recordId: item.id,
      addedBy: 'user',
      addedAt: item.addedAt,
      metadata,
    })
  }

  return { entities, memberships, anchors, relations: [] }
}
