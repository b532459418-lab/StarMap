/**
 * Planned Records Adapter —— 把 travel-map 里 `status === 'planned'` 的记录
 * 投影成 want_to_go 图层里的只读条目（PRD FR-WTG-7）。
 *
 * 为什么输入是【原始 TravelMapRecord[]】而不是 travelAtlas 的 Country / City：
 * travelAtlas.ts 在记录层（`rawRecords`）就把 planned 过滤掉了，它导出的领域对象里
 * 根本没有这些记录。FR-TA-5 要求那条过滤【保持不变】，所以 planned 记录只能从
 * 原始 records 里取。过滤动作放在本函数内部，调用方把整份 records 传进来即可。
 *
 * 设计约束同 travel.ts / wantToGo.ts：Core、纯函数、options.now 必填、不改输入。
 *
 * 这些条目在 V0.4 是【只读】的：没有对应的本地编辑端点，membership 上带
 * `readOnly: true` 与 `addedBy: 'rule'`，UI 据此隐藏「隐藏 / 删除」操作。
 * 迁移进 want-to-go.local.json 是 P1（PRD §15 Q2）。
 */

import type { TravelMapRecord } from '../../types/travel.ts'
import type {
  Anchor,
  Entity,
  EntityId,
  EntityMetadata,
  LayerMembership,
  WorldGraphSnapshot,
} from '../types.ts'
// 与 wantToGo.ts 同一个图层，只是来源不同；图层 id 只在 Layer Registry 里声明一次。
import { WANT_TO_GO_LAYER_ID } from '../layers.ts'
import { anchorId } from './travel.ts'

/** membership.metadata.source 与 entity.metadata.source 的取值（FR-WTG-7）。 */
export const PLANNED_SOURCE = 'travel-map:planned'

export interface PlannedRecordsOptions {
  /** 注入 Entity.updatedAt 的时间戳（ISO 8601）。【必填】，理由同 travel.ts。 */
  now: string
  /**
   * travelAtlas 的 `display.countryCodes`（国家英文名 → 两位国家代码）。
   * 记录自带 `country_code` 时优先用记录上的值，这里只是第二级回落。
   */
  countryCodes?: Record<string, string>
}

// ---- ID 规则（PRD §8.2）----

/**
 * `place:planned:<TravelMapRecord.id>`。
 *
 * 与 wantToGoEntityId 的 `place:wtg:<CC>:<slug>` 【刻意】不同：同一个真实地点
 * 既可能是一条 planned 记录、又可能被手动加进想去列表，PRD §8.2 允许两个 Entity 并存，
 * 由渲染层合并显示（FR-MR-5）。Entity 级去重是 0.5 的迁移工作。
 */
export const plannedEntityId = (recordId: string): EntityId => `place:planned:${recordId}`

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/**
 * 把 travel-map 的 planned 记录投影成一个 World Graph 快照。
 *
 * - 只取 `status === 'planned'` 的记录，其余忽略
 * - Entity：`place:planned:<recordId>`，`type: 'place'`，`subtype: 'city'`
 * - Anchor：lat / lng 都是有限数时产出 location Anchor（`precision: 'exact'`）；
 *   travel-map 的坐标可以是 null（schema 允许），这时只有 Entity 没有 Anchor（D06）
 * - Membership：`want_to_go`，`addedBy: 'rule'`，`metadata.readOnly = true`
 * - Relation：不产出
 *
 * 同一个 record id 出现两次时第一条胜出；不修改输入。
 */
export const plannedRecordsToWorldGraph = (
  records: readonly TravelMapRecord[],
  options: PlannedRecordsOptions,
): WorldGraphSnapshot => {
  const now = options.now
  const countryCodes = options.countryCodes
  const entities: Entity[] = []
  const memberships: LayerMembership[] = []
  const anchors: Anchor[] = []
  const seenEntityIds = new Set<EntityId>()

  for (const record of records) {
    if (record.status !== 'planned') continue

    const entityId = plannedEntityId(record.id)
    if (seenEntityIds.has(entityId)) continue
    seenEntityIds.add(entityId)

    // 三级回落：记录自带 → display.countryCodes → 省略。统一大写。
    const rawCountryCode = record.country_code || countryCodes?.[record.country_en] || ''
    const countryCode = rawCountryCode.trim().toUpperCase()

    const metadata: EntityMetadata = {
      source: PLANNED_SOURCE,
      readOnly: true,
      recordId: record.id,
    }
    if (countryCode) metadata.countryCode = countryCode
    if (record.country_en) metadata.countryEn = record.country_en

    // title.zh 在中文名缺失时回落到英文名，理由同 travel.ts 的 buildTitle：
    // 空标题会在地图上渲染成一个没有标签的标记。
    const title: Entity['title'] = { zh: record.city || record.city_en || '' }
    if (record.city_en) title.en = record.city_en

    entities.push({
      id: entityId,
      type: 'place',
      subtype: 'city',
      title,
      metadata,
      visibility: 'private',
      createdAt: record.start_date,
      updatedAt: now,
    })

    if (isFiniteNumber(record.lat) && isFiniteNumber(record.lng)) {
      anchors.push({
        id: anchorId('location', entityId),
        entityId,
        kind: 'location',
        lat: record.lat,
        lng: record.lng,
        precision: 'exact',
      })
    }

    const membershipMetadata: Record<string, unknown> = {
      source: PLANNED_SOURCE,
      readOnly: true,
    }
    if (record.notes) membershipMetadata.note = record.notes
    memberships.push({
      entityId,
      layerId: WANT_TO_GO_LAYER_ID,
      addedBy: 'rule',
      addedAt: record.start_date,
      metadata: membershipMetadata,
    })
  }

  return { entities, memberships, anchors, relations: [] }
}
