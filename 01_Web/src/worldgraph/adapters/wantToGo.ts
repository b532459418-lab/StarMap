/**
 * Want to Go Adapter —— 把 want-to-go.local.json 的领域条目投影成 World Graph 快照。
 *
 * 【待《World Graph Core Model RFC》定稿】映射规则来自 StarMap V0.4 Layer Engine PRD v0.1
 * §6 FR-WTG-1 / FR-WTG-2 与 §8.1 / §8.2。
 *
 * 设计约束（与 travel.ts 同源，改之前先读完）：
 *
 * 1. 本模块是 StarMap Core：不读文件、不 import src/data/**、不碰 import.meta。
 *    文件内容由调用方（src/data/wantToGo.ts）读好之后以 `unknown` 传进 parseWantToGoFile。
 *
 * 2. 纯函数：不修改输入、不读时钟。时间戳唯一来源是 options.now，【必填】，没有缺省值。
 *
 * 3. parseWantToGoFile 【不抛异常】。这份文件可能被用户手改，一条坏数据不该让整个图层消失：
 *    坏的整份文件退化为空列表，坏的单条被丢弃，原因都写进 problems 供 UI / 控制台提示。
 *
 * 4. 隐藏条目仍然产出 Entity 与 membership，只在 membership.metadata.hidden 上打标记
 *    （FR-WTG-5 的「已隐藏 N 项」需要它们还在快照里）。本适配器自己不做任何过滤。
 *
 * 5. 不产出 Relation：V0.4 的「想去」是 Entity + LayerMembership，没有 want_to_go 关系边
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

export interface WantToGoParseResult {
  items: WantToGoItem[]
  problems: string[]
}

export interface WantToGoWorldGraphOptions {
  /**
   * 注入 Entity.updatedAt 的时间戳（ISO 8601）。【必填】，理由同 travel.ts：
   * 纯函数不能自己读时钟，否则同样的输入会产出不同的快照。
   * createdAt 用条目自己的 addedAt，不用这个值。
   */
  now: string
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

// ---- ID 规则（PRD §8.2）----

/**
 * `place:wtg:<countryCode>:<slug(nameEn)>`，例 `place:wtg:GL:nuuk`。
 *
 * 与 plannedRecords 的 `place:planned:<recordId>` 【刻意】不同：PRD §8.2 允许同一真实
 * 地点从两个来源各产出一个 Entity，Entity 级去重是 0.5 的迁移工作。
 */
export const wantToGoEntityId = (countryCode: string, nameEn: string): EntityId =>
  `place:wtg:${countryCode.toUpperCase()}:${slugify(nameEn)}`

// ---- 容错解析 ----

/**
 * 把 want-to-go.local.json 的解析结果（或任何东西）转成条目列表。
 *
 * 整份文件级别的问题（不是对象 / schema_version 不是 1 / items 不是数组）退化为空列表；
 * 单条级别的问题只丢弃该条。任何情况下都不抛异常，problems 里是给人看的中文说明。
 */
export const parseWantToGoFile = (value: unknown): WantToGoParseResult => {
  const problems: string[] = []

  if (!isRecord(value)) {
    problems.push('想去数据不是一个对象，已按空列表处理。')
    return { items: [], problems }
  }
  if (value.schema_version !== 1) {
    problems.push(`想去数据的 schema_version 不是 1（实际为 ${JSON.stringify(value.schema_version)}），已按空列表处理。`)
    return { items: [], problems }
  }
  if (!Array.isArray(value.items)) {
    problems.push('想去数据的 items 不是数组，已按空列表处理。')
    return { items: [], problems }
  }

  const items: WantToGoItem[] = []
  value.items.forEach((raw, index) => {
    const label = `第 ${index + 1} 条想去记录`
    if (!isRecord(raw)) {
      problems.push(`${label}不是一个对象，已跳过。`)
      return
    }
    const id = text(raw.id)
    if (!id) {
      problems.push(`${label}缺少 id，已跳过。`)
      return
    }
    if (!isRecord(raw.place)) {
      problems.push(`${label}（${id}）缺少 place，已跳过。`)
      return
    }

    const place = raw.place
    if (place.kind !== 'city' && place.kind !== 'country') {
      problems.push(`${label}（${id}）的 place.kind 只能是 city 或 country，已跳过。`)
      return
    }
    // nameEn 参与 EntityId 的 slug，为空会产出 `place:wtg:GL:` 这种无意义 id，只能丢弃。
    const nameEn = text(place.nameEn)
    if (!nameEn) {
      problems.push(`${label}（${id}）缺少 place.nameEn，已跳过。`)
      return
    }
    const countryCode = text(place.countryCode).toUpperCase()
    if (!/^[A-Z]{2}$/.test(countryCode)) {
      problems.push(`${label}（${id}）的 place.countryCode 不是两个英文字母，已跳过。`)
      return
    }

    const hasLat = place.lat !== undefined && place.lat !== null
    const hasLng = place.lng !== undefined && place.lng !== null
    if (hasLat !== hasLng) {
      problems.push(`${label}（${id}）的经纬度必须同时存在或同时缺省，已跳过。`)
      return
    }
    if (hasLat && (!isFiniteNumber(place.lat) || !isFiniteNumber(place.lng))) {
      problems.push(`${label}（${id}）的经纬度不是有限数字，已跳过。`)
      return
    }

    const addedAt = text(raw.addedAt)
    if (!datePattern.test(addedAt)) {
      problems.push(`${label}（${id}）的 addedAt 必须是 YYYY-MM-DD，已跳过。`)
      return
    }

    const parsedPlace: WantToGoPlace = {
      kind: place.kind,
      nameZh: text(place.nameZh) || nameEn,
      nameEn,
      countryCode,
    }
    if (hasLat && isFiniteNumber(place.lat) && isFiniteNumber(place.lng)) {
      parsedPlace.lat = place.lat
      parsedPlace.lng = place.lng
    }

    const item: WantToGoItem = {
      id,
      place: parsedPlace,
      addedAt,
      // hidden 缺省为 false；非布尔值按 false 处理，不额外报问题。
      hidden: raw.hidden === true,
    }
    const note = text(raw.note)
    if (note) item.note = note
    const source = text(raw.source)
    if (source) item.source = source

    items.push(item)
  })

  return { items, problems }
}

// ---- 投影 ----

/**
 * 把想去条目投影成一个 World Graph 快照。
 *
 * - Entity：`place:wtg:<CC>:<slug>`，`type: 'place'`，`subtype` 取 place.kind
 * - Anchor：只在 lat / lng 都是有限数时产出（D06：无坐标 Entity 合法）；
 *           city → precision 'exact'，country → 'region'（国家坐标是一个代表点，不是精确位置）
 * - Membership：`want_to_go`，`addedBy: 'user'`（用户手动添加），`addedAt` 用条目的加入日期
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
      addedBy: 'user',
      addedAt: item.addedAt,
      metadata,
    })
  }

  return { entities, memberships, anchors, relations: [] }
}
